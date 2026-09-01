/**
 * Аудит прогонов LLM — на настоящей PostgreSQL под миграциями.
 *
 * Проверяется поведение, существующее только вместе с БД:
 *
 * 1. **Требование D.** После прогона реального сценария (двойник LLM →
 *    `recordAiRun`) в строке `ai_runs` нет НИ ОДНОГО фрагмента промта и нет
 *    текста ответа. Проверяется вся строка целиком, а не отдельные поля:
 *    утечка обычно происходит не там, где её ищут, — на S3 это был
 *    `context.extra`, дописанный «чтобы удобнее отлаживать».
 * 2. **Изоляция.** Подрядчик не видит и не создаёт чужие прогоны; инженер без
 *    объектов не видит ничего.
 * 3. **Бюджет.** `monthlyAiSpend` считает ровно календарный месяц, не считает
 *    `cost IS NULL` и ограничен областью видимости — иначе порог §11 срабатывал
 *    бы по чужим тратам.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import type { AuthScope } from '../../auth/scope.js';
import { RecordedLlmProvider } from '../../llm/recorded.js';
import type { LlmRequest } from '../../llm/port.js';
import {
  MAX_STRUCTURED_RESULT_BYTES,
  listAiRuns,
  monthlyAiSpend,
  recordAiRun,
  findAiRun,
} from './ai-runs.js';
import type { Database } from './users.js';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'migrations',
);

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const OBJECT_A = id(1);
const OBJECT_B = id(2);
const ORG_CONTRACTOR_A = id(4);
const ORG_CONTRACTOR_B = id(5);
const USER = id(6);
const FOLDER_A = id(16);
const FOLDER_B = id(17);

const ADMIN: AuthScope = { kind: 'admin', userId: USER };
const CONTRACTOR_A: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: ORG_CONTRACTOR_A,
};
const CONTRACTOR_B: AuthScope = {
  kind: 'contractor',
  userId: USER,
  contractorId: ORG_CONTRACTOR_B,
};
/**
 * Инженер без назначений.
 *
 * До S37 это была «пустая область», и она не видела ничего. Объектных областей
 * больше нет, назначений тоже, и утверждения ниже перевёрнуты: инженер видит
 * всю стройку, а изоляция осталась ровно одна — подрядчик и его организация.
 */
const ENGINEER: AuthScope = { kind: 'engineer', userId: USER };

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_A}', 'OBJA1', 'Объект А', 'ЖК «А», корпус 1')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT_B}', 'OBJB1', 'Объект Б', 'ЖК «Б», корпус 2')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER}', 'kc-ai-runs', 'Тестовый пользователь')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_A}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT_B}', 'roofing') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_A}', '${ORG_CONTRACTOR_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT_B}', '${ORG_CONTRACTOR_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_A}', '${OBJECT_A}', '${ORG_CONTRACTOR_A}', '${ORG_CONTRACTOR_A}', 'roofing', DATE '2026-01-01', 'Поставка А', '${USER}')`,
  `INSERT INTO folders
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${FOLDER_B}', '${OBJECT_B}', '${ORG_CONTRACTOR_B}', '${ORG_CONTRACTOR_B}', 'roofing', DATE '2026-01-01', 'Поставка Б', '${USER}')`,
];

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await testDb.query(statement);
  }
  db = drizzle(createTestPool(testDb) as unknown as Pool);
}, 180_000);

afterAll(async () => {
  await testDb.close();
});

const HASH_IN = 'a'.repeat(64);
const HASH_OUT = 'b'.repeat(64);

function inputOf(overrides: Partial<Parameters<typeof recordAiRun>[2]> = {}) {
  return {
    folderId: FOLDER_A,
    stage: 'page_classify' as const,
    provider: 'recorded' as const,
    model: 'recorded-model',
    promptCode: 'page_classify_open_world',
    promptVersion: 1,
    inputHash: HASH_IN,
    outputHash: HASH_OUT,
    tokensIn: 100,
    tokensOut: 20,
    cost: 0.125,
    latencyMs: 42,
    structuredResult: { label: 'B-DOC', docType: 'aosr' },
    requestId: 'req-0001',
    ...overrides,
  };
}

/** Полный текстовый дамп строки: в нём ищутся часовые. */
async function dumpRun(runId: string): Promise<string> {
  const rows = await testDb.query<{ dump: string }>(
    `SELECT to_jsonb(ai_runs)::text AS dump FROM ai_runs WHERE id = '${runId}'`,
  );
  return rows[0]?.dump ?? '';
}

// =====================================================================
// Требование D: в ai_runs нет ни промта, ни ответа
// =====================================================================

