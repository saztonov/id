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
 * 3. **Новый вид раздела стартует в `assisted`** (§0.5, п.5) — и отказ приходит
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

/** Вид раздела из корпуса; профили версионируются именно по нему. */
const KIND_ROOFING = 'roofing';
const KIND_RC = 'rc_structures';

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

  `INSERT INTO section_kinds (code, name) VALUES ('${KIND_ROOFING}', 'Кровля автостоянки')`,
  `INSERT INTO section_kinds (code, name)
     VALUES ('${KIND_RC}', 'Несущие ЖБ конструкции надземной части')`,

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

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

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
    ['GET', `${P}/counterparties`],
    ['GET', `${P}/counterparties/:counterpartyId`],
    ['POST', `${P}/counterparties`],
    ['PATCH', `${P}/counterparties/:counterpartyId`],
    ['GET', `${P}/objects/:objectId/sections`],
    ['POST', `${P}/objects/:objectId/sections`],
    ['PATCH', `${P}/sections/:sectionId`],
    ['GET', `${P}/section-kinds`],
    ['POST', `${P}/section-kinds`],
    ['GET', `${P}/section-kinds/:kindCode/effective-profile`],
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
      url: `${P}/section-kinds`,
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
      expect((await as(kcSub, 'GET', `${P}/section-kinds`)).statusCode).toBe(200);
    }
  });

  it('запись в справочник от НЕ-администратора даёт 403', async () => {
    const writes: readonly (readonly [Method, string, unknown])[] = [
      ['POST', `${P}/counterparties`, { name: 'ООО «Проба»', kind: 'supplier' }],
      ['POST', `${P}/objects`, { code: 'DENY1', name: 'Проба', fullName: 'Проба' }],
      ['POST', `${P}/section-kinds`, { code: 'denied_kind', name: 'Проба' }],
      ['POST', `${P}/section-profiles`, { sectionKindCode: KIND_RC, effectiveFrom: '2026-01-01' }],
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

  it('инженер без назначенных объектов не видит и справочников', async () => {
    // §1.6: пустая область видимости означает «ничего», а не «всё». Решение
    // принимает `isEmptyScope()`, а не собственная проверка роли в репозитории.
    const types = await as(KC.engineerBlank, 'GET', `${P}/doc-types`);
    expect(types.statusCode).toBe(200);
    expect(types.json<unknown[]>()).toEqual([]);

    const objects = await as(KC.engineerBlank, 'GET', `${P}/objects`);
    expect(objects.json<{ items: unknown[] }>().items).toEqual([]);

    expect(
      (await as(KC.engineerBlank, 'GET', `${P}/doc-types/${DOC_TYPE_SYSTEM}`)).statusCode,
    ).toBe(404);
  });
});

// =====================================================================
// Объекты строительства: код ровно пять символов
// =====================================================================

describe('объект строительства: код — ровно пять символов', () => {
  it('код из 4 и из 6 символов отвергается с 422, из 5 — принимается', async () => {
    const four = await asAdmin('POST', `${P}/objects`, {
      code: 'TST1',
      name: 'Объект с коротким кодом',
      fullName: 'Объект с коротким кодом',
    });
    expect(four.statusCode).toBe(422);
    expect(pointersOf(four)).toContain('/code');

    const six = await asAdmin('POST', `${P}/objects`, {
      code: 'TST123',
      name: 'Объект с длинным кодом',
      fullName: 'Объект с длинным кодом',
    });
    expect(six.statusCode).toBe(422);
    expect(pointersOf(six)).toContain('/code');

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

    // Ни одна из отвергнутых форм в базу не попала: 422 — это отказ на входе, а
    // не «вставилось и откатилось».
    const rows = await db.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM construction_objects WHERE code IN ('TST1', 'TST123')`,
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('код с недопустимыми символами и повторный код различаются по статусу', async () => {
    const cyrillic = await asAdmin('POST', `${P}/objects`, {
      code: 'ТЕСТ1',
      name: 'Объект',
      fullName: 'Объект',
    });
    expect(cyrillic.statusCode).toBe(422);

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
  it('раздел создаётся с видом раздела из справочника', async () => {
    const created = await asAdmin('POST', `${P}/objects/${OBJECT}/sections`, {
      code: '2.5.1',
      name: 'Кровля автостоянки',
      sectionKindCode: KIND_ROOFING,
      sortOrder: 10,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ sectionKindCode: string; objectId: string }>()).toMatchObject({
      sectionKindCode: KIND_ROOFING,
      objectId: OBJECT,
    });

    const listed = await as(KC.engineer, 'GET', `${P}/objects/${OBJECT}/sections`);
    expect(listed.json<{ code: string }[]>().map((section) => section.code)).toEqual(['2.5.1']);
  });

  it('неизвестный вид раздела — 422 с указанием поля; повтор кода — 409', async () => {
    const unknownKind = await asAdmin('POST', `${P}/objects/${OBJECT}/sections`, {
      code: '9.9.9',
      name: 'Раздел с неизвестным видом',
      sectionKindCode: 'no_such_kind',
    });
    expect(unknownKind.statusCode).toBe(422);
    expect(pointersOf(unknownKind)).toContain('/sectionKindCode');

    const duplicate = await asAdmin('POST', `${P}/objects/${OBJECT}/sections`, {
      code: '2.5.1',
      name: 'Дубль раздела',
      sectionKindCode: KIND_ROOFING,
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('раздел неизвестного объекта — 404, а не нарушение внешнего ключа', async () => {
    const response = await asAdmin('POST', `${P}/objects/${id(901)}/sections`, {
      code: '1.1.1',
      name: 'Раздел',
      sectionKindCode: KIND_ROOFING,
    });
    expect(response.statusCode).toBe(404);
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
  sectionKindCode: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  expectedDocTypes: string[];
  enabledRuleCodes: string[];
  autonomyLevel: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

describe('профиль вида раздела: новый раздел стартует в assisted', () => {
  let first: ProfileResponse;
  let second: ProfileResponse;

  it('создание раздела сразу в automatic отвергается', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionKindCode: KIND_ROOFING,
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
      `SELECT count(*)::text AS total FROM section_profiles WHERE section_kind_code = '${KIND_ROOFING}'`,
    );
    expect(rows[0]?.total).toBe('0');
  });

  it('первая версия публикуется в assisted', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionKindCode: KIND_ROOFING,
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
      sectionKindCode: KIND_ROOFING,
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
      sectionKindCode: KIND_ROOFING,
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
    const listed = await asAdmin('GET', `${P}/section-profiles?sectionKindCode=${KIND_ROOFING}`);
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
      `${P}/section-kinds/${KIND_ROOFING}/effective-profile?at=2026-03-15`,
    );
    expect(past.statusCode).toBe(200);
    expect(past.json<ProfileResponse>().id).toBe(first.id);
    expect(past.json<ProfileResponse>().version).toBe(1);

    const now = await asAdmin(
      'GET',
      `${P}/section-kinds/${KIND_ROOFING}/effective-profile?at=2026-08-01`,
    );
    expect(now.json<ProfileResponse>().id).toBe(second.id);

    const beforeAnyProfile = await asAdmin(
      'GET',
      `${P}/section-kinds/${KIND_ROOFING}/effective-profile?at=2025-12-31`,
    );
    expect(beforeAnyProfile.statusCode).toBe(404);
  });

  it('черновик версии не участвует в выборе действующего профиля', async () => {
    const draft = await asAdmin('POST', `${P}/section-profiles`, {
      sectionKindCode: KIND_ROOFING,
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
      `${P}/section-kinds/${KIND_ROOFING}/effective-profile?at=2026-03-15`,
    );
    expect(past.json<ProfileResponse>().id).toBe(first.id);
  });

  it('повторная публикация той же версии — 409', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles/${first.id}/publish`);
    expect(response.statusCode).toBe(409);

    // `published_at` прежней версии не поехал вперёд: по ней уже есть прогоны.
    const listed = await asAdmin('GET', `${P}/section-profiles?sectionKindCode=${KIND_ROOFING}`);
    const previous = listed.json<ProfileResponse[]>().find((profile) => profile.id === first.id);
    expect(previous?.publishedAt).toBe(first.publishedAt);
  });

  it('черновик публикуется отдельным действием и получает автора', async () => {
    const created = await asAdmin('POST', `${P}/section-profiles`, {
      sectionKindCode: KIND_RC,
      effectiveFrom: '2026-02-01',
      publish: false,
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<ProfileResponse>();
    expect(draft.publishedAt).toBeNull();

    // До публикации вид раздела не имеет действующего профиля, и это законное
    // состояние открытого мира: правила полноты обязаны отличать его от
    // «комплект неполон» (§9.1), поэтому 404, а не пустой профиль.
    const missing = await asAdmin(
      'GET',
      `${P}/section-kinds/${KIND_RC}/effective-profile?at=2026-03-01`,
    );
    expect(missing.statusCode).toBe(404);

    const published = await asAdmin('POST', `${P}/section-profiles/${draft.id}/publish`);
    expect(published.statusCode).toBe(200);
    expect(published.json<ProfileResponse>()).toMatchObject({ publishedBy: USER_ADMIN });
    expect(published.json<ProfileResponse>().publishedAt).not.toBeNull();

    const effective = await asAdmin(
      'GET',
      `${P}/section-kinds/${KIND_RC}/effective-profile?at=2026-03-01`,
    );
    expect(effective.json<ProfileResponse>().id).toBe(draft.id);
  });

  it('период с концом раньше начала отвергается схемой', async () => {
    const response = await asAdmin('POST', `${P}/section-profiles`, {
      sectionKindCode: KIND_RC,
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
