/**
 * Разбор описи передачи папки и сопоставление её групп с комплектами (S20).
 *
 * ## Почему фикстура синтетическая и лежит здесь
 *
 * §1.4 запрещает переносить закрытый корпус в репозиторий, поэтому обе описи
 * ниже воспроизводят СТРУКТУРУ настоящих — форму А (пять граф, группа строкой с
 * «№ п/п») и форму Б (восемь граф, группа слитым баннером) — на вымышленных
 * организациях и номерах. Соседний `registry.test.ts` держит свою фикстуру тем
 * же способом: предмет проверки здесь — поведение разбора на структуре, а не
 * содержимое конкретной папки, и markdown-строка рядом с проверкой читается
 * вместе с ней.
 *
 * Каждая особенность фикстуры взята с настоящего файла и названа в тесте:
 * перенос группы через разрыв страницы с пустой шапкой, таблица объёмов и
 * подвал после описи, шесть форм даты, склейка номера через `;`, интервал через
 * `÷`, невозможная дата, дата без дня, диапазон «страница по списку».
 */

import { describe, expect, it } from 'vitest';
import {
  matchTransferGroups,
  parseTransferRegistry,
  type TransferGroupCandidate,
  type TransferPageInput,
} from './transfer-registry.js';

const page = (id: string, text: string): TransferPageInput => ({
  sourcePageId: id,
  pageTextVersionId: `${id}-text`,
  text,
});

// =====================================================================
// Форма А: пять граф, группа — строка с непустым «№ п/п»
// =====================================================================

const FORM_A_PAGE_1 = [
  'Заказчик-застройщик ООО «Синтетик Эстет»',
  '',
  'Генподрядчик ООО «СУ-Тест»',
  '',
  'Исполнитель работ ООО «РЕД-Тест»',
  '',
  'Объект «Синтетический комплекс» по адресу: г. Москва, ул. Тестовая, вл. 1',
  '',
  '###### Папка № 27',
  '',
  '###### Реестр исполнительной документации №27-СИНТ',
  '',
  '| № п/п | Наименование документа | № документа | Дата документа | Кол-во экз. |',
  '|---|---|---|---|---|',
  '| 1 | Устройство кладки стен из блоков толщ. 200мм -2-го этажа | 1.1-Кл (п/а, -2 эт) | 23.06.2026 | 3 |',
  '|  | Сертификат соответствия | РОСС; RU.Я2331.04ПВК0.Н; 02184 | 11.10.2024÷; 10.10.2027 | 3 |',
  '|  | Паспорт качества | 00БС-012814 | 13.05.2026 | 3 |',
  '|  | Паспорт | б/н | 31.04.2026 | 3 |',
].join('\n');

const FORM_A_PAGE_2 = [
  '| | | | | |',
  '|---|---|---|---|---|',
  '|  | Паспорт | 1770 | .апрель.2026 | 3 |',
  '|  | исполнительная схема | 2-КВ-1 | 23.06.2026 | 3 |',
  '| 2 | Устройство металлических перемычек в стенах из блоков | 1.2-Кл (п/а, -2 эт) | 23.06.2026 | 3 |',
  '|  | Сертификат качества | 2400022639 | 13.06.2024 | 3 |',
  '',
  '| Вид работ, переданных данным реестром | п. ДГП | Объем |',
  '|---|---|---|',
  '| Газобетонные блоки D500 (внутренняя) - 100 мм Корпус 1, -2 этаж | 12.1.1.1 | 0,77 |',
  '| Газобетонные блоки D500 (внутренняя) - 200 мм Корпус 1, -2 этаж | 12.1.1.3 | 0,44 |',
  '',
  '**Сдал:**',
  '',
  'Представитель ООО «СУ-Тест»: Вед. Инженер по ИД Тестова А.И.',
  '',
  '«31» 04 2026г.',
].join('\n');

const formA = (): ReturnType<typeof parseTransferRegistry> =>
  parseTransferRegistry({
    pages: [page('a-1', FORM_A_PAGE_1), page('a-2', FORM_A_PAGE_2)],
  });

