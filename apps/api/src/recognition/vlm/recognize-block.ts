/**
 * Распознавание ОДНОГО замороженного блока через VLM-порт (ADR-0007).
 *
 * ## Три исхода — требование ADR-0006
 *
 * `ok` / `invalid_response` / `model_refusal` различаются принципиально:
 *
 * - `invalid_response` — модель ЧТО-ТО ответила, но результат непригоден
 *   (не JSON, не по схеме, содержательный invalid-код валидатора). Дефект на
 *   нашей стороне контракта: промпт, схема или сама модель.
 * - `model_refusal` — модель НЕ ДАЛА результата: ответ оборван лимитом
 *   (`finish_reason=length`), срезан контент-фильтром или пуст. Пустая строка —
 *   не результат: «пустой блок» выражается JSON-объектом с пустыми полями
 *   (`{"fragments": []}`, штамп из null), и это единственная законная форма
 *   пустоты.
 *
 * Оба неуспеха НЕ ретраятся сетью (это решает движок задач по классам
 *   `LlmError`, а здесь ошибок нет — есть исходы); блок остаётся непокрытым, и
 *   прогон завершится `failed` при финализации.
 *
 * ## Потолок вызовов на блок
 *
 * `maxCropRequests + 1` на проход, проходов два (основной и корректирующий):
 * шесть вызовов при потолке по умолчанию, восемь у блока «страница целиком».
 * Больше не бывает: круги ограничены потолком, а закрывающий вызов запрещает
 * инструмент и потому не порождает следующего круга.
 *
 * ## Два внутренних повтора — оба ограничены единицей
 *
 * 1. **Корректирующий** — платный второй вызов, и причин у него две при одном
 *    потолке. Первая: классифицированная ЖАНРОВАЯ ошибка
 *    (`classifyFailure → fixable_genre`) — к system добавляется
 *    `CORRECTIVE_INSTRUCTION`. Вторая: содержательный код `retryable`
 *    валидатора (таблица без единой строки) — довесок берётся из
 *    `RETRY_INSTRUCTION` по коду. После второй неудачи повторов ЗДЕСЬ нет:
 *    жанровая ошибка становится `invalid_response`, и `retryable` — тоже, пока
 *    вызывающий не скажет `acceptRetryable`. Скажет он это на раунде
 *    дораспознавания страницы: у портала есть ещё один круг, и тратить его —
 *    его решение, а не порта. Ровно один повтор — решение плана v3 (порт
 *    `output_shape` RD WEB: детерминированный промпт без довеска даёт
 *    детерминированно тот же не-JSON).
 * 2. **Downscale** — при отказе транспорта «тело слишком велико»
 *    (`LlmPayloadTooLargeError`) и переданной инъекции `downscale` кроп ОДИН
 *    раз уменьшается и вызов повторяется. Инъекция, а не импорт: sharp живёт в
 *    воркере, api-пакету он не зависимость.
 *
 * Все прочие `LlmError` пробрасываются наружу как есть: ретраи, backoff и
 * остановка батча — юрисдикция движка задач.
 */
import type { BlockType } from '@id/contracts';
import type { RecognitionBlock } from '@id/recognition';
import type { ZodError } from 'zod';

import { LlmPayloadTooLargeError, LlmUpstreamError } from '../../llm/port.js';
import type {
  VlmJsonSchemaFormat,
  VlmPort,
  VlmRequest,
  VlmResponse,
  VlmToolCall,
  VlmToolExchange,
} from '../../llm/vlm-port.js';

import {
  mapImageResponse,
  mapStampResponse,
  mapTextResponse,
  type VlmBlockContext,
} from './map.js';
import {
  CORRECTIVE_INSTRUCTION,
  NO_MORE_CROPS_INSTRUCTION,
  RETRY_INSTRUCTION,
  classifyFailure,
  extractJson,
  stripNoise,
  validateStamp,
  validateText,
  type BlockValidation,
} from './postprocess.js';
import { substitutePlaceholders } from './prompts.js';
import {
  vlmImageResponseSchema,
  vlmStampResponseSchema,
  vlmTextResponseSchema,
} from './schemas.js';

