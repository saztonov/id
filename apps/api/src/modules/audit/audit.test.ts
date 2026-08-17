/**
 * Журнал аудита, защита резервных видов ИД и профили правил объекта — через HTTP
 * на собранном приложении.
 *
 * Три дефекта S4, найденные адверсарным прогоном, проверяются здесь ровно так, как
 * были найдены: запросом к API, а не вызовом функции репозитория.
 *
 * 1. **Правка справочников была бесследна.** Полный набор изменяющих операций не
 *    оставлял в `audit_log` ни одной строки, и вопросы «кто отключил резервный вид
 *    ИД», «кто переименовал контрагента», «кто деактивировал объект» были
 *    неотвечаемы — хотя именно эти значения формируют вердикты AOSR.HDR,
 *    AOSR.P2/P6 и REF (§9.3). Проверяется не «запись появилась», а состав: актор,
 *    объект, `request_id` и ИЗМЕНЁННЫЕ поля. Отдельно проверяется атомарность:
 *    отвергнутая базой запись следа НЕ оставляет.
 * 2. **Наложением отключался резервный вид ИД.** `PATCH
 *    /catalog/doc-types/other_acts {isActive:false}` отвечал 200, и резервных
 *    типов становилось 9 из 10. Проверяется отказ 422, сохранность всех десяти,
 *    след отклонённой попытки, и то, что запрет узок: системный НЕрезервный тип
 *    по-прежнему отключается, а имя и порядок резервного настраиваются.
 *    Отдельно — второй рубеж: тот же запрет держит триггер БД (0010).
 * 3. **`object_rule_profiles` не были реализованы вовсе.** Проверяется
 *    версионность с закрытием периода, публикация и разрешение «действующие
 *    правила для объекта и раздела на дату», включая то, что наложение объекта
 *    НЕ может поднять автоматизм (§0.5, п.5) и что «профиль раздела не настроен»
 *    остаётся отличимым от «комплект пуст» (§9.1).
 *
 * Право `audit.read` до этого этапа не имел потребителя: журнал писался и не
 * читался. Здесь проверяется и он — вместе с областью видимости по объекту и
 * курсорной пагинацией.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, type TestDatabase } from '@id/db-harness';
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

const ORG_DEVELOPER = id(201);
const ORG_CONTRACTOR = id(202);
const OBJECT_A = id(203);
const OBJECT_B = id(204);
const SECTION_ROOF = id(205);
const SECTION_PILES = id(206);
const SECTION_B_ROOF = id(207);
const PROFILE_ROOFING = id(208);

const USER_ADMIN = id(210);
const USER_ENGINEER = id(211);
/** Инженер без назначенных объектов: пустая область видимости (§1.6). */
const USER_ENGINEER_BLANK = id(212);
const USER_MANAGER = id(213);
const USER_CONTRACTOR = id(214);

const CANDIDATE_MAP = id(220);
const CANDIDATE_NEW_TYPE = id(221);

const KC = {
  admin: 'kc-audit-admin',
  engineer: 'kc-audit-engineer',
  engineerBlank: 'kc-audit-engineer-blank',
  manager: 'kc-audit-manager',
  contractor: 'kc-audit-contractor',
} as const;

const ADMIN_EMAIL = 'audit-admin@example.test';

const KIND_ROOFING = 'roofing';
/** Вид раздела БЕЗ опубликованного профиля: проверяет `n_a`, а не «комплект пуст». */
const KIND_PILES = 'piles';

