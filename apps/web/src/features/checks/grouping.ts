/**
 * Разбор списка замечаний для экрана «Проверка» (S27).
 *
 * Вынесено из компонента, потому что это единственная его часть, которую можно
 * проверить без DOM: компонентных тестов в проекте нет вовсе
 * (`@testing-library` не в зависимостях), а весь экран держался на Playwright.
 * Правила разбиения и подписи — как раз то, что ломается тихо.
 *
 * Порядок строк здесь НЕ трогается: его задал сервер (страница → важность →
 * код правила), и вторая сортировка на клиенте либо повторила бы её, либо
 * разошлась бы с ней.
 */
import type { ChecksSummary, Finding } from '../../api/types.js';

/**
 * Две секции, а не одна таблица с прочерком.
 *
 * Прочерк в колонке «Страница» читался бы как «портал не смог определить
 * страницу», то есть как дефект портала. А замечание «есть материал, но нет
 * сертификата» страницы не имеет по построению: оно о том, чего в комплекте
 * НЕТ, и указать лист, на котором этого нет, невозможно.
 */
export interface FindingSections {
  /** Замечания с адресом на странице комплекта. */
  readonly onPages: readonly Finding[];
  /** Замечания уровня комплекта: чего не хватает. */
  readonly onBundle: readonly Finding[];
  /** Снятые обоснованным решением руководителя — отдельно и свёрнуто. */
  readonly waived: readonly Finding[];
}

/**
 * Что показывается, а что нет.
 *
 * `open` и `undetermined` — на экране. `undetermined` не сливается с ошибкой:
 * это «данных для вывода нет», и печатать его как дефект — тот сорт ложного
 * замечания, который разрушает доверие быстрее пропущенного.
 *
 * `waived` — в свёрнутой строке внизу: снятое руководителем решение юридически
 * значимо и не имеет права исчезнуть бесследно.
 *
 * `resolved` не показывается: устранённое замечание описывает прошлое
 * состояние комплекта, а экран отвечает на вопрос «что не так сейчас».
 */
export function splitFindings(items: readonly Finding[]): FindingSections {
  const visible = items.filter((item) => item.state === 'open' || item.state === 'undetermined');
  return {
    onPages: visible.filter((item) => item.page !== null),
    onBundle: visible.filter((item) => item.page === null),
    waived: items.filter((item) => item.state === 'waived'),
  };
}

/**
 * Подпись страницы в строке.
 *
 * `basis: 'document'` означает, что номер выведен из начала документа, а не из
 * места ошибки: срок действия может стоять на любом его листе. Подписать это
 * «Страница 5» значило бы отправить проверяющего смотреть не туда и заявить
 * точность, которой у портала нет.
 */
export function pageLabel(finding: Finding): string {
  if (finding.page === null) return '';
  const number = String(finding.page.number);
  return finding.page.basis === 'document' ? `Документ со стр. ${number}` : number;
}

/** Есть ли у замечания рабочий адрес разметки. Без него ссылка не рисуется. */
export function markupHref(revisionId: string, finding: Finding): string | null {
  const index = finding.page?.workingPageIndex ?? null;
  if (index === null) return null;
  const query = new URLSearchParams({ tab: 'markup', page: String(index) });
  if (finding.blockId !== null) query.set('block', finding.blockId);
  return `/ids/revisions/${revisionId}?${query.toString()}`;
}

/**
 * Состояние проверки одной фразой.
 *
 * Четыре случая, и они не сливаются. «Проверки ещё не было» и «комплект
 * изменился» выглядят одинаково пустым экраном и означают разное: в первом
 * случае надо нажать кнопку, во втором — знать, что список ниже описывает
 * прежний состав. Прежняя вкладка не различала их вовсе и потому молчала в обоих.
 */
export type RunState =
  | { readonly kind: 'never' }
  | { readonly kind: 'running' }
  | { readonly kind: 'running_over_previous'; readonly since: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'done' };

