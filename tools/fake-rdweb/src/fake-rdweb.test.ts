/**
 * Двойник проверяется ПРОГОНОМ через настоящий HTTP — `fetch` на `fake.url`.
 *
 * Обращаться к внутренним объектам вместо сети здесь нельзя: смысл двойника ровно в
 * том, что он ведёт себя как удалённый сервис — с кодами ответов, заголовками,
 * телом presigned PUT и поллингом. Тест, зовущий обработчики напрямую, пропустил бы
 * и неправильный content-type, и потерянный 401, и подмену 422 на 400.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startFakeRdWeb, type FakeRdWeb } from './index.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MULTIPAGE_FIXTURE = join(REPO_ROOT, 'tools', 'fixtures', 'pdf', 'multipage.pdf');

const EMAIL = 'portal@example.test';
const PASSWORD = 'portal-secret';

const running: FakeRdWeb[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const fake = running.pop();
    await fake?.close();
  }
});

async function start(options: Parameters<typeof startFakeRdWeb>[0] = {}): Promise<FakeRdWeb> {
  const fake = await startFakeRdWeb(options);
  running.push(fake);
  return fake;
}

/**
 * Минимальный валидный многостраничный PDF.
 *
 * Собирается прямо здесь, потому что готовой фикстуры на 50 страниц в репозитории
 * нет, а число страниц двойник считает по НАСТОЯЩИМ байтам — подсунуть ему число
 * мимо файла невозможно (и не нужно: именно эту связь тест и проверяет).
 */
function makePdf(pageCount: number): Buffer {
  const kids = Array.from({ length: pageCount }, (_unused, index) => `${index + 3} 0 R`).join(' ');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [ ${kids} ] /Count ${pageCount} >>\nendobj\n`,
    ...Array.from(
      { length: pageCount },
      (_unused, index) =>
        `${index + 3} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 595 842 ] >>\nendobj\n`,
    ),
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('')}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

interface Session {
  readonly access: string;
  readonly refresh: string;
}

async function login(fake: FakeRdWeb): Promise<Session> {
  const response = await fetch(`${fake.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token };
}

async function api(
  fake: FakeRdWeb,
  session: Session,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.access}`,
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  return fetch(`${fake.url}${path}`, { ...init, headers });
}

async function createNode(fake: FakeRdWeb, session: Session): Promise<string> {
  const response = await api(fake, session, '/api/projects/nodes', {
    method: 'POST',
    body: JSON.stringify({ project_id: 'prj-portal', node_type: 'folder', name: 'Раздел 1' }),
  });
  expect(response.status).toBe(201);
  const node = (await response.json()) as { node_id: string };
  return node.node_id;
}

/** Полный цикл `init → PUT → complete`; возвращает `document_id`. */
async function uploadPdf(
  fake: FakeRdWeb,
  session: Session,
  nodeId: string,
  bytes: Buffer,
  fileName = 'akt.pdf',
): Promise<string> {
  const initResponse = await api(fake, session, '/api/documents/upload/init', {
    method: 'POST',
    body: JSON.stringify({
      project_id: 'prj-portal',
      node_id: nodeId,
      file_name: fileName,
      project_version: 'rev-1',
      size_bytes: bytes.length,
    }),
  });
  expect(initResponse.status).toBe(200);
  const init = (await initResponse.json()) as {
    document_id: string;
    upload_url: string;
    method: string;
    required_headers: Record<string, string>;
  };
  expect(init.method).toBe('PUT');
  expect(init.upload_url.startsWith(fake.url)).toBe(true);

  const putResponse = await fetch(init.upload_url, {
    method: 'PUT',
    headers: init.required_headers,
    body: new Uint8Array(bytes),
  });
  expect(putResponse.status).toBe(200);

  const completeResponse = await api(fake, session, '/api/documents/upload/complete', {
    method: 'POST',
    body: JSON.stringify({ document_id: init.document_id }),
  });
  expect(completeResponse.status).toBe(200);
  const complete = (await completeResponse.json()) as { status: string; size_bytes: number };
  expect(complete.status).toBe('rendering');
  expect(complete.size_bytes).toBe(bytes.length);
  return init.document_id;
}

interface DocumentDetail {
  status: string;
  page_count: number | null;
  pages: Array<{ page_index: number; render_status: string; has_preview: boolean }>;
}

/** Поллинг детали документа до `ready`; возвращает и число обращений, и результат. */
async function pollUntilReady(
  fake: FakeRdWeb,
  session: Session,
  documentId: string,
): Promise<{ detail: DocumentDetail; polls: number; renderingSeen: number }> {
  let polls = 0;
  let renderingSeen = 0;
  for (;;) {
    const response = await api(fake, session, `/api/documents/${documentId}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as DocumentDetail;
    polls += 1;
    if (detail.status === 'ready') {
      return { detail, polls, renderingSeen };
    }
    expect(detail.status).toBe('rendering');
    expect(detail.pages).toHaveLength(0);
    expect(detail.page_count).toBeNull();
    renderingSeen += 1;
    if (polls > 20) {
      throw new Error('документ так и не стал ready');
    }
  }
}

