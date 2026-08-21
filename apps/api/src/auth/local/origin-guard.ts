/**
 * Проверка источника запроса для публичных маршрутов локального входа.
 *
 * Зачем это нужно вообще. `csrfGuardHook` (`middleware/require-auth.ts`) при
 * отсутствии сессии пропускает запрос — и правильно делает: защищать нечего,
 * такой запрос всё равно упрётся в `requireAuth`. Но `POST /api/v1/auth/login`
 * по построению идёт БЕЗ сессии и в `requireAuth` не упирается: он сессию
 * создаёт. Без отдельной проверки чужая страница может отправить форму входа с
 * учётными данными атакующего, и жертва окажется залогинена в его учётную
 * запись — дальше всё, что она загрузит в портал, попадёт к нему (login CSRF).
 *
 * Правило намеренно опирается на Fetch Metadata, а не на один только `Origin`:
 * `Sec-Fetch-Site` браузер выставляет сам и подделать его страница не может.
 *
 * Заголовку `Host` доверия нет: его называет клиент. Ради dev-прокси Vite, где
 * браузер шлёт `Origin: http://localhost:5173`, а `PUBLIC_URL` указывает на
 * `:3000`, есть явная переменная `AUTH_LOCAL_ALLOWED_ORIGINS`, запрещённая в
 * production. Явный список лучше молчаливого доверия заголовку: список видно в
 * конфигурации, а доверие — только в коде.
 */
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';

import type { Env } from '../../config/env.js';
import { forbidden, unsupportedMediaType } from '../../lib/problem.js';

/**
 * Значения `Sec-Fetch-Site`, при которых запрос точно свой.
 *
 * `none` — навигация, набранная в адресной строке, либо запрос расширения;
 * `same-origin` — своя страница. `same-site` НЕ принимается: поддомен того же
 * сайта может быть чужим приложением, и в модели угроз портала он таким и
 * считается.
 */
const ALLOWED_FETCH_SITE = new Set(['same-origin', 'none']);

function allowedOrigins(env: Env): readonly string[] {
  const extra = (env.AUTH_LOCAL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return [new URL(env.PUBLIC_URL).origin, ...extra.map(toOrigin)].filter(
    (value): value is string => value !== null,
  );
}

/** Полный origin: схема, хост и порт. Сравнение по одному хосту пропустило бы http вместо https. */
function toOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function sameOriginGuard(env: Env): onRequestAsyncHookHandler {
  const origins = allowedOrigins(env);

  return function verifyOrigin(request: FastifyRequest) {
    const fetchSite = headerValue(request, 'sec-fetch-site');
    if (fetchSite !== undefined) {
      if (ALLOWED_FETCH_SITE.has(fetchSite)) return Promise.resolve();
      return Promise.reject(
        forbidden('Запрос отклонён проверкой источника.', {
          slug: 'csrf',
          logDetail: `sec-fetch-site: ${fetchSite}`,
        }),
      );
    }

    const origin = headerValue(request, 'origin');
    if (origin !== undefined) {
      const normalized = toOrigin(origin);
      if (normalized !== null && origins.includes(normalized)) return Promise.resolve();
      return Promise.reject(
        forbidden('Запрос отклонён проверкой источника.', {
          slug: 'csrf',
          logDetail: `origin не входит в список разрешённых: ${origin}`,
        }),
      );
    }

    // Ни Fetch Metadata, ни Origin — значит запрос пришёл не из браузера:
    // curl, интеграционный тест, `app.inject`. Пропускается осознанно: защита от
    // CSRF по определению защищает от браузера, а неброузерному клиенту нечего
    // подделывать — он и так распоряжается своими заголовками целиком.
    // Существование этой ветки закреплено отдельным тестом, чтобы она не
    // «уточнилась» однажды до отказа и не сломала тесты и служебные скрипты.
    return Promise.resolve();
  };
}

/**
 * Только `application/json`.
 *
 * HTML-форма умеет отправлять `application/x-www-form-urlencoded`,
 * `multipart/form-data` и `text/plain` — и делает это БЕЗ предварительного
 * запроса CORS, то есть чужая страница отправит её беспрепятственно. Требование
 * JSON вынуждает браузер сделать preflight, который чужой источник не пройдёт.
 */
export function jsonOnlyGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const contentType = headerValue(request, 'content-type') ?? '';
  const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (mediaType === 'application/json') return Promise.resolve();
  return Promise.reject(
    unsupportedMediaType('Тело запроса должно быть application/json.', {
      logDetail: `content-type: ${contentType || '(отсутствует)'}`,
    }),
  );
}
