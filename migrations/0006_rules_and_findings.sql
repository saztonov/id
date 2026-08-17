-- Правила, прогоны проверок и замечания (§3.7).

-- Реестр правил. Код — не CHECK-перечисление: реализация правила живёт в
-- packages/rules, и при старте выполняется сверка «каждый код имеет реализацию и
-- наоборот» (§9.6). Формат кода — заглавные латинские сегменты через точку.
CREATE TABLE rule_definitions (
  code             text PRIMARY KEY,
  title            text NOT NULL,
  -- Правило типо-специфично, когда тип задан: на незнакомом типе оно даёт n_a,
  -- а не ошибку (§9.1).
  doc_type_code    text REFERENCES doc_types (code),
  level            text NOT NULL,
  kind             text NOT NULL,
  default_severity text NOT NULL,
  -- Роли, которым разрешено снимать замечание с обоснованием.
  waiver_roles     text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rule_definitions_code_chk CHECK (code ~ '^[A-Z][A-Z0-9]*([.][A-Z0-9]+)*$'),
  CONSTRAINT rule_definitions_severity_chk
    CHECK (default_severity IN ('error', 'warning', 'info')),
  -- Уровень и вид правила — открытые множества (группы правил §9.3-§9.5 растут
  -- вместе с каталогом), поэтому проверяется только формат кода-слага.
  CONSTRAINT rule_definitions_level_chk CHECK (level ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT rule_definitions_kind_chk CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT rule_definitions_waiver_roles_chk CHECK (waiver_roles <@ ARRAY[
    'contractor', 'engineer', 'manager', 'admin']::text[])
);

CREATE INDEX ix_rule_definitions_doc_type ON rule_definitions (doc_type_code);

CREATE TABLE ruleset_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version      text NOT NULL UNIQUE,
  published_at timestamptz,
  published_by uuid REFERENCES users (id),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ruleset_versions_published_chk
    CHECK (published_at IS NULL OR published_by IS NOT NULL)
);

CREATE INDEX ix_ruleset_versions_published_by ON ruleset_versions (published_by);

-- Неизменяемый снимок поведения правил: прогон месячной давности обязан
-- воспроизводиться точно, поэтому здесь лежит копия настроек, а не ссылка на
-- изменяемый реестр.
CREATE TABLE ruleset_rules (
  ruleset_version_id uuid NOT NULL REFERENCES ruleset_versions (id) ON DELETE CASCADE,
  rule_code          text NOT NULL REFERENCES rule_definitions (code),
  is_enabled         boolean NOT NULL DEFAULT true,
  severity           text NOT NULL,
  is_blocking        boolean NOT NULL DEFAULT false,
  params             jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (ruleset_version_id, rule_code),
  CONSTRAINT ruleset_rules_severity_chk CHECK (severity IN ('error', 'warning', 'info'))
);

CREATE INDEX ix_ruleset_rules_rule ON ruleset_rules (rule_code);

CREATE TABLE validation_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id            uuid NOT NULL REFERENCES submission_revisions (id),
  ruleset_version_id     uuid NOT NULL REFERENCES ruleset_versions (id),
  object_rule_profile_id uuid REFERENCES object_rule_profiles (id),
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  counts                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Ключ для составного FK замечаний.
  CONSTRAINT validation_runs_revision_uq UNIQUE (id, revision_id)
);

CREATE INDEX ix_validation_runs_revision ON validation_runs (revision_id, started_at DESC);
CREATE INDEX ix_validation_runs_ruleset ON validation_runs (ruleset_version_id);
CREATE INDEX ix_validation_runs_profile ON validation_runs (object_rule_profile_id);

