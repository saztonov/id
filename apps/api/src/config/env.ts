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

  AUTH_MODE: z.enum(['oidc', 'dev-stub', 'local']).default('oidc'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),

  // --- локальная аутентификация, AUTH_MODE=local (ADR-0009) ---

  /**
   * Ключ HMAC для ключей троттлинга входа. 32+ байта.
   *
   * Отдельный от AUDIT_HMAC_KEY намеренно: ротация ключа журнала не должна
   * массово снимать блокировки входа — иначе смена ключа становится способом
   * сбросить защиту от перебора.
   */
  AUTH_LOCAL_LOGIN_HMAC_KEY: nonPlaceholder('AUTH_LOCAL_LOGIN_HMAC_KEY').optional(),
  AUTH_LOCAL_REGISTRATION_ENABLED: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  /**
   * Границы длины пароля — единственный источник для всего кода: политика
   * (`policy.ts`) и схемы тела запросов берут значения отсюда. Два независимых
   * максимума разошлись бы, и пароль, принятый формой, отвергался бы политикой.
   *
   * Умолчание 12 — «рекомендуемая длина» корпоративного стандарта (минимум 8).
   * Для развёртывания без MFA разумно поднять до 15 (SP 800-63B).
   */
  AUTH_LOCAL_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(256).default(12),
  AUTH_LOCAL_PASSWORD_MAX_LENGTH: z.coerce.number().int().min(64).max(256).default(128),
  /**
   * Только реализованное. Разрешать здесь алгоритм, которого нет в коде,
   * значит завести хэш, который нечем проверить: пользователь не сможет войти,
   * и причина не будет видна ни в одном журнале.
   */
  AUTH_LOCAL_HASH: z.enum(['scrypt']).default('scrypt'),
  /** N = 2^значение. 16 при r=8, p=2 — профиль OWASP при ограниченной памяти. */
  AUTH_LOCAL_SCRYPT_COST_LOG2: z.coerce.number().int().min(15).max(20).default(16),
  AUTH_LOCAL_SCRYPT_PARALLELISM: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * Сколько операций хеширования выполняется одновременно.
   *
   * Каждая занимает ~64 МБ и поток пула libuv (по умолчанию их 4). Без предела
   * всплеск входов вытесняет из пула всё остальное — чтение файлов, DNS, zlib —
   * и вход роняет производительность всего API. Переполнение очереди отвечает
   * 429, а не копит ожидание.
   */
  AUTH_LOCAL_HASH_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  /**
   * Дополнительные источники, которым разрешено слать форму входа: полные
   * origin через запятую.
   *
   * Существует ради dev-прокси Vite (браузер шлёт Origin :5173, а PUBLIC_URL
   * указывает на :3000). В production запрещён: там SPA и API за одним адресом.
   */
  AUTH_LOCAL_ALLOWED_ORIGINS: z.string().optional(),
  AUTH_LOCAL_LOGIN_MAX_PER_IP: z.coerce.number().int().positive().default(5),
  AUTH_LOCAL_LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  AUTH_LOCAL_LOGIN_MAX_PER_LOGIN_HOUR: z.coerce.number().int().positive().default(10),
  AUTH_LOCAL_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(30),
  AUTH_LOCAL_BACKOFF_MAX_SECONDS: z.coerce.number().int().positive().default(30),
  AUTH_LOCAL_REGISTER_MAX_PER_IP_HOUR: z.coerce.number().int().positive().default(3),
  /** Смена пароля: сверх требований стандарта, но перебор текущего пароля тоже перебор. */
  AUTH_LOCAL_PASSWORD_MAX_PER_HOUR: z.coerce.number().int().positive().default(5),

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
  /**
   * Пароль служебного аккаунта RD WEB (§5.1).
   *
   * M2M-аутентификации у них нет, поэтому портал ходит сессией служебной
   * учётной записи. Пароль живёт ТОЛЬКО здесь: ни в `app_settings` (§10), ни в
   * журнале его быть не должно — `nonPlaceholder` заодно не даёт доехать до
   * стенда значению из `.env.example`.
   */
  RDWEB_PASSWORD: nonPlaceholder('RDWEB_PASSWORD').optional(),
  /**
   * Проекты RD WEB, которыми владеет портал.
   *
   * Это ограничение прав служебного аккаунта, а не выбор из многих: документы
   * прогонов создаются в первом проекте списка. Без явного списка нечем
   * проверить, что аккаунт не пишет в проекты, где работают люди.
   */
  RDWEB_PROJECT_ALLOWLIST: z.string().optional(),
  /**
   * Модель OCR, которую портал заказывает у RD WEB (§10, §5.2 шаг 6).
   *
   * Обязательное поле их контракта: `JobCreateRequest.settings` —
   * `dict[BlockType, BlockTypeSelection]`, а у `BlockTypeSelection` обязательны
   * `provider_type` и `model_id`. Запуск «настройками по умолчанию» невозможен
   * — их схема отвечает 422. Значения по умолчанию у нас нет намеренно: выдумать
   * идентификатор модели чужой системы нельзя, а отсутствие настройки обязано
   * останавливать запуск с внятной причиной, а не приводить к 422 из RD WEB.
   */
  RDWEB_OCR_MODEL: z.string().min(1).optional(),
  /** Тип провайдера их стороны; сегодня в `ProviderType` есть только `lmstudio`. */
  RDWEB_OCR_PROVIDER: z.string().min(1).default('lmstudio'),
  /**
   * Профиль промта OCR на тип блока: `text=<id>,image=<id>,stamp=<id>`.
   *
   * Промты OCR не редактируются порталом — это профили RD WEB (§10), поэтому
   * здесь только ВЫБОР профиля. Пусто — остаётся authoritative-дефолт их
   * админки, и это штатное состояние, а не деградация.
   */
  RDWEB_OCR_PROMPT_PROFILES: z.string().optional(),

  /**
   * Провайдер анализа (§10).
   *
   * `rdweb` присутствует в перечислении намеренно: переключатель обязан
   * существовать в администрировании, потому что заказчик выбрал «proxy_llm и
   * RD WEB на выбор». Но generic text-analysis эндпоинта у RD WEB нет (§0.3
   * п.6), поэтому выбор проходит проверки конфигурации и упирается в отказ на
   * первом же вызове с пояснением. Отсутствие значения в перечислении выглядело
   * бы как «мы про него забыли», а тихая подмена на `proxy_llm` — как будто
   * переключатель работает.
   */
  LLM_PROVIDER: z.enum(['proxy_llm', 'rdweb', 'recorded', 'none']).default('none'),
  PROXY_LLM_BASE_URL: z.string().url().optional(),
  PROXY_LLM_TOKEN: z.string().optional(),
  LLM_MODEL_ALLOWLIST: z.string().optional(),
  /**
   * Модель по умолчанию для вызовов, где стадия её не выбирает.
   *
   * Значения по умолчанию нет по той же причине, что у `RDWEB_OCR_MODEL`:
   * выдумать идентификатор модели чужого шлюза нельзя, а отсутствие настройки
   * обязано останавливать старт с внятной причиной, а не давать 400 из прокси
   * на первом же вызове.
   */
  LLM_MODEL: z.string().min(1).optional(),
  /**
   * Месячный потолок суммы `ai_runs.cost` (§11). `0` — ограничения нет.
   *
   * Ноль по умолчанию, а не какое-нибудь «разумное» число: придуманный порог
   * либо останавливает работу на ровном месте, либо не значит ничего.
   */
  LLM_BUDGET_MONTHLY: z.coerce.number().nonnegative().default(0),
  /** Скользящее окно в процессе; `0` — без ограничения. */
  LLM_RATE_LIMIT_PER_MIN: z.coerce.number().int().nonnegative().default(60),
  /**
   * Дедлайн шлюза proxy_llm — 190 с на весь запрос; клиентский таймаут обязан
   * быть больше, иначе клиент отваливается раньше, чем шлюз отдаст свой 504,
   * и различить «шлюз не успел» и «сеть порвалась» уже нельзя.
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  /** Потолок и срок жизни кэша ответов LLM в памяти процесса (§8.2). */
  LLM_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  LLM_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),

  /**
   * Путь к бинарю pdftoppm (poppler) для серверной растеризации PDF→PNG
   * (ADR-0008). Пусто — бинарь ищется в PATH; не найден нигде — растеризация
   * недоступна, и зависящие от неё задачи честно отказывают.
   */
  PDFTOPPM_PATH: z.string().min(1).optional(),

  /**
   * Потоки ONNX Runtime для локальной детекции (ADR-0008): intra — внутри
   * одного оператора графа, inter — между операторами. Дефолты 2/1 подобраны
   * под очередь cpu (§12, параллелизм 1–2): инференс не имеет права занять все
   * ядра машины, на которой живут и API, и остальные очереди воркера.
   */
  ORT_INTRA_OP_THREADS: z.coerce.number().int().positive().default(2),
  ORT_INTER_OP_THREADS: z.coerce.number().int().positive().default(1),

  AUDIT_HMAC_KEY: nonPlaceholder('AUDIT_HMAC_KEY').optional(),

  /**
   * Срок хранения данных ревизии после решения по ней (§4.2, §13).
   *
   * Отсчитывается от `decided_at`, а не от загрузки: хранить обязаны то, по чему
   * принято решение, и срок начинается с решения. До окончания срока сборка
   * мусора не имеет права удалить ни байта, даже если на объект нет ни одной
   * ссылки.
   *
   * Значения «хранить вечно» нет намеренно: оно неотличимо от «политику не
   * настроили», а §4.2 требует именно политику. Десять лет по умолчанию — это
   * консервативная величина для строительной ИД, и она безопасна в ту сторону,
   * в которую ошибка дешевле: лишний год хранения стоит дискового места,
   * недостающий — утраченных доказательств.
   */
  RETENTION_DAYS: z.coerce.number().int().positive().default(3650),
  /**
   * Признаётся ли legal hold этой установкой (§4.2).
   *
   * По умолчанию ДА. Выключение — осознанное решение эксплуатации, и оно
   * означает ровно одно: наложенные удержания перестают удерживать. Поэтому
   * значение попадает в решение об удалении явным полем, а не подразумевается:
   * «удержания не было» и «удержание проигнорировано настройкой» — разные
   * факты, и второй обязан быть виден в отчёте.
   */
  LEGAL_HOLD_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

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
 * Хосты вендоров моделей, обращение к которым напрямую запрещено §10.
 *
 * Список именно хостов, а не подстрок: проверка вхождением поймала бы
 * законный `https://llm-gw.internal/openrouter-compat` и пропустила бы
 * `https://openrouter.ai.evil.example`.
 */
