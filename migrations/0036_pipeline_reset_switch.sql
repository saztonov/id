-- 0036. Два триггера, которые выключатель ADR-0015 пропустил.
--
-- ## Что случилось
--
-- Миграция 0035 подчинила настройке `core.enforce_immutability` три триггерные
-- функции: `deny_modification`, `deny_frozen_layout_content`,
-- `deny_locked_revision_content`. Это покрыло 43 триггера из 0008 — но не все
-- запреты живут там.
--
-- Две функции заведены отдельными миграциями и раннего выхода не получили:
--
--   * `deny_confirmed_document_delete` (0016) — «Удалить логический документ
--     нельзя: он подтверждён человеком»;
--   * `deny_locked_source_page_content` (0013) — правка `source_pages` в
--     неподанной ревизии.
--
-- Обе стоят прямо в пути операций, ради которых выключатель и заводился:
-- первая — в `purge.ts` (шаг `logical_documents`), вторая — в удалении файла.
-- То есть режим тестирования включён, а операция всё равно падает, и падает
-- отказом, который в этом режиме обещано не выдавать.
--
-- ## Почему снова выключатель, а не DROP TRIGGER
--
-- Довод тот же, что в ADR-0015: снятый триггер некому вернуть. Инвариант,
-- удалённый «на время тестирования», не напоминает о себе ничем — схема
-- выглядит исправной, а подтверждённый человеком документ оказывается
-- удаляемым навсегда. Здесь добавляются ровно те же шесть строк раннего
-- выхода, и строгость возвращается тем же одним переключателем.
--
-- Тела функций скопированы целиком по той же причине, что и в 0035: триггеры
-- привязаны к функциям по OID, обёртку вокруг них подставить нельзя — будет
-- вызвана исходная. `CREATE OR REPLACE` сохраняет привязку, ни один триггер не
-- пересоздаётся, WHEN-условия не переписываются.

-- =====================================================================
-- 1. Подтверждённый человеком документ
-- =====================================================================
--
-- Подтверждение границ документа — решение человека, и стирать его молча нельзя:
-- пересегментация переписала бы разметку, которую он проверил глазами. В режиме
-- тестирования это перестаёт быть запретом, потому что сам сброс конвейера там
-- штатная операция — «распознать заново» означает снести всё производное,
-- включая документы.

CREATE OR REPLACE FUNCTION deny_confirmed_document_delete() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NOT immutability_enforced() THEN
    RETURN OLD;
  END IF;

  IF OLD.is_confirmed THEN
    RAISE EXCEPTION 'Удалить логический документ нельзя: он подтверждён человеком'
      USING ERRCODE = 'restrict_violation',
            CONSTRAINT = 'logical_documents_confirmed_lock',
            HINT = 'Снимите подтверждение явным действием, затем пересоберите документы';
  END IF;

  RETURN OLD;
END
$fn$;

-- =====================================================================
-- 2. Страницы исходных файлов поданной ревизии
-- =====================================================================
--
-- Тот же ранний выход, что 0035 добавила трём своим функциям. Возврат зависит от
-- операции: BEFORE-триггер обязан вернуть OLD на удалении и NEW на вставке и
-- правке, иначе строка не запишется вовсе.

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
  IF NOT immutability_enforced() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

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
