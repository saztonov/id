-- S44. Ревизия и комплект схлопываются в ПАПКУ, комплект становится уровнем под ней.
--
-- ## Что происходило
--
-- Иерархия ИД была четырёхуровневой: объект → раздел → комплект (`works`) →
-- ревизия поставки (`submission_revisions`) → файлы, страницы, документы.
-- Уровень ревизии задумывался под повторную подачу и согласование, а после
-- того, как согласование снято (0058), от него не осталось ничего: в боевой
-- базе у каждого из шести комплектов ровно одна ревизия номер один, и
-- `createWork` всегда создавала пару «комплект + ревизия» одной транзакцией.
-- Два уровня описывали одну сущность.
--
-- Одновременно выяснилось, что загружают в портал НЕ комплект одной работы.
-- Боевой файл «ИД Мастер апрель 2026.pdf» — это папка: опись передачи и
-- двенадцать актов освидетельствования, у каждого свой перечень приложений,
-- свои паспорта, сертификаты, заключения и исполнительная схема. Портал считал
-- все 220 страниц одним комплектом, и от этого ломалось всё, что опирается на
-- границу акта: сверка перечня приложений искала документ по ВСЕЙ папке и
-- получала 72 «сопоставлено неоднозначно» (один и тот же сертификат лежит в
-- приложениях двенадцати актов), а граф связей построил семь рёбер
-- «акт → документ качества» вместо сотни с лишним.
--
-- ## Что вводится
--
-- 1. `submission_revisions` переименована в `folders` и вобрала колонки
--    `works`. Это НЕ перенос данных: строка ревизии остаётся собой, у неё тот
--    же `id`, и все 25 дочерних таблиц продолжают ссылаться на тот же ключ.
--    Меняется имя колонки: `revision_id` → `folder_id`.
--
--    Схлопывание дёшево именно потому, что изоляция §4.1 держится на ключах
--    `(id, object_id, contractor_id)` и `(id, object_id)`, объявленных на
--    ревизии, а не на комплекте. Они остаются на месте вместе со всеми
--    составными внешними ключами дочерних таблиц.
--
-- 2. `complects` — новый уровень ПОД папкой: акт освидетельствования вместе со
--    своим перечнем приложений, приложениями и исполнительной схемой. Строки
--    создаёт сегментация, человек их не заводит.
--
-- 3. `complect_id` появляется у девяти таблиц, которые описывают СОДЕРЖАНИЕ, а
--    не бумагу: документы, реквизиты, строки перечня, связи, материалы,
--    замечания, прогоны правил. Страницы, файлы, разметка и распознавание
--    остаются на папке: страница принадлежит файлу, документ — акту.
--
-- ## Почему ссылка на комплект СОСТАВНАЯ
--
-- `complect_id` обязан быть NULL-евым: опись передачи, титульные листы и всё,
-- что лежит до первого акта, ни одному комплекту не принадлежат, а папка без
-- актов — законное состояние, а не сбой.
--
-- Но простой ключ `complect_id → complects (id)` доказывает лишь существование
-- комплекта, а не то, что он из ЭТОЙ папки. Документ одной папки, сославшийся
-- на комплект другой, прошёл бы такой ключ насквозь — и увёз бы в отчёт чужой
-- состав.
--
-- Поэтому ссылка составная, парой с `folder_id`. При `MATCH SIMPLE` (умолчание)
-- ключ не проверяется, если хотя бы одна колонка NULL, а `folder_id` здесь
-- NOT NULL всегда — значит единственный непроверяемый случай это «комплекта нет
-- вовсе», ровно тот, ради которого колонка и сделана необязательной. Тот же
-- приём и по той же причине уже применён к доказательствам `field_values`
-- (0005).
--
-- ## Обратного пути нет
--
-- Миграция разрушительная: `works` снимается, статусы и номера ревизий
-- удаляются. Восстановление — только из дампа, снятого шагом развёртывания.

-- ---------------------------------------------------------------------------
-- 0. Очередь обязана быть пуста.
--
-- `jobs.payload` адресует работу идентификатором ревизии. После переименования
-- незавершённая задача указывала бы в никуда, поэтому остатки снимаются здесь,
-- с названной причиной.
-- ---------------------------------------------------------------------------

UPDATE jobs
   SET status = 'cancelled',
       last_error = 'снята при переходе на папки: адресация задач сменилась',
       locked_by = NULL,
       locked_until = NULL,
       updated_at = now()
 WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- 1. Ревизия становится папкой и вбирает колонки комплекта.
-- ---------------------------------------------------------------------------

