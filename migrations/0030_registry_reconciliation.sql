-- Сверка описи передачи с комплектами папки (S20).
--
-- ## Что здесь заводится и зачем
--
-- Портал умеет принимать комплекты, собирать из них реестр и хранить
-- подписанный скан описи как комплект вида `registry`. Чего он не умеет —
-- прочитать этот скан и сравнить его с тем, что в портале загружено. Эти
-- таблицы хранят результат такого сравнения.
--
-- ## Опись — ЭТАЛОН, а не акт передачи
--
-- Посылка, на которой строились S19 и ADR-0011 («реестр — акт передачи, сверка
-- решает, выпускать ли папку»), снята заказчиком. Из портала документация
-- никуда не передаётся и юридически значимых подписей на ней не ставится: его
-- работа — проверить результат распознавания и подсветить расхождения. Опись
-- же независимо от портала знает, что должно быть в папке и под какими
-- номерами (`docs/CORPUS_FINDINGS.md`: «эталонен он по составу и номерам»).
--
-- Отсюда главное свойство этих таблиц: **сверка ничего не блокирует**. Ни один
-- код не добавляется в блокеры передачи, статусы реестра остаются
-- бухгалтерской отметкой, и `verdict = 'mismatch'` не мешает ни одному
-- действию портала.
--
-- ## Почему единица результата — КОМПЛЕКТ, а не папка
--
-- В одной папке комплекты разных субподрядчиков, и подрядчик имеет право знать
-- об ошибках в СВОИХ документах, но не о работах соседей. Поэтому результат по
-- каждому комплекту материализуется отдельной строкой
-- (`registry_reconciliation_works`) со своими счётчиками и вердиктом, а все
-- дочерние таблицы несут `work_id` и `contractor_id` денормализованно —
-- выдача по комплекту обязана быть фильтром по ключу, а не цепочкой join'ов
-- через группу. Разница не косметическая: условие внутри обработчика однажды
-- забывают, а индекс — нет.
--
-- Сводка по папке целиком (шапка описи, группы без комплекта, комплекты вне
-- описи, общие счётчики) принадлежит родительской строке и отдаётся только
-- тому, кто ведёт папку.
--
-- ## Почему у этих таблиц НЕТ триггера неизменяемости
--
-- Соблазн повесить охранник по статусу реестра («после issued заперто») велик,
-- и он неверен дважды.
--
-- Во-первых, повторный прогон переписывает результат целиком (`DELETE`+
-- `INSERT`), поэтому запертая родительская запись означала бы не «нельзя
-- править», а «задача `registry.reconcile` падает три раза и уходит в `dead`».
-- Тот же самый дефект даёт и `deny_locked_revision_content(..., 'derived')`:
-- ревизия файла описи проходит обычный workflow и может уйти в `approved`.
--
-- Во-вторых, запирать нечего. Снимок ТОГО, ЧТО ПЕРЕДАЛИ, хранит
-- `registry_items` (0028) — он и заперт. Сверка же — производный факт о
-- конкретном скане: после нового распознавания она обязана пересчитаться, и
-- запрет на пересчёт означал бы, что портал показывает результат разбора,
-- которого больше нет.
--
-- Единственное, что защищено, — авторская отметка «разобрано»: она живёт в
-- собственных столбцах и переживает пересчёт, потому что человек разбирал
-- расхождение, а не строку таблицы.

-- =====================================================================
-- 1. Ключ для составного внешнего ключа комплекта
-- =====================================================================

-- Частичный индекс `ux_works_registry_file` (0028) целью составного FK быть не
-- может: PostgreSQL требует полного уникального ограничения. Поэтому заводится
-- отдельное — оно же выражает «комплект принадлежит ровно одному реестру».
-- `registry_id` допускает NULL (комплект, ещё не включённый в папку), и это
-- уникальности не мешает: NULL в ней не сравнивается, а ссылающаяся строка
-- обязана назвать оба столбца непустыми.
ALTER TABLE works ADD CONSTRAINT works_registry_id_uq UNIQUE (registry_id, id);

-- =====================================================================
-- 2. Прогон сверки
-- =====================================================================

