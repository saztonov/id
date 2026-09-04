/**
 * Стенд сквозного прогона: НАСТОЯЩЕЕ приложение портала на настоящей схеме.
 *
 * ## Почему не мок
 *
 * Задание требует прямо: тест обязан ходить в настоящее API. Причина — не
 * строгость ради строгости, а восемь этапов журнала исполнения, где зелёные
 * тесты сосуществовали с неработающим кодом. Мок отвечает тем, что в него
 * положили, и потому не замечает ни опечатки в пути, ни отсутствия права, ни
 * несовпадения формы ответа, ни того, что маршрут вообще не зарегистрирован.
 *
 * Поэтому здесь поднимается `buildApp()` из `apps/api` — тот же, что слушает
 * порт в бою, — на pglite под настоящими миграциями из `migrations/`, с
 * файловым хранилищем и `AUTH_MODE=dev-stub`. Ни один порт не подменяется.
 *
 * ## Один origin, а не два
 *
 * Статика SPA и API отдаются ОДНИМ сервером. Это не удобство: cookie сессии
 * помечена `SameSite=Lax`, а CSRF-токен читается JavaScript из cookie `id_csrf`
 * (§4.1). На двух origin браузер вёл бы себя иначе, чем в бою, и прогон
 * проверял бы не ту модель безопасности. Поэтому фронтовый сервер сам
 * проксирует `/api`, `/auth`, `/me`, `/health` и `/metrics` в приложение.
 *
 * ## Воркера в стенде нет — кроме одной задачи
 *
 * Конвейер ИД в сквозных сценариях проходится подготовленной фикстурой: поднять
 * настоящий воркер значило бы тащить в прогон qpdf, poppler и модель детекции.
 * Но у массового ввода справочников (§3.2) вся суть в том, что файл разбирает
 * ВОРКЕР, а не API, и без исполнителя сценарий импорта проверял бы только форму
 * загрузки. Поэтому стенд запускает крошечный насос ровно одного типа задач,
 * настоящим обработчиком из `apps/worker/dist`: подмены нет, есть отсутствующий
 * в стенде процесс.
 *
 * ## Импорт `buildApp` относительным путём
 *
 * `@id/api` объявляет в `exports` только корень, а `buildApp` живёт в `app.ts` и
 * из индекса не экспортируется намеренно (воркеру Fastify не нужен). Подпуть
 * через имя пакета карта экспорта закрывает, поэтому берётся файл собранного
 * пакета. Требование к порядку одно: `pnpm -r build` до прогона; при его
 * отсутствии стенд падает с внятным текстом, а не с `ERR_MODULE_NOT_FOUND`.
 */
/*
 * Файл — Node-скрипт (`.mjs`), а не модуль SPA, поэтому глобалии среды
 * объявляются здесь. Общий flat-конфиг ESLint лежит в корне монорепозитория и
 * знает про Node только для `*.ts`; править его ради одного файла воркспейса
 * значило бы менять правила всем одиннадцати пакетам.
 */
/* global process, console, URL, setInterval, clearInterval, AbortController */
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPgliteDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { fixtureSql, KC, LOCAL_LOGINS, LOCAL_PASSWORD, sha256Of } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..', '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const DIST_DIR = join(WEB_ROOT, 'dist');
const API_APP = join(REPO_ROOT, 'apps', 'api', 'dist', 'app.js');
const ROTATED_PDF = join(REPO_ROOT, 'tools', 'fixtures', 'pdf', 'rotated.pdf');

const FRONT_PORT = Number(process.env['E2E_PORT'] ?? 4173);
const API_PORT = Number(process.env['E2E_API_PORT'] ?? 4174);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Пути, которые обслуживает приложение, а не статика. */
const API_PREFIXES = ['/api/', '/auth/', '/me', '/health', '/metrics'];

function isApiPath(url) {
  return API_PREFIXES.some((prefix) => url === prefix || url.startsWith(prefix));
}

function fail(message) {
  console.error(`[стенд] ${message}`);
  process.exit(1);
}

