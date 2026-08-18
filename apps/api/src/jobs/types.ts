/**
 * Каталог типов фоновых задач и их payload (§12).
 *
 * Одно определение на тип задачи, и в нём собрано всё, что о задаче должны
 * одинаково знать три разных места: постановщик (роут или другая задача),
 * исполнитель (воркер) и консоль администратора. Разнесённые по этим местам
 * очередь, число попыток и форма payload разъехались бы молча — постановщик
 * положил бы в payload одно поле, обработчик прочитал бы другое, и обнаружилось
 * бы это на первой поставке, а не на типах.
 *
 * ## Почему очередь выводится из типа, а не хранится колонкой
 *
 * В `jobs` колонки `queue` нет (миграция 0007), и добавлять её незачем: очередь
 * — это свойство того, чем задача занята, а не строки в таблице. Хранимое поле
 * пришлось бы поддерживать в согласии с этим файлом, то есть завести второй
 * источник правды. Захват фильтрует по списку типов очереди
 * (`jobTypesOfQueue()`), и индекс `ix_jobs_claim` этому не мешает.
 *
 * ## Как распределены очереди (§12: io 4–8, cpu 1–2, llm 2–4)
 *
 * `cpu` — задачи, которые СЧИТАЮТ в процессе и держат файл в памяти: сборка
 * рабочего PDF, нарезка, превью, разбор загруженного файла. Их параллелизм
 * низкий именно из-за памяти: 86 МБ комплект в pdf-lib даёт 300+ МБ heap
 * (ADR-0003), и четыре таких задачи разом — это OOM на одной VPS.
 *
 * `io` — задачи, время которых уходит на ОЖИДАНИЕ: вызовы RD WEB, S3 и запросы
 * к БД. Сюда же отнесены короткие сводные задачи (`graph.build`, `checks.*`,
 * `doc.parse_registry`): их длительность — это round-trip'ы к PostgreSQL, а не
 * счёт, и ставить их в очередь с параллелизмом 2 значило бы держать конвейер за
 * сборкой чужого PDF.
 *
 * `llm` — вызовы модели. Отдельная очередь нужна не из-за ресурсов портала, а
 * из-за бюджета и rate limit провайдера (§10).
 */
import { z } from 'zod';
import { type ProcessingStage } from '@id/contracts';

// =====================================================================
// Очереди
// =====================================================================

export const JOB_QUEUES = ['io', 'cpu', 'llm'] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

/**
 * Диапазоны параллелизма из §12 и значение по умолчанию.
 *
 * Диапазон хранится рядом со значением намеренно: настройка воркера обязана
 * проверяться против плана, а не «сколько поставили». `clampConcurrency()`
 * не даёт выйти за границы, иначе одна переменная окружения превратила бы
 * `cpu` в четыре параллельных qpdf.
 */
export const QUEUE_CONCURRENCY: Readonly<
  Record<JobQueue, { readonly min: number; readonly max: number; readonly default: number }>
> = {
  io: { min: 4, max: 8, default: 6 },
  cpu: { min: 1, max: 2, default: 2 },
  llm: { min: 2, max: 4, default: 3 },
};

export function clampConcurrency(queue: JobQueue, requested: number | undefined): number {
  const range = QUEUE_CONCURRENCY[queue];
  if (requested === undefined || !Number.isFinite(requested)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.trunc(requested)));
}

// =====================================================================
// Payload
// =====================================================================

/**
 * Общая часть payload любой задачи.
 *
 * `request_id` — сквозной идентификатор (§11), и ключ именно в snake_case:
 * его кладёт `tracePayload()` из слоя наблюдаемости, а воркер поднимает
 * контекст `requestIdFromPayload()`. Второе написание ключа означало бы
 * оборванную цепочку «HTTP → job → вызов RD WEB», причём молча.
 */
const basePayload = z.object({
  request_id: z.string().min(1).max(128).optional(),
});

const uuid = z.uuid();

/** Задача, работающая над ревизией поставки. Таких — большинство. */
const revisionPayload = basePayload.extend({ revisionId: uuid });

const filePayload = revisionPayload.extend({ sourceFileId: uuid });

/**
 * Задачи разметки 4–6 и 9: рабочий документ И ревизия разметки.
 *
 * `layoutRevisionId` обязателен, хотя «текущий черновик этого bundle» найти
 * можно и без него. Нельзя: черновик у поставки один, но за время жизни
 * поставки их сменяется несколько (заморозка №1 → создание №2), и задача,
 * поставленная для первой ревизии, отработала бы по второй, выдав диагностику,
 * противоположную факту. Цель обязана адресоваться явно — так же, как её уже
 * адресуют задачи 7 и 8.
 */
const markupPayload = revisionPayload.extend({
  bundleId: uuid,
  layoutRevisionId: uuid,
});

