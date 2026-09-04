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
 * вниз от `folders`, снятая с настоящей схемы (все 34 миграции на
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
 * `purgeDerivedForFolder` НЕ трогает `job_runs`, `ai_runs` и
 * `folder_events`. Это журнал: что портал делал с комплектом и сколько это
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
 * Поэтому каждая из трёх операций сначала зовёт `cancelJobsOfFolder`, и в
 * `purgeFolderEntirely` — обязательно ДО `FOLDER_DELETES`, где `job_runs`
 * удаляются: закрывать открытые попытки после было бы уже нечего.
 *
 * При полном удалении комплекта журнал уходит вместе с ним: строки ссылаются на
 * ревизию внешним ключом, и оставить их невозможно технически, а хранить
 * «историю несуществующего» — бессмысленно.
 */
import { sql, type SQL } from 'drizzle-orm';

import { cancelJobsOfFolder } from './jobs.js';
import type { Database } from './users.js';

type Executor = Pick<Database, 'execute'>;

/**
 * Производное содержимое ревизии, от листьев к корню.
 *
 * Каждая строка — один `DELETE`. Таблицы с собственной колонкой `folder_id`
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
    where: (id: SQL) => sql`finding_id in (select id from findings where folder_id = ${id})`,
  },
  { table: 'findings', where: (id: SQL) => sql`folder_id = ${id}` },
  {
    table: 'current_block_result',
    where: (id: SQL) =>
      sql`layout_block_id in (select id from layout_blocks where folder_id = ${id})`,
  },
  {
    table: 'block_results',
    where: (id: SQL) =>
      sql`layout_block_id in (select id from layout_blocks where folder_id = ${id})`,
  },
  { table: 'field_values', where: (id: SQL) => sql`folder_id = ${id}` },
  {
    table: 'layout_block_points',
    where: (id: SQL) => sql`block_id in (select id from layout_blocks where folder_id = ${id})`,
  },
  { table: 'layout_blocks', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'page_classifications', where: (id: SQL) => sql`folder_id = ${id}` },
  // Разворот содержимого (0052) — производное решение о странице, как и
  // классификация: ссылается на `source_pages` и обязан уйти ДО них.
  { table: 'page_orientations', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'page_text_versions', where: (id: SQL) => sql`folder_id = ${id}` },
  {
    table: 'artifact_versions',
    where: (id: SQL) =>
      sql`recognition_run_id in (select id from recognition_runs where folder_id = ${id})`,
  },
  {
    table: 'recognition_run_pages',
    where: (id: SQL) =>
      sql`recognition_run_id in (select id from recognition_runs where folder_id = ${id})`,
  },
  /*
   * Журнал отправок в RD WEB — ДО прогонов: он на них ссылается (0069).
   *
   * В `PIPELINE_RESET_KEEPS` его нет намеренно. Отправка принадлежит прогону, и
   * пережить его удаление она не может ни физически (внешний ключ), ни по
   * смыслу. Счётчик генераций при этом живёт не здесь, а в `rd_exec_documents`,
   * который сброс переживает, — поэтому следующая отправка получит следующую
   * генерацию, а не начнёт нумерацию заново.
   */
  { table: 'rd_exec_syncs', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'recognition_runs', where: (id: SQL) => sql`folder_id = ${id}` },
  {
    table: 'rd_run_documents',
    where: (id: SQL) =>
      sql`layout_revision_id in (select id from layout_revisions where folder_id = ${id})`,
  },
  { table: 'layout_revisions', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'document_relations', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'material_documents', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'page_assignments', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'registry_row_candidates', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'registry_rows', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'logical_documents', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'complects', where: (id: SQL) => sql`folder_id = ${id}` },
  {
    table: 'batches',
    where: (id: SQL) => sql`material_id in (select id from materials where folder_id = ${id})`,
  },
  { table: 'materials', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'processing_bundle_pages', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'processing_bundles', where: (id: SQL) => sql`folder_id = ${id}` },
  /*
   * Реестр внешних идентификаторов RD WEB (0069) — при ПОЛНОМ удалении папки.
   *
   * Обе таблицы стоят в `PIPELINE_RESET_KEEPS`: сброс конвейера обязан их
   * пережить. Иначе повторное распознавание объявляло бы каждый блок новым, и
   * комплект перераспознавался бы целиком за наш счёт — то есть ровно то, ради
   * чего реестр и заведён, переставало бы работать при первом же повторе.
   *
   * Порядок: блоки раньше документа (ссылаются на него), сам документ — раньше
   * `layout_blocks` не обязан: связь с разметкой объявлена `ON DELETE SET NULL`.
   */
  { table: 'rd_exec_blocks', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'rd_exec_documents', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'validation_runs', where: (id: SQL) => sql`folder_id = ${id}` },
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
  // Реестр внешних идентификаторов RD WEB (0069): именно он делает повторный
  // прогон дешёвым — неизменившийся блок остаётся тем же блоком, и модель по
  // нему не вызывается. Снеся реестр вместе с результатами, сброс превращал бы
  // каждое повторное распознавание в полное и платное.
  'rd_exec_blocks',
  'rd_exec_documents',
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
export const FOLDER_DELETES: readonly PurgeStep[] = [
  { table: 'ai_runs', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'job_runs', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'folder_events', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'source_pages', where: (id: SQL) => sql`folder_id = ${id}` },
  { table: 'source_files', where: (id: SQL) => sql`folder_id = ${id}` },
];

async function runDeletes(
  executor: Executor,
  steps: readonly PurgeStep[],
  folderId: string,
): Promise<void> {
  // Имя таблицы уходит через `sql.raw`: оно берётся из константы в этом файле и
  // снаружи не приходит. Идентификатор ревизии — всегда связанный параметр.
  const id = sql`${folderId}::uuid`;
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
export async function purgeDerivedForFolder(executor: Executor, folderId: string): Promise<void> {
  await cancelJobsOfFolder(executor, folderId);
  await runDeletes(executor, DERIVED_DELETES, folderId);
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
export async function resetPipelineForFolder(executor: Executor, folderId: string): Promise<void> {
  // Стадии перечислены, а не сняты все: сброс конвейера оставляет рабочий
  // документ и разметку, поэтому задачи `uploaded` и `layout` относятся к тому,
  // что переживает сброс, и снимать их было бы отменой чужой живой работы.
  await cancelJobsOfFolder(executor, folderId, {
    stages: ['recognition', 'analysis', 'checks'],
  });
  await runDeletes(executor, PIPELINE_RESET_DELETES, folderId);
}

/**
 * Снести папку целиком вместе с составом и журналом.
 *
 * Строка `folders` удаляется последней: до неё на папку не должно остаться ни
 * одной ссылки, иначе отказ придёт от внешнего ключа посреди транзакции.
 */
export async function purgeFolderEntirely(executor: Executor, folderId: string): Promise<void> {
  // Отмена — ДО `FOLDER_DELETES`: там удаляются `job_runs`, и закрывать
  // открытые попытки после было бы уже нечего. Порядок здесь такой же
  // обязательный, как топологический порядок самих удалений.
  await cancelJobsOfFolder(executor, folderId);
  await runDeletes(executor, DERIVED_DELETES, folderId);
  await runDeletes(executor, FOLDER_DELETES, folderId);
  await executor.execute(sql`delete from folders where id = ${folderId}`);
}
