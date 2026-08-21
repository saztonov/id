-- Локальная аутентификация: третий режим AUTH_MODE (ADR-0009).
--
-- Почему учётные данные — отдельная таблица, а не колонки в users.
--   users.kc_sub остаётся NOT NULL UNIQUE и остаётся единственным внешним
--   идентификатором. Наличие СТРОКИ в user_credentials и есть признак «этот
--   пользователь может войти паролем»: проверять нечего и подделать нечем.
--   Колонки в users потребовали бы сделать kc_sub nullable, то есть ослабить
--   ограничение на таблице идентичности ради режима, который в конкретном
--   развёртывании может быть не включён. Ослабление NOT NULL — то изменение,
--   которое потом не откатывается, потому что данные уже накоплены.
--
-- Что здесь лежит в kc_sub у локальной учётной записи.
--   'local:<uuid>' — collision-safe placeholder, а НЕ тип пользователя.
--   Keycloak выдаёт sub в форме UUID, префикс эту форму нарушает, поэтому
--   пересечение пространств невозможно конструктивно. При переходе на SSO
--   placeholder заменяется настоящим subject'ом скриптом связывания учётных
--   записей (tools/scripts/link-sso.mjs), сохраняющим users.id, роли и области;
--   простое переключение AUTH_MODE завело бы Keycloak-пользователю ВТОРУЮ
--   строку users и потеряло бы назначения.
--
-- Имя колонки kc_sub для локальной учётной записи — признанный долг:
--   переименование в subject стоило бы правки фикстур ~25 тестов и
--   генерированной схемы. Смысл зафиксирован здесь и в ADR-0009.

CREATE TABLE user_credentials (
  user_id              uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- Каноническая форма логина: NFKC + trim + lower (canonicalizeLogin()).
  -- Собственная колонка, а не users.email: логин обязан быть уникальным, а
  -- users.email уникальным быть не может — в федерации два субъекта Keycloak с
  -- одним адресом законны.
  --
  -- citext здесь второй рубеж, а не основной: канонизация выполняется в коде,
  -- потому что тот же результат нужен для HMAC троттлинга, где базы нет. Если
  -- код и БД однажды разойдутся в понимании регистра, упадёт UNIQUE — а не
  -- тихо заведётся вторая учётная запись на тот же адрес.
  login_key            citext NOT NULL UNIQUE,
  -- Как пользователь ввёл адрес. Для отображения; в поиске не участвует.
  login_display        text NOT NULL,
  -- Самодостаточная строка PHC-подобного вида:
  --   scrypt$N=65536,r=8,p=2$<salt-b64url>$<key-b64url>
  -- Параметры внутри значения, а не в конфигурации: иначе смена стоимости
  -- сделала бы нечитаемыми все прежние хэши.
  password_hash        text NOT NULL,
  -- Денормализация префикса password_hash ради ОГРАНИЧЕНИЯ: строку с
  -- алгоритмом, которого код не умеет проверять, база не примет вовсе.
  password_algorithm   text NOT NULL,
  -- Отметка возраста пароля. Инвалидация сессий при смене выполняется отзывом
  -- строк auth_sessions (сессии серверные), а не сравнением меток: сравнение
  -- метки с временем выпуска — механика JWT, которой здесь нет.
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  -- Пароль выдан администратором либо сброшен: до смены пользователь допускается
  -- только к /me, выходу, CSRF и самой смене пароля.
  must_change_password boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- Только реализованное. Разрешать в схеме алгоритм, которого нет в коде,
  -- значит однажды получить строку, которую нечем проверить: пользователь не
  -- сможет войти, и причина будет не видна ни в одном логе.
  CONSTRAINT user_credentials_algorithm_chk
    CHECK (password_algorithm IN ('scrypt')),
  CONSTRAINT user_credentials_hash_prefix_chk
    CHECK (password_hash LIKE password_algorithm || '$%'),
  CONSTRAINT user_credentials_login_chk
    CHECK (length(login_key) BETWEEN 3 AND 320)
);

-- Пароль допустим только у локальной учётной записи.
--
-- Реализовано триггером, а не CHECK'ом с обращением к users: CHECK в PostgreSQL
-- обязан зависеть только от строки таблицы. Функция, читающая другую таблицу,
-- синтаксически проходит, но не перепроверяется при изменении той строки и не
-- защищена от гонки — то есть создаёт видимость ограничения вместо ограничения.
-- Триггер выполняется в той же транзакции и берёт строку users под FOR SHARE,
-- поэтому параллельное изменение kc_sub дождётся коммита.
--
-- Смысл ограничения: без него администратор мог бы завести федеративному
-- пользователю второй, необнаружимый путь входа мимо Keycloak.
CREATE FUNCTION user_credentials_local_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  subject text;
BEGIN
  SELECT kc_sub INTO subject FROM users WHERE id = NEW.user_id FOR SHARE;
  IF subject IS NULL THEN
    RAISE EXCEPTION 'user_credentials: пользователь % не найден', NEW.user_id;
  END IF;
  IF subject NOT LIKE 'local:%' THEN
    RAISE EXCEPTION
      'user_credentials: пароль допустим только у локальной учётной записи, '
      'а % федеративный (kc_sub не имеет префикса local:)', NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_credentials_local_only_trg
  BEFORE INSERT OR UPDATE OF user_id ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION user_credentials_local_only();

