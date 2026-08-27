-- S37. Стадия конвейера в списке комплектов и исполнитель, прочитанный из акта.
--
-- Три независимых изменения, объединённые одним потоком работ.
--
-- ## 1. Индекс очереди по ревизии
--
-- `jobs` ссылается на ревизию через `payload ->> 'revisionId'`, без внешнего
-- ключа: тип задачи определяет форму полезной нагрузки, и колонки под ревизию у
-- очереди нет по построению. Отбор по этому выражению делали и раньше
-- (`computeProcessingStatus`, `computeLayoutProgress`, `cancelJobsOfRevision`),
-- но по одной ревизии и по требованию человека — то есть редко.
--
-- Список комплектов объекта спрашивает то же самое по ВСЕЙ странице и обновляет
-- опросом, пока хоть один комплект в работе. Без индекса это постоянный
-- последовательный просмотр очереди.
--
-- Индекс частичный по той же причине, по которой запрос отбирает те же три
-- статуса: завершённые и отменённые задачи не спрашивает никто, а очередь
-- накапливает их тысячами.
CREATE INDEX ix_jobs_revision
  ON jobs ((payload ->> 'revisionId'))
  WHERE status IN ('queued', 'running', 'failed');

-- ## 2. Исполнитель, подставленный порталом
--
-- `works.contractor_id` остаётся NOT NULL, и это не осторожность. Составной
-- внешний ключ `submission_revisions_scope_fk (work_id, object_id,
-- contractor_id)` работает в режиме MATCH SIMPLE: NULL в одной колонке отключает
-- проверку ЦЕЛИКОМ, вместе с `work_id` и `object_id`. Обнулив исполнителя, мы
-- сняли бы третий уровень изоляции (§4.1) молча.
--
-- Поэтому «портал ещё не знает исполнителя» выражается не пустотой, а
-- признаком. Он же — то, что делает подставленное значение ОТЛИЧИМЫМ от
-- прочитанного: выдуманное значение, неотличимое от факта, — ровно тот дефект,
-- ради которого месяц комплекта стал выводиться из акта (ADR-0019).
ALTER TABLE works
  ADD COLUMN contractor_assumed boolean NOT NULL DEFAULT false,
  -- Что написано в акте, если сопоставить со справочником не удалось. Без этого
  -- поля экран не смог бы отличить «модель не назвала организацию» от
  -- «организация названа, но её нет в справочнике», и оба случая печатались бы
  -- как «После OCR» — то есть как незаконченная работа портала.
  ADD COLUMN contractor_raw text,
  -- Файл описи реестра исполнителя не подставляет: он подаётся организацией,
  -- которая ведёт папку, и это не догадка.
  ADD CONSTRAINT works_contractor_assumed_chk
    CHECK (NOT contractor_assumed OR kind = 'complect');

COMMENT ON COLUMN works.contractor_assumed IS
  'Исполнитель подставлен порталом из карточки объекта, а не назван человеком и не прочитан из акта.';
COMMENT ON COLUMN works.contractor_raw IS
  'Наименование исполнителя из акта, которое не удалось сопоставить со справочником.';

-- ## 3. Отсрочка составных ключей области
--
-- `contractor_id` денормализован вниз по дереву, и все четыре ключа объявлены
-- NOT DEFERRABLE. Значит порядка, в котором проходит замена исполнителя, НЕ
-- СУЩЕСТВУЕТ: `UPDATE works` первым даёт отказ от ревизий, `UPDATE
-- submission_revisions` первым — от works.
--
-- `DEFERRABLE INITIALLY IMMEDIATE` инвариант не ослабляет: проверка остаётся, а
-- отложить её может только тот, кто явно попросил `SET CONSTRAINTS ... DEFERRED`
-- внутри своей транзакции. Всем остальным путям поведение не меняется вовсе.
--
-- Ключи названы ПОИМЁННО и в коде тоже: `SET CONSTRAINTS ALL DEFERRED` отсрочил
-- бы и то, о чём никто не думал.
ALTER TABLE submission_revisions
  ALTER CONSTRAINT submission_revisions_scope_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE logical_documents
  ALTER CONSTRAINT logical_documents_scope_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE findings
  ALTER CONSTRAINT findings_scope_fk DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE submission_archives
  ALTER CONSTRAINT submission_archives_scope_fk DEFERRABLE INITIALLY IMMEDIATE;
