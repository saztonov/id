/**
 * Встроенные тексты промптов стадий анализа существуют у каждой стадии.
 *
 * Регрессия на состояние, в котором портал прожил от S8 до S27: три LLM-ступени
 * анализа читали промт только из каталога и при пустом ответе пропускали себя
 * целиком. Сид-миграция 0032 клала `extract` и `check` черновиками, а
 * `page_classify` не сеяла ни одна миграция вовсе, — значит ни одна ступень не
 * выполнялась НИКОГДА. Снаружи это выглядело как «страницы распознаны, а
 * документов и реквизитов нет», и причина лежала в консоли воркера.
 *
 * Проверяется здесь не текст промптов (он проверяется своими тестами и сверкой
 * на дрейф сида), а то, что стадия без встроенного текста не осталась.
 */
import { describe, expect, it } from 'vitest';

import { LLM_REVIEW_PROMPT } from '../checks/llm-review-prompt.js';
import { FIELD_EXTRACT_PROMPT, PAGE_CLASSIFY_PROMPT } from '../segmentation/prompts.js';
import { REGISTRY_MATCH_PROMPT } from '../segmentation/registry-match-prompt.js';
import { analysisPromptDefaultByStage, ANALYSIS_PROMPT_STAGES } from './analysis-defaults.js';

describe('встроенные промты стадий анализа', () => {
  it('покрывают все стадии текстового анализа', () => {
    // Список ожидаемых стадий выписан, а не выведен из самого реестра: иначе
    // проверка сводилась бы к «реестр равен себе». Новая стадия обязана
    // появиться здесь осознанно — на S57 она этого и потребовала.
    expect([...ANALYSIS_PROMPT_STAGES].sort()).toEqual([
      'check',
      'extract',
      'page_classify',
      'registry_match',
    ]);
  });

  it('у каждой стадии есть непустой текст, и код совпадает со стадией', () => {
    for (const stage of ANALYSIS_PROMPT_STAGES) {
      const preset = analysisPromptDefaultByStage(stage);
      expect(preset).not.toBeNull();
      // Совпадение `code` и `stage` — то же решение, что у `PAGE_CLASSIFY_STAGE`
      // в воркере: разъехавшись, они дали бы «промта стадии нет» при заведённом
      // промте.
      expect(preset?.code).toBe(stage);
      expect(preset?.text.system.length).toBeGreaterThan(200);
      expect(preset?.text.user.length).toBeGreaterThan(20);
    }
  });

  it('отдаёт ровно те константы, из которых генерируется сид-миграция', () => {
    // Иначе встроенный текст и засеянный черновик разошлись бы, и «взяли
    // встроенный» перестало бы значить «взяли то же, что в каталоге».
    expect(analysisPromptDefaultByStage('page_classify')?.text).toBe(PAGE_CLASSIFY_PROMPT);
    expect(analysisPromptDefaultByStage('extract')?.text).toBe(FIELD_EXTRACT_PROMPT);
    expect(analysisPromptDefaultByStage('check')?.text).toBe(LLM_REVIEW_PROMPT);
    expect(analysisPromptDefaultByStage('registry_match')?.text).toBe(REGISTRY_MATCH_PROMPT);
  });

  it('незнакомая стадия — null, а не бросок', () => {
    // Вызывающий спрашивает про стадию из своего же кода; превращать опечатку в
    // падение прогона незачем — пропуск с названной причиной законен ровно здесь.
    expect(analysisPromptDefaultByStage('recognize')).toBeNull();
    expect(analysisPromptDefaultByStage('')).toBeNull();
    // Свойства прототипа не должны просачиваться сквозь поиск по объекту.
    expect(analysisPromptDefaultByStage('toString')).toBeNull();
    expect(analysisPromptDefaultByStage('constructor')).toBeNull();
  });
});
