/**
 * Перечисления доменной модели (§3).
 *
 * Каждое перечисление экспортируется парой «схема + выведенный тип»: схема
 * валидирует границу (HTTP, БД, интеграции), тип используется в коде.
 *
 * Закрытым перечислением становится только то, множество значений чего
 * определяем мы сами. Всё, что расширяется эксплуатацией — виды разделов,
 * коды видов ИД, коды правил — остаётся строкой с проверкой формата
 * (см. `domain.ts`): портал спроектирован под открытый мир (§0.5), и
 * жёсткий enum на справочнике превратил бы добавление раздела в релиз.
 */

import { z } from 'zod';

// --- Идентичность и доступ (§3.1) ---

export const userRoleSchema = z.enum(['contractor', 'engineer', 'manager', 'admin']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const counterpartyKindSchema = z.enum([
  'customer',
  'general_contractor',
  'contractor',
  'supplier',
]);
export type CounterpartyKind = z.infer<typeof counterpartyKindSchema>;

// --- Жизненный цикл поставки (§3, §10) ---

/**
 * Состояние ревизии поставки.
 *
 * `superseded` — ревизия закрыта возвратом: она остаётся неизменяемой, а
 * работа продолжается в новой draft с `parentRevisionId`. Возврат не
 * «переоткрывает» ревизию, иначе история согласования переписывалась бы.
 */
export const workflowStatusSchema = z.enum([
  'draft',
  'submitted',
  'in_review',
  'returned',
  'approved',
  'superseded',
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

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
]);
export type AttentionFlag = z.infer<typeof attentionFlagSchema>;

// --- Разметка (§3.4, §5.3) ---

export const layoutRevisionStateSchema = z.enum(['draft', 'frozen', 'superseded']);
export type LayoutRevisionState = z.infer<typeof layoutRevisionStateSchema>;

export const blockTypeSchema = z.enum(['text', 'image', 'stamp']);
export type BlockType = z.infer<typeof blockTypeSchema>;

export const shapeTypeSchema = z.enum(['rectangle', 'polygon']);
export type ShapeType = z.infer<typeof shapeTypeSchema>;

export const blockSourceSchema = z.enum(['auto', 'user']);
export type BlockSource = z.infer<typeof blockSourceSchema>;

/**
 * Происхождение блока вместо уверенности детектора.
 *
 * Уверенность и модель не хранятся: `BlockOut` легаси-API их не отдаёт
 * (§0.1), и колонка была бы вечно NULL. `unavailable` — честная замена
 * выдуманному числу; `full_page` отмечает блок, которым пользователь заменил
 * всю страницу целиком (§5.3).
 */
export const detectorProvenanceSchema = z.enum(['rf_detr', 'full_page', 'user', 'unavailable']);
export type DetectorProvenance = z.infer<typeof detectorProvenanceSchema>;

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

export const artifactKindSchema = z.enum(['zip', 'md', 'html', 'blocks_json', 'qa']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

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
 */
export const matchStateSchema = z.enum(['matched', 'missing', 'extra', 'ambiguous']);
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
  'revision',
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
 */
export const jobOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'lease_expired']);
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
