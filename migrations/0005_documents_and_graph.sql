-- Логические документы и граф проверки (§3.6).

CREATE TABLE logical_documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id            uuid NOT NULL REFERENCES submission_revisions (id),
  object_id              uuid NOT NULL,
  contractor_id          uuid NOT NULL,
  -- §3.6 называет поле doc_type_id, но хранится код: именно на код ссылаются
  -- rule_definitions.doc_type_code, section_profiles.expected_doc_types и
  -- doc_type_overrides, и он же приходит в контрактах (logicalDocumentSchema).
  -- NULL — штатное состояние открытого мира: документ опознан как документ, но
  -- не отнесён ни к одному известному типу. Это не то же, что needs_review
  -- («похоже на известный тип, но не уверен»).
  doc_type_code          text REFERENCES doc_types (code),
  ordinal                integer NOT NULL,
  -- Nullable, а не NOT NULL DEFAULT '': заголовок берётся из извлечения
  -- реквизитов и на момент создания документа ещё неизвестен. Пустая строка
  -- по умолчанию делала бы «заголовок не определён» и «заголовок пуст»
  -- неразличимыми и обесценивала бы NOT NULL — вставка, забывшая заголовок,
  -- молча проходила бы. Заодно drizzle-kit 0.31.10 неверно экранирует
  -- DEFAULT '' и выдаёт незакрытый литерал в сгенерированной схеме.
  title                  text,
  folder_group           text,
  type_confidence        double precision,
  boundary_confidence    double precision,
  needs_review           boolean NOT NULL DEFAULT false,
  is_confirmed           boolean NOT NULL DEFAULT false,
  confirmed_by           uuid REFERENCES users (id),
  confirmed_at           timestamptz,
  derived_pdf_blob_sha256 text,
  -- Нарезка всегда производна: встроенная подпись оригинала к ней не относится.
  is_derived_copy        boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT logical_documents_ordinal_chk CHECK (ordinal >= 0),
  CONSTRAINT logical_documents_type_confidence_chk
    CHECK (type_confidence IS NULL OR (type_confidence >= 0 AND type_confidence <= 1)),
  CONSTRAINT logical_documents_boundary_confidence_chk
    CHECK (boundary_confidence IS NULL OR (boundary_confidence >= 0 AND boundary_confidence <= 1)),
  CONSTRAINT logical_documents_confirmed_chk
    CHECK (NOT is_confirmed OR confirmed_by IS NOT NULL),
  CONSTRAINT logical_documents_derived_pdf_chk
    CHECK (derived_pdf_blob_sha256 ~ '^[0-9a-f]{64}$'),
  -- Ключ для составных FK: страница и строка реестра не могут сослаться на
  -- документ чужой ревизии.
  CONSTRAINT logical_documents_revision_id_uq UNIQUE (revision_id, id),
  CONSTRAINT logical_documents_scope_fk
    FOREIGN KEY (revision_id, object_id, contractor_id)
    REFERENCES submission_revisions (id, object_id, contractor_id)
  -- UNIQUE (revision_id, ordinal) нет намеренно: пересегментация переписывает
  -- порядок целиком одним UPDATE, а уникальность проверяется построчно и упала
  -- бы на промежуточном состоянии.
);

CREATE INDEX ix_logical_documents_revision ON logical_documents (revision_id, ordinal);
CREATE INDEX ix_logical_documents_doc_type ON logical_documents (doc_type_code);
CREATE INDEX ix_logical_documents_object ON logical_documents (object_id);
CREATE INDEX ix_logical_documents_contractor ON logical_documents (contractor_id);
CREATE INDEX ix_logical_documents_confirmed_by ON logical_documents (confirmed_by);
CREATE INDEX ix_logical_documents_needs_review ON logical_documents (revision_id)
  WHERE needs_review;

