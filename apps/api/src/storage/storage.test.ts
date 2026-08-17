/**
 * Хранилище файлов: ключи, оба драйвера и измерение (§7, §11, §13).
 *
 * Приём файлов целиком проверяется в `modules/files/files.test.ts` через HTTP, и
 * там работает драйвер `local`. Но боевой драйвер — `s3`, и через HTTP он
 * недостижим: сети в тестах нет. Поэтому здесь он проверяется с подменённым
 * транспортом, и проверяется именно то, что нельзя увидеть по ответу портала:
 * какой запрос уходит в хранилище.
 *
 * Что здесь считается существенным:
 *
 * 1. **Ключ строится только из uuid и sha256** (§13). Имя файла в него не
 *    попадает ни при каких входных данных, а `..` в ключе не превращается в
 *    запись за пределы каталога.
 * 2. **Presigned GET отсутствует как метод.** §4.2 запрещает отдавать наружу
 *    ссылку, действующую мимо RBAC; гарантией служит отсутствие метода, и тест
 *    фиксирует именно это, чтобы «удобный» presignGet не появился позже.
 * 3. **Ответ хранилища не переписывается желаемым.** Если на запрос диапазона
 *    пришёл объект целиком, провайдер обязан сказать «диапазона нет»: иначе
 *    маршрут выдачи пометит 206 тело, которое диапазоном не является.
 * 4. **Ошибка хранилища не выносит наружу ни адреса, ни подписи** (§11).
 * 5. **Каждая операция измеряется** порогом `SLOW_EXTERNAL_MS` — включая
 *    драйвер `local`: «на диске кончилось место» обязано выглядеть в журнале
 *    так же, как отказ S3.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { createHash, createHmac, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { runWithContext } from '../observability/context.js';
import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import { assertStorageKey, blobKey, isUploadKey, uploadKey } from './keys.js';
import { LocalStorageProvider, LOCAL_UPLOAD_PATH } from './local.js';
import { S3StorageProvider } from './s3.js';
import {
  instrumentStorage,
  isStorageError,
  StorageError,
  type ObjectStream,
  type StorageProvider,
} from './provider.js';

const SHA256 = createHash('sha256').update('содержимое одной поставки').digest('hex');
const SECRET = createHmac('sha256', 'unit-test-secret').update('storage-tests').digest();
const REVISION = '00000000-0000-4000-8000-0000000000c1';

const ROOTS: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'id-storage-tests-'));
  ROOTS.push(dir);
  return dir;
}

function localProvider(): LocalStorageProvider {
  return new LocalStorageProvider({
    directory: tempRoot(),
    publicUrl: 'http://localhost:3000',
    secret: SECRET,
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

// =====================================================================
// Ключи
// =====================================================================

describe('ключи объектов', () => {
  it('строятся из sha256 и не содержат ни имени файла, ни кода объекта', () => {
    const key = blobKey(SHA256);
    expect(key).toBe(`blobs/${SHA256.slice(0, 2)}/${SHA256.slice(2, 4)}/${SHA256}`);
    // Ключ детерминирован: на этом стоит дедупликация §3.3.
    expect(blobKey(SHA256)).toBe(key);
    expect(key).not.toMatch(/pdf|АОСР|кровля/i);
  });

  it('отвергают не-sha256 и не-uuid', () => {
    expect(() => blobKey('../../etc/passwd')).toThrow();
    expect(() => blobKey(SHA256.toUpperCase())).toThrow();
    expect(() => uploadKey('не-uuid')).toThrow();
    expect(uploadKey('9f4b7c2e-0000-4000-8000-00000000abcd')).toMatch(/^uploads\//);
    expect(isUploadKey(uploadKey(randomUUID()))).toBe(true);
    expect(isUploadKey(blobKey(SHA256))).toBe(false);
  });

  it('не пропускают обход каталога и абсолютный путь', () => {
    for (const bad of ['../secrets', 'blobs/../../etc', '/absolute', 'blobs//double', '']) {
      expect(() => assertStorageKey(bad)).toThrow();
    }
    // В сообщении не должно быть самого ключа: он приходит снаружи и уезжает в журнал.
    try {
      assertStorageKey('../secrets');
      expect.unreachable('ожидался отказ');
    } catch (error) {
      expect((error as Error).message).not.toContain('secrets');
    }
  });
});

// =====================================================================
// Драйвер local
// =====================================================================

describe('драйвер local', () => {
  it('кладёт, отдаёт, копирует и удаляет объект', async () => {
    const storage = localProvider();
    const key = uploadKey(randomUUID());
    const body = Buffer.from('%PDF-1.6 синтетический файл', 'utf8');

    const head = await storage.putObject({ key, body, contentType: 'application/pdf' });
    expect(head.sizeBytes).toBe(body.byteLength);

    const whole = await storage.getObjectStream(key);
    expect(await collect(whole.stream)).toEqual(body);
    expect(whole.range).toBeNull();

    const target = blobKey(SHA256);
    await storage.copyObject(key, target, 'application/pdf');
    expect((await storage.headObject(target))?.sizeBytes).toBe(body.byteLength);

    await storage.deleteObject(key);
    expect(await storage.headObject(key)).toBeNull();
    // Повторное удаление — не ошибка: сборка мусора обязана быть идемпотентной.
    await expect(storage.deleteObject(key)).resolves.toBeUndefined();
  });

  it('отдаёт запрошенный диапазон и общий размер объекта', async () => {
    const storage = localProvider();
    const key = uploadKey(randomUUID());
    const body = Buffer.from('0123456789', 'utf8');
    await storage.putObject({ key, body, contentType: 'application/pdf' });

    const part = await storage.getObjectStream(key, { start: 2, end: 5 });
    expect(await collect(part.stream)).toEqual(Buffer.from('2345', 'utf8'));
    expect(part.contentLength).toBe(4);
    expect(part.sizeBytes).toBe(10);
  });

  it('не пишет за пределы каталога, даже если ключ собрали руками', async () => {
    const storage = localProvider();
    await expect(
      storage.putObject({
        key: '../escaped',
        body: Buffer.from('x'),
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow();
  });

  it('ошибка тела запроса не превращается в отказ хранилища', async () => {
    // Регрессия: обёртка «локальное хранилище недоступно» переводила превышение
    // потолка загрузки в 500 вместо 413, то есть в аварию портала вместо
    // ошибки подрядчика.
    const storage = localProvider();
    class TooLarge extends Error {}
    const failing = Readable.from(
      (async function* body() {
        yield Buffer.from('%PDF-');
        throw new TooLarge('потолок');
      })(),
    );

    await expect(
      storage.putObject({
        key: uploadKey(randomUUID()),
        body: failing,
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(TooLarge);
  });

  it('оборванная запись не оставляет по ключу половину файла', async () => {
    const storage = localProvider();
    const key = uploadKey(randomUUID());
    const failing = Readable.from(
      (async function* body() {
        yield Buffer.from('половина');
        throw new Error('обрыв');
      })(),
    );

    await expect(
      storage.putObject({ key, body: failing, contentType: 'application/pdf' }),
    ).rejects.toThrow();
    expect(await storage.headObject(key)).toBeNull();
  });

  it('«презигнутый» адрес ведёт на маршрут портала и несёт подписанный токен', async () => {
    const storage = localProvider();
    const key = uploadKey(randomUUID());
    const presigned = await storage.presignPut({ key, expiresInSeconds: 60, maxBytes: 1024 });

    const url = new URL(presigned.url);
    expect(url.pathname).toBe(LOCAL_UPLOAD_PATH);
    expect(presigned.method).toBe('PUT');

    const token = url.searchParams.get('token') ?? '';
    expect(storage.localUploads.verifyToken(token)).toEqual({ key, maxBytes: 1024 });
  });

  it('подделанный, испорченный и просроченный токен не принимаются', async () => {
    const storage = localProvider();
    const key = uploadKey(randomUUID());
    const { url } = await storage.presignPut({ key, expiresInSeconds: 60, maxBytes: 1024 });
    const token = new URL(url).searchParams.get('token') ?? '';
    const [body = '', signature = ''] = token.split('.');

    // Тело изменено, подпись прежняя: ключ, на который выдано право, подменить нельзя.
    const forgedBody = Buffer.from(
      JSON.stringify({ k: blobKey(SHA256), e: Date.now() + 60_000, m: 1024 }),
      'utf8',
    ).toString('base64url');
    expect(storage.localUploads.verifyToken(`${forgedBody}.${signature}`)).toBeNull();
    expect(storage.localUploads.verifyToken(`${body}.${signature}x`)).toBeNull();
    expect(storage.localUploads.verifyToken(body)).toBeNull();

    // Другой процесс — другой секрет: чужой токен здесь недействителен.
    const other = new LocalStorageProvider({
      directory: tempRoot(),
      publicUrl: 'http://localhost:3000',
      secret: createHmac('sha256', 'другой-секрет').update('x').digest(),
    });
    expect(other.localUploads.verifyToken(token)).toBeNull();
  });

  it('срок токена истекает', async () => {
    const storage = localProvider();
    const key = uploadKey(randomUUID());
    const { url } = await storage.presignPut({ key, expiresInSeconds: -1, maxBytes: 1024 });
    const token = new URL(url).searchParams.get('token') ?? '';
    expect(storage.localUploads.verifyToken(token)).toBeNull();
  });

  it('файлы лежат под ключом, а не под именем, которое назвал пользователь', async () => {
    const root = tempRoot();
    const storage = new LocalStorageProvider({
      directory: root,
      publicUrl: 'http://localhost:3000',
      secret: SECRET,
    });
    const key = blobKey(SHA256);
    await storage.putObject({
      key,
      body: Buffer.from('%PDF-1.6'),
      contentType: 'application/pdf',
    });
    expect(readFileSync(join(root, ...key.split('/'))).toString('utf8')).toBe('%PDF-1.6');
  });
});

// =====================================================================
// Драйвер s3
// =====================================================================

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function s3Provider(respond: (request: Captured) => Response): {
  provider: S3StorageProvider;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const provider = new S3StorageProvider({
    endpoint: 'https://storage.yandexcloud.net',
    bucket: 'id-portal',
    accessKey: 'unit-test-access-key-id',
    secretKey: 'unit-test-access-key-material',
    region: 'ru-central1',
    fetchImpl: ((url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = value;
      }
      const captured: Captured = { url, method: init.method ?? 'GET', headers };
      calls.push(captured);
      return Promise.resolve(respond(captured));
    }) as unknown as typeof fetch,
  });
  return { provider, calls };
}

describe('драйвер s3', () => {
  it('подписывает PUT и объявляет хэш тела', async () => {
    const { provider, calls } = s3Provider(() => new Response(null, { status: 200 }));
    const body = Buffer.from('%PDF-1.6 тело', 'utf8');
    const key = blobKey(SHA256);

    await provider.putObject({ key, body, contentType: 'application/pdf' });

    const call = calls[0];
    expect(call?.method).toBe('PUT');
    expect(call?.url).toBe(`https://storage.yandexcloud.net/id-portal/${key}`);
    expect(call?.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=unit-test-access-key-id\/\d{8}\/ru-central1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(call?.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(body).digest('hex'),
    );
    expect(call?.headers['content-length']).toBe(String(body.byteLength));
    // Секрет подписи в запрос не уходит ни одним заголовком.
    expect(JSON.stringify(call?.headers)).not.toContain('unit-test-access-key-material');
  });

  it('передаёт диапазон и возвращает его вместе с общим размером', async () => {
    const { provider, calls } = s3Provider(
      () =>
        new Response('2345', {
          status: 206,
          headers: { 'content-length': '4', 'content-range': 'bytes 2-5/10' },
        }),
    );

    const object = await provider.getObjectStream(blobKey(SHA256), { start: 2, end: 5 });
    expect(calls[0]?.headers['range']).toBe('bytes=2-5');
    expect(object.range).toEqual({ start: 2, end: 5 });
    expect(object.sizeBytes).toBe(10);
    expect(await collect(object.stream)).toEqual(Buffer.from('2345', 'utf8'));
  });

  it('объект целиком в ответ на диапазон не выдаётся за диапазон', async () => {
    // Хранилище вправе проигнорировать `Range` (RFC 9110). Соврать здесь значит
    // отдать браузеру 206 с телом, которое диапазоном не является.
    const { provider } = s3Provider(
      () => new Response('0123456789', { status: 200, headers: { 'content-length': '10' } }),
    );

    const object = await provider.getObjectStream(blobKey(SHA256), { start: 2, end: 5 });
    expect(object.range).toBeNull();
    expect(object.contentLength).toBe(10);
  });

  it('отсутствие объекта — это ответ, а не ошибка', async () => {
    const { provider } = s3Provider(() => new Response(null, { status: 404 }));
    expect(await provider.headObject(blobKey(SHA256))).toBeNull();
    // Удаление отсутствующего объекта тоже проходит: повтор обязан быть безопасным.
    await expect(provider.deleteObject(blobKey(SHA256))).resolves.toBeUndefined();
  });

  it('копирует объект серверной операцией и переписывает тип содержимого', async () => {
    const { provider, calls } = s3Provider(
      (request) =>
        new Response(null, {
          status: 200,
          headers: request.method === 'HEAD' ? { 'content-length': '13' } : {},
        }),
    );

    const source = uploadKey(randomUUID());
    const target = blobKey(SHA256);
    const head = await provider.copyObject(source, target, 'application/pdf');

    expect(calls[0]?.headers['x-amz-copy-source']).toBe(`/id-portal/${source}`);
    // Иначе объект унаследовал бы тип, который назвал клиент при загрузке.
    expect(calls[0]?.headers['x-amz-metadata-directive']).toBe('REPLACE');
    expect(head.sizeBytes).toBe(13);
  });

  it('presignPut подписывает адрес и не выносит наружу секрет', async () => {
    const { provider } = s3Provider(() => new Response(null, { status: 200 }));
    const key = uploadKey(randomUUID());

    const presigned = await provider.presignPut({ key, expiresInSeconds: 3600, maxBytes: 1024 });
    const url = new URL(presigned.url);

    expect(url.pathname).toBe(`/id-portal/${key}`);
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(presigned.url).not.toContain('unit-test-access-key-material');
    // Имя файла в адрес не попадает по построению: ключ строится из uuid.
    expect(presigned.url).not.toMatch(/\.pdf/i);
  });

  it('presignGet отсутствует как метод — это и есть гарантия §4.2', () => {
    const { provider } = s3Provider(() => new Response(null, { status: 200 }));
    expect('presignGet' in provider).toBe(false);
    expect((provider as unknown as Record<string, unknown>)['presignGet']).toBeUndefined();
  });

  it('отказ хранилища не выносит наружу ни адреса, ни подписи', async () => {
    const { provider } = s3Provider(
      () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }),
    );

    try {
      await provider.putObject({
        key: blobKey(SHA256),
        body: Buffer.from('x'),
        contentType: 'application/pdf',
      });
      expect.unreachable('ожидался отказ хранилища');
    } catch (error) {
      expect(isStorageError(error)).toBe(true);
      const failure = error as StorageError;
      expect(failure.code).toBe('rejected');
      expect(failure.statusCode).toBe(403);
      expect(failure.message).not.toContain('X-Amz-Signature');
      expect(failure.message).not.toContain('storage.yandexcloud.net');
    }
  });

  it('поток без известной длины отвергается до сети', async () => {
    const { provider, calls } = s3Provider(() => new Response(null, { status: 200 }));
    await expect(
      provider.putObject({
        key: blobKey(SHA256),
        body: Readable.from([Buffer.from('x')]),
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// =====================================================================
// Измерение
// =====================================================================

describe('измерение операций хранилища', () => {
  function harness(slowExternalMs: number) {
    const lines: string[] = [];
    const logger = createLogger({
      service: 'api-test',
      level: 'debug',
      destination: new Writable({
        write(chunk, _encoding, callback) {
          lines.push(String(chunk));
          callback();
        },
      }),
    });
    const metrics = createMetrics({ enabled: true, service: 'api-test' });
    return { lines, logger, metrics, slowExternalMs };
  }

  /** Провайдер, который ничего не делает, но делает это заметно долго. */
  function slowProvider(delayMs: number): StorageProvider {
    const head = { key: 'k', sizeBytes: 1, contentType: null, etag: null };
    const wait = <T>(value: T): Promise<T> =>
      new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
    return {
      driver: 'local',
      localUploads: undefined,
      putObject: () => wait(head),
      getObjectStream: () => wait({} as ObjectStream),
      headObject: () => wait(head),
      deleteObject: () => wait(undefined),
      copyObject: () => wait(head),
      presignPut: () => wait({ url: 'x', method: 'PUT' as const, headers: {}, expiresAt: 'x' }),
    };
  }

  it('пишет длительность в метрики и относит `local` к внешним вызовам', async () => {
    const { logger, metrics, slowExternalMs } = harness(5000);
    const storage = instrumentStorage(slowProvider(0), { metrics, logger, slowExternalMs });

    await storage.headObject(blobKey(SHA256));
    const payload = await metrics.render();

    expect(payload.body).toContain('external_call_duration_seconds');
    expect(payload.body).toMatch(/operation="head_object"/);
    expect(payload.body).toMatch(/service="local-storage"/);
  });

  it('превышение SLOW_EXTERNAL_MS переводит запись в предупреждение', async () => {
    const { lines, logger, metrics } = harness(5);
    const storage = instrumentStorage(slowProvider(20), {
      metrics,
      logger,
      slowExternalMs: 5,
    });

    await storage.putObject({
      key: blobKey(SHA256),
      body: Buffer.from('x'),
      contentType: 'application/pdf',
    });

    const slow = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'external_call_slow');
    expect(slow).toBeDefined();
    expect(slow?.['operation']).toBe('put_object');
    expect(slow?.['threshold_ms']).toBe(5);
    // Ключ в журнале допустим: он состоит из uuid и sha256 и ничего не рассказывает.
    expect(slow?.['storage_key']).toBe(blobKey(SHA256));
  });

  it('строка об операции связывается с запросом сквозным request_id', async () => {
    // §11: без этого путь 83-страничной поставки через хранилище и два десятка
    // job'ов не проследить. Логгер операции создаётся ВНУТРИ вызова — иначе
    // поля берутся в момент сборки приложения, когда запроса ещё нет.
    const { lines, logger, metrics } = harness(5000);
    const storage = instrumentStorage(slowProvider(0), { metrics, logger, slowExternalMs: 5000 });

    await runWithContext({ requestId: 'req-storage-test', revisionId: REVISION }, async () => {
      await storage.headObject(blobKey(SHA256));
    });

    const entry = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row['event'] === 'external_call');
    expect(entry?.['request_id']).toBe('req-storage-test');
    expect(entry?.['revision_id']).toBe(REVISION);
    expect(entry?.['component']).toBe('storage');
  });

  it('отказ измеряется тоже, и класс ошибки попадает в журнал', async () => {
    const { lines, logger, metrics } = harness(5000);
    const base = slowProvider(0);
    const failing: StorageProvider = {
      ...base,
      deleteObject: () =>
        Promise.reject(new StorageError('unavailable', 'delete_object', 'Хранилище недоступно')),
    };
    const storage = instrumentStorage(failing, { metrics, logger, slowExternalMs: 5000 });

    await expect(storage.deleteObject(blobKey(SHA256))).rejects.toBeInstanceOf(StorageError);

    const failed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['event'] === 'external_call_failed');
    expect(failed?.['error_class']).toBe('StorageError');
    expect(await metrics.render()).toBeDefined();
  });
});

// =====================================================================
// Хранилище не доверяет тому, что лежит рядом
// =====================================================================

describe('чтение чужого содержимого каталога', () => {
  it('файл, положенный мимо портала, читается только по допустимому ключу', async () => {
    const root = tempRoot();
    const storage = new LocalStorageProvider({
      directory: root,
      publicUrl: 'http://localhost:3000',
      secret: SECRET,
    });
    writeFileSync(join(root, 'подброшенный.txt'), 'секрет');

    // Имя не проходит правило ключа (кириллица), значит недостижимо через провайдер.
    await expect(storage.getObjectStream('подброшенный.txt')).rejects.toThrow();
  });
});
