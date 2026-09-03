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
export function markupHref(folderId: string, finding: Finding): string | null {
  const index = finding.page?.workingPageIndex ?? null;
  if (index === null) return null;
  const query = new URLSearchParams({ tab: 'markup', page: String(index) });
  if (finding.blockId !== null) query.set('block', finding.blockId);
  return `/ids/folders/${folderId}?${query.toString()}`;
}

/**
 * Состояние проверки одной фразой.
 *
 * Случаи не сливаются. «Проверки ещё не было» и «комплект изменился» выглядят
 * одинаково пустым экраном и означают разное: в первом случае надо нажать
 * кнопку, во втором — знать, что список ниже описывает прежний состав. Прежняя
 * вкладка не различала их вовсе и потому молчала в обоих.
 *
 * ## Успех получил свой вид (S29)
 *
 * Прежнее `done` рисовалось отсутствием плашки, то есть было неотличимо от
 * непрогруженного экрана: пользователь, прошедший комплект без единой ошибки,
 * не получал подтверждения вовсе и не мог понять, сработало ли что-нибудь.
 * Теперь исход прогона расщеплён надвое, и зелёное сообщение появляется только
 * тогда, когда придраться не к чему НИ ПО ОДНОМУ пункту.
 */
export type RunState =
  | { readonly kind: 'never' }
  /** Конвейер занят и сам дойдёт до проверки: звать человека не нужно. */
  | { readonly kind: 'ahead'; readonly stage: string | null }
  | { readonly kind: 'running' }
  | { readonly kind: 'running_over_previous'; readonly since: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'done_clean' }
  | {
      readonly kind: 'done_with_issues';
      /** `error` — есть открытые ошибки; иначе оговорки мягче. */
      readonly tone: 'error' | 'warning';
      /** Что именно мешает назвать прогон чистым. Непустой по построению. */
      readonly reservations: readonly string[];
    };

/**
 * Условие зелёного — строгое, и это решение заказчика.
 *
 * Зелёная плашка над таблицей, в которой есть хоть один крестик, обесценивает
 * сама себя: один раз увидев её рядом с непроверенной страницей, проверяющий
 * перестаёт ей верить и дальше читает таблицу целиком — то есть плашка не
 * экономит ему ничего. Поэтому чистым считается прогон, у которого сошлось
 * всё: и находки, и покрытие.
 *
 * `undetermined` учитывается наравне с ошибками намеренно (§0.5): «данных для
 * вывода нет» — это не «всё в порядке», и слить их значило бы выдать
 * непроверенное за проверенное.
 */
function reservationsOf(summary: ChecksSummary): readonly string[] {
  const { coverage, counts } = summary;
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
  /**
   * «Портал прочитал иначе» — тоже оговорка, но НЕ дефект бумаги (S44).
   *
   * Соблазн был убрать их из плашки совсем: это претензия портала к самому
   * себе, и подрядчику с ней делать нечего. Так нельзя. Утверждение правила —
   * «извлечённое значение расходится с текстом», то есть значение неверно, а по
   * неверным значениям судили ОСТАЛЬНЫЕ правила. Зелёная плашка над таким
   * прогоном обещала бы проверку, которой не было.
   *
   * Поэтому оговорка остаётся, но своими словами: в счётчик дефектов документа
   * эти замечания не входят, и «предупреждений» на экране больше не на треть
   * состоит из них.
   */
  if (counts.extractionQuality > 0) {
    parts.push(
      `в ${String(counts.extractionQuality)} ${plural(counts.extractionQuality, 'месте', 'местах', 'местах')} портал прочитал иначе`,
    );
  }
  if (counts.undetermined > 0) {
    parts.push(
      `${String(counts.undetermined)} ${plural(counts.undetermined, 'замечание', 'замечания', 'замечаний')} не проверено`,
    );
  }
  if (coverage.pagesRecognized < coverage.pagesTotal) {
    parts.push(
      `распознано ${String(coverage.pagesRecognized)} ${plural(coverage.pagesRecognized, 'страница', 'страницы', 'страниц')} из ${String(coverage.pagesTotal)}`,
    );
  }
  if (coverage.pagesUnassigned > 0) {
    parts.push(
      `${String(coverage.pagesUnassigned)} ${plural(coverage.pagesUnassigned, 'страница', 'страницы', 'страниц')} не ${plural(coverage.pagesUnassigned, 'отнесена', 'отнесены', 'отнесены')} к документам`,
    );
  }
  if (coverage.documentsUnknownType > 0) {
    parts.push(
      `вид не определён у ${String(coverage.documentsUnknownType)} ${plural(coverage.documentsUnknownType, 'документа', 'документов', 'документов')}`,
    );
  }

  return parts;
}