const layoutPayload = revisionPayload.extend({
  layoutRevisionId: uuid,
  /**
   * Страницы пачкой: детекция у RD WEB синхронная и постраничная (§5.2, п.3),
   * поэтому одна задача = одна пачка, а не весь комплект.
   */
  pageIndices: z.array(z.int().nonnegative()).min(1).max(20).optional(),
  /**
   * Перезаписать уже размеченные страницы (§5.3, «повторить детекцию»).
   *
   * Ставится ТОЛЬКО явным действием пользователя (`POST /layouts/{id}/detect`).
   * Первичная цепочка «Разметить файл» его не ставит: автоматическая
   * переразметка не имеет права стирать сделанное. Без флага удалённая сторона
   * возвращает такие страницы в `skipped_pages`, и импорт их не трогает.
   */
  overwriteExisting: z.boolean().optional(),
});

const recognitionPayload = revisionPayload.extend({ recognitionRunId: uuid });

/** Обслуживание: ревизии у такой задачи нет, и это не упущение payload. */
const maintenancePayload = basePayload.extend({
  /** Ограничение объёма одного прохода: сборка мусора не должна идти часами. */
  batchLimit: z.int().positive().max(10_000).optional(),
});

// =====================================================================
// Определения задач
// =====================================================================

export interface JobDefinition<TPayload extends z.ZodType = z.ZodType> {
  readonly queue: JobQueue;
  readonly payload: TPayload;
  /**
   * Стадия конвейера для вычисляемого `processing_status` (§3.8).
   *
   * `null` — обслуживающая задача: она не относится к поставке, и включать её
   * в сводку по ревизии нельзя.
   */
  readonly stage: ProcessingStage | null;
  readonly maxAttempts: number;
  /**
   * Аренда: сколько задача может выполняться без продления, прежде чем reaper
   * сочтёт воркера мёртвым. Продлевается сердцебиением (`runner.ts`), поэтому
   * значение — это не «сколько задача идёт», а «через сколько после смерти
   * воркера её подберут заново».
   */
  readonly leaseMs: number;
  /** Больше — раньше в очереди. Совпадает с `jobs.priority`. */
  readonly priority: number;
}

const DEFAULT_LEASE_MS = 60_000;
/** Внешний вызов может ждать минутами, и сердцебиение не должно быть единственной защитой. */
const EXTERNAL_LEASE_MS = 180_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PRIORITY = 100;

/**
 * Полный список задач §12 в порядке конвейера.
 *
 * Тип объявлен здесь даже тогда, когда обработчика ещё нет (он появится на
 * своём этапе): отсутствие обработчика — это отказ конкретной задачи с внятным
 * классом ошибки, а отсутствие типа — расхождение постановщика и исполнителя,
 * которое типами уже не ловится.
 */