ALTER TABLE works DROP CONSTRAINT works_current_revision_fk;
ALTER TABLE submission_revisions DROP CONSTRAINT submission_revisions_scope_fk;
ALTER TABLE submission_revisions DROP CONSTRAINT submission_revisions_submission_id_fkey;

ALTER TABLE submission_revisions RENAME TO folders;

ALTER TABLE folders
  ADD COLUMN section_code             text,
  ADD COLUMN period                   date,
  ADD COLUMN title                    text,
  ADD COLUMN managed_by_contractor_id uuid REFERENCES counterparties (id),
  ADD COLUMN contractor_assumed       boolean NOT NULL DEFAULT false,
  ADD COLUMN contractor_raw           text,
  ADD COLUMN ordinal                  integer,
  ADD COLUMN auto_run_enabled         boolean NOT NULL DEFAULT false,
  ADD COLUMN created_by               uuid REFERENCES users (id);

UPDATE folders f
   SET section_code             = w.section_code,
       period                   = w.period,
       title                    = w.title,
       managed_by_contractor_id = w.managed_by_contractor_id,
       contractor_assumed       = w.contractor_assumed,
       contractor_raw           = w.contractor_raw,
       ordinal                  = w.ordinal,
       auto_run_enabled         = w.auto_run_enabled,
       created_by               = w.created_by
  FROM works w
 WHERE w.id = f.work_id;

ALTER TABLE folders
  ALTER COLUMN section_code SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN managed_by_contractor_id SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL;

-- Статусы подачи и родословная ревизий уходят вместе с согласованием (0058).
ALTER TABLE folders
  DROP COLUMN work_id,
  DROP COLUMN revision_no,
  DROP COLUMN parent_revision_id,
  DROP COLUMN status,
  DROP COLUMN submitted_at,
  DROP COLUMN submitted_by,
  DROP COLUMN decided_at,
  DROP COLUMN decided_by,
  DROP COLUMN return_reason;

-- Раздел обязан быть включён на объекте — ключ переезжает с `works` дословно.
ALTER TABLE folders
  ADD CONSTRAINT folders_section_fk
    FOREIGN KEY (object_id, section_code) REFERENCES object_sections (object_id, section_code),
  ADD CONSTRAINT folders_period_chk CHECK (period IS NULL OR EXTRACT(DAY FROM period) = 1),
  ADD CONSTRAINT folders_ordinal_chk CHECK (ordinal IS NULL OR ordinal > 0);

DROP TABLE works;

-- Имена ключей следуют за сущностью: разбор отказа обязан называть папку, а не
-- поставку, которой больше нет.
ALTER TABLE folders RENAME CONSTRAINT submission_revisions_pkey TO folders_pkey;
ALTER TABLE folders RENAME CONSTRAINT submission_revisions_scope_uq TO folders_scope_uq;
ALTER TABLE folders RENAME CONSTRAINT submission_revisions_object_uq TO folders_object_uq;
ALTER TABLE folders RENAME CONSTRAINT submission_revisions_version_chk TO folders_version_chk;
ALTER TABLE folders
  RENAME CONSTRAINT submission_revisions_manifest_hash_chk TO folders_manifest_hash_chk;
-- Объект и исполнитель у ревизии своих внешних ключей не имели: их держал
-- составной `submission_revisions_scope_fk` на комплект, а комплекта больше
-- нет. Ключи объявляются напрямую — иначе папка могла бы ссылаться на
-- несуществующий объект или на организацию не из справочника.
ALTER TABLE folders
  ADD CONSTRAINT folders_object_id_fkey
    FOREIGN KEY (object_id) REFERENCES construction_objects (id),
  ADD CONSTRAINT folders_contractor_id_fkey
    FOREIGN KEY (contractor_id) REFERENCES counterparties (id);

ALTER INDEX ix_submission_revisions_object RENAME TO ix_folders_object;
ALTER INDEX ix_submission_revisions_contractor RENAME TO ix_folders_contractor;

CREATE INDEX ix_folders_section_period ON folders (object_id, section_code, period);
CREATE INDEX ix_folders_managed_by ON folders (managed_by_contractor_id);
CREATE INDEX ix_folders_created_by ON folders (created_by);

