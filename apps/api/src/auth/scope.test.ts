/**
 * Область видимости: чистые функции (§4.1). Non-degradable гейт §1.6.
 *
 * Каждый вид области проверяется парой «разрешено — запрещено»: набор, знающий
 * только про разрешённые строки, пропускает функцию, которая всегда возвращает
 * `true`, а это ровно тот дефект, который открывает доступ ко всему.
 *
 * Две ловушки проверяются отдельно, потому что на однородной фикстуре обе дают
 * зелёный прогон. Первая — инженер с пустым списком объектов: у него нет ни
 * одной разрешённой строки, и «нет ограничения» здесь неотличимо от «ограничение
 * выполнено», если не потребовать явного отказа. Вторая — путаница полей:
 * область, сравнивающая `contractor_id` со списком объектов, ведёт себя
 * правильно до тех пор, пока в данных нет строки, где эти значения перекрещены.
 */
import { describe, expect, it } from 'vitest';

import { allowsRow, isEmptyScope, isUnrestricted, type AuthScope } from './scope.js';

const USER = '00000000-0000-4000-8000-000000000001';
const OBJECT_A = '00000000-0000-4000-8000-0000000000a1';
const OBJECT_B = '00000000-0000-4000-8000-0000000000b1';
const CONTRACTOR_A = '00000000-0000-4000-8000-0000000000a2';
const CONTRACTOR_B = '00000000-0000-4000-8000-0000000000b2';

interface ScopedRow {
  readonly objectId: string;
  readonly contractorId: string;
}

const ROW_OBJECT_A_CONTRACTOR_A: ScopedRow = { objectId: OBJECT_A, contractorId: CONTRACTOR_A };
const ROW_OBJECT_A_CONTRACTOR_B: ScopedRow = { objectId: OBJECT_A, contractorId: CONTRACTOR_B };
const ROW_OBJECT_B_CONTRACTOR_A: ScopedRow = { objectId: OBJECT_B, contractorId: CONTRACTOR_A };
const ROW_OBJECT_B_CONTRACTOR_B: ScopedRow = { objectId: OBJECT_B, contractorId: CONTRACTOR_B };

/** Полная матрица: два объекта на двух подрядчиков. */
const ALL_ROWS: readonly ScopedRow[] = [
  ROW_OBJECT_A_CONTRACTOR_A,
  ROW_OBJECT_A_CONTRACTOR_B,
  ROW_OBJECT_B_CONTRACTOR_A,
  ROW_OBJECT_B_CONTRACTOR_B,
];

const CONTRACTOR_SCOPE: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: CONTRACTOR_A,
};
const ENGINEER_SCOPE: AuthScope = { kind: 'engineer', userId: USER, objectIds: [OBJECT_A] };
const ENGINEER_WITHOUT_OBJECTS: AuthScope = { kind: 'engineer', userId: USER, objectIds: [] };
const MANAGER_SCOPE: AuthScope = { kind: 'manager', userId: USER };
const ADMIN_SCOPE: AuthScope = { kind: 'admin', userId: USER };

function allowed(scope: AuthScope): readonly ScopedRow[] {
  return ALL_ROWS.filter((row) => allowsRow(scope, row));
}

