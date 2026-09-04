/**
 * Адаптер порта на сегодняшние маршруты контура `/api/executive/v1`.
 *
 * Разбор ответов терпимый к незнакомым полям и строгий к знакомым: чужая
 * сторона вправе добавить поле, и падать из-за этого нельзя (§0.5 портала —
 * незнакомое обязано обрабатываться, а не проваливаться), но если поле, на
 * котором держится решение, пришло не того типа — это отказ, а не догадка.
 *
 * Постраничность результатов блоков поддержана в обеих формах, потому что §14
 * называет курсор только у `/plan`, а у `/blocks` о нём молчит. Ответ-массив и
 * ответ-объект с `items`/`next_cursor` разбираются одинаково: цена поддержки —
 * десять строк, цена ошибки — молча прочитанная первая страница из пяти.
 */
import type { ExecSyncSnapshotBody } from '@id/execsync';

import type { ExecSyncClient } from './client.js';
import {
  ExecSyncError,
  type ExecBlockResultRow,
  type ExecBlockResultsPage,
  type ExecSyncPort,
  type ExecSyncStatus,
  type InitSyncResult,
  type UploadDocumentInput,
} from './port.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOf(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function booleanOf(source: Record<string, unknown> | null, key: string): boolean {
  return source?.[key] === true;
}

function intOf(source: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringsOf(source: Record<string, unknown> | null, key: string): readonly string[] {
  const value = source?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function requireString(
  source: Record<string, unknown> | null,
  key: string,
  operation: string,
): string {
  const value = stringOf(source, key);
  if (value === null) {
    throw new ExecSyncError(`RD WEB не вернул обязательное поле «${key}»`, { operation });
  }
  return value;
}

function countersOf(source: Record<string, unknown> | null): Record<string, number> {
  const raw = asRecord(source?.['counters']);
  if (raw === null) return {};
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
  }
  return counters;
}

function blockRowOf(raw: unknown): ExecBlockResultRow | null {
  const source = asRecord(raw);
  const externalBlockId = stringOf(source, 'external_block_id');
  if (externalBlockId === null) return null;
  return {
    externalBlockId,
    externalBlockRevision: intOf(source, 'external_block_revision', 0),
    status: stringOf(source, 'status') ?? 'unknown',
    isDeleted: booleanOf(source, 'is_deleted'),
    reconciliationAction: stringOf(source, 'reconciliation_action'),
    reconciliationReason: stringsOf(source, 'reconciliation_reason'),
    reusedWithoutModel: booleanOf(source, 'reused_without_model'),
    ocrMarkdown: stringOf(source, 'ocr_markdown'),
    ocrText: stringOf(source, 'ocr_text'),
    ocrJson: source?.['ocr_json'] ?? null,
    resultStatus: stringOf(source, 'result_status'),
    updatedAt: stringOf(source, 'updated_at'),
  };
}

export interface ExecSyncAdapterOptions {
  readonly client: ExecSyncClient;
}

export class ExecSyncAdapter implements ExecSyncPort {
  readonly #client: ExecSyncClient;

  constructor(options: ExecSyncAdapterOptions) {
    this.#client = options.client;
  }

  async initSync(body: ExecSyncSnapshotBody, manifestSha256: string): Promise<InitSyncResult> {
    const response = await this.#client.request<unknown>({
      method: 'POST',
      path: '/document-syncs/init',
      operation: 'sync_init',
      body: { ...body, manifest_sha256: manifestSha256 },
    });

    const source = asRecord(response);
    const upload = asRecord(source?.['upload']);
    const url = stringOf(upload, 'url');

    return {
      syncId: requireString(source, 'sync_id', 'sync_init'),
      duplicate: booleanOf(source, 'duplicate'),
      uploadRequired: booleanOf(source, 'upload_required'),
      state: stringOf(source, 'state') ?? 'accepted',
      upload:
        url === null
          ? null
          : {
              method: 'PUT',
              url,
              requiredHeaders: headersOf(upload),
              expiresIn: intOf(upload, 'expires_in', 3600),
            },
    };
  }

  async uploadDocument(input: UploadDocumentInput): Promise<void> {
    await this.#client.putStream({
      url: input.url,
      headers: input.headers,
      body: input.body,
      sizeBytes: input.sizeBytes,
    });
  }

  async completeSync(syncId: string): Promise<void> {
    await this.#client.request<unknown>({
      method: 'POST',
      path: `/document-syncs/${encodeURIComponent(syncId)}/complete`,
      operation: 'sync_complete',
      body: {},
    });
  }

  async readSync(syncId: string): Promise<ExecSyncStatus> {
    const response = await this.#client.request<unknown>({
      method: 'GET',
      path: `/document-syncs/${encodeURIComponent(syncId)}`,
      operation: 'sync_read',
    });
    const source = asRecord(response);
    return {
      syncId: stringOf(source, 'sync_id') ?? syncId,
      state: requireString(source, 'state', 'sync_read'),
      allTerminal: booleanOf(source, 'all_terminal'),
      allSuccessful: booleanOf(source, 'all_successful'),
      counters: countersOf(source),
    };
  }

  async readDocumentBlocks(
    externalDocumentId: string,
    cursor?: string,
  ): Promise<ExecBlockResultsPage> {
    const response = await this.#client.request<unknown>({
      method: 'GET',
      path: `/documents/${encodeURIComponent(externalDocumentId)}/blocks`,
      operation: 'document_blocks',
      ...(cursor === undefined ? {} : { query: { cursor } }),
    });

    // Форма 1: голый массив — постраничности нет.
    if (Array.isArray(response)) {
      return { items: response.map(blockRowOf).filter(isRow), nextCursor: null };
    }

    // Форма 2: страница с курсором.
    const source = asRecord(response);
    const items = source?.['items'];
    if (!Array.isArray(items)) {
      throw new ExecSyncError('RD WEB вернул результаты блоков в незнакомой форме', {
        operation: 'document_blocks',
      });
    }
    return {
      items: items.map(blockRowOf).filter(isRow),
      nextCursor: stringOf(source, 'next_cursor'),
    };
  }
}

function isRow(row: ExecBlockResultRow | null): row is ExecBlockResultRow {
  return row !== null;
}

function headersOf(upload: Record<string, unknown> | null): Record<string, string> {
  const raw = asRecord(upload?.['required_headers']);
  if (raw === null) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[key] = value;
  }
  return headers;
}