-- ---------------------------------------------------------------------------
-- 2. Колонка ссылки переименована во всех дочерних таблицах.
--
-- `layout_revisions` своё имя сохраняет: это ВЕРСИИ РАЗМЕТКИ, другая сущность,
-- и её собственные `layout_revision_id` в дочерних таблицах не трогаются.
-- Переименовывается только ссылка на поставку.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_runs RENAME COLUMN revision_id TO folder_id;
ALTER TABLE document_relations RENAME COLUMN revision_id TO folder_id;
ALTER TABLE error_samples RENAME COLUMN revision_id TO folder_id;
ALTER TABLE field_values RENAME COLUMN revision_id TO folder_id;
ALTER TABLE findings RENAME COLUMN revision_id TO folder_id;
ALTER TABLE job_runs RENAME COLUMN revision_id TO folder_id;
ALTER TABLE layout_blocks RENAME COLUMN revision_id TO folder_id;
ALTER TABLE layout_revisions RENAME COLUMN revision_id TO folder_id;
ALTER TABLE logical_documents RENAME COLUMN revision_id TO folder_id;
ALTER TABLE material_documents RENAME COLUMN revision_id TO folder_id;
ALTER TABLE materials RENAME COLUMN revision_id TO folder_id;
ALTER TABLE page_assignments RENAME COLUMN revision_id TO folder_id;
ALTER TABLE page_classifications RENAME COLUMN revision_id TO folder_id;
ALTER TABLE page_orientations RENAME COLUMN revision_id TO folder_id;
ALTER TABLE page_text_versions RENAME COLUMN revision_id TO folder_id;
ALTER TABLE processing_bundle_pages RENAME COLUMN revision_id TO folder_id;
ALTER TABLE processing_bundles RENAME COLUMN revision_id TO folder_id;
ALTER TABLE processing_feedback RENAME COLUMN revision_id TO folder_id;
ALTER TABLE recognition_runs RENAME COLUMN revision_id TO folder_id;
ALTER TABLE registry_row_candidates RENAME COLUMN revision_id TO folder_id;
ALTER TABLE registry_rows RENAME COLUMN revision_id TO folder_id;
ALTER TABLE revision_events RENAME COLUMN revision_id TO folder_id;
ALTER TABLE source_files RENAME COLUMN revision_id TO folder_id;
ALTER TABLE source_pages RENAME COLUMN revision_id TO folder_id;
ALTER TABLE validation_runs RENAME COLUMN revision_id TO folder_id;

-- Порядковый номер страницы считается в границах папки, а не поставки.
ALTER TABLE source_pages RENAME COLUMN revision_ordinal TO folder_ordinal;
-- Образец наблюдённого заголовка тоже указывает на папку.
ALTER TABLE doc_type_candidates RENAME COLUMN sample_revision_id TO sample_folder_id;

-- Поток доменных событий принадлежит папке.
ALTER TABLE revision_events RENAME TO folder_events;

