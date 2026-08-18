/**
 * Замер сегментации на эталонной разметке корпуса (§16).
 *
 * ## Зачем это тест, а не скрипт
 *
 * `evaluateLeaveOnePackageOut` и обезличенный эталон (`tools/fixtures/corpus`)
 * без вызывающего — это ровно тот отказ, которым закончился слой наблюдаемости
 * на S3: код написан, покрыт тестами и никогда не исполняется. Здесь у них
 * появляется единственный настоящий потребитель — сегментатор портала, тот же
 * `classifyPages` + `decodeSegmentation`, который исполняют задачи 14–15.
 *
 * ## Что здесь проверяется, а что просто измеряется
 *
 * ПРОВЕРЯЕТСЯ инвариант §1.6: на всех 142 реальных страницах каждая страница
 * оказывается ровно в одном документе либо в непривязанных. Это гейт, и он
 * падает при нарушении.
 *
 * ИЗМЕРЯЮТСЯ boundary recall и macro-F1 по типам. Порогами они не являются и
 * тестом не становятся: §0.5 прямо запрещает переносить метрики трёх комплектов
 * двух разделов на остальные разделы, а §16 разрешает считать их гейтом только
 * после того, как раздел наберёт собственную статистику. Превратить их здесь в
 * `expect(...).toBeGreaterThan(0.95)` значило бы зафиксировать как обещание то,
 * что план называет гипотезой, подлежащей измерению на пилоте.
 *
 * ## Почему тест пропускается без эталона
 *
 * Эталон коммитится (он обезличен), поэтому в норме тест исполняется всегда.
 * `skipIf` защищает единственный случай — рабочее дерево без сгенерированного
 * набора; молча проходить при пустом корпусе тест не имеет права, поэтому
 * непустота проверяется отдельным утверждением.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateLeaveOnePackageOut,
  formatCorpusMetrics,
  loadReferenceCorpus,
  type ReferencePackage,
  type SegmentationPrediction,
} from '@id/fixtures';

import { classifyPages } from './classify.js';
import { BOUNDARY_CONFIDENCE_CEILING, CONFIDENT_BOUNDARY, decodeSegmentation } from './decoder.js';
import type { PageInput } from './types.js';

const CORPUS: readonly ReferencePackage[] = loadReferenceCorpus();

/** Страница эталона → вход фазы 1. Ожидаемые метки сюда не попадают. */
function toPageInputs(pkg: ReferencePackage): readonly PageInput[] {
  return pkg.pages.map((page) => ({
    sourcePageId: `${pkg.packageKey}#${page.pageNo}`,
    revisionOrdinal: page.pageNo - 1,
    // Эталон не хранит разбиение по исходным файлам: комплект пришёл одним
    // PDF. Смена файла — слабый приор (§8.2), решения он не принимает, и его
    // отсутствие результат не меняет.
    sourceFileId: pkg.packageKey,
    filePageIndex: page.pageNo - 1,
    pageTextVersionId: null,
    text: page.text,
    blockTypes: page.blockTypes,
    rotation: page.rotation,
    manual: null,
  }));
}

/** Настоящий сегментатор портала целиком: фаза 1 плюс фаза 3. */
function segment(pkg: ReferencePackage): readonly SegmentationPrediction[] {
  const pages = toPageInputs(pkg);
  const classifications = classifyPages(pages);
  const result = decodeSegmentation(pages, classifications);

  const byPage = new Map<string, SegmentationPrediction>();
  for (const document of result.documents) {
    for (const page of document.pages) {
      const pageNo = Number(page.sourcePageId.split('#')[1]);
      const classification = classifications.find((c) => c.sourcePageId === page.sourcePageId);
      byPage.set(page.sourcePageId, {
        pageNo,
        label: classification?.label ?? 'U',
        docTypeCode: document.docTypeCode,
        documentKey: `doc-${document.ordinal}`,
        boundaryConfidence: document.boundaryConfidence ?? 0,
        needsReview: document.needsReview,
      });
    }
  }
  for (const page of result.unassigned) {
    const pageNo = Number(page.sourcePageId.split('#')[1]);
    const classification = classifications.find((c) => c.sourcePageId === page.sourcePageId);
    byPage.set(page.sourcePageId, {
      pageNo,
      label: classification?.label ?? 'U',
      docTypeCode: null,
      documentKey: null,
      boundaryConfidence: 0,
      needsReview: page.needsReview,
    });
  }

  return [...byPage.values()].sort((a, b) => a.pageNo - b.pageNo);
}

