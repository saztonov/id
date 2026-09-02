/**
 * Каждый адрес, который набирает браузер, существует в собранном приложении.
 *
 * ## Зачем этот тест появился (S45)
 *
 * S44 переименовал `/api/v1/works…` в `/api/v1/folders…` и переписал вместе с
 * сервером его собственные тесты. Клиент переименовали наполовину: ключи и типы
 * стали новыми, строки адресов остались старыми. Всё собралось, все проверки
 * прошли, а на бою экран объекта не показал ни одного комплекта и не завёл
 * ни одного нового — каждый запрос получал 404.
 *
 * Ни один существовавший тест не мог этого поймать, и это не упущение автора:
 *
 * - тесты API дергают адреса, которые сами же и называют, — они правятся вместе
 *   с сервером и разойтись с ним не могут;
 * - у клиента тестов на слой адресов не было вовсе;
 * - e2e-набор такую проверку содержит (`apps/web/e2e/navigation.spec.ts`), но в
 *   `pnpm -r test` не входит: конфигурация vitest видит только `src/**`.
 *
 * Между клиентом и сервером не было ни одного места, где их адреса сверялись бы.
 * Этот тест — такое место.
 *
 * ## Почему сверяются исходники клиента, а не общая таблица
 *
 * Напрашивалось объявить адреса один раз в `@id/contracts` и обязать клиент
 * ходить через них. Но общая таблица защищает ровно до первой строки,
 * написанной по месту вызова, — а в клиенте таких строк 130, и запрет на них
 * пришлось бы проверять ещё одним тестом-сканером. Тогда сканер и есть
 * проверка: он читает те адреса, которые ФАКТИЧЕСКИ уйдут в сеть, включая
 * написанные мимо любой таблицы.
 *
 * ## Как отличается «маршрута нет» от «данных нет»
 *
 * Существование маршрута доказывается тем, что приложение НЕ ответило
 * `404 Маршрут не найден.` — дословным сообщением `setNotFoundHandler`
 * (`apps/api/src/app.ts`). Всё остальное — 401 без сессии, 403 без права, 400 на
 * подставном идентификаторе — означает, что маршрут есть и он отработал.
 * Подставлять валидные данные не нужно: проверяется адрес, а не поведение.
 *
 * ## Почему приложений два
 *
 * Часть маршрутов регистрируется по настройке: вход паролем и админка локальных
 * учётных записей живут только при `AUTH_MODE=local` (`auth/routes.ts`,
 * `modules/admin/routes.ts`). Клиент зовёт их ровно в том же режиме — экран
 * входа спрашивает у портала его конфигурацию, — поэтому проверяемое здесь
 * утверждение звучит так: адрес существует хотя бы в одной поддерживаемой
 * конфигурации портала. Одно приложение объявило бы половину экрана входа
 * несуществующей, и тест пришлось бы глушить списком исключений — то есть
 * ровно тем способом, которым проверки перестают проверять.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { loadEnv } from '../../config/env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const CLIENT_SRC = join(ROOT, 'apps', 'web', 'src');

/** Дословно из `app.setNotFoundHandler`: по нему и отличается «маршрута нет». */
const ROUTE_MISSING_DETAIL = 'Маршрут не найден.';

/**
 * Подстановка вместо параметра адреса.
 *
 * UUID, потому что большинство параметров — идентификаторы со схемой: значение
 * не той формы дало бы 400 ещё до роутера, и тест не отличил бы «маршрут есть,
 * но параметр не тот» от «маршрута нет». Там, где параметр не UUID (код
 * раздела, ключ настройки), 400 тоже приемлем — он доказывает, что маршрут
 * найден и дошёл до проверки схемы.
 */
const PARAM_STUB = '00000000-0000-4000-8000-000000000001';

/**
 * Адреса, которые в сеть не уходят.
 *
 * Список короткий и объяснимый: это не «исключения ради зелёного теста», а
 * строки, которые адресом не являются. Каждая ниже названа поимённо, чтобы
 * добавление сюда требовало довода.
 */
const NOT_ADDRESSES: readonly string[] = [
  // Префикс, из которого адреса собираются (`const V1 = '/api/v1'`).
  '/api/v1',
  // Маска в тексте документации и в комментариях («все эндпоинты /api/v1/*»).
  '/api/v1/*',
  // Пример пути в докстринге модуля предпросмотра PDF, а не вызов.
  '/api/v1/files/{id}/content',
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-client-routes-'));

const COMMON_ENV = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  CSRF_SECRET: 'csrf-secret-of-client-routes-tests-01',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-client-routes-tests',
  RATE_LIMIT_MAX: '100000',
} as const;

