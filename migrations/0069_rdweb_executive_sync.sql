-- S52. Снимок исполнительной документации в RD WEB: контракт document-sync v1.
--
-- ## Что происходит
--
-- RD WEB сменил контракт. Прежний маршрут — вход по логину-паролю, дерево
-- проектов, постраничная детекция, `jobs`/`export` — снимается целиком: выданное
-- удостоверение к нему не подходит вовсе. Новый маршрут устроен наоборот:
-- портал отправляет исходный PDF и ПОЛНЫЙ снимок обведённых блоков, а RD WEB сам
-- строит вырезы, сам выбирает модель и сам решает, что действительно требует
-- повторного распознавания.
--
-- Отсюда три таблицы. Все они существуют ради одного свойства контракта:
-- распознаётся не всё, а только изменившееся. Свойство держится на том, что
-- внешний идентификатор блока СТАБИЛЕН между отправками, — а стабильного
-- идентификатора блока у портала не было.
--
-- ## Почему нельзя было взять `layout_blocks.id`
--
-- Потому что он не переживает повторное распознавание. `PIPELINE_RESET_DELETES`
-- (`purge.ts`) сносит `block_results`, после чего `importDetectedBlocks` сносит
-- блоки `source='auto'` и вставляет их заново — с новыми `uuid` при той же
-- геометрии. Для RD WEB это `new_block` по каждому блоку, то есть повторная
-- оплата распознавания всего комплекта на ровном месте.
--
-- Геометрия, в свою очередь, не переживает правку рамки: там `uuid` как раз
-- сохраняется (`updateLayoutBlock` правит строку на месте), а геометрия меняется.
--
-- Ни один ключ по отдельности не покрывает оба случая, поэтому сопоставление
-- двухпроходное и живёт в `rd_exec_blocks`: сперва по `layout_block_id` (правка
-- рамки — тот же блок с новой `revision`, §17 п. 3), затем по `geometry_key`
-- (переразметка — тот же блок, `revision` не меняется, RD WEB отвечает
-- `unchanged` и не берёт денег).
--
-- ## Чего здесь НЕТ
--
-- Таблицы результатов блока. Результаты идут в существующий `block_results`
-- конвертом в `content_json`, а решение RD WEB по блоку (`status`,
-- `reconciliation_action`, `reconciliation_reason`, `reused_without_model`)
-- живёт в провенансе того же конверта. Вторая таблица результатов была бы вторым
-- источником правды об одном факте.
--
-- `rd_run_documents` не удаляется: на неё ссылается
-- `recognition_runs.rd_run_document_id` прошлых прогонов, и снос уничтожил бы
-- доказательство «чем распознавали полгода назад». Таблица становится
-- write-never — писатели уходят вместе с кодом легаси-маршрута.

-- ---------------------------------------------------------------------------
-- 1. Логический документ: одна строка на папку.
--
-- Логический документ контракта — это ПАПКА, а не рабочий PDF: контракт
-- различает документ («лист АР-01») и его редакцию, и у нас это различие уже
-- есть — папка живёт, `processing_bundles` пересобирается. Возьми мы bundle,
-- каждая пересборка давала бы новый документ, все блоки — `new_block`, и вся
-- экономия контракта исчезла бы в первый же день.
-- ---------------------------------------------------------------------------

CREATE TABLE rd_exec_documents (
  folder_id            uuid PRIMARY KEY,
  -- Денормализованный объект: тем же приёмом и по той же причине, что у
  -- `layout_blocks` — составной ключ не даёт строке уехать в чужую область.
  object_id            uuid NOT NULL,
  external_project_id  text NOT NULL,
  external_document_id text NOT NULL,

  -- Счётчики контракта (§2). Монотонность держится оператором «+1 ... RETURNING»
  -- в одной транзакции с созданием строки отправки и уникальностью
  -- (folder_id, sync_generation) на ней: два параллельных прогона одной папки
  -- не получат одну генерацию.
  sync_generation      bigint NOT NULL DEFAULT 0,
  -- Генерация, которую сервер ПРИНЯЛ (init прошёл без 409), а не «последняя
  -- завершённая»: §4 требует строить снимок поверх принятого.
  base_generation      bigint NOT NULL DEFAULT 0,
  next_block_seq       bigint NOT NULL DEFAULT 1,

  -- Человеческая метка редакции PDF («R17»). Счётчик, а не хеш: контракт зовёт
  -- поле человеческой меткой, и «R3» в их интерфейсе читается, а «b7f1a2c9» нет.
  pdf_revision_no      integer NOT NULL DEFAULT 0,
  last_pdf_sha256      text,

  -- Снимок разошёлся с сервером (409, §9). Повторять тот же запрос контракт
  -- запрещает прямо (§17 п. 6), поэтому признак поднимается, а пересборку
  -- делает отдельная задача.
  resync_required      boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rd_exec_documents_scope_fk
    FOREIGN KEY (folder_id, object_id) REFERENCES folders (id, object_id),
  CONSTRAINT rd_exec_documents_external_uq UNIQUE (external_document_id),
  CONSTRAINT rd_exec_documents_project_chk
    CHECK (length(external_project_id) BETWEEN 1 AND 128),
  CONSTRAINT rd_exec_documents_document_chk
    CHECK (length(external_document_id) BETWEEN 1 AND 128),
  CONSTRAINT rd_exec_documents_generation_chk
    CHECK (sync_generation >= base_generation AND base_generation >= 0),
  CONSTRAINT rd_exec_documents_seq_chk CHECK (next_block_seq > 0),
  CONSTRAINT rd_exec_documents_pdf_sha_chk
    CHECK (last_pdf_sha256 IS NULL OR last_pdf_sha256 ~ '^[0-9a-f]{64}$'),
  -- Метка редакции и хеш появляются вместе: «редакция R3 неизвестно чего» —
  -- это не состояние, а потерянная запись.
  CONSTRAINT rd_exec_documents_pdf_rev_chk
    CHECK ((pdf_revision_no = 0) = (last_pdf_sha256 IS NULL))
);

