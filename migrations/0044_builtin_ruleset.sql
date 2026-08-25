-- Встроенный набор правил и его активация (§3.7, §9.6).
--
-- Файл сгенерирован generateBuiltinRulesetSql() из RULE_CATALOG. Править вручную
-- бессмысленно: следующая генерация вернёт содержимое каталога.
-- Перегенерировать: pnpm rules:seed:generate.
--
-- ## Что было неверно
--
-- Реестр правил (rule_definitions) сеялся миграциями с S4, а НАБОР — версия с
-- неизменяемым снимком поведения — не сеялся никогда, и указатель
-- ruleset.active_version_id по умолчанию NULL. Прогон правил из-за этого не
-- начинался вовсе: checks.run отказывал «активная версия набора правил не
-- назначена», и замечаний у комплекта не появлялось НИ ОДНОГО ни при каких
-- данных. Портал, вся работа которого — проверка комплекта, из коробки не
-- проверял ничего, и сказано об этом было только в консоли воркера.
--
-- ## Почему набор помечен origin='builtin', а не опубликован от чьего-то имени
--
-- ruleset_versions_published_chk требовал published_by у любой опубликованной
-- версии, и обойти его можно было бы, подставив встроенного администратора.
-- Так делать нельзя по той же причине, по которой сид промптов не сеет
-- published-строку: published_by читают как ДОКАЗАТЕЛЬСТВО решения человека, и
-- подделка в этом столбце обесценивает журнал целиком. Поэтому заведена третья
-- возможность: набор, опубликованный не человеком, а поставкой портала, — и она
-- названа своим словом в колонке origin.
--
-- ## Почему порядок операторов именно такой
--
-- Триггер ruleset_rules_published_immutable (0008) запрещает ВСТАВКУ строк в
-- снимок уже опубликованной версии — правило, добавленное после публикации,
-- меняет результат прогона так же, как изменённое. Отсюда единственно
-- возможный порядок: версия с published_at IS NULL, затем снимок, затем
-- публикация. Обратный порядок дал бы отказ триггера посреди миграции.
--
-- ## Что миграция НЕ делает
--
-- Не трогает уже назначенную активную версию: ON CONFLICT (key) DO NOTHING.
-- Администратор, опубликовавший свой набор, остаётся на нём.

ALTER TABLE ruleset_versions
  ADD COLUMN origin text NOT NULL DEFAULT 'manual';

ALTER TABLE ruleset_versions
  ADD CONSTRAINT ruleset_versions_origin_chk CHECK (origin IN ('manual', 'builtin'));

ALTER TABLE ruleset_versions DROP CONSTRAINT ruleset_versions_published_chk;
ALTER TABLE ruleset_versions ADD CONSTRAINT ruleset_versions_published_chk
  CHECK (published_at IS NULL OR published_by IS NOT NULL OR origin = 'builtin');

-- 1. Версия — НЕОПУБЛИКОВАННАЯ: пока published_at пуст, снимок можно набирать.
INSERT INTO ruleset_versions (version, origin, notes)
SELECT $rules$builtin-1$rules$, $ruleset$builtin$ruleset$,
       $ruleset$Набор по умолчанию из каталога правил портала. Опубликован поставкой, а не человеком.$ruleset$
 WHERE NOT EXISTS (SELECT 1 FROM ruleset_versions WHERE version = $rules$builtin-1$rules$);

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
    ($rules$SCH.680$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$SIG.PDF.371$rules$, true, $rules$info$rules$, false, $rules${}$rules$::jsonb),
    ($rules$SIG.STAMP.370$rules$, true, $rules$warning$rules$, false, $rules${}$rules$::jsonb),
    ($rules$TP.620$rules$, true, $rules$error$rules$, true, $rules${"requiredFields":["number","issued_at"]}$rules$::jsonb),
    ($rules$XS.130$rules$, true, $rules$error$rules$, false, $rules${}$rules$::jsonb)
  ) AS x(rule_code, is_enabled, severity, is_blocking, params)
 WHERE v.version = $rules$builtin-1$rules$ AND v.published_at IS NULL
ON CONFLICT (ruleset_version_id, rule_code) DO NOTHING;

-- 3. Публикация — последним оператором, после набора снимка.
UPDATE ruleset_versions
   SET published_at = now()
 WHERE version = $rules$builtin-1$rules$ AND published_at IS NULL;

-- 4. Активация. DO NOTHING: осознанный выбор администратора не затирается.
INSERT INTO app_settings (key, value)
SELECT $ruleset$ruleset.active_version_id$ruleset$, to_jsonb(id::text)
  FROM ruleset_versions WHERE version = $rules$builtin-1$rules$
ON CONFLICT (key) DO NOTHING;
