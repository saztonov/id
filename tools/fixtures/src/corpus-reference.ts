/**
 * Эталонная разметка корпуса (§17, S8, пункт 7).
 *
 * Закрытый корпус — 142 реальные страницы трёх комплектов двух разделов работ
 * — в git не попадает (§1.4). Попадает производный набор: геометрия страниц,
 * обезличенные тексты и ожидаемые метки. Он нужен для одного: измерить
 * качество сегментации методом leave-one-package-out (§16), не имея на машине
 * закрытых файлов.
 *
 * ## Три свойства, ради которых написан модуль
 *
 * 1. **Разметка `expected` сделана человеком по содержанию страниц, а не
 *    прогоном классификатора.** Эталон, размеченный проверяемой системой,
 *    измеряет ноль: любая её ошибка становится «правильным ответом». Таблица
 *    `PACKAGE_SPECS` ниже — результат чтения всех 142 страниц и сверки с
 *    `docs/CORPUS_FINDINGS.md`; спорные страницы помечены в комментариях и
 *    вынесены в `docs/PII_REVIEW.md`.
 *
 * 2. **Обезличивание идёт через `anonymizeText` из S1, а не через вторую
 *    копию.** Именно `anonymizeText` сохраняет валидность или намеренную
 *    невалидность контрольных сумм: битый ОГРН из 12 цифр остаётся
 *    двенадцатизначным и битым, иначе регрессия §16 проверяет пустоту.
 *    Здесь добавлены только те проходы, которых у него нет вовсе
 *    (наименования организаций, изувеченные OCR серийные номера ЭП, инициалы
 *    перед фамилией) — они дополняют обезличиватель, а не подменяют его,
 *    и перечислены в отчёте S8, чтобы решение «переносить ли их в
 *    `anonymize.ts`» принималось явно.
 *
 * 3. **Барьер, а не вычитка.** Генератор отказывается писать файл, если в
 *    результате нашёлся хоть один маркер `containsPii` или `pii-scan.mjs`, а
 *    тест `corpus-reference.test.ts` проверяет уже закоммиченные файлы при
 *    каждом прогоне. Урок S1 (`docs/EXECUTION_LOG.md`, пункт 6): разовой
 *    вычиткой ПДн в репозитории не удерживаются.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { anonymizeText, containsPii } from './anonymize.js';

// ---------------------------------------------------------------------------
// Типы эталонного набора
// ---------------------------------------------------------------------------

/**
 * Метка страницы. Повторяет `PageLabel` из `apps/api/src/segmentation/types.ts`.
 *
 * Тип объявлен здесь, а не импортирован: `@id/fixtures` не зависит от
 * `apps/api` и заводить такую зависимость ради четырёх литералов неправильно —
 * инструментальный пакет тянул бы за собой приложение. Значения обязаны
 * совпадать буквально; расхождение обнаружит тест метрик, который сравнивает
 * предсказания сегментатора с этими метками.
 */
export type ReferencePageLabel = 'B-DOC' | 'I-DOC' | 'A-ROLE' | 'U';

/** Исход определения типа. Повторяет `TypeOutcome` сегментации. */
export type ReferenceTypeOutcome = 'known' | 'other' | 'uncertain' | 'none';

/** Тип блока разметки. Повторяет `blockTypeSchema` контрактов. */
export type ReferenceBlockType = 'text' | 'image' | 'stamp';

/** Ожидаемое решение по странице. */
export interface ReferenceExpectation {
  readonly label: ReferencePageLabel;
  /** Код каталога либо резервный; `null` — тип странице не присваивается. */
  readonly docTypeCode: string | null;
  readonly typeOutcome: ReferenceTypeOutcome;
  readonly pageRoleCode: string | null;
  /** Логический документ, которому принадлежит страница; `null` — непривязанная. */
  readonly documentKey: string | null;
}

