/**
 * Справочники (§3.2): проверки через HTTP на собранном приложении.
 *
 * Приложение поднимается штатным `buildApp()` поверх настоящей PostgreSQL
 * (pglite) под миграциями проекта, включая seed каталога видов ИД, а вход идёт
 * штатным потоком `/auth/login` → `/auth/callback`. Ни один маршрут здесь не
 * объявлен заново и ни одна функция репозитория не вызывается напрямую:
 * проверяется то, что зарегистрировано в `app.ts`. Тест, вызывающий
 * `createSectionProfile()` мимо роута, доказывал бы работоспособность модуля,
 * который в приложение может быть и не подключён — это ровно тот дефект, что
 * нашёлся на S3.
 *
 * Что здесь проверяется по существу, а не «эндпоинт отвечает 200»:
 *
 * 1. **Границы форматов держит вход, а не БД.** Контрольная сумма ИНН, длина кода
 *    объекта, длина КПП — 422 на границе. Показательно именно значение с ВЕРНОЙ
 *    формой и битой контрольной суммой: CHECK `counterparties_inn_chk` такое
 *    значение принимает, поэтому 422 доказывает, что отказ дала схема входа.
 * 2. **Разграничение прав отдельно для чтения и записи** (§4.1): читают
 *    справочник все роли, пишет только администратор, а очередь кандидатов
 *    закрыта и на чтение, потому что в ней лежат фрагменты чужих документов.
 * 3. **Новый раздел стартует в `assisted`** (§0.5, п.5) — и отказ приходит
 *    именно отказом, а не молчаливым понижением уровня.
 * 4. **Версионность профиля** — прогон проверок месячной давности обязан
 *    разрешаться в ту же версию профиля после публикации новой.
 * 5. **Наложения каталога видов ИД не затирают поставку.** Проверяется прямым
 *    SQL по `doc_types`, а не только формой ответа: иначе «переопределил» и
 *    «переписал строку seed» неразличимы.
 * 6. **Кандидат закрывается, а не удаляется.** Удаление стёрло бы историю
 *    решения администратора и вернуло бы тот же заголовок в очередь при
 *    следующей поставке.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase, createTestPool } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

// =====================================================================
// Фикстура
// =====================================================================

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_DEVELOPER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(3);

const USER_ADMIN = id(10);
const USER_ENGINEER = id(11);
/** Инженер без назначенных объектов: пустая область видимости (§1.6). */
const USER_ENGINEER_BLANK = id(12);
const USER_MANAGER = id(13);
const USER_CONTRACTOR = id(14);

const CANDIDATE_FREQUENT = id(20);
const CANDIDATE_MID = id(21);
const CANDIDATE_RARE = id(22);

const KC = {
  admin: 'kc-catalog-admin',
  engineer: 'kc-catalog-engineer',
  engineerBlank: 'kc-catalog-engineer-blank',
  manager: 'kc-catalog-manager',
  contractor: 'kc-catalog-contractor',
} as const;

/** Раздел из корпуса; профили версионируются именно по нему. */
const SECTION_ROOFING = 'roofing';
const SECTION_RC = 'rc_structures';

/** Системный вид ИД из seed-миграции 0009: на нём проверяются наложения. */
const DOC_TYPE_SYSTEM = 'aosr';
const DOC_TYPE_SYSTEM_NAME = 'Акт освидетельствования скрытых работ';

// Синтетические реквизиты. Контрольные суммы посчитаны, реальные значения
// корпуса в тесты не попадают — это держит `pnpm pii:scan`.
const INN_VALID = '7700123459';
/** Форма верна (CHECK в БД такое пропустит), контрольная сумма — нет. */
const INN_BROKEN_CHECKSUM = '7700123458';
const KPP_VALID = '770012345';
const OGRN_VALID = '1027700123450';
/** 12 цифр вместо 13 — дефект оформления, а не распознавания (§9.2). */
const OGRN_TOO_SHORT = '102770012345';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind, inn)
     VALUES ('${ORG_DEVELOPER}', 'ООО «Застройщик»', 'customer', '${INN_VALID}')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядная организация»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  // Реестр правил заполняется сидом 0017 из RULE_CATALOG (S9), поэтому здесь
  // фикстур нет: собственная строка rule_definitions ломала бы сверку реестра
  // с реализациями при старте приложения (§9.6). Коды ниже — настоящие.

  `INSERT INTO sections (code, name) VALUES ('${SECTION_ROOFING}', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO sections (code, name) VALUES ('${SECTION_RC}', 'Несущие ЖБ конструкции надземной части') ON CONFLICT (code) DO NOTHING`,

  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор портала')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер объекта')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_BLANK}', '${KC.engineerBlank}', 'Инженер без объектов')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR}', '${KC.contractor}', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,

  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_BLANK}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

  // Очередь кандидатов: разная частота проверяет и сортировку, и курсор.
  `INSERT INTO doc_type_candidates
     (id, observed_title_norm, observed_title_sample, occurrences)
     VALUES ('${CANDIDATE_FREQUENT}', 'акт приемки узла учета',
             'АКТ приёмки узла учёта тепловой энергии', 14)`,
  `INSERT INTO doc_type_candidates
     (id, observed_title_norm, observed_title_sample, occurrences)
     VALUES ('${CANDIDATE_MID}', 'ведомость смонтированных закладных',
             'ВЕДОМОСТЬ смонтированных закладных деталей', 5)`,
  `INSERT INTO doc_type_candidates
     (id, observed_title_norm, observed_title_sample, occurrences)
     VALUES ('${CANDIDATE_RARE}', 'протокол проверки узла', 'ПРОТОКОЛ проверки узла', 1)`,
];

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-catalog-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/catalog-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-catalog-tests',
  RATE_LIMIT_MAX: '100000',
});

let db: TestDatabase;
let app: AppInstance;

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await db.query(statement);
  }

  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

// =====================================================================
// Вход и запросы
// =====================================================================

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface SignedIn {
  readonly cookie: string;
  readonly csrfToken: string;
}

function cookieOf(response: LightMyRequestResponse, name: string): string {
  const found = response.cookies.filter((cookie) => cookie.name === name).at(-1);
  if (found === undefined || found.value === '') throw new Error(`В ответе нет cookie ${name}`);
  return found.value;
}

function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return `${name}=${encodeURIComponent(cookieOf(response, name))}`;
}

function locationOf(response: LightMyRequestResponse): string {
  const value = response.headers['location'];
  if (typeof value !== 'string') throw new Error('В ответе нет заголовка location');
  return value;
}

