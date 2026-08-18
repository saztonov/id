/**
 * Схемы маршрутов документов (§8, §14).
 *
 * Перечисления входа закрыты, перечисления ВЫХОДА — нет. Асимметрия
 * намеренная и уже оплаченная на S4: ужесточение схемы ответа до закрытого
 * списка давало 500 на строке, которую БД считает корректной (профиль,
 * сохранённый до введения перечня категорий). Состав меток, ролей и исходов
 * держит CHECK в БД, а схема ответа отдаёт то, что там лежит.
 *
 * Секретов в ответах нет по построению: цитата и `charSpan` описывают текст
 * страницы этой же поставки, а подписанные ссылки RD WEB вырезаны ещё при
 * разборе экспорта (`recognition/export.ts`).
 */
import { z } from 'zod';
import { documentRelationSchema, matchStateSchema } from '@id/contracts';

export const revisionIdParamSchema = z.object({ revisionId: z.uuid() });
export const documentIdParamSchema = z.object({ documentId: z.uuid() });

/**
 * Тело запроса «Собрать документы».
 *
 * Параметров нет: что именно сегментировать, задаёт ревизия, а откуда брать
 * текст — последний завершённый прогон распознавания. Дать клиенту выбирать
 * прогон значило бы позволить собрать документы по одному распознаванию, а
 * реквизиты извлечь по другому.
 *
 * Схема ПОДКЛЮЧЕНА к маршруту, а не описана «на будущее»: объявленная и
 * никем не применённая схема тела — это документация, выглядящая как проверка.
 * `optional()` — потому что тела у запроса законно может не быть вовсе.
 */
export const segmentRequestSchema = z.object({}).optional();

export const segmentResponseSchema = z.object({
  revisionId: z.uuid(),
  jobId: z.string(),
  /** `false` — задача уже стояла в очереди: повтор нажатия безопасен (§12). */
  jobCreated: z.boolean(),
});

const charSpanSchema = z
  .object({ start: z.int().nonnegative(), end: z.int().nonnegative() })
  .nullable();

const documentViewSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  docTypeCode: z.string().nullable(),
  ordinal: z.int().nonnegative(),
  title: z.string().nullable(),
  folderGroup: z.string().nullable(),
  typeConfidence: z.number().nullable(),
  boundaryConfidence: z.number().nullable(),
  needsReview: z.boolean(),
  isConfirmed: z.boolean(),
  confirmedBy: z.uuid().nullable(),
  confirmedAt: z.string().nullable(),
  /** Значение ETag: с ним же приходит `If-Match` на подтверждении. */
  version: z.int().nonnegative(),
  pageCount: z.int().nonnegative(),
});

export const documentListSchema = z.object({ items: z.array(documentViewSchema) });

const documentPageSchema = z.object({
  sourcePageId: z.uuid(),
  revisionOrdinal: z.int().nonnegative(),
  sortOrder: z.int().nonnegative().nullable(),
  pageRoleCode: z.string().nullable(),
  needsReview: z.boolean(),
});

export const documentDetailSchema = documentViewSchema.extend({
  pages: z.array(documentPageSchema),
  relations: z.array(
    z.object({
      parentDocumentId: z.uuid(),
      childDocumentId: z.uuid(),
      relation: documentRelationSchema,
    }),
  ),
});

const fieldValueViewSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  fieldCode: z.string(),
  valueText: z.string().nullable(),
  valueDate: z.string().nullable(),
  valueNum: z.string().nullable(),
  valueJson: z.unknown(),
  confidence: z.number().nullable(),
  isVerified: z.boolean(),
  extractorVersion: z.string(),
  /** Доказательство: версия текста, точный диапазон и цитата (§8.4). */
  pageTextVersionId: z.uuid().nullable(),
  charSpan: charSpanSchema,
  quote: z.string().nullable(),
  extractedBy: z.string(),
});

export const fieldValueListSchema = z.object({ items: z.array(fieldValueViewSchema) });

const pageAccountingItemSchema = z.object({
  sourcePageId: z.uuid(),
  revisionOrdinal: z.int().nonnegative(),
  documentId: z.uuid().nullable(),
  sortOrder: z.int().nonnegative().nullable(),
  pageRoleCode: z.string().nullable(),
  /** Причина непривязки; у привязанной страницы `null` (`page_assignments_state_chk`). */
  reason: z.string().nullable(),
  needsReview: z.boolean(),
});

/**
 * Учёт страниц ревизии.
 *
 * `unaccounted` — отдельным полем, а не молчанием. Список обязан быть пуст
 * (§16), и именно поэтому он отдаётся: экран, который просто не показывает
 * потерянные страницы, делает нарушение инварианта ненаблюдаемым.
 */
export const pageAccountingSchema = z.object({
  items: z.array(pageAccountingItemSchema),
  unaccounted: z.array(
    z.object({
      sourcePageId: z.uuid(),
      sourceFileId: z.uuid(),
      revisionOrdinal: z.int().nonnegative(),
    }),
  ),
  counts: z.object({
    assigned: z.int().nonnegative(),
    unassigned: z.int().nonnegative(),
    unaccounted: z.int().nonnegative(),
  }),
});

const registryRowViewSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  rowNo: z.int().positive(),
  sectionTitle: z.string().nullable(),
  docNameRaw: z.string(),
  docNoRaw: z.string().nullable(),
  orgRaw: z.string().nullable(),
  docNoNorm: z.string().nullable(),
  docNoFolded: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  issuedAt: z.string().nullable(),
  matchedDocumentId: z.uuid().nullable(),
  matchScore: z.number().nullable(),
  matchState: matchStateSchema,
});

export const registryListSchema = z.object({ items: z.array(registryRowViewSchema) });

/**
 * Объяснение решения по странице.
 *
 * Отдаются все четыре составляющие: чем получена метка, насколько уверенно, по
 * какому фрагменту текста и что проиграло. Решение, о котором известен только
 * исход, неотличимо от угаданного.
 */
const classificationViewSchema = z.object({
  sourcePageId: z.uuid(),
  revisionOrdinal: z.int().nonnegative(),
  label: z.string(),
  docTypeCode: z.string().nullable(),
  typeOutcome: z.string(),
  observedTitle: z.string().nullable(),
  pageRoleCode: z.string().nullable(),
  parentRef: z.string().nullable(),
  confidence: z.number().nullable(),
  reason: z.string().nullable(),
  source: z.string(),
  pageTextVersionId: z.uuid().nullable(),
  charSpan: charSpanSchema,
  quote: z.string().nullable(),
  alternatives: z.array(z.string()),
  ambiguous: z.boolean(),
});

export const classificationListSchema = z.object({ items: z.array(classificationViewSchema) });

/**
 * Подтверждение типа и границ документа инженером.
 *
 * `docTypeCode` необязателен: подтвердить можно и предложенный конвейером тип,
 * не меняя его. `needsReview` по умолчанию снимается — смысл пометки «человек
 * ещё не смотрел» исчерпан самим подтверждением.
 */
export const confirmRequestSchema = z.object({
  docTypeCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/u, 'Код вида ИД — слаг из строчных латинских букв, цифр и _')
    .max(64)
    .optional(),
  needsReview: z.boolean().optional(),
});
