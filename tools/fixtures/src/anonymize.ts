/**
 * Обезличиватель закрытого корпуса ИД (§1.4 плана).
 *
 * Настоящие 142 страницы содержат ФИО, ИНН, ОГРН, адреса и телефоны и в git не
 * попадают. Отсюда получается производный набор, пригодный для тестов в
 * репозитории.
 *
 * Два свойства, ради которых модуль существует:
 *
 * 1. **Контрольные суммы сохраняют своё состояние.** Валидный ИНН заменяется на
 *    валидный, невалидный — на невалидный, ОГРН из 12 цифр остаётся из 12 цифр
 *    и остаётся битым. Иначе обезличиватель молча «починит» дефект, и
 *    регрессионный тест на битый ОГРН перестанет проверять хоть что-нибудь.
 *
 *    «Валидный» здесь означает ровно то же, что для портала: и проверка, и
 *    порождение контрольных цифр берутся из `@id/contracts`. Своей арифметики у
 *    обезличивателя нет намеренно — она тут была, с теми же весами и модулями, и
 *    именно совпадение делало её опасной. Разойдись копии на один вес, «битый
 *    ОГРН» производного корпуса стал бы валидным для проверок, а тест на этот
 *    дефект остался бы зелёным, проверяя пустоту.
 *
 * 2. **Все синтетические значения лежат в зарезервированном пространстве,**
 *    недостижимом для настоящих реквизитов: ИНН и КПП начинаются с `00`
 *    (региона 00 не существует), ОГРН — с `0` (признака 0 не существует),
 *    почтовый индекс — с `0`, код телефона — `000`, серийный номер ЭП — с
 *    `0000`, фамилии и топонимы порождаются встроенными словарями. Только
 *    поэтому `containsPii` способен отличить остаток настоящих ПДн от
 *    результата собственной работы обезличивателя.
 *
 * `containsPii` — помощник, а не доказательство. §1.4 требует ручного
 * PII-review в `docs/PII_REVIEW.md`, и он остаётся обязательным: эвристики
 * адресов и ФИО принципиально неполны, а настоящая фамилия теоретически может
 * совпасть с грамматикой синтетического словаря.
 */
import { checkInn, checkOgrn, innControlDigits, ogrnControlDigit } from '@id/contracts';

export interface AnonymizeOptions {
  /** Соль. Разные seed дают разные, но одинаково детерминированные наборы. */
  readonly seed?: string;
}

export interface PiiReport {
  readonly clean: boolean;
  readonly findings: string[];
}

const DEFAULT_SEED = 'id-portal/anonymizer/v1';

// ---------------------------------------------------------------------------
// Зарезервированное синтетическое пространство
// ---------------------------------------------------------------------------

const SYNTH_INN_PREFIX = '00';
const SYNTH_KPP_PREFIX = '00';
const SYNTH_OGRN_PREFIX = '0';
const SYNTH_POSTAL_PREFIX = '0';
const SYNTH_PHONE_CODE = '000';
const SYNTH_HEX_PREFIX = '0000';

// ---------------------------------------------------------------------------
// Детерминированный источник псевдослучайности
// ---------------------------------------------------------------------------

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Поток псевдослучайных чисел, зависящий только от seed, вида значения и самого
 * значения. Это и даёт стабильность: одна и та же фамилия всюду в корпусе
 * получает одну и ту же замену, а Math.random не используется вовсе.
 */
function rngFor(seed: string, kind: string, value: string): () => number {
  return mulberry32(fnv1a32(`${seed}|${kind}|${value}`));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('Словарь синтетических значений пуст');
  return item;
}

function pickChar(rng: () => number, alphabet: string): string {
  return alphabet.charAt(Math.floor(rng() * alphabet.length));
}

function randomDigits(rng: () => number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += String(Math.floor(rng() * 10));
  return out;
}

/**
 * Портит контрольную цифру гарантированно: сдвиг всегда в диапазоне 1..9.
 *
 * Цифра — строка, потому что такими их отдаёт `@id/contracts`: у 12-значного ИНН
 * контрольных цифр две, и «06» это не 6.
 */
function spoilDigit(digit: string, rng: () => number): string {
  return String((Number(digit) + 1 + Math.floor(rng() * 9)) % 10);
}

