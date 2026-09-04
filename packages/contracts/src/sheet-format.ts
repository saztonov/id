/**
 * Формат листа и режим его разметки — ЕДИНСТВЕННАЯ реализация в портале.
 *
 * Модуль лежит в контрактах по той же причине, что `identifiers.ts`: одно и то
 * же правило обязаны считать три места — воркер (решает, запускать ли детектор
 * на странице), API (решает, нужна ли модель этому комплекту, и объясняет отказ)
 * и БРАУЗЕР (подписывает страницу в ленте миниатюр и поясняет, почему на ней
 * один блок). Браузер не может импортировать из `apps/api` вовсе, поэтому
 * размещение правила в API гарантированно породило бы вторую реализацию во
 * фронтенде, и разошлись бы они молча: страница выглядела бы как A4, а
 * размечалась как A3.
 *
 * `apps/api/src/pdf/raster.ts` остаётся при своём: `effectiveRasterDpi`
 * отвечает на вопрос «с каким разрешением рендерить», а не «что на этом листе
 * искать», и склеивать эти два вопроса незачем — потолок площади растра
 * срабатывает с A1, а правило разметки различает уже A4 и A3.
 *
 * ## Почему допуск обязателен, а не «на всякий случай»
 *
 * Размеры страницы лежат в `source_pages.width_px/height_px` округлёнными до
 * целого пункта (`Math.round`, `apps/api/src/modules/files/verify.ts`), поэтому
 * номинальный A4 хранится как 595×842 — уже мимо номинала 595.2756×841.8898.
 * На боевом комплекте 220 страниц (`temp/ИД Мастер апрель 2026.pdf`) НИ ОДНА
 * страница не совпадает с номиналом: 594×842 (98 страниц), 593×842 (81),
 * 595×842 (17), 842×594 (8), 842×593 (4) и 1187..1190×842 (12). Правило вида
 * «равно A4» не сработало бы там ни разу.
 *
 * Сверху 5 % покрывают скан с полями (600×850 pt) и US Letter (612×792 pt — он
 * же `DEFAULT_MEDIA_BOX` для страницы без `/MediaBox`). Снизу запас огромен: у
 * A3 короткая сторона на 41 % больше A4, так что допуск не подходит к границе
 * и близко.
 *
 * ## Два допуска, а не один
 *
 * `sheetClass` (малый/крупный) решает, ЧТО делать со страницей, и ошибка в нём
 * стоит потерянного листа. `code` — подпись для человека, и ошибка в ней стоит
 * неверного слова в ленте миниатюр. Поэтому у них разные допуски (5 % против
 * 2 %) и они не выводятся друг из друга: лист может быть `large` без имени
 * формата вовсе.
 *
 * ## Ориентация на решение не влияет
 *
 * Внутри считаются только `short = min(w, h)` и `long = max(w, h)`, поэтому
 * альбомный A3 (1191×842) и портретный (842×1191) дают ОДИН ответ. Это не
 * косметика: в том же боевом комплекте двенадцать страниц — АЛЬБОМНЫЕ A4
 * (842×594), и сравнение «ширина против короткой стороны A4» объявило бы их
 * крупными листами, после чего двенадцать страниц потеряли бы весь свой текст.
 *
 * Это же снимает вопрос о поворотах: `/Rotate` уже применён к хранимым
 * размерам, а `content_rotation` (поправка к скану) физического размера листа
 * не меняет. `orientation` считается для подписи и в правиле не участвует.
 */
import { z } from 'zod';

import { detectionSheetStrategySchema, largeSheetNumberZoneSchema } from './enums.js';
import type { DetectionSheetStrategy, LargeSheetNumberZone } from './enums.js';

/**
 * Класс листа: от него зависит, что портал ищет на странице.
 *
 * `unknown` — размер нечитаем (`NaN`, ноль, отрицательное). Отдельное значение,
 * а не «считаем малым»: «размера не знаем» и «лист размером с A4» — разные
 * утверждения, и второе привело бы к странице, размеченной одним блоком на
 * основании арифметической ошибки. Режимом такой страницы становится
 * `full_detection` — прежнее поведение портала.
 */