/** Один запрос инструмента и что портал на него ответил (S28). */
export interface VlmCropEvent {
  /** Границы участка, нормированные к странице; `null` — аргументы негодны. */
  readonly rect: readonly [number, number, number, number] | null;
  readonly outcome:
    /** Участок вырезан и приложен к диалогу. */
    | 'granted'
    /** Резчик отказал: участок вне листа или вырожден. */
    | 'degenerate'
    /** Резчик сломался; блок при этом дочитывается по основному кропу. */
    | 'crop_failed'
    /** Аргументы инструмента не прямоугольник. */
    | 'invalid_args'
    /** Модель позвала инструмент, которого не существует. */
    | 'unknown_tool'
    /** Круги кончились: запрос отклонён потолком, выдачи не будет. */
    | 'ceiling_rejected';
}

/**
 * Доказательства прохода, общие для всех трёх исходов.
 *
 * `calls` — ВСЕ физические ответы модели (круги дозапроса, закрывающий вызов,
 * корректирующий повтор), а не только последний: каждый из них оплачен, и по
 * строке `ai_runs` на каждый — единственный способ увидеть настоящую цену
 * блока. Пока наружу отдавался один ответ, круги кропа не попадали в учёт
 * вовсе.
 */
export interface VlmBlockEvidence {
  readonly calls: readonly VlmResponse[];
  readonly cropTrail: readonly VlmCropEvent[];
  /** Сколько кругов дозапроса состоялось (0 — модель обошлась без них). */
  readonly cropRequests: number;
  /**
   * Понадобился ли закрывающий вызов.
   *
   * Отдельным полем, а не выводом из `warnings`: по нему считается доля блоков,
   * которым потолка кругов не хватило, — а это и есть ответ на вопрос, верен
   * ли потолок для блоков такого рода.
   */
  readonly forcedFinal: boolean;
}

export type VlmBlockOutcome =
  | ({
      kind: 'ok';
      block: RecognitionBlock;
      /** Разобранный и провалидированный ответ модели — источник `content_json`. */
      raw: unknown;
      response: VlmResponse;
      warnings: string[];
    } & VlmBlockEvidence)
  | ({ kind: 'invalid_response'; reason: string; response?: VlmResponse } & VlmBlockEvidence)
  | ({ kind: 'model_refusal'; reason: string; response?: VlmResponse } & VlmBlockEvidence);

/**
 * Просьба повторить вызов с довеском `retryWith` к system-промпту.
 *
 * Отдельный тип, а не `null`: причин повтора теперь две, и им нужны разные
 * инструкции. Возвращать `null` и выбирать инструкцию у вызывающего значило бы
 * решать в одном месте по признаку, известному в другом.
 */
interface RetryRequest {
  readonly retryWith: string;
}

function isRetryRequest(value: VlmBlockOutcome | RetryRequest): value is RetryRequest {
  return 'retryWith' in value;
}

export interface RecognizeBlockPrompt {
  readonly code: string;
  readonly version: number;
  readonly systemPrompt: string;
  /** С плейсхолдерами; подстановка происходит здесь (`substitutePlaceholders`). */
  readonly userTemplate: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly topK?: number | undefined;
  readonly responseFormat: VlmJsonSchemaFormat;
  readonly schemaVersion: string;
}