CREATE INDEX ix_rd_exec_documents_object ON rd_exec_documents (object_id);

-- ---------------------------------------------------------------------------
-- 2. Реестр устойчивой идентичности блока.
-- ---------------------------------------------------------------------------

CREATE TABLE rd_exec_blocks (
  folder_id                  uuid NOT NULL
    REFERENCES rd_exec_documents (folder_id) ON DELETE CASCADE,
  external_block_id          text NOT NULL,

  -- sha256 канонической строки геометрии (`geometryKey`, `layout.ts`). Второй
  -- канонизации геометрии в проекте быть не должно: она разошлась бы с первой
  -- молча, а расхождение здесь означает повторную оплату распознавания.
  geometry_key               text NOT NULL,
  -- sha256 ВСЕЙ объявленной проекции блока, включая display_name, sort_order и
  -- metadata. Шире геометрии намеренно: §7 относит такие правки к
  -- `metadata_only` и задачи не создаёт, то есть лишний подъём `revision`
  -- бесплатен, а НЕ поднять revision стоит 409 `block_revision_conflict` и
  -- пересборки снимка. Асимметрия цены и решает.
  declared_sha256            text NOT NULL,
  revision                   integer NOT NULL DEFAULT 1,

  -- Текущая строка разметки. NULL — блок пережил снос строки переразметкой:
  -- идентичность в этот момент держится `geometry_key`, и это штатное
  -- состояние, а не потеря.
  layout_block_id            uuid,
  working_page_index         integer NOT NULL,
  block_type                 text NOT NULL,

  first_announced_generation bigint NOT NULL,
  last_announced_generation  bigint NOT NULL,
  -- Блок исчез из снимка. Строка остаётся: «блока нет, потому что вы его
  -- удалили» и «блока нет, потому что мы его потеряли» — разные факты (§14).
  deleted_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (folder_id, external_block_id),
  -- ON DELETE SET NULL, а не CASCADE: переразметка не имеет права стирать
  -- внешнюю идентичность — реестр ради того и заведён, чтобы её пережить.
  --
  -- Список колонок у SET NULL обязателен, и это не украшение: без него
  -- PostgreSQL обнуляет ВСЕ колонки ключа, то есть заодно и `folder_id`, у
  -- которого стоит NOT NULL. Удаление строки разметки падало бы с «null value
  -- in column folder_id» — проверено тестом реестра на pglite. Синтаксис
  -- доступен с PostgreSQL 15; на боевом кластере 17.10.
  CONSTRAINT rd_exec_blocks_layout_fk
    FOREIGN KEY (folder_id, layout_block_id)
    REFERENCES layout_blocks (folder_id, id) ON DELETE SET NULL (layout_block_id),
  CONSTRAINT rd_exec_blocks_revision_chk CHECK (revision > 0),
  CONSTRAINT rd_exec_blocks_page_chk CHECK (working_page_index >= 0),
  CONSTRAINT rd_exec_blocks_type_chk CHECK (block_type IN ('text', 'image', 'stamp')),
  CONSTRAINT rd_exec_blocks_geometry_chk CHECK (geometry_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rd_exec_blocks_declared_chk CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rd_exec_blocks_id_len_chk CHECK (length(external_block_id) BETWEEN 1 AND 128),
  CONSTRAINT rd_exec_blocks_generation_chk
    CHECK (last_announced_generation >= first_announced_generation
       AND first_announced_generation > 0)
);

-- Одна строка разметки не может быть двумя внешними блоками.
CREATE UNIQUE INDEX ux_rd_exec_blocks_layout
  ON rd_exec_blocks (folder_id, layout_block_id)
  WHERE layout_block_id IS NOT NULL;

-- Рабочий запрос второго прохода сопоставления.
CREATE INDEX ix_rd_exec_blocks_geometry
  ON rd_exec_blocks (folder_id, geometry_key)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Журнал отправок.
--
-- Строка пишется ДО сетевого вызова: `external_sync_id` — ключ идемпотентности,
-- и отправка, не дошедшая до ответа, обязана лечиться повтором с тем же ключом,
-- а не потерей самого ключа. Тем же приёмом и по той же причине
-- `rd_run_documents` писалась до PUT (ADR-0004 §2).
-- ---------------------------------------------------------------------------

CREATE TABLE rd_exec_syncs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id          uuid NOT NULL REFERENCES rd_exec_documents (folder_id) ON DELETE CASCADE,
  recognition_run_id uuid,

  external_sync_id   text NOT NULL,
  sync_generation    bigint NOT NULL,
  base_generation    bigint NOT NULL,
  manifest_sha256    text NOT NULL,
  document_sha256    text NOT NULL,
  document_revision  text NOT NULL,
  blocks_count       integer NOT NULL,

  remote_sync_id     text,
  duplicate          boolean,
  upload_required    boolean,
  -- Круг «загрузили -> complete сказал upload_not_verified». Ровно один, иначе
  -- цикл крутился бы на битом объекте в хранилище.
  upload_attempts    integer NOT NULL DEFAULT 0,

  state              text NOT NULL DEFAULT 'preparing',
  -- Состояние ИХ стороны, как оно пришло. Хранится строкой без CHECK: перечень
  -- §11 принадлежит контракту, и новое значение обязано доехать до журнала, а
  -- не отвергнуться нашей базой.
  remote_state       text,
  all_terminal       boolean,
  all_successful     boolean,
  counters           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code         text,
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rd_exec_syncs_run_fk
    FOREIGN KEY (folder_id, recognition_run_id) REFERENCES recognition_runs (folder_id, id),
  CONSTRAINT rd_exec_syncs_external_uq UNIQUE (folder_id, external_sync_id),
  CONSTRAINT rd_exec_syncs_generation_uq UNIQUE (folder_id, sync_generation),
  CONSTRAINT rd_exec_syncs_state_chk CHECK (state IN (
    'preparing', 'initialized', 'uploaded', 'completed', 'terminal', 'conflict')),
  CONSTRAINT rd_exec_syncs_manifest_chk CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rd_exec_syncs_document_chk CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rd_exec_syncs_counts_chk CHECK (blocks_count >= 0 AND upload_attempts >= 0),
  CONSTRAINT rd_exec_syncs_generation_chk
    CHECK (sync_generation > 0 AND base_generation >= 0 AND sync_generation > base_generation),
  -- Терминальная отправка обязана назвать состояние их стороны: без него
  -- «работа кончилась» неотличимо от «мы перестали спрашивать».
  CONSTRAINT rd_exec_syncs_terminal_chk CHECK (state <> 'terminal' OR remote_state IS NOT NULL)
);