export interface ReferencePage {
  /** Сквозной порядок в комплекте, с 1. */
  readonly pageNo: number;
  /** ОБЕЗЛИЧЕННЫЙ текст страницы: тела блоков, склеенные пустой строкой. */
  readonly text: string;
  readonly blockTypes: readonly ReferenceBlockType[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
  readonly expected: ReferenceExpectation;
}

export interface ReferencePackage {
  /** Обезличенный ключ комплекта: без номера акта, шифра и адреса объекта. */
  readonly packageKey: string;
  /** `section_kinds.code`: 'roofing' | 'concrete_frame'. */
  readonly sectionKindCode: string;
  readonly pages: readonly ReferencePage[];
  /** Сколько строк ожидается в реестре приложений; `null` — реестра нет. */
  readonly expectedRegistryRowCount: number | null;
}

// ---------------------------------------------------------------------------
// Ручная разметка
// ---------------------------------------------------------------------------

/**
 * Документ эталона.
 *
 * Метки страниц выводятся отсюда механически: первая страница документа —
 * `B-DOC`, страница со служебной ролью — `A-ROLE`, прочие — `I-DOC`. Так
 * разметка задаётся в терминах, в которых её проверял человек («сертификат на
 * страницах 27–29, приложения на 28 и 29»), а не постранично, где легко
 * рассогласовать соседние строки.
 */
export interface ReferenceDocSpec {
  readonly key: string;
  /** Код каталога `packages/doc-types`; `null` — тип не присваивается. */
  readonly docTypeCode: string | null;
  readonly typeOutcome: ReferenceTypeOutcome;
  /** Страницы документа по порядку. Первая — граница документа. */
  readonly pages: readonly number[];
  /** Страница → код роли (`page_roles`). Такая страница получает `A-ROLE`. */
  readonly roles?: Readonly<Record<number, string>>;
}

export interface ReferencePackageSpec {
  readonly packageKey: string;
  readonly sectionKindCode: string;
  /**
   * Число страниц. Единственный признак, которым спецификация связывается с
   * папкой закрытого корпуса.
   *
   * По имени папки связывать нельзя: имена содержат номер акта, шифр раздела и
   * дату, то есть сами идентифицируют объект, а §1.4 запрещает такому попадать
   * в репозиторий. Число страниц у трёх комплектов различается (50, 9, 83), а
   * несовпадение немедленно роняет генератор — молчаливой подмены комплекта
   * не получится.
   */
  readonly pageCount: number;
  readonly expectedRegistryRowCount: number | null;
  readonly documents: readonly ReferenceDocSpec[];
}

/** Роли страниц, встреченные в корпусе. Совпадают с `PAGE_ROLES` каталога. */
const ROLE_COPY = 'copy_stamp';
const ROLE_SIGNATURE = 'signature_visual';
const ROLE_ANNEX = 'annex_continuation';

/**
 * Комплект A — кровля автостоянки, 50 страниц, реестр на 23 строки.
 *
 * Строение: акт (1–2), три исполнительные схемы (3–8, каждая с отдельным
 * листом визуализации ЭП), реестр приложений (9–10), затем доказательные
 * документы, каждый со своим листом «КОПИЯ ВЕРНА».
 *
 * Спорное место — страницы 4, 6, 8: на них нет ничего, кроме штампа ЭП, а
 * размер листа совпадает с предыдущей схемой. Отнесены к схеме ролью
 * `signature_visual`. Альтернатива («самостоятельная непривязанная страница»)
 * отвергнута: лист подписи без документа не существует, а совпадение формата
 * листа — прямое указание на родителя.
 */
const PACKAGE_A: ReferencePackageSpec = {
  packageKey: 'package-a',
  sectionKindCode: 'roofing',
  pageCount: 50,
  expectedRegistryRowCount: 23,
  documents: [
    { key: 'doc-01', docTypeCode: 'aosr', typeOutcome: 'known', pages: [1, 2] },
    {
      key: 'doc-02',
      docTypeCode: 'exec_scheme',
      typeOutcome: 'known',
      pages: [3, 4],
      roles: { 4: ROLE_SIGNATURE },
    },
    {
      key: 'doc-03',
      docTypeCode: 'exec_scheme',
      typeOutcome: 'known',
      pages: [5, 6],
      roles: { 6: ROLE_SIGNATURE },
    },
    {
      key: 'doc-04',
      docTypeCode: 'exec_scheme',
      typeOutcome: 'known',
      pages: [7, 8],
      roles: { 8: ROLE_SIGNATURE },
    },
    { key: 'doc-05', docTypeCode: 'annex_registry', typeOutcome: 'known', pages: [9, 10] },
    {
      key: 'doc-06',
      docTypeCode: 'declaration',
      typeOutcome: 'known',
      pages: [11, 12],
      roles: { 12: ROLE_COPY },
    },
    {
      key: 'doc-07',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [13, 14],
      roles: { 14: ROLE_COPY },
    },
    {
      key: 'doc-08',
      docTypeCode: 'declaration',
      typeOutcome: 'known',
      pages: [15, 16],
      roles: { 16: ROLE_COPY },
    },
    {
      key: 'doc-09',
      docTypeCode: 'declaration',
      typeOutcome: 'known',
      pages: [17, 18],
      roles: { 18: ROLE_COPY },
    },
    // Техпаспорт отдан единственным `image`-блоком: весь текст живёт в описании
    // графики (`docs/CORPUS_FINDINGS.md`). Тип виден в описании поля «Технический
    // паспорт №», поэтому это `known`, а не `uncertain`.
    {
      key: 'doc-10',
      docTypeCode: 'technical_passport',
      typeOutcome: 'known',
      pages: [19, 20],
      roles: { 20: ROLE_COPY },
    },
    {
      key: 'doc-11',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [21, 22],
      roles: { 22: ROLE_COPY },
    },
    {
      key: 'doc-12',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [23, 24],
      roles: { 24: ROLE_COPY },
    },
    {
      key: 'doc-13',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [25, 26],
      roles: { 26: ROLE_COPY },
    },
    {
      key: 'doc-14',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [27, 28],
      roles: { 28: ROLE_COPY },
    },
    {
      key: 'doc-15',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [29, 30],
      roles: { 30: ROLE_COPY },
    },
    {
      key: 'doc-16',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [31, 32],
      roles: { 32: ROLE_COPY },
    },
    {
      key: 'doc-17',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [33, 34],
      roles: { 34: ROLE_COPY },
    },
    {
      key: 'doc-18',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [35, 36],
      roles: { 36: ROLE_COPY },
    },
    {
      key: 'doc-19',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [37, 38],
      roles: { 38: ROLE_COPY },
    },
    {
      key: 'doc-20',
      docTypeCode: 'mix_quality_doc',
      typeOutcome: 'known',
      pages: [39, 40],
      roles: { 40: ROLE_COPY },
    },
    {
      key: 'doc-21',
      docTypeCode: 'lab_protocol_concrete',
      typeOutcome: 'known',
      pages: [41, 42],
      roles: { 42: ROLE_COPY },
    },
    {
      key: 'doc-22',
      docTypeCode: 'lab_protocol_concrete',
      typeOutcome: 'known',
      pages: [43, 44],
      roles: { 44: ROLE_COPY },
    },
    {
      key: 'doc-23',
      docTypeCode: 'lab_protocol_concrete',
      typeOutcome: 'known',
      pages: [45, 46],
      roles: { 46: ROLE_COPY },
    },
    {
      key: 'doc-24',
      docTypeCode: 'lab_protocol_concrete',
      typeOutcome: 'known',
      pages: [47, 48],
      roles: { 48: ROLE_COPY },
    },
    {
      key: 'doc-25',
      docTypeCode: 'lab_protocol_concrete',
      typeOutcome: 'known',
      pages: [49, 50],
      roles: { 50: ROLE_COPY },
    },
  ],
};

/**
 * Комплект B — кровля автостоянки, 9 страниц, реестра приложений нет.
 *
 * Самый короткий комплект и единственный без реестра: состав приложений
 * перечислен прямо в пункте 3 акта. Поэтому `expectedRegistryRowCount = null`,
 * и правило полноты обязано отработать без реестра, а не выдать «неполон».
 */
const PACKAGE_B: ReferencePackageSpec = {
  packageKey: 'package-b',
  sectionKindCode: 'roofing',
  pageCount: 9,
  expectedRegistryRowCount: null,
  documents: [
    { key: 'doc-01', docTypeCode: 'aosr', typeOutcome: 'known', pages: [1, 2] },
    {
      key: 'doc-02',
      docTypeCode: 'exec_scheme',
      typeOutcome: 'known',
      pages: [3, 4],
      roles: { 4: ROLE_SIGNATURE },
    },
    {
      key: 'doc-03',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [5, 6, 7],
      roles: { 6: ROLE_ANNEX, 7: ROLE_COPY },
    },
    {
      key: 'doc-04',
      docTypeCode: 'quality_passport',
      typeOutcome: 'known',
      pages: [8, 9],
      roles: { 9: ROLE_COPY },
    },
  ],
};

/**
 * Комплект C — несущие ЖБ конструкции, 83 страницы, реестр на 29 строк.
 *
 * Две особенности, ради которых комплект ценен как эталон:
 *
 * - Техническое заключение занимает 17 страниц подряд (6–22) без единого
 *   маркера «Лист N из M». Ровно тот класс, который текстом не определяется
 *   (`docs/CORPUS_FINDINGS.md`): 16 страниц из 17 обязаны получить `I-DOC` по
 *   структурному признаку, а не по якорю. Число 17 не выведено из вёрстки: на
 *   титуле напечатано «Всего на 17 страницах».
 * - Сертификат качества №469/26 занимает две страницы (77–78) и подписан
 *   «Лист 1 / Листов 2» и «Лист 2 / Листов 2» — единственный в корпусе случай
 *   явного маркера продолжения.
 *
 * Спорное место — страница 5: на ней только пятая подпись из подписного блока
 * реестра приложений. Отнесена к реестру как `I-DOC`, а не как отдельный лист
 * подписи: подписной блок начался на странице 4 и физически продолжается.
 */
const PACKAGE_C: ReferencePackageSpec = {
  packageKey: 'package-c',
  sectionKindCode: 'concrete_frame',
  pageCount: 83,
  expectedRegistryRowCount: 29,
  documents: [
    { key: 'doc-01', docTypeCode: 'aosr', typeOutcome: 'known', pages: [1, 2] },
    { key: 'doc-02', docTypeCode: 'annex_registry', typeOutcome: 'known', pages: [3, 4, 5] },
    {
      key: 'doc-03',
      docTypeCode: 'technical_conclusion',
      typeOutcome: 'known',
      pages: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
      roles: { 23: ROLE_COPY },
    },
    {
      key: 'doc-04',
      docTypeCode: 'declaration',
      typeOutcome: 'known',
      pages: [24, 25, 26],
      roles: { 25: ROLE_ANNEX, 26: ROLE_COPY },
    },
    {
      key: 'doc-05',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [27, 28, 29, 30],
      roles: { 28: ROLE_ANNEX, 29: ROLE_ANNEX, 30: ROLE_COPY },
    },
    {
      key: 'doc-06',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [31, 32],
      roles: { 32: ROLE_COPY },
    },
    {
      key: 'doc-07',
      docTypeCode: 'sanitary_conclusion',
      typeOutcome: 'known',
      pages: [33, 34, 35],
      roles: { 35: ROLE_COPY },
    },
    {
      key: 'doc-08',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [36, 37],
      roles: { 37: ROLE_COPY },
    },
    {
      key: 'doc-09',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [38, 39, 40],
      roles: { 39: ROLE_ANNEX, 40: ROLE_COPY },
    },
    {
      key: 'doc-10',
      docTypeCode: 'product_quality_doc',
      typeOutcome: 'known',
      pages: [41, 42],
      roles: { 42: ROLE_COPY },
    },
    {
      key: 'doc-11',
      docTypeCode: 'refusal_letter',
      typeOutcome: 'known',
      pages: [43, 44],
      roles: { 44: ROLE_COPY },
    },
    {
      key: 'doc-12',
      docTypeCode: 'cert_conformity',
      typeOutcome: 'known',
      pages: [45, 46],
      roles: { 46: ROLE_ANNEX },
    },
    // Разрешение на применение знака соответствия — самостоятельный документ,
    // а не приложение к предыдущему сертификату: у него свой номер, свой срок
    // и своя подпись. В реестре приложений он не значится вовсе.
    {
      key: 'doc-13',
      docTypeCode: 'permit_conformity_mark',
      typeOutcome: 'known',
      pages: [47, 48],
      roles: { 48: ROLE_COPY },
    },
    {
      key: 'doc-14',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [49, 50],
      roles: { 50: ROLE_COPY },
    },
    {
      key: 'doc-15',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [51, 52],
      roles: { 52: ROLE_COPY },
    },
    {
      key: 'doc-16',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [53, 54],
      roles: { 54: ROLE_COPY },
    },
    // Реестр называет этот лист «Паспорт качества Арматура №16005», а сам лист
    // озаглавлен «СЕРТИФИКАТ КАЧЕСТВА № 16005». Эталон следует документу, а не
    // реестру: сверка с реестром по виду документа невозможна в принципе,
    // только по номеру (`docs/CORPUS_FINDINGS.md`).
    {
      key: 'doc-17',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [55, 56],
      roles: { 56: ROLE_COPY },
    },
    {
      key: 'doc-18',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [57, 58],
      roles: { 58: ROLE_COPY },
    },
    {
      key: 'doc-19',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [59, 60],
      roles: { 60: ROLE_COPY },
    },
    {
      key: 'doc-20',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [61, 62],
      roles: { 62: ROLE_COPY },
    },
    {
      key: 'doc-21',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [63, 64],
      roles: { 64: ROLE_COPY },
    },
    {
      key: 'doc-22',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [65, 66],
      roles: { 66: ROLE_COPY },
    },
    {
      key: 'doc-23',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [67, 68],
      roles: { 68: ROLE_COPY },
    },
    {
      key: 'doc-24',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [69, 70],
      roles: { 70: ROLE_COPY },
    },
    {
      key: 'doc-25',
      docTypeCode: 'quality_passport',
      typeOutcome: 'known',
      pages: [71, 72],
      roles: { 72: ROLE_COPY },
    },
    {
      key: 'doc-26',
      docTypeCode: 'quality_passport',
      typeOutcome: 'known',
      pages: [73, 74],
      roles: { 74: ROLE_COPY },
    },
    {
      key: 'doc-27',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [75, 76],
      roles: { 76: ROLE_COPY },
    },
    {
      key: 'doc-28',
      docTypeCode: 'mill_certificate',
      typeOutcome: 'known',
      pages: [77, 78, 79],
      roles: { 79: ROLE_COPY },
    },
    {
      key: 'doc-29',
      docTypeCode: 'quality_passport',
      typeOutcome: 'known',
      pages: [80, 81],
      roles: { 81: ROLE_COPY },
    },
    {
      key: 'doc-30',
      docTypeCode: 'lab_protocol_metal',
      typeOutcome: 'known',
      pages: [82, 83],
      roles: { 83: ROLE_COPY },
    },
  ],
};

/** Спецификации трёх комплектов. Порядок задаёт порядок файлов эталона. */
export const PACKAGE_SPECS: readonly ReferencePackageSpec[] = [PACKAGE_A, PACKAGE_B, PACKAGE_C];

// ---------------------------------------------------------------------------
// Пути
// ---------------------------------------------------------------------------

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Корень репозитория. `src` и `dist` лежат на одной глубине, путь общий. */
const REPO_ROOT = join(HERE, '..', '..', '..');

/** Каталог закоммиченного эталона. */
export const REFERENCE_CORPUS_DIR = join(HERE, '..', 'corpus');

/**
 * Сканер ПДн. У него берётся ВЕРДИКТ по хэшам, а не значения маркеров.
 *
 * Экспортируется, чтобы тест мог утверждать инвариант «в исходнике сканера
 * нечего прочитать как значение» — см. `auditByPiiScanner`.
 */
export const PII_SCANNER_PATH = join(REPO_ROOT, 'tools', 'scripts', 'pii-scan.mjs');

/**
 * Каталог закрытого корпуса или `null`, если его на машине нет.
 *
 * Возврат `null` вместо исключения — намеренно: корпуса нет ни в CI, ни у
 * большинства разработчиков, и генератор обязан сказать об этом словами, а не
 * трассой стека.
 */
export function resolveGoldenCorpusDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['GOLDEN_CORPUS_DIR'];
  const dir =
    configured !== undefined && configured !== '' ? configured : join(REPO_ROOT, 'temp', 'MD');
  return existsSync(dir) ? dir : null;
}

