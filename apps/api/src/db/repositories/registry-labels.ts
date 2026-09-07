/**
 * Метки инженера на строках перечня и счёт качества сверки (S57).
 *
 * ## Зачем это существует
 *
 * Сверку строк с документами судит модель (ADR-0028), и главный вопрос о ней —
 * «стало ли лучше» — по её же решениям не отвечается. Портал может сопоставить
 * больше строк и сопоставить их неправильно; может найти расхождение и
 * придумать его. Единственный источник истины здесь — человек, посмотревший на
 * строку.
 *
 * ## Почему счёт по ДВУМ осям
 *
 * Качество сопоставления и качество замечаний — разные величины, и смешивать их
 * нельзя. Правильно найденный документ ничего не говорит о том, верны ли
 * замечания по нему; верное замечание об организации бывает и у строки, документ
 * которой выбран неверно. Доля сопоставленных строк сама по себе не показатель
 * вовсе: она растёт и когда портал стал точнее, и когда он стал смелее.
 *
 * ## Почему счёт разложен по версии промта
 *
 * Иначе он измеряет неизвестно что. Правка промта — это и есть та работа,
 * которую офлайн-гейт проверить не может (записи ответов привязаны к тексту
 * промта), и разложение по `ai_runs.prompt_version` — единственный способ
 * увидеть, что версия сделала.
 */
import { and, eq, sql } from 'drizzle-orm';

import { aiRuns, folders, registryRowLabels, registryRows } from '@id/db';

import { withScope, type ScopeTarget } from '../scoped.js';
import { guardWrites, requireVisibleFolder } from './documents.js';

import type { AuthScope } from '../../auth/scope.js';
import type { Database } from './users.js';

type ReadExecutor = Pick<Database, 'select'>;

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/** Как проверяющий оценил САМО сопоставление строки с документом. */
export const MATCH_VERDICTS = ['correct', 'wrong_document', 'not_in_folder', 'unclear'] as const;
export type MatchVerdict = (typeof MATCH_VERDICTS)[number];

/**
 * Как проверяющий оценил замечание портала по графе строки.
 *
 * `missed` — расхождение есть, а портал промолчал. Без него табло измеряло бы
 * только ложные тревоги и было бы тем оптимистичнее, чем меньше портал
 * находит.
 */
export const CHECK_VERDICTS = ['confirmed', 'false_alarm', 'missed'] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export interface CheckLabel {
  readonly kind: string;
  readonly verdict: CheckVerdict;
}

export interface RegistryRowLabelInput {
  readonly registryRowId: string;
  readonly matchVerdict: MatchVerdict;
  readonly expectedDocumentId?: string | null;
  readonly checkLabels?: readonly CheckLabel[];
  readonly seenValidationRunId?: string | null;
}

export interface RegistryRowLabelView {
  readonly registryRowId: string;
  readonly matchVerdict: MatchVerdict;
  readonly expectedDocumentId: string | null;
  readonly checkLabels: readonly CheckLabel[];
  readonly labeledAt: string;
}

/**
 * Поставить (или переставить) метку строки.
 *
 * Замена, а не накопление: у строки одно мнение проверяющего — последнее.
 * История здесь не нужна и вредна, потому что счёт по накопленным меткам
 * пришлось бы вести «по последней», то есть повторять это правило в каждом
 * запросе.
 *
 * Область применяется к строке через её папку: чужую строку не пометить, даже
 * зная идентификатор.
 */
export async function saveRegistryRowLabel(
  db: Database,
  scope: AuthScope,
  actorUserId: string,
  input: RegistryRowLabelInput,
): Promise<{ readonly saved: boolean }> {
  const rows = await db
    .select({ folderId: registryRows.folderId })
    .from(registryRows)
    .innerJoin(folders, eq(registryRows.folderId, folders.id))
    .where(withScope(scope, FOLDER_SCOPE, eq(registryRows.id, input.registryRowId)));

  const folderId = rows[0]?.folderId;
  // Строка не видна области — молча ничего не делаем и говорим об этом
  // возвратом: маршрут превратит это в 404, а не в «сохранено».
  if (folderId === undefined) return { saved: false };

  await guardWrites(() =>
    db
      .insert(registryRowLabels)
      .values({
        registryRowId: input.registryRowId,
        folderId,
        matchVerdict: input.matchVerdict,
        expectedDocumentId: input.expectedDocumentId ?? null,
        checkLabels: [...(input.checkLabels ?? [])],
        labeledBy: actorUserId,
        seenValidationRunId: input.seenValidationRunId ?? null,
      })
      .onConflictDoUpdate({
        target: registryRowLabels.registryRowId,
        set: {
          matchVerdict: input.matchVerdict,
          expectedDocumentId: input.expectedDocumentId ?? null,
          checkLabels: [...(input.checkLabels ?? [])],
          labeledBy: actorUserId,
          labeledAt: sql`now()`,
          seenValidationRunId: input.seenValidationRunId ?? null,
        },
      }),
  );

  return { saved: true };
}

