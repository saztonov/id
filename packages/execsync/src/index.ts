/**
 * Контракт снимка исполнительной документации RD WEB
 * (`rdweb.executive_document_snapshot.v1`, канонизация `rd.execsync.canon.v1`).
 *
 * Пакет содержит ТОЛЬКО контракт: схемы провода, канонизацию, хеш и предполётные
 * проверки. Ни сети, ни БД, ни знания о наших таблицах — сборка снимка из строк
 * живёт в `apps/api`, транспорт там же.
 *
 * ## Почему отдельный пакет, а не `@id/contracts`
 *
 * Две причины, и вторая важнее. Техническая: от `@id/contracts` зависит
 * `apps/web`, а его `index.ts` — барель без подпутей в `exports`; модуль с
 * `node:crypto` попал бы в браузерный граф Vite при любом импорте из пакета.
 * Существенная: `CONTRACTS_VERSION` версионирует НАШИ схемы, а `rd.execsync.canon.v1`
 * — чужие, и менять их будет RD WEB. Слитые в один пакет, они заставляли бы
 * поднимать нашу версию на их правках.
 *
 * Прецедент ровно этой формы уже есть — `@id/detection`: порт чужого алгоритма,
 * доказываемый закоммиченными эталонами.
 */
export {
  canonicalManifestJson,
  canonicalProjection,
  compareCanonKeys,
  manifestSha256,
  sealSnapshot,
  type CanonValue,
} from './canon.js';

export { fixed6, GEOMETRY_SCALE, TIE_BREAK, ExecSyncNumberError } from './fixed6.js';

export {
  assertHashSafeMetadata,
  assertWellFormed,
  EXEC_SYNC_LIMITS,
  ExecSyncCanonError,
  requireSafeInteger,
  type ExecSyncLimits,
} from './safety.js';

export {
  COORDINATE_SPACE,
  EXEC_SYNC_CANON_VERSION,
  EXEC_SYNC_SCHEMA_VERSION,
  EXEC_SYNC_STATUS_VERSION,
  execSyncBlockSchema,
  execSyncDocumentSchema,
  execSyncSnapshotBodySchema,
  execSyncSnapshotEnvelopeSchema,
  polygonPointSchema,
  SNAPSHOT_MODE,
  type ExecSyncBlock,
  type ExecSyncDocument,
  type ExecSyncMetadataValue,
  type ExecSyncSnapshotBody,
  type ExecSyncSnapshotEnvelope,
} from './wire.js';
