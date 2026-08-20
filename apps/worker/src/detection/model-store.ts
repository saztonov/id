/**
 * Хранилище модели детекции: S3 → временный файл → sha256 → атомарный rename,
 * кэш ONNX-сессии в памяти процесса (ADR-0008).
 *
 * ## Почему content-addressed, а не «последняя версия»
 *
 * Ключи хранилища (`detectionModelKey`/`detectionManifestKey`) адресуются
 * версией, а не содержимым, но целостность ПОДТВЕРЖДАЕТ sha256 из манифеста —
 * не адрес (см. докстринг `keys.ts`). Скачивание во временный файл и rename
 * только ПОСЛЕ успешной сверки гарантируют, что по финальному пути
 * `{cacheDir}/{version}.onnx` никогда не лежит наполовину скачанный или не
 * прошедший проверку файл: сессия ONNX Runtime открывает либо целый
 * проверенный файл, либо не открывает ничего.
 *
 * ## Single-flight и кэш сессии
 *
 * `ensureModel(version)` кэширует загруженную сессию по версии в памяти
 * процесса и не допускает параллельной повторной загрузки ОДНОЙ версии:
 * страницы одного комплекта детектируются задачами `layout.detect_local`
 * почти одновременно (очередь cpu, конкуренция 1–2), и без single-flight
 * каждая создала бы свою ONNX-сессию поверх одних и тех же весов.
 *
 * ## Предупреждения — как ДАННЫЕ, а не как callback в журнал
 *
 * Модуль не знает про логгер воркера (в отличие от `createQpdfToolkit`, у
 * которого есть свой `onWarning` — тот собирается в `main.ts`, где логгер уже
 * существует). `createModelStore()` же собирается в `pipeline.ts` ДО того, как
 * появляется `ctx.logger` конкретной задачи, и плодить для этого отдельный
 * канал логирования на уровне пайплайна — лишняя сущность. Поэтому
 * `ensureModel()` возвращает `warnings` в результате, а логирует их вызывающая
 * задача (`local-detection.ts`), у которой `ctx.logger` уже есть.
 *
 * ## Честный отказ вместо угадывания
 *
 * Пустая версия, отсутствующие в хранилище файлы, битый JSON, манифест, не
 * прошедший схему, или несовпавший sha256 — во всех случаях
 * `DetectionConfigurationError` с текстом, что именно поправить. Ручная
 * разметка при этом не страдает: отказывает только автоматическая детекция.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { detectionManifestKey, detectionModelKey, type StorageProvider } from '@id/api';
import { manifestParams, parseDetectionManifest, type InferenceParams } from '@id/detection';

import { DetectionConfigurationError } from './errors.js';
import type { OnnxSessionOptions, OnnxSessionPort } from './session.js';

/** Манифест — JSON в единицы КБ; потолок только чтобы не читать мусор в память. */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export interface LoadedModel {
  readonly session: OnnxSessionPort;
  readonly params: InferenceParams;
  /** Несмертельные предупреждения загрузки (манифест без `onnx_sha256` и т.п.). */
  readonly warnings: readonly string[];
}

export interface ModelStoreDeps {
  readonly storage: StorageProvider;
  /** Каталог кэша весов на диске воркера (переживает процесс, не job). */
  readonly cacheDir: string;
  /**
   * Фабрика ONNX-сессии — обычно `OnnxRuntimeSession.create`. Инъекция ради
   * теста: `model-store.test.ts` подставляет двойник и не грузит настоящий
   * onnxruntime-node.
   */
  readonly createSession: (
    onnxPath: string,
    options: OnnxSessionOptions,
  ) => Promise<OnnxSessionPort>;
  readonly sessionOptions?: OnnxSessionOptions | undefined;
}

export interface ModelStore {
  ensureModel(version: string): Promise<LoadedModel>;
}

