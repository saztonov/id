/**
 * Двухуровневое извлечение реквизитов (§8.4).
 *
 * Тексты синтетические. Фикстура незнакомого типа взята дословно из
 * `tools/fixtures/src/synthetic.ts` (`FIXTURE_TEXTS['unknown-type']`) —
 * литералом, а не импортом: `@id/fixtures` не входит в зависимости `@id/api`,
 * и добавлять его ради одной строки значило бы тянуть в backend генератор PDF.
 * Дрейф этой строки заметен сразу: без неё падает главный набор файла.
 *
 * ИНН в наборе про контрольную сумму синтетический и намеренно битый; ни одно
 * значение корпуса сюда не перенесено (§1.4).
 */

import { describe, expect, it } from 'vitest';
import {
  extractBaseFields,
  extractFields,
  extractTypeFields,
  type ExtractionInput,
} from './extract.js';

/** `FIXTURE_TEXTS['unknown-type'][0]` — вида нет в каталоге намеренно. */
const UNKNOWN_TYPE_TEXT =
  'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ\n№ ГИ-77 от 12.05.2026\nДавление 1,0 МПа, выдержка 10 мин';

function input(text: string, overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    docTypeCode: null,
    typeConfident: false,
    pages: [{ pageTextVersionId: 'ptv1', text }],
    ...overrides,
  };
}

function valueOf(fields: readonly { fieldCode: string }[], code: string): unknown {
  return fields.find((field) => field.fieldCode === code);
}

// =====================================================================
// Гейт S8: базовая схема работает и на незнакомом типе
// =====================================================================

describe('базовая схема применяется всегда', () => {
  const fields = extractFields(
    input(UNKNOWN_TYPE_TEXT, { docTypeCode: 'unknown_document', typeConfident: false }),
  );

  it('документ незнакомого вида отдаёт номер и дату выдачи', () => {
    // Это и есть смысл двухуровневого извлечения (§8.4, §0.5): раздел,
    // которого система не знает, обязан всё равно давать данные для проверок
    // сроков и сверки с реестром. Иначе незнакомый раздел проваливается
    // целиком, а не частично.
    expect(valueOf(fields, 'number')).toMatchObject({ valueText: 'ГИ-77', extractedBy: 'rule' });
    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2026-05-12' });
  });

  it('резервный тип не отключает базовые экстракторы', () => {
    const asFallback = extractBaseFields(
      input(UNKNOWN_TYPE_TEXT, { docTypeCode: 'other_quality_docs', typeConfident: true }),
    );
    const asUnknown = extractBaseFields(input(UNKNOWN_TYPE_TEXT, { docTypeCode: null }));

    expect(asFallback.map((field) => field.fieldCode)).toEqual(
      asUnknown.map((field) => field.fieldCode),
    );
  });

  it('документ без текста не является ошибкой', () => {
    expect(extractFields(input(''))).toEqual([]);
  });
});

// =====================================================================
// Типо-специфичный уровень
// =====================================================================

