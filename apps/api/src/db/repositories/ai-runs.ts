/**
 * Прогоны анализа LLM: аудит стоимости и провенанса без хранения промтов (§10, §11).
 *
 * ## Требование D: чувствительного payload здесь нет по построению
 *
 * `recordAiRun()` ФИЗИЧЕСКИ не принимает ни `systemPrompt`, ни `userPrompt`, ни
 * текста ответа модели. Это не соглашение, а форма типа: строку `ai_runs`
 * нельзя заполнить текстом промта, даже если очень захотеть, потому что такого
 * параметра не существует. Дисциплина в этом месте не работает — «положим
 * промт, чтобы было удобно отлаживать» выглядит безобидно, а результат —
 * распознанный текст ИД в таблице без срока хранения, то есть второй, более
 * долговечный канал утечки, чем журнал (находка S3, п. 3).
 *
 * Вход и выход описываются ХЭШАМИ: `input_hash` — sha256 полного эффективного
 * промта, `output_hash` — sha256 текста ответа. Их достаточно, чтобы доказать
 * «этот результат получен этим промтом» и чтобы найти расхождение при смене
 * версии промта, и недостаточно, чтобы восстановить содержимое.
 *
 * `structured_result` — это уже РАЗОБРАННЫЙ результат стадии (метка страницы,
 * список полей), а не сырой ответ. Его размер ограничен: разбор, весящий
 * десятки килобайт, — это признак того, что в него положили сырой ответ.
 *
 * ## Область видимости
 *
 * У `ai_runs` есть `folder_id`, но нет ни `object_id`, ни `contractor_id` —
 * они живут на ревизии поставки. Поэтому область применяется соединением с
 * `folders`, как в `recognition.ts` и `bundles.ts`. Вставка тоже
 * идёт через проверку видимости ревизии: без неё подрядчик, знающий чужой
 * `folder_id`, дописывал бы строки в чужой аудит.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { aiRuns, folders } from '@id/db';

import type { AuthScope } from '../../auth/scope.js';
import { badRequest, notFound } from '../../lib/problem.js';
import type { LlmProviderName, LlmStage } from '../../llm/port.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import type { Database } from './users.js';

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/**
 * Потолок разобранного результата.
 *
 * 32 КиБ — это заведомо больше любого разбора стадии (метка страницы весит
 * сотни байт, список реквизитов документа — единицы килобайт) и заведомо
 * меньше сырого ответа модели по 83-страничной поставке. Второй рубеж к
 * требованию D: тип запрещает передать промт полем, а этот предел ловит
 * попытку протащить его внутри `structuredResult`.
 */
export const MAX_STRUCTURED_RESULT_BYTES = 32_768;

const HEX64 = /^[0-9a-f]{64}$/;

export interface RecordAiRunInput {
  readonly folderId: string;
  readonly stage: LlmStage;
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly promptCode: string | null;
  readonly promptVersion: number | null;
  /** sha256 полного эффективного промта, hex. */
  readonly inputHash: string;
  /**
   * sha256 текста ответа, hex. `null` — ответа не было вовсе.
   *
   * Отсутствие ответа — законное состояние строки, а не повод её не писать:
   * таймаут и исчерпанный бюджет означают, что вызов состоялся (или мог
   * состояться) и потратил время, а «строки нет» неотличимо от «вызова не
   * было». Колонка nullable в схеме (0004), и CHECK формата к NULL не
   * применяется.
   */
  readonly outputHash: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly latencyMs: number | null;
  /** Разобранный результат стадии, а не сырой ответ. */
  readonly structuredResult: unknown;
  readonly requestId: string | null;
}

export interface AiRunView {
  readonly id: string;
  readonly folderId: string;
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly promptCode: string | null;
  readonly promptVersion: number | null;
  readonly inputHash: string | null;
  readonly outputHash: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly cost: number | null;
  readonly latencyMs: number | null;
  readonly structuredResult: unknown;
  readonly requestId: string | null;
  readonly createdAt: string;
}

const isoAt = (column: unknown, alias: string) =>
  sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as(
    alias,
  );

