/**
 * Схемы доменных сущностей (§3).
 *
 * Схемы описывают сущности в форме, в которой они пересекают границу процесса:
 * поля в camelCase, метки времени — строками ISO-8601, `numeric` — числами.
 * Отображение на snake_case и типы PostgreSQL — забота слоя БД (S2).
 *
 * Различие `.nullable()` и `.optional()` выдержано намеренно: NULL-колонка БД
 * даёт `.nullable()`, а `.optional()` остаётся за полями, которых в объекте
 * может не быть вовсе. При включённом `exactOptionalPropertyTypes` смешение
 * этих двух вещей быстро становится источником ложных типов.
 *
 * Инварианты, которые в §3 заданы как CHECK или как текстовое правило,
 * продублированы здесь через `.refine()`: БД защищает данные, схема защищает
 * границу и даёт понятное сообщение до похода в БД.
 */

import { z } from 'zod';

import {
  artifactKindSchema,
  attentionFlagSchema,
  autonomyLevelSchema,
  blockSourceSchema,
  blockTypeSchema,
  counterpartyKindSchema,
  detectorProvenanceSchema,
  documentRelationSchema,
  extractedBySchema,
  findingOriginSchema,
  findingStateSchema,
  findingTargetTypeSchema,
  layoutRevisionStateSchema,
  materialSourceSchema,
  matchStateSchema,
  pageRoleCodeSchema,
  recognitionStatusSchema,
  severitySchema,
  shapeTypeSchema,
  signatureProbeResultSchema,
  verifyStateSchema,
  workflowStatusSchema,
} from './enums.js';

// =====================================================================
// Примитивы
// =====================================================================

export const uuidSchema = z.uuid();

export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'SHA-256 — 64 шестнадцатеричных символа в нижнем регистре');

/** Метка времени ISO-8601. Смещение допускается: не всё приходит в UTC. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Календарная дата без времени: даты документов — именно календарные. */
export const isoDateSchema = z.iso.date();

/** Уверенность модели или сопоставления. */
export const confidenceSchema = z.number().min(0).max(1);

/** Код-слаг справочника: латиница в нижнем регистре, цифры, подчёркивание. */
export const codeSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Код — латиница в нижнем регистре, цифры и подчёркивание');

/**
 * Вид раздела работ и код вида ИД — строки, а не enum.
 *
 * Корпус покрывает два раздела из многих (§0.5): каталог обязан расти
 * эксплуатацией через справочник и `doc_type_candidates`. Закрытый enum
 * превратил бы заведение нового раздела в релиз портала.
 */
export const sectionKindCodeSchema = codeSlugSchema;
export const docTypeCodeSchema = codeSlugSchema;

/** Код правила проверки: `AOSR.P4`, `DATE.372`, `SIG.STAMP.370`, `REG`. */
export const ruleCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/,
    'Код правила — заглавные латинские сегменты через точку',
  );

/** Версия для оптимистичной блокировки (`If-Match`). */
export const rowVersionSchema = z.int().nonnegative();

export const sortOrderSchema = z.int().nonnegative();

/** Произвольный JSONB. */
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

/**
 * Счётчики прогона (`counts jsonb`).
 *
 * Набор ключей намеренно не фиксирован: он зависит от версии ruleset и от
 * того, какие стадии реально отработали, а закреплённая схема ломалась бы
 * при каждом добавлении правила.
 */
export const countsSchema = z.record(z.string(), z.int().nonnegative());
export type Counts = z.infer<typeof countsSchema>;

/**
 * Диапазон символов в тексте страницы (`int4range` в БД).
 *
 * Полуинтервал `[start, end)` в единицах кода UTF-16 — та же конвенция, что
 * в `pageTextVersion.offsetConvention`. Без явного согласования этих двух
 * мест цитата в доказательстве отобразилась бы на чужой фрагмент.
 */
export const charSpanSchema = z
  .object({
    start: z.int().nonnegative(),
    end: z.int().nonnegative(),
  })
  .refine((span) => span.start <= span.end, {
    message: 'Начало диапазона не может быть больше конца',
    path: ['end'],
  });