describe('типо-специфичная схема — только при уверенно определённом типе', () => {
  const PROTOCOL =
    'ПРОТОКОЛ об испытаниях № 1753.КП/02.26 от 04.02.2026\n' +
    'Дата изготовления образцов: 07.01.2026\n' +
    'Дата испытания: 04.02.2026\n' +
    'Возраст на момент испытания 28 сут';

  it('при typeConfident: false специфичные реквизиты не извлекаются', () => {
    // Экстрактор написан под форму конкретного вида. На документе другого вида
    // он не «не найдёт», а найдёт НЕ ТО, и отличить это будет нельзя.
    expect(
      extractTypeFields(
        input(PROTOCOL, { docTypeCode: 'lab_protocol_concrete', typeConfident: false }),
      ),
    ).toEqual([]);
  });

  it('при typeConfident: true специфичные реквизиты добавляются к базовым', () => {
    const specific = extractTypeFields(
      input(PROTOCOL, { docTypeCode: 'lab_protocol_concrete', typeConfident: true }),
    );

    expect(valueOf(specific, 'tested_at')).toMatchObject({ valueDate: '2026-02-04' });
    expect(valueOf(specific, 'made_at')).toMatchObject({ valueDate: '2026-01-07' });
    expect(valueOf(specific, 'age_days')).toMatchObject({ valueNum: '28' });
  });

  it('специфичный уровень не дублирует базовые реквизиты', () => {
    const all = extractFields(
      input(PROTOCOL, { docTypeCode: 'lab_protocol_concrete', typeConfident: true }),
    );
    const codes = all.map((field) => field.fieldCode);

    expect(codes).toEqual([...new Set(codes)]);
    expect(codes).toContain('number');
  });

  it('неизвестный код типа специфичных реквизитов не даёт', () => {
    expect(
      extractTypeFields(input(PROTOCOL, { docTypeCode: 'нет_такого_типа', typeConfident: true })),
    ).toEqual([]);
  });

  it('кадастровый номер участка номером схемы не становится', () => {
    // Боевой случай папки «ИД Мастер апрель 2026»: у листа схемы заголовка
    // нет, а в штампе первым напечатан кадастровый номер объекта. Двенадцать
    // схем получили номером «77:07:0010004:24», и правило приложений п. 4
    // акта столько же раз сообщило, что схемы в комплекте нет.
    const scheme =
      '**[STAMP]** | Object: «Жилой комплекс, кадастровый № 77:07:0010004:24» | ' +
      'Stage: ИД\n\n' +
      'Исполнительная схема № 48.1-ОТ/-1 ЭТАЖ\n' +
      'Приложение к акту № 48-ОТ/-1 ЭТАЖ от 10.04.2026г.';
    const fields = extractFields(
      input(scheme, { docTypeCode: 'exec_scheme', typeConfident: true }),
    );

    expect(valueOf(fields, 'scheme_number')).toMatchObject({ valueText: '48.1-ОТ/-1 ЭТАЖ' });
    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '48.1-ОТ/-1 ЭТАЖ' });
  });

  it('кадастровый номер не берётся и там, где он не подписан словом', () => {
    // В наименовании объекта номер идёт без слова «кадастровый»: признак
    // держится на форме записи, а не на соседях слева.
    const scheme = 'Объект: ЖК на Мосфильмовской, № 77:07:0010004:24, корпус 1';
    const fields = extractFields(
      input(scheme, { docTypeCode: 'exec_scheme', typeConfident: true }),
    );

    expect(valueOf(fields, 'number')).toBeUndefined();
  });

  it('номер исполнительной схемы читается из штампа страницы', () => {
    // Лист схемы не назван нигде, кроме штампа: ни заголовка, ни номера в теле
    // страницы у чертежа нет. Штамп попадает в текст рендером v2 — и номер
    // берут оба кода, базовый `number` и `scheme_number` каталога.
    const scheme =
      '**[STAMP]** | № К14/ДК2-СЦ4 | Code: СТ26/01-14-ДК2-РД | Stage: ИД | Sheet: 1 из 1\n\n' +
      '**Name:** Исполнительная схема стяжки в/о П.Д-П.Ж\n\n' +
      '**Organization:** ООО «ЭМДМ-СТРОЙ»';
    const fields = extractFields(
      input(scheme, { docTypeCode: 'exec_scheme', typeConfident: true }),
    );

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: 'К14/ДК2-СЦ4' });
    expect(valueOf(fields, 'scheme_number')).toMatchObject({ valueText: 'К14/ДК2-СЦ4' });
    // «Обозначение» проекта печатается без «№» и номером документа не является:
    // оно общее у всех листов раздела.
    expect(valueOf(fields, 'number')).not.toMatchObject({ valueText: 'СТ26/01-14-ДК2-РД' });
  });
});

// =====================================================================
// Поля LLM детерминированно не выдумываются
// =====================================================================

describe('поля LLM не выдаются правилами', () => {
  const CERTIFICATE =
    'СЕРТИФИКАТ СООТВЕТСТВИЯ № RU.TCC.240.445.30406\n' +
    'ИЗГОТОВИТЕЛЬ ООО "Тест-Материал", адрес: 000000, тестовый адрес\n' +
    'ЗАЯВИТЕЛЬ ООО "Пример-Строй"\n' +
    'Продукция: пруток тестовый\n' +
    'соответствует требованиям ГОСТ 34028-2016';

  it.each([
    'issuer',
    'applicant',
    'manufacturer',
    'product_name',
    'product_marks',
    'basis_documents',
  ])('реквизит %s остаётся LLM-стадии', (code) => {
    // Значение с `extractedBy: 'rule'` выглядит проверенным фактом: оно
    // показывается инженеру с цитатой и питает правила §9. Взять «строку
    // после слова ИЗГОТОВИТЕЛЬ» значило бы подать догадку в этом качестве.
    const fields = extractFields(
      input(CERTIFICATE, { docTypeCode: 'cert_conformity', typeConfident: true }),
    );

    expect(fields.map((field) => field.fieldCode)).not.toContain(code);
  });

  it('детерминированные реквизиты того же документа при этом извлекаются', () => {
    const fields = extractFields(
      input(CERTIFICATE, { docTypeCode: 'cert_conformity', typeConfident: true }),
    );

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: 'RU.TCC.240.445.30406' });
    expect(valueOf(fields, 'gost_tu')).toMatchObject({ valueJson: ['ГОСТ 34028-2016'] });
  });
});

// =====================================================================
// Уверенность
// =====================================================================

