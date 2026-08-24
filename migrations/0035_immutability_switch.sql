-- Выключатель неизменяемости для этапа тестирования (S24, ADR-0015).
--
-- ## Что это и зачем
--
-- Миграция 0008 поставила 43 триггера поверх трёх функций: состав поданной
-- ревизии, замороженная разметка, артефакты прогонов и рабочий документ не
-- меняются и не удаляются ничем — ни API, ни воркером, ни рукой в psql. Это
-- инвариант §3.9, и на бою он обязан действовать.
--
-- На этапе тестирования продукта он мешает буквально: чтобы переиграть сценарий,
-- приходится заводить новый комплект, потому что удалить файл из уже поданной
-- ревизии — и даже из черновика с собранным рабочим документом — невозможно.
--
-- ## Почему выключатель, а не DROP TRIGGER
--
-- Снятые триггеры некому вернуть. Инвариант, удалённый «на время тестирования»,
-- не напомнит о себе перед боем ничем: схема будет выглядеть исправной, а
-- поданный комплект — переписываемым. Поэтому триггеры остаются на месте все до
-- одного, а решение принимает одна строка в `app_settings`, видимая на экране
-- «Администрирование» и попадающая в аудит при каждом переключении.
--
-- ## Почему тела функций скопированы целиком
--
-- Триггеры привязаны к функциям по OID, поэтому обёртку вокруг них подставить
-- нельзя — вызвана будет исходная. `CREATE OR REPLACE` с полным телом — это
-- единственный способ добавить ранний выход, не трогая ни одного из 43 триггеров
-- и не переписывая их WHEN-условия.
--
-- Тела ниже дословно повторяют 0008 плюс шесть строк охранника в начале каждого.
-- ЭТА миграция теперь авторитетна: правку логики неизменяемости вносить сюда
-- (или в следующую), а не в 0008 — там она уже применена и не перечитывается.
--
-- ## Значение по умолчанию — строгий режим
--
-- Строки в `app_settings` нет ни в одной существующей базе, и `coalesce`
-- отвечает `true`. Забытая настройка НЕ открывает прод: чтобы ослабить запреты,
-- надо явно записать `false`.

CREATE FUNCTION immutability_enforced() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  -- STABLE, а не VOLATILE: планировщик вычисляет функцию один раз на оператор, а
  -- не на строку. Иначе удаление комплекта из тысячи строк дало бы тысячу
  -- чтений `app_settings` — по одному на каждый вызов триггера.
  SELECT coalesce(
    (SELECT value = to_jsonb(true) FROM app_settings WHERE key = 'core.enforce_immutability'),
    true);
$fn$;

COMMENT ON FUNCTION immutability_enforced() IS
  'Действует ли §3.9. false — режим тестирования: триггеры неизменяемости пропускают запись.';

-- =====================================================================
-- Черновик не является доказательством
-- =====================================================================
--
-- Часть запретов 0008 объявлена БЕЗУСЛОВНОЙ: рабочий документ, артефакты
-- прогона, распознанный текст не удаляются никогда, а замороженная ревизия
-- разметки — независимо от того, чья она.
--
-- На поданной ревизии это верно: её состав покрыт `aggregate_manifest_hash`, и
-- всё выведенное из него доказывает, что именно проверяли. В ЧЕРНОВИКЕ доказывать
-- нечего — хэш состава не записан, наружу ничего не уходило, а рабочий документ
-- пересобирается нажатием кнопки.
--
-- Практическое следствие безусловности было такое: подрядчик не мог удалить
-- ошибочно загруженный файл из СВОЕГО ЖЕ черновика, если успел нажать
-- «Распознать» — та кнопка замораживает разметку сама. Отказ приходил пятисотым
-- кодом из драйвера, потому что прикладной слой такого случая не предполагал.
--
-- Поэтому запреты ниже пересозданы с условием «ревизия не черновик». Для всех
-- прочих статусов они действуют дословно как прежде.

