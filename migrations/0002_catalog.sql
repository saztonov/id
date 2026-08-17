-- Справочники (§3.2).
--
-- Открытый мир (§0.5): множества, растущие эксплуатацией — виды разделов, виды
-- ИД, роли страниц, коды правил — это таблицы-справочники с кодом-слагом, а не
-- CHECK-перечисления. Закрытым перечислением остаётся только то, множество
-- значений чего задаём мы сами (kind, autonomy_level, статусы).

CREATE TABLE counterparties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  inn           text,
  kpp           text,
  ogrn          text,
  legal_address text,
  kind          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Проверяется только форма реквизита. Контрольные суммы ИНН и ОГРН — дело
  -- правила AOSR.HDR над извлечёнными значениями: ОГРН из 12 цифр обязан доехать
  -- до движка правил замечанием, а не быть отброшенным на границе. Классы
  -- символов записаны как [0-9], а не \d: литерал остаётся однозначным и при
  -- выключенном standard_conforming_strings.
  CONSTRAINT counterparties_inn_chk CHECK (inn ~ '^([0-9]{10}|[0-9]{12})$'),
  CONSTRAINT counterparties_kpp_chk CHECK (kpp ~ '^[0-9]{9}$'),
  CONSTRAINT counterparties_ogrn_chk CHECK (ogrn ~ '^([0-9]{13}|[0-9]{15})$'),
  CONSTRAINT counterparties_kind_chk
    CHECK (kind IN ('customer', 'general_contractor', 'contractor', 'supplier'))
);

CREATE INDEX ix_counterparties_inn ON counterparties (inn);
CREATE INDEX ix_counterparties_ogrn ON counterparties (ogrn);

CREATE TABLE construction_objects (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Код объекта — ровно 5 латинских букв или цифр.
  code                   varchar(5) NOT NULL UNIQUE,
  name                   text NOT NULL,
  full_name              text NOT NULL,
  address                text,
  is_active              boolean NOT NULL DEFAULT true,
  developer_id           uuid REFERENCES counterparties (id),
  tech_customer_id       uuid REFERENCES counterparties (id),
  general_contractor_id  uuid REFERENCES counterparties (id),
  -- Шаблон номера акта объекта; сверяется правилом AOSR.ACT.
  act_number_pattern     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT construction_objects_code_chk CHECK (code ~ '^[A-Za-z0-9]{5}$')
);

CREATE INDEX ix_construction_objects_developer ON construction_objects (developer_id);
CREATE INDEX ix_construction_objects_tech_customer ON construction_objects (tech_customer_id);
CREATE INDEX ix_construction_objects_general_contractor
  ON construction_objects (general_contractor_id);

