-- Том, поставка, ревизия, файлы и рабочий документ (§3, §3.3).
--
-- Денормализация и её целостность. Столбцы object_id и contractor_id
-- дублируются в дочерних таблицах не для удобства, а как третий уровень
-- изоляции доступа (§4.1): scope-фильтр не должен зависеть от join'а, который
-- легко забыть. Чтобы дубль не разошёлся с истиной, каждый такой столбец
-- закрыт составным внешним ключом на строку-владельца — например
-- source_pages(revision_id, source_file_id) -> source_files(revision_id, id).
-- Поэтому у submission_revisions есть object_id и contractor_id, которых §3 не
-- перечисляет: без них ни logical_documents, ни findings нельзя привязать
-- составным FK к ревизии, и документ мог бы объявить чужой объект.

CREATE TABLE volumes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id        uuid NOT NULL REFERENCES construction_objects (id),
  section_id       uuid NOT NULL REFERENCES object_sections (id),
  code             text NOT NULL,
  name             text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  -- Единственная настройка, при которой конвейер проходит остановки §6 без
  -- человека. По умолчанию выключена: неверная рамка после OCR стоит полного
  -- повторного прогона на GPU.
  auto_run_enabled boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT volumes_object_code_uq UNIQUE (object_id, code),
  CONSTRAINT volumes_object_id_uq UNIQUE (object_id, id),
  CONSTRAINT volumes_section_fk
    FOREIGN KEY (object_id, section_id) REFERENCES object_sections (object_id, id)
);

CREATE INDEX ix_volumes_section ON volumes (section_id);
CREATE INDEX ix_volumes_object ON volumes (object_id);

CREATE TABLE submissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  volume_id           uuid NOT NULL REFERENCES volumes (id),
  object_id           uuid NOT NULL REFERENCES construction_objects (id),
  contractor_id       uuid NOT NULL REFERENCES counterparties (id),
  number              text,
  title               text NOT NULL,
  -- FK добавлен ниже: submission_revisions ссылается на submissions, связь
  -- взаимная.
  current_revision_id uuid,
  created_by          uuid NOT NULL REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submissions_volume_fk
    FOREIGN KEY (object_id, volume_id) REFERENCES volumes (object_id, id),
  -- Ключ для составного FK ревизии: object_id и contractor_id ревизии обязаны
  -- совпадать с поставкой.
  CONSTRAINT submissions_scope_uq UNIQUE (id, object_id, contractor_id)
);

CREATE INDEX ix_submissions_volume ON submissions (volume_id);
CREATE INDEX ix_submissions_object ON submissions (object_id);
CREATE INDEX ix_submissions_contractor ON submissions (contractor_id);
CREATE INDEX ix_submissions_created_by ON submissions (created_by);

CREATE TABLE submission_revisions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id           uuid NOT NULL REFERENCES submissions (id),
  object_id               uuid NOT NULL,
  contractor_id           uuid NOT NULL,
  revision_no             integer NOT NULL,
  -- Возврат не переоткрывает ревизию, а закрывает её и создаёт новую draft:
  -- иначе история согласования переписывалась бы.
  parent_revision_id      uuid REFERENCES submission_revisions (id),
  status                  text NOT NULL DEFAULT 'draft',
  -- Хэш состава ревизии (файлы и их порядок). Только его совпадение разрешает
  -- переиспользовать результаты предыдущей ревизии при повторной подаче.
  aggregate_manifest_hash text,
  -- Оптимистичная блокировка для If-Match.
  version                 integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  submitted_at            timestamptz,
  submitted_by            uuid REFERENCES users (id),
  decided_at              timestamptz,
  decided_by              uuid REFERENCES users (id),
  return_reason           text,
  -- processing_status здесь нет намеренно: по §3.8 это вычисляемая сводка над
  -- job_runs. Хранимое поле скрыло бы попытки и параллельные стадии и врало бы
  -- навсегда при падении воркера.
  CONSTRAINT submission_revisions_revision_no_chk CHECK (revision_no > 0),
  CONSTRAINT submission_revisions_version_chk CHECK (version >= 0),
  CONSTRAINT submission_revisions_status_chk CHECK (status IN (
    'draft', 'submitted', 'in_review', 'returned', 'approved', 'superseded')),
  CONSTRAINT submission_revisions_manifest_hash_chk
    CHECK (aggregate_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT submission_revisions_parent_chk
    CHECK (revision_no = 1 OR parent_revision_id IS NOT NULL),
  CONSTRAINT submission_revisions_no_uq UNIQUE (submission_id, revision_no),
  -- Ключ для указателя current_revision_id: он не может смотреть на ревизию
  -- другой поставки.
  CONSTRAINT submission_revisions_submission_id_uq UNIQUE (submission_id, id),
  -- Ключи для составных FK дочерних таблиц.
  CONSTRAINT submission_revisions_scope_uq UNIQUE (id, object_id, contractor_id),
  CONSTRAINT submission_revisions_object_uq UNIQUE (id, object_id),
  CONSTRAINT submission_revisions_scope_fk
    FOREIGN KEY (submission_id, object_id, contractor_id)
    REFERENCES submissions (id, object_id, contractor_id)
);