// ---------------------------------------------------------------------------
// Реквизиты с контрольной суммой
// ---------------------------------------------------------------------------

/**
 * Веса, модули и делители здесь не повторяются: и «валиден ли исходный реквизит»,
 * и «какая цифра нужна синтетическому» спрашиваются у `@id/contracts` — того же
 * модуля, которым портал будет судить получившийся корпус (§1.4).
 */
function synthInn(original: string, seed: string): string {
  const rng = rngFor(seed, 'inn', original);
  const keepValid = checkInn(original).ok;
  if (original.length === 10) {
    const body = SYNTH_INN_PREFIX + randomDigits(rng, 7);
    const check = innControlDigits(body);
    return body + (keepValid ? check : spoilDigit(check, rng));
  }
  if (original.length === 12) {
    const body = SYNTH_INN_PREFIX + randomDigits(rng, 8);
    // Две цифры сразу; портится только вторая, поэтому невалидность остаётся той
    // же природы, что у исходного значения, — расхождение в последнем знаке.
    const control = innControlDigits(body);
    const eleventh = control.slice(0, 1);
    const twelfth = control.slice(1);
    return body + eleventh + (keepValid ? twelfth : spoilDigit(twelfth, rng));
  }
  // Длина не 10 и не 12 — сама по себе дефект распознавания. Сохраняем её:
  // правило проверки формата обязано продолжать срабатывать.
  return (
    SYNTH_INN_PREFIX + randomDigits(rng, Math.max(original.length - SYNTH_INN_PREFIX.length, 0))
  );
}

/**
 * Делитель по длине (11 у ОГРН, 13 у ОГРНИП) выбирает `ogrnControlDigit`.
 *
 * Раньше выбор был и здесь: задание называло 11 для обеих длин, и промах в эту
 * сторону закрепил бы «невалидность» настоящего ОГРНИП в производном корпусе как
 * факт. Теперь выбирать нечего — длина тела определяет делитель в одном месте.
 */
function synthOgrn(original: string, seed: string): string {
  const rng = rngFor(seed, 'ogrn', original);
  const keepValid = checkOgrn(original).ok;
  const build = (bodyLength: number): string => {
    const body = SYNTH_OGRN_PREFIX + randomDigits(rng, bodyLength - SYNTH_OGRN_PREFIX.length);
    const check = ogrnControlDigit(body);
    return body + (keepValid ? check : spoilDigit(check, rng));
  };
  if (original.length === 13) return build(12);
  if (original.length === 15) return build(14);
  // Ровно тот случай, ради которого писался модуль: битый ОГРН из 12 цифр
  // остаётся из 12 цифр и остаётся битым — длина сама по себе делает его таким.
  return (
    SYNTH_OGRN_PREFIX + randomDigits(rng, Math.max(original.length - SYNTH_OGRN_PREFIX.length, 0))
  );
}

function synthKpp(original: string, seed: string): string {
  const rng = rngFor(seed, 'kpp', original);
  return (
    SYNTH_KPP_PREFIX + randomDigits(rng, Math.max(original.length - SYNTH_KPP_PREFIX.length, 0))
  );
}

// ---------------------------------------------------------------------------
// Словари синтетических значений
// ---------------------------------------------------------------------------

const SURNAME_PREFIXES: readonly string[] = [
  'Бел',
  'Вер',
  'Гор',
  'Дуб',
  'Жар',
  'Зор',
  'Кам',
  'Лип',
  'Мор',
  'Нов',
  'Пав',
  'Рощ',
  'Свет',
  'Тих',
  'Хол',
  'Ясн',
];
const SURNAME_MIDDLES: readonly string[] = [
  'ан',
  'ар',
  'ен',
  'ер',
  'ин',
  'ол',
  'ур',
  'ыр',
  'ад',
  'ит',
  'ум',
  'яр',
];
const SURNAME_ENDINGS: readonly string[] = ['ов', 'ев', 'ин', 'ский'];

const SYNTHETIC_SURNAME_RE = new RegExp(
  `^(?:${SURNAME_PREFIXES.join('|')})(?:${SURNAME_MIDDLES.join('|')})(?:(?:ов|ев|ин)а?|ск(?:ий|ая))$`,
  'i',
);

