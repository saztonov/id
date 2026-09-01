/**
 * Redaction логгера (§11): проверяется поведение, а не наличие списка.
 *
 * Строки перехватываются собственным приёмником pino, а не подменой console:
 * список redaction — это опция самого логгера, и объявление ключа в массиве
 * ничего не доказывает. Ошибиться можно в форме пути (`token` против `*.token`),
 * в цензоре, в глубине вложенности — и каждый такой промах виден только в том,
 * что реально ушло в поток.
 *
 * Секретные значения в тестах — часовые: уникальные строки, которых в выводе
 * не должно быть нигде. Проверяется весь сериализованный JSON, а не отдельные
 * поля, потому что утечка обычно происходит не там, где её ищут: в дочерних
 * bindings, в сериализаторе ошибки, в подстановке в текст сообщения.
 */
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { REDACTED, createLogger } from './logger.js';

interface Captured {
  readonly record: Record<string, unknown>;
  /** Сериализованная строка целиком: в ней ищутся часовые. */
  readonly text: string;
}

function capture(fields: Record<string, unknown>, extraRedactPaths?: readonly string[]): Captured {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  const logger = createLogger({
    service: 'api-test',
    level: 'trace',
    destination,
    ...(extraRedactPaths === undefined ? {} : { extraRedactPaths }),
  });
  logger.info(fields, 'строка для проверки redaction');

  expect(chunks, 'логгер не записал ровно одну строку').toHaveLength(1);
  const text = chunks.join('');
  return { record: JSON.parse(text) as Record<string, unknown>, text };
}

/** Часовые: значения, встречающиеся в выводе только если redaction не сработала. */
const SENTINELS = {
  password: 'chasovoy-parol-0001',
  authorization: 'chasovoy-bearer-0002',
  cookie: 'chasovoy-cookie-0003',
  setCookie: 'chasovoy-set-cookie-0004',
  accessToken: 'chasovoy-access-0005',
  refreshToken: 'chasovoy-refresh-0006',
  idToken: 'chasovoy-id-token-0007',
  csrfToken: 'chasovoy-csrf-0008',
  clientSecret: 'chasovoy-client-secret-0009',
  signature: 'chasovoy-sigv4-0010',
} as const;

function presigned(signature: string): string {
  return `https://storage.example.net/id/9f1c/orig.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${signature}`;
}

describe('секреты не попадают в вывод', () => {
  it('вычёркивает пароль, Authorization, cookie и set-cookie', () => {
    const { record, text } = capture({
      password: SENTINELS.password,
      authorization: `Bearer ${SENTINELS.authorization}`,
      cookie: `id_session=${SENTINELS.cookie}`,
      'set-cookie': `id_session=${SENTINELS.setCookie}; HttpOnly`,
    });

    expect(record.password).toBe(REDACTED);
    expect(record.authorization).toBe(REDACTED);
    expect(record.cookie).toBe(REDACTED);
    expect(record['set-cookie']).toBe(REDACTED);

    for (const sentinel of [
      SENTINELS.password,
      SENTINELS.authorization,
      SENTINELS.cookie,
      SENTINELS.setCookie,
    ]) {
      expect(text, `значение ${sentinel} осталось в строке лога`).not.toContain(sentinel);
    }
  });

  it('вычёркивает те же заголовки во вложенных объектах запроса и ответа', () => {
    // Форма, в которой их кладёт pino-http: `req.headers.*` и `res.headers.*`.
    const { record, text } = capture({
      req: {
        headers: {
          authorization: `Bearer ${SENTINELS.authorization}`,
          cookie: `id_session=${SENTINELS.cookie}`,
        },
      },
      res: { headers: { 'set-cookie': `id_session=${SENTINELS.setCookie}; HttpOnly` } },
    });

    const req = record.req as { headers: Record<string, unknown> };
    const res = record.res as { headers: Record<string, unknown> };

    expect(req.headers.authorization).toBe(REDACTED);
    expect(req.headers.cookie).toBe(REDACTED);
    expect(res.headers['set-cookie']).toBe(REDACTED);
    expect(text).not.toContain(SENTINELS.authorization);
    expect(text).not.toContain(SENTINELS.cookie);
    expect(text).not.toContain(SENTINELS.setCookie);
  });

  it('вычёркивает access- и refresh-токены в обоих написаниях', () => {
    const { record, text } = capture({
      accessToken: SENTINELS.accessToken,
      access_token: SENTINELS.accessToken,
      refreshToken: SENTINELS.refreshToken,
      refresh_token: SENTINELS.refreshToken,
      idToken: SENTINELS.idToken,
      csrfToken: SENTINELS.csrfToken,
      clientSecret: SENTINELS.clientSecret,
      session: { refreshTokenEnc: SENTINELS.refreshToken },
    });

    for (const key of [
      'accessToken',
      'access_token',
      'refreshToken',
      'refresh_token',
      'idToken',
      'csrfToken',
      'clientSecret',
    ]) {
      expect(record[key], `поле ${key} не вычеркнуто`).toBe(REDACTED);
    }

    for (const sentinel of [
      SENTINELS.accessToken,
      SENTINELS.refreshToken,
      SENTINELS.idToken,
      SENTINELS.csrfToken,
      SENTINELS.clientSecret,
    ]) {
      expect(text, `значение ${sentinel} осталось в строке лога`).not.toContain(sentinel);
    }
  });
});

