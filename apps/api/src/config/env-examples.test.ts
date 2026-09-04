/**
 * Каждая переменная окружения названа в примере, и наоборот.
 *
 * ## Зачем эта сверка появилась (S52)
 *
 * На момент её написания в `.env.example` не было 52 переменных из 91 — среди
 * них `LLM_PROVIDER`, `PROXY_LLM_TOKEN`, весь `RDWEB_*`, `ERROR_REPORTER`,
 * `SENTRY_DSN`, `RATE_LIMIT_MAX`, `RETENTION_DAYS`, `LEGAL_HOLD_ENABLED`. Все
 * они имеют рабочее значение по умолчанию, портал с ними поднимается, и потому
 * их отсутствие в примере никого не остановило.
 *
 * Цена такой невидимости не теоретическая. Оператор не может настроить то, о
 * существовании чего не знает: `RATE_LIMIT_MAX` без `TRUST_PROXY` делает лимит
 * общим на всех, `CLIENT_ERROR_REPORTING=false` скрывает отказы, не оставляющие
 * следа на сервере, `LEGAL_HOLD_ENABLED` решает, отвергается ли удаление. Это
 * настройки, о которых узнают по последствиям, если не прочитать их в примере.
 *
 * Обратная сторона не менее важна: строка в `deploy/id.env.example`, которой
 * нет ни в одной схеме, — это переменная, которую боевой стенд задаёт, а
 * приложение не читает. Опечатка в имени выглядит как настроенное значение и
 * молча не действует.
 *
 * ## Почему исходники читаются текстом, а не импортируются
 *
 * `envSchema` из `config/env.ts` не экспортирован, а схема воркера объявлена
 * прямо в `apps/worker/src/main.ts`. Экспортировать их ради теста — значит
 * расширить публичную поверхность двух модулей под нужды проверки; чтение
 * исходника такого следа не оставляет и уже применяется в портале там, где
 * сверяются две стороны (`modules/navigation/client-routes.test.ts`).
 *
 * Риск чтения текстом — сломавшийся разборщик, который найдёт ноль имён и
 * промолчит. Он закрыт положительными контролями ниже: разборщик обязан найти
 * не меньше определённого числа имён и конкретные известные переменные.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const API_ENV_SOURCE = join(ROOT, 'apps', 'api', 'src', 'config', 'env.ts');
const WORKER_ENV_SOURCE = join(ROOT, 'apps', 'worker', 'src', 'main.ts');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const DEPLOY_ENV_EXAMPLE = join(ROOT, 'deploy', 'id.env.example');
const DEPLOY_MIGRATE_ENV_EXAMPLE = join(ROOT, 'deploy', 'id-migrate.env.example');
const DEPLOY_COMPOSE = join(ROOT, 'deploy', 'docker-compose.prod.yml');

/**
 * Имена полей zod-схемы: `  ИМЯ:` с отступом ровно в два пробела.
 *
 * Отступ — часть признака, а не украшение: без него в выборку попали бы поля
 * вложенных объектов и ключи любых других таблиц в файле.
 */
function schemaKeys(source: string, from = 0): ReadonlySet<string> {
  const text = source.slice(from);
  return new Set([...text.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gmu)].map((match) => match[1] ?? ''));
}

/** Схема воркера объявлена внутри `main.ts`, поэтому вырезается по границам. */
function workerSchemaKeys(source: string): ReadonlySet<string> {
  const start = source.indexOf('workerEnvSchema = z.object({');
  expect(start, 'схема воркера не найдена — разборщик устарел').toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('\n});');
  return schemaKeys(rest.slice(0, end));
}

/**
 * Имена в файле примера — и заданные, и закомментированные.
 *
 * Закомментированные считаются НАЗВАННЫМИ намеренно: у переменной со значением
 * по умолчанию задавать её в файле незачем, а знать о ней нужно. Требование —
 * «переменная описана», а не «переменная задана».
 */
function exampleNames(source: string): ReadonlySet<string> {
  return new Set(
    [...source.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1] ?? ''),
  );
}

const apiKeys = schemaKeys(readFileSync(API_ENV_SOURCE, 'utf8'));
const workerKeys = workerSchemaKeys(readFileSync(WORKER_ENV_SOURCE, 'utf8'));
const example = exampleNames(readFileSync(ENV_EXAMPLE, 'utf8'));
const deployExample = exampleNames(readFileSync(DEPLOY_ENV_EXAMPLE, 'utf8'));
const deployMigrateExample = exampleNames(readFileSync(DEPLOY_MIGRATE_ENV_EXAMPLE, 'utf8'));