-- Одновременно у поставки может быть только одна незакрытая ревизия: возврат
-- закрывает предыдущую и лишь затем создаётся новая draft.
CREATE UNIQUE INDEX ux_submission_revisions_single_draft
  ON submission_revisions (submission_id)
  WHERE status = 'draft';

CREATE INDEX ix_submission_revisions_parent ON submission_revisions (parent_revision_id);
CREATE INDEX ix_submission_revisions_object ON submission_revisions (object_id);
CREATE INDEX ix_submission_revisions_contractor ON submission_revisions (contractor_id);
CREATE INDEX ix_submission_revisions_status ON submission_revisions (status);
CREATE INDEX ix_submission_revisions_submitted_by ON submission_revisions (submitted_by);
CREATE INDEX ix_submission_revisions_decided_by ON submission_revisions (decided_by);

ALTER TABLE submissions
  ADD CONSTRAINT submissions_current_revision_fk
  FOREIGN KEY (id, current_revision_id)
  REFERENCES submission_revisions (submission_id, id);

CREATE INDEX ix_submissions_current_revision ON submissions (current_revision_id);

-- Дедупликация содержимого по SHA-256: повторная подача после возврата —
-- типовой сценарий, и второй раз те же байты не хранятся.
CREATE TABLE stored_blobs (
  sha256     text PRIMARY KEY,
  -- Ключ строится только из uuid и sha256: ни имя файла, ни код объекта в путь
  -- не попадают (§13).
  s3_key     text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL,
  mime       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stored_blobs_sha256_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT stored_blobs_size_chk CHECK (size_bytes >= 0)
);

CREATE TABLE source_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id     uuid NOT NULL REFERENCES submission_revisions (id),
  blob_sha256     text NOT NULL REFERENCES stored_blobs (sha256),
  file_name       text NOT NULL,
  sort_order      integer NOT NULL,
  -- До проверки файл недоступен пользователям (§4.2). Зашифрованный или
  -- непарсящийся PDF уходит в quarantined.
  verify_state    text NOT NULL DEFAULT 'pending',
  verify_error    text,
  -- Структурный зонд встроенной подписи: тройное состояние
  -- none_detected / detected_unverified / unknown плюс обосновывающие признаки.
  signature_probe jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_files_sort_order_chk CHECK (sort_order >= 0),
  CONSTRAINT source_files_verify_state_chk
    CHECK (verify_state IN ('pending', 'ok', 'quarantined')),
  -- Порядок файлов задаёт пользователь до начала разметки, и он однозначен.
  CONSTRAINT source_files_order_uq UNIQUE (revision_id, sort_order),
  CONSTRAINT source_files_revision_id_uq UNIQUE (revision_id, id)
  -- UNIQUE (revision_id, blob_sha256) нет намеренно: повторный SHA-256 файла в
  -- одной ревизии не запрещается ограничением, дубликат выявляется правилом.
);

CREATE INDEX ix_source_files_blob ON source_files (blob_sha256);
CREATE INDEX ix_source_files_verify_state ON source_files (verify_state)
  WHERE verify_state <> 'ok';