describe.skipIf(CORPUS.length === 0)('сегментация на эталонной разметке корпуса', () => {
  it('эталон загружен и непуст', () => {
    // Цикл по нулю комплектов «проверяет» что угодно — это ровно тот дефект,
    // который S7 нашёл у трёх собственных проверок секретов.
    expect(CORPUS.length).toBeGreaterThan(0);
    const pages = CORPUS.reduce((sum, pkg) => sum + pkg.pages.length, 0);
    expect(pages).toBeGreaterThan(100);
  });

  it.each(CORPUS.map((pkg) => [pkg.packageKey, pkg] as const))(
    'инвариант назначения страниц держится на комплекте %s',
    (_key, pkg) => {
      // НЕ ДЕГРАДИРУЕМЫЙ ГЕЙТ §1.6 на НАСТОЯЩИХ страницах, а не на фикстуре:
      // 142 страницы двух разделов со всеми их аномалиями OCR.
      const pages = toPageInputs(pkg);
      const result = decodeSegmentation(pages, classifyPages(pages));

      const seen = new Set<string>();
      for (const document of result.documents) {
        for (const page of document.pages) {
          expect(seen.has(page.sourcePageId), page.sourcePageId).toBe(false);
          seen.add(page.sourcePageId);
        }
      }
      for (const page of result.unassigned) {
        expect(seen.has(page.sourcePageId), page.sourcePageId).toBe(false);
        seen.add(page.sourcePageId);
      }

      expect(seen.size).toBe(pages.length);
    },
  );

  it('ни один документ не остался пустым', () => {
    for (const pkg of CORPUS) {
      const pages = toPageInputs(pkg);
      const result = decodeSegmentation(pages, classifyPages(pages));
      for (const document of result.documents) {
        expect(document.pages.length, `${pkg.packageKey}#${document.ordinal}`).toBeGreaterThan(0);
      }
    }
  });

  it('метрики leave-one-package-out считаются и выводятся числами', () => {
    // Порог тихой ошибки берётся из ШКАЛЫ САМОГО ДЕКОДЕРА, а не задаётся здесь
    // числом. Иначе замер и сегментатор живут по разным шкалам: так и вышло —
    // потолок фазы 2 был 0.8, порог замера 0.9, и ни одна ошибка модели не
    // могла быть засчитана тихой ни при какой её уверенности.
    const metrics = evaluateLeaveOnePackageOut(CORPUS, segment, {
      highConfidence: CONFIDENT_BOUNDARY,
    });

    expect(metrics.folds).toHaveLength(CORPUS.length);
    // Каждый фолд обязан быть посчитан по СВОЕМУ комплекту: страницы одного
    // комплекта не могут быть одновременно в калибровке и в оценке.
    expect(metrics.folds.map((fold) => fold.heldOutPackage).sort()).toEqual(
      CORPUS.map((pkg) => pkg.packageKey).sort(),
    );

    // Числа для доклада. Порогами они не являются (§0.5): три комплекта двух
    // разделов не дают оснований обещать что-либо на остальных разделах.
    // Формат живёт в `formatCorpusMetrics`, а не здесь: доклад, собираемый на
    // месте, показывает то число, которое пишущему удобнее.
    // eslint-disable-next-line no-console
    console.log(`\n${formatCorpusMetrics(metrics)}\n`);

    // Проверяется только осмысленность самих чисел, а не их величина.
    for (const value of [
      metrics.boundaryRecallMicro,
      metrics.boundaryRecallMacro,
      metrics.boundaryPrecisionMicro,
      metrics.macroF1Types,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Знаменатель обязан быть явным: доля без него непроверяема, а
    // «нашли 83% документов» при найденных 75% — это разница между двумя
    // способами усреднения, а не между двумя сегментаторами.
    expect(metrics.boundaryReference).toBeGreaterThan(0);
    expect(metrics.boundaryMatched).toBeLessThanOrEqual(metrics.boundaryReference);
    expect(metrics.boundaryRecallMicro).toBeCloseTo(
      metrics.boundaryMatched / metrics.boundaryReference,
      10,
    );
  });

  it('порог тихой ошибки достижим фазой 2: критерий §16 к ней применим', () => {
    // Прямая проверка согласования замера с сегментатором. При пороге выше
    // потолка фазы 2 счётчик тихих ошибок модели тождественно равен нулю — то
    // есть критерий, объявленный §16 более значимым, чем F1, не измеряет
    // ничего, и это невидимо: ноль читается как «ошибок нет».
    expect(CONFIDENT_BOUNDARY).toBeLessThanOrEqual(BOUNDARY_CONFIDENCE_CEILING.llm);
    expect(CONFIDENT_BOUNDARY).toBeLessThanOrEqual(BOUNDARY_CONFIDENCE_CEILING.anchor);
  });

  it('пропуски границ разложены по типам и веса типов посчитаны', () => {
    const metrics = evaluateLeaveOnePackageOut(CORPUS, segment, {
      highConfidence: CONFIDENT_BOUNDARY,
    });

    // Сумма пропусков по типам обязана сойтись с общим числом ненайденных
    // границ: разбивка, не сходящаяся с итогом, хуже её отсутствия.
    const missed = metrics.missedBoundaries.reduce((sum, item) => sum + item.missed, 0);
    expect(missed).toBe(metrics.boundaryReference - metrics.boundaryMatched);

    // Доли типов складываются в единицу — иначе «22% корпуса» ни о чём.
    if (metrics.types.length > 0) {
      expect(metrics.types.reduce((sum, type) => sum + type.share, 0)).toBeCloseTo(1, 10);
    }
  });
});