describe('уверенность различает сильный и слабый шаблон', () => {
  it('дата под словом «от» надёжнее голой даты в теле', () => {
    // §9.1: низкая уверенность обязана давать `undetermined`, а не `fail`.
    // Если обе находки получат одну уверенность, различать будет нечем, и
    // правило поднимет замечание на дате поверки прибора.
    const strong = extractBaseFields(input('ПАСПОРТ № П-1 от 01.02.2026'));
    const weak = extractBaseFields(input('ПАСПОРТ № П-1\nповерка прибора 01.02.2026'));

    const strongDate = strong.find((field) => field.fieldCode === 'issued_at');
    const weakDate = weak.find((field) => field.fieldCode === 'issued_at');

    expect(strongDate?.valueDate).toBe('2026-02-01');
    expect(weakDate?.valueDate).toBe('2026-02-01');
    expect(weakDate?.confidence).toBeLessThan(strongDate?.confidence ?? 0);
  });

  it('номер со знаком «№» надёжнее номера с латинской N', () => {
    const strong = extractBaseFields(input('СЕРТИФИКАТ № С-1'));
    const weak = extractBaseFields(input('СЕРТИФИКАТ\nN С-1'));

    expect(weak.find((f) => f.fieldCode === 'number')?.valueText).toBe('С-1');
    expect(weak.find((f) => f.fieldCode === 'number')?.confidence).toBeLessThan(
      strong.find((f) => f.fieldCode === 'number')?.confidence ?? 0,
    );
  });

  it('битая контрольная сумма ИНН понижает уверенность, но значение не теряет', () => {
    // §9.1: значение обязано существовать, иначе дефект исчезает вместе с
    // реквизитом и правило не сможет выдать даже `undetermined`.
    const valid = extractBaseFields(input('ИНН 7707083893'));
    const broken = extractBaseFields(input('ИНН 7707083894'));

    const brokenInn = broken.find((field) => field.fieldCode === 'manufacturer_inn');

    expect(brokenInn?.valueText).toBe('7707083894');
    expect(brokenInn?.confidence).toBeLessThan(
      valid.find((field) => field.fieldCode === 'manufacturer_inn')?.confidence ?? 0,
    );
  });
});

// =====================================================================
// Доказательство
// =====================================================================

describe('доказательство', () => {
  it('цитата — ровно срез текста по своему диапазону', () => {
    const text = 'ПАСПОРТ КАЧЕСТВА № ПК-42 от 03.03.2026';
    const fields = extractBaseFields(input(text));

    for (const field of fields) {
      const evidence = field.evidence;
      if (evidence === null) continue;
      expect(evidence.quote).toBe(text.slice(evidence.charStart, evidence.charEnd));
      expect(evidence.pageTextVersionId).toBe('ptv1');
    }

    expect(fields.find((field) => field.fieldCode === 'number')?.evidence?.quote).toBe('ПК-42');
  });

  it('страница без версии текста даёт значение без доказательства, а не молчание', () => {
    // Версия текста может отсутствовать (страница-картинка, ручной ввод).
    // Значение при этом остаётся, но `evidence` честно `null`: диапазон, не
    // привязанный к версии текста, ни на что не отображается (§3.5, CHECK
    // `field_values_span_source_chk`).
    const fields = extractBaseFields({
      docTypeCode: null,
      typeConfident: false,
      pages: [{ pageTextVersionId: null, text: 'СЕРТИФИКАТ № С-9' }],
    });

    expect(fields.find((field) => field.fieldCode === 'number')?.valueText).toBe('С-9');
    expect(fields.find((field) => field.fieldCode === 'number')?.evidence).toBeNull();
  });
});

// =====================================================================
// Формы значений
// =====================================================================

describe('формы записи, наблюдаемые в корпусе', () => {
  it('срок действия «с … по …» разбирается в две даты', () => {
    const fields = extractBaseFields(input('Срок действия с 01.10.2024 по 01.10.2028'));

    expect(valueOf(fields, 'valid_from')).toMatchObject({ valueDate: '2024-10-01' });
    expect(valueOf(fields, 'valid_to')).toMatchObject({ valueDate: '2028-10-01' });
  });

  it('дата прописью «от «09» марта 2026» разбирается', () => {
    const fields = extractBaseFields(input('АКТ № 336 от «09» марта 2026'));

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2026-03-09' });
  });

  it('полужирная дата модели разбирается наравне с обычной', () => {
    // Правка ради даты акта общая для всех дат, и держать её надо тестом на
    // базовом реквизите тоже: `issued_at` читают все виды документов.
    const fields = extractBaseFields(input('АКТ № 336 от «**09**» **марта 2026г.**'));

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2026-03-09' });
  });

  it('несуществующая дата не превращается в соседнюю', () => {
    // `new Date(2026, 1, 31)` молча даёт 3 марта. Молчаливая коррекция здесь
    // хуже отсутствия: она даёт правилу сроков дату, которой в документе нет.
    expect(extractBaseFields(input('АКТ № 1 от 31.02.2026')).map((f) => f.fieldCode)).not.toContain(
      'issued_at',
    );
  });

  it('нормативные документы собираются списком без повторов', () => {
    const fields = extractBaseFields(
      input(
        'соответствует ГОСТ 34028-2016, ГОСТ Р 52544-2006 и ТУ 1234-001\nповторно ГОСТ 34028-2016',
      ),
    );

    expect(valueOf(fields, 'gost_tu')).toMatchObject({
      valueJson: ['ГОСТ 34028-2016', 'ГОСТ Р 52544-2006', 'ТУ 1234-001'],
    });
  });

  it('номер партии и номер плавки различаются', () => {
    const fields = extractBaseFields(input('партия № 94819, плавка № 220145'));

    expect(valueOf(fields, 'batch_no')).toMatchObject({ valueText: '94819' });
    expect(valueOf(fields, 'heat_no')).toMatchObject({ valueText: '220145' });
  });

  it('коды ОКПД 2 и ТН ВЭД извлекаются по своим подписям', () => {
    const fields = extractBaseFields(input('код ОКПД 2 23.99.12.110; код ТН ВЭД 6807 10 000 1'));

    expect(valueOf(fields, 'okpd2')).toMatchObject({ valueText: '23.99.12.110' });
    expect(valueOf(fields, 'tnved')).toMatchObject({ valueText: '6807 10 000 1' });
  });

  it('запись об аккредитации извлекается по форме RA.RU', () => {
    const fields = extractBaseFields(
      input('уникальный номер записи об аккредитации № RA.RU.21НВ77'),
    );

    expect(valueOf(fields, 'issuer_accreditation')).toMatchObject({ valueText: 'RA.RU.21НВ77' });
  });

  it('реквизит собирается со всех страниц документа, а не только с первой', () => {
    const fields = extractBaseFields({
      docTypeCode: null,
      typeConfident: false,
      pages: [
        { pageTextVersionId: 'ptv1', text: 'СЕРТИФИКАТ № С-1' },
        { pageTextVersionId: 'ptv2', text: 'Дата изготовления: 15.01.2026' },
      ],
    });

    expect(valueOf(fields, 'manufactured_at')).toMatchObject({ valueDate: '2026-01-15' });
    expect(
      fields.find((field) => field.fieldCode === 'manufactured_at')?.evidence?.pageTextVersionId,
    ).toBe('ptv2');
  });
});