describe('parseTransferRegistry, форма А', () => {
  it('определяет форму по графе «кол-во экз.»', () => {
    expect(formA().form).toBe('a');
  });

  it('открывает группу строкой с непустым «№ п/п» и берёт номер АОСР из её графы номера', () => {
    const groups = formA().groups;

    expect(groups).toHaveLength(2);
    expect(groups[0]?.groupNo).toBe('1');
    expect(groups[0]?.titleRaw).toContain('Устройство кладки стен');
    expect(groups[0]?.actNoRaw).toBe('1.1-Кл (п/а, -2 эт)');
    expect(groups[1]?.groupNo).toBe('2');
    expect(groups[1]?.actNoRaw).toBe('1.2-Кл (п/а, -2 эт)');
  });

  it('сама работа тоже строка описи: акт лежит в папке наравне с приложениями', () => {
    const rows = formA().rows;

    expect(rows[0]?.docNoRaw).toBe('1.1-Кл (п/а, -2 эт)');
    expect(rows[0]?.groupOrdinal).toBe(0);
    expect(rows[0]?.rowNo).toBe('1');
  });

  it('продолжает группу через разрыв страницы с пустой шапкой', () => {
    const { rows, groups } = formA();

    // Строки со второй страницы принадлежат ПЕРВОЙ группе: пустая шапка
    // `| | | | | |` — это продолжение, а не новая таблица.
    const paspoprt1770 = rows.find((row) => row.docNoRaw === '1770');
    expect(paspoprt1770?.groupOrdinal).toBe(0);

    const shema = rows.find((row) => row.docNoRaw === '2-КВ-1');
    expect(shema?.groupOrdinal).toBe(0);

    // А следующая за ними строка с «№ п/п» открывает вторую группу.
    const second = rows.find((row) => row.docNoRaw === '2400022639');
    expect(second?.groupOrdinal).toBe(groups[1]?.ordinal);
  });

  it('склеенный точками с запятой номер сравним, а интервал через ÷ разобран', () => {
    const row = formA().rows.find((item) => item.docNameRaw === 'Сертификат соответствия');

    expect(row?.docNoRaw).toBe('РОСС; RU.Я2331.04ПВК0.Н; 02184');
    // `;` — след переноса строки внутри ячейки, и в сравнимой форме его нет.
    expect(row?.docNoNorm).not.toContain(';');
    expect(row?.validFrom).toBe('2024-10-11');
    expect(row?.validTo).toBe('2027-10-10');
  });

  it('«б/н» номером для сверки не считается', () => {
    const row = formA().rows.find((item) => item.docNameRaw === 'Паспорт' && item.rowNo === null);

    expect(row?.docNoRaw).toBe('б/н');
    expect(row?.docNoNorm).toBeNull();
  });

  it('невозможная дата даёт предупреждение, а не выдуманное значение', () => {
    const { rows, warnings } = formA();
    const row = rows.find((item) => item.docNoRaw === 'б/н');

    expect(row?.issuedAt).toBeNull();
    expect(warnings.some((text) => text.includes('31.04.2026'))).toBe(true);
  });

  it('дата без дня, месяц словом, названа отдельным предупреждением', () => {
    const { rows, warnings } = formA();
    const row = rows.find((item) => item.docNoRaw === '1770');

    expect(row?.issuedAt).toBeNull();
    expect(warnings.some((text) => text.includes('без дня'))).toBe(true);
  });

  it('таблица объёмов и подвал в опись не попадают', () => {
    const { rows, groups } = formA();

    expect(rows.some((row) => row.docNameRaw.includes('Газобетонные блоки'))).toBe(false);
    expect(groups.some((group) => group.titleRaw.includes('Газобетонные блоки'))).toBe(false);
    expect(rows.some((row) => row.docNameRaw.includes('Тестова'))).toBe(false);
  });

  it('читает шапку: номер реестра, номер папки, объект и исполнителя', () => {
    const header = formA().header;

    expect(header.registryNo).toBe('27-СИНТ');
    expect(header.folderNo).toBe('27');
    expect(header.objectRaw).toContain('Синтетический комплекс');
    expect(header.contractorRaw).toContain('РЕД-Тест');
  });
});

// =====================================================================
// Форма Б: восемь граф, группа — слитый баннер, номер АОСР в строке акта
// =====================================================================

