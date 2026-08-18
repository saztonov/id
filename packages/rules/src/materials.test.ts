/**
 * Тесты вывода материалов и партий (§3.6, §9.1).
 *
 * Узлы «материал» и «партия» — единственная часть графа, которую не строит ни
 * одна предыдущая задача конвейера. Ошибка здесь не даёт ложного замечания
 * напрямую, она делает хуже: правила `MAT.*` и `DATE.312`/`DATE.372` перестают
 * находить дефекты, оставаясь зелёными, потому что проверять оказывается нечего.
 * Поэтому тесты смотрят на состав узлов, а не на «функция вернула массив».
 */
import { MATERIAL_CATEGORIES } from '@id/contracts';
import { describe, expect, it } from 'vitest';

import {
  CATEGORIES_WITHOUT_HINT,
  categoryOfProduct,
  deriveMaterials,
  normalizeMaterialName,
} from './materials.js';
import { makeDocument } from './testing.js';
import type { DocumentNode, FieldNode } from './types.js';

function value(fieldCode: string, patch: Partial<FieldNode> = {}): FieldNode {
  return {
    id: `f-${fieldCode}-${String(Math.random()).slice(2, 8)}`,
    fieldCode,
    valueText: null,
    valueDate: null,
    valueNum: null,
    valueJson: null,
    confidence: 0.9,
    isVerified: false,
    extractedBy: 'rule',
    pageTextVersionId: 'ptv-1',
    charSpan: { start: 0, end: 5 },
    quote: 'цитата',
    sourcePageId: 'page-1',
    blockType: 'text',
    blockId: 'block-1',
    ...patch,
  };
}

let counter = 0;
const ids = {
  materialId: (): string => `mat-${String((counter += 1))}`,
  batchId: (materialId: string): string => `${materialId}-batch-${String((counter += 1))}`,
};

function qualityDoc(
  code: string,
  fields: readonly FieldNode[],
  patch: Partial<DocumentNode> = {},
): DocumentNode {
  return makeDocument({ docTypeCode: code, fields: [...fields], ...patch });
}

describe('categoryOfProduct', () => {
  it('сетка выигрывает у арматуры — порядок подсказок значим', () => {
    // Сварная сетка, попавшая в арматурный прокат, получила бы требования
    // матрицы к прокату, которых у неё быть не может.
    expect(categoryOfProduct('Сетка сварная 100х100х4')).toBe('welded_mesh');
    expect(categoryOfProduct('Арматура А500С ⌀12')).toBe('rebar');
  });

  it('узнаёт категории двух разделов корпуса', () => {
    expect(categoryOfProduct('Гидроизоляция рулонная наплавляемая')).toBe('roll_waterproofing');
    expect(categoryOfProduct('Смесь бетонная тяжёлая В25')).toBe('ready_mix_concrete');
    expect(categoryOfProduct('Плиты минераловатные')).toBe('thermal_insulation');
    expect(categoryOfProduct('Дюбель тарельчатый')).toBe('fasteners');
  });

  it('незнакомая продукция даёт null, а не случайную категорию', () => {
    // Открытый мир: категория, определённая наугад, дала бы неверные требования
    // матрицы, то есть ложную ошибку на новом разделе.
    expect(categoryOfProduct('Комплект уплотнительных элементов ТУ 1234')).toBeNull();
    expect(categoryOfProduct(null)).toBeNull();
  });

  it('таблица подсказок описывает не все категории — и это объявлено вслух', () => {
    // Список категорий закрыт, а подсказки — эмпирика двух разделов. Разрыв
    // обязан быть виден, а не притворяться полнотой.
    expect(CATEGORIES_WITHOUT_HINT.every((code) => MATERIAL_CATEGORIES.includes(code))).toBe(true);
  });
});