export function runStateOf(
  summary: ChecksSummary,
  matchesCurrentFiles: boolean,
  /**
   * Стадия, которой конвейер занят прямо сейчас, если он сам дойдёт до
   * проверки; `null` — не занят либо занят тем, что проверкой не кончится.
   *
   * Без неё вкладка отвечала «проверка ещё не выполнялась» и советовала нажать
   * кнопку — двадцать четыре минуты на боевой папке из 153 документов, пока
   * конвейер шёл сам. Совет был не просто лишним: нажатие начинает всё заново.
   */
  runningStage: string | null = null,
): RunState {
  const latest = summary.latestRun;
  if (latest === null) {
    return runningStage === null ? { kind: 'never' } : { kind: 'ahead', stage: runningStage };
  }
  if (latest.finishedAt === null) {
    return summary.shownRunId === null
      ? { kind: 'running' }
      : { kind: 'running_over_previous', since: latest.startedAt };
  }
  // Прогон правил закончен, но конвейер снова идёт — значит идёт НОВЫЙ круг, и
  // прежний результат вот-вот сменится. Показывать его как итог можно, обещать
  // им покой — нет.
  if (runningStage !== null) return { kind: 'ahead', stage: runningStage };
  // Состав изменился после проверки — догрузили файл. Удаление и замена сносят
  // прогоны вместе с производным, поэтому сюда попадает только догрузка.
  if (!matchesCurrentFiles) return { kind: 'stale' };

  const reservations = reservationsOf(summary);
  if (reservations.length === 0) return { kind: 'done_clean' };
  return {
    kind: 'done_with_issues',
    tone: summary.counts.openErrors > 0 ? 'error' : 'warning',
    reservations,
  };
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
 *
 * ## Почему фраза зависит от состояния прогона (S29)
 *
 * Прежняя версия собирала хвост только из счётчиков и при пустых счётчиках
 * печатала «Ошибок не найдено.» — в том числе там, где прогона правил не было
 * вовсе. Счётчики в этом случае нули по построению: без прогона выдача
 * возвращает пустой список. То есть портал заявлял чистоту комплекта, которого
 * не проверял, и делал это ПРЯМО НАД плашкой «Проверка ещё не выполнялась».
 *
 * Различие «не нашли» и «не искали» стоит одного параметра и решает главную
 * жалобу: по такому экрану нельзя было понять, всё ли в порядке.
 */
export function summaryText(summary: ChecksSummary, state: RunState): string {
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
  /**
   * «Портал прочитал иначе» — тоже оговорка, но НЕ дефект бумаги (S44).
   *
   * Соблазн был убрать их из плашки совсем: это претензия портала к самому
   * себе, и подрядчику с ней делать нечего. Так нельзя. Утверждение правила —
   * «извлечённое значение расходится с текстом», то есть значение неверно, а по
   * неверным значениям судили ОСТАЛЬНЫЕ правила. Зелёная плашка над таким
   * прогоном обещала бы проверку, которой не было.
   *
   * Поэтому оговорка остаётся, но своими словами: в счётчик дефектов документа
   * эти замечания не входят, и «предупреждений» на экране больше не на треть
   * состоит из них.
   */
  if (counts.extractionQuality > 0) {
    parts.push(
      `в ${String(counts.extractionQuality)} ${plural(counts.extractionQuality, 'месте', 'местах', 'местах')} портал прочитал иначе`,
    );
  }
  if (counts.undetermined > 0) {
    parts.push(`${String(counts.undetermined)} не проверено`);
  }

  return `${read}. ${foundText(state, parts)}`;
}

/** Хвост сводки: что искали и что нашли — либо честное «не искали». */
function foundText(state: RunState, parts: readonly string[]): string {
  switch (state.kind) {
    case 'never':
      return 'Проверка по правилам не выполнялась: ошибки не искали.';
    case 'running':
      return 'Проверка по правилам идёт: результата пока нет.';
    default:
      return parts.length === 0
        ? 'Проверка выполнена: ошибок не найдено.'
        : `Найдено: ${parts.join(', ')}.`;
  }
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