-- Учёт страниц ревизии: одна таблица вместо пары document_pages/unassigned_pages.
--
-- Первая половина инварианта §16 — «страница ровно в одном состоянии» — здесь
-- следствие ключа, а не проверки. Двумя таблицами взаимоисключаемость пришлось
-- бы держать триггерами «нет ли этой страницы в соседней таблице», а такой
-- триггер на READ COMMITTED (уровень по умолчанию) ненадёжен принципиально: две
-- параллельные транзакции, вставляющие одну страницу в разные таблицы, не видят
-- незакоммиченных строк друг друга, обе проходят проверку и обе фиксируются.
-- Уникальный индекс, наоборот, заставляет вторую вставку ждать первую
-- транзакцию и затем отвергает её — это и есть единственный способ получить
-- инвариант без SERIALIZABLE и явных блокировок.
--
-- Непривязанная страница остаётся явной строкой (document_id IS NULL), а не
-- отсутствием записи: иначе вторая половина инварианта — «потерь нет» —
-- непроверяема, отсутствие строки не отличить от потерянной страницы.
CREATE TABLE page_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id    uuid NOT NULL,
  source_page_id uuid NOT NULL,
  -- NULL — страница учтена как непривязанная. Именно nullable-документ и делает
  -- два прежних состояния одной строкой, у которой ключ ниже единственный.
  document_id    uuid,
  sort_order     integer,
  page_role_code text REFERENCES page_roles (code),
  -- Причина непривязки; у привязанной страницы обязана быть NULL.
  reason         text,
  needs_review   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Тот самый ключ: страница ревизии учтена ровно один раз, и «привязана» с
  -- «непривязана» одновременно физически невозможны.
  CONSTRAINT page_assignments_page_uq UNIQUE (revision_id, source_page_id),
  CONSTRAINT page_assignments_sort_order_chk CHECK (sort_order IS NULL OR sort_order >= 0),
  -- Оба состояния описаны полностью: привязанная страница обязана иметь место в
  -- документе и не иметь причины непривязки, непривязанная — наоборот. Без этого
  -- nullable-документ допускал бы полустроки вида «без документа, но с порядком».
  CONSTRAINT page_assignments_state_chk CHECK (
    (document_id IS NOT NULL AND sort_order IS NOT NULL AND reason IS NULL)
    OR (document_id IS NULL AND sort_order IS NULL AND page_role_code IS NULL
        AND reason IS NOT NULL)),
  -- Документ и страница не могут оказаться из разных ревизий. Каскад унаследован
  -- от document_pages: удаление документа уносит назначения его страниц, и они
  -- становятся НЕУЧТЁННЫМИ. Это осознанный выбор — пересегментация обязана
  -- переучесть их той же транзакцией, а забытые видны в v_unaccounted_pages ниже.
  -- Обнулять document_id каскадом нельзя: строка потеряла бы и sort_order, и
  -- причину непривязки, то есть нарушила бы page_assignments_state_chk.
  CONSTRAINT page_assignments_document_fk
    FOREIGN KEY (revision_id, document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE,
  CONSTRAINT page_assignments_source_page_fk
    FOREIGN KEY (revision_id, source_page_id) REFERENCES source_pages (revision_id, id)
  -- UNIQUE (document_id, sort_order) нет по той же причине, что и у ordinal
  -- документа: пересегментация переписывает порядок целиком одним UPDATE.
);

CREATE INDEX ix_page_assignments_document ON page_assignments (document_id, sort_order);
CREATE INDEX ix_page_assignments_source_page ON page_assignments (source_page_id);
CREATE INDEX ix_page_assignments_role ON page_assignments (page_role_code);
-- Экран «непривязанные страницы» и правило полноты читают только их.
CREATE INDEX ix_page_assignments_unassigned ON page_assignments (revision_id)
  WHERE document_id IS NULL;

-- Вторая половина инварианта §16 — «потерь нет». Ограничением она не выражается:
-- ограничение говорит о строке, которая ЕСТЬ, а здесь утверждение о полноте, то
-- есть о странице, которой в page_assignments НЕТ. Поэтому проверка вынесена в
-- представление: тест инварианта и админский экран требуют его пустоты.
CREATE VIEW v_unaccounted_pages AS
SELECT p.revision_id,
       p.id AS source_page_id,
       p.source_file_id,
       p.revision_ordinal
  FROM source_pages p
 WHERE NOT EXISTS (
         SELECT 1
           FROM page_assignments a
          WHERE a.revision_id = p.revision_id
            AND a.source_page_id = p.id);

