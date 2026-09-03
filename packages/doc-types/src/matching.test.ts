/**
 * Тесты матчера: семантика «якорь совпадает с началом нормализованной строки
 * в зоне заголовка».
 *
 * Определения типов здесь фиктивные и объявлены прямо в файле. Зависеть от
 * реального каталога нельзя: тогда правка формулировки якоря роняла бы тест
 * правила сопоставления, и по красному тесту было бы не понять, что сломано —
 * матчер или каталог. Каталог проверяется отдельно, в `catalog.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HEADING_LINES,
  matchDocTypes,
  matchPageRoles,
  normalizeLine,
  normalizeLines,
  resolveDocType,
} from './matching.js';
import type { DocTypeMatch } from './matching.js';
import type { DocTypeDefinition, MatchHints, PageRoleCode, PageRoleDefinition } from './types.js';

const fakeType = (code: string, matchHints: MatchHints, isFallback = false): DocTypeDefinition => ({
  code,
  name: `Фиктивный тип ${code}`,
  shortName: code,
  group: isFallback ? 'fallback' : 'quality_docs',
  kind: isFallback ? 'fallback' : 'evidence',
  hasAnnexes: false,
  isFallback,
  observedInCorpus: false,
  matchHints,
  fieldSchema: [],
  sortOrder: 10,
});

const fakeRole = (code: PageRoleCode, matchHints: MatchHints): PageRoleDefinition => ({
  code,
  name: `Фиктивная роль ${code}`,
  autoAttach: true,
  matchHints,
});

const codesOf = (matches: readonly DocTypeMatch[]): string[] => matches.map((m) => m.code);

/** Непустые строки-заполнители: пустые матчер отбрасывает, и зона поехала бы. */
const filler = (count: number): string =>
  Array.from({ length: count }, (_, i) => `строка шапки бланка ${i + 1}`).join('\n');

const QUALITY_DOC = fakeType('fake_quality_doc', { anchors: ['ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ'] });

const ANY_DOC = fakeType('fake_any_doc', { anchors: ['ДОКУМЕНТ'] });

const CERT = fakeType('fake_cert', {
  anchors: ['СЕРТИФИКАТ\\s+СООТВЕТСТВИЯ'],
  negativeAnchors: ['ПРИЛОЖЕНИ[ЕЯ]'],
});

const LOG = fakeType('fake_log', {
  anchors: ['ЖУРНАЛ\\s+БЕТОННЫХ\\s+РАБОТ'],
  bodyHints: ['УСЛОВНЫЕ\\s+ОБОЗНАЧЕНИЯ', 'Класс\\s+бетона'],
});

const FALLBACK = fakeType('fake_fallback', { anchors: ['ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ'] }, true);

describe('normalizeLine', () => {
  it('снимает markdown-заголовок вместе с ведущей цитатой', () => {
    // OCR отдаёт заголовки как `##### АКТ`; без снятия префикса якорь,
    // привязанный к началу строки, мёртв.
    expect(normalizeLine('##### АКТ')).toBe('АКТ');
    expect(normalizeLine('> ##### ЗАКЛЮЧЕНИЕ')).toBe('ЗАКЛЮЧЕНИЕ');
    expect(normalizeLine('##### Паспорт № 230126/2/126000477.1.1')).toBe(
      'Паспорт № 230126/2/126000477.1.1',
    );
  });

  it('снимает маркер цитаты и маркеры списка', () => {
    expect(normalizeLine('> цитата бланка')).toBe('цитата бланка');
    expect(normalizeLine('- пункт перечня')).toBe('пункт перечня');
    expect(normalizeLine('* пункт перечня')).toBe('пункт перечня');
    expect(normalizeLine('+ пункт перечня')).toBe('пункт перечня');
  });

  it('снимает символы акцента в любом месте строки', () => {
    expect(normalizeLine('* **ПАСПОРТ** КАЧЕСТВА')).toBe('ПАСПОРТ КАЧЕСТВА');
    expect(normalizeLine('_курсив_ и `код`')).toBe('курсив и код');
  });

  it('снимает обрамляющие «|», но не разделители внутри строки', () => {
    expect(normalizeLine('|  СЕРТИФИКАТ СООТВЕТСТВИЯ  |')).toBe('СЕРТИФИКАТ СООТВЕТСТВИЯ');
    expect(normalizeLine('| 13 | Документ о качестве |')).toBe('13 | Документ о качестве');
  });

  it('схлопывает пробелы и обрезает края', () => {
    expect(normalizeLine('АКТ    освидетельствования\tскрытых  работ')).toBe(
      'АКТ освидетельствования скрытых работ',
    );
    expect(normalizeLine('   ')).toBe('');
  });
});

