/**
 * Журнал ошибок (§11) на настоящей PostgreSQL.
 *
 * Тесты идут на pglite с полной цепочкой миграций, а не на подставном
 * исполнителе SQL: проверяется именно поведение операторов — что счётчик
 * растёт в одной строке бакета, что примеры прореживаются условием
 * `WHERE NOT EXISTS`, что переоткрытие видит СТАРЫЙ статус. Мок повторил бы
 * наши же представления о запросах и не заметил бы ни расхождения имён
 * колонок, ни того, что `RETURNING` в `UPDATE` отдаёт новые значения.
 *
 * Писатель по построению не бросает: сбой записи он только пишет в лог.
 * Поэтому лог перехватывается, и каждая выборка убеждается, что записи
 * `journal_write_failed` не было — иначе «ноль строк» читалось бы как
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

import { JournalErrorReporter, type ErrorEventContext, type SqlExecutor } from './errors.js';
import { ErrorJournalWriter, OVERFLOW_ISSUE_ID, issueIdForFingerprint } from './journal-writer.js';
import { createLogger, type AppLogger } from './logger.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

const ADMIN_ID = '7f000000-0000-4000-8000-0000000000ad';

/** Строка сводки: сигнатура, её проблема и суммарный счётчик по бакетам. */
interface IssueRow {
  readonly fingerprint: string;
  readonly issue_id: string;
  readonly error_class: string;
  readonly message_template: string;
  readonly top_frame: string | null;
  readonly count: number | string;
  readonly source: string;
  readonly domain: string;
  readonly severity: string;
}

interface SampleRow {
  readonly request_id: string | null;
  readonly user_id: string | null;
  readonly route: string | null;
  readonly object_id: string | null;
  readonly job_type: string | null;
  readonly attempt: number | null;
  readonly repeat_count: number;
  readonly context: Record<string, unknown> | null;
}

let db: TestDatabase;
let logger: AppLogger;
let logLines: Record<string, unknown>[] = [];
/** Счётчик обращений к БД: им проверяется, что шторм не пишет построчно. */
let queries = 0;

function asSqlExecutor(source: TestDatabase): SqlExecutor {
  return {
    async query(text: string, values?: readonly unknown[]) {
      queries += 1;
      return { rows: await source.query(text, values as unknown[] | undefined) };
    },
  };
}

function newWriter(overrides: Partial<ConstructorParameters<typeof ErrorJournalWriter>[0]> = {}) {
  return new ErrorJournalWriter({
    sql: asSqlExecutor(db),
    logger,
    source: 'api',
    // Таймер не запускается: сброс в тестах вызывается явно, иначе проверка
    // «сколько запросов ушло» зависела бы от гонки с таймером.
    ...overrides,
  });
}

let writer: ErrorJournalWriter;
let reporter: JournalErrorReporter;

beforeAll(async () => {
  db = await createPgliteDatabase();
  await applyMigrations(db, loadMigrations(MIGRATIONS_DIR));

  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(JSON.parse(chunk.toString('utf8')) as Record<string, unknown>);
      callback();
    },
  });
  logger = createLogger({ service: 'api-test', level: 'trace', destination });

  // Администратор нужен ровно для одной ветки: закрыть проблему может только
  // названный человек, так требует error_issues_resolved_chk.
  await db.query(
    `insert into users (id, kc_sub, full_name) values ($1, 'kc-journal-admin', 'Администратор')`,
    [ADMIN_ID],
  );
}, 300_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // Служебная проблема переполнения заведена миграцией и обязана пережить
  // очистку: без неё события сверх лимита некуда было бы отнести.
  await db.query('delete from error_issues where id <> $1', [OVERFLOW_ISSUE_ID]);
  await db.query('delete from error_stats_hourly');
  await db.query('delete from error_samples');
  await db.query('delete from error_issue_actions');
  logLines = [];
  queries = 0;
  writer = newWriter();
  reporter = new JournalErrorReporter(writer, 'api');
});

/** Писатель глотает собственные сбои: без этой проверки тесты слепы. */
function expectWriteSucceeded(): void {
  const failed = logLines.filter(
    (line) => line.event === 'journal_write_failed' || line.event === 'journal_overflow',
  );
  expect(failed, 'запись журнала сорвалась').toStrictEqual([]);
}

async function report(error: unknown, context?: ErrorEventContext): Promise<void> {
  await reporter.report(error, context);
}

async function issues(): Promise<readonly IssueRow[]> {
  await writer.flush();
  expectWriteSucceeded();
  return db.query<IssueRow>(
    `select s.fingerprint, s.issue_id, s.error_class, s.message_template, s.top_frame,
            coalesce(sum(h.count), 0) as count,
            i.source, i.domain, i.severity
       from error_signatures s
       join error_issues i on i.id = s.issue_id
       left join error_stats_hourly h on h.issue_id = s.issue_id
      group by s.fingerprint, s.issue_id, s.error_class, s.message_template, s.top_frame,
               i.source, i.domain, i.severity
      order by s.error_class, s.top_frame`,
  );
}

