-- Флаги внимания страницы — производные данные, а не состав поставки (§7.3).
--
-- ## Что было неверно
--
-- `source_pages` целиком отнесена к классу `source` (0008) и заперта с момента
-- подачи ревизии. Колонка `attention_flags` живёт именно на этой таблице, но по
-- смыслу принадлежит другому классу: её значение считает конвейер по ТЕКУЩЕЙ
-- разметке, оно не входит в `aggregate_manifest_hash` и ничего не говорит о том,
-- что подрядчик подал. Разметку же правят и после подачи — по §4.1 право
-- `markup.edit` есть у подрядчика И у инженера, а инженер работает с ревизией в
-- статусе `submitted`/`in_review`.
--
-- Следствие было ровно тем, за которое S2 назвал первую редакцию триггеров
-- перерасширением запрета: детекция на поданной ревизии отрабатывает, задачи
-- зелёные, `attention_flags` пуст. На экране «флагов нет» и «флаги не записаны»
-- становятся неразличимы, то есть проверяющий не видит ни одной подсказки и не
-- знает, что их не посчитали.
--
-- ## Что здесь делается
--
-- Триггер `source_pages` заменяется на специализированный. Он различает ровно
-- один случай: UPDATE, у которого `attention_flags` — ЕДИНСТВЕННОЕ изменившееся
-- поле строки. Такой UPDATE проверяется по правилам класса `derived` (запрещён
-- только в терминальных статусах returned/approved/superseded). Всё остальное —
-- INSERT, DELETE и любой UPDATE, трогающий состав (файл, индекс страницы,
-- порядок в ревизии, размеры, поворот), — проверяется по прежним правилам класса
-- `source` и заперто с момента submit.
--
-- Сравнение делается по jsonb-образу строки целиком, а не перечислением колонок:
-- перечень пришлось бы поддерживать при каждом ALTER TABLE, и забытая колонка
-- молча стала бы изменяемой на поданной ревизии. Здесь наоборот: новая колонка
-- по умолчанию попадает в «состав» и остаётся запертой.

CREATE OR REPLACE FUNCTION deny_locked_source_page_content() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  terminal   constant text[] := ARRAY['returned', 'approved', 'superseded'];
  source_locked constant text[] := terminal || ARRAY['submitted', 'in_review'];
  verb    constant text := CASE TG_OP
                             WHEN 'INSERT' THEN 'Добавить'
                             WHEN 'UPDATE' THEN 'Изменить'
                             ELSE 'Удалить'
                           END;
  entity  constant text := 'страницу исходного файла';
  flags_only boolean := false;
  locked     text[];
  status_old text;
  status_new text;
BEGIN
  -- Правка ТОЛЬКО флагов внимания: состав строки при этом обязан совпасть
  -- побайтово, включая revision_id — перенос страницы в другую ревизию под
  -- видом «обновления флагов» здесь не проходит.
  IF TG_OP = 'UPDATE' THEN
    flags_only := (to_jsonb(OLD) - 'attention_flags') = (to_jsonb(NEW) - 'attention_flags');
  END IF;

  locked := CASE WHEN flags_only THEN terminal ELSE source_locked END;

  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO status_old FROM submission_revisions WHERE id = OLD.revision_id;
    IF status_old = ANY (locked) THEN
      RAISE EXCEPTION '% % нельзя: ревизия поставки в статусе «%»', verb, entity, status_old
        USING ERRCODE = 'restrict_violation',
              HINT = 'Исправление вносится созданием НОВОЙ ревизии поставки, а не правкой поданной или согласованной';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO status_new FROM submission_revisions WHERE id = NEW.revision_id;
    IF status_new = ANY (locked) THEN
      RAISE EXCEPTION '% % нельзя: ревизия поставки в статусе «%»', verb, entity, status_new
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

DROP TRIGGER IF EXISTS source_pages_revision_locked ON source_pages;

CREATE TRIGGER source_pages_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON source_pages FOR EACH ROW
  EXECUTE FUNCTION deny_locked_source_page_content();
