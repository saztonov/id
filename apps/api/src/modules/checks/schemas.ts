/**
 * Схемы модуля проверок (§9, §14).
 *
 * Сводка прогона отдаётся `passthrough`-объектом намеренно: `validation_runs.counts`
 * — это jsonb, в который движок кладёт журнал исполнения правил, и жёсткая схема
 * ОТВЕТА при появлении нового счётчика давала бы 500 на прогоне, записанном
 * прежней версией. Асимметрия «строгий вход, терпимый выход» уже установлена на
 * S4 и по той же причине.
 */
import { z } from 'zod';

export const revisionIdParamSchema = z.object({ revisionId: z.uuid() });

export const runChecksResponseSchema = z.object({
  jobId: z.uuid().nullable(),
  created: z.boolean(),
});

export const validationRunSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  rulesetVersionId: z.uuid(),
  sectionProfileId: z.uuid().nullable(),
  objectRuleProfileId: z.uuid().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: z.looseObject({}),
});

export const validationRunListSchema = z.object({ items: z.array(validationRunSchema) });

/**
 * Замечание в том виде, в каком его печатает экран.
 *
 * Поля `page`, `document`, `target` и `evidence` собирает сервер, а не браузер:
 * номер страницы и название вида ИД живут только в БД, и клиент добывал первое
 * двумя лишними запросами, а второго не знал вовсе. Прецедент — `submitBlockers`
 * рабочего процесса, приходящие готовыми русскими фразами.
 *
 * Схема обязана перечислять новые поля явно: ответ сериализуется через zod
 * (`setSerializerCompiler` в `app.ts`), и не объявленное здесь поле молча
 * вырезается из тела — отладка такого расхождения стоит дороже, чем его
 * предотвращение.
 */
export const findingPageSchema = z.object({
  /** Сквозной номер страницы по комплекту. */
  number: z.int().positive(),
  /** Страница рабочего документа — только для ссылки на разметку. */
  workingPageIndex: z.int().nonnegative().nullable(),
  /** `document` — номер приблизителен: это начало документа, а не место ошибки. */
  basis: z.enum(['finding', 'evidence', 'field', 'document']),
});

export const findingDocumentSchema = z.object({
  id: z.uuid(),
  docTypeCode: z.string().nullable(),
  label: z.string(),
});

export const findingTargetSchema = z.object({
  kind: z.enum([
    'document',
    'material',
    'batch',
    'registry_row',
    'page',
    'field',
    'revision',
    'gone',
  ]),
  label: z.string(),
  detail: z.string().nullable(),
});

export const findingEvidenceSchema = z.object({
  quote: z.string(),
  pageTextVersionId: z.uuid(),
  charSpan: z.object({ start: z.int().nonnegative(), end: z.int().nonnegative() }),
});

export const findingSchema = z.object({
  id: z.uuid(),
  validationRunId: z.uuid(),
  ruleCode: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  state: z.enum(['open', 'resolved', 'waived', 'undetermined']),
  origin: z.enum(['deterministic', 'llm', 'external_unavailable']),
  isBlocking: z.boolean(),
  targetType: z.string(),
  targetId: z.uuid().nullable(),
  sourcePageId: z.uuid().nullable(),
  blockId: z.uuid().nullable(),
  message: z.string(),
  hint: z.string().nullable(),
  text: z.string(),
  page: findingPageSchema.nullable(),
  document: findingDocumentSchema.nullable(),
  target: findingTargetSchema,
  evidence: z.array(findingEvidenceSchema),
});

/**
 * Сводка экрана проверки.
 *
 * `latestRun` — самый новый прогон ревизии; по нему решается «идёт ли проверка»
 * и запирается согласование. `shownRunId` — прогон, из которого взяты `items` и
 * `counts`. Они расходятся ровно в одном случае: пока идёт повторная проверка,
 * показывается результат предыдущей — гасить экран значило бы вернуть ту самую
 * пустоту, из-за которой вкладку и переделывали.
 */
