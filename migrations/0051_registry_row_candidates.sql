-- Кандидаты строки реестра приложений (S34).
--
-- ## Зачем состояние между «нашли» и «нет в комплекте»
--
-- Сверка идёт по номеру, и это правильно: реестр заполняется подрядчиком
-- вручную и обобщает наименования до неразличимости (`0005`, `match.ts`). Но
-- когда номер не ответил, у строки остаётся два разных исхода, которые до сих
-- пор сливались в один. «Документа с таким номером в комплекте нет» — вывод.
-- «Номер не прочитан, но в комплекте лежит документ того же вида и той же
-- даты» — не вывод, а наблюдение, и выдавать его за вывод нельзя ни в ту, ни
-- в другую сторону.
--
-- Отсюда состояние `candidate`. Оно НЕ выбирает документ: `matched_document_id`
-- у него пуст, и ребро графа `акт → документ` по нему не строится. Разница не
-- косметическая: ребро читают правила дат (§9.2), и совпадение, полученное по
-- виду документа, молча превратилось бы в основание для `fail` о просроченном
-- сертификате.
--
-- ## Почему таблица, а не массив идентификаторов
--
-- Массив `uuid[]` в `registry_rows` был бы короче на одну таблицу и хуже по
-- трём причинам сразу. Он не удерживает ссылку в СВОЮ ревизию — составного
-- внешнего ключа у элемента массива не бывает, а `registry_rows` этот инвариант
-- держит с самого начала (`registry_rows_matched_document_fk`). Он не хранит
-- ОСНОВАНИЕ, по которому документ признан похожим, — а «похож» без названной
-- причины проверяющему бесполезен ровно так же, как замечание без подсказки.
-- И он не даёт упорядочить кандидатов по силе основания.
--
-- ## Почему у таблицы нет собственного триггера неизменяемости
--
-- Он не нужен: кандидаты живут и умирают вместе со своей строкой реестра, а
-- та уже под `registry_rows_revision_locked` (0008, класс `derived`). Каскад
-- по `registry_row_id` делает вычистку при пересчёте частью удаления строки.

-- =====================================================================
-- 1. Новое состояние сверки
-- =====================================================================

-- `candidate` дополняет перечисление, а не заменяет ничего: `missing` остаётся
-- ответом там, где похожего документа нет вовсе.
--
-- `registry_rows_matched_chk` не трогается намеренно. Он требует документ у
-- `matched`, а `candidate` документа не выбирает по построению — ограничение
-- остаётся верным без единой правки.
ALTER TABLE registry_rows DROP CONSTRAINT registry_rows_match_state_chk;

ALTER TABLE registry_rows ADD CONSTRAINT registry_rows_match_state_chk
  CHECK (match_state IN ('matched', 'missing', 'extra', 'ambiguous', 'candidate'));

-- =====================================================================
-- 2. Кандидаты
-- =====================================================================

CREATE TABLE registry_row_candidates (
  revision_id     uuid NOT NULL REFERENCES submission_revisions (id) ON DELETE CASCADE,
  registry_row_id uuid NOT NULL,
  document_id     uuid NOT NULL,
  -- Основание закрытым перечислением: оно уходит в отчёт дословно.
  basis           text NOT NULL,
  score           double precision NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT registry_row_candidates_pk PRIMARY KEY (registry_row_id, document_id),
  CONSTRAINT registry_row_candidates_basis_chk
    CHECK (basis IN ('doc_no', 'doc_type', 'issued_at', 'doc_type_and_issued_at')),
  CONSTRAINT registry_row_candidates_score_chk
    CHECK (score >= 0 AND score <= 1),
  CONSTRAINT registry_row_candidates_row_fk
    FOREIGN KEY (registry_row_id)
    REFERENCES registry_rows (id) ON DELETE CASCADE,
  -- Кандидат не может указывать на документ чужой ревизии — тот же инвариант
  -- и тем же способом, что у `registry_rows_matched_document_fk`.
  CONSTRAINT registry_row_candidates_document_fk
    FOREIGN KEY (revision_id, document_id)
    REFERENCES logical_documents (revision_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_registry_row_candidates_revision ON registry_row_candidates (revision_id);
CREATE INDEX ix_registry_row_candidates_document ON registry_row_candidates (document_id);
