/**
 * Политика пароля (B.3).
 *
 * Проверки выполняются ТОЛЬКО на сервере. Фронт повторяет их подсказками ради
 * подсказок; решение принимает этот файл, и повтор на клиенте помечен в
 * `apps/web/src/features/auth/passwordHints.ts` как производный.
 *
 * Длина считается в code points, а не в `.length`: `'a'.length` для суррогатной
 * пары равен двум, и пароль из эмодзи проходил бы порог вдвое дешевле. Границы
 * берутся из конфигурации, и оттуда же их берут схемы тела запросов — два
 * независимых максимума однажды разошлись бы, и пароль, принятый формой,
 * отвергался бы политикой без внятного объяснения.
 *
 * Чего здесь нет и почему (ADR-0009, отступления 5 и 6):
 *   - HIBP k-anonymity: портал не ходит в интернет напрямую, стенд бывает офлайн;
 *   - zxcvbn: ~800 КБ словарей ради одной оценки, а §2 стандарта требует
 *     сверять версии всех зависимостей. Замена — длина, классы символов,
 *     список распространённых и проверка на прогулки по клавиатуре.
 */
import type { Env } from '../../config/env.js';
import { canonicalizeLogin, collapseGlyphs, transliterate } from './canonical.js';
import { isCommonPassword } from './common-passwords.js';

export interface PasswordContext {
  readonly login: string | null;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly organizationName: string | null;
}

export interface PolicyViolation {
  readonly code: string;
  /** Текст для пользователя: попадает в 422 и показывается формой. */
  readonly message: string;
}

/**
 * Ряды клавиатуры для поиска прогулок вида `qwertyui` и `йцукенгш`.
 *
 * Обе раскладки: пользователь, набравший подряд идущие клавиши, одинаково
 * предсказуем независимо от того, какие буквы при этом получились.
 */
const KEYBOARD_ROWS: readonly string[] = [
  '1234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  'йцукенгшщзхъ',
  'фывапролджэ',
  'ячсмитьбю',
];

const KEYBOARD_WALK_LENGTH = 6;
const SEQUENCE_LENGTH = 5;
/** Ниже этой длины требуется разнообразие символов; выше — длина сама себе защита. */
const LENGTH_WITHOUT_CLASSES = 16;
/** Слова короче не проверяются на вхождение: «иван» встретится в чём угодно. */
const MIN_CONTEXT_WORD = 4;

/** Длина в code points: суррогатная пара — один символ, а не два. */
export function passwordLength(password: string): number {
  return [...password.normalize('NFKC')].length;
}

function countClasses(password: string): number {
  let classes = 0;
  if (/\p{Ll}/u.test(password)) classes += 1;
  if (/\p{Lu}/u.test(password)) classes += 1;
  if (/\p{Nd}/u.test(password)) classes += 1;
  if (/[^\p{L}\p{Nd}]/u.test(password)) classes += 1;
  return classes;
}

function hasKeyboardWalk(canonical: string): boolean {
  for (const row of KEYBOARD_ROWS) {
    for (let start = 0; start + KEYBOARD_WALK_LENGTH <= row.length; start += 1) {
      const run = row.slice(start, start + KEYBOARD_WALK_LENGTH);
      if (canonical.includes(run)) return true;
      if (canonical.includes([...run].reverse().join(''))) return true;
    }
  }
  return false;
}

/** `abcdef`, `123456`, `fedcba` — подряд идущие code points. */
function hasSequentialRun(canonical: string): boolean {
  const chars = [...canonical];
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < chars.length; i += 1) {
    const previous = chars[i - 1]?.codePointAt(0) ?? 0;
    const current = chars[i]?.codePointAt(0) ?? 0;
    ascending = current === previous + 1 ? ascending + 1 : 1;
    descending = current === previous - 1 ? descending + 1 : 1;
    if (ascending >= SEQUENCE_LENGTH || descending >= SEQUENCE_LENGTH) return true;
  }
  return false;
}

/** Пароль из одного повторённого символа или короткого повторённого куска. */
function isLowVariety(canonical: string): boolean {
  const unique = new Set([...canonical]).size;
  if (unique <= 3) return true;

  for (let size = 1; size <= 4; size += 1) {
    if (canonical.length % size !== 0) continue;
    const unit = canonical.slice(0, size);
    if (unit.repeat(canonical.length / size) === canonical) return true;
  }
  return false;
}

