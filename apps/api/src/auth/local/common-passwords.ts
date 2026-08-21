/**
 * Пароли, которые нельзя принимать (B.3).
 *
 * Стандарт требует «проверку по списку распространённых или скомпрометированных
 * паролей». Онлайновая проверка HIBP k-anonymity здесь неприменима: портал не
 * ходит в интернет напрямую, а стенд бывает офлайн (ADR-0009, отступление 5).
 *
 * Список сознательно не гонится за размером. Десять тысяч строк из публичного
 * топ-листа ловят немногим больше, чем несколько сотен, потому что хвост такого
 * списка состоит из паролей, которых политика длины не пропустит и так
 * («qwerty», «123456» — короче двенадцати символов). Реальную работу делают три
 * вещи, и они здесь есть:
 *
 *   1. точный список того, что люди действительно набирают, включая русские
 *      раскладочные варианты, которых в англоязычных топ-листах нет вовсе;
 *   2. проверка «основа + хвост из цифр» — `Password2024`, `qwerty12345`;
 *   3. алгоритмические проверки в `policy.ts`: прогулки по клавиатуре,
 *      последовательности и повторы одного символа.
 *
 * Сравнение ведётся по канонической форме (NFKC + lower) со схлопыванием
 * неоднозначных глифов, поэтому регистр и подмены вида `P@ssw0rd` в записях
 * списка значения не имеют и все они записаны обычными строчными буквами.
 */
import { collapseGlyphs } from './canonical.js';

/**
 * Основы: то, вокруг чего строят пароль. Совпадение проверяется и целиком, и
 * после снятия хвостовых цифр и знаков.
 */
const COMMON_STEMS: readonly string[] = [
  // Латинская классика
  'password',
  'passw0rd',
  'pa55word',
  'welcome',
  'letmein',
  'monkey',
  'dragon',
  'master',
  'shadow',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'batman',
  'trustno1',
  'iloveyou',
  'starwars',
  'whatever',
  'freedom',
  'computer',
  'internet',
  'samsung',
  'google',
  'facebook',
  'michael',
  'jennifer',
  'jordan',
  'hunter',
  'thomas',
  'charlie',
  'daniel',
  'andrew',
  'matthew',
  'joshua',
  'admin',
  'administrator',
  'root',
  'guest',
  'default',
  'changeme',
  'secret',
  'login',
  'access',
  'system',
  'server',
  'database',
  'manager',
  'operator',
  'engineer',
  'director',
  'company',
  'corporate',
  'business',
  'private',
  'security',
  'network',
  'service',
  'support',
  'developer',
  'testing',
  'temporary',
  'temppassword',
  'newpassword',
  'mypassword',
  'oldpassword',

  // Кириллица в латинской раскладке — то, что реально набирают в России и чего
  // в англоязычных топ-листах нет.
  'ghbdtn', // привет
  'gfhjkm', // пароль
  'ljcneg', // доступ
  'rjvgm.nth', // компьютер
  'cnhjbntkm', // строитель
  'ntktajy', // телефон
  'vjcrdf', // москва
  'hjccbz', // россия
  'z;bdjq', // я живой
  'gjkmpjdfntkm', // пользователь
  'flvbybcnhfnjh', // администратор

  // Кириллица как есть
  'пароль',
  'привет',
  'россия',
  'москва',
  'компьютер',
  'администратор',
  'пользователь',
  'строитель',
  'документация',
  'исполнительная',

  // Названия и контекст портала: то, что придумает уставший администратор.
  'portal',
  'портал',
  'idportal',
  'id-portal',
  'stroyka',
  'стройка',
  'objekt',
  'объект',
  'podryad',
  'подряд',
  'proekt',
  'проект',
];

/** Полные пароли: их не разложить на «основу и хвост». */
const COMMON_FULL: readonly string[] = [
  'qwertyuiop',
  'qwertyuiop[]',
  'asdfghjkl',
  'zxcvbnm',
  'qazwsxedc',
  'qwerasdf',
  '1qaz2wsx',
  '1q2w3e4r',
  '1q2w3e4r5t',
  'q1w2e3r4',
  'q1w2e3r4t5',
  'йцукенгш',
  'йцукенгшщз',
  'фывапролд',
  'ячсмитьбю',
  'passwordpassword',
  'qwertyqwerty',
  'adminadmin',
  'abcdefghijkl',
  'abcd1234efgh',
  'aaaaaaaaaaaa',
  'zaq12wsxcde3',
  'iloveyouforever',
  'letmeinplease',
  'thisismypassword',
  'correcthorsebattery',
];

const STEMS = new Set(COMMON_STEMS.map(collapseGlyphs));
const FULL = new Set(COMMON_FULL.map(collapseGlyphs));
/**
 * Основы, которые ищутся вхождением, а не только целиком.
 *
 * Порог в шесть символов выбран как граница осмысленности: «password» внутри
 * `MyPassword2024god` обязан ловиться, а «root» внутри «Kronshteyn-77» — нет.
 */
const CONTAINED_STEMS = [...STEMS].filter((stem) => stem.length >= 6);

/**
 * Хвост из цифр, знаков и года: `Password2024!`, `admin123`, `пароль_2020`.
 *
 * Снимается ДО схлопывания глифов и именно хвост, а не все цифры: иначе `12345`
 * в конце превратился бы в буквы и перестал быть узнаваемым хвостом, а основа
 * `p@ssw0rd` осталась бы неразобранной.
 */
function stripTrailingFiller(value: string): string {
  return value.replace(/[\d!@#$%^&*()_+\-=.,]+$/u, '');
}

/**
 * Пароль совпадает с известным.
 *
 * Значение обязано быть уже приведено к канонической форме (NFKC + lower);
 * схлопывание глифов выполняется здесь, потому что оно должно применяться и к
 * записям списка — иначе `P@ssw0rd` не совпал бы с `password`.
 */
export function isCommonPassword(canonical: string): boolean {
  const candidates = [canonical, stripTrailingFiller(canonical)];

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const collapsed = collapseGlyphs(candidate);
    if (FULL.has(collapsed) || STEMS.has(collapsed)) return true;
  }

  const whole = collapseGlyphs(canonical);
  return CONTAINED_STEMS.some((stem) => whole.includes(stem));
}

/** Размер списка — для теста, который следит, что список не опустел при правке. */
export const COMMON_PASSWORD_COUNT = STEMS.size + FULL.size;
