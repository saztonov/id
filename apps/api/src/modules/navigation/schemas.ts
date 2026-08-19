/**
 * Схемы запросов и ответов навигации «тома → поставки → ревизия» (§3, §14).
 *
 * Формы самих сущностей берутся из `@id/contracts` целиком (`volumeSchema`,
 * `submissionSchema`, `submissionRevisionSchema`), а не переписываются здесь:
 * ответ навигации и ответ любого другого модуля обязаны описывать одну и ту же
 * поставку одинаково, иначе клиент получит две несовместимые её версии.
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
  submissionRevisionSchema,
  submissionSchema,
  uuidSchema,
  volumeSchema,
} from '@id/contracts';

const pageQuerySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

/**
 * Признак в строке запроса.
 *
 * `z.coerce.boolean()` не годится: он считает истиной любую непустую строку,
 * то есть `?isActive=false` означало бы `true`.
 */
const queryFlagSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

const searchSchema = z.string().min(1).max(200);

// =====================================================================
// Тома
// =====================================================================

export const volumeListQuerySchema = pageQuerySchema.extend({
  objectId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  isActive: queryFlagSchema.optional(),
  search: searchSchema.optional(),
});

export const volumeIdParamSchema = z.object({ volumeId: uuidSchema });

export const volumePageSchema = cursorPageSchema(volumeSchema);

// =====================================================================
// Поставки
// =====================================================================

export const submissionListQuerySchema = pageQuerySchema.extend({
  volumeId: uuidSchema.optional(),
  objectId: uuidSchema.optional(),
  search: searchSchema.optional(),
});

export const submissionIdParamSchema = z.object({ submissionId: uuidSchema });

export const submissionPageSchema = cursorPageSchema(submissionSchema);

/**
 * Тело создания поставки.
 *
 * `contractorId` в нём отсутствует намеренно: организация берётся из области
 * видимости (`db/repositories/navigation.ts`). Поле в теле было бы приглашением
 * завести поставку от чужого имени.
 */
export const createSubmissionBodySchema = z.object({
  volumeId: uuidSchema,
  title: z.string().min(1).max(1000),
  number: z.string().max(128).nullish(),
});

/** Ответ создания: и поставка, и открытая вместе с ней первая ревизия. */
export const createdSubmissionSchema = z.object({
  submission: submissionSchema,
  revision: submissionRevisionSchema,
});

// =====================================================================
// Ревизии
// =====================================================================

export const revisionListQuerySchema = pageQuerySchema;

export const revisionPageSchema = cursorPageSchema(submissionRevisionSchema);
