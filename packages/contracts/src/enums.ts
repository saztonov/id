/**
 * Перечисления доменной модели (§3).
 *
 * Каждое перечисление экспортируется парой «схема + выведенный тип»: схема
 * валидирует границу (HTTP, БД, интеграции), тип используется в коде.
 *
 * Закрытым перечислением становится только то, множество значений чего
 * определяем мы сами. Всё, что расширяется эксплуатацией — разделы,
 * коды видов ИД, коды правил — остаётся строкой с проверкой формата
 * (см. `domain.ts`): портал спроектирован под открытый мир (§0.5), и
 * жёсткий enum на справочнике превратил бы добавление раздела в релиз.
 */

import { z } from 'zod';

// --- Идентичность и доступ (§3.1) ---

/**
 * Бизнес-роль портала.
 *
 * `general_contractor` появился на S19 и не сводится ни к подрядчику, ни к
 * инженеру заказчика: он собирает реестр из комплектов разных исполнителей,
 * грузит подписанный скан и передаёт папку. Права у него подрядческие (грузить и
 * подавать), а область видимости — объектная: все объекты, где он назван
 * генподрядчиком в карточке.
 */
export const userRoleSchema = z.enum([
  'contractor',
  'general_contractor',
  'engineer',
  'manager',
  'admin',
]);
export type UserRole = z.infer<typeof userRoleSchema>;

/*
 * Вид контрагента живёт в `domain.ts` рядом с `codeSlugSchema`: с миграции 0027
 * это справочник `counterparty_kinds`, а не перечисление. Причина — в шапке той
 * же миграции: реестр ИД называет лаборатории, органы по сертификации,
 * метрологов и учебные центры, и каждый новый вид не должен быть релизом.
 */

// --- Жизненный цикл поставки (§3, §10) ---

/**
 * Стадия конвейера (§12).
 *
 * В БД не хранится: это вычисляемая сводка над `job_runs` и состояниями
 * ревизии (§0.3, п.5). Одно хранимое поле скрыло бы попытки и параллельные
 * стадии, а при падении воркера навсегда осталось бы врать.
 */
export const processingStageSchema = z.enum([
  'uploaded',
  'layout',
  'recognition',
  'analysis',
  'checks',
  'ready',
  'failed',
]);
export type ProcessingStage = z.infer<typeof processingStageSchema>;

// --- Файлы и страницы (§3.3, §4.2) ---

export const verifyStateSchema = z.enum(['pending', 'ok', 'quarantined']);
export type VerifyState = z.infer<typeof verifyStateSchema>;

/**
 * Результат структурного зондирования встроенной подписи PDF.
 *
 * Состояний три, а не два: портал не проверяет криптографию (§0.1), поэтому
 * `detected_unverified` означает «словарь подписи в файле есть, но валидность
 * мы не устанавливали», а `unknown` — «файл не разобрался». Булево поле
 * склеило бы «подписи нет» и «не смогли посмотреть» в один ответ.
 */
export const signatureProbeResultSchema = z.enum([
  'none_detected',
  'detected_unverified',
  'unknown',
]);
export type SignatureProbeResult = z.infer<typeof signatureProbeResultSchema>;

/** Флаг внимания на странице разметки (§7.3). Сигнал для человека, не ошибка. */
export const attentionFlagSchema = z.enum([
  'no_blocks',
  'low_coverage',
  'suspicious_overlap',
  'bbox_out_of_page',
  'degenerate_geometry',
  'tiny_block',
  'neighbor_mismatch',
  'blank_page_candidate',
  'missing_expected_stamp',
  'layout_hash_mismatch',
  /**
   * Страница ушла на распознавание ЦЕЛИКОМ: детекция ничего на ней не нашла
   * либо покрыла слишком мало (`applyTextCoverageFallback`).
   *
   * Не ошибка и не отказ: без заплатки страница осталась бы совсем без текста.
   * Но и не рядовой исход — полностраничный кроп читается моделью хуже
   * прицельного, поэтому человек должен знать, где портал распознавал вслепую.
   */
  'text_fallback_applied',
]);
export type AttentionFlag = z.infer<typeof attentionFlagSchema>;

// --- Разметка (§3.4, §5.3) ---

/**
 * Состояние ревизии разметки.
 *
 * `frozen` больше нет (миграция 0048): заморозка была отменена вместе со всем
 * циклом «правка после распознавания — только новой ревизией». Блоки правятся
 * всегда, а хэш набора фиксирует прогон распознавания в момент старта.
 * `superseded` осталось историческим: такие ревизии существуют в уже
 * работавших базах, и их содержимое по-прежнему неизменяемо.
 */
