-- Виды контрагентов, реквизиты шапки реестра и импорт справочников (§3.2, §14).
--
-- Три правки в одной миграции, потому что источник у них один — разбор реального
-- реестра исполнительной документации. Реестр называет два десятка организаций,
-- из которых подрядчиками и поставщиками не является почти никто: испытательные
-- лаборатории, органы по сертификации, метрологические службы, учебные центры,
-- заводы-изготовители, проектировщики, геодезисты. Каждая из них обязана попасть
-- в справочник до того, как её документ доедет до проверки.
--
-- Почему вид контрагента становится таблицей.
--   Заголовок миграции 0002 сформулировал правило прямо: множества, растущие
--   эксплуатацией, — это справочники с кодом-слагом, а не CHECK-перечисления.
--   К виду контрагента это правило применили не полностью: CHECK на четыре
--   значения оказался закрытым перечислением там, где множество открыто. Каждый
--   новый вид сегодня — миграция, то есть релиз портала ради строки справочника.
--
-- Вид на карточке — ОСНОВНОЙ вид деятельности организации, а не её роль в
-- конкретной работе. Одна и та же организация в разобранном реестре оказалась
-- одновременно генподрядчиком объекта, исполнителем одной из работ и автором
-- исполнительных схем. Роль записывается там, где используется, а не на
-- карточке: иначе карточку пришлось бы заводить под каждую роль заново.
--
-- Почему у объекта появляются кадастровый номер и идентификатор.
--   Оба печатаются в шапке реестра и в шапке АОСР. Без них портал не может ни
--   сверить шапку поданного документа с карточкой объекта, ни подставить их в
--   выгрузку, а вводить их каждый раз руками означает вводить их по-разному.
--
-- Почему импорт — две таблицы, а не разбор на лету.
--   Офисный файл не разбирается ни в браузере, ни в процессе публичного API:
--   уязвимость парсера там — это рабочая машина сотрудника и ключи портала
--   соответственно. Разбор идёт в воркере, а его результат обязан дождаться
--   подтверждения человеком: ничто из разобранного не попадает в рабочие
--   таблицы автоматически. Отсюда staging: `catalog_import_rows` — это то, что
--   администратор видит и утверждает, а не то, что уже создано.

-- =====================================================================
-- Виды контрагентов
-- =====================================================================

CREATE TABLE counterparty_kinds (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  CONSTRAINT counterparty_kinds_code_chk CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT counterparty_kinds_sort_order_chk CHECK (sort_order >= 0)
);

-- Стартовый состав: четыре вида из снятого CHECK плюс семь, наблюдённых в
-- реестре. Список пополняется эксплуатацией через API, а не следующей
-- миграцией — ради этого таблица и заведена.
INSERT INTO counterparty_kinds (code, name, sort_order) VALUES
  ('customer',           'Заказчик (застройщик)',       10),
  ('general_contractor', 'Генеральный подрядчик',       20),
  ('contractor',         'Подрядчик',                   30),
  ('supplier',           'Поставщик',                   40),
  ('manufacturer',       'Завод-изготовитель',          50),
  ('laboratory',         'Испытательная лаборатория',   60),
  ('certification_body', 'Орган по сертификации',       70),
  ('metrology',          'Метрологическая служба',      80),
  ('training_center',    'Учебный центр',               90),
  ('designer',           'Проектировщик',              100),
  ('surveyor',           'Геодезическая организация',  110)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE counterparties DROP CONSTRAINT counterparties_kind_chk;

ALTER TABLE counterparties
  ADD CONSTRAINT counterparties_kind_fkey
  FOREIGN KEY (kind) REFERENCES counterparty_kinds (code);

-- Индекс на столбец внешнего ключа: по нему же идёт фильтр `?kind=` в списке
-- контрагентов и подбор организаций подрядчика в администрировании.
CREATE INDEX ix_counterparties_kind ON counterparties (kind);

-- =====================================================================
-- Реквизиты объекта из шапки реестра
-- =====================================================================

