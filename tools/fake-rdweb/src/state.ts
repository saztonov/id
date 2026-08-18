/**
 * Состояние офлайн-двойника RD WEB: типы контрактов и хранилище в памяти.
 *
 * Всё живёт в процессе теста и умирает вместе с сервером — двойник существует ради
 * воспроизводимости, а не ради долговечности. Имена полей в DTO — snake_case, потому
 * что это ПРОВОДНОЙ формат legacy-API (FastAPI/pydantic), и переименование здесь
 * сделало бы двойник негодным для проверки адаптера.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Перечисления домена (значения — из services/web_ocr/domain/enums.py)
// ---------------------------------------------------------------------------

export type BlockTypeName = 'text' | 'image' | 'stamp';
export type ShapeTypeName = 'rectangle' | 'polygon';
export type BlockSourceName = 'user' | 'auto';
export type BlockStatusName =
  'draft' | 'queued' | 'recognizing' | 'refining' | 'recognized' | 'failed' | 'non_retriable';
export type RenderStatusName = 'pending' | 'rendering' | 'ready' | 'error';
export type DocumentStatusName = 'uploaded' | 'rendering' | 'ready' | 'error';
export type NodeTypeName =
  'folder' | 'client' | 'project' | 'section' | 'stage' | 'task' | 'document';
export type JobScopeName = 'selected' | 'all' | 'unrecognized' | 'failed';
export type JobStatusName =
  | 'pending'
  | 'running'
  | 'refining'
  | 'verifying'
  | 'finalizing'
  | 'done'
  | 'completed_with_warnings'
  | 'failed'
  | 'canceled'
  | 'paused';

// ---------------------------------------------------------------------------
// DTO ответов (форма — из routes/_*_schemas.py)
// ---------------------------------------------------------------------------

/** `_blocks_schemas.BlockOut`. */
export interface BlockOut {
  block_id: string;
  project_id: string;
  document_id: string;
  page_index: number;
  sort_order: number | null;
  block_type: BlockTypeName;
  shape_type: ShapeTypeName;
  coords_norm: number[];
  coords_px: number[] | null;
  polygon_points: number[][] | null;
  status: BlockStatusName;
  active_result_id: string | null;
  linked_block_id: string | null;
  source: BlockSourceName;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  client_id: string | null;
}

/** `_documents_schemas.PageOut`. */
export interface PageOut {
  page_index: number;
  width_px: number | null;
  height_px: number | null;
  rotation: number | null;
  render_status: RenderStatusName;
  has_preview: boolean;
}

/** `services/counters.DocumentCounters`. */
export interface DocumentCounters {
  blocks: number;
  recognized: number;
  errors: number;
}

/** `_projects_schemas.TreeItemOut` — узел дерева либо документ-лист. */
export interface TreeItemOut {
  kind: 'node' | 'document';
  node_id: string;
  project_id: string;
  parent_id: string | null;
  node_type: string;
  name: string;
  code: string | null;
  path: string | null;
  depth: number | null;
  sort_order: number | null;
  status: string | null;
  attributes: unknown;
  document_id: string | null;
  document_status: string | null;
  page_count: number | null;
  project_version: string | null;
  counters: DocumentCounters | null;
  verification: null;
  recognizing: boolean;
  is_done: boolean;
  done_at: string | null;
  done_by_email: string | null;
  created_at: string;
  updated_at: string;
}

/** `_recognition_job_schemas.JobOut` (поля, которые двойник действительно ведёт). */
export interface JobOut {
  job_id: string;
  project_id: string;
  document_id: string;
  scope: JobScopeName;
  status: JobStatusName;
  priority: number;
  total_blocks: number;
  queued_blocks: number;
  running_blocks: number;
  recognized_blocks: number;
  failed_blocks: number;
  non_retriable_blocks: number;
  settings: unknown;
  created_by: string;
  created_by_email: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  error_message: string | null;
  has_export: boolean;
  document_name: string | null;
  page_count: number | null;
  processing_ms: number | null;
}

// ---------------------------------------------------------------------------
// Внутренние записи хранилища
// ---------------------------------------------------------------------------

export interface UserRecord {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
  readonly systemRole: 'user' | 'admin';
}

