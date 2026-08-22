/**
 * Тесты расчёта метрик leave-one-package-out.
 *
 * Проверяется САМ РАСЧЁТ на синтетических предсказаниях, а не его значение на
 * корпусе. Тест «boundary recall ≥ 95%» ловил бы не регресс сегментатора, а
 * наличие закрытого корпуса на машине; кроме того, §0.5 запрещает считать эти
 * числа гейтом за пределами двух разделов, из которых собран корпус.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateLeaveOnePackageOut,
  formatCorpusMetrics,
  type SegmentationPrediction,
} from './metrics.js';
import type { ReferenceExpectation, ReferencePackage } from './corpus-reference.js';

/** Собирает комплект из перечня документов: код типа и число страниц. */
function pkg(key: string, documents: readonly [string, number][]): ReferencePackage {
  const pages = [];
  let pageNo = 1;
  for (const [docTypeCode, count] of documents) {
    for (let i = 0; i < count; i += 1) {
      const expected: ReferenceExpectation = {
        label: i === 0 ? 'B-DOC' : 'I-DOC',
        docTypeCode: i === 0 ? docTypeCode : docTypeCode,
        typeOutcome: 'known',
        pageRoleCode: null,
        documentKey: `${key}-${docTypeCode}-${pageNo}`,
      };
      pages.push({
        pageNo,
        text: `страница ${pageNo}`,
        blockTypes: ['text'] as const,
        widthPx: 100,
        heightPx: 200,
        rotation: 0,
        expected,
      });
      pageNo += 1;
    }
  }
  return { packageKey: key, sectionCode: 'roofing', pages, expectedRegistryRowCount: null };
}

/** Идеальное предсказание: повторяет эталон. Требует НЕзаслеплённого доступа. */
function perfect(reference: readonly ReferencePackage[]) {
  const byKey = new Map(reference.map((p) => [p.packageKey, p]));
  return (blinded: ReferencePackage): readonly SegmentationPrediction[] => {
    const source = byKey.get(blinded.packageKey);
    return (source?.pages ?? []).map((page) => ({
      pageNo: page.pageNo,
      label: page.expected.label,
      docTypeCode: page.expected.docTypeCode,
      documentKey: page.expected.documentKey,
    }));
  };
}

const CORPUS: readonly ReferencePackage[] = [
  pkg('one', [
    ['aosr', 2],
    ['cert_conformity', 1],
    ['mill_certificate', 1],
  ]),
  pkg('two', [
    ['aosr', 2],
    ['cert_conformity', 1],
    ['mill_certificate', 2],
  ]),
  pkg('three', [
    ['aosr', 1],
    ['mill_certificate', 1],
    ['quality_passport', 2],
  ]),
];