export function runStateOf(summary: ChecksSummary, matchesCurrentFiles: boolean): RunState {
  const latest = summary.latestRun;
  if (latest === null) return { kind: 'never' };
  if (latest.finishedAt === null) {
    return summary.shownRunId === null
      ? { kind: 'running' }
      : { kind: 'running_over_previous', since: latest.startedAt };
  }
  // Состав изменился после проверки — догрузили файл. Удаление и замена сносят
  // прогоны вместе с производным, поэтому сюда попадает только догрузка.
  return matchesCurrentFiles ? { kind: 'done' } : { kind: 'stale' };
}

/** Склонение по русскому правилу: 1 ошибка, 2 ошибки, 5 ошибок. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Сводка словами, а не набором чисел с подписями.
 *
 * Счётчик «блокирующих открытых: 0» отвечал на вопрос, которого у пользователя
 * нет. Вопрос у него другой: сколько страниц портал прочитал и что нашёл, —
 * и ответ на него читается одной фразой.
 */
export function summaryText(summary: ChecksSummary): string {
  const { coverage, counts } = summary;
  const read =
    coverage.pagesTotal === 0
      ? 'Файлов в комплекте нет'
      : `Распознано ${String(coverage.pagesRecognized)} ${plural(coverage.pagesRecognized, 'страница', 'страницы', 'страниц')} из ${String(coverage.pagesTotal)}` +
        (coverage.documentsTotal > 0
          ? `, разобрано ${String(coverage.documentsTotal)} ${plural(coverage.documentsTotal, 'документ', 'документа', 'документов')}`
          : '');

  const parts: string[] = [];
  if (counts.openErrors > 0) {
    parts.push(
      `${String(counts.openErrors)} ${plural(counts.openErrors, 'ошибка', 'ошибки', 'ошибок')}`,
    );
  }
  const soft = counts.openWarnings + counts.openInfo;
  if (soft > 0) {
    parts.push(
      `${String(soft)} ${plural(soft, 'предупреждение', 'предупреждения', 'предупреждений')}`,
    );
  }
  if (counts.undetermined > 0) {
    parts.push(`${String(counts.undetermined)} не проверено`);
  }

  const found = parts.length === 0 ? 'Ошибок не найдено.' : `Найдено: ${parts.join(', ')}.`;
  return `${read}. ${found}`;
}

/**
 * Чего проверка не покрыла.
 *
 * Заявление о ПОЛНОТЕ, а не замечание. «Страница 7 не отнесена ни к одному
 * документу» — сообщение о работе портала: подрядчику нечего с ним сделать, у
 * него нет ни кнопки, ни способа. Замечанием оно встало бы в один ряд с
 * «просрочена дата», которую чинят перезаливкой, и разбавило бы список шумом,
 * чинить который нечем.
 *
 * Но знать это он обязан: пустой список ошибок по неразобранным страницам
 * ничего не доказывает. `null` — покрыто всё, плашки нет вовсе.
 */
export function coverageGap(summary: ChecksSummary): string | null {
  const { coverage } = summary;
  const parts: string[] = [];

  if (coverage.pagesUnassigned > 0) {
    const numbers = coverage.unassignedPageNumbers;
    const shown = numbers.join(', ');
    const rest = coverage.pagesUnassigned - numbers.length;
    parts.push(
      `не отнёс к документам ${String(coverage.pagesUnassigned)} ${plural(coverage.pagesUnassigned, 'страницу', 'страницы', 'страниц')}` +
        (shown === '' ? '' : ` (${shown}${rest > 0 ? ` и ещё ${String(rest)}` : ''})`),
    );
  }
  if (coverage.documentsUnknownType > 0) {
    parts.push(
      `не определил вид у ${String(coverage.documentsUnknownType)} ${plural(coverage.documentsUnknownType, 'документа', 'документов', 'документов')}`,
    );
  }

  if (parts.length === 0) return null;
  return `Портал ${parts.join(' и ')}. Часть проверок по ним не выполнялась.`;
}
