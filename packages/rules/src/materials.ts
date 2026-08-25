/**
 * Вывод материалов и партий из реквизитов документов качества (§3.6, §9.1).
 *
 * Граф проверки в §9.1 — это `АОСР → пункты → реестр → материалы/партии →
 * документы качества → протоколы`. Задача 19 строит рёбра между документами, но
 * узлов «материал» и «партия» не создаёт: до S9 их некому было читать. Здесь
 * они выводятся из уже извлечённых реквизитов, а не угадываются из текста.
 *
 * ## Почему вывод, а не отдельная стадия распознавания
 *
 * Всё, из чего состоит партия, уже лежит в `field_values`: номер партии, номер
 * плавки, дата изготовления, изготовитель, наименование продукции, марка. Вторая
 * стадия, читающая тот же текст ещё раз, дала бы второй набор значений, который
 * разошёлся бы с первым — и расхождение выглядело бы как дефект комплекта.
 *
 * ## Категория может быть неизвестна, и это штатно
 *
 * Перечень категорий закрыт (`MATERIAL_CATEGORIES` контрактов), а разделов работ
 * существенно больше, чем два в корпусе (§0.5). Материал, для которого категория
 * не определена, получает `null`, и правила матрицы дают по нему `n_a`, а не
 * «пакет подтверждения неполон». Ключевые слова ниже — подсказки, выведенные из
 * наименований продукции двух разделов корпуса, а не нормативная классификация;
 * ошибка подсказки обязана приводить к `n_a`, а не к ложному замечанию.
 */
import { MATERIAL_CATEGORIES, type MaterialCategoryCode } from '@id/contracts';
import { foldHomoglyphs, isFallbackCode, isQualityDocCode } from './helpers.js';
import type { BatchNode, DocumentNode, MaterialNode } from './types.js';

/** Реквизиты, из которых собирается материал. */
const FIELD_PRODUCT_NAME = 'product_name';
const FIELD_MARK = 'product_marks';
const FIELD_BATCH_NO = 'batch_no';
const FIELD_HEAT_NO = 'heat_no';
const FIELD_MANUFACTURED_AT = 'manufactured_at';

/**
 * Ключевые слова категорий.
 *
 * Порядок значим: `сетка` обязана победить `арматур`, иначе сварная сетка
 * попадёт в арматурный прокат и матрица потребует от неё сертификат на прокат.
 */
const CATEGORY_HINTS: readonly (readonly [MaterialCategoryCode, RegExp])[] = [
  ['welded_mesh', /СЕТК[АИУ]|СЕТОК/u],
  ['rebar', /АРМАТУР|ПРОКАТ\s+АРМАТУРН|СТЕРЖН[ИЕ]/u],
  // Порядок слов в наименовании не фиксирован: в корпусе встречаются и
  // «Смесь бетонная тяжёлая В25», и «Бетонная смесь». Одно направление
  // шаблона молча теряло бы половину товарных смесей.
  [
    'ready_mix_concrete',
    /БЕТОНН\p{L}*\s+СМЕС|СМЕС\p{L}*\s+БЕТОНН|РАСТВОР|ТОВАРН\p{L}*\s+БЕТОН|^БЕТОН/u,
  ],
  ['roll_waterproofing', /ГИДРОИЗОЛЯЦ|ТЕХНОЭЛАСТ|УНИФЛЕКС|БИКРОСТ|РУЛОНН/u],
  [
    'thermal_insulation',
    /УТЕПЛИТЕЛ|МИНЕРАЛЬН\p{L}*\s+ВАТ|МИНЕРАЛОВАТ|МИНВАТ|XPS|ПЕНОПОЛИСТИРОЛ|РОКВУЛ|ТЕХНОНИКОЛЬ\s+XPS/u,
  ],
  ['fasteners', /МЕТИЗ|САМОРЕЗ|ДЮБЕЛ|БОЛТ|ГАЙК|ТЕЛЕСКОПИЧЕСК\p{L}*\s+КРЕПЁЖ|КРЕПЕЖ/u],
  ['pipes', /ТРУБ[АЫ]|ТРУБОПРОВОД/u],
  ['pipe_fittings', /ФИТИНГ|ОТВОД|ПЕРЕХОД\p{L}*\s+МУФТ/u],
  ['cable', /КАБЕЛ|ПРОВОД\b/u],
  ['paint_coatings', /ЛАКОКРАСОЧ|ГРУНТОВК|ЭМАЛ|КРАСК/u],
  ['fire_protection', /ОГНЕЗАЩИТ|ОГНЕСТОЙК/u],
  ['glazing', /СТЕКЛОПАКЕТ|СВЕТОПРОЗРАЧН|ОСТЕКЛЕН/u],
  ['equipment', /ОБОРУДОВАНИ|УСТАНОВК[АИ]|НАСОС|ВЕНТУСТАНОВК/u],
];

