/**
 * Общие типы сегментации и извлечения (§8).
 *
 * Файл пишется ОДИН раз и до реализации фаз намеренно: три фазы §8.2, разбор
 * реестра §8.3 и извлечение реквизитов §8.4 делаются разными людьми и в разных
 * файлах, а обмениваются они ровно этими структурами. Разъехавшиеся определения
 * входа и выхода — тот же класс отказа, что на S2 дал 39 расхождений между
 * схемой Drizzle и SQL: каждый пишет по тексту плана, а план не задаёт полей.
 *
 * ## Почему «не знаю» здесь два разных значения
 *
 * Мир открытый (§0.5): корпус покрывает два раздела работ из многих. Поэтому
 * `typeOutcome` различает `other` («это документ, но ни один известный тип не
 * подходит» — уверенность может быть высокой) и `uncertain` («похоже на
 * известный тип, но не уверен»). Поведение разное: первый получает резервный
 * тип и запись в `doc_type_candidates`, второй — `needs_review` и гипотезу.
 * Одно значение на оба случая означало бы, что незнакомый раздел неотличим от
 * плохого скана, а правила §9.1 не смогут выдать `n_a` вместо `fail`.
 */

/** Тип блока разметки; повторяет `blockTypeSchema` контрактов. */
export type SegmentationBlockType = 'text' | 'image' | 'stamp';

/**
 * Метка страницы (§8.2).
 *
 * `B-DOC` — страница начинает документ, `I-DOC` — продолжает предыдущий,
 * `A-ROLE` — служебная роль (копия верна, лист подписи, приложение-продолжение),
 * `U` — сигнала нет.
 */
export type PageLabel = 'B-DOC' | 'I-DOC' | 'A-ROLE' | 'U';

/** Исход определения типа. См. шапку файла: `other` и `uncertain` — разное. */
export type TypeOutcome = 'known' | 'other' | 'uncertain' | 'none';

/** Чем получена метка. Входит в объяснение решения на экране документов. */
export type ClassificationSource = 'anchor' | 'blocks' | 'llm' | 'manual';

/** Доказательство: точный диапазон в конкретной версии текста страницы. */
export interface TextEvidence {
  readonly pageTextVersionId: string;
  /** Полуинтервал [start, end) в code unit'ах UTF-16 — `offset_convention` §3.5. */
  readonly charStart: number;
  readonly charEnd: number;
  /** Ровно `text.slice(charStart, charEnd)`, а не то, что вернула модель. */
  readonly quote: string;
}

/** Ручная разметка страницы: приоритетна внутри текущей ревизии (§8.2, фаза 3). */
export interface ManualLabel {
  readonly label: PageLabel;
  readonly docTypeCode: string | null;
  readonly pageRoleCode: string | null;
}

/**
 * Страница на входе классификатора.
 *
 * Здесь и текст, и метаданные страницы: четыре класса документов корпуса
 * (исполнительные схемы, продолжения без маркера, техпаспорт одним `image`,
 * разорванный заголовок) текстом не определяются в принципе, им нужен состав
 * блоков — это прямая находка S1, записанная в `docs/CORPUS_FINDINGS.md`.
 */
export interface PageInput {
  readonly sourcePageId: string;
  /** Сквозной порядок страницы в ревизии поставки. */
  readonly folderOrdinal: number;
  /** Смена файла — СЛАБЫЙ приор границы (§8.2): документ продолжается в другом файле. */
  readonly sourceFileId: string;
  readonly filePageIndex: number;
  /** Версия текста, в которой измеряются все `char_span`. `null` — текста нет. */
  readonly pageTextVersionId: string | null;
  /** `page_text_versions.text_md`. Пустая строка — страница без текста. */
  readonly text: string;
  /** Состав блоков страницы: схема — это `image` + `stamp` без якорей. */
  readonly blockTypes: readonly SegmentationBlockType[];
  readonly rotation: number;
  /** Ручная разметка: если задана, фазы 1–2 её не переопределяют. */
  readonly manual?: ManualLabel | null;
}