CREATE TABLE registry_reconciliations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id         uuid NOT NULL,
  registry_id       uuid NOT NULL,
  -- Комплект-файл описи и его ревизия: сверен КОНКРЕТНЫЙ скан, а не «реестр
  -- вообще». Заменили скан — это другая сверка, и старая остаётся фактом о
  -- прежнем скане.
  work_id           uuid NOT NULL,
  revision_id       uuid NOT NULL,

  -- `unparsed` — третье значение, без которого вердикт лжёт. При нечитаемом
  -- OCR разбор отдаёт ноль строк, все счётчики сходятся (0+0=0), и двузначный
  -- вердикт объявил бы «расхождений нет» там, где сверять было нечего.
  verdict           text NOT NULL,

  -- Оптимистичная блокировка для If-Match на отметке «разобрано».
  version           integer NOT NULL DEFAULT 0,

  -- Шапка описи против карточки реестра: самая дешёвая и самая сильная
  -- проверка. Без неё скан ЧУЖОЙ папки прошёл бы как `clean`, если состав
  -- случайно сошёлся.
  header_registry_no text,
  header_folder_no   text,
  header_mismatch    boolean NOT NULL DEFAULT false,

  -- Версии разбора и сопоставления: именно они объясняют, почему вчерашняя
  -- сверка расходится с сегодняшней на том же скане.
  parser_version    text NOT NULL,
  matcher_version   text NOT NULL,
  finished_at       timestamptz NOT NULL DEFAULT now(),

  -- Счётчики отдельными столбцами, а не jsonb: их читает экран и проверяет
  -- CHECK, а разбор jsonb в предикате проверкой быть не может.
  groups_total      integer NOT NULL DEFAULT 0,
  groups_matched    integer NOT NULL DEFAULT 0,
  groups_missing    integer NOT NULL DEFAULT 0,
  groups_ambiguous  integer NOT NULL DEFAULT 0,
  rows_total        integer NOT NULL DEFAULT 0,
  rows_matched      integer NOT NULL DEFAULT 0,
  rows_missing      integer NOT NULL DEFAULT 0,
  rows_ambiguous    integer NOT NULL DEFAULT 0,
  rows_field_mismatch integer NOT NULL DEFAULT 0,
  works_total       integer NOT NULL DEFAULT 0,
  works_extra       integer NOT NULL DEFAULT 0,
  extra_documents   integer NOT NULL DEFAULT 0,
  warnings          text[] NOT NULL DEFAULT '{}',

  -- Отметка «разобрано, не дефект». Переживает пересчёт: человек разбирал
  -- расхождение, а не строку таблицы.
  reviewed_by       uuid REFERENCES users (id),
  reviewed_at       timestamptz,
  reviewed_note     text,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT registry_reconciliations_verdict_chk
    CHECK (verdict IN ('unparsed', 'mismatch', 'clean')),
  CONSTRAINT registry_reconciliations_version_chk CHECK (version >= 0),
  CONSTRAINT registry_reconciliations_counts_chk CHECK (
    groups_total >= 0 AND rows_total >= 0 AND works_total >= 0
    AND groups_matched + groups_missing + groups_ambiguous = groups_total
    AND rows_matched + rows_missing + rows_ambiguous = rows_total
    AND works_extra BETWEEN 0 AND works_total
    AND rows_field_mismatch BETWEEN 0 AND rows_total
    AND extra_documents >= 0
  ),
  -- Пояснение обязательно и содержательно: отметка без объяснения — это
  -- «закрыл, чтобы не мозолило», а не разбор.
  -- `reviewed_note IS NOT NULL` выписан отдельно, а не подразумевается через
  -- `char_length(...) BETWEEN`: при NULL сравнение даёт NULL, дизъюнкция
  -- «ложь OR NULL» — тоже NULL, а CHECK считает NULL выполненным. Без явной
  -- проверки отметка без пояснения прошла бы, и ограничение выглядело бы
  -- работающим.
  CONSTRAINT registry_reconciliations_reviewed_chk CHECK (
    (reviewed_by IS NULL AND reviewed_at IS NULL AND reviewed_note IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL
        AND reviewed_note IS NOT NULL
        AND char_length(reviewed_note) BETWEEN 10 AND 1000)
  ),

  -- Одна сверка на один скан: повтор переписывает, а не копит.
  CONSTRAINT registry_reconciliations_scan_uq UNIQUE (registry_id, revision_id),
  -- Цель составного FK детей. Без неё дочерняя пара `(revision_id,
  -- reconciliation_id)` ссылаться не на что, и денормализованный `revision_id`
  -- в детях держался бы только кодом.
  CONSTRAINT registry_reconciliations_revision_uq UNIQUE (id, revision_id),

  -- Три составных ключа, и каждый закрывает свой способ соврать:
  -- реестр обязан лежать на названном объекте, комплект-файл — принадлежать
  -- названному реестру, ревизия — названному комплекту. Простой FK на
  -- `submission_revisions.id` пустил бы строку указать на ревизию чужого
  -- объекта, и третий уровень изоляции (§4.1) на этой таблице отсутствовал бы.
  CONSTRAINT registry_reconciliations_registry_fk
    FOREIGN KEY (object_id, registry_id) REFERENCES registries (object_id, id),
  CONSTRAINT registry_reconciliations_work_fk
    FOREIGN KEY (registry_id, work_id) REFERENCES works (registry_id, id),
  CONSTRAINT registry_reconciliations_revision_fk
    FOREIGN KEY (work_id, revision_id) REFERENCES submission_revisions (work_id, id)
);