/**
 * Категория по наименованию продукции; `null` — определить не удалось.
 *
 * ## Фолдинг гомоглифов здесь НЕ применяется, и это не упущение
 *
 * Первая версия функции сворачивала гомоглифы перед сравнением — по аналогии с
 * §8.3, где это обязательно. Прогон теста показал, что так подсказки не
 * срабатывают НИ РАЗУ: `foldHomoglyphs` переводит кириллические `С`, `А`, `Р`,
 * `О`, `Т`, `К`, `Н`, `У` в латиницу, и написанный кириллицей шаблон `СЕТК`
 * перестаёт совпадать с превращённым в `CETK` текстом. Правила `MAT.*` при этом
 * оставались зелёными: материал без категории даёт `n_a`, а не ошибку, — то
 * есть проверка матрицы выключалась молча.
 *
 * Фолдинг решает задачу сравнения ДВУХ значений, набранных в разных алфавитах
 * (номер в реестре против номера в документе). Здесь сравнивается значение с
 * ШАБЛОНОМ, и алфавит шаблона фиксирован — сворачивать нужно было бы обе
 * стороны, а не одну. Приводится только регистр.
 */
export function categoryOfProduct(productName: string | null): MaterialCategoryCode | null {
  if (productName === null) return null;
  const text = productName.toUpperCase();
  for (const [code, pattern] of CATEGORY_HINTS) {
    if (pattern.test(text)) return code;
  }
  return null;
}

/** Полнота таблицы подсказок: каждая категория перечня либо описана, либо нет. */
export const CATEGORIES_WITHOUT_HINT: readonly MaterialCategoryCode[] = MATERIAL_CATEGORIES.filter(
  (code) => !CATEGORY_HINTS.some(([hinted]) => hinted === code),
);

/**
 * Нормализация наименования материала для ГРУППИРОВКИ.
 *
 * Здесь фолдинг гомоглифов, наоборот, нужен: один и тот же материал приходит с
 * сертификатом, паспортом и протоколом, и OCR легко набирает `Арматура` в трёх
 * документах тремя способами. Без свёртки получилось бы три материала вместо
 * одного, и связь «изготовитель партии покрыт сертификатом» (дефект №2 корпуса)
 * порвалась бы ровно там, где она проверяется.
 *
 * Результат нечитаем человеком — и не должен быть: для показа есть `nameRaw`,
 * а `name_norm` живёт под индексом `gin_trgm` ради сопоставления.
 */