describe('leave-one-package-out', () => {
  it('держит ровно один комплект за фолд и не показывает предсказателю ответы', () => {
    const seen: string[] = [];
    evaluateLeaveOnePackageOut(CORPUS, (input) => {
      seen.push(input.packageKey);
      // Заслепление: предсказателю нужны текст, геометрия и состав блоков, но
      // не эталонные метки. Иначе фолд измеряет умение читать ответы.
      for (const page of input.pages) {
        expect(page.expected.label).toBe('U');
        expect(page.expected.docTypeCode).toBeNull();
        expect(page.expected.documentKey).toBeNull();
      }
      expect(input.pages.every((page) => page.text.length > 0)).toBe(true);
      return [];
    });
    expect(seen).toEqual(['one', 'two', 'three']);
  });

  it('на идеальном предсказании даёт единицу и ни одной тихой ошибки', () => {
    const metrics = evaluateLeaveOnePackageOut(CORPUS, perfect(CORPUS));
    expect(metrics.boundaryRecallMicro).toBe(1);
    expect(metrics.boundaryRecallMacro).toBe(1);
    expect(metrics.boundaryMatched).toBe(metrics.boundaryReference);
    expect(metrics.missedBoundaries).toEqual([]);
    expect(metrics.phantomTypes).toEqual([]);
    expect(metrics.folds.map((fold) => fold.boundaryPrecision)).toEqual([1, 1, 1]);
    expect(metrics.macroF1Types).toBe(1);
    expect(metrics.silentHighConfidenceBoundaryErrors).toBe(0);
  });

  it('на пустом предсказании даёт нули, а не NaN', () => {
    const metrics = evaluateLeaveOnePackageOut(CORPUS, () => []);
    expect(metrics.boundaryRecallMicro).toBe(0);
    expect(metrics.boundaryRecallMacro).toBe(0);
    expect(metrics.macroF1Types).toBe(0);
    expect(Number.isNaN(metrics.boundaryRecallMicro)).toBe(false);
    for (const fold of metrics.folds) expect(fold.boundaryPrecision).toBe(0);
  });

  it('считает macro-F1 только по типам с support >= 3', () => {
    const metrics = evaluateLeaveOnePackageOut(CORPUS, perfect(CORPUS));
    // aosr — три документа, mill_certificate — четыре: они в macro-F1.
    // cert_conformity — два, quality_passport — один: они в rareTypes.
    expect(metrics.rareTypes).toEqual([
      { code: 'cert_conformity', support: 2 },
      { code: 'quality_passport', support: 1 },
    ]);
  });

  it('не пускает промах по редкому типу ни в числитель, ни в знаменатель', () => {
    // Тип с support = 2 не имеет права ни улучшить число, ни испортить его:
    // на двух документах F1 принимает всего несколько значений (§16).
    const broken = (blinded: ReferencePackage): readonly SegmentationPrediction[] =>
      perfect(CORPUS)(blinded).map((prediction) =>
        prediction.docTypeCode === 'cert_conformity'
          ? { ...prediction, docTypeCode: 'declaration' }
          : prediction,
      );
    const metrics = evaluateLeaveOnePackageOut(CORPUS, broken);
    expect(metrics.macroF1Types).toBe(1);
    expect(metrics.rareTypes.map((type) => type.code)).toContain('cert_conformity');
    // Ложный тип с нулевым support тоже редкий: он в списке ручной проверки.
    expect(metrics.rareTypes.map((type) => type.code)).not.toContain('declaration');
  });

  it('подмена типа даёт одновременно промах эталонного и ложное срабатывание', () => {
    const swapped = (blinded: ReferencePackage): readonly SegmentationPrediction[] =>
      perfect(CORPUS)(blinded).map((prediction) =>
        prediction.docTypeCode === 'aosr'
          ? { ...prediction, docTypeCode: 'mill_certificate' }
          : prediction,
      );
    const metrics = evaluateLeaveOnePackageOut(CORPUS, swapped);
    const counts = metrics.folds
      .flatMap((fold) => [...fold.perType])
      .reduce((acc, [code, value]) => {
        const entry = acc.get(code) ?? { tp: 0, fp: 0, fn: 0, support: 0 };
        acc.set(code, {
          tp: entry.tp + value.tp,
          fp: entry.fp + value.fp,
          fn: entry.fn + value.fn,
          support: entry.support + value.support,
        });
        return acc;
      }, new Map<string, { tp: number; fp: number; fn: number; support: number }>());
    expect(counts.get('aosr')).toEqual({ tp: 0, fp: 0, fn: 3, support: 3 });
    expect(counts.get('mill_certificate')).toEqual({ tp: 3, fp: 3, fn: 0, support: 3 });
    expect(metrics.macroF1Types).toBeLessThan(1);
    // Границы при этом найдены все: подмена типа их не трогает.
    expect(metrics.boundaryRecallMicro).toBe(1);
    expect(metrics.boundaryRecallMacro).toBe(1);
  });

  it('пропущенная граница снижает recall, лишняя — precision', () => {
    const metrics = evaluateLeaveOnePackageOut(CORPUS, (blinded) =>
      perfect(CORPUS)(blinded).map((prediction) =>
        prediction.pageNo === 1 ? { ...prediction, label: 'I-DOC' as const } : prediction,
      ),
    );
    expect(metrics.boundaryRecallMacro).toBeCloseTo((2 / 3 + 2 / 3 + 2 / 3) / 3, 10);
    expect(metrics.boundaryRecallMicro).toBeCloseTo(6 / 9, 10);
    expect(metrics.boundaryMatched).toBe(6);
    expect(metrics.boundaryReference).toBe(9);
    for (const fold of metrics.folds) expect(fold.boundaryPrecision).toBe(1);
  });

  it('молчаливая уверенная ошибка границы считается, а помеченная — нет', () => {
    const wrongPage = (blinded: ReferencePackage): readonly SegmentationPrediction[] =>
      perfect(CORPUS)(blinded).map((prediction) =>
        prediction.pageNo === 2 ? { ...prediction, label: 'B-DOC' as const } : prediction,
      );

    // Уверенность не сообщена вовсе — это и есть тихая ошибка (§16). Ошибок
    // две, а не три: в третьем комплекте страница 2 действительно начинает
    // документ, и «ошибочная» метка там совпала с эталоном.
    const silent = evaluateLeaveOnePackageOut(CORPUS, wrongPage);
    expect(silent.silentHighConfidenceBoundaryErrors).toBe(2);

    const flagged = evaluateLeaveOnePackageOut(CORPUS, (blinded) =>
      wrongPage(blinded).map((prediction) => ({ ...prediction, needsReview: true })),
    );
    expect(flagged.silentHighConfidenceBoundaryErrors).toBe(0);

    const unsure = evaluateLeaveOnePackageOut(CORPUS, (blinded) =>
      wrongPage(blinded).map((prediction) => ({ ...prediction, boundaryConfidence: 0.4 })),
    );
    expect(unsure.silentHighConfidenceBoundaryErrors).toBe(0);
  });

  it('на пустом наборе комплектов не делит на ноль', () => {
    const metrics = evaluateLeaveOnePackageOut([], () => []);
    expect(metrics.folds).toEqual([]);
    expect(metrics.boundaryRecallMicro).toBe(0);
    expect(metrics.boundaryRecallMacro).toBe(0);
    expect(metrics.macroF1Types).toBe(0);
    expect(metrics.rareTypes).toEqual([]);
    expect(metrics.types).toEqual([]);
  });

  /**
   * Комплекты корпуса разноразмерны, и способ усреднения меняет число на
   * величину, которая читается как разница между «нашли 83%» и «нашли 75%».
   * Здесь это воспроизведено нарочно: маленький комплект найден целиком,
   * большой — наполовину.
   */
  it('микро и макро расходятся на разноразмерных комплектах и оба выводятся', () => {
    const uneven: readonly ReferencePackage[] = [
      pkg('small', [['aosr', 1]]),
      pkg('large', [
        ['aosr', 1],
        ['cert_conformity', 1],
        ['mill_certificate', 1],
        ['quality_passport', 1],
      ]),
    ];

    // Большой комплект: найдена только первая граница из четырёх.
    const metrics = evaluateLeaveOnePackageOut(uneven, (blinded) =>
      perfect(uneven)(blinded).map((prediction) =>
        blinded.packageKey === 'large' && prediction.pageNo > 1
          ? { ...prediction, label: 'I-DOC' as const }
          : prediction,
      ),
    );

    // Макро: (1 + 0.25) / 2 = 0.625. Микро: 2 из 5 = 0.4. Разница в полтора
    // раза, и «один процент качества» здесь — это выбор способа усреднения.
    expect(metrics.boundaryRecallMacro).toBeCloseTo(0.625, 10);
    expect(metrics.boundaryRecallMicro).toBeCloseTo(2 / 5, 10);
    expect(metrics.boundaryMatched).toBe(2);
    expect(metrics.boundaryReference).toBe(5);

    // Оба числа обязаны быть в отчёте вместе со знаменателем.
    const report = formatCorpusMetrics(metrics);
    expect(report).toContain('микро');
    expect(report).toContain('макро');
    expect(report).toContain('2/5');
  });

  it('пропуски границ разложены по типам, а не сведены в одно число', () => {
    // Пятнадцать пропусков одного класса и пятнадцать разрозненных дают
    // одинаковый recall и требуют разной работы: якорь против калибровки.
    const metrics = evaluateLeaveOnePackageOut(CORPUS, (blinded) =>
      perfect(CORPUS)(blinded).map((prediction) =>
        prediction.docTypeCode === 'mill_certificate' && prediction.label === 'B-DOC'
          ? { ...prediction, label: 'I-DOC' as const }
          : prediction,
      ),
    );

    expect(metrics.missedBoundaries).toEqual([{ code: 'mill_certificate', missed: 3, support: 3 }]);
    expect(formatCorpusMetrics(metrics)).toContain('mill_certificate: 3/3');
  });

  it('выдуманный тип виден в отчёте, хотя в macro-F1 его нет по построению', () => {
    // Тип, которого в эталоне нет вовсе: support = 0, значит в F1 он не входит
    // (§16), и в список редких прежде тоже не попадал. То есть систематическая
    // галлюцинация не отражалась НИ ОДНИМ числом отчёта.
    const metrics = evaluateLeaveOnePackageOut(CORPUS, (blinded) =>
      perfect(CORPUS)(blinded).map((prediction) =>
        prediction.docTypeCode === 'aosr'
          ? { ...prediction, docTypeCode: 'lab_protocol_generic' }
          : prediction,
      ),
    );

    expect(metrics.phantomTypes).toEqual([{ code: 'lab_protocol_generic', fp: 3 }]);
    expect(metrics.rareTypes.map((type) => type.code)).not.toContain('lab_protocol_generic');
    expect(metrics.types.find((type) => type.code === 'lab_protocol_generic')).toMatchObject({
      support: 0,
      fp: 3,
      countedInMacroF1: false,
    });
    expect(formatCorpusMetrics(metrics)).toContain('ВЫДУМАННЫЕ типы');
  });

  it('вес типа в корпусе выводится рядом с его F1', () => {
    // `mill_certificate` — три документа из девяти. В макро-среднем по
    // типам он весит 1/N независимо от этого, и без доли число F1 читается
    // как средневзвешенное, которым не является.
    const metrics = evaluateLeaveOnePackageOut(CORPUS, perfect(CORPUS));
    const total = metrics.types.reduce((sum, type) => sum + type.support, 0);
    expect(total).toBe(9);
    expect(metrics.types.find((type) => type.code === 'mill_certificate')?.share).toBeCloseTo(
      3 / 9,
      10,
    );
    expect(metrics.types.reduce((sum, type) => sum + type.share, 0)).toBeCloseTo(1, 10);
  });

  it('порог уверенности и минимальный support настраиваются', () => {
    const metrics = evaluateLeaveOnePackageOut(CORPUS, perfect(CORPUS), { minSupport: 1 });
    // При minSupport = 1 редких типов нет вовсе, все идут в macro-F1.
    expect(metrics.rareTypes).toEqual([]);
    expect(metrics.macroF1Types).toBe(1);
  });
});
