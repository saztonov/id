-- Неизменяемость на уровне БД (§3.9).
--
-- Инвариант обязана держать БД, а не только код: любой писатель — API, воркер,
-- миграция данных, рука в psql — обязан получить отказ. Функция здесь одна и
-- параметризованная; различия таблиц выражены аргументами и WHEN-условиями
-- триггеров, а не копиями тела.
--
-- Аргументы deny_modification():
--   [0] название сущности для сообщения (на русском, в винительном падеже);
--   [1] список столбцов через запятую, которые всё-таки могут меняться
--       («слив» состояния: frozen -> superseded, published -> archived);
--   [2] необязательный запрос-охранник: строка заперта, если он вернул true.
--       Нужен там, где запертость определяется родителем (снимок правил заперт
--       публикацией своей версии ruleset), а WHEN-условие триггера подзапросов
--       не допускает. У UPDATE опрашиваются ОБЕ стороны (прежняя и новая), у
--       DELETE — прежняя, у INSERT — новая;
--   [3] столбец этой строки, значение которого подставляется в $1 охранника.
--       Сам этот столбец менять нельзя: строка, переписавшая ссылку на
--       родителя, покидает запертый набор целиком, а не меняется в нём. Запрет
--       ставится отдельным триггером (см. ruleset_rules_no_reparent).
--
-- Штатный способ исправить неизменяемую запись — создать новую версию. Полное
-- удаление (retention, legal hold снят) выполняется владельцем БД отдельной
-- процедурой с временно отключёнными триггерами, а не runtime-ролью портала:
-- сборка мусора по §4.2 и так работает под отдельной ограниченной ролью.

CREATE FUNCTION deny_modification() RETURNS trigger
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

-- 1. Ревизия поставки после submit.
--
-- Заперто содержимое, а не строка целиком: статус обязан двигаться дальше
-- (submitted -> in_review -> returned | approved), и решение записывается в
-- decided_*. Перечисление «всё, кроме draft» шире буквального «submitted», но
-- in_review и returned — тоже пост-submit состояния, и содержимое в них так же
-- неизменяемо.
CREATE TRIGGER submission_revisions_content_immutable
  BEFORE UPDATE ON submission_revisions FOR EACH ROW
  WHEN (OLD.status <> 'draft' AND OLD.status NOT IN ('approved', 'superseded'))
  EXECUTE FUNCTION deny_modification(
    'поданную ревизию поставки',
    'status,version,updated_at,decided_at,decided_by,return_reason');

-- После решения заперта и служебная часть: согласованная или закрытая возвратом
-- ревизия не меняется ничем.
CREATE TRIGGER submission_revisions_decided_immutable
  BEFORE UPDATE ON submission_revisions FOR EACH ROW
  WHEN (OLD.status IN ('approved', 'superseded'))
  EXECUTE FUNCTION deny_modification('согласованную ревизию поставки', '');

-- Возврат в draft запрещён отдельно: сам столбец status изменяемый (иначе
-- workflow встал бы), поэтому без этого триггера поданную ревизию можно было бы
-- «переоткрыть» и править дальше. Возврат подрядчику создаёт НОВУЮ draft-ревизию
-- с parent_revision_id, а не оживляет старую.
CREATE TRIGGER submission_revisions_no_reopen
  BEFORE UPDATE ON submission_revisions FOR EACH ROW
  WHEN (OLD.status <> 'draft' AND NEW.status = 'draft')
  EXECUTE FUNCTION deny_modification('поданную ревизию поставки', '');

CREATE TRIGGER submission_revisions_no_delete
  BEFORE DELETE ON submission_revisions FOR EACH ROW
  WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION deny_modification('поданную ревизию поставки', '');

-- 2. Замороженная ревизия разметки.
--
-- Разрешён единственный переход frozen -> superseded: любое изменение разметки
-- создаёт новую frozen-ревизию и новый RD-документ, а прежняя помечается
-- вытесненной. blocks_hash при этом остаётся тем, по которому сверялся OCR.
CREATE TRIGGER layout_revisions_frozen_immutable
  BEFORE UPDATE ON layout_revisions FOR EACH ROW
  WHEN (OLD.state = 'frozen' AND NEW.state <> 'superseded')
  EXECUTE FUNCTION deny_modification('замороженную ревизию разметки', '');