const STREET_STEMS: readonly string[] = [
  'Берёзов',
  'Ветрян',
  'Журавлин',
  'Заречн',
  'Каменск',
  'Лугов',
  'Малинов',
  'Ольхов',
  'Полев',
  'Приозёрн',
  'Родников',
  'Светлогорск',
  'Соловьин',
  'Сосновск',
  'Тихомировск',
  'Ясеневск',
];

const SYNTHETIC_STREET_RE = new RegExp(`^(?:${STREET_STEMS.join('|')})(?:ая|ое|ый)$`, 'i');

/** Буквы, для которых есть синтетические имена. Основа перестановки инициалов. */
const NAME_LETTERS = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ';

/** Все имена оканчиваются на согласную: отчество строится как имя + «ович». */
const MALE_NAMES: Readonly<Record<string, readonly string[]>> = {
  А: ['Аскольд', 'Аристарх'],
  Б: ['Богдан', 'Боримир'],
  В: ['Велимир', 'Всеслав'],
  Г: ['Глеб', 'Градимир'],
  Д: ['Добромир', 'Дамир'],
  Е: ['Егор', 'Елизар'],
  Ж: ['Ждан', 'Жадан'],
  З: ['Захар', 'Зорян'],
  И: ['Игнат', 'Изяслав'],
  К: ['Кирилл', 'Казимир'],
  Л: ['Лавр', 'Ладимир'],
  М: ['Мстислав', 'Мирослав'],
  Н: ['Нестор', 'Никанор'],
  О: ['Олег', 'Остромир'],
  П: ['Панкрат', 'Пересвет'],
  Р: ['Ратибор', 'Родослав'],
  С: ['Светозар', 'Станислав'],
  Т: ['Тихомир', 'Твердислав'],
  У: ['Устин', 'Ульян'],
  Ф: ['Филарет', 'Феодор'],
  Х: ['Харитон', 'Хвалимир'],
  Ц: ['Цветан', 'Цветомир'],
  Ч: ['Чеслав', 'Часлав'],
  Ш: ['Шандор', 'Шамир'],
  Э: ['Эдгар', 'Эрнест'],
  Ю: ['Юстин', 'Юлиан'],
  Я: ['Ярослав', 'Яромир'],
};

const FEMALE_NAMES: Readonly<Record<string, string>> = {
  А: 'Ангелина',
  Б: 'Богдана',
  В: 'Веселина',
  Г: 'Голуба',
  Д: 'Добрава',
  Е: 'Есения',
  Ж: 'Ждана',
  З: 'Зорина',
  И: 'Ивета',
  К: 'Красимира',
  Л: 'Лада',
  М: 'Мирослава',
  Н: 'Неждана',
  О: 'Олеся',
  П: 'Пелагея',
  Р: 'Радмила',
  С: 'Светозара',
  Т: 'Тихомира',
  У: 'Ульяна',
  Ф: 'Фаина',
  Х: 'Харитина',
  Ц: 'Цветана',
  Ч: 'Чеслава',
  Ш: 'Шаяна',
  Э: 'Эвелина',
  Ю: 'Юния',
  Я: 'Ярина',
};

const FALLBACK_MALE_NAMES: readonly string[] = ['Ярослав', 'Яромир'];
const FALLBACK_FEMALE_NAME = 'Ярина';

/**
 * Слова, после которых одиночная заглавная буква с точкой — не инициал.
 * Без этого «Приложение А.» превратилось бы в человека.
 */
const NOT_A_SURNAME: ReadonlySet<string> = new Set([
  'акт',
  'блок',
  'вариант',
  'влд',
  'вл',
  'глава',
  'гост',
  'группа',
  'декларация',
  'договор',
  'дом',
  'заказ',
  'захватка',
  'зао',
  'ип',
  'класс',
  'код',
  'ком',
  'корп',
  'корпус',
  'лист',
  'марка',
  'наб',
  'нострой',
  'номер',
  'обл',
  'объект',
  'оф',
  'ооо',
  'ось',
  'отметка',
  'пао',
  'партия',
  'паспорт',
  'пер',
  'плавка',
  'позиция',
  'пом',
  'приказ',
  'приложение',
  'примечание',
  'протокол',
  'пункт',
  'раздел',
  'рисунок',
  'секция',
  'серия',
  'сертификат',
  'снип',
  'сро',
  'стандарт',
  'сто',
  'стр',
  'схема',
  'таблица',
  'тип',
  'узел',
  'улица',
  'участок',
  'форма',
  'часть',
  'этап',
]);

