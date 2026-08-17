/**
 * Переменные окружения и проверки при старте.
 *
 * Стандарт требует fail-fast: процесс не должен подниматься с конфигурацией,
 * при которой он будет работать неправильно или небезопасно. Отдельно
 * проверяется то, что в продакшне запрещено само по себе — режим заглушки
 * авторизации и локальное хранилище файлов.
 */
import { z } from 'zod';

/** Заглушки, которыми обычно заполняют .env.example. */
const PLACEHOLDERS = ['changeme', 'change-me', 'todo', 'xxx', 'secret', 'password', '<...>'];

const nonPlaceholder = (name: string) =>
  z
    .string()
    .min(1)
    .refine(
      (v) => !PLACEHOLDERS.includes(v.toLowerCase()),
      `${name}: значение выглядит как заглушка из .env.example`,
    );

/**
 * Заглушка в строке подключения — на месте пароля, а не вместо всей строки.
 *
 * Скопированный `.env.example` выглядит как
 * `postgresql://id_app:changeme@db.internal:6432/id`, и сравнение значения
 * целиком такую строку пропускает. Проверять подстрокой по всему значению
 * нельзя: слово `password` законно встречается как имя параметра запроса.
 * Поэтому разбирается именно компонент пароля.
 */
const connectionString = (name: string) =>
  nonPlaceholder(name).refine((v) => {
    let password: string;
    try {
      password = decodeURIComponent(new URL(v).password);
    } catch {
      // Не разобралось как URL — судить о компонентах нечем, остальные
      // проверки схемы и подключение на старте выявят непригодное значение.
      return true;
    }
    return password === '' || !PLACEHOLDERS.includes(password.toLowerCase());
  }, `${name}: на месте пароля стоит заглушка из .env.example`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Публичный адрес портала: нужен для redirect_uri OIDC и ссылок в письмах. */
  PUBLIC_URL: z.string().url(),

  DATABASE_URL: connectionString('DATABASE_URL'),
  PG_CA_CERT_PATH: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  AUTH_MODE: z.enum(['oidc', 'dev-stub']).default('oidc'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),

  /** Ключ шифрования refresh-токена в сессии. 32 байта в base64. */
  SESSION_ENC_KEY: z.string().optional(),
  SESSION_ENC_KEY_VERSION: z.coerce.number().int().nonnegative().default(1),
  CSRF_SECRET: z.string().min(32).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),

  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default('ru-central-1'),
  LOCAL_STORAGE_DIR: z.string().optional(),

  PREVIEW_MODE: z.enum(['pdfjs', 'cached']).default('pdfjs'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(209_715_200),
  MAX_PAGES_PER_FILE: z.coerce.number().int().positive().default(500),

  RDWEB_BASE_URL: z.string().url().optional(),
  RDWEB_USER: z.string().optional(),
  RDWEB_PASSWORD: z.string().optional(),

  LLM_PROVIDER: z.enum(['proxy_llm', 'recorded', 'none']).default('none'),
  PROXY_LLM_BASE_URL: z.string().url().optional(),
  PROXY_LLM_TOKEN: z.string().optional(),
  LLM_MODEL_ALLOWLIST: z.string().optional(),

  AUDIT_HMAC_KEY: nonPlaceholder('AUDIT_HMAC_KEY').optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SLOW_REQUEST_MS: z.coerce.number().int().positive().default(1000),
  SLOW_QUERY_MS: z.coerce.number().int().positive().default(300),
  SLOW_EXTERNAL_MS: z.coerce.number().int().positive().default(5000),
  ERROR_REPORTER: z.enum(['db', 'sentry']).default('db'),
  SENTRY_DSN: z.string().optional(),
  METRICS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Кому верить в заголовке `X-Forwarded-For`.
   *
   * По умолчанию — никому. Безусловное `trustProxy: true` означает, что
   * адрес клиента выбирает сам клиент: подстановкой заголовка обходится
   * лимит запросов (ключ лимита — это `request.ip`), отравляется журнал
   * сессий и криминалистическая ценность ip-полей обнуляется. Проверено
   * атакой: с ротацией `X-Forwarded-For` восемь запросов при лимите три
   * не дали ни одного `429`.
   *
   * Значение — список адресов или подсетей доверенных прокси через запятую.
   * В single-VPS схеме это адрес nginx на той же машине.
   */
  TRUST_PROXY: z.string().default(''),

  /**
   * Принимать ли `X-Request-Id` от клиента.
   *
   * По умолчанию нет: принятый заголовок попадает в каждую строку журнала
   * запроса и в тело ответа, то есть атакующий подделывает корреляцию логов
   * и отражает произвольную строку. Включать имеет смысл только когда
   * заголовок ставит доверенный прокси, а не браузер.
   */
  TRUST_REQUEST_ID: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Требования, которые невозможно выразить схемой поля: они связывают
 * несколько переменных либо зависят от NODE_ENV.
 */
function crossChecks(env: Env): string[] {
  const errors: string[] = [];
  const isProd = env.NODE_ENV === 'production';

  if (env.AUTH_MODE === 'dev-stub' && isProd) {
    // Заглушка подписывает токены локальным ключом и принимает любую
    // заявленную роль. В продакшне это полный обход авторизации.
    errors.push('AUTH_MODE=dev-stub запрещён при NODE_ENV=production');
  }

  if (env.AUTH_MODE === 'oidc') {
    for (const key of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const) {
      if (!env[key]) errors.push(`${key} обязателен при AUTH_MODE=oidc`);
    }
  }

  if (isProd) {
    if (!env.SESSION_ENC_KEY) errors.push('SESSION_ENC_KEY обязателен в production');
    if (!env.CSRF_SECRET) errors.push('CSRF_SECRET обязателен в production');
    if (!env.AUDIT_HMAC_KEY) errors.push('AUDIT_HMAC_KEY обязателен в production');
    if (env.STORAGE_DRIVER === 'local') {
      // Стандарт запрещает постоянное хранение пользовательских данных на VPS.
      errors.push('STORAGE_DRIVER=local запрещён в production');
    }
    if (!env.PG_CA_CERT_PATH) {
      errors.push('PG_CA_CERT_PATH обязателен в production: TLS без проверки CA небезопасен');
    }
    if (!env.PUBLIC_URL.startsWith('https://')) {
      errors.push('PUBLIC_URL в production обязан быть https: cookie помечены Secure');
    }
    if (env.TRUST_PROXY === '') {
      // За nginx без списка доверенных прокси адрес клиента неизвестен: все
      // пользователи сходятся в один ключ лимита и делят одно ведро на всех,
      // а auth_sessions.ip у каждого равен адресу прокси, то есть журнал
      // сессий теряет смысл. Доверять же заголовку без списка нельзя —
      // тогда адрес называет сам клиент.
      errors.push(
        'TRUST_PROXY обязателен в production: укажите адрес nginx, иначе лимит запросов ' +
          'общий для всех пользователей, а адрес клиента не определяется',
      );
    }
  }

  if (env.SESSION_ENC_KEY !== undefined) {
    const size = Buffer.from(env.SESSION_ENC_KEY, 'base64').byteLength;
    if (size !== 32) {
      errors.push(`SESSION_ENC_KEY: ожидается 32 байта в base64, получено ${size}`);
    }
  }

  if (env.STORAGE_DRIVER === 's3') {
    for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const) {
      if (!env[key]) errors.push(`${key} обязателен при STORAGE_DRIVER=s3`);
    }
  } else if (!env.LOCAL_STORAGE_DIR) {
    errors.push('LOCAL_STORAGE_DIR обязателен при STORAGE_DRIVER=local');
  }

  if (env.LLM_PROVIDER === 'proxy_llm') {
    for (const key of ['PROXY_LLM_BASE_URL', 'PROXY_LLM_TOKEN'] as const) {
      if (!env[key]) errors.push(`${key} обязателен при LLM_PROVIDER=proxy_llm`);
    }
  }

  if (env.ERROR_REPORTER === 'sentry' && !env.SENTRY_DSN) {
    errors.push('SENTRY_DSN обязателен при ERROR_REPORTER=sentry');
  }

  if (env.SESSION_IDLE_MINUTES * 60 >= env.SESSION_ABSOLUTE_HOURS * 3600) {
    errors.push('SESSION_IDLE_MINUTES не может быть больше SESSION_ABSOLUTE_HOURS');
  }

  if (env.TRUST_REQUEST_ID && env.TRUST_PROXY === '') {
    // Заголовок ставит либо доверенный прокси, либо кто угодно. Без списка
    // доверенных прокси второе неотличимо от первого.
    errors.push('TRUST_REQUEST_ID=true требует непустого TRUST_PROXY');
  }

  return errors;
}

/**
 * Значение `trustProxy` для Fastify.
 *
 * Возвращает `false`, а не `true`, при пустом списке: доверять адресу,
 * который назвал сам клиент, нельзя даже «на всякий случай».
 */
export function trustProxyOption(env: Env): boolean | string[] {
  const list = env.TRUST_PROXY.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : false;
}

export class EnvError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Некорректная конфигурация окружения:\n  ${problems.join('\n  ')}`);
    this.name = 'EnvError';
  }
}

/**
 * Разбирает и проверяет окружение. Бросает `EnvError` со полным списком
 * проблем — по одной за запуск исправлять конфигурацию мучительно.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`),
    );
  }

  const problems = crossChecks(parsed.data);
  if (problems.length > 0) throw new EnvError(problems);

  return parsed.data;
}

/** Список моделей LLM, разрешённых политикой. */
export function allowedModels(env: Env): readonly string[] {
  return (env.LLM_MODEL_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
