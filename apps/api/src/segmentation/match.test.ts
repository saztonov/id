/**
 * Сверка реестра приложений с документами комплекта (§8.3).
 *
 * Номера синтетические. Форма номера декларации взята из §8.3 плана как
 * эталон фолдинга: реквизитом участника она не является и в списке маркеров
 * `pii:scan` не состоит.
 */

import { describe, expect, it } from 'vitest';
import { documentNumbersOf, matchRegistryRows, type MatchableDocument } from './match.js';
import type { ParsedRegistryRow } from './types.js';
import { normalizeDocNo } from '@id/contracts';

/** Строка реестра с автоматически посчитанными формами номера. */
function row(
  rowNo: number,
  docNo: string | null,
  docName = 'Документ о качестве',
): ParsedRegistryRow {
  const forms = docNo === null ? null : normalizeDocNo(docNo);

  return {
    rowNo,
    sectionTitle: null,
    docNameRaw: docName,
    docNoRaw: docNo,
    orgRaw: null,
    docNoNorm: forms?.normalized ?? null,
    docNoFolded: forms?.folded ?? null,
    validFrom: null,
    validTo: null,
    issuedAt: null,
  };
}

function doc(
  documentId: string,
  number: string | null,
  title = 'СЕРТИФИКАТ КАЧЕСТВА',
  extra: Partial<MatchableDocument> = {},
): MatchableDocument {
  return {
    documentId,
    docTypeCode: null,
    numbers: number === null ? [] : [number],
    issuedAt: null,
    title,
    ...extra,
  };
}