/** Решение по одной странице. Ровно одно на каждую страницу входа. */
export interface PageClassification {
  readonly sourcePageId: string;
  readonly label: PageLabel;
  /** Код каталога либо резервный код; `null` — тип не присвоен. */
  readonly docTypeCode: string | null;
  readonly typeOutcome: TypeOutcome;
  /**
   * Заголовок документа дословно.
   *
   * Обязателен при `typeOutcome === 'other'`: именно он нормализуется и уходит
   * в `doc_type_candidates`, то есть без него цикл роста каталога (§3.2) не
   * работает и незнакомый тип просто теряется.
   */
  readonly observedTitle: string | null;
  readonly pageRoleCode: string | null;
  /** Номер документа-родителя из якоря роли (`К сертификату соответствия №…`). */
  readonly parentRef: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly source: ClassificationSource;
  /** Проигравшие кандидаты: показываются инженеру, а не отбрасываются молча. */
  readonly alternatives: readonly string[];
  /** Несколько кандидатов равного приоритета — каталог их не различает. */
  readonly ambiguous: boolean;
  readonly evidence: TextEvidence | null;
}

/** Страница внутри собранного документа. */
export interface DecodedPage {
  readonly sourcePageId: string;
  readonly sortOrder: number;
  readonly pageRoleCode: string | null;
  /**
   * Присоединение стоит перепроверить человеку (S44).
   *
   * Не то же, что `DecodedDocument.needsReview`: тот про ВИД документа, этот —
   * про принадлежность конкретного листа. Лист приложения без номера родителя
   * присоединяется по соседству, и соседство — довод, а не доказательство.
   */
  readonly needsReview?: boolean;
  /** Чем именно присоединение не доказано; заполнено вместе с `needsReview`. */
  readonly reviewReason?: string;
}

/** Логический документ, собранный декодером. */
export interface DecodedDocument {
  readonly ordinal: number;
  /** Код каталога либо резервный (`other_*`, `unknown_document`). */
  readonly docTypeCode: string | null;
  readonly title: string | null;
  readonly typeConfidence: number | null;
  readonly boundaryConfidence: number | null;
  readonly needsReview: boolean;
  /** Наблюдённый заголовок для `doc_type_candidates`; заполнен при резервном типе. */
  readonly observedTitle: string | null;
  readonly pages: readonly DecodedPage[];
}

/** Учтённая, но не привязанная страница. Строка существует явно (§3.6). */
export interface DecodedUnassigned {
  readonly sourcePageId: string;
  readonly reason: string;
  readonly needsReview: boolean;
}

/**
 * Результат фазы 3.
 *
 * Инвариант: каждая страница входа встречается РОВНО один раз суммарно в
 * `documents[].pages` и `unassigned`. Это non-degradable гейт §1.6, и держат
 * его два независимых рубежа: проверка внутри декодера и уникальный индекс
 * `page_assignments_page_uq` вместе с представлением `v_unaccounted_pages`.
 */
export interface Segmentation {
  readonly documents: readonly DecodedDocument[];
  readonly unassigned: readonly DecodedUnassigned[];
}

/** Строка реестра приложений, разобранная из текста (§8.3). */
export interface ParsedRegistryRow {
  readonly rowNo: number;
  /** Заголовок раздела реестра («Документы, подтверждающие качество…»). */
  readonly sectionTitle: string | null;
  readonly docNameRaw: string;
  readonly docNoRaw: string | null;
  readonly orgRaw: string | null;
  readonly docNoNorm: string | null;
  readonly docNoFolded: string | null;
  /** ISO-даты `YYYY-MM-DD` либо `null`. */
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly issuedAt: string | null;
}

/** Значение реквизита, готовое к записи в `field_values`. */
export interface ExtractedField {
  readonly fieldCode: string;
  readonly valueText: string | null;
  readonly valueDate: string | null;
  readonly valueNum: string | null;
  readonly valueJson: unknown;
  readonly confidence: number;
  readonly extractedBy: 'rule' | 'llm';
  readonly evidence: TextEvidence | null;
}
