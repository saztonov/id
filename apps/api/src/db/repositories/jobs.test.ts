/**
 * Две регрессии репозитория задач, обе — на прод-инциденты.
 *
 * 1. Назначение `seq` события ревизии: проигрыш гонки не убивает транзакцию.
 * 2. Отмена задач ревизии: сброс не оставляет за собой ни мертвецов, ни спящих.
 * 3. Ключ дедупликации: какие терминальные состояния его держат (0039).
 *
 * Разбор первой — ниже; остальные описаны над своими `describe`.
 *
 * # Назначение `seq` события ревизии
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
import {
  appendRevisionEvent,
  cancelJobsOfRecognitionRun,
  cancelJobsOfRevision,
  enqueueSystemJob,
  readJobAutoContinue,
} from './jobs.js';
import { resetPipelineForRevision } from './purge.js';
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

// =====================================================================
// Отмена задач ревизии: сброс не оставляет за собой ни мертвецов, ни спящих
// =====================================================================

/**
 * Сброс конвейера и удаление комплекта сносили производное, но `jobs` не
 * трогали вовсе: внешнего ключа на ревизию у задачи нет, и удаление проходило,
 * оставляя очередь жить. Мёртвая задача продолжала держать красную плашку на
 * ревизии, у которой снесли причину отказа; стоящая в очереди просыпалась, не
 * находила прогона и рождала НОВОГО мертвеца — сброс не заканчивал прошлую
 * попытку, а размножал её.
 */
describe('cancelJobsOfRevision', () => {
  async function seed(type: 'checks.run' | 'doc.classify_pages', status: string): Promise<string> {
    const { jobId } = await enqueueSystemJob(db, {
      type,
      payload: { revisionId: REVISION },
      dedupeKey: `${type}:${REVISION}:cancel-${status}`,
    });
    await testDb.query(`UPDATE jobs SET status = '${status}' WHERE id = '${jobId}'`);
    return jobId;
  }

  const statusOf = async (jobId: string): Promise<string | undefined> =>
    (await testDb.query<{ status: string }>(`SELECT status FROM jobs WHERE id = '${jobId}'`))[0]
      ?.status;

  it('снимает и queued, и running, и мёртвые', async () => {
    const queued = await seed('checks.run', 'queued');
    const running = await seed('checks.run', 'running');
    const dead = await seed('checks.run', 'failed');
    // `done` не трогается: работа сделана, переписывать её исход нечем.
    const done = await seed('checks.run', 'done');

    const cancelled = await cancelJobsOfRevision(db, REVISION);
    expect(cancelled).toBeGreaterThanOrEqual(3);

    expect(await statusOf(queued)).toBe('cancelled');
    expect(await statusOf(running)).toBe('cancelled');
    // Мёртвая снимается в отличие от `cancelPendingJobsOfStage`: та снимает
    // остаток идущей работы, эта закрывает работу, предмета которой больше нет.
    expect(await statusOf(dead)).toBe('cancelled');
    expect(await statusOf(done)).toBe('done');
  });

  it('открытая попытка закрывается исходом cancelled, а строка журнала остаётся', async () => {
    const jobId = await seed('doc.classify_pages', 'running');
    await testDb.query(
      `INSERT INTO job_runs (job_id, job_type, revision_id, attempt)
         VALUES ('${jobId}', 'doc.classify_pages', '${REVISION}', 1)`,
    );

    await cancelJobsOfRevision(db, REVISION);

    const runs = await testDb.query<{ outcome: string | null; finished_at: string | null }>(
      `SELECT outcome, finished_at FROM job_runs WHERE job_id = '${jobId}'`,
    );
    // Строка НЕ удалена: `job_runs` — журнал (§11). Но и не оставлена открытой:
    // `outcome IS NULL` означает «попытка идёт», и такая строка навсегда попала
    // бы в in_flight сводки обработки.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('cancelled');
    expect(runs[0]?.finished_at).not.toBeNull();
  });

  it('со списком стадий снимает только их', async () => {
    const analysis = await seed('doc.classify_pages', 'queued');
    const checks = await seed('checks.run', 'queued');

    await cancelJobsOfRevision(db, REVISION, { stages: ['analysis'] });

    expect(await statusOf(analysis)).toBe('cancelled');
    expect(await statusOf(checks)).toBe('queued');
  });

  it('пустой список стадий не снимает ничего', async () => {
    const job = await seed('checks.run', 'queued');

    // Пустой список — «снимать нечего», а не «снять всё». Молчаливое расширение
    // до всех типов было бы худшим из возможных прочтений.
    expect(await cancelJobsOfRevision(db, REVISION, { stages: [] })).toBe(0);
    expect(await statusOf(job)).toBe('queued');
  });
});

// =====================================================================
// Отмена задач восстанавливаемого прогона (S29)
// =====================================================================

