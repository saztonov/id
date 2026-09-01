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
 * Это регрессия на прод-инцидент. `appendFolderEvent` ловил нарушение первичного
 * ключа и повторял, но повтор не срабатывал никогда: распознаватель читал `code` с
 * верхнего уровня, а Drizzle прячет его в `cause`, — и даже сработай он, повторять
 * было бы нечего, потому что 23505 абортирует ВСЮ транзакцию вызывающего, а
 * SAVEPOINT в проекте не берётся нигде. В журнале задачи `vlm.start_recognition`
 * из-за этого осталось «duplicate key value violates unique constraint
 * folder_events_pkey» ВМЕСТО настоящей причины отказа распознавания: событие
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
  folderTreeSql,
  type TestDatabase,
} from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import type { AuthScope } from '../../auth/scope.js';
import { HttpProblem } from '../../lib/problem.js';
import {
  appendFolderEvent,
  cancelJobsOfRecognitionRun,
  cancelJobsOfFolder,
  computeProcessingStatus,
  enqueueSystemJob,
  readJobAutoContinue,
} from './jobs.js';
import { resetPipelineForFolder } from './purge.js';
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
const FOLDER = id(5);

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
    ...folderTreeSql({
      contractorId: ORG,
      objectId: OBJECT,
      userId: USER,
      folderId: FOLDER,
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
  readonly db: Parameters<typeof appendFolderEvent>[0];
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
    db: stub as unknown as Parameters<typeof appendFolderEvent>[0],
    calls: () => calls,
  };
}