-- Заявки на регистрацию — отдельно от users.
--
-- Неодобренная заявка не должна выглядеть пользователем ни для одного запроса
-- портала: строка в users с is_active=false всё равно попадает в выборки
-- администрирования, в счётчики и в подсказки выбора исполнителя. Заявка — это
-- не пользователь, а намерение им стать.
CREATE TABLE registration_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_key          citext NOT NULL,
  login_display      text NOT NULL,
  full_name          text NOT NULL,
  position           text,
  -- Пароль, выбранный заявителем. NULL, если администратор при одобрении решил
  -- выдать временный (основное действие: адрес при регистрации не подтверждён,
  -- а SMTP в портале нет, поэтому личность подтверждается вне портала).
  password_hash      text,
  password_algorithm text,
  status             text NOT NULL DEFAULT 'pending',
  decided_at         timestamptz,
  decided_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  ip                 inet,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registration_requests_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT registration_requests_algorithm_chk
    CHECK (password_algorithm IS NULL OR password_algorithm IN ('scrypt')),
  -- Хэш и алгоритм задаются только вместе: строка с одним из двух непроверяема.
  CONSTRAINT registration_requests_hash_pair_chk
    CHECK ((password_hash IS NULL) = (password_algorithm IS NULL)),
  -- Решение и его автор появляются одновременно с уходом из 'pending'.
  CONSTRAINT registration_requests_decision_chk
    CHECK ((status = 'pending') = (decided_at IS NULL))
);

-- Одна ОТКРЫТАЯ заявка на адрес. Частичный уникальный индекс, а не UNIQUE:
-- после отказа человек имеет право подать заявку снова, и история отказов
-- должна сохраниться.
CREATE UNIQUE INDEX ux_registration_requests_pending
  ON registration_requests (login_key) WHERE status = 'pending';
CREATE INDEX ix_registration_requests_created ON registration_requests (created_at DESC);

-- Троттлинг попыток: и по логину, и по адресу клиента, в одной таблице с
-- разными пространствами ключей.
--
-- PostgreSQL, а не Redis: Redis в стеке нет, а стандарт прямо разрешает
-- PostgreSQL при умеренной нагрузке. Общее хранилище важнее скорости — лимит,
-- живущий в памяти процесса, перестаёт быть лимитом при второй реплике.
--
-- Ключ логина — HMAC КАНОНИЧЕСКОЙ формы, а не сам логин. Три причины:
--   1. Считать попытки нужно и по НЕСУЩЕСТВУЮЩИМ адресам, иначе поведение
--      различается и превращается в оракул существования учётной записи —
--      ровно то, что запрещает анти-enumeration.
--   2. Строка на каждый перебранный адрес не должна быть строкой ПДн: по той же
--      причине audit_log хранит actor_email_hmac, а не адрес.
--   3. Ключ HMAC живёт в окружении, поэтому дамп базы не даёт списка адресов,
--      по которым шёл перебор.
-- Ключ — AUTH_LOCAL_LOGIN_HMAC_KEY, отдельный от AUDIT_HMAC_KEY: ротация ключа
-- журнала не должна массово снимать блокировки входа.
CREATE TABLE auth_throttle (
  scope             text NOT NULL,
  bucket_key        text NOT NULL,
  -- Заполняется, только когда логин разрешился в пользователя: нужен
  -- администратору, чтобы разблокировать по карточке, не зная ключа HMAC.
  user_id           uuid REFERENCES users (id) ON DELETE CASCADE,
  failed_attempts   integer NOT NULL DEFAULT 0,
  first_failed_at   timestamptz NOT NULL DEFAULT now(),
  last_failed_at    timestamptz NOT NULL DEFAULT now(),
  -- Экспоненциальный backoff: 1с → 2с → 4с → … до потолка.
  next_attempt_at   timestamptz,
  -- Блокировка после исчерпания лимита неудач.
  locked_until      timestamptz,
  -- Конец окна подсчёта: строка старше него начинает счёт заново.
  window_expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, bucket_key),
  CONSTRAINT auth_throttle_scope_chk
    CHECK (scope IN ('login', 'ip-login', 'ip-register')),
  CONSTRAINT auth_throttle_attempts_chk CHECK (failed_attempts >= 0)
);

CREATE INDEX ix_auth_throttle_user ON auth_throttle (user_id);
-- Выборка уборки просроченных строк.
CREATE INDEX ix_auth_throttle_expiry ON auth_throttle (window_expires_at);

-- Режим, в котором выдана сессия.
--
-- Сессия, выданная Keycloak, не должна переживать переход портала на локальный
-- вход, и наоборот: права те же, а способ подтверждения личности разный, и
-- после смены режима прежнее подтверждение больше ничего не значит.
--
-- DEFAULT проставляется только ради существующих строк и тут же снимается:
-- умолчание на этой колонке означало бы, что забытый параметр вставки тихо
-- превращает локальную сессию в федеративную.
ALTER TABLE auth_sessions ADD COLUMN auth_mode text NOT NULL DEFAULT 'oidc';
ALTER TABLE auth_sessions ALTER COLUMN auth_mode DROP DEFAULT;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_mode_chk
  CHECK (auth_mode IN ('oidc', 'dev-stub', 'local'));