describe('deriveMaterials', () => {
  it('собирает один материал из трёх документов о качестве', () => {
    // Три узла вместо одного разорвали бы связь «изготовитель партии покрыт
    // сертификатом» ровно там, где она проверяется (дефект №2 корпуса).
    const passport = qualityDoc('quality_passport', [
      value('product_name', { valueText: 'Гидроизоляция рулонная наплавляемая' }),
    ]);
    const certificate = qualityDoc('cert_conformity', [
      value('product_name', { valueText: 'Гидроизоляция  рулонная наплавляемая ' }),
    ]);
    const declaration = qualityDoc('declaration', [
      value('product_name', { valueText: 'Гидроизоляция рулонная наплавляемая' }),
    ]);

    const materials = deriveMaterials([passport, certificate, declaration], ids);

    expect(materials).toHaveLength(1);
    expect(materials[0]?.documentIds).toEqual([passport.id, certificate.id, declaration.id]);
    expect(materials[0]?.categoryCode).toBe('roll_waterproofing');
  });

  it('партия ключуется парой «номер партии + номер плавки»', () => {
    // У арматуры значим номер плавки, у рулонной гидроизоляции — номер партии.
    // Требовать оба значило бы терять партии половины видов продукции.
    const mill = qualityDoc('mill_certificate', [
      value('product_name', { valueText: 'Арматура А500С' }),
      value('heat_no', { valueText: '77123' }),
      value('manufactured_at', { valueDate: '2026-01-09' }),
    ]);
    const roll = qualityDoc('quality_passport', [
      value('product_name', { valueText: 'Гидроизоляция рулонная' }),
      value('batch_no', { valueText: 'П-15' }),
    ]);

    const materials = deriveMaterials([mill, roll], ids);

    const rebar = materials.find((material) => material.categoryCode === 'rebar');
    expect(rebar?.batches).toHaveLength(1);
    expect(rebar?.batches[0]).toMatchObject({ heatNo: '77123', manufacturedAt: '2026-01-09' });

    const waterproofing = materials.find(
      (material) => material.categoryCode === 'roll_waterproofing',
    );
    expect(waterproofing?.batches[0]).toMatchObject({ batchNo: 'П-15', manufacturedAt: null });
  });

  it('акт материалом не становится', () => {
    // Акт называет РАБОТЫ, а не продукцию. Материал «Устройство гидроизоляции»
    // не имел бы ни одного документа подтверждения и дал бы ложное замечание.
    const act = makeDocument({
      docTypeCode: 'aosr',
      fields: [value('product_name', { valueText: 'Устройство гидроизоляции' })],
    });

    expect(deriveMaterials([act], ids)).toEqual([]);
  });

  it('документ резервного типа материалом не становится', () => {
    const fallback = qualityDoc(
      'other_quality_docs',
      [value('product_name', { valueText: 'Кран шаровой Ду50' })],
      { isKnownType: false, isFallbackType: true },
    );

    expect(deriveMaterials([fallback], ids)).toEqual([]);
  });

  it('документ без наименования продукции пропускается', () => {
    const nameless = qualityDoc('cert_conformity', [value('number', { valueText: 'C-1' })]);
    expect(deriveMaterials([nameless], ids)).toEqual([]);
  });

  it('проверенное вручную значение приоритетнее распознанного', () => {
    const document = qualityDoc('quality_passport', [
      value('product_name', {
        valueText: 'Арматура А500С',
        isVerified: true,
        extractedBy: 'manual',
      }),
      value('product_name', { valueText: 'Ap мaтуpa А500С' }),
    ]);

    expect(deriveMaterials([document], ids)[0]?.nameRaw).toBe('Арматура А500С');
  });

  it('наименование из списка берётся первым элементом', () => {
    const document = qualityDoc('mill_certificate', [
      value('product_name', { valueJson: ['Арматура А500С', 'прокат'] }),
    ]);

    expect(deriveMaterials([document], ids)[0]?.nameRaw).toBe('Арматура А500С');
  });
});

describe('normalizeMaterialName', () => {
  it('снимает кавычки, схлопывает пробелы и сворачивает гомоглифы', () => {
    // Свёртка делает значение нечитаемым, и это осознанно: ключ группировки
    // обязан совпадать у одного материала, набранного OCR в трёх документах
    // тремя способами. Для показа человеку есть `nameRaw`.
    expect(normalizeMaterialName('  «Арматура»   А500С ')).toBe('APMATUPA A500C');
  });

  it('два написания одного наименования дают ОДИН материал', () => {
    const cyrillic = qualityDoc('quality_passport', [
      value('product_name', { valueText: 'Арматура А500С' }),
    ]);
    const mixed = qualityDoc('cert_conformity', [
      // Латинские A, P, C вместо кириллических — типовой результат OCR.
      value('product_name', { valueText: 'Apмaтуpa A500C' }),
    ]);

    expect(deriveMaterials([cyrillic, mixed], ids)).toHaveLength(1);
  });
});
