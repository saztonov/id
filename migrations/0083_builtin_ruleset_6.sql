-- Новая версия встроенного набора правил (§3.7, §9.6).
--
-- Файл сгенерирован generateBuiltinRulesetSql() из RULE_CATALOG. Править вручную
-- бессмысленно: следующая генерация вернёт содержимое каталога.
-- Перегенерировать: pnpm rules:seed:generate.
--
-- ## Зачем новая версия, а не дополнение прежней
--
-- Снимок опубликованного набора неизменяем: триггер
-- ruleset_rules_published_immutable запрещает вставку строк в него, и это не
-- формальность. Правило, добавленное в действующий набор задним числом, меняет
-- результат прогона так же, как изменённое, а прогоны уже сохранены и на них
-- ссылаются замечания. Поэтому каждое пополнение каталога, которому нужен
-- работающий набор, приезжает НОВОЙ версией.
--
-- ## Почему активация условная
--
-- Администратор мог опубликовать собственный набор — с другой тяжестью правил,
-- со снятыми проверками — и переключить портал на него. Такое решение поставка
-- отменять не вправе: указатель переводится, только если сейчас действует набор
-- поставки (origin = 'builtin'). Иначе новая версия просто лежит рядом, и
-- администратор выбирает её сам в справочнике правил.

-- 0. Предусловие снимка: определения правил, на которые он ссылается.
--
-- Набор ссылается на rule_definitions внешним ключом. Обычно определения сеют
-- партии, идущие раньше, — но на боевой базе двух правил не оказалось, хотя их
-- партия числилась применённой, и набор упал с ruleset_rules_rule_code_fkey,
-- остановив выкатку целиком. Здесь предусловие доставляет сам набор.
INSERT INTO rule_definitions (
  code, title, doc_type_code, level, kind, default_severity, waiver_roles
)
VALUES
  ($rules$AOSR.ACT.031$rules$, $rules$Дата акта не раньше окончания работ, окончание не раньше начала$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$act$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.010$rules$, $rules$Наименование объекта в акте совпадает с карточкой объекта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.020$rules$, $rules$Реквизиты сторон в шапке акта заполнены$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.021$rules$, $rules$Контрольная сумма ИНН в шапке акта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.022$rules$, $rules$Контрольная сумма ОГРН в шапке акта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.023$rules$, $rules$Тройка ОГРН, ИНН и наименования сходится со справочником$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P1.050$rules$, $rules$Пункт 1: наименование работ и привязка заполнены$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P3.070$rules$, $rules$Пункт 3: применённые материалы подтверждены документами$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P3.071$rules$, $rules$Пункт 3: при более чем пяти документах есть ссылка на реестр$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P4.080$rules$, $rules$Пункт 4: перечисленные приложения присутствуют в комплекте$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.SGN.040$rules$, $rules$Состав подписантов акта полон$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$signatures$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.SGN.041$rules$, $rules$Реквизиты приказов подписантов указаны$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$signatures$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.SGN.042$rules$, $rules$Организация в строке осмотра совпадает с выполнившей работы$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$signatures$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$CERT.600$rules$, $rules$Сертификат соответствия: обязательные реквизиты и срок$rules$, $rules$cert_conformity$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$DATE.300$rules$, $rules$Интервальный документ действует на релевантную дату$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.302$rules$, $rules$Документ истёк на дату проверки$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.303$rules$, $rules$Документ ещё не действовал на релевантную дату$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.310$rules$, $rules$Разовый документ выдан не позже применения$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.312$rules$, $rules$Партия изготовлена не позже применения$rules$, NULL, $rules$material$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DECL.601$rules$, $rules$Декларация о соответствии: обязательные реквизиты и срок$rules$, $rules$declaration$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$LLM.FILL.010$rules$, $rules$Обязательный реквизит документа не заполнен$rules$, NULL, $rules$document$rules$, $rules$crosscheck$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LLM.FILL.020$rules$, $rules$Значение реквизита расходится с текстом документа$rules$, NULL, $rules$document$rules$, $rules$extraction_quality$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LLM.FILL.030$rules$, $rules$Реквизиты документов комплекта противоречат друг другу$rules$, NULL, $rules$folder$rules$, $rules$crosscheck$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LLM.FILL.040$rules$, $rules$Документ не похож на заявленный вид$rules$, NULL, $rules$document$rules$, $rules$crosscheck$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$PASS.611$rules$, $rules$Паспорт качества: обязательные реквизиты заполнены$rules$, $rules$quality_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$REFUS.670$rules$, $rules$Отказное письмо: обязательные реквизиты$rules$, $rules$refusal_letter$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$REG.100$rules$, $rules$Строка реестра приложений не найдена в комплекте$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$REG.101$rules$, $rules$Документ комплекта не назван ни одной строкой реестра$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.102$rules$, $rules$Строка реестра сопоставлена неоднозначно$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.110$rules$, $rules$Строка описи передачи не найдена в папке$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.111$rules$, $rules$Документ папки не назван описью передачи$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.112$rules$, $rules$Раздел описи передачи не сопоставлен акту$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$SCH.681$rules$, $rules$К акту приложена исполнительная схема, ссылающаяся на его номер$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$TP.620$rules$, $rules$Технический паспорт: обязательные реквизиты заполнены$rules$, $rules$technical_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$XS.131$rules$, $rules$Объект и шифр проекта одинаковы по всей папке$rules$, NULL, $rules$folder$rules$, $rules$crosscheck$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[])
