/**
 * Фаза 1 сегментации — детерминированная классификация страниц (§8.2).
 *
 * Чистая функция: ни базы, ни сети, ни часов. Вход — страницы с текстом и
 * составом блоков, выход — ровно одно решение на страницу в том же порядке.
 *
 * ## Что здесь нового по сравнению с S1
 *
 * S1 отремонтировал якоря (`packages/doc-types/matching.ts`) и замерил их на
 * корпусе: 56 блоков из 158 получили тип, 67 — роль страницы, 35 остались без
 * сигнала (`docs/CORPUS_FINDINGS.md`). Замер же назвал четыре класса
 * документов, которые текстом не определяются В ПРИНЦИПЕ. Их и закрывает эта
 * фаза, причём каждый — своим механизмом, а не общим «поумнее»:
 *
 * 1. **Исполнительные схемы (0 из 4).** Слов «исполнительная схема» нет ни в
 *    тексте, ни в штампе. Единственный различающий признак — состав блоков
 *    страницы: `image` вместе со `stamp`. Признак косвенный, поэтому тип
 *    присваивается с НИЗКОЙ уверенностью и исходом `uncertain` — декодер
 *    обязан пометить такой документ `needs_review`.
 * 2. **Продолжения без маркера.** Закрываются внутридокументными счётчиками:
 *    «Лист 2 из 2» — сильный сигнал продолжения, «Лист 1 из 2» — наоборот,
 *    признак ПЕРВОЙ страницы, и присоединять её к предыдущему документу
 *    нельзя. Одним якорем эти два случая неразличимы, поэтому счётчик
 *    разбирается отдельно, а не оставлен роли `doc_continuation`.
 * 3. **Страница, отданная одним `image`-блоком** (техпаспорт МСЕТ): текста
 *    нет вовсе, решать может только человек или фаза 2 по описанию графики.
 * 4. **Заголовок, разорванный OCR на две строки** («СЕРТИФИКАТ» /
 *    «СООТВЕТСТВИЯ»): ограниченная склейка соседних коротких строк.
 *
 * ## Чего здесь намеренно НЕТ
 *
 * Смена исходного файла и смена ориентации самостоятельных решений не
 * принимают (§8.2, «слабые приоры»). Документ штатно продолжается в другом
 * одностраничном файле — подрядчики так и сдают сканы; A3-схема среди
 * текстовых листов меняет ориентацию, оставаясь частью того же документа.
 * Обратное правило («новый файл — новый документ») разорвало бы каждый такой
 * документ, а такая ошибка границы тихая и высокоуверенная — §16 называет её
 * более значимой, чем F1. Поэтому оба признака только ДОПИСЫВАЮТСЯ в
 * объяснение решения и видны инженеру, но метку не меняют.
 */
import {
  DEFAULT_HEADING_LINES,
  DOC_TYPES,
  matchDocTypes,
  MAX_TRAILING_CHARS,
  introducesFollowingLine,
  matchPageRoles,
  normalizeLine,
  PAGE_ROLES,
  resolveDocType,
} from '@id/doc-types';
import {
  detectActContinuation,
  detectPrimaryAct,
  isActContinuation,
  isPrimaryAct,
  PRIMARY_ACT_CONFIDENT_MARKERS,
} from './primary-act.js';
import { OPENER_RE } from './document-openers.js';
import { continuesTable } from './table-flow.js';
import type { PageClassification, PageInput, TextEvidence, TypeOutcome } from './types.js';

export interface Phase1Options {
  /** Размер зоны заголовка в строках; по умолчанию — значение каталога. */
  readonly headingLines?: number;
}

/**
 * Уверенности фазы 1 — константами, а не числами по месту.
 *
 * Их сравнивают между собой (декодер отделяет уверенный тип от гипотезы),
 * поэтому шкала обязана быть одна и видимая целиком.
 */
export const PHASE1_CONFIDENCE = {
  /** Разметка человека. Выше не бывает: это и есть эталон. */
  manual: 1,
  /** Якорь каталога сработал на строке заголовка. */
  anchor: 0.9,
  /** Якорь сработал, но кандидатов равного приоритета несколько. */
  anchorAmbiguous: 0.5,
  /** Якорь сработал на СКЛЕЕННОЙ строке — реконструкция, а не факт текста. */
  gluedAnchor: 0.6,
  /** Счётчик листов «Лист N из M», N > 1. */
  sheetCounter: 0.7,
  /** Роль страницы найдена якорем роли. */
  role: 0.75,
  /** Тип присвоен по составу блоков — косвенный признак. */
  blocks: 0.35,
  /**
   * Воспроизведена форма бланка освидетельствования: три признака и более.
   *
   * Выше `KNOWN_TYPE_MIN_CONFIDENCE`, и это существенно: ниже порога документ
   * не считался бы уверенно типизированным, и весь чек-лист АОСР ответил бы
   * `n_a` — то есть акт был бы найден и не проверен.
   */
  actForm: 0.85,
  /** Форма бланка узнана по двум признакам: гипотеза, требует проверки. */
  actFormWeak: 0.6,
  /**
   * Лист продолжает бланк акта: признаки подвала при акте на предыдущем листе.
   *
   * Ниже `sheetCounter` (0.7): счётчик утверждает позицию листа прямо, а здесь
   * вывод сделан из соседства двух признаков.
   */
  actContinuation: 0.65,
  /**
   * Заголовок опознан как заголовок ДОКУМЕНТА, но ни один тип не подошёл.
   *
   * Значение высокое намеренно: §0.5 прямо разрешает высокую уверенность у
   * `other`. Утверждается ведь не вид документа, а гораздо более слабое —
   * «этот лист начинает самостоятельный документ», и подтверждено оно строкой
   * текста, а не косвенным признаком.
   */
  unknownHeading: 0.65,
  /**
   * Заголовок прочитан в пересказе графики, а не в тексте листа.
   *
   * Ниже `unknownHeading` (0.65) намеренно: там утверждение опирается на строку
   * САМОГО документа, здесь — на прозу распознавания о нём. Выше `blocks`
   * (0.35): состав блоков — косвенный признак, а пересказ называет вид словами.
   *
   * Значение обязано остаться ниже `KNOWN_TYPE_MIN_CONFIDENCE` (0.8): лист,
   * типизированный по пересказу, уверенно типизированным не считается и уходит
   * к человеку с `needs_review`.
   */
  imageSummary: 0.45,
  /** Сигнала нет. */
  none: 0,
} as const;