describe('allowsRow: подрядчик', () => {
  it('видит свои строки на любом объекте', () => {
    expect(allowsRow(CONTRACTOR_SCOPE, ROW_OBJECT_A_CONTRACTOR_A)).toBe(true);
    expect(allowsRow(CONTRACTOR_SCOPE, ROW_OBJECT_B_CONTRACTOR_A)).toBe(true);
  });

  it('не видит строку другого подрядчика на том же объекте', () => {
    expect(allowsRow(CONTRACTOR_SCOPE, ROW_OBJECT_A_CONTRACTOR_B)).toBe(false);
  });

  it('не видит строку другого подрядчика на другом объекте', () => {
    expect(allowsRow(CONTRACTOR_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(false);
  });

  it('не путает подрядчика с объектом', () => {
    // Строка, у которой object_id равен разрешённому contractor_id: проверка,
    // сравнивающая не то поле, на такой строке ответит «разрешено».
    expect(
      allowsRow(CONTRACTOR_SCOPE, { objectId: CONTRACTOR_A, contractorId: CONTRACTOR_B }),
    ).toBe(false);
  });

  it('ограничен ровно своими строками', () => {
    expect(allowed(CONTRACTOR_SCOPE)).toEqual([
      ROW_OBJECT_A_CONTRACTOR_A,
      ROW_OBJECT_B_CONTRACTOR_A,
    ]);
  });
});

describe('allowsRow: инженер', () => {
  it('видит любого подрядчика на назначенном объекте', () => {
    expect(allowsRow(ENGINEER_SCOPE, ROW_OBJECT_A_CONTRACTOR_A)).toBe(true);
    expect(allowsRow(ENGINEER_SCOPE, ROW_OBJECT_A_CONTRACTOR_B)).toBe(true);
  });

  it('не видит строку объекта вне своего списка', () => {
    expect(allowsRow(ENGINEER_SCOPE, ROW_OBJECT_B_CONTRACTOR_A)).toBe(false);
    expect(allowsRow(ENGINEER_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(false);
  });

  it('видит все назначенные объекты и только их', () => {
    const both: AuthScope = { kind: 'engineer', userId: USER, objectIds: [OBJECT_A, OBJECT_B] };
    expect(allowed(both)).toEqual(ALL_ROWS);

    const other: AuthScope = {
      kind: 'engineer',
      userId: USER,
      objectIds: ['00000000-0000-4000-8000-0000000000c1'],
    };
    expect(allowed(other)).toEqual([]);
  });

  it('не путает объект с подрядчиком', () => {
    const scope: AuthScope = { kind: 'engineer', userId: USER, objectIds: [CONTRACTOR_A] };
    expect(allowsRow(scope, { objectId: OBJECT_B, contractorId: CONTRACTOR_A })).toBe(false);
  });

  it('ограничен ровно своим объектом', () => {
    expect(allowed(ENGINEER_SCOPE)).toEqual([ROW_OBJECT_A_CONTRACTOR_A, ROW_OBJECT_A_CONTRACTOR_B]);
  });
});

describe('allowsRow: инженер с пустым списком объектов', () => {
  it.each(ALL_ROWS)('не видит строку %o', (row) => {
    expect(allowsRow(ENGINEER_WITHOUT_OBJECTS, row)).toBe(false);
  });

  it('не видит ничего, а не всё', () => {
    // Главная ловушка изоляции: пустой список объектов не является отсутствием
    // ограничения. Проверка сравнением с ALL_ROWS, а не только с длиной, —
    // чтобы падение показывало, что именно просочилось.
    expect(allowed(ENGINEER_WITHOUT_OBJECTS)).toEqual([]);
    expect(allowed(ENGINEER_WITHOUT_OBJECTS)).not.toEqual(ALL_ROWS);
  });
});

describe('allowsRow: руководитель и администратор', () => {
  it.each([
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('%s видит все строки', (_kind, scope) => {
    expect(allowed(scope)).toEqual(ALL_ROWS);
  });

  it('видят строку подрядчика, к которому не привязаны', () => {
    // У этих областей нет ни contractorId, ни objectIds: доступ к данным ИД у
    // них не ограничен, а разграничение действий делает permission на роуте.
    expect(allowsRow(MANAGER_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(true);
    expect(allowsRow(ADMIN_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(true);
  });
});

describe('isEmptyScope', () => {
  it('истинно только для инженера без объектов', () => {
    expect(isEmptyScope(ENGINEER_WITHOUT_OBJECTS)).toBe(true);
  });

  it.each([
    ['contractor', CONTRACTOR_SCOPE],
    ['engineer с объектом', ENGINEER_SCOPE],
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('ложно для %s', (_kind, scope) => {
    expect(isEmptyScope(scope)).toBe(false);
  });
});

describe('isUnrestricted', () => {
  it.each([
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('%s не ограничен', (_kind, scope) => {
    expect(isUnrestricted(scope)).toBe(true);
  });

  it.each([
    ['contractor', CONTRACTOR_SCOPE],
    ['engineer с объектом', ENGINEER_SCOPE],
    ['engineer без объектов', ENGINEER_WITHOUT_OBJECTS],
  ] as const)('%s ограничен', (_kind, scope) => {
    expect(isUnrestricted(scope)).toBe(false);
  });
});
