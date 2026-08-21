-- Журнал ошибок: проблемы, сигнатуры, точные счётчики и выборочные примеры (§11, §14).
--
-- Почему одной таблицы `error_events` оказалось мало.
--   Она отвечает ровно на два вопроса: «какие отпечатки видел портал» и
--   «сколько раз всего». На вопросы, ради которых журнал вообще открывают —
--   «началась ли новая волна», «сломалось ли после вчерашнего деплоя»,
--   «сколько было за сутки», «чем это чинили в прошлый раз» — она не отвечает
--   и не может: `count` монотонен и не разложен по времени, образец хранится
--   один, а истории решений нет вовсе. `first_seen_at` отвечает только на
--   «когда отпечаток появился впервые» и молчит про повторную волну.
--
-- Почему проблема отделена от отпечатка.
--   Отпечаток считается из нормализованного сообщения, а нормализация уже
--   менялась однажды (см. заголовок apps/api/src/observability/errors.ts) и
--   будет меняться впредь. Любая такая правка расщепляет накопленный счётчик
--   на два и обнуляет историю ровно у тех ошибок, которыми занимались дольше
--   всего. Поэтому отпечаток принадлежит СИГНАТУРЕ и версионирован
--   (`algo_version`), а статус, владелец, история действий и подтверждённое
--   решение принадлежат ПРОБЛЕМЕ с собственным неизменным `id`. Несколько
--   сигнатур ссылаются на одну проблему — это же делает возможным ручное
--   объединение «одна поломка, два стека».
--
-- Почему счётчики почасовые, а примеры выборочные.
--   Это две разные потребности, и попытка обслужить обе одной таблицей даёт
--   таблицу, которая не обслуживает ни одну. Точное число событий нужно за
--   произвольный период и с разбивкой по релизу — это `error_stats_hourly`,
--   строка на комбинацию, а не на событие. Диагностический контекст (кто,
--   какой маршрут, какая ревизия) нужен в нескольких экземплярах, а не в
--   тысячах — это `error_samples`, и они пишутся по прореживающей политике.
--   Имя `samples` выбрано вместо `occurrences` сознательно: таблицу с
--   названием «появления», в которую попадает одно появление из тысячи,
--   кто-нибудь однажды просуммирует и получит неверное число.
--
-- Почему у проблемы нет суммарного счётчика.
--   Колонка `count`, обновляемая на каждое событие, — это запись в таблицу и
--   во все её индексы на каждый отказ. Во время шторма журнал усиливал бы
--   нагрузку на ту же больную базу, которую обязан диагностировать. Сумма
--   считается по бакетам за выбранный период, и это ровно то число, которое
--   человек имеет в виду, когда сортирует «по частоте».
--
-- Почему классификация — несколько независимых осей, а не одно поле.
--   Ошибка драйвера PostgreSQL внутри задачи распознавания одновременно
--   относится к домену `db`, к способу исполнения `job` и к стадии
--   `recognition`. Одно поле `kind` заставило бы выбрать одно из трёх и молча
--   потерять два, а именно их пересечение и отвечает на вопрос «где чинить».
--
-- Почему ссылки на ревизию, объект и задачу — без внешних ключей.
--   По той же причине, что `audit_log.object_id`: журнал обязан пережить
--   удаление сущности сборкой мусора. Внешний ключ означал бы, что удаление
--   старой поставки либо обнуляет диагностику, либо не выполняется вовсе.

-- =====================================================================
-- Проблемы
-- =====================================================================