const FORM_B_HEADER =
  '| № | № п/п | Наименование документа | Номер документа (шифр) | ' +
  'Организация составившая документ (производитель) | ' +
  'Дата составления или срок действия | Кол-во листов, шт | Страница по списку |';

const FORM_B_PAGE_1 = [
  'Реестр исполнительной документации №8 от 26.08.2024 г.',
  '',
  '| Номер папки | №4 |',
  '|---|---|',
  '| Корпус | 1 |',
  '',
  FORM_B_HEADER,
  '|---|---|---|---|---|---|---|---|',
  '| Устройство шпунтового ограждения котлована (ООО "БАУТРАНС-Тест") |  |  |  |  |  |  |  |',
  '| 1 | 1.1 | АОСР Устройство шпунтового ограждения котлована | №04-ШО | ООО "Баутранс-Тест" | от 02.08.2024 | 1 | 1 |',
  '|  | 1.2 | Реестр к АОСР №04-ШО | №01 | ООО "Баутранс-Тест" | от 02.08.2024 | 1 | 2 |',
  '|  | 1.3 | Сертификат соответствия | №РОСС RU C-RU.АЩЯ1.В.00522/23 | ООО "Алия Цемент-Тест" | с 15.12.2023г по 14.12.2028г | 1 | 5 |',
  '|  | 1.4 | Сертификат калибровки | №КВЮ-10501 | ООО "АЗ-И-Тест" | до 23.11.2028 г | 2 | 26-27 |',
  '|  | 1.5 | Свидетельство о поверке | №С-ДИЗ/18-10-2023/287780467 | ООО "ИЭКС СЕРТ-Тест" | действителен до 02.04.2026г | 1 | 25 |',
  '|  | 1.6 | Паспорт | б/н | ООО "Тест" | до 10.2024г | 1 | 30 |',
].join('\n');

const FORM_B_PAGE_2 = [
  '| | | | | | | | |',
  '|---|---|---|---|---|---|---|---|',
  '|  | 1.7 | Протокол радиационного контроля | №9/07 | ООО "ТБУ-Тест" | от 19.07.2024 | 1 | 8 |',
  '| Опорная стойка (ООО "БАУТРАНС-Тест") |  |  |  |  |  |  |  |',
  '| 2 | 2.1 | АОСР Погружение опорной стойки | №02-ОС | ООО "Баутранс-Тест" | от 30.07.2024 | 1 | 36 |',
  '|  | 2.2 | Реестр к АОСР №02-ОС | №01 | ООО "Баутранс-Тест" | от 30.07.2024 | 1 | 37 |',
  '',
  '**Принял:**',
  '',
  'Представитель ООО «Заказчик-Тест»',
].join('\n');

const formB = (): ReturnType<typeof parseTransferRegistry> =>
  parseTransferRegistry({
    pages: [page('b-1', FORM_B_PAGE_1), page('b-2', FORM_B_PAGE_2)],
  });