export const checksSummarySchema = z.object({
  latestRun: z
    .object({
      id: z.uuid(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
    })
    .nullable(),
  shownRunId: z.uuid().nullable(),
  coverage: z.object({
    pagesTotal: z.int().nonnegative(),
    pagesRecognized: z.int().nonnegative(),
    pagesAssigned: z.int().nonnegative(),
    pagesUnassigned: z.int().nonnegative(),
    unassignedPageNumbers: z.array(z.int().positive()),
    documentsTotal: z.int().nonnegative(),
    documentsUnknownType: z.int().nonnegative(),
  }),
  counts: z.object({
    openErrors: z.int().nonnegative(),
    openWarnings: z.int().nonnegative(),
    openInfo: z.int().nonnegative(),
    undetermined: z.int().nonnegative(),
    waived: z.int().nonnegative(),
  }),
});

export const findingListSchema = z.object({
  items: z.array(findingSchema),
  summary: checksSummarySchema,
});

/**
 * Отчёт о составе комплекта и результате проверки (S29).
 *
 * Порядок секций задан заказчиком и держится СЕРВЕРОМ: акт → строки внутреннего
 * реестра → документы о качестве → прочее → замечания без адреса. Пересортировка
 * на клиенте либо повторила бы этот порядок, либо разошлась бы с ним.
 *
 * Вердикта «чисто/не чисто» здесь нет намеренно: его считает экран по сводке
 * замечаний и покрытия (`grouping.ts`), и второе место, отвечающее на тот же
 * вопрос, разошлось бы с первым при первой правке условия.
 *
 * Поля перечисляются явно по той же причине, что и у `findingSchema`: ответ
 * сериализуется через zod, и необъявленное поле молча вырезается из тела.
 */
const reportItemSchema = z.object({
  code: z.string(),
  title: z.string(),
  /**
   * `not_applicable` и `not_run` не сливаются ни с успехом, ни с ошибкой:
   * галочка ставится ТОЛЬКО вердикту `pass` (§0.5).
   */
  status: z.enum(['ok', 'error', 'warning', 'undetermined', 'not_applicable', 'not_run']),
  detail: z.string().nullable(),
  hint: z.string().nullable(),
});

const reportRowSchema = z.object({
  id: z.string(),
  kind: z.enum(['document', 'registry_row', 'finding']),
  title: z.string(),
  subtitle: z.string().nullable(),
  page: z
    .object({
      number: z.int().positive(),
      workingPageIndex: z.int().nonnegative().nullable(),
    })
    .nullable(),
  /** Диапазон страниц документа для печати: «1–3» либо «8». */
  pages: z.string().nullable(),
  dates: z
    .object({
      issuedAt: z.string().nullable(),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
      /** Дата составления акта: его никто не выдаёт (S40). */
      composedAt: z.string().nullable(),
    })
    .nullable(),
  /** `unchecked` — прогона не было: портал НЕ ЗНАЕТ, верны ли данные. */
  status: z.enum(['ok', 'error', 'warning', 'undetermined', 'missing', 'unchecked']),
  statusText: z.string(),
  /** Способ устранения рядом со строкой: замечание без него бесполезно (§9.1). */
  statusHint: z.string().nullable(),
  /** Правило и блок замечания строки: переход «замечание → блок» (§16). */
  statusRuleCode: z.string().nullable(),
  blockId: z.uuid().nullable(),
  findingIds: z.array(z.uuid()),
  items: z.array(reportItemSchema),
});

const reportSectionSchema = z.object({
  kind: z.enum(['act', 'registry', 'quality', 'other', 'unplaced']),
  title: z.string(),
  note: z.string().nullable(),
  rows: z.array(reportRowSchema),
});

export const checkReportSchema = z.object({
  runId: z.uuid().nullable(),
  sections: z.array(reportSectionSchema),
});

export const findingQuerySchema = z.object({ validationRunId: z.uuid().optional() });

/** Каталог правил с умолчаниями: вход публикации набора (§3.7). */
export const ruleCatalogEntrySchema = z.object({
  code: z.string(),
  title: z.string(),
  docTypeCode: z.string().nullable(),
  level: z.string(),
  kind: z.string(),
  defaultSeverity: z.enum(['error', 'warning', 'info']),
  defaultBlocking: z.boolean(),
  requiresSectionProfile: z.boolean(),
  requiresExternalRegistry: z.string().nullable(),
  defaultParams: z.looseObject({}),
});

export const ruleCatalogListSchema = z.object({ items: z.array(ruleCatalogEntrySchema) });