async function signIn(kcSub: string): Promise<SignedIn> {
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(kcSub)}`,
  });
  expect(started.statusCode).toBe(302);

  const authorizationUrl = new URL(locationOf(started));
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  expect(completed.statusCode).toBe(302);

  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

const signedIn = new Map<string, SignedIn>();

async function sessionFor(kcSub: string): Promise<SignedIn> {
  const cached = signedIn.get(kcSub);
  if (cached !== undefined) return cached;
  const fresh = await signIn(kcSub);
  signedIn.set(kcSub, fresh);
  return fresh;
}

async function call(
  method: Method,
  url: string,
  session: SignedIn | null,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    ...(session === null
      ? {}
      : { headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken } }),
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}

async function as(
  kcSub: string,
  method: Method,
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return call(method, url, await sessionFor(kcSub), body);
}

function asAdmin(method: Method, url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return as(KC.admin, method, url, body);
}

/** Указатели полей из конверта problem+json: по ним проверяется адрес отказа. */
function pointersOf(response: LightMyRequestResponse): readonly (string | null)[] {
  return (
    response.json<{ errors?: { pointer: string | null }[] }>().errors?.map((e) => e.pointer) ?? []
  );
}

function detailOf(response: LightMyRequestResponse): string {
  return response.json<{ detail?: string }>().detail ?? '';
}

function messagesOf(response: LightMyRequestResponse): string {
  return (response.json<{ errors?: { message: string }[] }>().errors ?? [])
    .map((e) => e.message)
    .join(' | ');
}

const P = '/api/v1/catalog';

// =====================================================================
// Регистрация маршрутов
// =====================================================================

describe('маршруты справочников зарегистрированы в приложении', () => {
  /**
   * Через `hasRoute`, а не поиском в `printRoutes()`: дерево склеивает общие
   * префиксы («doc-types» и «doc-type-candidates» печатаются как общий кусок),
   * поэтому подстроки полного пути в нём может не быть у исправного маршрута.
   */
  const EXPECTED_ROUTES: readonly (readonly [Method, string])[] = [
    ['GET', `${P}/objects`],
    ['GET', `${P}/objects/:objectId`],
    ['POST', `${P}/objects`],
    ['PATCH', `${P}/objects/:objectId`],
    ['DELETE', `${P}/objects/:objectId`],
    ['GET', `${P}/counterparties`],
    ['GET', `${P}/counterparties/:counterpartyId`],
    ['POST', `${P}/counterparties`],
    ['PATCH', `${P}/counterparties/:counterpartyId`],
    ['DELETE', `${P}/counterparties/:counterpartyId`],
    ['GET', `${P}/counterparty-kinds`],
    ['POST', `${P}/counterparty-kinds`],
    ['GET', `${P}/sections`],
    ['POST', `${P}/sections`],
    ['PATCH', `${P}/sections/:sectionCode`],
    ['GET', `${P}/objects/:objectId/sections`],
    ['PUT', `${P}/objects/:objectId/sections/:sectionCode`],
    ['GET', `${P}/objects/:objectId/contractors`],
    ['PUT', `${P}/objects/:objectId/contractors/:contractorId`],
    ['GET', `${P}/sections/:sectionCode/effective-profile`],
    ['GET', `${P}/section-profiles`],
    ['POST', `${P}/section-profiles`],
    ['POST', `${P}/section-profiles/:profileId/publish`],
    ['GET', `${P}/objects/:objectId/rd-documents`],
    ['POST', `${P}/objects/:objectId/rd-documents`],
    ['PATCH', `${P}/rd-documents/:rdDocumentId`],
    ['GET', `${P}/doc-types`],
    ['GET', `${P}/doc-types/:code`],
    ['POST', `${P}/doc-types`],
    ['PATCH', `${P}/doc-types/:code`],
    ['DELETE', `${P}/doc-types/:code/override`],
    ['GET', `${P}/doc-type-candidates`],
    ['GET', `${P}/doc-type-candidates/:candidateId`],
    ['PATCH', `${P}/doc-type-candidates/:candidateId`],
    ['POST', `${P}/doc-type-candidates/:candidateId/map`],
    ['POST', `${P}/doc-type-candidates/:candidateId/doc-type`],
  ];

  it('все маршруты модуля зарегистрированы', () => {
    for (const [method, url] of EXPECTED_ROUTES) {
      expect({ method, url, registered: app.hasRoute({ method, url }) }).toEqual({
        method,
        url,
        registered: true,
      });
    }
  });

  it('без сессии — 401, а не 403', async () => {
    expect((await call('GET', `${P}/doc-types`, null)).statusCode).toBe(401);
    expect((await call('GET', `${P}/objects`, null)).statusCode).toBe(401);
  });

  it('запись без CSRF-заголовка отклоняется', async () => {
    const session = await sessionFor(KC.admin);
    const response = await app.inject({
      method: 'POST',
      url: `${P}/sections`,
      headers: { cookie: session.cookie },
      payload: { code: 'no_csrf', name: 'Без CSRF' },
    });
    expect(response.statusCode).toBe(403);
  });
});

// =====================================================================
// Права: читают все, пишет администратор
// =====================================================================

describe('права на справочники: чтение всем, запись администратору', () => {
  it('каталог видов ИД читают все четыре роли', async () => {
    for (const kcSub of [KC.contractor, KC.engineer, KC.manager, KC.admin]) {
      const response = await as(kcSub, 'GET', `${P}/doc-types`);
      expect({ kcSub, status: response.statusCode }).toEqual({ kcSub, status: 200 });
      expect(response.json<unknown[]>().length).toBeGreaterThan(0);
    }
  });

  it('справочники объектов и контрагентов читают все роли', async () => {
    for (const kcSub of [KC.contractor, KC.engineer, KC.manager, KC.admin]) {
      expect((await as(kcSub, 'GET', `${P}/objects`)).statusCode).toBe(200);
      expect((await as(kcSub, 'GET', `${P}/counterparties`)).statusCode).toBe(200);
      expect((await as(kcSub, 'GET', `${P}/sections`)).statusCode).toBe(200);
    }
  });

  it('запись в справочник от НЕ-администратора даёт 403', async () => {
    const writes: readonly (readonly [Method, string, unknown])[] = [
      ['POST', `${P}/counterparties`, { name: 'ООО «Проба»', kind: 'supplier' }],
      ['POST', `${P}/objects`, { code: 'DENY1', name: 'Проба', fullName: 'Проба' }],
      ['POST', `${P}/sections`, { code: 'denied_section', name: 'Проба' }],
      ['POST', `${P}/section-profiles`, { sectionCode: SECTION_RC, effectiveFrom: '2026-01-01' }],
      ['PATCH', `${P}/doc-types/${DOC_TYPE_SYSTEM}`, { name: 'Проба' }],
    ];

    for (const kcSub of [KC.contractor, KC.engineer, KC.manager]) {
      for (const [method, url, body] of writes) {
        const response = await as(kcSub, method, url, body);
        expect({ kcSub, url, status: response.statusCode }).toEqual({
          kcSub,
          url,
          status: 403,
        });
      }
    }
  });

  it('очередь кандидатов закрыта и на чтение: в ней фрагменты чужих документов', async () => {
    for (const kcSub of [KC.contractor, KC.engineer, KC.manager]) {
      const response = await as(kcSub, 'GET', `${P}/doc-type-candidates`);
      expect({ kcSub, status: response.statusCode }).toEqual({ kcSub, status: 403 });
    }
    expect((await asAdmin('GET', `${P}/doc-type-candidates`)).statusCode).toBe(200);
  });

  it('инженеру без назначений справочники видны целиком', async () => {
    // Прежде это утверждение было обратным и опиралось на «пустую область»
    // (§1.6). Заказчик снял деление стройки на назначенные и прочие объекты
    // (S37) — именно с этого экрана и началась правка: инженер видел
    // «Объектов в вашей области видимости нет» и не мог завести ни одного
    // комплекта.
    const types = await as(KC.engineerBlank, 'GET', `${P}/doc-types`);
    expect(types.statusCode).toBe(200);
    expect(types.json<unknown[]>()).not.toEqual([]);

    const objects = await as(KC.engineerBlank, 'GET', `${P}/objects`);
    expect(objects.json<{ items: unknown[] }>().items).not.toEqual([]);

    expect(
      (await as(KC.engineerBlank, 'GET', `${P}/doc-types/${DOC_TYPE_SYSTEM}`)).statusCode,
    ).toBe(200);
  });
});

// =====================================================================
// Объекты строительства: код — 1–5 символов любого алфавита
// =====================================================================

describe('объект строительства: код — от 1 до 5 символов любого алфавита', () => {
  it('код из 6 символов отвергается с 422, из 4 и из 5 — принимается', async () => {
    const six = await asAdmin('POST', `${P}/objects`, {
      code: 'TST123',
      name: 'Объект с длинным кодом',
      fullName: 'Объект с длинным кодом',
    });
    expect(six.statusCode).toBe(422);
    expect(pointersOf(six)).toContain('/code');

    // Короткий код стал законным (0033): длина реквизита, назначаемого
    // стройкой, требованием портала не является.
    const four = await asAdmin('POST', `${P}/objects`, {
      code: 'TST1',
      name: 'Объект с коротким кодом',
      fullName: 'Объект с коротким кодом',
    });
    expect(four.statusCode).toBe(201);

    const five = await asAdmin('POST', `${P}/objects`, {
      code: 'TST05',
      name: 'Объект 5',
      fullName: 'ЖК «Тест», корпус 5',
      developerId: ORG_DEVELOPER,
    });
    expect(five.statusCode).toBe(201);
    expect(five.json<{ code: string; developerId: string }>()).toMatchObject({
      code: 'TST05',
      developerId: ORG_DEVELOPER,
    });

    // Отвергнутая форма в базу не попала: 422 — это отказ на входе, а не
    // «вставилось и откатилось».
    const rows = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM construction_objects WHERE code = 'TST123'`,
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('кириллический код принимается: он назначен стройкой, а не порталом', async () => {
    const cyrillic = await asAdmin('POST', `${P}/objects`, {
      code: 'ЗИЛ18',
      name: 'Объект ЗИЛ',
      fullName: 'ЖК «ЗИЛ», корпус 18',
    });
    expect(cyrillic.statusCode).toBe(201);
    expect(cyrillic.json<{ code: string }>()).toMatchObject({ code: 'ЗИЛ18' });
  });

  it('код с разделителем и повторный код различаются по статусу', async () => {
    const separator = await asAdmin('POST', `${P}/objects`, {
      code: 'ЗИЛ-8',
      name: 'Объект',
      fullName: 'Объект',
    });
    expect(separator.statusCode).toBe(422);
    expect(pointersOf(separator)).toContain('/code');

    const duplicate = await asAdmin('POST', `${P}/objects`, {
      code: 'TST01',
      name: 'Дубль кода',
      fullName: 'Дубль кода',
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('неизвестный застройщик — 422 с указанием поля, а не 500', async () => {
    const response = await asAdmin('POST', `${P}/objects`, {
      code: 'TST06',
      name: 'Объект 6',
      fullName: 'Объект 6',
      developerId: id(900),
    });
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response)).toContain('/developerId');
  });

  it('повреждённый курсор — 400, а не молчаливый возврат к первой странице', async () => {
    const response = await asAdmin('GET', `${P}/objects?cursor=%2A%2A%2A`);
    expect(response.statusCode).toBe(400);
  });
});

