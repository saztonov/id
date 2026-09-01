/**
 * Сброс производного и полное удаление ревизии поставки (S24).
 *
 * ## Зачем это отдельный модуль
 *
 * Три операции портала упираются в одно и то же: чтобы убрать исходный файл или
 * комплект, надо сначала убрать всё, что из них выведено. Внешний ключ
 * `processing_bundle_pages.source_page_id → source_pages(id)` не каскадный
 * намеренно (0004), и это правильно: страница рабочего документа не должна
 * исчезать как побочный эффект. Но это же означает, что порядок удаления надо
 * знать.
 *
 * Написать его трижды по месту вызова — значит получить три разных порядка и три
 * разных набора забытых таблиц. Забытая таблица здесь не даёт мягкой ошибки: она
 * даёт `foreign key violation` из драйвера в середине операции, то есть отказ,
 * причину которого пользователю объяснить нечем.
 *
 * ## Порядок выведен из схемы, а не придуман
 *
 * Список ниже — топологическая сортировка подграфа внешних ключей, растущего
 * вниз от `submission_revisions`, снятая с настоящей схемы (все 34 миграции на
 * pglite). Он не «примерно правильный», он полный на момент написания, и
 * `purge.test.ts` заполняет каждую перечисленную таблицу и требует, чтобы
 * удаление прошло. Новая таблица со ссылкой на ревизию сломает этот тест — и
 * это единственный способ узнать о ней вовремя.
 *
 * `doc_type_candidates` в списке нет намеренно: обе его ссылки на ревизию и
 * страницу объявлены `ON DELETE SET NULL` (0003), и БД обнуляет их сама.
 * Удалять кандидата вида ИД из-за того, что исчез комплект, было бы неверно —
 * это накопленное знание каталога, а не часть комплекта.
 *
 * ## Что считается производным, а что историей
 *
 * `purgeDerivedForRevision` НЕ трогает `job_runs`, `ai_runs`, `review_actions` и
 * `revision_events`. Это журнал: что портал делал с комплектом и сколько это
 * стоило. Пересборка разметки не отменяет факта, что прошлая разметка была, и
 * стирать след предыдущей попытки вместе с её результатом значило бы прятать от
 * пользователя, что попытка вообще случалась.
 *
 * ## Почему сносу предшествует отмена задач
 *
 * Очередь производным не является и в списках ниже её нет: `jobs` ссылается на
 * ревизию через payload, без внешнего ключа, — поэтому удаление проходило и
 * оставляло задачи жить. Оставленные, они делали ровно две вещи. Мёртвая
 * держала `dead > 0`, то есть красную плашку «обработка остановилась» на
 * ревизии, у которой снесли причину отказа. Стоящая в очереди просыпалась по
 * `next_run_at`, не находила ни прогона, ни разметки и рождала нового мертвеца:
 * сброс не заканчивал прошлую попытку, а размножал её.
 *
 * Поэтому каждая из трёх операций сначала зовёт `cancelJobsOfRevision`, и в
 * `purgeRevisionEntirely` — обязательно ДО `REVISION_DELETES`, где `job_runs`
 * удаляются: закрывать открытые попытки после было бы уже нечего.
 *
 * При полном удалении комплекта журнал уходит вместе с ним: строки ссылаются на
 * ревизию внешним ключом, и оставить их невозможно технически, а хранить
 * «историю несуществующего» — бессмысленно.
 */
import { sql, type SQL } from 'drizzle-orm';

import { cancelJobsOfRevision } from './jobs.js';
import type { Database } from './users.js';

type Executor = Pick<Database, 'execute'>;

/**
 * Производное содержимое ревизии, от листьев к корню.
 *
 * Каждая строка — один `DELETE`. Таблицы с собственной колонкой `revision_id`
 * отбираются по ней напрямую; остальные — подзапросом по родителю, и подзапрос
 * назван явно, а не выведен из имени, чтобы связь читалась на месте.
 */
export interface PurgeStep {
  readonly table: string;
  /**
   * Условие отбора. Функция, а не строка: идентификатор ревизии приходит из
   * запроса и обязан уехать в БД СВЯЗАННЫМ параметром. Склеенный в текст, он
   * стал бы инъекцией, и валидация `z.uuid()` на маршруте это не оправдывает —
   * репозиторий не может опираться на то, что все его будущие вызывающие
   * помнят про неё.
   */
  readonly where: (id: SQL) => SQL;
}