export const JOB_DEFINITIONS = {
  // 1–3. Приём файлов и сборка рабочего документа (§4.2, §3.3).
  'file.verify': {
    queue: 'cpu',
    payload: filePayload,
    stage: 'uploaded',
    maxAttempts: 3,
    leaseMs: 300_000,
    priority: 200,
  },
  'file.signature_probe': {
    queue: 'cpu',
    payload: filePayload,
    stage: 'uploaded',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: 150,
  },
  'bundle.build': {
    queue: 'cpu',
    payload: revisionPayload,
    stage: 'uploaded',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: 150,
  },

  // 4–9. Разметка (§6.1).
  'rd.create_run_document': {
    queue: 'io',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'rd.upload_working_pdf': {
    queue: 'io',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },
  'rd.wait_pages': {
    queue: 'io',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: 30,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'layout.detect_pages': {
    queue: 'io',
    payload: layoutPayload,
    stage: 'layout',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'layout.analyze_coverage': {
    queue: 'io',
    payload: layoutPayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'preview.cache_pages': {
    queue: 'cpu',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: 600_000,
    // Ниже остальных: превью — ускорение экрана, а не условие продолжения.
    priority: 50,
  },

  // 10–13. Распознавание (§5.2, §6.2).
  'layout.reconcile': {
    queue: 'io',
    payload: layoutPayload,
    stage: 'recognition',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'rd.start_recognition': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    // Повтор старта OCR — это второй прогон на GPU. Единственная попытка:
    // неуспех обязан разбираться человеком, а не переигрываться автоматом.
    maxAttempts: 1,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'rd.poll_recognition': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: 60,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'rd.fetch_export_once': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },

  // 14–19. Сегментация и извлечение (§8).
  'doc.classify_pages': {
    queue: 'llm',
    payload: revisionPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'doc.segment': {
    queue: 'llm',
    payload: revisionPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'doc.extract_fields': {
    queue: 'llm',
    payload: revisionPayload.extend({ documentId: uuid.optional() }),
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'doc.parse_registry': {
    queue: 'io',
    payload: revisionPayload.extend({ documentId: uuid.optional() }),
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'doc.match_registry': {
    queue: 'io',
    payload: revisionPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'graph.build': {
    queue: 'io',
    payload: revisionPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },

  // 20–23. Проверки и выдача (§9, §10 плана: нарезка после подтверждения границ).
  'checks.run': {
    queue: 'io',
    payload: revisionPayload.extend({ validationRunId: uuid.optional() }),
    stage: 'checks',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'checks.summarize': {
    queue: 'io',
    payload: revisionPayload.extend({ validationRunId: uuid }),
    stage: 'checks',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'doc.materialize_pdf': {
    queue: 'cpu',
    payload: revisionPayload.extend({ documentId: uuid.optional() }),
    stage: 'ready',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },
  'submission.build_archive': {
    queue: 'cpu',
    payload: revisionPayload,
    stage: 'ready',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },

  // 24–25. Обслуживание.
  'jobs.reaper': {
    queue: 'io',
    payload: maintenancePayload,
    stage: null,
    maxAttempts: 1000,
    leaseMs: DEFAULT_LEASE_MS,
    // Выше всех: освобождение зависших аренд — условие работы остальных.
    priority: 500,
  },
  'storage.gc': {
    queue: 'io',
    payload: maintenancePayload,
    stage: null,
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: 10,
  },
} as const satisfies Record<string, JobDefinition>;

export type JobType = keyof typeof JOB_DEFINITIONS;

export const JOB_TYPES = Object.keys(JOB_DEFINITIONS) as readonly JobType[];

/** Типизованный payload по типу задачи: обработчик получает разобранное значение. */
export type JobPayloadMap = {
  [K in JobType]: z.infer<(typeof JOB_DEFINITIONS)[K]['payload']>;
};

export type JobPayload<K extends JobType = JobType> = JobPayloadMap[K];

/** Payload любой задачи в виде, пригодном для чтения общим кодом. */
export type AnyJobPayload = Record<string, unknown> & {
  readonly request_id?: string;
  readonly revisionId?: string;
};

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && Object.hasOwn(JOB_DEFINITIONS, value);
}

export function jobDefinition<K extends JobType>(type: K): (typeof JOB_DEFINITIONS)[K] {
  return JOB_DEFINITIONS[type];
}

export function queueOf(type: JobType): JobQueue {
  return JOB_DEFINITIONS[type].queue;
}

export function stageOf(type: JobType): ProcessingStage | null {
  return JOB_DEFINITIONS[type].stage;
}

export function jobTypesOfQueue(queue: JobQueue): readonly JobType[] {
  return JOB_TYPES.filter((type) => JOB_DEFINITIONS[type].queue === queue);
}

/**
 * Разбор payload по схеме типа.
 *
 * Возвращает результат, а не бросает: непригодный payload — это дефект
 * постановщика, и задача обязана уйти в dead с внятным сообщением, а не
 * повторяться пять раз с одинаковым исходом.
 */
export function parseJobPayload<K extends JobType>(
  type: K,
  raw: unknown,
): { ok: true; payload: JobPayloadMap[K] } | { ok: false; problems: string[] } {
  const parsed = JOB_DEFINITIONS[type].payload.safeParse(raw);
  if (parsed.success) return { ok: true, payload: parsed.data as JobPayloadMap[K] };
  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`,
    ),
  };
}

/** Ревизия из payload, если задача к ней относится. Нужна и `job_runs`, и контексту. */
export function revisionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as { revisionId?: unknown }).revisionId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// =====================================================================
// Идемпотентность и отпечаток payload
// =====================================================================

/**
 * Ключ дедупликации (§12).
 *
 * Частичный уникальный индекс `ux_jobs_dedupe_key` действует, пока задача не
 * завершена, поэтому ключ отвечает на вопрос «эта работа уже поставлена?», а не
 * «эта работа когда-либо выполнялась?». Второй вопрос решается состоянием
 * домена (bundle собран, файл проверен), а не очередью: иначе повторная подача
 * после возврата ревизии не запустила бы конвейер.
 *
 * Части ключа склеиваются через `:` и сам тип идёт первым — ключ читается
 * глазами в консоли задач, и «чей это ключ» не должно требовать запроса.
 */
export function dedupeKeyFor(type: JobType, ...parts: readonly string[]): string {
  return [type, ...parts].join(':');
}

/**
 * Отпечаток payload для `job_runs.payload_digest` НЕ считается здесь.
 *
 * Он вычисляется в SQL прямо в операторе захвата (`claimJobs`): `jsonb` хранится
 * с нормализованным порядком ключей, поэтому `payload::text` канонический, а
 * подсчёт на стороне Node потребовал бы второго round-trip'а между захватом
 * задачи и записью попытки — то есть окна, в котором попытка идёт, а строки
 * `job_runs` о ней нет.
 */

// =====================================================================
// Повторы
// =====================================================================

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly factor: number;
  readonly capMs: number;
  /** Доля случайного разброса: 0.2 — ±20%. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 5_000,
  factor: 2,
  capMs: 600_000,
  jitter: 0.2,
};

/**
 * Задержка перед следующей попыткой: экспонента с потолком и разбросом (§12).
 *
 * Потолок обязателен: без него шестая попытка ушла бы на часы, и падение
 * внешнего сервиса на минуту стоило бы поставке половины дня. Разброс — чтобы
 * сотня задач, упавших от одного сбоя RD WEB, не пошла в повтор одной секундой.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(policy.capMs, policy.baseMs * Math.pow(policy.factor, exponent));
  const spread = raw * policy.jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(raw + delta));
}