export const sheetClassSchema = z.enum(['small', 'large', 'unknown']);
export type SheetClass = z.infer<typeof sheetClassSchema>;

/** Формат ряда ISO A. Крупнее A0 и мельче A6 портал по имени не различает. */
export const isoSheetCodeSchema = z.enum(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
export type IsoSheetCode = z.infer<typeof isoSheetCodeSchema>;

/**
 * Наименьший ISO-формат, в который лист укладывается целиком.
 *
 * Нужен нестандартным размерам: «нестандартный 320×450 мм (в пределах A2)»
 * отвечает человеку на вопрос «насколько он большой», а придумывать имя листу,
 * которого нет в ISO, портал не берётся.
 */
export const sheetFitsInSchema = z.union([isoSheetCodeSchema, z.literal('over_a0')]);
export type SheetFitsIn = z.infer<typeof sheetFitsInSchema>;

export const sheetOrientationSchema = z.enum(['portrait', 'landscape', 'square']);
export type SheetOrientation = z.infer<typeof sheetOrientationSchema>;

/**
 * Что портал ищет на странице.
 *
 * Режим — производное от класса листа И политики разметки, и потребителям нужен
 * именно он: класс листа сам по себе не отвечает ни на один вопрос конвейера
 * («запускать ли детектор», «какие флаги ставить», «что написать на экране»), а
 * режим отвечает на все три.
 */
export const pageMarkupModeSchema = z.enum(['full_page', 'stamp_only', 'full_detection']);
export type PageMarkupMode = z.infer<typeof pageMarkupModeSchema>;

/**
 * Описание листа: класс — для решения, остальное — для человека.
 *
 * Поля, кроме `sheetClass`, равны `null` РОВНО тогда, когда `sheetClass` —
 * `unknown`. Инвариант держится тестом: иначе «неизвестный размер» пришлось бы
 * изображать нулями, а ноль миллиметров — это утверждение о листе, а не отказ
 * от утверждения.
 */
export interface SheetFormat {
  readonly sheetClass: SheetClass;
  readonly code: IsoSheetCode | null;
  readonly fitsIn: SheetFitsIn | null;
  readonly orientation: SheetOrientation | null;
  /** Округление до 0.1 мм: значение показывается человеку, а не сравнивается. */
  readonly widthMm: number | null;
  readonly heightMm: number | null;
}

/** Версия политики разметки. Меняется релизом, а не настройкой. */
export const MARKUP_POLICY_VERSION = 1 as const;

/**
 * Политика разметки, ЗАПИНЕННАЯ на ревизии разметки.
 *
 * Не настройка портала, а её слепок: настройку администратор меняет когда
 * угодно, в том числе посреди веера постраничных задач, и без пина одна ревизия
 * получила бы половину страниц по старому правилу и половину по новому — без
 * единого следа о том, почему. Прецедент тот же, что у `layout_profile_id` и
 * `detector_profile` (миграция 0012): свойство, объясняющее ПРОШЛУЮ разметку,
 * принадлежит ревизии, а не текущему состоянию админки.
 *
 * Пороги лежат здесь же данными, а не константами кода: калибровка, попавшая в
 * пин, объясняет старую разметку и после того, как её изменили.
 */
export const markupPolicySchema = z.object({
  version: z.literal(MARKUP_POLICY_VERSION),
  sheetStrategy: detectionSheetStrategySchema,
  numberZone: largeSheetNumberZoneSchema,
  /**
   * Насколько зона номера листа шире объединяющего прямоугольника штампов —
   * доли размера листа, вверх и в стороны.
   */
  numberZonePad: z.object({
    x: z.number().min(0).max(0.5),
    y: z.number().min(0).max(0.5),
  }),
});
export type MarkupPolicy = z.infer<typeof markupPolicySchema>;

/**
 * Политика, при которой портал ведёт себя ровно как до правила форматов.
 *
 * Ею размечены все ревизии, созданные раньше пина, — и она же остаётся
 * умолчанием колонки, чтобы прошлая разметка судилась тем правилом, по которому
 * её делали.
 */
export const LEGACY_MARKUP_POLICY: MarkupPolicy = {
  version: MARKUP_POLICY_VERSION,
  sheetStrategy: 'detect_all',
  numberZone: 'off',
  numberZonePad: { x: 0.1, y: 0.25 },
};

/**
 * Политика из настроек портала — то, что будет запинено на НОВОЙ ревизии.
 *
 * Провайдер детекции остаётся в аргументах, хотя значение у него теперь одно:
 * `detection.provider` читается из `app_settings` строкой, и восстановление
 * базы из копии старше миграции 0069 вернуло бы туда снятое `rdweb`. Любое
 * значение, кроме `local`, получает легаси-политику — молча применить к
 * незнакомому провайдеру НОВОЕ правило форматов нельзя: блоки размечались бы по
 * одному правилу, а флаги считались по другому, и анализ покрытия судил бы
 * разметку по чужому.
 */
export function markupPolicyFromSettings(input: {
  readonly provider: string;
  readonly sheetStrategy: DetectionSheetStrategy;
  readonly numberZone: LargeSheetNumberZone;
}): MarkupPolicy {
  if (input.provider !== 'local') return LEGACY_MARKUP_POLICY;
  return {
    version: MARKUP_POLICY_VERSION,
    sheetStrategy: input.sheetStrategy,
    numberZone: input.numberZone,
    numberZonePad: LEGACY_MARKUP_POLICY.numberZonePad,
  };
}

/**
 * Разбор запиненной политики из `jsonb`.
 *
 * Непригодное значение даёт легаси-политику, а не исключение: колонку пишет
 * миграция и код портала, но экран разметки не должен отвечать пятисоткой на
 * строку, которую поправили руками в консоли БД. Прежнее поведение — безопасный
 * ответ на «не понимаю, что здесь записано».
 */
export function parseMarkupPolicy(value: unknown): MarkupPolicy {
  const parsed = markupPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : LEGACY_MARKUP_POLICY;
}

// =====================================================================
// Классификация листа
// =====================================================================

/** Пунктов в дюйме и миллиметров в дюйме: размеры страницы PDF — в пунктах. */
const POINTS_PER_INCH = 72;
const MM_PER_INCH = 25.4;

const MM_TO_PT = POINTS_PER_INCH / MM_PER_INCH;

/**
 * Ряд ISO A в миллиметрах, от крупного к мелкому.
 *
 * В миллиметрах, а не в пунктах: так таблица сверяется с ГОСТ 2.301 глазами, а
 * перевод делается один раз и в одном месте. Порядок убывающий — от него
 * зависит выбор наименьшего подходящего формата в `fitsIn`.
 */
const ISO_SHEETS_MM: readonly (readonly [IsoSheetCode, number, number])[] = [
  ['A0', 841, 1189],
  ['A1', 594, 841],
  ['A2', 420, 594],
  ['A3', 297, 420],
  ['A4', 210, 297],
  ['A5', 148, 210],
  ['A6', 105, 148],
];

/** Тот же ряд в пунктах: сравнение идёт в единицах хранения, без лишних переводов. */
const ISO_SHEETS_PT = ISO_SHEETS_MM.map(
  ([code, shortMm, longMm]) => [code, shortMm * MM_TO_PT, longMm * MM_TO_PT] as const,
);

const A4_SHORT_PT = 210 * MM_TO_PT;
const A4_LONG_PT = 297 * MM_TO_PT;

/**
 * Допуск класса: 5 %. Обоснование — в шапке файла (округление до пункта, поля
 * скана, US Letter). Не настройка: это калибровка физической константы, а
 * аварийный выход из неверной классификации — стратегия `detect_all`.
 */
export const SHEET_CLASS_TOLERANCE = 0.05;

/** Допуск имени формата: 2 %. Ошибка в подписи дешевле ошибки в решении. */
export const SHEET_CODE_TOLERANCE = 0.02;

function orientationOf(widthPt: number, heightPt: number): SheetOrientation {
  if (widthPt === heightPt) return 'square';
  return widthPt > heightPt ? 'landscape' : 'portrait';
}

function toMm(valuePt: number): number {
  return Math.round((valuePt / MM_TO_PT) * 10) / 10;
}

function matchesCode(shortPt: number, longPt: number, shortIso: number, longIso: number): boolean {
  return (
    Math.abs(shortPt - shortIso) <= shortIso * SHEET_CODE_TOLERANCE &&
    Math.abs(longPt - longIso) <= longIso * SHEET_CODE_TOLERANCE
  );
}

const UNKNOWN_SHEET: SheetFormat = {
  sheetClass: 'unknown',
  code: null,
  fitsIn: null,
  orientation: null,
  widthMm: null,
  heightMm: null,
};

/**
 * Формат листа по его размерам в пунктах.
 *
 * Размеры приходят из карты страниц рабочего документа (`source_pages`), где они
 * уже пост-поворотные: `/Rotate` применён при разборе PDF.
 */
export function classifySheet(widthPt: number, heightPt: number): SheetFormat {
  if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt)) return UNKNOWN_SHEET;
  if (widthPt <= 0 || heightPt <= 0) return UNKNOWN_SHEET;

  const shortPt = Math.min(widthPt, heightPt);
  const longPt = Math.max(widthPt, heightPt);

  const small =
    shortPt <= A4_SHORT_PT * (1 + SHEET_CLASS_TOLERANCE) &&
    longPt <= A4_LONG_PT * (1 + SHEET_CLASS_TOLERANCE);

  let code: IsoSheetCode | null = null;
  let fitsIn: SheetFitsIn = 'over_a0';
  for (const [isoCode, shortIso, longIso] of ISO_SHEETS_PT) {
    if (code === null && matchesCode(shortPt, longPt, shortIso, longIso)) code = isoCode;
    // Ряд идёт от крупного к мелкому, поэтому последний подошедший и есть
    // наименьший из подходящих.
    if (
      shortPt <= shortIso * (1 + SHEET_CODE_TOLERANCE) &&
      longPt <= longIso * (1 + SHEET_CODE_TOLERANCE)
    ) {
      fitsIn = isoCode;
    }
  }

  return {
    sheetClass: small ? 'small' : 'large',
    code,
    fitsIn,
    orientation: orientationOf(widthPt, heightPt),
    widthMm: toMm(widthPt),
    heightMm: toMm(heightPt),
  };
}