CREATE TABLE error_issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Человекочитаемое имя проблемы. Заполняется из класса и шаблона сообщения
  -- первой сигнатуры и остаётся редактируемым: после разбора «TypeError:
  -- <value> is not a function» полезнее назвать «падение экспорта при пустом
  -- реестре».
  title             text NOT NULL,
  status            text NOT NULL DEFAULT 'new',
  priority          text NOT NULL DEFAULT 'normal',
  assignee_user_id  uuid REFERENCES users (id),
  -- Служебная проблема-накопитель: в неё уходят события сверх лимита новых
  -- сигнатур. Признак нужен экрану, чтобы не показывать её как обычную
  -- поломку: это отметка о переполнении, а не дефект портала.
  is_synthetic      boolean NOT NULL DEFAULT false,

  -- Оси классификации. Заполняются по первой сигнатуре и уточняются
  -- сбросом накопителя; `pipeline_stage` пуст у всего, что не относится к
  -- конвейеру обработки поставки.
  source            text NOT NULL DEFAULT 'unknown',
  execution         text NOT NULL DEFAULT 'unknown',
  domain            text NOT NULL DEFAULT 'unknown',
  pipeline_stage    text,
  severity          text NOT NULL DEFAULT 'error',

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  -- Релиз, в котором проблема впервые и в последний раз наблюдалась. Пара
  -- отвечает на «появилось после деплоя» без обращения к ряду.
  first_release     text,
  last_release      text,

  acked_at          timestamptz,
  acked_by          uuid REFERENCES users (id),
  resolved_at       timestamptz,
  resolved_by       uuid REFERENCES users (id),
  -- Разбор и способ устранения. Живут бессрочно и переживают очистку примеров:
  -- «эта ошибка возвращалась трижды, и вот чем её чинили» — единственное, ради
  -- чего вообще стоит хранить журнал год.
  root_cause        text,
  resolution        text,
  resolution_type   text,
  fixed_in_release  text,

  CONSTRAINT error_issues_status_chk CHECK (status IN ('new', 'ack', 'resolved')),
  CONSTRAINT error_issues_priority_chk CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT error_issues_source_chk CHECK (source IN ('api', 'worker', 'web', 'unknown')),
  CONSTRAINT error_issues_execution_chk
    CHECK (execution IN ('http', 'job', 'process', 'client', 'unknown')),
  CONSTRAINT error_issues_domain_chk CHECK (domain IN (
    'db', 'llm', 'recognition', 'storage', 'auth', 'integration', 'application', 'unknown')),
  -- Стадия конвейера (§12). NULL — событие вне конвейера: HTTP-запрос,
  -- обслуживающая задача, падение процесса.
  CONSTRAINT error_issues_pipeline_stage_chk CHECK (pipeline_stage IS NULL OR pipeline_stage IN (
    'uploaded', 'layout', 'recognition', 'analysis', 'checks', 'ready', 'failed')),
  CONSTRAINT error_issues_severity_chk CHECK (severity IN ('warn', 'error', 'fatal')),
  CONSTRAINT error_issues_resolution_type_chk CHECK (resolution_type IS NULL OR resolution_type IN (
    'fixed', 'wontfix', 'duplicate', 'external', 'not_reproducible')),
  -- Закрытая проблема обязана назвать, кем и когда закрыта: «закрыто без
  -- автора» неотличимо от сбоя миграции статуса.
  CONSTRAINT error_issues_resolved_chk CHECK (
    status <> 'resolved' OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),
  CONSTRAINT error_issues_seen_order_chk CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX ix_error_issues_status ON error_issues (status, last_seen_at DESC);
CREATE INDEX ix_error_issues_last_seen ON error_issues (last_seen_at DESC);
CREATE INDEX ix_error_issues_domain ON error_issues (domain, last_seen_at DESC);
CREATE INDEX ix_error_issues_source ON error_issues (source, last_seen_at DESC);
CREATE INDEX ix_error_issues_assignee ON error_issues (assignee_user_id);
CREATE INDEX ix_error_issues_acked_by ON error_issues (acked_by);
CREATE INDEX ix_error_issues_resolved_by ON error_issues (resolved_by);

-- Служебная проблема-накопитель переполнения. Заводится миграцией с
-- фиксированным идентификатором, а не кодом при первом переполнении: код,
-- создающий строку в момент, когда его как раз душит поток уникальных
-- сигнатур, — это лишняя запись ровно тогда, когда записывать нельзя.
INSERT INTO error_issues (id, title, is_synthetic, source, execution, domain, severity)
VALUES (
  '00000000-0000-4000-8000-0000000e0001',
  'Переполнение числа новых сигнатур',
  true,
  'unknown',
  'unknown',
  'application',
  'warn'
);

