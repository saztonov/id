/**
 * Серверные сессии BFF (§4.1).
 *
 * Браузер получает только случайный идентификатор сессии в cookie
 * `HttpOnly; Secure; SameSite=Lax`. Токены Keycloak в браузер не попадают
 * никогда: access-токен вообще не хранится, refresh-токен лежит в PostgreSQL
 * зашифрованным AES-256-GCM. Ключ берётся из окружения (`SESSION_ENC_KEY`) и в
 * БД не хранится — дамп базы без доступа к окружению не даёт refresh-токенов.
 *
 * Номер версии ключа пишется в `auth_sessions.key_version`, а не в конверт:
 * при ротации нужно уметь найти строки, зашифрованные старым ключом, обычным
 * SQL-запросом, не расшифровывая их.
 *
 * Здесь же живут криптографические примитивы, общие для всего слоя
 * аутентификации (постоянное по времени сравнение, sha256): держать их в
 * нескольких файлах значит рано или поздно получить в одном из них `===`.
 */
import { hash, randomBytes, randomUUID, timingSafeEqual, webcrypto } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'pg';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { z } from 'zod';
import type { Env } from '../config/env.js';

/** Идентификатор сессии. Единственное, что уезжает в браузер. */
export const SESSION_COOKIE = 'id_session';
/**
 * CSRF-токен, доступный скриптам SPA.
 *
 * Это не дырка в защите: смысл double-submit в том, что чужой origin не может
 * ни прочитать cookie, ни выставить заголовок. Проверяется всё равно не cookie,
 * а совпадение заголовка с `auth_sessions.csrf_hash`.
 */
export const CSRF_COOKIE = 'id_csrf';
/** Незавершённый вход: `state`, `nonce`, `code_verifier`. Живёт минуты. */
export const LOGIN_COOKIE = 'id_login';
export const CSRF_HEADER = 'x-csrf-token';

/** Методы, для которых CSRF-токен обязателен (§4.1). GET и HEAD — нет. */
export const CSRF_PROTECTED_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

const LOGIN_TRANSACTION_TTL_SECONDS = 600;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_KEY_BYTES = 32;

// =====================================================================
// Примитивы
// =====================================================================

/**
 * Сравнение без утечки через время исполнения.
 *
 * Применяется к `state`, `nonce` и хэшу CSRF-токена. Обычный `===` на строках
 * прерывается на первом различии, и по времени ответа значение восстанавливается
 * посимвольно. Разная длина сравниваться не может, поэтому она проверяется
 * отдельно — сама длина секретом не является.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function sha256Hex(value: string): string {
  return hash('sha256', Buffer.from(value, 'utf8'), 'hex');
}

/**
 * Адрес для колонки `inet` либо `null`.
 *
 * `request.ip` — значение внешнего происхождения: при доверии прокси в нём
 * оказывается то, что стоит в `X-Forwarded-For`. Нечисловая строка доезжала до
 * PostgreSQL параметром `$9::inet` и возвращалась ошибкой 22P02, то есть
 * неаутентифицированным 500 на `/auth/callback`. Адрес — сведение для разбора
 * инцидентов, а не часть работы входа, поэтому непригодное значение отбрасывается,
 * а вход продолжается.
 *
 * Идентификатор зоны (`fe80::1%eth0`) `net.isIP` принимает, а `inet` — нет,
 * поэтому проверяется отдельно.
 */
export function normalizeIpAddress(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value.includes('%')) return null;
  return isIP(value) === 0 ? null : value;
}

/** В БД хранится только хэш CSRF-токена: сам токен восстановить нельзя. */
export function hashCsrfToken(token: string): string {
  return sha256Hex(token);
}

export function randomSessionId(): string {
  return randomUUID();
}

// =====================================================================
// Шифрование refresh-токена
// =====================================================================

export interface SessionCipher {
  readonly keyVersion: number;
  seal(plaintext: string, aad: string): Promise<Buffer>;
  /** `null`, если конверт зашифрован недоступным ключом или повреждён. */
  open(envelope: Buffer, aad: string, keyVersion: number): Promise<string | null>;
}