// =====================================================================
// Контрагенты: контрольные суммы проверяет вход
// =====================================================================

describe('контрагент: битые реквизиты отвергаются на входе, а не в БД', () => {
  it('ИНН с верной длиной и битой контрольной суммой не доходит до БД', async () => {
    const response = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Опечатка в ИНН»',
      kind: 'supplier',
      inn: INN_BROKEN_CHECKSUM,
    });

    // Показательность этого случая в том, что БД такое значение ПРИНЯЛА БЫ:
    // CHECK `counterparties_inn_chk` проверяет только форму «10 или 12 цифр».
    // Значит 422 доказывает отказ схемы входа, а не срабатывание ограничения.
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response)).toContain('/inn');
    expect(messagesOf(response)).toContain('Контрольная сумма');
    // И названы обе цифры: администратор по ним решает, сверять ли с выпиской.
    expect(messagesOf(response)).toContain('ожидалась цифра 9');

    const rows = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM counterparties WHERE inn = '${INN_BROKEN_CHECKSUM}'`,
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('ОГРН из 12 цифр отвергается по длине, КПП из 8 и 10 — тоже', async () => {
    const ogrn = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Короткий ОГРН»',
      kind: 'supplier',
      ogrn: OGRN_TOO_SHORT,
    });
    expect(ogrn.statusCode).toBe(422);
    expect(pointersOf(ogrn)).toContain('/ogrn');
    expect(messagesOf(ogrn)).toContain('13 цифр');

    for (const kpp of ['77001234', '7700123456']) {
      const response = await asAdmin('POST', `${P}/counterparties`, {
        name: `ООО «КПП ${kpp.length}»`,
        kind: 'supplier',
        kpp,
      });
      expect({ kpp, status: response.statusCode }).toEqual({ kpp, status: 422 });
      expect(pointersOf(response)).toContain('/kpp');
    }
  });

  it('полностью корректная карточка создаётся и читается обратно', async () => {
    const created = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Поставщик бетона»',
      kind: 'supplier',
      inn: INN_VALID,
      kpp: KPP_VALID,
      ogrn: OGRN_VALID,
      legalAddress: 'г. Тестовый, ул. Проверочная, 1',
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<{ id: string; inn: string; kpp: string; ogrn: string }>();
    expect(body).toMatchObject({ inn: INN_VALID, kpp: KPP_VALID, ogrn: OGRN_VALID });

    const read = await asAdmin('GET', `${P}/counterparties/${body.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ name: string }>().name).toBe('ООО «Поставщик бетона»');
  });

  it('правка с битым ИНН отвергается, пустая правка — тоже', async () => {
    const broken = await asAdmin('PATCH', `${P}/counterparties/${ORG_CONTRACTOR}`, {
      inn: INN_BROKEN_CHECKSUM,
    });
    expect(broken.statusCode).toBe(422);

    const empty = await asAdmin('PATCH', `${P}/counterparties/${ORG_CONTRACTOR}`, {});
    expect(empty.statusCode).toBe(422);

    // Значение в БД не изменилось ни в одном из двух случаев.
    const rows = await db.query<{ inn: string | null }>(
      `SELECT inn FROM counterparties WHERE id = '${ORG_CONTRACTOR}'`,
    );
    expect(rows[0]?.inn).toBeNull();
  });
});

