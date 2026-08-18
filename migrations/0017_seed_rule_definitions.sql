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
  ($rules$AOSR.ACT.030$rules$, $rules$Номер акта соответствует шаблону объекта$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$act$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$AOSR.ACT.031$rules$, $rules$Дата акта не раньше окончания работ, окончание не раньше начала$rules$, $rules$aosr$rules$, $rules$document$rules$, $rules$act$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
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
  ($rules$EXT.NRS.141$rules$, $rules$Подписанты акта в национальном реестре специалистов$rules$, NULL, $rules$revision$rules$, $rules$external$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$EXT.SCHED.142$rules$, $rules$Освидетельствованные работы есть в графике строительства$rules$, NULL, $rules$revision$rules$, $rules$external$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$EXT.SRO.140$rules$, $rules$Членство подрядчика в СРО$rules$, NULL, $rules$revision$rules$, $rules$external$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$LAB.650$rules$, $rules$Протокол прочности: оценка результата по возрасту образца$rules$, $rules$lab_protocol_concrete$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$LAB.651$rules$, $rules$Приёмочный протокол в проектном возрасте приложен$rules$, $rules$lab_protocol_concrete$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$MAT.110$rules$, $rules$Пакет подтверждения материала соответствует матрице раздела$rules$, NULL, $rules$material$rules$, $rules$materials$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$MAT.111$rules$, $rules$Изготовитель партии покрыт приложенным сертификатом$rules$, NULL, $rules$material$rules$, $rules$materials$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$MAT.112$rules$, $rules$Нормативный документ в паспорте совпадает с сертификатом$rules$, NULL, $rules$material$rules$, $rules$materials$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$MILL.630$rules$, $rules$Сертификат качества металла: марка и механические свойства$rules$, $rules$mill_certificate$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$MIX.640$rules$, $rules$Документ о качестве смеси: марка соответствует проектной$rules$, $rules$mix_quality_doc$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$PASS.610$rules$, $rules$Паспорт качества: фактические значения в пределах нормы по НД$rules$, $rules$quality_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$PASS.611$rules$, $rules$Паспорт качества: обязательные реквизиты заполнены$rules$, $rules$quality_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$REF.120$rules$, $rules$Объект строительства активен в справочнике$rules$, NULL, $rules$revision$rules$, $rules$reference$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REF.121$rules$, $rules$Контрагенты комплекта активны в справочнике$rules$, NULL, $rules$revision$rules$, $rules$reference$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REFUS.670$rules$, $rules$Отказное письмо: обязательные реквизиты$rules$, $rules$refusal_letter$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$REG.100$rules$, $rules$Строка реестра приложений не найдена в комплекте$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$]::text[]),
  ($rules$REG.101$rules$, $rules$Документ комплекта не назван ни одной строкой реестра$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$REG.102$rules$, $rules$Строка реестра сопоставлена неоднозначно$rules$, NULL, $rules$registry$rules$, $rules$registry$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$SCH.680$rules$, $rules$Исполнительная схема: привязка и подписи$rules$, $rules$exec_scheme$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$SIG.PDF.371$rules$, $rules$Структурный зонд встроенной подписи$rules$, NULL, $rules$signature$rules$, $rules$signatures$rules$, $rules$info$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$SIG.STAMP.370$rules$, $rules$Срок сертификата ЭП по визуальному штампу$rules$, NULL, $rules$signature$rules$, $rules$signatures$rules$, $rules$warning$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[]),
  ($rules$TP.620$rules$, $rules$Технический паспорт: обязательные реквизиты заполнены$rules$, $rules$technical_passport$rules$, $rules$document$rules$, $rules$evidence$rules$, $rules$error$rules$, ARRAY[$rules$manager$rules$, $rules$admin$rules$]::text[]),
  ($rules$XS.130$rules$, $rules$В комплекте нет дубля акта$rules$, NULL, $rules$revision$rules$, $rules$crosscheck$rules$, $rules$error$rules$, ARRAY[$rules$engineer$rules$, $rules$manager$rules$]::text[])
ON CONFLICT (code) DO UPDATE SET
  title = EXCLUDED.title,
  doc_type_code = EXCLUDED.doc_type_code,
  level = EXCLUDED.level,
  kind = EXCLUDED.kind,
  default_severity = EXCLUDED.default_severity,
  waiver_roles = EXCLUDED.waiver_roles;