export type CharSpan = z.infer<typeof charSpanSchema>;

// =====================================================================
// Реквизиты организаций
// =====================================================================

/**
 * Форма ИНН, КПП и ОГРН — только длина и цифры, без контрольных сумм.
 *
 * Контрольная сумма проверяется правилом `AOSR.HDR` над извлечёнными
 * реквизитами, а не схемой. Разница принципиальна: ОГРН из 12 цифр — один из
 * семи известных дефектов корпуса, и он обязан доехать до движка правил
 * замечанием, а не быть отброшенным на границе как «невалидный ввод».
 */
export const innSchema = z
  .string()
  .regex(/^(\d{10}|\d{12})$/, 'ИНН — 10 цифр у организации или 12 у ИП');

export const kppSchema = z.string().regex(/^\d{9}$/, 'КПП — 9 цифр');

export const ogrnSchema = z
  .string()
  .regex(/^(\d{13}|\d{15})$/, 'ОГРН — 13 цифр у организации или 15 (ОГРНИП)');

// =====================================================================
// §3.2 Справочники
// =====================================================================

/** Код объекта — ровно 5 латинских букв или цифр (CHECK в `construction_objects`). */
export const objectCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{5}$/, 'Код объекта — ровно 5 символов: латинские буквы или цифры');

export const constructionObjectSchema = z.object({
  id: uuidSchema,
  code: objectCodeSchema,
  name: z.string().min(1).max(255),
  fullName: z.string().min(1).max(1000),
  address: z.string().max(1000).nullable(),
  isActive: z.boolean(),
  developerId: uuidSchema.nullable(),
  techCustomerId: uuidSchema.nullable(),
  generalContractorId: uuidSchema.nullable(),
  /** Шаблон номера акта: проверяется правилом `AOSR.ACT`. */
  actNumberPattern: z.string().max(255).nullable(),
});
export type ConstructionObject = z.infer<typeof constructionObjectSchema>;

export const counterpartySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(500),
  inn: innSchema.nullable(),
  kpp: kppSchema.nullable(),
  ogrn: ogrnSchema.nullable(),
  legalAddress: z.string().max(1000).nullable(),
  kind: counterpartyKindSchema,
  isActive: z.boolean(),
});
export type Counterparty = z.infer<typeof counterpartySchema>;

export const objectSectionSchema = z.object({
  id: uuidSchema,
  objectId: uuidSchema,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  sortOrder: sortOrderSchema,
  isActive: z.boolean(),
  sectionKindCode: sectionKindCodeSchema,
});
export type ObjectSection = z.infer<typeof objectSectionSchema>;

/**
 * Версионный профиль вида раздела (§3.2).
 *
 * Профиль версионный с периодом действия, потому что иначе прогон проверок
 * месячной давности невоспроизводим. Пустой `expectedDocTypes` — не «комплект
 * пуст», а «состав не настроен»: правила полноты в этом случае дают `n_a`
 * (§9.1), и различать эти два случая обязан вызывающий код.
 */
