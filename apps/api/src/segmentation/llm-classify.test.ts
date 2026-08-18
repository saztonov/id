/**
 * Фаза 2 сегментации: схема ответа, её разбор и отображение цитаты.
 *
 * Тесты написаны от требования §8.2 «цитата нормализуется и отображается
 * обратно на точный span `page_text_versions`; если это невозможно —
 * результат `undetermined`». Проверяется не то, что разбор работает на
 * хорошем ответе, а то, что он ОТВЕРГАЕТ плохой и оставляет след: молчаливый
 * `U` без причины неотличим от честного «модель не знает», и настроить по
 * нему ничего нельзя.
 *
 * Данные синтетические: номера, наименования и организации выдуманы.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPageWithLlm,
  locateQuote,
  pagesNeedingLlm,
  QUOTE_NOT_MAPPED,
  SCHEMA_VERSION,
  type LlmClassifyDeps,
} from './llm-classify.js';
import { LlmBudgetError } from '../llm/port.js';
import type { PageClassification, PageInput } from './types.js';

const PROMPT = { system: 'системный промт', user: 'пользовательский промт' };

function page(text: string, extra: Partial<PageInput> = {}): PageInput {
  return {
    sourcePageId: 'p1',
    revisionOrdinal: 1,
    sourceFileId: 'file-1',
    filePageIndex: 0,
    pageTextVersionId: 'ptv-1',
    text,
    blockTypes: ['text'],
    rotation: 0,
    ...extra,
  };
}

const NO_NEIGHBOURS = { before: null, after: null };

function answering(text: string): LlmClassifyDeps {
  return { complete: () => Promise.resolve({ text }) };
}

/** Ответ по схеме; отдельные поля переопределяются в конкретном тесте. */
function answer(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    label: 'B-DOC',
    doc_type: 'cert_conformity',
    observed_title: 'СЕРТИФИКАТ СООТВЕТСТВИЯ',
    confidence: 0.82,
    reason: 'на листе заголовок сертификата',
    quote: 'СЕРТИФИКАТ СООТВЕТСТВИЯ',
    ...patch,
  });
}

describe('отображение цитаты на исходный текст', () => {
  it('находит цитату, разорванную OCR по строкам и оформленную markdown', () => {
    const text = 'шапка\n\n##### **СЕРТИФИКАТ**\nСООТВЕТСТВИЯ\n№ A-1';
    const evidence = locateQuote(page(text), 'СЕРТИФИКАТ СООТВЕТСТВИЯ');
    expect(evidence).not.toBeNull();
    const ev = evidence as NonNullable<typeof evidence>;
    // Диапазон — в исходном тексте, а цитата — ровно его срез, а не строка
    // модели: иначе подсветка разойдётся с записанным `char_span`.
    expect(text.slice(ev.charStart, ev.charEnd)).toBe(ev.quote);
    expect(ev.quote).toBe('СЕРТИФИКАТ**\nСООТВЕТСТВИЯ');
  });

  it('регистр значим: пересказанная другим регистром цитата не отображается', () => {
    expect(locateQuote(page('ПАСПОРТ КАЧЕСТВА № 7'), 'паспорт качества')).toBeNull();
  });

  it('без версии текста цитату отображать не на что', () => {
    expect(
      locateQuote(page('ПАСПОРТ КАЧЕСТВА', { pageTextVersionId: null }), 'ПАСПОРТ'),
    ).toBeNull();
  });
});