const RUN_SELECTION = {
  id: aiRuns.id,
  folderId: aiRuns.folderId,
  stage: aiRuns.stage,
  provider: aiRuns.provider,
  model: aiRuns.model,
  promptCode: aiRuns.promptCode,
  promptVersion: aiRuns.promptVersion,
  inputHash: aiRuns.inputHash,
  outputHash: aiRuns.outputHash,
  tokensIn: aiRuns.tokensIn,
  tokensOut: aiRuns.tokensOut,
  cost: aiRuns.cost,
  latencyMs: aiRuns.latencyMs,
  structuredResult: aiRuns.structuredResult,
  requestId: aiRuns.requestId,
  createdAt: isoAt(aiRuns.createdAt, 'created_at_iso'),
  /**
   * То же время в машинном виде — только для курсора.
   *
   * `to_char` округляет микросекунды, и две записи одной миллисекунды при
   * keyset-пагинации либо пропускались бы, либо выдавались дважды.
   */
  cursorAt: sql<string>`${aiRuns.createdAt}::text`.as('cursor_at'),
};

function toView(row: Record<string, unknown>): AiRunView {
  const cost = row.cost;
  return {
    id: row.id as string,
    folderId: row.folderId as string,
    stage: row.stage as string,
    provider: row.provider as string,
    model: row.model as string,
    promptCode: (row.promptCode ?? null) as string | null,
    promptVersion: (row.promptVersion ?? null) as number | null,
    inputHash: (row.inputHash ?? null) as string | null,
    outputHash: (row.outputHash ?? null) as string | null,
    tokensIn: (row.tokensIn ?? null) as number | null,
    tokensOut: (row.tokensOut ?? null) as number | null,
    // `numeric` приезжает строкой: в JS у числа с плавающей точкой нет точного
    // представления «два знака после запятой», и драйвер намеренно не решает
    // за прикладной код. Здесь стоимость нужна числом для сумм и метрик.
    cost: typeof cost === 'string' ? Number(cost) : ((cost ?? null) as number | null),
    latencyMs: (row.latencyMs ?? null) as number | null,
    structuredResult: row.structuredResult ?? null,
    requestId: (row.requestId ?? null) as string | null,
    createdAt: (row.createdAt as string | null) ?? '',
  };
}

function assertHash(value: string, field: string): void {
  if (!HEX64.test(value)) {
    throw badRequest(`${field}: ожидается sha256 в виде 64 шестнадцатеричных символов.`);
  }
}

/**
 * Запись прогона анализа.
 *
 * Ревизия проверяется на видимость ДО вставки: `INSERT` условие области
 * видимости не принимает, а без проверки строка чужого аудита создавалась бы
 * по одному лишь знанию идентификатора.
 */
export async function recordAiRun(
  db: Database,
  scope: AuthScope,
  input: RecordAiRunInput,
): Promise<AiRunView> {
  assertHash(input.inputHash, 'inputHash');
  if (input.outputHash !== null) assertHash(input.outputHash, 'outputHash');

  const structured = input.structuredResult ?? null;
  const serialized = JSON.stringify(structured) ?? 'null';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STRUCTURED_RESULT_BYTES) {
    throw badRequest(
      `structuredResult больше ${MAX_STRUCTURED_RESULT_BYTES} байт: в ai_runs хранится ` +
        'разобранный результат стадии, а не сырой ответ модели.',
    );
  }

  const visible = await db
    .select({ id: folders.id })
    .from(folders)
    .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, input.folderId)))
    .limit(1);
  if (visible[0] === undefined) throw notFound('Ревизия поставки не найдена.');

  const rows = await db
    .insert(aiRuns)
    .values({
      folderId: input.folderId,
      stage: input.stage,
      provider: input.provider,
      model: input.model,
      promptCode: input.promptCode,
      promptVersion: input.promptVersion,
      inputHash: input.inputHash,
      outputHash: input.outputHash,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      // `numeric` принимается строкой по той же причине, по которой и отдаётся.
      cost: input.cost === null ? null : input.cost.toFixed(4),
      latencyMs: input.latencyMs,
      structuredResult: structured,
      requestId: input.requestId,
    })
    .returning({ id: aiRuns.id });

  const id = rows[0]?.id;
  if (id === undefined) throw notFound('Запись прогона анализа не создана.');

  const created = await findAiRun(db, scope, id);
  if (created === null) throw notFound('Запись прогона анализа не найдена после создания.');
  return created;
}