CREATE TABLE source_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id      uuid NOT NULL REFERENCES submission_revisions (id),
  source_file_id   uuid NOT NULL REFERENCES source_files (id),
  file_page_index  integer NOT NULL,
  -- Позиция страницы в ревизии: порядок задаёт пользователь до разметки.
  revision_ordinal integer NOT NULL,
  -- Размеры уже с учётом поворота: координаты разметки заданы в пост-поворотном
  -- фрейме (§7.1).
  width_px         integer NOT NULL,
  height_px        integer NOT NULL,
  rotation         integer NOT NULL DEFAULT 0,
  attention_flags  text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_pages_file_page_index_chk CHECK (file_page_index >= 0),
  CONSTRAINT source_pages_revision_ordinal_chk CHECK (revision_ordinal >= 0),
  CONSTRAINT source_pages_width_chk CHECK (width_px > 0),
  CONSTRAINT source_pages_height_chk CHECK (height_px > 0),
  CONSTRAINT source_pages_rotation_chk CHECK (rotation IN (0, 90, 180, 270)),
  -- Флаги внимания — закрытое перечисление (§7.3), поэтому проверяется каждый
  -- элемент массива, а не только его тип.
  CONSTRAINT source_pages_attention_flags_chk CHECK (attention_flags <@ ARRAY[
    'no_blocks', 'low_coverage', 'suspicious_overlap', 'bbox_out_of_page',
    'degenerate_geometry', 'tiny_block', 'neighbor_mismatch', 'blank_page_candidate',
    'missing_expected_stamp', 'layout_hash_mismatch']::text[]),
  CONSTRAINT source_pages_file_index_uq UNIQUE (source_file_id, file_page_index),
  CONSTRAINT source_pages_revision_ordinal_uq UNIQUE (revision_id, revision_ordinal),
  CONSTRAINT source_pages_revision_id_uq UNIQUE (revision_id, id),
  -- Страница и её файл обязаны принадлежать одной ревизии.
  CONSTRAINT source_pages_file_fk
    FOREIGN KEY (revision_id, source_file_id) REFERENCES source_files (revision_id, id)
);

CREATE INDEX ix_source_pages_file ON source_pages (source_file_id);

-- Рабочий PDF — производный неизменяемый документ, собранный из всех файлов
-- ревизии в заданном пользователем порядке. Именно он уезжает в RD WEB: их API
-- принимает один PDF на документ, а их детектор работает по своему рендеру.
CREATE TABLE processing_bundles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id             uuid NOT NULL REFERENCES submission_revisions (id),
  aggregate_manifest_hash text NOT NULL,
  working_pdf_blob_sha256 text NOT NULL REFERENCES stored_blobs (sha256),
  builder_version         text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processing_bundles_manifest_hash_chk
    CHECK (aggregate_manifest_hash ~ '^[0-9a-f]{64}$'),
  -- Bundle — чистая функция от состава ревизии и версии сборщика, поэтому
  -- второй такой же был бы и лишней копией 86 МБ, и неоднозначностью «какой из
  -- двух отправляли».
  CONSTRAINT processing_bundles_manifest_uq
    UNIQUE (revision_id, aggregate_manifest_hash, builder_version),
  CONSTRAINT processing_bundles_revision_id_uq UNIQUE (revision_id, id)
);

CREATE INDEX ix_processing_bundles_blob ON processing_bundles (working_pdf_blob_sha256);

-- Карта страниц рабочего PDF: любая страница однозначно отображается обратно на
-- исходный файл и его страницу.
CREATE TABLE processing_bundle_pages (
  bundle_id          uuid NOT NULL REFERENCES processing_bundles (id) ON DELETE CASCADE,
  -- Денормализованная ревизия: без неё нельзя составным FK запретить взять в
  -- bundle страницу чужой ревизии.
  revision_id        uuid NOT NULL,
  working_page_index integer NOT NULL,
  source_page_id     uuid NOT NULL REFERENCES source_pages (id),
  CONSTRAINT processing_bundle_pages_index_chk CHECK (working_page_index >= 0),
  PRIMARY KEY (bundle_id, working_page_index),
  CONSTRAINT processing_bundle_pages_page_uq UNIQUE (bundle_id, source_page_id),
  CONSTRAINT processing_bundle_pages_bundle_fk
    FOREIGN KEY (bundle_id, revision_id) REFERENCES processing_bundles (id, revision_id),
  CONSTRAINT processing_bundle_pages_page_fk
    FOREIGN KEY (revision_id, source_page_id) REFERENCES source_pages (revision_id, id)
);

CREATE INDEX ix_processing_bundle_pages_page ON processing_bundle_pages (source_page_id);
CREATE INDEX ix_processing_bundle_pages_revision ON processing_bundle_pages (revision_id);

-- Пример-ссылки кандидата в виды ИД (0002): кандидат живёт дольше поставки,
-- поэтому удаление ревизии по retention обнуляет ссылку, а не удаляет кандидата.
ALTER TABLE doc_type_candidates
  ADD CONSTRAINT doc_type_candidates_sample_revision_fk
  FOREIGN KEY (sample_revision_id) REFERENCES submission_revisions (id) ON DELETE SET NULL;

ALTER TABLE doc_type_candidates
  ADD CONSTRAINT doc_type_candidates_sample_page_fk
  FOREIGN KEY (sample_source_page_id) REFERENCES source_pages (id) ON DELETE SET NULL;

CREATE INDEX ix_doc_type_candidates_sample_revision
  ON doc_type_candidates (sample_revision_id);
CREATE INDEX ix_doc_type_candidates_sample_page
  ON doc_type_candidates (sample_source_page_id);