/** Резервные виды ИД поставки (seed 0009): их и защищает запрет. */
const FALLBACK_ANY_ACT = 'other_acts';
const FALLBACK_UNKNOWN = 'unknown_document';
/** Системный, но НЕ резервный: он отключаться обязан. */
const SYSTEM_ACT = 'aosr';

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_DEVELOPER}', 'ООО «Застройщик аудита»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind)
     VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик аудита»', 'contractor')`,

  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'AUD01', 'Объект А', 'ЖК «Аудит», корпус 1')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_B}', 'AUD02', 'Объект Б', 'ЖК «Аудит», корпус 2')`,
  // Реестр правил заполняется сидом на S9, когда появятся реализации. До тех
  // пор публикация профиля со ссылкой на правило требует фикстуры: сверка
  // enabledRuleCodes с реестром намеренно fail-closed — опечатка в коде
  // молча выключила бы проверку (§9.1).
  `INSERT INTO rule_definitions (code, title, level, kind, default_severity)
     VALUES ('AOSR.HDR', 'Шапка акта освидетельствования', 'document', 'deterministic', 'error')`,
  `INSERT INTO rule_definitions (code, title, level, kind, default_severity)
     VALUES ('AOSR.HDR.022', 'Контрольная сумма ОГРН', 'document', 'deterministic', 'error')`,
  `INSERT INTO rule_definitions (code, title, level, kind, default_severity)
     VALUES ('DATE.312', 'Дата изготовления партии не позже применения', 'document', 'deterministic', 'error')`,
  `INSERT INTO rule_definitions (code, title, level, kind, default_severity)
     VALUES ('MAT.100', 'Пакет подтверждения материала полон', 'document', 'deterministic', 'error')`,

  `INSERT INTO section_kinds (code, name) VALUES ('${KIND_ROOFING}', 'Кровля')`,
  `INSERT INTO section_kinds (code, name) VALUES ('${KIND_PILES}', 'Свайное основание')`,

  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_ROOF}', '${OBJECT_A}', 'roof', 'Кровля корпуса 1', '${KIND_ROOFING}')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_PILES}', '${OBJECT_A}', 'piles', 'Сваи корпуса 1', '${KIND_PILES}')`,
  `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
     VALUES ('${SECTION_B_ROOF}', '${OBJECT_B}', 'roof', 'Кровля корпуса 2', '${KIND_ROOFING}')`,

  // Профиль вида раздела вставляется прямым SQL: проверяется РАЗРЕШЕНИЕ правил, а
  // не создание профиля (оно проверено в catalog.test.ts). Уровень `automatic`
  // взят намеренно — на нём видно, что наложение объекта умеет только понижать.
  `INSERT INTO section_profiles
     (id, section_kind_code, version, effective_from, expected_doc_types,
      material_categories, material_matrix, enabled_rule_codes, thresholds,
      autonomy_level, published_at)
     VALUES ('${PROFILE_ROOFING}', '${KIND_ROOFING}', 1, '2026-01-01',
             '{aosr,cert_conformity}', '{roll_waterproofing}',
             '{"roll_waterproofing": {"documents": ["cert_conformity"]}}'::jsonb,
             '{AOSR.HDR,DATE.312,MAT.100}',
             '{"ageDays": 28, "minStrengthPct": 100}'::jsonb,
             'automatic', now())`,

  `INSERT INTO users (id, kc_sub, full_name, email)
     VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор', '${ADMIN_EMAIL}')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер объекта А')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_BLANK}', '${KC.engineerBlank}', 'Инженер без объектов')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_CONTRACTOR}', '${KC.contractor}', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,

  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_BLANK}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
  `INSERT INTO user_object_scopes (user_id, object_id)
     VALUES ('${USER_ENGINEER}', '${OBJECT_A}')`,

  `INSERT INTO doc_type_candidates (id, observed_title_norm, observed_title_sample, occurrences)
     VALUES ('${CANDIDATE_MAP}', 'акт приемки узла учета', 'АКТ приёмки узла учёта', 7)`,
  `INSERT INTO doc_type_candidates (id, observed_title_norm, observed_title_sample, occurrences)
     VALUES ('${CANDIDATE_NEW_TYPE}', 'ведомость закладных', 'ВЕДОМОСТЬ закладных деталей', 3)`,
];

// =====================================================================
// Приложение поверх pglite
// =====================================================================

interface QueryConfig {
  readonly text: string;
  readonly rowMode?: 'array' | undefined;
}

interface QueryOutcome {
  rows: unknown[];
  rowCount: number;
}

const SELECT_STATEMENT = /^\s*select\b/i;
const WRITE_STATEMENT = /^\s*(insert|update|delete)\b/i;

/**
 * Позиционная строка из pglite (разбор — в `catalog.test.ts`).
 *
 * Коротко: Drizzle просит `rowMode: 'array'` и сопоставляет значения ПОЗИЦИОННО,
 * а pglite отдаёт объекты, теряя одноимённые колонки (`to_char`, `coalesce`).
 * PostgreSQL собирает строку в JSON-массив по порядку столбцов сам.
 */
function positionalQuery(text: string): string {
  const cells = `(select json_agg(cell.value order by cell.ord)
       from json_each(row_to_json(drizzle_row)) with ordinality as cell(key, value, ord)) as cells`;

  if (SELECT_STATEMENT.test(text)) {
    return `select ${cells} from (${text}) as drizzle_row`;
  }
  if (WRITE_STATEMENT.test(text)) {
    return `with drizzle_row as (${text}) select ${cells} from drizzle_row`;
  }
  throw new Error(`Позиционная выборка не поддержана для оператора: ${text.slice(0, 40)}`);
}

class PglitePool {
  readonly #db: TestDatabase;

  constructor(db: TestDatabase) {
    this.#db = db;
  }

  async query(source: string | QueryConfig, values?: unknown[]): Promise<QueryOutcome> {
    if (typeof source === 'string') {
      const raw = await this.#db.query<Record<string, unknown>>(source, values);
      return { rows: raw, rowCount: raw.length };
    }

    if (source.rowMode === 'array') {
      const rows = await this.#db.query<{ cells: unknown[] | null }>(
        positionalQuery(source.text),
        values,
      );
      return { rows: rows.map((row) => row.cells ?? []), rowCount: rows.length };
    }

