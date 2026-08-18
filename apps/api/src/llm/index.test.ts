/**
 * Фабрика провайдера LLM (§10, §0.3 п.6, §0.5).
 *
 * Четыре значения `LLM_PROVIDER` дают четыре разных по смыслу состояния, и
 * проверяется именно их РАЗЛИЧИМОСТЬ. Если бы `rdweb` тихо собирался в
 * `proxy_llm`, переключатель в администрировании выглядел бы работающим, а
 * заказчик считал бы требование §0.3 п.6 закрытым. Если бы `none` бросал при
 * сборке, портал не поднимался бы без LLM — вопреки §0.5, где якорные правила
 * обязаны работать сами по себе.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import { createMetrics } from '../observability/metrics.js';
import { RDWEB_LLM_BLOCK_REASON, createLlmProvider, type LlmDeps } from './index.js';
import {
  LlmBlockedProviderError,
  LlmDisabledError,
  LlmRecordingMissingError,
  type LlmRequest,
} from './port.js';
import { ProxyLlmProvider } from './proxy.js';
import { RecordedLlmProvider } from './recorded.js';

/** Отказ вызова как значение: `.catch()` дал бы объединение с успешным ответом. */
async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('вызов обязан был завершиться отказом');
}

const REQUEST: LlmRequest = {
  stage: 'page_classify',
  promptCode: 'page_classify_open_world',
  promptVersion: 1,
  systemPrompt: 'Классифицируй страницу.',
  userPrompt: 'АКТ',
  schemaVersion: 'page_classify.v1',
  cacheContext: '',
};

function envOf(overrides: NodeJS.ProcessEnv): Env {
  return loadEnv({
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
  });
}

function deps(overrides: Partial<LlmDeps> = {}): LlmDeps {
  return {
    metrics: createMetrics({ enabled: false, service: 'llm-factory-test' }),
    logger: createLogger({ service: 'llm-factory-test', level: 'silent' }),
    spend: { monthlySpend: () => Promise.resolve(0) },
    ...overrides,
  };
}

describe('LLM_PROVIDER=rdweb', () => {
  it('переключатель существует в конфигурации', () => {
    expect(envOf({ LLM_PROVIDER: 'rdweb' }).LLM_PROVIDER).toBe('rdweb');
  });

  it('но заблокирован: вызов отвергается с пояснением про S13', async () => {
    const provider = createLlmProvider(envOf({ LLM_PROVIDER: 'rdweb' }), deps());

    const error = await failureOf(provider.complete(REQUEST));
    expect(error).toBeInstanceOf(LlmBlockedProviderError);
    expect(error.message).toBe(RDWEB_LLM_BLOCK_REASON);
    expect(error.message).toContain('generic text-analysis');
    expect(error.message).toContain('S13');
    expect(provider).not.toBeInstanceOf(ProxyLlmProvider);
  });
});

describe('LLM_PROVIDER=none', () => {
  it('это значение по умолчанию и оно не мешает старту', () => {
    expect(envOf({}).LLM_PROVIDER).toBe('none');
  });

  it('вызов честно сообщает, что модель не подключена', async () => {
    const provider = createLlmProvider(envOf({ LLM_PROVIDER: 'none' }), deps());

    const error = await failureOf(provider.complete(REQUEST));
    expect(error).toBeInstanceOf(LlmDisabledError);
    expect(error.message).toContain('якорн');
    expect((error as LlmDisabledError).retriable).toBe(false);
  });
});

describe('LLM_PROVIDER=recorded', () => {
  it('в production не поднимается вовсе', () => {
    expect(() =>
      envOf({
        NODE_ENV: 'production',
        LLM_PROVIDER: 'recorded',
        PUBLIC_URL: 'https://id.example.com',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://kc.example.com/realms/id',
        OIDC_CLIENT_ID: 'id-portal',
        OIDC_CLIENT_SECRET: 'oidc-confidential-credential-0001',
        SESSION_ENC_KEY: Buffer.alloc(32, 0x2a).toString('base64'),
        CSRF_SECRET: 'c'.repeat(32),
        AUDIT_HMAC_KEY: 'h'.repeat(44),
        PG_CA_CERT_PATH: '/etc/ssl/certs/managed-pg-root.crt',
        TRUST_PROXY: '127.0.0.1',
      }),
    ).toThrow(/LLM_PROVIDER=recorded запрещён/);
  });

  it('без переданных записей отвечает отказом, а не выдумкой', async () => {
    const provider = createLlmProvider(envOf({ LLM_PROVIDER: 'recorded' }), deps());

    expect(provider).toBeInstanceOf(RecordedLlmProvider);
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(LlmRecordingMissingError);
  });

  it('переданные записи используются', async () => {
    const model = 'recorded-model';
    const hash = RecordedLlmProvider.hashOf(REQUEST, model);
    const provider = createLlmProvider(
      envOf({ LLM_PROVIDER: 'recorded' }),
      deps({
        recorded: { responses: new Map([[hash, { kind: 'ok', text: '{"label":"U"}' }]]), model },
      }),
    );

    expect((await provider.complete(REQUEST)).text).toBe('{"label":"U"}');
  });
});

describe('LLM_PROVIDER=proxy_llm', () => {
  const source = {
    LLM_PROVIDER: 'proxy_llm',
    PROXY_LLM_BASE_URL: 'https://llm-gw.internal/v1',
    PROXY_LLM_TOKEN: 'unit-test-gateway-token',
    LLM_MODEL: 'gw/model-a',
  };

  it('собирается и ходит по настроенному адресу', async () => {
    const urls: string[] = [];
    const provider = createLlmProvider(
      envOf(source),
      deps({
        fetchImpl: ((input: Parameters<typeof fetch>[0]) => {
          urls.push(String(input));
          return Promise.resolve(
            new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"U"}' } }] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }) as typeof fetch,
      }),
    );

    expect(provider).toBeInstanceOf(ProxyLlmProvider);
    const response = await provider.complete(REQUEST);
    expect(response.model).toBe('gw/model-a');
    expect(urls).toStrictEqual(['https://llm-gw.internal/v1/chat/completions']);
  });

  it('без адреса или токена конфигурация не поднимается', () => {
    expect(() => envOf({ LLM_PROVIDER: 'proxy_llm' })).toThrow(/PROXY_LLM_BASE_URL/);
  });

  it('без модели вызов отвергается с внятной причиной, а не пустым model в теле', async () => {
    const calls: string[] = [];
    const provider = createLlmProvider(
      envOf({ ...source, LLM_MODEL: undefined }),
      deps({
        fetchImpl: ((input: Parameters<typeof fetch>[0]) => {
          calls.push(String(input));
          return Promise.resolve(new Response('{}', { status: 200 }));
        }) as typeof fetch,
      }),
    );

    const error = await failureOf(provider.complete(REQUEST));
    expect(error.message).toContain('LLM_MODEL');
    // До шлюза дело не дошло: пустой `model` дал бы 400 без объяснения причины.
    expect(calls).toStrictEqual([]);
  });
});