/**
 * Переменные, заданные прямо в compose, а не в файле `.env`.
 *
 * Так задан `WORKER_METRICS_PORT`: он стоит рядом с healthcheck, который к нему
 * ходит, и разносить их по двум файлам значило бы сделать возможным состояние
 * «порт сменили, проверка стучится в старый». `deploy/id.env.example` это
 * решение объясняет отдельной строкой.
 */
const composeEnv = new Set(
  [...readFileSync(DEPLOY_COMPOSE, 'utf8').matchAll(/^\s*([A-Z][A-Z0-9_]*):\s/gmu)].map(
    (match) => match[1] ?? '',
  ),
);

/**
 * Имена в примерах, которых нет и не должно быть ни в одной схеме приложения.
 *
 * Список короткий и каждая строка названа поимённо: это не «исключения ради
 * зелёного», а имена, которые читает не приложение.
 */
const NOT_APPLICATION_VARIABLES: Readonly<Record<string, string>> = {
  // Читается гейтом (`hasRealPostgres`), а не `loadEnv()`: включает тесты
  // конкурентности, непроверяемые на pglite (ADR-0002).
  TEST_DATABASE_URL: 'переменная тестов, не приложения',
  // Подставляется в шаблон nginx (`deploy/nginx/id.conf.template`).
  ID_DOMAIN: 'читается развёртыванием, а не порталом',
  // Отдельный шаг миграций ходит под своей ролью с правом DDL: у процесса API
  // такого права нет и быть не должно.
  MIGRATE_DATABASE_URL: 'подключение шага миграций, у него своя роль',
};

const notApplication = new Set(Object.keys(NOT_APPLICATION_VARIABLES));

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('разборщик исходников не сломан', () => {
  /**
   * Положительные контроли.
   *
   * Без них вся сверка проходила бы молча при разборщике, который находит ноль
   * имён: пустое множество — подмножество любого.
   */
  it('находит правдоподобное число переменных и конкретные известные', () => {
    expect(apiKeys.size).toBeGreaterThan(80);
    expect(workerKeys.size).toBeGreaterThan(5);
    expect(example.size).toBeGreaterThan(80);
    expect(deployExample.size).toBeGreaterThan(30);

    expect(apiKeys.has('DATABASE_URL')).toBe(true);
    expect(apiKeys.has('AUTH_MODE')).toBe(true);
    expect(workerKeys.has('WORKER_CONCURRENCY_CPU')).toBe(true);
    expect(example.has('PUBLIC_URL')).toBe(true);

    // Отрицательный контроль: разборщик не должен находить что попало.
    expect(apiKeys.has('WORKER_CONCURRENCY_CPU')).toBe(false);
  });
});

describe('.env.example описывает конфигурацию портала целиком', () => {
  it('каждая переменная схемы названа в примере', () => {
    const missing = sorted([...apiKeys].filter((key) => !example.has(key)));
    expect(
      missing,
      'переменная есть в env.ts и не описана в .env.example: оператор о ней не узнает',
    ).toEqual([]);
  });

  it('каждое имя в примере существует в схеме', () => {
    const unknown = sorted(
      [...example].filter((name) => !apiKeys.has(name) && !notApplication.has(name)),
    );
    expect(
      unknown,
      'имя в .env.example, которого нет в env.ts: опечатка выглядит как настройка и молча не действует',
    ).toEqual([]);
  });
});

describe('примеры развёртывания не задают несуществующего', () => {
  it('каждое имя в deploy/id.env.example читается приложением или названо в исключениях', () => {
    const unknown = sorted(
      [...deployExample].filter(
        (name) => !apiKeys.has(name) && !workerKeys.has(name) && !notApplication.has(name),
      ),
    );
    expect(unknown).toEqual([]);
  });

  it('шаг миграций задаёт только своё подключение', () => {
    const unknown = sorted(
      [...deployMigrateExample].filter((name) => !apiKeys.has(name) && !notApplication.has(name)),
    );
    expect(unknown).toEqual([]);
  });

  it('настройки самого воркера задаются хоть где-то в развёртывании', () => {
    // Воркер живёт своим контейнером, и переменная, не названная ни в `id.env`,
    // ни в compose, задана быть не может вовсе — она существует только в коде.
    //
    // Проверяются ОБА файла, а не один: часть переменных намеренно живёт в
    // compose рядом с тем, что их читает (см. `composeEnv`). Требовать их в
    // `id.env` значило бы требовать дублирования, которое само по себе
    // источник расхождения.
    const missing = sorted(
      [...workerKeys].filter((key) => !deployExample.has(key) && !composeEnv.has(key)),
    );
    expect(missing).toEqual([]);
  });
});
