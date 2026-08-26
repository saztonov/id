/**
 * Печать строк отчёта о составе комплекта (S29).
 *
 * Вынесено из компонента по тому же доводу, что и `grouping.ts`: компонентных
 * тестов в проекте нет вовсе (`@testing-library` не в зависимостях), и всё, что
 * можно проверить без DOM, обязано жить там, где его проверяют. Ломается тихо
 * ровно это — какой значок достался строке и что написано вместо даты.
 *
 * Порядок секций и строк здесь НЕ трогается: его задал сервер, и вторая
 * сортировка на клиенте либо повторила бы её, либо разошлась бы с ней.
 */
import type { ReportItemStatus, ReportRow, ReportRowStatus } from '../../api/types.js';

/** Тон строки: тот же словарь, что у тегов остального портала. */
export type ReportTone = 'success' | 'danger' | 'warning' | 'neutral';

/**
 * Значок и тон состояния.
 *
 * Галочка достаётся ТОЛЬКО `ok`. `unchecked`, `not_applicable` и `not_run`
 * получают нейтральный вид и своё слово: выдать непроверенное за проверенное —
 * тот же класс лжи, из-за которого экран и переделывался («Ошибок не найдено»
 * печаталось там, где ошибок не искали).
 */
export function toneOf(status: ReportRowStatus | ReportItemStatus): ReportTone {
  switch (status) {
    case 'ok':
      return 'success';
    case 'error':
    case 'missing':
      return 'danger';
    case 'warning':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function markOf(status: ReportRowStatus | ReportItemStatus): string {
  switch (status) {
    case 'ok':
      return '✓';
    case 'error':
    case 'missing':
      return '✕';
    case 'warning':
      return '!';
    default:
      return '—';
  }
}

const ITEM_LABELS: Readonly<Record<ReportItemStatus, string>> = {
  ok: 'пройдено',
  error: 'ошибка',
  warning: 'предупреждение',
  undetermined: 'не проверено',
  not_applicable: 'неприменимо',
  not_run: 'не исполнялось',
};

export function itemLabel(status: ReportItemStatus): string {
  return ITEM_LABELS[status];
}

/**
 * Даты строки одной фразой.
 *
 * Пустая строка означает «дат в документе не нашлось», и это НЕ повод для
 * прочерка в колонке: прочерк читается как «портал не смог», а здесь портал
 * прочитал документ, в котором дат нет. Различает их вызывающий, печатая
 * `null` как пустую ячейку.
 */
export function datesLabel(row: ReportRow): string | null {
  const dates = row.dates;
  if (dates === null) return null;

  const parts: string[] = [];
  if (dates.issuedAt !== null) parts.push(`выдан ${formatDate(dates.issuedAt)}`);
  if (dates.validFrom !== null && dates.validTo !== null) {
    parts.push(`действует ${formatDate(dates.validFrom)} — ${formatDate(dates.validTo)}`);
  } else if (dates.validTo !== null) {
    parts.push(`до ${formatDate(dates.validTo)}`);
  } else if (dates.validFrom !== null) {
    parts.push(`с ${formatDate(dates.validFrom)}`);
  }

  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * Дата как её пишут в документах: 12.03.2024.
 *
 * ISO-строка приходит с сервера (`date` в БД, без времени и без зоны), поэтому
 * разбирается посимвольно, а не через `Date`: конструктор увёл бы дату на сутки
 * в часовых поясах западнее UTC — тот самый дефект, который в сроке годности
 * сертификата означает «просрочен на день раньше».
 */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(iso);
  if (match === null) return iso;
  return `${match[3] ?? ''}.${match[2] ?? ''}.${match[1] ?? ''}`;
}

/**
 * Адрес разметки строки; `null` — идти некуда, ссылку рисовать нельзя.
 *
 * Блок дописывается, когда он известен: §16 называет переход «замечание →
 * доказательство» отдельным пунктом приёмки, и ссылка обязана не просто открыть
 * лист, а выделить тот блок, о котором речь. Без него проверяющий открывает
 * страницу, не находит обещанного и перестаёт верить остальным строкам тоже.
 */
export function rowHref(revisionId: string, row: ReportRow): string | null {
  const index = row.page?.workingPageIndex ?? null;
  if (index === null) return null;
  const query = new URLSearchParams({ tab: 'markup', page: String(index) });
  if (row.blockId !== null) query.set('block', row.blockId);
  return `/ids/revisions/${revisionId}?${query.toString()}`;
}

/**
 * Что печатать в колонке «Стр.».
 *
 * У строки с замечанием — страница ЗАМЕЧАНИЯ, а не диапазон документа: колонка
 * отвечает на «куда смотреть», и туда же ведёт ссылка. Печатать «1–2», ведя на
 * второй лист, значило бы разойтись с собственной ссылкой.
 *
 * У строки без замечания печатается диапазон: там смотреть некуда конкретно, и
 * полезнее знать, сколько листов занимает документ.
 */
export function pagesLabel(row: ReportRow): string | null {
  if (row.statusRuleCode !== null && row.page !== null) return String(row.page.number);
  if (row.pages !== null) return row.pages;
  return row.page === null ? null : String(row.page.number);
}

/**
 * Сводка секции: сколько строк подтверждено.
 *
 * `null` — считать нечего (секция из одних непроверенных строк либо пустая).
 * Печатать «0 из 0 подтверждено» значило бы сообщать о работе, которой не было.
 */
export function sectionTally(rows: readonly ReportRow[]): string | null {
  const counted = rows.filter((row) => row.status !== 'unchecked');
  if (counted.length === 0) return null;
  const ok = counted.filter((row) => row.status === 'ok').length;
  return `${String(ok)} из ${String(counted.length)} без замечаний`;
}