// =====================================================================
// Разделы объекта и реестр РД
// =====================================================================

describe('разделы объекта и реестр рабочей документации', () => {
  it('раздел объекта включается и выключается переключателем', async () => {
    const listed = await as(KC.engineer, 'GET', `${P}/objects/${OBJECT}/sections`);
    expect(listed.statusCode).toBe(200);

    // Отдаётся ВЕСЬ справочник с отметкой: список из одних включённых не дал бы
    // способа включить первый.
    const before = listed.json<{ sectionCode: string; isActive: boolean }[]>();
    expect(before.map((row) => row.sectionCode)).toContain(SECTION_ROOFING);
    expect(before.find((row) => row.sectionCode === SECTION_ROOFING)?.isActive).toBe(false);

    const enabled = await asAdmin('PUT', `${P}/objects/${OBJECT}/sections/${SECTION_ROOFING}`, {
      isActive: true,
    });
    expect(enabled.statusCode).toBe(200);
    // Наименование приходит из справочника, а не из фикстуры: вставка раздела
    // в тесте идёт `ON CONFLICT DO NOTHING` поверх сида 0029, и второй источник
    // имени здесь нарочно не заводится.
    expect(enabled.json<{ isActive: boolean; sectionCode: string; name: string }>()).toMatchObject({
      isActive: true,
      sectionCode: SECTION_ROOFING,
      name: 'Кровля',
    });

    // Повтор того же включения — не ошибка: переключатель идемпотентен, и
    // второе нажатие обязано означать то же, что первое.
    const again = await asAdmin('PUT', `${P}/objects/${OBJECT}/sections/${SECTION_ROOFING}`, {
      isActive: true,
    });
    expect(again.statusCode).toBe(200);

    const off = await asAdmin('PUT', `${P}/objects/${OBJECT}/sections/${SECTION_ROOFING}`, {
      isActive: false,
    });
    expect(off.json<{ isActive: boolean }>().isActive).toBe(false);
  });

  it('раздела нет в справочнике — 404, а не нарушение внешнего ключа', async () => {
    const response = await asAdmin('PUT', `${P}/objects/${OBJECT}/sections/no_such_section`, {
      isActive: true,
    });
    expect(response.statusCode).toBe(404);
  });

  it('раздел неизвестного объекта — 404', async () => {
    const response = await asAdmin('PUT', `${P}/objects/${id(901)}/sections/${SECTION_ROOFING}`, {
      isActive: true,
    });
    expect(response.statusCode).toBe(404);
  });

  it('подрядчик закрепляется за объектом и открепляется', async () => {
    const assigned = await asAdmin('PUT', `${P}/objects/${OBJECT}/contractors/${ORG_CONTRACTOR}`, {
      isActive: true,
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json<{ contractorId: string; isActive: boolean }>()).toMatchObject({
      contractorId: ORG_CONTRACTOR,
      isActive: true,
    });

    const listed = await as(KC.engineer, 'GET', `${P}/objects/${OBJECT}/contractors`);
    expect(listed.json<{ contractorId: string }[]>().map((row) => row.contractorId)).toContain(
      ORG_CONTRACTOR,
    );

    const released = await asAdmin('PUT', `${P}/objects/${OBJECT}/contractors/${ORG_CONTRACTOR}`, {
      isActive: false,
    });
    expect(released.json<{ isActive: boolean }>().isActive).toBe(false);
  });

  it('раздел заводится в справочник и отключается в нём же', async () => {
    const created = await asAdmin('POST', `${P}/sections`, {
      code: 'catalog_probe',
      name: 'Раздел-проба',
      sortOrder: 990,
    });
    expect(created.statusCode).toBe(201);

    const duplicate = await asAdmin('POST', `${P}/sections`, {
      code: 'catalog_probe',
      name: 'Он же ещё раз',
    });
    expect(duplicate.statusCode).toBe(409);

    const badCode = await asAdmin('POST', `${P}/sections`, { code: 'Кровля', name: 'Кириллица' });
    expect(badCode.statusCode).toBe(422);

    const off = await asAdmin('PATCH', `${P}/sections/catalog_probe`, { isActive: false });
    expect(off.json<{ isActive: boolean }>().isActive).toBe(false);

    // Отключённый в справочнике раздел на объекте включить нельзя: иначе
    // «отключён» означало бы только «не показывать в списке». Отказ — 409, а не
    // 422: тело запроса верное, противоречит ему состояние справочника.
    const enable = await asAdmin('PUT', `${P}/objects/${OBJECT}/sections/catalog_probe`, {
      isActive: true,
    });
    expect(enable.statusCode).toBe(409);
  });

  it('документ РД создаётся, неизвестный проектировщик даёт 422', async () => {
    const created = await asAdmin('POST', `${P}/objects/${OBJECT}/rd-documents`, {
      cipher: '2.5.1-АР',
      revision: 'изм. 2',
      name: 'Кровля. Планы и узлы',
      designerId: ORG_DEVELOPER,
    });
    expect(created.statusCode).toBe(201);

    const listed = await as(KC.engineer, 'GET', `${P}/objects/${OBJECT}/rd-documents`);
    expect(listed.json<{ items: { cipher: string }[] }>().items.map((rd) => rd.cipher)).toEqual([
      '2.5.1-АР',
    ]);

    const unknownDesigner = await asAdmin('POST', `${P}/objects/${OBJECT}/rd-documents`, {
      cipher: '2.5.2-АР',
      designerId: id(902),
    });
    expect(unknownDesigner.statusCode).toBe(422);
    expect(pointersOf(unknownDesigner)).toContain('/designerId');
  });
});

// =====================================================================
// Профили видов разделов: автономия и версионность
// =====================================================================

interface ProfileResponse {
  id: string;
  sectionCode: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  expectedDocTypes: string[];
  enabledRuleCodes: string[];
  autonomyLevel: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

describe('профиль раздела: новый раздел стартует в assisted', () => {
  let first: ProfileResponse;
  let second: ProfileResponse;

  it('создание раздела сразу в automatic отвергается', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_ROOFING,
      effectiveFrom: '2026-01-01',
      expectedDocTypes: [DOC_TYPE_SYSTEM, 'annex_registry'],
      enabledRuleCodes: ['AOSR.HDR.022'],
      autonomyLevel: 'automatic',
      publish: true,
    });

    // Отказ, а не молчаливое понижение до assisted: §0.5 п.5 требует, чтобы
    // автоматизм включался решением на накопленной статистике, и администратор
    // обязан узнать, что его решение не применено.
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response)).toContain('/autonomyLevel');
    expect(detailOf(response)).toContain('Автоматический режим');

    const rows = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM section_profiles WHERE section_code = '${SECTION_ROOFING}'`,
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('первая версия публикуется в assisted', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_ROOFING,
      effectiveFrom: '2026-01-01',
      expectedDocTypes: [DOC_TYPE_SYSTEM, 'annex_registry'],
      enabledRuleCodes: ['AOSR.HDR.022'],
      thresholds: { ocrConfidence: 0.75 },
      publish: true,
    });
    expect(response.statusCode).toBe(201);

    first = response.json<ProfileResponse>();
    expect(first).toMatchObject({
      version: 1,
      autonomyLevel: 'assisted',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      publishedBy: USER_ADMIN,
    });
    expect(first.publishedAt).not.toBeNull();
    expect(first.expectedDocTypes).toEqual([DOC_TYPE_SYSTEM, 'annex_registry']);
  });

  it('automatic отвергается, пока нет накопленной статистики раздела', async () => {
    // §16: переход в automatic требует не менее пяти поставок раздела и доли
    // ручных правок типа ниже 10%. Статистика появляется на S8, поэтому сейчас
    // отказ — единственный правильный ответ. Молчаливый переход был бы хуже
    // отсутствия гейта: раздел стал бы автоматическим без подтверждения качества.
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_ROOFING,
      effectiveFrom: '2026-06-01',
      expectedDocTypes: [DOC_TYPE_SYSTEM, 'annex_registry', 'mill_certificate'],
      enabledRuleCodes: ['AOSR.HDR.022', 'DATE.312'],
      autonomyLevel: 'automatic',
      publish: true,
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('autonomy');
  });

  it('вторая версия в assisted публикуется и закрывает период первой', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_ROOFING,
      effectiveFrom: '2026-06-01',
      expectedDocTypes: [DOC_TYPE_SYSTEM, 'annex_registry', 'mill_certificate'],
      enabledRuleCodes: ['AOSR.HDR.022', 'DATE.312'],
      autonomyLevel: 'assisted',
      publish: true,
    });
    expect(response.statusCode).toBe(201);

    second = response.json<ProfileResponse>();
    expect(second).toMatchObject({ version: 2, autonomyLevel: 'assisted' });
    expect(second.id).not.toBe(first.id);
  });

  it('публикация новой версии не ломает прежнюю', async () => {
    const listed = await asAdmin('GET', `${P}/section-profiles?sectionCode=${SECTION_ROOFING}`);
    expect(listed.statusCode).toBe(200);
    const versions = listed.json<ProfileResponse[]>();

    expect(versions.map((profile) => profile.version)).toEqual([2, 1]);

    const previous = versions.find((profile) => profile.id === first.id);
    // Содержимое прежней версии не тронуто: изменился только конец периода.
    expect(previous).toMatchObject({
      version: 1,
      autonomyLevel: 'assisted',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-05-31',
    });
    expect(previous?.expectedDocTypes).toEqual(first.expectedDocTypes);
    expect(previous?.enabledRuleCodes).toEqual(first.enabledRuleCodes);
    expect(previous?.publishedAt).toBe(first.publishedAt);
  });

  it('прогон на прошедшую дату разрешается в ту же версию, что и до публикации', async () => {
    // Это и есть смысл версионности профиля: результат проверки, выполненной
    // 15 марта, воспроизводим после того, как в июне опубликован новый профиль.
    const past = await asAdmin(
      'GET',
      `${P}/sections/${SECTION_ROOFING}/effective-profile?at=2026-03-15`,
    );
    expect(past.statusCode).toBe(200);
    expect(past.json<ProfileResponse>().id).toBe(first.id);
    expect(past.json<ProfileResponse>().version).toBe(1);

    const now = await asAdmin(
      'GET',
      `${P}/sections/${SECTION_ROOFING}/effective-profile?at=2026-08-01`,
    );
    expect(now.json<ProfileResponse>().id).toBe(second.id);

    const beforeAnyProfile = await asAdmin(
      'GET',
      `${P}/sections/${SECTION_ROOFING}/effective-profile?at=2025-12-31`,
    );
    expect(beforeAnyProfile.statusCode).toBe(404);
  });

  it('черновик версии не участвует в выборе действующего профиля', async () => {
    const draft = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_ROOFING,
      effectiveFrom: '2026-03-01',
      expectedDocTypes: ['unknown_document'],
      publish: false,
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json<ProfileResponse>()).toMatchObject({ version: 3, publishedAt: null });

    // Черновик перекрывает 15 марта по периоду, но прогон обязан по-прежнему
    // получить версию 1: неопубликованная настройка не меняет результат проверки.
    const past = await asAdmin(
      'GET',
      `${P}/sections/${SECTION_ROOFING}/effective-profile?at=2026-03-15`,
    );
    expect(past.json<ProfileResponse>().id).toBe(first.id);
  });

  it('повторная публикация той же версии — 409', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles/${first.id}/publish`);
    expect(response.statusCode).toBe(409);

    // `published_at` прежней версии не поехал вперёд: по ней уже есть прогоны.
    const listed = await asAdmin('GET', `${P}/section-profiles?sectionCode=${SECTION_ROOFING}`);
    const previous = listed.json<ProfileResponse[]>().find((profile) => profile.id === first.id);
    expect(previous?.publishedAt).toBe(first.publishedAt);
  });

  it('черновик публикуется отдельным действием и получает автора', async () => {
    const created = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_RC,
      effectiveFrom: '2026-02-01',
      publish: false,
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<ProfileResponse>();
    expect(draft.publishedAt).toBeNull();

    // До публикации раздел не имеет действующего профиля, и это законное
    // состояние открытого мира: правила полноты обязаны отличать его от
    // «комплект неполон» (§9.1), поэтому 404, а не пустой профиль.
    const missing = await asAdmin(
      'GET',
      `${P}/sections/${SECTION_RC}/effective-profile?at=2026-03-01`,
    );
    expect(missing.statusCode).toBe(404);

    const published = await asAdmin('POST', `${P}/section-profiles/${draft.id}/publish`);
    expect(published.statusCode).toBe(200);
    expect(published.json<ProfileResponse>()).toMatchObject({ publishedBy: USER_ADMIN });
    expect(published.json<ProfileResponse>().publishedAt).not.toBeNull();

    const effective = await asAdmin(
      'GET',
      `${P}/sections/${SECTION_RC}/effective-profile?at=2026-03-01`,
    );
    expect(effective.json<ProfileResponse>().id).toBe(draft.id);
  });

  it('период с концом раньше начала отвергается схемой', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionCode: SECTION_RC,
      effectiveFrom: '2026-05-01',
      effectiveTo: '2026-04-01',
    });
    expect(response.statusCode).toBe(422);
  });
});