function runQuery(db: Database, scope: AuthScope, ...conditions: SQL[]) {
  return db
    .select(RUN_SELECTION)
    .from(aiRuns)
    .innerJoin(folders, eq(aiRuns.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, ...conditions));
}

export async function findAiRun(
  db: Database,
  scope: AuthScope,
  runId: string,
): Promise<AiRunView | null> {
  const rows = await runQuery(db, scope, eq(aiRuns.id, runId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toView(row);
}

export interface AiRunListParams {
  readonly folderId: string;
  readonly limit: number;
  readonly cursor?: string | null | undefined;
}

export interface AiRunPage {
  readonly items: readonly AiRunView[];
  readonly nextCursor: string | null;
}

const cursorSchema = z.object({ at: z.string().min(1), id: z.string().min(1) });

/**
 * Страница прогонов ревизии, новые первыми.
 *
 * Курсор по паре `(created_at, id)`: OFFSET на растущей таблице пропускал бы
 * строки при каждом новом прогоне, а прогоны стадии `page_classify` по
 * 83-страничной поставке добавляются десятками за минуты.
 */
export async function listAiRuns(
  db: Database,
  scope: AuthScope,
  params: AiRunListParams,
): Promise<AiRunPage> {
  const after = decodeCursor(params.cursor);
  const conditions: SQL[] = [eq(aiRuns.folderId, params.folderId)];
  if (after !== null) {
    conditions.push(
      sql`(${aiRuns.createdAt}, ${aiRuns.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`,
    );
  }

  const rows = await runQuery(db, scope, ...conditions)
    .orderBy(desc(aiRuns.createdAt), desc(aiRuns.id))
    // На одну больше запрошенного: наличие следующей страницы известно без
    // отдельного COUNT по тому же условию.
    .limit(params.limit + 1);

  const page = rows.slice(0, params.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({ at: last.cursorAt, id: last.id })
      : null;

  return { items: page.map(toView), nextCursor };
}

/**
 * Фактическая трата за календарный месяц даты `at`. Это и есть `SpendReader`
 * политики бюджета (§11, `LLM_BUDGET_MONTHLY`).
 *
 * Границы считаются в UTC и передаются явными значениями, а не через
 * `date_trunc` от `now()`: бюджет обязан считаться одинаково независимо от
 * временной зоны сервера БД, а тест на «последний день месяца» иначе
 * непроверяем.
 *
 * `cost IS NULL` (провайдер не сообщил стоимость) в сумму не входит: считать
 * его нулём значило бы утверждать, что вызов был бесплатным.
 */
export async function monthlyAiSpend(db: Database, scope: AuthScope, at: Date): Promise<number> {
  const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

  const rows = await db
    .select({ total: sql<string | null>`coalesce(sum(${aiRuns.cost}), 0)::text` })
    .from(aiRuns)
    .innerJoin(folders, eq(aiRuns.folderId, folders.id))
    .where(
      withScope(
        scope,
        FOLDER_SCOPE,
        and(
          sql`${aiRuns.createdAt} >= ${from.toISOString()}::timestamptz`,
          sql`${aiRuns.createdAt} < ${to.toISOString()}::timestamptz`,
        ) ?? sql`true`,
      ),
    );

  const total = rows[0]?.total;
  return total === null || total === undefined ? 0 : Number(total);
}

function encodeCursor(cursor: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса, а не «начнём заново»: молчаливый откат
 * к первой странице выглядит для клиента как бесконечный список.
 */
function decodeCursor(raw: string | null | undefined): z.infer<typeof cursorSchema> | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = cursorSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Ниже общий отказ: разница между «не base64» и «не та форма» клиенту
    // ничего не даёт.
  }
  throw badRequest('Курсор страницы недействителен.');
}