CREATE INDEX ix_registry_reconciliations_registry ON registry_reconciliations (registry_id);
CREATE INDEX ix_registry_reconciliations_object ON registry_reconciliations (object_id);
CREATE INDEX ix_registry_reconciliations_reviewed_by ON registry_reconciliations (reviewed_by);

-- =====================================================================
-- 3. Результат по каждому комплекту папки
-- =====================================================================

-- Единица выдачи подрядчику и инженеру. Счётчики и вердикт считает воркер и
-- записывает сюда, а не вычисляет маршрут: пересчёт на лету означал бы
-- межревизионное чтение прямо в HTTP-обработчике, то есть обход §4.1.
CREATE TABLE registry_reconciliation_works (
  reconciliation_id uuid NOT NULL,
  revision_id       uuid NOT NULL,
  work_id           uuid NOT NULL REFERENCES works (id),
  -- Ревизия комплекта, с которой сверялись. Пусто у комплекта без поданной
  -- ревизии: он в папке есть, а сверять в нём нечего.
  matched_revision_id uuid REFERENCES submission_revisions (id),
  contractor_id     uuid NOT NULL REFERENCES counterparties (id),
  -- Наименование и исполнитель копируются, а не читаются по ссылке: сверка —
  -- факт о моменте прогона, и переименование работы его не переписывает.
  title             text NOT NULL,
  contractor_name   text,
  -- `extra` — комплект, которого опись не назвала ни одной группой. Для его
  -- подрядчика это главная новость, и она обязана лежать в его же строке.
  state             text NOT NULL,
  verdict           text NOT NULL,
  rows_total        integer NOT NULL DEFAULT 0,
  rows_matched      integer NOT NULL DEFAULT 0,
  rows_missing      integer NOT NULL DEFAULT 0,
  rows_ambiguous    integer NOT NULL DEFAULT 0,
  rows_field_mismatch integer NOT NULL DEFAULT 0,
  extra_documents   integer NOT NULL DEFAULT 0,

  PRIMARY KEY (reconciliation_id, work_id),
  CONSTRAINT registry_reconciliation_works_state_chk CHECK (state IN ('matched', 'extra')),
  CONSTRAINT registry_reconciliation_works_verdict_chk
    CHECK (verdict IN ('unparsed', 'mismatch', 'clean')),
  CONSTRAINT registry_reconciliation_works_counts_chk CHECK (
    rows_total >= 0 AND extra_documents >= 0
    AND rows_matched + rows_missing + rows_ambiguous = rows_total
    AND rows_field_mismatch BETWEEN 0 AND rows_total
  ),
  CONSTRAINT registry_reconciliation_works_parent_fk
    FOREIGN KEY (reconciliation_id, revision_id)
    REFERENCES registry_reconciliations (id, revision_id) ON DELETE CASCADE
);