async function samples(): Promise<readonly SampleRow[]> {
  return db.query<SampleRow>(
    `select request_id, user_id, route, object_id, job_type, attempt, repeat_count, context
       from error_samples order by id`,
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

    await report(failToStoreResult());
    await report(failToStoreResult());

    const rows = await issues();

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
    await report(plain);
    await report(integrity);

    const rows = await issues();

    expect(rows.map((row) => row.error_class)).toStrictEqual(['Error', 'IntegrityError']);
    expect(rows.map((row) => Number(row.count))).toStrictEqual([1, 1]);
  });

  it('склеивает одинаковый класс с разными uuid и числами в сообщении', async () => {
    function pageMissing(folderId: string, pageNumber: number): Error {
      return new Error(`страница ${pageNumber} ревизии ${folderId} не найдена`);
    }

    await report(pageMissing('7f000000-0000-4000-8000-000000000001', 42));
    await report(pageMissing('7f000000-0000-4000-8000-000000000002', 7));

    const rows = await issues();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.count)).toBe(2);
    expect(rows[0]?.message_template).toBe('страница <n> ревизии <uuid> не найдена');
  });

  it('сохраняет различимость имён в кавычках при нормализации', async () => {
    function relationMissing(relation: string): Error {
      return new Error(`relation "${relation}" does not exist`);
    }

    await report(relationMissing('page_assignments'));
    await report(relationMissing('folders'));

    const rows = await issues();

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

    await report(first);
    await report(second);

    const rows = await issues();

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

    await report(raiseHere());

    const [row] = await issues();

    expect(row?.top_frame).toBe('raiseHere (apps/api/src/observability/errors.test.ts)');
  });
});

describe('пример', () => {
  it('сохраняет идентификаторы, по которым падение можно найти', async () => {
    await report(new Error('падение с контекстом'), {
      requestId: 'req-0000000000000001',
      userId: '7f000000-0000-4000-8000-00000000000a',
      route: '/api/folders/:folderId/blocks',
      objectId: '7f000000-0000-4000-8000-00000000000b',
      jobType: 'ocr_block',
      attempt: 3,
    });

    await issues();
    const [row] = await samples();

    expect(row?.request_id).toBe('req-0000000000000001');
    expect(row?.user_id).toBe('7f000000-0000-4000-8000-00000000000a');
    expect(row?.route).toBe('/api/folders/:folderId/blocks');
    expect(row?.object_id).toBe('7f000000-0000-4000-8000-00000000000b');
    expect(row?.job_type).toBe('ocr_block');
    expect(row?.attempt).toBe(3);
  });

  it('не записывает секреты в контекст примера', async () => {
    const sentinels = {
      password: 'chasovoy-parol-1001',
      accessToken: 'chasovoy-access-1002',
      signature: 'chasovoy-sigv4-1003',
    };

    await report(new Error('падение при выгрузке артефакта'), {
      requestId: 'req-0000000000000002',
      extra: {
        password: sentinels.password,
        accessToken: sentinels.accessToken,
        uploadUrl: `https://storage.example.net/id/9f1c/artifact.zip?X-Amz-Signature=${sentinels.signature}`,
      },
    });

    await issues();
    const [row] = await samples();
    const stored = JSON.stringify(row?.context);

    for (const [field, sentinel] of Object.entries(sentinels)) {
      expect(
        stored,
        `${field} записан в error_samples.context в открытом виде. ` +
          'Таблицу читает администратор, а §11 требует redaction секретов везде: ' +
          'sampleContext() в errors.ts обязан прогонять extra через тот же список, ' +
          'что и логгер, а не полагаться на дисциплину вызывающего кода.',
      ).not.toContain(sentinel);
    }
  });

  it('прореживается: повтор той же комбинации нового примера не создаёт', async () => {
    function repeated(): Error {
      return new Error('внешний сервис не ответил');
    }

    for (let i = 0; i < 50; i += 1) await report(repeated());
    await issues();

    expect(
      await samples(),
      'на каждое появление записан пример: прореживание в INSERT ... WHERE NOT EXISTS ' +
        'не работает, и таблица примеров растёт со скоростью потока отказов',
    ).toHaveLength(1);
  });

  it('шторм одного отпечатка не превращается в запись на событие', async () => {
    function storm(): Error {
      return new Error('пул соединений исчерпан');
    }

    for (let i = 0; i < 1_000; i += 1) await report(storm());
    const before = queries;
    await issues();

    expect(
      queries - before,
      'число обращений к БД растёт вместе с числом отказов: во время шторма ' +
        'журнал усиливает нагрузку на ту самую базу, которую диагностирует',
    ).toBeLessThan(20);

    const rows = await db.query<{ count: string }>(
      'select sum(count)::text as count from error_stats_hourly',
    );
    expect(Number(rows[0]?.count)).toBe(1_000);
  });
});

