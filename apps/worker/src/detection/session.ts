/**
 * Порт ONNX-инференса локальной детекции + реализация поверх onnxruntime-node
 * (ADR-0008).
 *
 * `OnnxSessionPort` — единственная граница, которую видит `detector.ts`: он не
 * знает ни про `InferenceSession`, ни про имена входа/выхода графа. Это делает
 * оркестрацию (`detector.ts`) тестируемой фикстурными тензорами без бинарника
 * ONNX Runtime и без файла модели на диске.
 */
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { DetectionModelMismatchError } from '@id/detection';

/** Тензор в форме, которую понимает `@id/detection` (`TensorWithDims`). */
export interface OnnxTensorLike {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/** Порт инференса: один вход (препроцессенная плитка), два выхода (боксы+классы). */
export interface OnnxSessionPort {
  run(
    input: OnnxTensorLike,
  ): Promise<{ readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike }>;
}

export interface OnnxSessionOptions {
  /** Потоков внутри одного оператора графа (`ORT_INTRA_OP_THREADS`, default 2). */
  readonly intraOpNumThreads?: number;
  /** Потоков между операторами графа (`ORT_INTER_OP_THREADS`, default 1). */
  readonly interOpNumThreads?: number;
}

export const DEFAULT_INTRA_OP_THREADS = 2;
export const DEFAULT_INTER_OP_THREADS = 1;

interface OutputResolution {
  readonly detsName: string;
  readonly labelsName: string;
}

function tensorShape(
  meta: InferenceSession.ValueMetadata | undefined,
): readonly (number | string)[] | null {
  return meta !== undefined && meta.isTensor ? meta.shape : null;
}

function lastAxisSize(shape: readonly (number | string)[] | null): number | null {
  if (shape === null || shape.length === 0) return null;
  const last = shape[shape.length - 1];
  return typeof last === 'number' ? last : null;
}

/** Классификация по подстроке имени — только как разрешение ничьей размерности. */
function classifyByName(name: string): 'dets' | 'labels' | 'unknown' {
  const lower = name.toLowerCase();
  if (/(det|box|bbox)/u.test(lower)) return 'dets';
  if (/(label|logit|class|score)/u.test(lower)) return 'labels';
  return 'unknown';
}

/**
 * Различить выходы `dets`/`labels` ДВУХ выходов графа по размерности
 * последней оси: боксы — всегда 4 числа (xyxy либо cxcywh), логиты классов —
 * `num_classes + 1` столбцов (+no-object).
 *
 * ## Известная неоднозначность и её разрешение
 *
 * У портала известно 3 типа блока (text/image/stamp) — если манифест не
 * добавляет своих классов сверху, `num_classes = 3`, и тогда labels ТОЖЕ имеют
 * 4 столбца (3 + no-object), совпадая с dets чистой геометрией. В этом случае
 * решение — по ИМЕНИ выхода (подстроки `det`/`box` против
 * `label`/`logit`/`class`, которые типовой экспорт RF-DETR/DETR использует
 * предсказуемо). Совпадение размеров без узнаваемого имени — это не «повезёт
 * с дефолтом», а честный отказ конфигурации: угадывание здесь молча
 * перепутало бы боксы и классы по всему прогону.
 */
export function resolveOutputNames(
  outputNames: readonly string[],
  outputMetadata: readonly InferenceSession.ValueMetadata[],
): OutputResolution {
  if (outputNames.length !== 2) {
    throw new DetectionModelMismatchError(
      `ONNX-граф обязан отдавать ровно 2 выхода (dets, labels), получено ${outputNames.length}: ` +
        `${outputNames.join(', ') || '—'}`,
    );
  }
  const [nameA, nameB] = outputNames as [string, string];
  const metaByName = new Map(outputMetadata.map((meta) => [meta.name, meta]));
  const lastA = lastAxisSize(tensorShape(metaByName.get(nameA)));
  const lastB = lastAxisSize(tensorShape(metaByName.get(nameB)));
  const aIsBoxShape = lastA === 4;
  const bIsBoxShape = lastB === 4;

  if (aIsBoxShape && !bIsBoxShape) return { detsName: nameA, labelsName: nameB };
  if (bIsBoxShape && !aIsBoxShape) return { detsName: nameB, labelsName: nameA };

  const classA = classifyByName(nameA);
  const classB = classifyByName(nameB);
  if (classA === 'dets' && classB !== 'dets') return { detsName: nameA, labelsName: nameB };
  if (classB === 'dets' && classA !== 'dets') return { detsName: nameB, labelsName: nameA };
  if (classA === 'labels' && classB !== 'labels') return { detsName: nameB, labelsName: nameA };
  if (classB === 'labels' && classA !== 'labels') return { detsName: nameA, labelsName: nameB };

  throw new DetectionModelMismatchError(
    `Не удалось различить выходы dets/labels ONNX-графа по размерности ` +
      `(${nameA}: последняя ось ${String(lastA)}, ${nameB}: последняя ось ${String(lastB)}) ` +
      'и по имени: переименуйте выходы графа при экспорте так, чтобы боксы содержали ' +
      '"det"/"box", а логиты классов — "label"/"logit"/"class".',
  );
}

function asFloat32Tensor(
  value: { readonly type: string; readonly data: unknown },
  what: string,
): Float32Array {
  if (value.type !== 'float32') {
    throw new DetectionModelMismatchError(
      `Выход ${what} ONNX-графа имеет тип ${value.type}, ожидался float32`,
    );
  }
  return value.data as Float32Array;
}

/**
 * Реализация `OnnxSessionPort` поверх `onnxruntime-node` (CPU execution
 * provider, ADR-0008). Имя входа и распределение выходов dets/labels
 * разрешаются ОДИН раз при создании сессии — `run()` их только применяет.
 */
export class OnnxRuntimeSession implements OnnxSessionPort {
  readonly #session: InferenceSession;
  readonly #inputName: string;
  readonly #outputs: OutputResolution;

