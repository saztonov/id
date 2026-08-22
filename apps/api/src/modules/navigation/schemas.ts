/**
 * Схемы запросов и ответов навигации «объект → комплект → ревизия» и реестров
 * передачи (§3, §14).
 *
 * Формы самих сущностей берутся из `@id/contracts` целиком (`workSchema`,
 * `registrySchema`, `submissionRevisionSchema`), а не переписываются здесь:
 * ответ навигации и ответ любого другого модуля обязаны описывать один и тот же
 * комплект одинаково, иначе клиент получит две несовместимые его версии.
 *
 * Строка запроса приводится из строк явно (`z.coerce`): Fastify отдаёт
 * querystring строками, а `cursorPageQuerySchema` из контрактов описывает
 * `limit` как `z.int()` — `?limit=10` этой схемой не прошёл бы. Границы страницы
 * берутся теми же константами контрактов, чтобы предел выдачи не разъехался
 * между слоями. Решение повторяет `modules/catalog/schemas.ts`.
 */
import { z } from 'zod';
import {
  cursorPageSchema,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  periodSchema,
  registryItemSchema,
  registrySchema,
  registryStatusSchema,
  sectionCodeSchema,
  sortOrderSchema,
  submissionRevisionSchema,
  uuidSchema,
  workSchema,
} from '@id/contracts';

const pageQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

/**
 * Признак в строке запроса.
 *
 * `z.coerce.boolean()` не годится: он считает истиной любую непустую строку,
 * то есть `?unassigned=false` означало бы `true`.
 */
const queryFlagSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

const searchSchema = z.string().min(1).max(200);

// =====================================================================
// Комплекты работ
// =====================================================================

export const workListQuerySchema = pageQuerySchema.extend({
  objectId: uuidSchema.optional(),
  sectionCode: sectionCodeSchema.optional(),
  period: periodSchema.optional(),
  registryId: uuidSchema.optional(),
  /** Только комплекты, ещё не включённые ни в один реестр. */
  unassigned: queryFlagSchema.optional(),
  search: searchSchema.optional(),
});

export const workIdParamSchema = z.object({ workId: uuidSchema });

export const workPageSchema = cursorPageSchema(workSchema);

export const workListSchema = z.array(workSchema);

/**
 * Тело заведения комплекта.
 *
 * `contractorId` необязателен и означает разное для разных областей. Подрядчику
 * его задавать нельзя вовсе: исполнитель берётся из его организации, а поле в
 * теле было бы приглашением завести работу от чужого имени. Генподрядчику,
 * наоборот, оно необходимо — субподрядчики учётных записей, как правило, не
 * имеют, и ПТО собирает их комплекты само. Разбор — в `resolveActingContractor`.
 */
export const createWorkBodySchema = z.object({
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema,
  period: periodSchema,
  title: z.string().min(1).max(1000),
  contractorId: uuidSchema.nullish(),
});

export const updateWorkBodySchema = z
  .object({
    title: z.string().min(1).max(1000).optional(),
    autoRunEnabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Запрос не содержит ни одного изменяемого поля.',
  });

/** Ответ заведения: и комплект, и открытая вместе с ним первая ревизия. */
export const createdWorkSchema = z.object({
  work: workSchema,
  revision: submissionRevisionSchema,
});

// =====================================================================
// Ревизии
// =====================================================================

export const revisionListQuerySchema = pageQuerySchema;

export const revisionPageSchema = cursorPageSchema(submissionRevisionSchema);

// =====================================================================
// Реестры
// =====================================================================

export const registryListQuerySchema = pageQuerySchema.extend({
  objectId: uuidSchema.optional(),
  sectionCode: sectionCodeSchema.optional(),
  period: periodSchema.optional(),
  status: registryStatusSchema.optional(),
});

export const registryIdParamSchema = z.object({ registryId: uuidSchema });

export const registryWorkParamsSchema = z.object({
  registryId: uuidSchema,
  workId: uuidSchema,
});

export const registryPageSchema = cursorPageSchema(registrySchema);

export const createRegistryBodySchema = z.object({
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema,
  period: periodSchema,
  number: z.string().max(128).nullish(),
  folderNo: z.string().max(64).nullish(),
  building: z.string().max(128).nullish(),
  floor: z.string().max(64).nullish(),
  structure: z.string().max(255).nullish(),
});

export const updateRegistryBodySchema = z
  .object({
    number: z.string().max(128).nullish(),
    folderNo: z.string().max(64).nullish(),
    building: z.string().max(128).nullish(),
    floor: z.string().max(64).nullish(),
    structure: z.string().max(255).nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Запрос не содержит ни одного изменяемого поля.',
  });

/** Порядок работы в реестре. Не задан — комплект встаёт в конец. */
export const includeWorkBodySchema = z.object({ ordinal: sortOrderSchema.nullish() });

const registryBlockerSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
});

/**
 * Карточка реестра.
 *
 * `works`, `file` и `blockers` — необязательные поля, и это не небрежность
 * схемы: подрядчику они не отдаются вовсе. «В папке 7 комплектов, из них ваш
 * один» — сведение о работе конкурентов, полученное арифметикой, и отдавать его
 * нулём вместо отсутствия значило бы соврать вместо умолчания.
 */
export const registryViewSchema = z.object({
  registry: registrySchema,
  works: z.array(workSchema).optional(),
  file: workSchema.nullish(),
  blockers: z.array(registryBlockerSchema).optional(),
});

export const registryItemListSchema = z.array(registryItemSchema);
