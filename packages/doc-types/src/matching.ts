/**
 * Сопоставление текста страницы с типами каталога.
 *
 * Логика вынесена сюда, а не в тесты и не в сегментатор, потому что её
 * используют трое: классификатор страниц (S8), тесты каталога и адверсарная
 * проверка якорей на корпусе. Разойдутся реализации — разойдутся и выводы.
 *
 * ## Почему матчинг построчный, а не по всему блоку
 *
 * Замер на реальном корпусе (158 блоков, три комплекта) показал три дефекта
 * наивного подхода «искать шаблон в тексте блока целиком»:
 *
 * 1. OCR отдаёт заголовки с markdown-префиксами: `##### АКТ`, `##### ЗАКЛЮЧЕНИЕ`,
 *    `##### Паспорт № 230126/…`. Шаблон с `^\s*` не проходит через `#`, и
 *    11 из 16 привязанных к началу строки якорей были мертвы. Якорь самого
 *    АОСР не срабатывал ни на одном из трёх актов.
 *
 * 2. Якорь не отличал заголовок документа от УПОМИНАНИЯ документа. Строка
 *    реестра приложений `| 13 | Документ о качестве; Раствор М-150 | …|`
 *    взводила тип «документ о качестве», а страница реестра целиком давала
 *    пять-шесть типов сразу.
 *
 * 3. Печатная подсказка бланка АОСР «(исполнительные схемы и чертежи,
 *    результаты экспертизы, обследований, лабораторных и иных испытаний)»
 *    гарантированно давала ложный `exec_scheme` на каждом акте — это текст
 *    формы РД-11-02, он воспроизводится на 100% документов.
 *
 * Построчный матчинг по нормализованной строке с семантикой «строка целиком»
 * закрывает все три: префиксы снимаются, а упоминание внутри табличной строки
 * или в скобках заголовком уже не выглядит.
 */
import type { DocTypeDefinition, PageRoleDefinition } from './types.js';

/**
 * Сколько строк от начала блока считается зоной заголовка.
 *
 * Двадцать, а не три-пять: в бланке АОСР строка «освидетельствования скрытых
 * работ» идёт четырнадцатой — выше расположена шапка формы с наименованием
 * объекта и всеми четырьмя участниками. Пятнадцати хватало бы впритык, без
 * запаса на вариации вёрстки бланка.
 *
 * Верхняя граница тоже содержательна: она не даёт якорю сработать на
 * упоминании документа в подвале страницы или в перечне приложений.
 */
export const DEFAULT_HEADING_LINES = 20;

/**
 * Снимает разметку, которой OCR оформляет строку, оставляя её содержание.
 *
 * Убираются markdown-заголовки, маркеры списков, цитаты, жирный и курсивный
 * акцент, а также ведущие и хвостовые разделители таблиц.
 */
