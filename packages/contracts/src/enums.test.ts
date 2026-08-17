/**
 * Контрольные проверки доменных схем.
 *
 * Проверяются не «схема принимает корректное значение», а именно те границы,
 * из-за нарушения которых система тихо портит данные: вырожденная рамка
 * блока, чужой код объекта, реквизиты неверной длины.
 */

import { describe, expect, it } from 'vitest';

import {
  constructionObjectSchema,
  innSchema,
  kppSchema,
  layoutBlockSchema,
  normalizedCoordsSchema,
  objectCodeSchema,
  ogrnSchema,
} from './domain.js';
import {
  blockTypeSchema,
  findingOriginSchema,
  severitySchema,
  signatureProbeResultSchema,
  userRoleSchema,
} from './enums.js';

const validCoords = { x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.9 };

describe('normalizedCoordsSchema', () => {
  it('принимает корректную рамку и вырожденную в линию', () => {
    expect(normalizedCoordsSchema.safeParse(validCoords).success).toBe(true);
    expect(normalizedCoordsSchema.safeParse({ x0: 0, y0: 0, x1: 0, y1: 1 }).success).toBe(true);
    expect(normalizedCoordsSchema.safeParse({ x0: 0, y0: 0, x1: 1, y1: 1 }).success).toBe(true);
  });

  it('отбраковывает x0 > x1 и указывает виновное поле', () => {
    const result = normalizedCoordsSchema.safeParse({ ...validCoords, x0: 0.9, x1: 0.1 });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('x1');
  });

  it('отбраковывает y0 > y1', () => {
    const result = normalizedCoordsSchema.safeParse({ ...validCoords, y0: 0.9, y1: 0.1 });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('y1');
  });

  it('отбраковывает координаты вне диапазона 0..1', () => {
    expect(normalizedCoordsSchema.safeParse({ ...validCoords, x0: -0.001 }).success).toBe(false);
    expect(normalizedCoordsSchema.safeParse({ ...validCoords, y0: -1 }).success).toBe(false);
    expect(normalizedCoordsSchema.safeParse({ ...validCoords, x1: 1.0001 }).success).toBe(false);
    expect(normalizedCoordsSchema.safeParse({ ...validCoords, y1: 2 }).success).toBe(false);
  });

  it('отбраковывает NaN и Infinity: такая рамка прошла бы сравнения границ', () => {
    expect(normalizedCoordsSchema.safeParse({ ...validCoords, x0: Number.NaN }).success).toBe(
      false,
    );
    expect(
      normalizedCoordsSchema.safeParse({ ...validCoords, x1: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });
});

describe('layoutBlockSchema', () => {
  const block = {
    id: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    layoutRevisionId: '11111111-2222-4333-8444-555555555555',
    sourcePageId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    workingPageIndex: 0,
    objectId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    blockType: 'text',
    shapeType: 'rectangle',
    coords: validCoords,
    points: [],
    sortOrder: 0,
    source: 'auto',
    detectorProvenance: 'rf_detr',
  };

  it('принимает прямоугольный блок без точек полигона', () => {
    expect(layoutBlockSchema.safeParse(block).success).toBe(true);
  });

  it('переносит инвариант координат внутрь блока', () => {
    const broken = { ...block, coords: { x0: 0.9, y0: 0.1, x1: 0.2, y1: 0.8 } };

    expect(layoutBlockSchema.safeParse(broken).success).toBe(false);
  });

  it('требует у полигона не менее трёх точек', () => {
    const twoPoints = {
      ...block,
      shapeType: 'polygon',
      points: [
        { pointNo: 0, x: 0.1, y: 0.1 },
        { pointNo: 1, x: 0.2, y: 0.2 },
      ],
    };

    expect(layoutBlockSchema.safeParse(twoPoints).success).toBe(false);
    expect(
      layoutBlockSchema.safeParse({
        ...twoPoints,
        points: [...twoPoints.points, { pointNo: 2, x: 0.3, y: 0.1 }],
      }).success,
    ).toBe(true);
  });
});

describe('objectCodeSchema', () => {
  it('принимает ровно пять латинских букв или цифр', () => {
    for (const code of ['A1B2C', '00000', 'zzzzz', 'Ab3Cd']) {
      expect(objectCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it('отбраковывает любую длину, кроме пяти', () => {
    for (const code of ['', 'A1B2', 'A1B2C3', 'A1B2C ']) {
      expect(objectCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it('отбраковывает кириллицу и разделители: код уезжает в ключи и шаблоны', () => {
    for (const code of ['АБВГД', 'A1-B2', 'A1B2_', 'A1B2\n']) {
      expect(objectCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it('применяется внутри карточки объекта', () => {
    const object = {
      id: '12345678-1234-4234-8234-123456789abc',
      code: 'A1B2C',
      name: 'ЖК Пример',
      fullName: 'Жилой комплекс «Пример», корпус 1',
      address: null,
      isActive: true,
      developerId: null,
      techCustomerId: null,
      generalContractorId: null,
      actNumberPattern: null,
    };

    expect(constructionObjectSchema.safeParse(object).success).toBe(true);
    expect(constructionObjectSchema.safeParse({ ...object, code: 'A1B2' }).success).toBe(false);
  });
});

describe('реквизиты организаций', () => {
  it('ИНН: 10 и 12 цифр проходят, 11 — нет', () => {
    expect(innSchema.safeParse('7701234567').success).toBe(true);
    expect(innSchema.safeParse('770123456789').success).toBe(true);
    expect(innSchema.safeParse('77012345678').success).toBe(false);
  });

  it('ИНН: девять и тринадцать цифр, буквы и пробелы отбраковываются', () => {
    for (const inn of ['770123456', '7701234567890', '77012З4567', ' 7701234567']) {
      expect(innSchema.safeParse(inn).success).toBe(false);
    }
  });

  it('КПП — ровно 9 цифр', () => {
    expect(kppSchema.safeParse('770101001').success).toBe(true);
    expect(kppSchema.safeParse('77010100').success).toBe(false);
    expect(kppSchema.safeParse('7701010012').success).toBe(false);
  });

  it('ОГРН: 13 и 15 цифр проходят, 12 — нет', () => {
    expect(ogrnSchema.safeParse('1027700132195').success).toBe(true);
    expect(ogrnSchema.safeParse('304500116000157').success).toBe(true);
    // Ровно этот дефект найден в корпусе: схема справочника его не пропускает,
    // а такое же значение, извлечённое из документа, обязано доехать до правил.
    expect(ogrnSchema.safeParse('102770013219').success).toBe(false);
  });
});

describe('перечисления', () => {
  it('отбраковывают значение вне списка', () => {
    expect(userRoleSchema.safeParse('contractor').success).toBe(true);
    expect(userRoleSchema.safeParse('superadmin').success).toBe(false);
    expect(blockTypeSchema.safeParse('table').success).toBe(false);
    expect(severitySchema.safeParse('critical').success).toBe(false);
  });

  it('сохраняют состояния, которые нельзя схлопывать', () => {
    // Троичность зондирования подписи и отдельный `external_unavailable`
    // — не украшение: их потеря превращает «не смогли проверить» в вывод.
    expect(signatureProbeResultSchema.options).toContain('unknown');
    expect(signatureProbeResultSchema.options).toContain('detected_unverified');
    expect(findingOriginSchema.options).toContain('external_unavailable');
  });
});