CREATE TABLE findings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  validation_run_id uuid NOT NULL REFERENCES validation_runs (id) ON DELETE CASCADE,
  revision_id       uuid NOT NULL,
  object_id         uuid NOT NULL,
  contractor_id     uuid NOT NULL,
  rule_code         text NOT NULL REFERENCES rule_definitions (code),
  severity          text NOT NULL,
  state             text NOT NULL DEFAULT 'open',
  origin            text NOT NULL,
  is_blocking       boolean NOT NULL DEFAULT false,
  confirmed_by      uuid REFERENCES users (id),
  confirmed_at      timestamptz,
  target_type       text NOT NULL,
  -- Ссылка полиморфна (ревизия, страница, документ, реквизит, строка реестра,
  -- материал, партия), поэтому внешнего ключа нет; вид цели задан target_type.
  target_id         uuid,
  source_page_id    uuid REFERENCES source_pages (id),
  block_id          uuid REFERENCES layout_blocks (id),
  message           text NOT NULL,
  -- Способ устранения: замечание без него бесполезно подрядчику (§9.1).
  hint              text,
  waived_by         uuid REFERENCES users (id),
  waived_at         timestamptz,
  waiver_reason     text,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT findings_severity_chk CHECK (severity IN ('error', 'warning', 'info')),
  CONSTRAINT findings_state_chk
    CHECK (state IN ('open', 'resolved', 'waived', 'undetermined')),
  CONSTRAINT findings_origin_chk
    CHECK (origin IN ('deterministic', 'llm', 'external_unavailable')),
  CONSTRAINT findings_target_type_chk CHECK (target_type IN (
    'revision', 'source_page', 'document', 'field_value', 'registry_row',
    'material', 'batch')),
  -- Три инварианта методики, а не «плохие данные»: находка LLM не становится
  -- блокирующей без подтверждения инженером; undetermined не может быть
  -- блокирующим, иначе троичная логика вырождается в двоичную и подрядчик
  -- получает стоп по «не знаю»; снятие замечания требует автора и обоснования.
  CONSTRAINT findings_llm_blocking_chk
    CHECK (NOT (origin = 'llm' AND is_blocking) OR confirmed_by IS NOT NULL),
  CONSTRAINT findings_undetermined_chk CHECK (NOT (state = 'undetermined' AND is_blocking)),
  CONSTRAINT findings_waived_chk CHECK (
    state <> 'waived' OR (waived_by IS NOT NULL AND waiver_reason IS NOT NULL)),
  CONSTRAINT findings_run_fk
    FOREIGN KEY (validation_run_id, revision_id)
    REFERENCES validation_runs (id, revision_id),
  CONSTRAINT findings_scope_fk
    FOREIGN KEY (revision_id, object_id, contractor_id)
    REFERENCES submission_revisions (id, object_id, contractor_id)
);

CREATE INDEX ix_findings_run ON findings (validation_run_id);
CREATE INDEX ix_findings_revision_state ON findings (revision_id, state, severity);
CREATE INDEX ix_findings_object ON findings (object_id);
CREATE INDEX ix_findings_contractor ON findings (contractor_id);
CREATE INDEX ix_findings_rule ON findings (rule_code);
CREATE INDEX ix_findings_source_page ON findings (source_page_id);
CREATE INDEX ix_findings_block ON findings (block_id);
CREATE INDEX ix_findings_confirmed_by ON findings (confirmed_by);
CREATE INDEX ix_findings_waived_by ON findings (waived_by);
CREATE INDEX ix_findings_blocking ON findings (revision_id) WHERE is_blocking;

-- Доказательство: цитата, отображённая на точный диапазон текста страницы. Если
-- отобразить не удалось, замечание обязано быть undetermined, а не error.
CREATE TABLE finding_evidence (
  finding_id           uuid NOT NULL REFERENCES findings (id) ON DELETE CASCADE,
  page_text_version_id uuid NOT NULL REFERENCES page_text_versions (id),
  char_span            int4range NOT NULL,
  quote                text NOT NULL,
  PRIMARY KEY (finding_id, page_text_version_id, char_span),
  CONSTRAINT finding_evidence_span_chk CHECK (lower(char_span) >= 0)
);

CREATE INDEX ix_finding_evidence_page_text ON finding_evidence (page_text_version_id);

CREATE TABLE review_actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id    uuid NOT NULL REFERENCES submission_revisions (id),
  actor_user_id  uuid NOT NULL REFERENCES users (id),
  -- Множество действий задаёт модуль workflow (submit, return, approve,
  -- override, комментарий), и оно расширяется без миграции: здесь проверяется
  -- только формат кода.
  action         text NOT NULL,
  comment        text,
  at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_actions_action_chk CHECK (action ~ '^[a-z][a-z0-9_]*$')
);

CREATE INDEX ix_review_actions_revision ON review_actions (revision_id, at DESC);
CREATE INDEX ix_review_actions_actor ON review_actions (actor_user_id);