export function normalizeLine(line: string): string {
  return line
    .replace(/^[\s>]*#{1,6}\s*/u, '')
    .replace(/^[\s>*+-]+/u, '')
    .replace(/[*_`]/gu, '')
    .replace(/^\s*\|\s*/u, '')
    .replace(/\s*\|\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Строки блока, приведённые к сравнимому виду; пустые отброшены. */
export function normalizeLines(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map(normalizeLine)
    .filter((l) => l.length > 0);
}

/**
 * Совпадает ли шаблон со строкой как с целым.
 *
 * Именно это отсекает упоминания: `ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б` — заголовок,
 * а `13 Документ о качестве; Раствор М-150 №АБС00001381 ООО "АБС Групп"` —
 * строка реестра, и совпадением она считаться не должна.
 *
 * Хвост после совпадения допускается только короткий и служебный: номер,
 * дата, скобочное уточнение. Порог в 80 символов подобран по корпусу —
 * самый длинный настоящий заголовок с хвостом это
 * «ДОКУМЕНТ О КАЧЕСТВЕ БЕТОННОЙ СМЕСИ (РАСТВОРА) ЗАДАННОГО КАЧЕСТВА ПАРТИИ № …».
 */
const MAX_TRAILING_CHARS = 80;

function matchesAsHeading(pattern: RegExp, line: string): boolean {
  const m = pattern.exec(line);
  if (!m) return false;
  if (m.index > 0) return false;
  const trailing = line.slice(m.index + m[0].length).trim();
  return trailing.length <= MAX_TRAILING_CHARS;
}

/** Компилирует шаблон. Флаги фиксированы: регистронезависимо, юникод. */
function compile(source: string): RegExp {
  try {
    return new RegExp(source, 'iu');
  } catch (cause) {
    throw new Error(`Некорректный шаблон: ${source}`, { cause });
  }
}

export interface MatchOptions {
  /** Размер зоны заголовка в строках. */
  readonly headingLines?: number;
}

export interface DocTypeMatch {
  readonly code: string;
  /** Строка, на которой сработал якорь, — для объяснения решения в UI. */
  readonly line: string;
  /** Номер строки в нормализованном представлении. */
  readonly lineIndex: number;
  /** Сколько подсказок из тела дополнительно подтвердились. */
  readonly bodyHitCount: number;
}

/**
 * Ищет типы, чьи якоря сработали в зоне заголовка.
 *
 * Возвращает все совпадения, а не первое: несколько кандидатов — это
 * содержательный результат, означающий неоднозначность, и решать её должен
 * вызывающий (сегментатор — приоритетом и контекстом, тест — падением).
 *
 * `bodyHints` сами по себе тип не присваивают: они только повышают
 * уверенность у типа, чей якорь уже сработал. Иначе подсказка вроде
 * «УСЛОВНЫЕ ОБОЗНАЧЕНИЯ» начнёт типизировать любую страницу с легендой.
 */
export function matchDocTypes(
  text: string,
  types: readonly DocTypeDefinition[],
  options: MatchOptions = {},
): readonly DocTypeMatch[] {
  const lines = normalizeLines(text);
  const headingZone = lines.slice(0, options.headingLines ?? DEFAULT_HEADING_LINES);
  const body = lines.join('\n');
  const matches: DocTypeMatch[] = [];

  for (const type of types) {
    if (type.isFallback) continue;

    const negatives = (type.matchHints.negativeAnchors ?? []).map(compile);
    if (negatives.some((re) => headingZone.some((l) => matchesAsHeading(re, l)))) continue;

    let hit: { line: string; index: number } | null = null;
    for (const source of type.matchHints.anchors) {
      const re = compile(source);
      const idx = headingZone.findIndex((l) => matchesAsHeading(re, l));
      if (idx >= 0) {
        hit = { line: headingZone[idx] as string, index: idx };
        break;
      }
    }
    if (!hit) continue;

    const bodyHitCount = (type.matchHints.bodyHints ?? []).filter((s) =>
      compile(s).test(body),
    ).length;

    matches.push({ code: type.code, line: hit.line, lineIndex: hit.index, bodyHitCount });
  }

  return matches;
}

export interface ResolvedDocType {
  /** Победивший код или null, если не сработал ни один якорь. */
  readonly code: string | null;
  /** Проигравшие кандидаты равного или меньшего приоритета. */
  readonly alternatives: readonly string[];
  /**
   * Несколько кандидатов с ОДИНАКОВЫМ приоритетом.
   *
   * Это не то же самое, что несколько совпадений: подвид, выигравший у
   * обобщающего типа, — штатное разрешение конфликта, а два равноправных
   * кандидата означают, что каталог не различает эти документы, и решать
   * должен человек либо LLM.
   */
  readonly ambiguous: boolean;
}

/**
 * Выбирает один тип из совпавших по специфичности.
 *
 * Возвращает не просто победителя, а факт неоднозначности: молча выбрать
 * первый из двух равноправных кандидатов означало бы скрыть от инженера,
 * что классификация ненадёжна.
 */
export function resolveDocType(
  matches: readonly DocTypeMatch[],
  types: readonly DocTypeDefinition[],
): ResolvedDocType {
  if (matches.length === 0) return { code: null, alternatives: [], ambiguous: false };

  const priorityOf = new Map(types.map((t) => [t.code, t.priority ?? 0]));
  const ranked = [...matches].sort(
    (a, b) => (priorityOf.get(b.code) ?? 0) - (priorityOf.get(a.code) ?? 0),
  );

  const winner = ranked[0] as DocTypeMatch;
  const topPriority = priorityOf.get(winner.code) ?? 0;
  const tied = ranked.filter((m) => (priorityOf.get(m.code) ?? 0) === topPriority);

  return {
    code: winner.code,
    alternatives: ranked.slice(1).map((m) => m.code),
    ambiguous: tied.length > 1,
  };
}

export interface PageRoleMatch {
  readonly code: string;
  readonly line: string;
  /** Захваченный номер документа-родителя, если якорь его выделил. */
  readonly parentRef?: string;
}

/**
 * Ищет роли страницы.
 *
 * Роли ищутся по всему блоку, а не только в зоне заголовка: штамп
 * электронной подписи и «КОПИЯ ВЕРНА» печатаются в подвале страницы.
 * Именно поэтому роль сама по себе не решает судьбу страницы — присоединять
 * ли её к предыдущему документу, определяет `autoAttach` конкретной роли.
 */
export function matchPageRoles(
  text: string,
  roles: readonly PageRoleDefinition[],
): readonly PageRoleMatch[] {
  const lines = normalizeLines(text);
  const matches: PageRoleMatch[] = [];

  for (const role of roles) {
    const negatives = (role.matchHints.negativeAnchors ?? []).map(compile);
    if (negatives.some((re) => lines.some((l) => re.test(l)))) continue;

    for (const source of role.matchHints.anchors) {
      const re = compile(source);
      let found: PageRoleMatch | null = null;
      for (const line of lines) {
        const m = re.exec(line);
        if (!m) continue;
        const parent = m[1]?.trim();
        found = { code: role.code, line, ...(parent ? { parentRef: parent } : {}) };
        break;
      }
      if (found) {
        matches.push(found);
        break;
      }
    }
  }

  return matches;
}