/** Тип, который присваивается по составу блоков. Единственный такой в каталоге. */
const EXEC_SCHEME_CODE = 'exec_scheme';

/** Тип, который присваивается по форме печатного бланка. Тоже единственный. */
const PRIMARY_ACT_CODE = 'aosr';

/**
 * Роль «продолжение документа» — метка `I-DOC`, а не `A-ROLE`.
 *
 * Роль появилась на S1 и по смыслу совпадает с `I-DOC` из §8.2: лист
 * продолжает предыдущий документ. Оставить её `A-ROLE` значило бы завести
 * два разных имени для одного состояния и заставить декодер их согласовывать.
 */
const DOC_CONTINUATION = 'doc_continuation';

/**
 * Роль «на листе нет ничего, кроме штампа электронной подписи».
 *
 * Названа здесь потому, что фаза 1 обязана её СНИМАТЬ там, где содержание на
 * листе всё-таки есть: декодер присоединяет такой лист к предыдущему
 * документу по соседству, и ошибка была бы тихой.
 */
const SIGNATURE_ROLE = 'signature_visual';

/**
 * Роль «лист заверен штампом „КОПИЯ ВЕРНА“».
 *
 * Названа здесь по той же причине, что и `SIGNATURE_ROLE`: фаза 1 обязана её
 * СНИМАТЬ там, где лист начинает собственный документ. Штамп заверения ставится
 * в свободное место листа и о РОЛИ листа не говорит ничего — в комплекте
 * `№01_Бл_П` он стоит на каждой странице подряд, и роль уносила в непривязанные
 * семь листов, среди которых шесть приложений, названных строками реестра
 * («ПРОТОКОЛ АТТЕСТАЦИИ № 60261» получал `A-ROLE` при заголовке в первой строке).
 */
const COPY_STAMP_ROLE = 'copy_stamp';

/**
 * Порядок разбора ролей при нескольких совпадениях.
 *
 * Роли ищутся по всей странице, поэтому совпасть могут сразу две: лист
 * приложения с «КОПИЯ ВЕРНА» в углу. Выигрывает та, что говорит о ПРИНАДЛЕЖНОСТИ
 * листа (приложение, продолжение), а не о способе заверения копии.
 */
const ROLE_PRECEDENCE = [
  'annex_continuation',
  DOC_CONTINUATION,
  COPY_STAMP_ROLE,
  SIGNATURE_ROLE,
  'blank',
] as const;

// ── Разбор исходного текста с сохранением позиций ─────────────────────────

interface RawLine {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

/** Строки исходного текста вместе с их позициями. Позиции нужны для `evidence`. */
function rawLines(text: string): readonly RawLine[] {
  const out: RawLine[] = [];
  const re = /\r?\n/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ start: last, end: m.index, raw: text.slice(last, m.index) });
    last = m.index + m[0].length;
  }
  out.push({ start: last, end: text.length, raw: text.slice(last) });
  return out;
}

/**
 * Ведущая разметка, которую снимает `normalizeLine`.
 *
 * Список повторяет её порядок: сначала markdown-заголовок, затем маркеры
 * списка и цитаты, затем обрамляющая вертикальная черта таблицы. Повтор
 * неизбежен: `normalizeLine` возвращает строку, а нам нужна ДЛИНА снятого
 * префикса, чтобы посчитать позицию в исходном тексте.
 */