CREATE TRIGGER layout_revisions_supersede_only
  BEFORE UPDATE ON layout_revisions FOR EACH ROW
  WHEN (OLD.state = 'frozen' AND NEW.state = 'superseded')
  EXECUTE FUNCTION deny_modification(
    'замороженную ревизию разметки', 'state,version,updated_at');

CREATE TRIGGER layout_revisions_superseded_immutable
  BEFORE UPDATE ON layout_revisions FOR EACH ROW
  WHEN (OLD.state = 'superseded')
  EXECUTE FUNCTION deny_modification('вытесненную ревизию разметки', '');

CREATE TRIGGER layout_revisions_no_delete
  BEFORE DELETE ON layout_revisions FOR EACH ROW
  WHEN (OLD.state <> 'draft')
  EXECUTE FUNCTION deny_modification('замороженную ревизию разметки', '');

-- 2a. Содержимое замороженной ревизии разметки.
--
-- Запертой строки layout_revisions недостаточно: blocks_hash считается по НАБОРУ
-- блоков, и он остаётся прежним, что бы с блоками ни сделали. Правка, удаление
-- или добавление блока после заморозки делают пин ложным — цикл сверки §5.2
-- сравнит локальный хэш с удалённым, увидит совпадение и запустит OCR по
-- разметке, которой в БД уже нет. Поэтому блоки и точки полигонов запираются
-- вместе с ревизией, а не полагаются на неизменяемость её строки.
--
-- Аргументы deny_frozen_layout_content():
--   [0] сущность для сообщения (в винительном падеже);
--   [1] столбец этой строки, по которому находится ревизия разметки;
--   [2] необязательный запрос, возвращающий state ревизии по $1 (значение
--       столбца из [1]). По умолчанию — прямая ссылка на layout_revisions.id.
CREATE FUNCTION deny_frozen_layout_content() RETURNS trigger
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
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
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

-- Каскадное удаление блоков вместе с ревизией остаётся возможным только для
-- draft: к моменту срабатывания каскада родительская строка уже удалена, поиск
-- возвращает NULL, и запрет не применяется. Замороженную ревизию удалить нельзя
-- отдельным триггером выше, поэтому обхода через родителя нет.
CREATE TRIGGER layout_blocks_frozen_content_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON layout_blocks FOR EACH ROW
  EXECUTE FUNCTION deny_frozen_layout_content('блок разметки', 'layout_revision_id');