// =====================================================================
// Номер с пробелами внутри — дефект, найденный сквозным прогоном S8
// =====================================================================

describe('номер документа с пробелами внутри', () => {
  it('номер декларации берётся целиком, а не до первого пробела', () => {
    // Дефект был не «неточным значением», а отказом сверки §8.3: шаблон брал
    // первый токен, и ВСЕ декларации комплекта получали номер «РОСС».
    // Фолдинг гомоглифов при этом становился бессмысленным — сравнивать
    // было нечего.
    const fields = extractBaseFields(
      input('ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ\n№ РОСС RU Д-RU.PA01.B.99001/24\nСрок действия'),
    );

    expect(valueOf(fields, 'number')).toMatchObject({
      valueText: 'РОСС RU Д-RU.PA01.B.99001/24',
    });
  });

  it('разряды номера, разделённые пробелом, остаются в номере', () => {
    // Форма из корпуса: «№79 825 от 12.01.2026».
    const fields = extractBaseFields(input('ПАСПОРТ КАЧЕСТВА\n№79 825 от 12.01.2026'));

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '79 825' });
  });

  it('дата выдачи в номер не подмешивается', () => {
    // Обратная цена того же послабления: без учёта регистра «от» уезжало в
    // номер, и документ переставал находиться по нему.
    for (const text of ['АКТ\n№ 01-ТЕСТ от «27» февраля 2026', 'АКТ\n№ ГИ-77 от 12.05.2026']) {
      const fields = extractBaseFields(input(text));
      const number = valueOf(fields, 'number') as { valueText: string };
      expect(number.valueText, text).not.toContain('от');
    }
  });

  it('наименование организации после номера в номер не попадает', () => {
    const fields = extractBaseFields(input('СЕРТИФИКАТ КАЧЕСТВА № 16005 ООО «Ромашка»'));

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '16005' });
  });

  it('соседняя ячейка таблицы в номер не утягивается', () => {
    const fields = extractBaseFields(
      input('| 1 | Сертификат соответствия | №RU.ТЕСТ.001.Н.00042 | ООО «Ромашка» |'),
    );

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: 'RU.ТЕСТ.001.Н.00042' });
  });
});

// =====================================================================
// Полужирный заголовок с номером (комплект 01-ДК2-СЦ)
// =====================================================================

describe('полужирное начертание заголовка не портит номер', () => {
  it('номер внутри `**…**` не обрезается до последней точки', () => {
    // Шаблон не смыкался на закрывающих звёздочках и откатывался назад:
    // «POCC RU Д-RU.PA01.B.36916/24» превращалось в «POCC RU Д-RU.PA01.B»,
    // и три декларации комплекта не находились в реестре приложений.
    const fields = extractBaseFields(
      input('## ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ\n\n**№ POCC RU Д-RU.PA01.B.36916/24**\n\nЗАЯВИТЕЛЬ:'),
    );

    expect(valueOf(fields, 'number')).toMatchObject({
      valueText: 'POCC RU Д-RU.PA01.B.36916/24',
    });
  });

  it('звёздочки не уезжают в значение реквизита', () => {
    // «18-000002580**» отличается от строки реестра ровно на разметку, и
    // точное совпадение вырождалось в частичное с пометкой «проверьте».
    const fields = extractBaseFields(input('**Документ о качестве № 18-000002580**'));

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '18-000002580' });
  });

  it('номер партии в полужирном заголовке остаётся номером документа', () => {
    const fields = extractBaseFields(
      input('**ДОКУМЕНТ О КАЧЕСТВЕ БЕТОННОЙ СМЕСИ ЗАДАННОГО КАЧЕСТВА ПАРТИИ № АБ000000389**'),
    );

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: 'АБ000000389' });
  });
});

// =====================================================================
// Чужой номер выше собственного (комплект 01-ДК2-СЦ)
// =====================================================================

