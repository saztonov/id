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
  ($rules$AOSR.ACT.030$rules$, $rules$Номер акта соответствует шаблону объекта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$act$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.ACT.031$rules$, $rules$Дата акта не раньше окончания работ, окончание не раньше начала$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$act$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.ACT.032$rules$, $rules$Месяц комплекта сходится с датой акта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$act$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.010$rules$, $rules$Наименование объекта в акте совпадает с карточкой объекта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.020$rules$, $rules$Реквизиты сторон в шапке акта заполнены$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.021$rules$, $rules$Контрольная сумма ИНН в шапке акта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.022$rules$, $rules$Контрольная сумма ОГРН в шапке акта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.HDR.023$rules$, $rules$Тройка ОГРН, ИНН и наименования сходится со справочником$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$header$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P1.050$rules$, $rules$Пункт 1: наименование работ и привязка заполнены$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P2.060$rules$, $rules$Пункт 2: шифр рабочей документации указан с номером изменения$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P2.061$rules$, $rules$Пункт 2: шифр рабочей документации есть в справочнике$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P3.070$rules$, $rules$Пункт 3: применённые материалы подтверждены документами$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P3.071$rules$, $rules$Пункт 3: при более чем пяти документах есть ссылка на реестр$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P4.080$rules$, $rules$Пункт 4: перечисленные приложения присутствуют в комплекте$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.P4.081$rules$, $rules$Пункт 4: наименование схемы согласовано с пунктом 1$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$AOSR.P7.090$rules$, $rules$Пункт 7: последующие работы не совпадают с освидетельствованными$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$items$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.SGN.040$rules$, $rules$Состав подписантов акта полон$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$signatures$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.SGN.041$rules$, $rules$Реквизиты приказов подписантов указаны$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$signatures$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.SGN.042$rules$, $rules$Организация в строке осмотра совпадает с выполнившей работы$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$signatures$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$CERT.600$rules$, $rules$Сертификат соответствия: обязательные реквизиты и срок$rules$, $rules$cert_conformity$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$CONCL.660$rules$, $rules$Заключение: обязательные реквизиты и срок$rules$, $rules$technical_conclusion$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$DATE.300$rules$, $rules$Интервальный документ действует на релевантную дату$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.302$rules$, $rules$Документ истёк на дату проверки$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.303$rules$, $rules$Документ ещё не действовал на релевантную дату$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.304$rules$, $rules$Отметка о подтверждении действия покрывает период$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.310$rules$, $rules$Разовый документ выдан не позже применения$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.311$rules$, $rules$Документ не абсурдно старый$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.312$rules$, $rules$Партия изготовлена не позже применения$rules$, NULL, $rules$material$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.320$rules$, $rules$Отгрузка смеси и сохраняемость$rules$, $rules$mix_quality_doc$rules$, $rules$document$rules$, $rules$dates$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.330$rules$, $rules$Аккредитация лаборатории действует на дату испытания$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$DATE.331$rules$, $rules$Поверка прибора действует на дату измерения$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.332$rules$, $rules$Аккредитация подтверждена внешним реестром$rules$, NULL, $rules$document$rules$, $rules$external$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DATE.372$rules$, $rules$Протокол испытаний относится к применённым партиям$rules$, NULL, $rules$document$rules$, $rules$dates$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$DECL.601$rules$, $rules$Декларация о соответствии: обязательные реквизиты и срок$rules$, $rules$declaration$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$EXT.NRS.141$rules$, $rules$Подписанты акта в национальном реестре специалистов$rules$, NULL, $rules$folder$rules$, $rules$external$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$EXT.SCHED.142$rules$, $rules$Освидетельствованные работы есть в графике строительства$rules$, NULL, $rules$folder$rules$, $rules$external$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$EXT.SRO.140$rules$, $rules$Членство подрядчика в СРО$rules$, NULL, $rules$folder$rules$, $rules$external$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LAB.650$rules$, $rules$Протокол прочности: оценка результата по возрасту образца$rules$, $rules$lab_protocol_concrete$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$LAB.651$rules$, $rules$Приёмочный протокол в проектном возрасте приложен$rules$, $rules$lab_protocol_concrete$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$LLM.FILL.010$rules$, $rules$Обязательный реквизит документа не заполнен$rules$, NULL, $rules$document$rules$, $rules$crosscheck$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LLM.FILL.020$rules$, $rules$Значение реквизита расходится с текстом документа$rules$, NULL, $rules$document$rules$, $rules$extraction_quality$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LLM.FILL.030$rules$, $rules$Реквизиты документов комплекта противоречат друг другу$rules$, NULL, $rules$folder$rules$, $rules$crosscheck$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LLM.FILL.040$rules$, $rules$Документ не похож на заявленный вид$rules$, NULL, $rules$document$rules$, $rules$crosscheck$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$MAT.110$rules$, $rules$Пакет подтверждения материала соответствует матрице раздела$rules$, NULL, $rules$material$rules$, $rules$materials$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$MAT.111$rules$, $rules$Изготовитель партии покрыт приложенным сертификатом$rules$, NULL, $rules$material$rules$, $rules$materials$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$MAT.112$rules$, $rules$Нормативный документ в паспорте совпадает с сертификатом$rules$, NULL, $rules$material$rules$, $rules$materials$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$MILL.630$rules$, $rules$Сертификат качества металла: марка и механические свойства$rules$, $rules$mill_certificate$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$MIX.640$rules$, $rules$Документ о качестве смеси: марка соответствует проектной$rules$, $rules$mix_quality_doc$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$PASS.610$rules$, $rules$Паспорт качества: фактические значения в пределах нормы по НД$rules$, $rules$quality_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$PASS.611$rules$, $rules$Паспорт качества: обязательные реквизиты заполнены$rules$, $rules$quality_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$REF.120$rules$, $rules$Объект строительства активен в справочнике$rules$, NULL, $rules$folder$rules$, $rules$reference$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REF.121$rules$, $rules$Контрагенты комплекта активны в справочнике$rules$, NULL, $rules$folder$rules$, $rules$reference$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REFUS.670$rules$, $rules$Отказное письмо: обязательные реквизиты$rules$, $rules$refusal_letter$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$REG.100$rules$, $rules$Строка реестра приложений не найдена в комплекте$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$REG.101$rules$, $rules$Документ комплекта не назван ни одной строкой реестра$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.102$rules$, $rules$Строка реестра сопоставлена неоднозначно$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.110$rules$, $rules$Строка описи передачи не найдена в папке$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.111$rules$, $rules$Документ папки не назван описью передачи$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.112$rules$, $rules$Раздел описи передачи не сопоставлен акту$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.113$rules$, $rules$Номер акта в строке описи передачи расходится с актом раздела$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.114$rules$, $rules$Организация в строке описи передачи расходится с документом$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.115$rules$, $rules$Номер в строке описи передачи записан иначе, чем в документе$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.116$rules$, $rules$Дата в строке описи передачи расходится с документом$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.117$rules$, $rules$Число листов в строке описи передачи расходится с документом$rules$, NULL, $rules$folder$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$SCH.680$rules$, $rules$Исполнительная схема: привязка и подписи$rules$, $rules$exec_scheme$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$SIG.PDF.371$rules$, $rules$Структурный зонд встроенной подписи$rules$, NULL, $rules$signature$rules$, $rules$signatures$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$SIG.STAMP.370$rules$, $rules$Срок сертификата ЭП по визуальному штампу$rules$, NULL, $rules$signature$rules$, $rules$signatures$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$TP.620$rules$, $rules$Технический паспорт: обязательные реквизиты заполнены$rules$, $rules$technical_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$XS.130$rules$, $rules$В комплекте нет дубля акта$rules$, NULL, $rules$folder$rules$, $rules$crosscheck$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[])