CREATE FUNCTION revision_is_draft(rev uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  -- `false` при отсутствии строки — намеренно: сирота без ревизии не получает
  -- послаблений, положенных черновику.
  SELECT coalesce((SELECT status = 'draft' FROM submission_revisions WHERE id = rev), false);
$fn$;

/* Ревизия блока разметки: у точек полигона своей ссылки на ревизию нет. */
CREATE FUNCTION block_revision_is_draft(block uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(
    (SELECT sr.status = 'draft'
       FROM layout_blocks lb
       JOIN submission_revisions sr ON sr.id = lb.revision_id
      WHERE lb.id = block),
    false);
$fn$;

/* Ревизия прогона распознавания: у артефактов своей ссылки на неё нет. */
CREATE FUNCTION run_revision_is_draft(run uuid) RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(
    (SELECT sr.status = 'draft'
       FROM recognition_runs rr
       JOIN submission_revisions sr ON sr.id = rr.revision_id
      WHERE rr.id = run),
    false);
$fn$;

DROP TRIGGER processing_bundles_immutable_delete ON processing_bundles;
CREATE TRIGGER processing_bundles_immutable_delete
  BEFORE DELETE ON processing_bundles FOR EACH ROW
  WHEN (NOT revision_is_draft(OLD.revision_id))
  EXECUTE FUNCTION deny_modification('собранный рабочий документ', '');

DROP TRIGGER artifact_versions_immutable_delete ON artifact_versions;
CREATE TRIGGER artifact_versions_immutable_delete
  BEFORE DELETE ON artifact_versions FOR EACH ROW
  WHEN (NOT run_revision_is_draft(OLD.recognition_run_id))
  EXECUTE FUNCTION deny_modification('артефакт прогона распознавания', '');

DROP TRIGGER page_text_versions_immutable_delete ON page_text_versions;
CREATE TRIGGER page_text_versions_immutable_delete
  BEFORE DELETE ON page_text_versions FOR EACH ROW
  WHEN (NOT revision_is_draft(OLD.revision_id))
  EXECUTE FUNCTION deny_modification('распознанный текст страницы', '');

DROP TRIGGER layout_revisions_no_delete ON layout_revisions;
CREATE TRIGGER layout_revisions_no_delete
  BEFORE DELETE ON layout_revisions FOR EACH ROW
  WHEN (OLD.state <> 'draft' AND NOT revision_is_draft(OLD.revision_id))
  EXECUTE FUNCTION deny_modification('замороженную ревизию разметки', '');

CREATE OR REPLACE FUNCTION deny_modification() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  entity    text := TG_ARGV[0];
  mutable   text[] := CASE
                        WHEN TG_NARGS > 1 AND TG_ARGV[1] <> ''
                          THEN string_to_array(TG_ARGV[1], ',')
                        ELSE ARRAY[]::text[]
                      END;
  guard_sql text := CASE WHEN TG_NARGS > 2 THEN TG_ARGV[2] ELSE '' END;
  guard_col text := CASE WHEN TG_NARGS > 3 THEN TG_ARGV[3] ELSE '' END;
  is_locked boolean;
  probe     boolean;
  changed   text;
BEGIN
  -- Выключатель режима тестирования (S24). См. шапку миграции.
  IF NOT immutability_enforced() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  -- У UPDATE охранник опрашивается по обеим сторонам. Взгляд только на NEW
  -- позволял бы ВЫНЕСТИ строку из запертого набора (охранник смотрел бы уже на
  -- нового, незапертого родителя), взгляд только на OLD — ВТАЩИТЬ её в
  -- запертый. Достаточно запертости любой из сторон.
  IF guard_sql <> '' THEN
    is_locked := false;

    IF TG_OP <> 'INSERT' THEN
      EXECUTE guard_sql INTO probe USING to_jsonb(OLD) ->> guard_col;
      is_locked := COALESCE(probe, false);
    END IF;

    IF NOT is_locked AND TG_OP <> 'DELETE' THEN
      EXECUTE guard_sql INTO probe USING to_jsonb(NEW) ->> guard_col;
      is_locked := COALESCE(probe, false);
    END IF;

    IF NOT is_locked THEN
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Удалить % нельзя: запись неизменяема', entity
      USING ERRCODE = 'restrict_violation',
            HINT = 'Исправление вносится созданием новой версии, а не правкой существующей';
  END IF;

  -- Пополнение запертого набора запрещено так же, как правка: добавленная после
  -- публикации строка меняет результат прогона не меньше, чем изменённая.
  -- Отдельная ветка нужна и технически: сравнение столбцов ниже обратилось бы к
  -- несуществующему для INSERT OLD.
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Добавить % нельзя: родительская запись заперта', entity
      USING ERRCODE = 'restrict_violation',
            HINT = 'Дополнение вносится созданием новой версии, а не пополнением уже запертой';
  END IF;

  -- Сравниваются все столбцы, кроме разрешённых: перечислять запрещённые
  -- пришлось бы заново при каждом добавлении столбца, и новый столбец оказался
  -- бы изменяемым по умолчанию.
  SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO changed
  FROM jsonb_each(to_jsonb(NEW) - mutable) AS n(key, value)
  WHERE n.value IS DISTINCT FROM (to_jsonb(OLD) - mutable) -> n.key;

  IF changed IS NOT NULL THEN
    RAISE EXCEPTION 'Изменить % нельзя: неизменяемые поля (%)', entity, changed
      USING ERRCODE = 'restrict_violation',
            HINT = 'Исправление вносится созданием новой версии, а не правкой существующей';
  END IF;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION deny_frozen_layout_content() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  entity     text := TG_ARGV[0];
  ref_col    text := TG_ARGV[1];
  lookup_sql text := CASE
                       WHEN TG_NARGS > 2 AND TG_ARGV[2] <> '' THEN TG_ARGV[2]
                       ELSE 'SELECT state FROM layout_revisions WHERE id = $1::uuid'
                     END;
  -- superseded заперта не слабее frozen: по её blocks_hash уже прошёл прогон, и
  -- его артефакты обязаны воспроизводиться.
  locked  constant text[] := ARRAY['frozen', 'superseded'];
  verb    constant text := CASE TG_OP
                             WHEN 'INSERT' THEN 'Добавить'
                             WHEN 'UPDATE' THEN 'Изменить'
                             ELSE 'Удалить'
                           END;
  row_json  jsonb;
  ref_value text;
  state_now text;
BEGIN
  -- Выключатель режима тестирования (S24). См. шапку миграции.
  IF NOT immutability_enforced() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;

  -- Удаление содержимого замороженной разметки ЧЕРНОВОЙ ревизии разрешено (S24).
  -- Блок замороженной разметки — доказательство того, по чему шёл прогон, но
  -- только для ревизии, которую подали. Пока ревизия черновик, удаление её
  -- разметки — это отказ от собственной незаконченной работы, а не подмена
  -- проверенного. Правка (INSERT/UPDATE) при этом запрещена по-прежнему: там
  -- разошлись бы блоки и `blocks_hash`, по которому сверяется прогон.
  -- Ревизия ищется по той ссылке, которая у строки есть: у блока это
  -- `revision_id`, у точки полигона — `block_id`. Проверять только первую значило
  -- бы освободить блоки и оставить запертыми их точки, то есть не освободить
  -- ничего: точки удаляются раньше блоков.
  IF TG_OP = 'DELETE' THEN
    IF (row_json ? 'revision_id')
       AND revision_is_draft((row_json ->> 'revision_id')::uuid) THEN
      RETURN OLD;
    END IF;
    IF (row_json ? 'block_id')
       AND block_revision_is_draft((row_json ->> 'block_id')::uuid) THEN
      RETURN OLD;
    END IF;
  END IF;

  -- Столбец берётся по имени из аргумента, поэтому опечатка или переименование
  -- дали бы NULL и молча превратили триггер в заглушку. Отсутствие столбца —
  -- ошибка настройки, и она обязана падать, а не пропускать запись.
  IF NOT (row_json ? ref_col) THEN
    RAISE EXCEPTION 'Триггер % настроен на несуществующий столбец %.%',
      TG_NAME, TG_TABLE_NAME, ref_col;
  END IF;

  -- У UPDATE проверяются обе стороны: перенос блока из черновика в замороженную
  -- ревизию так же недопустим, как правка уже замороженного.
  IF TG_OP <> 'INSERT' THEN
    ref_value := to_jsonb(OLD) ->> ref_col;
    EXECUTE lookup_sql INTO state_now USING ref_value;
    IF state_now = ANY (locked) THEN
      RAISE EXCEPTION '% % нельзя: ревизия разметки в состоянии «%»', verb, entity, state_now
        USING ERRCODE = 'restrict_violation',
              HINT = 'Правка разметки выполняется созданием новой ревизии разметки, а не изменением замороженной';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    ref_value := to_jsonb(NEW) ->> ref_col;
    EXECUTE lookup_sql INTO state_now USING ref_value;
    IF state_now = ANY (locked) THEN
      RAISE EXCEPTION '% % нельзя: ревизия разметки в состоянии «%»', verb, entity, state_now
        USING ERRCODE = 'restrict_violation',
              HINT = 'Правка разметки выполняется созданием новой ревизии разметки, а не изменением замороженной';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION deny_locked_revision_content() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  entity     text := TG_ARGV[0];
  ref_col    text := TG_ARGV[1];
  lookup_sql text := CASE
                       WHEN TG_NARGS > 2 AND TG_ARGV[2] <> '' THEN TG_ARGV[2]
                       ELSE 'SELECT status FROM submission_revisions WHERE id = $1::uuid'
                     END;
  scope      text := CASE WHEN TG_NARGS > 3 THEN TG_ARGV[3] ELSE 'source' END;
  -- returned-ревизия закрыта навсегда: возврат создаёт новую draft
  -- с parent_revision_id, а не переоткрывает эту.
  terminal   constant text[] := ARRAY['returned', 'approved', 'superseded'];
  locked     text[] := CASE scope
                         WHEN 'derived' THEN terminal
                         ELSE terminal || ARRAY['submitted', 'in_review']
                       END;
  verb    constant text := CASE TG_OP
                             WHEN 'INSERT' THEN 'Добавить'
                             WHEN 'UPDATE' THEN 'Изменить'
                             ELSE 'Удалить'
                           END;
  row_json   jsonb;
  ref_value  text;
  status_now text;
BEGIN
  -- Выключатель режима тестирования (S24). См. шапку миграции.
  IF NOT immutability_enforced() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;

  -- См. то же в deny_frozen_layout_content(): молча отключившийся триггер
  -- неизменяемости хуже отсутствующего, потому что выглядит работающим.
  IF NOT (row_json ? ref_col) THEN
    RAISE EXCEPTION 'Триггер % настроен на несуществующий столбец %.%',
      TG_NAME, TG_TABLE_NAME, ref_col;
  END IF;

  -- У UPDATE проверяются обе стороны: перенос строки из черновика в поданную
  -- ревизию (например page_assignments.document_id на документ чужой ревизии)
  -- меняет состав запертой ревизии не меньше, чем правка её собственной строки.
  IF TG_OP <> 'INSERT' THEN
    ref_value := to_jsonb(OLD) ->> ref_col;
    EXECUTE lookup_sql INTO status_now USING ref_value;
    IF status_now = ANY (locked) THEN
      RAISE EXCEPTION '% % нельзя: ревизия поставки в статусе «%»', verb, entity, status_now
        USING ERRCODE = 'restrict_violation',
              HINT = 'Исправление вносится созданием НОВОЙ ревизии поставки, а не правкой поданной или согласованной';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    ref_value := to_jsonb(NEW) ->> ref_col;
    EXECUTE lookup_sql INTO status_now USING ref_value;
    IF status_now = ANY (locked) THEN
      RAISE EXCEPTION '% % нельзя: ревизия поставки в статусе «%»', verb, entity, status_now
        USING ERRCODE = 'restrict_violation',
              HINT = 'Исправление вносится созданием НОВОЙ ревизии поставки, а не правкой поданной или согласованной';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;