interface DetectResponse {
  created: Array<Record<string, unknown>>;
  skipped_pages: number[];
  warnings: string[];
  detect_job_id?: string;
}

async function detect(
  fake: FakeRdWeb,
  session: Session,
  documentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: DetectResponse }> {
  const response = await api(fake, session, `/api/documents/${documentId}/detect-blocks`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as DetectResponse };
}

/** Полная подготовка: вход, папка, загрузка фикстуры, ожидание рендера. */
async function readyDocument(
  fake: FakeRdWeb,
  bytes?: Buffer,
): Promise<{ session: Session; documentId: string; pageCount: number }> {
  const session = await login(fake);
  const nodeId = await createNode(fake, session);
  const payload =
    bytes ?? (existsSync(MULTIPAGE_FIXTURE) ? readFileSync(MULTIPAGE_FIXTURE) : makePdf(3));
  const documentId = await uploadPdf(fake, session, nodeId, payload);
  const { detail } = await pollUntilReady(fake, session, documentId);
  return { session, documentId, pageCount: detail.page_count ?? 0 };
}

describe('вход служебной учёткой', () => {
  it('выдаёт пару токенов и пускает на /api/auth/me', async () => {
    const fake = await start();
    const session = await login(fake);
    const response = await api(fake, session, '/api/auth/me');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: EMAIL, system_role: 'user' });
  });

  it('на неверный пароль отвечает 401 телом {detail}', async () => {
    const fake = await start();
    const response = await fetch(`${fake.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: 'wrong' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toHaveProperty('detail');
  });

  it('без токена защищённый маршрут отвечает 401', async () => {
    const fake = await start();
    const response = await fetch(`${fake.url}/api/auth/me`);
    expect(response.status).toBe(401);
  });
});

describe('загрузка документа', () => {
  it('проходит цикл init → PUT → complete на настоящем PDF', async () => {
    const fake = await start();
    const session = await login(fake);
    const nodeId = await createNode(fake, session);
    const bytes = existsSync(MULTIPAGE_FIXTURE) ? readFileSync(MULTIPAGE_FIXTURE) : makePdf(3);
    const documentId = await uploadPdf(fake, session, nodeId, bytes);

    const snapshot = fake.snapshot();
    const document = snapshot.documents.find((d) => d.documentId === documentId);
    expect(document).toMatchObject({ projectId: 'prj-portal', nodeId, sizeBytes: bytes.length });
    expect(document?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('отклоняет complete без байтов и файл без сигнатуры %PDF-', async () => {
    const fake = await start();
    const session = await login(fake);
    const nodeId = await createNode(fake, session);

    const initResponse = await api(fake, session, '/api/documents/upload/init', {
      method: 'POST',
      body: JSON.stringify({
        project_id: 'prj-portal',
        node_id: nodeId,
        file_name: 'pusto.pdf',
        project_version: 'rev-1',
      }),
    });
    const init = (await initResponse.json()) as { document_id: string; upload_url: string };

    const notUploaded = await api(fake, session, '/api/documents/upload/complete', {
      method: 'POST',
      body: JSON.stringify({ document_id: init.document_id }),
    });
    expect(notUploaded.status).toBe(422);

    await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array(Buffer.from('это не pdf', 'utf8')),
    });
    const notPdf = await api(fake, session, '/api/documents/upload/complete', {
      method: 'POST',
      body: JSON.stringify({ document_id: init.document_id }),
    });
    expect(notPdf.status).toBe(422);
    expect((await notPdf.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('%PDF-'),
    });
  });
});

describe('рендер и страницы', () => {
  it('поллинг доходит от rendering до ready, страниц ровно page_count', async () => {
    const fake = await start();
    const session = await login(fake);
    const nodeId = await createNode(fake, session);
    const documentId = await uploadPdf(fake, session, nodeId, makePdf(3));

    const { detail, renderingSeen } = await pollUntilReady(fake, session, documentId);
    expect(renderingSeen).toBeGreaterThan(0);
    expect(detail.page_count).toBe(3);
    expect(detail.pages).toHaveLength(3);
    expect(detail.pages.every((p) => p.render_status === 'ready' && p.has_preview)).toBe(true);

    const preview = await api(fake, session, `/api/documents/${documentId}/pages/0/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
  });

  it('превью до готовности рендера отвечает 409', async () => {
    const fake = await start();
    const session = await login(fake);
    const nodeId = await createNode(fake, session);
    const documentId = await uploadPdf(fake, session, nodeId, makePdf(2));
    const preview = await api(fake, session, `/api/documents/${documentId}/pages/0/preview`);
    expect(preview.status).toBe(409);
  });
});

