/**
 * `/metrics` в формате Prometheus (§11).
 *
 * Приложение собирается тестом по документированной схеме подключения из
 * `metrics.ts` и `request-log.ts`: маршрут `/metrics` берётся из `metrics.route`,
 * а метка маршрута попадает в метрики через `setRequestLogFields()` из
 * `request.routeOptions.url`. Проверяется именно эта связка, потому что
 * кардинальность метки задаётся не модулем метрик, а тем, что ему передали.
 *
 * Формат разбирается парсером, а не проверяется поиском подстроки `# HELP`:
 * Prometheus отказывается принимать весь ответ целиком при единственной
 * непарсящейся строке, и такой отказ обязан быть виден тестом, а не графиком,
 * который перестал обновляться.
 */
import { Writable } from 'node:stream';

import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadEnv } from '../config/env.js';
import { createLogger } from './logger.js';
import { collapsePathIds, createMetrics, type Metrics } from './metrics.js';
import { createRequestLogHandler, setRequestLogFields } from './request-log.js';

const METRICS_PATH = '/metrics';
const OBJECT_ROUTE = '/api/objects/:objectId/pages/:pageNumber';
const OBJECT_ID = '7f000000-0000-4000-8000-0000000000ab';

function testEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://id_app:local-only-pw@localhost:5432/id',
    AUTH_MODE: 'dev-stub',
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://storage.yandexcloud.net',
    S3_BUCKET: 'id-portal',
    S3_ACCESS_KEY: 'unit-test-access-key-id',
    S3_SECRET_KEY: 'unit-test-access-key-material',
    ...overrides,
  };
}

/** Приёмник, который выбрасывает строки: журнал запросов здесь не проверяется. */
function discardingLogger() {
  return createLogger({
    service: 'api-test',
    level: 'warn',
    destination: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
}

interface Harness {
  readonly app: FastifyInstance;
  readonly metrics: Metrics;
}

/**
 * Подключение метрик так, как это делает приложение: маршрут регистрируется
 * только при `metrics.route !== undefined`, поэтому `METRICS_ENABLED=false`
 * должно давать 404 без единой ветки `if` в самом приложении.
 */
async function buildHarness(metricsEnabled: string): Promise<Harness> {
  const env = loadEnv(testEnv({ METRICS_ENABLED: metricsEnabled }));
  const metrics = createMetrics({ enabled: env.METRICS_ENABLED, service: 'api' });

  const app = fastify({ logger: false });
  const httpLog = createRequestLogHandler({
    logger: discardingLogger(),
    slowRequestMs: env.SLOW_REQUEST_MS,
    metrics,
    ignorePaths: [METRICS_PATH],
  });

  app.addHook('onRequest', (request, reply, done) => {
    httpLog(request.raw, reply.raw, () => {
      setRequestLogFields(request.raw, { route: request.routeOptions.url });
      done();
    });
  });

  app.get(OBJECT_ROUTE, () => ({ ok: true }));

  const route = metrics.route;
  if (route !== undefined) {
    app.route({ method: route.method, url: route.url, handler: route.handler });
  }

  await app.ready();
  return { app, metrics };
}

interface Exposition {
  readonly declaredHelp: ReadonlySet<string>;
  readonly declaredTypes: ReadonlyMap<string, string>;
  readonly samples: readonly { readonly name: string; readonly labels: string }[];
  readonly unparsed: readonly string[];
}

/** Имя, необязательные метки, значение и необязательная метка времени. */
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})? (\S+)(?: \d+)?$/;
const NUMERIC_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
/**
 * Регистронезависимо: prom-client печатает `Nan`, а не `NaN`. Prometheus
 * разбирает значение через ParseFloat языка Go, для которого регистр в `nan` и
 * `inf` не важен, поэтому такая строка валидна и придираться к ней нельзя.
 */