const DIRECT_VENDOR_HOSTS = ['openrouter.ai', 'api.openai.com', 'api.anthropic.com'];

function forbiddenLlmHost(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return null;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Не разобралось как URL — об этом уже сказала схема поля.
    return null;
  }
  return (
    DIRECT_VENDOR_HOSTS.find((host) => hostname === host || hostname.endsWith(`.${host}`)) ?? null
  );
}

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

  if (env.AUTH_MODE === 'local') {
    // Оба ключа обязательны во ВСЕХ окружениях, а не только в production.
    // AUTH_LOCAL_LOGIN_HMAC_KEY — не украшение журнала: по нему ключуются строки
    // auth_throttle. Без него пришлось бы либо класть логины в БД открытым
    // текстом, либо отказаться от подсчёта попыток, то есть от защиты от
    // перебора. AUDIT_HMAC_KEY по той же причине: события входа обязаны попадать
    // в журнал, а адрес в журнале хранится только как HMAC.
    if (!env.AUTH_LOCAL_LOGIN_HMAC_KEY) {
      errors.push(
        'AUTH_LOCAL_LOGIN_HMAC_KEY обязателен при AUTH_MODE=local: по нему ключуется ' +
          'троттлинг входа',
      );
    } else if (Buffer.byteLength(env.AUTH_LOCAL_LOGIN_HMAC_KEY, 'utf8') < 32) {
      errors.push('AUTH_LOCAL_LOGIN_HMAC_KEY: требуется не менее 32 байт');
    }
    if (!env.AUDIT_HMAC_KEY) {
      errors.push(
        'AUDIT_HMAC_KEY обязателен при AUTH_MODE=local: события входа пишутся в журнал, ' +
          'а адрес в нём хранится только как HMAC',
      );
    }

    if (env.AUTH_LOCAL_PASSWORD_MIN_LENGTH > env.AUTH_LOCAL_PASSWORD_MAX_LENGTH) {
      errors.push(
        'AUTH_LOCAL_PASSWORD_MIN_LENGTH больше AUTH_LOCAL_PASSWORD_MAX_LENGTH: ' +
          'политика отвергала бы любой пароль',
      );
    }

    if (isProd && env.AUTH_LOCAL_ALLOWED_ORIGINS !== undefined) {
      // Список существует ради dev-прокси. В production SPA и API живут за одним
      // PUBLIC_URL, поэтому лишний origin здесь — это разрешение слать форму
      // входа с чужой страницы, то есть отключённая защита от login CSRF.
      errors.push(
        'AUTH_LOCAL_ALLOWED_ORIGINS запрещён в production: источник формы входа — PUBLIC_URL',
      );
    }

    // Отдельной проверки TRUST_PROXY здесь нет: она уже безусловна для
    // production выше. Лимиты входа и регистрации считаются по адресу клиента и
    // потому опираются на неё же — дублировать правило значит однажды поправить
    // одну копию из двух.
  } else if (env.AUTH_LOCAL_LOGIN_HMAC_KEY !== undefined) {
    // Настройка, которая ничего не делает, хуже отсутствующей: администратор
    // считает защиту настроенной, а её нет.
    errors.push('AUTH_LOCAL_LOGIN_HMAC_KEY имеет смысл только при AUTH_MODE=local');
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

  // Интеграция RD WEB включается наличием адреса. Половина конфигурации хуже
  // её отсутствия: портал поднялся бы, кнопка «Разметить файл» ставила бы
  // задачи, и каждая падала бы на входе служебным аккаунтом.
  if (env.RDWEB_BASE_URL !== undefined) {
    for (const key of ['RDWEB_USER', 'RDWEB_PASSWORD', 'RDWEB_PROJECT_ALLOWLIST'] as const) {
      if (!env[key]) errors.push(`${key} обязателен при заданном RDWEB_BASE_URL`);
    }
  }

  if (env.LLM_PROVIDER === 'proxy_llm') {
    for (const key of ['PROXY_LLM_BASE_URL', 'PROXY_LLM_TOKEN'] as const) {
      if (!env[key]) errors.push(`${key} обязателен при LLM_PROVIDER=proxy_llm`);
    }
    if (isProd && !env.LLM_MODEL) {
      // Только в production, как и остальные обязательные значения этого
      // блока: выдумать идентификатор модели чужого шлюза нельзя, и на боевом
      // стенде отсутствие настройки обязано останавливать старт, а не давать
      // 400 из шлюза на первом же вызове. В test и development отсутствие
      // модели допустимо — там вызов либо не делается, либо модель приходит
      // с запросом; отказ при этом остаётся внятным (см. ProxyLlmProvider).
      errors.push('LLM_MODEL обязателен при LLM_PROVIDER=proxy_llm в production');
    }
  }

  if (env.LLM_PROVIDER === 'recorded' && isProd) {
    // Двойник отвечает записанными строками и не ходит наружу. В продакшне это
    // означает выдуманный результат анализа ИД, поданный как настоящий, —
    // ровно та же категория, что и AUTH_MODE=dev-stub.
    errors.push('LLM_PROVIDER=recorded запрещён при NODE_ENV=production');
  }

  const directVendorHost = forbiddenLlmHost(env.PROXY_LLM_BASE_URL);
  if (directVendorHost !== null) {
    // §10: прямые запросы в OpenRouter из портала запрещены. Проверка стоит
    // здесь, а не в клиенте: адрес читается один раз при старте, и «мы просто
    // временно переключили base url на вендора» обязано не подниматься вовсе.
    errors.push(
      `PROXY_LLM_BASE_URL указывает прямо на ${directVendorHost}: §10 разрешает только ` +
        'корпоративный шлюз proxy_llm, прямые запросы к вендору из портала запрещены',
    );
  }

  if (env.LLM_MODEL !== undefined) {
    const allowlist = allowedModels(env);
    if (allowlist.length > 0 && !allowlist.includes(env.LLM_MODEL)) {
      errors.push('LLM_MODEL не входит в LLM_MODEL_ALLOWLIST: вызов был бы отвергнут политикой');
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