// ---------------------------------------------------------------------------
// Разбор исходного комплекта
// ---------------------------------------------------------------------------

/** Страница исходного комплекта до обезличивания. */
export interface SourcePage {
  readonly pageNo: number;
  readonly text: string;
  readonly blockTypes: readonly ReferenceBlockType[];
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
}

interface BlocksJson {
  readonly pages?: readonly {
    page_index: number;
    width_px: number;
    height_px: number;
    rotation: number;
  }[];
  readonly blocks?: readonly { page_index: number; ordinal: number; block_type: string }[];
}

const BLOCK_TYPES: readonly string[] = ['text', 'image', 'stamp'];

function isBlockType(value: string): value is ReferenceBlockType {
  return BLOCK_TYPES.includes(value);
}

/**
 * Разбирает один комплект: `*_results.md` даёт текст по страницам и блокам,
 * `*_blocks.json` — геометрию и состав блоков.
 *
 * Из текста выбрасываются служебные строки экспорта (`> **Created:**`,
 * `> **Crop:**`, `> **Stamp:**`) и заголовки блоков. Первые две — метаданные
 * прогона со ссылками на чужой сервер, третья — разбор штампа их парсером, а
 * не текст страницы. Всё остальное сохраняется дословно: markdown-префиксы
 * `#####`, разрывы строк, таблицы и точки с запятой от OCR — те самые
 * структурные признаки, на которых ломались якоря S1.
 */
export function parseSourcePackage(dir: string): readonly SourcePage[] {
  const files = readdirSync(dir);
  const mdName = files.find((f) => f.endsWith('_results.md'));
  const jsonName = files.find((f) => f.endsWith('_blocks.json'));
  if (mdName === undefined || jsonName === undefined) {
    throw new Error(`В ${dir} нет пары *_results.md и *_blocks.json`);
  }

  const blocks = JSON.parse(readFileSync(join(dir, jsonName), 'utf8')) as BlocksJson;
  const geometry = blocks.pages ?? [];
  const typesByPage = new Map<number, { ordinal: number; type: ReferenceBlockType }[]>();
  for (const block of blocks.blocks ?? []) {
    if (!isBlockType(block.block_type)) continue;
    const list = typesByPage.get(block.page_index) ?? [];
    list.push({ ordinal: block.ordinal, type: block.block_type });
    typesByPage.set(block.page_index, list);
  }

  const bodies = parseMarkdownPages(readFileSync(join(dir, mdName), 'utf8'));
  if (bodies.length !== geometry.length) {
    throw new Error(`${dir}: страниц в md ${bodies.length}, в blocks.json ${geometry.length}`);
  }

  return geometry.map((page, index) => {
    const types = (typesByPage.get(page.page_index) ?? [])
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((b) => b.type);
    return {
      pageNo: index + 1,
      text: bodies[index] ?? '',
      blockTypes: types,
      widthPx: page.width_px,
      heightPx: page.height_px,
      rotation: page.rotation,
    };
  });
}

