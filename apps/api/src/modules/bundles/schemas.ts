/**
 * Схемы рабочего документа ревизии (§3.3, §14).
 *
 * Карта страниц выдаётся наружу целиком и поштучно. Поштучное чтение не
 * удобство: результат распознавания приходит по странице рабочего PDF, а
 * замечание адресуется листу исходного файла, и тянуть карту на 83 строки ради
 * одного соответствия пришлось бы восемьдесят три раза.
 */
import { z } from 'zod';
import { isoDateTimeSchema, uuidSchema } from '@id/contracts';

export const revisionIdParamSchema = z.object({ revisionId: uuidSchema });
export const bundleIdParamSchema = z.object({ bundleId: uuidSchema });
export const bundlePageParamSchema = z.object({
  bundleId: uuidSchema,
  workingPageIndex: z.coerce.number().int().nonnegative(),
});

export const bundleSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  aggregateManifestHash: z.string(),
  workingPdfBlobSha256: z.string(),
  builderVersion: z.string(),
  createdAt: isoDateTimeSchema,
  pageCount: z.number().int().nonnegative(),
});

/**
 * Список рабочих документов ревизии с признаком актуальности состава.
 *
 * `matchesCurrentFiles` считает сервер — он и так считает это сравнение в
 * `POST /markup` и в `POST /bundle`. Признак нужен именно ДОГРУЗКЕ файла:
 * удаление и замена сносят разметку, распознавание и замечания сами, а догрузка
 * не сносит ничего, и прежний разбор продолжает описывать состав, которого
 * больше нет. Без признака экран проверки молча показывал бы ошибки не того
 * комплекта.
 *
 * В сравнении участвует только манифест состава: версия сборщика — забота
 * воркера, который пересоберёт документ сам, а пользователю о ней сказать
 * нечего.
 */
export const bundleListSchema = z.object({
  items: z.array(bundleSchema.extend({ matchesCurrentFiles: z.boolean() })),
});

export const bundlePageSchema = z.object({
  workingPageIndex: z.number().int().nonnegative(),
  sourcePageId: uuidSchema,
  sourceFileId: uuidSchema,
  fileName: z.string(),
  filePageIndex: z.number().int().nonnegative(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  rotation: z.number().int(),
});

export const bundlePageListSchema = z.object({
  bundleId: uuidSchema,
  items: z.array(bundlePageSchema),
});

/**
 * Ответ на запрос сборки.
 *
 * Содержит и задачу, и уже готовый документ. Оба поля значимы: при повторном
 * нажатии сборка не выполняется заново (тот же состав — тот же документ), и
 * клиенту нужно уметь отличить «поставлено в очередь» от «уже собрано», не
 * опрашивая список.
 */
export const bundleBuildResponseSchema = z.object({
  jobId: uuidSchema.nullable(),
  created: z.boolean(),
  bundle: bundleSchema.nullable(),
  aggregateManifestHash: z.string(),
});