describe('оси классификации', () => {
  it('распознаёт ошибку драйвера PostgreSQL по форме объекта, а не по имени класса', async () => {
    // Форма объекта ошибки `pg`: SQLSTATE плюс поля, которые кладёт драйвер.
    // Имя класса намеренно постороннее — классификация не имеет права на него
    // опираться, иначе новый класс драйвера молча выпадет из среза.
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      name: 'SomeVendorError',
      code: '23505',
      severity: 'ERROR',
      constraint: 'ux_jobs_dedupe_key',
    });

    await report(driverError);
    const [row] = await issues();

    expect(row?.domain).toBe('db');
  });

  it('принимает источник из настроек писателя, а не из каждого вызова', async () => {
    const workerWriter = newWriter({ source: 'worker' });
    const workerReporter = new JournalErrorReporter(workerWriter, 'worker');

    await workerReporter.report(new Error('падение фоновой задачи'));
    await workerWriter.flush();

    const rows = await issues();

    expect(rows.map((row) => row.source)).toStrictEqual(['worker']);
  });
});

describe('переоткрытие закрытой проблемы', () => {
  it('возвращает статус в new, сохраняет решение и пишет действие reopen', async () => {
    function regression(): Error {
      return new Error('повторяющаяся регрессия экспорта');
    }

    await report(regression());
    await issues();

    const fingerprintRows = await db.query<{ fingerprint: string }>(
      'select fingerprint from error_signatures',
    );
    const issueId = issueIdForFingerprint(String(fingerprintRows[0]?.fingerprint));

    // Закрываем так, как это сделал бы администратор: с автором и решением.
    // Ограничение error_issues_resolved_chk требует автора, и обойти его в
    // тесте значило бы проверять состояние, которого в БД быть не может.
    await db.query(
      `update error_issues
          set status = 'resolved', resolved_at = now(),
              resolved_by = $4, resolution = $2, root_cause = $3
        where id = $1`,
      [
        issueId,
        'добавлена проверка пустого реестра',
        'экспорт не проверял размер выборки',
        ADMIN_ID,
      ],
    );

    await report(regression());
    await issues();

    const [issue] = await db.query<{ status: string; resolution: string | null }>(
      'select status, resolution from error_issues where id = $1',
      [issueId],
    );
    expect(issue?.status).toBe('new');
    expect(
      issue?.resolution,
      'при переоткрытии стёрто прежнее решение: «чем это чинили в прошлый раз» ' +
        'и есть то немногое, ради чего журнал хранят год',
    ).toBe('добавлена проверка пустого реестра');

    const actions = await db.query<{ action: string }>(
      'select action from error_issue_actions where issue_id = $1',
      [issueId],
    );
    expect(actions.map((a) => a.action)).toStrictEqual(['reopen']);
  });

  it('не пишет reopen повторно, пока проблема снова не закрыта', async () => {
    function flapping(): Error {
      return new Error('мигающая ошибка планировщика');
    }

    await report(flapping());
    await issues();
    await report(flapping());
    await issues();
    await report(flapping());
    await issues();

    const actions = await db.query<{ action: string }>('select action from error_issue_actions');
    expect(
      actions,
      'действие reopen пишется на каждый сброс: RETURNING в UPDATE отдаёт новые ' +
        'значения, и признак «был resolved» обязан читаться из снимка до обновления',
    ).toStrictEqual([]);
  });
});

describe('защита от потока уникальных сигнатур', () => {
  it('сверх лимита события учитываются служебной проблемой, а не плодят строки', async () => {
    const limited = newWriter({ newSignatureLimitPerHour: 2 });
    const limitedReporter = new JournalErrorReporter(limited, 'api');

    // Сообщения различаются нечисловой частью, поэтому нормализация их не
    // склеит: ровно так выглядит дефект, оставляющий значение в тексте.
    for (const suffix of ['alfa', 'bravo', 'charlie', 'delta', 'echo']) {
      await limitedReporter.report(new Error(`неизвестный вид ИД ${suffix}`));
    }
    await limited.flush();

    const signatures = await db.query<{ n: string }>(
      'select count(*)::text as n from error_signatures',
    );
    expect(Number(signatures[0]?.n)).toBe(2);

    const overflow = await db.query<{ count: string }>(
      'select coalesce(sum(count), 0)::text as count from error_stats_hourly where issue_id = $1',
      [OVERFLOW_ISSUE_ID],
    );
    expect(
      Number(overflow[0]?.count),
      'события сверх лимита исчезли: «журнал пуст» и «журнал захлебнулся» — ' +
        'разные утверждения, и второе обязано быть видно',
    ).toBe(3);
  });
});

describe('сбой записи', () => {
  it('не бросает наружу и считается потерей', async () => {
    let dropped = 0;
    const broken = new ErrorJournalWriter({
      sql: {
        query: () => Promise.reject(new Error('база недоступна')),
      },
      logger,
      source: 'api',
      metrics: {
        observeJournalDropped(count) {
          dropped += count;
        },
      },
    });
    const brokenReporter = new JournalErrorReporter(broken, 'api');

    await brokenReporter.report(new Error('падение при недоступной базе'));
    await expect(broken.flush()).resolves.toBeUndefined();

    expect(dropped).toBe(1);
    expect(logLines.some((line) => line.event === 'journal_write_failed')).toBe(true);
  });
});
