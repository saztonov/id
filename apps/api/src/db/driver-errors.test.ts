/**
 * Обход цепочки `cause` — то место, где класс дефектов начинался.
 *
 * Проверка «только верхний уровень» выглядит рабочей и молча возвращает `false` на
 * КАЖДОЙ ошибке Drizzle: `code` и `constraint` лежат в `cause`. Три копии этой
 * функции жили в трёх репозиториях, и одна из них была именно такой — повтор при
 * гонке за `seq` события ревизии не сработал ни разу.
 */
import { describe, expect, it } from 'vitest';

import { driverField } from './driver-errors.js';

/** Ошибка драйвера `pg`, как её отдаёт узел: поля прямо на объекте. */
function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
  });
}

/** Обёртка Drizzle: своих `code`/`constraint` не имеет, оригинал — в `cause`. */
function wrapped(cause: unknown, depth = 1): Error {
  let current: unknown = cause;
  for (let i = 0; i < depth; i += 1) {
    current = new Error('Failed query: insert into ...', { cause: current });
  }
  return current as Error;
}

describe('driverField', () => {
  it('находит поля на самой ошибке', () => {
    const error = pgError('23505', 'folder_events_pkey');
    expect(driverField(error, 'code')).toBe('23505');
    expect(driverField(error, 'constraint')).toBe('folder_events_pkey');
  });

  it('находит поля сквозь одну обёртку Drizzle — ровно тот случай, что был сломан', () => {
    const error = wrapped(pgError('23505', 'source_files_order_uq'));
    expect(driverField(error, 'code')).toBe('23505');
    expect(driverField(error, 'constraint')).toBe('source_files_order_uq');
  });

  it('находит поля сквозь несколько обёрток', () => {
    const error = wrapped(pgError('23503', 'works_registry_fk'), 3);
    expect(driverField(error, 'code')).toBe('23503');
  });

  it('на ошибке без этих полей возвращает null, а не бросает', () => {
    expect(driverField(new Error('просто ошибка'), 'code')).toBeNull();
    expect(driverField(wrapped(new Error('просто ошибка'), 2), 'constraint')).toBeNull();
  });

  it('не зацикливается на циклической цепочке cause', () => {
    const first = new Error('первая');
    const second = new Error('вторая', { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(driverField(first, 'code')).toBeNull();
  });

  it('ссылка cause на самоё себя обрывает обход', () => {
    const error = new Error('сама на себя');
    (error as { cause?: unknown }).cause = error;

    expect(driverField(error, 'code')).toBeNull();
  });

  it('не-объект и null безопасны', () => {
    expect(driverField(null, 'code')).toBeNull();
    expect(driverField('строка вместо ошибки', 'code')).toBeNull();
    expect(driverField(undefined, 'constraint')).toBeNull();
  });

  it('пустая строка полем не считается: искать надо дальше по цепочке', () => {
    const error = wrapped(pgError('23505', 'ux_prompt_templates_single_published'));
    Object.assign(error, { code: '' });
    expect(driverField(error, 'code')).toBe('23505');
  });
});