CREATE INDEX ix_registry_reconciliation_works_revision
  ON registry_reconciliation_works (matched_revision_id);
CREATE INDEX ix_registry_reconciliation_works_contractor
  ON registry_reconciliation_works (contractor_id);

-- =====================================================================
-- 4. Группы описи
-- =====================================================================

CREATE TABLE registry_reconciliation_groups (
  reconciliation_id uuid NOT NULL,
  revision_id       uuid NOT NULL,
  -- Сквозной порядок группы в описи, от нуля, — единственный её ключ.
  -- Напечатанный номер (`group_no`) уникальным быть не обязан: в форме Б его
  -- нет вовсе, а в форме А подрядчик волен повторить или пропустить.
  ordinal           integer NOT NULL,
  group_no          text,
  title_raw         text NOT NULL,
  act_no_raw        text,
  act_no_norm       text,
  contractor_raw    text,
  matched_work_id   uuid REFERENCES works (id),
  matched_revision_id uuid REFERENCES submission_revisions (id),
  matched_contractor_id uuid REFERENCES counterparties (id),
  match_state       text NOT NULL,
  match_score       numeric(4, 3),
  reason            text NOT NULL,

  PRIMARY KEY (reconciliation_id, ordinal),
  CONSTRAINT registry_reconciliation_groups_ordinal_chk CHECK (ordinal >= 0),
  -- Значения `'extra'` здесь нет намеренно: комплект, не названный описью, не
  -- есть группа описи. Повторить мёртвое значение из
  -- `registry_rows_match_state_chk` (0005), которое не присваивает ни одна
  -- ветка кода, значило бы завести второй такой же.
  CONSTRAINT registry_reconciliation_groups_state_chk
    CHECK (match_state IN ('matched', 'missing', 'ambiguous')),
  CONSTRAINT registry_reconciliation_groups_score_chk
    CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 1)),
  -- Сопоставленная группа обязана назвать комплект, несопоставленная — не
  -- вправе: иначе экран показал бы «группа не нашла комплекта» и ссылку на
  -- комплект одновременно.
  CONSTRAINT registry_reconciliation_groups_matched_chk CHECK (
    (match_state = 'matched' AND matched_work_id IS NOT NULL)
    OR (match_state <> 'matched' AND matched_work_id IS NULL)
  ),
  CONSTRAINT registry_reconciliation_groups_parent_fk
    FOREIGN KEY (reconciliation_id, revision_id)
    REFERENCES registry_reconciliations (id, revision_id) ON DELETE CASCADE
);

CREATE INDEX ix_registry_reconciliation_groups_work
  ON registry_reconciliation_groups (matched_work_id);

-- =====================================================================
-- 5. Строки описи
-- =====================================================================

