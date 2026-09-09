/**
 * Подпись строки перечня в отчёте (S57).
 *
 * Проверяется одно: подпись говорит ДОВОД, а не переводит число порогами.
 * Прежняя версия делала обратное — 0.85 и выше означало «начертание номера
 * отличается», ниже — «номер совпал не полностью», — и на боевой папке «ИД
 * Мастер апрель 2026» сорок строк получили одну подпись на четыре разных
 * случая: приложение без своего номера, тот же номер в другой раскладке,
 * совпадение по куску и партия вместо номера.
 *
 * Отдельно проверяется граница между «нет в комплекте» и «портал не
 * сопоставил»: первое обвиняет папку, второе — говорит о портале, и слить их
 * значит отправить проверяющего искать бумагу, которая лежит на своём месте.
 *
 * С S59 проверяется и обратное: найденная строка НЕ получает предупреждения за
 * расхождения по графам. Заказчик показал ложное предупреждение на верно
 * названном сертификате («РОСС RU.OC54.H005483»: реестр называет поставщика,
 * документ — изготовителя) и решил, что сопоставление отвечает только на вопрос
 * «есть документ или нет».
 */
import { describe, expect, it } from 'vitest';

import { candidatesTail, registryRowVerdict } from './check-report.js';

const verdict = (
  matchState: 'matched' | 'missing' | 'ambiguous' | 'candidate' | 'undetermined',
  over: Partial<Parameters<typeof registryRowVerdict>[0]> = {},
): ReturnType<typeof registryRowVerdict> =>
  registryRowVerdict({
    matchState,
    matchScore: null,
    where: ', стр. 42',
    candidates: '',
    ...over,
  });

describe('registryRowVerdict', () => {
  it('найденная строка печатает довод того, кто её нашёл', () => {
    const outcome = verdict('matched', {
      matchedBy: 'llm',
      matchNote: 'номер тот же, набран другой раскладкой',
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.text).toBe(
      'найден в комплекте: номер тот же, набран другой раскладкой, стр. 42',
    );
  });

  it('без довода подпись остаётся короткой и не выдумывает причину', () => {
    const outcome = verdict('matched', { matchedBy: 'rule' });
    expect(outcome.status).toBe('ok');
    expect(outcome.text).toBe('найден в комплекте, стр. 42');
  });

  it('расхождения по графам НЕ поднимают найденную строку до предупреждения (S59)', () => {
    // Скриншот заказчика: сертификат назван в реестре верно, а графа
    // организации называет поставщика вместо изготовителя. С S57 по S59 такая
    // строка получала «в описании строки расхождений: 1» — и это было ложью о
    // папке: документ на месте, и инженеру с ним делать нечего. Мутация «вернуть
    // ветку расхождений» красит именно этот тест.
    const outcome = verdict('matched', {
      matchNote: 'номер совпал посимвольно',
      checks: [{ status: 'mismatch' }, { status: 'mismatch' }, { status: 'ok' }],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.text).toBe('найден в комплекте: номер совпал посимвольно, стр. 42');
    expect(outcome.text).not.toContain('расхождений');
  });

  it('«не сопоставлено» говорит о портале, а не о папке', () => {
    const outcome = verdict('undetermined', {
      matchNote: 'документ не найден среди документов раздела',
    });
    expect(outcome.status).toBe('undetermined');
    expect(outcome.text).toContain('портал не сопоставил');
    expect(outcome.text).not.toContain('нет в комплекте');
  });

  it('«нет в комплекте» осталось единственным обвинением папке', () => {
    const outcome = verdict('missing');
    expect(outcome.status).toBe('error');
    expect(outcome.text).toBe('нет в комплекте');
  });

  it('кандидат называет, что именно похоже', () => {
    const outcome = verdict('candidate', {
      matchNote: 'среди документов раздела не найден; по номеру найден в разделе 7',
      candidates: ': похоже на стр. 19, 20',
    });
    expect(outcome.status).toBe('warning');
    expect(outcome.text).toContain('в разделе 7');
    expect(outcome.text).toContain('стр. 19, 20');
  });

  it('несколько подходящих документов не выдаются за найденный', () => {
    const outcome = verdict('ambiguous');
    expect(outcome.status).toBe('warning');
    expect(outcome.text).toContain('несколько документов');
  });
});

describe('candidatesTail', () => {
  it('перечисляет страницы кандидатов через запятую', () => {
    expect(
      candidatesTail([
        { number: 19, workingPageIndex: 18 },
        { number: 20, workingPageIndex: null },
      ]),
    ).toBe(': похоже на стр. 19, 20');
  });

  it('молчит, когда кандидатов нет: «похожих документов 0» не помогает никому', () => {
    expect(candidatesTail([])).toBe('');
  });
});