export async function listRegistryRowLabels(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<readonly RegistryRowLabelView[]> {
  await requireVisibleFolder(db, scope, folderId);

  const rows = await db
    .select({
      registryRowId: registryRowLabels.registryRowId,
      matchVerdict: registryRowLabels.matchVerdict,
      expectedDocumentId: registryRowLabels.expectedDocumentId,
      checkLabels: registryRowLabels.checkLabels,
      labeledAt: sql<string>`to_char(${registryRowLabels.labeledAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(registryRowLabels)
    .where(eq(registryRowLabels.folderId, folderId));

  return rows.map((row) => ({
    registryRowId: row.registryRowId,
    matchVerdict: row.matchVerdict as MatchVerdict,
    expectedDocumentId: row.expectedDocumentId,
    checkLabels: Array.isArray(row.checkLabels) ? (row.checkLabels as CheckLabel[]) : [],
    labeledAt: row.labeledAt,
  }));
}

/** Счёт качества сопоставления: одна ось табло. */
export interface MatchScoreboard {
  /** Строк, у которых есть метка человека. Знаменатель всех долей ниже. */
  readonly labeled: number;
  readonly correct: number;
  readonly wrongDocument: number;
  readonly notInFolder: number;
  readonly unclear: number;
  /**
   * Из размеченных: скольким портал НАЗВАЛ документ.
   *
   * Отдельно от `correct`, и в этом весь смысл двух чисел: смелость и точность
   * растут по-разному, и одно число их не различает.
   */
  readonly claimed: number;
  /** Из размеченных: сколько портал оставил «не сопоставлено». */
  readonly undetermined: number;
}

/** Счёт качества замечаний: вторая ось табло. */
export interface CheckScoreboard {
  readonly confirmed: number;
  readonly falseAlarm: number;
  readonly missed: number;
  /** По видам расхождений — чтобы видеть, какой из них портал ведёт хуже. */
  readonly byKind: Readonly<
    Record<string, { confirmed: number; falseAlarm: number; missed: number }>
  >;
}

export interface Scoreboard {
  readonly folderId: string;
  /**
   * Версия промта сверки в этом прогоне; `null` — промт не опубликован.
   *
   * Ноль в `ai_runs.prompt_version` означает встроенный текст: строки каталога
   * с таким номером не бывает. Для табло это `null` — «версия неизвестна», и
   * сравнивать такие прогоны между собой нельзя.
   */
  readonly promptVersion: number | null;
  readonly match: MatchScoreboard;
  readonly checks: CheckScoreboard;
}

/**
 * Свести метки с решениями портала.
 *
 * Чистая часть — здесь, чтение — у вызывающего: счёт обязан быть проверяем
 * тестом без БД, иначе первым же его потребителем станет боевая папка.
 */
export function scoreRegistryMatching(input: {
  readonly folderId: string;
  readonly promptVersion: number | null;
  readonly rows: readonly {
    readonly id: string;
    readonly matchState: string;
    readonly checks: readonly { readonly kind: string; readonly status: string }[];
  }[];
  readonly labels: readonly RegistryRowLabelView[];
}): Scoreboard {
  const labelOf = new Map(input.labels.map((label) => [label.registryRowId, label]));

  const match: {
    labeled: number;
    correct: number;
    wrongDocument: number;
    notInFolder: number;
    unclear: number;
    claimed: number;
    undetermined: number;
  } = {
    labeled: 0,
    correct: 0,
    wrongDocument: 0,
    notInFolder: 0,
    unclear: 0,
    claimed: 0,
    undetermined: 0,
  };

  const byKind: Record<string, { confirmed: number; falseAlarm: number; missed: number }> = {};
  const checks = { confirmed: 0, falseAlarm: 0, missed: 0 };

  for (const row of input.rows) {
    const label = labelOf.get(row.id);
    if (label === undefined) continue;

    match.labeled += 1;
    if (label.matchVerdict === 'correct') match.correct += 1;
    else if (label.matchVerdict === 'wrong_document') match.wrongDocument += 1;
    else if (label.matchVerdict === 'not_in_folder') match.notInFolder += 1;
    else match.unclear += 1;

    if (row.matchState === 'matched') match.claimed += 1;
    if (row.matchState === 'undetermined') match.undetermined += 1;

    for (const check of label.checkLabels) {
      const bucket = (byKind[check.kind] ??= { confirmed: 0, falseAlarm: 0, missed: 0 });
      if (check.verdict === 'confirmed') {
        bucket.confirmed += 1;
        checks.confirmed += 1;
      } else if (check.verdict === 'false_alarm') {
        bucket.falseAlarm += 1;
        checks.falseAlarm += 1;
      } else {
        bucket.missed += 1;
        checks.missed += 1;
      }
    }
  }

  return {
    folderId: input.folderId,
    promptVersion: input.promptVersion,
    match,
    checks: { ...checks, byKind },
  };
}

/** Версия промта сверки, которой считался последний прогон папки. */
export async function readMatchPromptVersion(
  db: ReadExecutor,
  folderId: string,
): Promise<number | null> {
  const rows = await db
    .select({ promptVersion: aiRuns.promptVersion })
    .from(aiRuns)
    .where(and(eq(aiRuns.folderId, folderId), eq(aiRuns.stage, 'registry_match')))
    .orderBy(sql`${aiRuns.createdAt} desc`)
    .limit(1);

  const version = rows[0]?.promptVersion ?? null;
  // Ноль — встроенный текст промта, а не версия каталога: строки с таким
  // номером в `prompt_templates` не бывает (CHECK `version > 0`).
  return version === null || version === 0 ? null : version;
}
