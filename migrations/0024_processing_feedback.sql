-- Обратная связь конвейера: дефекты качества обработки (§11, ADR-0010).
--
-- Зачем отдельная таблица, когда журнал ошибок уже есть.
--   Журнал ошибок регистрирует ИСКЛЮЧЕНИЯ. Промт же портится не падением, а
--   формально успешным неправильным результатом: модель вернула JSON не по
--   схеме, отказалась отвечать, оставила поле пустым, детектор не нашёл ни
--   одной обводки. Ничего из этого объектом Error не является и в
--   error_signatures не попадает по построению — сегодня такие дефекты видны
--   только счётчиками blocks_invalid/blocks_refused в recognition_run_pages,
--   без причины и без привязки к версии промта.
--
-- Почему нельзя было доложить это в error_samples.
--   У них противоположная политика записи. Примеры ПРОРЕЖИВАЮТСЯ: их задача —
--   дать контекст для разбора, а не сосчитать. Дефекты качества прореживать
--   нельзя: «какая версия промта чаще даёт невалидный JSON» — это доля, и
--   выборка вместо полного ряда отвечает на неё неверно. Две политики записи в
--   одной таблице — дефект, который проявится не сразу, а на первом же выводе,
--   сделанном по неполным данным.
--
-- Почему reason_code — закрытый перечень, а не текст.
--   По нему строится годовой ряд «доля дефектов у промта X версии N». Текст
--   сообщения меняется от правки формулировки, и ряд разрывается в момент,
--   когда его впервые захотят посмотреть.
--
-- Почему ссылки без внешних ключей.
--   Набор данных обязан пережить сборку мусора ревизии: удаление старой
--   поставки не должно обнулять статистику, по которой дорабатывают промты.
--   Тот же приём, что у audit_log.object_id и error_samples.
--
-- Чего здесь НЕТ: входа и выхода модели, текста страницы, кропа, presigned URL.
--   §11 относит их к ПДн и секретам, а таблица живёт два года.
--   Воспроизводимость дают ai_runs.input_hash/output_hash и artifact_versions,
--   а сам кроп инженер открывает в портале по layout_block_id.

CREATE TABLE processing_feedback (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                     timestamptz NOT NULL DEFAULT now(),

  -- Крупная категория: чем этот сигнал является. `manual_correction` — правка
  -- человека, самый ценный вид: инженер проставляет правильный ответ там, где
  -- модель ошиблась.
  feedback_type          text NOT NULL,
  -- Причина из закрытого перечня. Ключ агрегации.
  reason_code            text NOT NULL,
  severity               text NOT NULL DEFAULT 'warn',

  -- Предмет. Без FK, см. заголовок.
  revision_id            uuid,
  recognition_run_id     uuid,
  source_page_id         uuid,
  working_page_index     integer,
  layout_block_id        uuid,
  -- Код реквизита (имя поля), а не его значение: значение — это ПДн.
  field_code             text,
  finding_id             uuid,
  job_run_id             uuid,
  -- Строка ai_runs того же вызова: по ней доступны хэши входа и выхода.
  ai_run_id              uuid,

  -- Провенанс: чем именно получен результат. Ради этих колонок таблица и
  -- заведена — без версии инструмента дефект не приводит ни к какому решению.
  doc_type_code          text,
  pipeline_stage         text,
  provider               text,
  model                  text,
  prompt_code            text,
  prompt_version         integer,
  detector_model_version text,
  ruleset_version        text,
  app_release            text,

  -- Уверенность, если стадия её знает (классификация, детекция).
  score                  double precision,
  -- Что наблюдалось и что ожидалось: КОДЫ, счётчики и геометрия, не значения.
  observed               jsonb,
  expected               jsonb,
  request_id             text,

  CONSTRAINT processing_feedback_type_chk CHECK (feedback_type IN (
    'system_failure', 'recognition_failure', 'wrong_extraction', 'check_error',
    'manual_correction')),
  CONSTRAINT processing_feedback_reason_chk CHECK (reason_code IN (
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
    'manual.type_changed')),
  CONSTRAINT processing_feedback_severity_chk CHECK (severity IN ('info', 'warn', 'error')),
  -- Стадия конвейера (§12) плюс две стадии, которых в ProcessingStage нет,
  -- потому что там перечислены состояния поставки, а не шаги обработки.
  CONSTRAINT processing_feedback_stage_chk CHECK (pipeline_stage IS NULL OR pipeline_stage IN (
    'uploaded', 'layout', 'recognition', 'analysis', 'checks', 'ready', 'failed',
    'detect', 'match')),
  CONSTRAINT processing_feedback_score_chk
    CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  CONSTRAINT processing_feedback_page_chk
    CHECK (working_page_index IS NULL OR working_page_index >= 0),
  CONSTRAINT processing_feedback_prompt_version_chk
    CHECK (prompt_version IS NULL OR prompt_version > 0)
);

-- Лента и срезы. Индекс по паре (промт, версия) — основной рабочий запрос:
-- «что даёт эта версия промта»; по нему же считается доля.
CREATE INDEX ix_processing_feedback_at ON processing_feedback (at DESC);
CREATE INDEX ix_processing_feedback_reason ON processing_feedback (reason_code, at DESC);
CREATE INDEX ix_processing_feedback_prompt
  ON processing_feedback (prompt_code, prompt_version, at DESC);
CREATE INDEX ix_processing_feedback_stage ON processing_feedback (pipeline_stage, at DESC);
CREATE INDEX ix_processing_feedback_doc_type ON processing_feedback (doc_type_code, at DESC);
CREATE INDEX ix_processing_feedback_revision ON processing_feedback (revision_id, at DESC);
CREATE INDEX ix_processing_feedback_block ON processing_feedback (layout_block_id)
  WHERE layout_block_id IS NOT NULL;