describe('parseTransferRegistry, форма Б', () => {
  it('определяет форму по графам «кол-во листов» и «страница по списку»', () => {
    expect(formB().form).toBe('b');
  });

  it('открывает группу баннером и берёт исполнителя из скобок', () => {
    const groups = formB().groups;

    expect(groups).toHaveLength(2);
    expect(groups[0]?.titleRaw).toBe('Устройство шпунтового ограждения котлована');
    expect(groups[0]?.contractorRaw).toBe('ООО "БАУТРАНС-Тест"');
    expect(groups[1]?.titleRaw).toBe('Опорная стойка');
  });

  it('берёт номер АОСР из строки акта внутри группы, а не из баннера', () => {
    const groups = formB().groups;

    expect(groups[0]?.actNoRaw).toBe('04-ШО');
    expect(groups[0]?.actRowOrdinal).toBe(0);
    expect(groups[1]?.actNoRaw).toBe('02-ОС');
  });

  it('строка «Реестр к АОСР» номер группы не переопределяет', () => {
    // Второй «АОСР» в наименовании — это приложение, а не сам акт: правило
    // смотрит на НАЧАЛО наименования и срабатывает только один раз на группу.
    expect(formB().groups[0]?.actNoRaw).toBe('04-ШО');
  });

  it('продолжает группу через разрыв страницы без повтора баннера', () => {
    const { rows, groups } = formB();
    const protocol = rows.find((row) => row.docNoRaw === '9/07');

    expect(protocol?.groupOrdinal).toBe(groups[0]?.ordinal);
  });

  it('различает дату составления и срок действия', () => {
    const rows = formB().rows;

    const act = rows.find((row) => row.docNoRaw === '04-ШО');
    expect(act?.issuedAt).toBe('2024-08-02');

    const range = rows.find((row) => row.docNameRaw === 'Сертификат соответствия');
    expect(range?.validFrom).toBe('2023-12-15');
    expect(range?.validTo).toBe('2028-12-14');

    // «до …» и «действителен до …» — это срок, а не дата составления.
    const until = rows.find((row) => row.docNameRaw === 'Сертификат калибровки');
    expect(until?.validTo).toBe('2028-11-23');
    expect(until?.issuedAt).toBeNull();

    const valid = rows.find((row) => row.docNameRaw === 'Свидетельство о поверке');
    expect(valid?.validTo).toBe('2026-04-02');
    expect(valid?.issuedAt).toBeNull();
  });

  it('срок без дня не превращается в дату', () => {
    const { rows, warnings } = formB();
    const row = rows.find((item) => item.docNameRaw === 'Паспорт');

    expect(row?.validTo).toBeNull();
    expect(row?.issuedAt).toBeNull();
    expect(warnings.some((text) => text.includes('10.2024') && text.includes('без дня'))).toBe(
      true,
    );
  });

  it('число листов и «страница по списку» читаются, диапазон остаётся дословным', () => {
    const rows = formB().rows;
    const calibration = rows.find((row) => row.docNameRaw === 'Сертификат калибровки');

    expect(calibration?.sheets).toBe(2);
    expect(calibration?.pagesRaw).toBe('26-27');
    expect(rows.find((row) => row.docNoRaw === '04-ШО')?.pagesRaw).toBe('1');
  });

  it('дробный «№ п/п» хранится текстом', () => {
    const rows = formB().rows;

    expect(rows.map((row) => row.rowNo).slice(0, 3)).toStrictEqual(['1.1', '1.2', '1.3']);
  });

  it('читает номер реестра и номер папки из таблицы-шапки', () => {
    const header = formB().header;

    expect(header.registryNo).toBe('8');
    expect(header.folderNo).toBe('4');
  });

  it('подвал в опись не попадает', () => {
    expect(formB().rows.some((row) => row.docNameRaw.includes('Заказчик-Тест'))).toBe(false);
  });
});

// =====================================================================
// Открытый мир: чего разбор не имеет права сделать молча
// =====================================================================

describe('parseTransferRegistry, открытый мир', () => {
  it('нераспознанная шапка даёт предупреждение, а не пустой результат без причины', () => {
    const result = parseTransferRegistry({
      pages: [page('x-1', ['| А | Б | В |', '|---|---|---|', '| 1 | 2 | 3 |'].join('\n'))],
    });

    expect(result.form).toBeNull();
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.some((text) => text.includes('шапка описи не распознана'))).toBe(true);
  });

  it('строка до первой группы не пропадает молча', () => {
    const result = parseTransferRegistry({
      pages: [
        page(
          'y-1',
          [
            FORM_B_HEADER,
            '|---|---|---|---|---|---|---|---|',
            '|  | 1.1 | Сертификат без группы | №77 | ООО "Тест" | от 01.02.2024 | 1 | 1 |',
          ].join('\n'),
        ),
      ],
    });

    expect(result.rows).toHaveLength(0);
    expect(result.warnings.some((text) => text.includes('до первой группы'))).toBe(true);
  });

  it('группа без номера АОСР названа предупреждением', () => {
    const result = parseTransferRegistry({
      pages: [
        page(
          'z-1',
          [
            FORM_B_HEADER,
            '|---|---|---|---|---|---|---|---|',
            '| Работа без акта (ООО "Тест") |  |  |  |  |  |  |  |',
            '|  | 1.1 | Сертификат соответствия | №77 | ООО "Тест" | от 01.02.2024 | 1 | 1 |',
          ].join('\n'),
        ),
      ],
    });

    expect(result.groups[0]?.actNoRaw).toBeNull();
    expect(result.warnings.some((text) => text.includes('номер АОСР не найден'))).toBe(true);
  });
});