/**
 * Ключ шифрования.
 *
 * Вне продакшна `SESSION_ENC_KEY` не обязателен (`loadEnv()` требует его только
 * при `NODE_ENV=production`), поэтому при отсутствии генерируется случайный на
 * время жизни процесса. Последствие осознанное: после перезапуска сервера
 * в разработке refresh-токены прежних сессий не расшифровываются, и это лучше,
 * чем константа по умолчанию, которая однажды доедет до боевого стенда.
 *
 * Реализация на WebCrypto (`subtle`), а не на потоковом `createCipheriv`:
 * односоставный вызов не даёт забыть `final()` и не оставляет объекта с
 * изменяемым состоянием, который легко переиспользовать по ошибке. Цена —
 * асинхронный интерфейс.
 */
export async function createSessionCipher(env: Env): Promise<SessionCipher> {
  const keyBytes =
    env.SESSION_ENC_KEY === undefined
      ? randomBytes(AES_KEY_BYTES)
      : Buffer.from(env.SESSION_ENC_KEY, 'base64');

  if (keyBytes.byteLength !== AES_KEY_BYTES) {
    throw new Error(`SESSION_ENC_KEY: ожидается ${String(AES_KEY_BYTES)} байт в base64`);
  }

  const keyVersion = env.SESSION_ENC_KEY_VERSION;
  // extractable: false — ключ нельзя выгрузить обратно даже из своего процесса.
  const key = await webcrypto.subtle.importKey(
    'raw',
    new Uint8Array(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

  return {
    keyVersion,

    async seal(plaintext: string, aad: string): Promise<Buffer> {
      const iv = randomBytes(GCM_IV_BYTES);
      const ciphertext = await webcrypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(iv),
          // AAD связывает конверт с конкретной строкой: перенести refresh-токен
          // в чужую сессию правкой одного поля в БД не получится.
          additionalData: new TextEncoder().encode(aad),
          tagLength: GCM_TAG_BYTES * 8,
        },
        key,
        new TextEncoder().encode(plaintext),
      );
      // WebCrypto дописывает тег в конец шифротекста, поэтому конверт — это
      // iv || ciphertext || tag, а не iv || tag || ciphertext.
      return Buffer.concat([iv, Buffer.from(ciphertext)]);
    },

    async open(envelope: Buffer, aad: string, envelopeKeyVersion: number): Promise<string | null> {
      if (envelopeKeyVersion !== keyVersion) return null;
      if (envelope.byteLength < GCM_IV_BYTES + GCM_TAG_BYTES) return null;
      try {
        const plaintext = await webcrypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: new Uint8Array(envelope.subarray(0, GCM_IV_BYTES)),
            additionalData: new TextEncoder().encode(aad),
            tagLength: GCM_TAG_BYTES * 8,
          },
          key,
          new Uint8Array(envelope.subarray(GCM_IV_BYTES)),
        );
        return Buffer.from(plaintext).toString('utf8');
      } catch {
        // Несовпадение тега неотличимо от порчи данных и одинаково означает
        // «доверять содержимому нельзя».
        return null;
      }
    },
  };
}

function refreshTokenAad(sessionId: string, keyVersion: number): string {
  return `auth_sessions:${sessionId}:v${String(keyVersion)}`;
}

// =====================================================================
// Незавершённый вход
// =====================================================================

const loginTransactionSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
  returnTo: z.string().min(1),
  issuedAt: z.int().positive(),
});

export type LoginTransaction = z.infer<typeof loginTransactionSchema>;

/**
 * `state`, `nonce` и `code_verifier` уезжают в браузер шифрованными.
 *
 * Подписи было бы недостаточно: `code_verifier` — секрет PKCE, и в открытой
 * cookie он превращает PKCE в декорацию. Хранить незавершённый вход в БД тоже
 * можно, но это строка на каждое нажатие «Войти», включая брошенные.
 */
export async function sealLoginTransaction(
  cipher: SessionCipher,
  transaction: LoginTransaction,
): Promise<string> {
  const envelope = await cipher.seal(JSON.stringify(transaction), LOGIN_COOKIE);
  return envelope.toString('base64url');
}

