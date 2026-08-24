/**
 * Назначение `seq` события ревизии: проигрыш гонки не убивает транзакцию.
 *
 * Это регрессия на прод-инцидент. `appendRevisionEvent` ловил нарушение первичного
 * ключа и повторял, но повтор не срабатывал никогда: распознаватель читал `code` с
 * верхнего уровня, а Drizzle прячет его в `cause`, — и даже сработай он, повторять
 * было бы нечего, потому что 23505 абортирует ВСЮ транзакцию вызывающего, а
 * SAVEPOINT в проекте не берётся нигде. В журнале задачи `vlm.start_recognition`
 * из-за этого осталось «duplicate key value violates unique constraint
 * revision_events_pkey» ВМЕСТО настоящей причины отказа распознавания: событие
 * `recognition.failed` пишется внутри транзакции `finishRecognitionRun`, и запись
 * отчёта об ошибке подменила собой саму ошибку.
 *
 * ## Почему конкуренция здесь не настоящая
 *
 * pglite однопоточен: `createTestPool` отдаёт один и тот же исполнитель, изоляции
 * транзакций между «соединениями» нет. Тест с двумя параллельными вызовами был бы
 * зелёным при ЛЮБОЙ реализации, включая сломанную, — то есть не утверждал бы
 * ничего. Поэтому конкурент не имитируется, а подменяется один оператор: проверяется
 * ровно то следствие, ради которого правка сделана, — конфликт возвращает пустой
 * `rows` вместо исключения, и транзакция вызывающего остаётся живой.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createPgliteDatabase,
  createTestPool,
  revisionTreeSql,
  type TestDatabase,
} from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { HttpProblem } from '../../lib/problem.js';
import { appendRevisionEvent } from './jobs.js';
import type { Database } from './users.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG = id(1);
const OBJECT = id(2);
const USER = id(3);
const WORK = id(4);
const REVISION = id(5);

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const fixture: readonly string[] = [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'EVT01', 'Объект', 'ЖК «События», корпус 1')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER}', 'kc-events', 'Сотрудник', '${ORG}')`,
    ...revisionTreeSql({
      contractorId: ORG,
      objectId: OBJECT,
      userId: USER,
      workId: WORK,
      revisionId: REVISION,
    }),
  ];
  for (const statement of fixture) {
    await testDb.query(statement);
  }

  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

// =====================================================================
// Ветка проигранной гонки — на подменном исполнителе
// =====================================================================

/** Исполнитель, отдающий заранее заготовленные ответы. */
function executorReturning(...results: readonly { rows: unknown[] }[]): {
  readonly db: Parameters<typeof appendRevisionEvent>[0];
  calls: () => number;
} {
  let calls = 0;
  const stub = {
    execute: (): Promise<unknown> => {
      const result = results[Math.min(calls, results.length - 1)];
      calls += 1;
      return Promise.resolve(result);
    },
  };
  return {
    db: stub as unknown as Parameters<typeof appendRevisionEvent>[0],
    calls: () => calls,
  };
}

describe('appendRevisionEvent: проигранная гонка за seq', () => {
  it('пустой rows — не сбой, а повтор: исключения нет', async () => {
    const stub = executorReturning({ rows: [] }, { rows: [{ seq: 7 }] });

    const seq = await appendRevisionEvent(stub.db, {
      revisionId: REVISION,
      eventType: 'recognition.failed',
    });

    expect(seq).toBe(7);
    expect(stub.calls()).toBe(2);
  });

  it('seq приходит от драйвера строкой (bigint), а возвращается числом', async () => {
    const stub = executorReturning({ rows: [{ seq: '3' }] });

    const seq = await appendRevisionEvent(stub.db, { revisionId: REVISION, eventType: 'x' });

    expect(seq).toBe(3);
    expect(typeof seq).toBe('number');
  });

  it('затор исчерпывает лимит попыток и отдаёт 500, а не крутится вечно', async () => {
    const stub = executorReturning({ rows: [] });

    const failure = await appendRevisionEvent(stub.db, {
      revisionId: REVISION,
      eventType: 'recognition.failed',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpProblem);
    expect((failure as HttpProblem).status).toBe(500);
    // Ровно столько, сколько объявлено константой: «оптимизация» цикла в
    // бесконечный обрушила бы этот тест, а не прод.
    expect(stub.calls()).toBe(8);
  });

  it('ошибка драйвера выходит наружу без повтора: отказ записи обязан быть виден', async () => {
    let calls = 0;
    const stub = {
      execute: (): Promise<unknown> => {
        calls += 1;
        return Promise.reject(new Error('соединение потеряно'));
      },
    } as unknown as Parameters<typeof appendRevisionEvent>[0];

    await expect(
      appendRevisionEvent(stub, { revisionId: REVISION, eventType: 'x' }),
    ).rejects.toThrow('соединение потеряно');
    expect(calls).toBe(1);
  });
});

// =====================================================================
// Главное утверждение — на настоящей БД, внутри настоящей транзакции
// =====================================================================

describe('appendRevisionEvent внутри транзакции', () => {
  it('конфликт не абортирует транзакцию вызывающего и не оставляет дыр в seq', async () => {
    await db.transaction(async (tx) => {
      // Конкурент «уже зафиксирован»: номер 1 занят.
      await tx.execute(sql`
        insert into revision_events (revision_id, seq, event_type, payload)
        values (${REVISION}::uuid, 1, 'seed', '{}'::jsonb)
      `);

      // Первый оператор подменяется на заведомо конфликтующий — ровно тот,
      // который выдал бы проигравший гонку. Остальные идут в настоящую
      // транзакцию без изменений.
      let first = true;
      const racing = {
        execute: (query: SQL): Promise<unknown> => {
          if (!first) return tx.execute(query);
          first = false;
          return tx.execute(sql`
            insert into revision_events (revision_id, seq, event_type, payload)
            values (${REVISION}::uuid, 1, 'race', '{}'::jsonb)
            on conflict (revision_id, seq) do nothing
            returning seq
          `);
        },
      } as unknown as Parameters<typeof appendRevisionEvent>[0];

      const seq = await appendRevisionEvent(racing, {
        revisionId: REVISION,
        eventType: 'recognition.failed',
      });
      expect(seq).toBe(2);

      // Транзакция жива. На нарушении первичного ключа здесь был бы 25P02
      // «current transaction is aborted», и вся работа вызывающего пропала бы.
      const alive = await tx.execute<{ ok: number }>(sql`select 1 as ok`);
      expect(alive.rows[0]?.ok).toBe(1);
    });

    const rows = await testDb.query<{ seq: string | number; event_type: string }>(
      `SELECT seq, event_type FROM revision_events WHERE revision_id = '${REVISION}' ORDER BY seq`,
    );
    // Без дыр: SSE отличает «пропущенное вне окна хранения» от «ничего нового»
    // сравнением cursor + 1 < oldestSeq, и дырявая лента даёт ложный reset.
    expect(rows.map((row) => Number(row.seq))).toEqual([1, 2]);
    expect(rows[1]?.event_type).toBe('recognition.failed');
  });
});