export interface RecognizeBlockInput {
  readonly vlm: VlmPort;
  readonly prompt: RecognizeBlockPrompt;
  /** Модель из `settings_snapshot` прогона — обязательна (контракт VlmRequest). */
  readonly model: string;
  readonly block: {
    readonly layoutBlockId: string;
    readonly blockType: BlockType;
    readonly coordsNorm: readonly [number, number, number, number];
    readonly sortOrder: number;
  };
  readonly cropPng: Uint8Array;
  /** 1-based (для человека в {PAGE_NUM}): workingPageIndex + 1. */
  readonly pageNumber: number;
  /** Инъекция воркера (там sharp); отсутствие = downscale-повтора не будет. */
  readonly downscale?: ((png: Uint8Array) => Promise<Uint8Array>) | undefined;
  /**
   * Выдача участка ТОЙ ЖЕ страницы по запросу модели (ADR-0013, S21).
   *
   * Инъекция, а не импорт: резать умеет sharp, живущий в воркере. Отсутствие
   * означает, что инструмент модели вообще не объявляется — она о нём не
   * узнает и попросить не сможет.
   *
   * Координаты нормированы к странице (0..1), как `coordsNorm` блока. Отказ
   * (`null`) — законный ответ: участок вне листа или вырожден. Он доезжает до
   * модели текстом, а не молчанием, иначе она будет ждать кроп, которого нет.
   */
  readonly requestCrop?:
    ((rect: readonly [number, number, number, number]) => Promise<Uint8Array | null>) | undefined;
  /**
   * Потолок кругов дозапроса для ЭТОГО блока; по умолчанию `MAX_CROP_REQUESTS`.
   *
   * Параметром, а не константой, потому что блоки неравны: у блока «страница
   * целиком» (заплатка пустой страницы) кроп — единственный способ увеличить
   * мелкий шрифт, и двух кругов ему бывает мало, тогда как точечному блоку
   * второй круг чаще всего уже не нужен. Решение принимает вызывающий: он
   * знает провенанс блока, а порт — нет.
   */
  readonly maxCropRequests?: number | undefined;
  /**
   * Принимать ли результат, чей дефект `retryable` пережил корректирующий повтор.
   *
   * Граница приёмки стоит на КРУГ ВЫШЕ повтора и потому решается снаружи.
   * Внутри блока повтор один: если и он вернул таблицу без строк, у портала
   * остаётся ещё один инструмент — раунд дораспознавания страницы, где к
   * system-промпту добавляется своя инструкция и ответ не приходит из кэша по
   * тому же `input_hash`. Пока этот инструмент не израсходован, упрямая
   * пустота — непригодный результат (`invalid_response`), и блок НЕ пишется:
   * записанный блок закрыл бы страницу чекпоинтом, и раунду нечего было бы
   * переигрывать.
   *
   * На самом раунде (`true`) результат принимается с предупреждением: ронять
   * страницу — а в строгом режиме и весь прогон — из-за одного блока дороже,
   * чем потерять его содержимое с записью в обратную связь.
   */
  readonly acceptRetryable?: boolean | undefined;
  /**
   * Отмена попытки задачи (S41).
   *
   * Один блок — это до восьми физических вызовов подряд, и каждый из них после
   * отмены был бы оплачен ради результата, который записать уже некуда. Сигнал
   * доезжает до каждого вызова, а не проверяется один раз на входе: отмена
   * приходит посреди диалога чаще, чем до него.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Потолок дозапросов на один блок по умолчанию.
 *
 * Два — не «на всякий случай», а граница платности: каждый круг это полный
 * повторный вызов со всем диалогом в теле, то есть растущая цена. Модель,
 * которой двух взглядов на соседний участок не хватило, третьим чаще всего не
 * воспользуется — она зациклилась, и платить за это должен потолок, а не
 * заказчик.
 *
 * Потолок при этом больше не обрывает диалог молчанием: исчерпав круги, портал
 * делает ЗАКРЫВАЮЩИЙ вызов с запрещённым инструментом (`tool_choice: none`) и
 * требованием ответить по имеющемуся. Прежде на этом месте блок объявлялся
 * отказом, и один такой блок из восьмидесяти пяти ронял весь прогон.
 *
 * Отдельным блокам потолок поднимает вызывающий (`maxCropRequests`).
 */
export const MAX_CROP_REQUESTS = 2;

/** Имя инструмента: на него смотрит разбор ответа и промт. */
export const REQUEST_CROP_TOOL = 'request_crop';

/**
 * Объявление инструмента.
 *
 * Границы участка нормированы к странице, как координаты блоков, — модель уже
 * видит их в этой системе и не обязана знать про пиксели растра, DPI и поворот.
 */
export const REQUEST_CROP_TOOL_SPEC = {
  name: REQUEST_CROP_TOOL,
  description:
    'Показать другой участок ТОЙ ЖЕ страницы. Пользуйся, только если содержимое ' +
    'присланного кропа обрезано или неразборчиво и соседний участок нужен, чтобы ' +
    'прочитать его дословно. Не пользуйся, чтобы восстановить смысл по контексту.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['x0', 'y0', 'x1', 'y1'],
    properties: {
      x0: { type: 'number', minimum: 0, maximum: 1, description: 'Левая граница, доля ширины' },
      y0: { type: 'number', minimum: 0, maximum: 1, description: 'Верхняя граница, доля высоты' },
      x1: { type: 'number', minimum: 0, maximum: 1, description: 'Правая граница, доля ширины' },
      y1: { type: 'number', minimum: 0, maximum: 1, description: 'Нижняя граница, доля высоты' },
    },
  },
} as const;

