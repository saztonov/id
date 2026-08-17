/**
 * Провайдер OIDC: Keycloak и локальная заглушка за одним интерфейсом.
 *
 * Authorization Code Flow + PKCE с обязательными `state` и `nonce` (§4.1).
 * Токены остаются на сервере: наружу из этого модуля уходят только разобранные
 * claims и строка refresh-токена, которую вызывающий обязан немедленно
 * зашифровать (см. `session.ts`).
 *
 * Заглушка нужна не для удобства, а потому что на машине сборки нет Docker и,
 * значит, нет Keycloak (§1.3). Чтобы заглушка проверяла тот же код, что и
 * настоящий провайдер, она подписывает id_token локальным ключом в той же форме
 * claims, а **верификатор один** — `verifyIdToken()`. Различается только
 * источник ключей: удалённый JWKS против локального. Иначе в продакшне
 * исполнялся бы путь, ни разу не проверенный тестами.
 *
 * Запрет `AUTH_MODE=dev-stub` при `NODE_ENV=production` живёт в `config/env.ts`
 * и здесь не дублируется.
 */
import { hash, randomUUID } from 'node:crypto';
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  buildEndSessionUrl,
  calculatePKCECodeChallenge,
  type Configuration,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  refreshTokenGrant,
  tokenRevocation,
} from 'openid-client';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import type { Env } from '../config/env.js';
import { forbidden, HttpProblem, unauthorized } from '../lib/problem.js';
import { constantTimeEquals } from './session.js';

/** Клиент Keycloak, к которому привязаны роли портала. */
export const DEFAULT_PORTAL_CLIENT_ID = 'id-portal';

/**
 * Единственная роль, за которую отвечает Keycloak (§4.1): право войти в портал.
 *
 * Проверяется в двух местах, потому что в Keycloak её объявляют то ролью
 * клиента `id-portal` (тогда в токене это `resource_access['id-portal'].roles`
 * со значением `access`), то ролью realm с полным именем. Принимаем оба вида,
 * чтобы настройка realm'а не требовала правки кода.
 */
export const PORTAL_ACCESS_CLIENT_ROLE = 'access';
export const PORTAL_ACCESS_REALM_ROLE = 'id-portal.access';

/** Подпись: только асимметричная. HMAC при публичном JWKS — путь к подделке. */
const ALLOWED_ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'];

const CLOCK_TOLERANCE_SECONDS = 5;
const DEV_STUB_ALGORITHM = 'ES256';
const DEV_STUB_KEY_ID = 'dev-stub';
const DEV_STUB_ISSUER = 'urn:id-portal:dev-stub';
const DEV_STUB_TOKEN_TTL_SECONDS = 300;
/**
 * Сколько помнить израсходованные коды заглушки.
 *
 * Совпадает со сроком жизни cookie логина: код без действующей cookie обменять
 * всё равно нельзя, поэтому запись старше этого срока ничего не защищает и
 * только держит память.
 */
const DEV_STUB_CODE_MEMORY_SECONDS = 600;
/** После этого числа записей словарь просроченных чистится. */
const DEV_STUB_CODE_MEMORY_LIMIT = 1000;

export type AuthMode = Env['AUTH_MODE'];

/**
 * Разобранные claims идентификации.
 *
 * Роли здесь присутствуют намеренно и ровно для одного применения — проверки
 * `id-portal.access`. Бизнес-роли из токена не используются никогда: их
 * источник — таблицы портала (§4.1). Структурная гарантия этого — в
 * `middleware/require-auth.ts`, где роли имеют помеченный тип, который нельзя
 * получить из строк токена.
 */
export interface IdentityClaims {
  readonly subject: string;
  readonly issuer: string;
  /** Идентификатор SSO-сессии Keycloak: попадает в `auth_sessions.kc_sid`. */
  readonly sessionId: string | null;
  readonly email: string | null;
  readonly fullName: string | null;
  readonly preferredUsername: string | null;
  readonly realmRoles: readonly string[];
  readonly clientRoles: readonly string[];
}