ON CONFLICT (code) DO NOTHING;

-- 1. Версия — НЕОПУБЛИКОВАННАЯ: пока published_at пуст, снимок можно набирать.
INSERT INTO ruleset_versions (version, origin, notes)
SELECT $rules$builtin-6$rules$, $ruleset$builtin$ruleset$,
       $ruleset$Набор по умолчанию из каталога правил портала. Опубликован поставкой, а не человеком.$ruleset$
 WHERE NOT EXISTS (SELECT 1 FROM ruleset_versions WHERE version = $rules$builtin-6$rules$);

-- 2. Снимок поведения: severity, is_blocking и params из умолчаний каталога.
--
-- Условие published_at IS NULL — не украшение: триггер запрещает вставку в
-- снимок опубликованной версии и сработал бы РАНЬШЕ, чем ON CONFLICT успел бы
-- признать строку дублем. Так оператор остаётся безвредным при повторе.
INSERT INTO ruleset_rules (ruleset_version_id, rule_code, is_enabled, severity, is_blocking, params)
SELECT v.id, x.rule_code, x.is_enabled, x.severity, x.is_blocking, x.params
  FROM ruleset_versions v
  CROSS JOIN (VALUES
    ($rules$AOSR.ACT.031$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.010$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.020$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.021$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.022$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.023$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P1.050$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P3.070$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P3.071$rules$, true, $rules$warning$rules$, false, $rules${"maxDocumentsWithoutRegistry":5}$rules$::jsonb),
    ($rules$AOSR.P4.080$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.SGN.040$rules$, true, $rules$error$rules$, false, $rules${"requiredSignerFields":["rep_developer","rep_builder","rep_builder_control","rep_contractor"]}$rules$::jsonb),
    ($rules$AOSR.SGN.041$rules$, true, $rules$warning$rules$, false, $rules${"requiredSignerFields":["rep_developer","rep_builder","rep_builder_control","rep_contractor"]}$rules$::jsonb),
    ($rules$AOSR.SGN.042$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$CERT.600$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$DATE.300$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.302$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$DATE.303$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.310$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.312$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DECL.601$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$LLM.FILL.010$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LLM.FILL.020$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LLM.FILL.030$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LLM.FILL.040$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$PASS.611$rules$, true, $rules$error$rules$, false, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$REFUS.670$rules$, true, $rules$warning$rules$, false, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$REG.100$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$REG.101$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.102$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.110$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.111$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.112$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$SCH.681$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$TP.620$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$XS.131$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb)
  ) AS x(rule_code, is_enabled, severity, is_blocking, params)
 WHERE v.version = $rules$builtin-6$rules$ AND v.published_at IS NULL
ON CONFLICT (ruleset_version_id, rule_code) DO NOTHING;

-- 3. Публикация — последним оператором, после набора снимка.
UPDATE ruleset_versions
   SET published_at = now()
 WHERE version = $rules$builtin-6$rules$ AND published_at IS NULL;

-- 4. Активация. DO NOTHING: осознанный выбор администратора не затирается.
INSERT INTO app_settings (key, value)
SELECT $ruleset$ruleset.active_version_id$ruleset$, to_jsonb(id::text)
  FROM ruleset_versions WHERE version = $rules$builtin-6$rules$
ON CONFLICT (key) DO UPDATE
   SET value = EXCLUDED.value, updated_at = now()
 WHERE EXISTS (
         SELECT 1 FROM ruleset_versions prev
          WHERE to_jsonb(prev.id::text) = app_settings.value
            AND prev.origin = $ruleset$builtin$ruleset$
       );
