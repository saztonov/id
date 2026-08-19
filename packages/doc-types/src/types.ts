/**
 * Типы каталога видов исполнительной документации.
 *
 * Каталог живёт в коде как источник правды (типизация и автодополнение в
 * правилах проверки), а в БД попадает seed-миграцией. Пользовательские
 * настройки хранятся отдельной таблицей `doc_type_overrides` и seed'ом
 * не затираются.
 *
 * Мир открытый: корпус покрывает лишь два раздела работ из многих, поэтому
 * каталог заведомо неполон и обязан иметь резервные типы (`isFallback`).
 * Документ, не подошедший ни под один известный тип, получает резервный,
 * а его заголовок уходит в `doc_type_candidates` для пополнения справочника.
 */

/** Группа каталога. Определяет папку в дереве документов и раздел в UI. */
export type DocTypeGroup =
  | 'acts'
  | 'exec_schemes'
  | 'registries_logs'
  | 'quality_docs'
  | 'tests_conclusions'
  | 'networks'
  | 'facade'
  | 'org'
  | 'handover'
  | 'fallback';

/**
 * Роль документа в комплекте.
 *
 * - `primary` — управляющий документ, вокруг которого строится комплект (АОСР).
 * - `registry` — реестр приложений: перечень ожидаемого состава.
 * - `evidence` — доказательный документ (сертификат, паспорт, протокол).
 * - `fallback` — резервный тип для открытого мира.
 */
export type DocTypeKind = 'primary' | 'registry' | 'evidence' | 'fallback';

/** Тип значения извлекаемого реквизита. */
export type FieldType = 'text' | 'date' | 'date_range' | 'number' | 'list' | 'table';

/**
 * Чем извлекается реквизит.
 *
 * `rule` — детерминированный парсер: даты, номера, ИНН/ОГРН, ГОСТ, партии.
 * `llm` — семантика: наименования работ и продукции, привязки по осям.
 */
export type FieldExtractor = 'rule' | 'llm';

export interface FieldDefinition {
  readonly code: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly extractor: FieldExtractor;
}

/**
 * Признаки распознавания типа.
 *
 * Шаблоны хранятся строками, а не литералами `RegExp`, потому что уезжают
 * в JSONB seed-миграции и редактируются администратором. Компиляция —
 * через `compileAnchors()`, там же валидируется корректность выражения.
 */
export interface MatchHints {
  /** Якорные шаблоны заголовка. Срабатывание любого — кандидат на тип. */
  readonly anchors: readonly string[];
  /** Шаблоны, наличие которых ИСКЛЮЧАЕТ тип. Пример: «ПРИЛОЖЕНИЕ» у сертификата. */
  readonly negativeAnchors?: readonly string[];
  /** Дополнительные признаки в теле, повышающие уверенность. */
  readonly bodyHints?: readonly string[];
  /**
   * Индивидуальный размер зоны заголовка для якорей ЭТОГО типа.
   *
   * Нужен формам, где титул стоит ниже общего окна `DEFAULT_HEADING_LINES`:
   * в бланке АОСР по приказу №344/пр шапка с объектом и четырьмя участниками
   * идёт ПЕРЕД титулом, и строка «освидетельствования скрытых работ»
   * оказывается 28–31-й (замер на temp/MD/new, пять актов). Расширять окно
   * всем типам сразу нельзя: замер там же показал ложные срабатывания
   * (паспорт качества → декларация на упоминании в глубине страницы).
   */
  readonly headingLines?: number;
}

export interface DocTypeDefinition {
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly group: DocTypeGroup;
  readonly kind: DocTypeKind;
  /** Бывают ли у типа приложения-продолжения (приложение к сертификату). */
  readonly hasAnnexes: boolean;
  /** Резервный тип открытого мира. */
  readonly isFallback: boolean;
  /**
   * Встречался ли тип в закрытом корпусе двух разделов.
   *
   * У типов с `false` якоря и схемы полей — гипотезы из нормативного состава,
   * не проверенные на реальных документах. Это влияет на доверие к правилам
   * и на приоритет калибровки при появлении новых разделов.
   */
  readonly observedInCorpus: boolean;
  readonly matchHints: MatchHints;
  /** Специфичные для типа реквизиты. Базовые добавляются отдельно. */
  readonly fieldSchema: readonly FieldDefinition[];
  readonly sortOrder: number;
  /**
   * Специфичность типа при конфликте якорей. Больше — точнее, по умолчанию 0.
   *
   * Нужна там, где общий заголовок не позволяет определить подвид. «Протокол
   * об испытаниях №1753.КП/02.26» — это протокол, но бетона или металла,
   * видно лишь из подзаголовка «по определению прочности раствора».
   * Поэтому подвиды получают высокий приоритет, а обобщающий тип — нулевой:
   * при наличии подзаголовка выигрывает подвид, без него документ всё равно
   * не теряется и остаётся опознан как протокол.
   */
  readonly priority?: number;
}

/**
 * Роль страницы — ортогональна типу документа.
 *
 * «КОПИЯ ВЕРНА», лист штампа ЭП, пустая страница и приложение-продолжение
 * не являются самостоятельными видами ИД: это роли страниц внутри документа.
 */
export type PageRoleCode = 'blank' | 'copy_stamp' | 'signature_visual' | 'annex_continuation';

export interface PageRoleDefinition {
  readonly code: PageRoleCode;
  readonly name: string;
  /**
   * Присоединяется ли страница к предыдущему документу автоматически.
   *
   * У пустой страницы — `false`: она может быть разделителем, и решать это
   * должен человек, а не эвристика.
   */
  readonly autoAttach: boolean;
  readonly matchHints: MatchHints;
}

/** Скомпилированный якорь с исходной строкой — для сообщений об ошибках. */
export interface CompiledAnchor {
  readonly source: string;
  readonly regex: RegExp;
}

/**
 * Компилирует шаблоны в регулярные выражения.
 *
 * Флаги фиксированы: `i` — регистронезависимость (в сканах регистр плавает),
 * `m` — многострочность (заголовок ищется построчно), `u` — корректная
 * работа с кириллицей.
 */
export function compileAnchors(patterns: readonly string[]): readonly CompiledAnchor[] {
  return patterns.map((source) => {
    try {
      return { source, regex: new RegExp(source, 'imu') };
    } catch (cause) {
      throw new Error(`Некорректный шаблон якоря: ${source}`, { cause });
    }
  });
}
