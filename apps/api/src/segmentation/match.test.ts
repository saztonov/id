/**
 * Сверка реестра приложений с документами комплекта (§8.3).
 *
 * Номера синтетические. Форма номера декларации взята из §8.3 плана как
 * эталон фолдинга: реквизитом участника она не является и в списке маркеров
 * `pii:scan` не состоит.
 */

import { describe, expect, it } from 'vitest';
import { matchRegistryRows, type MatchableDocument } from './match.js';
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
): MatchableDocument {
  return { documentId, docTypeCode: null, number, title };
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
          number: '16005',
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
});