export interface OidcTokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string | null;
  readonly accessTokenExpiresAt: Date | null;
}

/** Личность, которую выдаёт заглушка. Провайдером `oidc` игнорируется. */
export interface DevStubIdentity {
  readonly subject: string;
  readonly email: string | null;
  readonly fullName: string | null;
  /**
   * Роли, которые заглушка положит в токен.
   *
   * Существует ради проверки требования §4.1: бизнес-роль в токене не должна
   * давать никаких прав. Тест выдаёт себе `manager` в токене и убеждается, что
   * портал по-прежнему считает пользователя беспра́вным.
   */
  readonly tokenRoles: readonly string[];
  readonly grantPortalAccess: boolean;
}

export interface StartLoginParams {
  readonly redirectUri: string;
  readonly loginHint?: string | undefined;
  readonly devStub?: DevStubIdentity | undefined;
}

export interface StartLoginResult {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly nonce: string;
  /** Остаётся на сервере: уходит в зашифрованную cookie логина, не в браузерный JS. */
  readonly codeVerifier: string;
}

export interface CompleteLoginParams {
  /** Полный URL обратного вызова вместе со строкой запроса. */
  readonly callbackUrl: URL;
  readonly expectedState: string;
  readonly expectedNonce: string;
  readonly codeVerifier: string;
}

export interface CompleteLoginResult {
  readonly tokens: OidcTokens;
  readonly claims: IdentityClaims;
}

export interface EndSessionParams {
  readonly refreshToken: string | null;
  readonly postLogoutRedirectUri: string;
}

export interface EndSessionResult {
  /**
   * Адрес front-channel logout провайдера. Локальную сессию мы уже отозвали,
   * но SSO-cookie Keycloak снимается только переходом браузера по этому адресу.
   */
  readonly endSessionUrl: string | null;
  /** Удалось ли отозвать refresh-токен на стороне провайдера (RFC 7009). */
  readonly refreshTokenRevoked: boolean;
  /** Причина неудачи — для журнала, не для ответа клиенту. */
  readonly failure: string | null;
}

export interface AuthProvider {
  readonly mode: AuthMode;
  startLogin(params: StartLoginParams): Promise<StartLoginResult>;
  completeLogin(params: CompleteLoginParams): Promise<CompleteLoginResult>;
  refresh(refreshToken: string): Promise<OidcTokens>;
  endSession(params: EndSessionParams): Promise<EndSessionResult>;
}

export function hasPortalAccess(claims: IdentityClaims): boolean {
  return (
    claims.clientRoles.includes(PORTAL_ACCESS_CLIENT_ROLE) ||
    claims.realmRoles.includes(PORTAL_ACCESS_REALM_ROLE)
  );
}

// =====================================================================
// Единственный верификатор id_token
// =====================================================================

const rolesClaimSchema = z.object({ roles: z.array(z.string()).default([]) });

const idTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  iss: z.string().min(1),
  sid: z.string().min(1).optional(),
  nonce: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  given_name: z.string().min(1).optional(),
  family_name: z.string().min(1).optional(),
  preferred_username: z.string().min(1).optional(),
  realm_access: rolesClaimSchema.optional(),
  resource_access: z.record(z.string(), rolesClaimSchema).optional(),
});

interface IdTokenExpectations {
  readonly issuer: string;
  readonly audience: string;
  readonly clientId: string;
  readonly expectedNonce: string;
}

/**
 * Проверка id_token: подпись, `iss`, `aud`, срок, затем `nonce`.
 *
 * `nonce` проверяется здесь, а не только средствами openid-client, потому что
 * этот же код обслуживает заглушку. Пропущенная проверка `nonce` возвращает
 * атаку подстановки токена, от которой Authorization Code Flow защищается
 * именно им.
 */
