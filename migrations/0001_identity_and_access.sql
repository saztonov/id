-- Идентичность и доступ (§3.1).
--
-- Перечисления домена во всей схеме выражены как CHECK ... IN (...), а не
-- нативными типами PostgreSQL. Обоснование: значение перечисления добавляется
-- обычной миграцией внутри транзакции (DROP CONSTRAINT + ADD CONSTRAINT), тогда
-- как ALTER TYPE ... ADD VALUE в версиях PostgreSQL до 12 в транзакционном блоке
-- запрещён, а раннер применяет каждую миграцию в транзакции. Списки значений
-- дословно совпадают с packages/contracts/src/enums.ts: расхождение границы API
-- и БД должно ломаться на миграции, а не проявляться в рантайме.
--
-- Справочники живут в 0002, поэтому внешние ключи на них добавлены там же:
-- порядок применения файлов запрещает ссылку вперёд.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Субъект Keycloak — единственный внешний идентификатор: e-mail в realm
  -- меняется, а sub нет.
  kc_sub        text NOT NULL UNIQUE,
  email         citext,
  full_name     text NOT NULL,
  position      text,
  is_active     boolean NOT NULL DEFAULT true,
  -- Организация подрядчика; FK на counterparties добавлен в 0002.
  contractor_id uuid,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_users_contractor ON users (contractor_id);
CREATE INDEX ix_users_email ON users (email);

-- Портал — единственный источник бизнес-ролей (§4.1): роли Keycloak сюда не
-- копируются, оттуда приходит только identity и признак доступа к порталу.
CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_chk
    CHECK (role IN ('contractor', 'engineer', 'manager', 'admin'))
);

CREATE TABLE user_object_scopes (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- FK на construction_objects добавлен в 0002.
  object_id  uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, object_id)
);

CREATE INDEX ix_user_object_scopes_object ON user_object_scopes (object_id);

CREATE TABLE auth_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Сессия Keycloak: нужна для backchannel logout по kc_sid.
  kc_sid              text,
  -- Refresh-токен хранится зашифрованным (§3.1). Ключ — в secret storage, а не
  -- в БД; key_version позволяет ротировать ключ, не разлогинивая всех.
  refresh_envelope    bytea NOT NULL,
  key_version         integer NOT NULL,
  csrf_hash           text NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  ip                  inet,
  ua                  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_expiry_chk CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT auth_sessions_key_version_chk CHECK (key_version > 0)
);

CREATE INDEX ix_auth_sessions_user ON auth_sessions (user_id);
CREATE INDEX ix_auth_sessions_kc_sid ON auth_sessions (kc_sid);
-- Выборка reaper'а: живые сессии с истёкшим абсолютным сроком.
CREATE INDEX ix_auth_sessions_expiry ON auth_sessions (absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE audit_log (
  -- Идентификатор последовательный, а не uuid: журнал читается диапазонами по
  -- времени и порядку записи.
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  actor_user_id    uuid REFERENCES users (id),
  -- HMAC, а не адрес: журнал переживает удаление пользователя, но не обязан
  -- хранить его ПДн (ключ AUDIT_HMAC_KEY, §15).
  actor_email_hmac text,
  action           text NOT NULL,
  entity_type      text NOT NULL,
  -- Текст, а не uuid: ключами сущностей бывают код (doc_types) и строка
  -- настройки (app_settings).
  entity_id        text,
  -- Область видимости записи журнала. FK нет намеренно: запись обязана быть
  -- сделана при любом состоянии справочников и не может быть изменена или
  -- удалена каскадом от них.
  object_id        uuid,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip               inet,
  request_id       text
);

CREATE INDEX ix_audit_log_at ON audit_log (at DESC);
CREATE INDEX ix_audit_log_object ON audit_log (object_id, at DESC);
CREATE INDEX ix_audit_log_actor ON audit_log (actor_user_id, at DESC);
CREATE INDEX ix_audit_log_entity ON audit_log (entity_type, entity_id);
