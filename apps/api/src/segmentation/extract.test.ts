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