async function verifyIdToken(
  idToken: string,
  keys: JWTVerifyGetKey,
  expectations: IdTokenExpectations,
): Promise<IdentityClaims> {
  let payload: unknown;
  try {
    const verified = await jwtVerify(idToken, keys, {
      issuer: expectations.issuer,
      audience: expectations.audience,
      algorithms: ALLOWED_ID_TOKEN_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat'],
    });
    payload = verified.payload;
  } catch (cause) {
    throw unauthorized('Токен провайдера идентификации не прошёл проверку.', {
      cause,
      logDetail: 'подпись или обязательные claims id_token недействительны',
    });
  }

  const parsed = idTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw unauthorized('Токен провайдера идентификации не прошёл проверку.', {
      logDetail: 'id_token не содержит обязательных claims в ожидаемой форме',
    });
  }
  const claims = parsed.data;

  if (claims.nonce === undefined || !constantTimeEquals(claims.nonce, expectations.expectedNonce)) {
    throw unauthorized('Токен провайдера идентификации не прошёл проверку.', {
      logDetail: 'nonce id_token не совпал с nonce запроса авторизации',
    });
  }

  return {
    subject: claims.sub,
    issuer: claims.iss,
    sessionId: claims.sid ?? null,
    email: claims.email ?? null,
    fullName: composeFullName(claims),
    preferredUsername: claims.preferred_username ?? null,
    realmRoles: claims.realm_access?.roles ?? [],
    clientRoles: claims.resource_access?.[expectations.clientId]?.roles ?? [],
  };
}

