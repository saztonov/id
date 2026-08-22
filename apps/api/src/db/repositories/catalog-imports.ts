/**
 * Массовый ввод справочников: приём файла, предпросмотр, применение (§3.2).
 *
 * ## Состояние живёт в статусе, а переходы — в CAS
 *
 * `uploading → parsing → ready → applied`, плюс `failed` и `expired`. Каждый
 * переход выполняется одним `UPDATE … WHERE status = <ожидаемый> RETURNING`, и
 * это не украшение: между «администратор увидел готовый предпросмотр» и
 * «нажал применить» проходят минуты, за которые он успевает нажать дважды, а
 * второй воркер — подобрать ту же задачу. Проверка статуса чтением, а затем
 * запись породила бы ровно тот дефект, ради которого в портале везде стоят
 * `If-Match` и `dedupe_key`: два применения одного файла, то есть два комплекта
 * карточек.
 *
 * ## Дубликаты перепроверяются на применении, а не только на разборе
 *
 * Разбор работает над снимком справочника, снятым в момент чтения файла. Между
 * ним и применением справочник живёт: те же строки могли приехать вторым
 * импортом или быть заведены формой. `counterparties.inn` при этом НЕ уникален
 * в схеме (два ИП с одним ИНН — законный случай для §3.2), поэтому база такое
 * не остановит, и проверка обязана быть здесь. Строка, ставшая дубликатом,
 * помечается и пропускается, а не отменяет весь пакет: остальные сорок девять
 * карточек ни в чём не виноваты.
 *
 * ## Почему аудит один на импорт, а не на карточку
 *
 * След обязан отвечать на вопрос «кто и что завёл». Для пакета из пятисот строк
 * пятьсот записей журнала отвечают на него хуже, чем одна: они вытеснят из
 * ленты всё остальное за день. Поэтому в `audit_log` пишется одно действие с
 * количествами, а поимённый состав остаётся в `catalog_import_rows`, где у
 * каждой строки лежит `created_entity_id`. Эта таблица не чистится вместе с
 * файлом: файл — разовый ввод, а история ввода — нет.
 */

import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  catalogImportRows,
  catalogImports,
  constructionObjects,
  counterparties,
  counterpartyKinds,
} from '@id/db';
import type {
  CatalogImportProblem,
  CatalogImportStatus,
  CatalogImportTarget,
  CatalogImportVerdict,
} from '@id/contracts';
import type { AuthScope } from '../../auth/scope.js';
import { conflict, notFound } from '../../lib/problem.js';
import { appendAudit, type AuditActor } from './audit.js';
import {
  normalizeOrgName,
  type CatalogSnapshot,
  type ParsedImportRow,
} from '../../catalog-import/parse.js';

type Database = NodePgDatabase;
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

// =====================================================================
// Формы
// =====================================================================

export interface CatalogImportRecord {
  readonly id: string;
  readonly target: CatalogImportTarget;
  readonly status: CatalogImportStatus;
  readonly fileName: string;
  readonly sizeBytes: number | null;
  readonly rowCount: number;
  readonly errorCount: number;
  readonly duplicateCount: number;
  readonly createdCount: number;
  readonly failureReason: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly parsedAt: string | null;
  readonly appliedAt: string | null;
  readonly expiresAt: string;
}

export interface CatalogImportRowRecord {
  readonly id: string;
  readonly rowNo: number;
  readonly raw: Record<string, string>;
  readonly verdict: CatalogImportVerdict;
  readonly problems: readonly CatalogImportProblem[];
  readonly createdEntityId: string | null;
}

