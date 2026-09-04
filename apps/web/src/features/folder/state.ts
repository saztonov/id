/**
 * Одна фраза о том, что делает конвейер прямо сейчас (S51).
 *
 * ## Почему это отдельный модуль
 *
 * По той же причине, что и `busy.ts`: различают состояния не значения полей по
 * отдельности, а их сочетания — занятость, текущая стадия, мёртвые задачи,
 * ожидание, режим сравнения провайдеров. Такую логику проверяют таблицей
 * входов, а компонентных тестов во фронте портала нет; внутри `PipelineBar`
 * она была недосягаема для vitest и потому не проверялась вовсе.
 *
 * ## Что здесь исправлено переездом
 *
 * Фраза об ожидании выбиралась по счётчику `deferred`, который копится за всю
 * жизнь ревизии. На боевом комплекте `vlm.finalize_run` отсрочился 270 раз, и
 * после первой же отсрочки экран до конца обработки повторял «ждём, пока
 * допишутся страницы» — в том числе через двадцать минут после того, как
 * страницы дописались и пошёл разбор документов. Человек читал это как
 * зависание распознавания и шёл разбираться с исправным конвейером.
 */
import type { ProcessingStatus } from '../../api/types.js';
import { PIPELINE_STAGES } from './busy.js';

export interface StateInput {
  readonly stage: string | null;
  /** Стадия с задачами в очереди; `null` — конвейер не занят. */
  readonly activeStage: string | null;
  readonly queued: number;
  readonly running: number;
  /** Стадия задачи, отсроченной ПРЯМО СЕЙЧАС; `null` — никто не ждёт. */
  readonly deferredStage: string | null;
  readonly dead: number;
  readonly busy: boolean;
  readonly dryRun: boolean;
  readonly progress: { readonly pagesTotal: number } | null;
}

/**
 * Стадия, которая ЖДЁТ прямо сейчас.
 *
 * Ожидание бывает не только у распознавания: страниц ждёт `vlm.finalize_run`,
 * реквизитов — `doc.extract_finalize`, отрисовки страниц — разметка через RD
 * WEB. Раньше все три случая назывались страницами, потому что фраза была одна.
 *
 * Из нескольких ждущих стадий называется САМАЯ РАННЯЯ: она и держит остальные.
 */
export function deferredStageOf(status: ProcessingStatus | null | undefined): string | null {
  const waiting = new Set<string>();
  for (const row of status?.jobTypes ?? []) {
    if (row.deferredNow > 0 && row.stage !== null) waiting.add(row.stage);
  }
  if (waiting.size === 0) return null;
  return PIPELINE_STAGES.find((stage) => waiting.has(stage)) ?? null;
}

/** Чего ждёт стадия — словами, встраиваемыми в «идёт: …». */
function waitingLabel(stage: string): string | null {
  switch (stage) {
    case 'recognition':
      return 'ждём, пока допишутся страницы';
    case 'analysis':
      return 'ждём, пока дочитаются документы';
    case 'layout':
      return 'ждём, пока подготовятся страницы';
    default:
      return null;
  }
}

/** Одна фраза о том, что происходит прямо сейчас. */
export function describeState(input: StateInput): string {
  const { stage, activeStage, queued, running, deferredStage, dead, busy, dryRun, progress } =
    input;

  if (stage === null) return 'конвейер не запускался';
  if (!busy) {
    // «Готово» о прогоне, который ничего не опубликовал, — это неправда:
    // распознавание состоялось, а комплект после него ровно там же, где был.
    if (dryRun && (stage === 'ready' || stage === 'recognition')) {
      return 'распознано, но не опубликовано';
    }
    if (stage === 'ready') return 'готово';
    if (stage === 'failed') return 'обработка остановлена отказом';
    return `последняя стадия: ${stageLabel(stage)}`;
  }

  // Сборщик ждёт, пока допишется то, что собирает: это работа, а не затор. Пока
  // ожидание записывалось отказом, эта же секунда показывалась как «Обработка
  // остановилась» — и человек шёл разбираться с исправным конвейером. Ожидание
  // называется только ИДУЩЕЕ: см. шапку модуля о липкой фразе про страницы.
  if (deferredStage !== null && dead === 0) {
    const waiting = waitingLabel(deferredStage);
    if (waiting !== null) return `идёт: ${waiting}`;
  }

  // Занятый конвейер называет ТЕКУЩУЮ стадию, а не самую дальнюю: иначе во
  // время пересборки рабочего документа экран обещает выделение блоков, которое
  // ещё даже не поставлено в очередь.
  const now = activeStage ?? stage;

  // Прогон создан, но страниц ещё нет: между постановкой в очередь и первой
  // страницей проходят десятки секунд, и молчание здесь читается как зависание.
  if (now === 'recognition' && running > 0 && (progress === null || progress.pagesTotal === 0)) {
    return 'идёт: готовим страницы к распознаванию';
  }
  if (running === 0) {
    return `в очереди: ${String(queued)} ${plural(queued, 'задача', 'задачи', 'задач')}, ждём исполнителя`;
  }
  return `идёт: ${stageLabel(now)}`;
}

/** Склонение по русскому правилу: 1 задача, 2 задачи, 5 задач. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Подписи стадий.
 *
 * Отдельная таблица, а не `PROCESSING_STAGE_LABELS` из `shared/labels`: там
 * стадии названы для журнала («распознавание»), а здесь фраза встраивается в
 * «идёт: …» и читается вместе с ней.
 */
export function stageLabel(stage: string | null): string {
  switch (stage) {
    case 'uploaded':
      return 'приём файлов и сборка рабочего документа';
    case 'layout':
      return 'выделение блоков на страницах';
    case 'recognition':
      return 'распознавание';
    case 'analysis':
      return 'разбор документов и реквизитов';
    case 'checks':
      return 'проверка правилами';
    case 'ready':
      return 'нарезка и выдача';
    default:
      return stage ?? 'неизвестно';
  }
}
