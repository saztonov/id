-- Разворот содержимого страницы: зонд, ручная правка и стадия зонда (ADR-0020, S35).
--
-- ## Что за величина и чем она НЕ является
--
-- У страницы теперь два поворота, и путать их нельзя.
--
-- `source_pages.rotation` — это `/Rotate` из самого PDF. Он УЖЕ применён:
-- `geometryOf()` при пробинге меняет местами стороны, poppler разворачивает
-- растр, pdf.js отдаёт пост-поворотный вьюпорт. Портал его не выбирает — он его
-- читает.
--
-- `content_rotation` — это поправка к СКАНУ, легшему на лист боком при
-- `/Rotate = 0`. Её не применяет никто: ни один слой конвейера о ней до сих пор
-- не знал. Именно из-за неё страница 4 эталонного комплекта (сертификат на
-- геотекстиль) распозналась наполовину: модель сняла строчный текст, а таблицу
-- «Норма / Факт» из десяти строк потеряла целиком — на повёрнутой сетке строгий
-- транскрипционный промт разваливается.
--
-- Значение: на сколько градусов ПО ЧАСОВОЙ СТРЕЛКЕ надо повернуть растр
-- страницы, чтобы текст читался нормально. Та же фраза дословно повторена в
-- `rotateRectNorm` (пакет detection), в шапке `markup/rotation.ts` и в тексте
-- промта зонда: четыре места читают одно число и обязаны понимать его
-- одинаково, иначе лист уедет вверх ногами — и это не упадёт, а просто будет
-- неверно.
--
-- ## Почему отдельная таблица, а не колонка в `source_pages`
--
-- Триггер `source_pages_revision_locked` (0008, п. 7.1) объявлен со scope
-- source, а там заперты в том числе submitted и in_review — ровно те статусы, в
-- которых инженер размечает (`layout_blocks` стоит со scope derived). Колонка в
-- `source_pages` оказалась бы недоступна на запись именно в тот момент, когда
-- человек жмёт кнопку поворота.
--
-- Ослабить триггер оговоркой, как это сделала 0013 для `attention_flags`,
-- нельзя во второй раз: одна оговорка сделала функцию неочевидной, вторая
-- сделает её нечитаемой. Прецедент для повторения — `page_classifications`
-- (0014): отдельная таблица по паре (revision_id, source_page_id), заведённая
-- после 0008, со своим триггером класса derived.
--
-- ## Почему ключ по странице ИСХОДНОГО файла
--
-- Разворот — свойство скана, а не листа рабочего документа. `source_pages`
-- принадлежат ревизии поставки и пересборкой не трогаются; пересобираются
-- `processing_bundles` и `processing_bundle_pages`. Ключ по `source_page_id`
-- переживает пересборку без единой строки миграции данных — тот же принцип, по
-- которому его переживает ручная метка вида ИД.
--
-- ## Почему одна строка, а не две (машинная и ручная)
--
-- Потребителям — детекции, кропу, экрану — нужен ОДИН ответ на вопрос «в какую
-- сторону повёрнут лист». Две строки означали бы слияние приоритетов в трёх
-- местах кода, и разъехались бы эти три места молча. Приоритет выражается
-- колонкой `source`, как в `page_classifications.source`.
--
-- Мнение зонда при этом сохраняется отдельными колонками ДАЖЕ когда инженер его
-- перекрыл: без него нельзя ответить на вопрос «зонд был прав?», ради которого
-- зонд и заводят.

