-- Разметка, прогоны и неизменяемые артефакты (§3.4, §3.5).

CREATE TABLE layout_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES submission_revisions (id),
  -- Денормализованная область видимости: экран разметки фильтрует по объекту, а
  -- составной FK ниже не даёт этому столбцу разойтись с ревизией.
  object_id   uuid NOT NULL,
  bundle_id   uuid NOT NULL REFERENCES processing_bundles (id),
  revision_no integer NOT NULL,
  state       text NOT NULL DEFAULT 'draft',
  blocks_hash text,
  version     integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  frozen_at   timestamptz,
  frozen_by   uuid REFERENCES users (id),
  CONSTRAINT layout_revisions_revision_no_chk CHECK (revision_no > 0),
  CONSTRAINT layout_revisions_version_chk CHECK (version >= 0),
  CONSTRAINT layout_revisions_state_chk
    CHECK (state IN ('draft', 'frozen', 'superseded')),
  CONSTRAINT layout_revisions_blocks_hash_chk CHECK (blocks_hash ~ '^[0-9a-f]{64}$'),
  -- Заморозка без хэша блоков бессмысленна: именно он сверяется с удалённым
  -- набором перед запуском OCR (§5.2).
  CONSTRAINT layout_revisions_frozen_chk CHECK (
    state = 'draft' OR (blocks_hash IS NOT NULL AND frozen_at IS NOT NULL)),
  CONSTRAINT layout_revisions_no_uq UNIQUE (revision_id, revision_no),
  CONSTRAINT layout_revisions_revision_id_uq UNIQUE (revision_id, id),
  -- Цель составного FK блоков разметки. Один ключ вместо трёх: он закрывает сразу
  -- все денормализованные столбцы блока (ревизия поставки, объект, рабочий
  -- документ). Прежний UNIQUE (id, object_id) был его подмножеством и удалён.
  CONSTRAINT layout_revisions_scope_uq UNIQUE (id, revision_id, object_id, bundle_id),
  CONSTRAINT layout_revisions_scope_fk
    FOREIGN KEY (revision_id, object_id) REFERENCES submission_revisions (id, object_id),
  -- Рабочий документ обязан принадлежать той же ревизии поставки.
  CONSTRAINT layout_revisions_bundle_fk
    FOREIGN KEY (revision_id, bundle_id) REFERENCES processing_bundles (revision_id, id)
);

-- Незамороженная разметка одна: вторая параллельная draft означала бы два
-- расходящихся набора блоков на одну ревизию.
CREATE UNIQUE INDEX ux_layout_revisions_single_draft
  ON layout_revisions (revision_id)
  WHERE state = 'draft';

CREATE INDEX ix_layout_revisions_bundle ON layout_revisions (bundle_id);
CREATE INDEX ix_layout_revisions_object ON layout_revisions (object_id);
CREATE INDEX ix_layout_revisions_frozen_by ON layout_revisions (frozen_by);

-- Цель составного FK блоков разметки. Уникальность тройки уже следует из
-- первичного ключа (bundle_id, working_page_index), но FK требует ключа,
-- совпадающего по составу со ссылающимися столбцами. Объявлено здесь, рядом
-- с единственным потребителем, а не в 0003.
ALTER TABLE processing_bundle_pages
  ADD CONSTRAINT processing_bundle_pages_page_index_uq
  UNIQUE (bundle_id, working_page_index, source_page_id);

