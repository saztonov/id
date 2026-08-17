-- События, настройки, промты, задачи и наблюдаемость (§3.8).

-- Монотонный seq внутри ревизии: он позволяет SSE поддерживать Last-Event-ID и
-- replay после реконнекта. Outbox с published_at этого не умеет — он рассчитан
-- на одного потребителя. Отдельный индекс (revision_id, seq) не создаётся: это
-- и есть индекс первичного ключа.
CREATE TABLE revision_events (
  revision_id uuid NOT NULL REFERENCES submission_revisions (id),
  seq         bigint NOT NULL,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id, seq),
  CONSTRAINT revision_events_seq_chk CHECK (seq > 0)
);

-- Только несекретное: секреты живут в secret storage, а здесь допустима лишь
-- маскированная ссылка и статус подключения (§10).
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_app_settings_updated_by ON app_settings (updated_by);

CREATE TABLE prompt_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  version       integer NOT NULL,
  stage         text NOT NULL,
  doc_type_code text REFERENCES doc_types (code),
  state         text NOT NULL DEFAULT 'draft',
  system_prompt text NOT NULL,
  user_template text NOT NULL,
  output_schema jsonb,
  model_override text,
  published_at  timestamptz,
  published_by  uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_templates_code_chk CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT prompt_templates_version_chk CHECK (version > 0),
  CONSTRAINT prompt_templates_stage_chk
    CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary')),
  CONSTRAINT prompt_templates_state_chk
    CHECK (state IN ('draft', 'test', 'published', 'archived')),
  CONSTRAINT prompt_templates_published_chk CHECK (
    state <> 'published' OR (published_at IS NOT NULL AND published_by IS NOT NULL)),
  CONSTRAINT prompt_templates_code_version_uq UNIQUE (code, version)
);

-- Опубликованная версия промта одна на код: rollback — это публикация другой
-- версии с переводом текущей в archived, а не второй активный промт.
CREATE UNIQUE INDEX ux_prompt_templates_single_published
  ON prompt_templates (code)
  WHERE state = 'published';

CREATE INDEX ix_prompt_templates_doc_type ON prompt_templates (doc_type_code);
CREATE INDEX ix_prompt_templates_published_by ON prompt_templates (published_by);

CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'queued',
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  -- Аренда: locked_until нужен reaper'у, чтобы вернуть в очередь задачу
  -- умершего воркера (at-least-once).
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  priority     integer NOT NULL DEFAULT 100,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_type_chk CHECK (type ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'),
  CONSTRAINT jobs_status_chk
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  CONSTRAINT jobs_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT jobs_max_attempts_chk CHECK (max_attempts > 0)
);

-- Выборка задач воркером: FOR UPDATE SKIP LOCKED по готовым к запуску.
CREATE INDEX ix_jobs_status_next_run ON jobs (status, next_run_at);
CREATE INDEX ix_jobs_claim ON jobs (priority DESC, next_run_at)
  WHERE status = 'queued';
-- Идемпотентность постановки: пока задача не завершена, второй такой же
-- dedupe_key не появится. Условие на NULL добавлено ради размера индекса —
-- NULL-ключи в уникальном индексе и так не конфликтуют.
CREATE UNIQUE INDEX ux_jobs_dedupe_key ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'done';
CREATE INDEX ix_jobs_lease ON jobs (locked_until) WHERE status = 'running';

-- Журнал попыток. Он же — источник вычисляемого processing_status ревизии и
-- ответ на вопрос «сколько реально идёт обработка 83-страничного комплекта».
CREATE TABLE job_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Задача может быть удалена сборкой мусора, а тайминги обязаны остаться:
  -- поэтому ссылка обнуляется, а job_type дублируется строкой.
  job_id         uuid REFERENCES jobs (id) ON DELETE SET NULL,
  job_type       text NOT NULL,
  revision_id    uuid REFERENCES submission_revisions (id),
  request_id     text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  duration_ms    integer,
  attempt        integer NOT NULL,
  -- NULL — попытка ещё выполняется. Исход относится к попытке, а не к задаче:
  -- будет ли повтор, определяется jobs.attempts против max_attempts.
  outcome        text,
  error_class    text,
  error_message  text,
  payload_digest text,
  CONSTRAINT job_runs_attempt_chk CHECK (attempt > 0),
  CONSTRAINT job_runs_outcome_chk CHECK (
    outcome IS NULL OR outcome IN ('succeeded', 'failed', 'cancelled', 'lease_expired')),
  CONSTRAINT job_runs_duration_chk CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT job_runs_finished_chk CHECK (outcome IS NOT NULL OR finished_at IS NULL)
);

CREATE INDEX ix_job_runs_job ON job_runs (job_id);
CREATE INDEX ix_job_runs_revision ON job_runs (revision_id, started_at DESC);
CREATE INDEX ix_job_runs_type ON job_runs (job_type, started_at DESC);
CREATE INDEX ix_job_runs_request ON job_runs (request_id);
CREATE INDEX ix_job_runs_in_flight ON job_runs (started_at) WHERE outcome IS NULL;

-- Дедупликация по отпечатку: тысяча одинаковых падений — одна строка со
-- счётчиком, иначе экран диагностики бесполезен.
CREATE TABLE error_events (
  fingerprint       text PRIMARY KEY,
  error_class       text NOT NULL,
  message_template  text NOT NULL,
  top_frame         text,
  count             bigint NOT NULL DEFAULT 1,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  sample_request_id text,
  sample_context    jsonb,
  status            text NOT NULL DEFAULT 'new',
  acked_by          uuid REFERENCES users (id),
  resolved_at       timestamptz,
  CONSTRAINT error_events_count_chk CHECK (count > 0),
  CONSTRAINT error_events_status_chk CHECK (status IN ('new', 'ack', 'resolved'))
);

CREATE INDEX ix_error_events_status ON error_events (status, last_seen_at DESC);
CREATE INDEX ix_error_events_acked_by ON error_events (acked_by);

CREATE TABLE outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz
);

-- Публикатор читает только неопубликованные, поэтому индекс частичный.
CREATE INDEX ix_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX ix_outbox_aggregate ON outbox (aggregate_type, aggregate_id);