const SSO_ENV = loadEnv({ ...COMMON_ENV, AUTH_MODE: 'dev-stub' });

const LOCAL_ENV = loadEnv({
  ...COMMON_ENV,
  AUTH_MODE: 'local',
  AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-client-routes-tests-01',
  // Минимально допустимая стоимость: тест паролей не проверяет, а боевая
  // добавила бы к подъёму приложения секунды на прогрев.
  AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
});

let db: TestDatabase;
let apps: AppInstance[];

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  const pool = createTestPool(db) as unknown as Pool;
  apps = [await buildApp({ env: SSO_ENV, pool }), await buildApp({ env: LOCAL_ENV, pool })];
  for (const app of apps) await app.ready();
}, 240_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

interface ClientAddress {
  /** Адрес с подставленными параметрами — то, что уйдёт в сеть. */
  readonly url: string;
  /** Как он написан в исходнике: по нему человек найдёт место. */
  readonly literal: string;
  readonly file: string;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!/\.tsx?$/u.test(entry) || /\.test\.tsx?$/u.test(entry)) continue;
    found.push(path);
  }
  return found;
}

/**
 * Подставить в шаблон значения вместо `${…}`.
 *
 * `null` — в подстановке оказалось выражение (тернарник, вызов), и собрать из
 * него адрес нельзя. Такие строки тест пропускает: гадать, во что они
 * развернутся, значит проверять собственную догадку.
 */
function resolveTemplate(literal: string): string | null {
  // Кавычка или пробел внутри литерала означают, что там не адрес, а выражение:
  // `…/export${suffix === '' ? '' : …}`. Развернуть его статически нельзя.
  if (/['"\s]/u.test(literal)) return null;

  const withParams = literal.replace(/\$\{[^}]*\}/gu, PARAM_STUB);
  if (withParams.includes('${') || withParams.includes('}')) return null;

  // Строка запроса к роутеру отношения не имеет: маршрут ищется по пути.
  return withParams.split('?')[0] ?? withParams;
}

function collectClientAddresses(): ClientAddress[] {
  const found = new Map<string, ClientAddress>();

  for (const file of sourceFiles(CLIENT_SRC)) {
    const text = readFileSync(file, 'utf8');
    const literals = [
      ...[...text.matchAll(/[`'](\/api\/v1[^`'\s]*)[`']/gu)].map((m) => m[1] ?? ''),
      ...[...text.matchAll(/`\$\{V1\}([^`]*)`/gu)].map((m) => `/api/v1${m[1] ?? ''}`),
    ];

    for (const literal of literals) {
      if (NOT_ADDRESSES.includes(literal)) continue;
      const url = resolveTemplate(literal);
      if (url === null) continue;
      found.set(url, { url, literal, file: file.slice(ROOT.length + 1).replace(/\\/gu, '/') });
    }
  }

  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Отвечает ли приложение по этому адресу хоть на один метод.
 *
 * Метод из исходника не вычитывается намеренно: разбор `request('POST', …)`
 * против `get(…)` добавил бы к тесту собственный парсер вызовов, который сам
 * может ошибиться. Проверяемое утверждение слабее и достаточно: адрес известен
 * роутеру. Дефект, ради которого тест написан, — исчезнувший путь целиком.
 */
async function routeExists(url: string): Promise<boolean> {
  for (const app of apps) {
    for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({ method, url });
      if (response.statusCode !== 404) return true;

      const problem = response.json<{ detail?: string }>();
      if (problem.detail !== ROUTE_MISSING_DETAIL) return true;
    }
  }
  return false;
}

describe('адреса клиента и маршруты API', () => {
  it('каждый адрес, который зовёт клиент, известен приложению', async () => {
    const addresses = collectClientAddresses();

    // Защита от самообмана: пустой список прошёл бы проверку молча — ровно так
    // же, как молчал бы сломавшийся сканер исходников.
    expect(addresses.length).toBeGreaterThan(100);

    const missing: string[] = [];
    for (const address of addresses) {
      if (!(await routeExists(address.url))) {
        missing.push(`${address.literal}  (${address.file})`);
      }
    }

    expect(missing, `клиент зовёт адреса, которых нет в API:\n${missing.join('\n')}`).toEqual([]);
  }, 120_000);

  it('несуществующий адрес отличим от существующего', async () => {
    // Положительный контроль рядом с отрицательным: без него проверка выше
    // проходила бы и при сломанном `routeExists`, всегда отвечающем «есть».
    expect(await routeExists('/api/v1/folders')).toBe(true);
    expect(await routeExists('/api/v1/works')).toBe(false);
  }, 30_000);
});
