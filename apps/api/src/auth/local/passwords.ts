/**
 * Хеширование и проверка паролей (ADR-0009, решение 4).
 *
 * Алгоритм — `scrypt` из `node:crypto`. Выбор объясняется тем же
 * обстоятельством, что породило `AUTH_MODE=dev-stub`: на машине сборки нет
 * Docker и нет тулчейна нативных модулей (см. шапку `auth/oidc.ts`). `bcrypt`
 * требует node-gyp, `@node-rs/argon2` приносит платформенный бинарь, а
 * `bcryptjs` при cost 12 занимает главный поток на полсекунды — и это на КАЖДУЮ
 * попытку, включая холостую проверку несуществующего логина. `scrypt` не имеет
 * зависимостей, memory-hard и исполняется в пуле потоков libuv.
 *
 * Параметры `N=2^16, r=8, p=2` — профиль OWASP Password Storage при
 * ограниченной памяти (эквивалент `2^17/8/1`). `p=1` при `N=2^16` был бы ниже
 * минимального профиля.
 *
 * Строка хэша самодостаточна:
 *
 *     scrypt$N=65536,r=8,p=2$<salt-b64url>$<key-b64url>
 *
 * Параметры лежат ВНУТРИ значения, а не в конфигурации: иначе повышение
 * стоимости сделало бы нечитаемыми все прежние хэши, и смена параметра
 * разлогинила бы портал целиком. Переход на argon2id — это ветка в `verify()`
 * плюс перехэширование при следующем успешном входе, без миграции данных.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env.js';

/** Единственный реализованный алгоритм. Схема БД и `env.ts` разрешают его же. */
export const PASSWORD_ALGORITHM = 'scrypt';
export type PasswordAlgorithm = typeof PASSWORD_ALGORITHM;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const BLOCK_SIZE = 8;

/**
 * Алфавит выдаваемого администратором пароля.
 *
 * Без визуально неоднозначных `0O1lI`: такой пароль диктуют голосом и
 * переписывают с экрана, и «не тот символ» здесь превращается в обращение в
 * поддержку, а не в повторную попытку.
 */
const GENERATED_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const GENERATED_LENGTH = 24;

export interface PasswordHash {
  readonly algorithm: PasswordAlgorithm;
  readonly encoded: string;
}

interface ScryptParams {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelism: number;
}

/**
 * Ограничитель одновременных операций хеширования.
 *
 * Каждая занимает ~64 МБ и поток пула libuv (по умолчанию их четыре). Без
 * предела всплеск входов вытесняет из пула всё остальное — чтение файлов, DNS,
 * zlib, — и вход роняет производительность всего API. Очередь ограничена
 * вчетверо от числа мест: ждать дольше бессмысленно, потому что клиент к тому
 * времени уже получит отказ по таймауту.
 */
export class HashLimiter {
  readonly #capacity: number;
  readonly #maxQueue: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
    this.#maxQueue = capacity * 4;
  }

  get queueLength(): number {
    return this.#waiting.length;
  }

  /** `null`, если очередь переполнена: вызывающий обязан ответить 429. */
  async acquire(): Promise<(() => void) | null> {
    if (this.#active >= this.#capacity && this.#waiting.length >= this.#maxQueue) return null;

    if (this.#active >= this.#capacity) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;

    let released = false;
    return () => {
      // Идемпотентность важнее краткости: двойной release в ветке ошибки выдал
      // бы больше мест, чем есть, и предел перестал бы существовать.
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiting.shift()?.();
    };
  }
}

/**
 * Параметры из конфигурации.
 *
 * Читаются на каждом хешировании, а не запоминаются при старте: тесты понижают
 * стоимость ради скорости, и кэш параметров сделал бы её изменение невидимым.
 */
function paramsOf(env: Env): ScryptParams {
  return {
    cost: 2 ** env.AUTH_LOCAL_SCRYPT_COST_LOG2,
    blockSize: BLOCK_SIZE,
    parallelism: env.AUTH_LOCAL_SCRYPT_PARALLELISM,
  };
}

/**
 * Предел памяти одной операции.
 *
 * Обязателен: по умолчанию `crypto.scrypt` разрешает 32 МБ, а `N=2^16, r=8`
 * требует `128·N·r ≈ 64 МБ` и падает с `ERR_CRYPTO_INVALID_SCRYPT_PARAM`.
 * Двойной запас — на служебные буферы реализации.
 */
function maxmemOf(params: ScryptParams): number {
  return 128 * params.cost * params.blockSize * 2;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // NFKC — та же нормализация, что у логина. Без неё один и тот же пароль,
      // набранный в разных нормальных формах Unicode, не совпадёт сам с собой:
      // пользователь сменит способ ввода и потеряет доступ.
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      {
        N: params.cost,
        r: params.blockSize,
        p: params.parallelism,
        maxmem: maxmemOf(params),
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

function encode(params: ScryptParams, salt: Buffer, key: Buffer): string {
  const meta = [
    `N=${String(params.cost)}`,
    `r=${String(params.blockSize)}`,
    `p=${String(params.parallelism)}`,
  ].join(',');
  return [PASSWORD_ALGORITHM, meta, salt.toString('base64url'), key.toString('base64url')].join(
    '$',
  );
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/**
 * Разбор строки хэша. `null` на любой непонятной: непонятный хэш обязан
 * означать отказ во входе, а не исключение с пятисоткой.
 */
export function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 4) return null;
  const [algorithm, meta, saltPart, keyPart] = parts as [string, string, string, string];
  if (algorithm !== PASSWORD_ALGORITHM) return null;

  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(meta);
  if (match === null) return null;
  const cost = Number(match[1]);
  const blockSize = Number(match[2]);
  const parallelism = Number(match[3]);
  // Параметры из БД проверяются наравне с внешним вводом: подставленная строка
  // с N=2 превратила бы проверку пароля в мгновенную и обесценила бы хеширование.
  if (!Number.isInteger(cost) || cost < 2 ** 14 || (cost & (cost - 1)) !== 0) return null;
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 64) return null;
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16) return null;

  const salt = Buffer.from(saltPart, 'base64url');
  const key = Buffer.from(keyPart, 'base64url');
  if (salt.byteLength < 8 || key.byteLength !== KEY_BYTES) return null;

  return { params: { cost, blockSize, parallelism }, salt, key };
}