describe('детекция блоков', () => {
  it('синхронная детекция пачкой возвращает координаты в 0..1 и без confidence', async () => {
    const fake = await start();
    const { session, documentId, pageCount } = await readyDocument(fake);
    const pages = Array.from({ length: pageCount }, (_unused, index) => index);

    const { status, payload } = await detect(fake, session, documentId, { page_indices: pages });
    expect(status).toBe(200);
    expect(payload.created.length).toBeGreaterThan(0);
    for (const block of payload.created) {
      expect(block).not.toHaveProperty('confidence');
      expect(block).not.toHaveProperty('model_id');
      expect(block).toMatchObject({ source: 'auto', status: 'draft', version: 1 });
      const coords = block['coords_norm'] as number[];
      expect(coords).toHaveLength(4);
      expect(coords.every((c) => c >= 0 && c <= 1)).toBe(true);
      expect(coords[0]).toBeLessThanOrEqual(coords[2] as number);
      expect(coords[1]).toBeLessThanOrEqual(coords[3] as number);
    }
  });

  it('превышение maxPagesPerDetectCall отвечает 422', async () => {
    const fake = await start({ maxPagesPerDetectCall: 2 });
    const { session, documentId, pageCount } = await readyDocument(fake, makePdf(5));
    expect(pageCount).toBe(5);

    const { status, payload } = await detect(fake, session, documentId, {
      page_indices: [0, 1, 2, 3, 4],
    });
    expect(status).toBe(422);
    expect(payload as unknown as { detail: string }).toMatchObject({
      detail: expect.stringContaining('меньшими пачками'),
    });
  });

  it('повторная детекция без overwrite_existing даёт skipped_pages, а не дубли', async () => {
    const fake = await start();
    const { session, documentId } = await readyDocument(fake, makePdf(3));

    const first = await detect(fake, session, documentId, { page_indices: [0] });
    expect(first.payload.created.length).toBeGreaterThan(0);
    const afterFirst = fake.snapshot().blocks.length;

    const second = await detect(fake, session, documentId, { page_indices: [0] });
    expect(second.status).toBe(200);
    expect(second.payload.created).toHaveLength(0);
    expect(second.payload.skipped_pages).toEqual([0]);
    expect(fake.snapshot().blocks).toHaveLength(afterFirst);
  });

  it('нерендеренная страница даёт предупреждение, async_mode — 202 и detect_job_id', async () => {
    const fake = await start();
    const { session, documentId } = await readyDocument(fake, makePdf(2));

    const outOfRange = await detect(fake, session, documentId, { page_indices: [0, 9] });
    expect(outOfRange.payload.warnings).toContain('Страница 9 не отрендерена — пропущена');

    const async = await detect(fake, session, documentId, { async_mode: true });
    expect(async.status).toBe(202);
    expect(async.payload.detect_job_id).toBeTruthy();
    expect(async.payload.created).toHaveLength(0);
  });

  it('на 50 страницах детекция даёт все три типа блоков (гейт S6)', async () => {
    const fake = await start({ maxPagesPerDetectCall: 50 });
    const { session, documentId, pageCount } = await readyDocument(fake, makePdf(50));
    expect(pageCount).toBe(50);

    const { status, payload } = await detect(fake, session, documentId, {});
    expect(status).toBe(200);
    const types = new Set(payload.created.map((b) => b['block_type']));
    expect([...types].sort()).toEqual(['image', 'stamp', 'text']);
  });
});