function parseMarkdownPages(markdown: string): readonly string[] {
  const pages: string[][] = [];
  let current: string[] | null = null;
  for (const line of markdown.split('\n')) {
    if (/^## Page \d+\s*$/.test(line)) {
      current = [];
      pages.push(current);
      continue;
    }
    if (current === null) continue;
    if (/^### BLOCK #\d+ \[/.test(line)) continue;
    if (/^> \*\*/.test(line)) continue;
    current.push(line);
  }
  return pages.map((lines) =>
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

// ---------------------------------------------------------------------------
// Детерминированный источник псевдослучайности
// ---------------------------------------------------------------------------

/**
 * Своя копия fnv1a+mulberry32: в `anonymize.ts` они не экспортированы, а
 * заменять там видимость ради производного набора неправильно — обезличиватель
 * S1 остаётся неприкосновенным. Требование к копии одно: детерминированность,
 * поэтому расхождение с оригиналом безвредно.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function rngFor(seed: string, kind: string, value: string): () => number {
  let state = fnv1a32(`${seed}|${kind}|${value}`) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_SEED = 'id-portal/corpus-reference/v1';

// ---------------------------------------------------------------------------
// Синтез наименований
// ---------------------------------------------------------------------------

const CYR_CONSONANTS = 'бвгдклмнпрстфх';
const CYR_VOWELS = 'аеиоуы';
const LAT_CONSONANTS = 'bdgklmnprstv';
const LAT_VOWELS = 'aeiou';

function isCyrillic(value: string): boolean {
  return /[А-Яа-яЁё]/.test(value);
}

/**
 * Заменяет наименование, сохраняя его форму: длину, регистр каждой буквы,
 * дефисы, кавычки, пробелы, количество цифр и алфавит.
 *
 * Форма сохраняется не для красоты. Кириллица обязана остаться кириллицей
 * (§1.4): сверка реестра с комплектом работает через фолдинг гомоглифов, и
 * если производный набор потеряет кириллические наименования, тест на фолдинг
 * перестанет что-либо проверять. По той же причине сохраняется длина: пороги
 * `pg_trgm.similarity` чувствительны к ней.
 */
function synthName(original: string, seed: string): string {
  const rng = rngFor(seed, 'org', original.toLowerCase());
  const cyrillic = isCyrillic(original);
  const consonants = cyrillic ? CYR_CONSONANTS : LAT_CONSONANTS;
  const vowels = cyrillic ? CYR_VOWELS : LAT_VOWELS;
  let letterIndex = 0;
  let out = '';
  for (const char of original) {
    if (/\d/.test(char)) {
      out += String(Math.floor(rng() * 10));
      continue;
    }
    if (!/[A-Za-zА-Яа-яЁё]/.test(char)) {
      out += char;
      letterIndex = 0;
      continue;
    }
    const alphabet = letterIndex % 2 === 0 ? consonants : vowels;
    const letter = alphabet.charAt(Math.floor(rng() * alphabet.length));
    out +=
      char === char.toUpperCase() && char !== char.toLowerCase() ? letter.toUpperCase() : letter;
    letterIndex += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Дополнительные проходы обезличивания
// ---------------------------------------------------------------------------

const LETTERS = 'A-Za-zА-Яа-яЁё';
const WB = `(?<![${LETTERS}0-9])`;
const WA = `(?![${LETTERS}0-9])`;

/**
 * Организационно-правовые формы и обёртки наименований.
 *
 * `ЖК` и «именуемый» здесь не случайны: название жилого комплекса и имя
 * корпуса идентифицируют объект не хуже наименования подрядчика.
 */
const ORG_PREFIX =
  '(?:ООО|ОАО|ЗАО|ПАО|АО|АНО|НАО|ПКФ|СРО|ЖК|ИП|' +
  'Общество\\s+с\\s+ограниченной\\s+ответственностью|' +
  'ОБЩЕСТВО\\s+С\\s+ОГРАНИЧЕННОЙ\\s+ОТВЕТСТВЕННОСТЬЮ|' +
  'Автономная\\s+Некоммерческая\\s+Организация|именуемый|Корпорация)';

/**
 * Наименование в кавычках.
 *
 * Внутренние кавычки разрешены намеренно: в корпусе застройщик записан как
 * `ООО "СЗ "АРЕНА "ВОСХОД"`, то есть кавычки вложены и не закрыты. Ленивая
 * группа доводит до той кавычки, за которой стоит разделитель, — иначе
 * наименование обрезалось бы на первой внутренней кавычке и уцелевший хвост
 * остался бы в репозитории.
 */
const ORG_QUOTED_RE = new RegExp(
  `${ORG_PREFIX}\\s*[«"“]([^»”\\n]{2,90}?)[»"”](?=[\\s,;.)|]|$)`,
  'g',
);

/** Наименование без кавычек: «ООО АЛЬФА-СТРОЙ» в разобранном штампе. */
const ORG_BARE_RE = new RegExp(
  `${ORG_PREFIX}\\s+([А-ЯЁ][А-ЯЁа-яё]{2,}(?:-[А-ЯЁ][А-ЯЁа-яё]*)*)${WA}`,
  'g',
);

/**
 * Латинское наименование изготовителя.
 *
 * Кириллическое «РОКВУЛ» и латинское «ROCKWOOL» — один и тот же поставщик, и
 * заменить только первое значит не заменить ничего: второе восстанавливает
 * первое однозначно. Роль-метка («ИЗГОТОВИТЕЛЬ», «Производитель») здесь
 * заменяет организационно-правовую форму, которой у латинского написания нет.
 */
const ORG_LATIN_RE =
  /(?:ИЗГОТОВИТЕЛЬ|Изготовитель|ПРОИЗВОДИТЕЛЬ|Производитель|ООО|АО|ЗАО|ОАО|ПАО)\s+([A-Z][A-Za-z-]{3,}(?:\s+[A-Z][A-Za-z-]{2,}){0,2})/g;

/**
 * Слова, которые не являются собственным именем организации.
 *
 * Список БОЛЬШЕ НЕ является основной защитой и пополняться не должен: общие
 * слова отсеивает измеримый критерий `occursAsProse`, и именно он обязан
 * держать удар на новом корпусе. Здесь остались слова, которые критерий один не
 * ловит, — те, что в этом корпусе не встречаются в связном тексте ни разу и
 * потому неотличимы от имени собственного по одному лишь регистру: «МОСКВА»,
 * «ГРУПП», «ЦЕНТР», «СТАЛЬ». Заменять их бессмысленно и вредно: они встречаются
 * в десятке наименований сразу, а замена сделала бы производный корпус
 * нечитаемым, ничего не скрыв.
 *
 * Измерено на закрытом корпусе: из слов списка критерий сам отсеивает
 * «качества», «системы», «центр» и «строительство», а нужен список ровно для
 * двенадцати: group, russia, бетон, бюро, групп, завод, москва, проектное,
 * системы, сталь, строительные, строй. Весь словарь документов, добавленный на
 * S9 («сертификат», «паспорт», «протокол», …), критерию не нужен и оставлен
 * нижней границей, а не механизмом.
 */
const GENERIC_ORG_WORDS: ReadonlySet<string> = new Set([
  'завод',
  'заводы',
  'филиал',
  'групп',
  'группа',
  'центр',
  'компания',
  'корпорация',
  'бюро',
  'проектное',
  'производственный',
  'строительные',
  'строительство',
  'строительная',
  'системы',
  'система',
  'управление',
  'проектами',
  'сертификация',
  'лаборатория',
  'испытательная',
  'россия',
  'российская',
  'федерация',
  'москва',
  'город',
  'клубный',
  'жилой',
  'комплекс',
  'реке',
  'дом',
  'плюс',
  // Отраслевые слова: в наименованиях они не собственные, а в обычном тексте
  // встречаются постоянно. Замена сделала бы текст нечитаемым, ничего не скрыв.
  'сталь',
  'строй',
  'бетон',
  'металл',
  'russia',
  'group',
  'company',
  'limited',
  'branch',
  // Словарь самих документов. Попав в наименование организации хотя бы один
  // раз («Центр качества», «Сертификация продукции»), такое слово уезжало в
  // ПОСЛОВНУЮ замену и уничтожалось по всему корпусу — включая заголовки, по
  // которым классификатор узнаёт вид документа.
  //
  // Цена ошибки измерена: слово «качества» заменялось на бессмысленное, и
  // заголовок «СЕРТИФИКАТ КАЧЕСТВА №…» переставал существовать на всех 13
  // страницах-началах `mill_certificate` в комплекте package-c. Якорь каталога
  // не срабатывал ни разу, boundary recall терял 22% корпуса, и число 0.746
  // описывало не качество сегментации, а ущерб от обезличивания.
  //
  // Наименование организации ЦЕЛИКОМ по-прежнему заменяется фразой: скрывает
  // участника именно она, а не отдельное нарицательное слово в её составе.
  'качества',
  'качество',
  'сертификат',
  'сертификаты',
  'сертификация',
  'паспорт',
  'паспорта',
  'протокол',
  'протоколы',
  'декларация',
  'соответствия',
  'соответствие',
  'испытаний',
  'испытания',
  'испытательный',
  'продукции',
  'продукция',
  'изготовитель',
  'производитель',
  'поставщик',
  'заказчик',
  'документ',
  'документа',
  'партия',
  'партии',
  'номер',
  'заключение',
  'экспертиза',
  'экспертизы',
]);

/** Организация в тексте: наименование целиком и его собственные слова. */
interface OrgVocabulary {
  readonly phrases: readonly string[];
  readonly words: readonly string[];
}

/** Полузакрытый интервал текста `[start, end)`. */
type TextSpan = readonly [number, number];

/**
 * Кавычки как признак имени.
 *
 * В деловом документе в кавычки берут именно название — организации, системы
 * сертификации, продукта. Шаблон нужен там, где организационно-правовая форма
 * стоит не перед наименованием, а после него («Филиал «Технофлекс» ООО») или
 * не печатается вовсе («компания „РОКВУЛ“ (Rockwool)» в описании печати).
 */
const QUOTED_NAME_RE = /[«"“]([^«»"“”\n]{2,90})[»”"]/g;

/**
 * Интервалы текста, распознанные как контекст наименования организации.
 *
 * Три источника: совпадение ORG-шаблона (само наименование), любой отрывок в
 * кавычках и доменное имя. Домен здесь не случаен: он идентифицирует
 * организацию не хуже наименования — ровно поэтому существует `scrubWebsites`,
 * — и `www.rockwool.ru` обязан считаться упоминанием организации, а не прозой.
 */
function nameContextSpans(text: string): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  for (const re of [ORG_QUOTED_RE, ORG_BARE_RE, ORG_LATIN_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const core = match[1];
      if (core === undefined) continue;
      const start = match.index + match[0].indexOf(core);
      spans.push([start, start + core.length]);
    }
  }
  for (const re of [QUOTED_NAME_RE, WEBSITE_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/**
 * Встречается ли слово в закрытом корпусе ХОТЬ РАЗ как обычная проза.
 *
 * Прозаическим считается вхождение, которое лежит вне всякого распознанного
 * контекста наименования И записано со строчной буквы. Строчная буква — не
 * эвристика вкуса, а машинный признак нарицательного: в русском деловом
 * документе собственное имя пишут с прописной или капсом, а нарицательное в
 * связном тексте — со строчной. Именно этим «сертификации» из фразы «в рамках
 * систем добровольной сертификации» отличается от «ПРОМСОРТ» из логотипа.
 *
 * Проверка идёт по вхождениям, а не по частоте: порога здесь нет и быть не
 * может. Измерено, что доля не разделяет классы — «ТехноНИКОЛЬ» встречается вне
 * шаблона чаще, чем «Корпус», хотя первое имя собственное, а второе нет.
 */
function occursAsProse(
  word: string,
  texts: readonly string[],
  contexts: readonly (readonly TextSpan[])[],
): boolean {
  const re = new RegExp(`${WB}${escapeRegExp(word)}${WA}`, 'gi');
  for (const [index, text] of texts.entries()) {
    const spans = contexts[index] ?? [];
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (spans.some(([from, to]) => start >= from && end <= to)) continue;
      const first = match[0].charAt(0);
      if (first === first.toLowerCase() && first !== first.toUpperCase()) return true;
    }
  }
  return false;
}

/**
 * Собирает наименования организаций по всему комплекту сразу.
 *
 * Сбор до замены и по всем страницам — обязателен: подрядчик, названный на
 * первой странице акта, встречается ещё в реестре, в документах о качестве и в
 * штампах «КОПИЯ ВЕРНА». Если заменять постранично, одна организация получит
 * разные синтетические имена, и сверка реестра с комплектом в производном
 * наборе развалится — а именно её этот набор и должен позволять измерять.
 *
 * Основной путь — замена ФРАЗОЙ: участника скрывает наименование целиком, а не
 * отдельное нарицательное слово в его составе. Пословная замена нужна только
 * там, где фраза не собирается: «ПромСорт-Тула» напечатано в логотипе двумя
 * строками, и дефиса между ними нет.
 *
 * Поэтому слово попадает в словарь замены, только если ИЗМЕРЕНО, что оно не
 * встречается в комплекте как обычная проза (`occursAsProse`). Стоп-лист общих
 * слов решением не был: он пополнялся после каждого нового корпуса, а цена
 * пропуска — молча испорченный эталон. Так «КАЧЕСТВА» на S8 уехало в пословную
 * замену и стёрло заголовок «СЕРТИФИКАТ КАЧЕСТВА №…» на тринадцати страницах, а
 * на S9 то же самое повторили «сертификации», «строительстве» и «менеджмента» —
 * формы слов, которых в списке не оказалось.
 */
function collectOrganizations(texts: readonly string[]): OrgVocabulary {
  const contexts = texts.map(nameContextSpans);
  const phrases = new Set<string>();
  const candidates = new Set<string>();
  for (const text of texts) {
    for (const re of [ORG_QUOTED_RE, ORG_BARE_RE, ORG_LATIN_RE]) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        const core = (match[1] ?? '').trim();
        if (core.length < 2) continue;
        phrases.add(core);
        // Дефис — разделитель, а не часть слова: «ПромСорт-Тула» встречается в
        // корпусе ещё и как логотип из двух строк, где дефиса нет вовсе.
        for (const word of core.split(/[^A-Za-zА-Яа-яЁё0-9]+/)) {
          if (word.length < 4) continue;
          if (GENERIC_ORG_WORDS.has(word.toLowerCase())) continue;
          candidates.add(word);
        }
      }
    }
  }
  const words = [...candidates].filter((word) => !occursAsProse(word, texts, contexts));
  // Длинные раньше коротких: иначе замена слова разрушит объемлющую фразу.
  const byLength = (a: string, b: string): number => b.length - a.length || a.localeCompare(b);
  return { phrases: [...phrases].sort(byLength), words: words.sort(byLength) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Заменяет собранные наименования во всём тексте комплекта. */
function replaceOrganizations(text: string, vocabulary: OrgVocabulary, seed: string): string {
  let out = text;
  for (const phrase of [...vocabulary.phrases, ...vocabulary.words]) {
    const re = new RegExp(`${WB}${escapeRegExp(phrase)}${WA}`, 'gi');
    out = out.replace(re, (match) => synthName(match, seed));
  }
  return out;
}

/**
 * Серийные номера ЭП, изувеченные OCR.
 *
 * `anonymizeText` ищет 30+ шестнадцатеричных символов подряд, а OCR читает в
 * штампе «КОПИЯ ВЕРНА» латинскую I вместо 1 и O вместо 0 — строка перестаёт
 * быть hex и проходит мимо обезличивателя. Таких вариантов в корпусе больше,
 * чем чистых: одну и ту же подпись OCR прочитал десятком способов.
 */
const MANGLED_CERT_RE = /(?<![0-9A-Za-z_])[0-9A-Z][0-9A-Z\s]{24,}[0-9A-Z](?![0-9A-Za-z_])/g;

function scrubMangledCertSerials(text: string, seed: string): string {
  return text.replace(MANGLED_CERT_RE, (match) => {
    const compact = match.replace(/\s+/g, '');
    if (compact.startsWith('0000')) return match;
    const hexish = compact.replace(/[^0-9A-F]/g, '').length / compact.length;
    if (hexish < 0.7) return match;
    const rng = rngFor(seed, 'cert', compact);
    let out = '';
    for (const char of match) {
      if (/\s/.test(char)) {
        out += char;
        continue;
      }
      out +=
        out.replace(/\s/g, '').length < 4 ? '0' : '0123456789ABCDEF'.charAt(Math.floor(rng() * 16));
    }
    return out;
  });
}

/**
 * ФИО с инициалами ПЕРЕД фамилией: «И.И. Иванов».
 *
 * `INITIALS_RE` обезличивателя рассчитан на порядок «Фамилия И. О.» и такую
 * запись не видит. Вместо второй реализации словарей фамилий строка
 * переставляется в понятный обезличивателю порядок, прогоняется через него и
 * собирается обратно: одна и та же фамилия получает одну и ту же замену в
 * обоих порядках, чего копия дать не смогла бы.
 */
const INITIALS_FIRST_RE = new RegExp(
  // Разделитель обязателен: либо точка после второго инициала, либо пробел
  // перед фамилией. Без этого требования шаблон принимает «Г.МОСКВА» за
  // человека «Г. М. Осква» — и адрес превращается в подписанта.
  `${WB}([А-ЯЁ])\\.\\s*([А-ЯЁ])(\\.\\s*|\\s+)([А-ЯЁ][А-Яа-яЁё]{2,})${WA}`,
  'g',
);

function scrubInitialsFirst(text: string, seed: string): string {
  return text.replace(
    INITIALS_FIRST_RE,
    (match, first: string, second: string, gap: string, surname: string) => {
      const probe = anonymizeText(`${surname} ${first}. ${second}.`, { seed });
      const parsed = /^(\S+)\s+(\S)\.\s*(\S)\.$/.exec(probe.trim());
      if (parsed === null) return match;
      if (parsed[1] === surname) return match;
      // Разделитель возвращается тот же, что был: в корпусе встречаются и
      // «Г.А.Иванова», и «Г.А. Иванова», и «И.Н Иванова» без второй точки.
      return `${parsed[2] ?? ''}.${parsed[3] ?? ''}${gap}${parsed[1] ?? ''}`;
    },
  );
}

/**
 * ФИО с инициалами через точку: «Иванова.Е.Н» в отметке ОТК.
 *
 * `INITIALS_RE` обезличивателя требует пробела между фамилией и инициалами, а
 * штамп отдела технического контроля печатает их через точку без пробела.
 */
const SURNAME_DOT_INITIALS_RE = new RegExp(
  `${WB}([А-ЯЁ][А-Яа-яЁё]{2,})\\.([А-ЯЁ])\\.([А-ЯЁ])(\\.?)${WA}`,
  'g',
);

function scrubSurnameDotInitials(text: string, seed: string): string {
  return text.replace(
    SURNAME_DOT_INITIALS_RE,
    (match, surname: string, first: string, second: string, tail: string) => {
      const probe = anonymizeText(`${surname} ${first}. ${second}.`, { seed });
      const parsed = /^(\S+)\s+(\S)\.\s*(\S)\.$/.exec(probe.trim());
      if (parsed === null || parsed[1] === surname) return match;
      return `${parsed[1]}.${parsed[2] ?? ''}.${parsed[3] ?? ''}${tail}`;
    },
  );
}

/**
 * ФИО без отчества после должности: «В ЛИЦЕ: ГЕНЕРАЛЬНЫЙ ДИРЕКТОР, ИВАНОВ ИВАН».
 *
 * `FULL_NAME_RE` требует отчества, а бланк декларации его не печатает. Приём
 * тот же, что с инициалами: строка подаётся обезличивателю в форме, которую он
 * разбирает.
 *
 * Собранная пара «оригинал → замена» применяется потом ко всему комплекту, а
 * не только к строке с должностью: в декларации то же ФИО стоит ещё раз ниже,
 * отдельной строкой под словом «Заявитель», где никакой должности рядом нет.
 * Одна строка на весь корпус — и в репозитории остаётся настоящее имя.
 */
const PERSON_AFTER_ROLE_RE = new RegExp(
  `В\\s+ЛИЦЕ:?[^,\\n]{0,60},\\s*([А-ЯЁ][А-ЯЁа-яё]{2,}\\s+[А-ЯЁ][А-ЯЁа-яё]{2,})${WA}`,
  'g',
);

function collectPersons(texts: readonly string[], seed: string): ReadonlyMap<string, string> {
  const persons = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(PERSON_AFTER_ROLE_RE)) {
      const person = match[1];
      if (person === undefined || persons.has(person)) continue;
      const replaced = anonymizeText(`Владелец: ${person}`, { seed }).replace(/^Владелец:\s*/, '');
      if (replaced !== person) persons.set(person, replaced);
    }
  }
  return persons;
}

function replacePersons(text: string, persons: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [original, replacement] of persons) {
    out = out.replace(new RegExp(`${WB}${escapeRegExp(original)}${WA}`, 'g'), replacement);
  }
  return out;
}

/**
 * Область, край и республика в адресе.
 *
 * Это адресный реквизит, а не имя человека, но обойти его нельзя по
 * механической причине: название одной из областей содержит подстроку из списка
 * фамилий `pii-scan.mjs`, и производный набор с ней не пройдёт барьер
 * репозитория. Заменяется вся адресная единица, чтобы не остался
 * полуобезличенный адрес.
 */
const REGION_RE = new RegExp(
  `${WB}([А-ЯЁ][а-яё]+(?:ская|ский|ской|ская))(\\s+(?:область|обл\\.|обл|край|район|АО))${WA}`,
  'g',
);
const REPUBLIC_RE = new RegExp(`(${WB}Республика\\s+)([А-ЯЁ][а-яё]+)${WA}`, 'g');

/**
 * Улицы, которых не видит обезличиватель, и почтовый индекс перед городом.
 *
 * `STREET_AFTER_RE` знает только полные слова («Вавилова улица»), а корпус
 * пишет сокращённо — «Вавилова ул, дом № 69/75», «Ермакова Роща ул». Точно так
 * же `POSTAL_INDEX_RE` требует, чтобы за индексом стояло «г.» или «обл.», а в
 * корпусе стоит «117335, Москва г». Обе записи — адрес подрядчика, и в
 * производный набор им нельзя.
 *
 * Оба шаблона самоограничены типом адресной единицы, поэтому проверка «строка
 * похожа на адрес» им не нужна: без слова «ул» или «шоссе» они не срабатывают.
 */
const STREET_TYPES =
  'ул|улица|ш|шоссе|наб|набережная|пер|переулок|б-р|бульвар|пр-кт|проспект|пл|площадь|проезд';
const STREET_AFTER_ABBR_RE = new RegExp(
  `${WB}([А-ЯЁ][А-Яа-яЁё]+(?:\\s+[А-ЯЁ][А-Яа-яЁё]+)?)(\\s+(?:${STREET_TYPES})\\.?${WA})`,
  'g',
);
// Пробел после сокращения необязателен, а сокращение «ш.» обезличиватель не
// знает вовсе: в его списке есть «шоссе», но не «ш», поэтому «Ш. КИЕВСКОЕ»
// проходило мимо. Повторная обработка уже синтетического названия безопасна —
// `anonymizeText` узнаёт свои топонимы и возвращает их без изменений.
const STREET_BEFORE_TIGHT_RE = new RegExp(
  // Точка тоже необязательна, а `\s*` намеренно пропускает перенос строки:
  // OCR разрывает адрес между «ул» и названием, а `anonymizeText` работает
  // построчно и такую пару не видит в принципе.
  `${WB}((?:${STREET_TYPES})\\.?\\s*)([А-ЯЁ][А-Яа-яЁё]+(?:\\s+[А-ЯЁ][А-Яа-яЁё]+)?)${WA}`,
  'g',
);
// Латиница после запятой нужна: часть паспортов качества дублирует адрес
// по-английски, и «140204, Voskresensk» — тот же самый настоящий индекс.
const POSTAL_BEFORE_CITY_RE = /(?<!\d)[1-6]\d{5}(?!\d)(?=\s*,\s*[А-ЯЁа-яёA-Za-z])/g;

/**
 * Синтетическое название улицы берётся у обезличивателя, а не выдумывается.
 *
 * У `containsPii` есть собственное представление о том, как выглядит
 * синтетический топоним (список основ плюс окончание), и название, придуманное
 * здесь, он объявит настоящим — справедливо, потому что отличить их иначе
 * нельзя. Поэтому имя подаётся `anonymizeText` в форме «ул. Название», которую
 * он разбирает, и обратно берётся его же замена.
 */
function synthStreetName(name: string, seed: string): string {
  const replaced = anonymizeText(`ул. ${name}`, { seed }).replace(/^ул\.\s+/, '');
  return replaced === name ? name : replaced;
}

function scrubStreets(text: string, seed: string): string {
  return text
    .replace(
      STREET_AFTER_ABBR_RE,
      (_match, name: string, tail: string) => synthStreetName(name, seed) + tail,
    )
    .replace(
      STREET_BEFORE_TIGHT_RE,
      (_match, label: string, name: string) => label + synthStreetName(name, seed),
    )
    .replace(POSTAL_BEFORE_CITY_RE, (index) => {
      const rng = rngFor(seed, 'postal', index);
      let out = '0';
      while (out.length < index.length) out += String(Math.floor(rng() * 10));
      return out;
    });
}

/**
 * ФИО без отчества отдельной строкой: «Иванова Ирина» под отметкой ОТК.
 *
 * Ни один шаблон обезличивателя такую запись не берёт: отчества нет, инициалов
 * нет, должности в той же строке нет. Признаком служит форма строки целиком —
 * ровно два слова с заглавной буквы, первое с фамильным суффиксом. Строка
 * целиком, а не подстрока, потому что иначе под шаблон попали бы «Российская
 * Федерация» и «Московская область»; запись капсом («РОССИЙСКАЯ ФЕДЕРАЦИЯ»)
 * шаблоном не берётся вовсе.
 */
const SURNAME_TAIL = '(?:ов|ев|ёв|ин|ын|ский|цкий|ова|ева|ёва|ина|ына|ская|цкая|енко|чук)';
const STANDALONE_PERSON_RE = new RegExp(`^([А-ЯЁ][а-яё]+${SURNAME_TAIL})\\s+([А-ЯЁ][а-яё]{2,})$`);

function scrubStandalonePersons(text: string, seed: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = STANDALONE_PERSON_RE.exec(line.trim());
      if (match === null) return line;
      const person = `${match[1] ?? ''} ${match[2] ?? ''}`;
      const replaced = anonymizeText(`Владелец: ${person}`, { seed }).replace(/^Владелец:\s*/, '');
      return replaced === person ? line : line.replace(person, replaced);
    })
    .join('\n');
}

/**
 * Внутригородской округ в адресе объекта.
 *
 * Улица, дом и индекс уже синтетические, а округ — нет, и он в паре с
 * описанием объекта возвращает адресу узнаваемость. Заменяется вместе с ними,
 * иначе обезличивание адреса половинчато.
 */
// `\w` в JavaScript — только ASCII, поэтому окончание слова «муниципальный»
// приходится писать явным кириллическим классом, иначе шаблон не срабатывает.
const MUNICIPALITY_RE =
  /(муниципальн[а-яё]*\s+(?:образование|округ)\s+)([А-ЯЁ][А-Яа-яЁё]+(?:-[А-ЯЁ][А-Яа-яЁё]+)?)/gi;

function scrubRegions(text: string, seed: string): string {
  return text
    .replace(REGION_RE, (_match, name: string, tail: string) => synthName(name, seed) + tail)
    .replace(REPUBLIC_RE, (_match, label: string, name: string) => label + synthName(name, seed))
    .replace(
      MUNICIPALITY_RE,
      (_match, label: string, name: string) => label + synthName(name, seed),
    );
}

/**
 * Телефоны, не подходящие под формат обезличивателя.
 *
 * `PHONE_RE` рассчитан на российский мобильный `+7 XXX XXX XX XX`. В корпусе
 * телефоны организаций записаны как «(495) 9562192», «(48143) 5-39-17»,
 * «+7-499-170-06-52», «+7 (484) 39 6-85-82» — ни один под шаблон не подходит.
 *
 * Правится вся строка, где есть метка телефона, а не первое вхождение после
 * неё: в корпусе за одной меткой стоит по три-четыре номера через запятую.
 * Разделители и длины сохраняются — правило, читающее телефон из реквизитов,
 * обязано продолжать видеть телефон.
 */
// Метка телефона либо код в скобках: в корпусе есть строки, где номер стоит
// в конце адреса вообще без слова «тел», и без второго признака они уцелели бы.
//
// Метка ищется с НАЧАЛА слова. Без этого «тел» находился внутри «строительстве»,
// «изготовитель», «потребитель», «свидетельство» — и вся строка объявлялась
// телефонной. Цена измерена: строка «ГОСТ 32314-2012 … применяемые в
// строительстве» попадала под `PHONE_RUN_RE`, и номер ГОСТа превращался в
// «ГОСТ 40001-0691» на 51 позиции. Дефект был не виден только потому, что
// пословная замена уже стёрла слово «строительстве» и метка не срабатывала:
// одна ошибка обезличивания маскировала другую.
const PHONE_LABEL_RE =
  /(?<![А-Яа-яЁёA-Za-z])(?:тел|факс|phone|fax|call-centre)|\(\d{3,5}\)\s*\d{2}/i;
const PHONE_RUN_RE = /(?<![\d.,])[+(]?\d[\d\s()-]{6,}\d(?!\d)/g;

/**
 * Цифры синтетического телефона.
 *
 * Ведущие 7 или 8 сохраняются, следующие три цифры принудительно обнуляются:
 * `containsPii` считает своим только код `000`, и номер с любым другим кодом
 * он справедливо объявит настоящим. Остальные цифры берутся из набора без 7 и
 * 8, чтобы внутри номера случайно не сложился второй, уже «чужой» телефон.
 */
const PHONE_DIGITS = '0123456123469';

function scrubLabelledPhones(text: string, seed: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!PHONE_LABEL_RE.test(line)) return line;
      return line.replace(PHONE_RUN_RE, (run) => {
        // Сплошная цифровая последовательность без разделителей — это ИНН,
        // ОГРН или индекс, стоящие в той же строке, что и телефон, а не номер.
        // Обезличиватель уже перевёл их в зарезервированное пространство, и
        // повторная случайная замена вернула бы их в «настоящее».
        if (!/[^\d]/.test(run)) return run;
        const rng = rngFor(seed, 'phone', run);
        let index = 0;
        return run.replace(/\d/g, (digit) => {
          const position = index;
          index += 1;
          if (position === 0 && (digit === '7' || digit === '8')) return digit;
          if (position >= 1 && position <= 3) return '0';
          return PHONE_DIGITS.charAt(Math.floor(rng() * PHONE_DIGITS.length));
        });
      });
    })
    .join('\n');
}

