/**
 * Русские подписи к кодам домена.
 *
 * Коды приходят из API как есть (`no_blocks`, `integrity_error`, `quarantined`),
 * и показывать их пользователю нельзя. Все подписи собраны здесь, а не рядом с
 * экранами: один и тот же флаг внимания виден и в ленте миниатюр, и в списке
 * блоков, и две формулировки одного состояния читаются как два разных.
 *
 * Функция `labelOf` возвращает сам код, если подписи нет. Это намеренно:
 * незнакомое значение обязано быть ВИДНО (открытый мир §0.5), а не подменяться
 * прочерком, за которым не отличить «новое состояние» от «пусто».
 */
import type {
  AttentionFlag,
  BlockType,
  DetectorProvenance,
  LayoutRevisionState,
  ProcessingStage,
  RecognitionStatus,
  Severity,
  VerifyState,
  WorkflowStatus,
} from '@id/contracts';

export function labelOf<K extends string>(
  dictionary: Readonly<Record<K, string>>,
  code: string,
): string {
  return (dictionary as Record<string, string | undefined>)[code] ?? code;
}

export const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  draft: 'Черновик',
  submitted: 'Подана',
  in_review: 'На проверке',
  returned: 'Возвращена',
  approved: 'Согласована',
  superseded: 'Заменена',
};

export const VERIFY_STATE_LABELS: Record<VerifyState, string> = {
  pending: 'Проверяется',
  ok: 'Принят',
  quarantined: 'Карантин',
};

export const LAYOUT_STATE_LABELS: Record<LayoutRevisionState, string> = {
  draft: 'Черновик',
  frozen: 'Заморожена',
  superseded: 'Заменена',
};

export const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  text: 'Текст',
  image: 'Изображение',
  stamp: 'Штамп',
};

export const PROVENANCE_LABELS: Record<DetectorProvenance, string> = {
  rf_detr: 'детектор RF-DETR',
  full_page: 'страница целиком',
  user: 'вручную',
  unavailable: 'происхождение неизвестно',
};

export const RECOGNITION_STATUS_LABELS: Record<RecognitionStatus, string> = {
  running: 'Выполняется',
  done: 'Завершён',
  integrity_error: 'Расхождение хэшей',
  failed: 'Отказ',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  error: 'Ошибка',
  warning: 'Предупреждение',
  info: 'Замечание',
};

export const FINDING_STATE_LABELS: Record<string, string> = {
  open: 'Открыто',
  resolved: 'Устранено',
  waived: 'Списано',
  undetermined: 'Не определено',
};

export const FINDING_ORIGIN_LABELS: Record<string, string> = {
  deterministic: 'Правило',
  llm: 'Модель',
  external_unavailable: 'Внешний реестр недоступен',
};

/**
 * Роли страниц внутри документа (`page_roles`, миграция 0009).
 *
 * Роль отвечает на вопрос «почему эта страница здесь»: продолжение документа,
 * приложение к нему, лист визуализации подписи. Код без подписи («annex_
 * continuation») читается как техническая деталь, хотя для инженера это
 * содержательное свойство страницы.
 */
export const PAGE_ROLE_LABELS: Record<string, string> = {
  annex_continuation: 'Приложение-продолжение документа',
  blank: 'Пустая страница',
  copy_stamp: 'Штамп «КОПИЯ ВЕРНА»',
  doc_continuation: 'Продолжение документа',
  signature_visual: 'Лист визуализации подписи',
};

/**
 * Объект замечания (`findings.target_type`).
 *
 * Ссылка полиморфна и внешнего ключа не имеет — вид цели задан этим кодом.
 * Показывать его как есть значило бы печатать `registry_row` человеку, который
 * ищет строку реестра приложений.
 */
export const FINDING_TARGET_LABELS: Record<string, string> = {
  revision: 'ревизия целиком',
  source_page: 'страница',
  document: 'документ',
  field_value: 'реквизит',
  registry_row: 'строка реестра приложений',
  material: 'материал',
  batch: 'партия',
};

export const MATCH_STATE_LABELS: Record<string, string> = {
  matched: 'Сопоставлена',
  missing: 'Не найден документ',
  extra: 'Документ вне реестра',
  ambiguous: 'Неоднозначно',
};

/**
 * Флаги внимания §7.3 — сигналы для человека, а не ошибки.
 *
 * Формулировки описывают наблюдение, а не вердикт: «блоков не найдено», а не
 * «страница не размечена». Разница существенна — по §5.3 решение принимает
 * пользователь, и подсказка не должна выглядеть приговором.
 */
export const ATTENTION_FLAG_LABELS: Record<AttentionFlag, string> = {
  no_blocks: 'Блоков не найдено',
  low_coverage: 'Низкое покрытие страницы',
  suspicious_overlap: 'Подозрительные перекрытия',
  bbox_out_of_page: 'Рамка выходит за страницу',
  degenerate_geometry: 'Вырожденная геометрия',
  tiny_block: 'Аномально маленький блок',
  neighbor_mismatch: 'Расхождение с соседними страницами',
  blank_page_candidate: 'Похоже на пустую страницу',
  missing_expected_stamp: 'Нет ожидаемого штампа',
  layout_hash_mismatch: 'Расхождение хэшей разметки',
};

export const PROCESSING_STAGE_LABELS: Record<ProcessingStage, string> = {
  uploaded: 'Файлы приняты',
  layout: 'Разметка',
  recognition: 'Распознавание',
  analysis: 'Сегментация и анализ',
  checks: 'Проверка',
  ready: 'Готово',
  failed: 'Отказ',
};

export const REVIEW_ACTION_LABELS: Record<string, string> = {
  submit: 'Подана на проверку',
  take_to_review: 'Взята на проверку',
  return: 'Возвращена подрядчику',
  approve: 'Согласована',
  override: 'Обоснованный отказ от замечания',
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  done: 'Успех',
  failed: 'Отказ',
  cancelled: 'Отменена',
};

/**
 * Словаря препятствий согласования здесь НЕТ намеренно.
 *
 * `submitBlockers` и `approveBlockers` приходят готовыми русскими фразами с
 * числами («документов без нарезки: 3»), а не кодами: их формирует
 * `apps/api/src/db/repositories/workflow.ts`. Словарь-переводчик поверх них
 * либо потерял бы числа, либо расходился бы с сервером при каждой правке
 * формулировки — и то и другое хуже, чем показать фразу как есть.
 */
