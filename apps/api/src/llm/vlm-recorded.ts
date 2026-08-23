/**
 * Офлайн-двойник VLM: зафиксированные ответы по хэшу канонического входа.
 *
 * Контракт тот же, что у текстового двойника (`recorded.ts`, урок S7): двойник
 * не смеет быть мягче оригинала. Незаписанный вход — это отказ с хэшем в
 * сообщении, а не «что-нибудь правдоподобное»: молчаливый ответ на неизвестный
 * хэш скрыл бы изменение промта, схемы или crop policy — всё это входит в
 * `vlmInputHash`, и любое из них обязано ронять тест до осознанного добавления
 * новой записи.
 *
 * «Плохие» ответы модели (оборванный `finish_reason='length'`, пустой текст,
 * не-JSON) здесь выражаются самой записью: `text` и `finishReason` отдаются
 * как записаны, без починки — классификация исхода блока принадлежит
 * `recognize-block`, и двойник обязан довозить до него те же факты, что и
 * боевой провайдер. Кэша у двойника нет по той же причине, что у текстового:
 * запись обязана воспроизводиться на каждом вызове.
 */
import { LlmRecordingMissingError } from './port.js';
import type { LlmPolicy } from './policy.js';
import { responseHash } from './prompt.js';
import type { VlmPort, VlmRequest, VlmResponse } from './vlm-port.js';
import { vlmInputHash } from './vlm-prompt.js';

const PROVIDER = 'recorded' as const;

/**
 * Записанный ответ модели на конкретный канонический вход.
 *
 * `finishReason` обязателен (пусть и `null`): по нему вызывающий отличает
 * обрыв от завершения, и запись без него означала бы «двойник добрее
 * оригинала — у него ответы никогда не обрываются». Токены и стоимость
 * опциональны: они нужны сценариям бюджета, а запись без них честно отдаёт
 * `null` — «провайдер не сообщил».
 */
export interface VlmRecordedResponse {
  readonly text: string;
  readonly finishReason: string | null;
  /** Фактически «ответившая» модель; по умолчанию — запрошенная. */
  readonly model?: string | undefined;
  readonly tokensIn?: number | undefined;
  readonly tokensOut?: number | undefined;
  readonly cost?: number | undefined;
}

export interface RecordedVlmProviderOptions {
  /** Ключ — `vlmInputHash(request)`, hex. */
  readonly responses: ReadonlyMap<string, VlmRecordedResponse>;
  /**
   * Применяется только allowlist моделей — как у текстового двойника: иначе
   * тесты пропустили бы модель, которую production отвергнет до вызова.
   */
  readonly policy?: LlmPolicy | undefined;
  readonly now?: (() => number) | undefined;
}

export class RecordedVlmProvider implements VlmPort {
  readonly #options: RecordedVlmProviderOptions;
  readonly #now: () => number;

  constructor(options: RecordedVlmProviderOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Хэш, под которым нужно записать ответ на такой запрос. */
  static hashOf(request: VlmRequest): string {
    return vlmInputHash(request);
  }

  /**
   * Хелпер для тестов: готовая пара «хэш → запись» для конструктора Map.
   * Считать хэш руками в каждом тесте — значит разъехаться с канонизацией
   * при первой её правке.
   */
  static recordingFor(
    request: VlmRequest,
    response: VlmRecordedResponse,
  ): readonly [string, VlmRecordedResponse] {
    return [RecordedVlmProvider.hashOf(request), response];
  }

  async complete(request: VlmRequest): Promise<VlmResponse> {
    const startedAt = this.#now();
    const model = request.model;
    this.#options.policy?.ensureModelAllowed(model);

    const inputHash = vlmInputHash(request);
    const recorded = this.#options.responses.get(inputHash);
    if (recorded === undefined) {
      throw new LlmRecordingMissingError(
        inputHash,
        `Нет записанного VLM-ответа для хэша ${inputHash} (промт ` +
          `${request.promptCode}@${request.promptVersion}, схема ${request.schemaVersion}, ` +
          `модель ${model}). Вход изменился (промт, схема, кроп, generation-профиль) либо ` +
          'запись не добавлена: правдоподобный ответ скрыл бы это изменение, поэтому вызов ' +
          'отвергнут.',
      );
    }

    return {
      text: recorded.text,
      // Офлайн-двойник инструментов не воспроизводит: записанный ответ — это
      // окончательный ответ, а круг «модель попросила кроп» без живого шлюза
      // воспроизвести нечем. Пустой список честнее выдуманного вызова.
      toolCalls: [],
      model: recorded.model ?? model,
      requestedModel: model,
      provider: PROVIDER,
      tokensIn: recorded.tokensIn ?? null,
      tokensOut: recorded.tokensOut ?? null,
      cost: recorded.cost ?? null,
      latencyMs: this.#now() - startedAt,
      inputHash,
      outputHash: responseHash(recorded.text),
      cacheHit: false,
      finishReason: recorded.finishReason,
    };
  }
}