/**
 * ОГРН без метки.
 *
 * OCR прочитал слово «ОГРН» на круглой печати как «ОТРИ», и обезличиватель,
 * ищущий значение по метке, прошёл мимо настоящего регистрационного номера.
 * Значение подаётся `anonymizeText` с восстановленной меткой: только он умеет
 * сохранить состояние контрольной суммы, а именно оно здесь и важно — это тот
 * самый ОГРН из `docs/CORPUS_FINDINGS.md`, у которого не сходится контрольная
 * цифра и который обязан остаться несходящимся.
 */
const BARE_OGRN_RE = /(?<!\d)([1-9]\d{12}|[1-9]\d{14})(?!\d)/g;

function scrubBareOgrn(text: string, seed: string): string {
  return text.replace(BARE_OGRN_RE, (value) => {
    const probe = anonymizeText(`ОГРН ${value}`, { seed });
    const parsed = /ОГРН\s+(\d+)/.exec(probe);
    return parsed?.[1] ?? value;
  });
}

/**
 * Номер специалиста в национальном реестре (НРС НОСТРОЙ, НОПРИЗ).
 *
 * Это идентификатор ФИЗИЧЕСКОГО ЛИЦА: реестр специалистов публичен, и по номеру
 * восстанавливается фамилия, которую обезличиватель только что заменил. Без
 * этого прохода замена ФИО в акте была бы декоративной.
 *
 * Проход появился не от полноты, а по измерению. В корпусе таких номеров два.
 * Один (`С-69103647`) сплошной, и `scrubLabelledPhones` его не трогал никогда —
 * он пропускает непрерывные цифровые последовательности. Второй (`С-77-271747`)
 * с дефисами, и он гасился СЛУЧАЙНО: строка с ним содержит слово
 * «строительного», внутри которого прежний `PHONE_LABEL_RE` находил подстроку
 * «тел» и объявлял всю строку телефонной. Как только метка телефона стала
 * искаться с начала слова, номер проступил — то есть защиты у него не было
 * вовсе, была маскировка одной ошибки другой.
 */
