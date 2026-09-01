-- S44. Портал перестаёт согласовывать и перестаёт вести реестры передачи.
--
-- ## Что происходило
--
-- Модель ИД строилась вокруг подачи и согласования: ревизия поставки жила в
-- статусах `draft → submitted → in_review → returned → approved → superseded`,
-- сорок с лишним триггеров запирали её содержимое в терминальных статусах, а
-- папка передачи (`registries`) заводилась руками и сверялась с комплектами
-- отдельным конвейером.
--
-- Ничего из этого не работало. В боевой базе шесть комплектов, у каждого ровно
-- одна ревизия номер один в статусе `draft`; `review_actions`, `legal_holds`,
-- `submission_archives`, `registry_items` и `registry_reconciliations` пусты —
-- ноль строк в каждой. То есть уровень согласования не использовался ни разу, а
-- сверка описи не выполнялась никогда.
--
-- Заказчик снял посылку прямо: из портала документация никуда не передаётся и
-- юридически значимых подписей в нём нет. Портал — инструмент контроля
-- качества: загрузили, проверили, исправили, перезалили. Опись передачи при
-- этом никуда не девается — она приходит страницами внутри того же файла и
-- проверяется как обычный документ вида `transfer_registry`.
--
-- ## Что снимается
--
-- 1. Двадцать один триггер `deny_locked_revision_content`/
--    `deny_locked_source_page_content`: они запирали содержимое по СТАТУСУ
--    ревизии, а статуса больше не будет.
-- 2. Четыре триггера самой `submission_revisions`: неизменяемость состава,
--    решения, запрет переоткрытия и удаления.
-- 3. Четыре триггера удаления, чьё условие срабатывания — `NOT
--    *_revision_is_draft(...)`. Все ревизии базы — черновики, поэтому условие
--    ложно всегда, и снятие триггера поведения не меняет.
-- 4. Таблицы согласования и удержания: `review_actions`, `submission_archives`,
--    `legal_holds` — вместе со своими триггерами.
-- 5. Реестры передачи целиком: `registries`, `registry_items` и пять таблиц
--    сверки описи.
--
-- ## Что остаётся и почему
--
-- `immutability_enforced()` и ключ `core.enforce_immutability` НЕ удаляются:
-- переключатель читают `deny_modification()` и `deny_confirmed_document_delete()`,
-- а они живут дальше. Неизменяемость производных артефактов (распознанный
-- текст, рабочий документ, артефакт прогона) на статусе ревизии не держалась и
-- сохраняется: `*_immutable_update` остаются на месте.
--
-- Триггеры публикации промтов и наборов правил (`prompt_templates_*`,
-- `ruleset_*`) к ревизиям отношения не имеют и не трогаются.
--
-- ## Обратного пути нет
--
-- Миграция разрушительная: снимаются таблицы и их данные. Восстановление —
-- только из дампа, снятого шагом развёртывания перед применением.

-- ---------------------------------------------------------------------------
-- 1. Триггеры, запиравшие содержимое по статусу ревизии.
-- ---------------------------------------------------------------------------

DROP TRIGGER batches_revision_locked ON batches;
DROP TRIGGER block_results_revision_locked ON block_results;
DROP TRIGGER current_block_result_revision_locked ON current_block_result;
DROP TRIGGER document_relations_revision_locked ON document_relations;
DROP TRIGGER field_values_revision_locked ON field_values;
DROP TRIGGER layout_block_points_revision_locked ON layout_block_points;
DROP TRIGGER layout_blocks_revision_locked ON layout_blocks;
DROP TRIGGER layout_revisions_revision_locked ON layout_revisions;
DROP TRIGGER logical_documents_revision_locked ON logical_documents;
DROP TRIGGER material_documents_revision_locked ON material_documents;
DROP TRIGGER materials_revision_locked ON materials;
DROP TRIGGER page_assignments_revision_locked ON page_assignments;
DROP TRIGGER page_classifications_revision_locked ON page_classifications;
DROP TRIGGER page_orientations_revision_locked ON page_orientations;
DROP TRIGGER page_text_versions_revision_locked ON page_text_versions;
DROP TRIGGER processing_bundle_pages_revision_locked ON processing_bundle_pages;
DROP TRIGGER processing_bundles_revision_locked ON processing_bundles;
DROP TRIGGER recognition_runs_revision_locked ON recognition_runs;
DROP TRIGGER registry_rows_revision_locked ON registry_rows;
DROP TRIGGER source_files_revision_locked ON source_files;
DROP TRIGGER source_pages_revision_locked ON source_pages;

-- ---------------------------------------------------------------------------
-- 2. Триггеры самой ревизии и триггеры удаления, висевшие на «черновике».
-- ---------------------------------------------------------------------------

DROP TRIGGER submission_revisions_content_immutable ON submission_revisions;
DROP TRIGGER submission_revisions_decided_immutable ON submission_revisions;
DROP TRIGGER submission_revisions_no_reopen ON submission_revisions;
DROP TRIGGER submission_revisions_no_delete ON submission_revisions;

-- Заморозка разметки снята ещё в 0048 (`state` теперь только `draft`
-- либо `superseded`), и запретить эти триггеры уже ничего не могли. Но их
-- ветка удаления звала `revision_is_draft()`, которую снимает эта же миграция:
-- оставленные, они падали бы на КАЖДОМ удалении блока.
DROP TRIGGER layout_blocks_frozen_content_immutable ON layout_blocks;
DROP TRIGGER layout_block_points_frozen_content_immutable ON layout_block_points;

DROP TRIGGER artifact_versions_immutable_delete ON artifact_versions;
DROP TRIGGER page_text_versions_immutable_delete ON page_text_versions;
DROP TRIGGER processing_bundles_immutable_delete ON processing_bundles;
DROP TRIGGER layout_revisions_no_delete ON layout_revisions;

-- ---------------------------------------------------------------------------
-- 3. Таблицы согласования и удержания.
-- ---------------------------------------------------------------------------

DROP TABLE review_actions;
DROP TABLE submission_archives;
DROP TABLE legal_holds;

-- ---------------------------------------------------------------------------
-- 4. Реестры передачи и сверка описи.
-- ---------------------------------------------------------------------------

DROP TABLE registry_reconciliation_extra_docs;
DROP TABLE registry_reconciliation_rows;
DROP TABLE registry_reconciliation_groups;
DROP TABLE registry_reconciliation_works;
DROP TABLE registry_reconciliations;
DROP TABLE registry_items;

ALTER TABLE works DROP CONSTRAINT works_registry_fk;
ALTER TABLE works DROP CONSTRAINT works_registry_kind_chk;
ALTER TABLE works DROP COLUMN registry_id;
ALTER TABLE works DROP COLUMN kind;

DROP TABLE registries;

-- ---------------------------------------------------------------------------
-- 5. Функции, которым больше некого спрашивать.
-- ---------------------------------------------------------------------------

DROP FUNCTION require_approved_revision();
DROP FUNCTION deny_locked_revision_content();
DROP FUNCTION deny_locked_source_page_content();
DROP FUNCTION deny_frozen_layout_content();
DROP FUNCTION revision_is_draft(uuid);
DROP FUNCTION block_revision_is_draft(uuid);
DROP FUNCTION run_revision_is_draft(uuid);

DROP FUNCTION deny_released_hold_change();