CREATE TABLE layout_blocks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layout_revision_id  uuid NOT NULL REFERENCES layout_revisions (id) ON DELETE CASCADE,
  -- Денормализованная ревизия поставки. Без неё блок мог сослаться на страницу
  -- чужой ревизии и даже чужого объекта: простой FK на source_pages (id) о
  -- ревизии ничего не знает, а layout_blocks_scope_fk проверял object_id только
  -- против layout_revisions, но не против страницы. Такой блок уезжал в RD WEB и
  -- получал OCR-текст чужой поставки, а scope-фильтр по object_id его не отсекал.
  revision_id         uuid NOT NULL,
  -- Денормализованный рабочий документ: только он делает проверяемым
  -- соответствие working_page_index <-> source_page_id.
  bundle_id           uuid NOT NULL,
  source_page_id      uuid NOT NULL REFERENCES source_pages (id),
  -- Индекс страницы в рабочем PDF; авторитетное соответствие
  -- working_page_index <-> source_page_id лежит в processing_bundle_pages.
  working_page_index  integer NOT NULL,
  object_id           uuid NOT NULL,
  block_type          text NOT NULL,
  shape_type          text NOT NULL,
  -- Четыре отдельные колонки, а не real[4]: массив не гарантирует ни длину, ни
  -- диапазон, и CHECK на порядок границ по нему не выражается. Координаты
  -- нормализованы (доля от размера страницы, origin слева-сверху,
  -- пост-поворотный фрейм) — это система координат Konva.
  x0                  double precision NOT NULL,
  y0                  double precision NOT NULL,
  x1                  double precision NOT NULL,
  y1                  double precision NOT NULL,
  sort_order          integer NOT NULL,
  source              text NOT NULL,
  -- Уверенность и модель детектора не хранятся: BlockOut легаси-API их не
  -- отдаёт, и колонки были бы вечно NULL. Вместо выдуманного числа — провенанс.
  detector_provenance text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT layout_blocks_working_page_index_chk CHECK (working_page_index >= 0),
  CONSTRAINT layout_blocks_sort_order_chk CHECK (sort_order >= 0),
  CONSTRAINT layout_blocks_block_type_chk CHECK (block_type IN ('text', 'image', 'stamp')),
  CONSTRAINT layout_blocks_shape_type_chk CHECK (shape_type IN ('rectangle', 'polygon')),
  CONSTRAINT layout_blocks_source_chk CHECK (source IN ('auto', 'user')),
  CONSTRAINT layout_blocks_provenance_chk
    CHECK (detector_provenance IN ('rf_detr', 'full_page', 'user', 'unavailable')),
  CONSTRAINT layout_blocks_coords_chk CHECK (
    x0 >= 0 AND y0 >= 0 AND x1 <= 1 AND y1 <= 1 AND x0 <= x1 AND y0 <= y1),
  -- Ключи для составных FK результатов распознавания (по ревизии разметки) и
  -- реквизитов (по ревизии поставки).
  CONSTRAINT layout_blocks_revision_id_uq UNIQUE (revision_id, id),
  CONSTRAINT layout_blocks_layout_revision_uq UNIQUE (layout_revision_id, id),
  -- Один FK закрывает три денормализованных столбца сразу: блок не может
  -- объявить ни чужую ревизию поставки, ни чужой объект, ни чужой рабочий
  -- документ.
  CONSTRAINT layout_blocks_scope_fk
    FOREIGN KEY (layout_revision_id, revision_id, object_id, bundle_id)
    REFERENCES layout_revisions (id, revision_id, object_id, bundle_id) ON DELETE CASCADE,
  -- Страница обязана принадлежать той же ревизии. Формально это следует и из
  -- layout_blocks_page_fk (страница -> bundle -> ревизия), но денормализованные
  -- bundle_id и working_page_index могут когда-нибудь уйти, а изоляция ревизий
  -- уйти не может — поэтому она выражена прямо.
  CONSTRAINT layout_blocks_source_page_fk
    FOREIGN KEY (revision_id, source_page_id) REFERENCES source_pages (revision_id, id),
  -- Тройка целиком, а не два отдельных FK на ту же таблицу: два FK по разным
  -- парам столбцов допускают попадание в РАЗНЫЕ строки карты, то есть блок,
  -- нарисованный на странице рабочего PDF, которой соответствует другая исходная
  -- страница той же ревизии. Результат тот же — чужой OCR-текст в блоке.
  CONSTRAINT layout_blocks_page_fk
    FOREIGN KEY (bundle_id, working_page_index, source_page_id)
    REFERENCES processing_bundle_pages (bundle_id, working_page_index, source_page_id)
);

