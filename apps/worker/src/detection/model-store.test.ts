/**
 * `createModelStore`: манифест+веса из хранилища (мок — Map ключ→байты) →
 * sha256-сверка, атомарная публикация (tmp-файл не остаётся), single-flight и
 * кэш сессии, честные отказы конфигурации (план Ф7).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectionManifestKey, detectionModelKey, type StorageProvider } from '@id/api';

import { DetectionConfigurationError } from './errors.js';
import { createModelStore, type ModelStoreDeps } from './model-store.js';
import type { OnnxSessionOptions, OnnxSessionPort } from './session.js';

// =====================================================================
// Мок хранилища: Map ключ → байты (план: «мок storage: Map ключ→байты»).
// =====================================================================
class FakeStorage implements StorageProvider {
  readonly driver = 'local' as const;
  readonly localUploads = undefined;
  readonly objects = new Map<string, Buffer>();
  getObjectStreamCalls = 0;

  async putObject(input: {
    readonly key: string;
    readonly body: Buffer;
    readonly contentType: string;
  }) {
    this.objects.set(input.key, input.body);
    return {
      key: input.key,
      sizeBytes: input.body.byteLength,
      contentType: input.contentType,
      etag: null,
    };
  }

  async getObjectStream(key: string) {
    this.getObjectStreamCalls += 1;
    const body = this.objects.get(key);
    if (body === undefined) throw new Error(`fake storage: объект ${key} не найден`);
    return {
      stream: Readable.from(body),
      sizeBytes: body.byteLength,
      contentLength: body.byteLength,
      range: null,
    };
  }

  async headObject(key: string) {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    return { key, sizeBytes: body.byteLength, contentType: null, etag: null };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  copyObject(): Promise<never> {
    throw new Error('не используется в тесте');
  }

  presignPut(): Promise<never> {
    throw new Error('не используется в тесте');
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestBytes(fields: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      num_classes: 3,
      resolution: 16,
      class_mapping: { text: 0, image: 1, stamp: 2 },
      preprocessing: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      ...fields,
    }),
    'utf8',
  );
}

class FakeSession implements OnnxSessionPort {
  constructor(readonly onnxPath: string) {}
  async run(): Promise<never> {
    throw new Error('не вызывается в этих тестах');
  }
}

describe('createModelStore', () => {
  let cacheDir: string;
  let storage: FakeStorage;
  let createSessionCalls: { readonly onnxPath: string; readonly options: OnnxSessionOptions }[];

  function deps(overrides: Partial<ModelStoreDeps> = {}): ModelStoreDeps {
    return {
      storage,
      cacheDir,
      createSession: async (onnxPath, options) => {
        createSessionCalls.push({ onnxPath, options });
        return new FakeSession(onnxPath);
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'id-model-store-test-'));
    storage = new FakeStorage();
    createSessionCalls = [];
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('пустая версия — DetectionConfigurationError, хранилище не трогается', async () => {
    const store = createModelStore(deps());
    await expect(store.ensureModel('')).rejects.toThrow(DetectionConfigurationError);
    await expect(store.ensureModel('   ')).rejects.toThrow(DetectionConfigurationError);
    expect(storage.getObjectStreamCalls).toBe(0);
  });

  it('манифест не найден в хранилище — честный отказ', async () => {
    const store = createModelStore(deps());
    await expect(store.ensureModel('v1')).rejects.toThrow(DetectionConfigurationError);
    await expect(store.ensureModel('v1')).rejects.toThrow(/манифест/i);
  });

  it('веса не найдены в хранилище (манифест есть) — честный отказ', async () => {
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({}),
      contentType: 'application/json',
    });
    const store = createModelStore(deps());
    await expect(store.ensureModel('v1')).rejects.toThrow(DetectionConfigurationError);
    await expect(store.ensureModel('v1')).rejects.toThrow(/model\.onnx|вес/i);
  });

  it('манифест — не валидный JSON', async () => {
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: Buffer.from('{not json'),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: Buffer.from('fake-onnx-weights'),
      contentType: 'application/octet-stream',
    });
    const store = createModelStore(deps());
    await expect(store.ensureModel('v1')).rejects.toThrow(DetectionConfigurationError);
    await expect(store.ensureModel('v1')).rejects.toThrow(/JSON/i);
  });

  it('манифест не проходит схему (пустой class_mapping) — честный отказ', async () => {
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ class_mapping: {} }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: Buffer.from('fake-onnx-weights'),
      contentType: 'application/octet-stream',
    });
    const store = createModelStore(deps());
    await expect(store.ensureModel('v1')).rejects.toThrow(DetectionConfigurationError);
  });

  it('успешная загрузка: sha256 совпал, файл на диске, tmp-файл не остаётся, warnings пуст', async () => {
    const weights = Buffer.from('real-onnx-weights-payload');
    const sha256 = sha256Hex(weights);
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ onnx_sha256: sha256 }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    const store = createModelStore(deps());
    const loaded = await store.ensureModel('v1');

    expect(loaded.warnings).toEqual([]);
    expect(loaded.params.resolution).toBe(16);
    expect(loaded.params.classMapping).toEqual({ text: 0, image: 1, stamp: 2 });
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]?.onnxPath).toBe(join(cacheDir, 'v1.onnx'));

    const files = await readdir(cacheDir);
    expect(files).toEqual(['v1.onnx']);
  });

  it('sha256 не совпал — отказ, tmp-файл не остаётся, финальный файл не создан', async () => {
    const weights = Buffer.from('real-onnx-weights-payload');
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ onnx_sha256: sha256Hex(Buffer.from('другие байты')) }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    const store = createModelStore(deps());
    await expect(store.ensureModel('v1')).rejects.toThrow(DetectionConfigurationError);
    await expect(store.ensureModel('v1')).rejects.toThrow(/sha256/i);

    const files = await readdir(cacheDir);
    expect(files).toEqual([]);
  });

  it('манифест без onnx_sha256 — загрузка проходит, но с предупреждением', async () => {
    const weights = Buffer.from('unverified-weights');
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({}),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    const store = createModelStore(deps());
    const loaded = await store.ensureModel('v1');
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toMatch(/onnx_sha256/);
  });

  it('кэш в памяти: второй ensureModel той же версии не обращается к storage повторно', async () => {
    const weights = Buffer.from('cached-weights');
    const sha256 = sha256Hex(weights);
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ onnx_sha256: sha256 }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    const store = createModelStore(deps());
    const first = await store.ensureModel('v1');
    const callsAfterFirst = storage.getObjectStreamCalls;
    const second = await store.ensureModel('v1');

    expect(second).toBe(first);
    expect(storage.getObjectStreamCalls).toBe(callsAfterFirst);
    expect(createSessionCalls).toHaveLength(1);
  });

  it('single-flight: параллельные ensureModel одной версии грузят модель один раз', async () => {
    const weights = Buffer.from('concurrent-weights');
    const sha256 = sha256Hex(weights);
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ onnx_sha256: sha256 }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    const store = createModelStore(deps());
    const [a, b, c] = await Promise.all([
      store.ensureModel('v1'),
      store.ensureModel('v1'),
      store.ensureModel('v1'),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createSessionCalls).toHaveLength(1);
  });

  it('кэш на диске переживает новый процесс: второй createModelStore переиспользует файл без повторного скачивания', async () => {
    const weights = Buffer.from('disk-cached-weights');
    const sha256 = sha256Hex(weights);
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ onnx_sha256: sha256 }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    const first = createModelStore(deps());
    await first.ensureModel('v1');
    const callsAfterFirstProcess = storage.getObjectStreamCalls;

    // Новый объект store (симулирует рестарт процесса) на ТОМ ЖЕ cacheDir и
    // ТОМ ЖЕ storage — веса скачивать заново не должен, только сверить sha256.
    const second = createModelStore(deps());
    await second.ensureModel('v1');

    // getObjectStream — только для манифеста (веса уже на диске и прошли sha256).
    expect(storage.getObjectStreamCalls).toBe(callsAfterFirstProcess + 1);
  });

  it('устаревший/повреждённый файл на диске — перезагружается из хранилища, а не используется как есть', async () => {
    const weights = Buffer.from('correct-weights');
    const sha256 = sha256Hex(weights);
    await storage.putObject({
      key: detectionManifestKey('v1'),
      body: manifestBytes({ onnx_sha256: sha256 }),
      contentType: 'application/json',
    });
    await storage.putObject({
      key: detectionModelKey('v1'),
      body: weights,
      contentType: 'application/octet-stream',
    });

    // Кладём НЕВЕРНЫЙ файл на диск заранее, будто от старой версии.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cacheDir, 'v1.onnx'), 'stale-corrupted-content');

    const store = createModelStore(deps());
    const loaded = await store.ensureModel('v1');
    expect(loaded).toBeDefined();

    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(join(cacheDir, 'v1.onnx'));
    expect(onDisk.equals(weights)).toBe(true);
  });
});
