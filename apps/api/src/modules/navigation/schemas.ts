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
  processingStageSchema,
  reconciliationExtraDocumentSchema,
  reconciliationGroupSchema,
  reconciliationRowSchema,
  reconciliationWorkSchema,
  registryItemSchema,
  registryReconciliationSchema,
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
export const workListQuerySchema = pageQuerySchema.extend({
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
  registryId: uuidSchema.optional(),
  /** Только комплекты, ещё не включённые ни в один реестр. */
  unassigned: queryFlagSchema.optional(),
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
  unassigned: queryFlagSchema.optional(),
  search: searchSchema.optional(),
});

export const objectIdParamSchema = z.object({ objectId: uuidSchema });

export const sectionCountsSchema = z.array(
  z.object({ sectionCode: sectionCodeSchema, works: z.int().min(0) }),
);

/**
 * Состояние конвейера по комплектам страницы списка.
 *
 * Идентификаторы приходят строкой через запятую, а не массивом: это `GET`, и
 * повторяющийся ключ (`?workIds=a&workIds=b`) разные клиенты кодируют
 * по-разному. Ограничение сверху — `MAX_PAGE_LIMIT`: спрашивать про больше, чем
 * помещается на странице, незачем, а без потолка запрос стал бы способом
 * заказать произвольно тяжёлый агрегат.
 */
export const workPipelineQuerySchema = z.object({
  workIds: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((part) => part.trim()))
    .pipe(z.array(uuidSchema).min(1).max(MAX_PAGE_LIMIT)),
});

export const workPipelineSchema = z.array(
  z.object({
    workId: uuidSchema,
    revisionId: uuidSchema,
    stage: processingStageSchema,
    queued: z.int().min(0),
    running: z.int().min(0),
    dead: z.int().min(0),
  }),
);

export const workIdParamSchema = z.object({ workId: uuidSchema });

/**
 * Предпросмотр удаления комплекта (S24).
 *
 * Числа отдаются отдельным ответом, а не считаются на клиенте по уже загруженным
 * спискам: экран комплекта не держит ни блоков разметки, ни замечаний, и
 * посчитать их ему нечем. Диалог удаления обязан назвать, что именно исчезнет, —
 * иначе «Удалить комплект?» это вопрос, на который нельзя ответить осознанно.
 */
/**
 * Что исчезнет вместе с реестром.
 *
 * `worksDetached` и удаляемое названы РАЗНЫМИ полями намеренно: комплекты
 * состава только отвязываются, и склеить их в один счётчик «будет удалено»
 * значило бы напугать человека тем, чего не произойдёт.
 */
export const registryDeletionPreviewSchema = z.object({
  registryId: uuidSchema,
  number: z.string().nullable(),
  status: registryStatusSchema,
  worksDetached: z.int().nonnegative(),
  registryItems: z.int().nonnegative(),
  reconciliations: z.int().nonnegative(),
  file: z
    .object({
      workId: uuidSchema,
      title: z.string(),
      revisions: z.int().nonnegative(),
      files: z.int().nonnegative(),
      pages: z.int().nonnegative(),
    })
    .nullable(),
  blockers: z.array(z.string()),
});

export const workDeletionPreviewSchema = z.object({
  workId: uuidSchema,
  title: z.string(),
  revisions: z.int().nonnegative(),
  files: z.int().nonnegative(),
  pages: z.int().nonnegative(),
  layoutBlocks: z.int().nonnegative(),
  documents: z.int().nonnegative(),
  findings: z.int().nonnegative(),
  /** Готовые русские фразы: словарь поверх кодов на клиенте потерял бы числа. */
  blockers: z.array(z.string()),
});

export const workPageSchema = cursorPageSchema(workSchema);

export const workListSchema = z.array(workSchema);

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
export const createWorkBodySchema = z.object({
  objectId: uuidSchema,
  sectionCode: sectionCodeSchema,
  // Месяца здесь нет намеренно (S30): его выводит конвейер по самому раннему
  // распознанному акту. Спрашивать его при заведении значило бы просить
  // человека назвать то, чего он ещё не видел, — акта в этот момент нет.
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

/** Ревизия комплекта: адрес результата сверки по ОДНОМУ комплекту (S20). */
export const revisionIdParamSchema = z.object({ revisionId: uuidSchema });

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
  /**
   * Сводка сверки описи — числа и вердикт, без списков (S20).
   *
   * Поле того же класса, что `works`/`blockers`: подрядчику не отдаётся вовсе,
   * потому что относится к папке целиком. Свои расхождения он читает на экране
   * СВОЕГО комплекта, где нет ни чужих работ, ни общих счётчиков.
   */
  reconciliation: registryReconciliationSchema.nullish(),
});

export const registryItemListSchema = z.array(registryItemSchema);

// =====================================================================
// Сверка описи передачи (S20)
// =====================================================================

/**
 * Постановка сверки. `202`, а не `200`: сверяет воркер, и ответ маршрута
 * означает «задача принята», а не «результат готов».
 */
export const reconcileResponseSchema = z.object({
  jobId: uuidSchema,
  /** `false` — такая задача уже стоит в очереди; повтор безопасен (§12). */
  created: z.boolean(),
});

/**
 * Сводка сверки ПО ПАПКЕ.
 *
 * Отдаётся только под `registry.manage`. Здесь есть всё, что относится к папке
 * целиком, — шапка описи, группы без комплекта, комплекты вне описи, общие
 * счётчики, — и потому маршрут, отдающий эту схему, подрядчику недоступен.
 */
export const registryReconciliationViewSchema = z.object({
  reconciliation: registryReconciliationSchema.nullable(),
  works: z.array(reconciliationWorkSchema).optional(),
  groups: z.array(reconciliationGroupSchema).optional(),
  rows: z.array(reconciliationRowSchema).optional(),
  extraDocuments: z.array(reconciliationExtraDocumentSchema).optional(),
});

/**
 * Результат сверки ПО ОДНОМУ КОМПЛЕКТУ.
 *
 * Полей о папке в схеме нет вовсе — ни шапки, ни групп, ни чужих комплектов,
 * ни общих счётчиков. Это не забывчивость и не «спрячем на экране»: подрядчик
 * имеет право знать об ошибках в своих документах и не имеет права знать о
 * работе соседей по папке, и выражено это типом, а не условием в обработчике,
 * которое однажды забудут.
 */
export const workReconciliationViewSchema = z.object({
  work: reconciliationWorkSchema.nullable(),
  rows: z.array(reconciliationRowSchema),
  extraDocuments: z.array(reconciliationExtraDocumentSchema),
  /** Версия разбора и время прогона: ими объясняется расхождение двух сверок. */
  parserVersion: z.string().max(64).nullable(),
  finishedAt: z.string().max(64).nullable(),
});

/** Отметка «расхождение разобрано»: суждение человека, а не наблюдение. */
export const reviewReconciliationBodySchema = z.object({
  note: z.string().min(10).max(1000),
});