// =====================================================================
// Каталог видов ИД и наложения
// =====================================================================

interface DocTypeResponse {
  code: string;
  name: string;
  shortName: string;
  groupCode: string;
  kind: string;
  isSystem: boolean;
  isFallback: boolean;
  isActive: boolean;
  hasOverride: boolean;
  sortOrder: number;
}

async function seedName(code: string): Promise<string | undefined> {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM doc_types WHERE code = '${code}'`,
  );
  return rows[0]?.name;
}

describe('виды ИД: наложение переопределяет выдачу, но не строку поставки', () => {
  const OVERRIDDEN_NAME = 'АОСР (локальное наименование объекта)';

  it('системный тип читается из seed без наложения', async () => {
    const response = await asAdmin('GET', `${P}/doc-types/${DOC_TYPE_SYSTEM}`);
    expect(response.statusCode).toBe(200);
    expect(response.json<DocTypeResponse>()).toMatchObject({
      code: DOC_TYPE_SYSTEM,
      name: DOC_TYPE_SYSTEM_NAME,
      shortName: 'АОСР',
      groupCode: 'acts',
      kind: 'primary',
      isSystem: true,
      isFallback: false,
      isActive: true,
      hasOverride: false,
    });
  });

  it('переопределённое имя возвращается вместо системного', async () => {
    const patched = await asAdmin('PATCH', `${P}/doc-types/${DOC_TYPE_SYSTEM}`, {
      name: OVERRIDDEN_NAME,
      sortOrder: 5,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<DocTypeResponse>()).toMatchObject({
      name: OVERRIDDEN_NAME,
      sortOrder: 5,
      hasOverride: true,
      // Поля, которых наложение не касается, остаются от поставки.
      shortName: 'АОСР',
      isSystem: true,
    });

    const listed = await as(KC.engineer, 'GET', `${P}/doc-types`);
    const inList = listed.json<DocTypeResponse[]>().find((t) => t.code === DOC_TYPE_SYSTEM);
    expect(inList?.name).toBe(OVERRIDDEN_NAME);
    expect(inList?.hasOverride).toBe(true);
  });

  it('строка каталога в БД не затёрта: правится doc_type_overrides', async () => {
    // Ключевая проверка. Если бы PATCH писал в `doc_types`, следующий прогон
    // seed-миграции вернул бы системное имя и настройка администратора исчезла
    // бы без следа — а ответ API при этом выглядел бы точно так же.
    expect(await seedName(DOC_TYPE_SYSTEM)).toBe(DOC_TYPE_SYSTEM_NAME);

    const overrides = await db.query<{ name: string | null; sort_order: number | null }>(
      `SELECT name, sort_order FROM doc_type_overrides WHERE doc_type_code = '${DOC_TYPE_SYSTEM}'`,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.name).toBe(OVERRIDDEN_NAME);
  });

  it('отключение наложением убирает тип из выдачи, но не из каталога', async () => {
    const disabled = await asAdmin('PATCH', `${P}/doc-types/${DOC_TYPE_SYSTEM}`, {
      isActive: false,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<DocTypeResponse>().isActive).toBe(false);

    const active = await asAdmin('GET', `${P}/doc-types`);
    expect(active.json<DocTypeResponse[]>().map((t) => t.code)).not.toContain(DOC_TYPE_SYSTEM);

    const all = await asAdmin('GET', `${P}/doc-types?includeInactive=true`);
    const found = all.json<DocTypeResponse[]>().find((t) => t.code === DOC_TYPE_SYSTEM);
    expect(found).toMatchObject({ isActive: false, hasOverride: true });

    // Строка каталога на месте: отключение — настройка, а не удаление типа.
    expect(await seedName(DOC_TYPE_SYSTEM)).toBe(DOC_TYPE_SYSTEM_NAME);
  });

  it('снятие наложения возвращает поставляемые значения', async () => {
    const cleared = await asAdmin('DELETE', `${P}/doc-types/${DOC_TYPE_SYSTEM}/override`);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<DocTypeResponse>()).toMatchObject({
      name: DOC_TYPE_SYSTEM_NAME,
      isActive: true,
      hasOverride: false,
    });

    const overrides = await db.query(
      `SELECT 1 FROM doc_type_overrides WHERE doc_type_code = '${DOC_TYPE_SYSTEM}'`,
    );
    expect(overrides).toHaveLength(0);
  });

  it('фильтры по группе и роли в комплекте работают', async () => {
    const acts = await asAdmin('GET', `${P}/doc-types?groupCode=acts&kind=primary`);
    expect(acts.statusCode).toBe(200);
    const codes = acts.json<DocTypeResponse[]>().map((t) => t.code);
    expect(codes).toContain(DOC_TYPE_SYSTEM);
    expect(acts.json<DocTypeResponse[]>().every((t) => t.groupCode === 'acts')).toBe(true);
    expect(acts.json<DocTypeResponse[]>().every((t) => t.kind === 'primary')).toBe(true);
  });

  it('пустая правка и неизвестный код различаются: 422 и 404', async () => {
    expect((await asAdmin('PATCH', `${P}/doc-types/${DOC_TYPE_SYSTEM}`, {})).statusCode).toBe(422);
    expect((await asAdmin('PATCH', `${P}/doc-types/no_such_type`, { name: 'x' })).statusCode).toBe(
      404,
    );
    expect((await asAdmin('GET', `${P}/doc-types/no_such_type`)).statusCode).toBe(404);
  });

  it('заведённый администратором тип не системный и не резервный', async () => {
    const created = await asAdmin('POST', `${P}/doc-types`, {
      code: 'act_roof_membrane',
      name: 'Акт освидетельствования кровельной мембраны',
      shortName: 'Акт мембраны',
      groupCode: 'acts',
      kind: 'evidence',
      sortOrder: 95,
    });
    expect(created.statusCode).toBe(201);
    // `isSystem`/`isFallback` клиентом не задаются: иначе резервным можно было бы
    // объявить любой тип и увести под него все неопознанные документы.
    expect(created.json<DocTypeResponse>()).toMatchObject({
      isSystem: false,
      isFallback: false,
      isActive: true,
      hasOverride: false,
    });

    const duplicate = await asAdmin('POST', `${P}/doc-types`, {
      code: 'act_roof_membrane',
      name: 'Повтор кода',
      shortName: 'Повтор',
      groupCode: 'acts',
      kind: 'evidence',
    });
    expect(duplicate.statusCode).toBe(409);
  });
});

// =====================================================================
// Кандидаты в виды ИД
// =====================================================================

interface CandidateResponse {
  id: string;
  observedTitleNorm: string;
  observedTitleSample: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: string;
  mappedDocTypeCode: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

async function candidateCount(): Promise<string | undefined> {
  const rows = await db.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM doc_type_candidates',
  );
  return rows[0]?.total;
}

describe('кандидаты в виды ИД: очередь по частоте, закрытие без удаления', () => {
  it('очередь отдаёт частоту и пример заголовка, самые частые первыми', async () => {
    const response = await asAdmin('GET', `${P}/doc-type-candidates?limit=50`);
    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: CandidateResponse[] }>().items;

    // Сортировка по частоте — не украшение: администратор обязан начинать с
    // «встречено 14 документов», а не с единичного артефакта OCR.
    expect(items.map((item) => item.occurrences)).toEqual([14, 5, 1]);
    expect(items[0]).toMatchObject({
      id: CANDIDATE_FREQUENT,
      occurrences: 14,
      observedTitleNorm: 'акт приемки узла учета',
      observedTitleSample: 'АКТ приёмки узла учёта тепловой энергии',
      status: 'new',
      mappedDocTypeCode: null,
      reviewedBy: null,
      reviewedAt: null,
    });
    // Метки времени именно метками времени, а не «Invalid Date»: они собираются
    // в SQL, поэтому не зависят ни от драйвера, ни от зоны процесса.
    expect(Number.isNaN(Date.parse(items[0]?.firstSeenAt ?? ''))).toBe(false);
    expect(items[0]?.lastSeenAt.endsWith('Z')).toBe(true);
  });

  it('очередь листается курсором без пропусков и повторов', async () => {
    const first = await asAdmin('GET', `${P}/doc-type-candidates?limit=2`);
    const firstPage = first.json<{ items: CandidateResponse[]; nextCursor: string | null }>();
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const next = await asAdmin(
      'GET',
      `${P}/doc-type-candidates?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    );
    const secondPage = next.json<{ items: CandidateResponse[]; nextCursor: string | null }>();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const seen = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('сопоставление с существующим типом ЗАКРЫВАЕТ запись, а не удаляет её', async () => {
    const before = await candidateCount();

    const mapped = await asAdmin('POST', `${P}/doc-type-candidates/${CANDIDATE_MID}/map`, {
      docTypeCode: DOC_TYPE_SYSTEM,
    });
    expect(mapped.statusCode).toBe(200);
    expect(mapped.json<CandidateResponse>()).toMatchObject({
      id: CANDIDATE_MID,
      status: 'mapped',
      mappedDocTypeCode: DOC_TYPE_SYSTEM,
      reviewedBy: USER_ADMIN,
    });
    expect(mapped.json<CandidateResponse>().reviewedAt).not.toBeNull();

    // Записей столько же: удаление стёрло бы решение администратора, и тот же
    // заголовок вернулся бы в очередь при следующей поставке.
    expect(await candidateCount()).toBe(before);

    const read = await asAdmin('GET', `${P}/doc-type-candidates/${CANDIDATE_MID}`);
    expect(read.statusCode).toBe(200);
    expect(read.json<CandidateResponse>().status).toBe('mapped');

    // Из рабочей очереди запись ушла: фильтр по статусу её больше не отдаёт.
    const queue = await asAdmin('GET', `${P}/doc-type-candidates?status=new&limit=50`);
    const ids = queue.json<{ items: CandidateResponse[] }>().items.map((item) => item.id);
    expect(ids).not.toContain(CANDIDATE_MID);
    expect(ids).toContain(CANDIDATE_FREQUENT);
  });

  it('сопоставление с несуществующим типом — 422, а не 500', async () => {
    const response = await asAdmin('POST', `${P}/doc-type-candidates/${CANDIDATE_RARE}/map`, {
      docTypeCode: 'no_such_doc_type',
    });
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response)).toContain('/docTypeCode');

    const unchanged = await asAdmin('GET', `${P}/doc-type-candidates/${CANDIDATE_RARE}`);
    expect(unchanged.json<CandidateResponse>().status).toBe('new');
  });

  it('«взять в работу» и «вернуть в очередь» снимают результат разбора', async () => {
    const reviewing = await asAdmin('PATCH', `${P}/doc-type-candidates/${CANDIDATE_RARE}`, {
      status: 'reviewing',
    });
    expect(reviewing.statusCode).toBe(200);
    expect(reviewing.json<CandidateResponse>()).toMatchObject({
      status: 'reviewing',
      reviewedBy: USER_ADMIN,
    });

    const back = await asAdmin('PATCH', `${P}/doc-type-candidates/${CANDIDATE_RARE}`, {
      status: 'new',
    });
    expect(back.json<CandidateResponse>()).toMatchObject({
      status: 'new',
      reviewedBy: null,
      reviewedAt: null,
      mappedDocTypeCode: null,
    });
  });

  it('статус mapped вручную не ставится: он требует кода типа', async () => {
    // CHECK `doc_type_candidates_mapped_chk` требует при `mapped` непустой
    // `mapped_doc_type_code`, поэтому этот статус — результат действия, а не
    // значение поля.
    const response = await asAdmin('PATCH', `${P}/doc-type-candidates/${CANDIDATE_RARE}`, {
      status: 'mapped',
    });
    expect(response.statusCode).toBe(422);
  });

  it('«завести тип» создаёт вид ИД и закрывает кандидата одной операцией', async () => {
    const before = await candidateCount();

    const response = await asAdmin(
      'POST',
      `${P}/doc-type-candidates/${CANDIDATE_FREQUENT}/doc-type`,
      {
        code: 'act_metering_unit',
        name: 'Акт приёмки узла учёта тепловой энергии',
        shortName: 'Акт узла учёта',
        groupCode: 'networks',
        kind: 'evidence',
        sortOrder: 530,
      },
    );
    expect(response.statusCode).toBe(201);

    const body = response.json<{ docType: DocTypeResponse; candidate: CandidateResponse }>();
    expect(body.docType).toMatchObject({
      code: 'act_metering_unit',
      isSystem: false,
      isFallback: false,
      hasOverride: false,
    });
    expect(body.candidate).toMatchObject({
      id: CANDIDATE_FREQUENT,
      status: 'mapped',
      mappedDocTypeCode: 'act_metering_unit',
      reviewedBy: USER_ADMIN,
      // Наблюдённая частота сохраняется: она обоснование решения.
      occurrences: 14,
    });

    expect(await candidateCount()).toBe(before);
    expect((await asAdmin('GET', `${P}/doc-types/act_metering_unit`)).statusCode).toBe(200);
    expect(
      (await as(KC.engineer, 'GET', `${P}/doc-types`)).json<DocTypeResponse[]>().map((t) => t.code),
    ).toContain('act_metering_unit');
  });

  it('неизвестный кандидат — 404', async () => {
    expect((await asAdmin('GET', `${P}/doc-type-candidates/${id(903)}`)).statusCode).toBe(404);
    expect(
      (
        await asAdmin('POST', `${P}/doc-type-candidates/${id(903)}/map`, {
          docTypeCode: DOC_TYPE_SYSTEM,
        })
      ).statusCode,
    ).toBe(404);
  });
});

