/**
 * Нарезка папки на комплекты (S44).
 *
 * Проверяется ровно то, ради чего правило заведено: граница комплекта — акт, а
 * не файл и не страница. Числа в наборах взяты с боевой папки «ИД Мастер
 * апрель 2026» (220 страниц, 134 документа, 12 актов): регулярный блок там —
 * «АОСР → перечень приложений → приложения → исполнительная схема».
 */
import { describe, expect, it } from 'vitest';

import { planComplects } from './complects.js';

/** Документ в порядке обхода: нарезке нужны только вид и порядковый номер. */
function doc(
  ordinal: number,
  docTypeCode: string | null,
): { ordinal: number; docTypeCode: string | null } {
  return { ordinal, docTypeCode };
}

/** Регулярный блок папки: акт, его перечень, два приложения и схема. */
function block(start: number): { ordinal: number; docTypeCode: string | null }[] {
  return [
    doc(start, 'aosr'),
    doc(start + 1, 'annex_registry'),
    doc(start + 2, 'quality_passport'),
    doc(start + 3, 'cert_conformity'),
    doc(start + 4, 'exec_scheme'),
  ];
}

describe('planComplects', () => {
  it('акт открывает комплект, всё до следующего акта — его содержимое', () => {
    const plan = planComplects([...block(1), ...block(6)]);

    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0]?.documentOrdinals).toEqual([1, 2, 3, 4, 5]);
    expect(plan.groups[1]?.documentOrdinals).toEqual([6, 7, 8, 9, 10]);
    expect(plan.outside).toEqual([]);
  });

  it('опись и титулы до первого акта комплекту не принадлежат', () => {
    // Боевая папка начинается описью передачи на двух страницах: она не
    // приложение ни к одному акту, и приписать её первому попавшемуся значило
    // бы соврать о составе.
    const plan = planComplects([doc(1, 'transfer_registry'), doc(2, null), ...block(3)]);

    expect(plan.outside).toEqual([1, 2]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.documentOrdinals).toEqual([3, 4, 5, 6, 7]);
  });

  it('папка без актов остаётся папкой без комплектов', () => {
    // Так выглядит отдельно загруженная опись передачи. Это законное
    // состояние: проверки идут по папке, как и до нарезки.
    const plan = planComplects([doc(1, 'transfer_registry'), doc(2, 'quality_passport')]);

    expect(plan.groups).toEqual([]);
    expect(plan.outside).toEqual([1, 2]);
  });

  it('акт без приложений — комплект из одного документа', () => {
    const plan = planComplects([doc(1, 'aosr'), doc(2, 'aosr')]);

    expect(plan.groups.map((group) => group.documentOrdinals)).toEqual([[1], [2]]);
  });

  it('порядок задают номера, а не порядок массива', () => {
    // Вызывающий собирает список как ему удобно; полагаться на его порядок
    // значило бы зависеть от того, чего он не обещал.
    const plan = planComplects([
      doc(3, 'quality_passport'),
      doc(1, 'aosr'),
      doc(2, 'annex_registry'),
    ]);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.documentOrdinals).toEqual([1, 2, 3]);
  });

  it('семейство АОСР целиком открывает комплект, а не один код', () => {
    // `isAnalysisAnchor` — предикат каталога: акты сетей и конструкций тоже
    // якоря. Своего списка кодов здесь нет намеренно, иначе он разошёлся бы
    // с каталогом при первом же добавлении вида.
    const plan = planComplects([doc(1, 'aosr_networks'), doc(2, 'quality_passport')]);

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.documentOrdinals).toEqual([1, 2]);
  });
});