describe('appendFolderEvent: проигранная гонка за seq', () => {
  it('пустой rows — не сбой, а повтор: исключения нет', async () => {
    const stub = executorReturning({ rows: [] }, { rows: [{ seq: 7 }] });

    const seq = await appendFolderEvent(stub.db, {
      folderId: FOLDER,
      eventType: 'recognition.failed',
    });

    expect(seq).toBe(7);
    expect(stub.calls()).toBe(2);
  });

  it('seq приходит от драйвера строкой (bigint), а возвращается числом', async () => {
    const stub = executorReturning({ rows: [{ seq: '3' }] });

    const seq = await appendFolderEvent(stub.db, { folderId: FOLDER, eventType: 'x' });

    expect(seq).toBe(3);
    expect(typeof seq).toBe('number');
  });

  it('затор исчерпывает лимит попыток и отдаёт 500, а не крутится вечно', async () => {
    const stub = executorReturning({ rows: [] });

    const failure = await appendFolderEvent(stub.db, {
      folderId: FOLDER,
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
    } as unknown as Parameters<typeof appendFolderEvent>[0];

    await expect(appendFolderEvent(stub, { folderId: FOLDER, eventType: 'x' })).rejects.toThrow(
      'соединение потеряно',
    );
    expect(calls).toBe(1);
  });
});

// =====================================================================
// Главное утверждение — на настоящей БД, внутри настоящей транзакции
// =====================================================================

describe('appendFolderEvent внутри транзакции', () => {
  it('конфликт не абортирует транзакцию вызывающего и не оставляет дыр в seq', async () => {
    await db.transaction(async (tx) => {
      // Конкурент «уже зафиксирован»: номер 1 занят.
      await tx.execute(sql`
        insert into folder_events (folder_id, seq, event_type, payload)
        values (${FOLDER}::uuid, 1, 'seed', '{}'::jsonb)
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
            insert into folder_events (folder_id, seq, event_type, payload)
            values (${FOLDER}::uuid, 1, 'race', '{}'::jsonb)
            on conflict (folder_id, seq) do nothing
            returning seq
          `);
        },
      } as unknown as Parameters<typeof appendFolderEvent>[0];

      const seq = await appendFolderEvent(racing, {
        folderId: FOLDER,
        eventType: 'recognition.failed',
      });
      expect(seq).toBe(2);

      // Транзакция жива. На нарушении первичного ключа здесь был бы 25P02
      // «current transaction is aborted», и вся работа вызывающего пропала бы.
      const alive = await tx.execute<{ ok: number }>(sql`select 1 as ok`);
      expect(alive.rows[0]?.ok).toBe(1);
    });

    const rows = await testDb.query<{ seq: string | number; event_type: string }>(
      `SELECT seq, event_type FROM folder_events WHERE folder_id = '${FOLDER}' ORDER BY seq`,
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
describe('cancelJobsOfFolder', () => {
  async function seed(type: 'checks.run' | 'doc.classify_pages', status: string): Promise<string> {
    const { jobId } = await enqueueSystemJob(db, {
      type,
      payload: { folderId: FOLDER },
      dedupeKey: `${type}:${FOLDER}:cancel-${status}`,
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

    const cancelled = await cancelJobsOfFolder(db, FOLDER);
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
      `INSERT INTO job_runs (job_id, job_type, folder_id, attempt)
         VALUES ('${jobId}', 'doc.classify_pages', '${FOLDER}', 1)`,
    );

    await cancelJobsOfFolder(db, FOLDER);

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

    await cancelJobsOfFolder(db, FOLDER, { stages: ['analysis'] });

    expect(await statusOf(analysis)).toBe('cancelled');
    expect(await statusOf(checks)).toBe('queued');
  });

  it('пустой список стадий не снимает ничего', async () => {
    const job = await seed('checks.run', 'queued');

    // Пустой список — «снимать нечего», а не «снять всё». Молчаливое расширение
    // до всех типов было бы худшим из возможных прочтений.
    expect(await cancelJobsOfFolder(db, FOLDER, { stages: [] })).toBe(0);
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
      payload: { folderId: FOLDER, recognitionRunId: runId, pageIndex: pageIndex++ },
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

    const cancelled = await cancelJobsOfRecognitionRun(db, FOLDER, PARENT);
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
      `INSERT INTO job_runs (job_id, job_type, folder_id, attempt)
         VALUES ('${jobId}', 'vlm.recognize_page', '${FOLDER}', 1)`,
    );

    await cancelJobsOfRecognitionRun(db, FOLDER, PARENT);

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
    expect(await cancelJobsOfRecognitionRun(db, FOLDER, unknown)).toBe(0);
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
  const keyOf = (status: string): string => `checks.run:${FOLDER}:${status}`;

  async function enqueue(status: string): Promise<{ jobId: string; created: boolean }> {
    return enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
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
    const key = `checks.run:${FOLDER}:reset`;
    const before = await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: key,
    });

    await resetPipelineForFolder(db, FOLDER);

    const status = await testDb.query<{ status: string }>(
      `SELECT status FROM jobs WHERE id = '${before.jobId}'`,
    );
    expect(status[0]?.status).toBe('cancelled');

    const after = await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
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
    const key = `doc.classify_pages:${FOLDER}:auto`;
    const manual = await enqueueSystemJob(db, {
      type: 'doc.classify_pages',
      payload: { folderId: FOLDER },
      dedupeKey: key,
    });
    expect(await readJobAutoContinue(db, manual.jobId)).toBe(false);

    const throughRun = await enqueueSystemJob(db, {
      type: 'doc.classify_pages',
      payload: { folderId: FOLDER, autoContinue: true },
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
      payload: { folderId: FOLDER },
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
    const key = `checks.run:${FOLDER}:predicate`;
    const first = await enqueueSystemJob(db, {
      type: 'checks.run',
      payload: { folderId: FOLDER },
      dedupeKey: key,
    });
    await expect(
      enqueueSystemJob(db, {
        type: 'checks.run',
        payload: { folderId: FOLDER },
        dedupeKey: key,
      }),
    ).resolves.toEqual({ jobId: first.jobId, created: false });
  });
});

// =====================================================================
// Постраничный счётчик выделения блоков (S30)
// =====================================================================

/**
 * Счётчик, который врёт, хуже отсутствующего: по нему решают, ждать дальше или
 * идти разбираться. Проверяются все способы соврать, из-за которых счёт был
 * переписан с остатка на прямой (S36): зонд ориентации, принятый за сделанную
 * страницу, раздатчик, ещё не раздавший работу, и прошлый прогон, выданный за
 * текущий.
 */
describe('computeProcessingStatus: разметка постранично', () => {
  const SCOPE: AuthScope = { kind: 'manager', userId: USER };

  const BLOB = 'c'.repeat(64);
  const FILE = id(200);
  const BUNDLE = id(201);
  const PAGE_COUNT = 5;

  let seeded = false;

  async function seedBundle(): Promise<void> {
    if (seeded) return;
    seeded = true;
    await testDb.query(
      `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
         VALUES ('${BLOB}', 'blobs/${BLOB}', 1024, 'application/pdf')`,
    );
    await testDb.query(
      `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
         VALUES ('${FILE}', '${FOLDER}', '${BLOB}', 'komplekt.pdf', 0, 'ok')`,
    );
    await testDb.query(
      `INSERT INTO processing_bundles
         (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${BUNDLE}', '${FOLDER}', '${'d'.repeat(64)}', '${BLOB}', 'bundle/1+pdf-lib')`,
    );
    for (let index = 0; index < PAGE_COUNT; index += 1) {
      const pageId = id(210 + index);
      await testDb.query(
        `INSERT INTO source_pages
           (id, folder_id, source_file_id, file_page_index, folder_ordinal, width_px, height_px, rotation)
         VALUES ('${pageId}', '${FOLDER}', '${FILE}', ${String(index)}, ${String(index)}, 1654, 2339, 0)`,
      );
      await testDb.query(
        `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
           VALUES ('${BUNDLE}', '${FOLDER}', ${String(index)}, '${pageId}')`,
      );
    }
  }

  /** Задача детекции на одну страницу — как их ставит локальная ветка. */
  async function detectPage(pageIndex: number, status: string, tag: string): Promise<void> {
    const { jobId } = await enqueueSystemJob(db, {
      type: 'layout.detect_local',
      payload: {
        folderId: FOLDER,
        layoutRevisionId: id(220),
        pageIndices: [pageIndex],
      },
      dedupeKey: `layout.detect_local:${String(pageIndex)}:${tag}`,
    });
    await testDb.query(`UPDATE jobs SET status = '${status}' WHERE id = '${jobId}'`);
  }

  /** Зонд ориентации на одну страницу — с него начинается прогон при ADR-0020. */
  async function probePage(pageIndex: number, status: string, tag: string): Promise<void> {
    const { jobId } = await enqueueSystemJob(db, {
      type: 'page.orientation_probe',
      payload: {
        folderId: FOLDER,
        layoutRevisionId: id(220),
        bundleId: BUNDLE,
        sourcePageId: id(210 + pageIndex),
        workingPageIndex: pageIndex,
      },
      dedupeKey: `page.orientation_probe:${String(pageIndex)}:${tag}`,
    });
    await testDb.query(`UPDATE jobs SET status = '${status}' WHERE id = '${jobId}'`);
  }

  /** Чистая очередь: сценарии ниже проверяют состояния, а не их наслоение. */
  async function clearJobs(): Promise<void> {
    await testDb.query(`DELETE FROM jobs WHERE payload ->> 'folderId' = '${FOLDER}'`);
  }

  const layoutOf = async (): Promise<{
    pagesTotal: number;
    pagesDone: number;
    pagesPending: number;
    pagesFailed: number;
  } | null> => {
    const status = await computeProcessingStatus(db, SCOPE, FOLDER);
    return status?.layout ?? null;
  };

  it('без рабочего документа счётчика нет вовсе, а не «0 из 0»', async () => {
    // Ноль страниц читался бы как «комплект пуст», хотя портал просто ещё не
    // собрал рабочий документ.
    expect(await layoutOf()).toBeNull();
  });

  it('считает сделанное: страница размечена, когда детекция прошла и никто не ждёт', async () => {
    await seedBundle();
    await detectPage(0, 'done', 'a');
    await detectPage(1, 'done', 'a');
    await detectPage(2, 'running', 'a');
    await detectPage(3, 'queued', 'a');
    await detectPage(4, 'failed', 'a');

    expect(await layoutOf()).toEqual({
      pagesTotal: 5,
      pagesDone: 2,
      pagesPending: 2,
      pagesFailed: 1,
    });
  });

  it('страница с блоками и БЕЗ блоков считается одинаково сделанной', async () => {
    // Ключевое отличие от подсчёта по `layout_blocks`: страница, на которой
    // детектор не нашёл ничего, блоков не даёт — и такой счётчик застрял бы,
    // не дойдя до конца, на любом комплекте с пустым листом.
    const layout = await layoutOf();
    expect(layout?.pagesDone).toBe(2);

    const blocks = await testDb.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM layout_blocks`,
    );
    expect(blocks[0]?.count).toBe(0);
  });

  it('повторный запуск начинает счёт заново, а не показывает «всё готово»', async () => {
    // `done`-задачи прошлого прогона не удаляются, и черновик разметки у
    // ревизии один. Счёт по одним завершённым задачам показал бы «5 из 5» в
    // первую же секунду нового прогона; спасает то, что ждущая задача новой
    // волны перекрывает завершённую задачу прошлой.
    for (let index = 0; index < PAGE_COUNT; index += 1) {
      await detectPage(index, 'queued', 'b');
    }

    expect(await layoutOf()).toEqual({
      pagesTotal: 5,
      pagesDone: 0,
      pagesPending: 5,
      pagesFailed: 0,
    });
  });

  it('страницу, взятую в работу заново, не считает и упавшей тоже', async () => {
    // Иначе одна страница попала бы в две корзины сразу, а сумма превысила бы
    // общее число страниц.
    const layout = await layoutOf();
    expect(layout?.pagesPending ?? 0).toBe(5);
    expect(layout?.pagesFailed ?? 0).toBe(0);
    expect(
      (layout?.pagesDone ?? 0) + (layout?.pagesPending ?? 0) + (layout?.pagesFailed ?? 0),
    ).toBe(5);
  });

  it('зонды ориентации — это ещё не размеченные страницы', async () => {
    // Тот самый дефект, с которого всё началось: зонды не входили в счёт, и
    // прогон открывался словами «размечено 5 страниц из 5», а дальше счётчик
    // пятился ровно с той скоростью, с какой зонды порождали детекцию.
    await clearJobs();
    for (let index = 0; index < PAGE_COUNT; index += 1) {
      await probePage(index, 'queued', 'c');
    }

    expect(await layoutOf()).toEqual({
      pagesTotal: 5,
      pagesDone: 0,
      pagesPending: 5,
      pagesFailed: 0,
    });
  });

  it('отработавший зонд не делает страницу размеченной: ждём детекцию', async () => {
    await clearJobs();
    await probePage(0, 'done', 'd');
    await detectPage(0, 'queued', 'd');
    // Соседняя страница держит стадию живой: без единой ждущей задачи счётчику
    // нечего показывать, и он молчит вовсе.
    await probePage(1, 'queued', 'd');

    expect(await layoutOf()).toEqual({
      pagesTotal: 5,
      pagesDone: 0,
      pagesPending: 2,
      pagesFailed: 0,
    });

    await testDb.query(
      `UPDATE jobs SET status = 'done'
        WHERE type = 'layout.detect_local' AND dedupe_key = 'layout.detect_local:0:d'`,
    );

    expect(await layoutOf()).toEqual({
      pagesTotal: 5,
      pagesDone: 1,
      pagesPending: 1,
      pagesFailed: 0,
    });
  });

  it('пока раздатчик в очереди, счёт нулевой, а не «всё готово»', async () => {
    // `layout.start` ставит страничные задачи сам, и до его отработки в очереди
    // видны только задачи ПРОШЛОГО прогона. Без этой ветки экран показывал бы
    // «5 из 5» ровно за секунду до падения счётчика в ноль.
    await clearJobs();
    for (let index = 0; index < PAGE_COUNT; index += 1) {
      await detectPage(index, 'done', 'e');
    }
    await enqueueSystemJob(db, {
      type: 'layout.start',
      payload: { folderId: FOLDER },
      dedupeKey: 'layout.start:progress',
    });

    expect(await layoutOf()).toEqual({
      pagesTotal: 5,
      pagesDone: 0,
      pagesPending: 0,
      pagesFailed: 0,
    });
  });

  it('стадия не идёт — счётчика нет вовсе', async () => {
    // Сводная стадия остаётся `layout` и во время пересборки рабочего документа:
    // она берётся как самая дальняя с активностью, а её оставил прошлый прогон.
    // Полоса при этом обязана исчезнуть, а не показывать прошлый комплект.
    await testDb.query(
      `UPDATE jobs SET status = 'done'
        WHERE payload ->> 'folderId' = '${FOLDER}' AND status IN ('queued', 'running')`,
    );

    expect(await layoutOf()).toBeNull();
  });
});
