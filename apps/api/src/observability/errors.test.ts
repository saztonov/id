/**
 * Дедупликация ошибок (§11) на настоящей PostgreSQL.
 *
 * Тесты идут на pglite с полной цепочкой миграций, а не на подставном
 * исполнителе SQL: проверяется именно `ON CONFLICT (fingerprint) DO UPDATE` —
 * то, что счётчик растёт в одной строке, а не появляется вторая. Мок повторил
 * бы наши же представления о запросе и не заметил бы ни расхождения имён
 * колонок, ни отсутствия уникального ключа.
 *
 * `DbErrorReporter` по построению не бросает: сбой записи он только пишет в
 * лог. Поэтому лог перехватывается, и каждый тест убеждается, что записи
 * `error_report_failed` не было — иначе «ноль строк» читалось бы как
 * «дедупликация сработала».
 */
import { Writable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Counter, Registry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TestDatabase } from '@id/db-harness';
import { createPgliteDatabase } from '@id/db-harness';
import { applyMigrations, loadMigrations } from '@id/migrator';

import { DbErrorReporter, type SqlExecutor } from './errors.js';
import { createLogger } from './logger.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

interface ErrorEventRow {
  readonly fingerprint: string;
  readonly error_class: string;
  readonly message_template: string;
  readonly top_frame: string | null;
  readonly count: number | string;
  readonly sample_request_id: string | null;
  readonly sample_context: Record<string, unknown> | null;
}

function asSqlExecutor(db: TestDatabase): SqlExecutor {
  return {
    async query(text: string, values?: readonly unknown[]) {
      return { rows: await db.query(text, values as unknown[] | undefined) };
    },
  };
}

let db: TestDatabase;
let reporter: DbErrorReporter;
let logLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  db = await createPgliteDatabase();
  await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      callback();
    },
  });
  reporter = new DbErrorReporter({
    sql: asSqlExecutor(db),
    logger: createLogger({ service: 'api-test', level: 'trace', destination }),
  });
}, 300_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query('delete from error_events');
  logLines = [];
});

/** Репортер глотает собственные сбои: без этой проверки тесты слепы. */
function expectWriteSucceeded(): void {
  const failed = logLines.filter((line) => line.event === 'error_report_failed');
  expect(failed, 'запись в error_events сорвалась').toStrictEqual([]);
}

async function events(): Promise<readonly ErrorEventRow[]> {
  expectWriteSucceeded();
  return db.query<ErrorEventRow>(
    `select fingerprint, error_class, message_template, top_frame, count,
            sample_request_id, sample_context
       from error_events
      order by error_class, top_frame`,
  );
}

function catchFrom(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('вызов не упал: сценарий теста больше не воспроизводится');
}

describe('дедупликация по отпечатку', () => {
  it('склеивает два одинаковых падения в одну строку со счётчиком 2', async () => {
    function failToStoreResult(): Error {
      return new Error('не удалось сохранить результат распознавания блока');
    }

    await reporter.report(failToStoreResult());
    await reporter.report(failToStoreResult());

    const rows = await events();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.count)).toBe(2);
    expect(rows[0]?.message_template).toBe('не удалось сохранить результат распознавания блока');
  });

  it('не склеивает разные классы ошибок с одинаковым сообщением', async () => {
    class IntegrityError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'IntegrityError';
      }
    }

    // Оба объекта создаются в одной функции: свой кадр стека и сообщение
    // совпадают, различается только класс — значит различие даст именно он.
    function raiseBothClasses(): readonly [Error, Error] {
      return [
        new Error('расхождение хэшей разметки'),
        new IntegrityError('расхождение хэшей разметки'),
      ];
    }

    const [plain, integrity] = raiseBothClasses();
    await reporter.report(plain);
    await reporter.report(integrity);

    const rows = await events();

    expect(rows.map((row) => row.error_class)).toStrictEqual(['Error', 'IntegrityError']);
    expect(rows.map((row) => Number(row.count))).toStrictEqual([1, 1]);
  });

  it('склеивает одинаковый класс с разными uuid и числами в сообщении', async () => {
    function pageMissing(revisionId: string, pageNumber: number): Error {
      return new Error(`страница ${pageNumber} ревизии ${revisionId} не найдена`);
    }

    await reporter.report(pageMissing('7f000000-0000-4000-8000-000000000001', 42));
    await reporter.report(pageMissing('7f000000-0000-4000-8000-000000000002', 7));

    const rows = await events();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.count)).toBe(2);
    expect(rows[0]?.message_template).toBe('страница <n> ревизии <uuid> не найдена');
  });

  it('сохраняет различимость имён в кавычках при нормализации', async () => {
    function relationMissing(relation: string): Error {
      return new Error(`relation "${relation}" does not exist`);
    }

    await reporter.report(relationMissing('page_assignments'));
    await reporter.report(relationMissing('submission_revisions'));

    const rows = await events();

    expect(rows).toHaveLength(2);
  });
});

