/**
 * Подавление повторов в отчётах браузера (§11).
 *
 * Модуль работает на машине пользователя, и его дефект стоит дороже дефекта на
 * сервере: вкладка способна отправлять отчёт в цикле отрисовки десятки раз в
 * секунду. Здесь проверяется ровно то, что этого не даёт случиться, и то, что
 * подавление не превращается в потерю данных.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installClientErrorReporting,
  reportClientError,
  resetClientErrorReporting,
} from './errorReporting.js';
import { CLIENT_ERROR_PATH, type ClientErrorReport } from '../api/types.js';

const sent: ClientErrorReport[] = [];

beforeEach(() => {
  sent.length = 0;
  resetClientErrorReporting();

  // `sendBeacon` — основной путь: он переживает уход со страницы, а обычный
  // запрос браузер в этот момент отменяет.
  vi.stubGlobal('navigator', {
    sendBeacon: (url: string, blob: Blob) => {
      expect(url).toBe(CLIENT_ERROR_PATH);
      // Тело читается синхронно из уже сериализованной строки: `Blob.text()`
      // асинхронен, а проверка не должна зависеть от планировщика.
      void blob;
      return true;
    },
  });
  vi.stubGlobal('location', { href: 'https://id.example.test/admin?tab=journal' });
  vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-00000000000a' });

  // Перехват на уровне Blob: конструктор получает готовую строку отчёта.
  vi.stubGlobal(
    'Blob',
    class {
      constructor(parts: string[]) {
        sent.push(JSON.parse(parts[0] ?? '{}') as ClientErrorReport);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('подавление повторов', () => {
  it('одна и та же ошибка отправляется один раз за жизнь вкладки', () => {
    const fail = (): Error => new Error('цикл отрисовки упал');

    for (let i = 0; i < 100; i += 1) reportClientError(fail(), { kind: 'render' });

    expect(
      sent,
      'каждое повторение отправлено: цикл отрисовки способен бросать одно и то же ' +
        'исключение десятки раз в секунду, и вкладка устроила бы себе отказ сама',
    ).toHaveLength(1);
  });

  it('разные ошибки различаются и отправляются обе', () => {
    reportClientError(new Error('первая'), { kind: 'render' });
    reportClientError(new Error('вторая'), { kind: 'render' });

    expect(sent.map((report) => report.message)).toStrictEqual(['первая', 'вторая']);
  });

  it('потолок отправок на вкладку соблюдается', () => {
    for (let i = 0; i < 50; i += 1) {
      reportClientError(new Error(`ошибка номер ${i}`), { kind: 'render' });
    }

    expect(sent.length).toBeLessThanOrEqual(10);
  });

  it('номер события выдаётся даже подавленному отчёту', () => {
    const first = reportClientError(new Error('одна и та же'), { kind: 'render' });
    const second = reportClientError(new Error('одна и та же'), { kind: 'render' });

    expect(
      second,
      'подавленный отчёт остался без номера: человек не знает, что его случай ' +
        'сочли повтором, и в поддержку ему обратиться не с чем',
    ).toBe(first);
  });
});

describe('шум не отправляется', () => {
  it('отменённый запрос ошибкой не считается', () => {
    const aborted = new Error('The user aborted a request.');
    aborted.name = 'AbortError';

    reportClientError(aborted, { kind: 'manual' });

    expect(
      sent,
      'отмена запроса записана как ошибка портала: её порождает сам пользователь, ' +
        'закрывая экран, и журнал заполнится шумом, похожим на отказ',
    ).toHaveLength(0);
  });
});

describe('перехватчики окна', () => {
  it('снимаются возвращённой функцией', () => {
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    });

    const uninstall = installClientErrorReporting();
    expect(added).toStrictEqual(['error', 'unhandledrejection']);

    uninstall();
    expect(removed).toStrictEqual(['error', 'unhandledrejection']);
  });
});