export const layoutRevisionStateSchema = z.enum(['draft', 'superseded']);
export type LayoutRevisionState = z.infer<typeof layoutRevisionStateSchema>;

export const blockTypeSchema = z.enum(['text', 'image', 'stamp']);
export type BlockType = z.infer<typeof blockTypeSchema>;

export const shapeTypeSchema = z.enum(['rectangle', 'polygon']);
export type ShapeType = z.infer<typeof shapeTypeSchema>;

export const blockSourceSchema = z.enum(['auto', 'user']);
export type BlockSource = z.infer<typeof blockSourceSchema>;

/**
 * Происхождение блока.
 *
 * `rf_detr` покрывает обоих поставщиков детекции — легаси-API RD WEB и
 * локальный ONNX-инференс (модель одна и та же): их различает
 * `layout_blocks.detection_score`/`detection_model_version`, которые знает
 * только локальный путь (легаси-API уверенность не отдаёт, у него честный
 * NULL). `unavailable` — честная замена выдуманному числу; `full_page`
 * отмечает блок, которым пользователь заменил всю страницу целиком (§5.3).
 */
export const detectorProvenanceSchema = z.enum(['rf_detr', 'full_page', 'user', 'unavailable']);
export type DetectorProvenance = z.infer<typeof detectorProvenanceSchema>;

/**
 * Разворот СОДЕРЖИМОГО страницы: четверть оборота по часовой стрелке (ADR-0020).
 *
 * Не путать с `/Rotate` из PDF (`source_pages.rotation`): тот уже применён и к
 * размерам карты страниц, и к вьюпорту pdf.js, и к растру poppler. Этот —
 * поправка к скану, легшему на лист боком при нулевом `/Rotate`, и не применён
 * никем. Значение отвечает на вопрос «на сколько повернуть растр, чтобы текст
 * читался нормально».
 *
 * Числа, а не строки: величина арифметическая — её складывают, обращают и
 * передают в `sharp.rotate`.
 */
export const contentRotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);
export type ContentRotation = z.infer<typeof contentRotationSchema>;

/**
 * Кем поставлен разворот.
 *
 * `user` перекрывает `probe` и никогда не перекрывается им обратно — правило
 * живёт в SQL (`ON CONFLICT … WHERE source <> 'user'`), а не в обработчике,
 * чтобы гонка «инженер повернул, пока зонд летел» решалась базой.
 */
export const contentRotationSourceSchema = z.enum(['probe', 'user']);
export type ContentRotationSource = z.infer<typeof contentRotationSourceSchema>;

// --- Распознавание и артефакты (§3.5, §5.2) ---

/**
 * Состояние прогона распознавания.
 *
 * `integrity_error` отделён от `failed`: расхождение локального и удалённого
 * хэша разметки означает, что распознали не то, что заказывали. Результат
 * такого прогона не используется вовсе, тогда как `failed` допускает повтор.
 */
export const recognitionStatusSchema = z.enum(['running', 'done', 'integrity_error', 'failed']);
export type RecognitionStatus = z.infer<typeof recognitionStatusSchema>;

/**
 * `canonical` — сериализованный RecognitionResult v2 (ADR-0006/0007):
 * единственный источник правды VLM-прогона. Остальные виды производит
 * legacy-путь RD WEB.
 */
