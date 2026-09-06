/**
 * Перечисления сверки не разошлись с ограничениями базы (S54).
 *
 * ## Дефект, из-за которого тест написан
 *
 * `CandidateBasis` и `match_state` живут в двух местах сразу: типом в коде и
 * закрытым CHECK в SQL. Оба места правят руками, и разойтись они могут только
 * молча — тип не исполняется, а CHECK срабатывает лишь на строке, которая до
 * него доехала. S53 добавил основание `annex_pages` в тип и забыл миграцию:
 * `pnpm gate` был зелёным, стенд ничего не заметил (кандидатов с этим
 * основанием в фикстурах не было), а на бою первая же строка описи, у которой
 * несколько подходящих родителей, убила `doc.match_registry` тремя отказами
 * подряд — 128 строк остались `missing`, граф и проверка правилами не
 * построены.
 *
 * ## Почему сверка со схемой Drizzle, а не с живой базой
 *
 * Схема в `@id/db` СГЕНЕРИРОВАНА из миграций и хранит CHECK дословно, а её
 * расхождение с миграциями уже ловит `schema-drift.test.ts`. Цепочка «код →
 * схема → миграции → бой» замкнута, и платить за неё поднятием pglite с сотней
 * миграций в каждом прогоне не нужно.
 */
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { registryRowCandidates, registryRows } from '@id/db';
import type { PgTable } from 'drizzle-orm/pg-core';

import { CANDIDATE_BASES, MATCH_STATES } from './match.js';

/**
 * Значения закрытого CHECK, прочитанные из схемы.
 *
 * drizzle-kit печатает такой CHECK как `col = ANY (ARRAY['a'::text, …])`, и
 * литералы берутся разбором готового SQL. Отсутствие ограничения — отказ, а не
 * пустой список: «CHECK потеряли» и «CHECK ничего не разрешает» — разные беды,
 * и вторая молчала бы зелёным.
 */
function literalsOf(table: PgTable, constraint: string): readonly string[] {
  const check = getTableConfig(table).checks.find((candidate) => candidate.name === constraint);
  if (check === undefined) {
    throw new Error(`Ограничение ${constraint} в сгенерированной схеме не найдено`);
  }
  const text = new PgDialect().sqlToQuery(check.value).sql;
  return [...text.matchAll(/'([^']*)'::text/gu)].map((match) => match[1] ?? '');
}

describe('перечисления сверки совпадают с CHECK базы', () => {
  it('основания кандидата', () => {
    // Сравниваются МНОЖЕСТВА: порядок в SQL задаёт drizzle-kit, и требовать от
    // него порядок объявления значило бы красить гейт на перегенерации схемы.
    expect([...CANDIDATE_BASES].sort()).toEqual(
      [...literalsOf(registryRowCandidates, 'registry_row_candidates_basis_chk')].sort(),
    );
  });

  it('состояния строки описи', () => {
    expect([...MATCH_STATES].sort()).toEqual(
      [...literalsOf(registryRows, 'registry_rows_match_state_chk')].sort(),
    );
  });
});