// ---------------------------------------------------------------------------
// Границы слова для кириллицы
// ---------------------------------------------------------------------------

/**
 * JS-«\b» опирается на ASCII-\w, поэтому для кириллицы он срабатывает не там,
 * где нужно: в « ИНН» границы перед «И» нет вовсе. Строим её вручную.
 */
const LETTERS = 'A-Za-zА-Яа-яЁё';
const WB = `(?<![${LETTERS}0-9])`;
const WA = `(?![${LETTERS}0-9])`;

/** Слово с заглавной первой буквой — кандидат в фамилию, имя или топоним. */
const CYR_WORD = '[А-ЯЁ][А-Яа-яЁё]{2,}(?:-[А-ЯЁ][А-Яа-яЁё]+)?';

const PATRONYMIC_TAIL = 'ович|евич|ьич|овна|евна|ична|ОВИЧ|ЕВИЧ|ЬИЧ|ОВНА|ЕВНА|ИЧНА';
const FEMININE_PATRONYMIC_RE = /(овна|евна|ична)$/i;
const FEMININE_SURNAME_RE = /(ова|ева|ёва|ина|ына|ская|цкая)$/i;

// ---------------------------------------------------------------------------
// Регулярные выражения по видам ПДн
// ---------------------------------------------------------------------------

/** Метка и до четырёх нецифровых символов перед значением: «ИНН: », «ОГРН): ». */
const LABEL_GAP = '[^0-9\\n]{0,4}';

const INN_KPP_RE = new RegExp(
  `(${WB}ИНН\\s*\\/\\s*КПП${LABEL_GAP})(\\d{8,16})(\\s*\\/\\s*)(\\d{8,12})${WA}`,
  'g',
);
const INN_RE = new RegExp(`(${WB}ИНН${LABEL_GAP})(\\d{8,16})(?!\\d)`, 'g');
const OGRN_RE = new RegExp(`(${WB}(?:ОГРНИП|ОГРН)${LABEL_GAP})(\\d{9,17})(?!\\d)`, 'g');
const KPP_RE = new RegExp(`(${WB}КПП${LABEL_GAP})(\\d{8,12})(?!\\d)`, 'g');

const PHONE_RE =
  /(?<![\d-])(\+?[78])([ \t\-(]*)(\d{3})([ \t\-)]*)(\d{3})([ \t-]*)(\d{2})([ \t-]*)(\d{2})(?!\d)/g;

/** Серийный номер сертификата ЭП. `blk_…` отсекается лookbehind'ом по «_». */
const CERT_HEX_RE = /(?<![0-9A-Za-z_])[0-9A-Fa-f]{30,}(?![0-9A-Za-z_])/g;

const POSTAL_INDEX_RE = /(?<!\d)([1-6]\d{5})(?!\d)(?=\s*,\s*(?:г|Г|город|ГОРОД|обл|ОБЛ))/g;

/**
 * Почты в §1.4 нет, но в корпусе встречаются личные ящики вида «фамилия@…».
 * Домен `.invalid` зарезервирован RFC 2606 и не может принадлежать никому.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SYNTH_EMAIL_DOMAIN = 'example.invalid';

function bothCases(words: readonly string[]): string {
  return [...words]
    .sort((a, b) => b.length - a.length)
    .flatMap((word) => [
      word.toUpperCase(),
      word.toLowerCase(),
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    ])
    .join('|');
}

const STREET_TYPES_BEFORE = bothCases([
  'ул',
  'улица',
  'наб',
  'набережная',
  'пер',
  'переулок',
  'пр-кт',
  'проспект',
  'проезд',
  'ш',
  'шоссе',
  'б-р',
  'бульвар',
  'пл',
  'площадь',
  'туп',
  'тупик',
  'аллея',
  'линия',
]);
const STREET_TYPES_AFTER = bothCases([
  'шоссе',
  'улица',
  'проспект',
  'набережная',
  'бульвар',
  'переулок',
  'проезд',
  'площадь',
  'аллея',
  'линия',
]);
const TOPONYM = `${CYR_WORD}(?:\\s+${CYR_WORD})?`;

const STREET_BEFORE_RE = new RegExp(`(${WB}(?:${STREET_TYPES_BEFORE})\\.?\\s+)(${TOPONYM})`, 'g');
const STREET_AFTER_RE = new RegExp(`${WB}(${TOPONYM})(\\s+(?:${STREET_TYPES_AFTER})${WA})`, 'g');

const HOUSE_MARKERS = bothCases([
  'д',
  'дом',
  'вл',
  'влд',
  'стр',
  'корп',
  'пом',
  'ком',
  'оф',
  'кв',
  'уч',
]);
const HOUSE_RE = new RegExp(
  `(${WB}(?:${HOUSE_MARKERS})\\.?\\s*№?\\s*)(\\d{1,4}(?:\\s*[/-]\\s*\\d{1,4})?)(?!\\d)`,
  'g',
);

/**
 * Улицы и номера домов правятся только внутри строки, где адрес действительно
 * есть. Иначе «Арматура А240С, д.8» (диаметр 8 мм) превратилась бы в дом №8.
 */
