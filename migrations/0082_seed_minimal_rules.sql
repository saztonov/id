-- Seed реестра правил проверки (§3.7, §9.6).
--
-- Файл сгенерирован generateRuleSeedSql() из packages/rules. Править вручную
-- бессмысленно: следующая генерация вернёт содержимое каталога. Источник правды
-- — RULE_CATALOG, откуда движок берёт и реализации; сверка при старте требует,
-- чтобы множества кодов совпадали в обе стороны.
--
-- Seed не удаляет строки: удаление задело бы rule_code уже выполненных прогонов
-- и переписало бы историю. Код, исчезнувший из каталога, обнаруживается сверкой
-- и требует явной миграции.
--
-- Значения по умолчанию для снимка (is_blocking, params) сюда НЕ пишутся: их
-- место — ruleset_rules, то есть опубликованная версия набора. Колонок под них
-- в rule_definitions нет намеренно, иначе появилось бы второе место, где
-- задано поведение правила, и снимок перестал бы быть единственным.

INSERT INTO rule_definitions (
  code, title, doc_type_code, level, kind, default_severity, waiver_roles
)
VALUES
  ($rules$SCH.681$rules$, $rules$К акту приложена исполнительная схема, ссылающаяся на его номер$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$XS.131$rules$, $rules$Объект и шифр проекта одинаковы по всей папке$rules$, NULL, $rules$folder$rules$, $rules$crosscheck$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[])
ON CONFLICT (code) DO UPDATE SET
  title = EXCLUDED.title,
  doc_type_code = EXCLUDED.doc_type_code,
  level = EXCLUDED.level,
  kind = EXCLUDED.kind,
  default_severity = EXCLUDED.default_severity,
  waiver_roles = EXCLUDED.waiver_roles;