-- ---------------------------------------------------------------------------
-- 3. Имена ключей и индексов дочерних таблиц.
--
-- Переименовывается ТОЛЬКО тот токен `revision`, что означал поставку.
-- Объекты самой разметки (`layout_revisions_pkey`, `layout_blocks_layout_revision_uq`,
-- `rd_run_documents_layout_revision_id_uq` и прочие ссылки на `layout_revision_id`)
-- не трогаются: ревизия разметки — другая сущность, и она осталась.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_runs RENAME CONSTRAINT ai_runs_revision_id_fkey TO ai_runs_folder_id_fkey;
ALTER TABLE job_runs RENAME CONSTRAINT job_runs_revision_id_fkey TO job_runs_folder_id_fkey;
ALTER TABLE layout_blocks RENAME CONSTRAINT layout_blocks_revision_id_uq TO layout_blocks_folder_id_uq;
ALTER TABLE layout_revisions RENAME CONSTRAINT layout_revisions_revision_id_fkey TO layout_revisions_folder_id_fkey;
ALTER TABLE layout_revisions RENAME CONSTRAINT layout_revisions_revision_id_uq TO layout_revisions_folder_id_uq;
ALTER TABLE logical_documents RENAME CONSTRAINT logical_documents_revision_id_fkey TO logical_documents_folder_id_fkey;
ALTER TABLE logical_documents RENAME CONSTRAINT logical_documents_revision_id_uq TO logical_documents_folder_id_uq;
ALTER TABLE materials RENAME CONSTRAINT materials_revision_id_fkey TO materials_folder_id_fkey;
ALTER TABLE materials RENAME CONSTRAINT materials_revision_id_uq TO materials_folder_id_uq;
ALTER TABLE page_text_versions RENAME CONSTRAINT page_text_versions_revision_id_uq TO page_text_versions_folder_id_uq;
ALTER TABLE processing_bundles RENAME CONSTRAINT processing_bundles_revision_id_fkey TO processing_bundles_folder_id_fkey;
ALTER TABLE processing_bundles RENAME CONSTRAINT processing_bundles_revision_id_uq TO processing_bundles_folder_id_uq;
ALTER TABLE recognition_runs RENAME CONSTRAINT recognition_runs_revision_id_fkey TO recognition_runs_folder_id_fkey;
ALTER TABLE recognition_runs RENAME CONSTRAINT recognition_runs_revision_id_uq TO recognition_runs_folder_id_uq;
ALTER TABLE registry_row_candidates RENAME CONSTRAINT registry_row_candidates_revision_id_fkey TO registry_row_candidates_folder_id_fkey;
ALTER TABLE folder_events RENAME CONSTRAINT revision_events_pkey TO folder_events_pkey;
ALTER TABLE folder_events RENAME CONSTRAINT revision_events_revision_id_fkey TO folder_events_folder_id_fkey;
ALTER TABLE folder_events RENAME CONSTRAINT revision_events_seq_chk TO folder_events_seq_chk;
ALTER TABLE source_files RENAME CONSTRAINT source_files_revision_id_fkey TO source_files_folder_id_fkey;
ALTER TABLE source_files RENAME CONSTRAINT source_files_revision_id_uq TO source_files_folder_id_uq;
ALTER TABLE source_pages RENAME CONSTRAINT source_pages_revision_id_fkey TO source_pages_folder_id_fkey;
ALTER TABLE source_pages RENAME CONSTRAINT source_pages_revision_id_uq TO source_pages_folder_id_uq;
ALTER TABLE source_pages RENAME CONSTRAINT source_pages_revision_ordinal_chk TO source_pages_folder_ordinal_chk;
ALTER TABLE source_pages RENAME CONSTRAINT source_pages_revision_ordinal_uq TO source_pages_folder_ordinal_uq;
ALTER TABLE validation_runs RENAME CONSTRAINT validation_runs_revision_id_fkey TO validation_runs_folder_id_fkey;
ALTER TABLE validation_runs RENAME CONSTRAINT validation_runs_revision_uq TO validation_runs_folder_uq;

ALTER INDEX ix_ai_runs_revision RENAME TO ix_ai_runs_folder;
ALTER INDEX ix_doc_type_candidates_sample_revision RENAME TO ix_doc_type_candidates_sample_folder;
ALTER INDEX ix_document_relations_revision RENAME TO ix_document_relations_folder;
ALTER INDEX ix_field_values_revision RENAME TO ix_field_values_folder;
ALTER INDEX ix_findings_revision_state RENAME TO ix_findings_folder_state;
ALTER INDEX ix_job_runs_revision RENAME TO ix_job_runs_folder;
-- Индекс очереди строится по КЛЮЧУ payload, а не по имени индекса: переименование
-- оставило бы выражение `payload ->> 'revisionId'`, по которому после смены
-- адресации задач не найдётся ни одной строки. Пересоздаём.
DROP INDEX ix_jobs_revision;
CREATE INDEX ix_jobs_folder
  ON jobs ((payload ->> 'folderId'))
  WHERE status IN ('queued', 'running', 'failed');
ALTER INDEX ix_layout_blocks_revision_page RENAME TO ix_layout_blocks_folder_page;
ALTER INDEX ix_logical_documents_revision RENAME TO ix_logical_documents_folder;
ALTER INDEX ix_material_documents_revision RENAME TO ix_material_documents_folder;
ALTER INDEX ix_materials_revision RENAME TO ix_materials_folder;
ALTER INDEX ix_processing_bundle_pages_revision RENAME TO ix_processing_bundle_pages_folder;
ALTER INDEX ix_processing_feedback_revision RENAME TO ix_processing_feedback_folder;
ALTER INDEX ix_recognition_runs_revision RENAME TO ix_recognition_runs_folder;
ALTER INDEX ix_registry_row_candidates_revision RENAME TO ix_registry_row_candidates_folder;
ALTER INDEX ix_registry_rows_revision RENAME TO ix_registry_rows_folder;
ALTER INDEX ix_validation_runs_revision RENAME TO ix_validation_runs_folder;
ALTER TABLE doc_type_candidates
  RENAME CONSTRAINT doc_type_candidates_sample_revision_fk
    TO doc_type_candidates_sample_folder_fk;


-- ---------------------------------------------------------------------------
-- 4. Представление неучтённых страниц пересобирается на новых именах.
-- ---------------------------------------------------------------------------

DROP VIEW v_unaccounted_pages;

