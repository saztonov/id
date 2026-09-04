/**
 * Порт RD WEB: контракт снимка исполнительной документации (document-sync v1).
 *
 * Методы повторяют ШАГИ контракта (§3), а не маршруты: `initSync` — это «объяви
 * снимок», а не «дёрни /document-syncs/init». Тот же принцип держал прежний порт
 * этой интеграции, и он оправдал себя ровно один раз — когда контракт сменился
 * целиком: домен обязан пережить смену чужого API, а не переписываться вместе с
 * ним.
 *
 * ## Чего в порту намеренно НЕТ
 *
 * Ни выбора модели, ни промт-профиля, ни кропов. §1 контракта относит всё это к
 * зоне ответственности RD WEB: «качество распознавания зависит от того, как
 * именно построен вырез, и разделять это решение между двумя системами означало
 * бы, что за результат не отвечает никто». Поле, которое мы не вправе заполнять,
 * в интерфейсе выглядело бы обещанием.
 *
 * Нет и сборки манифеста: тело и его `manifest_sha256` приходят готовыми из
 * `@id/execsync`. Иначе канонический хеш §13 нельзя было бы проверить
 * эталонными примерами, не поднимая сервер.
 */
import type { Readable } from 'node:stream';

import type { ExecSyncSnapshotBody } from '@id/execsync';

/** Состояния синхронизации (§11). Строка, а не enum: перечень не наш. */
export type ExecSyncState = string;

/**
 * Терминальные состояния отправки (§11).
 *
 * `superseded` здесь ЕСТЬ, и это не ошибка: отправка кончилась, просто не
 * успехом. Различие между «кончилась» и «кончилась хорошо» выражают два разных
 * множества — их же различают `all_terminal` и `all_successful` в ответе.
 */
export const TERMINAL_SYNC_STATES: ReadonlySet<string> = new Set([
  'completed',
  'completed_with_issues',
  'superseded',
  'canceled',
  'error',
]);

/** Успешные состояния отправки: только по ним забираются результаты. */
export const SUCCESSFUL_SYNC_STATES: ReadonlySet<string> = new Set([
  'completed',
  'completed_with_issues',
]);

/**
 * Статусы блока, считающиеся успехом (§11).
 *
 * `suspicious` в множество НЕ входит — контракт говорит об этом прямо:
 * «результат получен, но не подтверждён». Текст мы всё равно публикуем (потерять
 * распознанное хуже, чем показать сомнительное с пометкой), но считать его
 * успехом нельзя, иначе счётчик «распознано» перестанет значить распознанное.
 */
export const SUCCESSFUL_BLOCK_STATUSES: ReadonlySet<string> = new Set([
  'success',
  'reused',
  'unchanged',
  'deleted',
]);

export interface ExecUploadTicket {
  readonly method: 'PUT';
  readonly url: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
  /** Секунд до протухания ссылки. По умолчанию контракта — час. */
  readonly expiresIn: number;
}

export interface InitSyncResult {
  readonly syncId: string;
  /** Тот же `external_sync_id` с тем же содержимым уже принимался (§9). */
  readonly duplicate: boolean;
  /** `false` — файл узнан по sha256, шаг загрузки пропускается (§3). */
  readonly uploadRequired: boolean;
  readonly state: ExecSyncState;
  readonly upload: ExecUploadTicket | null;
}

export interface UploadDocumentInput {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Фабрика потока, а не буфер: 86 МБ не поднимаются в память. */
  readonly body: () => Readable;
  readonly sizeBytes: number;
}

export interface ExecSyncStatus {
  readonly syncId: string;
  readonly state: ExecSyncState;
  /** «Работа закончилась». НЕ признак успеха — см. `allSuccessful` (§14). */
  readonly allTerminal: boolean;
  /** «Закончилась хорошо». Другой флаг, и путать их запрещает §17 п. 7. */
  readonly allSuccessful: boolean;
  readonly counters: Readonly<Record<string, number>>;
}

