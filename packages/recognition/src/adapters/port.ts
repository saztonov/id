/**
 * Порт будущего источника распознавания (OpenRouter VLM и любой следующий).
 *
 * ЗДЕСЬ ТОЛЬКО ТИПЫ. Реализация — отдельный этап интеграции, на котором
 * решаются вопросы, намеренно не зафиксированные контрактом:
 *
 * * канал: корпоративный шлюз proxy_llm (§10 запрещает прямые вызовы вендора,
 *   `DIRECT_VENDOR_HOSTS` в env.ts) либо отдельное решение заказчика;
 * * чьи изображения: байтов картинок в типе НЕТ намеренно — кто и как режет
 *   страницу на кропы (замороженная разметка портала — текущее решение
 *   заказчика) и по какому каналу они уходят, фиксируется на интеграции;
 * * поведение при невалидном ответе: результат, не прошедший валидацию по
 *   схеме, ОБЯЗАН отличаться от отказа модели — это разные исходы с разным
 *   поведением (требование в стиле docs/RDWEB_IMPROVEMENTS.md §3.3).
 */
import type { RecognitionProvider, RecognitionResult } from '../schema.js';

/** Блок замороженной разметки портала, предъявляемый источнику. */
export interface RecognitionRequestBlock {
  readonly layoutBlockId: string;
  readonly blockType: 'text' | 'image' | 'stamp';
  readonly coordsNorm: readonly [number, number, number, number];
}

export interface RecognitionRequestPage {
  readonly workingPageIndex: number;
  /**
   * Блоки страницы либо `null` — источник работает постранично и сам решает,
   * что на странице есть. Оба режима укладываются в контракт: `ordinal` и
   * `coordsNorm` у канонического блока nullable.
   */
  readonly blocks: readonly RecognitionRequestBlock[] | null;
}

export interface RecognitionRequest {
  readonly runId: string;
  readonly granularity: 'page' | 'block';
  readonly pages: readonly RecognitionRequestPage[];
}

export interface RecognitionSourcePort {
  readonly provider: RecognitionProvider;
  recognize(request: RecognitionRequest): Promise<RecognitionResult>;
}
