/**
 * Генератор синтетических PDF-фикстур и обезличиватель закрытого корпуса.
 */
export {
  type ReferenceBlockType,
  type ReferenceExpectation,
  type ReferencePage,
  type ReferencePackage,
  type ReferencePageLabel,
  type ReferenceTypeOutcome,
  type SourcePage,
  REFERENCE_CORPUS_DIR,
  anonymizePackage,
  auditByPiiScanner,
  auditCorpusPii,
  buildReferencePackage,
  collectPackageMarkers,
  loadReferenceCorpus,
  parseSourcePackage,
  resolveGoldenCorpusDir,
} from './corpus-reference.js';

export {
  type CorpusMetrics,
  type EvaluateOptions,
  type FoldResult,
  type MissedBoundaries,
  type SegmentationPrediction,
  type TypeCounts,
  type TypeReport,
  evaluateLeaveOnePackageOut,
  formatCorpusMetrics,
} from './metrics.js';