describe('разбор ответа модели', () => {
  it('принимает ответ по схеме и подтверждает его цитатой', async () => {
    const text = '##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1 от 01.02.2026';
    const outcome = await classifyPageWithLlm(
      page(text),
      NO_NEIGHBOURS,
      answering(answer()),
      PROMPT,
    );

    expect(outcome.problem).toBeNull();
    const c = outcome.classification as PageClassification;
    expect(c.label).toBe('B-DOC');
    expect(c.docTypeCode).toBe('cert_conformity');
    expect(c.typeOutcome).toBe('known');
    expect(c.source).toBe('llm');
    expect(c.evidence?.quote).toBe('СЕРТИФИКАТ СООТВЕТСТВИЯ');
  });

  it('передаёт провайдеру версию схемы и соседний контекст для ключа кэша', async () => {
    const seen: { schemaVersion?: string; cacheContext?: string } = {};
    const deps: LlmClassifyDeps = {
      complete: (req) => {
        seen.schemaVersion = req.schemaVersion;
        seen.cacheContext = req.cacheContext;
        return Promise.resolve({ text: answer() });
      },
    };
    await classifyPageWithLlm(
      page('СЕРТИФИКАТ СООТВЕТСТВИЯ'),
      { before: page('до', { sourcePageId: 'p0' }), after: page('после', { sourcePageId: 'p2' }) },
      deps,
      PROMPT,
    );
    expect(seen.schemaVersion).toBe(SCHEMA_VERSION);
    // Та же страница между другими соседями — другая задача о границе, и
    // переиспользовать прежний ответ из кэша нельзя.
    expect(seen.cacheContext).toBe('p1|p0|p2');
  });

  it('снимает обрамление ```json, но проверяет содержимое полной схемой', async () => {
    const outcome = await classifyPageWithLlm(
      page('СЕРТИФИКАТ СООТВЕТСТВИЯ'),
      NO_NEIGHBOURS,
      answering('```json\n' + answer() + '\n```'),
      PROMPT,
    );
    expect(outcome.problem).toBeNull();
    expect(outcome.classification).not.toBeNull();
  });

  it('невалидный JSON не бросается наружу и оставляет причину', async () => {
    const outcome = await classifyPageWithLlm(
      page('СЕРТИФИКАТ СООТВЕТСТВИЯ'),
      NO_NEIGHBOURS,
      answering('Кажется, это сертификат, но я не уверен.'),
      PROMPT,
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toContain('не является JSON');
  });

  it('неклассифицированный сбой адаптера не роняет прогон сегментации', async () => {
    const deps: LlmClassifyDeps = { complete: () => Promise.reject(new Error('таймаут')) };
    const outcome = await classifyPageWithLlm(page('текст'), NO_NEIGHBOURS, deps, PROMPT);
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toContain('таймаут');
  });

  it('классифицированный отказ провайдера пробрасывается, а не сворачивается в текст', async () => {
    // `LlmError` несёт повторяемость, признак «отказ относится ко всем
    // последующим вызовам» и состоявшуюся попытку с хэшем промта. Свёрнутый в
    // строку `problem`, он уничтожал всё это здесь: обработчик задачи 14 не
    // видел отказа вовсе, таймаут не оставлял строки `ai_runs`, а исчерпанный
    // бюджет дёргал провайдера на каждой оставшейся странице.
    const budget = new LlmBudgetError('бюджет исчерпан', { spent: 1, budget: 1 });
    const deps: LlmClassifyDeps = { complete: () => Promise.reject(budget) };

    await expect(
      classifyPageWithLlm(page('текст'), NO_NEIGHBOURS, deps, PROMPT),
    ).rejects.toBeInstanceOf(LlmBudgetError);
  });

  it('незнакомый код вида документа — не по схеме', async () => {
    const outcome = await classifyPageWithLlm(
      page('СЕРТИФИКАТ СООТВЕТСТВИЯ'),
      NO_NEIGHBOURS,
      answering(answer({ doc_type: 'act_of_something' })),
      PROMPT,
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toContain('не соответствует схеме');
  });

  it('переведённое название вида вместо кода — не по схеме', async () => {
    // Структура ответа при этом безупречна, и без закрытого списка кодов
    // такой ответ прошёл бы разбор и создал документ несуществующего вида.
    const outcome = await classifyPageWithLlm(
      page('СЕРТИФИКАТ СООТВЕТСТВИЯ'),
      NO_NEIGHBOURS,
      answering(answer({ doc_type: 'certificate of conformity' })),
      PROMPT,
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toContain('не соответствует схеме');
  });

  it('язык объяснения на решение не влияет', async () => {
    const outcome = await classifyPageWithLlm(
      page('СЕРТИФИКАТ СООТВЕТСТВИЯ'),
      NO_NEIGHBOURS,
      answering(answer({ reason: 'the page header names a conformity certificate' })),
      PROMPT,
    );
    expect(outcome.problem).toBeNull();
    expect((outcome.classification as PageClassification).docTypeCode).toBe('cert_conformity');
  });

  it('«other» без observed_title отвергается: без заголовка каталог не растёт', async () => {
    const outcome = await classifyPageWithLlm(
      page('АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ № ГИ-77'),
      NO_NEIGHBOURS,
      answering(
        answer({ doc_type: 'other', observed_title: '', quote: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ' }),
      ),
      PROMPT,
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toContain('observed_title');
  });

  it('«other» с заголовком принимается и высокая уверенность допустима', async () => {
    const outcome = await classifyPageWithLlm(
      page('АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ № ГИ-77'),
      NO_NEIGHBOURS,
      answering(
        answer({
          doc_type: 'other',
          observed_title: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ',
          confidence: 0.95,
          quote: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ',
        }),
      ),
      PROMPT,
    );
    const c = outcome.classification as PageClassification;
    expect(c.typeOutcome).toBe('other');
    expect(c.docTypeCode).toBeNull();
    expect(c.observedTitle).toBe('АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ');
    expect(c.confidence).toBe(0.95);
  });

  it('«uncertain» отличается от «other» исходом, а не только уверенностью', async () => {
    const outcome = await classifyPageWithLlm(
      page('ПАСПОРТ № 42'),
      NO_NEIGHBOURS,
      answering(answer({ doc_type: 'uncertain', quote: 'ПАСПОРТ № 42' })),
      PROMPT,
    );
    expect((outcome.classification as PageClassification).typeOutcome).toBe('uncertain');
  });

  it('цитата, которой нет на странице, делает результат undetermined', async () => {
    // Ровно то место, где двойник обязан быть строг: модель, сочинившая
    // цитату, столь же охотно сочинит и вид документа.
    const outcome = await classifyPageWithLlm(
      page('ПАСПОРТ КАЧЕСТВА № 7'),
      NO_NEIGHBOURS,
      answering(answer({ quote: 'СЕРТИФИКАТ СООТВЕТСТВИЯ № A-1' })),
      PROMPT,
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toBe(QUOTE_NOT_MAPPED);
  });

  it('пустая цитата — не по схеме, а не «ответ без доказательства»', async () => {
    const outcome = await classifyPageWithLlm(
      page('ПАСПОРТ КАЧЕСТВА № 7'),
      NO_NEIGHBOURS,
      answering(answer({ quote: '' })),
      PROMPT,
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.problem).toContain('не соответствует схеме');
  });

  it('label «U» не может утверждать вид документа', async () => {
    const outcome = await classifyPageWithLlm(
      page('ПАСПОРТ КАЧЕСТВА № 7'),
      NO_NEIGHBOURS,
      answering(answer({ label: 'U', quote: 'ПАСПОРТ КАЧЕСТВА № 7' })),
      PROMPT,
    );
    const c = outcome.classification as PageClassification;
    expect(c.label).toBe('U');
    expect(c.typeOutcome).toBe('none');
    expect(c.docTypeCode).toBeNull();
  });
});

describe('отбор страниц для модели', () => {
  const base: PageClassification = {
    sourcePageId: 'x',
    label: 'U',
    docTypeCode: null,
    typeOutcome: 'none',
    observedTitle: null,
    pageRoleCode: null,
    parentRef: null,
    confidence: 0,
    reason: '',
    source: 'anchor',
    alternatives: [],
    ambiguous: false,
    evidence: null,
  };

  it('модель зовут только для U и только там, где не решил человек', () => {
    const result = pagesNeedingLlm([
      { ...base, sourcePageId: 'a' },
      { ...base, sourcePageId: 'b', label: 'B-DOC' },
      { ...base, sourcePageId: 'c', source: 'manual' },
      { ...base, sourcePageId: 'd', label: 'A-ROLE' },
      { ...base, sourcePageId: 'e' },
    ]);
    expect(result.map((c) => c.sourcePageId)).toEqual(['a', 'e']);
  });
});
