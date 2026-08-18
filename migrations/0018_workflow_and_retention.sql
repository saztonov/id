-- Согласование, архив одобренной ревизии, retention и legal hold (§3.9, §4.2, §13).
--
-- Этап S10 добавляет три вещи, у каждой из которых своя причина жить в БД.
--
-- 1. **Нарезка логического документа** (задача 22). Столбцы результата ложатся
--    на `logical_documents`, потому что нарезка — свойство ровно одного
--    документа, а не отдельная сущность с собственной жизнью. Вместе с ними
--    заводятся два ограничения, выражающие §12 и §13 не комментарием, а
--    проверкой: нарезка существует только у подтверждённого документа, и любая
--    существующая нарезка помечена производной.
--
-- 2. **Архив одобренной ревизии** (задача 23). Отдельная таблица: архив
--    появляется ПОСЛЕ approve, то есть тогда, когда всё содержимое ревизии уже
--    заперто триггерами 0008. Складывать его в запертое поддерево значило бы
--    либо ослабить запрет, либо сделать задачу 23 неисполнимой.
--
-- 3. **Legal hold** (§4.2). Тоже отдельная таблица, и по той же причине:
--    удержание ставится и снимается когда угодно, в том числе на согласованную
--    ревизию, строка которой неизменяема целиком. Колонка на
--    `submission_revisions` была бы неустанавливаемой ровно там, где удержание
--    нужнее всего.
--
-- Retention НЕ хранится колонкой: срок считается от `decided_at` и текущей
-- политики (`RETENTION_DAYS`). Хранимая дата стала бы вторым источником правды
-- и молча разошлась бы с политикой при её изменении — тот же класс дефекта, что
-- закрыт вычисляемым `processing_status` (§3.8).

-- =====================================================================
-- 1. Нарезка логического документа (задача 22, §13)
-- =====================================================================

ALTER TABLE logical_documents
  ADD COLUMN derived_pdf_page_count integer,
  ADD COLUMN derived_pdf_bytes      bigint,
  ADD COLUMN derived_pdf_built_at   timestamptz,
  -- Каким инструментом нарезано: qpdf и pdf-lib дают разные байты, и «чем
  -- получен этот файл» — часть провенанса производной копии (ADR-0003).
  ADD COLUMN derived_pdf_toolkit    text,
  -- Удалось ли записать отметку о производности в МЕТАДАННЫЕ PDF. Флаг в БД
  -- остаётся источником правды (метаданные перепишет любой редактор), но
  -- «отметки нет» и «не проверяли» обязаны различаться.
  ADD COLUMN derived_note_applied   boolean;

-- §13: «любая нарезка помечается is_derived_copy=true». Инвариант держит БД, а
-- не аккуратность задачи: производная копия внешне неотличима от оригинала, и
-- встроенная подпись оригинала к ней не относится.
ALTER TABLE logical_documents
  ADD CONSTRAINT logical_documents_derived_marked_chk
    CHECK (derived_pdf_blob_sha256 IS NULL OR is_derived_copy);

-- §12: нарезка идёт ПОСЛЕ подтверждения границ. Обратное следствие тоже
-- намеренное: снятие подтверждения обязано сопровождаться очисткой нарезки,
-- потому что границы изменились и прежний файл описывает не тот документ.
ALTER TABLE logical_documents
  ADD CONSTRAINT logical_documents_derived_confirmed_chk
    CHECK (derived_pdf_blob_sha256 IS NULL OR is_confirmed);

-- Провенанс нарезки полон или отсутствует целиком: половина значений означала
-- бы файл, о происхождении которого нечего сказать.
ALTER TABLE logical_documents
  ADD CONSTRAINT logical_documents_derived_provenance_chk
    CHECK (
      (derived_pdf_blob_sha256 IS NULL
        AND derived_pdf_page_count IS NULL
        AND derived_pdf_bytes IS NULL
        AND derived_pdf_built_at IS NULL
        AND derived_pdf_toolkit IS NULL
        AND derived_note_applied IS NULL)
      OR (derived_pdf_blob_sha256 IS NOT NULL
        AND derived_pdf_page_count IS NOT NULL
        AND derived_pdf_bytes IS NOT NULL
        AND derived_pdf_built_at IS NOT NULL
        AND derived_pdf_toolkit IS NOT NULL
        AND derived_note_applied IS NOT NULL)
    );

ALTER TABLE logical_documents
  ADD CONSTRAINT logical_documents_derived_sizes_chk
    CHECK (
      (derived_pdf_page_count IS NULL OR derived_pdf_page_count > 0)
      AND (derived_pdf_bytes IS NULL OR derived_pdf_bytes > 0)
    );

-- =====================================================================
-- 2. Архив одобренной ревизии (задача 23, §13)
-- =====================================================================