export async function openLoginTransaction(
  cipher: SessionCipher,
  raw: string,
): Promise<LoginTransaction | null> {
  const plaintext = await cipher.open(
    Buffer.from(raw, 'base64url'),
    LOGIN_COOKIE,
    cipher.keyVersion,
  );
  if (plaintext === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }

  const result = loginTransactionSchema.safeParse(parsed);
  if (!result.success) return null;
  if (Date.now() - result.data.issuedAt > LOGIN_TRANSACTION_TTL_SECONDS * 1000) return null;
  return result.data;
}

// =====================================================================
// Cookie
// =====================================================================

/**
 * `Secure` включается по схеме PUBLIC_URL, а не по NODE_ENV.
 *
 * `loadEnv()` уже требует https в продакшне, поэтому такая привязка строго не
 * слабее, а в разработке по http браузер просто отбросил бы `Secure`-cookie,
 * и вход не работал бы вовсе.
 */
export function cookieSecurity(env: Env): boolean {
  return env.PUBLIC_URL.startsWith('https://');
}

export function sessionCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: cookieSecurity(env),
    sameSite: 'lax',
    path: '/',
    signed: true,
  };
}

/** CSRF-токен читает SPA, поэтому `httpOnly` здесь неприменим. */
export function csrfCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: false,
    secure: cookieSecurity(env),
    sameSite: 'lax',
    path: '/',
  };
}

export function loginCookieOptions(env: Env): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: cookieSecurity(env),
    sameSite: 'lax',
    path: '/auth',
    maxAge: LOGIN_TRANSACTION_TTL_SECONDS,
    signed: true,
  };
}

// =====================================================================
// Хранилище сессий
// =====================================================================

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly kcSid: string | null;
  readonly keyVersion: number;
  readonly csrfHash: string;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly createdAt: Date;
}

export interface CreateSessionInput {
  readonly userId: string;
  readonly kcSid: string | null;
  readonly refreshToken: string | null;
  readonly csrfToken: string;
  /** Проходит `normalizeIpAddress()`: непригодное значение станет `NULL`. */
  readonly ip: string | null;
  readonly userAgent: string | null;
}

type SessionRow = {
  id: string;
  user_id: string;
  kc_sid: string | null;
  key_version: number;
  csrf_hash: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  created_at: Date;
};

type EnvelopeRow = { refresh_envelope: Buffer; key_version: number };

const SESSION_COLUMNS = `id, user_id, kc_sid, key_version, csrf_hash,
       idle_expires_at, absolute_expires_at, created_at`;

/**
 * Доступ к `auth_sessions` и `users` идёт параметризованным SQL, а не через
 * scoped-репозиторий: у аутентификации нет области видимости по определению —
 * она эту область и устанавливает. Все запросы здесь адресуют строку по
 * первичному ключу либо по `user_id`, никаких данных ИД не читают.
 */
export class SessionStore {
  readonly #pool: Pool;
  readonly #cipher: SessionCipher;
  readonly #idleMs: number;
  readonly #absoluteMs: number;

  constructor(pool: Pool, cipher: SessionCipher, env: Env) {
    this.#pool = pool;
    this.#cipher = cipher;
    this.#idleMs = env.SESSION_IDLE_MINUTES * 60_000;
    this.#absoluteMs = env.SESSION_ABSOLUTE_HOURS * 3_600_000;
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const id = randomSessionId();
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + this.#absoluteMs);
    const idleExpiresAt = new Date(Math.min(now + this.#idleMs, absoluteExpiresAt.getTime()));

    // Колонка NOT NULL, а refresh-токен провайдер может и не выдать: пустая
    // строка в конверте отличима от отсутствия конверта и не требует ветки в схеме.
    const envelope = await this.#cipher.seal(
      input.refreshToken ?? '',
      refreshTokenAad(id, this.#cipher.keyVersion),
    );

    const { rows } = await this.#pool.query<SessionRow>(
      `insert into auth_sessions
         (id, user_id, kc_sid, refresh_envelope, key_version, csrf_hash,
          idle_expires_at, absolute_expires_at, ip, ua)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10)
       returning ${SESSION_COLUMNS}`,
      [
        id,
        input.userId,
        input.kcSid,
        envelope,
        this.#cipher.keyVersion,
        hashCsrfToken(input.csrfToken),
        idleExpiresAt,
        absoluteExpiresAt,
        normalizeIpAddress(input.ip),
        input.userAgent?.slice(0, 512) ?? null,
      ],
    );

    const row = rows[0];
    if (row === undefined) throw new Error('Сессия не создана: insert не вернул строку');
    return toSessionRecord(row);
  }

  /** Действующая сессия либо `null`. Истёкшая и отозванная неразличимы намеренно. */
  async load(sessionId: string): Promise<SessionRecord | null> {
    // Мусор в cookie иначе дошёл бы до PostgreSQL и вернулся ошибкой 22P02,
    // то есть 500 вместо 401.
    if (!UUID_PATTERN.test(sessionId)) return null;

    const { rows } = await this.#pool.query<SessionRow>(
      `select ${SESSION_COLUMNS}
         from auth_sessions
        where id = $1
          and revoked_at is null
          and idle_expires_at > now()
          and absolute_expires_at > now()`,
      [sessionId],
    );

    const row = rows[0];
    return row === undefined ? null : toSessionRecord(row);
  }