describe('matchRegistryRows', () => {
  it('точное совпадение номера даёт matched со счётом 1', () => {
    // Реестр печатает «№ 16005», документ — «16005»: `normalizeDocNo` снимает
    // и «№», и пробелы, поэтому сравнение остаётся точным.
    const result = matchRegistryRows([row(1, '№ 16005')], [doc('d1', '16005')]);

    expect(result.rows[0]).toEqual({
      rowNo: 1,
      matchState: 'matched',
      matchedDocumentId: 'd1',
      matchScore: 1,
      reason: 'номер документа совпал точно',
      // Подтверждённое совпадение называет документ прямо, и предлагать к нему
      // «похожих» незачем: кандидаты заполняются только у `candidate`.
      candidates: [],
    });
  });

  it('расхождение вида документа сверку не ломает', () => {
    // Прямая находка корпуса: реестр называет «Паспорт качества Арматура
    // №16005» лист, озаглавленный «СЕРТИФИКАТ КАЧЕСТВА № 16005»
    // (`docs/CORPUS_FINDINGS.md`). Сверка обязана идти ТОЛЬКО по номеру:
    // требование совпадения вида объявило бы полный комплект неполным.
    const result = matchRegistryRows(
      [row(1, '16005', 'Паспорт качества Арматура')],
      [
        {
          documentId: 'd1',
          docTypeCode: 'mill_certificate',
          numbers: ['16005'],
          issuedAt: null,
          title: 'СЕРТИФИКАТ КАЧЕСТВА',
        },
      ],
    );

    expect(result.rows[0]?.matchState).toBe('matched');
    expect(result.extraDocumentIds).toEqual([]);
  });

  it('документ, не названный ни одной строкой, попадает в лишние', () => {
    const result = matchRegistryRows([row(1, 'A-1')], [doc('d1', 'A-1'), doc('d2', 'B-2')]);

    expect(result.extraDocumentIds).toEqual(['d2']);
  });

  it('номера в комплекте нет — missing, а не ближайшее похожее', () => {
    const result = matchRegistryRows([row(1, 'A-1')], [doc('d1', 'A-2')]);

    expect(result.rows[0]?.matchState).toBe('missing');
    expect(result.rows[0]?.matchedDocumentId).toBeNull();
  });

  it('строка без сравнимого номера («б/н») не совпадает ни с чем', () => {
    // Два разных документа «без номера» совпали бы по такому «номеру», и
    // отчёт утверждал бы, что строка подтверждена чужим документом.
    const bez = { ...row(1, 'б/н'), docNoNorm: null, docNoFolded: null };
    const result = matchRegistryRows([bez], [doc('d1', 'б/н')]);

    expect(result.rows[0]?.matchState).toBe('missing');
    expect(result.extraDocumentIds).toEqual(['d1']);
  });

  describe('фолдинг гомоглифов', () => {
    /** Тот же номер в четырёх раскладках: точных совпадений между ними нет. */
    const REGISTRY_LATIN = 'РОСС RU Д-RU.РА01.В.10001/25';
    const REGISTRY_CYRILLIC = 'РОСС RU Д-РУ.PA01.B.10001/25';
    const DOCUMENT_LATIN = 'РОСС RU Д-RU.PA01.B.10001/25';
    const DOCUMENT_CYRILLIC = 'РОСС RU Д-РУ.РА01.В.10001/25';

    it('единственный кандидат по folded — matched, но со счётом ниже единицы', () => {
      const result = matchRegistryRows([row(1, REGISTRY_LATIN)], [doc('d1', DOCUMENT_CYRILLIC)]);

      expect(result.rows[0]?.matchState).toBe('matched');
      expect(result.rows[0]?.matchedDocumentId).toBe('d1');
      expect(result.rows[0]?.matchScore).toBeLessThan(1);
      expect(result.rows[0]?.reason).toContain('фолдинг');
    });

    it('несколько кандидатов по folded — ambiguous, а не matched', () => {
      // Прямое требование гейта S8. Проверка чувствительна: подмена
      // `ambiguous` на `matched` в `match.ts` роняет и `matchState`, и
      // `matchedDocumentId`, и `matchScore` — выбрать документ здесь
      // означало бы выдать догадку за проверенный факт.
      const result = matchRegistryRows(
        [row(1, REGISTRY_LATIN), row(2, REGISTRY_CYRILLIC)],
        [doc('d1', DOCUMENT_LATIN), doc('d2', DOCUMENT_CYRILLIC)],
      );

      expect(result.rows.map((match) => match.matchState)).toEqual(['ambiguous', 'ambiguous']);
      expect(result.rows.map((match) => match.matchedDocumentId)).toEqual([null, null]);
      expect(result.rows.map((match) => match.matchScore)).toEqual([null, null]);
      expect(result.rows[0]?.reason).toContain('2');
    });

    it('оба кандидата ambiguous-строки считаются названными и лишними не становятся', () => {
      const result = matchRegistryRows(
        [row(1, REGISTRY_LATIN)],
        [doc('d1', DOCUMENT_LATIN), doc('d2', DOCUMENT_CYRILLIC)],
      );

      expect(result.rows[0]?.matchState).toBe('ambiguous');
      expect(result.extraDocumentIds).toEqual([]);
    });

    it('точное совпадение выигрывает у folded-коллизии', () => {
      // Иначе строка получала бы `ambiguous` там, где посимвольно совпадает
      // ровно один документ, и сверка теряла бы свой самый надёжный сигнал.
      const result = matchRegistryRows(
        [row(1, DOCUMENT_LATIN)],
        [doc('d1', DOCUMENT_LATIN), doc('d2', DOCUMENT_CYRILLIC)],
      );

      expect(result.rows[0]).toMatchObject({
        matchState: 'matched',
        matchedDocumentId: 'd1',
        matchScore: 1,
      });
    });
  });

  it('несколько документов с одинаковым точным номером — тоже ambiguous', () => {
    const result = matchRegistryRows([row(1, 'A-1')], [doc('d1', 'A-1'), doc('d2', 'A-1')]);

    expect(result.rows[0]?.matchState).toBe('ambiguous');
    expect(result.rows[0]?.matchedDocumentId).toBeNull();
  });

  it('один документ на нескольких строках реестра — совпадение у каждой', () => {
    // В корпусе один сертификат покрывает три диаметра проката и назван в
    // трёх позициях. Отдавать совпадение только первой значило бы объявить
    // две оставшиеся позиции неподтверждёнными.
    const result = matchRegistryRows(
      [row(4, 'A-1'), row(5, 'A-1'), row(6, 'A-1')],
      [doc('d1', 'A-1')],
    );

    expect(result.rows.map((match) => match.matchState)).toEqual(['matched', 'matched', 'matched']);
  });

  it('документ без извлечённого номера в сверке не участвует и попадает в лишние', () => {
    const result = matchRegistryRows([row(1, 'A-1')], [doc('d1', 'A-1'), doc('d2', null)]);

    expect(result.extraDocumentIds).toEqual(['d2']);
  });

  it('пустой реестр объявляет лишними все документы', () => {
    // Комплект без реестра — штатный случай. Решение, считать ли это дефектом,
    // принимает правило S9, а не сверка.
    const result = matchRegistryRows([], [doc('d1', 'A-1')]);

    expect(result).toEqual({ rows: [], extraDocumentIds: ['d1'] });
  });

  describe('несколько номеров у документа', () => {
    it('документ находится по любому из своих номеров', () => {
      // У исполнительной схемы номер приходит шифром схемы из штампа, а не
      // реквизитом `number`: пока сверка смотрела только в него, ни одна схема
      // комплекта не находила свою строку реестра.
      const scheme: MatchableDocument = {
        documentId: 'd1',
        docTypeCode: 'exec_scheme',
        numbers: ['К14/ДК2-СЦ4'],
        issuedAt: null,
        title: null,
      };
      const result = matchRegistryRows([row(1, '№ К14/ДК2-СЦ4')], [scheme]);

      expect(result.rows[0]).toMatchObject({ matchState: 'matched', matchedDocumentId: 'd1' });
      expect(result.extraDocumentIds).toEqual([]);
    });

    it('две формы номера одного документа не делают его коллизией с самим собой', () => {
      const both: MatchableDocument = {
        documentId: 'd1',
        docTypeCode: null,
        numbers: ['A-10001', 'A 10001'],
        issuedAt: null,
        title: null,
      };
      const result = matchRegistryRows([row(1, 'A-10001')], [both]);

      expect(result.rows[0]?.matchState).toBe('matched');
      expect(result.rows[0]?.matchScore).toBe(1);
    });
  });

  describe('частичное совпадение номера', () => {
    it('единственный кандидат по куску номера — matched с низким счётом', () => {
      // Номер листа приходит из штампа то с приставкой раздела, то без неё.
      // Строгое сравнение объявляло бы «нет в комплекте» документ, который в
      // комплекте лежит, — ложный вывод, запрещённый §9.1.
      const result = matchRegistryRows([row(1, '№ К14/ДК2-СЦ4')], [doc('d1', 'ДК2-СЦ4')]);

      expect(result.rows[0]).toMatchObject({
        matchState: 'matched',
        matchedDocumentId: 'd1',
        matchScore: 0.6,
      });
      expect(result.rows[0]?.reason).toContain('частично');
    });

    it('несколько кандидатов по куску — ambiguous, а не выбор наугад', () => {
      const result = matchRegistryRows(
        [row(1, 'ДК2-СЦ4')],
        [doc('d1', 'К14/ДК2-СЦ4'), doc('d2', 'К15/ДК2-СЦ4')],
      );

      expect(result.rows[0]?.matchState).toBe('ambiguous');
      expect(result.rows[0]?.matchedDocumentId).toBeNull();
      // Оба кандидата названы описью, и лишними их объявлять нельзя.
      expect(result.extraDocumentIds).toEqual([]);
    });

    it('точное совпадение сильнее частичного', () => {
      const result = matchRegistryRows(
        [row(1, 'ДК2-СЦ4')],
        [doc('d1', 'ДК2-СЦ4'), doc('d2', 'К14/ДК2-СЦ4')],
      );

      expect(result.rows[0]).toMatchObject({ matchedDocumentId: 'd1', matchScore: 1 });
    });

    it('короткие номера в частичное сравнение не берутся', () => {
      // «1» входит подстрокой в половину номеров комплекта: разрешить такое
      // сравнение значило бы выдавать случайные пары за находки.
      const result = matchRegistryRows([row(1, '1')], [doc('d1', 'A-1')]);

      expect(result.rows[0]?.matchState).toBe('missing');
    });
  });
});