CREATE INDEX ix_rd_exec_syncs_run ON rd_exec_syncs (recognition_run_id)
  WHERE recognition_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Коды обратной связи новой ветки (ADR-0010).
--
-- `suspicious` по §11 успехом НЕ считается: результат получен, но не
-- подтверждён. Текст мы публикуем — потерять распознанное хуже, чем показать
-- сомнительное с пометкой, — но след обязан остаться, иначе «распознано» и
-- «распознано неуверенно» на экране неразличимы.
-- ---------------------------------------------------------------------------

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
    'orientation.low_confidence',
    'rdweb.suspicious',
    'rdweb.block_error',
    'rdweb.block_non_retriable',
    'rdweb.block_unmappable'));

-- ---------------------------------------------------------------------------
-- 5. Детекция через RD WEB снята вместе с легаси-маршрутом.
--
-- У нового контракта детекции нет вовсе: блоки в снимке наши. Значение уходит
-- из перечисления `detection.provider`, и сохранённую строку надо перевести
-- здесь: `readEffectiveSetting` при непрошедшем схему значении молча вернул бы
-- умолчание, то есть настройка выглядела бы «как задана», а действовала иначе.
-- Тот же приём, что в 0040.
-- ---------------------------------------------------------------------------

UPDATE app_settings
   SET value = '"local"'::jsonb, updated_at = now()
 WHERE key = 'detection.provider' AND value = '"rdweb"'::jsonb;