const REGISTRY_ID_RE = /((?:НРС|НОСТРОЙ|НОПРИЗ)[^\n]{0,40}?№?\s*[СC]-)(\d[\d-]{5,}\d)/g;

function scrubRegistryIds(text: string, seed: string): string {
  return text.replace(REGISTRY_ID_RE, (_match, label: string, id: string) => {
    const rng = rngFor(seed, 'registry', id);
    return label + id.replace(/\d/g, () => String(Math.floor(rng() * 10)));
  });
}

/** Номера специалистов, найденные в комплекте, — для само-аудита. */
function collectRegistryIds(texts: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    REGISTRY_ID_RE.lastIndex = 0;
    for (const match of text.matchAll(REGISTRY_ID_RE)) {
      const id = match[2];
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Сайты организаций.
 *
 * Домен идентифицирует организацию так же, как её наименование, а `EMAIL_RE`
 * обезличивателя ловит только адреса почты. `.invalid` зарезервирован
 * RFC 2606 и не может принадлежать никому.
 */
const WEBSITE_RE =
  /(?<![@\w])((?:https?:\/\/)?(?:www\.)?)([A-Za-zА-Яа-я0-9-]+(?:\.[A-Za-zА-Яа-я0-9-]+)*)\.(?:ru|com|net|org|рф)(?![\w-])/g;

function scrubWebsites(text: string, seed: string): string {
  return text.replace(WEBSITE_RE, (match, scheme: string, host: string) => {
    if (match.includes('example.invalid')) return match;
    return `${scheme}${synthName(host, seed)}.invalid`;
  });
}

/**
 * Полное обезличивание одного комплекта.
 *
 * Порядок фиксирован: сначала `anonymizeText` (S1) — он единственный умеет
 * сохранять состояние контрольных сумм, — затем проходы, которых у него нет.
 * Обратный порядок сломал бы ФИО: синтетические наименования организаций
 * попали бы под шаблон фамилии.
 */
export function anonymizePackage(
  texts: readonly string[],
  seed: string = DEFAULT_SEED,
): readonly string[] {
  const base = texts.map((text) => anonymizeText(text, { seed }));
  const vocabulary = collectOrganizations(base);
  const persons = collectPersons(base, seed);
  return base.map((text) => {
    let out = replaceOrganizations(text, vocabulary, seed);
    out = replacePersons(out, persons);
    out = scrubMangledCertSerials(out, seed);
    out = scrubInitialsFirst(out, seed);
    out = scrubSurnameDotInitials(out, seed);
    out = scrubStandalonePersons(out, seed);
    out = scrubRegions(out, seed);
    out = scrubStreets(out, seed);
    out = scrubBareOgrn(out, seed);
    out = scrubRegistryIds(out, seed);
    out = scrubLabelledPhones(out, seed);
    out = scrubWebsites(out, seed);
    return out;
  });
}

// ---------------------------------------------------------------------------
// Барьер против ПДн
// ---------------------------------------------------------------------------

/**
 * Значения, которые обезличиватель заменил на этом прогоне.
 *
 * Прежде такой список читался из исходника `tools/scripts/pii-scan.mjs`
 * (`readPiiScanMarkers`), и это была ошибка в обе стороны. Сканеру знать
 * значения не нужно вовсе — ему достаточно уметь их узнать; а служба
 * справочником заставляла его хранить двенадцать настоящих фамилий открытым
 * текстом в отслеживаемом git файле, то есть делала стража ПДн их носителем.
 *
 * Источник значений у обезличивателя свой и законный: закрытый корпус, который
 * он и так читает (`resolveGoldenCorpusDir`). Наименования организаций, ФИО и
 * номера специалистов в НРС он находит сам — иначе не смог бы их заменить, — и
 * найденное здесь просто возвращается наружу как набор для само-аудита.
 * Никакого нового источника данных не появляется, а связь со сканером исчезает.
 *
 * Считается по тем же шагам, что и в `anonymizePackage`, и по той же причине:
 * собирать словарь надо ПОСЛЕ `anonymizeText` и ПО ВСЕМУ комплекту сразу.
 */
export function collectPackageMarkers(
  texts: readonly string[],
  seed: string = DEFAULT_SEED,
): readonly string[] {
  const base = texts.map((text) => anonymizeText(text, { seed }));
  const vocabulary = collectOrganizations(base);
  const persons = collectPersons(base, seed);
  return [
    ...vocabulary.phrases,
    ...vocabulary.words,
    ...persons.keys(),
    ...collectRegistryIds(base),
  ];
}

/**
 * Проверяет текст двумя независимыми способами и возвращает список претензий.
 *
 * Оба нужны. `containsPii` знает про формы (ИНН, ОГРН, ФИО, адрес) и ловит то,
 * чего в списке маркеров нет; список маркеров знает конкретные значения корпуса
 * и ловит то, под форму не подходящее, — например наименование организации.
 *
 * `markers` обязателен намеренно. Пока он был необязательным, забытый аргумент
 * молча вырождал проверку в «только по форме», и выглядело это как успех.
 * Там, где значений корпуса нет (машина без `GOLDEN_CORPUS_DIR`), пустой
 * массив передаётся явно — это заявление, а не умолчание.
 */
export function auditCorpusPii(text: string, markers: readonly string[]): readonly string[] {
  const problems: string[] = [...containsPii(text).findings];
  for (const marker of markers) {
    // Маркер ищется как ОТДЕЛЬНОЕ слово и без учёта регистра — ровно тем же
    // предикатом, каким `replaceOrganizations` его заменяет. Иначе аудит
    // спрашивает не то, на что отвечает замена, и барьер срабатывает на шуме.
    //
    // Подстрочное `includes` именно так и провалило генерацию на S9: маркер
    // «УРАЛ» нашёлся внутри СИНТЕТИЧЕСКОГО имени «ПАНУРАЛОХИ», которое сам же
    // обезличиватель и сочинил из случайных букв, «НИЦ» — внутри слова
    // «МУНИЦИПАЛЬНЫЙ», а «сертификации» — внутри «Мостройсертификации». Ни
    // одно из трёх не является пережившим обезличивание значением, а барьер
    // при этом становился зависимым от зерна: вероятность подстроки из четырёх
    // букв в случайном имени не нулевая.
    if (new RegExp(`${WB}${escapeRegExp(marker)}${WA}`, 'i').test(text)) {
      problems.push(`маркер обезличивателя: «${marker}»`);
    }
  }
  return problems;
}

/** Вердикт сканера ПДн: класс сработавшего маркера без самого значения. */
export interface PiiScanVerdict {
  readonly class: string;
}

/**
 * Третий, независимый рубеж: вердикт `tools/scripts/pii-scan.mjs` по хэшам.
 *
 * Через эту границу не проходит ни одного плоского значения ни в одну сторону:
 * обезличиватель отдаёт текст и получает КЛАСС сработавшего маркера. Сканер
 * остаётся хранителем хэшей и ничьим справочником не становится.
 *
 * Загрузка динамическая и по вычисляемому пути: сканер — исполняемый скрипт вне
 * пакета воркспейса, и статический импорт вытащил бы его в `rootDir` сборки.
 */
export async function auditByPiiScanner(
  text: string,
  path: string = PII_SCANNER_PATH,
): Promise<readonly string[]> {
  const module: unknown = await import(pathToFileURL(path).href);
  const scanText = (module as { scanText?: unknown }).scanText;
  if (typeof scanText !== 'function') {
    throw new Error(`В ${path} нет экспортированной функции scanText`);
  }
  const hits = (await (scanText as (value: string) => Promise<readonly PiiScanVerdict[]>)(
    text,
  )) as readonly PiiScanVerdict[];
  return hits.map((hit) => `сканер ПДн: маркер класса «${hit.class}»`);
}

// ---------------------------------------------------------------------------
// Сборка эталона
// ---------------------------------------------------------------------------

/**
 * Собирает эталонный комплект из разобранных страниц и ручной разметки.
 *
 * Здесь же проверяются инварианты разметки: страница не может принадлежать
 * двум документам, а непокрытых страниц быть не должно. Инвариант назначения
 * страниц — non-degradable гейт §1.6, и эталон, его нарушающий, сделал бы
 * измерение этого гейта бессмысленным.
 */
export function buildReferencePackage(
  spec: ReferencePackageSpec,
  pages: readonly SourcePage[],
  anonymizedTexts: readonly string[],
): ReferencePackage {
  if (pages.length !== spec.pageCount) {
    throw new Error(
      `${spec.packageKey}: ожидалось ${spec.pageCount} страниц, получено ${pages.length}`,
    );
  }

  const assignment = new Map<number, ReferenceExpectation>();
  for (const doc of spec.documents) {
    doc.pages.forEach((pageNo, index) => {
      if (assignment.has(pageNo)) {
        throw new Error(`${spec.packageKey}: страница ${pageNo} назначена дважды`);
      }
      if (pageNo < 1 || pageNo > spec.pageCount) {
        throw new Error(`${spec.packageKey}: страница ${pageNo} вне комплекта`);
      }
      const role = doc.roles?.[pageNo] ?? null;
      const label: ReferencePageLabel = role !== null ? 'A-ROLE' : index === 0 ? 'B-DOC' : 'I-DOC';
      assignment.set(pageNo, {
        label,
        // Служебная страница собственного типа не несёт: тип принадлежит
        // документу, к которому она присоединена, а не листу «КОПИЯ ВЕРНА».
        docTypeCode: role !== null ? null : doc.docTypeCode,
        typeOutcome: role !== null ? 'none' : doc.typeOutcome,
        pageRoleCode: role,
        documentKey: doc.key,
      });
    });
  }

  const referencePages = pages.map((page, index) => {
    const expected = assignment.get(page.pageNo) ?? {
      label: 'U' as const,
      docTypeCode: null,
      typeOutcome: 'none' as const,
      pageRoleCode: null,
      documentKey: null,
    };
    return {
      pageNo: page.pageNo,
      text: anonymizedTexts[index] ?? '',
      blockTypes: page.blockTypes,
      widthPx: page.widthPx,
      heightPx: page.heightPx,
      rotation: page.rotation,
      expected,
    };
  });

  return {
    packageKey: spec.packageKey,
    sectionKindCode: spec.sectionKindCode,
    pages: referencePages,
    expectedRegistryRowCount: spec.expectedRegistryRowCount,
  };
}

// ---------------------------------------------------------------------------
// Загрузка закоммиченного эталона
// ---------------------------------------------------------------------------

/** Имя файла эталона по ключу комплекта. */
export function referenceFileName(packageKey: string): string {
  return `${packageKey}.json`;
}

/**
 * Читает закоммиченный эталон.
 *
 * Работает без закрытого корпуса — в этом весь смысл производного набора:
 * метрики §16 считаются в CI, где реальных 142 страниц нет и не будет.
 */
export function loadReferenceCorpus(
  dir: string = REFERENCE_CORPUS_DIR,
): readonly ReferencePackage[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as ReferencePackage);
}

/**
 * Сериализация эталона: стабильная, без отметок времени.
 *
 * Короткий массив типов блоков схлопывается в одну строку не ради красоты:
 * ровно так его печатает prettier, а `pnpm format:check` входит в общий гейт.
 * Расхождение сделало бы гейт красным сразу после генерации, и «починка»
 * форматтером тут же разошлась бы с выводом генератора — тест на дрейф между
 * разметкой и файлом перестал бы проходить.
 */
export function serializeReferencePackage(pkg: ReferencePackage): string {
  const json = JSON.stringify(pkg, null, 2).replace(
    /"blockTypes": \[\n(\s*)([\s\S]*?)\n\s*\]/g,
    (_match, _indent: string, body: string) =>
      `"blockTypes": [${body
        .split('\n')
        .map((line) => line.trim())
        .join(' ')}]`,
  );
  return `${json}\n`;
}