  /**
   * Продление скользящего окна простоя.
   *
   * Обновление делается не на каждом запросе, а когда истекла половина окна:
   * иначе каждый GET превращался бы в запись, и `auth_sessions` стала бы самой
   * горячей таблицей портала на пустом месте.
   */
  async touch(session: SessionRecord): Promise<SessionRecord> {
    const now = Date.now();
    if (session.idleExpiresAt.getTime() - now > this.#idleMs / 2) return session;

    const next = new Date(Math.min(now + this.#idleMs, session.absoluteExpiresAt.getTime()));
    const { rows } = await this.#pool.query<SessionRow>(
      `update auth_sessions
          set idle_expires_at = $2
        where id = $1 and revoked_at is null
        returning ${SESSION_COLUMNS}`,
      [session.id, next],
    );

    const row = rows[0];
    return row === undefined ? session : toSessionRecord(row);
  }

  /** `null`, если токена не было или он зашифрован недоступной версией ключа. */
  async readRefreshToken(sessionId: string): Promise<string | null> {
    const { rows } = await this.#pool.query<EnvelopeRow>(
      'select refresh_envelope, key_version from auth_sessions where id = $1',
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) return null;

    const plaintext = await this.#cipher.open(
      row.refresh_envelope,
      refreshTokenAad(sessionId, row.key_version),
      row.key_version,
    );
    return plaintext === null || plaintext === '' ? null : plaintext;
  }

  /** Вызывается после обновления токенов: конверт всегда перезаписывается целиком. */
  async replaceRefreshToken(sessionId: string, refreshToken: string | null): Promise<void> {
    const envelope = await this.#cipher.seal(
      refreshToken ?? '',
      refreshTokenAad(sessionId, this.#cipher.keyVersion),
    );
    await this.#pool.query(
      'update auth_sessions set refresh_envelope = $2, key_version = $3 where id = $1',
      [sessionId, envelope, this.#cipher.keyVersion],
    );
  }

  async rotateCsrfToken(sessionId: string, csrfToken: string): Promise<void> {
    await this.#pool.query('update auth_sessions set csrf_hash = $2 where id = $1', [
      sessionId,
      hashCsrfToken(csrfToken),
    ]);
  }

  async revoke(sessionId: string): Promise<void> {
    if (!UUID_PATTERN.test(sessionId)) return;
    await this.#pool.query(
      'update auth_sessions set revoked_at = now() where id = $1 and revoked_at is null',
      [sessionId],
    );
  }

  /** Для деактивации пользователя и для back-channel logout по `kc_sid`. */
  async revokeAllForUser(userId: string): Promise<number> {
    const result = await this.#pool.query(
      'update auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async revokeByKeycloakSession(kcSid: string): Promise<number> {
    const result = await this.#pool.query(
      'update auth_sessions set revoked_at = now() where kc_sid = $1 and revoked_at is null',
      [kcSid],
    );
    return result.rowCount ?? 0;
  }

  verifyCsrfToken(session: SessionRecord, presentedToken: string | undefined): boolean {
    if (presentedToken === undefined || presentedToken === '') return false;
    return constantTimeEquals(hashCsrfToken(presentedToken), session.csrfHash);
  }
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kcSid: row.kc_sid,
    keyVersion: row.key_version,
    csrfHash: row.csrf_hash,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    createdAt: row.created_at,
  };
}