export async function hashPassword(env: Env, password: string): Promise<PasswordHash> {
  const params = paramsOf(env);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return { algorithm: PASSWORD_ALGORITHM, encoded: encode(params, salt, key) };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (parsed === null) return false;

  const actual = await derive(password, parsed.salt, parsed.params);
  // Побайтовое сравнение постоянного времени: сравнение строк прерывалось бы на
  // первом различии, и ключ восстанавливался бы по времени ответа.
  return actual.byteLength === parsed.key.byteLength && timingSafeEqual(actual, parsed.key);
}

/** Хэш посчитан устаревшими параметрами: перехэшировать при следующем входе. */
export function needsRehash(env: Env, encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (parsed === null) return true;
  const target = paramsOf(env);
  return (
    parsed.params.cost < target.cost ||
    parsed.params.blockSize < target.blockSize ||
    parsed.params.parallelism < target.parallelism
  );
}

// =====================================================================
// Холостая проверка
// =====================================================================

let dummyHash: string | null = null;

/**
 * Готовит холостой хэш заранее.
 *
 * Вызывается при сборке приложения. Ленивая подготовка сделала бы ПЕРВЫЙ вход с
 * неизвестным логином вдвое дороже последующих — измеримая разница, то есть
 * оракул существования учётной записи ровно там, где его старательно убирают.
 *
 * Пароль случайный, а не константа в исходнике: константу можно подобрать и
 * получить холостую проверку, отвечающую «верно».
 */
export async function warmupDummyHash(env: Env): Promise<void> {
  dummyHash ??= (await hashPassword(env, randomBytes(32).toString('hex'))).encoded;
}

/**
 * Холостая проверка для несуществующего логина (B.2, unified latency).
 *
 * Выполняет настоящий scrypt тех же параметров и отбрасывает результат: без неё
 * ответ на неизвестный логин приходил бы заметно быстрее, чем на неверный
 * пароль, и перебором адресов восстанавливался бы список учётных записей.
 */
export async function verifyDummy(env: Env, password: string): Promise<false> {
  await warmupDummyHash(env);
  // Строка выше заполняет поле; проверка нужна только компилятору.
  if (dummyHash !== null) await verifyPassword(password, dummyHash);
  return false;
}

/** Только для тестов: забыть подготовленный холостой хэш. */
export function resetDummyHashForTests(): void {
  dummyHash = null;
}

// =====================================================================
// Генерация пароля
// =====================================================================

/**
 * Пароль, выдаваемый администратором.
 *
 * Отбор с отбрасыванием, а не остаток от деления: `% alphabet.length` дал бы
 * первым символам алфавита чуть большую вероятность. На двадцати четырёх
 * символах смещение невелико, но «невелико» — не тот критерий, по которому
 * выбирают генератор паролей.
 */
export function randomPassword(length: number = GENERATED_LENGTH): string {
  const alphabet = GENERATED_ALPHABET;
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let result = '';
  while (result.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}