CREATE TABLE document_relations (
  parent_document_id uuid NOT NULL,
  child_document_id  uuid NOT NULL,
  relation           text NOT NULL,
  -- Денормализованная ревизия: связь между документами разных ревизий
  -- бессмысленна, а составными FK ниже она запрещена. Первичный ключ остаётся
  -- трёхколоночным — одна пара документов может быть связана по-разному.
  revision_id        uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_document_id, child_document_id, relation),
  CONSTRAINT document_relations_self_chk CHECK (parent_document_id <> child_document_id),
  CONSTRAINT document_relations_relation_chk CHECK (relation IN (
    'annex', 'quality_doc', 'protocol', 'copy_certification', 'signature_page',
    'supersedes', 'duplicate')),
  CONSTRAINT document_relations_parent_fk
    FOREIGN KEY (revision_id, parent_document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE,
  CONSTRAINT document_relations_child_fk
    FOREIGN KEY (revision_id, child_document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_document_relations_child ON document_relations (child_document_id);
CREATE INDEX ix_document_relations_revision ON document_relations (revision_id);

CREATE TABLE field_values (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Денормализованная ревизия: документ, версия текста страницы и блок-источник
  -- обязаны быть из одной ревизии. Тремя простыми FK это не выражается, а
  -- доказательство, снятое с текста чужой поставки, — худший вид ложного факта:
  -- оно выглядит проверенным.
  revision_id         uuid NOT NULL,
  document_id         uuid NOT NULL REFERENCES logical_documents (id) ON DELETE CASCADE,
  field_code          text NOT NULL,
  -- Значение разложено по типам колонок, а не приведено к строке: сравнение дат
  -- и допусков (§9.2, §9.4) обязано работать с датой и числом.
  value_text          text,
  value_date          date,
  value_num           numeric,
  value_json          jsonb,
  confidence          double precision,
  is_verified         boolean NOT NULL DEFAULT false,
  extractor_version   text NOT NULL,
  -- Тройка доказательства: версия текста страницы, точный диапазон символов и
  -- цитата. Без отображения цитаты на span результат считается undetermined.
  page_text_version_id uuid REFERENCES page_text_versions (id),
  source_block_id     uuid REFERENCES layout_blocks (id),
  char_span           int4range,
  quote               text,
  extracted_by        text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_values_field_code_chk CHECK (field_code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT field_values_confidence_chk
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT field_values_extracted_by_chk CHECK (extracted_by IN ('rule', 'llm', 'manual')),
  -- Диапазон символов без текста, в котором он измерен, ни на что не
  -- отображается.
  CONSTRAINT field_values_span_source_chk
    CHECK (char_span IS NULL OR page_text_version_id IS NOT NULL),
  CONSTRAINT field_values_span_bounds_chk
    CHECK (char_span IS NULL OR lower(char_span) >= 0),
  CONSTRAINT field_values_document_fk
    FOREIGN KEY (revision_id, document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE,
  -- Ссылки необязательные, и это не ослабляет FK: составной ключ с NULL в
  -- ссылающемся столбце по MATCH SIMPLE не проверяется, а revision_id здесь
  -- NOT NULL — значит единственный непроверяемый случай «ссылки нет вовсе».
  CONSTRAINT field_values_page_text_fk
    FOREIGN KEY (revision_id, page_text_version_id)
    REFERENCES page_text_versions (revision_id, id),
  CONSTRAINT field_values_source_block_fk
    FOREIGN KEY (revision_id, source_block_id)
    REFERENCES layout_blocks (revision_id, id)
  -- UNIQUE (document_id, field_code) нет: детерминированный экстрактор и LLM
  -- могут предложить значение одного и того же реквизита, выбор фиксируется
  -- is_verified.
);

CREATE INDEX ix_field_values_revision ON field_values (revision_id);
CREATE INDEX ix_field_values_document ON field_values (document_id, field_code);
CREATE INDEX ix_field_values_page_text ON field_values (page_text_version_id);
CREATE INDEX ix_field_values_source_block ON field_values (source_block_id);

-- Строка реестра приложений. Реестр эталонен по составу и номерам, но не по
-- видам документов: подрядчик заполняет его от руки и обобщает, поэтому сверка
-- идёт по номеру, а вид из реестра — лишь слабая подсказка.
CREATE TABLE registry_rows (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id         uuid NOT NULL,
  -- Документ-реестр, которому принадлежит строка.
  document_id         uuid NOT NULL,
  row_no              integer NOT NULL,
  section_title       text,
  doc_name_raw        text NOT NULL,
  doc_no_raw          text,
  org_raw             text,
  -- Три формы номера: raw для показа человеку, norm для точного сравнения,
  -- folded для сравнения после фолдинга гомоглифов (одна декларация встречается
  -- и как Д-RU.PA01.B, и как Д-РУ.РА01.В; similarity такое расхождение не
  -- закрывает — замер дал 0.55).
  doc_no_norm         text,
  doc_no_folded       text,
  valid_from          date,
  valid_to            date,
  issued_at           date,
  matched_document_id uuid,
  match_score         double precision,
  match_state         text NOT NULL DEFAULT 'missing',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registry_rows_row_no_chk CHECK (row_no > 0),
  CONSTRAINT registry_rows_match_score_chk
    CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 1)),
  CONSTRAINT registry_rows_match_state_chk
    CHECK (match_state IN ('matched', 'missing', 'extra', 'ambiguous')),
  -- Совпадение только по folded при коллизии даёт ambiguous, а не matched;
  -- matched без документа — противоречие.
  CONSTRAINT registry_rows_matched_chk
    CHECK (match_state <> 'matched' OR matched_document_id IS NOT NULL),
  CONSTRAINT registry_rows_row_uq UNIQUE (document_id, row_no),
  CONSTRAINT registry_rows_document_fk
    FOREIGN KEY (revision_id, document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE,
  -- Сопоставление не может указать на документ чужой ревизии. Каскада нет
  -- намеренно: пересегментация обязана сначала обнулить matched_document_id и
  -- лишь затем удалять документы — иначе тихо потерялась бы строка реестра,
  -- которая сама по себе остаётся фактом поставки.
  CONSTRAINT registry_rows_matched_document_fk
    FOREIGN KEY (revision_id, matched_document_id)
    REFERENCES logical_documents (revision_id, id)
);

CREATE INDEX ix_registry_rows_revision ON registry_rows (revision_id);
CREATE INDEX ix_registry_rows_matched ON registry_rows (matched_document_id);
CREATE INDEX ix_registry_rows_no_norm ON registry_rows (doc_no_norm);
CREATE INDEX ix_registry_rows_no_folded ON registry_rows (doc_no_folded);

CREATE TABLE materials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id   uuid NOT NULL REFERENCES submission_revisions (id),
  name_raw      text NOT NULL,
  name_norm     text NOT NULL,
  mark          text,
  size_spec     text,
  category_code text,
  source        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materials_source_chk
    CHECK (source IN ('act_p3', 'registry', 'quality_doc', 'manual')),
  CONSTRAINT materials_category_chk
    CHECK (category_code IS NULL OR category_code ~ '^[a-z][a-z0-9_]*$'),
  -- Ключ для составного FK связей материал-документ.
  CONSTRAINT materials_revision_id_uq UNIQUE (revision_id, id)
);

CREATE INDEX ix_materials_revision ON materials (revision_id);
CREATE INDEX ix_materials_name_norm ON materials USING gin (name_norm gin_trgm_ops);

CREATE TABLE batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id     uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  batch_no        text,
  heat_no         text,
  -- Та самая дата, против которой проверяются DATE.312 и DATE.372.
  manufactured_at date,
  volume          numeric,
  unit            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batches_material_id_uq UNIQUE (material_id, id)
);

CREATE INDEX ix_batches_material ON batches (material_id);

CREATE TABLE material_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Денормализованная ревизия: двумя простыми FK материал ревизии R1 связывался
  -- с документом ревизии R2, и покрытие материала «подтверждалось» сертификатом
  -- из чужой поставки — ровно тот дефект, который правила §9.4 обязаны находить.
  revision_id uuid NOT NULL,
  material_id uuid NOT NULL REFERENCES materials (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES logical_documents (id) ON DELETE CASCADE,
  batch_id    uuid,
  -- Множество связей материал-документ в enums.ts не закреплено (оно шире связей
  -- документ-документ и растёт вместе с матрицей материалов профиля), поэтому
  -- проверяется только формат кода.
  relation    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_documents_relation_chk CHECK (relation ~ '^[a-z][a-z0-9_]*$'),
  -- Партия обязана принадлежать тому же материалу.
  CONSTRAINT material_documents_batch_fk
    FOREIGN KEY (material_id, batch_id) REFERENCES batches (material_id, id),
  -- Материал и документ обязаны быть из одной ревизии. Партия закрыта материалом,
  -- поэтому отдельная ревизия у batches не нужна.
  CONSTRAINT material_documents_material_fk
    FOREIGN KEY (revision_id, material_id)
    REFERENCES materials (revision_id, id) ON DELETE CASCADE,
  CONSTRAINT material_documents_document_fk
    FOREIGN KEY (revision_id, document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE
);

-- Уникальность связи двумя частичными индексами: связь без партии и связь с
-- партией — разные утверждения, а NULL в обычном UNIQUE не сравнивается.
CREATE UNIQUE INDEX ux_material_documents_with_batch
  ON material_documents (material_id, document_id, batch_id, relation)
  WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX ux_material_documents_without_batch
  ON material_documents (material_id, document_id, relation)
  WHERE batch_id IS NULL;

-- Уникальные индексы выше частичные, поэтому поиск по материалу опирается на
-- отдельный полный индекс.
CREATE INDEX ix_material_documents_revision ON material_documents (revision_id);
CREATE INDEX ix_material_documents_material ON material_documents (material_id);
CREATE INDEX ix_material_documents_document ON material_documents (document_id);
CREATE INDEX ix_material_documents_batch ON material_documents (batch_id);