const ADDRESS_LINE_RE = new RegExp(
  `(?<!\\d)[1-6]\\d{5}(?!\\d)\\s*,\\s*[Гг]` +
    `|${WB}(?:${bothCases([
      'ул',
      'улица',
      'наб',
      'набережная',
      'пер',
      'переулок',
      'пр-кт',
      'проспект',
      'проезд',
      'шоссе',
      'б-р',
      'бульвар',
      'площадь',
    ])})\\.?${WA}` +
    `|по\\s+адресу`,
);

const OWNER_RE = /(Владелец\s*:\s*)([^;\n]*?)(?=\s*(?:;|$))/g;
const FULL_NAME_RE = new RegExp(
  `${WB}(${CYR_WORD})(\\s+)(${CYR_WORD})(\\s+)([А-ЯЁ][А-Яа-яЁё]*(?:${PATRONYMIC_TAIL}))${WA}`,
  'g',
);
const INITIALS_RE = new RegExp(`${WB}(${CYR_WORD})(\\s+)([А-ЯЁ])\\.(?:(\\s*)([А-ЯЁ])\\.)?`, 'g');

// ---------------------------------------------------------------------------
// Синтез ФИО
// ---------------------------------------------------------------------------

const letterPermutations = new Map<string, string>();

/**
 * Перестановка алфавита инициалов. Именно она связывает «Тестов А. А.» и
 * «Тестов Александр Александрович»: обе формы одной фамилии дают согласованные
 * инициалы, потому что буква отображается в букву, а имя выбирается из корзины
 * этой буквы.
 */
function permutationFor(seed: string): string {
  const cached = letterPermutations.get(seed);
  if (cached !== undefined) return cached;
  const chars = [...NAME_LETTERS];
  const rng = rngFor(seed, 'letters', '');
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = chars[i];
    const b = chars[j];
    if (a === undefined || b === undefined) continue;
    chars[i] = b;
    chars[j] = a;
  }
  const permutation = chars.join('');
  letterPermutations.set(seed, permutation);
  return permutation;
}

function mapLetter(letter: string, seed: string): string {
  const upper = letter.toUpperCase();
  const index = NAME_LETTERS.indexOf(upper);
  if (index < 0) return upper;
  return permutationFor(seed).charAt(index) || upper;
}