export const sectionProfileSchema = z
  .object({
    id: uuidSchema,
    sectionKindCode: sectionKindCodeSchema,
    version: z.int().positive(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable(),
    expectedDocTypes: z.array(docTypeCodeSchema),
    materialCategories: z.array(codeSlugSchema),
    materialMatrix: jsonValueSchema,
    enabledRuleCodes: z.array(ruleCodeSchema),
    thresholds: jsonValueSchema,
    autonomyLevel: autonomyLevelSchema,
    publishedAt: isoDateTimeSchema.nullable(),
    publishedBy: uuidSchema.nullable(),
  })
  .refine((p) => p.effectiveTo === null || p.effectiveFrom <= p.effectiveTo, {
    message: 'Начало действия профиля позже его окончания',
    path: ['effectiveTo'],
  });
export type SectionProfile = z.infer<typeof sectionProfileSchema>;

// =====================================================================
// §3 Том, поставка, ревизия
// =====================================================================

/**
 * Том — раздел работ конкретного объекта, единица работы (§3).
 *
 * `autoRunEnabled` — единственная настройка, при которой конвейер проходит
 * остановки §6 без участия человека. По умолчанию выключена: распознавание
 * дороже всего, а неверная рамка после OCR стоит полного повторного прогона.
 */
export const volumeSchema = z.object({
  id: uuidSchema,
  objectId: uuidSchema,
  sectionId: uuidSchema,
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(500),
  isActive: z.boolean(),
  autoRunEnabled: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type Volume = z.infer<typeof volumeSchema>;

/**
 * Поставка — комплект ИД, поданный подрядчиком по тому.
 *
 * `objectId` и `contractorId` денормализованы сознательно: на них опирается
 * третий уровень изоляции доступа — composite FK (§4.1). Без них проверка
 * области видимости требовала бы join'а на каждый запрос.
 */
export const submissionSchema = z.object({
  id: uuidSchema,
  volumeId: uuidSchema,
  objectId: uuidSchema,
  contractorId: uuidSchema,
  number: z.string().max(128).nullable(),
  title: z.string().min(1).max(1000),
  currentRevisionId: uuidSchema.nullable(),
  createdBy: uuidSchema,
  createdAt: isoDateTimeSchema,
});
export type Submission = z.infer<typeof submissionSchema>;

/**
 * Ревизия поставки — неизменяемая после submit единица прохождения конвейера.
 *
 * `aggregateManifestHash` — хэш состава ревизии (файлы и их порядок). Только
 * его совпадение разрешает переиспользовать результаты предыдущей ревизии
 * при повторной подаче после возврата.
 */
export const submissionRevisionSchema = z
  .object({
    id: uuidSchema,
    submissionId: uuidSchema,
    revisionNo: z.int().positive(),
    parentRevisionId: uuidSchema.nullable(),
    status: workflowStatusSchema,
    aggregateManifestHash: sha256Schema.nullable(),
    version: rowVersionSchema,
    createdAt: isoDateTimeSchema,
    submittedAt: isoDateTimeSchema.nullable(),
    submittedBy: uuidSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    decidedBy: uuidSchema.nullable(),
    returnReason: z.string().max(4000).nullable(),
  })
  .refine((r) => r.revisionNo === 1 || r.parentRevisionId !== null, {
    message: 'У ревизии старше первой обязана быть родительская',
    path: ['parentRevisionId'],
  });
export type SubmissionRevision = z.infer<typeof submissionRevisionSchema>;

// =====================================================================
// §3.3 Файлы, страницы, рабочий документ
// =====================================================================

/**
 * Результат структурного зондирования подписи (`source_files.signature_probe`).
 *
 * Признаки хранятся рядом с вердиктом, потому что именно они его
 * обосновывают: отсутствие `ByteRange` — прямое доказательство отсутствия
 * подписи, так как `ByteRange` адресует байтовые смещения файла и не может
 * лежать в сжатом потоке объектов (§0.1).
 */
export const signatureProbeSchema = z.object({
  result: signatureProbeResultSchema,
  hasByteRange: z.boolean(),
  subFilters: z.array(z.string()),
  signatureFieldCount: z.int().nonnegative(),
  probedAt: isoDateTimeSchema,
  probeError: z.string().max(2000).nullable(),
});
export type SignatureProbe = z.infer<typeof signatureProbeSchema>;

export const sourceFileSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  blobSha256: sha256Schema,
  fileName: z.string().min(1).max(500),
  sortOrder: sortOrderSchema,
  verifyState: verifyStateSchema,
  verifyError: z.string().max(4000).nullable(),
  signatureProbe: signatureProbeSchema.nullable(),
});
export type SourceFile = z.infer<typeof sourceFileSchema>;

/**
 * Страница исходного файла.
 *
 * `rotation` — только четыре значения `/Rotate`; координаты разметки заданы в
 * пост-поворотном фрейме (§7.1), поэтому размеры страницы тоже хранятся уже
 * с учётом поворота.
 */
export const sourcePageSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  sourceFileId: uuidSchema,
  filePageIndex: z.int().nonnegative(),
  revisionOrdinal: z.int().nonnegative(),
  widthPx: z.int().positive(),
  heightPx: z.int().positive(),
  rotation: z.literal([0, 90, 180, 270]),
  attentionFlags: z.array(attentionFlagSchema),
});
export type SourcePage = z.infer<typeof sourcePageSchema>;