const SPECIAL_VALUE = /^[+-]?(?:inf|infinity|nan)$/i;
const AGGREGATE_SUFFIXES = ['_bucket', '_sum', '_count'] as const;

function isExpositionValue(token: string): boolean {
  return NUMERIC_VALUE.test(token) || SPECIAL_VALUE.test(token);
}

function parseExposition(body: string): Exposition {
  const declaredHelp = new Set<string>();
  const declaredTypes = new Map<string, string>();
  const samples: { name: string; labels: string }[] = [];
  const unparsed: string[] = [];

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;

    if (line.startsWith('# HELP ')) {
      const name = line.slice('# HELP '.length).split(' ')[0];
      if (name !== undefined) declaredHelp.add(name);
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const [name, type] = line.slice('# TYPE '.length).split(' ');
      if (name !== undefined && type !== undefined) declaredTypes.set(name, type);
      continue;
    }
    if (line.startsWith('#')) continue;

    const parsed = SAMPLE_LINE.exec(line);
    const name = parsed?.[1];
    const value = parsed?.[3];
    if (name === undefined || value === undefined || !isExpositionValue(value)) {
      unparsed.push(line);
      continue;
    }
    samples.push({ name, labels: parsed?.[2] ?? '' });
  }

  return { declaredHelp, declaredTypes, samples, unparsed };
}