-- =====================================================================
-- Сигнатуры
-- =====================================================================

CREATE TABLE error_signatures (
  fingerprint      text PRIMARY KEY,
  -- Версия алгоритма отпечатка. Смена нормализации сообщения повышает версию,
  -- новые события заводят новую сигнатуру — но ссылается она на ТУ ЖЕ
  -- проблему, если её удалось сопоставить. Без этой колонки было бы
  -- невозможно даже понять, почему счётчик однажды разошёлся надвое.
  algo_version     integer NOT NULL,
  issue_id         uuid NOT NULL REFERENCES error_issues (id) ON DELETE CASCADE,
  error_class      text NOT NULL,
  message_template text NOT NULL,
  top_frame        text,
  source           text NOT NULL DEFAULT 'unknown',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT error_signatures_algo_chk CHECK (algo_version > 0),
  CONSTRAINT error_signatures_source_chk CHECK (source IN ('api', 'worker', 'web', 'unknown'))
);

CREATE INDEX ix_error_signatures_issue ON error_signatures (issue_id);
CREATE INDEX ix_error_signatures_last_seen ON error_signatures (last_seen_at DESC);

-- =====================================================================
-- Точные счётчики по часам
-- =====================================================================

-- Строка на комбинацию, а не на событие. Разбивка по релизу — то, чем
-- отвечают на «сломалось после деплоя»: две соседние строки одного часа с
-- разными релизами показывают переход, а суммарный счётчик его прячет.
--
-- `release` и `pipeline_stage` объявлены NOT NULL с явными заглушками, потому
-- что входят в первичный ключ, а NULL в ключе не сравнивается сам с собой:
-- каждая запись «релиз неизвестен» создавала бы новую строку вместо инкремента.
-- Заглушка выбрана читаемой ('unknown', 'none'), а не пустой строкой — она
-- попадает на экран как есть.
CREATE TABLE error_stats_hourly (
  issue_id       uuid NOT NULL REFERENCES error_issues (id) ON DELETE CASCADE,
  bucket_at      timestamptz NOT NULL,
  release        text NOT NULL DEFAULT 'unknown',
  source         text NOT NULL DEFAULT 'unknown',
  execution      text NOT NULL DEFAULT 'unknown',
  domain         text NOT NULL DEFAULT 'unknown',
  pipeline_stage text NOT NULL DEFAULT 'none',
  severity       text NOT NULL DEFAULT 'error',
  count          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (issue_id, bucket_at, release, source, execution, domain, pipeline_stage, severity),
  CONSTRAINT error_stats_hourly_count_chk CHECK (count >= 0)
  -- Ограничения «bucket_at — начало часа» здесь нет, хотя инвариант такой есть.
  -- Выразить его нечем: `date_trunc` и `extract` над timestamptz зависят от
  -- TimeZone сессии и потому STABLE, а CHECK принимает только IMMUTABLE. Врать
  -- о неизменяемости через обёртку ради ограничения, которое всё равно
  -- обеспечивает писатель, — худший размен: ограничение стало бы неверным при
  -- смене TimeZone, и повреждение проявилось бы не на записи, а на чтении ряда.
);

CREATE INDEX ix_error_stats_hourly_bucket ON error_stats_hourly (bucket_at DESC);
CREATE INDEX ix_error_stats_hourly_issue ON error_stats_hourly (issue_id, bucket_at DESC);

-- =====================================================================
-- Выборочные примеры
-- =====================================================================

