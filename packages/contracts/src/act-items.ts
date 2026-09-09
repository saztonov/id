/**
 * Перечни акта освидетельствования: п. 3 «применённые материалы» и п. 4
 * «предъявленные документы» — общий разбор для сверки и для правил (S59).
 *
 * ## Почему в контрактах, а не в `apps/api` и не в `packages/rules`
 *
 * Номер документа внутри строки перечня искали два регулярных выражения:
 * `ACT_ITEM3_NUMBER` в сверке (`apps/api/src/segmentation/match.ts`) и
 * `DOC_NO_IN_TEXT` в правилах (`packages/rules/src/aosr.ts`). Они уже
 * разошлись: в правилах стояла опечатка `N(?![p{L}])` — класс из трёх букв
 * вместо любой буквы, — и «N» перед словом читалось как знак номера. Правила
 * импортировать из `apps/api` не могут, поэтому общее место — здесь, рядом с
 * `normalizeDocNo`, которую оба читают отсюда же.
 *
 * ## Что здесь НЕ делается
 *
 * Лестница сравнения номеров (числовое ядро, компактная форма) остаётся в
 * сверке: здесь только разбор текста на позиции и номера. Сравнивать найденное
 * — дело вызывающего, и делает он это `normalizeDocNo`, а не второй копией.
 */

/**
 * Номер документа, названный внутри строки перечня.
 *
 * Границей служит то, что за номером ИДЁТ: предлог «от» перед датой, запятая,
 * точка с запятой, скобка или конец строки. Пробелом граница быть не может —
 * он встречается внутри номера («№ РОСС RU BY.HE06.H22245»), а в акте так
 * записан и номер схемы: «№ 48.1-от/-1 этаж от 10.04.2026г.».
 *
 * «Не» и «No» — то, во что OCR превращает «№»: в боевой папке так прочитано
 * больше четверти номеров, и без них строка молча становилась «названной без
 * номера». Латинское «N» считается знаком номера только не перед буквой:
 * иначе «Novaya» давало бы номер «ovaya».
 *
 * Предлог «к» тоже граница: в «Реестр приложений № 1 к акту № 48-ОТ» номер
 * реестра кончается перед «к акту», иначе он дочитывался бы до конца строки
 * вместе с номером родителя.
 *
 * Флаг `g`: вызывающие перебирают ВСЕ номера строки через `matchAll`, который
 * копирует выражение и не делит `lastIndex` между вызовами.
 */
export const ACT_ITEM_NUMBER =
  /(?:№|Не(?=\s*[0-9A-ZА-Я])|No(?=\s*[0-9A-ZА-Я])|N(?![\p{L}]))\s*([^,;()]+?)(?=\s+от\s|\s+к\s+\p{L}|\s*[,;()]|$)/gu;

/**
 * Короче этого ссылка номером не считается.
 *
 * Двузначное значение после «№» — это пункт перечня или номер партии, а не
 * номер документа; сопоставление по нему нашло бы случайный лист.
 */
export const MIN_ACT_ITEM_NUMBER_LENGTH = 3;

/**
 * Ссылка на ЧУЖОЙ документ перед «№»: «Реестр 2 к АОСР № ПБ-1».
 *
 * Предлог «к» отделяет номер родителя от номера самой строки. Без проверки
 * строка «Реестр 2 к АОСР № ПБ-1 от 31.03.2026» искалась бы по номеру акта — и
 * правило п. 4 отвечало «документа с номером ПБ-1 нет», хотя реестр № 2 лежит
 * в комплекте, а «ПБ-1» — это акт, к которому он приложен.
 */
export const PARENT_REFERENCE_BEFORE_NUMBER = /(?:^|[^\p{L}])к\s+\p{L}[^№]*$/u;

/** Номера, названные в строке перечня, в порядке появления, без хвостовой пунктуации. */
export function actItemNumbers(text: string): readonly string[] {
  const numbers: string[] = [];
  for (const match of text.matchAll(ACT_ITEM_NUMBER)) {
    const raw = (match[1] ?? '').replace(/[.,;:]+$/u, '').trim();
    if (raw === '' || numbers.includes(raw)) continue;
    numbers.push(raw);
  }
  return numbers;
}

/**
 * Собственный номер строки перечня: первый «№», перед которым не стоит ссылка
 * на родителя.
 *
 * `null` — номера нет либо единственный номер принадлежит родителю («Реестр 2 к
 * АОСР № ПБ-1»): считать его номером строки значило бы искать не тот документ.
 */
export function ownDocNoOf(text: string): string | null {
  for (const match of text.matchAll(ACT_ITEM_NUMBER)) {
    const index = match.index ?? 0;
    if (PARENT_REFERENCE_BEFORE_NUMBER.test(text.slice(0, index))) continue;
    const raw = (match[1] ?? '').replace(/[.,;:]+$/u, '').trim();
    if (raw !== '') return raw;
  }
  return null;
}

/**
 * Ссылка на реестр приложений внутри строки перечня.
 *
 * Бланк пишет её тремя способами, и все три встречаются в боевой базе:
 * «Реестр 1 к АОСР №ПБ-1 от 31.03.2026г», «Реестр №1.1 к АОСР № 48-ОТ/-1 этаж»,
 * «Перечислено в реестре приложений №1». Номер реестра — короткое число с
 * необязательной точкой («1», «2», «1.1»); всё длиннее — номер чужого
 * документа, а не реестра.
 *
 * «Рестр» — то, как OCR прочитал заголовок «Реестр № 2 к АОСР № ПБ-1» в боевой
 * базе: без второй «е» слово теряется целиком, и реестр остаётся безномерным.
 */
