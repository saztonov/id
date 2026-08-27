/**
 * Подписи состояния комплекта в списке объекта (S37).
 *
 * ## Зачем отдельный модуль
 *
 * Здесь живут ЧИСТЫЕ функции: у месяца и исполнителя по четыре различимых
 * состояния каждое, и различает их не значение поля, а пара «значение плюс
 * стадия конвейера». Такую логику надо проверять таблицей входов, а не кликами
 * по экрану, — компонентных тестов во фронте портала нет, есть vitest над
 * чистыми функциями и Playwright над сквозными путями.
 *
 * ## Почему подписей четыре, а не две
 *
 * Заказчик указал ровно на это: «комплект распознан, а месяц — После OCR».
 * Пустое поле означало два РАЗНЫХ факта, а печаталось одинаково:
 *
 * - конвейер до разбора не дошёл — портал ещё не знает, и ждать правильно;
 * - разбор прошёл, а даты в акте не нашлось — ждать бессмысленно, и это
 *   единственный случай, когда человеку надо вмешаться.
 *
 * Прочерк не годится ни для того, ни для другого: он читается как «портал не
 * смог», то есть как отказ, а первый случай — ещё не случившаяся работа
 * (ADR-0019).
 */
import type { ProcessingStage } from '@id/contracts';

/** `2026-08-01` → `август 2026`: месяц читают словом, а не датой. */
const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

/** Месяц как дата: `null` печатается вызывающим, здесь только форма записи. */
export function monthLabel(period: string): string {
  const [year, month] = period.split('-');
  const index = Number(month) - 1;
  return MONTHS[index] === undefined ? period : `${MONTHS[index]} ${year ?? ''}`.trim();
}

/**
 * Состояние конвейера по комплекту.
 *
 * `null` — сводки нет: комплект без ревизии либо строка, которой не оказалось в
 * ответе. Это НЕ «не запускалось»: о комплекте, про который сервер промолчал,
 * портал не утверждает ничего.
 */
export interface WorkPipeline {
  readonly stage: ProcessingStage;
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
}

/** Дошёл ли конвейер до разбора документов: после него месяц уже либо есть, либо не будет. */
function analysisReached(pipeline: WorkPipeline | null): boolean {
  if (pipeline === null) return false;
  return pipeline.stage === 'analysis' || pipeline.stage === 'checks' || pipeline.stage === 'ready';
}

/**
 * Месяц комплекта.
 *
 * Сигнатура с двумя аргументами, а не с одним: без стадии функция не может
 * отличить «ещё не читали» от «прочитали и не нашли», и до S37 не отличала.
 */
export function periodLabel(period: string | null, pipeline: WorkPipeline | null = null): string {
  if (period !== null) return monthLabel(period);
  if (pipeline !== null && pipeline.dead > 0) return 'Обработка остановлена';
  if (analysisReached(pipeline)) return 'Дата акта не распознана';
  return 'После OCR';
}

/**
 * Исполнитель комплекта.
 *
 * `assumed` означает «портал подставил из карточки объекта, человек не
 * называл». Такое значение обязано быть отличимо от прочитанного — иначе
 * догадка выглядит фактом, — и до распознавания печатается той же надписью, что
 * и месяц: заказчик так и сказал, «надпись как и в дате».
 *
 * `raw` — наименование из акта, которого не нашлось в справочнике. Это ЗНАНИЕ, а
 * не пустота: портал прочитал организацию, но закрепить её за объектом может
 * только человек.
 */
export function contractorLabel(input: {
  readonly name: string | null;
  readonly assumed: boolean;
  readonly raw: string | null;
  readonly pipeline: WorkPipeline | null;
}): string {
  if (!input.assumed) return input.name ?? '—';
  if (input.raw !== null) return `${input.raw} — нет в справочнике объекта`;
  if (input.pipeline !== null && input.pipeline.dead > 0) return 'Обработка остановлена';
  if (analysisReached(input.pipeline)) return 'В акте не распознан';
  return 'После OCR';
}

/** Подписи стадий: те же слова, что печатает плашка на карточке ревизии. */
const STAGE_LABELS: Record<ProcessingStage, string> = {
  uploaded: 'файлы приняты',
  layout: 'выделение блоков',
  recognition: 'распознавание',
  analysis: 'разбор документов',
  checks: 'проверка',
  ready: 'готово',
  failed: 'отказ',
};

/**
 * Состояние конвейера одной строкой.
 *
 * «Не запускалось» и «нет данных» — разные ответы, и путать их нельзя: первое
 * утверждает о комплекте факт, второго портал не знает.
 */
export function pipelineLabel(pipeline: WorkPipeline | null): string {
  if (pipeline === null) return 'нет данных';
  if (pipeline.dead > 0) return 'отказ';
  if (pipeline.running > 0 || pipeline.queued > 0) {
    return `идёт: ${STAGE_LABELS[pipeline.stage]}`;
  }
  if (pipeline.stage === 'uploaded') return 'не запускалось';
  return STAGE_LABELS[pipeline.stage];
}

/** Идёт ли по комплекту работа: по этому признаку экран решает, опрашивать ли дальше. */
export function pipelineBusy(pipeline: WorkPipeline | null): boolean {
  return pipeline !== null && pipeline.dead === 0 && (pipeline.queued > 0 || pipeline.running > 0);
}