export const artifactKindSchema = z.enum(['zip', 'md', 'html', 'blocks_json', 'qa', 'canonical']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/**
 * Провайдер РАСПОЗНАВАНИЯ в настройках портала (`recognition.provider`).
 *
 * Это выбор ветки конвейера, а не провайдер канонического результата:
 * `recognitionProviderSchema` из `@id/recognition` (`rdweb_md | openrouter_vlm |
 * synthetic`) описывает источник данных в самом результате, и маппинг между
 * ними явный (`rdweb` → `rdweb_md`). Одно перечисление на два смысла склеило
 * бы настройку с форматом хранения.
 */
export const recognitionProviderSettingSchema = z.enum(['rdweb', 'openrouter_vlm']);
export type RecognitionProviderSetting = z.infer<typeof recognitionProviderSettingSchema>;

/** Провайдер ДЕТЕКЦИИ блоков (`detection.provider`): RD WEB или локальный RF-DETR. */
export const detectionProviderSettingSchema = z.enum(['rdweb', 'local']);
export type DetectionProviderSetting = z.infer<typeof detectionProviderSettingSchema>;

/**
 * Режим инференса детектора (`detection.inference_mode`).
 *
 * `auto` — по режиму сборки датасета обучения из манифеста модели
 * (`tiling.mode`); `tiles` и `whole_page` — принудительный override, тот самый
 * kill-switch, что есть в настройках эталонного RD WEB. Он нужен ровно тогда,
 * когда манифест описывает обучение неверно: инференс обязан идти в масштабе
 * кадра обучения, иначе RF-DETR выдаёт вырожденные боксы ~на весь кадр.
 */
export const detectionInferenceModeSettingSchema = z.enum(['auto', 'tiles', 'whole_page']);
export type DetectionInferenceModeSetting = z.infer<typeof detectionInferenceModeSettingSchema>;

/**
 * Стратегия разметки по формату листа (`detection.sheet_strategy`).
 *
 * `detect_all` — прежнее поведение: детектор идёт по каждой странице и три его
 * класса попадают в разметку как есть. `sheet_aware` — правило форматов: лист
 * A4 и мельче размечается одним текстовым блоком на всю страницу без запуска
 * модели вовсе, а на листе крупнее A4 остаётся только штамп (и, если включена,
 * самая верхняя надпись — она несёт номер листа).
 *
 * Настройка действует на НОВЫЕ ревизии разметки: значение запинывается в
 * `layout_revisions.markup_policy` при создании черновика, и уже начатая
 * разметка переключение не видит. Разбор пина — `parseMarkupPolicy`
 * в `sheet-format.ts`.
 */
export const detectionSheetStrategySchema = z.enum(['sheet_aware', 'detect_all']);
export type DetectionSheetStrategy = z.infer<typeof detectionSheetStrategySchema>;

/**
 * Как искать собственный номер листа на крупном формате
 * (`detection.large_sheet_number_zone`).
 *
 * У исполнительной схемы нет текста, кроме штампа, а в штампе стоит
 * «Обозначение» проекта — общее у всех листов раздела. Номер, которым лист
 * назван в реестре приложений, напечатан вне прямоугольника штампа: замер на
 * двенадцати крупных листах эталонного комплекта показал, что он стоит
 * ЗАГОЛОВКОМ ВВЕРХУ листа.
 *
 * `near_stamp` — оставлять на крупном листе, кроме штампа, один самый верхний
 * текстовый кандидат детектора: его текст доедет до страницы, и номер найдёт то
 * же правило `№ …`, которым портал уже пользуется. `off` — только штамп; номер
 * листа тогда придётся обводить вручную.
 *
 * Имя значения осталось от прежнего правила, искавшего номер в околоштамповой
 * зоне. Оно хранится в настройке и в пине политики, поэтому переименование —
 * это миграция, а не правка строки.
 */
export const largeSheetNumberZoneSchema = z.enum(['near_stamp', 'off']);
export type LargeSheetNumberZone = z.infer<typeof largeSheetNumberZoneSchema>;

// --- Документы и реквизиты (§3.6, §8) ---

/** Связь между логическими документами (`document_relations.relation`). */
export const documentRelationSchema = z.enum([
  'annex',
  'quality_doc',
  'protocol',
  'copy_certification',
  'signature_page',
  'supersedes',
  'duplicate',
]);
export type DocumentRelation = z.infer<typeof documentRelationSchema>;

/** Роль страницы внутри документа (§8.1). Ортогональна виду ИД. */
export const pageRoleCodeSchema = z.enum([
  'blank',
  'copy_stamp',
  'signature_visual',
  'annex_continuation',
  // Роль ставится разбором страницы с S30, а перечень её не знал: значение,
  // которое портал уже писал в page_classifications, отвергалось на границе
  // API. Справочник page_roles этот код содержит с того же сида.
  'doc_continuation',
]);
export type PageRoleCode = z.infer<typeof pageRoleCodeSchema>;

export const extractedBySchema = z.enum(['rule', 'llm', 'manual']);
export type ExtractedBy = z.infer<typeof extractedBySchema>;

/**
 * Итог сопоставления строки реестра приложений с документом (§8.3).
 *
 * `ambiguous` обязателен: совпадение только после фолдинга гомоглифов при
 * наличии коллизии не является совпадением, и объявить его `matched` значило
 * бы тихо привязать документ не к той строке.
 *
 * `candidate` — тоже не совпадение, но и не отсутствие: номер не ответил, а в
 * комплекте лежит документ того же вида либо той же даты. Состояние документ
 * НЕ выбирает (`matched_document_id` пуст) и ребра графа не строит: иначе
 * похожесть по виду молча стала бы основанием для правил дат (§9.2).
 */
export const matchStateSchema = z.enum(['matched', 'missing', 'extra', 'ambiguous', 'candidate']);
export type MatchState = z.infer<typeof matchStateSchema>;

/** Откуда взят материал в графе проверки (§9.3, `AOSR.P3`). */
export const materialSourceSchema = z.enum(['act_p3', 'registry', 'quality_doc', 'manual']);
export type MaterialSource = z.infer<typeof materialSourceSchema>;

// --- Проверки (§3.7, §9) ---

export const severitySchema = z.enum(['error', 'warning', 'info']);
export type Severity = z.infer<typeof severitySchema>;

/**
 * Состояние замечания.
 *
 * `undetermined` — не разновидность `open`, а третье значение троичной логики
 * (§9.1): «данных для вывода не хватает». Низкая уверенность OCR или
 * неизвестный тип связи дат обязаны приводить сюда, а не к `fail`.
 */
export const findingStateSchema = z.enum(['open', 'resolved', 'waived', 'undetermined']);
export type FindingState = z.infer<typeof findingStateSchema>;

/**
 * Происхождение замечания.
 *
 * `external_unavailable` — внешний реестр (НРС, СРО, аккредитация) недоступен:
 * такое замечание означает «требуется ручная проверка», а не юридический
 * вывод (§9.5). `llm` не может быть блокирующим без подтверждения инженером
 * — инвариант проверяется схемой `findingSchema` в `domain.ts`.
 */
export const findingOriginSchema = z.enum(['deterministic', 'llm', 'external_unavailable']);
export type FindingOrigin = z.infer<typeof findingOriginSchema>;

/** К чему привязано замечание (`findings.target_type`). */
export const findingTargetTypeSchema = z.enum([
  'folder',
  'source_page',
  'document',
  'field_value',
  'registry_row',
  'material',
  'batch',
]);
export type FindingTargetType = z.infer<typeof findingTargetTypeSchema>;

// --- Governance и задачи (§3.8, §10, §12) ---

export const promptStateSchema = z.enum(['draft', 'test', 'published', 'archived']);
export type PromptState = z.infer<typeof promptStateSchema>;

/**
 * Уровень автономии раздела (§0.5, п.5).
 *
 * Новый раздел всегда стартует в `assisted`: качество классификации,
 * измеренное на двух разделах корпуса, на остальные не переносится.
 */
export const autonomyLevelSchema = z.enum(['assisted', 'automatic']);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

/**
 * Исход одной попытки задачи (`job_runs.outcome`).
 *
 * Это исход попытки, а не задачи: будет ли повтор, определяется
 * `jobs.attempts` против `max_attempts`, поэтому отдельного значения
 * «будет повторено» здесь нет. `lease_expired` ставит reaper, когда воркер
 * умер, не закрыв аренду, — такую попытку нельзя считать ни успехом, ни
 * прикладной ошибкой.
 *
 * `deferred` и `failed` — РАЗНЫЕ факты, и различие не косметическое.
 * `failed` означает «работа не получилась»; `deferred` — «работы ещё нет,
 * условие не наступило»: так ждут поллеры (`vlm.finalize_run` — терминальности
 * страниц прогона, `rd.poll_recognition` — окончания OCR, `rd.wait_pages` —
 * рендера). Пока значение было одно, минута нормального ожидания давала
 * двенадцать строк `failed`, текст «Распознавание ещё идёт» в `jobs.last_error`
 * и плашку «Обработка остановилась: отказов 12» на живом конвейере — причём
 * заслоняя собой задачу, которая действительно умерла.
 *
 * Отсрочка не несёт ни `error_class`, ни `error_message`: сообщать не о чем.
 * Счётчик попыток она не откатывает — ожидание, не кончающееся никогда, обязано
 * однажды стать отказом.
 */
export const jobOutcomeSchema = z.enum([
  'succeeded',
  'failed',
  'cancelled',
  'lease_expired',
  'deferred',
]);
export type JobOutcome = z.infer<typeof jobOutcomeSchema>;

/**
 * Категории материалов для матрицы требований к пакету подтверждения (§9.3).
 *
 * Здесь, а не в модуле роутов: перечень нужен и схеме входа справочника, и
 * репозиторию профилей правил, и движку правил на S9. Две копии расходятся
 * молча — ровно так и вышло с контрольными суммами реквизитов, поэтому
 * определение одно.
 *
 * ✓ — категория подтверждена корпусом двух разделов. Остальные взяты из
 * нормативного состава, и требования к ним не калиброваны (§0.5).
 */
export const MATERIAL_CATEGORIES = [
  /** ✓ Рулонная гидроизоляция (кровля 2.5.1). */
  'roll_waterproofing',
  /** ✓ Арматурный прокат (ЖБ 2.1.5). */
  'rebar',
  /** ✓ Товарные бетонные смеси. */
  'ready_mix_concrete',
  /** ✓ Минеральная вата и XPS. */
  'thermal_insulation',
  /** ✓ Метизы. */
  'fasteners',
  /** ✓ Сварная сетка. */
  'welded_mesh',
  'pipes',
  'pipe_fittings',
  'cable',
  'equipment',
  'paint_coatings',
  'fire_protection',
  'glazing',
] as const;

export const materialCategoryCodeSchema = z.enum(MATERIAL_CATEGORIES);
export type MaterialCategoryCode = z.infer<typeof materialCategoryCodeSchema>;

// --- Обратная связь конвейера (§11, ADR-0010) ---

/**
 * Крупная категория сигнала о качестве обработки.
 *
 * `manual_correction` — правка человека. Самый ценный вид: инженер, исправляя
 * распознанное, проставляет правильный ответ там, где модель ошиблась, и это
 * единственный сигнал, который знает не только «плохо», но и «как надо».
 */
export const processingFeedbackTypeSchema = z.enum([
  'system_failure',
  'recognition_failure',
  'wrong_extraction',
  'check_error',
  'manual_correction',
]);
export type ProcessingFeedbackType = z.infer<typeof processingFeedbackTypeSchema>;

/**
 * Причина из закрытого перечня — ключ, по которому строится годовой ряд.
 *
 * Закрытый, а не свободный текст, сознательно: формулировку сообщения меняют
 * при первой же правке кода, и ряд «доля дефектов у промта X версии N»
 * разорвался бы ровно тогда, когда его впервые захотят посмотреть.
 */
export const processingFeedbackReasonSchema = z.enum([
  /** Ответ модели не разобран как JSON. */
  'vlm.invalid_json',
  /** JSON разобран, но не соответствует схеме блока. */
  'vlm.schema_mismatch',
  /** Модель не дала результата: отказ, обрыв по лимиту, пустой ответ. */
  'vlm.refusal',
  /** Ответ формально верен и пуст: распознавать было нечего или не вышло. */
  'vlm.empty_result',
  /** Реквизит не извлечён. В записи только код поля, не значение. */
  'extract.field_missing',
  /**
   * Реквизит извлечён, но расходится с текстом документа (S44).
   *
   * Отдельный код, а не оттенок `extract.field_missing`. Тот говорит «не
   * прочитали», этот — «прочитали не то», и чинятся они разным: первое правилом
   * или промтом, второе моделью. Склеив их, портал потерял бы единственный
   * срез, по которому они различаются.
   *
   * В записи только КОД реквизита, никогда его значение: значение — это ПДн.
   */
  'extract.value_mismatch',
  'classify.low_confidence',
  'detect.no_blocks',
  'detect.low_score',
  /**
   * Крупный лист: детектор что-то нашёл, но штампа среди этого не было (S42).
   *
   * Отдельный код, а не оттенок `detect.no_blocks`. Тот говорит о дефекте
   * конвейера — рендер, порог, модель; этот говорит о качестве ВХОДЯЩЕЙ
   * документации: чертёж пришёл без основной надписи, и распознавать на нём
   * нечего. Это разные разборы и разные годовые ряды, и склеив их, портал
   * потерял бы единственный срез, по которому они различаются.
   */
  'detect.no_stamp',
  'match.ambiguous',
  'doc_split.unassigned_pages',
  /** Правки человека: он назвал правильный ответ. */
  'manual.field_corrected',
  'manual.block_redrawn',
  'manual.type_changed',
  /**
   * Зонд ориентации не дал ответа (ADR-0020).
   *
   * Не отказ конвейера: страница считается прямой и уходит на детекцию. Но и не
   * рядовой исход — на боковом листе детектор даёт скудную разметку, и знать,
   * где портал работал вслепую, обязан человек.
   */
  'orientation.probe_failed',
  /** Зонд предложил разворот, но не уверен: мнение записано, лист не повёрнут. */
  'orientation.low_confidence',
]);
export type ProcessingFeedbackReason = z.infer<typeof processingFeedbackReasonSchema>;