function composeFullName(claims: z.infer<typeof idTokenClaimsSchema>): string | null {
  if (claims.name !== undefined) return claims.name;
  const parts = [claims.family_name, claims.given_name].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

// =====================================================================
// Провайдер Keycloak
// =====================================================================

interface OidcProviderOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

class KeycloakAuthProvider implements AuthProvider {
  readonly mode = 'oidc';

  readonly #options: OidcProviderOptions;
  /**
   * Discovery выполняется при первом использовании, а не при старте: недоступный
   * Keycloak не должен мешать процессу подняться и отвечать на `/health/live`.
   * Неудача не запоминается — следующая попытка входа повторит запрос.
   */
  #configuration: Promise<Configuration> | null = null;
  #jwks: JWTVerifyGetKey | null = null;

  constructor(options: OidcProviderOptions) {
    this.#options = options;
  }

  async #config(): Promise<Configuration> {
    this.#configuration ??= discovery(
      new URL(this.#options.issuer),
      this.#options.clientId,
      this.#options.clientSecret,
    ).catch((cause: unknown) => {
      this.#configuration = null;
      throw new HttpProblem(503, undefined, {
        slug: 'unavailable',
        detail: 'Провайдер идентификации недоступен. Повторите попытку позже.',
        cause,
        logDetail: 'discovery по OIDC_ISSUER не удался',
      });
    });
    return this.#configuration;
  }

  async #keys(): Promise<JWTVerifyGetKey> {
    if (this.#jwks !== null) return this.#jwks;
    const metadata = (await this.#config()).serverMetadata();
    if (metadata.jwks_uri === undefined) {
      throw new HttpProblem(503, undefined, {
        slug: 'unavailable',
        logDetail: 'метаданные провайдера не содержат jwks_uri',
      });
    }
    // Кэш ключей внутри createRemoteJWKSet: без него каждая проверка токена
    // тянула бы JWKS по сети.
    this.#jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    return this.#jwks;
  }

  async startLogin(params: StartLoginParams): Promise<StartLoginResult> {
    const config = await this.#config();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const state = randomState();
    const nonce = randomNonce();

    const url = buildAuthorizationUrl(config, {
      redirect_uri: params.redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      ...(params.loginHint !== undefined ? { login_hint: params.loginHint } : {}),
    });

    return { authorizationUrl: url.href, state, nonce, codeVerifier };
  }

  async completeLogin(params: CompleteLoginParams): Promise<CompleteLoginResult> {
    const config = await this.#config();
    let response: Awaited<ReturnType<typeof authorizationCodeGrant>>;
    try {
      response = await authorizationCodeGrant(config, params.callbackUrl, {
        pkceCodeVerifier: params.codeVerifier,
        expectedState: params.expectedState,
        expectedNonce: params.expectedNonce,
        idTokenExpected: true,
      });
    } catch (cause) {
      throw unauthorized('Не удалось завершить вход.', {
        cause,
        logDetail: 'обмен authorization code на токены отклонён провайдером',
      });
    }

    const tokens = toOidcTokens(response);
    const claims = await verifyIdToken(tokens.idToken, await this.#keys(), {
      issuer: (await this.#config()).serverMetadata().issuer,
      audience: this.#options.clientId,
      clientId: this.#options.clientId,
      expectedNonce: params.expectedNonce,
    });

    return { tokens, claims };
  }

  async refresh(refreshToken: string): Promise<OidcTokens> {
    const config = await this.#config();
    try {
      return toOidcTokens(await refreshTokenGrant(config, refreshToken));
    } catch (cause) {
      throw unauthorized('Сессия истекла, войдите заново.', {
        cause,
        logDetail: 'refresh_token отклонён провайдером',
      });
    }
  }

  async endSession(params: EndSessionParams): Promise<EndSessionResult> {
    const config = await this.#config();

    let revoked = false;
    let failure: string | null = null;
    if (params.refreshToken !== null) {
      try {
        // RFC 7009: обрывает выданный порталу доступ немедленно, не дожидаясь,
        // пока браузер перейдёт по front-channel адресу (а он может и не перейти).
        await tokenRevocation(config, params.refreshToken, {
          token_type_hint: 'refresh_token',
        });
        revoked = true;
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : 'отзыв refresh-токена не удался';
      }
    }

    let endSessionUrl: string | null = null;
    try {
      endSessionUrl = buildEndSessionUrl(config, {
        post_logout_redirect_uri: params.postLogoutRedirectUri,
      }).href;
    } catch (cause) {
      failure ??= cause instanceof Error ? cause.message : 'end_session_endpoint недоступен';
    }

    return { endSessionUrl, refreshTokenRevoked: revoked, failure };
  }
}

function toOidcTokens(response: {
  access_token: string;
  id_token?: string | undefined;
  refresh_token?: string | undefined;
  expires_in?: number | undefined;
}): OidcTokens {
  if (response.id_token === undefined) {
    throw unauthorized('Не удалось завершить вход.', {
      logDetail: 'провайдер не вернул id_token',
    });
  }
  return {
    accessToken: response.access_token,
    idToken: response.id_token,
    refreshToken: response.refresh_token ?? null,
    accessTokenExpiresAt:
      response.expires_in === undefined ? null : new Date(Date.now() + response.expires_in * 1000),
  };
}

// =====================================================================
// Локальная заглушка
// =====================================================================

interface StubKeys {
  readonly privateKey: CryptoKey;
  readonly verify: JWTVerifyGetKey;
}

const stubAuthorizationCodeSchema = z.object({
  sub: z.string().min(1),
  email: z.string().nullable(),
  name: z.string().nullable(),
  sid: z.string().min(1),
  nonce: z.string().min(1),
  state: z.string().min(1),
  challenge: z.string().min(1),
  roles: z.array(z.string()),
  access: z.boolean(),
});

type StubAuthorizationCode = z.infer<typeof stubAuthorizationCodeSchema>;

/**
 * Заглушка играет обе роли: и провайдера, и его же клиента.
 *
 * Она не срезает шаги протокола — сама проверяет `state`, соответствие
 * `code_verifier` ранее присланному `code_challenge` и одноразовость кода. Иначе
 * PKCE, `state` и защита от повтора оставались бы непроверенными до первого
 * запуска с настоящим Keycloak.
 */
class DevStubAuthProvider implements AuthProvider {
  readonly mode = 'dev-stub';

  readonly #clientId: string;
  #keys: Promise<StubKeys> | null = null;
  /**
   * Израсходованные коды: `sid` → когда запись можно забыть.
   *
   * Настоящий провайдер расходует authorization code при первом обмене, и без
   * этого заглушка отличалась бы от него в опасную сторону: один перехваченный
   * URL обратного вызова вместе с cookie логина выписывал неограниченное число
   * сессий. Проверено атакой: четыре повтора дали четыре сессии.
   *
   * Ключ — `sid` из самого кода, а не строка кода: перекодировать JSON и
   * получить другую строку с тем же `sid` слишком просто.
   */
  #usedCodes = new Map<string, number>();

  constructor(clientId: string) {
    this.#clientId = clientId;
  }

  /**
   * Помечает код использованным. `false` — код уже расходовали.
   *
   * Проверка и отметка выполняются одним синхронным шагом: между ними не должно
   * быть `await`, иначе два одновременных повтора успели бы пройти оба.
   */
  #consumeCode(sid: string): boolean {
    const now = Date.now();
    if (this.#usedCodes.has(sid)) return false;

    if (this.#usedCodes.size >= DEV_STUB_CODE_MEMORY_LIMIT) {
      // Просроченные записи выбрасываются пересборкой, а не удалением по ключу:
      // ничего, кроме размера словаря, от способа не зависит.
      this.#usedCodes = new Map([...this.#usedCodes].filter(([, until]) => until > now));
    }

    this.#usedCodes.set(sid, now + DEV_STUB_CODE_MEMORY_SECONDS * 1000);
    return true;
  }

  async #stubKeys(): Promise<StubKeys> {
    this.#keys ??= (async (): Promise<StubKeys> => {
      const pair = await generateKeyPair(DEV_STUB_ALGORITHM, { extractable: true });
      const publicJwk = await exportJWK(pair.publicKey);
      return {
        privateKey: pair.privateKey,
        verify: createLocalJWKSet({
          keys: [{ ...publicJwk, alg: DEV_STUB_ALGORITHM, kid: DEV_STUB_KEY_ID, use: 'sig' }],
        }),
      };
    })();
    return this.#keys;
  }

  startLogin(params: StartLoginParams): Promise<StartLoginResult> {
    const identity: DevStubIdentity = params.devStub ?? {
      subject: 'dev-stub-user',
      email: null,
      fullName: null,
      tokenRoles: [],
      grantPortalAccess: true,
    };

    const codeVerifier = randomPKCECodeVerifier();
    const state = randomState();
    const nonce = randomNonce();

    return calculatePKCECodeChallenge(codeVerifier).then((challenge) => {
      const code: StubAuthorizationCode = {
        sub: identity.subject,
        email: identity.email,
        name: identity.fullName,
        sid: randomUUID(),
        nonce,
        state,
        challenge,
        roles: [...identity.tokenRoles],
        access: identity.grantPortalAccess,
      };
      const url = new URL(params.redirectUri);
      url.searchParams.set('code', encodeStubCode(code));
      url.searchParams.set('state', state);
      return { authorizationUrl: url.href, state, nonce, codeVerifier };
    });
  }

  async completeLogin(params: CompleteLoginParams): Promise<CompleteLoginResult> {
    const rawCode = params.callbackUrl.searchParams.get('code');
    const returnedState = params.callbackUrl.searchParams.get('state');
    if (rawCode === null || returnedState === null) {
      throw unauthorized('Не удалось завершить вход.', {
        logDetail: 'ответ авторизации заглушки без code или state',
      });
    }

    const code = decodeStubCode(rawCode);

    if (
      !constantTimeEquals(returnedState, params.expectedState) ||
      !constantTimeEquals(code.state, params.expectedState)
    ) {
      throw unauthorized('Не удалось завершить вход.', {
        logDetail: 'state ответа авторизации не совпал с ожидаемым',
      });
    }

    const challenge = await calculatePKCECodeChallenge(params.codeVerifier);
    if (!constantTimeEquals(challenge, code.challenge)) {
      throw unauthorized('Не удалось завершить вход.', {
        logDetail: 'code_verifier не соответствует code_challenge (PKCE)',
      });
    }

    // Последним шагом перед выдачей токенов: неудачный обмен код не расходует,
    // иначе знающий URL обратного вызова отбирал бы вход у самого пользователя.
    if (!this.#consumeCode(code.sid)) {
      throw unauthorized('Не удалось завершить вход.', {
        logDetail: 'authorization code заглушки уже был использован',
      });
    }

    const keys = await this.#stubKeys();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({
      sid: code.sid,
      nonce: code.nonce,
      ...(code.email !== null ? { email: code.email } : {}),
      ...(code.name !== null ? { name: code.name } : {}),
      preferred_username: code.sub,
      realm_access: { roles: code.roles },
      resource_access: {
        [this.#clientId]: { roles: code.access ? [PORTAL_ACCESS_CLIENT_ROLE] : [] },
      },
    })
      .setProtectedHeader({ alg: DEV_STUB_ALGORITHM, kid: DEV_STUB_KEY_ID })
      .setIssuer(DEV_STUB_ISSUER)
      .setAudience(this.#clientId)
      .setSubject(code.sub)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + DEV_STUB_TOKEN_TTL_SECONDS)
      .sign(keys.privateKey);

    const claims = await verifyIdToken(idToken, keys.verify, {
      issuer: DEV_STUB_ISSUER,
      audience: this.#clientId,
      clientId: this.#clientId,
      expectedNonce: params.expectedNonce,
    });

    return {
      tokens: {
        accessToken: `dev-stub-access-${code.sid}`,
        idToken,
        // Отпечаток, а не сам «токен»: значение всё равно уйдёт в шифрованный
        // конверт, и путь шифрования должен проверяться и в режиме заглушки.
        refreshToken: `dev-stub-refresh-${hash('sha256', code.sid, 'hex')}`,
        accessTokenExpiresAt: new Date(Date.now() + DEV_STUB_TOKEN_TTL_SECONDS * 1000),
      },
      claims,
    };
  }

  refresh(refreshToken: string): Promise<OidcTokens> {
    if (!refreshToken.startsWith('dev-stub-refresh-')) {
      return Promise.reject(
        unauthorized('Сессия истекла, войдите заново.', {
          logDetail: 'refresh-токен не выпускался заглушкой',
        }),
      );
    }
    return Promise.reject(
      forbidden('Обновление токена в режиме заглушки не поддерживается.', {
        logDetail: 'AUTH_MODE=dev-stub: refresh не реализован намеренно',
      }),
    );
  }

  endSession(params: EndSessionParams): Promise<EndSessionResult> {
    // Внешней SSO-сессии нет, снимать нечего: локальный отзыв уже произошёл.
    return Promise.resolve({
      endSessionUrl: params.postLogoutRedirectUri,
      refreshTokenRevoked: params.refreshToken !== null,
      failure: null,
    });
  }
}