describe('отпечаток берёт свой кадр стека, а не кадр библиотеки', () => {
  it('различает два наших вызова одной и той же библиотечной ошибки', async () => {
    const registry = new Registry();
    const occupiedName = 'observability_probe_total';
    new Counter({ name: occupiedName, help: 'занимает имя в реестре', registers: [registry] });

    // Ошибку создаёт prom-client, поэтому верхний кадр стека у обоих падений
    // один и тот же — внутри node_modules. Различаются только наши вызовы.
    function registerFromSegmentation(): void {
      new Counter({ name: occupiedName, help: 'повтор из сегментации', registers: [registry] });
    }
    function registerFromExtraction(): void {
      new Counter({ name: occupiedName, help: 'повтор из извлечения', registers: [registry] });
    }

    const first = catchFrom(registerFromSegmentation);
    const second = catchFrom(registerFromExtraction);

    const topStackLine = String((first as Error).stack).split('\n')[1] ?? '';
    expect(
      topStackLine,
      'верхний кадр перестал быть библиотечным: сценарий больше ничего не проверяет',
    ).toContain('node_modules');
    expect((first as Error).message).toBe((second as Error).message);

    await reporter.report(first);
    await reporter.report(second);

    const rows = await events();

    expect(rows, 'два разных места вызова склеились в одну строку').toHaveLength(2);
    expect(rows.map((row) => Number(row.count))).toStrictEqual([1, 1]);

    const frames = rows.map((row) => row.top_frame ?? '');
    expect(frames.join('\n')).not.toContain('node_modules');
    expect(frames.some((frame) => frame.includes('registerFromSegmentation'))).toBe(true);
    expect(frames.some((frame) => frame.includes('registerFromExtraction'))).toBe(true);
  });

  it('не тащит в отпечаток номер строки: путь до файла остаётся относительным', async () => {
    function raiseHere(): Error {
      return new Error('падение с известным кадром');
    }

    await reporter.report(raiseHere());

    const [row] = await events();

    expect(row?.top_frame).toBe('raiseHere (apps/api/src/observability/errors.test.ts)');
  });
});

describe('образец контекста', () => {
  it('сохраняет идентификаторы, по которым падение можно найти', async () => {
    await reporter.report(new Error('падение с контекстом'), {
      requestId: 'req-0000000000000001',
      userId: '7f000000-0000-4000-8000-00000000000a',
      route: '/api/revisions/:revisionId/blocks',
      objectId: '7f000000-0000-4000-8000-00000000000b',
      jobType: 'ocr_block',
      attempt: 3,
    });

    const [row] = await events();

    expect(row?.sample_request_id).toBe('req-0000000000000001');
    expect(row?.sample_context).toMatchObject({
      user_id: '7f000000-0000-4000-8000-00000000000a',
      route: '/api/revisions/:revisionId/blocks',
      object_id: '7f000000-0000-4000-8000-00000000000b',
      job_type: 'ocr_block',
      attempt: 3,
    });
  });

  it('не записывает секреты в sample_context', async () => {
    const sentinels = {
      password: 'chasovoy-parol-1001',
      accessToken: 'chasovoy-access-1002',
      signature: 'chasovoy-sigv4-1003',
    };

    await reporter.report(new Error('падение при выгрузке артефакта'), {
      requestId: 'req-0000000000000002',
      extra: {
        password: sentinels.password,
        accessToken: sentinels.accessToken,
        uploadUrl: `https://storage.example.net/id/9f1c/artifact.zip?X-Amz-Signature=${sentinels.signature}`,
      },
    });

    const [row] = await events();
    const stored = JSON.stringify(row?.sample_context);

    for (const [field, sentinel] of Object.entries(sentinels)) {
      expect(
        stored,
        `${field} записан в error_events.sample_context в открытом виде. ` +
          'Таблицу читает администратор, а §11 требует redaction секретов везде: ' +
          'sampleContext() в errors.ts обязан прогонять extra через тот же список, ' +
          'что и логгер, а не полагаться на дисциплину вызывающего кода.',
      ).not.toContain(sentinel);
    }
  });
});