CREATE TABLE submission_archives (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Один архив на ревизию: второй означал бы два разных ответа на вопрос «что
  -- именно согласовали», а не новую версию.
  revision_id     uuid NOT NULL UNIQUE REFERENCES submission_revisions (id),
  object_id       uuid NOT NULL,
  contractor_id   uuid NOT NULL,
  s3_key          text NOT NULL UNIQUE,
  archive_sha256  text NOT NULL,
  byte_size       bigint NOT NULL,
  entry_count     integer NOT NULL,
  -- Версия сборщика: смена состава архива обязана быть видна, иначе два разных
  -- набора файлов лежат под одним обещанием.
  builder_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT submission_archives_sha_chk CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT submission_archives_size_chk CHECK (byte_size > 0),
  CONSTRAINT submission_archives_entries_chk CHECK (entry_count > 0),
  CONSTRAINT submission_archives_scope_fk
    FOREIGN KEY (revision_id, object_id, contractor_id)
    REFERENCES submission_revisions (id, object_id, contractor_id)
);

CREATE INDEX ix_submission_archives_object ON submission_archives (object_id);
CREATE INDEX ix_submission_archives_contractor ON submission_archives (contractor_id);

-- Архив собирается только у СОГЛАСОВАННОЙ ревизии.
--
-- Это не дублирование проверки приложения, а другой её уровень: «архив
-- одобренной ревизии» (§13) — утверждение о содержимом файла, и если строка
-- может появиться у ревизии в любом другом статусе, то имя `rev{N}-approved`
-- перестаёт что-либо значить. Проверка идёт по фактическому статусу родителя, а
-- не по тому, что задачу поставил обработчик approve.
CREATE FUNCTION require_approved_revision() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  status_now text;
BEGIN
  SELECT status INTO status_now FROM submission_revisions WHERE id = NEW.revision_id;
  IF status_now IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Архив собирается только у согласованной ревизии, а её статус «%»',
      COALESCE(status_now, 'ревизия не найдена')
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'submission_archives_approved_only',
            HINT = 'Сначала согласование, затем сборка архива';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER submission_archives_approved_only
  BEFORE INSERT ON submission_archives FOR EACH ROW
  EXECUTE FUNCTION require_approved_revision();

-- Архив неизменяем так же, как артефакты прогона распознавания (0008, п. 3):
-- на его sha256 ссылается выдача, а пересборка под тем же ключом означала бы
-- другой файл под прежним обещанием.
CREATE TRIGGER submission_archives_immutable_update
  BEFORE UPDATE ON submission_archives FOR EACH ROW
  EXECUTE FUNCTION deny_modification('архив согласованной ревизии', '');

CREATE TRIGGER submission_archives_immutable_delete
  BEFORE DELETE ON submission_archives FOR EACH ROW
  EXECUTE FUNCTION deny_modification('архив согласованной ревизии', '');

-- =====================================================================
-- 3. Legal hold (§4.2)
-- =====================================================================

CREATE TABLE legal_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id  uuid NOT NULL REFERENCES submission_revisions (id),
  object_id    uuid NOT NULL,
  reason       text NOT NULL,
  placed_by    uuid NOT NULL REFERENCES users (id),
  placed_at    timestamptz NOT NULL DEFAULT now(),
  released_by  uuid REFERENCES users (id),
  released_at  timestamptz,
  release_note text,
  CONSTRAINT legal_holds_reason_chk CHECK (length(btrim(reason)) >= 10),
  -- Снятие удержания — это автор и время вместе; одно без другого делает
  -- «кто снял» неотвечаемым.
  CONSTRAINT legal_holds_release_chk
    CHECK ((released_by IS NULL) = (released_at IS NULL)),
  CONSTRAINT legal_holds_object_fk
    FOREIGN KEY (revision_id, object_id) REFERENCES submission_revisions (id, object_id)
);

-- Одновременно у ревизии не больше одного ДЕЙСТВУЮЩЕГО удержания: снятые
-- остаются историей, и повторное удержание — это новая строка, а не правка
-- старой.
CREATE UNIQUE INDEX ux_legal_holds_active
  ON legal_holds (revision_id)
  WHERE released_at IS NULL;

CREATE INDEX ix_legal_holds_object ON legal_holds (object_id);
CREATE INDEX ix_legal_holds_placed_by ON legal_holds (placed_by);

-- История удержаний не переписывается и не удаляется: изменяемо ровно снятие.
-- Запрет узкий намеренно (урок S2): запертая целиком строка сделала бы снятие
-- удержания невозможным, то есть данные не удалялись бы никогда.
CREATE TRIGGER legal_holds_release_only
  BEFORE UPDATE ON legal_holds FOR EACH ROW
  EXECUTE FUNCTION deny_modification(
    'наложенное удержание', 'released_by,released_at,release_note');

CREATE TRIGGER legal_holds_no_delete
  BEFORE DELETE ON legal_holds FOR EACH ROW
  EXECUTE FUNCTION deny_modification('удержание', '');

-- Повторное снятие уже снятого удержания запрещено отдельно: без этого запись
-- «кто снял» переписывалась бы, потому что сами колонки снятия изменяемы.
CREATE FUNCTION deny_released_hold_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'Удержание уже снято: изменить снятое удержание нельзя'
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'legal_holds_released_lock',
            HINT = 'Новое удержание накладывается новой записью';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER legal_holds_released_lock
  BEFORE UPDATE ON legal_holds FOR EACH ROW
  EXECUTE FUNCTION deny_released_hold_change();