/**
 * Рабочий PDF ревизии — производный неизменяемый документ (§3.3).
 *
 * Именно он уезжает в RD WEB: их API принимает один PDF на документ, а их
 * детектор работает по их собственному рендеру. Оригиналы остаются
 * нетронутыми, обратное отображение страниц — через `processingBundlePage`.
 */
export const processingBundleSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  aggregateManifestHash: sha256Schema,
  workingPdfBlobSha256: sha256Schema,
  builderVersion: z.string().min(1).max(64),
  createdAt: isoDateTimeSchema,
});
export type ProcessingBundle = z.infer<typeof processingBundleSchema>;

export const processingBundlePageSchema = z.object({
  bundleId: uuidSchema,
  workingPageIndex: z.int().nonnegative(),
  sourcePageId: uuidSchema,
});
export type ProcessingBundlePage = z.infer<typeof processingBundlePageSchema>;

// =====================================================================
// §3.4 Разметка
// =====================================================================

export const layoutRevisionSchema = z
  .object({
    id: uuidSchema,
    revisionId: uuidSchema,
    bundleId: uuidSchema,
    revisionNo: z.int().positive(),
    state: layoutRevisionStateSchema,
    blocksHash: sha256Schema.nullable(),
    version: rowVersionSchema,
    frozenAt: isoDateTimeSchema.nullable(),
    frozenBy: uuidSchema.nullable(),
  })
  .refine((r) => r.state === 'draft' || (r.blocksHash !== null && r.frozenAt !== null), {
    message: 'Замороженная ревизия разметки обязана иметь хэш блоков и время заморозки',
    path: ['blocksHash'],
  });
export type LayoutRevision = z.infer<typeof layoutRevisionSchema>;

/** Нормализованная координата: доля от размера страницы, origin слева-сверху. */
export const normalizedCoordinateSchema = z.number().min(0).max(1);

/**
 * Ограничивающий прямоугольник блока в нормализованных координатах.
 *
 * Это тот же инвариант, что CHECK в `layout_blocks`
 * (`x0>=0 AND y0>=0 AND x1<=1 AND y1<=1 AND x0<=x1 AND y0<=y1`). Держать его
 * в двух местах осмысленно: БД защищает данные от любого писателя, схема
 * ловит вырожденную рамку на границе API и называет виновное поле.
 */
export const normalizedCoordsSchema = z
  .object({
    x0: normalizedCoordinateSchema,
    y0: normalizedCoordinateSchema,
    x1: normalizedCoordinateSchema,
    y1: normalizedCoordinateSchema,
  })
  .refine((c) => c.x0 <= c.x1, {
    message: 'Левая граница блока правее правой (x0 > x1)',
    path: ['x1'],
  })
  .refine((c) => c.y0 <= c.y1, {
    message: 'Верхняя граница блока ниже нижней (y0 > y1)',
    path: ['y1'],
  });
export type NormalizedCoords = z.infer<typeof normalizedCoordsSchema>;

/** Точка полигона (`layout_block_points`). */
export const normalizedPointSchema = z.object({
  pointNo: z.int().nonnegative(),
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
});
export type NormalizedPoint = z.infer<typeof normalizedPointSchema>;