describe('documentNumbersOf', () => {
  it('собирает номера в порядке кодов и без повторов', () => {
    const numbers = documentNumbersOf([
      { fieldCode: 'scheme_number', valueText: 'К14/ДК2-СЦ4' },
      { fieldCode: 'issuer', valueText: 'ООО «СУ-10»' },
      { fieldCode: 'number', valueText: '336' },
      { fieldCode: 'blank_number', valueText: '  ' },
      { fieldCode: 'number', valueText: '336' },
    ]);

    // `number` первым — он и есть основной реквизит; пустые и повторы отброшены.
    expect(numbers).toEqual(['336', 'К14/ДК2-СЦ4']);
  });

  it('чужие номера — партии, заводской, номер акта в реестре — не берутся', () => {
    const numbers = documentNumbersOf([
      { fieldCode: 'batch_number', valueText: '7' },
      { fieldCode: 'serial_number', valueText: 'SN-1' },
      { fieldCode: 'act_number', valueText: '01-ДК2-СЦ' },
    ]);

    expect(numbers).toEqual([]);
  });
});

/**
 * S34: сокращённый вид документа перед номером.
 *
 * Реестр пишет «ИС №001», «ПС №4»: перед номером стоит сокращение вида, и «№»
 * оказывается ВНУТРИ значения. Сравнимая форма получается `ИС001`, тогда как
 * сам лист называет себя «№ 001», и ни одна ступень лестницы такую пару не
 * сводила — частичная требует четырёх символов от каждой стороны.
 */