async function startApi() {
  if (!existsSync(API_APP)) {
    fail(
      `не найден собранный пакет API: ${API_APP}\n` +
        'Стенд поднимает настоящее приложение, поэтому перед прогоном нужен `pnpm -r build`.',
    );
  }
  if (!existsSync(ROTATED_PDF)) {
    fail(
      `не найдена фикстура ${ROTATED_PDF}\n` +
        'Синтетические PDF генерируются командой `pnpm fixtures:generate`.',
    );
  }

  const storageDir = mkdtempSync(join(tmpdir(), 'id-e2e-storage-'));
  const pdfBytes = readFileSync(ROTATED_PDF);
  const sha = sha256Of(pdfBytes);

  // Байты кладутся ровно по тому ключу, который записан в `stored_blobs`:
  // `blobs/{aa}/{bb}/{sha256}` (см. `apps/api/src/storage/keys.ts`).
  const blobPath = join(storageDir, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha);
  mkdirSync(dirname(blobPath), { recursive: true });
  writeFileSync(blobPath, pdfBytes);

  const db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  const { buildApp } = await import(pathToFileURL(API_APP).href);
  const { loadEnv, computeAggregateManifestHash } = await import(
    pathToFileURL(join(REPO_ROOT, 'apps', 'api', 'dist', 'index.js')).href
  );

  /*
   * Хэш состава файлов берётся у ПОРТАЛА, а не считается фикстурой заново.
   *
   * Признак «рабочий документ отвечает текущему составу» сервер вычисляет
   * сравнением этого хэша, и экран проверки по нему решает, показывать ли плашку
   * «комплект изменился». Вторая реализация канонической формы разошлась бы с
   * первой на первой же правке, и стенд молча показывал бы плашку всегда.
   *
   * Функция передаётся ИЗВНЕ, а не импортируется фикстурой: тогда сам посев не
   * зависит от `apps/api/dist`, и его можно приложить к схеме без сборки —
   * см. `fixture.test.mjs`. Требование «`pnpm -r build` до прогона» остаётся у
   * стенда, где оно и проверяется несколькими строками выше.
   */
  for (const statement of fixtureSql({
    sha,
    size: pdfBytes.byteLength,
    aggregateHash: computeAggregateManifestHash,
  })) {
    await db.query(statement);
  }

  /**
   * Режим стенда задаётся снаружи.
   *
   * `dev-stub` — прогон существующих сценариев (регрессия). `local` — прогон
   * сценариев локального входа: вход формой, заявка, одобрение, блокировка.
   * Один харнесс на оба режима намеренно: второй, отдельно поддерживаемый,
   * разошёлся бы с первым в фикстуре, и различие сценариев объяснялось бы
   * различием стендов, а не различием режимов.
   */
  const authMode = process.env['E2E_AUTH_MODE'] === 'local' ? 'local' : 'dev-stub';

  const env = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: `http://127.0.0.1:${String(FRONT_PORT)}`,
    DATABASE_URL: 'postgresql://pglite/id-portal-e2e',
    AUTH_MODE: authMode,
    ...(authMode === 'local'
      ? {
          AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-playwright-run-0123456789',
          // Стоимость снижена: прогон выполняет десятки проверок пароля, и
          // боевые 240 мс на каждую превратили бы сценарий в ожидание.
          AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
          AUTH_LOCAL_REGISTER_MAX_PER_IP_HOUR: '1000',
          AUTH_LOCAL_PASSWORD_MAX_PER_HOUR: '1000',
          AUTH_LOCAL_LOGIN_MAX_PER_IP: '1000',
        }
      : {}),
    CSRF_SECRET: 'csrf-secret-of-playwright-run-0123456789',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: storageDir,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-playwright-run',
    // Лимит запросов сняли бы весь прогон целиком: сценарии открывают десятки
    // страниц с одного адреса.
    RATE_LIMIT_MAX: '1000000',
    PREVIEW_MODE: 'pdfjs',
    LOG_LEVEL: 'warn',
  });

  if (authMode === 'local') await seedLocalCredentials(db, env);

  const app = await buildApp({ env, pool: createTestPool(db) });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  const pump = await startCatalogImportPump(app, db);
  return { app, db, storageDir, pump };
}

/**
 * Исполнитель задач `catalog.import.parse`.
 *
 * Берёт очередь напрямую, без `JobRunner`: аренда, повторы и метрики здесь
 * лишние — нужна ровно одна вещь, чтобы загруженный файл был разобран тем же
 * кодом, что и в бою. Обработчик импортируется из собранного воркера.
 */