export const layoutBlockSchema = z
  .object({
    id: uuidSchema,
    layoutRevisionId: uuidSchema,
    sourcePageId: uuidSchema,
    workingPageIndex: z.int().nonnegative(),
    objectId: uuidSchema,
    blockType: blockTypeSchema,
    shapeType: shapeTypeSchema,
    coords: normalizedCoordsSchema,
    /** Точки полигона; у прямоугольника пуст. Порядок задаёт `pointNo`. */
    points: z.array(normalizedPointSchema),
    sortOrder: sortOrderSchema,
    source: blockSourceSchema,
    detectorProvenance: detectorProvenanceSchema,
  })
  .refine((b) => b.shapeType !== 'polygon' || b.points.length >= 3, {
    message: 'Полигон описывается не менее чем тремя точками',
    path: ['points'],
  });
export type LayoutBlock = z.infer<typeof layoutBlockSchema>;

// =====================================================================
// §3.5 Прогоны и неизменяемые артефакты
// =====================================================================

export const recognitionWarningSchema = z.object({
  code: codeSlugSchema,
  message: z.string().min(1).max(2000),
  workingPageIndex: z.int().nonnegative().nullable(),
});
export type RecognitionWarning = z.infer<typeof recognitionWarningSchema>;

/**
 * Прогон распознавания (§5.2).
 *
 * Три хэша разметки хранятся раздельно, потому что доказывают разное:
 * `localLayoutHash` — что заказывали, `remoteLayoutHashBefore` — что стояло на
 * стороне RD WEB перед стартом OCR, `remoteLayoutHashAfter` — что там стояло
 * после. Расхождение любой пары переводит прогон в `integrity_error`, и его
 * результаты не используются.
 */
export const recognitionRunSchema = z
  .object({
    id: uuidSchema,
    revisionId: uuidSchema,
    layoutRevisionId: uuidSchema,
    rdRunDocumentId: uuidSchema,
    rdJobId: z.string().max(128).nullable(),
    localLayoutHash: sha256Schema,
    remoteLayoutHashBefore: sha256Schema.nullable(),
    remoteLayoutHashAfter: sha256Schema.nullable(),
    workingPdfSha256: sha256Schema,
    /** Снимок настроек прогона с вырезанными секретами. */
    settingsSnapshot: jsonValueSchema,
    status: recognitionStatusSchema,
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.nullable(),
    counts: countsSchema,
    warnings: z.array(recognitionWarningSchema),
  })
  .refine((r) => r.status === 'running' || r.finishedAt !== null, {
    message: 'У завершённого прогона обязано быть время окончания',
    path: ['finishedAt'],
  });
export type RecognitionRun = z.infer<typeof recognitionRunSchema>;

export const artifactVersionSchema = z.object({
  id: uuidSchema,
  recognitionRunId: uuidSchema,
  kind: artifactKindSchema,
  s3Key: z.string().min(1).max(1024),
  artifactSha256: sha256Schema,
  byteSize: z.int().nonnegative(),
});
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;

/**
 * Текст страницы, полученный из артефакта прогона.
 *
 * `offsetConvention` вынесена в явное поле, хотя значение сейчас одно:
 * на смещения этой строки ссылаются `charSpan` в реквизитах и в
 * доказательствах, и молчаливая смена конвенции сдвинула бы все цитаты.
 */
export const pageTextVersionSchema = z.object({
  id: uuidSchema,
  sourcePageId: uuidSchema,
  recognitionRunId: uuidSchema,
  artifactVersionId: uuidSchema,
  textMd: z.string(),
  textSha256: sha256Schema,
  offsetConvention: z.literal('utf16-code-unit'),
});
export type PageTextVersion = z.infer<typeof pageTextVersionSchema>;

// =====================================================================
// §3.6 Логические документы
// =====================================================================

/**
 * Логический документ внутри поставки.
 *
 * `docTypeCode` допускает null: документ может быть опознан как документ, но
 * не отнесён ни к одному известному типу (§8.2). Это штатное состояние
 * открытого мира, а не ошибка распознавания, и оно обязано отличаться от
 * `needsReview` — «похоже на известный тип, но не уверен».
 */