describe('массовые операции и CRUD блоков', () => {
  it('full-page-text удаляет прежние блоки и оставляет один TEXT-блок на страницу', async () => {
    const fake = await start();
    const { session, documentId, pageCount } = await readyDocument(fake, makePdf(3));
    await detect(fake, session, documentId, {});
    expect(fake.snapshot().blocks.length).toBeGreaterThan(pageCount);

    const response = await api(
      fake,
      session,
      `/api/documents/${documentId}/blocks/full-page-text`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ pages_total: pageCount });

    const blocks = fake.snapshot().blocks;
    expect(blocks).toHaveLength(pageCount);
    for (const block of blocks) {
      expect(block.block_type).toBe('text');
      expect(block.coords_norm).toEqual([0, 0, 1, 1]);
      expect(block.source).toBe('auto');
    }

    const purge = await api(fake, session, `/api/documents/${documentId}/blocks/purge`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(purge.status).toBe(202);
    expect(fake.snapshot().blocks).toHaveLength(0);
  });

  it('PATCH с устаревшим expected_version отвечает 409 с текущим блоком', async () => {
    const fake = await start();
    const { session, documentId } = await readyDocument(fake, makePdf(2));

    const createResponse = await api(fake, session, `/api/documents/${documentId}/blocks`, {
      method: 'POST',
      body: JSON.stringify({
        page_index: 0,
        block_type: 'text',
        coords_norm: [0.1, 0.1, 0.5, 0.4],
      }),
    });
    expect(createResponse.status).toBe(201);
    const block = (await createResponse.json()) as { block_id: string; version: number };
    expect(block.version).toBe(1);

    const firstPatch = await api(fake, session, `/api/blocks/${block.block_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expected_version: 1, coords_norm: [0.2, 0.2, 0.6, 0.5] }),
    });
    expect(firstPatch.status).toBe(200);
    expect((await firstPatch.json()) as { version: number }).toMatchObject({ version: 2 });

    const stalePatch = await api(fake, session, `/api/blocks/${block.block_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expected_version: 1, coords_norm: [0.3, 0.3, 0.7, 0.6] }),
    });
    expect(stalePatch.status).toBe(409);
    const body = (await stalePatch.json()) as {
      detail: string;
      expected_version: number;
      actual_version: number;
      current: { block_id: string; version: number; coords_norm: number[] };
    };
    expect(body.expected_version).toBe(1);
    expect(body.actual_version).toBe(2);
    expect(body.current.block_id).toBe(block.block_id);
    expect(body.current.coords_norm).toEqual([0.2, 0.2, 0.6, 0.5]);
  });

  it('отклоняет некорректную геометрию и page_index за пределами документа', async () => {
    const fake = await start();
    const { session, documentId } = await readyDocument(fake, makePdf(2));

    const badCoords = await api(fake, session, `/api/documents/${documentId}/blocks`, {
      method: 'POST',
      body: JSON.stringify({
        page_index: 0,
        block_type: 'text',
        coords_norm: [0.6, 0.1, 0.2, 0.4],
      }),
    });
    expect(badCoords.status).toBe(422);

    const badPage = await api(fake, session, `/api/documents/${documentId}/blocks`, {
      method: 'POST',
      body: JSON.stringify({
        page_index: 9,
        block_type: 'text',
        coords_norm: [0.1, 0.1, 0.2, 0.4],
      }),
    });
    expect(badPage.status).toBe(422);
  });
});