async function statOrNull(path: string): Promise<{ readonly sizeBytes: number } | null> {
  try {
    const info = await stat(path);
    return { sizeBytes: info.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const digest = createHash('sha256');
  await pipeline(createReadStream(path), digest);
  return digest.digest('hex');
}

/** Прочитать объект хранилища целиком, ограниченно размером (манифест — JSON в КБ). */
async function readObjectBounded(
  storage: StorageProvider,
  key: string,
  what: string,
): Promise<Buffer> {
  const object = await storage.getObjectStream(key);
  if (object.sizeBytes > MAX_MANIFEST_BYTES) {
    object.stream.destroy();
    throw new DetectionConfigurationError(
      `${what} (${key}) размером ${object.sizeBytes} Б превышает разумный предел ` +
        `${MAX_MANIFEST_BYTES} Б для JSON-манифеста`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.stream) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_MANIFEST_BYTES) {
      object.stream.destroy();
      throw new DetectionConfigurationError(`${what} (${key}) длиннее заявленного размера`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

interface OnnxFileResult {
  readonly path: string;
  readonly warning: string | null;
}

/**
 * Гарантировать наличие проверенного файла весов на диске, вернуть его путь.
 *
 * Существующий файл с известным `expectedSha256` сверяется побайтово перед
 * переиспользованием — кэш на диске переживает рестарт процесса, и файл,
 * оставшийся от старой версии `.onnx` под тем же именем (ручная подмена,
 * повреждение диска), обязан быть обнаружен, а не загружен в сессию как есть.
 */
async function ensureOnnxFile(
  deps: ModelStoreDeps,
  version: string,
  modelKey: string,
  expectedSha256: string | undefined,
): Promise<OnnxFileResult> {
  await mkdir(deps.cacheDir, { recursive: true });
  const finalPath = join(deps.cacheDir, `${version}.onnx`);

  const existing = await statOrNull(finalPath);
  if (existing !== null) {
    if (expectedSha256 === undefined) {
      return {
        path: finalPath,
        warning:
          `манифест модели детекции ${version} не содержит onnx_sha256: кэш весов ` +
          `${finalPath} переиспользуется без проверки целостности`,
      };
    }
    const actual = await sha256OfFile(finalPath);
    if (actual === expectedSha256) {
      return { path: finalPath, warning: null };
    }
    // Не совпало — переходим на (пере)скачивание ниже; предупреждение об этом
    // факте теряется в пользу более важного исхода перезагрузки (успех/отказ
    // ниже говорит сам за себя через свои события).
  }

  const tmpPath = join(deps.cacheDir, `${version}.onnx.tmp-${process.pid}`);
  let warning: string | null = null;
  try {
    const object = await deps.storage.getObjectStream(modelKey);
    await pipeline(object.stream, createWriteStream(tmpPath));

    if (expectedSha256 !== undefined) {
      const actual = await sha256OfFile(tmpPath);
      if (actual !== expectedSha256) {
        throw new DetectionConfigurationError(
          `веса модели детекции ${version} не совпали с onnx_sha256 манифеста ` +
            `(ожидалось ${expectedSha256}, получено ${actual}): файл повреждён при выкладке ` +
            'либо манифест указывает не на те веса',
        );
      }
    } else {
      warning =
        `манифест модели детекции ${version} не содержит onnx_sha256: целостность скачанных ` +
        'весов не проверена';
    }

    // Rename — атомарная точка публикации: до неё по finalPath ничего не
    // лежит, после — лежит только проверенный файл целиком.
    await rename(tmpPath, finalPath);
  } finally {
    // Не мешает успешному пути (rename уже переместил файл, ENOENT молча
    // игнорируется force:true) и убирает временный файл на любом отказе —
    // tmp-файл не остаётся ни при сетевой ошибке, ни при несовпавшем sha256.
    await rm(tmpPath, { force: true });
  }
  return { path: finalPath, warning };
}

/**
 * Хранилище модели детекции: манифест+веса по версии → готовая ONNX-сессия и
 * параметры инференса.
 */
export function createModelStore(deps: ModelStoreDeps): ModelStore {
  const cache = new Map<string, LoadedModel>();
  const inflight = new Map<string, Promise<LoadedModel>>();

  async function loadModel(version: string): Promise<LoadedModel> {
    const trimmed = version.trim();
    if (trimmed === '') {
      throw new DetectionConfigurationError(
        'модель детекции не загружена: задайте detection.model_version в администрировании ' +
          'и выложите файлы model.onnx и manifest.json локальной модели',
      );
    }

    const manifestKey = detectionManifestKey(trimmed);
    const manifestHead = await deps.storage.headObject(manifestKey);
    if (manifestHead === null) {
      throw new DetectionConfigurationError(
        `манифест модели детекции версии «${trimmed}» не найден в хранилище (${manifestKey}): ` +
          'выложите onnx_export_manifest.json прежде чем включать локальную детекцию',
      );
    }

    const modelKey = detectionModelKey(trimmed);
    const modelHead = await deps.storage.headObject(modelKey);
    if (modelHead === null) {
      throw new DetectionConfigurationError(
        `веса модели детекции версии «${trimmed}» не найдены в хранилище (${modelKey}): ` +
          'выложите model.onnx прежде чем включать локальную детекцию',
      );
    }

    const manifestBytes = await readObjectBounded(
      deps.storage,
      manifestKey,
      'манифест модели детекции',
    );
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
      throw new DetectionConfigurationError(
        `манифест модели детекции версии «${trimmed}» не является валидным JSON: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    let params: InferenceParams;
    let onnxSha256: string | undefined;
    try {
      const manifest = parseDetectionManifest(manifestJson);
      params = manifestParams(manifest);
      onnxSha256 = manifest.onnx_sha256;
    } catch (error) {
      throw new DetectionConfigurationError(
        `манифест модели детекции версии «${trimmed}» не прошёл проверку схемы: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    const onnxFile = await ensureOnnxFile(deps, trimmed, modelKey, onnxSha256);
    const session = await deps.createSession(onnxFile.path, deps.sessionOptions ?? {});
    return { session, params, warnings: onnxFile.warning === null ? [] : [onnxFile.warning] };
  }

  return {
    async ensureModel(version: string): Promise<LoadedModel> {
      const cached = cache.get(version);
      if (cached !== undefined) return cached;

      const running = inflight.get(version);
      if (running !== undefined) return running;

      const promise = loadModel(version).then(
        (loaded) => {
          cache.set(version, loaded);
          inflight.delete(version);
          return loaded;
        },
        (error: unknown) => {
          inflight.delete(version);
          throw error;
        },
      );
      inflight.set(version, promise);
      return promise;
    },
  };
}