function isAllUpper(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

function matchCase(original: string, replacement: string): string {
  return isAllUpper(original) ? replacement.toUpperCase() : replacement;
}

function isSyntheticSurname(value: string): boolean {
  return SYNTHETIC_SURNAME_RE.test(value);
}

/**
 * «Мешков» и «Мешкова» в корпусе — один и тот же человек, записанный в разных
 * формах. Ключ приводится к мужской форме, чтобы обе получили общую основу.
 */
function surnameKey(surname: string): string {
  const lower = surname.toLowerCase();
  if (/(ская|цкая)$/.test(lower)) return `${lower.slice(0, -2)}ий`;
  if (/(ова|ева|ёва|ина|ына)$/.test(lower)) return lower.slice(0, -1);
  return lower;
}

function synthSurname(original: string, seed: string, female: boolean): string {
  const rng = rngFor(seed, 'surname', surnameKey(original));
  const base =
    pick(rng, SURNAME_PREFIXES) + pick(rng, SURNAME_MIDDLES) + pick(rng, SURNAME_ENDINGS);
  const shaped = female ? (base.endsWith('ский') ? `${base.slice(0, -2)}ая` : `${base}а`) : base;
  return matchCase(original, shaped);
}

function synthGiven(original: string, seed: string, female: boolean): string {
  const letter = mapLetter(original.charAt(0), seed);
  const shaped = female
    ? (FEMALE_NAMES[letter] ?? FALLBACK_FEMALE_NAME)
    : pick(
        rngFor(seed, 'given', original.toLowerCase()),
        MALE_NAMES[letter] ?? FALLBACK_MALE_NAMES,
      );
  return matchCase(original, shaped);
}

function synthPatronymic(original: string, seed: string): string {
  const letter = mapLetter(original.charAt(0), seed);
  const base = pick(
    rngFor(seed, 'patronymic', original.toLowerCase()),
    MALE_NAMES[letter] ?? FALLBACK_MALE_NAMES,
  );
  const shaped = base + (FEMININE_PATRONYMIC_RE.test(original) ? 'овна' : 'ович');
  return matchCase(original, shaped);
}

interface PersonParts {
  readonly surname: string;
  readonly given: string | null;
  readonly patronymic: string | null;
}

function isFemalePerson(parts: PersonParts): boolean {
  if (parts.patronymic !== null) return FEMININE_PATRONYMIC_RE.test(parts.patronymic);
  return FEMININE_SURNAME_RE.test(parts.surname);
}

function isPlausibleSurname(word: string): boolean {
  return word.length >= 3 && !NOT_A_SURNAME.has(word.toLowerCase());
}

function renderPerson(parts: PersonParts, seed: string): string {
  const female = isFemalePerson(parts);
  const pieces = [synthSurname(parts.surname, seed, female)];
  if (parts.given !== null) pieces.push(synthGiven(parts.given, seed, female));
  if (parts.patronymic !== null) pieces.push(synthPatronymic(parts.patronymic, seed));
  return pieces.join(' ');
}

const PERSON_TOKEN_RE = /^[А-ЯЁ][А-Яа-яЁё-]+$/;

/** «Владелец: Фамилия Имя [Отчество]» — иначе там должность, а не человек. */
function parsePersonPhrase(phrase: string): PersonParts | null {
  const tokens = phrase.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 3) return null;
  if (!tokens.every((token) => PERSON_TOKEN_RE.test(token))) return null;
  const [surname, given, patronymic] = tokens;
  if (surname === undefined || given === undefined) return null;
  if (!isPlausibleSurname(surname)) return null;
  return { surname, given, patronymic: patronymic ?? null };
}

// ---------------------------------------------------------------------------
// Синтез прочих значений
// ---------------------------------------------------------------------------

function synthPhone(digitsAfterCode: string, seed: string): string {
  return randomDigits(rngFor(seed, 'phone', digitsAfterCode), 7);
}

function synthEmail(original: string, seed: string): string {
  const rng = rngFor(seed, 'email', original.toLowerCase());
  let local = '';
  for (let i = 0; i < 6; i += 1) local += pickChar(rng, 'abcdefghijklmnopqrstuvwxyz');
  return `${local}@${SYNTH_EMAIL_DOMAIN}`;
}

function isSyntheticEmail(value: string): boolean {
  return value.toLowerCase().endsWith(`@${SYNTH_EMAIL_DOMAIN}`);
}

function synthCertHex(original: string, seed: string): string {
  const rng = rngFor(seed, 'cert', original);
  const alphabet = /[a-f]/.test(original) ? '0123456789abcdef' : '0123456789ABCDEF';
  let out = SYNTH_HEX_PREFIX;
  while (out.length < original.length) out += pickChar(rng, alphabet);
  return out.slice(0, original.length);
}

function synthPostalIndex(original: string, seed: string): string {
  return SYNTH_POSTAL_PREFIX + randomDigits(rngFor(seed, 'postal', original), original.length - 1);
}

function streetEnding(lower: string): string {
  if (lower.endsWith('ое') || lower.endsWith('ее')) return 'ое';
  if (lower.endsWith('ый') || lower.endsWith('ий') || lower.endsWith('ой')) return 'ый';
  return 'ая';
}