// =====================================================================
// Сопоставление групп с комплектами
// =====================================================================

const candidate = (over: Partial<TransferGroupCandidate>): TransferGroupCandidate => ({
  workId: 'work-1',
  revisionId: 'rev-1',
  contractorId: 'org-1',
  contractorName: 'ООО "Баутранс-Тест"',
  title: 'Устройство шпунтового ограждения котлована',
  actNumbers: ['04-ШО'],
  ...over,
});

describe('matchTransferGroups', () => {
  it('первая ступень — номер АОСР, и счёт у неё единица', () => {
    const { groups } = formB();
    const outcome = matchTransferGroups(groups, [candidate({})]);

    expect(outcome.groups[0]?.state).toBe('matched');
    expect(outcome.groups[0]?.workId).toBe('work-1');
    expect(outcome.groups[0]?.score).toBe(1);
  });

  it('номер, совпавший только после фолдинга гомоглифов, стоит дешевле точного', () => {
    const { groups } = formB();
    // «О» кириллическая в номере комплекта против латинской в описи.
    const outcome = matchTransferGroups(groups, [candidate({ actNumbers: ['04-ШO'] })]);

    expect(outcome.groups[0]?.state).toBe('matched');
    expect(outcome.groups[0]?.score).toBe(0.85);
  });

  it('наименование работы — ступень ниже номера', () => {
    const { groups } = formB();
    const outcome = matchTransferGroups(groups, [candidate({ actNumbers: ['совсем-другой'] })]);

    expect(outcome.groups[0]?.state).toBe('matched');
    expect(outcome.groups[0]?.score).toBe(0.9);
  });

  it('коллизия по наименованию различается исполнителем', () => {
    const { groups } = formB();
    const outcome = matchTransferGroups(groups, [
      candidate({ workId: 'work-1', actNumbers: [], contractorName: 'ООО "Баутранс-Тест"' }),
      candidate({ workId: 'work-2', actNumbers: [], contractorName: 'ООО "Другая-Тест"' }),
    ]);

    expect(outcome.groups[0]?.state).toBe('matched');
    expect(outcome.groups[0]?.workId).toBe('work-1');
    expect(outcome.groups[0]?.score).toBe(0.8);
  });

  it('коллизия, которую исполнитель не разрешает, остаётся ambiguous', () => {
    const { groups } = formB();
    const outcome = matchTransferGroups(groups, [
      candidate({ workId: 'work-1', actNumbers: [] }),
      candidate({ workId: 'work-2', actNumbers: [] }),
    ]);

    expect(outcome.groups[0]?.state).toBe('ambiguous');
    expect(outcome.groups[0]?.workId).toBeNull();
    expect(outcome.groups[0]?.score).toBeNull();
  });

  it('группа без комплекта — missing, комплект без группы — extra', () => {
    const { groups } = formB();
    const outcome = matchTransferGroups(groups, [
      candidate({}),
      candidate({ workId: 'work-9', actNumbers: ['09-ХХ'], title: 'Работа, которой нет в описи' }),
    ]);

    // Вторая группа описи («Опорная стойка») комплекта не нашла.
    expect(outcome.groups[1]?.state).toBe('missing');
    expect(outcome.extraWorkIds).toStrictEqual(['work-9']);
  });

  it('проигравшая ступень не гасит расхождение «комплект не назван описью»', () => {
    // У одного комплекта сходится номер, у второго — наименование той же
    // группы. Если бы лестница считалась целиком, второй перестал бы быть
    // «не названным описью», хотя ни одна группа его не выбрала.
    const { groups } = formB();
    const outcome = matchTransferGroups(groups, [
      candidate({ workId: 'work-1', actNumbers: ['04-ШО'], title: 'Совсем другая работа' }),
      candidate({ workId: 'work-2', actNumbers: ['нет такого'] }),
    ]);

    expect(outcome.groups[0]?.workId).toBe('work-1');
    expect(outcome.extraWorkIds).toContain('work-2');
  });
});