  private constructor(session: InferenceSession, inputName: string, outputs: OutputResolution) {
    this.#session = session;
    this.#inputName = inputName;
    this.#outputs = outputs;
  }

  static async create(
    onnxPath: string,
    options: OnnxSessionOptions = {},
  ): Promise<OnnxRuntimeSession> {
    const session = await InferenceSession.create(onnxPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: options.intraOpNumThreads ?? DEFAULT_INTRA_OP_THREADS,
      interOpNumThreads: options.interOpNumThreads ?? DEFAULT_INTER_OP_THREADS,
    });
    if (session.inputNames.length !== 1) {
      throw new DetectionModelMismatchError(
        `ONNX-граф обязан иметь ровно 1 вход, получено ${session.inputNames.length}: ` +
          `${session.inputNames.join(', ')}`,
      );
    }
    const inputName = session.inputNames[0] as string;
    const outputs = resolveOutputNames(session.outputNames, session.outputMetadata);
    return new OnnxRuntimeSession(session, inputName, outputs);
  }

  async run(
    input: OnnxTensorLike,
  ): Promise<{ readonly dets: OnnxTensorLike; readonly labels: OnnxTensorLike }> {
    const tensor = new Tensor('float32', input.data, input.dims);
    const result = await this.#session.run({ [this.#inputName]: tensor });
    const dets = result[this.#outputs.detsName];
    const labels = result[this.#outputs.labelsName];
    if (dets === undefined || labels === undefined) {
      throw new DetectionModelMismatchError(
        'ONNX-сессия не вернула ожидаемые выходы dets/labels: проверьте состав fetches',
      );
    }
    return {
      dets: { data: asFloat32Tensor(dets, 'dets'), dims: dets.dims },
      labels: { data: asFloat32Tensor(labels, 'labels'), dims: labels.dims },
    };
  }

  async release(): Promise<void> {
    await this.#session.release();
  }
}