CREATE TABLE registry_reconciliation_rows (
  reconciliation_id uuid NOT NULL,
  revision_id       uuid NOT NULL,
  ordinal           integer NOT NULL,
  group_ordinal     integer NOT NULL,
  -- Копии из группы: строка отдаётся подрядчику фильтром по этим столбцам, а
  -- не join'ом через группу. Пусты у строк несопоставленной группы.
  work_id           uuid REFERENCES works (id),
  contractor_id     uuid REFERENCES counterparties (id),

  -- Напечатанный номер позиции ТЕКСТОМ: в форме Б он дробный («6.23»), а
  -- уникальным не бывает — урок миграции 0015, где `UNIQUE (document_id,
  -- row_no)` пришлось снять, потому что нумерация начинается заново в каждом
  -- разделе.
  row_no            text,
  doc_name_raw      text NOT NULL,
  doc_no_raw        text,
  doc_no_norm       text,
  doc_no_folded     text,
  org_raw           text,
  issued_at         date,
  valid_from        date,
  valid_to          date,
  sheets            integer,
  copies            integer,
  -- «Страница по списку» дословно: бывает диапазоном «46-47», и разбирать её в
  -- числа до замера незачем.
  pages_raw         text,

  matched_document_id uuid REFERENCES logical_documents (id),
  match_state       text NOT NULL,
  match_score       numeric(4, 3),
  -- Коды расхождений реквизитов у сопоставленной строки: `issued_at`,
  -- `organization`, `sheets`. Пустое значение с любой стороны расхождением НЕ
  -- считается — это «не извлечено», а не «не совпало» (§9.1, открытый мир).
  field_mismatches  text[] NOT NULL DEFAULT '{}',
  reason            text NOT NULL,

  PRIMARY KEY (reconciliation_id, ordinal),
  CONSTRAINT registry_reconciliation_rows_ordinal_chk CHECK (ordinal >= 0),
  CONSTRAINT registry_reconciliation_rows_group_chk CHECK (group_ordinal >= 0),
  CONSTRAINT registry_reconciliation_rows_state_chk
    CHECK (match_state IN ('matched', 'missing', 'ambiguous')),
  CONSTRAINT registry_reconciliation_rows_score_chk
    CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 1)),
  CONSTRAINT registry_reconciliation_rows_matched_chk CHECK (
    (match_state = 'matched' AND matched_document_id IS NOT NULL)
    OR (match_state <> 'matched' AND matched_document_id IS NULL)
  ),
  -- Расхождение реквизитов бывает только у сопоставленной строки: у
  -- несопоставленной сравнивать не с чем.
  CONSTRAINT registry_reconciliation_rows_fields_chk
    CHECK (match_state = 'matched' OR cardinality(field_mismatches) = 0),
  CONSTRAINT registry_reconciliation_rows_sheets_chk
    CHECK (sheets IS NULL OR sheets >= 0),
  CONSTRAINT registry_reconciliation_rows_copies_chk
    CHECK (copies IS NULL OR copies >= 0),
  CONSTRAINT registry_reconciliation_rows_group_fk
    FOREIGN KEY (reconciliation_id, group_ordinal)
    REFERENCES registry_reconciliation_groups (reconciliation_id, ordinal) ON DELETE CASCADE,
  CONSTRAINT registry_reconciliation_rows_parent_fk
    FOREIGN KEY (reconciliation_id, revision_id)
    REFERENCES registry_reconciliations (id, revision_id) ON DELETE CASCADE
);

CREATE INDEX ix_registry_reconciliation_rows_work
  ON registry_reconciliation_rows (reconciliation_id, work_id);
CREATE INDEX ix_registry_reconciliation_rows_document
  ON registry_reconciliation_rows (matched_document_id);

-- =====================================================================
-- 6. Документы, которых опись не назвала
-- =====================================================================

CREATE TABLE registry_reconciliation_extra_docs (
  reconciliation_id uuid NOT NULL,
  revision_id       uuid NOT NULL,
  document_id       uuid NOT NULL REFERENCES logical_documents (id),
  work_id           uuid NOT NULL REFERENCES works (id),
  doc_revision_id   uuid NOT NULL REFERENCES submission_revisions (id),
  contractor_id     uuid NOT NULL REFERENCES counterparties (id),
  -- Копии реквизитов документа: экран показывает их рядом со строками описи, а
  -- сверка — факт о моменте прогона.
  doc_no_raw        text,
  doc_name_raw      text,
  doc_type_code     text,

  PRIMARY KEY (reconciliation_id, document_id),
  CONSTRAINT registry_reconciliation_extra_docs_parent_fk
    FOREIGN KEY (reconciliation_id, revision_id)
    REFERENCES registry_reconciliations (id, revision_id) ON DELETE CASCADE
);

CREATE INDEX ix_registry_reconciliation_extra_docs_work
  ON registry_reconciliation_extra_docs (reconciliation_id, work_id);
CREATE INDEX ix_registry_reconciliation_extra_docs_revision
  ON registry_reconciliation_extra_docs (doc_revision_id);
CREATE INDEX ix_registry_reconciliation_extra_docs_contractor
  ON registry_reconciliation_extra_docs (contractor_id);
