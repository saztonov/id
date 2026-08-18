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
});

export const findingListSchema = z.object({ items: z.array(findingSchema) });

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
