-- S57. Сверку строки перечня судит модель, и решение хранится вместе с доводом.
--
-- ## Что меняется по существу
--
-- До сих пор строка перечня несла три факта: найденный документ, счёт и
-- состояние. Счёт был единственным следом того, КАКОЙ ступенью лестницы строка
-- найдена, и отчёт переводил его обратно в слова порогами (0.85 — «начертание
-- номера отличается», ниже — «номер совпал не полностью»). Перевод числа в
-- довод обратно не восстанавливает: на папке «ИД Мастер апрель 2026» сорок
-- строк получили одинаковую подпись «номер совпал не полностью — проверьте
-- документ», хотя двадцать из них — приложения без своего номера, а восемь —
-- один и тот же сертификат, набранный в описи двумя раскладками.
--
-- Поэтому решение сверки теперь хранит:
--   * `matched_by`   — КТО решил: лестница номеров или модель;
--   * `match_basis`  — ПО ЧЕМУ решено: признак, а не автор;
--   * `match_note`   — довод словами, для человека;
--   * `checks`       — проверки СОДЕРЖАНИЯ строки: верно ли она описывает
--                      найденный документ (организация, ссылка на акт, форма
--                      номера, даты, листы);
--   * `row_anchors`  — где в тексте описи лежат её ячейки, чтобы замечание
--                      могло сослаться на обе стороны расхождения;
--   * `match_ai_run_id` — вызов модели, которым решение получено.
--
-- ## Почему появилось состояние `undetermined`
--
-- «Документ не найден» и «портал не смог найти» — разные утверждения, а
-- состояние было одно: `missing`. Правило REG.110 отвечает на `missing`
-- замечанием «в комплекте не найден документ», отчёт печатает «нет в
-- комплекте», и оба утверждают отсутствие бумаги. Между тем строка остаётся
-- ненайденной и когда выборка кандидатов оказалась не той (документ лежит в
-- чужом разделе описи), и когда данных для решения не хватило, и когда модель
-- недоступна. Объявлять в этих случаях отсутствие — обвинять комплект в
-- границах собственного поиска.
--
-- `undetermined` и есть эта разница: «не сопоставлено» вместо «нет в папке».
-- Утверждать отсутствие вправе только тот, кто искал по всей папке.
--
-- ## Почему основания перечислены, а не свободный текст
--
-- Та же причина, что в 0072: основание уходит в отчёт и переводится на русский
-- разбором по вариантам. Значение, о котором разбор не знает, — пустая строка
-- в объяснении «почему портал считает документ подходящим». Перечисление
-- закрыто и сверяется с кодом тестом (`match-basis.test.ts`).
--
-- `llm` основанием НЕ является: это автор решения, и для него есть
-- `matched_by`. Признак, по которому решено, у модели тот же, что у лестницы, —
-- номер, партия, наименование с датой, приложение при родителе.

ALTER TABLE registry_rows
  ADD COLUMN matched_by       text  NOT NULL DEFAULT 'rule',
  ADD COLUMN match_basis      text,
  ADD COLUMN match_note       text,
  ADD COLUMN match_ai_run_id  uuid,
  ADD COLUMN checks           jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN row_anchors      jsonb;

ALTER TABLE registry_rows
  ADD CONSTRAINT registry_rows_matched_by_chk CHECK (matched_by IN ('rule', 'llm'));

ALTER TABLE registry_rows
  ADD CONSTRAINT registry_rows_match_basis_chk
    CHECK (match_basis IS NULL OR match_basis IN ('doc_no', 'annex_pages', 'batch_no', 'name_and_date'));

-- Довод без решения — след разбора, который ничего не решил: он допустим у
-- любого состояния, поэтому связь односторонняя. А вот основание без
-- найденного документа бессмысленно: основание отвечает на вопрос «почему
-- ЭТОТ документ», и без документа вопроса нет.
ALTER TABLE registry_rows
  ADD CONSTRAINT registry_rows_basis_needs_match_chk
    CHECK (match_basis IS NULL OR matched_document_id IS NOT NULL);

-- Проверки содержания — всегда массив, даже пустой: «портал не нашёл
-- расхождений» и «портал не проверял» различаются не здесь, а состоянием
-- строки и журналом прогона.
ALTER TABLE registry_rows
  ADD CONSTRAINT registry_rows_checks_array_chk CHECK (jsonb_typeof(checks) = 'array');

ALTER TABLE registry_rows
  ADD CONSTRAINT registry_rows_row_anchors_object_chk
    CHECK (row_anchors IS NULL OR jsonb_typeof(row_anchors) = 'object');

ALTER TABLE registry_rows
  ADD CONSTRAINT registry_rows_match_ai_run_fk
    FOREIGN KEY (match_ai_run_id) REFERENCES ai_runs(id) ON DELETE SET NULL;

ALTER TABLE registry_rows DROP CONSTRAINT registry_rows_match_state_chk;

ALTER TABLE registry_rows ADD CONSTRAINT registry_rows_match_state_chk
  CHECK (match_state IN ('matched', 'missing', 'extra', 'ambiguous', 'candidate', 'undetermined'));

-- Основания кандидата пополняются теми же двумя признаками: документ о
-- качестве называет себя номером партии, а строка без номера опознаётся
-- наименованием вместе с датой. Прежде такие кандидаты приходили с основанием
-- `doc_no`, то есть отчёт объяснял их номером, которого в строке нет.
ALTER TABLE registry_row_candidates DROP CONSTRAINT registry_row_candidates_basis_chk;

ALTER TABLE registry_row_candidates ADD CONSTRAINT registry_row_candidates_basis_chk
  CHECK (basis IN ('doc_no', 'doc_type', 'issued_at', 'doc_type_and_issued_at', 'annex_pages',
                   'batch_no', 'name_and_date'));

-- Стадия вызова модели. Список пересоздаётся целиком: CHECK не пополняется
-- частями, и второе место, знающее этот перечень (`LlmStage` в
-- `apps/api/src/llm/port.ts`), сверяется с ним глазами при каждой правке.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_stage_chk;

ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_stage_chk
  CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary',
                   'recognize', 'orientation', 'registry_match'));

ALTER TABLE prompt_templates DROP CONSTRAINT prompt_templates_stage_chk;

ALTER TABLE prompt_templates ADD CONSTRAINT prompt_templates_stage_chk
  CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary',
                   'recognize', 'orientation', 'registry_match'));