CREATE INDEX ix_layout_blocks_revision_page
  ON layout_blocks (layout_revision_id, source_page_id, sort_order);
CREATE INDEX ix_layout_blocks_source_page ON layout_blocks (source_page_id);
CREATE INDEX ix_layout_blocks_object ON layout_blocks (object_id);

-- Точки полигона хранятся здесь, а не в jsonb: функции jsonb_matches_schema() в
-- PostgreSQL не существует (это функция расширения pg_jsonschema, а стандарт
-- разрешает только pgcrypto, citext и pg_trgm). Нормализованная таблица даёт
-- настоящие CHECK на диапазон и однозначный порядок точек.
CREATE TABLE layout_block_points (
  block_id uuid NOT NULL REFERENCES layout_blocks (id) ON DELETE CASCADE,
  point_no integer NOT NULL,
  x        double precision NOT NULL,
  y        double precision NOT NULL,
  PRIMARY KEY (block_id, point_no),
  CONSTRAINT layout_block_points_point_no_chk CHECK (point_no >= 0),
  CONSTRAINT layout_block_points_x_chk CHECK (x >= 0 AND x <= 1),
  CONSTRAINT layout_block_points_y_chk CHECK (y >= 0 AND y <= 1)
);

-- Отдельный RD-документ на каждую frozen layout revision; после запуска OCR он
-- не переиспользуется, а закрывается (closed_at).
CREATE TABLE rd_run_documents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layout_revision_id uuid NOT NULL UNIQUE REFERENCES layout_revisions (id),
  -- Идентификаторы удалённой системы: текст, потому что их формат — не наш
  -- контракт.
  rd_document_id     text NOT NULL,
  rd_project_id      text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT rd_run_documents_layout_revision_id_uq UNIQUE (layout_revision_id, id)
);