export const logicalDocumentSchema = z
  .object({
    id: uuidSchema,
    revisionId: uuidSchema,
    objectId: uuidSchema,
    contractorId: uuidSchema,
    docTypeCode: docTypeCodeSchema.nullable(),
    ordinal: z.int().nonnegative(),
    title: z.string().max(2000),
    folderGroup: codeSlugSchema.nullable(),
    typeConfidence: confidenceSchema.nullable(),
    boundaryConfidence: confidenceSchema.nullable(),
    needsReview: z.boolean(),
    isConfirmed: z.boolean(),
    confirmedBy: uuidSchema.nullable(),
    confirmedAt: isoDateTimeSchema.nullable(),
    derivedPdfBlobSha256: sha256Schema.nullable(),
    /** Нарезка всегда производна: встроенная подпись оригинала к ней не относится. */
    isDerivedCopy: z.boolean(),
  })
  .refine((d) => !d.isConfirmed || d.confirmedBy !== null, {
    message: 'Подтверждённый документ обязан хранить, кто его подтвердил',
    path: ['confirmedBy'],
  });
export type LogicalDocument = z.infer<typeof logicalDocumentSchema>;

export const documentPageSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  documentId: uuidSchema,
  sourcePageId: uuidSchema,
  sortOrder: sortOrderSchema,
  pageRoleCode: pageRoleCodeSchema.nullable(),
});
export type DocumentPage = z.infer<typeof documentPageSchema>;

export const documentRelationEdgeSchema = z
  .object({
    parentDocumentId: uuidSchema,
    childDocumentId: uuidSchema,
    relation: documentRelationSchema,
  })
  .refine((e) => e.parentDocumentId !== e.childDocumentId, {
    message: 'Документ не может быть связан сам с собой',
    path: ['childDocumentId'],
  });
export type DocumentRelationEdge = z.infer<typeof documentRelationEdgeSchema>;

/**
 * Извлечённый реквизит документа.
 *
 * Значение разложено по типам колонок, а не приведено к строке: сравнение дат
 * и допусков (§9.2, §9.4) должно работать с датой и числом, а не с их
 * текстовым видом. Ссылка на `pageTextVersionId` + `charSpan` + `quote` —
 * обязательная тройка доказательства: без отображения цитаты на точный span
 * результат считается `undetermined` (§8.2).
 */
export const fieldValueSchema = z.object({
  id: uuidSchema,
  documentId: uuidSchema,
  fieldCode: codeSlugSchema,
  valueText: z.string().nullable(),
  valueDate: isoDateSchema.nullable(),
  valueNum: z.number().nullable(),
  valueJson: jsonValueSchema.nullable(),
  confidence: confidenceSchema.nullable(),
  isVerified: z.boolean(),
  extractorVersion: z.string().min(1).max(64),
  pageTextVersionId: uuidSchema.nullable(),
  sourceBlockId: uuidSchema.nullable(),
  charSpan: charSpanSchema.nullable(),
  quote: z.string().max(4000).nullable(),
  extractedBy: extractedBySchema,
});
export type FieldValue = z.infer<typeof fieldValueSchema>;

/**
 * Строка реестра приложений (§8.3).
 *
 * Три формы номера хранятся одновременно: `raw` для показа человеку, `norm`
 * для точного сравнения, `folded` для сравнения после фолдинга гомоглифов
 * (одна декларация встречается и как `Д-RU.PA01.B`, и как `Д-РУ.РА01.В`).
 * Совпадение только по `folded` при коллизии даёт `ambiguous`, а не `matched`.
 */
export const registryRowSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  documentId: uuidSchema,
  rowNo: z.int().positive(),
  sectionTitle: z.string().max(1000).nullable(),
  docNameRaw: z.string().max(2000),
  docNoRaw: z.string().max(500).nullable(),
  orgRaw: z.string().max(1000).nullable(),
  docNoNorm: z.string().max(500).nullable(),
  docNoFolded: z.string().max(500).nullable(),
  validFrom: isoDateSchema.nullable(),
  validTo: isoDateSchema.nullable(),
  issuedAt: isoDateSchema.nullable(),
  matchedDocumentId: uuidSchema.nullable(),
  matchScore: confidenceSchema.nullable(),
  matchState: matchStateSchema,
});
export type RegistryRow = z.infer<typeof registryRowSchema>;

