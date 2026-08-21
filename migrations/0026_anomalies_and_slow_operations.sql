-- Значимые отказы 4xx и медленные операции (§11, ADR-0010, поток B).
--
-- Почему это агрегаты, а не строки журнала ошибок.
--   Отказ 401/403/429 не является инцидентом портала: это работающая защита.
--   Заводить на каждый такой ответ строку значило бы превратить журнал в
--   усилитель атаки — перебор паролей или сканер путей писал бы в базу с той же
--   частотой, с какой стучится. Интерес представляет не отдельный отказ, а
--   всплеск: «этот маршрут за час ответил 403 четыре тысячи раз». Ответ на
--   такой вопрос — счётчик по часам, и ничего кроме счётчика для него не нужно.
--
--   Медленные операции — то же самое с другой стороны: во время инцидента
--   медленно ВСЁ, и строка на запрос удвоила бы нагрузку ровно в тот момент,
--   когда система её не держит.
--
-- Почему счётчик, а не «топ медленных запросов с примерами».
--   Пример медленного запроса не объясняет ничего: тот же самый запрос в
--   спокойный час выполняется быстро. Объясняют распределение и время — сумма
--   и максимум по часу дают среднее и худший случай, а этого достаточно, чтобы
--   отличить «стало хуже у всех» от «есть один тяжёлый запрос».
--
-- Почему нет ссылки на пользователя.
--   У этих таблиц нет и не должно быть предмета мельче маршрута: это статистика
--   поведения системы, а не след действий человека. След действий ведёт
--   audit_log, и смешивать их значило бы завести второй, менее строгий журнал
--   действий — с ПДн и без правил хранения.

-- Отказы, за которыми имеет смысл следить. Остальные 4xx — опечатка клиента,
-- и их накопление не отвечает ни на один вопрос.
CREATE TABLE http_anomaly_stats_hourly (
  bucket_at    timestamptz NOT NULL,
  route        text NOT NULL,
  status_code  integer NOT NULL,
  -- Вид проблемы из RFC 9457 (`urn:id-portal:problem:<slug>`): по нему видно,
  -- отказ это по праву, по CSRF или по лимиту — при одном и том же статусе.
  problem_slug text NOT NULL DEFAULT 'unknown',
  count        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_at, route, status_code, problem_slug),
  CONSTRAINT http_anomaly_status_chk CHECK (status_code BETWEEN 400 AND 499),
  CONSTRAINT http_anomaly_count_chk CHECK (count >= 0)
);

CREATE INDEX ix_http_anomaly_bucket ON http_anomaly_stats_hourly (bucket_at DESC);
CREATE INDEX ix_http_anomaly_route ON http_anomaly_stats_hourly (route, bucket_at DESC);

-- Операции, превысившие порог. `target` — шаблон маршрута, нормализованный SQL
-- или имя внешнего вызова: значений параметров здесь нет и быть не может (§11).
CREATE TABLE slow_operations (
  kind              text NOT NULL,
  target            text NOT NULL,
  bucket_at         timestamptz NOT NULL,
  count             bigint NOT NULL DEFAULT 0,
  max_ms            integer NOT NULL DEFAULT 0,
  -- Сумма, а не среднее: среднее по часу нельзя сложить со средним другого
  -- часа, а сумму — можно, и произвольный период считается без потерь.
  sum_ms            bigint NOT NULL DEFAULT 0,
  -- Порог, действовавший в момент записи. Без него ряд, снятый до и после
  -- смены SLOW_QUERY_MS, выглядит как изменение поведения системы.
  threshold_ms      integer NOT NULL,
  sample_request_id text,
  PRIMARY KEY (kind, target, bucket_at),
  CONSTRAINT slow_operations_kind_chk CHECK (kind IN ('http', 'sql', 'external')),
  CONSTRAINT slow_operations_count_chk CHECK (count >= 0),
  CONSTRAINT slow_operations_max_chk CHECK (max_ms >= 0),
  CONSTRAINT slow_operations_sum_chk CHECK (sum_ms >= 0)
);

CREATE INDEX ix_slow_operations_bucket ON slow_operations (bucket_at DESC);
CREATE INDEX ix_slow_operations_kind ON slow_operations (kind, bucket_at DESC);