function synthStreet(original: string, seed: string): string {
  const key = original.toLowerCase().replace(/\s+/g, ' ');
  const stem = pick(rngFor(seed, 'street', key), STREET_STEMS);
  return matchCase(original, stem + streetEnding(key));
}

function isSyntheticStreet(value: string): boolean {
  return SYNTHETIC_STREET_RE.test(value.replace(/\s+/g, ' '));
}

function synthHouseNumber(original: string, seed: string): string {
  const rng = rngFor(seed, 'house', original);
  return original.replace(/\d+/g, (run) => {
    const first = String(1 + Math.floor(rng() * 9));
    return first + randomDigits(rng, Math.max(run.length - 1, 0));
  });
}

// ---------------------------------------------------------------------------
// Обезличивание
// ---------------------------------------------------------------------------

export function anonymizeText(text: string, opts?: AnonymizeOptions): string {
  const seed = opts?.seed ?? DEFAULT_SEED;
  return text
    .split('\n')
    .map((line) => anonymizeLine(line, seed))
    .join('\n');
}

function anonymizeLine(line: string, seed: string): string {
  let out = line;
  out = out.replace(CERT_HEX_RE, (match) =>
    match.startsWith(SYNTH_HEX_PREFIX) ? match : synthCertHex(match, seed),
  );
  out = out.replace(EMAIL_RE, (match) =>
    isSyntheticEmail(match) ? match : synthEmail(match, seed),
  );
  out = replaceRequisites(out, seed);
  out = out.replace(
    PHONE_RE,
    (
      match: string,
      lead: string,
      s1: string,
      code: string,
      s2: string,
      part1: string,
      s3: string,
      part2: string,
      s4: string,
      part3: string,
    ) => {
      if (code === SYNTH_PHONE_CODE) return match;
      const rest = synthPhone(part1 + part2 + part3, seed);
      return `${lead}${s1}${SYNTH_PHONE_CODE}${s2}${rest.slice(0, 3)}${s3}${rest.slice(3, 5)}${s4}${rest.slice(5, 7)}`;
    },
  );
  if (ADDRESS_LINE_RE.test(out)) out = replaceAddress(out, seed);
  out = replaceNames(out, seed);
  return out;
}

function replaceRequisites(line: string, seed: string): string {
  let out = line;
  out = out.replace(
    INN_KPP_RE,
    (_match: string, label: string, inn: string, gap: string, kpp: string) =>
      `${label}${inn.startsWith(SYNTH_INN_PREFIX) ? inn : synthInn(inn, seed)}${gap}${
        kpp.startsWith(SYNTH_KPP_PREFIX) ? kpp : synthKpp(kpp, seed)
      }`,
  );
  out = out.replace(INN_RE, (match: string, label: string, value: string) =>
    value.startsWith(SYNTH_INN_PREFIX) ? match : label + synthInn(value, seed),
  );
  out = out.replace(OGRN_RE, (match: string, label: string, value: string) =>
    value.startsWith(SYNTH_OGRN_PREFIX) ? match : label + synthOgrn(value, seed),
  );
  out = out.replace(KPP_RE, (match: string, label: string, value: string) =>
    value.startsWith(SYNTH_KPP_PREFIX) ? match : label + synthKpp(value, seed),
  );
  return out;
}

function replaceAddress(line: string, seed: string): string {
  let out = line;
  out = out.replace(POSTAL_INDEX_RE, (match: string) => synthPostalIndex(match, seed));
  out = out.replace(STREET_BEFORE_RE, (match: string, label: string, name: string) =>
    isSyntheticStreet(name) ? match : label + synthStreet(name, seed),
  );
  out = out.replace(STREET_AFTER_RE, (match: string, name: string, suffix: string) =>
    isSyntheticStreet(name) ? match : synthStreet(name, seed) + suffix,
  );
  out = out.replace(
    HOUSE_RE,
    (_match: string, label: string, number: string) => `${label}${synthHouseNumber(number, seed)}`,
  );
  return out;
}