// =====================================================================
// Виды контрагентов и удаление карточек справочника (0027)
// =====================================================================

describe('виды контрагентов — справочник, а не перечисление', () => {
  interface KindResponse {
    readonly code: string;
    readonly name: string;
    readonly sortOrder: number;
    readonly isActive: boolean;
  }

  it('сид миграции содержит виды, которых не было в снятом CHECK', async () => {
    const response = await as(KC.engineer, 'GET', `${P}/counterparty-kinds`);
    expect(response.statusCode).toBe(200);

    const codes = response.json<KindResponse[]>().map((k) => k.code);
    // Четыре прежних значения перечисления обязаны сохраниться: на них
    // ссылаются заведённые карточки.
    expect(codes).toEqual(
      expect.arrayContaining(['customer', 'general_contractor', 'contractor', 'supplier']),
    );
    // И новые, ради которых справочник заведён (реестр ИД называет их все).
    expect(codes).toEqual(
      expect.arrayContaining(['laboratory', 'certification_body', 'metrology', 'manufacturer']),
    );
  });

  it('подрядчик читает виды: это конфигурация, а не сведения об участниках', async () => {
    expect((await as(KC.contractor, 'GET', `${P}/counterparty-kinds`)).statusCode).toBe(200);
  });

  it('заводит вид только администратор, и карточка сразу его принимает', async () => {
    const denied = await as(KC.engineer, 'POST', `${P}/counterparty-kinds`, {
      code: 'expert_organization',
      name: 'Экспертная организация',
    });
    expect(denied.statusCode).toBe(403);

    const created = await asAdmin('POST', `${P}/counterparty-kinds`, {
      code: 'expert_organization',
      name: 'Экспертная организация',
      sortOrder: 120,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<KindResponse>()).toMatchObject({
      code: 'expert_organization',
      isActive: true,
      sortOrder: 120,
    });

    // Главное следствие: новый вид доступен карточке БЕЗ миграции.
    const card = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Экспертиза»',
      kind: 'expert_organization',
    });
    expect(card.statusCode).toBe(201);
  });

  it('повтор кода — 409, неизвестный вид в карточке — 422 с указателем', async () => {
    const duplicate = await asAdmin('POST', `${P}/counterparty-kinds`, {
      code: 'contractor',
      name: 'Ещё подрядчик',
    });
    expect(duplicate.statusCode).toBe(409);

    const unknown = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Неизвестный вид»',
      kind: 'no_such_kind',
    });
    expect(unknown.statusCode).toBe(422);
    expect(pointersOf(unknown)).toContain('/kind');
  });
});