describe('номер аккредитации лаборатории не выдаётся за номер документа', () => {
  const PROTOCOL = [
    '**ГЛАВЛАБГРУПП**',
    '',
    'Испытательная лаборатория ООО «ГЛАВЛАБГРУПП»',
    'Аттестат аккредитации №POCC RU.31112.И002015',
    'Срок действия до 24 июня 2026 года.',
    '',
    '## Протокол об испытаниях №1753.КП/02.26 от 04.02.2026',
  ].join('\n');

  it('берётся номер протокола, а не номер аттестата из шапки лаборатории', () => {
    // Из нескольких находок равной уверенности побеждает первая по тексту, а
    // шапка лаборатории напечатана выше заголовка. Все пять протоколов
    // комплекта получали номер лаборатории и не находились в реестре.
    const fields = extractBaseFields(input(PROTOCOL));

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '1753.КП/02.26' });
  });

  it('признак смотрит только на свою строку', () => {
    // «Аккредитация» абзацем выше относится к своему предложению: снимать по
    // ней номер следующего абзаца значило бы терять номер документа целиком.
    const fields = extractBaseFields(input('Область аккредитации\n\nПРОТОКОЛ ИСПЫТАНИЙ № 42/2026'));

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '42/2026' });
  });
});

// =====================================================================
// Подписи граф печатных форм номером не являются (temp/MD/new)
// =====================================================================

describe('подписи граф бланков не выдаются за номер документа', () => {
  it('«№ док» из штампа чертежа по ГОСТ Р 21.101 отклоняется', () => {
    // Описание штампа исполнительной схемы попадает в текст IMAGE-блока:
    // «Изм. Кол-во. Лист № док Подпись Дата». Захват «док» давал схеме номер
    // «док» с уверенностью 0.9 и ломал сверку с реестром.
    const fields = extractBaseFields(
      input('Строка таблицы: «Изм. Кол-во. Лист № док Подпись Дата», «Разраб. Синтетов С.С.»'),
    );

    expect(valueOf(fields, 'number')).toBeUndefined();
  });

  it('«№ п/п» — графа таблицы, а не номер', () => {
    const fields = extractBaseFields(input('Таблица показателей: № п/п, наименование, значение'));

    expect(valueOf(fields, 'number')).toBeUndefined();
  });

  it('«№ партии: 7» — реквизит партии, у него своё правило', () => {
    const fields = extractBaseFields(input('ПАСПОРТ КАЧЕСТВА\n№ партии: 7 от 01.02.2026'));

    expect(valueOf(fields, 'number')).toBeUndefined();
    expect(valueOf(fields, 'batch_no')).toMatchObject({ valueText: '7' });
  });

  it('одинокая кавычка после «№» номером не является', () => {
    const fields = extractBaseFields(input('Схема к акту № » от 21.11.2024'));

    expect(valueOf(fields, 'number')).toBeUndefined();
  });

  it('настоящий номер при этом извлекается как раньше', () => {
    const fields = extractBaseFields(input('СЕРТИФИКАТ № РОСС RU Д-RU.PA01.B.17254/23'));

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: 'РОСС RU Д-RU.PA01.B.17254/23' });
  });
});

describe('штамп электронной подписи не отравляет даты документа', () => {
  const ESIGN_ROW =
    '| Представитель лица | СИНТЕТОВ СИНТЕТ СИНТЕТОВИЧ,; ГЕНЕРАЛЬНЫЙ ДИРЕКТОР | ' +
    '14ACABDFF4E0954028EF68626CDD386F; BD4E4CC2; Действителен с 03.03.2025 по 03.06.2026; ' +
    'Выдан Федеральная налоговая служба | 22.05.2026 13:08 UTC +00 |';

  it('срок действия сертификата подписи не становится сроком документа', () => {
    const fields = extractBaseFields(input(ESIGN_ROW));

    expect(valueOf(fields, 'valid_from')).toBeUndefined();
    expect(valueOf(fields, 'valid_to')).toBeUndefined();
  });

  it('время подписания с UTC не становится датой выдачи', () => {
    const fields = extractBaseFields(input(ESIGN_ROW));

    expect(valueOf(fields, 'issued_at')).toBeUndefined();
  });

  it('настоящий срок действия документа при этом извлекается', () => {
    const fields = extractBaseFields(
      input('СЕРТИФИКАТ СООТВЕТСТВИЯ № С-1\nСрок действия с 01.10.2024 по 01.10.2028'),
    );

    expect(valueOf(fields, 'valid_from')).toMatchObject({ valueDate: '2024-10-01' });
    expect(valueOf(fields, 'valid_to')).toMatchObject({ valueDate: '2028-10-01' });
  });
});

// =====================================================================
// S34: собственный номер выбирается по ярлыку, а не по месту на листе
// =====================================================================

/**
 * Чужой номер отсекался списком того, чем номер быть НЕ должен, а такой список
 * не закрывается: у сертификата чужой номер один, у протокола другой, у
 * свидетельства о поверке третий. Ярлык собственного номера, наоборот, конечен.
 */
