export {
  RECOGNITION_RESULT_SCHEMA_VERSION,
  blockFeaturesSchema,
  canonicalTableSchema,
  contentFragmentSchema,
  imageBlockSchema,
  recognitionBlockSchema,
  recognitionPageSchema,
  recognitionProviderSchema,
  recognitionResultSchema,
  stampBlockSchema,
  textBlockSchema,
  type BlockFeatures,
  type CanonicalTable,
  type ContentFragment,
  type RecognitionBlock,
  type RecognitionPage,
  type RecognitionProvider,
  type RecognitionResult,
} from './schema.js';
export { PAGE_TEXT_RENDER_VERSION, renderPageText } from './render.js';
export { RENDER_FRAGMENTS_VERSION, renderFragmentsToMarkdown } from './render-fragments.js';
/**
 * Разбор markdown-экспорта RD WEB.
 *
 * Остаётся в пакете, хотя маршрут, который его породил, снят: сегодняшний
 * потребитель — построитель эталонного корпуса (`tools/fixtures`), который
 * читает ИСТОРИЧЕСКИЕ файлы `*_results.md` с диска. Это единственная
 * реализация чтения того формата на весь репозиторий, и к тому, чем портал
 * распознаёт сейчас, она отношения не имеет.
 */
export {
  RDWEB_MD_ADAPTER_VERSION,
  canonicalFromArchiveEntries,
  parseImageContent,
  parseStampLine,
} from './adapters/rdweb-md.js';
export type {
  RecognitionRequest,
  RecognitionRequestBlock,
  RecognitionRequestPage,
  RecognitionSourcePort,
} from './adapters/port.js';
