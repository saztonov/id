/**
 * Схемы маршрутов распознавания (§6.2, §14).
 *
 * Секретов в ответах нет и быть не может: `settingsSnapshot` отдаётся тем же
 * redacted-снимком, что лежит в БД, а идентификаторы RD WEB — это их id, а не
 * ключи доступа. Подписанные ссылки на кропы вырезаются ещё при разборе
 * экспорта (`recognition/export.ts`), поэтому в `textMd` их нет по построению.
 */
import { z } from 'zod';
import { artifactKindSchema, recognitionStatusSchema, sha256Schema } from '@id/contracts';

export const folderIdParamSchema = z.object({ folderId: z.uuid() });
export const runIdParamSchema = z.object({ runId: z.uuid() });
export const artifactParamSchema = z.object({ runId: z.uuid(), kind: artifactKindSchema });

/**
 * Тело запроса «Отправить на распознавание».
 *
 * `layoutId` обязателен и явен (§14). «Возьми текущую» было бы удобнее и
 * опаснее: разметка у поставки одна, но между открытием экрана и нажатием
 * кнопки её мог пересобрать сосед, и распозналось бы не то, что видел
 * пользователь.
 */
export const recognizeRequestSchema = z.object({
  layoutId: z.uuid(),
  /**
   * Довести прогон до проверки или остановиться на распознанном тексте (S50).
   *
   * Умолчание `true`, и это разворот прежнего поведения. Маршрут задумывался
   * гранулярным — «поставить распознавание и ничего больше», — но кнопкой его
   * зовёт экран разметки, где нажатие означает ровно то же, что «2. Распознать»
   * на папке: человек отдал комплект порталу и ждёт ошибок. Прежнее умолчание
   * `false` стоило боевой папке двух часов: прогон закончился, анализ не
   * начался, и вкладка «Проверка» сказала «портал ещё не разобрал папку».
   *
   * Явный `false` остаётся: им пользуются сценарии сравнения провайдеров и
   * тесты, которым нужен текст без разбора.
   */
  autoContinue: z.boolean().default(true),
});

export const recognitionRunViewSchema = z.object({
  id: z.uuid(),
  folderId: z.uuid(),
  layoutRevisionId: z.uuid(),
  rdJobId: z.string().nullable(),
  localLayoutHash: sha256Schema,
  remoteLayoutHashBefore: sha256Schema.nullable(),
  remoteLayoutHashAfter: sha256Schema.nullable(),
  workingPdfSha256: sha256Schema,
  settingsSnapshot: z.unknown(),
  status: recognitionStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: z.record(z.string(), z.unknown()),
  warnings: z.array(z.unknown()),
  runDocumentClosedAt: z.string().nullable(),
});

export const recognitionRunListSchema = z.object({
  items: z.array(recognitionRunViewSchema),
});

export const recognizeResponseSchema = z.object({
  recognitionRunId: z.uuid(),
  created: z.boolean(),
  jobId: z.string(),
  jobCreated: z.boolean(),
  /**
   * Прогон пойдёт в shadow-режиме (`ai.dry_run_only`, ADR-0007): результат
   * будет собран и проверен, но не опубликован — ни распознанного текста, ни
   * документов, ни замечаний после него не появится.
   *
   * Гейта на этом маршруте нет намеренно (он и есть инструмент сравнения
   * провайдеров), поэтому признак обязан приехать в ответе: иначе
   * «распознавание запущено» означало бы разное в двух режимах, не отличаясь ни
   * одним словом.
   */
  dryRun: z.boolean(),
});

export const artifactViewSchema = z.object({
  id: z.uuid(),
  recognitionRunId: z.uuid(),
  kind: artifactKindSchema,
  artifactSha256: sha256Schema,
  byteSize: z.int().nonnegative(),
});

export const artifactListSchema = z.object({ items: z.array(artifactViewSchema) });

export const pageTextViewSchema = z.object({
  id: z.uuid(),
  sourcePageId: z.uuid(),
  workingPageIndex: z.int().nonnegative().nullable(),
  artifactVersionId: z.uuid(),
  textMd: z.string(),
  textSha256: sha256Schema,
  offsetConvention: z.literal('utf16-code-unit'),
});

export const pageTextListSchema = z.object({ items: z.array(pageTextViewSchema) });

export const blockResultViewSchema = z.object({
  layoutBlockId: z.uuid(),
  resultType: z.string(),
  contentMd: z.string().nullable(),
  modelId: z.string().nullable(),
  confidence: z.number().nullable(),
  isCurrent: z.boolean(),
});

export const blockResultListSchema = z.object({ items: z.array(blockResultViewSchema) });