describe('ранжир: ярлык собственного номера сильнее любого «№» на листе', () => {
  it('«Архивный номер» без «№» побеждает номер договора', () => {
    // Протокол уплотнения из корпуса печатает свой номер ТОЛЬКО так, а выше
    // напечатан договор с заказчиком, у которого «№» есть.
    const text = [
      'Испытательная лаборатория ООО «ТЕСТЛАБ»',
      'Заказчик: ООО «ТЕСТ» (договор №СУ2-СТ-СП-0000-0 от 25.05.2023 г.)',
      '«Архивный номер: 2410-04/10», заголовок «Протокол от 04.10.2024».',
    ].join('\n');

    expect(valueOf(extractBaseFields(input(text)), 'number')).toMatchObject({
      valueText: '2410-04/10',
    });
  });

  it('ярлык посреди фразы перечисляет ЧУЖИЕ документы и не срабатывает', () => {
    // В перечне оснований декларации стоит «…, номер сертификата: RU 100 00020»
    // — это сертификат СМК изготовителя. Свой номер декларация печатает выше.
    const text = [
      '**ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ**',
      '',
      '№ РОСС RU Д-RU.PA01.B.00000/25',
      '',
      'Сертификат соответствия системы менеджмента ГОСТ Р ИСО 9001-2015, номер сертификата: RU 100 00020',
    ].join('\n');

    expect(valueOf(extractBaseFields(input(text)), 'number')).toMatchObject({
      valueText: 'РОСС RU Д-RU.PA01.B.00000/25',
    });
  });

  it('кавычка после номера не утягивает первую букву следующего слова', () => {
    // `NUMBER_TAIL` продолжает номер токеном с прописной буквы, и захваченная
    // закрывающая кавычка открывала ему дорогу: «000000». П».
    const text = '«Номер сертификата №000000», «Дата калибровки: 15.04.2024». Полевые записи:';

    expect(valueOf(extractBaseFields(input(text)), 'number')).toMatchObject({
      valueText: '000000',
    });
  });
});

describe('номер при заголовке документа сильнее номера из шапки организации', () => {
  it('номер строкой ниже титула побеждает номер аккредитации выше него', () => {
    // Признак `FOREIGN_NUMBER_OWNER` смотрит влево по своей строке, а здесь
    // владелец чужого номера назван строкой выше, и «№» открывает свою строку.
    const text = [
      'ООО "ТЕСТ МЕТРОЛОГИЯ"',
      'Уникальный номер записи об аккредитации в реестре',
      'аккредитованных лиц № RA.RU.000000',
      '',
      'СВИДЕТЕЛЬСТВО О ПОВЕРКЕ',
      '№ С-ТЕСТ/00-00-2024/000000001',
    ].join('\n');

    expect(valueOf(extractBaseFields(input(text)), 'number')).toMatchObject({
      valueText: 'С-ТЕСТ/00-00-2024/000000001',
    });
  });

  it('титул в две строки под разметкой бланка тоже считается заголовком', () => {
    const text = ['**АКТ**', '', '**освидетельствования скрытых работ**', '', '№ 01-TEST'].join(
      '\n',
    );

    expect(valueOf(extractBaseFields(input(text)), 'number')).toMatchObject({
      valueText: '01-TEST',
    });
  });

  it('заголовок, введённый пунктом перечня, — упоминание чужого документа', () => {
    // Примечание исполнительной схемы ссылается на поверку ПРИБОРА. Без
    // запрета схема получала бы номер чужого свидетельства своим.
    const text = [
      'ПРИМЕЧАНИЕ:',
      '5. Съемка выполнена тахеометром Leica TS06 №1383653.',
      'Свидетельство о поверке',
      '№С-ТЕСТ/00-00-2023/000000 от 16.11.2023.',
    ].join('\n');

    const number = valueOf(extractBaseFields(input(text)), 'number') as
      { valueText: string } | undefined;

    expect(number?.valueText).not.toBe('С-ТЕСТ/00-00-2023/000000');
  });
});

// =====================================================================
// Дата составления акта: месяц всего комплекта выводится из неё
// =====================================================================

/**
 * Формы записи даты, снятые с девяти актов корпуса.
 *
 * Набор дословно повторяет НАЧЕРТАНИЕ, а не значения: числа заменены на
 * синтетические, чтобы в тест не переезжали данные объекта (§1.4). Важно здесь
 * ровно то, что между кавычкой, числом и месяцем стоит — пробел, отсутствие
 * пробела или полужирное выделение модели.
 */
const ACT_DATE_FORMS: readonly (readonly [string, string])[] = [
  ['" 21 ноября 2024 г.', '2024-11-21'],
  ['" 31 " декабря 2024 г.', '2024-12-31'],
  ['"10" апреля 2026г.', '2026-04-10'],
  ['« 23 » июня 2026г.', '2026-06-23'],
  ['«02» февраля 2024 г.', '2024-02-02'],
  ['«09» марта 2026г.', '2026-03-09'],
  ['«22» марта 2026г.', '2026-03-22'],
  ['«23» ноября 2023 г.', '2023-11-23'],
  // Боевой случай, из-за которого месяц оставался пустым на прочитанном
  // целиком комплекте: модель выделяет число и месяц по отдельности.
  ['«**27**» **февраля 2026г.**', '2026-02-27'],
];