describe('реквизиты объекта из шапки реестра', () => {
  interface ObjectResponse {
    readonly id: string;
    readonly cadastralNumber: string | null;
    readonly permitIdentifier: string | null;
  }

  it('кадастровый номер и идентификатор заводятся и правятся', async () => {
    const created = await asAdmin('POST', `${P}/objects`, {
      code: 'CAD01',
      name: 'Объект с реквизитами',
      fullName: 'ЖК «Реквизиты», корпус 1',
      cadastralNumber: '77:07:0010004:24',
      permitIdentifier: '90-128/КЛ-23',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<ObjectResponse>()).toMatchObject({
      cadastralNumber: '77:07:0010004:24',
      permitIdentifier: '90-128/КЛ-23',
    });

    const objectId = created.json<ObjectResponse>().id;
    const patched = await asAdmin('PATCH', `${P}/objects/${objectId}`, {
      cadastralNumber: '77:07:0010004:24, 77:07:0010004:31',
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<ObjectResponse>().cadastralNumber).toContain('77:07:0010004:31');
  });
});

describe('удаление карточки справочника', () => {
  /**
   * Проверяется не только код ответа, но и ПРИЧИНА отказа в тексте: «нельзя»
   * без указания, что именно мешает, отправляет администратора искать ссылку
   * вручную по всей схеме — ровно то, ради чего ссылки пересчитываются заранее.
   */
  it('объект с разделами не удаляется, а отказ называет помеху', async () => {
    const response = await asAdmin('DELETE', `${P}/objects/${OBJECT}`);
    expect(response.statusCode).toBe(409);
    expect(detailOf(response)).toContain('разделы работ');
    expect(detailOf(response)).toContain('отключением');

    // Объект на месте: отказ ничего не удалил частично.
    expect((await asAdmin('GET', `${P}/objects/${OBJECT}`)).statusCode).toBe(200);
  });

  it('контрагент, назначенный пользователю, не удаляется', async () => {
    const response = await asAdmin('DELETE', `${P}/counterparties/${ORG_CONTRACTOR}`);
    expect(response.statusCode).toBe(409);
    expect(detailOf(response)).toContain('пользователи портала');
  });

  it('несвязанная карточка удаляется, повтор — 404', async () => {
    const created = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Ошибка ввода»',
      kind: 'supplier',
    });
    expect(created.statusCode).toBe(201);
    const id_ = created.json<{ id: string }>().id;

    expect((await asAdmin('DELETE', `${P}/counterparties/${id_}`)).statusCode).toBe(204);
    expect((await asAdmin('GET', `${P}/counterparties/${id_}`)).statusCode).toBe(404);
    expect((await asAdmin('DELETE', `${P}/counterparties/${id_}`)).statusCode).toBe(404);
  });

  it('удаляет только администратор', async () => {
    expect(
      (await as(KC.manager, 'DELETE', `${P}/counterparties/${ORG_DEVELOPER}`)).statusCode,
    ).toBe(403);
  });
});