-- Вид раздела работ. Справочник, а не перечисление: разделов существенно больше,
-- чем два разобранных в корпусе, и заведение нового не должно быть релизом.
CREATE TABLE section_kinds (
  code text PRIMARY KEY,
  name text NOT NULL,
  CONSTRAINT section_kinds_code_chk CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

CREATE TABLE object_sections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id         uuid NOT NULL REFERENCES construction_objects (id),
  code              text NOT NULL,
  name              text NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  section_kind_code text NOT NULL REFERENCES section_kinds (code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT object_sections_sort_order_chk CHECK (sort_order >= 0),
  CONSTRAINT object_sections_object_code_uq UNIQUE (object_id, code),
  -- Ключ для составных FK: раздел, указанный вместе с объектом, обязан
  -- принадлежать именно этому объекту.
  CONSTRAINT object_sections_object_id_uq UNIQUE (object_id, id)
);

CREATE INDEX ix_object_sections_kind ON object_sections (section_kind_code);

-- Профиль вида раздела: ожидаемый состав комплекта, уместные категории
-- материалов, матрица требований и применимые правила. Версионный с периодом
-- действия — иначе прогон проверок месячной давности невоспроизводим.
CREATE TABLE section_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_kind_code   text NOT NULL REFERENCES section_kinds (code),
  version             integer NOT NULL,
  effective_from      date NOT NULL,
  effective_to        date,
  expected_doc_types  text[] NOT NULL DEFAULT '{}',
  material_categories text[] NOT NULL DEFAULT '{}',
  material_matrix     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled_rule_codes  text[] NOT NULL DEFAULT '{}',
  thresholds          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Новый раздел всегда стартует в assisted (§0.5, п.5).
  autonomy_level      text NOT NULL DEFAULT 'assisted',
  published_at        timestamptz,
  published_by        uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT section_profiles_version_chk CHECK (version > 0),
  CONSTRAINT section_profiles_period_chk
    CHECK (effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT section_profiles_autonomy_chk
    CHECK (autonomy_level IN ('assisted', 'automatic')),
  CONSTRAINT section_profiles_kind_version_uq UNIQUE (section_kind_code, version)
);

CREATE INDEX ix_section_profiles_published ON section_profiles (published_by);

CREATE TABLE object_rule_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id      uuid NOT NULL REFERENCES construction_objects (id),
  section_id     uuid REFERENCES object_sections (id),
  version        integer NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT object_rule_profiles_version_chk CHECK (version > 0),
  CONSTRAINT object_rule_profiles_period_chk
    CHECK (effective_to IS NULL OR effective_from <= effective_to),
  -- Раздел обязан принадлежать тому же объекту, что и профиль.
  CONSTRAINT object_rule_profiles_section_fk
    FOREIGN KEY (object_id, section_id) REFERENCES object_sections (object_id, id)
);

-- Уникальность версии профиля выражена двумя частичными индексами, а не UNIQUE
-- (object_id, section_id, version): NULL в section_id (профиль всего объекта) в
-- обычном UNIQUE не сравнивается, и такие строки дублировались бы. NULLS NOT
-- DISTINCT не используется — он появился только в PostgreSQL 15.
CREATE UNIQUE INDEX ux_object_rule_profiles_section_version
  ON object_rule_profiles (object_id, section_id, version)
  WHERE section_id IS NOT NULL;
CREATE UNIQUE INDEX ux_object_rule_profiles_object_version
  ON object_rule_profiles (object_id, version)
  WHERE section_id IS NULL;

-- Индексы на столбцы внешних ключей: уникальные индексы выше частичные и для
-- поиска по object_id не годятся. Порядок по началу действия — это же и запрос
-- «профиль, действующий на дату».
CREATE INDEX ix_object_rule_profiles_object
  ON object_rule_profiles (object_id, effective_from DESC);
CREATE INDEX ix_object_rule_profiles_section ON object_rule_profiles (section_id);

-- Реестр рабочей документации объекта: шифр из п.2/п.6 АОСР сверяется с ним.
CREATE TABLE rd_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id   uuid NOT NULL REFERENCES construction_objects (id),
  cipher      text NOT NULL,
  revision    text,
  name        text,
  designer_id uuid REFERENCES counterparties (id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Уникальность шифра не ограничением: один и тот же шифр законно существует в
-- нескольких изменениях, а дубль в реестре — дефект данных, выявляемый правилом.
CREATE INDEX ix_rd_documents_object_cipher ON rd_documents (object_id, cipher);
CREATE INDEX ix_rd_documents_designer ON rd_documents (designer_id);

-- Каталог видов ИД. Наполняется seed-миграцией из packages/doc-types, поэтому
-- id имеет значение по умолчанию, а состав столбцов совпадает с generateSeedSql().
CREATE TABLE doc_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  short_name  text NOT NULL,
  group_code  text NOT NULL,
  kind        text NOT NULL,
  has_annexes boolean NOT NULL DEFAULT false,
  match_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_system   boolean NOT NULL DEFAULT false,
  -- Резервный тип открытого мира: классификатору обязано быть куда положить
  -- документ, который является документом, но не относится ни к одному типу.
  is_fallback boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doc_types_code_chk CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  -- Группа и роль в комплекте — закрытые множества (DocTypeGroup, DocTypeKind в
  -- packages/doc-types/src/types.ts), в отличие от самого кода типа.
  CONSTRAINT doc_types_group_chk CHECK (group_code IN (
    'acts', 'exec_schemes', 'registries_logs', 'quality_docs', 'tests_conclusions',
    'networks', 'facade', 'org', 'handover', 'fallback')),
  CONSTRAINT doc_types_kind_chk
    CHECK (kind IN ('primary', 'registry', 'evidence', 'fallback')),
  CONSTRAINT doc_types_sort_order_chk CHECK (sort_order >= 0)
);