describe('normalizeLines', () => {
  it('отбрасывает пустые строки', () => {
    expect(normalizeLines('##### АКТ\n\n   \n> освидетельствования скрытых работ\n')).toEqual([
      'АКТ',
      'освидетельствования скрытых работ',
    ]);
  });
});

describe('matchDocTypes — совпадение только с начала строки', () => {
  it('якорь срабатывает на заголовке', () => {
    expect(codesOf(matchDocTypes('ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б', [QUALITY_DOC]))).toEqual([
      'fake_quality_doc',
    ]);
  });

  it('якорь срабатывает и через markdown-префикс', () => {
    expect(codesOf(matchDocTypes('##### ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б', [QUALITY_DOC]))).toEqual([
      'fake_quality_doc',
    ]);
  });

  it('упоминание в строке реестра якорем не считается', () => {
    // Ровно та строка, из-за которой страница реестра приложений раньше
    // получала пять-шесть типов сразу: совпадение начинается не с начала строки.
    const row = '13 Документ о качестве; Раствор М-150 №АБС00001381';

    expect(normalizeLine(row)).toBe(row);
    expect(matchDocTypes(row, [QUALITY_DOC])).toEqual([]);
  });

  it('упоминание в табличной строке якорем не считается', () => {
    const row = '| 13 | Документ о качестве; Раствор М-150 | №АБС00001381 | ООО "АБС Групп" |';

    expect(matchDocTypes(row, [QUALITY_DOC])).toEqual([]);
  });

  it('возвращает строку срабатывания и её номер', () => {
    // Номер строки и сама строка — материал для объяснения решения в UI,
    // поэтому нумерация ведётся по нормализованному представлению.
    const text = 'Общество с ограниченной ответственностью\n##### ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б';
    const match = matchDocTypes(text, [QUALITY_DOC])[0];

    expect(match?.line).toBe('ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б');
    expect(match?.lineIndex).toBe(1);
  });

  it('возвращает всех кандидатов, а не первого', () => {
    const codes = codesOf(matchDocTypes('ДОКУМЕНТ О КАЧЕСТВЕ № 1', [QUALITY_DOC, ANY_DOC]));

    expect(codes).toEqual(['fake_quality_doc', 'fake_any_doc']);
  });

  it('на пустом тексте не срабатывает ничего', () => {
    expect(matchDocTypes('', [QUALITY_DOC, ANY_DOC, CERT, LOG])).toEqual([]);
  });

  it('некорректный шаблон падает с внятным сообщением', () => {
    const broken = fakeType('fake_broken', { anchors: ['ДОКУМЕНТ ('] });

    expect(() => matchDocTypes('ДОКУМЕНТ О КАЧЕСТВЕ', [broken])).toThrow(/Некорректный шаблон/u);
  });
});

describe('matchDocTypes — длина хвоста после совпадения', () => {
  it('короткий хвост (номер, дата) совпадение сохраняет', () => {
    const tail80 = `ДОКУМЕНТ О КАЧЕСТВЕ ${'я'.repeat(80)}`;

    expect(codesOf(matchDocTypes(tail80, [QUALITY_DOC]))).toEqual(['fake_quality_doc']);
  });

  it('хвост длиннее 80 символов совпадение отменяет', () => {
    const tail81 = `ДОКУМЕНТ О КАЧЕСТВЕ ${'я'.repeat(81)}`;

    expect(matchDocTypes(tail81, [QUALITY_DOC])).toEqual([]);
  });
});