CREATE TABLE error_samples (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id        uuid NOT NULL REFERENCES error_issues (id) ON DELETE CASCADE,
  -- Сигнатура без внешнего ключа: пример переживает смену версии алгоритма и
  -- удаление устаревшей сигнатуры, а строка «этот пример неизвестно к чему
  -- относится» бесполезна.
  fingerprint     text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'unknown',
  execution       text NOT NULL DEFAULT 'unknown',
  domain          text NOT NULL DEFAULT 'unknown',
  pipeline_stage  text,
  severity        text NOT NULL DEFAULT 'error',
  release         text,
  request_id      text,
  -- Идентификатор, выданный браузером и показанный пользователю. У ошибки
  -- отрисовки нет `request_id`: запроса не было. Без этой колонки обращение
  -- «у меня всё сломалось, вот номер» не с чем сопоставить.
  client_event_id text,
  -- Без внешнего ключа, как и остальные ссылки этой таблицы, но по второй
  -- причине вдобавок к переживанию сборки мусора: примеры пишутся ПАКЕТОМ уже
  -- после события, и одна строка с идентификатором пользователя, которого к
  -- моменту сброса не стало, отвергла бы весь пакет — то есть потеря одной
  -- записи превратилась бы в потерю всех накопленных за интервал.
  user_id         uuid,
  route           text,
  status_code     integer,
  -- SQLSTATE PostgreSQL или код системной ошибки Node.
  error_code      text,
  object_id       uuid,
  revision_id     uuid,
  job_id          uuid,
  job_type        text,
  attempt         integer,
  -- Сколько раз клиент наблюдал эту ошибку до отправки отчёта. Браузер
  -- дедуплицирует повторы в памяти вкладки, и без этого числа частота
  -- веб-ошибок была бы заведомо занижена.
  repeat_count    integer NOT NULL DEFAULT 1,
  -- Контекст, уже прошедший redactDeep. Значений полей и секретов здесь нет по
  -- построению: таблица живёт дольше, чем ротируемый журнал, и утечка в неё
  -- долговечнее.
  context         jsonb,
  CONSTRAINT error_samples_source_chk CHECK (source IN ('api', 'worker', 'web', 'unknown')),
  CONSTRAINT error_samples_execution_chk
    CHECK (execution IN ('http', 'job', 'process', 'client', 'unknown')),
  CONSTRAINT error_samples_domain_chk CHECK (domain IN (
    'db', 'llm', 'recognition', 'storage', 'auth', 'integration', 'application', 'unknown')),
  CONSTRAINT error_samples_severity_chk CHECK (severity IN ('warn', 'error', 'fatal')),
  CONSTRAINT error_samples_repeat_chk CHECK (repeat_count > 0),
  CONSTRAINT error_samples_attempt_chk CHECK (attempt IS NULL OR attempt > 0)
);

