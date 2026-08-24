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
 * При полном удалении комплекта журнал уходит вместе с ним: строки ссылаются на
 * ревизию внешним ключом, и оставить их невозможно технически, а хранить
 * «историю несуществующего» — бессмысленно.
 */
import { sql, type SQL } from 'drizzle-orm';

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
  await runDeletes(executor, DERIVED_DELETES, revisionId);
}

/**
 * Снести ревизию целиком вместе с составом и журналом.
 *
 * Строка `submission_revisions` удаляется последней: до неё на ревизию не должно
 * остаться ни одной ссылки, иначе отказ придёт от внешнего ключа посреди
 * транзакции.
 */
export async function purgeRevisionEntirely(executor: Executor, revisionId: string): Promise<void> {
  await runDeletes(executor, DERIVED_DELETES, revisionId);
  await runDeletes(executor, REVISION_DELETES, revisionId);
  await executor.execute(sql`delete from submission_revisions where id = ${revisionId}`);
}