CREATE TABLE recognition_runs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id               uuid NOT NULL REFERENCES submission_revisions (id),
  layout_revision_id        uuid NOT NULL REFERENCES layout_revisions (id),
  rd_run_document_id        uuid NOT NULL REFERENCES rd_run_documents (id),
  rd_job_id                 text,
  -- Три хэша разметки доказывают разное: local — что заказывали, remote_before —
  -- что стояло на стороне RD WEB перед стартом OCR, remote_after — что стояло
  -- после. Расхождение любой пары даёт integrity_error, и результат не
  -- используется.
  local_layout_hash         text NOT NULL,
  remote_layout_hash_before  text,
  remote_layout_hash_after   text,
  -- Пин отправленного рабочего PDF. FK на stored_blobs нет: сборка мусора может
  -- удалить сам блоб по retention, а доказательство «что именно отправляли»
  -- обязано остаться.
  working_pdf_sha256        text NOT NULL,
  settings_snapshot         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                    text NOT NULL DEFAULT 'running',
  started_at                timestamptz NOT NULL DEFAULT now(),
  finished_at               timestamptz,
  counts                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT recognition_runs_status_chk
    CHECK (status IN ('running', 'done', 'integrity_error', 'failed')),
  CONSTRAINT recognition_runs_local_hash_chk CHECK (local_layout_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recognition_runs_remote_before_chk
    CHECK (remote_layout_hash_before ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recognition_runs_remote_after_chk
    CHECK (remote_layout_hash_after ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recognition_runs_working_pdf_chk CHECK (working_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT recognition_runs_finished_chk
    CHECK (status = 'running' OR finished_at IS NOT NULL),
  -- Ключи для составных FK потомков: распознанный текст страницы не может
  -- сослаться на прогон чужой ревизии поставки, а результат блока — на прогон
  -- чужой ревизии разметки.
  CONSTRAINT recognition_runs_revision_id_uq UNIQUE (revision_id, id),
  CONSTRAINT recognition_runs_layout_revision_uq UNIQUE (layout_revision_id, id),
  CONSTRAINT recognition_runs_layout_fk
    FOREIGN KEY (revision_id, layout_revision_id)
    REFERENCES layout_revisions (revision_id, id),
  -- RD-документ прогона обязан принадлежать той же ревизии разметки.
  CONSTRAINT recognition_runs_rd_document_fk
    FOREIGN KEY (layout_revision_id, rd_run_document_id)
    REFERENCES rd_run_documents (layout_revision_id, id)
);

CREATE INDEX ix_recognition_runs_revision ON recognition_runs (revision_id);
CREATE INDEX ix_recognition_runs_layout ON recognition_runs (layout_revision_id);
CREATE INDEX ix_recognition_runs_rd_document ON recognition_runs (rd_run_document_id);
CREATE INDEX ix_recognition_runs_status ON recognition_runs (status)
  WHERE status = 'running';

CREATE TABLE artifact_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recognition_run_id uuid NOT NULL REFERENCES recognition_runs (id),
  kind               text NOT NULL,
  s3_key             text NOT NULL,
  artifact_sha256    text NOT NULL,
  byte_size          bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_versions_kind_chk
    CHECK (kind IN ('zip', 'md', 'html', 'blocks_json', 'qa')),
  CONSTRAINT artifact_versions_sha256_chk CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT artifact_versions_byte_size_chk CHECK (byte_size >= 0),
  -- Экспорт забирается однократно (§5.2), поэтому второй артефакт того же вида
  -- в прогоне — признак повторного забора, а не новая версия.
  CONSTRAINT artifact_versions_run_kind_uq UNIQUE (recognition_run_id, kind),
  CONSTRAINT artifact_versions_run_id_uq UNIQUE (recognition_run_id, id)
);

CREATE TABLE page_text_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Денормализованная ревизия: страница и прогон обязаны быть из одной ревизии.
  -- Двумя простыми FK это не выражается, а текст чужой страницы под видом своей
  -- обесценивает все цитаты, которые на него ссылаются.
  revision_id        uuid NOT NULL,
  source_page_id     uuid NOT NULL REFERENCES source_pages (id),
  recognition_run_id uuid NOT NULL REFERENCES recognition_runs (id),
  artifact_version_id uuid NOT NULL REFERENCES artifact_versions (id),
  text_md            text NOT NULL,
  text_sha256        text NOT NULL,
  -- Конвенция смещений вынесена в явное поле, хотя значение сейчас одно: на эти
  -- смещения ссылаются char_span реквизитов и доказательств, и молчаливая смена
  -- конвенции сдвинула бы все цитаты.
  offset_convention  text NOT NULL DEFAULT 'utf16-code-unit',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page_text_versions_sha256_chk CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT page_text_versions_offset_convention_chk
    CHECK (offset_convention = 'utf16-code-unit'),
  CONSTRAINT page_text_versions_page_run_uq UNIQUE (source_page_id, recognition_run_id),
  -- Ключ для составных FK реквизитов и доказательств замечаний.
  CONSTRAINT page_text_versions_revision_id_uq UNIQUE (revision_id, id),
  -- Текст обязан происходить из артефакта того же прогона.
  CONSTRAINT page_text_versions_artifact_fk
    FOREIGN KEY (recognition_run_id, artifact_version_id)
    REFERENCES artifact_versions (recognition_run_id, id),
  CONSTRAINT page_text_versions_page_fk
    FOREIGN KEY (revision_id, source_page_id) REFERENCES source_pages (revision_id, id),
  CONSTRAINT page_text_versions_run_fk
    FOREIGN KEY (revision_id, recognition_run_id)
    REFERENCES recognition_runs (revision_id, id)
);

CREATE INDEX ix_page_text_versions_run ON page_text_versions (recognition_run_id);
CREATE INDEX ix_page_text_versions_artifact ON page_text_versions (artifact_version_id);

-- Результаты неизменяемы и append-only, поэтому мутируемого is_active здесь нет:
-- «текущий» вынесен в отдельную таблицу-указатель.
CREATE TABLE block_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Денормализованная ревизия разметки. Двумя простыми FK результат прогона
  -- ревизии разметки L2 привязывался к блоку ревизии L1: OCR-текст оказывался
  -- у блока с другой геометрией, а сверка layout hash (§5.2) этого не видит —
  -- она сравнивает наборы блоков, а не принадлежность результатов.
  layout_revision_id uuid NOT NULL,
  -- RESTRICT, а не CASCADE: результат распознавания неизменяем, и на его текст
  -- ссылаются доказательства замечаний. Каскад означал бы, что удаление блока
  -- разметки молча уносит неизменяемые результаты — то есть неизменяемость
  -- обходится удалением родителя.
  layout_block_id    uuid NOT NULL REFERENCES layout_blocks (id) ON DELETE RESTRICT,
  recognition_run_id uuid NOT NULL REFERENCES recognition_runs (id),
  result_type        text NOT NULL,
  content_html       text,
  content_md         text,
  content_json       jsonb,
  model_id           text,
  -- Уверенность OCR, а не детектора: единственное поле confidence в легаси-API
  -- принадлежит BlockResultOut.
  confidence         double precision,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT block_results_confidence_chk
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT block_results_block_id_uq UNIQUE (layout_block_id, id),
  CONSTRAINT block_results_block_fk
    FOREIGN KEY (layout_revision_id, layout_block_id)
    REFERENCES layout_blocks (layout_revision_id, id) ON DELETE RESTRICT,
  CONSTRAINT block_results_run_fk
    FOREIGN KEY (layout_revision_id, recognition_run_id)
    REFERENCES recognition_runs (layout_revision_id, id)
);