/** Разбор аргументов инструмента: всё, что не прямоугольник, — отказ с причиной. */
export function parseCropRect(
  argumentsJson: string,
): { rect: readonly [number, number, number, number] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return { error: 'аргументы инструмента не являются JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { error: 'аргументы инструмента не являются объектом' };
  }
  const record = parsed as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const x0 = read('x0');
  const y0 = read('y0');
  const x1 = read('x1');
  const y1 = read('y1');
  if (x0 === null || y0 === null || x1 === null || y1 === null) {
    return { error: 'нужны четыре числа: x0, y0, x1, y1' };
  }
  // Границы листа и вырожденность проверяются здесь, а не в резчике: отказ
  // обязан быть внятным для модели, а не «sharp не смог».
  const inRange = [x0, y0, x1, y1].every((value) => value >= 0 && value <= 1);
  if (!inRange) return { error: 'координаты выходят за пределы листа (допустимо 0..1)' };
  if (x1 <= x0 || y1 <= y0) return { error: 'участок вырожден: x1>x0 и y1>y0 обязательны' };
  return { rect: [x0, y0, x1, y1] };
}

/**
 * Проверка и классом (Ф3 в дереве), и по `name`: страховка на случай, когда
 * инстанс пришёл из другой копии модуля (алиасы vitest ↔ dist сборки) — тогда
 * `instanceof` через границу копий лжёт, а имя класса контрактно стабильно.
 */
function isPayloadTooLarge(error: unknown): boolean {
  if (error instanceof LlmPayloadTooLargeError) return true;
  return error instanceof Error && error.name === 'LlmPayloadTooLargeError';
}