describe('алиас номера после внутреннего «№»', () => {
  it('«ИС №001» находит документ с номером «001.»', () => {
    const result = matchRegistryRows(
      [row(1, 'ИС №001', 'Исполнительная схема обратной засыпки')],
      [doc('d1', '001.', 'Исполнительная схема')],
    );

    // Совпадение ТОЧНОЕ: хвостовая точка снята нормализацией, алиас совпал
    // целиком. Частичная ступень с её порогом длины здесь не участвует.
    expect(result.rows[0]).toMatchObject({
      matchState: 'matched',
      matchedDocumentId: 'd1',
      matchScore: 1,
    });
  });

  it('полная форма продолжает работать: алиас её не вытесняет', () => {
    const result = matchRegistryRows([row(1, 'ИС №001')], [doc('d1', 'ИС №001'), doc('d2', '002')]);

    expect(result.rows[0]).toMatchObject({ matchState: 'matched', matchedDocumentId: 'd1' });
  });

  it('коротким алиасом вхождение не зондируется', () => {
    // «001» входит подстрокой в половину номеров комплекта. Алиас разрешён
    // только на точной ступени и фолдинге; на частичной он выдавал бы
    // случайные пары за находки.
    const result = matchRegistryRows(
      [row(1, 'ИС №001')],
      [doc('d1', 'К14/ДК2-001/2024'), doc('d2', 'АБВ-0012')],
    );

    expect(result.rows[0]?.matchState).toBe('missing');
  });

  it('два документа под алиасом дают ambiguous, а не выбор наугад', () => {
    const result = matchRegistryRows([row(1, 'ИС №001')], [doc('d1', '001'), doc('d2', '001.')]);

    expect(result.rows[0]).toMatchObject({ matchState: 'ambiguous', matchedDocumentId: null });
  });
});

/**
 * S34: кандидат — состояние между «нашли» и «нет в комплекте».
 *
 * Когда номер не ответил, у строки два разных исхода, которые до сих пор
 * сливались в один: «документа нет» — вывод, «номер не прочитан, но похожий
 * документ лежит» — наблюдение. Кандидат не выбирает документ и не строит
 * ребро графа: иначе похожесть по виду молча стала бы основанием для правил
 * дат.
 */