async function startCatalogImportPump(app, db) {
  const handlerModule = join(REPO_ROOT, 'apps', 'worker', 'dist', 'jobs', 'catalog-import.js');
  if (!existsSync(handlerModule)) {
    fail(
      `не найден собранный воркер: ${handlerModule}
` +
        'Сценарий импорта справочника исполняет настоящую задачу разбора, поэтому нужен `pnpm -r build`.',
    );
  }

  const { createCatalogImportParseHandler } = await import(pathToFileURL(handlerModule).href);
  const handler = createCatalogImportParseHandler({ db: app.db, storage: app.storage });
  const silent = { info() {}, warn() {}, error() {}, debug() {}, child: () => silent };

  const timer = setInterval(() => {
    void (async () => {
      const claimed = await db.query(
        `UPDATE jobs SET status = 'running', locked_by = 'e2e', locked_until = now() + interval '1 minute'
          WHERE id IN (SELECT id FROM jobs WHERE type = 'catalog.import.parse' AND status = 'queued'
                        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, payload`,
      );
      // `db.query` стенда отдаёт массив строк, а не конверт драйвера.
      const job = claimed[0];
      if (job === undefined) return;

      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      try {
        await handler({
          jobId: job.id,
          type: 'catalog.import.parse',
          attempt: 1,
          maxAttempts: 2,
          revisionId: null,
          payload,
          db: app.db,
          logger: silent,
          signal: new AbortController().signal,
          enqueue: async () => ({ jobId: 'e2e', created: true }),
          emit: async () => {},
        });
        await db.query(`UPDATE jobs SET status = 'done' WHERE id = '${job.id}'`);
      } catch (error) {
        console.error('[стенд] разбор импорта справочника упал:', error);
        await db.query(`UPDATE jobs SET status = 'failed' WHERE id = '${job.id}'`);
      }
    })();
  }, 200);
  timer.unref();
  return timer;
}

/**
 * Переводит фикстуру на локальный вход.
 *
 * Та же фикстура и те же люди, но `kc_sub` становится служебным `local:*`, а
 * входить они начинают по адресу и паролю. Иначе пришлось бы держать вторую
 * фикстуру, которая разошлась бы с первой, и различие сценариев объяснялось бы
 * различием данных, а не различием режимов.
 *
 * Хэши считаются НАСТОЯЩЕЙ функцией портала: подставленный вручную хэш проверил
 * бы разбор строки, но не то, что портал умеет её создавать.
 */
async function seedLocalCredentials(db, env) {
  const { hashPassword } = await import(
    pathToFileURL(join(REPO_ROOT, 'apps', 'api', 'dist', 'auth', 'local', 'passwords.js')).href
  );

  for (const [role, subject] of Object.entries(KC)) {
    const login = LOCAL_LOGINS[role];
    const hash = await hashPassword(env, LOCAL_PASSWORD);

    await db.query(`update users set kc_sub = $2, email = $3 where kc_sub = $1`, [
      subject,
      `local:${subject}`,
      login,
    ]);
    await db.query(
      `insert into user_credentials
         (user_id, login_key, login_display, password_hash, password_algorithm)
       select id, $2, $3, $4, $5 from users where kc_sub = $1`,
      [`local:${subject}`, login, login, hash.encoded, hash.algorithm],
    );
  }
}

function proxy(clientRequest, clientResponse) {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: API_PORT,
      method: clientRequest.method,
      path: clientRequest.url,
      headers: { ...clientRequest.headers, host: `127.0.0.1:${String(API_PORT)}` },
    },
    (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    },
  );
  upstream.on('error', (error) => {
    clientResponse.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    clientResponse.end(`Приложение недоступно: ${error.message}`);
  });
  clientRequest.pipe(upstream);
}

function serveStatic(clientRequest, clientResponse) {
  const url = new URL(clientRequest.url ?? '/', 'http://localhost');
  const relative = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = resolve(join(DIST_DIR, relative));

  // Единственный путь наружу из `dist` — обход каталогов; сборка сюда не пишет
  // ничего, что стоило бы прятать, но проверка стоит там, где ключ становится
  // путём, как и в драйвере хранилища.
  const inside = candidate === DIST_DIR || candidate.startsWith(DIST_DIR + sep);
  const path =
    inside && existsSync(candidate) && extname(candidate) !== ''
      ? candidate
      : join(DIST_DIR, 'index.html');

  const body = readFileSync(path);
  clientResponse.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    // Прогон открывает страницы много раз; кэш браузера прятал бы правку сборки.
    'cache-control': 'no-store',
  });
  clientResponse.end(body);
}

async function main() {
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    fail(
      `не найдена сборка SPA: ${DIST_DIR}\nПеред прогоном нужен \`pnpm --filter @id/web build\`.`,
    );
  }

  const started = await startApi();

  const front = createServer((clientRequest, clientResponse) => {
    try {
      if (isApiPath(clientRequest.url ?? '/')) proxy(clientRequest, clientResponse);
      else serveStatic(clientRequest, clientResponse);
    } catch (error) {
      clientResponse.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      clientResponse.end(String(error));
    }
  });

  front.listen(FRONT_PORT, '127.0.0.1', () => {
    console.error(`[стенд] портал на http://127.0.0.1:${String(FRONT_PORT)}`);
  });

  const shutdown = async () => {
    clearInterval(started.pump);
    front.close();
    await started.app.close();
    await started.db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main();