const LEADING_MARKUP: readonly RegExp[] = [/^[\s>]*#{1,6}\s*/u, /^[\s>*+-]+/u, /^\s*\|\s*/u];
const TRAILING_MARKUP = /[\s|*_`]+$/u;

/** Позиции содержательной части строки в исходном тексте. */
function contentSpan(line: RawLine): { start: number; end: number } | null {
  let offset = 0;
  for (const re of LEADING_MARKUP) {
    const m = re.exec(line.raw.slice(offset));
    if (m && m.index === 0) offset += m[0].length;
  }
  let end = line.raw.length;
  const tail = TRAILING_MARKUP.exec(line.raw.slice(offset));
  if (tail) end = offset + tail.index;
  if (end <= offset) return null;
  return { start: line.start + offset, end: line.start + end };
}

/**
 * Сопоставляет номер НОРМАЛИЗОВАННОЙ строки с исходной.
 *
 * `normalizeLines` выбрасывает пустые строки, поэтому номера расходятся, а
 * `evidence` обязан указывать в исходный текст: именно на нём измеряются
 * `char_span` в `page_text_versions` (§3.5, `offset_convention`).
 */
function rawLineByNormalizedIndex(lines: readonly RawLine[], index: number): RawLine | null {
  let seen = 0;
  for (const line of lines) {
    if (normalizeLine(line.raw).length === 0) continue;
    if (seen === index) return line;
    seen += 1;
  }
  return null;
}

function evidenceFor(page: PageInput, span: { start: number; end: number }): TextEvidence | null {
  // Без версии текста доказательство некуда привязать: `char_span` без
  // `page_text_version_id` указывает в никуда и в БД не запишется.
  if (page.pageTextVersionId === null) return null;
  return {
    pageTextVersionId: page.pageTextVersionId,
    charStart: span.start,
    charEnd: span.end,
    // Ровно срез исходного текста, а не то, что вернул матчер по
    // нормализованной строке: иначе цитата не совпадёт с подсветкой в UI.
    quote: page.text.slice(span.start, span.end),
  };
}

// ── Склейка разорванного заголовка ────────────────────────────────────────

/** Максимальная длина фрагмента разорванного заголовка. */
const GLUE_MAX_FRAGMENT_CHARS = 24;
/** Максимальное число склеиваемых строк. */
const GLUE_MAX_FRAGMENTS = 3;
/** Завершающая пунктуация: признак законченной фразы, а не обрывка заголовка. */
const GLUE_TERMINAL_PUNCTUATION = /[.,;:!?)\]»"'–—-]$/u;

/**
 * Годится ли строка в обрывок разорванного заголовка.
 *
 * Три условия сразу, и каждое стоит денег, если его снять:
 *
 * - **короткая**: длинная строка — это содержательный текст, а не обрывок;
 * - **без завершающей пунктуации**: «Настоящий сертификат выдан.» закончена,
 *   а «СЕРТИФИКАТ» — нет;
 * - **в верхнем регистре**: заголовки в сканах набраны прописными, а
 *   содержательный текст — нет. Это самое дешёвое и самое сильное условие:
 *   без него склеивались бы соседние строки таблиц и подписи.
 *
 * Плата известна и измерена (см. `classify.test.ts`): разрыв заголовка,
 * набранного строчными («Сертификат» / «соответствия»), не ловится. Такой
 * случай уходит в фазу 2, а не порождает ложный тип в фазе 1.
 */
function isHeadingFragment(line: string): boolean {
  if (line.length === 0 || line.length > GLUE_MAX_FRAGMENT_CHARS) return false;
  if (GLUE_TERMINAL_PUNCTUATION.test(line)) return false;
  if (!/\p{Lu}/u.test(line)) return false;
  return line === line.toLocaleUpperCase('ru');
}

/** Склейки-кандидаты в зоне заголовка вместе с диапазоном исходных строк. */
interface GlueCandidate {
  readonly text: string;
  readonly firstNormalizedIndex: number;
  readonly lastNormalizedIndex: number;
}

function glueCandidates(
  normalized: readonly string[],
  headingLines: number,
): readonly GlueCandidate[] {
  const zone = normalized.slice(0, headingLines);
  const out: GlueCandidate[] = [];
  for (let i = 0; i < zone.length; i += 1) {
    if (!isHeadingFragment(zone[i] as string)) continue;
    for (let size = 2; size <= GLUE_MAX_FRAGMENTS && i + size <= zone.length; size += 1) {
      const window = zone.slice(i, i + size);
      if (!window.every(isHeadingFragment)) break;
      out.push({
        text: window.join(' '),
        firstNormalizedIndex: i,
        lastNormalizedIndex: i + size - 1,
      });
    }
  }
  return out;
}

// ── Заголовок неизвестного вида документа (открытый мир, §0.5) ───────────
//
// Список слов-открывателей и шаблон живут в `document-openers.ts`: по ним
// отвечает на свой вопрос ещё и извлечение реквизитов — «какой из номеров на
// листе принадлежит САМОМУ документу». Одна копия на двоих, а не две.

/**
 * Заголовок ищется только в самом верху: ниже начинается содержание.
 *
 * Восемь, а не три. Три строки покрывали лист, у которого заголовок напечатан
 * первым, и не покрывали ни одного бланка с шапкой организации: у свидетельства
 * о поверке над титулом стоят три строки лаборатории с номером аккредитации, и
 * «СВИДЕТЕЛЬСТВО О ПОВЕРКЕ» оказывается ЧЕТВЁРТОЙ строкой. Лист уходил в
 * непривязанные вместе со своей строкой реестра.
 *
 * Расширение безопасно, потому что цену ложного срабатывания платит не это
 * число, а требования `findUnknownDocumentHeading`: открывающее слово из
 * закрытого списка в начале строки, отсутствие табличных разделителей и
 * завершающей пунктуации предложения, запрет элемента перечня под двоеточием.
 * Шапка организации ни одному из них не удовлетворяет.
 */
const UNKNOWN_HEADING_LINES = 8;
const UNKNOWN_HEADING_MIN_CHARS = 6;
const UNKNOWN_HEADING_MAX_CHARS = 160;

/**
 * Строка, которая выглядит заголовком самостоятельного документа.
 *
 * Возвращает индекс в нормализованном представлении либо `-1`. Требования
 * складываются так, чтобы ложное срабатывание было дороже пропуска:
 * открывающее слово из закрытого списка, положение в первых строках,
 * отсутствие табличных разделителей и завершающей пунктуации предложения.
 */
function findUnknownDocumentHeading(normalized: readonly string[]): number {
  const zone = Math.min(UNKNOWN_HEADING_LINES, normalized.length);
  for (let i = 0; i < zone; i += 1) {
    const line = normalized[i] as string;
    if (line.length < UNKNOWN_HEADING_MIN_CHARS) continue;
    if (line.length > UNKNOWN_HEADING_MAX_CHARS) continue;
    // Табличная строка заголовком не является: реестр приложений перечисляет
    // документы построчно, и каждая такая строка начинается словом из списка.
    if (line.includes('|')) continue;
    // Предложение, а не заголовок.
    if (/[.,;:]$/u.test(line)) continue;
    // Элемент перечня, введённого двоеточием строкой выше, — упоминание
    // документа, а не его заголовок. Тот же запрет, что и у якорей каталога
    // (`opensEnumeration`), и он обязан стоять здесь тоже: иначе снятый с
    // якоря перечень немедленно возвращается открытым миром, только уже с
    // резервным типом, и ложная граница остаётся на месте.
    if (i > 0 && introducesFollowingLine(normalized[i - 1] as string)) continue;
    if (!OPENER_RE.test(line.toUpperCase())) continue;
    return i;
  }
  return -1;
}

// ── Заголовок листа, отданного графикой ───────────────────────────────────

/**
 * Абзац описания IMAGE-блока, с которого начинается пересказ листа.
 *
 * `renderPageText` печатает описание блока четырьмя абзацами — `Summary:`,
 * `Description:`, `Entities:`, `Verification:` (`packages/recognition/src/render.ts`).
 * Заголовком листа распоряжается только первый: остальные три перечисляют
 * содержимое и УПОМИНАЮТ чужие документы. Приложение-схема к протоколу
 * уплотнения описано как «…к протоколу № 2410-04/10», и открывать по такому
 * упоминанию документ значило бы рвать комплект на ровном месте.
 */
const IMAGE_SUMMARY_LINE = /^Summary:\s*(.+)$/iu;

/**
 * Сколько символов пересказа считается его первым утверждением.
 *
 * Пересказ — это ПРЕДЛОЖЕНИЕ, а не заголовок: «Сертификат калибровки №240545 от
 * 15.04.2024 на плотномер пенетрационный В-1 (зав. № 90), выполненный ООО …».
 * Проверять его целиком требованиями `findUnknownDocumentHeading` нельзя — он
 * длиннее любого заголовка и кончается точкой. Решает голова строки: документ
 * называет себя первым, а обстоятельства идут следом.
 *
 * Значение равно `MAX_TRAILING_CHARS`, и это не совпадение. Якорь каталога
 * считается сработавшим, только если хвост после совпадения короче этого
 * порога (`matchesAsHeading`). Голова длиной в сам порог проходит его при
 * ЛЮБОЙ длине якоря — даже нулевой, — а голова длиннее отвергалась бы тем
 * сильнее, чем короче якорь: пересказ «Сертификат калибровки №240545…» в 120
 * символов не смыкался с якорем `СЕРТИФИКАТ\s+КАЛИБРОВКИ` именно по хвосту.
 */
const IMAGE_SUMMARY_HEAD_CHARS = MAX_TRAILING_CHARS;

/** Обрезка по границе слова: заголовок, разорванный посреди слова, — мусор. */
function headOf(text: string, limit: number): string {
  if (text.length <= limit) return text.trim();
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

export interface ImageSummaryHeading {
  /** Голова пересказа: она же `observed_title` листа. */
  readonly text: string;
  /** Индекс строки `Summary:` в нормализованном представлении. */
  readonly lineIndex: number;
}

/**
 * Заголовок листа, у которого текста нет, а есть пересказ графики.
 *
 * Нужен потому, что якорь каталога сюда не дотягивается ПО ПОСТРОЕНИЮ:
 * `matchesAsHeading` требует совпадения с позиции 0, а `normalizeLine` снимает
 * `**`, но оставляет служебный префикс `Summary:`. Ни расширение зоны
 * заголовка, ни новые виды каталога этого не меняют — отсюда отдельная ступень.
 *
 * Возвращается голова пересказа, а решение о виде принимает вызывающий: он
 * пробует по ней и якоря каталога, и открытый мир. Здесь же — только ответ на
 * вопрос «начинает ли этот лист самостоятельный документ», и отвечает на него
 * открывающее слово из того же закрытого списка `DOCUMENT_OPENERS`.
 *
 * Замер на корпусе `temp/MD/new`: правило принимает пересказы «Сертификат
 * калибровки №240545…», «Протокол испытания от 04.10.2024…», «Сертификат № 275
 * от 8 августа 2023 г…» и отвергает «Схема расположения контролируемых
 * участков… к протоколу № 2410-04/10», «Ситуационный план…», «Фрагмент плана…»
 * — то есть ровно приложения и фрагменты, документами не являющиеся.
 */
export function findImageSummaryHeading(normalized: readonly string[]): ImageSummaryHeading | null {
  for (const [index, line] of normalized.entries()) {
    const match = IMAGE_SUMMARY_LINE.exec(line);
    if (match === null) continue;

    const summary = (match[1] ?? '').trim();
    if (summary.length < UNKNOWN_HEADING_MIN_CHARS) continue;

    const head = headOf(summary, IMAGE_SUMMARY_HEAD_CHARS);
    if (!OPENER_RE.test(head.toUpperCase())) continue;

    return { text: head, lineIndex: index };
  }
  return null;
}

// ── Внутридокументные счётчики ────────────────────────────────────────────

const SHEET_COUNTER = /^(?:лист|страница)\s+(\d{1,3})\s+из\s+(\d{1,3})\b/iu;

/**
 * Тот же счётчик листов, но разнесённый по ДВУМ полям бланка.
 *
 * «Лист N из M» — не единственная его раскладка. Типографский бланк сертификата
 * качества печатает счётчик двумя отдельными полями в шапке — «Лист ___» и
 * «Листов ___», — и OCR отдаёт их разными строками, часто вперемешку с
 * соседними ячейками таблицы («Нормативный документ | Лист 2», «СТБ 1704-2012 |
 * Листов 2»). Смысл ровно тот же: N-й лист документа из M.
 *
 * Требуются ОБА поля сразу. Одинокое «Лист 2» встречается в реестрах и подписях
 * колонтитулов и счётчиком не является; пара «Лист N» + «Листов M» — это поля
 * бланка, и вместе они утверждают позицию листа внутри документа.
 *
 * Числа в поле, а не в фразе: после числа обязан идти конец строки или
 * разделитель ячейки. Без этого «Лист 2 из 2» разбиралось бы дважды — и как
 * поле, и как фраза, — а «Лист 2 приложения №5» стало бы счётчиком.
 */
const SHEET_FIELD = /(?:^|[|\s])лист\s+(\d{1,3})\s*(?:\||$)/iu;
const SHEETS_TOTAL_FIELD = /(?:^|[|\s])листов\s+(\d{1,3})\s*(?:\||$)/iu;

// `\w` даже под флагом `u` остаётся ASCII-классом и кириллического окончания
// не покрывает: `страниц\w*` не совпадёт со «страницах». Отсюда `\p{L}*`.
const TOTAL_SHEETS = /всего\s+на\s+(\d{1,3})\s+(?:страниц|лист)\p{L}*/iu;
const BLANK_NUMBER = /бланк\p{L}*\s*№/iu;

interface SheetCounter {
  readonly sheetNo: number;
  readonly total: number;
  readonly normalizedIndex: number;
  /** Как счётчик записан: одной фразой или двумя полями бланка. */
  readonly layout: 'phrase' | 'fields';
}

function findSheetCounter(normalized: readonly string[]): SheetCounter | null {
  for (let i = 0; i < normalized.length; i += 1) {
    const m = SHEET_COUNTER.exec(normalized[i] as string);
    if (!m) continue;
    const sheetNo = Number(m[1]);
    const total = Number(m[2]);
    if (!Number.isFinite(sheetNo) || !Number.isFinite(total)) continue;
    return { sheetNo, total, normalizedIndex: i, layout: 'phrase' };
  }

  // Раскладка бланка: два поля, каждое в своей строке.
  let sheetAt = -1;
  let sheetNo = Number.NaN;
  let total = Number.NaN;
  for (let i = 0; i < normalized.length; i += 1) {
    const line = normalized[i] as string;
    if (sheetAt < 0) {
      const m = SHEET_FIELD.exec(line);
      if (m) {
        sheetNo = Number(m[1]);
        sheetAt = i;
      }
    }
    if (!Number.isFinite(total)) {
      const m = SHEETS_TOTAL_FIELD.exec(line);
      if (m) total = Number(m[1]);
    }
  }
  if (sheetAt < 0 || !Number.isFinite(sheetNo) || !Number.isFinite(total)) return null;
  return { sheetNo, total, normalizedIndex: sheetAt, layout: 'fields' };
}

// ── Номер родителя, вынесенный на следующую строку ────────────────────────

/** Сколько строк ниже якоря роли просматривается в поисках номера родителя. */
const PARENT_LOOKAHEAD_LINES = 2;
/** Больше четырёх слов — это фраза, а не номер документа. */
const PARENT_MAX_TOKENS = 4;
const DATE_ONLY = /^\d{1,2}[./]\d{1,2}[./]\d{2,4}\s*(?:г\.?)?$/u;

/**
 * Дочитывает номер родительского документа со строки НИЖЕ якоря роли.
 *
 * Это работа, которую `page-roles.ts` явно оставил сегментатору: якорь видит
 * одну строку, а заголовок приложения в корпусе трёхстрочный —
 * «ПРИЛОЖЕНИЕ № 1» / «К СЕРТИФИКАТУ СООТВЕТСТВИЯ» / «RU.TEST.001.H.00271».
 * Без дочитывания три приложения из шести уходили в `unassigned` при том,
 * что номер родителя напечатан прямо под якорем.
 *
 * Дочитывается ТОЛЬКО после строки вида «К <родителю>»: одинокое
 * «ПРИЛОЖЕНИЕ» о родителе ничего не говорит, и следующая строка под ним —
 * это уже содержание приложения. Ошибиться здесь недорого: декодер всё равно
 * сверяет номер с текстом родительского документа и при несовпадении не
 * присоединяет лист.
 */
function parentRefBelow(normalized: readonly string[], anchorLine: string): string | null {
  const at = normalized.indexOf(anchorLine);
  if (at < 0 || !/^К\s/iu.test(anchorLine)) return null;
  for (let i = at + 1; i <= at + PARENT_LOOKAHEAD_LINES && i < normalized.length; i += 1) {
    const candidate = (normalized[i] as string).replace(/^№\s*/u, '').trim();
    if (candidate.length < 5 || candidate.length > 60) continue;
    if (!/\d/u.test(candidate)) continue;
    if (DATE_ONLY.test(candidate)) continue;
    if (candidate.split(/\s+/u).length > PARENT_MAX_TOKENS) continue;
    return candidate;
  }
  return null;
}

// ── Слабые приоры ─────────────────────────────────────────────────────────

/**
 * Приписка о слабых приорах.
 *
 * Возвращает ТОЛЬКО текст для объяснения. Ни один из этих признаков не
 * меняет метку: см. шапку файла.
 */
function weakPriorNote(page: PageInput, previous: PageInput | undefined): string {
  if (!previous) return '';
  const notes: string[] = [];
  if (previous.sourceFileId !== page.sourceFileId) {
    notes.push(
      'начало нового исходного файла (слабый приор: документ может продолжаться в другом файле)',
    );
  }
  if (previous.rotation !== page.rotation) {
    notes.push('смена ориентации (слабый приор: A3-схема встречается внутри текстового документа)');
  }
  return notes.length > 0 ? `; ${notes.join('; ')}` : '';
}

// ── Сборка решения ────────────────────────────────────────────────────────

interface Decision {
  readonly label: PageClassification['label'];
  readonly docTypeCode: string | null;
  readonly typeOutcome: TypeOutcome;
  readonly observedTitle: string | null;
  readonly pageRoleCode: string | null;
  readonly parentRef: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly source: PageClassification['source'];
  readonly alternatives: readonly string[];
  readonly ambiguous: boolean;
  readonly evidence: TextEvidence | null;
}

const NO_SIGNAL: Omit<Decision, 'reason'> = {
  label: 'U',
  docTypeCode: null,
  typeOutcome: 'none',
  observedTitle: null,
  pageRoleCode: null,
  parentRef: null,
  confidence: PHASE1_CONFIDENCE.none,
  source: 'anchor',
  alternatives: [],
  ambiguous: false,
  evidence: null,
};

function classifyOne(
  page: PageInput,
  previous: PageInput | undefined,
  headingLines: number,
): Decision {
  // 1. Ручная разметка приоритетна и фазами 1–2 не переопределяется (§8.2).
  const manual = page.manual;
  if (manual) {
    return {
      label: manual.label,
      docTypeCode: manual.docTypeCode,
      typeOutcome: manual.docTypeCode === null ? 'none' : 'known',
      observedTitle: null,
      pageRoleCode: manual.pageRoleCode,
      parentRef: null,
      confidence: PHASE1_CONFIDENCE.manual,
      reason: 'разметка человека',
      source: 'manual',
      alternatives: [],
      ambiguous: false,
      evidence: null,
    };
  }

  const lines = rawLines(page.text);
  const normalized = lines.map((l) => normalizeLine(l.raw)).filter((l) => l.length > 0);
  const note = weakPriorNote(page, previous);

  // 2. Внутридокументный счётчик листов. Стоит ВЫШЕ якорей заголовка, и это
  //    разворот прежнего порядка, за который заплачено ложной границей на
  //    сертификате качества.
  //
  //    Счётчик и якорь отвечают на один вопрос и дают противоположные ответы:
  //    якорь говорит «здесь начинается документ», счётчик — «этот лист второй
  //    по счёту внутри своего документа». Выигрывает счётчик, потому что
  //    типографский бланк печатает свою шапку — название, реквизиты
  //    изготовителя, номер и дату — НА КАЖДОМ листе, а поле «Лист N»
  //    заполняется на каждом листе своим числом. Повторная шапка выглядит
  //    заголовком, но заголовком второй раз не становится.
  //
  //    «Лист 1 из M» и «Лист 1 / Листов M» решения не принимают: первая
  //    страница документа продолжением не является, и присоединение её к
  //    предыдущему документу разорвало бы сразу два.
  const counter = findSheetCounter(normalized);
  if (counter && counter.sheetNo > 1) {
    const rawLine = rawLineByNormalizedIndex(lines, counter.normalizedIndex);
    const span = rawLine ? contentSpan(rawLine) : null;
    return {
      ...NO_SIGNAL,
      label: 'I-DOC',
      pageRoleCode: DOC_CONTINUATION,
      confidence: PHASE1_CONFIDENCE.sheetCounter,
      reason:
        counter.layout === 'phrase'
          ? `внутридокументный счётчик «лист ${counter.sheetNo} из ${counter.total}»: страница продолжает предыдущий документ${note}`
          : `счётчик листов бланка «лист ${counter.sheetNo}» при «листов ${counter.total}»: страница продолжает предыдущий документ, а шапка бланка на ней повторная${note}`,
      evidence: span ? evidenceFor(page, span) : null,
    };
  }

  // 3. Якоря каталога — построчно, через `matchDocTypes`/`resolveDocType`.
  const matches = matchDocTypes(page.text, DOC_TYPES, { headingLines });
  const resolved = resolveDocType(matches, DOC_TYPES);
  if (resolved.code !== null) {
    const hit = matches.find((m) => m.code === resolved.code);
    const rawLine = hit ? rawLineByNormalizedIndex(lines, hit.lineIndex) : null;
    const span = rawLine ? contentSpan(rawLine) : null;
    // Диапазон не выдумывается: не нашли строку в исходном тексте — evidence нет.
    const evidence = span ? evidenceFor(page, span) : null;
    return {
      label: 'B-DOC',
      docTypeCode: resolved.code,
      // `ambiguous` — каталог не различает этих кандидатов; решать человеку,
      // поэтому исход `uncertain`, а не `known` (§0.5: это разные состояния).
      typeOutcome: resolved.ambiguous ? 'uncertain' : 'known',
      observedTitle: evidence?.quote ?? hit?.line ?? null,
      pageRoleCode: null,
      parentRef: null,
      confidence: resolved.ambiguous ? PHASE1_CONFIDENCE.anchorAmbiguous : PHASE1_CONFIDENCE.anchor,
      reason: resolved.ambiguous
        ? `якорь заголовка сработал у нескольких типов равного приоритета: ${[resolved.code, ...resolved.alternatives].join(', ')}${note}`
        : `якорь заголовка типа ${resolved.code}${note}`,
      source: 'anchor',
      alternatives: resolved.alternatives,
      ambiguous: resolved.ambiguous,
      evidence,
    };
  }

  // 4. Форма бланка освидетельствования. Стоит ВЫШЕ склейки заголовка, потому
  //    что воспроизведённая печатная форма — признак сильнее реконструкции
  //    разорванной строки: склейка утверждает, что титул выглядел вот так,
  //    форма — что перед нами бланк РД-11-02 целиком.
  //
  //    Это единственный тип, опознаваемый не по титулу: потеря акта обнуляет
  //    весь анализ комплекта, а титул хрупок ровно там, где дороже всего
  //    (склеен провайдером в одну строку, разорван переносом, срезан сканом).
  const actForm = detectPrimaryAct(page.text);
  if (isPrimaryAct(actForm)) {
    const confident = actForm.markers.length >= PRIMARY_ACT_CONFIDENT_MARKERS;
    const rawLine =
      actForm.titleLineIndex >= 0 ? rawLineByNormalizedIndex(lines, actForm.titleLineIndex) : null;
    const span = rawLine ? contentSpan(rawLine) : null;
    return {
      ...NO_SIGNAL,
      label: 'B-DOC',
      docTypeCode: PRIMARY_ACT_CODE,
      // Три признака и больше — это уже не совпадение фразы, а воспроизведённая
      // форма, и тип объявляется определённым. Два — гипотеза: декодер обязан
      // поставить `needs_review`.
      typeOutcome: confident ? 'known' : 'uncertain',
      observedTitle: rawLine === null ? null : normalizeLine(rawLine.raw),
      confidence: confident ? PHASE1_CONFIDENCE.actForm : PHASE1_CONFIDENCE.actFormWeak,
      source: 'anchor',
      reason:
        `титул не опознан, но воспроизведена форма бланка освидетельствования ` +
        `(${actForm.markers.join('; ')})${note}`,
      evidence: span ? evidenceFor(page, span) : null,
    };
  }

  // 5. Склейка разорванного заголовка — только когда обычный якорь не сработал.
  //    Порядок важен: реконструкция не имеет права переспорить настоящую строку.
  const glued = glueCandidates(normalized, headingLines);
  if (glued.length > 0) {
    const augmented = glued.map((g) => g.text).join('\n') + '\n' + page.text;
    const gluedMatches = matchDocTypes(augmented, DOC_TYPES, {
      headingLines: headingLines + glued.length,
    }).filter((m) => m.lineIndex < glued.length);
    const gluedResolved = resolveDocType(gluedMatches, DOC_TYPES);
    if (gluedResolved.code !== null) {
      const hit = gluedMatches.find((m) => m.code === gluedResolved.code) as {
        readonly lineIndex: number;
      };
      const candidate = glued[hit.lineIndex] as GlueCandidate;
      const first = rawLineByNormalizedIndex(lines, candidate.firstNormalizedIndex);
      const last = rawLineByNormalizedIndex(lines, candidate.lastNormalizedIndex);
      const firstSpan = first ? contentSpan(first) : null;
      const lastSpan = last ? contentSpan(last) : null;
      const evidence =
        firstSpan && lastSpan
          ? evidenceFor(page, { start: firstSpan.start, end: lastSpan.end })
          : null;
      return {
        label: 'B-DOC',
        docTypeCode: gluedResolved.code,
        typeOutcome: gluedResolved.ambiguous ? 'uncertain' : 'known',
        observedTitle: candidate.text,
        pageRoleCode: null,
        parentRef: null,
        confidence: PHASE1_CONFIDENCE.gluedAnchor,
        reason: `якорь типа ${gluedResolved.code} сработал на склейке разорванного заголовка «${candidate.text}»${note}`,
        source: 'anchor',
        alternatives: gluedResolved.alternatives,
        ambiguous: gluedResolved.ambiguous,
        evidence,
      };
    }
  }

  // 6. Классификация по составу блоков: `image` + `stamp` без якорей — схема.
  //    Признак косвенный, поэтому исход `uncertain` и низкая уверенность:
  //    декодер обязан поставить `needs_review`.
  const hasImage = page.blockTypes.includes('image');
  const hasStamp = page.blockTypes.includes('stamp');
  if (hasImage && hasStamp) {
    return {
      ...NO_SIGNAL,
      label: 'B-DOC',
      docTypeCode: EXEC_SCHEME_CODE,
      typeOutcome: 'uncertain',
      confidence: PHASE1_CONFIDENCE.blocks,
      source: 'blocks',
      reason: `состав блоков страницы (графика и штамп) без якорей заголовка — кандидат в ${EXEC_SCHEME_CODE}; тип присвоен по косвенному признаку и требует подтверждения${note}`,
    };
  }

  // 7. Лист, отданный графикой: заголовок ищется в пересказе IMAGE-блока.
  //
  //    Стоит ВЫШЕ ролей и НИЖЕ всех текстовых признаков. Ниже — потому что
  //    строка самого документа всегда сильнее прозы о нём. Выше — потому что
  //    штамп «КОПИЯ ВЕРНА» стоит и на листах, отданных графикой, и роль
  //    уносила бы их в служебные вместе с их строкой реестра: так терялись
  //    сертификат калибровки №240545 и протокол уплотнения 2410-04/10.
  const unknownHeadingIndex = findUnknownDocumentHeading(normalized);
  if (unknownHeadingIndex < 0 && page.blockTypes.includes('image')) {
    const summary = findImageSummaryHeading(normalized);
    if (summary !== null) {
      // Вид определяется по ТОЙ ЖЕ голове пересказа, а не по всей странице:
      // `Description` и `Entities` перечисляют содержимое листа и упоминают
      // чужие документы, и якорь на них поймал бы упоминание, а не заголовок.
      const summaryMatches = matchDocTypes(summary.text, DOC_TYPES, { headingLines: 1 });
      const summaryType = resolveDocType(summaryMatches, DOC_TYPES);
      const rawLine = rawLineByNormalizedIndex(lines, summary.lineIndex);
      const span = rawLine ? contentSpan(rawLine) : null;
      return {
        ...NO_SIGNAL,
        label: 'B-DOC',
        docTypeCode: summaryType.code,
        // Никогда не `known`: вид прочитан в пересказе распознавания, и
        // подтвердить его обязан человек — даже когда якорь каталога сомкнулся.
        typeOutcome: summaryType.code === null ? 'other' : 'uncertain',
        observedTitle: summary.text,
        confidence: PHASE1_CONFIDENCE.imageSummary,
        reason:
          summaryType.code === null
            ? `лист отдан графикой; пересказ «${summary.text}» опознан как заголовок документа, но ни один вид каталога не подошёл${note}`
            : `лист отдан графикой; якорь типа ${summaryType.code} сработал на пересказе «${summary.text}» — вид требует подтверждения${note}`,
        alternatives: summaryType.alternatives,
        ambiguous: summaryType.ambiguous,
        evidence: span ? evidenceFor(page, span) : null,
      };
    }
  }

  // 8. Роли страницы. Роль документа не открывает: `A-ROLE` — служебный лист,
  //    и присоединять ли его, решает декодер по `autoAttach` и по контексту.
  const continuesPreviousTable = previous !== undefined && continuesTable(previous.text, page.text);
  const roles = matchPageRoles(page.text, PAGE_ROLES).filter((r) => {
    // Якорь роли `doc_continuation` ловит «Лист N из M» при ЛЮБОМ N, включая
    // первый. Первая страница документа продолжением не является, и
    // присоединение её к предыдущему документу разорвало бы сразу два: этот
    // потерял бы начало, а предыдущий получил бы чужой хвост.
    if (r.code === DOC_CONTINUATION) {
      const m = SHEET_COUNTER.exec(r.line);
      return !(m && Number(m[1]) === 1);
    }
    // Роль визуализации подписи означает «на листе нет ничего, кроме штампа»
    // — так она и определена в каталоге, который прямо оставляет
    // окончательное решение сегментатору: якорь видит строку, а не страницу.
    // Безголовое продолжение таблицы предыдущего листа этот ответ
    // опровергает: содержание на листе есть, и принадлежит он тому же
    // документу. Без этой строки хвост реестра приложений с блоком подписей
    // внизу получал роль, уходил в непривязанные, и три его позиции
    // терялись молча (боевой комплект 01-ДК2-СЦ).
    if (r.code === SIGNATURE_ROLE) return !continuesPreviousTable;
    // Штамп заверения копии о РОЛИ листа не говорит ничего: он ставится в
    // свободное место любого листа, содержательного в том числе. Роль
    // осмысленна лишь там, где кроме штампа на листе ничего нет, — и заголовок
    // документа это опровергает ровно так же, как продолжение таблицы
    // опровергает роль визуализации подписи строкой выше.
    //
    // Без этой строки семь листов комплекта `№01_Бл_П` уходили в непривязанные
    // при собственных заголовках в первой строке, а шесть строк реестра
    // получали «нет в комплекте» на документы, которые в комплекте лежат.
    if (r.code === COPY_STAMP_ROLE) return unknownHeadingIndex < 0;
    return true;
  });
  if (roles.length > 0) {
    const chosen =
      ROLE_PRECEDENCE.map((code) => roles.find((r) => r.code === code)).find((r) => r) ??
      (roles[0] as (typeof roles)[number]);
    const isContinuation = chosen.code === DOC_CONTINUATION;
    const parentRef =
      chosen.parentRef ??
      (chosen.code === 'annex_continuation' ? parentRefBelow(normalized, chosen.line) : null);
    return {
      ...NO_SIGNAL,
      label: isContinuation ? 'I-DOC' : 'A-ROLE',
      pageRoleCode: chosen.code,
      parentRef,
      confidence: PHASE1_CONFIDENCE.role,
      source: 'anchor',
      reason: `якорь роли страницы ${chosen.code}${parentRef ? ` с номером родителя «${parentRef}»` : ''}${note}`,
    };
  }

  // 9. Страница, отданная одним `image`-блоком: текста нет, решать нечем.
  if (page.blockTypes.length === 1 && page.blockTypes[0] === 'image' && normalized.length === 0) {
    return {
      ...NO_SIGNAL,
      reason: `текст страницы отсутствует, содержимое в графике${note}`,
    };
  }

  // 10. Открытый мир: заголовок опознан как заголовок ДОКУМЕНТА, но ни один
  //    тип каталога не подошёл (§0.5, п.1). Это не «не уверен», а «уверен, что
  //    это документ, и уверен, что вида такого у меня нет» — два разных
  //    состояния с разным поведением, и различать их обязан уже здесь, а не
  //    только LLM. Без этого шага незнакомый вид документа виден системе
  //    исключительно при подключённой модели, то есть требование §16 держалось
  //    бы внешним сервисом.
  //
  //    Сам поиск заголовка выполнен ВЫШЕ, перед ролями: его ответ нужен обоим
  //    шагам, и второй вызов был бы вторым источником правды о том, начинает ли
  //    лист документ.
  if (unknownHeadingIndex >= 0) {
    const headingText = normalized[unknownHeadingIndex] as string;
    const rawLine = rawLineByNormalizedIndex(lines, unknownHeadingIndex);
    const span = rawLine ? contentSpan(rawLine) : null;
    return {
      ...NO_SIGNAL,
      label: 'B-DOC',
      docTypeCode: null,
      typeOutcome: 'other',
      observedTitle: headingText,
      confidence: PHASE1_CONFIDENCE.unknownHeading,
      reason: `заголовок «${headingText}» опознан как заголовок документа, но ни один вид каталога не подошёл${note}`,
      evidence: span ? evidenceFor(page, span) : null,
    };
  }

  // 11. Сигнала нет. «Лист 1 из M» и «всего на N страницах» самостоятельного
  //    решения не дают, но подсказывают ожидаемый объём документа — это
  //    попадает в объяснение и помогает инженеру, а не подменяет решение.
  const hints: string[] = [];
  if (counter && counter.sheetNo === 1) {
    hints.push(
      `счётчик «лист 1 из ${counter.total}»: страница открывает документ на ${counter.total} листов, но заголовок не опознан`,
    );
  }
  const totalHint = TOTAL_SHEETS.exec(page.text);
  if (totalHint) hints.push(`объём документа заявлен: ${totalHint[0]}`);
  if (BLANK_NUMBER.test(page.text)) hints.push('на листе есть номер бланка');

  return {
    ...NO_SIGNAL,
    reason: `якоря каталога и ролей не сработали${hints.length > 0 ? `; ${hints.join('; ')}` : ''}${note}`,
  };
}

/**
 * Второй лист бланка присоединяется к акту.
 *
 * ## Что теряется без этого прохода
 *
 * Бланк РД-11-02 не помещается на один лист: на втором лежат п. 4 (перечень
 * подтверждающих документов), п. 5 (даты работ), п. 6, п. 7 и подписи четырёх
 * представителей — вход восьми правил чек-листа сразу. Заголовка на этом листе
 * нет по построению, счётчика «лист 2 из 2» типографский бланк не печатает, и
 * страница уходила в `unassigned` вместе со всем своим содержимым.
 *
 * ## Почему это ПОСТ-проход, а не ветка `classifyOne`
 *
 * Решение зависит от РЕШЕНИЯ соседа, а не от его текста: присоединять лист
 * можно только к акту, а был ли предыдущий лист актом — известно лишь после
 * его классификации. `classifyOne` видит `PageInput` предыдущей страницы, но не
 * её метку, и передать метку внутрь значило бы сделать функцию зависимой от
 * порядка обхода.
 *
 * ## Что именно переписывается
 *
 * Два состояния, и второе неочевидно.
 *
 * `U` — страница без сигнала: это тот самый потерянный лист с пп. 4–7.
 *
 * `B-DOC` типа акта, присвоенный ФОРМОЙ и без собственного титула. Замер на
 * корпусе показал, что раскладка бланка непостоянна: в одном пакете первый лист
 * несёт шапку с объектом и участниками, а все семь пунктов уезжают на второй.
 * Детектор формы честно опознавал там бланк — и порождал ВТОРОЙ акт на каждом
 * из шести пакетов. Собственного титула у такой страницы нет: заголовок
 * напечатан один раз, на первом листе. Поэтому форма без титула сразу за актом
 * читается как продолжение, а форма с титулом остаётся новым документом —
 * настоящий второй акт свой заголовок печатает.
 *
 * ## Три ограничения, каждое со своей ценой
 *
 * - присоединяется ТОЛЬКО непосредственно следующая страница: цепочка
 *   «акт → продолжение → продолжение» разорвана намеренно, потому что третий
 *   лист бланка не существует, а признаки подвала повторяются в подвале
 *   следующего документа;
 * - решение человека (`source: 'manual'`) не переписывается никогда — §8.2
 *   объявляет ручную разметку приоритетной;
 * - страница, получившая тип по ЯКОРЮ ЗАГОЛОВКА, не трогается: у неё есть
 *   прямой признак, и отменять его подсказкой соседа значило бы поставить
 *   контекст выше напечатанного.
 */
function linkActContinuations(
  pages: readonly PageInput[],
  decisions: readonly Decision[],
): readonly Decision[] {
  const out = [...decisions];

  for (let i = 1; i < out.length; i += 1) {
    const current = out[i] as Decision;
    const previous = out[i - 1] as Decision;

    if (current.source === 'manual') continue;
    if (previous.docTypeCode !== PRIMARY_ACT_CODE) continue;

    // Отсутствие `observedTitle` у акта означает, что тип присвоен формой, а не
    // якорем заголовка: якорь всегда кладёт в него сработавшую строку.
    const formActWithoutTitle =
      current.label === 'B-DOC' &&
      current.docTypeCode === PRIMARY_ACT_CODE &&
      current.observedTitle === null;
    if (current.label !== 'U' && !formActWithoutTitle) continue;

    const evidence = detectActContinuation((pages[i] as PageInput).text);
    if (!isActContinuation(evidence)) continue;

    out[i] = {
      ...current,
      label: 'I-DOC',
      docTypeCode: null,
      typeOutcome: 'none',
      observedTitle: null,
      alternatives: [],
      ambiguous: false,
      confidence: PHASE1_CONFIDENCE.actContinuation,
      reason:
        `страница продолжает бланк освидетельствования: предыдущий лист опознан ` +
        `как акт, на этой воспроизведены ${evidence.markers.join('; ')}` +
        `${formActWithoutTitle ? ', а собственного заголовка нет' : ''}`,
    };
  }

  return out;
}

/**
 * Классифицирует страницы фазой 1.
 *
 * Возвращает РОВНО одно решение на каждую страницу входа и в том же порядке.
 * Это не удобство, а контракт с фазой 3: декодер обходит два массива в паре,
 * и дыра в одном из них означала бы потерянную страницу — то есть нарушение
 * non-degradable инварианта §1.6 ещё до его проверки.
 */
export function classifyPages(
  pages: readonly PageInput[],
  options: Phase1Options = {},
): readonly PageClassification[] {
  const headingLines = options.headingLines ?? DEFAULT_HEADING_LINES;
  const decided = linkActContinuations(
    pages,
    pages.map((page, i) => classifyOne(page, pages[i - 1], headingLines)),
  );
  const out: PageClassification[] = pages.map((page, i) => ({
    sourcePageId: page.sourcePageId,
    ...(decided[i] as Decision),
  }));

  if (out.length !== pages.length) {
    throw new Error(
      `фаза 1 вернула ${out.length} решений на ${pages.length} страниц: дыра в назначении страниц`,
    );
  }
  for (let i = 0; i < pages.length; i += 1) {
    if ((out[i] as PageClassification).sourcePageId !== (pages[i] as PageInput).sourcePageId) {
      throw new Error(`фаза 1 нарушила порядок страниц на позиции ${i}`);
    }
  }
  return out;
}
