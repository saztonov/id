/**
 * Схемы запросов и ответов навигации «объект → комплект → ревизия» и реестров
 * передачи (§3, §14).
 *
 * Формы самих сущностей берутся из `@id/contracts` целиком (`folderSchema`,
 * `registrySchema`, `folderSchema`), а не переписываются здесь:
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
  processingStageSchema,
  sectionCodeSchema,
  folderSchema,
  uuidSchema,
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

/**
 * Отбор комплектов.
 *
 * `period` (точный месяц) и пара `periodFrom`/`periodTo` живут рядом намеренно.
 * Точный месяц — вопрос «что за август», и его задают реестр и сверка описи, где
 * период — свойство папки, а не диапазон. Границы — вопрос «что за квартал», и
 * его задаёт человек на экране объекта. Выражать первое вырожденным диапазоном
 * значило бы заставить каждого вызывающего повторять `from === to`.
 *
 * Границы включительные и независимые: задана одна — вторая не подразумевается.
 */
export const folderListQuerySchema = pageQuerySchema.extend({
  objectId: uuidSchema.optional(),
  sectionCode: sectionCodeSchema.optional(),
  period: periodSchema.optional(),
  /**
   * Пускать в отбор по месяцу комплекты, месяц которых ещё не определён (S30).
   *
   * Нужен списку кандидатов на включение в реестр: комплект, который портал ещё
   * не распознал, месяца не имеет, а включить его можно. По умолчанию выключен —
   * обычный отбор «за август» это вопрос о фактах.
   */
  includeUndatedPeriod: queryFlagSchema.optional(),
  periodFrom: periodSchema.optional(),
  periodTo: periodSchema.optional(),
  search: searchSchema.optional(),
});

/**
 * Сколько комплектов в каждом разделе объекта.
 *
 * Считается ТОЙ ЖЕ областью видимости, что и сам список: заголовок «комплектов 7»
 * над панелью, в которой подрядчику видны два, сообщил бы ему о работе соседей —
 * тем же способом, каким это делал бы счётчик комплектов в чужой папке (см.
 * `registryViewSchema`). Поэтому число здесь — не «сколько есть», а «сколько
 * видно спрашивающему», и другого числа портал не знает.
 */
export const sectionCountsQuerySchema = z.object({
  sectionCode: sectionCodeSchema.optional(),
  period: periodSchema.optional(),
  periodFrom: periodSchema.optional(),
  periodTo: periodSchema.optional(),
  search: searchSchema.optional(),
});

export const objectIdParamSchema = z.object({ objectId: uuidSchema });

export const sectionCountsSchema = z.array(
  z.object({ sectionCode: sectionCodeSchema, folders: z.int().min(0) }),
);

/**
 * Состояние конвейера по комплектам страницы списка.
 *
 * Идентификаторы приходят строкой через запятую, а не массивом: это `GET`, и
 * повторяющийся ключ (`?folderIds=a&folderIds=b`) разные клиенты кодируют
 * по-разному. Ограничение сверху — `MAX_PAGE_LIMIT`: спрашивать про больше, чем
 * помещается на странице, незачем, а без потолка запрос стал бы способом
 * заказать произвольно тяжёлый агрегат.
 */
export const folderPipelineQuerySchema = z.object({
  folderIds: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((part) => part.trim()))
    .pipe(z.array(uuidSchema).min(1).max(MAX_PAGE_LIMIT)),
});

export const folderPipelineSchema = z.array(
  z.object({
    folderId: uuidSchema,
    stage: processingStageSchema,
    queued: z.int().min(0),
    running: z.int().min(0),
    dead: z.int().min(0),
  }),
);

export const folderIdParamSchema = z.object({ folderId: uuidSchema });

/**
 * Предпросмотр удаления комплекта (S24).
 *
 * Числа отдаются отдельным ответом, а не считаются на клиенте по уже загруженным
 * спискам: экран комплекта не держит ни блоков разметки, ни замечаний, и
 * посчитать их ему нечем. Диалог удаления обязан назвать, что именно исчезнет, —
 * иначе «Удалить комплект?» это вопрос, на который нельзя ответить осознанно.
 */
export const folderDeletionPreviewSchema = z.object({
  folderId: uuidSchema,
  title: z.string(),
  files: z.int().nonnegative(),
  pages: z.int().nonnegative(),
  layoutBlocks: z.int().nonnegative(),
  documents: z.int().nonnegative(),
  findings: z.int().nonnegative(),
  /** Готовые русские фразы: словарь поверх кодов на клиенте потерял бы числа. */
  blockers: z.array(z.string()),
});

export const folderPageSchema = cursorPageSchema(folderSchema);

export const folderListSchema = z.array(folderSchema);

/**
 * Тело заведения комплекта.
 *
 * `contractorId` необязателен и означает разное для разных областей. Подрядчику
 * его задавать нельзя вовсе: исполнитель берётся из его организации, а поле в
 * теле было бы приглашением завести работу от чужого имени. Генподрядчику,
 * наоборот, оно необходимо — субподрядчики учётных записей, как правило, не
 * имеют, и ПТО собирает их комплекты само.
 *
 * Проверяющему поле оставлено, но с S37 оно НЕОБЯЗАТЕЛЬНО и на экране не
 * показывается: без него исполнитель выводится из карточки объекта и метится
 * признаком «подставлен порталом». Схему при этом не сузили — человек, который
 * знает исполнителя, вправе назвать его, и такое значение признаком не метится.
 * Разбор — в `resolveActingContractor`.
 */
export const createFolderBodySchema = z.object({
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema,
  // Месяца здесь нет намеренно (S30): его выводит конвейер по самому раннему
  // распознанному акту. Спрашивать его при заведении значило бы просить
  // человека назвать то, чего он ещё не видел, — акта в этот момент нет.
  title: z.string().min(1).max(1000),
  contractorId: uuidSchema.nullish(),
});

export const updateFolderBodySchema = z
  .object({
    title: z.string().min(1).max(1000).optional(),
    autoRunEnabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Запрос не содержит ни одного изменяемого поля.',
  });

/** Ответ заведения: и комплект, и открытая вместе с ним первая ревизия. */
export const createdFolderSchema = z.object({ folder: folderSchema });

// =====================================================================
// Ревизии
// =====================================================================

// =====================================================================
// Реестры
