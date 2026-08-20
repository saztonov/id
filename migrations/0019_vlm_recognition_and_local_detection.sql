-- VLM-распознавание через proxy_llm и локальная детекция RF-DETR (ADR-0007, ADR-0008).
--
-- Прогон распознавания получает второй маршрут: вместо экспорта RD WEB —
-- кропы блоков замороженной разметки в VLM через корпоративный шлюз, ответ
-- строго структурированным JSON, публикация одной финальной транзакцией.
-- Детекция блоков получает локальный маршрут: RF-DETR (ONNX) на CPU воркера.

-- 1. Стадия распознавания. Вызовы VLM журналируются в ai_runs той же строкой,
-- что и текстовые стадии, — им нужна собственная стадия, а не подмена под
-- extract. Провайдер остаётся proxy_llm: канал не меняется (§10, ADR-0007).
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_stage_chk;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_stage_chk
  CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary', 'recognize'));

-- Промты распознавания живут в том же governance, что и остальные
-- (draft → test → published → archived), под новой стадией.
ALTER TABLE prompt_templates DROP CONSTRAINT prompt_templates_stage_chk;
ALTER TABLE prompt_templates ADD CONSTRAINT prompt_templates_stage_chk
  CHECK (stage IN ('page_classify', 'doc_split', 'extract', 'check', 'summary', 'recognize'));

-- 2. Канонический артефакт (ADR-0006 §6 — отложенный enum получает потребителя):
-- сериализованный RecognitionResult v2, единственный источник правды прогона VLM.
ALTER TABLE artifact_versions DROP CONSTRAINT artifact_versions_kind_chk;
ALTER TABLE artifact_versions ADD CONSTRAINT artifact_versions_kind_chk
  CHECK (kind IN ('zip', 'md', 'html', 'blocks_json', 'qa', 'canonical'));

-- 3. Версия рендера текста страницы — парная к offset_convention: от текста
-- зависят все смещения (цитаты классификации, char_span реквизитов), и вторая
-- версия рендера обязана быть отличима от первой. Существующие строки legacy
-- корректно попадают под v1: правило 1 рендера — «дословно как в экспорте».
ALTER TABLE page_text_versions
  ADD COLUMN render_version text NOT NULL DEFAULT 'recognition.page_text.v1';
ALTER TABLE page_text_versions ADD CONSTRAINT page_text_versions_render_version_chk
  CHECK (render_version ~ '^[a-z0-9][a-z0-9._-]*$');

-- 4. У VLM-прогона RD-документа нет. Составной FK recognition_runs_rd_document_fk
-- при NULL в rd_run_document_id не срабатывает (MATCH SIMPLE) — это законно.
ALTER TABLE recognition_runs ALTER COLUMN rd_run_document_id DROP NOT NULL;

-- 5. Состояние страниц прогона VLM. Прогресс и финализация читаются отсюда,
-- а не из payload'ов очереди задач: очередь — механизм доставки, а не журнал
-- фактов. Терминальность строки (done/failed) — условие, по которому
-- финализатор решает «ещё идёт» против «покрытие неполно».
CREATE TABLE recognition_run_pages (
  recognition_run_id uuid NOT NULL REFERENCES recognition_runs (id),
  working_page_index integer NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  blocks_total       integer NOT NULL DEFAULT 0,
  blocks_recognized  integer NOT NULL DEFAULT 0,
  blocks_invalid     integer NOT NULL DEFAULT 0,
  blocks_refused     integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recognition_run_id, working_page_index),
  CONSTRAINT recognition_run_pages_page_chk CHECK (working_page_index >= 0),
  CONSTRAINT recognition_run_pages_status_chk CHECK (status IN ('pending', 'done', 'failed')),
  CONSTRAINT recognition_run_pages_counts_chk CHECK (
    blocks_total >= 0 AND blocks_recognized >= 0 AND blocks_invalid >= 0 AND blocks_refused >= 0)
);

-- 6. Один результат на блок в прогоне — гарантия БД, а не проверка приложения:
-- повторная аренда задачи после смерти воркера пишет через ON CONFLICT DO
-- NOTHING и не создаёт ни дублей, ни второго платного вызова. Legacy-путь
-- инвариант уже соблюдает (saveResults дедуплицирует по прогону).
ALTER TABLE block_results
  ADD CONSTRAINT block_results_run_block_uq UNIQUE (recognition_run_id, layout_block_id);

-- 7. Локальный детектор, в отличие от легаси-API RD WEB, знает уверенность и
-- версию модели. Колонки nullable: блоки от RD WEB и ручные честно хранят NULL
-- (см. комментарий к detector_provenance в 0004 — «вечно NULL» перестало быть
-- правдой ровно потому, что появился источник значения).
ALTER TABLE layout_blocks ADD COLUMN detection_score double precision;
ALTER TABLE layout_blocks ADD COLUMN detection_model_version text;
ALTER TABLE layout_blocks ADD CONSTRAINT layout_blocks_detection_score_chk
  CHECK (detection_score IS NULL OR (detection_score >= 0 AND detection_score <= 1));
