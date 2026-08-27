/**
 * Область видимости: чистые функции (§4.1). Non-degradable гейт §1.6.
 *
 * Каждый вид области проверяется парой «разрешено — запрещено»: набор, знающий
 * только про разрешённые строки, пропускает функцию, которая всегда возвращает
 * `true`, а это ровно тот дефект, который открывает доступ ко всему.
 *
 * ## Что изменилось в S37
 *
 * Областей по объектам не осталось: заказчик снял деление стройки на
 * «назначенные» и «прочие» объекты. Утверждения про инженера здесь не удалены, а
 * перевёрнуты — теперь они сторожат, что он видит стройку целиком, и падают,
 * если ограничение вернётся молча.
 *
 * Ловушка «путаница полей» осталась и стала важнее прежнего: единственная
 * оставшаяся граница сравнивает `contractor_id`, и область, читающая вместо неё
 * `object_id`, ведёт себя правильно ровно до строки, где эти значения
 * перекрещены. Такая строка в наборе есть.
 */
import { describe, expect, it } from 'vitest';

import { allowsRow, isUnrestricted, type AuthScope } from './scope.js';

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
const ENGINEER_SCOPE: AuthScope = { kind: 'engineer', userId: USER };
const GENERAL_CONTRACTOR_SCOPE: AuthScope = {
  kind: 'general_contractor',
  userId: USER,
  contractorId: CONTRACTOR_A,
};
const MANAGER_SCOPE: AuthScope = { kind: 'manager', userId: USER };
const ADMIN_SCOPE: AuthScope = { kind: 'admin', userId: USER };

function allowed(scope: AuthScope): readonly ScopedRow[] {
  return ALL_ROWS.filter((row) => allowsRow(scope, row));
}

describe('allowsRow: подрядчик — единственная оставшаяся граница', () => {
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

describe('allowsRow: объект больше не ограничивает', () => {
  it.each([
    ['engineer', ENGINEER_SCOPE],
    ['general_contractor', GENERAL_CONTRACTOR_SCOPE],
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('%s видит все строки', (_kind, scope) => {
    expect(allowed(scope)).toEqual(ALL_ROWS);
  });

  it('генподрядчик видит комплекты ЧУЖОЙ организации', () => {
    // Его `contractorId` отвечает не на «что он видит», а на «от чьего имени он
    // действует». Фильтр по нему оставил бы ему видимым только файл реестра, а
    // собрать папку из комплектов субподрядчиков стало бы нечем.
    expect(allowsRow(GENERAL_CONTRACTOR_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(true);
  });

  it('руководитель и администратор видят строку любого подрядчика', () => {
    // У этих областей нет ни contractorId, ни списка объектов: доступ к данным
    // ИД у них не ограничен, а разграничение действий делает permission.
    expect(allowsRow(MANAGER_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(true);
    expect(allowsRow(ADMIN_SCOPE, ROW_OBJECT_B_CONTRACTOR_B)).toBe(true);
  });
});

describe('isUnrestricted', () => {
  it.each([
    ['engineer', ENGINEER_SCOPE],
    ['general_contractor', GENERAL_CONTRACTOR_SCOPE],
    ['manager', MANAGER_SCOPE],
    ['admin', ADMIN_SCOPE],
  ] as const)('%s не ограничен', (_kind, scope) => {
    expect(isUnrestricted(scope)).toBe(true);
  });

  it('подрядчик ограничен', () => {
    expect(isUnrestricted(CONTRACTOR_SCOPE)).toBe(false);
  });
});