/**
 * Подпись листа для человека: имя формата либо размеры с указанием, во что он
 * укладывается.
 *
 * Ориентация приписывается только именованному формату: у нестандартного листа
 * размеры и так напечатаны, и слово «альбомный» рядом с ними ничего не добавляет.
 */
export function sheetFormatLabel(format: SheetFormat): string {
  if (format.sheetClass === 'unknown') return 'размер неизвестен';

  if (format.code !== null) {
    return format.orientation === 'landscape' ? `${format.code}, альбомный` : format.code;
  }

  const size = `${format.widthMm ?? 0}×${format.heightMm ?? 0} мм`;
  const bound = format.fitsIn === 'over_a0' ? 'крупнее A0' : `в пределах ${format.fitsIn ?? '?'}`;
  return `нестандартный ${size} (${bound})`;
}

/**
 * Что портал ищет на странице этого листа при этой политике.
 *
 * Единственное место, где класс листа превращается в решение конвейера.
 * Потребителей у него четверо — обработчик детекции, анализ покрытия, заплатка
 * покрытия и экран разметки, — и второй реализации правила быть не должно.
 */
export function resolvePageMarkupMode(
  sheetClass: SheetClass,
  policy: MarkupPolicy,
): PageMarkupMode {
  if (policy.sheetStrategy === 'detect_all') return 'full_detection';
  if (sheetClass === 'unknown') return 'full_detection';
  return sheetClass === 'small' ? 'full_page' : 'stamp_only';
}

/** Режим страницы по её размерам: сокращение для тех, кому класс сам по себе не нужен. */
export function pageMarkupMode(
  widthPt: number,
  heightPt: number,
  policy: MarkupPolicy,
): PageMarkupMode {
  return resolvePageMarkupMode(classifySheet(widthPt, heightPt).sheetClass, policy);
}