function replaceNames(line: string, seed: string): string {
  let out = line;
  out = out.replace(OWNER_RE, (match: string, label: string, phrase: string) => {
    const parts = parsePersonPhrase(phrase);
    if (parts === null || isSyntheticSurname(parts.surname)) return match;
    return label + renderPerson(parts, seed);
  });
  out = out.replace(
    FULL_NAME_RE,
    (
      match: string,
      surname: string,
      gap1: string,
      given: string,
      gap2: string,
      patronymic: string,
    ) => {
      if (!isPlausibleSurname(surname) || isSyntheticSurname(surname)) return match;
      const person = renderPerson({ surname, given, patronymic }, seed);
      const [s, g, p] = person.split(' ');
      return `${s ?? ''}${gap1}${g ?? ''}${gap2}${p ?? ''}`;
    },
  );
  out = out.replace(
    INITIALS_RE,
    (
      match: string,
      surname: string,
      gap: string,
      first: string,
      gap2: string | undefined,
      second: string | undefined,
    ) => {
      if (!isPlausibleSurname(surname) || isSyntheticSurname(surname)) return match;
      const female = FEMININE_SURNAME_RE.test(surname);
      const tail = second === undefined ? '' : `${gap2 ?? ''}${mapLetter(second, seed)}.`;
      return `${synthSurname(surname, seed, female)}${gap}${mapLetter(first, seed)}.${tail}`;
    },
  );
  return out;
}

// ---------------------------------------------------------------------------
// Проверка результата
// ---------------------------------------------------------------------------

/**
 * Ищет остатки настоящих ПДн. Отличает их от собственной работы по
 * зарезервированному синтетическому пространству: всё, что вне его, считается
 * подозрительным и попадает в findings.
 */
export function containsPii(text: string): PiiReport {
  const findings: string[] = [];
  const seen = new Set<string>();
  const add = (kind: string, value: string): void => {
    const entry = `${kind}: ${value.trim().slice(0, 80)}`;
    if (seen.has(entry)) return;
    seen.add(entry);
    findings.push(entry);
  };

  for (const line of text.split('\n')) {
    for (const match of line.matchAll(CERT_HEX_RE)) {
      if (!match[0].startsWith(SYNTH_HEX_PREFIX)) add('сертификат ЭП', match[0]);
    }
    for (const match of line.matchAll(EMAIL_RE)) {
      if (!isSyntheticEmail(match[0])) add('электронная почта', match[0]);
    }
    for (const match of line.matchAll(INN_RE)) {
      const value = match[2] ?? '';
      if (!value.startsWith(SYNTH_INN_PREFIX)) add('ИНН', value);
    }
    for (const match of line.matchAll(OGRN_RE)) {
      const value = match[2] ?? '';
      if (!value.startsWith(SYNTH_OGRN_PREFIX)) add('ОГРН', value);
    }
    for (const match of line.matchAll(KPP_RE)) {
      const value = match[2] ?? '';
      if (!value.startsWith(SYNTH_KPP_PREFIX)) add('КПП', value);
    }
    for (const match of line.matchAll(PHONE_RE)) {
      if (match[3] !== SYNTH_PHONE_CODE) add('телефон', match[0]);
    }
    if (ADDRESS_LINE_RE.test(line)) {
      for (const match of line.matchAll(POSTAL_INDEX_RE)) {
        if (!match[0].startsWith(SYNTH_POSTAL_PREFIX)) add('почтовый индекс', match[0]);
      }
      for (const match of line.matchAll(STREET_BEFORE_RE)) {
        const name = match[2] ?? '';
        if (!isSyntheticStreet(name)) add('улица', name);
      }
      for (const match of line.matchAll(STREET_AFTER_RE)) {
        const name = match[1] ?? '';
        if (!isSyntheticStreet(name)) add('улица', name);
      }
    }
    for (const match of line.matchAll(OWNER_RE)) {
      const parts = parsePersonPhrase(match[2] ?? '');
      if (parts !== null && !isSyntheticSurname(parts.surname)) add('ФИО', match[2] ?? '');
    }
    for (const match of line.matchAll(FULL_NAME_RE)) {
      const surname = match[1] ?? '';
      if (isPlausibleSurname(surname) && !isSyntheticSurname(surname)) add('ФИО', match[0]);
    }
    for (const match of line.matchAll(INITIALS_RE)) {
      const surname = match[1] ?? '';
      if (isPlausibleSurname(surname) && !isSyntheticSurname(surname)) add('ФИО', match[0]);
    }
  }

  return { clean: findings.length === 0, findings };
}