/** Строка результата блока (§14). */
export interface ExecBlockResultRow {
  readonly externalBlockId: string;
  readonly externalBlockRevision: number;
  readonly status: string;
  readonly isDeleted: boolean;
  readonly reconciliationAction: string | null;
  readonly reconciliationReason: readonly string[];
  readonly reusedWithoutModel: boolean;
  readonly ocrMarkdown: string | null;
  readonly ocrText: string | null;
  readonly ocrJson: unknown;
  readonly resultStatus: string | null;
  readonly updatedAt: string | null;
}

export interface ExecBlockResultsPage {
  readonly items: readonly ExecBlockResultRow[];
  readonly nextCursor: string | null;
}

export interface ExecSyncPort {
  /** Шаг 1: объявить снимок. Тело и хеш собраны вызывающим. */
  initSync(body: ExecSyncSnapshotBody, manifestSha256: string): Promise<InitSyncResult>;
  /** Шаг 2: загрузка PDF по выданному талону. Пропускается при `uploadRequired: false`. */
  uploadDocument(input: UploadDocumentInput): Promise<void>;
  /** Шаг 3: завершить отправку. Идемпотентен по контракту. */
  completeSync(syncId: string): Promise<void>;
  /** Шаг 4: состояние отправки. */
  readSync(syncId: string): Promise<ExecSyncStatus>;
  /** Шаг 5: результаты по блокам документа, постранично. */
  readDocumentBlocks(externalDocumentId: string, cursor?: string): Promise<ExecBlockResultsPage>;
}

/**
 * Виды конфликта §9 — единственный класс отказа, на который правильный ответ
 * не «повторить», а «пересобрать снимок» (§17 п. 6).
 */
export type ExecConflictKind =
  'sync_identity' | 'generation' | 'stale_generation' | 'stale_base_generation' | 'block_revision';

const CONFLICT_BY_CODE: Readonly<Record<string, ExecConflictKind>> = {
  sync_identity_conflict: 'sync_identity',
  generation_conflict: 'generation',
  stale_generation: 'stale_generation',
  stale_base_generation: 'stale_base_generation',
  block_revision_conflict: 'block_revision',
};

/**
 * Отказ RD WEB с сохранённым кодом контракта.
 *
 * Три производных признака вместо одного, потому что ответов ровно три и они
 * разные: повторить (429, 5xx, сеть), сдаться с внятной причиной (прочие 4xx) и
 * пересобрать снимок (409). Слив последний с первыми двумя, портал либо крутил
 * бы бесконечный повтор запроса, который контракт повторять запрещает, либо
 * объявлял бы отказом ситуацию, которая лечится сама.
 */
export class ExecSyncError extends Error {
  readonly status: number | undefined;
  readonly code: string | null;
  readonly operation: string;
  /** `Retry-After` их стороны в миллисекундах, если назван. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: {
      readonly status?: number | undefined;
      readonly code?: string | null | undefined;
      readonly operation: string;
      readonly retryAfterMs?: number | undefined;
    },
  ) {
    super(message);
    this.name = 'ExecSyncError';
    this.status = options.status;
    this.code = options.code ?? null;
    this.operation = options.operation;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Конфликт §9, если это он. Читается движком задач раньше `retriable`. */
  get conflict(): ExecConflictKind | null {
    if (this.status !== 409) return null;
    const code = this.code;
    if (code !== null && Object.hasOwn(CONFLICT_BY_CODE, code)) {
      return CONFLICT_BY_CODE[code] as ExecConflictKind;
    }
    // 409 с неизвестным кодом — всё равно конфликт: повторять его нельзя.
    return 'generation';
  }

  /**
   * Стоит ли повторять ТОТ ЖЕ запрос.
   *
   * Читается движком задач по форме (`classifyFailure` смотрит на свойство, а
   * не на класс) — так же, как у `LlmError`, и по той же причине: `instanceof`
   * не переживает границу пакетов.
   */
  get retriable(): boolean {
    if (this.status === undefined) return true; // сеть или таймаут
    if (this.status === 429) return true;
    return this.status >= 500;
  }

  /** Отказ по существу запроса: повтор даст тот же ответ. */
  get permanent(): boolean {
    return !this.retriable && this.conflict === null;
  }
}