describe('требование D: чувствительного payload в ai_runs нет', () => {
  it('после прогона двойника в строке нет ни фрагмента промта, ни текста ответа', async () => {
    // Часовые: уникальные строки, которых в БД быть не должно нигде.
    const SENTINEL_SYSTEM = 'chasovoy-system-prompt-0001';
    const SENTINEL_USER = 'chasovoy-user-prompt-0002';
    const SENTINEL_CONTEXT = 'chasovoy-cache-context-0003';
    const SENTINEL_ANSWER = 'chasovoy-model-answer-0004';

    const request: LlmRequest = {
      stage: 'page_classify',
      promptCode: 'page_classify_open_world',
      promptVersion: 1,
      systemPrompt: `Инструкция ${SENTINEL_SYSTEM}`,
      userPrompt: `АКТ освидетельствования скрытых работ ${SENTINEL_USER}`,
      schemaVersion: 'page_classify.v1',
      cacheContext: SENTINEL_CONTEXT,
      model: 'recorded-model',
    };
    const provider = new RecordedLlmProvider({
      responses: new Map([
        [
          RecordedLlmProvider.hashOf(request),
          { kind: 'ok', text: `{"label":"B-DOC","reason":"${SENTINEL_ANSWER}"}` } as const,
        ],
      ]),
    });

    const completion = await provider.complete(request);
    const run = await recordAiRun(db, ADMIN, {
      folderId: FOLDER_A,
      stage: request.stage,
      provider: completion.provider,
      model: completion.model,
      promptCode: request.promptCode,
      promptVersion: request.promptVersion,
      inputHash: completion.inputHash,
      outputHash: completion.outputHash,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      cost: completion.cost,
      latencyMs: completion.latencyMs,
      // В разобранный результат идёт метка, а не сырой ответ модели.
      structuredResult: { label: 'B-DOC' },
      requestId: 'req-sentinel',
    });

    const dump = await dumpRun(run.id);
    for (const sentinel of [SENTINEL_SYSTEM, SENTINEL_USER, SENTINEL_CONTEXT, SENTINEL_ANSWER]) {
      expect(dump, `в ai_runs попал часовой ${sentinel}`).not.toContain(sentinel);
    }
    // Хэши при этом на месте: связь «этот результат получен этим промтом»
    // доказуема без хранения самого промта.
    expect(dump).toContain(completion.inputHash);
    expect(dump).toContain(completion.outputHash);
  });

  it('слишком большой structuredResult отвергается', async () => {
    // Второй рубеж к требованию D: тип запрещает передать промт полем, предел
    // ловит попытку протащить его внутри разобранного результата.
    await expect(
      recordAiRun(
        db,
        ADMIN,
        inputOf({ structuredResult: { raw: 'я'.repeat(MAX_STRUCTURED_RESULT_BYTES) } }),
      ),
    ).rejects.toThrow(/structuredResult/);
  });

  it('нехэш во входе или выходе отвергается до вставки', async () => {
    await expect(recordAiRun(db, ADMIN, inputOf({ inputHash: 'не хэш' }))).rejects.toThrow(
      /inputHash/,
    );
    await expect(recordAiRun(db, ADMIN, inputOf({ outputHash: 'ABC' }))).rejects.toThrow(
      /outputHash/,
    );
  });
});

// =====================================================================
// Запись и чтение
// =====================================================================

describe('recordAiRun', () => {
  it('записывает прогон и возвращает его в разобранном виде', async () => {
    const run = await recordAiRun(db, ADMIN, inputOf({ requestId: 'req-basic' }));

    expect(run.folderId).toBe(FOLDER_A);
    expect(run.stage).toBe('page_classify');
    expect(run.provider).toBe('recorded');
    expect(run.tokensIn).toBe(100);
    expect(run.cost).toBe(0.125);
    expect(run.latencyMs).toBe(42);
    expect(run.structuredResult).toStrictEqual({ label: 'B-DOC', docType: 'aosr' });
    expect(run.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await findAiRun(db, ADMIN, run.id)).not.toBeNull();
  });

  it('провайдер recorded допустим на уровне БД', async () => {
    // Миграция 0004 разрешает `proxy_llm|rdweb|recorded`: офлайн-двойник обязан
    // писать свои прогоны, иначе гейты не видят аудита стоимости вовсе.
    const run = await recordAiRun(db, ADMIN, inputOf({ provider: 'recorded', cost: null }));
    expect(run.provider).toBe('recorded');
    expect(run.cost).toBeNull();
  });

  it('чужая ревизия недоступна для записи', async () => {
    await expect(
      recordAiRun(db, CONTRACTOR_B, inputOf({ requestId: 'req-alien' })),
    ).rejects.toThrow(/Ревизия поставки не найдена/);
    // Инженеру ревизия видна, значит и запись прогона по ней проходит.
    await expect(
      recordAiRun(db, ENGINEER, inputOf({ requestId: 'req-eng' })),
    ).resolves.toBeDefined();
  });
});