-- Формат не проверяется CHECK'ом намеренно. Кадастровых номеров у объекта
-- бывает несколько (участок и ОКС записываются по-разному, а стройка нередко
-- занимает два участка), идентификатор разрешения на строительство формы не
-- имеет вовсе. Проверка здесь отвергала бы законный ввод, а сверка шапки
-- документа с карточкой — дело правил §9, а не ограничения таблицы.
ALTER TABLE construction_objects
  ADD COLUMN cadastral_number  text,
  ADD COLUMN permit_identifier text;

-- =====================================================================
-- Импорт справочников из файла
-- =====================================================================

CREATE TABLE catalog_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Какой справочник наполняется. Закрытое перечисление: это множество задаём
  -- мы сами — каждый вид требует своего разборщика и своей формы предпросмотра.
  target          text NOT NULL,
  status          text NOT NULL DEFAULT 'uploading',
  file_name       text NOT NULL,
  -- Ключ объекта в стейджинге хранилища. В `blobs/` файл импорта не переносится:
  -- это разовый ввод, а не содержимое ИД, и после применения он удаляется.
  s3_key          text NOT NULL UNIQUE,
  sha256          text,
  size_bytes      bigint,
  row_count       integer NOT NULL DEFAULT 0,
  error_count     integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  created_count   integer NOT NULL DEFAULT 0,
  failure_reason  text,
  created_by      uuid NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  parsed_at       timestamptz,
  applied_at      timestamptz,
  -- Срок, после которого брошенный импорт вместе с файлом убирает отложенная
  -- задача. Обработчика `storage.gc` в воркере нет, и уборка импорта не должна
  -- его дожидаться: файл со списком контрагентов лежит в хранилище до тех пор,
  -- пока кто-то не решит его судьбу, а «кто-то» может не вернуться никогда.
  expires_at      timestamptz NOT NULL,
  CONSTRAINT catalog_imports_target_chk
    CHECK (target IN ('counterparties', 'construction_objects')),
  CONSTRAINT catalog_imports_status_chk
    CHECK (status IN ('uploading', 'parsing', 'ready', 'applied', 'failed', 'expired')),
  CONSTRAINT catalog_imports_sha256_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT catalog_imports_size_chk CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT catalog_imports_counts_chk
    CHECK (row_count >= 0 AND error_count >= 0 AND duplicate_count >= 0
           AND created_count >= 0 AND created_count <= row_count)
);

-- Отбор задачей истечения: что уже пора убрать.
CREATE INDEX ix_catalog_imports_expiry ON catalog_imports (expires_at)
  WHERE status IN ('uploading', 'ready');
CREATE INDEX ix_catalog_imports_created_by ON catalog_imports (created_by, created_at DESC);

CREATE TABLE catalog_import_rows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         uuid NOT NULL REFERENCES catalog_imports (id) ON DELETE CASCADE,
  -- Номер строки В ФАЙЛЕ, вместе с заголовком: администратор ищет строку с
  -- ошибкой в своём Excel, а не в нумерации портала.
  row_no            integer NOT NULL,
  -- Прочитанные ячейки как есть, ключами — распознанные колонки. Хранится
  -- всегда, в том числе у отвергнутой строки: без исходного значения замечание
  -- «контрольная сумма не сходится» нечем проверить.
  raw               jsonb NOT NULL,
  -- Приведённое к телу POST. NULL у строки, разбор которой до приведения не
  -- дошёл.
  normalized        jsonb,
  verdict           text NOT NULL,
  problems          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Заполняется применением. Без внешнего ключа намеренно: строка предпросмотра
  -- обязана пережить последующее удаление созданной ею записи, иначе история
  -- импорта начнёт исчезать задним числом.
  created_entity_id uuid,
  CONSTRAINT catalog_import_rows_row_no_chk CHECK (row_no > 0),
  CONSTRAINT catalog_import_rows_verdict_chk
    CHECK (verdict IN ('create', 'duplicate', 'error')),
  CONSTRAINT catalog_import_rows_created_chk
    CHECK (created_entity_id IS NULL OR verdict = 'create'),
  CONSTRAINT catalog_import_rows_problems_chk CHECK (jsonb_typeof(problems) = 'array'),
  CONSTRAINT catalog_import_rows_row_uq UNIQUE (import_id, row_no)
);

-- Предпросмотр читается с фильтром по вердикту и по возрастанию строки.
CREATE INDEX ix_catalog_import_rows_verdict
  ON catalog_import_rows (import_id, verdict, row_no);