/** Краткая сводка ошибок схемы БЕЗ содержимого ответа (§11: текст не светим). */
function issuesSummary(error: ZodError): string {
  const shown = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length === 0 ? '<root>' : issue.path.join('.')}: ${issue.code}`)
    .join('; ');
  const rest = error.issues.length - 3;
  return rest > 0 ? `${shown}; +${rest}` : shown;
}

export async function recognizeBlock(input: RecognizeBlockInput): Promise<VlmBlockOutcome> {
  const userPrompt = substitutePlaceholders(input.prompt.userTemplate, {
    pageNumber: input.pageNumber,
    layoutBlockId: input.block.layoutBlockId,
  });

  // Кроп мутирует единожды (downscale) и остаётся уменьшенным для
  // корректирующего повтора: раз тело не влезло один раз, не влезет и второй.
  let png = input.cropPng;
  let downscaleUsed = false;
  /** Сколько кругов дозапроса состоялось: уходит в предупреждения исхода. */
  let cropRequests = 0;
  /** Понадобился ли закрывающий вызов: различает две разные причины отказа. */
  let forcedFinalUsed = false;
  /** Каждый запрос инструмента и что портал на него ответил (S28). */
  const cropTrail: VlmCropEvent[] = [];
  /** Все физические ответы модели: по строке `ai_runs` на каждый (S28). */
  const calls: VlmResponse[] = [];

  const maxCropRequests = Math.max(0, input.maxCropRequests ?? MAX_CROP_REQUESTS);

  /**
   * Один вызов модели с уже состоявшимися кругами дозапроса.
   *
   * Диалог передаётся целиком: у шлюза нет состояния, а `X-Idempotency-Key`
   * считается по каноническому входу — круги обязаны в него входить, иначе
   * второй вызов склеится с первым и вернёт тот же запрос кропа (см.
   * `vlm-prompt.ts`, версия канонизации 3). Право позвать инструмент входит
   * туда же: закрывающий вызов отличается от обычного только им и довеском к
   * system, и без обоих в хэше он вернулся бы из кэша прежним отказом.
   */
  const callOnce = async (
    systemPrompt: string,
    exchanges: readonly VlmToolExchange[],
    toolChoice: 'auto' | 'none',
  ): Promise<VlmResponse> => {
    const request = (): VlmRequest => ({
      stage: 'recognize',
      promptCode: input.prompt.code,
      promptVersion: input.prompt.version,
      systemPrompt,
      userPrompt,
      images: [{ png }],
      responseFormat: input.prompt.responseFormat,
      schemaVersion: input.prompt.schemaVersion,
      model: input.model,
      temperature: input.prompt.temperature,
      maxTokens: input.prompt.maxTokens,
      topK: input.prompt.topK,
      // Инструмент объявляется, только если его есть чем исполнить: модель,
      // которой пообещали кроп и не дали, застрянет на запросе. Объявление
      // сохраняется и в закрывающем вызове — звать его запрещает `toolChoice`,
      // а не изъятие: история прошлых кругов уже уехала в `messages`, и часть
      // провайдеров отвергает её при пустом списке инструментов.
      ...(input.requestCrop !== undefined ? { tools: [REQUEST_CROP_TOOL_SPEC], toolChoice } : {}),
      ...(exchanges.length > 0 ? { exchanges } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    const record = (response: VlmResponse): VlmResponse => {
      calls.push(response);
      return response;
    };
    try {
      return record(await input.vlm.complete(request()));
    } catch (error) {
      if (!isPayloadTooLarge(error) || input.downscale === undefined || downscaleUsed) {
        throw error;
      }
      downscaleUsed = true;
      png = await input.downscale(png);
      return record(await input.vlm.complete(request()));
    }
  };

  /**
   * Выдача одного запрошенного участка с записью следа.
   *
   * Отказ резчика (`null`) и его поломка (исключение) доезжают до модели
   * ТЕКСТОМ: она ждёт картинку, и молчание вместо ответа — это зависший круг,
   * оплаченный целиком. Поломка при этом не роняет блок: соседний участок не
   * вырезался, но прочитать основной кроп это не мешает.
   */
  const serveCrop = async (toolCall: VlmToolCall): Promise<VlmToolExchange['results'][number]> => {
    if (toolCall.name !== REQUEST_CROP_TOOL) {
      cropTrail.push({ rect: null, outcome: 'unknown_tool' });
      return {
        toolCallId: toolCall.id,
        text: `Инструмент «${toolCall.name}» не существует.`,
        images: [],
      };
    }
    const parsedRect = parseCropRect(toolCall.argumentsJson);
    if ('error' in parsedRect) {
      cropTrail.push({ rect: null, outcome: 'invalid_args' });
      return { toolCallId: toolCall.id, text: parsedRect.error, images: [] };
    }
    // Не `undefined` по построению: инструмент не объявляется без резчика.
    const requestCrop = input.requestCrop as NonNullable<RecognizeBlockInput['requestCrop']>;
    let cropped: Uint8Array | null;
    try {
      cropped = await requestCrop(parsedRect.rect);
    } catch {
      cropTrail.push({ rect: parsedRect.rect, outcome: 'crop_failed' });
      return { toolCallId: toolCall.id, text: 'Участок вырезать не удалось.', images: [] };
    }
    if (cropped === null) {
      cropTrail.push({ rect: parsedRect.rect, outcome: 'degenerate' });
      return { toolCallId: toolCall.id, text: 'Участок вырезать не удалось.', images: [] };
    }
    cropTrail.push({ rect: parsedRect.rect, outcome: 'granted' });
    return { toolCallId: toolCall.id, text: 'Участок приложен.', images: [{ png: cropped }] };
  };

  /**
   * Вызов с отработкой дозапросов кропов до окончательного ответа.
   *
   * Потолок кругов больше не обрывает диалог молчанием: вызов, следующий за
   * ПОСЛЕДНИМ разрешённым кругом, идёт ЗАКРЫВАЮЩИМ — инструмент запрещён
   * (`tool_choice: none`), в system добавлено последнее слово. Модель, которой
   * не хватило участков, отвечает по имеющемуся вместо того, чтобы остаться
   * отказом.
   *
   * Вызовов при этом ровно столько же, сколько было раньше: `maxCropRequests
   * + 1`. Закрывающий занимает место того вызова, который прежде уходил
   * впустую — модель на нём просила очередной участок, а портал просто
   * переставал отвечать. Лишнего вызова с самым тяжёлым телом (весь диалог с
   * картинками внутри) здесь нет.
   */
  const call = async (systemPrompt: string): Promise<VlmResponse> => {
    const exchanges: VlmToolExchange[] = [];
    /** Идёт ли ЗАКРЫВАЮЩИЙ вызов: круги исчерпаны либо их нет вовсе. */
    let closing = maxCropRequests === 0;
    if (closing) forcedFinalUsed = true;

    const promptOf = (): string =>
      closing ? `${systemPrompt}\n\n${NO_MORE_CROPS_INSTRUCTION}` : systemPrompt;

    let response = await callOnce(promptOf(), exchanges, closing ? 'none' : 'auto');

    while (response.toolCalls.length > 0 && input.requestCrop !== undefined && !closing) {
      cropRequests += 1;

      const results: VlmToolExchange['results'][number][] = [];
      for (const toolCall of response.toolCalls) {
        results.push(await serveCrop(toolCall));
      }

      exchanges.push({ calls: response.toolCalls, results });
      closing = exchanges.length >= maxCropRequests;
      if (closing) forcedFinalUsed = true;
      response = await callOnce(promptOf(), exchanges, closing ? 'none' : 'auto');
    }

    if (response.toolCalls.length > 0 && closing) {
      // Модель просит участок в вызове, где инструмент ей запрещён. Выдачи не
      // будет, и запрос обязан остаться в следе: иначе разбор видит выданные
      // участки и не видит того, на котором блок встал.
      for (const toolCall of response.toolCalls) {
        const parsed = parseCropRect(toolCall.argumentsJson);
        cropTrail.push({
          rect: 'error' in parsed ? null : parsed.rect,
          outcome: 'ceiling_rejected',
        });
      }
    }

    return response;
  };

  /** Доказательства прохода: одинаковые поля у всех трёх исходов. */
  const evidence = (): VlmBlockEvidence => ({
    calls: [...calls],
    cropTrail: [...cropTrail],
    cropRequests,
    forcedFinal: forcedFinalUsed,
  });

  /** `RetryRequest` — дефект чинится повтором; повтор разрешён только первым проходом. */
  const interpret = (
    response: VlmResponse,
    allowRetry: boolean,
  ): VlmBlockOutcome | RetryRequest => {
    const finish = response.finishReason;
    if (finish === 'length' || finish === 'content_filter') {
      // Вызов оплачен, результата нет: оборванный/зацензуренный ответ — отказ
      // модели, а не непригодный результат (vlm-port.ts, ADR-0006).
      return {
        kind: 'model_refusal',
        reason: `finish_reason=${finish}: модель не завершила ответ`,
        response,
        ...evidence(),
      };
    }
    if (response.toolCalls.length > 0) {
      // Модель просит участок там, где просить уже нечем: либо инструмент не
      // подключён вовсе, либо закрывающий вызов его запретил, а она просит
      // всё равно. Это НЕ пустой ответ: текста нет потому, что она ещё не
      // говорила по существу, и путать эти два случая нельзя — чинятся они
      // разным (потолок кругов против промта и схемы).
      return {
        kind: 'model_refusal',
        reason: forcedFinalUsed
          ? `модель просит кроп и после закрывающего вызова: кругов ${String(cropRequests)}, инструмент был запрещён`
          : `модель запрашивает дополнительный кроп после ${String(cropRequests)} кругов: выдать его нечем`,
        response,
        ...evidence(),
      };
    }
    if (response.text.trim() === '') {
      /**
       * Пустое тело при `finish_reason=error` — не отказ модели, а её молчание.
       *
       * Отказ означает, что модель ответила и ответ непригоден: оборвалась по
       * лимиту, попала под фильтр, вернула пустую строку вместо пустого
       * объекта. Здесь же провайдер сообщил СВОЮ ошибку — токенов ноль, модель
       * не названа, — и повтор её лечит. Пока оба случая были одним исходом,
       * блок оставался непокрытым без единой попытки повтора, и прогон
       * закрывался отказом по неполному покрытию из-за одного такого ответа.
       */
      if (finish === 'error') {
        throw new LlmUpstreamError(
          'Шлюз LLM вернул пустой ответ с finish_reason=error: модель не отвечала.',
        );
      }
      return {
        kind: 'model_refusal',
        reason:
          'пустой текст ответа: пустой блок выражается JSON-объектом с пустыми полями, а не пустой строкой',
        response,
        ...evidence(),
      };
    }

    const parsed = extractJson(stripNoise(response.text));
    if (parsed === null) {
      if (allowRetry) return { retryWith: CORRECTIVE_INSTRUCTION[input.block.blockType] };
      return {
        kind: 'invalid_response',
        reason: 'ответ не является JSON-объектом (и после корректирующего повтора)',
        response,
        ...evidence(),
      };
    }

    const finishInvalid = (reasonCode: string): VlmBlockOutcome => ({
      kind: 'invalid_response',
      reason: reasonCode,
      response,
      ...evidence(),
    });

    const context: VlmBlockContext = {
      layoutBlockId: input.block.layoutBlockId,
      sortOrder: input.block.sortOrder,
      coordsNorm: input.block.coordsNorm,
      modelId: response.model,
    };

    const complete = (
      block: RecognitionBlock,
      raw: unknown,
      validation: BlockValidation,
    ): VlmBlockOutcome | RetryRequest => {
      if (validation.invalid !== null) return finishInvalid(validation.invalid);
      const warnings = [...validation.warnings];
      if (validation.retryable !== null) {
        // Первым проходом — повтор с адресной инструкцией.
        if (allowRetry) {
          return {
            retryWith:
              RETRY_INSTRUCTION[validation.retryable] ??
              CORRECTIVE_INSTRUCTION[input.block.blockType],
          };
        }
        // Повтор не помог. Пока у портала остаётся раунд дораспознавания
        // страницы, результат непригоден и блок не пишется: записанный блок
        // закрыл бы страницу чекпоинтом, и переигрывать было бы нечего.
        if (input.acceptRetryable !== true) return finishInvalid(validation.retryable);
        // Раунд израсходован: упрямая пустота остаётся ответом модели, и
        // ронять из-за неё страницу — в строгом режиме весь прогон — дороже,
        // чем принять её с предупреждением и записью в обратную связь.
        warnings.push(validation.retryable);
      }
      // Дозапрос кропа — не дефект, но факт, влияющий на цену и на доверие к
      // результату: он обязан быть виден в предупреждениях прогона, а не
      // только в счётчиках шлюза. Закрывающий вызов отмечается отдельно: это
      // ответ, данный без участка, который модель считала нужным.
      if (cropRequests > 0) warnings.push(`crop_requests=${String(cropRequests)}`);
      if (forcedFinalUsed) warnings.push('crop_ceiling_reached');
      return { kind: 'ok', block, raw, response, warnings, ...evidence() };
    };

    const schemaFailure = (error: ZodError): VlmBlockOutcome | RetryRequest => {
      const failureClass = classifyFailure(response.text, error);
      if (failureClass === 'fixable_genre' && allowRetry) {
        return { retryWith: CORRECTIVE_INSTRUCTION[input.block.blockType] };
      }
      return finishInvalid(`ответ не по схеме (${failureClass}): ${issuesSummary(error)}`);
    };

    switch (input.block.blockType) {
      case 'text': {
        const result = vlmTextResponseSchema.safeParse(parsed);
        if (!result.success) return schemaFailure(result.error);
        return complete(
          mapTextResponse(result.data, context),
          result.data,
          validateText(result.data),
        );
      }
      case 'image': {
        const result = vlmImageResponseSchema.safeParse(parsed);
        if (!result.success) return schemaFailure(result.error);
        // Содержательных image-валидаторов v1 нет: пустота полей законна, а
        // латинские двойники осей требуют инфраструктуры cyrillic_script —
        // сознательно отложено (см. план, приёмка shadow-прогонами).
        return complete(mapImageResponse(result.data, context), result.data, {
          warnings: [],
          invalid: null,
          retryable: null,
        });
      }
      case 'stamp': {
        const result = vlmStampResponseSchema.safeParse(parsed);
        if (!result.success) return schemaFailure(result.error);
        return complete(
          mapStampResponse(result.data, context),
          result.data,
          validateStamp(result.data),
        );
      }
    }
  };

  const first = await call(input.prompt.systemPrompt);
  const initial = interpret(first, true);
  if (!isRetryRequest(initial)) return initial;

  const corrected = await call(`${input.prompt.systemPrompt}\n\n${initial.retryWith}`);
  const second = interpret(corrected, false);
  // interpret(…, false) по построению повтора не просит; страховка типов.
  return isRetryRequest(second)
    ? {
        kind: 'invalid_response',
        reason: 'ответ не разобран после корректирующего повтора',
        response: corrected,
        ...evidence(),
      }
    : second;
}
