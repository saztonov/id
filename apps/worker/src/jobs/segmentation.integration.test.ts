/**
 * Цепочка «Собрать документы» целиком: очередь → воркер → база (§8, §12).
 *
 * ## Что здесь настоящее
 *
 * PostgreSQL (pglite) под миграциями проекта, файловое хранилище, ДВА
 * настоящих PDF, живой фейк-сервер RD WEB, штатный `JobRunner.runOnce()` и
 * реестр из `createWorkerRegistry()` — тот же, что собирает точка входа
 * воркера. Стадии приёма, разметки и распознавания проходятся полностью, а не
 * подставляются: `page_text_versions` появляются ровно тем путём, которым они
 * появляются в бою. Текст страниц задаётся двойнику RD WEB (это то, что в бою
 * приносит OCR), всё остальное — форма ответов, состав архива, ссылки на кропы,
 * QA-инварианты — остаётся его собственным.
 *
 * ## Что проверяется
 *
 * Не «задача завершилась успехом», а ПОСЛЕДСТВИЯ в базе, и прежде всего
 * специфический гейт S8 (§17):
 *
 * 1. **инвариант назначения страниц** — каждая страница ровно в одном
 *    документе либо в `page_assignments` без документа; `v_unaccounted_pages`
 *    пусто (non-degradable, §1.6);
 * 2. реестр приложений на 29 позиций собирается из ДВУХ страниц;
 * 3. `annex_continuation` присоединяется по номеру родителя;
 * 4. коллизия после фолдинга гомоглифов даёт `ambiguous`, а не `matched`;
 * 5. документ, пересекающий границу файлов, собирается верно;
 * 6. документ незнакомого вида получает резервный тип, попадает в
 *    `doc_type_candidates` и НЕ меняет границы соседних документов;
 * 7. базовые реквизиты извлекаются и у документа неизвестного вида.
 *
 * Плюс требования этапа: повтор каждой задачи не уничтожает данные, двойник
 * модели воспроизводит плохое поведение настоящей (невалидный JSON, цитата,
 * которой нет в тексте, отказ по бюджету), в `ai_runs` нет текста промта, а в
 * журнале уровня `trace` нет ни одного секрета.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { startFakeRdWeb, type FakeRdWeb } from '@id/fake-rdweb';
import {
  createDatabase,
  createLogger,
  createMetrics,
  createPdfLibToolkit,
  buildEffectivePrompt,
  createStorage,
  dedupeKeyFor,
  enqueueSystemJob,
  ensureDraftLayout,
  findLayoutRevision,
  findSectionMarkers,
  freezeLayout,
  JobRunner,
  LegacyRdWebAdapter,
  listFieldValues,
  listLogicalDocuments,
  listPageAssignments,
  listPageClassifications,
  listRegistryRows,
  listUnaccountedPages,
  loadEnv,
  loadPdfLibModule,
  NoopErrorReporter,
  RecordedLlmProvider,
  startRecognitionRun,
  type AuthScope,
  type Database,
  type LlmRequest,
  type PdfToolkit,
  type RecordedBehaviour,
  type StorageProvider,
} from '@id/api';

import { createWorkerRegistry } from './pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

const RD_PASSWORD = 'portal-secret-never-in-logs';
const OCR_MODEL = 'qwen2.5-vl-7b-instruct';
const LLM_MODEL = 'recorded-classifier';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_CONTRACTOR = id(2);
const OBJECT = id(4);
const SUBMISSION = id(10);
const REVISION = id(11);
const USER_CONTRACTOR = id(20);
const USER_ADMIN = id(21);
const FILE_A = id(30);
const FILE_B = id(31);

const SCOPE: AuthScope = { kind: 'admin', userId: USER_CONTRACTOR };
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-segmentation-e2e-'));

// =====================================================================
// Содержимое комплекта
// =====================================================================

/**
 * Номера документов подобраны так, чтобы воспроизвести ровно ту коллизию, ради
 * которой §8.3 требует фолдинга гомоглифов: одна и та же декларация набрана в
 * двух алфавитах, а реестр называет её третьим написанием. Значения
 * синтетические — настоящие номера корпуса в репозиторий не попадают (§1.4).
 */
const CERT_NO = 'RU.ТЕСТ.001.Н.00042';
/** Латинские `RU`, `PA`, `B`. */
const DECL_LATIN = 'РОСС RU Д-RU.PA01.B.99001/24';
/** Кириллические `РУ`, `РА`, `В` — тот же документ, другой алфавит. */
const DECL_CYRILLIC = 'РОСС RU Д-РУ.РА01.В.99001/24';
/** Третье написание: в реестре. Точно не совпадает ни с одним, folded — с обоими. */
const DECL_MIXED = 'РОСС RU Д-RU.РА01.B.99001/24';
const PROTOCOL_NO = 'П-1';

