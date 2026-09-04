/**
 * Тело снимка в терминах ПРОВОДА (§4).
 *
 * Имена полей — `snake_case`, дословно как в контракте RD WEB, а не наши
 * доменные `camelCase`. Это не небрежность и не лень маппера: канонический хеш
 * §13 считается по ЭТИМ именам, и если бы канонизация принимала доменный объект,
 * имена контракта жили бы в двух местах — в мапперe и в проекции. Их расхождение
 * дало бы хеш, не описывающий отправленное тело, то есть 422 с самой бесполезной
 * диагностикой из возможных: сервер сказал бы «манифест не тот», а сравнить было
 * бы не с чем.
 *
 * Маппер «наши строки БД → это тело» живёт в `apps/api`; здесь про БД не знают.
 */
import { z } from 'zod';

export const EXEC_SYNC_SCHEMA_VERSION = 'rdweb.executive_document_snapshot.v1';
export const EXEC_SYNC_STATUS_VERSION = 'rdweb.executive_sync_status.v1';
export const EXEC_SYNC_CANON_VERSION = 'rd.execsync.canon.v1';

/** Единственный режим снимка в v1: портал присылает полный текущий список (§6). */
export const SNAPSHOT_MODE = 'replace';
/** Единственная система координат в v1 (§5). */
export const COORDINATE_SPACE = 'rendered_page_normalized_v1';

/** 64 hex в нижнем регистре — форма всех хешей контракта. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 — 64 hex в нижнем регистре');

/** Внешний идентификатор: длина ограничена §12. */
const externalIdSchema = z.string().min(1).max(128);

/**
 * Значение внутри `metadata` блока.
 *
 * Рекурсивный тип объявлен вручную, а не выведен из zod: `z.lazy` даёт тип,
 * который `exactOptionalPropertyTypes` разворачивает в `any` на глубине.
 */
export type ExecSyncMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly ExecSyncMetadataValue[]
  | { readonly [key: string]: ExecSyncMetadataValue };

const metadataValueSchema: z.ZodType<ExecSyncMetadataValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(metadataValueSchema),
    z.record(z.string(), metadataValueSchema),
  ]),
);

export const execSyncDocumentSchema = z.object({
  file_name: z.string().min(1).max(255),
  mime_type: z.literal('application/pdf'),
  size_bytes: z.int().nonnegative(),
  sha256: sha256Schema,
  page_count: z.int().positive(),
});

export type ExecSyncDocument = z.infer<typeof execSyncDocumentSchema>;

/**
 * Пара координат полигона. Кортеж, а не массив длины два: контракт требует
 * именно пар, и массив из трёх чисел обязан отвергаться схемой, а не доезжать до
 * канонизации, где он молча превратился бы в три строки.
 */
export const polygonPointSchema = z.tuple([z.number(), z.number()]);

export const execSyncBlockSchema = z.object({
  external_block_id: externalIdSchema,
  revision: z.int().positive(),
  page_index: z.int().nonnegative(),
  block_type: z.enum(['text', 'image', 'stamp']),
  shape_type: z.enum(['rectangle', 'polygon']),
  coords_norm: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  polygon_points: z.array(polygonPointSchema).nullable(),
  linked_external_block_id: externalIdSchema.nullable(),
  display_name: z.string().max(1000).nullable(),
  sort_order: z.int().nonnegative(),
  force_reprocess: z.boolean(),
  metadata: z.record(z.string(), metadataValueSchema),
});

export type ExecSyncBlock = z.infer<typeof execSyncBlockSchema>;

/**
 * Тело снимка БЕЗ поля `manifest_sha256` — и это выражено типом намеренно.
 *
 * §13 первым правилом требует считать хеш по канонической проекции тела «без
 * самого поля `manifest_sha256`». Правило, выраженное типом, невозможно забыть;
 * правило, выраженное строкой `delete body.manifest_sha256` в реализации, —
 * можно, и цена забывчивости здесь одинакова для всех отправок сразу. Поле
 * рождается на свет ровно в одном месте — `sealSnapshot()`.
 */
export const execSyncSnapshotBodySchema = z.object({
  schema_version: z.literal(EXEC_SYNC_SCHEMA_VERSION),
  external_sync_id: externalIdSchema,
  external_project_id: externalIdSchema,
  project_name: z.string().min(1).max(1000),
  external_document_id: externalIdSchema,
  document_name: z.string().min(1).max(1000),
  document_revision: z.string().min(1).max(128),
  base_generation: z.int().nonnegative(),
  sync_generation: z.int().positive(),
  snapshot_mode: z.literal(SNAPSHOT_MODE),
  coordinate_space: z.literal(COORDINATE_SPACE),
  document: execSyncDocumentSchema,
  blocks: z.array(execSyncBlockSchema),
});

export type ExecSyncSnapshotBody = z.infer<typeof execSyncSnapshotBodySchema>;

/** Тело вместе с хешем — то, что уходит на провод. */
export const execSyncSnapshotEnvelopeSchema = execSyncSnapshotBodySchema.extend({
  manifest_sha256: sha256Schema,
});

export type ExecSyncSnapshotEnvelope = z.infer<typeof execSyncSnapshotEnvelopeSchema>;