const REGISTRY_REFERENCE =
  /ре{1,2}стр\p{L}*(?:\s+приложений)?\s*(?:№|N[oО]?|Не)?\s*(\d{1,3}(?:\.\d{1,3})?)(?![\d.])/iu;

export function registryRefNumber(text: string): string | null {
  const match = REGISTRY_REFERENCE.exec(text);
  return match?.[1] ?? null;
}

/**
 * Строка перечня целиком — ссылка на реестр, а не перечисление.
 *
 * Различие по НАЧАЛУ строки: «Реестр № 1 к …» и «Перечислено в реестре
 * приложений № 1» — ссылки; «Песок для строительных работ (Паспорт …)» —
 * перечисление, даже если где-то дальше в нём встретится слово «реестр».
 */
const REGISTRY_REFERENCE_ENTRY =
  /^\s*(?:\d{1,2}\s*[.)]\s*)?(?:перечислен\p{L}*\s+в\s+|см\.?\s+|согласно\s+)?ре{1,2}стр/iu;

/** Позиция перечня п. 3: материал и документы, названные при нём. */
export interface ActItemPosition {
  readonly raw: string;
  /** Текст до первой скобки, без порядкового номера «1.» и хвостовых знаков. */
  readonly name: string;
  /** Номера документов позиции: не короче трёх знаков и хотя бы с одной цифрой. */
  readonly numbers: readonly string[];
}

export type ActItemEntry =
  | { readonly kind: 'registry_ref'; readonly number: string; readonly raw: string }
  | {
      readonly kind: 'materials';
      readonly positions: readonly ActItemPosition[];
      readonly raw: string;
    }
  | { readonly kind: 'unparsed'; readonly raw: string };

/** Начало позиции: «1.» или «2)» перед буквой. Пробел или начало строки — обязательны. */
const POSITION_START = /(?:^|\s)(\d{1,2})\s*[.)]\s*(?=\p{L})/gu;

/**
 * Разбивает текст п. 3 на позиции.
 *
 * Резать можно только на НУЛЕВОЙ глубине скобок: внутри скобок стоят даты
 * («от 26.09.2024г.») и номера («RU.MCC.234»), и «24г. Сертификат» без учёта
 * скобок выглядело бы началом позиции. «0.5 мм» позицией не становится — после
 * точки идёт цифра, а не буква.
 */
export function splitItemPositions(text: string): readonly ActItemPosition[] {
  const depthAt: number[] = new Array<number>(text.length + 1).fill(0);
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    depthAt[i] = depth;
    const char = text[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
  }

  const starts: number[] = [];
  for (const match of text.matchAll(POSITION_START)) {
    // Позиция начинается с цифры, а не с пробела перед ней.
    const at = (match.index ?? 0) + (/^\s/u.test(match[0]) ? 1 : 0);
    if ((depthAt[at] ?? 0) === 0) starts.push(at);
  }

  const chunks: string[] = [];
  if (starts.length === 0) {
    chunks.push(text);
  } else {
    if ((starts[0] ?? 0) > 0) {
      const head = text.slice(0, starts[0]).trim();
      if (head !== '') chunks.push(head);
    }
    for (let i = 0; i < starts.length; i += 1) {
      const from = starts[i] ?? 0;
      const to = i + 1 < starts.length ? (starts[i + 1] ?? text.length) : text.length;
      chunks.push(text.slice(from, to));
    }
  }

  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => toPosition(chunk));
}

function toPosition(chunk: string): ActItemPosition {
  const withoutOrdinal = chunk.replace(/^\d{1,2}\s*[.)]\s*/u, '');
  const paren = withoutOrdinal.indexOf('(');
  const name = (paren === -1 ? withoutOrdinal : withoutOrdinal.slice(0, paren))
    .replace(/[\s.,;:—-]+$/u, '')
    .trim();
  const numbers = actItemNumbers(chunk).filter(
    (number) =>
      number.replace(/\s+/gu, '').length >= MIN_ACT_ITEM_NUMBER_LENGTH && /\d/u.test(number),
  );
  return { raw: chunk, name, numbers };
}

/**
 * Записи п. 3 акта → разобранные позиции.
 *
 * Запись, начинающаяся ссылкой на реестр, — ссылка; запись хотя бы с одной
 * позицией — перечисление; остальное — «не разобрано», и вызывающий обязан
 * сказать об этом словами, а не молча счесть материалы подтверждёнными.
 */
export function parseActItem3(entries: readonly string[]): readonly ActItemEntry[] {
  return entries.map((raw) => {
    if (REGISTRY_REFERENCE_ENTRY.test(raw)) {
      const number = registryRefNumber(raw);
      if (number !== null) return { kind: 'registry_ref', number, raw };
    }
    const positions = splitItemPositions(raw).filter((position) => position.name !== '');
    // Перечисление — это позиции с документами: хотя бы у одной есть номер
    // либо скобка с реквизитами. «см. приложения» позицией не является.
    const listed = positions.some(
      (position) => position.numbers.length > 0 || position.raw.includes('('),
    );
    if (listed) return { kind: 'materials', positions, raw };
    return { kind: 'unparsed', raw };
  });
}
