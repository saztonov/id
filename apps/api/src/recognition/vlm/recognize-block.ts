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
 * ## Два внутренних повтора — оба ограничены единицей
 *
 * 1. **Корректирующий** — платный второй вызов при классифицированной
 *    ЖАНРОВОЙ ошибке (`classifyFailure → fixable_genre`): к system добавляется
 *    `CORRECTIVE_INSTRUCTION`, после второй неудачи повторов нет. Ровно один —
 *    решение плана v3 (порт `output_shape` RD WEB: детерминированный промпт
 *    без довеска даёт детерминированно тот же не-JSON).
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

import { LlmPayloadTooLargeError } from '../../llm/port.js';
import type { VlmJsonSchemaFormat, VlmPort, VlmRequest, VlmResponse } from '../../llm/vlm-port.js';

import { mapImageResponse, mapStampResponse, mapTextResponse, type VlmBlockContext } from './map.js';
import {
  CORRECTIVE_INSTRUCTION,
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

export type VlmBlockOutcome =
  | {
      kind: 'ok';
      block: RecognitionBlock;
      /** Разобранный и провалидированный ответ модели — источник `content_json`. */
      raw: unknown;
      response: VlmResponse;
      warnings: string[];
    }
  | { kind: 'invalid_response'; reason: string; response?: VlmResponse }
  | { kind: 'model_refusal'; reason: string; response?: VlmResponse };

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

  const call = async (systemPrompt: string): Promise<VlmResponse> => {
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
    });
    try {
      return await input.vlm.complete(request());
    } catch (error) {
      if (!isPayloadTooLarge(error) || input.downscale === undefined || downscaleUsed) {
        throw error;
      }
      downscaleUsed = true;
      png = await input.downscale(png);
      return await input.vlm.complete(request());
    }
  };

  /** `null` — жанровая ошибка, разрешён корректирующий повтор. */
  const interpret = (response: VlmResponse, allowGenreRetry: boolean): VlmBlockOutcome | null => {
    const finish = response.finishReason;
    if (finish === 'length' || finish === 'content_filter') {
      // Вызов оплачен, результата нет: оборванный/зацензуренный ответ — отказ
      // модели, а не непригодный результат (vlm-port.ts, ADR-0006).
      return {
        kind: 'model_refusal',
        reason: `finish_reason=${finish}: модель не завершила ответ`,
        response,
      };
    }
    if (response.text.trim() === '') {
      return {
        kind: 'model_refusal',
        reason:
          'пустой текст ответа: пустой блок выражается JSON-объектом с пустыми полями, а не пустой строкой',
        response,
      };
    }

    const parsed = extractJson(stripNoise(response.text));
    if (parsed === null) {
      if (allowGenreRetry) return null;
      return {
        kind: 'invalid_response',
        reason: 'ответ не является JSON-объектом (и после корректирующего повтора)',
        response,
      };
    }

    const finishInvalid = (reasonCode: string): VlmBlockOutcome => ({
      kind: 'invalid_response',
      reason: reasonCode,
      response,
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
    ): VlmBlockOutcome | null => {
      if (validation.invalid !== null) return finishInvalid(validation.invalid);
      return { kind: 'ok', block, raw, response, warnings: [...validation.warnings] };
    };

    const schemaFailure = (error: ZodError): VlmBlockOutcome | null => {
      const failureClass = classifyFailure(response.text, error);
      if (failureClass === 'fixable_genre' && allowGenreRetry) return null;
      return finishInvalid(`ответ не по схеме (${failureClass}): ${issuesSummary(error)}`);
    };

    switch (input.block.blockType) {
      case 'text': {
        const result = vlmTextResponseSchema.safeParse(parsed);
        if (!result.success) return schemaFailure(result.error);
        return complete(mapTextResponse(result.data, context), result.data, validateText(result.data));
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
  if (initial !== null) return initial;

  const corrected = await call(
    `${input.prompt.systemPrompt}\n\n${CORRECTIVE_INSTRUCTION[input.block.blockType]}`,
  );
  const second = interpret(corrected, false);
  // interpret(…, false) по построению не просит повтора; страховка типов.
  return (
    second ?? {
      kind: 'invalid_response',
      reason: 'ответ не разобран после корректирующего повтора',
      response: corrected,
    }
  );
}