/** Метка времени в ISO-8601 средствами БД: разбор в JS дал бы зону процесса. */
function iso(column: unknown, alias: string): ReturnType<typeof sql<string>> {
  return sql<string>`to_char(${column as never} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as(
    alias,
  ) as never;
}

const IMPORT_SELECTION = {
  id: catalogImports.id,
  target: catalogImports.target,
  status: catalogImports.status,
  fileName: catalogImports.fileName,
  sizeBytes: catalogImports.sizeBytes,
  rowCount: catalogImports.rowCount,
  errorCount: catalogImports.errorCount,
  duplicateCount: catalogImports.duplicateCount,
  createdCount: catalogImports.createdCount,
  failureReason: catalogImports.failureReason,
  createdBy: catalogImports.createdBy,
  createdAt: iso(catalogImports.createdAt, 'created_at_iso'),
  parsedAt: iso(catalogImports.parsedAt, 'parsed_at_iso'),
  appliedAt: iso(catalogImports.appliedAt, 'applied_at_iso'),
  expiresAt: iso(catalogImports.expiresAt, 'expires_at_iso'),
};

interface RawImportRow {
  readonly target: string;
  readonly status: string;
  readonly sizeBytes: string | number | null;
  readonly [key: string]: unknown;
}

/**
 * Приведение перечислений и `bigint`.
 *
 * Их состав держит CHECK в БД (`catalog_imports_target_chk`,
 * `catalog_imports_status_chk`), а форму ответа — схема маршрута; разбор схемой
 * ещё и здесь означал бы третью проверку одного инварианта. `size_bytes` —
 * `bigint`, и драйвер отдаёт его строкой: без приведения оно уехало бы в JSON
 * строкой и разошлось бы с контрактом.
 */
function toImport(row: RawImportRow): CatalogImportRecord {
  return {
    ...(row as unknown as CatalogImportRecord),
    target: row.target as CatalogImportTarget,
    status: row.status as CatalogImportStatus,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  };
}

// =====================================================================
// Заведение и чтение
// =====================================================================

export interface CreateImportInput {
  readonly target: CatalogImportTarget;
  readonly fileName: string;
  readonly s3Key: string;
  readonly expiresAt: Date;
}

export async function createCatalogImport(
  db: Database,
  scope: AuthScope,
  input: CreateImportInput,
  actor: AuditActor,
): Promise<CatalogImportRecord> {
  const importId = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(catalogImports)
      .values({
        target: input.target,
        fileName: input.fileName,
        s3Key: input.s3Key,
        createdBy: scope.userId,
        expiresAt: input.expiresAt.toISOString(),
      })
      .returning({ id: catalogImports.id });

    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('импорт справочника не создан');

    await appendAudit(tx, scope, {
      ...actor,
      action: 'catalog_import.started',
      entityType: 'catalog_import',
      entityId: id,
      objectId: null,
      payload: { target: input.target, fileName: input.fileName },
    });
    return id;
  });

  const found = await findCatalogImport(db, importId);
  if (found === null) throw new Error('импорт справочника не читается после создания');
  return found;
}

export async function findCatalogImport(
  db: Executor,
  importId: string,
): Promise<CatalogImportRecord | null> {
  const rows = await db
    .select(IMPORT_SELECTION)
    .from(catalogImports)
    .where(eq(catalogImports.id, importId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toImport(row as unknown as RawImportRow);
}

/** Ключ объекта в хранилище: нужен уборке и разбору, наружу не отдаётся. */
export async function findImportObjectKey(db: Executor, importId: string): Promise<string | null> {
  const rows = await db
    .select({ s3Key: catalogImports.s3Key })
    .from(catalogImports)
    .where(eq(catalogImports.id, importId))
    .limit(1);
  return rows[0]?.s3Key ?? null;
}

export interface ImportListParams {
  readonly target?: CatalogImportTarget | undefined;
  readonly limit: number;
}

export async function listCatalogImports(
  db: Database,
  params: ImportListParams,
): Promise<readonly CatalogImportRecord[]> {
  const rows = await db
    .select(IMPORT_SELECTION)
    .from(catalogImports)
    .where(params.target === undefined ? undefined : eq(catalogImports.target, params.target))
    .orderBy(desc(catalogImports.createdAt))
    .limit(params.limit);
  return rows.map((row) => toImport(row as unknown as RawImportRow));
}

export interface ImportRowListParams {
  readonly verdict?: CatalogImportVerdict | undefined;
  readonly limit: number;
  readonly afterRowNo?: number | undefined;
}

export async function listCatalogImportRows(
  db: Database,
  importId: string,
  params: ImportRowListParams,
): Promise<readonly CatalogImportRowRecord[]> {
  const rows = await db
    .select({
      id: catalogImportRows.id,
      rowNo: catalogImportRows.rowNo,
      raw: catalogImportRows.raw,
      verdict: catalogImportRows.verdict,
      problems: catalogImportRows.problems,
      createdEntityId: catalogImportRows.createdEntityId,
    })
    .from(catalogImportRows)
    .where(
      and(
        eq(catalogImportRows.importId, importId),
        params.verdict === undefined ? undefined : eq(catalogImportRows.verdict, params.verdict),
        params.afterRowNo === undefined
          ? undefined
          : gt(catalogImportRows.rowNo, params.afterRowNo),
      ),
    )
    .orderBy(asc(catalogImportRows.rowNo))
    .limit(params.limit);

  return rows.map((row) => ({
    id: row.id,
    rowNo: row.rowNo,
    raw: (row.raw ?? {}) as Record<string, string>,
    verdict: row.verdict as CatalogImportVerdict,
    problems: (row.problems ?? []) as readonly CatalogImportProblem[],
    createdEntityId: row.createdEntityId,
  }));
}

// =====================================================================
// Переходы состояния
// =====================================================================

/** Результат перехода: `null` — импорта нет, `false` — он был в другом статусе. */
async function transition(
  executor: Executor,
  importId: string,
  from: readonly CatalogImportStatus[],
  patch: Record<string, unknown>,
): Promise<boolean | null> {
  const exists = await executor
    .select({ status: catalogImports.status })
    .from(catalogImports)
    .where(eq(catalogImports.id, importId))
    .limit(1);
  if (exists.length === 0) return null;

  const updated = await executor
    .update(catalogImports)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(catalogImports.id, importId), inArray(catalogImports.status, [...from])))
    .returning({ id: catalogImports.id });
  return updated.length > 0;
}

/** Ошибка перехода в текст, который читает человек. */
export function importConflict(current: CatalogImportStatus): never {
  const explanation: Record<CatalogImportStatus, string> = {
    uploading: 'файл ещё не загружен',
    parsing: 'файл разбирается',
    ready: 'предпросмотр готов',
    applied: 'импорт уже применён',
    failed: 'разбор файла не удался',
    expired: 'импорт истёк, файл удалён',
  };
  throw conflict(`Действие недоступно: ${explanation[current]}.`);
}

export interface CompleteUploadInput {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** `uploading → parsing`. Второй `complete` того же импорта — 409. */
export async function startImportParsing(
  db: Database,
  importId: string,
  input: CompleteUploadInput,
): Promise<CatalogImportRecord> {
  const moved = await transition(db, importId, ['uploading'], {
    status: 'parsing',
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
  });
  if (moved === null) throw notFound('Импорт справочника не найден.');
  if (!moved) {
    const current = await findCatalogImport(db, importId);
    importConflict(current?.status ?? 'failed');
  }
  const found = await findCatalogImport(db, importId);
  if (found === null) throw notFound('Импорт справочника не найден.');
  return found;
}

/** `parsing → failed`: разбор упёрся в файл, который книгой не является. */
export async function failCatalogImport(
  db: Database,
  importId: string,
  reason: string,
): Promise<void> {
  await transition(db, importId, ['uploading', 'parsing', 'ready'], {
    status: 'failed',
    failureReason: reason,
  });
}

/**
 * `parsing → ready`: сохранение разобранных строк.
 *
 * Строки пишутся одной вставкой и заменяют прежние, если задача выполняется
 * повторно (очередь `at-least-once`, §12): второй прогон обязан дать то же
 * состояние, а не удвоить предпросмотр.
 */
export async function saveCatalogImportRows(
  db: Database,
  importId: string,
  rows: readonly ParsedImportRow[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(catalogImportRows).where(eq(catalogImportRows.importId, importId));

    if (rows.length > 0) {
      await tx.insert(catalogImportRows).values(
        rows.map((row) => ({
          importId,
          rowNo: row.rowNo,
          raw: row.raw,
          normalized: row.normalized,
          verdict: row.verdict,
          problems: [...row.problems],
        })),
      );
    }

    const counts = {
      rowCount: rows.length,
      errorCount: rows.filter((r) => r.verdict === 'error').length,
      duplicateCount: rows.filter((r) => r.verdict === 'duplicate').length,
    };

    await tx
      .update(catalogImports)
      .set({ ...counts, status: 'ready', parsedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(catalogImports.id, importId), eq(catalogImports.status, 'parsing')));
  });
}

// =====================================================================
// Снимок справочника для разбора
// =====================================================================

/**
 * Состояние справочника одним чтением.
 *
 * Наименования складываются в мультикарту: одинаковые названия у разных
 * организаций встречаются, и разбор обязан отличать «нашёл один» от «нашёл
 * три», а не брать первый попавшийся.
 */
export interface MutableCatalogSnapshot extends CatalogSnapshot {
  readonly kinds: Map<string, boolean>;
  readonly counterpartyByInn: Map<string, string>;
  readonly counterpartyByName: Map<string, string[]>;
  readonly objectCodes: Set<string>;
}

export async function loadCatalogSnapshot(db: Executor): Promise<MutableCatalogSnapshot> {
  const kinds = await db
    .select({ code: counterpartyKinds.code, isActive: counterpartyKinds.isActive })
    .from(counterpartyKinds);

  const parties = await db
    .select({ id: counterparties.id, name: counterparties.name, inn: counterparties.inn })
    .from(counterparties);

  const objects = await db.select({ code: constructionObjects.code }).from(constructionObjects);

  const byInn = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const party of parties) {
    if (party.inn !== null && !byInn.has(party.inn)) byInn.set(party.inn, party.id);
    const key = normalizeOrgName(party.name);
    const bucket = byName.get(key);
    if (bucket === undefined) byName.set(key, [party.id]);
    else bucket.push(party.id);
  }

  return {
    kinds: new Map(kinds.map((k) => [k.code, k.isActive])),
    counterpartyByInn: byInn,
    counterpartyByName: byName,
    objectCodes: new Set(objects.map((o) => o.code.toUpperCase())),
  };
}

// =====================================================================
// Применение
// =====================================================================

export interface ApplyResult {
  readonly created: number;
  readonly skipped: number;
}

interface PendingRow {
  readonly id: string;
  readonly rowNo: number;
  readonly normalized: Record<string, string | null>;
}

/**
 * Создание карточек по строкам с вердиктом `create`.
 *
 * Одна транзакция на весь пакет: половина заведённого справочника хуже, чем
 * ничего, — она выглядит как успех и обнаруживается через неделю. Дубликат при
 * этом пакет не отменяет (см. заголовок файла): строка помечается и
 * пропускается.
 */
export async function applyCatalogImport(
  db: Database,
  scope: AuthScope,
  importId: string,
  actor: AuditActor,
): Promise<ApplyResult> {
  const before = await findCatalogImport(db, importId);
  if (before === null) throw notFound('Импорт справочника не найден.');
  if (before.status !== 'ready') importConflict(before.status);

  return db.transaction(async (tx) => {
    // Блокировка строки импорта: два одновременных применения одного файла
    // должны выстроиться в очередь, а не разойтись по разным снимкам.
    const locked = await tx
      .select({ status: catalogImports.status })
      .from(catalogImports)
      .where(eq(catalogImports.id, importId))
      .for('update')
      .limit(1);
    const current = locked[0]?.status as CatalogImportStatus | undefined;
    if (current === undefined) throw notFound('Импорт справочника не найден.');
    if (current !== 'ready') importConflict(current);

    const pending = await tx
      .select({
        id: catalogImportRows.id,
        rowNo: catalogImportRows.rowNo,
        normalized: catalogImportRows.normalized,
      })
      .from(catalogImportRows)
      .where(and(eq(catalogImportRows.importId, importId), eq(catalogImportRows.verdict, 'create')))
      .orderBy(asc(catalogImportRows.rowNo));

    const rows: PendingRow[] = pending
      .filter((row) => row.normalized !== null)
      .map((row) => ({
        id: row.id,
        rowNo: row.rowNo,
        normalized: row.normalized as Record<string, string | null>,
      }));

    // Снимок снимается ЗАНОВО, уже внутри транзакции: между разбором и
    // применением справочник мог измениться, а `counterparties.inn` уникальным
    // ключом не закрыт.
    const snapshot = await loadCatalogSnapshot(tx);

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      const duplicate =
        before.target === 'counterparties'
          ? isCounterpartyKnown(row.normalized, snapshot)
          : snapshot.objectCodes.has(String(row.normalized['code'] ?? '').toUpperCase());

      if (duplicate) {
        skipped += 1;
        await tx
          .update(catalogImportRows)
          .set({
            verdict: 'duplicate',
            problems: [
              {
                column: null,
                code: 'created_meanwhile',
                message: 'Запись появилась в справочнике между разбором файла и применением.',
              },
            ],
          })
          .where(eq(catalogImportRows.id, row.id));
        continue;
      }

      const entityId =
        before.target === 'counterparties'
          ? await insertCounterparty(tx, row.normalized, snapshot)
          : await insertObject(tx, row.normalized, snapshot);

      created += 1;
      await tx
        .update(catalogImportRows)
        .set({ createdEntityId: entityId })
        .where(eq(catalogImportRows.id, row.id));
    }

    await tx
      .update(catalogImports)
      .set({
        status: 'applied',
        createdCount: created,
        appliedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(catalogImports.id, importId));

    await appendAudit(tx, scope, {
      ...actor,
      action: 'catalog_import.applied',
      entityType: 'catalog_import',
      entityId: importId,
      objectId: null,
      payload: { target: before.target, created, skipped },
    });

    return { created, skipped };
  });
}

function isCounterpartyKnown(
  normalized: Record<string, string | null>,
  snapshot: MutableCatalogSnapshot,
): boolean {
  const inn = normalized['inn'];
  if (inn !== null && inn !== undefined && inn !== '') return snapshot.counterpartyByInn.has(inn);
  const key = normalizeOrgName(String(normalized['name'] ?? ''));
  return (snapshot.counterpartyByName.get(key) ?? []).length > 0;
}

async function insertCounterparty(
  tx: Executor,
  normalized: Record<string, string | null>,
  snapshot: MutableCatalogSnapshot,
): Promise<string> {
  const inserted = await tx
    .insert(counterparties)
    .values({
      name: String(normalized['name'] ?? ''),
      kind: String(normalized['kind'] ?? ''),
      inn: normalized['inn'] ?? null,
      kpp: normalized['kpp'] ?? null,
      ogrn: normalized['ogrn'] ?? null,
      legalAddress: normalized['legalAddress'] ?? null,
    })
    .returning({ id: counterparties.id });

  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('контрагент не создан импортом');

  // Снимок поддерживается в актуальном состоянии по ходу пакета: без этого два
  // одинаковых ИНН ВНУТРИ одного применения прошли бы оба.
  const inn = normalized['inn'];
  if (inn !== null && inn !== undefined && inn !== '') snapshot.counterpartyByInn.set(inn, id);
  const key = normalizeOrgName(String(normalized['name'] ?? ''));
  const bucket = snapshot.counterpartyByName.get(key);
  if (bucket === undefined) snapshot.counterpartyByName.set(key, [id]);
  else bucket.push(id);

  return id;
}

async function insertObject(
  tx: Executor,
  normalized: Record<string, string | null>,
  snapshot: MutableCatalogSnapshot,
): Promise<string> {
  const inserted = await tx
    .insert(constructionObjects)
    .values({
      code: String(normalized['code'] ?? ''),
      name: String(normalized['name'] ?? ''),
      fullName: String(normalized['fullName'] ?? ''),
      address: normalized['address'] ?? null,
      cadastralNumber: normalized['cadastralNumber'] ?? null,
      permitIdentifier: normalized['permitIdentifier'] ?? null,
      actNumberPattern: normalized['actNumberPattern'] ?? null,
      developerId: normalized['developerId'] ?? null,
      techCustomerId: normalized['techCustomerId'] ?? null,
      generalContractorId: normalized['generalContractorId'] ?? null,
    })
    .returning({ id: constructionObjects.id });

  const id = inserted[0]?.id;
  if (id === undefined) throw new Error('объект строительства не создан импортом');
  snapshot.objectCodes.add(String(normalized['code'] ?? '').toUpperCase());
  return id;
}

// =====================================================================
// Уборка
// =====================================================================

export interface ExpiredImport {
  readonly id: string;
  readonly s3Key: string;
}

/**
 * Импорты, у которых вышел срок: их файлы пора убрать из хранилища.
 *
 * Отбираются только незавершённые (`uploading`, `ready`): применённый и
 * отказавший освобождают объект сразу, у них ключ уже пуст. Отдельного
 * обработчика `storage.gc` в воркере нет, и уборка импорта его не ждёт —
 * файл со списком контрагентов не должен лежать в хранилище месяцами потому,
 * что кто-то не вернулся к предпросмотру.
 */
export async function claimExpiredImports(
  db: Database,
  limit: number,
): Promise<readonly ExpiredImport[]> {
  const rows = await db
    .update(catalogImports)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        inArray(catalogImports.status, ['uploading', 'ready']),
        lte(catalogImports.expiresAt, sql`now()`),
        sql`${catalogImports.id} in (
          select id from catalog_imports
           where status in ('uploading', 'ready') and expires_at <= now()
           order by expires_at
           limit ${limit}
           for update skip locked
        )`,
      ),
    )
    .returning({ id: catalogImports.id, s3Key: catalogImports.s3Key });

  return rows;
}