describe('presigned URL', () => {
  it('вычёркивает подпись во всех полях-адресах верхнего уровня', () => {
    const { record, text } = capture({
      url: presigned(SENTINELS.signature),
      uploadUrl: presigned(SENTINELS.signature),
      downloadUrl: presigned(SENTINELS.signature),
      cropUrl: presigned(SENTINELS.signature),
      presignedUrl: presigned(SENTINELS.signature),
    });

    for (const key of ['url', 'uploadUrl', 'downloadUrl', 'cropUrl', 'presignedUrl']) {
      expect(record[key], `поле ${key} отдано в лог с подписью`).toBe(
        `https://storage.example.net/id/9f1c/orig.pdf?${REDACTED}`,
      );
    }
    expect(text).not.toContain(SENTINELS.signature);
    expect(text).not.toContain('X-Amz-Signature');
  });

  it('вычёркивает подпись во вложенном поле-адресе', () => {
    // Ровно та форма, в которой адрес кропа приезжает от адаптера RD WEB.
    const { record, text } = capture({
      rd: { crop: { url: presigned(SENTINELS.signature) } },
      s3: { upload: { uploadUrl: presigned(SENTINELS.signature) } },
    });

    const rd = record.rd as { crop: { url: string } };
    const s3 = record.s3 as { upload: { uploadUrl: string } };

    expect(rd.crop.url).toContain(REDACTED);
    expect(s3.upload.uploadUrl).toContain(REDACTED);
    expect(text).not.toContain(SENTINELS.signature);
  });

  it('оставляет схему, хост и путь: без них запись бесполезна для разбора', () => {
    const { record } = capture({ downloadUrl: presigned(SENTINELS.signature) });

    expect(record.downloadUrl).toContain('https://storage.example.net/id/9f1c/orig.pdf');
  });

  it('не портит адрес без query-строки', () => {
    const { record } = capture({ url: 'https://storage.example.net/id/9f1c/orig.pdf' });

    expect(record.url).toBe('https://storage.example.net/id/9f1c/orig.pdf');
  });

  it('секрет закрыт на любой глубине, а не до третьего уровня', () => {
    // Раньше здесь закреплялась граница NESTING_DEPTH: глубже третьего уровня
    // требовался явный путь в extraRedactPaths. Ограничение снято — очистка
    // стала рекурсивной по значению, а не подстановкой по списку путей.
    // Причина: форма  — стандартный объект
    // ошибки HTTP-клиента, и она приходит с интеграциями RD WEB и proxy_llm,
    // где Authorization передаётся в каждом вызове.
    const deep = { rd: { page: { crop: { url: presigned(SENTINELS.signature) } } } };
    const deeper = { a: { b: { c: { d: { e: { password: SENTINELS.signature } } } } } };

    expect(capture(deep).text).not.toContain(SENTINELS.signature);
    expect(capture(deeper).text).not.toContain(SENTINELS.signature);
  });
});

describe('redaction не съедает диагностику', () => {
  it('оставляет обычные поля как есть', () => {
    const { record } = capture({
      event: 'block_result_stored',
      object_id: '7f000000-0000-4000-8000-000000000001',
      folder_id: '7f000000-0000-4000-8000-000000000002',
      route: '/api/folders/:folderId/blocks',
      status_code: 200,
      duration_ms: 137,
      page_number: 42,
      doc_type_code: 'aosr',
      attempt: 2,
      ok: true,
      pages: [1, 2, 3],
    });

    expect(record).toMatchObject({
      event: 'block_result_stored',
      object_id: '7f000000-0000-4000-8000-000000000001',
      folder_id: '7f000000-0000-4000-8000-000000000002',
      route: '/api/folders/:folderId/blocks',
      status_code: 200,
      duration_ms: 137,
      page_number: 42,
      doc_type_code: 'aosr',
      attempt: 2,
      ok: true,
      pages: [1, 2, 3],
    });
  });

  it('сохраняет служебные поля строки', () => {
    const { record } = capture({ event: 'probe' });

    expect(record.service).toBe('api-test');
    expect(record.level).toBe('info');
    expect(record.msg).toBe('строка для проверки redaction');
    expect(typeof record.time).toBe('string');
  });
});