CREATE INDEX ix_block_results_run ON block_results (recognition_run_id);
CREATE INDEX ix_block_results_block ON block_results (layout_block_id);

CREATE TABLE current_block_result (
  layout_block_id  uuid PRIMARY KEY REFERENCES layout_blocks (id) ON DELETE CASCADE,
  block_result_id  uuid NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Указатель не может смотреть на результат другого блока.
  CONSTRAINT current_block_result_result_fk
    FOREIGN KEY (layout_block_id, block_result_id)
    REFERENCES block_results (layout_block_id, id)
);

CREATE INDEX ix_current_block_result_result ON current_block_result (block_result_id);

-- Прогоны анализа LLM. Секретов и полного чувствительного payload здесь нет —
-- только хэши входа-выхода и структурированный результат.
CREATE TABLE ai_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id       uuid NOT NULL REFERENCES submission_revisions (id),
  stage             text NOT NULL,
  provider          text NOT NULL,
  model             text NOT NULL,
  prompt_code       text,
  prompt_version    integer,
  input_hash        text,
  output_hash       text,
  tokens_in         integer,
  tokens_out        integer,
  cost              numeric(12, 4),
  latency_ms        integer,
  structured_result jsonb,
  request_id        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Стадии — по §10; rdweb остаётся в списке провайдеров, но в MVP заблокирован
  -- до подтверждения capability, а recorded — офлайн-двойник для гейтов.
  CONSTRAINT ai_runs_stage_chk
    CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary')),
  CONSTRAINT ai_runs_provider_chk CHECK (provider IN ('proxy_llm', 'rdweb', 'recorded')),
  CONSTRAINT ai_runs_input_hash_chk CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_runs_output_hash_chk CHECK (output_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_runs_tokens_chk CHECK (
    (tokens_in IS NULL OR tokens_in >= 0) AND (tokens_out IS NULL OR tokens_out >= 0))
);

CREATE INDEX ix_ai_runs_revision ON ai_runs (revision_id, created_at DESC);
CREATE INDEX ix_ai_runs_stage ON ai_runs (stage, created_at DESC);
CREATE INDEX ix_ai_runs_request ON ai_runs (request_id);
