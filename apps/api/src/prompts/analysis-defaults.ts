/**
 * Встроенные тексты промптов стадий анализа — запасной вариант, когда в
 * каталоге нет опубликованной версии.
 *
 * ## Зачем
 *
 * Три LLM-ступени анализа — классификация страниц, извлечение реквизитов,
 * ИИ-проверка заполнения — читали промт ТОЛЬКО из `prompt_templates` со
 * `state='published'` и при пустом ответе пропускали себя целиком. На стенде
 * это означало, что ни одна из них не выполнялась никогда: сид-миграция 0032
 * кладёт `extract` и `check` ЧЕРНОВИКАМИ (публикация задумана как осознанное
 * действие администратора), а `page_classify` не сеяла ни одна миграция вовсе.
 * Заказчик видел это как «страницы распознаны, а документов и реквизитов нет», и
 * причина лежала в консоли: «опубликованного промта стадии extract нет».
 *
 * Запрет был лишним по существу. Сид-миграция ГЕНЕРИРУЕТСЯ из этих же констант
 * (`tools/scripts/generate-analysis-prompts-seed-migration.mjs`, дрейф ловит
 * `analysis-prompts-seed.test.ts`), то есть «неопубликованный черновик» и
 * «встроенный текст» — одна и та же строка. Требовать ручной публикации, чтобы
 * получить текст, который и так лежит в коде, значило запирать конвейер ни за
 * чем.
 *
 * Ровно тот же вывод уже сделан для стадии `recognize`
 * (`recognitionPromptDefaultByCode` в `recognition/vlm/prompts.ts`), и здесь
 * повторяется её механика, а не заводится вторая.
 *
 * ## Что это НЕ отменяет
 *
 * Опубликованная версия по-прежнему в приоритете: администратор, правивший
 * промт, получает свой текст, а не этот. Отличить их можно и постфактум —
 * встроенный уезжает в `ai_runs.prompt_version` нулём, и админ-консоль печатает
 * «встроенный текст, версия из кода». Видимость вместо запрета: запрет прятал
 * работу конвейера, а ноль в версии её называет.
 *
 * ## Реестр, а не три ветки `if`
 *
 * Стадий станет больше — `act_extract` уже заявлена соседним потоком. Ветвление
 * по стадии пришлось бы править в каждом читателе; запись в таблице ниже
 * добавляется одна и в одном месте.
 */
import { LLM_REVIEW_PROMPT } from '../checks/llm-review-prompt.js';
import { FIELD_EXTRACT_PROMPT, PAGE_CLASSIFY_PROMPT } from '../segmentation/prompts.js';
import type { PromptText } from '../segmentation/prompts.js';

/**
 * Стадии текстового анализа, у которых есть встроенный текст.
 *
 * Совпадает с `LlmTextStage` воркера по значениям, но объявлено здесь: пакет
 * `@id/api` не может зависеть от воркера, а разойтись им не даёт
 * `analysis-defaults.test.ts`.
 */
export type AnalysisPromptStage = 'page_classify' | 'extract' | 'check';

export interface AnalysisPromptDefault {
  /**
   * Код промта в каталоге. Совпадает с именем стадии у всех трёх — так их сеет
   * 0032, и так их ищет администратор.
   */
  readonly code: string;
  readonly stage: AnalysisPromptStage;
  readonly text: PromptText;
}

const ANALYSIS_PROMPT_DEFAULTS: Readonly<Record<AnalysisPromptStage, AnalysisPromptDefault>> = {
  page_classify: {
    code: 'page_classify',
    stage: 'page_classify',
    text: PAGE_CLASSIFY_PROMPT,
  },
  extract: {
    code: 'extract',
    stage: 'extract',
    text: FIELD_EXTRACT_PROMPT,
  },
  check: {
    code: 'check',
    stage: 'check',
    text: LLM_REVIEW_PROMPT,
  },
};

/** Коды стадий анализа — один источник для сида, диагностики и тестов. */
export const ANALYSIS_PROMPT_STAGES: readonly AnalysisPromptStage[] = Object.keys(
  ANALYSIS_PROMPT_DEFAULTS,
) as AnalysisPromptStage[];

/**
 * Встроенный текст стадии; `null` — стадия не текстовая либо неизвестна.
 *
 * `null`, а не бросок: вызывающий (`stagePrompt` в `worker/jobs/pipeline.ts`)
 * спрашивает про стадию, пришедшую из своего же кода, и превращать опечатку в
 * падение прогона незачем — пропуск с названной причиной остаётся законным
 * исходом ровно для этого случая.
 */
export function analysisPromptDefaultByStage(stage: string): AnalysisPromptDefault | null {
  // `Object.hasOwn`, а не прямое индексирование: строка приходит снаружи, и
  // `'toString'` вернул бы функцию прототипа. Дальше она уехала бы в
  // `systemPrompt` обращением к несуществующему полю — то есть в запрос к
  // модели, а не в отказ.
  if (!Object.hasOwn(ANALYSIS_PROMPT_DEFAULTS, stage)) return null;
  return ANALYSIS_PROMPT_DEFAULTS[stage as AnalysisPromptStage];
}