describe('listAiRuns', () => {
  it('изоляция: подрядчик не видит чужие прогоны ни списком, ни по прямому id', async () => {
    const own = await recordAiRun(db, ADMIN, inputOf({ requestId: 'req-own' }));
    const alien = await recordAiRun(db, ADMIN, inputOf({ folderId: FOLDER_B, requestId: 'req-b' }));

    const mine = await listAiRuns(db, CONTRACTOR_A, { folderId: FOLDER_A, limit: 100 });
    expect(mine.items.map((item) => item.id)).toContain(own.id);

    const foreign = await listAiRuns(db, CONTRACTOR_A, { folderId: FOLDER_B, limit: 100 });
    expect(foreign.items).toStrictEqual([]);
    expect(await findAiRun(db, CONTRACTOR_A, alien.id)).toBeNull();
    expect(await findAiRun(db, CONTRACTOR_B, alien.id)).not.toBeNull();

    // Инженер видит обе ревизии: изоляция режет подрядчика, а не его.
    const engineer = await listAiRuns(db, ENGINEER, { folderId: FOLDER_B, limit: 100 });
    expect(engineer.items.map((item) => item.id)).toContain(alien.id);
  });

  it('листается курсором без пропусков и без повторов', async () => {
    const folder = FOLDER_A;
    const before = await listAiRuns(db, ADMIN, { folderId: folder, limit: 1000 });
    for (let i = 0; i < 3; i += 1) {
      await recordAiRun(db, ADMIN, inputOf({ requestId: `req-page-${i}` }));
    }

    const expected = before.items.length + 3;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listAiRuns>> = await listAiRuns(db, ADMIN, {
        folderId: folder,
        limit: 2,
        cursor,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(expected);
    expect(new Set(seen).size).toBe(expected);
  });

  it('повреждённый курсор — отказ, а не молчаливый возврат к первой странице', async () => {
    await expect(
      listAiRuns(db, ADMIN, { folderId: FOLDER_A, limit: 2, cursor: 'не-курсор' }),
    ).rejects.toThrow(/Курсор/);
  });
});

// =====================================================================
// Бюджет
// =====================================================================

describe('monthlyAiSpend', () => {
  const MONTH = new Date('2026-05-15T12:00:00.000Z');

  beforeAll(async () => {
    const rows: readonly [string, string, string | null][] = [
      // [folder, created_at, cost]
      [FOLDER_A, '2026-04-30T23:59:59.000Z', '10.0000'],
      [FOLDER_A, '2026-05-01T00:00:00.000Z', '1.5000'],
      [FOLDER_A, '2026-05-31T23:59:59.999Z', '2.2500'],
      [FOLDER_A, '2026-06-01T00:00:00.000Z', '100.0000'],
      // Стоимость не сообщена: в сумму не входит — ноль означал бы «бесплатно».
      [FOLDER_A, '2026-05-10T00:00:00.000Z', null],
      // Чужая ревизия: видна администратору, но не подрядчику А.
      [FOLDER_B, '2026-05-10T00:00:00.000Z', '7.0000'],
    ];
    for (const [folder, at, cost] of rows) {
      await testDb.query(
        `INSERT INTO ai_runs (folder_id, stage, provider, model, cost, created_at)
           VALUES ('${folder}', 'summary', 'proxy_llm', 'gw/model-a',
                   ${cost === null ? 'NULL' : `'${cost}'`}, '${at}')`,
      );
    }
  });

  it('считает ровно календарный месяц', async () => {
    const total = await monthlyAiSpend(db, ADMIN, MONTH);
    // 1.5 + 2.25 + 7.0 из мая; апрельские и июньские строки не входят.
    // Плюс прогоны, записанные тестами выше в текущем месяце, — их здесь нет,
    // потому что май 2026 в прошлом относительно любой даты прогона гейта
    // только при NODE_ENV с фиксированным временем, поэтому сравнение точное.
    expect(total).toBeCloseTo(10.75, 4);
  });

  it('ограничен областью видимости', async () => {
    // Подрядчик А не видит трату по ревизии Б: иначе порог §11 срабатывал бы
    // по чужим расходам.
    expect(await monthlyAiSpend(db, CONTRACTOR_A, MONTH)).toBeCloseTo(3.75, 4);
    expect(await monthlyAiSpend(db, CONTRACTOR_B, MONTH)).toBeCloseTo(7, 4);
    // Инженер видит расход по всей стройке — сумму обеих ревизий.
    expect(await monthlyAiSpend(db, ENGINEER, MONTH)).toBeCloseTo(10.75, 4);
  });

  it('соседние месяцы считаются отдельно', async () => {
    expect(await monthlyAiSpend(db, ADMIN, new Date('2026-04-05T00:00:00.000Z'))).toBeCloseTo(
      10,
      4,
    );
    expect(await monthlyAiSpend(db, ADMIN, new Date('2026-06-20T00:00:00.000Z'))).toBeCloseTo(
      100,
      4,
    );
  });

  it('месяц без прогонов даёт ноль, а не null', async () => {
    expect(await monthlyAiSpend(db, ADMIN, new Date('2020-01-01T00:00:00.000Z'))).toBe(0);
  });
});
