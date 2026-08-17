-- Резервные виды ИД защищены от отключения; журнал аудита читается по действию.
--
-- Обе правки закрывают дефекты, найденные воспроизведением на S4.
--
-- 1. Наложением можно было отключить РЕЗЕРВНЫЙ вид ИД
--    (`PATCH /catalog/doc-types/other_acts {isActive:false}` -> 200), и в
--    каталоге оставалось 9 резервных типов из 10. По §8.1 классификатору обязано
--    быть куда положить документ, который является документом, но не относится
--    ни к одному известному типу, а §16 делает наличие резервного типа критерием
--    приёмки. Отказ ставит API (422 с объяснением), но инвариант обязана держать
--    и БД: писателем `doc_type_overrides` бывает не только портал — рука в psql,
--    миграция данных, будущий воркер. Проверка не выражается CHECK: она смотрит
--    на СОСЕДНЮЮ таблицу (`doc_types.is_fallback`), а CHECK подзапросов не
--    допускает.
--
-- 2. У журнала аудита появился читатель (`GET /api/v1/audit/entries`, право
--    `audit.read`), и один из его фильтров — действие. Индексы 0001 покрывают
--    время, объект, актора и сущность, но не действие: вопрос «кто и когда
--    отключал резервные типы» сканировал бы журнал целиком.

-- Столбец `is_active` наложения троичный: TRUE — включён, FALSE — отключён,
-- NULL — «наложения нет, берётся поставляемое значение». Запрещается только
-- FALSE: и включение, и снятие наложения оставляют резервный тип доступным,
-- поэтому условие сформулировано как IS NOT FALSE, а не IS DISTINCT FROM TRUE.
CREATE FUNCTION deny_fallback_deactivation() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  is_protected boolean;
BEGIN
  IF NEW.is_active IS NOT FALSE THEN
    RETURN NEW;
  END IF;

  -- Защищён резервный тип ПОСТАВКИ: `is_fallback` ставит только seed-миграция
  -- (портал заводит типы с is_fallback = false), поэтому конъюнкция с
  -- `is_system` описывает именно те строки, которые вернутся следующим seed'ом,
  -- а не решение администратора.
  SELECT t.is_fallback AND t.is_system INTO is_protected
    FROM doc_types t
   WHERE t.code = NEW.doc_type_code;

  IF COALESCE(is_protected, false) THEN
    RAISE EXCEPTION
      'Резервный вид ИД «%» нельзя отключить: документу незнакомого вида станет некуда деться',
      NEW.doc_type_code
      USING ERRCODE = 'check_violation',
            -- Имя ограничения — часть контракта миграций: по нему API отвечает
            -- 422 с объяснением вместо «внутренней ошибки сервера».
            CONSTRAINT = 'doc_type_overrides_fallback_active_chk',
            HINT = 'У резервного типа настраиваются только отображаемое имя и порядок';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER doc_type_overrides_keep_fallback_active
  BEFORE INSERT OR UPDATE ON doc_type_overrides FOR EACH ROW
  EXECUTE FUNCTION deny_fallback_deactivation();

CREATE INDEX ix_audit_log_action ON audit_log (action, at DESC);