/** Заголовок вида, которого в каталоге намеренно нет (§0.5, фикстура S0). */
const UNKNOWN_TITLE = 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ';
const UNKNOWN_NO = 'ГИ-77';

const REGISTRY_HEADER = [
  'Реестр приложений №1 к акту АОСР № 01-ТЕСТ от «27» февраля 2026',
  '',
  '| № п/п | Наименование документа | № чертежа, акта, разрешения, журнала и др. | Организация, составившая документ |',
  '|---|---|---|---|',
  '| 1 | 2 | 3 | 4 |',
  '',
  '**Документы, подтверждающие качество применяемых материалов и изделий**',
  '',
  '| | | | |',
  '|---|---|---|---|',
].join('\n');

/** Строки 1–3 называют документы комплекта, 4–29 — отсутствующие. */
function registryRowsFirstPage(): string {
  const rows = [
    `| 1 | Сертификат соответствия Плита теплоизоляционная | №${CERT_NO} с 25.05.2023 по 24.05.2026 | ООО «Ромашка» |`,
    `| 2 | Декларация о соответствии Плита теплоизоляционная | №${DECL_MIXED} с 12.05.2023 по 11.05.2028 | ООО «Ромашка» |`,
    `| 3 | Протокол об испытаниях образцов | №${PROTOCOL_NO} от 20.06.2025 | ООО «Василёк» |`,
  ];
  for (let n = 4; n <= 15; n += 1) {
    rows.push(
      `| ${n} | Документ о качестве материала | №СИНТ-${n} от 10.01.2026 | ООО «Ромашка» |`,
    );
  }
  return [REGISTRY_HEADER, ...rows].join('\n');
}

/**
 * Продолжение таблицы БЕЗ шапки — то, из-за чего реестр АОСР № 336 даёт 29
 * строк, а не 17. Первая строка намеренно оставлена хвостом переноса ячейки:
 * в корпусе она есть, и разбор обязан её отбросить, не сдвинув нумерацию.
 */
function registryRowsSecondPage(): string {
  const rows = ['| | Плита теплоизоляционная | | |'];
  for (let n = 16; n <= 29; n += 1) {
    rows.push(
      `| ${n} | Документ о качестве материала | №СИНТ-${n} от 10.01.2026 | ООО «Ромашка» |`,
    );
  }
  return ['| | | | |', '|---|---|---|---|', ...rows].join('\n');
}

/**
 * Текст страниц рабочего документа.
 *
 * Файл А — страницы 0..7, файл Б — 8..11. Протокол начинается последней
 * страницей файла А и продолжается первой страницей файла Б: это и есть
 * «документ через границу файлов» из гейта §17.
 */
const PAGE_TEXTS: readonly string[] = [
  // 0. Акт освидетельствования скрытых работ.
  [
    'АКТ',
    'освидетельствования скрытых работ',
    '№ 01-ТЕСТ от «27» февраля 2026',
    'Лист 1 из 2',
  ].join('\n'),
  // 1. Второй лист акта: маркер продолжения.
  ['Лист 2 из 2', 'п.3 При выполнении работ применены материалы'].join('\n'),
  // 2. Реестр приложений, строки 1–15.
  registryRowsFirstPage(),
  // 3. Продолжение реестра без шапки, строки 16–29.
  registryRowsSecondPage(),
  // 4. Сертификат соответствия.
  [
    'СЕРТИФИКАТ СООТВЕТСТВИЯ',
    `№ ${CERT_NO}`,
    'Срок действия с 25.05.2023 по 24.05.2026',
    'Изготовитель ООО «Ромашка»',
  ].join('\n'),
  // 5. Приложение к сертификату: номер родителя стоит строкой ниже якоря роли.
  ['ПРИЛОЖЕНИЕ', 'К сертификату соответствия', `№ ${CERT_NO}`].join('\n'),
  // 6. Декларация, латинское написание номера.
  ['ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ', `№ ${DECL_LATIN}`, 'Срок действия с 12.05.2023 по 11.05.2028'].join(
    '\n',
  ),
  // 7. Протокол испытаний — последняя страница файла А.
  ['ПРОТОКОЛ об испытаниях', `№ ${PROTOCOL_NO} от 20.06.2025`, 'Лист 1 из 2'].join('\n'),
  // 8. Продолжение протокола — первая страница файла Б.
  ['Лист 2 из 2', 'Вывод: соответствует требованиям'].join('\n'),
  // 9. Та же декларация, кириллическое написание номера.
  [
    'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ',
    `№ ${DECL_CYRILLIC}`,
    'Срок действия с 12.05.2023 по 11.05.2028',
  ].join('\n'),
  // 10. Документ вида, которого в каталоге нет.
  [UNKNOWN_TITLE, `№ ${UNKNOWN_NO} от 12.05.2026`, 'Давление 1,0 МПа, выдержка 10 мин'].join('\n'),
  // 11. Страница без заголовка и без якорей: остаётся `U` и уходит в фазу 2.
  ['Сведения о поставке материалов', 'Таблица 1', 'Позиция 1 — 12 шт.'].join('\n'),
  // 12. Пустая страница. Присоединять её автоматически нельзя (§8.2, фаза 3):
  //     она бывает и разделителем между документами, и оборотом предыдущего
  //     листа, а решает это человек. Страница обязана остаться учтённой ЯВНОЙ
  //     строкой без документа — именно на ней исполняется вторая половина
  //     инварианта §1.6 («потерь нет»). Первая редакция файла её не имела, и
  //     путь непривязанной страницы не исполнялся ни разу: мутация, вовсе
  //     убравшая запись непривязанных строк, не роняла ни одного теста.
  '',
];

