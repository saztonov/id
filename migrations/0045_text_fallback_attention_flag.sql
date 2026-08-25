-- Флаг внимания «страница распознана целиком» (§7.3, S27).
--
-- Распознавание идёт по блокам: страница, на которой детекция ничего не нашла,
-- не получала ни строки текста, а дальше её не видел ни классификатор, ни
-- сегментация — комплект молча терял напечатанный на ней документ. Выход был
-- один и ручной: открыть «Разметку» и нажать «Заменить страницу одним блоком»
-- на каждой такой странице.
--
-- Теперь это делает конвейер (`applyTextCoverageFallback`, вызывается перед
-- заморозкой разметки), и `text_fallback_applied` отмечает, где именно.
--
-- Флаг нужен, потому что заплатка — не рядовой исход. Полностраничный кроп
-- читается моделью хуже прицельного: мелкий шрифт сертификата на нём уже у
-- границы разборчивости. Ошибкой это не является — без заплатки текста не было
-- бы вовсе, — но проверяющий обязан знать, где портал распознавал вслепую.
--
-- Перечисление закрытое и проверяется поэлементно (`<@`), поэтому расширяется
-- только миграцией. Значение синхронно с `attentionFlagSchema`
-- (`packages/contracts/src/enums.ts`).

ALTER TABLE source_pages DROP CONSTRAINT source_pages_attention_flags_chk;
ALTER TABLE source_pages ADD CONSTRAINT source_pages_attention_flags_chk CHECK (
  attention_flags <@ ARRAY[
    'no_blocks', 'low_coverage', 'suspicious_overlap', 'bbox_out_of_page',
    'degenerate_geometry', 'tiny_block', 'neighbor_mismatch', 'blank_page_candidate',
    'missing_expected_stamp', 'layout_hash_mismatch', 'text_fallback_applied']::text[]);