describe('matchDocTypes — зона заголовка', () => {
  it('якорь на 25-й строке не срабатывает', () => {
    const text = `${filler(24)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;

    expect(normalizeLines(text)).toHaveLength(25);
    expect(matchDocTypes(text, [QUALITY_DOC])).toEqual([]);
  });

  it('расширение зоны через параметр возвращает то же совпадение', () => {
    const text = `${filler(24)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;

    expect(codesOf(matchDocTypes(text, [QUALITY_DOC], { headingLines: 30 }))).toEqual([
      'fake_quality_doc',
    ]);
  });

  it('граница зоны — ровно DEFAULT_HEADING_LINES строк', () => {
    const last = `${filler(DEFAULT_HEADING_LINES - 1)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;
    const past = `${filler(DEFAULT_HEADING_LINES)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;

    expect(codesOf(matchDocTypes(last, [QUALITY_DOC]))).toEqual(['fake_quality_doc']);
    expect(matchDocTypes(past, [QUALITY_DOC])).toEqual([]);
  });

  // Класс дефекта temp/MD/new: в бланке АОСР по приказу №344/пр титул стоит
  // 28–31-й строкой, ниже общего окна. Индивидуальное окно типа обязано его
  // доставать, НЕ расширяя зону соседним типам.
  it('индивидуальное окно типа достаёт заголовок ниже общего окна', () => {
    const deep = fakeType('fake_deep', {
      anchors: ['ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ'],
      headingLines: 40,
    });
    const text = `${filler(30)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;

    expect(codesOf(matchDocTypes(text, [deep, QUALITY_DOC]))).toEqual(['fake_deep']);
  });

  it('индивидуальное окно не может СУЗИТЬ зону: явная опция задаёт минимум', () => {
    const narrow = fakeType('fake_narrow', {
      anchors: ['ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ'],
      headingLines: 3,
    });
    const text = `${filler(10)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;

    expect(codesOf(matchDocTypes(text, [narrow]))).toEqual(['fake_narrow']);
  });

  it('индивидуальное окно работает и при явной опции вызывающего', () => {
    // classify всегда передаёт общее окно явно; «явная опция побеждает»
    // означала бы, что индивидуальное окно не работает нигде в проде.
    const deep = fakeType('fake_deep', {
      anchors: ['ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ'],
      headingLines: 40,
    });
    const text = `${filler(30)}\nДОКУМЕНТ О КАЧЕСТВЕ № 1`;

    expect(codesOf(matchDocTypes(text, [deep], { headingLines: DEFAULT_HEADING_LINES }))).toEqual([
      'fake_deep',
    ]);
  });
});

describe('matchDocTypes — отрицательные якоря', () => {
  it('отрицательный якорь в начале строки зоны заголовка отменяет тип', () => {
    const annex = 'ПРИЛОЖЕНИЕ\nк сертификату соответствия № 04УПС45\nСЕРТИФИКАТ СООТВЕТСТВИЯ';

    expect(matchDocTypes(annex, [CERT])).toEqual([]);
  });

  it('без отрицательного якоря тот же текст тип даёт', () => {
    expect(codesOf(matchDocTypes('СЕРТИФИКАТ СООТВЕТСТВИЯ № 1', [CERT]))).toEqual(['fake_cert']);
  });

  it('упоминание в середине строки отрицательным якорем не считается', () => {
    // Отрицательные якоря проверяются той же функцией, что и обычные, поэтому
    // ссылка на приложение внутри самого сертификата его тип не отменяет.
    const cert =
      'СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ ЕАЭС RU С-RU.НА46.В.00043/23\n' +
      'Продукция (см. приложение - бланк № 0000057)';

    expect(codesOf(matchDocTypes(cert, [CERT]))).toEqual(['fake_cert']);
  });
});

describe('matchDocTypes — подсказки в теле', () => {
  it('bodyHints сами по себе тип не присваивают', () => {
    expect(matchDocTypes('УСЛОВНЫЕ ОБОЗНАЧЕНИЯ\nКласс бетона В25', [LOG])).toEqual([]);
  });

  it('bodyHints повышают уверенность типа, чей якорь сработал', () => {
    const text = `ЖУРНАЛ БЕТОННЫХ РАБОТ\n${filler(30)}\nУСЛОВНЫЕ ОБОЗНАЧЕНИЯ\nКласс бетона В25`;
    const match = matchDocTypes(text, [LOG])[0];

    // Подсказки ищутся по всему блоку, а не в зоне заголовка: легенда и
    // характеристики печатаются в подвале.
    expect(match?.code).toBe('fake_log');
    expect(match?.bodyHitCount).toBe(2);
  });

  it('без подсказок счётчик нулевой, а тип остаётся', () => {
    const match = matchDocTypes('ЖУРНАЛ БЕТОННЫХ РАБОТ № 3', [LOG])[0];

    expect(match?.code).toBe('fake_log');
    expect(match?.bodyHitCount).toBe(0);
  });
});

describe('matchDocTypes — резервные типы', () => {
  it('резервный тип не возвращается даже при совпадающем якоре', () => {
    // Резерв присваивается решением классификатора «документ, но не из
    // известных типов», а не совпадением: иначе он перехватывал бы документ
    // у настоящего типа.
    expect(matchDocTypes('ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б', [FALLBACK])).toEqual([]);
    expect(codesOf(matchDocTypes('ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б', [FALLBACK, QUALITY_DOC]))).toEqual([
      'fake_quality_doc',
    ]);
  });
});

describe('matchDocTypes — якорь с опечаткой распознавания (S50)', () => {
  const REGISTRY = fakeType('fake_registry', {
    anchors: ['Реестр\\s*№\\s*[\\d.]+\\s+к\\s+(?:АОСР|акту)'],
    bodyHints: ['Организация,\\s*составившая\\s+документ'],
  });
  const JOURNAL = fakeType('fake_journal', {
    anchors: ['УЧ[ЕЁ]ТНЫЙ\\s+ЛИСТ'],
    bodyHints: ['Выявленные\\s+отступления'],
  });

  it('пропуск буквы в первом слове не теряет вид, если тело подтверждает', () => {
    // «Рестр № 1.1 к АОСР» — распознавание боевой папки. Прежде такой лист
    // оставался ничьим, а с ним терялись и строки перечня.
    const text = 'Рестр № 1.1 к АОСР № 52-ОТ\n| Организация, составившая документ |';
    const matches = matchDocTypes(text, [REGISTRY]);

    expect(codesOf(matches)).toEqual(['fake_registry']);
    expect(matches[0]?.fuzzy).toBe(true);
  });

  it('замена буквы разбирается так же: «УЧЕБНЫЙ» вместо «УЧЁТНЫЙ»', () => {
    const text = 'УЧЕБНЫЙ ЛИСТ № 118\n| Выявленные отступления от проекта |';
    const matches = matchDocTypes(text, [JOURNAL]);

    expect(codesOf(matches)).toEqual(['fake_journal']);
    expect(matches[0]?.fuzzy).toBe(true);
  });

  it('без подтверждения из тела приблизительный якорь не срабатывает', () => {
    // Одного похожего слова мало: страница, где «Регистр» — это начало фразы,
    // а не заголовок бланка, видом не типизируется.
    expect(matchDocTypes('Регистр № 1.1 к АОСР № 52-ОТ', [REGISTRY])).toEqual([]);
  });

  it('остальная часть якоря обязана совпасть точно', () => {
    const text = 'Рестр материалов на объекте\n| Организация, составившая документ |';
    expect(matchDocTypes(text, [REGISTRY])).toEqual([]);
  });

  it('точное совпадение не помечается приблизительным', () => {
    const text = 'Реестр № 1.1 к АОСР № 52-ОТ\n| Организация, составившая документ |';
    expect(matchDocTypes(text, [REGISTRY])[0]?.fuzzy).toBe(false);
  });
});

describe('resolveDocType — ничья равных приоритетов (S50)', () => {
  const PASSPORT = fakeType('fake_passport', {
    anchors: ['Паспорт\\s*№\\s*\\S'],
    bodyHints: ['Дата\\s+изготовления'],
  });
  const CERTIFICATE = fakeType('fake_certificate', {
    anchors: ['Сертификат\\s+соответствия'],
    bodyHints: ['ОРГАН\\s+ПО\\s+СЕРТИФИКАЦИИ'],
  });

  /**
   * Паспорт материала, в теле которого перечислены его документы качества.
   *
   * Ровно этот лист на боевой папке получал чужой вид с уверенностью 0.5 в
   * восьми комплектах из двенадцати — и гасил вместе с собой правила по
   * паспортам и строки перечня, ссылавшиеся на его номер.
   */
  const PASSPORT_PAGE = [
    'Паспорт № 357',
    'Дата изготовления 21.04.2025',
    'Сертификат соответствия № RU.CMIK.001.H.00270 от 17.05.2023 г.',
  ].join('\n');

  it('подсказка тела решает ничью в пользу хозяина бланка', () => {
    const resolved = resolveDocType(matchDocTypes(PASSPORT_PAGE, [PASSPORT, CERTIFICATE]), [
      PASSPORT,
      CERTIFICATE,
    ]);

    expect(resolved.code).toBe('fake_passport');
    expect(resolved.ambiguous).toBe(false);
    // Проигравший назван: решение объяснимо, а не молчаливо.
    expect(resolved.alternatives).toEqual(['fake_certificate']);
  });

  it('строка с номером И датой считается ссылкой, а не заголовком', () => {
    const page = ['Сертификат соответствия', 'Паспорт № 357 от 21.04.2025 г.'].join('\n');
    const resolved = resolveDocType(matchDocTypes(page, [PASSPORT, CERTIFICATE]), [
      PASSPORT,
      CERTIFICATE,
    ]);

    expect(resolved.code).toBe('fake_certificate');
    expect(resolved.ambiguous).toBe(false);
  });

  it('настоящая ничья остаётся ничьёй', () => {
    // Два заголовка без подсказок тела и без признаков ссылки: разводить их
    // позицией строки портал не вправе — это две разные бумаги на одном листе.
    const page = 'Паспорт № 7\nСертификат соответствия';
    const resolved = resolveDocType(matchDocTypes(page, [PASSPORT, CERTIFICATE]), [
      PASSPORT,
      CERTIFICATE,
    ]);

    expect(resolved.ambiguous).toBe(true);
  });
});

describe('matchPageRoles', () => {
  const STAMP = fakeRole('copy_stamp', { anchors: ['КОПИЯ\\s+ВЕРНА'] });
  const ANNEX = fakeRole('annex_continuation', {
    anchors: ['ПРИЛОЖЕНИЕ к сертификату соответствия\\s*№\\s*(.+)'],
  });
  const BLANK = fakeRole('blank', {
    anchors: ['ЛИСТ\\s+БЕЗ\\s+ТЕКСТА'],
    negativeAnchors: ['подпис'],
  });

  it('роль ищется по всему блоку, а не в зоне заголовка', () => {
    // Штамп «КОПИЯ ВЕРНА» печатается в подвале страницы, поэтому ограничение
    // зоной заголовка для ролей неприменимо.
    const text = `СЕРТИФИКАТ СООТВЕТСТВИЯ № 1\n${filler(30)}\nКОПИЯ ВЕРНА`;

    expect(matchPageRoles(text, [STAMP]).map((m) => m.code)).toEqual(['copy_stamp']);
  });

  it('роль срабатывает и не с начала строки', () => {
    // В отличие от типа документа: роль — это отметка на странице, а не её
    // заголовок, и печатается она где угодно.
    expect(matchPageRoles('Отдел кадров, КОПИЯ ВЕРНА', [STAMP])).toHaveLength(1);
  });

  it('захватывает номер документа-родителя', () => {
    const text = 'ПРИЛОЖЕНИЕ к сертификату соответствия № 04УПС45.RU.C00022';

    expect(matchPageRoles(text, [ANNEX])[0]?.parentRef).toBe('04УПС45.RU.C00022');
  });

  it('без захваченного номера свойства parentRef нет', () => {
    expect(matchPageRoles('КОПИЯ ВЕРНА', [STAMP])[0]).not.toHaveProperty('parentRef');
  });

  it('отрицательный якорь роли отменяет её из любого места блока', () => {
    expect(matchPageRoles('ЛИСТ БЕЗ ТЕКСТА', [BLANK]).map((m) => m.code)).toEqual(['blank']);
    expect(matchPageRoles('ЛИСТ БЕЗ ТЕКСТА\nвнизу подпись директора', [BLANK])).toEqual([]);
  });
});