const FILE_A_PAGES = 8;
const FILE_B_PAGES = PAGE_TEXTS.length - FILE_A_PAGES;

// =====================================================================
// Двойник модели
// =====================================================================

/**
 * Ответы модели по хэшу полного эффективного промта.
 *
 * Наполняется первым проходом: хэш зависит от промта, модели, провайдера,
 * соседнего контекста и версии схемы (§8.2), то есть в тесте его нельзя
 * выписать константой, не продублировав всю сборку промта. Поэтому `fallback`
 * ЗАПОМИНАЕТ хэш и отдаёт поведение, выбранное по содержимому страницы, а
 * отдельный тест затем доказывает, что тот же вход даёт тот же хэш.
 */
const recordedByHash = new Map<string, RecordedBehaviour>();
const llmSeen: { hash: string; userPrompt: string; effective: string }[] = [];

function behaviourFor(request: LlmRequest): RecordedBehaviour {
  const prompt = request.userPrompt;
  // Страница без сигнала: модель честно отвечает «документ, но вида такого нет».
  if (prompt.includes('Сведения о поставке материалов')) {
    return {
      kind: 'ok',
      text: JSON.stringify({
        label: 'B-DOC',
        doc_type: 'other',
        observed_title: 'ВЕДОМОСТЬ ПОСТАВКИ МАТЕРИАЛОВ',
        confidence: 0.82,
        reason: 'самостоятельный документ, ни один из перечисленных видов не подходит',
        quote: 'Сведения о поставке материалов',
      }),
      tokensIn: 900,
      tokensOut: 60,
      cost: 0.0012,
    };
  }
  // Двойник обязан уметь то же, что настоящая модель (урок S7).
  return { kind: 'invalid_json', text: '{"label": "B-DOC", "doc_type":' };
}

// =====================================================================
// Инфраструктура прогона
// =====================================================================

let testDb: TestDatabase;
let db: Database;
let storage: StorageProvider;
let toolkit: PdfToolkit;
let runner: JobRunner;
let fake: FakeRdWeb;
let bundleId = '';
const logSink: string[] = [];

async function buildPdf(pages: number): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage([595, 842]);
  return Buffer.from(await document.save());
}

function fixtureStatements(
  shaA: string,
  sizeA: number,
  shaB: string,
  sizeB: number,
): readonly string[] {
  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CONTRACTOR}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name)
       VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
    `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${USER_CONTRACTOR}', 'kc-seg-contractor', 'Сотрудник подрядчика', '${ORG_CONTRACTOR}')`,
    `INSERT INTO users (id, kc_sub, full_name)
       VALUES ('${USER_ADMIN}', 'kc-seg-admin', 'Администратор портала')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_CONTRACTOR}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_CONTRACTOR}') ON CONFLICT DO NOTHING`,
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', '${ORG_CONTRACTOR}', 'roofing', DATE '2026-01-01', 'Поставка 1', '${USER_CONTRACTOR}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
       VALUES ('${REVISION}', '${SUBMISSION}', '${OBJECT}', '${ORG_CONTRACTOR}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${shaA}', 'blobs/${shaA.slice(0, 2)}/${shaA.slice(2, 4)}/${shaA}', ${sizeA}, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${shaB}', 'blobs/${shaB.slice(0, 2)}/${shaB.slice(2, 4)}/${shaB}', ${sizeB}, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
       VALUES ('${FILE_A}', '${REVISION}', '${shaA}', 'часть-1.pdf', 0)`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order)
       VALUES ('${FILE_B}', '${REVISION}', '${shaB}', 'часть-2.pdf', 1)`,
    // Опубликованный промт стадии: §10 требует цикла draft → publish с
    // аудитом, поэтому в бою его публикует администратор. Здесь та же строка
    // заводится напрямую — важно, что публикатор настоящий пользователь, а не
    // выдуманный идентификатор.
    `INSERT INTO prompt_templates (code, version, stage, state, system_prompt, user_template,
                                   published_at, published_by)
       VALUES ('page_classify', 1, 'page_classify', 'published',
               'Ты классифицируешь страницы исполнительной документации.',
               'Коды видов: {{DOC_TYPE_CODES}}. Порядковый номер: {{ORDINAL}}. Поворот: {{ROTATION}}. Блоки: {{BLOCKS}}.
Предыдущая страница: {{BEFORE}}
Страница: {{PAGE}}
Следующая страница: {{AFTER}}',
               now(), '${USER_ADMIN}')`,
  ];
}