/**
 * Регрессия на красную плашку, которая не гасла никогда.
 *
 * `computeProcessingStatus` считает `dead` по ВСЕМ задачам ревизии без фильтра
 * по прогону, а `summaryStage` при `dead > 0` объявляет стадию `failed`. На
 * комплекте в 83 страницы упавший прогон оставил 132 мёртвые задачи, и
 * восстановительный прогон, прошедший успешно, ничего в этой картине не менял:
 * экран показывал «обработка остановлена отказом» поверх готового результата, а
 * опрос сводки при стадии `failed` выключается — плашка не могла погаснуть даже
 * сама собой.
 *
 * Проверяется именно узость фильтра: снять задачи стадии `recognition` целиком
 * было бы проще и означало бы снять заодно задачи ТОЛЬКО ЧТО поставленного
 * дочернего прогона.
 */
describe('cancelJobsOfRecognitionRun', () => {
  const PARENT = '00000000-0000-4000-8000-0000000000a1';
  const CHILD = '00000000-0000-4000-8000-0000000000a2';

  let pageIndex = 0;

  async function seed(runId: string, status: string, tag: string): Promise<string> {
    const { jobId } = await enqueueSystemJob(db, {
      type: 'vlm.recognize_page',
      payload: { revisionId: REVISION, recognitionRunId: runId, pageIndex: pageIndex++ },
      dedupeKey: `vlm.recognize_page:${runId}:${tag}`,
    });
    await testDb.query(`UPDATE jobs SET status = '${status}' WHERE id = '${jobId}'`);
    return jobId;
  }

  const statusOf = async (jobId: string): Promise<string | undefined> =>
    (await testDb.query<{ status: string }>(`SELECT status FROM jobs WHERE id = '${jobId}'`))[0]
      ?.status;

  it('снимает мертвецов родителя и не трогает задачи дочернего прогона', async () => {
    const parentDead = await seed(PARENT, 'failed', 'dead');
    const parentQueued = await seed(PARENT, 'queued', 'queued');
    const parentDone = await seed(PARENT, 'done', 'done');
    const childQueued = await seed(CHILD, 'queued', 'child');

    const cancelled = await cancelJobsOfRecognitionRun(db, REVISION, PARENT);
    expect(cancelled).toBe(2);

    expect(await statusOf(parentDead)).toBe('cancelled');
    expect(await statusOf(parentQueued)).toBe('cancelled');
    // Сделанная работа не переписывается: её исход — факт, а не состояние.
    expect(await statusOf(parentDone)).toBe('done');
    // Дочерний прогон только что поставлен этим же нажатием — снять его задачи
    // значило бы отменить восстановление ради того, чтобы погасить плашку.
    expect(await statusOf(childQueued)).toBe('queued');
  });

  it('открытая попытка родителя закрывается, а строка журнала остаётся', async () => {
    const jobId = await seed(PARENT, 'running', 'attempt');
    await testDb.query(
      `INSERT INTO job_runs (job_id, job_type, revision_id, attempt)
         VALUES ('${jobId}', 'vlm.recognize_page', '${REVISION}', 1)`,
    );

    await cancelJobsOfRecognitionRun(db, REVISION, PARENT);

    const runs = await testDb.query<{ outcome: string | null; finished_at: string | null }>(
      `SELECT outcome, finished_at FROM job_runs WHERE job_id = '${jobId}'`,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe('cancelled');
    expect(runs[0]?.finished_at).not.toBeNull();
  });

  it('без задач прогона отвечает нулём, а не падает', async () => {
    // Восстановление первого же прогона ревизии: у родителя задач может не
    // остаться вовсе (их снёс сброс конвейера), и это не повод для отказа.
    const unknown = '00000000-0000-4000-8000-0000000000af';
    expect(await cancelJobsOfRecognitionRun(db, REVISION, unknown)).toBe(0);
  });
});

// =====================================================================
// Ключ дедупликации по всем четырём терминальным состояниям (0039)
// =====================================================================

/**
 * Регрессия на дефект, из-за которого конвейер молча не запускался.
 *
 * Индекс 0007 исключал из уникальности только `done`, поэтому ОТМЕНЁННАЯ задача
 * держала ключ вечно. `enqueueSystemJob` при конфликте возвращает не ошибку, а
 * найденную задачу с `created: false` — и повторное нажатие кнопки получало в
 * ответ идентификатор мертвеца, который никогда не выполнится. Наблюдалось это
 * как «нажал, и ничего не происходит»: маршрут «Проверить» в режиме
 * тестирования снимает остаток детекции `cancelPendingJobsOfStage`, после чего
 * та же кнопка переставала ставить что-либо.
 *
 * Проверяются все четыре состояния разом и в одном тесте намеренно: дефект был
 * ровно в том, что различие между ними никто не выразил, и утверждение о
 * `cancelled` без соседей по таблице легко «починить», сломав `failed`.
 */
describe('enqueueSystemJob: какие состояния держат dedupe_key', () => {
  /** Свой ключ на состояние: тесты внутри describe делят одну базу. */
  const keyOf = (status: string): string => `checks.run:${REVISION}:${status}`;

  async function enqueue(status: string): Promise<{ jobId: string; created: boolean }> {
    return enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { revisionId: REVISION },
      dedupeKey: keyOf(status),
    });
  }

  it.each([
    ['queued', false],
    ['running', false],
    ['failed', false],
  ] as const)('состояние %s: ключ занят, вторая задача не ставится', async (status, expected) => {
    const first = await enqueue(status);
    expect(first.created).toBe(true);

    await testDb.query(`UPDATE jobs SET status = '${status}' WHERE id = '${first.jobId}'`);

    const second = await enqueue(status);
    expect(second.created).toBe(expected);
    // Возвращается именно существующая задача, а не новая с тем же ключом.
    expect(second.jobId).toBe(first.jobId);
  });

  it.each([['done'], ['cancelled']] as const)(
    'состояние %s: ключ свободен, задача ставится заново',
    async (status) => {
      const first = await enqueue(status);
      expect(first.created).toBe(true);

      await testDb.query(`UPDATE jobs SET status = '${status}' WHERE id = '${first.jobId}'`);

      const second = await enqueue(status);
      expect(second.created).toBe(true);
      expect(second.jobId).not.toBe(first.jobId);

      // Обе строки живут под одним ключом: частичный индекс их не считает
      // конфликтом, и журнал прежней попытки не переписан.
      const rows = await testDb.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM jobs WHERE dedupe_key = '${keyOf(status)}'`,
      );
      expect(rows[0]?.count).toBe(2);
    },
  );

  it('после отмены задача ставится заново — сквозь сброс конвейера', async () => {
    // Тот самый путь, из-за которого «нажал, и ничего не происходит»: сброс
    // отменяет задачи ревизии, и следующее нажатие обязано поставить работу
    // снова, а не получить в ответ отменённого мертвеца.
    const key = `checks.run:${REVISION}:reset`;
    const before = await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { revisionId: REVISION },
      dedupeKey: key,
    });

    await resetPipelineForRevision(db, REVISION);

    const status = await testDb.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = '${before.jobId}'`,
    );
    expect(status[0]?.status).toBe('cancelled');

    const after = await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { revisionId: REVISION },
      dedupeKey: key,
    });
    expect(after.created).toBe(true);
    expect(after.jobId).not.toBe(before.jobId);
  });

  it('сквозной прогон не отменяется дедупликацией и виден свежим чтением', async () => {
    // Payload найденной задачи побеждал по построению — `do nothing`
    // выбрасывает входящий целиком. Поэтому задача, поставленная ручной кнопкой
    // БЕЗ autoContinue, съедала нажатие «2. Распознать», сделанное следом:
    // цепочка доходила до своего звена и молча вставала.
    const key = `doc.classify_pages:${REVISION}:auto`;
    const manual = await enqueueSystemJob(db, {
      type: 'doc.classify_pages',
      payload: { revisionId: REVISION },
      dedupeKey: key,
    });
    expect(await readJobAutoContinue(db, manual.jobId)).toBe(false);

    const throughRun = await enqueueSystemJob(db, {
      type: 'doc.classify_pages',
      payload: { revisionId: REVISION, autoContinue: true },
      dedupeKey: key,
    });
    expect(throughRun.jobId).toBe(manual.jobId);
    expect(throughRun.created).toBe(false);
    expect(await readJobAutoContinue(db, manual.jobId)).toBe(true);

    // Флаг МОНОТОНЕН: обратно не снимается. Сквозной прогон — заказ, который
    // однажды сделан, и отменять его повторным нажатием ручной кнопки было бы
    // неверно в другую сторону.
    await enqueueSystemJob(db, {
      type: 'doc.classify_pages',
      payload: { revisionId: REVISION },
      dedupeKey: key,
    });
    expect(await readJobAutoContinue(db, manual.jobId)).toBe(true);
  });

  it('исчезнувшая задача даёт null, а не выдуманный ответ', async () => {
    // Вызывающий тогда остаётся при значении из payload: других сведений о
    // заказе нет, и подставлять `false` значило бы тихо отменить прогон.
    expect(await readJobAutoContinue(db, id(999))).toBeNull();
  });

  it('предикат ON CONFLICT совпадает с индексом: оператор не отказывает', async () => {
    // Расхождение предиката с `ux_jobs_dedupe_key` даёт не тихий дефект, а
    // «no unique or exclusion constraint matching the ON CONFLICT
    // specification» на КАЖДОЙ постановке. Проверяется здесь, а не на стенде.
    const key = `checks.run:${REVISION}:predicate`;
    const first = await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { revisionId: REVISION },
      dedupeKey: key,
    });
    await expect(
      enqueueSystemJob(db, {
        type: 'checks.run',
        payload: { revisionId: REVISION },
        dedupeKey: key,
      }),
    ).resolves.toEqual({ jobId: first.jobId, created: false });
  });
});
