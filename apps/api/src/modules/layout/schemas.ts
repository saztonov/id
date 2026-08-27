/**
 * Схемы маршрутов разметки (§7, §14).
 *
 * Геометрия проверяется схемой, хотя тот же инвариант держит CHECK в
 * `layout_blocks`: БД защищает данные от любого писателя, а схема называет
 * виновное поле пользователю до записи. Уверенности детектора здесь нет ни в
 * одном ответе — её нет в `BlockOut` легаси-API (§0.1), и поле, которое нечем
 * заполнить, в контракте было бы обещанием.
 */
import { z } from 'zod';
import {
  attentionFlagSchema,
  blockSourceSchema,
  blockTypeSchema,
  contentRotationSchema,
  contentRotationSourceSchema,
  detectorProvenanceSchema,
  layoutRevisionStateSchema,
  normalizedCoordsSchema,
  shapeTypeSchema,
} from '@id/contracts';

export const revisionIdParamSchema = z.object({ revisionId: z.uuid() });
export const layoutIdParamSchema = z.object({ layoutId: z.uuid() });
export const blockParamSchema = z.object({ layoutId: z.uuid(), blockId: z.uuid() });
export const pageParamSchema = z.object({
  layoutId: z.uuid(),
  workingPageIndex: z.coerce.number().int().nonnegative(),
});

/** Фильтр списка блоков по странице рабочего документа. */
export const pageQuerySchema = z.object({
  workingPageIndex: z.coerce.number().int().nonnegative().optional(),
});

const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const layoutRevisionViewSchema = z.object({
  id: z.uuid(),
  revisionId: z.uuid(),
  bundleId: z.uuid(),
  revisionNo: z.int().positive(),
  state: layoutRevisionStateSchema,
  blocksHash: z.string().nullable(),
  version: z.int().nonnegative(),
  detectorProfile: z.enum(['rf_detr', 'full_page']),
  /**
   * Была ли ручная правка. Именно от неё зависит доступность режима
   * `full-page-text`: он удаляет прежние блоки страницы (§5.3).
   */
  manuallyEdited: z.boolean(),
  createdAt: z.string(),
});

export const layoutListSchema = z.object({ items: z.array(layoutRevisionViewSchema) });

export const pageFlagsSchema = z.object({
  workingPageIndex: z.int().nonnegative(),
  flags: z.array(attentionFlagSchema),
});

export const layoutDetailSchema = layoutRevisionViewSchema.extend({
  pages: z.array(pageFlagsSchema),
  blockCount: z.int().nonnegative(),
});

export const layoutBlockViewSchema = z.object({
  id: z.uuid(),
  layoutRevisionId: z.uuid(),
  sourcePageId: z.uuid(),
  workingPageIndex: z.int().nonnegative(),
  blockType: blockTypeSchema,
  shapeType: shapeTypeSchema,
  coords: normalizedCoordsSchema,
  points: z.array(pointSchema),
  sortOrder: z.int().nonnegative(),
  source: blockSourceSchema,
  detectorProvenance: detectorProvenanceSchema,
  /**
   * Уверенность детектора: `null` у ручных блоков и у блоков от легаси-API
   * RD WEB, чей `BlockOut` её не несёт. Экран разметки показывает её рядом с
   * блоком — оператору, решающему, снижать ли порог, нужно видеть, с какой
   * уверенностью нашлось то, что нашлось.
   */
  detectionScore: z.number().min(0).max(1).nullable(),
});

export const layoutBlockListSchema = z.object({
  layoutRevisionId: z.uuid(),
  version: z.int().nonnegative(),
  items: z.array(layoutBlockViewSchema),
});

export const startMarkupResponseSchema = z.object({
  layoutRevisionId: z.uuid(),
  bundleId: z.uuid(),
  created: z.boolean(),
  jobId: z.uuid().nullable(),
  jobCreated: z.boolean(),
});

export const blockCreateSchema = z.object({
  workingPageIndex: z.int().nonnegative(),
  blockType: blockTypeSchema,
  shapeType: shapeTypeSchema.default('rectangle'),
  coords: normalizedCoordsSchema,
  points: z.array(pointSchema).default([]),
});

export const blockUpdateSchema = z
  .object({
    blockType: blockTypeSchema.optional(),
    shapeType: shapeTypeSchema.optional(),
    coords: normalizedCoordsSchema.optional(),
    points: z.array(pointSchema).optional(),
    sortOrder: z.int().nonnegative().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Пустая правка блока: не передано ни одного поля',
  });

export const blockMutationResponseSchema = z.object({
  blockId: z.uuid(),
  version: z.int().nonnegative(),
});

export const versionResponseSchema = z.object({ version: z.int().nonnegative() });

export const detectRequestSchema = z.object({
  /**
   * Страницы для повторной детекции. Пусто — весь комплект: разбиение на пачки
   * делает конвейер, а не клиент.
   */
  workingPageIndices: z.array(z.int().nonnegative()).max(500).optional(),
});

export const detectResponseSchema = z.object({
  layoutRevisionId: z.uuid(),
  batches: z.int().nonnegative(),
  jobIds: z.array(z.uuid()),
});

export const fullPageTextResponseSchema = z.object({
  layoutRevisionId: z.uuid(),
  version: z.int().nonnegative(),
  pages: z.int().nonnegative(),
});

// =====================================================================
// Разворот содержимого страницы (ADR-0020)
// =====================================================================

export const orientationParamSchema = z.object({
  revisionId: z.uuid(),
  sourcePageId: z.uuid(),
});

/**
 * Тело правки разворота.
 *
 * Значение — четверть оборота, и схема сужает его до четырёх чисел ДО записи:
 * тот же инвариант держит CHECK таблицы, но схема называет виновное поле
 * человеку, а не отдаёт ему `restrict_violation` из драйвера.
 */
export const orientationRequestSchema = z.object({
  rotation: contentRotationSchema,
});

export const orientationResponseSchema = z.object({
  revisionId: z.uuid(),
  sourcePageId: z.uuid(),
  contentRotation: contentRotationSchema,
  /** `null` — решения нет вовсе: строку разворота никто не заводил. */
  source: contentRotationSourceSchema.nullable(),
  probeRotation: contentRotationSchema.nullable(),
  probeConfidence: z.number().min(0).max(1).nullable(),
  probeError: z.string().nullable(),
});

/*
 * Числа блоков на странице в ответе НЕТ намеренно.
 *
 * Экран, который поворачивает страницу, ровно эти блоки сейчас и рисует —
 * посчитать их он может сам, а серверное поле было бы вторым источником одного
 * и того же числа, расходящимся ровно в тот момент, когда рамку удалили в
 * соседней вкладке.
 *
 * Детекцию маршрут тоже не ставит: инженер жмёт 90, 180, 270, подбирая, и это
 * были бы три задачи подряд. Перевыделение блоков остаётся отдельным действием
 * человека — той же кнопкой, что и всегда.
 */