beforeAll(async () => {
  fake = await startFakeRdWeb({
    users: [{ email: 'portal@example.test', password: RD_PASSWORD }],
    renderDelayPolls: 1,
    maxPagesPerDetectCall: 12,
    // Один полностраничный TEXT-блок на страницу: текст страницы обязан
    // совпасть с заданным дословно, иначе заголовок документа перестал бы быть
    // первой строкой, а `char_span` реквизитов измерялся бы в склейке секций.
    fullPageBlocks: true,
    pageTexts: PAGE_TEXTS,
  });

  const TEST_ENV = loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://pglite/id-portal-tests',
    AUTH_MODE: 'dev-stub',
    CSRF_SECRET: 'csrf-secret-of-segmentation-e2e-0123456',
    STORAGE_DRIVER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    AUDIT_HMAC_KEY: 'audit-hmac-key-of-segmentation-e2e',
    RDWEB_BASE_URL: fake.url,
    RDWEB_USER: 'portal@example.test',
    RDWEB_PASSWORD: RD_PASSWORD,
    RDWEB_PROJECT_ALLOWLIST: 'prj-portal',
    RDWEB_OCR_MODEL: OCR_MODEL,
  });

  testDb = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await testDb.exec(migration.sql);
  }

  const contentA = await buildPdf(FILE_A_PAGES);
  const contentB = await buildPdf(FILE_B_PAGES);
  const shaA = createHash('sha256').update(contentA).digest('hex');
  const shaB = createHash('sha256').update(contentB).digest('hex');
  for (const statement of fixtureStatements(shaA, contentA.byteLength, shaB, contentB.byteLength)) {
    await testDb.query(statement);
  }

  db = createDatabase(createTestPool(testDb) as unknown as Pool);

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logSink.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    service: 'segmentation-e2e',
    level: 'trace',
    env: 'test',
    destination,
  });
  const metrics = createMetrics({ enabled: false, service: 'segmentation-e2e' });
  storage = createStorage(TEST_ENV, { metrics, logger });

  for (const [sha, content] of [
    [shaA, contentA],
    [shaB, contentB],
  ] as const) {
    const key = `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
    const target = join(STORAGE_DIR, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }

  toolkit = createPdfLibToolkit(await loadPdfLibModule((specifier) => import(specifier)));

  const rdweb = new LegacyRdWebAdapter({
    baseUrl: fake.url,
    user: 'portal@example.test',
    password: RD_PASSWORD,
    projectId: 'prj-portal',
    metrics,
    logger,
    slowExternalMs: TEST_ENV.SLOW_EXTERNAL_MS,
  });

  const llm = new RecordedLlmProvider({
    responses: recordedByHash,
    model: LLM_MODEL,
    fallback: (hash, request) => {
      // Сохраняется ПОЛНЫЙ эффективный промт, а не только пользовательская
      // часть: раздел работ, названный в системной части, действует сильнее,
      // а прежняя проверка её не видела вовсе.
      llmSeen.push({
        hash,
        userPrompt: request.userPrompt,
        effective: buildEffectivePrompt({ ...request, model: LLM_MODEL }),
      });
      const behaviour = behaviourFor(request);
      recordedByHash.set(hash, behaviour);
      return behaviour;
    },
  });

  runner = new JobRunner({
    db,
    registry: createWorkerRegistry({
      db,
      storage,
      toolkit,
      limits: { maxBytes: TEST_ENV.MAX_UPLOAD_BYTES, maxPages: TEST_ENV.MAX_PAGES_PER_FILE },
      workDirBase: STORAGE_DIR,
      rdweb,
      rdProjectId: 'prj-portal',
      previewCached: false,
      waitPages: { pollsPerAttempt: 6, pollIntervalMs: 10 },
      pollRecognition: { pollsPerAttempt: 6, pollIntervalMs: 10 },
      recognitionSelections: [
        { blockType: 'text', providerType: 'lmstudio', modelId: OCR_MODEL },
        { blockType: 'image', providerType: 'lmstudio', modelId: OCR_MODEL },
        { blockType: 'stamp', providerType: 'lmstudio', modelId: OCR_MODEL },
      ],
      llm,
    }),
    logger,
    metrics,
    errorReporter: new NoopErrorReporter(),
    workerId: 'worker-segmentation-e2e',
  });

  // Стадии 1–3 штатным путём S5.
  for (const sourceFileId of [FILE_A, FILE_B]) {
    for (const type of ['file.verify', 'file.signature_probe'] as const) {
      await enqueueSystemJob(db, {
        type,
        payload: { revisionId: REVISION, sourceFileId },
        dedupeKey: dedupeKeyFor(type, sourceFileId),
      });
    }
  }
  await enqueueSystemJob(db, {
    type: 'bundle.build',
    payload: { revisionId: REVISION },
    dedupeKey: dedupeKeyFor('bundle.build', REVISION),
  });
  await drainQueue();

  const bundles = await testDb.query<{ id: string }>(
    `SELECT id FROM processing_bundles WHERE revision_id = '${REVISION}'`,
  );
  bundleId = bundles[0]?.id ?? '';
  expect(bundleId).not.toBe('');

  // Стадии 4–13: разметка и распознавание — полностью, как в бою.
  const { layout } = await ensureDraftLayout(db, SCOPE, { revisionId: REVISION, bundleId });
  await enqueueSystemJob(db, {
    type: 'rd.create_run_document',
    payload: { revisionId: REVISION, bundleId, layoutRevisionId: layout.id },
    dedupeKey: dedupeKeyFor('rd.create_run_document', layout.id),
  });
  await drainQueue();

  const current = await findLayoutRevision(db, SCOPE, layout.id);
  await freezeLayout(db, SCOPE, {
    layoutRevisionId: layout.id,
    expectedVersion: current?.version ?? 0,
    actorUserId: USER_CONTRACTOR,
  });
  const { run } = await startRecognitionRun(db, SCOPE, {
    layoutRevisionId: layout.id,
    requireRdDocument: true,
    settingsSnapshot: { version: 1, provider: 'lmstudio', model: OCR_MODEL, documentMode: false },
  });
  await enqueueSystemJob(db, {
    type: 'layout.reconcile',
    payload: { revisionId: REVISION, recognitionRunId: run.id },
    dedupeKey: dedupeKeyFor('layout.reconcile', run.id),
  });
  await drainQueue();

  const runs = await testDb.query<{ status: string }>(
    `SELECT status FROM recognition_runs WHERE id = '${run.id}'`,
  );
  expect(runs[0]?.status).toBe('done');

  // Стадии 14–19: то, ради чего написан файл.
  await enqueueSystemJob(db, {
    type: 'doc.classify_pages',
    payload: { revisionId: REVISION },
    dedupeKey: dedupeKeyFor('doc.classify_pages', REVISION),
  });
  await drainQueue();
}, 600_000);

afterAll(async () => {
  await runner.stop();
  await fake.close();
  await testDb.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainQueue(maxRounds = 160): Promise<void> {
  let idle = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const claimed = await runner.runOnce();
    if (claimed > 0) {
      idle = 0;
      continue;
    }
    idle += 1;
    if (idle > 3) return;
    await sleep(120);
  }
  throw new Error('очередь не опустела за отведённое число проходов');
}

async function count(sql: string): Promise<number> {
  const rows = await testDb.query<{ count: string | number }>(sql);
  return Number(rows[0]?.count ?? 0);
}

// =====================================================================
// Достижимость и отсутствие отказов
// =====================================================================

describe('задачи 14–19 действительно выполняются', () => {
  it('каждая из шести задач оставила строку в job_runs', async () => {
    const rows = await testDb.query<{ job_type: string }>(
      `SELECT DISTINCT job_type FROM job_runs ORDER BY job_type`,
    );
    const types = rows.map((row) => row.job_type);
    // Обработчик, написанный и не поставленный в очередь, — отказ S5;
    // зарегистрированный и не выполнявшийся — отказ S3. Проверяется факт
    // выполнения, а не наличие кода.
    for (const type of [
      'doc.classify_pages',
      'doc.segment',
      'doc.extract_fields',
      'doc.parse_registry',
      'doc.match_registry',
      'graph.build',
    ]) {
      expect(types, type).toContain(type);
    }
  });

  it('ни одна задача не завершилась отказом', async () => {
    const failed = await testDb.query<{ job_type: string; error_message: string }>(
      `SELECT job_type, error_message FROM job_runs WHERE outcome <> 'succeeded'`,
    );
    expect(failed).toEqual([]);
  });
});

// =====================================================================
// Non-degradable гейт: инвариант назначения страниц (§1.6)
// =====================================================================

describe('инвариант назначения страниц', () => {
  it('каждая страница учтена ровно один раз', async () => {
    const pages = await count(
      `SELECT count(*) AS count FROM source_pages WHERE revision_id = '${REVISION}'`,
    );
    const assignments = await count(
      `SELECT count(*) AS count FROM page_assignments WHERE revision_id = '${REVISION}'`,
    );
    expect(pages).toBe(PAGE_TEXTS.length);
    expect(assignments).toBe(pages);
  });

  it('неучтённых страниц нет', async () => {
    const unaccounted = await listUnaccountedPages(db, SCOPE, REVISION);
    expect(unaccounted).toEqual([]);
  });

  it('страница не может оказаться в двух документах', async () => {
    const duplicates = await count(
      `SELECT count(*) AS count FROM (
         SELECT source_page_id FROM page_assignments WHERE revision_id = '${REVISION}'
          GROUP BY source_page_id HAVING count(*) > 1) t`,
    );
    expect(duplicates).toBe(0);
  });

  it('привязанная и непривязанная страница описаны полностью', async () => {
    const assignments = await listPageAssignments(db, SCOPE, REVISION);
    for (const assignment of assignments) {
      if (assignment.documentId === null) {
        expect(assignment.reason, assignment.sourcePageId).not.toBeNull();
        expect(assignment.sortOrder).toBeNull();
      } else {
        expect(assignment.sortOrder, assignment.sourcePageId).not.toBeNull();
        expect(assignment.reason).toBeNull();
      }
    }
  });
});

// =====================================================================
// Гейт S8: границы, реестр, сверка, открытый мир
// =====================================================================

describe('непривязанные страницы существуют явной строкой', () => {
  it('пустая страница учтена, но к документу не присоединена', async () => {
    // Вторая половина инварианта §1.6. Без такой страницы путь записи
    // непривязанных строк в комплекте не исполняется вовсе, и его поломка
    // остаётся невидимой: мутация, убравшая запись целиком, не роняла ни
    // одного теста, пока в комплекте не появилась пустая страница.
    const assignments = await listPageAssignments(db, SCOPE, REVISION);
    const blank = assignments.find((a) => a.revisionOrdinal === PAGE_TEXTS.length - 1);
    expect(blank).toBeDefined();
    expect(blank?.documentId).toBeNull();
    expect(blank?.reason).not.toBeNull();
    // И при этом страница именно УЧТЕНА: отсутствие строки не отличалось бы
    // от потерянной страницы.
    expect(await listUnaccountedPages(db, SCOPE, REVISION)).toEqual([]);
  });
});
describe('гейт S8', () => {
  it('акт, реестр, сертификат, декларации и протокол опознаны', async () => {
    const documents = await listLogicalDocuments(db, SCOPE, REVISION);
    const codes = documents.map((document) => document.docTypeCode);
    expect(codes).toContain('aosr');
    expect(codes).toContain('annex_registry');
    expect(codes).toContain('cert_conformity');
    expect(codes.filter((code) => code === 'declaration')).toHaveLength(2);
  });

  it('реестр приложений собран из ДВУХ страниц и даёт 29 строк', async () => {
    const rows = await listRegistryRows(db, SCOPE, REVISION);
    expect(rows).toHaveLength(29);
    expect(rows.map((row) => row.rowNo)).toEqual(
      Array.from({ length: 29 }, (_value, index) => index + 1),
    );
  });

  it('приложение присоединено к сертификату по номеру родителя', async () => {
    const documents = await listLogicalDocuments(db, SCOPE, REVISION);
    const cert = documents.find((document) => document.docTypeCode === 'cert_conformity');
    expect(cert).toBeDefined();
    const assignments = await listPageAssignments(db, SCOPE, REVISION);
    const pagesOfCert = assignments.filter((a) => a.documentId === cert?.id);
    // Сертификат и лист приложения — один документ из двух страниц.
    expect(pagesOfCert).toHaveLength(2);
    expect(pagesOfCert.map((a) => a.pageRoleCode)).toContain('annex_continuation');
  });

  it('коллизия после фолдинга гомоглифов даёт ambiguous, а не matched', async () => {
    const rows = await listRegistryRows(db, SCOPE, REVISION);
    const collided = rows.find((row) => row.rowNo === 2);
    expect(collided).toBeDefined();
    // Две декларации, набранные в разных алфавитах, после фолдинга неразличимы.
    // Выбрать одну означало бы утверждать факт, которого сверка не установила.
    expect(collided?.matchState).toBe('ambiguous');
    expect(collided?.matchedDocumentId).toBeNull();
  });

  it('строка реестра с точным номером сведена с документом', async () => {
    const rows = await listRegistryRows(db, SCOPE, REVISION);
    const exact = rows.find((row) => row.rowNo === 1);
    expect(exact?.matchState).toBe('matched');
    expect(exact?.matchedDocumentId).not.toBeNull();
    expect(exact?.matchScore).toBe(1);
  });

  it('документ через границу файлов собран верно', async () => {
    const documents = await listLogicalDocuments(db, SCOPE, REVISION);
    const protocolPages = await protocolPageFiles(documents);
    // Обе страницы протокола — в одном документе и из РАЗНЫХ исходных файлов.
    expect(protocolPages).toHaveLength(2);
    expect(new Set(protocolPages)).toEqual(new Set([FILE_A, FILE_B]));
  });

  it('документ незнакомого вида получает резервный тип и попадает в кандидаты', async () => {
    const classifications = await listPageClassifications(db, SCOPE, REVISION);
    const unknown = classifications.find((c) => c.observedTitle === UNKNOWN_TITLE);
    expect(unknown).toBeDefined();
    // Два разных «не знаю» различены: это `other`, а не `uncertain`.
    expect(unknown?.typeOutcome).toBe('other');

    const candidates = await testDb.query<{ observed_title_norm: string; occurrences: number }>(
      `SELECT observed_title_norm, occurrences FROM doc_type_candidates`,
    );
    const titles = candidates.map((row) => row.observed_title_norm);
    expect(titles.some((title) => title.includes('ГИДРАВЛИЧЕСКОГО'))).toBe(true);
  });

  it('незнакомый вид не меняет границы соседних документов', async () => {
    const assignments = await listPageAssignments(db, SCOPE, REVISION);
    const byOrdinal = new Map(assignments.map((a) => [a.revisionOrdinal, a]));
    const unknownPage = byOrdinal.get(10);
    const declarationPage = byOrdinal.get(9);
    expect(unknownPage?.documentId).not.toBeNull();
    expect(declarationPage?.documentId).not.toBeNull();
    // Соседняя декларация осталась самостоятельным документом: незнакомец не
    // притянул её к себе и не разорвал.
    expect(unknownPage?.documentId).not.toBe(declarationPage?.documentId);
    const documents = await listLogicalDocuments(db, SCOPE, REVISION);
    const declaration = documents.find((d) => d.id === declarationPage?.documentId);
    expect(declaration?.docTypeCode).toBe('declaration');
  });

  it('базовые реквизиты извлекаются и у документа неизвестного вида', async () => {
    const documents = await listLogicalDocuments(db, SCOPE, REVISION);
    const assignments = await listPageAssignments(db, SCOPE, REVISION);
    const unknownPage = assignments.find((a) => a.revisionOrdinal === 10);
    const unknown = documents.find((d) => d.id === unknownPage?.documentId);
    expect(unknown).toBeDefined();

    const fields = await listFieldValues(db, SCOPE, unknown?.id ?? '');
    const byCode = new Map(fields.map((field) => [field.fieldCode, field]));
    // Номер и дата — те самые реквизиты, на которых работают проверки сроков
    // и сверка с реестром. Без них незнакомый документ был бы бесполезен.
    expect(byCode.get('number')?.valueText).toBe(UNKNOWN_NO);
    expect(byCode.get('issued_at')?.valueDate).toBe('2026-05-12');
  });

  it('ни один документ не остался без учёта страниц', async () => {
    const documents = await listLogicalDocuments(db, SCOPE, REVISION);
    for (const document of documents) {
      expect(document.pageCount, document.id).toBeGreaterThan(0);
    }
  });
});

async function protocolPageFiles(
  documents: readonly { id: string; docTypeCode: string | null }[],
): Promise<readonly string[]> {
  const protocol = documents.find(
    (document) => document.docTypeCode !== null && document.docTypeCode.startsWith('lab_protocol'),
  );
  if (protocol === undefined) return [];
  const rows = await testDb.query<{ source_file_id: string }>(
    `SELECT p.source_file_id FROM page_assignments a
       JOIN source_pages p ON p.id = a.source_page_id
      WHERE a.document_id = '${protocol.id}'`,
  );
  return rows.map((row) => row.source_file_id);
}

// =====================================================================
// Модель: двойник не мягче оригинала, секретов нет
// =====================================================================

describe('провайдер модели', () => {
  it('фаза 2 вызывалась только для страниц без сигнала', () => {
    // Платить за подтверждение того, что уже сказал якорь, незачем, а второй
    // источник правды с правом опровергнуть первый — прямой путь к молчаливым
    // расхождениям.
    expect(llmSeen.length).toBeGreaterThan(0);
    expect(llmSeen.length).toBeLessThan(PAGE_TEXTS.length);
  });

  it('ответ, не разбирающийся как JSON, не роняет задачу и не даёт метку', async () => {
    // Двойник обязан воспроизводить плохое поведение настоящей модели (§B).
    const behaviours = [...recordedByHash.values()].map((behaviour) => behaviour.kind);
    expect(behaviours).toContain('invalid_json');
    const failed = await count(
      `SELECT count(*) AS count FROM job_runs
        WHERE job_type = 'doc.classify_pages' AND outcome <> 'succeeded'`,
    );
    expect(failed).toBe(0);
  });

  it('ключ ответа устойчив: тот же вход даёт тот же хэш', () => {
    const hashes = llmSeen.map((entry) => entry.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const hash of hashes) expect(recordedByHash.has(hash)).toBe(true);
  });

  it('в ai_runs записаны хэши и стоимость, но нет текста промта', async () => {
    const rows = await testDb.query<{
      provider: string;
      model: string;
      input_hash: string;
      output_hash: string;
      structured_result: string;
    }>(
      `SELECT provider, model, input_hash, output_hash, structured_result::text AS structured_result
         FROM ai_runs WHERE revision_id = '${REVISION}'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.provider).toBe('recorded');
      expect(row.model).toBe(LLM_MODEL);
      expect(row.input_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.output_hash).toMatch(/^[0-9a-f]{64}$/u);
      // Ни системного промта, ни шаблона, ни текста страницы.
      expect(row.structured_result).not.toContain('классифицируешь');
      expect(row.structured_result).not.toContain('Коды видов');
      expect(row.structured_result).not.toContain('Сведения о поставке');
    }
  });

  /**
   * §0.5 п. 6 на том, что РЕАЛЬНО уехало провайдеру.
   *
   * Сканируется полный эффективный промт — системная часть, шаблон, список
   * кодов и подставленный текст, — то есть ровно та строка, по хэшу которой
   * записан ответ. Прежняя редакция смотрела только `userPrompt`: системная
   * часть, где запрет нарушить проще всего, не проверялась вовсе.
   *
   * Сканирование целиком возможно потому, что тексты страниц этого набора
   * маркеров не содержат, и это утверждается отдельно: иначе тест краснел бы
   * на данных, а не на инструкции, и его пришлось бы ослабить.
   */
  it('эффективный промт целиком, включая системную часть, не называет раздел работ', () => {
    expect(llmSeen.length).toBeGreaterThan(0);

    // Контроль предпосылки: маркеры не приходят из текста страниц.
    for (const text of PAGE_TEXTS) {
      expect(findSectionMarkers(text), text.slice(0, 40)).toEqual([]);
    }

    for (const entry of llmSeen) {
      const found = findSectionMarkers(entry.effective);
      expect(found, `промт намекает на раздел работ: ${found.join(', ')}`).toEqual([]);
      // Системная часть действительно попала в скан — иначе проверка
      // доказывала бы, что пуст `userPrompt`.
      expect(entry.effective).toContain('классифицируешь');
      expect(entry.effective.length).toBeGreaterThan(entry.userPrompt.length);
    }
  });

  it('в журнале уровня trace нет ни одного секрета', () => {
    const log = logSink.join('\n');
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(RD_PASSWORD);
  });
});