function encodeStubCode(code: StubAuthorizationCode): string {
  return Buffer.from(JSON.stringify(code), 'utf8').toString('base64url');
}

function decodeStubCode(raw: string): StubAuthorizationCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (cause) {
    throw unauthorized('Не удалось завершить вход.', {
      cause,
      logDetail: 'authorization code заглушки не разбирается',
    });
  }
  const result = stubAuthorizationCodeSchema.safeParse(parsed);
  if (!result.success) {
    throw unauthorized('Не удалось завершить вход.', {
      logDetail: 'authorization code заглушки не той формы',
    });
  }
  return result.data;
}

// =====================================================================
// Сборка
// =====================================================================

export function createAuthProvider(env: Env): AuthProvider {
  const clientId = env.OIDC_CLIENT_ID ?? DEFAULT_PORTAL_CLIENT_ID;

  if (env.AUTH_MODE === 'dev-stub') return new DevStubAuthProvider(clientId);

  // Обязательность этих переменных при AUTH_MODE=oidc проверена в loadEnv();
  // здесь остаётся только сужение типа.
  if (
    env.OIDC_ISSUER === undefined ||
    env.OIDC_CLIENT_ID === undefined ||
    env.OIDC_CLIENT_SECRET === undefined
  ) {
    throw new Error('AUTH_MODE=oidc требует OIDC_ISSUER, OIDC_CLIENT_ID и OIDC_CLIENT_SECRET');
  }

  return new KeycloakAuthProvider({
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
  });
}
