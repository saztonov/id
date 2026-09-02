-- S44. У «портал прочитал иначе» появляется свой код обратной связи.
--
-- ## Что чинится
--
-- `LLM.FILL.020` («извлечённое порталом значение расходится с текстом») — это
-- отчёт о качестве ИЗВЛЕЧЕНИЯ, и с S44 он вынесен из дефектов документа в свой
-- раздел отчёта. Но замечание живёт ровно один прогон: пересегментация или
-- повторная проверка стирают прошлые `findings`, и годового ряда «как часто
-- портал читает неверно и каким промтом» по ним не построить.
--
-- Ряд строит `processing_feedback` — таблица для того и заведена (ADR-0010). Ей
-- нужен свой код причины: `extract.field_missing` говорит «реквизит не
-- извлечён», а здесь извлечён, но не тот. Это разные разборы — первое чинят
-- правилом или промтом, второе моделью, — и склеив их, портал потерял бы
-- единственный срез, по которому они различаются.
--
-- В записи только КОД реквизита, никогда его значение: значение — это ПДн
-- (§11), и общая очистка `redactDeep` стоит рубежом поверх дисциплины
-- вызывающего.

ALTER TABLE processing_feedback DROP CONSTRAINT processing_feedback_reason_chk;
ALTER TABLE processing_feedback ADD CONSTRAINT processing_feedback_reason_chk
  CHECK (reason_code IN (
    'vlm.invalid_json',
    'vlm.schema_mismatch',
    'vlm.refusal',
    'vlm.empty_result',
    'extract.field_missing',
    'extract.value_mismatch',
    'classify.low_confidence',
    'detect.no_blocks',
    'detect.low_score',
    'detect.no_stamp',
    'match.ambiguous',
    'doc_split.unassigned_pages',
    'manual.field_corrected',
    'manual.block_redrawn',
    'manual.type_changed',
    'orientation.probe_failed',
    'orientation.low_confidence'));
