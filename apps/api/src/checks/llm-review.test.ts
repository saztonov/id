/**
 * ИИ-проверка заполнения (§9.1, S21).
 *
 * Проверяются инварианты, которые нельзя доверить промту, потому что промт —
 * это просьба, а не гарантия:
 *
 * 1. код замечания обязан принадлежать закрытому набору — выдуманный не пройдёт
 *    по внешнему ключу `findings.rule_code` и уронил бы запись ВСЕГО прогона;
 * 2. замечание без подтверждённой цитаты не принимается;
 * 3. `is_blocking` всегда `false` — инвариант БД `findings_llm_blocking_chk`
 *    (находка модели блокирует только после подтверждения человеком);
 * 4. `undetermined` не выдаётся за `open`: троичность §9.1 сохраняется.
 */
import { describe, expect, it } from 'vitest';

import { LlmError } from '../llm/port.js';
import {
  REVIEW_QUOTE_NOT_MAPPED,
  reviewDocumentWithLlm,
  type ReviewDocument,
} from './llm-review.js';

const DOCUMENT: ReviewDocument = {
  documentId: '00000000-0000-4000-8000-0000000000aa',
  docTypeCode: 'aosr',
  pages: [
    {
      sourcePageId: '00000000-0000-4000-8000-0000000000b1',
      pageTextVersionId: '00000000-0000-4000-8000-0000000000c1',
      text: [
        'АКТ освидетельствования скрытых работ № 336',
        'Застройщик: ООО «Заказчик»',
        'Лицо, выполнившее работы: ______________',
      ].join('\n'),
    },
  ],
  fields: [{ fieldCode: 'act_number', valueText: '336', valueDate: null }],
};

const PROMPT = { system: 'система', user: 'пользователь' };

function respond(payload: unknown) {
  return { complete: async () => Promise.resolve({ text: JSON.stringify(payload) }) };
}

describe('reviewDocumentWithLlm', () => {
  it('принимает замечание с цитатой и адресует его документу и странице', async () => {
    const outcome = await reviewDocumentWithLlm(
      DOCUMENT,
      respond({
        findings: [
          {
            code: 'LLM.FILL.010',
            state: 'open',
            severity: 'warning',
            message: 'Графа «Лицо, выполнившее работы» не заполнена',
            hint: 'Впишите организацию, выполнившую работы',
            quote: 'Лицо, выполнившее работы: ______________',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.problems).toEqual([]);
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0];
    expect(finding?.ruleCode).toBe('LLM.FILL.010');
    expect(finding?.origin).toBe('llm');
    // Инвариант БД: без подтверждения человеком блокировать нельзя.
    expect(finding?.isBlocking).toBe(false);
    expect(finding?.targetType).toBe('document');
    expect(finding?.targetId).toBe(DOCUMENT.documentId);
    // Адрес доказательства: без страницы ссылка «перейти к замечанию» не строится.
    expect(finding?.sourcePageId).toBe(DOCUMENT.pages[0]?.sourcePageId);
  });

  it('undetermined остаётся undetermined и не превращается в дефект', async () => {
    const outcome = await reviewDocumentWithLlm(
      DOCUMENT,
      respond({
        findings: [
          {
            code: 'LLM.FILL.020',
            state: 'undetermined',
            severity: 'info',
            message: 'Номер акта прочитан неуверенно',
            hint: null,
            quote: 'АКТ освидетельствования скрытых работ № 336',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.findings[0]?.state).toBe('undetermined');
    expect(outcome.findings[0]?.isBlocking).toBe(false);
  });

  it('выдуманный код правила отбрасывается: он не прошёл бы по внешнему ключу', async () => {
    const outcome = await reviewDocumentWithLlm(
      DOCUMENT,
      respond({
        findings: [
          {
            code: 'LLM.INVENTED.999',
            state: 'open',
            severity: 'error',
            message: 'что-то не так',
            hint: null,
            quote: 'Застройщик: ООО «Заказчик»',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.findings).toEqual([]);
    expect(outcome.problems[0]).toContain('не входит в набор ИИ-проверки');
  });

  it('замечание с выдуманной цитатой отбрасывается', async () => {
    const outcome = await reviewDocumentWithLlm(
      DOCUMENT,
      respond({
        findings: [
          {
            code: 'LLM.FILL.030',
            state: 'open',
            severity: 'warning',
            message: 'Организации в шапке и подвале разные',
            hint: 'Проверьте подвал',
            quote: 'Подрядчик: ООО «Совсем другая организация»',
          },
        ],
      }),
      PROMPT,
    );

    expect(outcome.findings).toEqual([]);
    expect(outcome.problems).toEqual([`LLM.FILL.030: ${REVIEW_QUOTE_NOT_MAPPED}`]);
  });

  it('пустой ответ — законный: замечаний нет и проблем нет', async () => {
    const outcome = await reviewDocumentWithLlm(DOCUMENT, respond({ findings: [] }), PROMPT);
    expect(outcome.findings).toEqual([]);
    expect(outcome.problems).toEqual([]);
  });

  it('отказ провайдера пробрасывается', async () => {
    await expect(
      reviewDocumentWithLlm(
        DOCUMENT,
        {
          complete: async () => {
            await Promise.resolve();
            throw new LlmError('шлюз недоступен', { retriable: true });
          },
        },
        PROMPT,
      ),
    ).rejects.toBeInstanceOf(LlmError);
  });
});