CREATE INDEX ix_error_samples_issue ON error_samples (issue_id, at DESC);
CREATE INDEX ix_error_samples_at ON error_samples (at DESC);
CREATE INDEX ix_error_samples_fingerprint ON error_samples (fingerprint, at DESC);
CREATE INDEX ix_error_samples_user ON error_samples (user_id, at DESC);
CREATE INDEX ix_error_samples_request ON error_samples (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX ix_error_samples_client_event ON error_samples (client_event_id)
  WHERE client_event_id IS NOT NULL;

-- =====================================================================
-- История работы с проблемой
-- =====================================================================

-- Неизменяемая лента действий. Одно поле `note` и мутируемый статус ответили
-- бы на «что сейчас» и потеряли бы «что уже пробовали»: именно прежние
-- решения — то немногое, что имеет ценность через год. Повторное появление
-- закрытой проблемы записывается действием `reopen` и НЕ стирает прежний
-- разбор.
CREATE TABLE error_issue_actions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id       uuid NOT NULL REFERENCES error_issues (id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  -- NULL — действие портала, а не человека: автоматическое переоткрытие при
  -- регрессии. Отличать его от действия администратора обязательно.
  actor_user_id  uuid REFERENCES users (id),
  action         text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT error_issue_actions_action_chk CHECK (
    action IN ('acknowledge', 'comment', 'resolve', 'reopen', 'assign'))
);

CREATE INDEX ix_error_issue_actions_issue ON error_issue_actions (issue_id, at DESC);
CREATE INDEX ix_error_issue_actions_actor ON error_issue_actions (actor_user_id);

-- =====================================================================
-- Перенос накопленного
-- =====================================================================

-- Каждая строка прежней таблицы получает проблему и сигнатуру. Источник —
-- 'unknown', а НЕ 'api': в `error_events` уже лежат ошибки воркера, и выдать
-- их за API значило бы испортить данные ровно в тот момент, когда ими
-- начинают пользоваться. Счётчик переносится в один бакет часа последнего
-- появления: разложить его по времени задним числом нечем, и притворяться,
-- что ряд известен, нельзя.
--
-- Идентификатор проблемы выдаётся ЗАРАНЕЕ, в `MATERIALIZED`-подзапросе, и
-- дальше используется всеми вставками. Сопоставление уже вставленных строк по
-- заголовку было бы дефектом: заголовок собран из класса и шаблона сообщения, а
-- два отпечатка различаются ещё и кадром стека — у одного класса с одним
-- шаблоном их бывает несколько, и join по заголовку размножил бы строки.
-- `MATERIALIZED` обязателен: без него планировщик вправе встроить подзапрос и
-- вычислить `gen_random_uuid()` заново в каждой ветке, выдав разным вставкам
-- разные идентификаторы одной проблемы.
--
-- Все вставки выполняются одним оператором: внешние ключи между ними
-- проверяются по его завершении, поэтому порядок ветвей значения не имеет.
WITH pairs AS MATERIALIZED (
  SELECT
    e.fingerprint,
    e.error_class,
    e.message_template,
    e.top_frame,
    e.count,
    e.first_seen_at,
    e.last_seen_at,
    e.acked_by,
    e.sample_request_id,
    e.sample_context,
    -- Прежняя схема не хранила автора закрытия, а `error_issues_resolved_chk`
    -- его требует. Понижение до 'ack' — единственное честное утверждение о
    -- такой записи: «взято в работу» верно, «закрыто таким-то» — нет.
    CASE WHEN e.status = 'resolved' THEN 'ack' ELSE e.status END AS status,
    gen_random_uuid() AS issue_id
  FROM error_events e
),
ins_issues AS (
  INSERT INTO error_issues (
    id, title, status, first_seen_at, last_seen_at, acked_by,
    source, execution, domain, severity
  )
  SELECT
    p.issue_id,
    left(p.error_class || ': ' || p.message_template, 300),
    p.status,
    p.first_seen_at,
    p.last_seen_at,
    p.acked_by,
    'unknown',
    'unknown',
    'unknown',
    'error'
  FROM pairs p
  RETURNING id
),
ins_signatures AS (
  INSERT INTO error_signatures (
    fingerprint, algo_version, issue_id, error_class, message_template, top_frame,
    source, first_seen_at, last_seen_at
  )
  SELECT
    p.fingerprint, 1, p.issue_id, p.error_class, p.message_template, p.top_frame,
    'unknown', p.first_seen_at, p.last_seen_at
  FROM pairs p
  RETURNING fingerprint
),
ins_stats AS (
  INSERT INTO error_stats_hourly (issue_id, bucket_at, count)
  SELECT p.issue_id, date_trunc('hour', p.last_seen_at), p.count
  FROM pairs p
  RETURNING issue_id
)
INSERT INTO error_samples (issue_id, fingerprint, at, request_id, context)
SELECT p.issue_id, p.fingerprint, p.last_seen_at, p.sample_request_id, p.sample_context
FROM pairs p;

-- Прежняя таблица переименовывается, а не удаляется: перенос сопоставляет
-- строки по заголовку, и если он где-то ошибся, исходные данные обязаны
-- остаться читаемыми. Удаление — отдельной миграцией, когда перенос проверен
-- на боевых данных.
ALTER TABLE error_events RENAME TO error_events_legacy;
ALTER INDEX ix_error_events_status RENAME TO ix_error_events_legacy_status;
ALTER INDEX ix_error_events_acked_by RENAME TO ix_error_events_legacy_acked_by;