describe('запуск распознавания и экспорт', () => {
  it('job доходит до done, до готовности экспорт отвечает 409', async () => {
    const fake = await start();
    const { session, documentId } = await readyDocument(fake, makePdf(2));
    await detect(fake, session, documentId, {});

    const createResponse = await api(fake, session, '/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        document_id: documentId,
        scope: 'all',
        settings: { text: { provider_type: 'lmstudio', model_id: 'fake-model' } },
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      job: { job_id: string; status: string; has_export: boolean; total_blocks: number };
      counts: Record<string, unknown>;
      skipped_block_ids: string[];
    };
    expect(created.job.has_export).toBe(false);
    expect(created.job.total_blocks).toBeGreaterThan(0);
    expect(created.skipped_block_ids).toEqual([]);

    const earlyZip = await api(fake, session, `/api/exports/jobs/${created.job.job_id}/zip`);
    expect(earlyZip.status).toBe(409);

    let status = created.job.status;
    let hasExport = false;
    for (let i = 0; i < 10 && !hasExport; i += 1) {
      const response = await api(fake, session, `/api/jobs/${created.job.job_id}`);
      const job = (await response.json()) as { status: string; has_export: boolean };
      status = job.status;
      hasExport = job.has_export;
    }
    expect(status).toBe('done');
    expect(hasExport).toBe(true);

    const zip = await api(fake, session, `/api/exports/jobs/${created.job.job_id}/zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});

describe('управление двойником', () => {
  it('expireTokens приводит к 401, а после refresh вызовы снова проходят', async () => {
    const fake = await start();
    const session = await login(fake);
    expect((await api(fake, session, '/api/auth/me')).status).toBe(200);

    fake.expireTokens();
    expect((await api(fake, session, '/api/auth/me')).status).toBe(401);

    const refreshResponse = await fetch(`${fake.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };
    const next: Session = { access: refreshed.access_token, refresh: refreshed.refresh_token };
    expect((await api(fake, next, '/api/auth/me')).status).toBe(200);
  });

  it('failNext роняет ровно один следующий вызов эндпоинта', async () => {
    const fake = await start();
    const session = await login(fake);
    fake.failNext('/api/projects', 503, 'Сервис недоступен');

    const failed = await api(fake, session, '/api/projects');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ detail: 'Сервис недоступен' });

    const retried = await api(fake, session, '/api/projects');
    expect(retried.status).toBe(200);
  });

  it('x-request-id из запроса виден в журнале вызовов', async () => {
    const fake = await start();
    const session = await login(fake);
    await api(fake, session, '/api/projects', { headers: { 'x-request-id': 'req-42' } });

    const call = fake.calls.find((c) => c.requestId === 'req-42');
    expect(call).toBeDefined();
    expect(call?.path).toBe('/api/projects');
    expect(call?.method).toBe('GET');
    expect(fake.calls.map((c) => c.seq)).toEqual(fake.calls.map((_unused, i) => i + 1));
  });

  it('поднимается многократно в одном процессе и полностью гасится', async () => {
    const first = await startFakeRdWeb();
    const second = await startFakeRdWeb();
    expect(first.url).not.toBe(second.url);
    await first.close();
    await second.close();
    await expect(fetch(`${first.url}/api/projects`)).rejects.toBeDefined();
  });
});