ON CONFLICT (code) DO NOTHING;

-- 1. Версия — НЕОПУБЛИКОВАННАЯ: пока published_at пуст, снимок можно набирать.
INSERT INTO ruleset_versions (version, origin, notes)
SELECT $rules$builtin-4$rules$, $ruleset$builtin$ruleset$,
       $ruleset$Набор по умолчанию из каталога правил портала. Опубликован поставкой, а не человеком.$ruleset$
 WHERE NOT EXISTS (SELECT 1 FROM ruleset_versions WHERE version = $rules$builtin-4$rules$);

-- 2. Снимок поведения: severity, is_blocking и params из умолчаний каталога.
--
-- Условие published_at IS NULL — не украшение: триггер запрещает вставку в
-- снимок опубликованной версии и сработал бы РАНЬШЕ, чем ON CONFLICT успел бы
-- признать строку дублем. Так оператор остаётся безвредным при повторе.
INSERT INTO ruleset_rules (ruleset_version_id, rule_code, is_enabled, severity, is_blocking, params)
SELECT v.id, x.rule_code, x.is_enabled, x.severity, x.is_blocking, x.params
  FROM ruleset_versions v
  CROSS JOIN (VALUES
    ($rules$AOSR.ACT.030$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.ACT.031$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.ACT.032$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.010$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.020$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.021$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.022$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.HDR.023$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P1.050$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P2.060$rules$, true, $rules$warning$rules$, false, $rules${"revisionPattern":"изм(?:енени[ея])?\\.?\\s*№?\\s*\\d+"}$rules$::jsonb),
    ($rules$AOSR.P2.061$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P3.070$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P3.071$rules$, true, $rules$warning$rules$, false, $rules${"maxDocumentsWithoutRegistry":5}$rules$::jsonb),
    ($rules$AOSR.P4.080$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.P4.081$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$AOSR.P7.090$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$AOSR.SGN.040$rules$, true, $rules$error$rules$, false, $rules${"requiredSignerFields":["rep_developer","rep_builder","rep_builder_control","rep_contractor"]}$rules$::jsonb),
    ($rules$AOSR.SGN.041$rules$, true, $rules$warning$rules$, false, $rules${"requiredSignerFields":["rep_developer","rep_builder","rep_builder_control","rep_contractor"]}$rules$::jsonb),
    ($rules$AOSR.SGN.042$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$CERT.600$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$CONCL.660$rules$, true, $rules$warning$rules$, false, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$DATE.300$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.302$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$DATE.303$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.304$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$DATE.310$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.311$rules$, true, $rules$warning$rules$, false, $rules${"maxAgeDays":3650}$rules$::jsonb),
    ($rules$DATE.312$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.320$rules$, true, $rules$warning$rules$, false, $rules${"workabilityHours":4,"maxDaysBetweenShipmentAndUse":0}$rules$::jsonb),
    ($rules$DATE.330$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$DATE.331$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$DATE.332$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$DATE.372$rules$, true, $rules$warning$rules$, false, $rules${"graceDays":0}$rules$::jsonb),
    ($rules$DECL.601$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$EXT.NRS.141$rules$, true, $rules$error$rules$, false, $rules${"requiredSignerFields":["rep_developer","rep_builder","rep_builder_control","rep_contractor"]}$rules$::jsonb),
    ($rules$EXT.SCHED.142$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$EXT.SRO.140$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LAB.650$rules$, true, $rules$error$rules$, false, $rules${"designAgeDays":28}$rules$::jsonb),
    ($rules$LAB.651$rules$, true, $rules$error$rules$, true, $rules${"designAgeDays":28}$rules$::jsonb),
    ($rules$LLM.FILL.010$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LLM.FILL.020$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LLM.FILL.030$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$LLM.FILL.040$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$MAT.110$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb),
    ($rules$MAT.111$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$MAT.112$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$MILL.630$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$MIX.640$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$PASS.610$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$PASS.611$rules$, true, $rules$error$rules$, false, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$REF.120$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REF.121$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REFUS.670$rules$, true, $rules$warning$rules$, false, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$REG.100$rules$, true, $rules$error$rules$, true, $rules${}$rules$::jsonb),
    ($rules$REG.101$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.102$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.110$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.111$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.112$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.113$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.114$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.115$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.116$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$REG.117$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$SCH.680$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$SIG.PDF.371$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$SIG.STAMP.370$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$TP.620$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$XS.130$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb)
  ) AS x(rule_code, is_enabled, severity, is_blocking, params)
 WHERE v.version = $rules$builtin-4$rules$ AND v.published_at IS NULL
ON CONFLICT (ruleset_version_id, rule_code) DO NOTHING;

-- 3. Публикация — последним оператором, после набора снимка.
UPDATE ruleset_versions
   SET published_at = now()
 WHERE version = $rules$builtin-4$rules$ AND published_at IS NULL;

-- 4. Активация. DO NOTHING: осознанный выбор администратора не затирается.
INSERT INTO app_settings (key, value)
SELECT $ruleset$ruleset.active_version_id$ruleset$, to_jsonb(id::text)
  FROM ruleset_versions WHERE version = $rules$builtin-4$rules$
ON CONFLICT (key) DO UPDATE
   SET value = EXCLUDED.value, updated_at = now()
 WHERE EXISTS (
         SELECT 1 FROM ruleset_versions prev
          WHERE to_jsonb(prev.id::text) = app_settings.value
            AND prev.origin = $ruleset$builtin$ruleset$
       );
