/**
 * Вход в портал внутри сквозного прогона.
 *
 * Вход идёт ЧЕРЕЗ BFF: `GET /auth/login` → редирект → `GET /auth/callback` →
 * cookie сессии. Ни один шаг не подменяется, cookie в браузер не подкладывается
 * руками. Это существенно: подложенная cookie не проверила бы ни выдачу
 * CSRF-токена, ни `SameSite`, ни то, что портал вообще умеет завершить вход, —
 * а именно эти три вещи и составляют §4.1 на стороне браузера.
 *
 * `AUTH_MODE=dev-stub` подписывает токены локальным ключом с той же формой
 * claims, что Keycloak, и запрещён при `NODE_ENV=production` (§1.3).
 */
import type { Page, APIRequestContext, BrowserContext } from '@playwright/test';

export const KC = {
  contractor: 'kc-e2e-contractor',
  engineer: 'kc-e2e-engineer',
  manager: 'kc-e2e-manager',
  admin: 'kc-e2e-admin',
  /** Роли подрядчика и инженера у одного человека: право есть, области нет. */
  mixed: 'kc-e2e-mixed',
} as const;

/**
 * Адреса и пароль тех же людей в режиме `local`.
 *
 * Повторяют `e2e/harness/fixture.mjs` по той же причине, что и `KC` выше:
 * харнесс — обычный `.mjs` без типов, и импорт из него делает всё, что пришло,
 * `any`. Расхождение ловится первым же сценарием входа: пароль просто не подойдёт.
 */
export const LOCAL_LOGINS = {
  contractor: 'contractor@e2e.example',
  engineer: 'engineer@e2e.example',
  manager: 'manager@e2e.example',
  admin: 'admin@e2e.example',
  mixed: 'mixed@e2e.example',
} as const;

export const LOCAL_PASSWORD = 'Mostovoy-Kran-77!';

export const IDS = {
  object: '00000000-0000-4000-8000-000000000004',
  volume: '00000000-0000-4000-8000-000000000006',
  volumeClosed: '00000000-0000-4000-8000-000000000007',
  submissionEmpty: '00000000-0000-4000-8000-000000000010',
  revisionEmpty: '00000000-0000-4000-8000-000000000011',
  revisionMarkup: '00000000-0000-4000-8000-000000000013',
  revisionReview: '00000000-0000-4000-8000-000000000015',
  layoutMarkup: '00000000-0000-4000-8000-000000000051',
  blockA: '00000000-0000-4000-8000-000000000060',
  /** Блок штампа на повёрнутой странице: адрес доказательства замечания (§16). */
  blockB: '00000000-0000-4000-8000-000000000061',
  /** Страницы исходника ревизии разметки: адресаты ручной метки типа (§8.2). */
  page0: '00000000-0000-4000-8000-000000000040',
  page1: '00000000-0000-4000-8000-000000000041',
} as const;

/** Вход и переход на нужный экран. */
export async function signIn(page: Page, kcSub: string, returnTo = '/ids'): Promise<void> {
  await page.goto(
    `/auth/login?devSub=${encodeURIComponent(kcSub)}&returnTo=${encodeURIComponent(returnTo)}`,
  );
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/'));
}

/**
 * CSRF-токен для запросов, которые тест делает мимо интерфейса.
 *
 * Берётся из той же cookie `id_csrf`, что читает приложение: у теста нет
 * привилегированного пути, и «сделать мимо интерфейса» означает «сделать так же,
 * как второй пользователь во второй вкладке».
 */
export async function csrfToken(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  const found = cookies.find((cookie) => cookie.name === 'id_csrf');
  if (found === undefined) throw new Error('В контексте нет cookie id_csrf: вход не состоялся');
  return found.value;
}

/**
 * HTTP-клиент теста — ВСЕГДА `page.request`, а не фикстура `request`.
 *
 * Фикстура `request` создаёт изолированный контекст: cookie сессии, полученная
 * браузером при входе, туда не попадает, и каждый такой вызов отвечает 401.
 * Прогон при этом выглядит осмысленно — «сервер не отдал данные», — хотя
 * проверяется в нём не сервер, а неавторизованный клиент. `page.request` ходит
 * с cookie той же вкладки, то есть от того же пользователя, что и интерфейс.
 */
export function api(page: Page): APIRequestContext {
  return page.request;
}

/** Мутация мимо интерфейса — ровно так же, как её сделал бы второй редактор. */
export async function apiPost(
  page: Page,
  path: string,
  options: { data?: unknown; ifMatch?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'x-csrf-token': await csrfToken(page.context()) };
  if (options.ifMatch !== undefined) headers['if-match'] = `"${String(options.ifMatch)}"`;
  const response = await page.request.post(path, {
    headers,
    ...(options.data === undefined ? {} : { data: options.data }),
  });
  // Тело разбирается терпимо: у 204 и у ответа прокси его может не быть вовсе, а
  // тест интересует прежде всего код состояния.
  const body = await response.json().catch(() => null);
  return { status: response.status(), body: body as unknown };
}