describe('кандидаты строки реестра', () => {
  const SCHEME = 'Исполнительная схема обратной засыпки';

  it('вид, выведенный из наименования строки, даёт кандидата', () => {
    const result = matchRegistryRows(
      [row(1, 'ИС №002', SCHEME)],
      [doc('d1', '1383653.', 'Схема', { docTypeCode: 'exec_scheme' })],
    );

    expect(result.rows[0]).toMatchObject({
      matchState: 'candidate',
      // Документ НЕ выбран: состояние ничего не утверждает.
      matchedDocumentId: null,
      candidates: [{ documentId: 'd1', basis: 'doc_type' }],
    });
  });

  it('кандидат не объявляется лишним документом', () => {
    const result = matchRegistryRows(
      [row(1, 'ИС №002', SCHEME)],
      [doc('d1', '1383653.', 'Схема', { docTypeCode: 'exec_scheme' })],
    );

    expect(result.extraDocumentIds).toEqual([]);
  });

  it('документ, названный другой строкой, кандидатом не предлагается', () => {
    // Строка 8 нашла свою схему точным совпадением; предлагать её же строке 9
    // значит подсказывать проверяющему заведомо неверный ответ.
    const result = matchRegistryRows(
      [row(1, 'ИС №001', SCHEME), row(2, 'ИС №002', SCHEME)],
      [doc('d1', '001', 'Схема', { docTypeCode: 'exec_scheme' })],
    );

    expect(result.rows[0]?.matchState).toBe('matched');
    expect(result.rows[1]).toMatchObject({ matchState: 'missing', candidates: [] });
  });

  it('совпадение даты выдачи тоже делает документ кандидатом', () => {
    const result = matchRegistryRows(
      [{ ...row(1, 'НЕТ-ТАКОГО-НОМЕРА', 'Гвозди'), issuedAt: '2024-10-04' }],
      [doc('d1', 'ДРУГОЙ-НОМЕР', 'Паспорт', { issuedAt: '2024-10-04' })],
    );

    expect(result.rows[0]).toMatchObject({
      matchState: 'candidate',
      candidates: [{ documentId: 'd1', basis: 'issued_at' }],
    });
  });

  it('наименование материала вида не даёт и кандидата по виду не порождает', () => {
    // «Гвозди» и «Блок стеновой» — наименования МАТЕРИАЛА, а не документа.
    const result = matchRegistryRows(
      [row(1, 'НЕТ-ТАКОГО-НОМЕРА', 'Гвозди')],
      [doc('d1', 'ДРУГОЙ-НОМЕР', 'Паспорт', { docTypeCode: 'quality_passport' })],
    );

    expect(result.rows[0]?.matchState).toBe('missing');
  });
});

/**
 * S34: претенденты неоднозначной строки — тоже кандидаты.
 *
 * `match.ts` считал их названными с самого начала (`named` пополняется до
 * проверки числа), а правило REG.101 — нет, потому что список никуда не
 * сохранялся. Комплект получал и «строка сопоставлена неоднозначно», и
 * «документ не назван ни одной строкой» за один и тот же факт.
 */
describe('претенденты неоднозначной строки', () => {
  it('точный номер у двух документов записывает обоих в кандидаты', () => {
    const result = matchRegistryRows(
      [row(1, '№ 00БС-012814', 'Паспорт')],
      [doc('d1', '00БС-012814'), doc('d2', '00БС-012814')],
    );

    expect(result.rows[0]).toMatchObject({
      matchState: 'ambiguous',
      matchedDocumentId: null,
      candidates: [
        { documentId: 'd1', basis: 'doc_no', score: 1 },
        { documentId: 'd2', basis: 'doc_no', score: 1 },
      ],
    });
  });

  it('ни один претендент не объявляется лишним документом', () => {
    const result = matchRegistryRows(
      [row(1, '№ 00БС-012814', 'Паспорт')],
      [doc('d1', '00БС-012814'), doc('d2', '00БС-012814')],
    );

    expect(result.extraDocumentIds).toEqual([]);
  });

  it('однозначное совпадение кандидатов не заводит', () => {
    // Отрицательный контроль: список претендентов имеет смысл только там, где
    // выбрать нельзя. У `matched` документ назван прямо.
    const result = matchRegistryRows([row(1, '№ 16005')], [doc('d1', '16005')]);

    expect(result.rows[0]).toMatchObject({ matchState: 'matched', candidates: [] });
  });
});