CREATE INDEX ix_doc_types_group ON doc_types (group_code, sort_order);

-- Настройки администратора поверх системного типа. Отдельная таблица нужна
-- ровно затем, чтобы seed мог переписывать системные строки, ничего не затирая.
CREATE TABLE doc_type_overrides (
  doc_type_code text PRIMARY KEY REFERENCES doc_types (code),
  name          text,
  is_active     boolean,
  sort_order    integer,
  match_hints   jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Цикл роста каталога (§3.2): документ, не опознанный ни правилами, ни LLM, не
-- пропадает — его заголовок кластеризуется и выносится администратору.
CREATE TABLE doc_type_candidates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_title_norm   text NOT NULL UNIQUE,
  observed_title_sample text NOT NULL,
  occurrences           integer NOT NULL DEFAULT 1,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  -- FK на ревизию и страницу-пример добавлены в 0003 с ON DELETE SET NULL:
  -- кандидат обязан пережить удаление поставки по retention.
  sample_revision_id    uuid,
  sample_source_page_id uuid,
  status                text NOT NULL DEFAULT 'new',
  mapped_doc_type_code  text REFERENCES doc_types (code),
  reviewed_by           uuid REFERENCES users (id),
  reviewed_at           timestamptz,
  CONSTRAINT doc_type_candidates_occurrences_chk CHECK (occurrences > 0),
  CONSTRAINT doc_type_candidates_status_chk
    CHECK (status IN ('new', 'reviewing', 'mapped', 'ignored')),
  CONSTRAINT doc_type_candidates_mapped_chk
    CHECK (status <> 'mapped' OR mapped_doc_type_code IS NOT NULL)
);

CREATE INDEX ix_doc_type_candidates_status ON doc_type_candidates (status, occurrences DESC);
CREATE INDEX ix_doc_type_candidates_mapped ON doc_type_candidates (mapped_doc_type_code);
CREATE INDEX ix_doc_type_candidates_reviewed_by ON doc_type_candidates (reviewed_by);

-- Роли страниц ортогональны видам ИД.
--
-- CHECK ... IN здесь сознательно нет, хотя pageRoleCodeSchema в contracts —
-- закрытое перечисление из четырёх значений: PAGE_ROLES в packages/doc-types уже
-- содержит пятую роль doc_continuation, найденную замером корпуса, и seed
-- вставляет её в эту таблицу. Множество ролей ограничено внешним ключом из
-- document_pages, то есть тем, что реально засеяно, а расширение роли остаётся
-- правкой каталога, а не миграцией схемы.
CREATE TABLE page_roles (
  code text PRIMARY KEY,
  name text NOT NULL,
  CONSTRAINT page_roles_code_chk CHECK (code ~ '^[a-z][a-z0-9_]*$')
);

-- Внешние ключи таблиц §3.1 на справочники: в 0001 их объявить было нельзя.
ALTER TABLE users
  ADD CONSTRAINT users_contractor_fk
  FOREIGN KEY (contractor_id) REFERENCES counterparties (id);

ALTER TABLE user_object_scopes
  ADD CONSTRAINT user_object_scopes_object_fk
  FOREIGN KEY (object_id) REFERENCES construction_objects (id);