CREATE TRIGGER layout_block_points_frozen_content_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON layout_block_points FOR EACH ROW
  EXECUTE FUNCTION deny_frozen_layout_content(
    'точку полигона блока', 'block_id',
    'SELECT lr.state FROM layout_blocks b
       JOIN layout_revisions lr ON lr.id = b.layout_revision_id
      WHERE b.id = $1::uuid');

-- 3. Артефакты прогона распознавания и текст страниц — неизменяемы полностью.
-- На их sha256 и смещения ссылаются доказательства замечаний; правка сдвинула
-- бы все цитаты и обесценила проверку artifact hash.
CREATE TRIGGER artifact_versions_immutable_update
  BEFORE UPDATE ON artifact_versions FOR EACH ROW
  EXECUTE FUNCTION deny_modification('артефакт прогона распознавания', '');

CREATE TRIGGER artifact_versions_immutable_delete
  BEFORE DELETE ON artifact_versions FOR EACH ROW
  EXECUTE FUNCTION deny_modification('артефакт прогона распознавания', '');

CREATE TRIGGER page_text_versions_immutable_update
  BEFORE UPDATE ON page_text_versions FOR EACH ROW
  EXECUTE FUNCTION deny_modification('распознанный текст страницы', '');

CREATE TRIGGER page_text_versions_immutable_delete
  BEFORE DELETE ON page_text_versions FOR EACH ROW
  EXECUTE FUNCTION deny_modification('распознанный текст страницы', '');

-- 4. Рабочий документ ревизии — неизменяем полностью: именно он уезжал в RD WEB,
-- и его карта страниц отображает результаты обратно на исходные файлы.
CREATE TRIGGER processing_bundles_immutable_update
  BEFORE UPDATE ON processing_bundles FOR EACH ROW
  EXECUTE FUNCTION deny_modification('собранный рабочий документ', '');

CREATE TRIGGER processing_bundles_immutable_delete
  BEFORE DELETE ON processing_bundles FOR EACH ROW
  EXECUTE FUNCTION deny_modification('собранный рабочий документ', '');

-- 5. Опубликованный промт. Разрешён единственный переход published -> archived:
-- rollback публикует другую версию, а текст опубликованной остаётся тем, по
-- которому считался кэш ответов LLM.
CREATE TRIGGER prompt_templates_published_immutable
  BEFORE UPDATE ON prompt_templates FOR EACH ROW
  WHEN (OLD.state = 'published' AND NEW.state <> 'archived')
  EXECUTE FUNCTION deny_modification('опубликованный промт', '');

CREATE TRIGGER prompt_templates_archive_only
  BEFORE UPDATE ON prompt_templates FOR EACH ROW
  WHEN (OLD.state = 'published' AND NEW.state = 'archived')
  EXECUTE FUNCTION deny_modification('опубликованный промт', 'state,updated_at');

CREATE TRIGGER prompt_templates_no_delete
  BEFORE DELETE ON prompt_templates FOR EACH ROW
  WHEN (OLD.state = 'published')
  EXECUTE FUNCTION deny_modification('опубликованный промт', '');

-- 6. Опубликованная версия ruleset и её снимок правил: прогон месячной давности
-- обязан воспроизводиться точно. До публикации набор правил редактируется
-- свободно, поэтому запертость строки снимка определяется родителем.
--
-- Отсюда порядок сборки набора: сначала создаётся неопубликованная версия, в неё
-- набирается снимок, и только потом ставится published_at. Вставить строки
-- снимка в уже опубликованную версию нельзя — это и есть инвариант.
CREATE TRIGGER ruleset_versions_published_immutable_update
  BEFORE UPDATE ON ruleset_versions FOR EACH ROW
  WHEN (OLD.published_at IS NOT NULL)
  EXECUTE FUNCTION deny_modification('опубликованную версию набора правил', '');

CREATE TRIGGER ruleset_versions_published_immutable_delete
  BEFORE DELETE ON ruleset_versions FOR EACH ROW
  WHEN (OLD.published_at IS NOT NULL)
  EXECUTE FUNCTION deny_modification('опубликованную версию набора правил', '');

-- «Распубликование» запрещено отдельно и явно. published_at и так входит в
-- сравниваемые столбцы триггера выше, но именно этот переход снимает запрет
-- со всего снимка сразу: расперев версию, её правила можно переписать и
-- опубликовать заново под тем же номером. Запрет обязан пережить и появление в
-- списке изменяемых столбцов чего-нибудь ещё (rollback: published -> archived).
CREATE TRIGGER ruleset_versions_no_unpublish
  BEFORE UPDATE ON ruleset_versions FOR EACH ROW
  WHEN (OLD.published_at IS NOT NULL AND NEW.published_at IS NULL)
  EXECUTE FUNCTION deny_modification('опубликованную версию набора правил', '');

-- Снимок правил: один триггер на все три операции, потому что и запрет, и
-- охранник у них общие. INSERT нужен не меньше UPDATE: правило, добавленное в
-- набор после публикации, меняет результат прогона так же, как изменённое.
--
-- Каскадное удаление снимка вместе с неопубликованной версией продолжает
-- работать: к моменту срабатывания каскада родительская строка уже удалена,
-- охранник не находит её и запертости не видит. Опубликованную версию удалить
-- нельзя триггером выше, поэтому обхода через родителя нет.
CREATE TRIGGER ruleset_rules_published_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON ruleset_rules FOR EACH ROW
  EXECUTE FUNCTION deny_modification(
    'правило опубликованного набора', '',
    'SELECT published_at IS NOT NULL FROM ruleset_versions WHERE id = $1::uuid',
    'ruleset_version_id');

-- Смена версии у существующей строки снимка запрещена как класс операции, в том
-- числе между двумя неопубликованными версиями: строка снимка принадлежит своей
-- версии, а «переезд» — это удаление в одной и вставка в другой. Именно этим
-- UPDATE снимок опубликованного набора выносился из-под охранника, и без
-- отдельного запрета корректность зависела бы от того, какую сторону UPDATE
-- охранник смотрит. Имя триггера сортируется раньше published_immutable,
-- поэтому сообщение об истинной причине выдаётся первым.
CREATE TRIGGER ruleset_rules_no_reparent
  BEFORE UPDATE ON ruleset_rules FOR EACH ROW
  WHEN (NEW.ruleset_version_id IS DISTINCT FROM OLD.ruleset_version_id)
  EXECUTE FUNCTION deny_modification('привязку правила к версии набора', '');

-- 7. Содержимое поданной и согласованной ревизии поставки.
--
-- Триггеры пункта 1 запирают столбцы ОДНОЙ строки submission_revisions, а
-- ревизия — это не строка, это дерево. Порядок файлов и состав страниц входят в
-- aggregate_manifest_hash; без запрета ниже после approve можно переписать
-- sort_order файлов, удалить страницы, переназначить страницу другому документу —
-- и хэш вместе с решением останутся прежними, то есть будут описывать состав,
-- которого больше нет. Поэтому заперты все дочерние таблицы ревизии.
--
-- Правка ЧЕРНОВИКА обязана проходить: до submit конвейер §12 пишет во все эти
-- таблицы, и триггер, запрещающий всё подряд, остановил бы систему целиком.
-- Проверка идёт по фактическому состоянию родителя, а не по факту существования
-- триггера.
--
-- Аргументы deny_locked_revision_content():
--   [0] сущность для сообщения (в винительном падеже);
--   [1] столбец этой строки, по которому находится ревизия поставки. У части
--       таблиц это прямой revision_id, у остальных — ссылка на строку-владельца
--       (block_id у точек полигона, material_id у партий);
--   [2] необязательный запрос, возвращающий workflow-статус ревизии по $1
--       (значение столбца из [1]). По умолчанию — прямая ссылка на
--       submission_revisions.id. §3 называет это поле workflow-статусом,
--       в схеме столбец называется status.
--   [3] класс содержимого: 'source' либо 'derived'. См. ниже.
--
-- ## Два класса содержимого, и почему запрет у них разный
--
-- Первая версия этого триггера запирала всё, кроме draft, — и делала продукт
-- неработоспособным. Ревизия попадает в in_review ИМЕННО для работы инженера:
-- по §4.1 он подтверждает тип и границы документа, правит реквизиты, снимает
-- замечания. Запрет на in_review оставлял ему единственное действие — вернуть
-- всю ревизию подрядчику. Триггер при этом выглядел рабочим: правильные
-- сообщения, верный ERRCODE.
--
-- Поэтому содержимое разделено:
--
-- 'source' — то, что подал подрядчик и что покрыто aggregate_manifest_hash:
--   исходные файлы, их страницы, рабочий документ и его карта страниц. Заперто
--   с момента submit: после подачи состав и порядок изменить нельзя, иначе хэш
--   описывает состав, которого больше нет.
--
-- 'derived' — то, что произвели конвейер и проверяющий: разметка, логические
--   документы, учёт страниц, реквизиты, реестр, материалы. Заперто только в
--   ТЕРМИНАЛЬНЫХ состояниях (returned, approved, superseded). В submitted и
--   in_review остаётся изменяемым, потому что это и есть предмет проверки.
--
-- ## Что этот триггер сознательно НЕ гарантирует
--
-- Он не различает, КТО меняет данные: подрядчик после submit прав на правку
-- не имеет, но в БД нет контекста актора (он появится с сессиями на S3).
-- Разграничение по роли — уровень приложения из §4.1: permission на роуте,
-- затем репозиторий со scope. БД держит то, что абсолютно инвариантно
-- независимо от актора: терминальное состояние неизменяемо, поданный состав
-- неизменяем. Попытка выразить в БД ещё и права роли даёт ровно тот дефект,
-- который здесь исправлен.
CREATE FUNCTION deny_locked_revision_content() RETURNS trigger
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

-- 7.1. Таблицы с прямой ссылкой на ревизию. Ссылка годится как источник истины
-- именно потому, что у денормализованных revision_id есть составной FK на
-- строку-владельца (0003–0005): разойтись с настоящей ревизией они не могут.
CREATE TRIGGER source_files_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON source_files FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('исходный файл', 'revision_id', '', 'source');

CREATE TRIGGER source_pages_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON source_pages FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('страницу исходного файла', 'revision_id', '', 'source');

-- У processing_bundles UPDATE и DELETE запрещены безусловно (пункт 4); этот
-- триггер добавляет запрет на INSERT в уже поданную ревизию.
CREATE TRIGGER processing_bundles_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON processing_bundles FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('рабочий документ', 'revision_id', '', 'source');

CREATE TRIGGER processing_bundle_pages_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON processing_bundle_pages FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('страницу рабочего документа', 'revision_id', '', 'source');

CREATE TRIGGER layout_revisions_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON layout_revisions FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('ревизию разметки', 'revision_id', '', 'derived');

CREATE TRIGGER logical_documents_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON logical_documents FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('логический документ', 'revision_id', '', 'derived');

-- Одна таблица на оба состояния учёта страницы (привязана к документу и
-- непривязана), поэтому и триггер один: переназначение страницы другому
-- документу и обнуление document_id — обычный UPDATE этой строки.
CREATE TRIGGER page_assignments_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON page_assignments FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('учёт страницы', 'revision_id', '', 'derived');

CREATE TRIGGER document_relations_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON document_relations FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('связь документов', 'revision_id', '', 'derived');

CREATE TRIGGER registry_rows_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON registry_rows FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('строку реестра приложений', 'revision_id', '', 'derived');

CREATE TRIGGER materials_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON materials FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('материал', 'revision_id', '', 'derived');

CREATE TRIGGER layout_blocks_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON layout_blocks FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('блок разметки', 'revision_id', '', 'derived');

CREATE TRIGGER field_values_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON field_values FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('значение реквизита', 'revision_id', '', 'derived');

CREATE TRIGGER material_documents_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON material_documents FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content('связь материала и документа', 'revision_id', '', 'derived');

-- 7.2. Таблицы, у которых ссылки на ревизию нет: она достаётся через владельца.
-- Каскадное удаление содержимого draft-ревизии продолжает работать: к моменту
-- срабатывания каскада строка владельца уже удалена, поиск возвращает NULL, и
-- запрет не применяется. Обхода через владельца это не открывает — удаление
-- самого владельца заперто его собственным триггером.
CREATE TRIGGER layout_block_points_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON layout_block_points FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'точку полигона блока', 'block_id',
    'SELECT sr.status FROM layout_blocks b
       JOIN submission_revisions sr ON sr.id = b.revision_id
      WHERE b.id = $1::uuid', 'derived');

CREATE TRIGGER batches_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON batches FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'партию материала', 'material_id',
    'SELECT sr.status FROM materials m
       JOIN submission_revisions sr ON sr.id = m.revision_id
      WHERE m.id = $1::uuid', 'derived');

-- 7.3. Результаты распознавания терминальной ревизии.
--
-- Пункт 3 запирает сами artifact_versions и page_text_versions, но текст,
-- который портал ПОКАЖЕТ, выбирается через изменяемый указатель
-- current_block_result. Пока он не заперт, содержимое согласованной ревизии
-- подменяется в три шага без изменения ни одного хэша: новый recognition_runs,
-- новый block_results с другим текстом, перевод указателя на него.
-- Проверено воспроизведением: SELECT через указатель возвращал подменённый
-- текст при неизменных blocks_hash, artifact_sha256 и aggregate_manifest_hash.
--
-- Класс 'derived': до approve повторное распознавание законно и указатель
-- обязан двигаться.
CREATE TRIGGER recognition_runs_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON recognition_runs FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'прогон распознавания', 'revision_id', '', 'derived');

CREATE TRIGGER page_text_versions_revision_locked
  BEFORE INSERT ON page_text_versions FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'версию текста страницы', 'revision_id', '', 'derived');

-- Ссылки на ревизию у этих двух таблиц нет: она достаётся через блок разметки.
CREATE TRIGGER block_results_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON block_results FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'результат распознавания блока', 'layout_block_id',
    'SELECT sr.status FROM layout_blocks b
       JOIN submission_revisions sr ON sr.id = b.revision_id
      WHERE b.id = $1::uuid', 'derived');

CREATE TRIGGER current_block_result_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON current_block_result FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'указатель на текущий результат', 'layout_block_id',
    'SELECT sr.status FROM layout_blocks b
       JOIN submission_revisions sr ON sr.id = b.revision_id
      WHERE b.id = $1::uuid', 'derived');