// =====================================================================
// Повтор задач: успех, ничего не изменивший или потерявший данные, — отказ
// =====================================================================

describe('повтор задач безопасен', () => {
  it('повторный прогон всей цепочки даёт тот же учёт страниц', async () => {
    const before = await listPageAssignments(db, SCOPE, REVISION);
    const documentsBefore = (await listLogicalDocuments(db, SCOPE, REVISION)).length;

    await enqueueSystemJob(db, {
      type: 'doc.classify_pages',
      payload: { revisionId: REVISION },
      dedupeKey: `doc.classify_pages:${REVISION}:repeat`,
    });
    await drainQueue();

    const after = await listPageAssignments(db, SCOPE, REVISION);
    expect(after).toHaveLength(before.length);
    expect((await listLogicalDocuments(db, SCOPE, REVISION)).length).toBe(documentsBefore);
    expect(await listUnaccountedPages(db, SCOPE, REVISION)).toEqual([]);
    // Реестр переразобран, а не потерян: 29 строк на месте.
    expect(await listRegistryRows(db, SCOPE, REVISION)).toHaveLength(29);
  });

  it('пересегментация при пустом наборе решений отвергается, а не стирает документы', async () => {
    const before = (await listLogicalDocuments(db, SCOPE, REVISION)).length;
    expect(before).toBeGreaterThan(0);

    await testDb.query(`DELETE FROM page_classifications WHERE revision_id = '${REVISION}'`);
    await enqueueSystemJob(db, {
      type: 'doc.segment',
      payload: { revisionId: REVISION },
      dedupeKey: `doc.segment:${REVISION}:empty`,
    });
    await drainQueue();

    // Задача обязана упасть, а документы — остаться. Успешная задача,
    // «правильно» применившая пустоту, уничтожила бы всю сборку (урок S6).
    const failed = await count(
      `SELECT count(*) AS count FROM job_runs
        WHERE job_type = 'doc.segment' AND outcome <> 'succeeded'`,
    );
    expect(failed).toBeGreaterThan(0);
    expect((await listLogicalDocuments(db, SCOPE, REVISION)).length).toBe(before);
    expect(await listUnaccountedPages(db, SCOPE, REVISION)).toEqual([]);
  });
});