function actDateOf(text: string): string | undefined {
  const fields = extractTypeFields(input(text, { docTypeCode: 'aosr', typeConfident: true }));
  return (
    fields.find((field) => field.fieldCode === 'act_date') as { valueDate?: string } | undefined
  )?.valueDate;
}

describe('дата составления акта читается со всех форм бланка', () => {
  for (const [form, expected] of ACT_DATE_FORMS) {
    it(`подпись снизу: ${form}`, () => {
      expect(actDateOf(`${form}\n\n(дата составления акта)`)).toBe(expected);
    });
  }

  it('титул в три строки: «от» стоит под словом АКТ, а не рядом с ним', () => {
    // Форма фикстуры сквозного прогона. Ступень «ярлык на строке» сюда не
    // дотягивается: `[^\n]` не пускает её через перевод строки.
    const text = [
      'АКТ',
      'освидетельствования скрытых работ',
      '№ 01-ТЕСТ от «27» февраля 2026',
    ].join('\n');

    expect(actDateOf(text)).toBe('2026-02-27');
  });

  it('акт назван сокращением: АОСР № … от «06» апреля 2026', () => {
    // Номер вида «02-ДК2-СЦ(зх.27)(2.5.1.1.1.3.27)» в прежнее окно в сорок
    // знаков не укладывался, и дата не находилась.
    expect(actDateOf('АОСР № 02-ТЕСТ-СЦ(зх.27)(2.5.1.1.1.3.27) от «06» апреля 2026')).toBe(
      '2026-04-06',
    );
  });

  it('дата сертификата из п. 3 датой акта не становится', () => {
    // Строка открывателем начинается и дату вводит предлогом. Решает то, что
    // ПЕРВЫЙ заголовок над находкой — не акт.
    const text = [
      'АКТ',
      'освидетельствования скрытых работ',
      'п.3 При выполнении работ применены материалы',
      'СЕРТИФИКАТ СООТВЕТСТВИЯ № С-1 от 12.01.2026',
    ].join('\n');

    expect(actDateOf(text)).not.toBe('2026-01-12');
  });

  it('акт, введённый пунктом перечня, — упоминание чужого акта', () => {
    const text = ['5. Приложения:', 'АКТ', '№ 5 от 01.02.2026'].join('\n');

    expect(actDateOf(text)).toBeUndefined();
  });
});

// =====================================================================
// S40. Чья это дата
// =====================================================================

/**
 * Все шесть наборов ниже собраны по комплекту `№01_Бл_П`: до S40 портал
 * извлекал из них чужую дату и показывал её на экране как дату документа.
 * Тексты сокращены до строк, участвующих в решении, но записаны дословно —
 * иначе тест проверял бы не то, на чём дефект держался.
 */
describe('дата выдачи не берётся у чужого документа', () => {
  it('дата договора из шапки акта не становится датой акта', () => {
    const fields = extractFields(
      input(
        'АКТ\nосвидетельствования скрытых работ\n№ 01-Бл/П\n" 21 " ноября 2024 г.\n' +
          '(дата составления акта)\n\n' +
          'на основании договора №ДПТУ-01/23-СР от 10.04.2023 г. с ООО "Октябрь Апарм"',
        { docTypeCode: 'aosr', typeConfident: true },
      ),
    );

    // У акта даты выдачи нет вовсе: его дата — `act_date`.
    expect(valueOf(fields, 'issued_at')).toBeUndefined();
    expect(valueOf(fields, 'act_date')).toMatchObject({ valueDate: '2024-11-21' });
  });

  it('срок действия сертификата из п. 3 не становится сроком действия акта', () => {
    const fields = extractFields(
      input(
        'АКТ\nосвидетельствования скрытых работ\n№ 01-Бл/П\n' +
          '3. При выполнении работ применены:\n' +
          'Сертификат соответствия №RU.MCC.234.435.37815 (с 01.08.2023г. по 01.08.2026г.).',
        { docTypeCode: 'aosr', typeConfident: true },
      ),
    );

    expect(valueOf(fields, 'valid_to')).toBeUndefined();
    expect(valueOf(fields, 'valid_from')).toBeUndefined();
  });

  it('дата сертификата, названного в паспорте качества, не становится датой паспорта', () => {
    const fields = extractFields(
      input(
        'Паспорт качества №0297\nна песок для строительных работ\n\n' +
          '«26» сентября 2024 г.\n\n' +
          'Соответствует требованиям ГОСТ 8736-2014, ' +
          'Сертификат соответствия №RU.MCC.234.435.37815 от 01.08.2023',
        { docTypeCode: 'quality_passport', typeConfident: true },
      ),
    );

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2024-09-26' });
  });

  it('дата отраслевого соглашения не становится датой сертификата', () => {
    const fields = extractFields(
      input(
        'СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ RU.MCC.234.435.37815\n\n' +
          'Уполномочена Межотраслевой комиссией в рамках отраслевого трехстороннего ' +
          'Соглашения г. Москвы от 28.12.2021 № 62 в качестве базовой организации\n\n' +
          'Срок действия с 01 августа 2023 г. по 01 августа 2026 г.',
        { docTypeCode: 'cert_conformity', typeConfident: true },
      ),
    );

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2023-08-01' });
    expect(valueOf(fields, 'valid_to')).toMatchObject({ valueDate: '2026-08-01' });
  });

  it('дата поверки прибора из примечания схемы не становится датой схемы', () => {
    const fields = extractFields(
      input(
        'ПРИМЕЧАНИЕ:\n5. Съемка выполнена тахеометром Leica TS06 №1383653.\n' +
          'Свидетельство о поверке\n№С-ДЭМ/16-11-2023/294950039 от 16.11.2023.',
        { docTypeCode: 'exec_scheme', typeConfident: false },
      ),
    );

    expect(valueOf(fields, 'issued_at')).toBeUndefined();
  });

  it('собственная дата документа при его заголовке остаётся', () => {
    // Отрицательный контроль: предохранитель обязан снимать чужую дату, а не
    // всякую дату при слове «протокол».
    const fields = extractFields(
      input(
        'Протокол от 04.10.2024\nопределения коэффициента уплотнения обратной засыпки\n№ 2410-04/10',
        { docTypeCode: 'lab_protocol_generic', typeConfident: true },
      ),
    );

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2024-10-04' });
  });
});