    const rows = await this.#db.query<Record<string, unknown>>(source.text, values);
    return { rows: rows.map((row) => normalizeRow(row)), rowCount: rows.length };
  }

  connect(): Promise<{
    query: (source: string | QueryConfig, values?: unknown[]) => Promise<QueryOutcome>;
    release: () => void;
  }> {
    return Promise.resolve({ query: this.query.bind(this), release: () => undefined });
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-audit-tests-01234567890',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: '.tmp/audit-tests',
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-audit-tests',
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

  app = await buildApp({ env: TEST_ENV, pool: new PglitePool(db) as unknown as Pool });
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

async function signIn(kcSub: string, email?: string): Promise<SignedIn> {
  const query = new URLSearchParams({ devSub: kcSub });
  if (email !== undefined) query.set('devEmail', email);

  const started = await app.inject({ method: 'GET', url: `/auth/login?${query.toString()}` });
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
  const fresh = await signIn(kcSub, kcSub === KC.admin ? ADMIN_EMAIL : undefined);
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

function pointersOf(response: LightMyRequestResponse): readonly (string | null)[] {
  return (
    response.json<{ errors?: { pointer: string | null }[] }>().errors?.map((e) => e.pointer) ?? []
  );
}

interface AuditRow {
  action: string;
  entity_type: string;
  entity_id: string | null;
  object_id: string | null;
  actor_user_id: string | null;
  actor_email_hmac: string | null;
  payload: Record<string, unknown>;
  request_id: string | null;
}

async function auditRows(action?: string): Promise<readonly AuditRow[]> {
  return db.query<AuditRow>(
    action === undefined
      ? `SELECT action, entity_type, entity_id, object_id, actor_user_id, actor_email_hmac,
                payload, request_id
           FROM audit_log ORDER BY id`
      : `SELECT action, entity_type, entity_id, object_id, actor_user_id, actor_email_hmac,
                payload, request_id
           FROM audit_log WHERE action = '${action}' ORDER BY id`,
  );
}

const P = '/api/v1/catalog';
const AUDIT = '/api/v1/audit/entries';

interface DocTypeResponse {
  code: string;
  name: string;
  isActive: boolean;
  isFallback: boolean;
  isSystem: boolean;
  sortOrder: number;
  hasOverride: boolean;
}

interface RuleProfileResponse {
  id: string;
  objectId: string;
  sectionId: string | null;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  overrides: Record<string, unknown>;
  publishedAt: string | null;
}

interface ResolvedRulesResponse {
  sectionKindCode: string;
  sectionProfileId: string | null;
  objectProfileIds: string[];
  expectedDocTypes: string[];
  materialCategories: string[];
  materialMatrix: Record<string, unknown>;
  enabledRuleCodes: string[];
  thresholds: Record<string, unknown>;
  autonomyLevel: string;
  relevantDateBasis: string;
  completenessConfigured: boolean;
}

interface AuditEntryResponse {
  id: number;
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  objectId: string | null;
  actorUserId: string | null;
  payload: Record<string, unknown>;
}

// =====================================================================
// Дефект 1: правка справочников бесследна
// =====================================================================

/** Заполняется первым тестом и переиспользуется дальше. */
let createdCounterpartyId = '';
let createdObjectId = '';

describe('след правок справочников в audit_log', () => {
  it('каждая изменяющая операция справочников оставила запись', async () => {
    const counterparty = await asAdmin('POST', `${P}/counterparties`, {
      name: 'ООО «Поставщик»',
      kind: 'supplier',
    });
    expect(counterparty.statusCode).toBe(201);
    createdCounterpartyId = counterparty.json<{ id: string }>().id;

    expect(
      (
        await asAdmin('PATCH', `${P}/counterparties/${createdCounterpartyId}`, {
          name: 'ООО «Поставщик-2»',
        })
      ).statusCode,
    ).toBe(200);

    const object = await asAdmin('POST', `${P}/objects`, {
      code: 'AUD03',
      name: 'Объект В',
      fullName: 'ЖК «Аудит», корпус 3',
    });
    expect(object.statusCode).toBe(201);
    createdObjectId = object.json<{ id: string }>().id;

    expect(
      (await asAdmin('PATCH', `${P}/objects/${createdObjectId}`, { isActive: false })).statusCode,
    ).toBe(200);

    const section = await asAdmin('POST', `${P}/objects/${OBJECT_A}/sections`, {
      code: 'facade',
      name: 'Фасад корпуса 1',
      sectionKindCode: KIND_ROOFING,
    });
    expect(section.statusCode).toBe(201);
    const sectionId = section.json<{ id: string }>().id;

    expect(
      (await asAdmin('PATCH', `${P}/sections/${sectionId}`, { name: 'Фасад, 1 этап' })).statusCode,
    ).toBe(200);

    expect(
      (await asAdmin('POST', `${P}/section-kinds`, { code: 'audit_kind', name: 'Вид для аудита' }))
        .statusCode,
    ).toBe(201);

    const profile = await asAdmin('POST', `${P}/section-profiles`, {
      sectionKindCode: 'audit_kind',
      effectiveFrom: '2026-02-01',
    });
    expect(profile.statusCode).toBe(201);
    const profileId = profile.json<{ id: string }>().id;

    expect((await asAdmin('POST', `${P}/section-profiles/${profileId}/publish`)).statusCode).toBe(
      200,
    );

    const rd = await asAdmin('POST', `${P}/objects/${OBJECT_A}/rd-documents`, {
      cipher: '12345-АР',
    });
    expect(rd.statusCode).toBe(201);
    const rdId = rd.json<{ id: string }>().id;

    expect(
      (await asAdmin('PATCH', `${P}/rd-documents/${rdId}`, { revision: '2' })).statusCode,
    ).toBe(200);

    expect(
      (
        await asAdmin('POST', `${P}/doc-types`, {
          code: 'audit_act',
          name: 'Акт для аудита',
          shortName: 'Акт аудита',
          groupCode: 'acts',
          kind: 'evidence',
        })
      ).statusCode,
    ).toBe(201);

    expect(
      (await asAdmin('PATCH', `${P}/doc-types/audit_act`, { name: 'Акт для аудита (правка)' }))
        .statusCode,
    ).toBe(200);

    expect((await asAdmin('DELETE', `${P}/doc-types/audit_act/override`)).statusCode).toBe(200);

    expect(
      (await asAdmin('PATCH', `${P}/doc-type-candidates/${CANDIDATE_MAP}`, { status: 'reviewing' }))
        .statusCode,
    ).toBe(200);

    expect(
      (
        await asAdmin('POST', `${P}/doc-type-candidates/${CANDIDATE_MAP}/map`, {
          docTypeCode: SYSTEM_ACT,
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await asAdmin('POST', `${P}/doc-type-candidates/${CANDIDATE_NEW_TYPE}/doc-type`, {
          code: 'audit_embedded_parts',
          name: 'Ведомость закладных деталей',
          shortName: 'Ведомость закладных',
          groupCode: 'acts',
          kind: 'evidence',
        })
      ).statusCode,
    ).toBe(201);

    const actions = new Set((await auditRows()).map((row) => row.action));
    for (const expected of [
      'object.created',
      'object.updated',
      'counterparty.created',
      'counterparty.updated',
      'section.created',
      'section.updated',
      'section_kind.created',
      'section_profile.created',
      'section_profile.published',
      'rd_document.created',
      'rd_document.updated',
      'doc_type.created',
      'doc_type.override_set',
      'doc_type.override_cleared',
      'doc_type_candidate.status_changed',
      'doc_type_candidate.mapped',
      'doc_type.created_from_candidate',
    ]) {
      expect({ expected, present: actions.has(expected) }).toEqual({ expected, present: true });
    }
  });

  it('запись содержит актора, отпечаток e-mail и request_id, но не сам адрес', async () => {
    const rows = await auditRows('counterparty.updated');
    const row = rows[0];

    expect(row?.actor_user_id).toBe(USER_ADMIN);
    // Отпечаток, а не адрес (§3.1): запись переживает удаление пользователя, но
    // ПДн не хранит.
    expect(row?.actor_email_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.actor_email_hmac).not.toContain(ADMIN_EMAIL);
    expect(row?.request_id).toMatch(/^[\w-]{1,64}$/);
  });

  it('payload — только изменённые поля', async () => {
    const rows = await auditRows('counterparty.updated');
    // Ни `kind`, ни `isActive` в запросе не было: журнал отвечает, ЧТО изменилось,
    // а не перечисляет всю форму.
    expect(rows[0]?.payload).toEqual({ name: 'ООО «Поставщик-2»' });
    expect(rows[0]?.entity_id).toBe(createdCounterpartyId);
    // Контрагент общий для объектов — привязки к объекту у записи нет.
    expect(rows[0]?.object_id).toBeNull();
  });

  it('правка объекта привязана к объекту: журнал отвечает «что менялось здесь»', async () => {
    const rows = await auditRows('object.updated');
    expect(rows[0]?.object_id).toBe(createdObjectId);
    expect(rows[0]?.payload).toEqual({ isActive: false });
  });

  it('след раздела и шифра РД привязан к объекту', async () => {
    expect((await auditRows('section.created'))[0]?.object_id).toBe(OBJECT_A);
    expect((await auditRows('rd_document.updated'))[0]?.object_id).toBe(OBJECT_A);
  });

  it('отвергнутая базой запись следа не оставляет: аудит и правка — одна транзакция', async () => {
    const before = (await auditRows('object.created')).length;

    // Тот же код объекта: нарушение UNIQUE `construction_objects_code_key`.
    const conflict = await asAdmin('POST', `${P}/objects`, {
      code: 'AUD03',
      name: 'Дубль',
      fullName: 'Дубль кода объекта',
    });
    expect(conflict.statusCode).toBe(409);

    expect((await auditRows('object.created')).length).toBe(before);
  });
});

// =====================================================================
// Дефект 2: наложением отключался резервный вид ИД
// =====================================================================

describe('резервные виды ИД защищены от отключения (§8.1, §16)', () => {
  async function fallbackCodes(): Promise<readonly string[]> {
    const response = await asAdmin('GET', `${P}/doc-types`);
    expect(response.statusCode).toBe(200);
    return response
      .json<DocTypeResponse[]>()
      .filter((type) => type.isFallback)
      .map((type) => type.code);
  }

  it('в поставке десять резервных типов, и все активны', async () => {
    expect((await fallbackCodes()).length).toBe(10);
  });

  it('отключение резервного типа отвергается с объяснением', async () => {
    const response = await asAdmin('PATCH', `${P}/doc-types/${FALLBACK_ANY_ACT}`, {
      isActive: false,
    });
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response)).toContain('/isActive');

    // Ни каталог, ни выдача не изменились: резервных типов по-прежнему десять.
    expect((await fallbackCodes()).length).toBe(10);
    const type = await asAdmin('GET', `${P}/doc-types/${FALLBACK_ANY_ACT}`);
    expect(type.json<DocTypeResponse>()).toMatchObject({ isActive: true, hasOverride: false });
  });

  it('unknown_document защищён так же: документу незнакомого вида есть куда деться', async () => {
    const response = await asAdmin('PATCH', `${P}/doc-types/${FALLBACK_UNKNOWN}`, {
      isActive: false,
    });
    expect(response.statusCode).toBe(422);
    expect(await fallbackCodes()).toContain(FALLBACK_UNKNOWN);
  });

  it('подсказки сопоставления резервному типу не переопределяются', async () => {
    const response = await asAdmin('PATCH', `${P}/doc-types/${FALLBACK_UNKNOWN}`, {
      matchHints: { anchors: ['ЛЮБОЙ ДОКУМЕНТ'] },
    });
    expect(response.statusCode).toBe(422);
    expect(pointersOf(response)).toContain('/matchHints');
  });

  it('отклонённая попытка оставляет след: это ошибка либо попытка', async () => {
    const rows = await auditRows('doc_type.override_rejected');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toMatchObject({
      entity_type: 'doc_type',
      entity_id: FALLBACK_ANY_ACT,
      actor_user_id: USER_ADMIN,
    });
    expect(rows[0]?.payload['rejectedFields']).toEqual(['isActive']);
    expect(rows[0]?.payload['reason']).toBe('fallback_type');
  });

  it('имя и порядок резервного типа настраиваются, снятие наложения тоже', async () => {
    const patched = await asAdmin('PATCH', `${P}/doc-types/${FALLBACK_ANY_ACT}`, {
      name: 'Иной акт (по договору)',
      sortOrder: 95,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<DocTypeResponse>()).toMatchObject({
      name: 'Иной акт (по договору)',
      sortOrder: 95,
      isActive: true,
    });

    // Снятие наложения возвращает поставляемое значение — и оно активно.
    const cleared = await asAdmin('DELETE', `${P}/doc-types/${FALLBACK_ANY_ACT}/override`);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<DocTypeResponse>()).toMatchObject({ hasOverride: false, isActive: true });
  });

  it('запрет узок: системный НЕрезервный тип отключается по-прежнему', async () => {
    const disabled = await asAdmin('PATCH', `${P}/doc-types/${SYSTEM_ACT}`, { isActive: false });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<DocTypeResponse>().isActive).toBe(false);

    expect((await asAdmin('DELETE', `${P}/doc-types/${SYSTEM_ACT}/override`)).statusCode).toBe(200);
  });

  it('второй рубеж — БД: триггер 0010 отвергает запись в обход API', async () => {
    // Прямая запись в `doc_type_overrides`: так выглядит рука в psql, миграция
    // данных или будущий воркер. Инвариант открытого мира обязан держаться и здесь.
    await expect(
      db.query(
        `INSERT INTO doc_type_overrides (doc_type_code, is_active)
           VALUES ('${FALLBACK_UNKNOWN}', false)`,
      ),
    ).rejects.toThrow(/резервный/i);

    // Включение и снятие наложения триггер пропускает: они инвариант не нарушают.
    await db.query(
      `INSERT INTO doc_type_overrides (doc_type_code, is_active)
         VALUES ('${FALLBACK_UNKNOWN}', true)`,
    );
    await db.query(`DELETE FROM doc_type_overrides WHERE doc_type_code = '${FALLBACK_UNKNOWN}'`);
  });
});

// =====================================================================
// Пропущенный пункт §17: профили правил объекта
// =====================================================================

let objectWideProfileId = '';

describe('профили правил объекта и разрешение действующих правил (§9.2)', () => {
  it('без наложений действуют правила профиля вида раздела', async () => {
    const response = await asAdmin(
      'GET',
      `${P}/objects/${OBJECT_B}/sections/${SECTION_B_ROOF}/effective-rules?at=2026-06-01`,
    );
    expect(response.statusCode).toBe(200);

    const rules = response.json<ResolvedRulesResponse>();
    expect(rules).toMatchObject({
      sectionKindCode: KIND_ROOFING,
      sectionProfileId: PROFILE_ROOFING,
      objectProfileIds: [],
      expectedDocTypes: ['aosr', 'cert_conformity'],
      enabledRuleCodes: ['AOSR.HDR', 'DATE.312', 'MAT.100'],
      autonomyLevel: 'automatic',
      // Основание релевантной даты по умолчанию — дата применения (§9.2).
      relevantDateBasis: 'application',
      completenessConfigured: true,
    });
    expect(rules.thresholds).toEqual({ ageDays: 28, minStrengthPct: 100 });
  });

  it('раздел без опубликованного профиля вида даёт «не настроено», а не пустой комплект', async () => {
    const response = await asAdmin(
      'GET',
      `${P}/objects/${OBJECT_A}/sections/${SECTION_PILES}/effective-rules?at=2026-06-01`,
    );
    expect(response.statusCode).toBe(200);

    // §9.1: правила полноты обязаны дать n_a, а не «комплект неполон». Пустой
    // список сам по себе этих случаев не различает — различает признак.
    expect(response.json<ResolvedRulesResponse>()).toMatchObject({
      sectionProfileId: null,
      expectedDocTypes: [],
      completenessConfigured: false,
      autonomyLevel: 'assisted',
    });
  });

  it('наложение объекта переопределяет профиль вида раздела', async () => {
    const created = await asAdmin('POST', `${P}/objects/${OBJECT_A}/rule-profiles`, {
      effectiveFrom: '2026-01-01',
      publish: true,
      overrides: {
        expectedDocTypes: ['aosr'],
        thresholds: { ageDays: 14 },
        disabledRuleCodes: ['MAT.100'],
        relevantDateBasis: 'delivery',
        autonomyLevel: 'assisted',
      },
    });
    expect(created.statusCode).toBe(201);
    const profile = created.json<RuleProfileResponse>();
    objectWideProfileId = profile.id;
    expect(profile).toMatchObject({ version: 1, sectionId: null });
    expect(profile.publishedAt).not.toBeNull();

    const rules = (
      await asAdmin(
        'GET',
        `${P}/objects/${OBJECT_A}/sections/${SECTION_ROOF}/effective-rules?at=2026-06-01`,
      )
    ).json<ResolvedRulesResponse>();

    expect(rules).toMatchObject({
      sectionProfileId: PROFILE_ROOFING,
      objectProfileIds: [objectWideProfileId],
      // Списки заменяются целиком.
      expectedDocTypes: ['aosr'],
      // Пороги накладываются по ключам: `minStrengthPct` из профиля вида остался.
      enabledRuleCodes: ['AOSR.HDR', 'DATE.312'],
      relevantDateBasis: 'delivery',
      // Автоматизм понижен наложением объекта.
      autonomyLevel: 'assisted',
      completenessConfigured: true,
    });
    expect(rules.thresholds).toEqual({ ageDays: 14, minStrengthPct: 100 });
    // Матрица материалов не переопределялась — осталась от вида раздела.
    expect(rules.materialMatrix).toEqual({
      roll_waterproofing: { documents: ['cert_conformity'] },
    });
  });

  it('наложение раздела применяется поверх наложения объекта', async () => {
    const created = await asAdmin('POST', `${P}/objects/${OBJECT_A}/rule-profiles`, {
      sectionId: SECTION_ROOF,
      effectiveFrom: '2026-01-01',
      publish: true,
      overrides: {
        expectedDocTypes: ['aosr', 'cert_conformity', 'exec_scheme'],
        materialMatrix: { roll_waterproofing: { documents: ['cert_conformity', 'passport'] } },
      },
    });
    expect(created.statusCode).toBe(201);
    const sectionProfileId = created.json<RuleProfileResponse>().id;

    const rules = (
      await asAdmin(
        'GET',
        `${P}/objects/${OBJECT_A}/sections/${SECTION_ROOF}/effective-rules?at=2026-06-01`,
      )
    ).json<ResolvedRulesResponse>();

    expect(rules.objectProfileIds).toEqual([objectWideProfileId, sectionProfileId]);
    expect(rules.expectedDocTypes).toEqual(['aosr', 'cert_conformity', 'exec_scheme']);
    expect(rules.materialMatrix).toEqual({
      roll_waterproofing: { documents: ['cert_conformity', 'passport'] },
    });
    // Понижение автоматизма из объектного наложения не потерялось.
    expect(rules.autonomyLevel).toBe('assisted');
    // Наложение раздела не задавало порогов — остались от объекта и вида.
    expect(rules.thresholds).toEqual({ ageDays: 14, minStrengthPct: 100 });
  });

  it('наложением нельзя поднять автоматизм (§0.5, п.5)', async () => {
    const response = await asAdmin('POST', `${P}/objects/${OBJECT_A}/rule-profiles`, {
      effectiveFrom: '2026-08-01',
      overrides: { autonomyLevel: 'automatic' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('неизвестный ключ наложения — отказ, а не молчаливое бездействие', async () => {
    const response = await asAdmin('POST', `${P}/objects/${OBJECT_A}/rule-profiles`, {
      effectiveFrom: '2026-08-01',
      overrides: { expectedDocTypez: ['aosr'] },
    });
    expect(response.statusCode).toBe(422);
  });

  it('новая версия закрывает период предыдущей', async () => {
    const first = await asAdmin('POST', `${P}/objects/${OBJECT_B}/rule-profiles`, {
      effectiveFrom: '2026-01-01',
      publish: true,
      overrides: { thresholds: { ageDays: 7 } },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json<RuleProfileResponse>().version).toBe(1);

    const second = await asAdmin('POST', `${P}/objects/${OBJECT_B}/rule-profiles`, {
      effectiveFrom: '2026-07-01',
      publish: true,
      overrides: { thresholds: { ageDays: 3 } },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json<RuleProfileResponse>().version).toBe(2);

    const versions = (
      await asAdmin('GET', `${P}/objects/${OBJECT_B}/rule-profiles?objectWide=true`)
    ).json<RuleProfileResponse[]>();
    expect(versions.map((profile) => profile.version)).toEqual([2, 1]);
    expect(versions.find((profile) => profile.version === 1)?.effectiveTo).toBe('2026-06-30');

    // Прогон на прошедшую дату разрешается в прежнюю версию: иначе проверка
    // месячной давности невоспроизводима.
    const past = (
      await asAdmin(
        'GET',
        `${P}/objects/${OBJECT_B}/sections/${SECTION_B_ROOF}/effective-rules?at=2026-03-01`,
      )
    ).json<ResolvedRulesResponse>();
    expect(past.thresholds).toEqual({ ageDays: 7, minStrengthPct: 100 });

    const now = (
      await asAdmin(
        'GET',
        `${P}/objects/${OBJECT_B}/sections/${SECTION_B_ROOF}/effective-rules?at=2026-09-01`,
      )
    ).json<ResolvedRulesResponse>();
    expect(now.thresholds).toEqual({ ageDays: 3, minStrengthPct: 100 });
  });

  it('черновик в разрешение не попадает, публикация — отдельное действие', async () => {
    const draft = await asAdmin('POST', `${P}/objects/${OBJECT_B}/rule-profiles`, {
      effectiveFrom: '2026-10-01',
      overrides: { thresholds: { ageDays: 1 } },
    });
    expect(draft.statusCode).toBe(201);
    const draftId = draft.json<RuleProfileResponse>().id;
    expect(draft.json<RuleProfileResponse>().publishedAt).toBeNull();

    const beforePublish = (
      await asAdmin(
        'GET',
        `${P}/objects/${OBJECT_B}/sections/${SECTION_B_ROOF}/effective-rules?at=2026-11-01`,
      )
    ).json<ResolvedRulesResponse>();
    expect(beforePublish.thresholds).toEqual({ ageDays: 3, minStrengthPct: 100 });

    expect((await asAdmin('POST', `${P}/rule-profiles/${draftId}/publish`)).statusCode).toBe(200);

    const afterPublish = (
      await asAdmin(
        'GET',
        `${P}/objects/${OBJECT_B}/sections/${SECTION_B_ROOF}/effective-rules?at=2026-11-01`,
      )
    ).json<ResolvedRulesResponse>();
    expect(afterPublish.thresholds).toEqual({ ageDays: 1, minStrengthPct: 100 });

    // Повторная публикация — 409: `published_at` не должен ехать вперёд у профиля,
    // по которому прогоны уже выполнены.
    expect((await asAdmin('POST', `${P}/rule-profiles/${draftId}/publish`)).statusCode).toBe(409);
    expect((await asAdmin('POST', `${P}/rule-profiles/${id(999)}/publish`)).statusCode).toBe(404);
  });

  it('раздел другого объекта не настраивается и не разрешается', async () => {
    expect(
      (
        await asAdmin('POST', `${P}/objects/${OBJECT_A}/rule-profiles`, {
          sectionId: SECTION_B_ROOF,
          effectiveFrom: '2026-01-01',
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (await asAdmin('GET', `${P}/objects/${OBJECT_A}/sections/${SECTION_B_ROOF}/effective-rules`))
        .statusCode,
    ).toBe(404);
  });

  it('создание и публикация профиля правил оставили след с привязкой к объекту', async () => {
    const rows = await auditRows('object_rule_profile.published');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      entity_type: 'object_rule_profile',
      object_id: OBJECT_A,
      actor_user_id: USER_ADMIN,
    });
    expect(rows[0]?.payload['overrides']).toMatchObject({ relevantDateBasis: 'delivery' });
  });

  it('область видимости: чтение сужено объектом, запись — правом администратора', async () => {
    // Инженер объекта А профили этого объекта читает.
    expect(
      (await as(KC.engineer, 'GET', `${P}/objects/${OBJECT_A}/rule-profiles`)).statusCode,
    ).toBe(200);
    // Инженер без назначений не видит и самого объекта (§1.6).
    expect(
      (await as(KC.engineerBlank, 'GET', `${P}/objects/${OBJECT_A}/rule-profiles`)).statusCode,
    ).toBe(404);
    // Подрядчик без поставок на объекте связан с ним ничем.
    expect(
      (await as(KC.contractor, 'GET', `${P}/objects/${OBJECT_A}/rule-profiles`)).statusCode,
    ).toBe(404);

    for (const kcSub of [KC.engineer, KC.manager, KC.contractor]) {
      const response = await as(kcSub, 'POST', `${P}/objects/${OBJECT_A}/rule-profiles`, {
        effectiveFrom: '2026-01-01',
      });
      expect({ kcSub, status: response.statusCode }).toEqual({ kcSub, status: 403 });
    }
  });
});

// =====================================================================
// Право audit.read: у журнала появился читатель
// =====================================================================

describe('чтение журнала аудита', () => {
  it('без сессии — 401, без права — 403, администратору — 200', async () => {
    expect((await call('GET', AUDIT, null)).statusCode).toBe(401);
    for (const kcSub of [KC.engineer, KC.manager, KC.contractor]) {
      const response = await as(kcSub, 'GET', AUDIT);
      expect({ kcSub, status: response.statusCode }).toEqual({ kcSub, status: 403 });
    }
    expect((await asAdmin('GET', AUDIT)).statusCode).toBe(200);
  });

  it('новые записи первыми, адрес в ответе не выдаётся', async () => {
    const page = (await asAdmin('GET', `${AUDIT}?limit=5`)).json<{ items: AuditEntryResponse[] }>();
    expect(page.items.length).toBe(5);

    const ids = page.items.map((entry) => entry.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);

    // `ip` остаётся в таблице для разбора инцидента, но в ответе API это ПДн.
    expect(Object.keys(page.items[0] ?? {})).not.toContain('ip');
  });

  it('вопрос «кто отключил резервный вид ИД» отвечается фильтрами', async () => {
    const response = await asAdmin(
      'GET',
      `${AUDIT}?entityType=doc_type&entityId=${FALLBACK_ANY_ACT}`,
    );
    expect(response.statusCode).toBe(200);

    const items = response.json<{ items: AuditEntryResponse[] }>().items;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((entry) => entry.entityId === FALLBACK_ANY_ACT)).toBe(true);
    expect(items.map((entry) => entry.action)).toContain('doc_type.override_rejected');
    expect(items.every((entry) => entry.actorUserId === USER_ADMIN)).toBe(true);
  });

  it('фильтры по действию, объекту и периоду', async () => {
    const byAction = (await asAdmin('GET', `${AUDIT}?action=counterparty.updated`)).json<{
      items: AuditEntryResponse[];
    }>();
    expect(byAction.items.length).toBe(1);
    expect(byAction.items[0]?.payload).toEqual({ name: 'ООО «Поставщик-2»' });

    const byObject = (await asAdmin('GET', `${AUDIT}?objectId=${OBJECT_A}&limit=50`)).json<{
      items: AuditEntryResponse[];
    }>();
    expect(byObject.items.length).toBeGreaterThanOrEqual(2);
    expect(byObject.items.every((entry) => entry.objectId === OBJECT_A)).toBe(true);

    const future = (await asAdmin('GET', `${AUDIT}?from=2100-01-01T00:00:00.000Z`)).json<{
      items: AuditEntryResponse[];
      nextCursor: string | null;
    }>();
    expect(future.items).toEqual([]);
    expect(future.nextCursor).toBeNull();

    // Перевёрнутый период — отказ на входе, а не пустая выдача.
    expect(
      (await asAdmin('GET', `${AUDIT}?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`))
        .statusCode,
    ).toBe(422);
  });

  it('курсорная пагинация листает без пропусков и повторов', async () => {
    const all = (await asAdmin('GET', `${AUDIT}?limit=50`)).json<{
      items: AuditEntryResponse[];
      nextCursor: string | null;
    }>();

    const firstPage = (await asAdmin('GET', `${AUDIT}?limit=2`)).json<{
      items: AuditEntryResponse[];
      nextCursor: string | null;
    }>();
    expect(firstPage.items.length).toBe(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = (
      await asAdmin(
        'GET',
        `${AUDIT}?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      )
    ).json<{ items: AuditEntryResponse[] }>();

    expect(secondPage.items.map((entry) => entry.id)).toEqual(
      all.items.slice(2, 4).map((entry) => entry.id),
    );

    // Повреждённый курсор — ошибка запроса, а не молчаливый возврат к началу.
    expect((await asAdmin('GET', `${AUDIT}?cursor=not-a-cursor`)).statusCode).toBe(400);
  });
});