export function normalizeMaterialName(value: string): string {
  return foldHomoglyphs(value)
    .replace(/[«»"'`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Идентификаторы узлов задаёт вызывающий: в БД это uuid, в тестах — счётчик. */
export interface MaterialIdFactory {
  materialId(nameNorm: string): string;
  batchId(materialId: string, key: string): string;
}

/**
 * Материалы и партии комплекта.
 *
 * Группировка идёт по нормализованному наименованию продукции: один и тот же
 * материал приходит с сертификатом соответствия, паспортом качества и
 * протоколом, и три узла вместо одного разорвали бы связь «изготовитель партии
 * покрыт сертификатом» (дефект №2 корпуса) ровно там, где она проверяется.
 *
 * Партия ключуется парой «номер партии + номер плавки»: у арматуры значим
 * номер плавки, у рулонной гидроизоляции — номер партии, и требовать оба
 * значило бы терять партии половины видов продукции.
 */
export function deriveMaterials(
  documents: readonly DocumentNode[],
  ids: MaterialIdFactory,
): readonly MaterialNode[] {
  interface Draft {
    readonly id: string;
    readonly nameRaw: string;
    readonly nameNorm: string;
    mark: string | null;
    readonly documentIds: string[];
    readonly batches: Map<string, { batch: BatchNode; documentIds: Set<string> }>;
  }

  const drafts = new Map<string, Draft>();

  for (const document of documents) {
    // Материал выводится только из документов о качестве: акт называет работы,
    // а не продукцию, и его наименование, попав сюда, породило бы материал
    // «Устройство гидроизоляции» без единого документа подтверждения.
    const code = document.docTypeCode;
    if (code === null || isFallbackCode(code) || !isQualityDocCode(code)) continue;

    const productName = firstText(document, FIELD_PRODUCT_NAME);
    if (productName === null) continue;

    const nameNorm = normalizeMaterialName(productName);
    if (nameNorm === '') continue;

    let draft = drafts.get(nameNorm);
    if (draft === undefined) {
      draft = {
        id: ids.materialId(nameNorm),
        nameRaw: productName,
        nameNorm,
        mark: null,
        documentIds: [],
        batches: new Map(),
      };
      drafts.set(nameNorm, draft);
    }

    if (!draft.documentIds.includes(document.id)) draft.documentIds.push(document.id);
    draft.mark ??= firstText(document, FIELD_MARK);

    const batchNo = firstText(document, FIELD_BATCH_NO);
    const heatNo = firstText(document, FIELD_HEAT_NO);
    const manufacturedAt = firstDate(document, FIELD_MANUFACTURED_AT);
    if (batchNo === null && heatNo === null && manufacturedAt === null) continue;

    const key = `${batchNo ?? ''}|${heatNo ?? ''}|${manufacturedAt ?? ''}`;
    const existing = draft.batches.get(key);
    if (existing === undefined) {
      draft.batches.set(key, {
        batch: {
          id: ids.batchId(draft.id, key),
          materialId: draft.id,
          batchNo,
          heatNo,
          manufacturedAt,
          documentIds: [document.id],
        },
        documentIds: new Set([document.id]),
      });
    } else {
      existing.documentIds.add(document.id);
    }
  }

  return [...drafts.values()].map((draft) => ({
    id: draft.id,
    nameRaw: draft.nameRaw,
    nameNorm: draft.nameNorm,
    mark: draft.mark,
    categoryCode: categoryOfProduct(draft.nameRaw),
    documentIds: draft.documentIds,
    batches: [...draft.batches.values()].map((entry) => ({
      ...entry.batch,
      documentIds: [...entry.documentIds],
    })),
  }));
}

function firstText(document: DocumentNode, fieldCode: string): string | null {
  const values = document.fields.filter((value) => value.fieldCode === fieldCode);
  const verified = values.find((value) => value.isVerified) ?? values[0];
  if (verified === undefined) return null;
  if (Array.isArray(verified.valueJson)) {
    const first = verified.valueJson.find((item): item is string => typeof item === 'string');
    if (first !== undefined && first.trim() !== '') return first.trim();
  }
  const text = verified.valueText;
  return text === null || text.trim() === '' ? null : text.trim();
}

function firstDate(document: DocumentNode, fieldCode: string): string | null {
  const values = document.fields.filter((value) => value.fieldCode === fieldCode);
  const verified = values.find((value) => value.isVerified) ?? values[0];
  return verified?.valueDate ?? null;
}
