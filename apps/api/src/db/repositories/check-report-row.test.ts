/**
 * Подпись строки описи в отчёте — единственное, что читает проверяющий.
 *
 * Набор без БД: `registryRowVerdict` — чистая функция, и проверяется здесь
 * ровно граница между «документ найден» и «сверьте руками». Граница не
 * косметическая: по ней считается заголовок «X из Y строк найдено в папке»
 * (`apps/web/src/features/checks/report.ts`), то есть цифра, которой человек
 * судит о полноте папки.
 */
import { describe, expect, it } from 'vitest';

import { registryRowVerdict } from './check-report.js';

const verdict = (
  matchState: 'matched' | 'missing' | 'ambiguous' | 'candidate',
  score: number | null,
  annexOfParent = false,
) =>
  registryRowVerdict({
    matchState,
    matchScore: score,
    where: ', стр. 42',
    candidates: '',
    annexOfParent,
  });

describe('registryRowVerdict', () => {
  it('точное совпадение номера — найден', () => {
    expect(verdict('matched', 1)).toStrictEqual({
      status: 'ok',
      text: 'найден в комплекте, стр. 42',
    });
  });

  it('совпадение через фолдинг гомоглифов — найден, с оговоркой о начертании', () => {
    // Опись папки «ИД Мастер апрель 2026» печатает «RU.CMIK.001.H.00270»
    // латиницей, бланк — «RU.СМИК.001.Н.00270» кириллицей. Это один документ,
    // и звать проверяющего сверять его руками не за чем.
    const outcome = verdict('matched', 0.85);
    expect(outcome.status).toBe('ok');
    expect(outcome.text).toContain('начертание номера отличается');
  });

  it('приложение, найденное по родителю, не обвиняется в несовпадении номера', () => {
    // Строка «Приложение к экспертному заключению № б/н» своего номера не
    // имеет: сверка находит её по СТРУКТУРЕ — приложение лежит листом внутри
    // родителя, — и счёт 0.7 говорит именно об этом. На папке «ИД Мастер
    // апрель 2026» двадцать таких строк подписаны «номер совпал не полностью —
    // проверьте документ», то есть проверяющего звали сверять номер, которого
    // в описи нет.
    const outcome = verdict('matched', 0.7, true);
    expect(outcome.status).toBe('ok');
    expect(outcome.text).toContain('приложение');
    expect(outcome.text).not.toContain('не полностью');
  });

  it('совпадение по куску номера остаётся предупреждением', () => {
    // Чувствительность к предыдущему: поблажка держится на пороге фолдинга, а
    // не на самом факте пониженного счёта.
    const outcome = verdict('matched', 0.6);
    expect(outcome.status).toBe('warning');
    expect(outcome.text).toContain('номер совпал не полностью');
  });

  it('строка без документа — ошибка, а кандидат и неоднозначность — предупреждение', () => {
    expect(verdict('missing', null).status).toBe('error');
    expect(verdict('ambiguous', null).status).toBe('warning');
    expect(verdict('candidate', 0.4).status).toBe('warning');
  });

  it('страницы похожих документов попадают в подпись кандидата', () => {
    const outcome = registryRowVerdict({
      matchState: 'candidate',
      matchScore: 0.4,
      where: '',
      candidates: ': похоже на стр. 19, 20',
    });
    expect(outcome.text).toContain('похоже на стр. 19, 20');
  });
});