describe('дата выдачи не берётся у другого реквизита того же документа', () => {
  const VERIFICATION =
    'ООО "ПРОММАШ ТЕСТ МЕТРОЛОГИЯ"\n\nСВИДЕТЕЛЬСТВО О ПОВЕРКЕ\n' +
    '№ С-ДЮП/17-04-2024/333174456\n\nДействительно до\n16.04.2025 г.\n\n' +
    'Средство измерений: Весы электронные лабораторные DX-300-WP\n\n' +
    'Дата поверки 17.04.2024 г.';

  it('свидетельство о поверке датируется поверкой, а не окончанием срока', () => {
    const fields = extractFields(
      input(VERIFICATION, { docTypeCode: 'metrology_verification', typeConfident: true }),
    );

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2024-04-17' });
    expect(valueOf(fields, 'valid_to')).toMatchObject({ valueDate: '2025-04-16' });
  });

  it('без подписи «дата поверки» срок окончания не выдаётся за дату выдачи', () => {
    // Слабая находка, совпавшая спаном с `valid_to`, снимается: один и тот же
    // участок текста не может быть двумя реквизитами сразу.
    const fields = extractFields(
      input(
        'СВИДЕТЕЛЬСТВО О ПОВЕРКЕ\n№ С-ДЮП/17-04-2024/333174456\n\nДействительно до\n16.04.2025 г.',
        {
          docTypeCode: 'metrology_verification',
          typeConfident: true,
        },
      ),
    );

    expect(valueOf(fields, 'issued_at')).toBeUndefined();
    expect(valueOf(fields, 'valid_to')).toMatchObject({ valueDate: '2025-04-16' });
  });

  it('дата изготовления не выдаётся за дату выдачи сертификата', () => {
    const fields = extractFields(
      input(
        'ОАО "Могилевхимволокно"\n\n8 августа 2023 г.\n\nСЕРТИФИКАТ № 275\n\n' +
          'Дата изготовления 07.09.2023',
        { docTypeCode: 'unknown_document', typeConfident: false },
      ),
    );

    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2023-08-08' });
    expect(valueOf(fields, 'manufactured_at')).toMatchObject({ valueDate: '2023-09-07' });
  });

  it('лист, отданный графикой, называет себя в пересказе Summary', () => {
    const fields = extractFields(
      input(
        '**[IMAGE]** | Type: Таблица\n\n' +
          '**Summary:** Сертификат № 275 от 8 августа 2023 г. на полотно полиэфирное ' +
          'геотекстильное ЛавсанГео-250 с таблицей норм и фактических показателей.',
        { docTypeCode: 'unknown_document', typeConfident: false },
      ),
    );

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '275' });
    expect(valueOf(fields, 'issued_at')).toMatchObject({ valueDate: '2023-08-08' });
  });
});

describe('ярлык собственного номера переживает разметку', () => {
  it('«**Номер сертификата №240545**» даёт номер документа, а не первый «№» листа', () => {
    // S40. Сертификат калибровки комплекта `№01_Бл_П` печатает в шапке бланка
    // свидетельство о регистрации ЛАБОРАТОРИИ, и его номер стоит на листе
    // первым. Пока ярлык требовал перед собой только пробелов, ступень на
    // выделенном полужирным поле не срабатывала, номер доставался чужой, и
    // строка реестра «Сертификат калибровки … № 240545» документа не находила.
    const fields = extractFields(
      input(
        'ООО «ИМЦ АЛЬФА МЕТРОЛОГИЧЕСКАЯ ЛАБОРАТОРИЯ»\nСвидетельство о регистрации\n' +
          '№ СНИЛЛ/КЛ-0001-21\n\n## СЕРТИФИКАТ КАЛИБРОВКИ\n\n' +
          '**Номер сертификата №240545**\n\nДата калибровки: 15.04.2024 г.',
        { docTypeCode: 'metrology_calibration', typeConfident: true },
      ),
    );

    expect(valueOf(fields, 'number')).toMatchObject({ valueText: '240545' });
  });
});