export const materialSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  nameRaw: z.string().min(1).max(2000),
  nameNorm: z.string().min(1).max(2000),
  mark: z.string().max(256).nullable(),
  sizeSpec: z.string().max(256).nullable(),
  categoryCode: codeSlugSchema.nullable(),
  source: materialSourceSchema,
});
export type Material = z.infer<typeof materialSchema>;

/**
 * Партия материала.
 *
 * `manufacturedAt` — та самая дата, против которой проверяется `DATE.312`
 * (изготовление не позже применения) и `DATE.372` (протокол относится к
 * применённым партиям).
 */
export const batchSchema = z.object({
  id: uuidSchema,
  materialId: uuidSchema,
  batchNo: z.string().max(256).nullable(),
  heatNo: z.string().max(256).nullable(),
  manufacturedAt: isoDateSchema.nullable(),
  volume: z.number().nullable(),
  unit: z.string().max(32).nullable(),
});
export type Batch = z.infer<typeof batchSchema>;

// =====================================================================
// §3.7 Проверки
// =====================================================================

export const validationRunSchema = z.object({
  id: uuidSchema,
  revisionId: uuidSchema,
  rulesetVersionId: uuidSchema,
  objectRuleProfileId: uuidSchema.nullable(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  counts: countsSchema,
});
export type ValidationRun = z.infer<typeof validationRunSchema>;

/**
 * Замечание проверки.
 *
 * Два инварианта §9.1 и §3.7 вынесены в `.refine()`, потому что нарушение
 * любого из них — это не «плохие данные», а сломанная методика:
 * находка LLM не становится блокирующей без подтверждения инженером, а
 * `undetermined` не может быть блокирующим вовсе, иначе троичная логика
 * вырождается обратно в двоичную и подрядчик получает стоп по «не знаю».
 */
export const findingSchema = z
  .object({
    id: uuidSchema,
    validationRunId: uuidSchema,
    revisionId: uuidSchema,
    objectId: uuidSchema,
    contractorId: uuidSchema,
    ruleCode: ruleCodeSchema,
    severity: severitySchema,
    state: findingStateSchema,
    origin: findingOriginSchema,
    isBlocking: z.boolean(),
    confirmedBy: uuidSchema.nullable(),
    confirmedAt: isoDateTimeSchema.nullable(),
    targetType: findingTargetTypeSchema,
    targetId: uuidSchema.nullable(),
    sourcePageId: uuidSchema.nullable(),
    blockId: uuidSchema.nullable(),
    message: z.string().min(1).max(4000),
    /** Способ устранения: замечание без него бесполезно подрядчику (§9.1). */
    hint: z.string().max(4000).nullable(),
    waivedBy: uuidSchema.nullable(),
    waivedAt: isoDateTimeSchema.nullable(),
    waiverReason: z.string().max(4000).nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
  })
  .refine((f) => !(f.origin === 'llm' && f.isBlocking) || f.confirmedBy !== null, {
    message: 'Находка LLM не может быть блокирующей без подтверждения инженером',
    path: ['confirmedBy'],
  })
  .refine((f) => !(f.state === 'undetermined' && f.isBlocking), {
    message: 'Неопределённое замечание не может быть блокирующим',
    path: ['isBlocking'],
  })
  .refine((f) => f.state !== 'waived' || (f.waivedBy !== null && f.waiverReason !== null), {
    message: 'Снятие замечания требует автора и обоснования',
    path: ['waiverReason'],
  });
export type Finding = z.infer<typeof findingSchema>;

/** Доказательство замечания: цитата, отображённая на точный span текста страницы. */
export const findingEvidenceSchema = z.object({
  findingId: uuidSchema,
  pageTextVersionId: uuidSchema,
  charSpan: charSpanSchema,
  quote: z.string().min(1).max(4000),
});
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;