export const DERIVED_DELETES: readonly PurgeStep[] = [
  {
    table: 'finding_evidence',
    where: (id: SQL) => sql`finding_id in (select id from findings where revision_id = ${id})`,
  },
  { table: 'findings', where: (id: SQL) => sql`revision_id = ${id}` },
  {
    table: 'current_block_result',
    where: (id: SQL) =>
      sql`layout_block_id in (select id from layout_blocks where revision_id = ${id})`,
  },
  {
    table: 'block_results',
    where: (id: SQL) =>
      sql`layout_block_id in (select id from layout_blocks where revision_id = ${id})`,
  },
  { table: 'field_values', where: (id: SQL) => sql`revision_id = ${id}` },
  {
    table: 'layout_block_points',
    where: (id: SQL) => sql`block_id in (select id from layout_blocks where revision_id = ${id})`,
  },
  { table: 'layout_blocks', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'page_classifications', where: (id: SQL) => sql`revision_id = ${id}` },
  // Разворот содержимого (0052) — производное решение о странице, как и
  // классификация: ссылается на `source_pages` и обязан уйти ДО них.
  { table: 'page_orientations', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'page_text_versions', where: (id: SQL) => sql`revision_id = ${id}` },
  {
    table: 'artifact_versions',
    where: (id: SQL) =>
      sql`recognition_run_id in (select id from recognition_runs where revision_id = ${id})`,
  },
  {
    table: 'recognition_run_pages',
    where: (id: SQL) =>
      sql`recognition_run_id in (select id from recognition_runs where revision_id = ${id})`,
  },
  { table: 'recognition_runs', where: (id: SQL) => sql`revision_id = ${id}` },
  {
    table: 'rd_run_documents',
    where: (id: SQL) =>
      sql`layout_revision_id in (select id from layout_revisions where revision_id = ${id})`,
  },
  { table: 'layout_revisions', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'document_relations', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'material_documents', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'page_assignments', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_reconciliation_extra_docs', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_reconciliation_rows', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_row_candidates', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_rows', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'logical_documents', where: (id: SQL) => sql`revision_id = ${id}` },
  {
    table: 'batches',
    where: (id: SQL) => sql`material_id in (select id from materials where revision_id = ${id})`,
  },
  { table: 'materials', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'processing_bundle_pages', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'processing_bundles', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_reconciliation_groups', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_reconciliation_works', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_reconciliations', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'validation_runs', where: (id: SQL) => sql`revision_id = ${id}` },
];

/**
 * Что переживает сброс конвейера: рабочий документ, разметка и развороты.
 *
 * Сброс — это «распознать заново поверх той же разметки», поэтому сама разметка,
 * её блоки и рабочий документ, на котором она лежит, обязаны остаться. Рабочий
 * документ вдобавок нельзя снести технически: `layout_revisions.bundle_id`
 * ссылается на него внешним ключом.
 *
 * `page_orientations` добавлены в S41. Разворот — свойство СКАНА, а не результат
 * конвейера: страница, снятая боком, останется такой после любого повторного
 * запуска, и мнение о ней не устаревает. Пока строки сносились, повтор разметки
 * комплекта на 220 страниц заново платил за 220 вызовов модели и столько же
 * минут ждал — а пользователь всё это время видел счётчик разметки на нуле и
 * не мог отличить работу от зависания. Ручной поворот (`source='user'`) тем
 * более обязан переживать сброс: его поставил человек, а не портал.
 */
const PIPELINE_RESET_KEEPS: readonly string[] = [
  'layout_block_points',
  'layout_blocks',
  'layout_revisions',
  'page_orientations',
  'processing_bundle_pages',
  'processing_bundles',
];

/**
 * Сброс конвейера: всё производное НИЖЕ разметки.
 *
 * Вычисляется фильтром по `DERIVED_DELETES`, а не пишется вторым списком. Порядок
 * здесь — топологическая сортировка подграфа внешних ключей, снятая с настоящей
 * схемы; второй экземпляр этого знания разошёлся бы с первым при появлении новой
 * таблицы, и разошёлся бы молча — до `foreign key violation` посреди операции.
 *
 * Зачем сброс нужен вообще: `block_results.layout_block_id` объявлен
 * `ON DELETE RESTRICT` (0004), поэтому перевыделить блоки поверх распознанной
 * страницы нельзя, пока результаты на месте. То же и для повторного
 * распознавания: «заменяет предыдущее» — это буквально снести предыдущее.
 */
export const PIPELINE_RESET_DELETES: readonly PurgeStep[] = DERIVED_DELETES.filter(
  (step) => !PIPELINE_RESET_KEEPS.includes(step.table),
);

/**
 * Остальное, что держит ревизию: журнал, состав и членство в папке.
 *
 * Отдельным списком, потому что применяется только при полном удалении. Порядок
 * продолжает тот же топологический ряд: страницы раньше файлов, всё остальное —
 * после производного.
 */
export const REVISION_DELETES: readonly PurgeStep[] = [
  { table: 'ai_runs', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'job_runs', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'legal_holds', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'registry_items', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'review_actions', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'revision_events', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'submission_archives', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'source_pages', where: (id: SQL) => sql`revision_id = ${id}` },
  { table: 'source_files', where: (id: SQL) => sql`revision_id = ${id}` },
];

/**
 * Что держит РЕЕСТР помимо ревизий его файла описи (S37).
 *
 * Отдельный список, потому что растёт он от другого корня: `registries`, а не
 * `submission_revisions`. Комплекты состава реестром не держатся — у них
 * `registry_id` обнуляется, — а вот снимок состава и прогоны сверки ссылаются
 * на сам реестр и удаление отвергнут.
 *
 * `registry_reconciliation_works/_groups/_rows/_extra_docs` здесь НЕ
 * перечислены: все четыре объявлены `ON DELETE CASCADE` от
 * `registry_reconciliations` (0030), и повторять каскад руками значило бы
 * держать второй порядок удаления рядом с настоящим.
 *
 * Список живёт здесь, а не в `navigation.ts`, по той же причине, по которой
 * здесь живут остальные: порядок удаления обязан быть в одном месте, и его
 * полноту сверяет `purge.test.ts`.
 */
export const REGISTRY_DELETES: readonly PurgeStep[] = [
  { table: 'registry_reconciliations', where: (id: SQL) => sql`registry_id = ${id}` },
  { table: 'registry_items', where: (id: SQL) => sql`registry_id = ${id}` },
];

async function runDeletes(
  executor: Executor,
  steps: readonly PurgeStep[],
  revisionId: string,
): Promise<void> {
  // Имя таблицы уходит через `sql.raw`: оно берётся из константы в этом файле и
  // снаружи не приходит. Идентификатор ревизии — всегда связанный параметр.
  const id = sql`${revisionId}::uuid`;
  for (const step of steps) {
    await executor.execute(sql`delete from ${sql.raw(step.table)} where ${step.where(id)}`);
  }
}

/**
 * Снести всё, что выведено из состава ревизии.
 *
 * Сам состав (`source_files`, `source_pages`) и строка ревизии остаются: их
 * правит вызывающий. После этого рабочий документ, разметка, распознавание,
 * документы и замечания придётся получать заново — об этом обязан предупредить
 * интерфейс ДО нажатия, а не после.
 */
export async function purgeDerivedForRevision(
  executor: Executor,
  revisionId: string,
): Promise<void> {
  await cancelJobsOfRevision(executor, revisionId);
  await runDeletes(executor, DERIVED_DELETES, revisionId);
}

/**
 * Снести результаты конвейера, оставив рабочий документ и разметку.
 *
 * Одна операция на два повтора: «выделить блоки заново» и «распознать заново».
 * Разделять их незачем — оба означают ровно одно: всё, что было выведено из
 * прежнего распознавания, больше не описывает то, что получится сейчас, а
 * половинчатая чистка оставила бы документы и замечания, указывающие на блоки с
 * другими идентификаторами. Такие данные выглядят целыми и врут.
 */
export async function resetPipelineForRevision(
  executor: Executor,
  revisionId: string,
): Promise<void> {
  // Стадии перечислены, а не сняты все: сброс конвейера оставляет рабочий
  // документ и разметку, поэтому задачи `uploaded` и `layout` относятся к тому,
  // что переживает сброс, и снимать их было бы отменой чужой живой работы.
  await cancelJobsOfRevision(executor, revisionId, {
    stages: ['recognition', 'analysis', 'checks'],
  });
  await runDeletes(executor, PIPELINE_RESET_DELETES, revisionId);
}

/**
 * Снести то, что держит реестр, кроме комплектов его состава.
 *
 * Зовётся из `deleteRegistry` последним шагом перед удалением самой строки:
 * комплекты к этому моменту уже отвязаны, а файл описи удалён целиком вместе со
 * своими ревизиями. Остаются снимок состава и прогоны сверки — они ссылаются на
 * реестр, а не на ревизию, и `purgeRevisionEntirely` их не касается.
 */
export async function purgeRegistryTail(executor: Executor, registryId: string): Promise<void> {
  const id = sql`${registryId}::uuid`;
  for (const step of REGISTRY_DELETES) {
    await executor.execute(sql`delete from ${sql.raw(step.table)} where ${step.where(id)}`);
  }
}

/**
 * Снести ревизию целиком вместе с составом и журналом.
 *
 * Строка `submission_revisions` удаляется последней: до неё на ревизию не должно
 * остаться ни одной ссылки, иначе отказ придёт от внешнего ключа посреди
 * транзакции.
 */
export async function purgeRevisionEntirely(executor: Executor, revisionId: string): Promise<void> {
  // Отмена — ДО `REVISION_DELETES`: там удаляются `job_runs`, и закрывать
  // открытые попытки после было бы уже нечего. Порядок здесь такой же
  // обязательный, как топологический порядок самих удалений.
  await cancelJobsOfRevision(executor, revisionId);
  await runDeletes(executor, DERIVED_DELETES, revisionId);
  await runDeletes(executor, REVISION_DELETES, revisionId);
  await executor.execute(sql`delete from submission_revisions where id = ${revisionId}`);
}