export interface AccessTokenRecord {
  readonly userId: string;
  readonly sessionId: string;
  /** Поколение токенов: `expireTokens()` двигает его и разом обесценивает все выданные. */
  readonly epoch: number;
  readonly expiresAtMs: number;
}

export interface RefreshTokenRecord {
  readonly userId: string;
  readonly sessionId: string;
}

export interface NodeRecord {
  nodeId: string;
  projectId: string;
  parentId: string | null;
  nodeType: NodeTypeName;
  name: string;
  code: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  attributes: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord {
  documentId: string;
  projectId: string;
  nodeId: string;
  fileName: string;
  projectVersion: string;
  s3Key: string;
  status: DocumentStatusName;
  sizeBytes: number;
  bytes: Buffer | null;
  sha256: string | null;
  pageCount: number | null;
  /** Сколько раз документ уже читали через `GET /api/documents/{id}` (модель рендера). */
  detailPolls: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobRecord {
  jobId: string;
  projectId: string;
  documentId: string;
  scope: JobScopeName;
  priority: number;
  settings: unknown;
  blockIds: string[];
  createdBy: string;
  createdAt: string;
  /** Сколько раз job уже читали через `GET /api/jobs/{id}` (модель прогресса). */
  polls: number;
}

export interface UploadTokenRecord {
  readonly documentId: string;
  used: boolean;
}

/** Одно принятое обращение — журнал для проверки сквозного `x-request-id`. */
export interface FakeRdWebCall {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly requestId: string | null;
  readonly at: string;
}

/** Запрограммированный отказ следующего обращения к эндпоинту (проверка повторов). */
export interface PendingFailure {
  readonly pathFragment: string;
  readonly status: number;
  readonly detail: string;
}

export interface DocumentSnapshot {
  readonly documentId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly fileName: string;
  readonly pageCount: number | null;
  readonly status: DocumentStatusName;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface NodeSnapshot {
  readonly nodeId: string;
  readonly projectId: string;
  readonly parentId: string | null;
  readonly nodeType: NodeTypeName;
  readonly name: string;
  readonly path: string;
  readonly depth: number;
}

export interface FakeRdWebSnapshot {
  readonly documents: readonly DocumentSnapshot[];
  readonly blocks: readonly BlockOut[];
  readonly nodes: readonly NodeSnapshot[];
}

// ---------------------------------------------------------------------------
// Константы, повторяющие настройки legacy-сервиса
// ---------------------------------------------------------------------------

/** `settings.upload.max_pdf_bytes` (500 МБ). */
export const MAX_PDF_BYTES = 500 * 1024 * 1024;
/** `settings.upload.presign_ttl_sec`. */
export const PRESIGN_TTL_SEC = 900;
/** Размер страницы A4 при 200 dpi — двойник не растеризует и отдаёт фиксированный. */
export const PAGE_WIDTH_PX = 1654;
export const PAGE_HEIGHT_PX = 2339;
/** Единственный преднастроенный проект двойника. */
export const PORTAL_PROJECT_ID = 'prj-portal';
export const PORTAL_PROJECT_NAME = 'Портал ИД';
export const PORTAL_TENANT_ID = 'tenant-portal';

const UNSAFE_NAME_RE = /[\p{Cc}/\\:*?"<>|]/gu;
const FALLBACK_FILE_NAME = 'document.pdf';

/** Упрощённый аналог `storage.keys.sanitize_file_name`: только basename и только `.pdf`. */
export function sanitizeFileName(name: string): string {
  const base = (name || '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base
    .replace(/\s+/g, '_')
    .replace(UNSAFE_NAME_RE, '')
    .replace(/^[._]+/, '');
  if (cleaned.length === 0 || !cleaned.toLowerCase().endsWith('.pdf')) {
    return FALLBACK_FILE_NAME;
  }
  return cleaned.slice(0, 200);
}

/** `storage.keys.original_pdf_key`. */
export function originalPdfKey(projectId: string, documentId: string, fileName: string): string {
  return `projects/${projectId}/documents/${documentId}/original/${sanitizeFileName(fileName)}`;
}

// ---------------------------------------------------------------------------
// Хранилище
// ---------------------------------------------------------------------------

/**
 * Всё состояние одного запущенного двойника.
 *
 * Идентификаторы выдаются счётчиком, а не случайно: воспроизводимый прогон легче
 * читать в логах, а требования уникальности внутри одного процесса счётчику
 * достаточно. Формат `prefix_hex` совпадает с `core.ids.new_id`.
 */
export class FakeState {
  readonly users = new Map<string, UserRecord>();
  readonly accessTokens = new Map<string, AccessTokenRecord>();
  readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  readonly nodes = new Map<string, NodeRecord>();
  readonly documents = new Map<string, DocumentRecord>();
  readonly blocks = new Map<string, BlockOut>();
  readonly jobs = new Map<string, JobRecord>();
  readonly uploadTokens = new Map<string, UploadTokenRecord>();
  readonly calls: FakeRdWebCall[] = [];
  readonly failures: PendingFailure[] = [];

  tokenEpoch = 0;
  private seq = 0;

  constructor(
    readonly renderDelayPolls: number,
    readonly maxPagesPerDetectCall: number,
    readonly accessTtlSec: number,
  ) {}

  /** Идентификатор вида `doc_<hex>` — как `core.ids.new_id`, но детерминированный. */
  newId(prefix: string): string {
    this.seq += 1;
    const digest = createHash('sha256').update(`${prefix}:${this.seq}`).digest('hex');
    return `${prefix}_${digest.slice(0, 32)}`;
  }

  now(): string {
    return new Date().toISOString();
  }

  /** Все блоки документа (опционально одной страницы) в UI-порядке группы. */
  blocksOf(documentId: string, pageIndex?: number): BlockOut[] {
    const rows = [...this.blocks.values()].filter(
      (b) =>
        b.document_id === documentId && (pageIndex === undefined || b.page_index === pageIndex),
    );
    return rows.sort(
      (a, b) =>
        a.page_index - b.page_index ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.block_id.localeCompare(b.block_id),
    );
  }

  /**
   * Следующий `sort_order` в группе «страница + тип» — как `_next_sort_order`.
   *
   * Группа именно по типу: у legacy-порядка блоков ось «страница × block_type», и
   * общий счётчик по странице дал бы другой порядок в UI.
   */
  nextSortOrder(documentId: string, pageIndex: number, blockType: BlockTypeName): number {
    const group = this.blocksOf(documentId, pageIndex).filter((b) => b.block_type === blockType);
    if (group.length === 0) {
      return 0;
    }
    return Math.max(...group.map((b, index) => b.sort_order ?? index)) + 1;
  }

  counters(documentId: string): DocumentCounters {
    const rows = this.blocksOf(documentId);
    return {
      blocks: rows.length,
      recognized: rows.filter((b) => b.status === 'recognized').length,
      errors: rows.filter((b) => b.status === 'failed' || b.status === 'non_retriable').length,
    };
  }

  /** Страницы документа: до готовности рендера их нет вовсе (как у пустого `document_pages`). */
  pagesOf(document: DocumentRecord): PageOut[] {
    if (document.status !== 'ready' || document.pageCount === null) {
      return [];
    }
    return Array.from({ length: document.pageCount }, (_unused, index) => ({
      page_index: index,
      width_px: PAGE_WIDTH_PX,
      height_px: PAGE_HEIGHT_PX,
      rotation: 0,
      render_status: 'ready' as const,
      has_preview: true,
    }));
  }

  snapshot(): FakeRdWebSnapshot {
    return {
      documents: [...this.documents.values()].map((d) => ({
        documentId: d.documentId,
        projectId: d.projectId,
        nodeId: d.nodeId,
        fileName: d.fileName,
        pageCount: d.pageCount,
        status: d.status,
        sizeBytes: d.sizeBytes,
        ...(d.sha256 === null ? {} : { sha256: d.sha256 }),
      })),
      blocks: [...this.blocks.values()].map((b) => ({ ...b })),
      nodes: [...this.nodes.values()].map((n) => ({
        nodeId: n.nodeId,
        projectId: n.projectId,
        parentId: n.parentId,
        nodeType: n.nodeType,
        name: n.name,
        path: n.path,
        depth: n.depth,
      })),
    };
  }
}