/**
 * Слова контекста, вхождение которых в пароль недопустимо.
 *
 * Из ФИО берутся и целая строка, и каждое слово от четырёх букв: `Иванов2024`
 * должен отвергаться, а `Иван` в составе длинной парольной фразы — нет, поэтому
 * порог по длине слова есть, а по числу слов — нет.
 */
function contextWords(context: PasswordContext): readonly string[] {
  const words: string[] = [];
  const push = (value: string | null): void => {
    if (value === null) return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_CONTEXT_WORD) words.push(trimmed);
  };

  push(context.login);
  push(context.email);
  push(context.fullName);
  push(context.organizationName);

  for (const source of [context.email, context.login]) {
    if (source === null) continue;
    // Локальная часть адреса: `ivanov` из `ivanov@example.ru`.
    const local = source.split('@')[0];
    if (local !== undefined) push(local);
  }

  for (const source of [context.fullName, context.organizationName]) {
    if (source === null) continue;
    for (const word of source.split(/[\s.,"«»()-]+/u)) push(word);
  }

  // Каждое слово даётся в двух видах: как есть и латиницей. «СтройМонтаж» и
  // `Stroymontazh-2024!` — одно и то же для всех, кроме побуквенного сравнения,
  // а транслитерация названия — первое, что приходит в голову при выборе пароля.
  const forms = words.flatMap((word) => [
    collapseGlyphs(word),
    collapseGlyphs(transliterate(word)),
  ]);

  return [...new Set(forms)].filter((word) => word.length >= MIN_CONTEXT_WORD);
}

/**
 * Нарушения политики. Пустой массив — пароль принят.
 *
 * Возвращается СПИСОК, а не первое нарушение: исправлять пароль по одной
 * претензии за попытку — то же самое, что подбирать его, и пользователь просто
 * уйдёт к паролю попроще.
 */
export function checkPasswordPolicy(
  password: string,
  context: PasswordContext,
  env: Env,
): readonly PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const length = passwordLength(password);
  const min = env.AUTH_LOCAL_PASSWORD_MIN_LENGTH;
  const max = env.AUTH_LOCAL_PASSWORD_MAX_LENGTH;

  if (length < min) {
    violations.push({
      code: 'too-short',
      message: `Пароль короче ${String(min)} символов.`,
    });
  }
  if (length > max) {
    violations.push({
      code: 'too-long',
      message: `Пароль длиннее ${String(max)} символов.`,
    });
  }

  // Дальнейшие проверки на слишком коротком пароле только добавляют шума:
  // «12345» и так отвергнут, а три претензии вместо одной ничего не уточняют.
  if (length < min) return violations;

  const canonical = password.normalize('NFKC').toLowerCase();
  // Пароль сверяется с контекстом в схлопнутом виде И в транслитерированном:
  // сторона пароля тоже может оказаться латиницей от кириллического слова.
  const flat = collapseGlyphs(password);
  const flatLatin = collapseGlyphs(transliterate(password));

  if (length < LENGTH_WITHOUT_CLASSES && countClasses(password) < 3) {
    violations.push({
      code: 'too-simple',
      message:
        `Пароль короче ${String(LENGTH_WITHOUT_CLASSES)} символов должен содержать минимум три ` +
        'вида символов: строчные и прописные буквы, цифры, знаки. Длинная парольная фраза ' +
        'этого требования не имеет.',
    });
  }

  if (isCommonPassword(canonical) || isCommonPassword(flat)) {
    violations.push({
      code: 'common',
      message: 'Такой пароль есть в списке распространённых.',
    });
  }

  if (hasKeyboardWalk(canonical)) {
    violations.push({
      code: 'keyboard-walk',
      message: 'Пароль содержит подряд идущие клавиши.',
    });
  }

  if (hasSequentialRun(canonical)) {
    violations.push({
      code: 'sequence',
      message: 'Пароль содержит последовательность символов подряд.',
    });
  }

  if (isLowVariety(canonical)) {
    violations.push({
      code: 'repetitive',
      message: 'Пароль состоит из повторяющихся символов.',
    });
  }

  for (const word of contextWords(context)) {
    if (flat.includes(word) || flatLatin.includes(word)) {
      violations.push({
        code: 'contains-personal-data',
        message: 'Пароль не должен содержать адрес, имя или название организации.',
      });
      break;
    }
  }

  return violations;
}

/**
 * Совпадение пароля с логином без учёта регистра и подмен.
 *
 * Отдельная функция, потому что применяется и вне полного разбора политики —
 * например, при проверке «новый пароль не равен прежнему логину».
 */
export function matchesLogin(password: string, login: string): boolean {
  return collapseGlyphs(password) === collapseGlyphs(canonicalizeLogin(login));
}
