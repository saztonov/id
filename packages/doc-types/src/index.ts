/**
 * Каталог видов исполнительной документации.
 *
 * Каталог — источник правды в коде: из него выводится `DocTypeCode`, на который
 * опираются правила проверки, и из него же генерируется seed-миграция. Мир
 * открытый: корпус покрывает два раздела работ из многих, поэтому каталог
 * заведомо неполон, а незнакомый документ получает резервный тип и попадает
 * в кандидаты на пополнение справочника.
 */

export type {
  DocTypeDefinition,
  DocTypeGroup,
  DocTypeKind,
  FieldDefinition,
  FieldExtractor,
  FieldType,
  MatchHints,
  PageRoleCode,
  PageRoleDefinition,
  CompiledAnchor,
} from './types.js';
export { compileAnchors } from './types.js';

export { DOC_TYPES } from './catalog.js';
export type { DocTypeCode } from './catalog.js';

export { BASE_EVIDENCE_FIELDS, fieldsForType } from './base-fields.js';
export { PAGE_ROLES } from './page-roles.js';

export {
  DEFAULT_HEADING_LINES,
  matchDocTypes,
  matchPageRoles,
  normalizeLine,
  normalizeLines,
  opensEnumeration,
  resolveDocType,
} from './matching.js';
export type { DocTypeMatch, MatchOptions, PageRoleMatch, ResolvedDocType } from './matching.js';

export { generateSeedSql, generateSeedStatements } from './seed.js';