/** Гистограмма объявляется одним именем, а выдаёт `_bucket`/`_sum`/`_count`. */
function baseName(name: string, declared: ReadonlyMap<string, string>): string {
  if (declared.has(name)) return name;
  for (const suffix of AGGREGATE_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

function labelValue(labels: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(labels)?.[1];
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
});

describe('GET /metrics при METRICS_ENABLED=true', () => {
  it('отдаёт разбираемый текстовый формат Prometheus', async () => {
    harness = await buildHarness('true');

    const response = await harness.app.inject({ method: 'GET', url: METRICS_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');

    const exposition = parseExposition(response.body);

    expect(exposition.unparsed, 'Prometheus отвергнет весь ответ из-за этих строк').toStrictEqual(
      [],
    );
    expect(exposition.samples.length).toBeGreaterThan(0);

    const missingDeclaration = exposition.samples
      .map((sample) => baseName(sample.name, exposition.declaredTypes))
      .filter((name) => !exposition.declaredTypes.has(name) || !exposition.declaredHelp.has(name));

    expect([...new Set(missingDeclaration)], 'метрика без # HELP или # TYPE').toStrictEqual([]);
  });

  it('включает метрики процесса', async () => {
    harness = await buildHarness('true');

    const { body } = await harness.app.inject({ method: 'GET', url: METRICS_PATH });
    const { declaredTypes } = parseExposition(body);

    for (const name of [
      'process_cpu_seconds_total',
      'process_resident_memory_bytes',
      'process_start_time_seconds',
      'nodejs_heap_size_used_bytes',
      'nodejs_eventloop_lag_seconds',
    ]) {
      expect(declaredTypes.has(name), `метрика процесса ${name} не собирается`).toBe(true);
    }
  });

  it('объявляет метрики §11: HTTP, job, очередь, внешние вызовы, стоимость LLM', async () => {
    harness = await buildHarness('true');

    const { body } = await harness.app.inject({ method: 'GET', url: METRICS_PATH });
    const { declaredTypes } = parseExposition(body);

    expect({
      http: declaredTypes.get('http_request_duration_seconds'),
      db: declaredTypes.get('db_query_duration_seconds'),
      job: declaredTypes.get('job_duration_seconds'),
      external: declaredTypes.get('external_call_duration_seconds'),
      queue: declaredTypes.get('job_queue_depth'),
      dead: declaredTypes.get('job_dead_jobs'),
      cost: declaredTypes.get('llm_cost_rub_total'),
      tokens: declaredTypes.get('llm_tokens_total'),
    }).toStrictEqual({
      http: 'histogram',
      db: 'histogram',
      job: 'histogram',
      external: 'histogram',
      queue: 'gauge',
      dead: 'gauge',
      cost: 'counter',
      tokens: 'counter',
    });
  });
});

describe('метка маршрута — шаблон, а не конкретный путь', () => {
  it('не пускает uuid и номер страницы в метки после запроса с параметрами', async () => {
    harness = await buildHarness('true');
    const app = harness.app;

    const answered = await app.inject({
      method: 'GET',
      url: `/api/objects/${OBJECT_ID}/pages/17`,
    });
    expect(answered.statusCode).toBe(200);

    // Наблюдение делается по событию `close` ответа, поэтому его ждём, а не
    // засыпаем на произвольный срок.
    const body = await vi.waitFor(async () => {
      const rendered = await app.inject({ method: 'GET', url: METRICS_PATH });
      expect(rendered.body).toContain('http_request_duration_seconds_count');
      return rendered.body;
    });

    const routes = parseExposition(body)
      .samples.filter((sample) => sample.name.startsWith('http_request_duration_seconds'))
      .map((sample) => labelValue(sample.labels, 'route'));

    expect([...new Set(routes)]).toStrictEqual([OBJECT_ROUTE]);
    expect(body, 'uuid в метке делает кардинальность неограниченной').not.toContain(OBJECT_ID);
    expect(body).not.toContain('/pages/17');
  });

  it('не измеряет сам /metrics: иначе опрос Prometheus попадает в свои же метрики', async () => {
    harness = await buildHarness('true');
    const app = harness.app;

    await app.inject({ method: 'GET', url: METRICS_PATH });
    const body = await vi.waitFor(async () => {
      const rendered = await app.inject({ method: 'GET', url: METRICS_PATH });
      return rendered.body;
    });

    const routes = parseExposition(body)
      .samples.filter((sample) => sample.name.startsWith('http_request_duration_seconds'))
      .map((sample) => labelValue(sample.labels, 'route'));

    expect(routes).not.toContain(METRICS_PATH);
  });

  it('сворачивает идентификаторы, если конкретный путь всё-таки просочился', async () => {
    harness = await buildHarness('true');

    harness.metrics.observeHttpRequest({
      method: 'GET',
      route: `/api/objects/${OBJECT_ID}/pages/17`,
      statusCode: 200,
      durationMs: 12,
    });

    const { body } = await harness.app.inject({ method: 'GET', url: METRICS_PATH });

    expect(body).not.toContain(OBJECT_ID);
    expect(body).toContain('route="/api/objects/:id/pages/:id"');
  });

  it('сворачивает uuid, длинный hex и числовой сегмент', () => {
    expect(collapsePathIds(`/api/objects/${OBJECT_ID}`)).toBe('/api/objects/:id');
    expect(collapsePathIds(`/api/artifacts/${'a1b2c3d4'.repeat(8)}`)).toBe('/api/artifacts/:id');
    expect(collapsePathIds('/api/pages/17/blocks')).toBe('/api/pages/:id/blocks');
    expect(collapsePathIds('')).toBe('unknown');
  });
});

describe('METRICS_ENABLED=false', () => {
  it('не регистрирует маршрут: /metrics отвечает 404', async () => {
    harness = await buildHarness('false');

    expect(harness.metrics.enabled).toBe(false);
    expect(harness.metrics.route).toBeUndefined();

    const response = await harness.app.inject({ method: 'GET', url: METRICS_PATH });

    expect(response.statusCode).toBe(404);
  });

  it('оставляет прикладной маршрут работоспособным и не падает на observe*', async () => {
    harness = await buildHarness('false');

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/objects/${OBJECT_ID}/pages/17`,
    });

    expect(response.statusCode).toBe(200);
    expect(await harness.metrics.render()).toStrictEqual({
      contentType: 'text/plain; version=0.0.4; charset=utf-8',
      body: '',
    });
  });
});