CREATE TABLE page_orientations (
  revision_id          uuid NOT NULL,
  source_page_id       uuid NOT NULL,

  -- ДЕЙСТВУЮЩЕЕ значение: его читают детекция, кроп и экран.
  content_rotation     integer NOT NULL,
  source               text NOT NULL,

  -- Мнение зонда. Живёт своей жизнью: `content_rotation` может отличаться от
  -- него и при ручной правке, и при низкой уверенности.
  probe_rotation       integer,
  probe_confidence     double precision,
  probe_model          text,
  probe_prompt_code    text,
  probe_prompt_version integer,
  -- Сшивка со строкой `ai_runs`: по ней находится сам вызов с его ценой.
  probe_input_hash     text,
  probed_at            timestamptz,
  -- Почему зонд не дал ответа. «Смотрели и не смогли» и «не смотрели» — разные
  -- состояния: первое не лечится ничем, второе лечится повторным запуском.
  probe_error          text,

  updated_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (revision_id, source_page_id),

  CONSTRAINT page_orientations_rotation_chk
    CHECK (content_rotation IN (0, 90, 180, 270)),
  CONSTRAINT page_orientations_probe_rotation_chk
    CHECK (probe_rotation IS NULL OR probe_rotation IN (0, 90, 180, 270)),
  CONSTRAINT page_orientations_source_chk CHECK (source IN ('probe', 'user')),
  CONSTRAINT page_orientations_confidence_chk
    CHECK (probe_confidence IS NULL OR (probe_confidence >= 0 AND probe_confidence <= 1)),
  -- Строка зонда обязана сказать, что он увидел, либо почему не увидел ничего.
  -- Иначе «зонд ответил 0» и «зонд не отработал» неотличимы.
  CONSTRAINT page_orientations_probe_evidence_chk
    CHECK (source <> 'probe' OR probe_rotation IS NOT NULL OR probe_error IS NOT NULL),

  CONSTRAINT page_orientations_source_page_fk
    FOREIGN KEY (revision_id, source_page_id)
    REFERENCES source_pages (revision_id, id) ON DELETE CASCADE
);

-- Рабочий запрос обоих потребителей — «какие страницы этой ревизии повёрнуты».
-- Частичный, потому что повёрнутых страниц единицы из десятков.
CREATE INDEX ix_page_orientations_rotated ON page_orientations (revision_id)
  WHERE content_rotation <> 0;

-- Класс derived (0008, п. 7): правится, пока правится разметка.
--
-- Триггер нужен, хотя таблица заведена после 0008 и по умолчанию свободна.
-- Разворот меняет РЕЗУЛЬТАТ распознавания, и после согласования он становится
-- частью основания вердикта: переписать его значило бы переписать основание,
-- оставив дату и подпись прежними. Это дословно тот же довод, которым обоснован
-- триггер `page_classifications`.
CREATE TRIGGER page_orientations_revision_locked
  BEFORE INSERT OR UPDATE OR DELETE ON page_orientations FOR EACH ROW
  EXECUTE FUNCTION deny_locked_revision_content(
    'разворот содержимого страницы', 'revision_id', '', 'derived');

-- Стадия зонда ориентации.
--
-- Отдельная стадия, а не recognize, по прецеденту 0019. Причина бухгалтерская:
-- строка зонда не принадлежит прогону распознавания — у неё нет
-- `recognition_run_id`, потому что зонд отрабатывает ДО детекции, когда прогона
-- ещё не существует. Под recognize он врал бы всякому срезу «цена прогона», а
-- именно такой срез S28 в своё время и чинил.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_stage_chk;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_stage_chk
  CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary',
                   'recognize', 'orientation'));

-- Промт зонда живёт в том же governance, что и остальные.
ALTER TABLE prompt_templates DROP CONSTRAINT prompt_templates_stage_chk;
ALTER TABLE prompt_templates ADD CONSTRAINT prompt_templates_stage_chk
  CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary',
                   'recognize', 'orientation'));

-- Причины качества: «зонд не отработал» и «зонд не уверен» — тот же класс
-- вопроса к конвейеру, что detect.no_blocks, и отвечать на него надо теми же
-- срезами.
ALTER TABLE processing_feedback DROP CONSTRAINT processing_feedback_reason_chk;
ALTER TABLE processing_feedback ADD CONSTRAINT processing_feedback_reason_chk
  CHECK (reason_code IN (
    'vlm.invalid_json',
    'vlm.schema_mismatch',
    'vlm.refusal',
    'vlm.empty_result',
    'extract.field_missing',
    'classify.low_confidence',
    'detect.no_blocks',
    'detect.low_score',
    'match.ambiguous',
    'doc_split.unassigned_pages',
    'manual.field_corrected',
    'manual.block_redrawn',
    'manual.type_changed',
    'orientation.probe_failed',
    'orientation.low_confidence'));