CREATE VIEW v_unaccounted_pages AS
  SELECT folder_id, id AS source_page_id, source_file_id, folder_ordinal
    FROM source_pages p
   WHERE NOT EXISTS (
     SELECT 1 FROM page_assignments a
      WHERE a.folder_id = p.folder_id AND a.source_page_id = p.id);

-- ---------------------------------------------------------------------------
-- 4a. Адрес замечания «вся поставка» становится адресом «вся папка».
--
-- `findings.target_type` — значение ДАННЫХ, а не имя объекта, поэтому оно не
-- переименовывается вместе с колонками: его надо переписать в строках и в
-- ограничении.
-- ---------------------------------------------------------------------------

UPDATE findings SET target_type = 'folder' WHERE target_type = 'revision';

ALTER TABLE findings DROP CONSTRAINT findings_target_type_chk;
ALTER TABLE findings ADD CONSTRAINT findings_target_type_chk CHECK (target_type IN (
  'folder', 'source_page', 'document', 'field_value', 'registry_row',
  'material', 'batch'));

-- ---------------------------------------------------------------------------
-- 5. Комплект — акт со своими приложениями.
-- ---------------------------------------------------------------------------

CREATE TABLE complects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id       uuid NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
  -- Денормализованная область видимости: те же три колонки, что у папки, ради
  -- составного ключа изоляции дочерних таблиц (§4.1).
  object_id       uuid NOT NULL,
  contractor_id   uuid NOT NULL,
  -- Порядок акта в папке. Задаётся сегментацией по порядку страниц.
  ordinal         integer NOT NULL,
  -- Документ-якорь комплекта. Ссылка простая: `logical_documents` ссылается на
  -- `complects` встречно, и составной ключ в обе стороны замкнул бы вставку.
  act_document_id uuid REFERENCES logical_documents (id) ON DELETE SET NULL,
  -- Номер и дата акта денормализованы: список папок и заголовки секций
  -- «Проверки» показывают их на каждой строке, а тянуть их через реквизиты
  -- значило бы читать `field_values` ради подписи заголовка.
  act_number      text,
  act_date        date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT complects_ordinal_chk CHECK (ordinal > 0),
  CONSTRAINT complects_ordinal_uq UNIQUE (folder_id, ordinal),
  CONSTRAINT complects_scope_uq UNIQUE (id, object_id, contractor_id),
  -- Цель составного ключа дочерних таблиц: «комплект из этой же папки».
  CONSTRAINT complects_folder_uq UNIQUE (folder_id, id),
  CONSTRAINT complects_folder_fk
    FOREIGN KEY (folder_id, object_id, contractor_id)
    REFERENCES folders (id, object_id, contractor_id)
);

CREATE INDEX ix_complects_folder ON complects (folder_id, ordinal);
CREATE INDEX ix_complects_act_document ON complects (act_document_id);

-- ---------------------------------------------------------------------------
-- 6. Ссылка на комплект у таблиц содержания.
--
-- Ключ составной парой с `folder_id` — см. шапку миграции. `ON DELETE` не
-- задаётся намеренно: комплекты создаются и уничтожаются только вместе с
-- документами, одной транзакцией пересегментации, и порядок там свой —
-- сначала снимается ссылка, затем удаляется комплект.
-- ---------------------------------------------------------------------------

ALTER TABLE logical_documents
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT logical_documents_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_logical_documents_complect ON logical_documents (complect_id);

ALTER TABLE field_values
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT field_values_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_field_values_complect ON field_values (complect_id);

ALTER TABLE registry_rows
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT registry_rows_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_registry_rows_complect ON registry_rows (complect_id);

ALTER TABLE registry_row_candidates
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT registry_row_candidates_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_registry_row_candidates_complect ON registry_row_candidates (complect_id);

ALTER TABLE document_relations
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT document_relations_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_document_relations_complect ON document_relations (complect_id);

ALTER TABLE materials
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT materials_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_materials_complect ON materials (complect_id);

ALTER TABLE material_documents
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT material_documents_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_material_documents_complect ON material_documents (complect_id);

ALTER TABLE findings
  ADD COLUMN complect_id uuid,
  ADD CONSTRAINT findings_complect_fk
    FOREIGN KEY (folder_id, complect_id) REFERENCES complects (folder_id, id);
CREATE INDEX ix_findings_complect ON findings (complect_id);

-- `validation_runs` уникальна по папке (`validation_runs_folder_uq`): прогон
-- правил один на папку и разрезается по комплектам внутри своего журнала, а не
-- множится на строки. Поэтому `complect_id` ей не нужен.
