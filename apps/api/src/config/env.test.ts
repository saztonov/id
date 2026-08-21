/**
 * Проверки конфигурации при старте (§15 плана, fail-fast).
 *
 * Тесты работают с явным объектом-окружением, а не с `process.env`: вызов
 * `loadEnv()` без аргумента прочитал бы окружение самого прогона, и результат
 * зависел бы от машины разработчика.
 *
 * Отдельная и главная проверка — полнота списка проблем. Стартовые проверки
 * ценны ровно настолько, насколько за один запуск видно всё, что мешает
 * запуску: конфигурация боевого стенда содержит десяток переменных, и режим
 * «одна ошибка за перезапуск» превращает развёртывание в перебор.
 */
import { describe, expect, it } from 'vitest';

import { EnvError, allowedModels, loadEnv } from './env.js';

/** Ровно 32 байта — размер ключа AES-256, которого требует §4.1. */
const SESSION_KEY_32_BYTES = Buffer.alloc(32, 0x2a).toString('base64');

function devEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://id_app:local-only-pw@localhost:5432/id',
    AUTH_MODE: 'dev-stub',
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://storage.yandexcloud.net',
    S3_BUCKET: 'id-portal',
    S3_ACCESS_KEY: 'unit-test-access-key-id',
    S3_SECRET_KEY: 'unit-test-access-key-material',
    ...overrides,
  };
}

function prodEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return devEnv({
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://id.example.com',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://kc.example.com/realms/id',
    OIDC_CLIENT_ID: 'id-portal',
    OIDC_CLIENT_SECRET: 'oidc-confidential-credential-0001',
    SESSION_ENC_KEY: SESSION_KEY_32_BYTES,
    CSRF_SECRET: 'c'.repeat(32),
    AUDIT_HMAC_KEY: 'h'.repeat(44),
    PG_CA_CERT_PATH: '/etc/ssl/certs/managed-pg-root.crt',
    // Без списка доверенных прокси адрес клиента за nginx неизвестен: лимит
    // запросов становится общим для всех, а auth_sessions.ip — адресом прокси.
    TRUST_PROXY: '127.0.0.1',
    ...overrides,
  });
}

/** Список проблем отвергнутой конфигурации; успешная загрузка — сама провал. */
function problemsOf(source: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  throw new Error('loadEnv() принял конфигурацию, которую обязан был отвергнуть');
}

function problemAbout(problems: readonly string[], name: string): string | undefined {
  return problems.find((problem) => problem.includes(name));
}

describe('запрещённое в production', () => {
  it('не поднимается с AUTH_MODE=dev-stub', () => {
    const problems = problemsOf(prodEnv({ AUTH_MODE: 'dev-stub' }));

    expect(problemAbout(problems, 'AUTH_MODE')).toBe(
      'AUTH_MODE=dev-stub запрещён при NODE_ENV=production',
    );
  });

  it('вне production та же заглушка допустима', () => {
    expect(loadEnv(devEnv({ AUTH_MODE: 'dev-stub' })).AUTH_MODE).toBe('dev-stub');
  });

  it('требует SESSION_ENC_KEY, CSRF_SECRET, AUDIT_HMAC_KEY и PG_CA_CERT_PATH', () => {
    const problems = problemsOf(
      prodEnv({
        SESSION_ENC_KEY: undefined,
        CSRF_SECRET: undefined,
        AUDIT_HMAC_KEY: undefined,
        PG_CA_CERT_PATH: undefined,
      }),
    );

    for (const name of [
      'SESSION_ENC_KEY',
      'CSRF_SECRET',
      'AUDIT_HMAC_KEY',
      'PG_CA_CERT_PATH',
    ] as const) {
      expect(problemAbout(problems, name), `${name} не упомянут ни в одной проблеме`).toBeDefined();
    }
  });

  it('запрещает STORAGE_DRIVER=local', () => {
    // Постоянное хранение пользовательских файлов на VPS стандарт запрещает,
    // поэтому проверка обязана срабатывать даже при заданном каталоге.
    const problems = problemsOf(
      prodEnv({ STORAGE_DRIVER: 'local', LOCAL_STORAGE_DIR: '/var/lib/id' }),
    );

    expect(problems).toContain('STORAGE_DRIVER=local запрещён в production');
  });

  it('требует TRUST_PROXY в production', () => {
    const problems = problemsOf(prodEnv({ TRUST_PROXY: '' }));

    expect(problemAbout(problems, 'TRUST_PROXY')).toContain('обязателен в production');
  });

  it('требует https в PUBLIC_URL', () => {
    const problems = problemsOf(prodEnv({ PUBLIC_URL: 'http://id.example.com' }));

    expect(problemAbout(problems, 'PUBLIC_URL')).toContain('https');
  });

  it('принимает полностью заданную боевую конфигурацию', () => {
    const env = loadEnv(prodEnv());

    expect(env.NODE_ENV).toBe('production');
    expect(env.AUTH_MODE).toBe('oidc');
    expect(env.STORAGE_DRIVER).toBe('s3');
  });
});

describe('связанные переменные', () => {
  it('отвергает SESSION_ENC_KEY не в 32 байта', () => {
    const short = problemsOf(devEnv({ SESSION_ENC_KEY: Buffer.alloc(16).toString('base64') }));
    const long = problemsOf(devEnv({ SESSION_ENC_KEY: Buffer.alloc(64).toString('base64') }));

    expect(problemAbout(short, 'SESSION_ENC_KEY')).toContain('получено 16');
    expect(problemAbout(long, 'SESSION_ENC_KEY')).toContain('получено 64');
  });

  it('принимает SESSION_ENC_KEY ровно в 32 байта', () => {
    expect(loadEnv(devEnv({ SESSION_ENC_KEY: SESSION_KEY_32_BYTES })).SESSION_ENC_KEY).toBe(
      SESSION_KEY_32_BYTES,
    );
  });

  it('отвергает AUTH_MODE=oidc без OIDC_CLIENT_SECRET', () => {
    const problems = problemsOf(
      devEnv({
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://kc.example.com/realms/id',
        OIDC_CLIENT_ID: 'id-portal',
        OIDC_CLIENT_SECRET: undefined,
      }),
    );

    expect(problems).toContain('OIDC_CLIENT_SECRET обязателен при AUTH_MODE=oidc');
  });

  it('отвергает idle-срок больше absolute', () => {
    const problems = problemsOf(
      devEnv({ SESSION_IDLE_MINUTES: '600', SESSION_ABSOLUTE_HOURS: '2' }),
    );

    expect(problems).toContain('SESSION_IDLE_MINUTES не может быть больше SESSION_ABSOLUTE_HOURS');
  });

  it('принимает idle-срок меньше absolute', () => {
    const env = loadEnv(devEnv({ SESSION_IDLE_MINUTES: '30', SESSION_ABSOLUTE_HOURS: '8' }));

    expect([env.SESSION_IDLE_MINUTES, env.SESSION_ABSOLUTE_HOURS]).toStrictEqual([30, 8]);
  });
});

describe('значения-заглушки', () => {
  it('отвергает DATABASE_URL, оставленный заглушкой', () => {
    for (const value of ['changeme', 'CHANGEME', 'secret', 'password', 'todo']) {
      expect(problemAbout(problemsOf(devEnv({ DATABASE_URL: value })), 'DATABASE_URL')).toContain(
        'заглушка',
      );
    }
  });

  it('отвергает DATABASE_URL с заглушкой внутри строки подключения', () => {
    // Скопированный .env.example выглядит именно так: заглушка стоит на месте
    // пароля, а не вместо всего значения. Сравнение значения целиком такую
    // строку пропускает, то есть проверка не решает задачу, ради которой введена.
    const problems = problemsOf(
      devEnv({ DATABASE_URL: 'postgresql://id_app:changeme@db.internal:6432/id' }),
    );

    expect(problemAbout(problems, 'DATABASE_URL')).toContain('заглушка');
  });

  it('отвергает AUDIT_HMAC_KEY, оставленный заглушкой', () => {
    expect(
      problemAbout(problemsOf(devEnv({ AUDIT_HMAC_KEY: 'secret' })), 'AUDIT_HMAC_KEY'),
    ).toBeDefined();
  });

  it('не считает заглушкой настоящую строку подключения', () => {
    expect(loadEnv(devEnv()).DATABASE_URL).toContain('postgresql://');
  });
});

describe('полнота отчёта о проблемах', () => {
  it('перечисляет все нарушения кросс-проверок за один запуск, а не первое', () => {
    const problems = problemsOf(
      prodEnv({
        AUTH_MODE: 'dev-stub',
        PUBLIC_URL: 'http://id.example.com',
        STORAGE_DRIVER: 'local',
        LOCAL_STORAGE_DIR: undefined,
        SESSION_ENC_KEY: undefined,
        CSRF_SECRET: undefined,
        AUDIT_HMAC_KEY: undefined,
        PG_CA_CERT_PATH: undefined,
      }),
    );

    const expected = [
      'AUTH_MODE',
      'SESSION_ENC_KEY',
      'CSRF_SECRET',
      'AUDIT_HMAC_KEY',
      'STORAGE_DRIVER',
      'PG_CA_CERT_PATH',
      'PUBLIC_URL',
      'LOCAL_STORAGE_DIR',
    ] as const;

    const missing = expected.filter((name) => problemAbout(problems, name) === undefined);

    expect(missing, `сообщено ${problems.length} проблем: ${problems.join(' | ')}`).toStrictEqual(
      [],
    );
  });

  it('перечисляет все нарушения схемы полей за один запуск', () => {
    const problems = problemsOf(
      devEnv({ PORT: 'восемь', LOG_LEVEL: 'chatty', PREVIEW_MODE: 'magic', ERROR_REPORTER: 'fax' }),
    );

    for (const name of ['PORT', 'LOG_LEVEL', 'PREVIEW_MODE', 'ERROR_REPORTER'] as const) {
      expect(problemAbout(problems, name), `${name} не упомянут ни в одной проблеме`).toBeDefined();
    }
  });

  it('повторяет весь список в тексте самой ошибки', () => {
    // Сообщение читает человек в логе упавшего контейнера: то, чего в нём нет,
    // не существует, даже если поле problems заполнено.
    let caught: EnvError | undefined;
    try {
      loadEnv(prodEnv({ SESSION_ENC_KEY: undefined, CSRF_SECRET: undefined }));
    } catch (error) {
      caught = error instanceof EnvError ? error : undefined;
    }

    expect(caught?.problems.length).toBeGreaterThan(1);
    for (const problem of caught?.problems ?? []) {
      expect(caught?.message).toContain(problem);
    }
  });
});

describe('значения по умолчанию', () => {
  it('подставляет пороги и лимиты §11 и §15', () => {
    const env = loadEnv(devEnv());

    expect({
      PORT: env.PORT,
      PG_POOL_MAX: env.PG_POOL_MAX,
      LOG_LEVEL: env.LOG_LEVEL,
      SLOW_REQUEST_MS: env.SLOW_REQUEST_MS,
      SLOW_QUERY_MS: env.SLOW_QUERY_MS,
      SLOW_EXTERNAL_MS: env.SLOW_EXTERNAL_MS,
      ERROR_REPORTER: env.ERROR_REPORTER,
      METRICS_ENABLED: env.METRICS_ENABLED,
      PREVIEW_MODE: env.PREVIEW_MODE,
      MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES,
      MAX_PAGES_PER_FILE: env.MAX_PAGES_PER_FILE,
      S3_REGION: env.S3_REGION,
      SESSION_IDLE_MINUTES: env.SESSION_IDLE_MINUTES,
      SESSION_ABSOLUTE_HOURS: env.SESSION_ABSOLUTE_HOURS,
      SESSION_ENC_KEY_VERSION: env.SESSION_ENC_KEY_VERSION,
      RATE_LIMIT_MAX: env.RATE_LIMIT_MAX,
      RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
      LLM_PROVIDER: env.LLM_PROVIDER,
    }).toStrictEqual({
      PORT: 3000,
      PG_POOL_MAX: 10,
      LOG_LEVEL: 'info',
      SLOW_REQUEST_MS: 1000,
      SLOW_QUERY_MS: 300,
      SLOW_EXTERNAL_MS: 5000,
      ERROR_REPORTER: 'db',
      METRICS_ENABLED: true,
      PREVIEW_MODE: 'pdfjs',
      MAX_UPLOAD_BYTES: 209_715_200,
      MAX_PAGES_PER_FILE: 500,
      S3_REGION: 'ru-central-1',
      SESSION_IDLE_MINUTES: 60,
      SESSION_ABSOLUTE_HOURS: 12,
      SESSION_ENC_KEY_VERSION: 1,
      RATE_LIMIT_MAX: 300,
      RATE_LIMIT_WINDOW_MS: 60_000,
      LLM_PROVIDER: 'none',
    });
  });

  it('различает METRICS_ENABLED=false от остальных значений', () => {
    // Флаг приходит строкой, а превращается в boolean: от него зависит, будет
    // ли вообще зарегистрирован маршрут /metrics.
    expect(loadEnv(devEnv({ METRICS_ENABLED: 'false' })).METRICS_ENABLED).toBe(false);
    expect(loadEnv(devEnv({ METRICS_ENABLED: 'true' })).METRICS_ENABLED).toBe(true);
  });

  it('разбирает LLM_MODEL_ALLOWLIST в список без пустых элементов', () => {
    expect(
      allowedModels(loadEnv(devEnv({ LLM_MODEL_ALLOWLIST: ' a-model , b-model ,, ' }))),
    ).toStrictEqual(['a-model', 'b-model']);
    expect(allowedModels(loadEnv(devEnv()))).toStrictEqual([]);
  });

  it('даёт значения по умолчанию для бюджета, частоты, таймаута и кэша LLM', () => {
    const env = loadEnv(devEnv());

    expect({
      LLM_BUDGET_MONTHLY: env.LLM_BUDGET_MONTHLY,
      LLM_RATE_LIMIT_PER_MIN: env.LLM_RATE_LIMIT_PER_MIN,
      LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS,
      LLM_CACHE_MAX_ENTRIES: env.LLM_CACHE_MAX_ENTRIES,
      LLM_CACHE_TTL_MS: env.LLM_CACHE_TTL_MS,
    }).toStrictEqual({
      // Ноль — «ограничения нет»: придуманный порог либо останавливает работу
      // на ровном месте, либо не значит ничего.
      LLM_BUDGET_MONTHLY: 0,
      LLM_RATE_LIMIT_PER_MIN: 60,
      // Больше дедлайна шлюза proxy_llm (190 с): клиент обязан дождаться его
      // 504, а не отвалиться первым (ADR-0007).
      LLM_TIMEOUT_MS: 240_000,
      LLM_CACHE_MAX_ENTRIES: 500,
      LLM_CACHE_TTL_MS: 3_600_000,
    });
  });
});

// =====================================================================
// LLM: провайдеры, запрет прямого доступа к вендорам (§10, §0.3 п.6)
// =====================================================================

describe('провайдер LLM', () => {
  const proxy = {
    LLM_PROVIDER: 'proxy_llm',
    PROXY_LLM_BASE_URL: 'https://llm-gw.internal/v1',
    PROXY_LLM_TOKEN: 'unit-test-gateway-token',
    LLM_MODEL: 'gw/model-a',
  };

  it('переключатель rdweb существует: он заблокирован в коде, а не в схеме', () => {
    // §0.3 п.6: заказчик выбрал «proxy_llm и RD WEB на выбор». Отсутствие
    // значения в перечислении выглядело бы как «мы про него забыли», а отказ на
    // вызове несёт пояснение и ссылку на пункт техзадания S13.
    expect(loadEnv(devEnv({ LLM_PROVIDER: 'rdweb' })).LLM_PROVIDER).toBe('rdweb');
  });

  it('recorded запрещён в production', () => {
    const problems = problemsOf(prodEnv({ LLM_PROVIDER: 'recorded' }));

    expect(problemAbout(problems, 'LLM_PROVIDER=recorded')).toBe(
      'LLM_PROVIDER=recorded запрещён при NODE_ENV=production',
    );
  });

  it('вне production двойник допустим', () => {
    expect(loadEnv(devEnv({ LLM_PROVIDER: 'recorded' })).LLM_PROVIDER).toBe('recorded');
  });

  it('proxy_llm требует адрес и токен', () => {
    const problems = problemsOf(devEnv({ LLM_PROVIDER: 'proxy_llm' }));

    expect(problems).toContain('PROXY_LLM_BASE_URL обязателен при LLM_PROVIDER=proxy_llm');
    expect(problems).toContain('PROXY_LLM_TOKEN обязателен при LLM_PROVIDER=proxy_llm');
  });

  it('в production proxy_llm требует ещё и модель', () => {
    // Выдумать идентификатор модели чужого шлюза нельзя — как и у
    // RDWEB_OCR_MODEL. Вне production отсутствие допустимо: там вызов либо не
    // делается, либо модель приходит с запросом.
    const problems = problemsOf(
      prodEnv({
        LLM_PROVIDER: 'proxy_llm',
        PROXY_LLM_BASE_URL: 'https://llm-gw.internal/v1',
        PROXY_LLM_TOKEN: 'prod-gateway-token-0001',
      }),
    );

    expect(problems).toContain('LLM_MODEL обязателен при LLM_PROVIDER=proxy_llm в production');
    expect(loadEnv(devEnv({ ...proxy, LLM_MODEL: undefined })).LLM_MODEL).toBeUndefined();
  });

  it('полная конфигурация proxy_llm принимается', () => {
    expect(loadEnv(devEnv(proxy)).PROXY_LLM_BASE_URL).toBe('https://llm-gw.internal/v1');
  });

  it('прямой адрес вендора отвергается (§10)', () => {
    for (const host of ['openrouter.ai', 'api.openai.com', 'api.anthropic.com']) {
      const problems = problemsOf(devEnv({ ...proxy, PROXY_LLM_BASE_URL: `https://${host}/v1` }));
      expect(problemAbout(problems, 'PROXY_LLM_BASE_URL')).toContain(host);
    }
    // Поддомен вендора — тот же прямой запрос.
    expect(
      problemAbout(
        problemsOf(devEnv({ ...proxy, PROXY_LLM_BASE_URL: 'https://api.openrouter.ai/v1' })),
        'PROXY_LLM_BASE_URL',
      ),
    ).toContain('openrouter.ai');
  });

  it('корпоративный шлюз с похожим путём не путается с вендором', () => {
    // Проверка вхождением подстроки поймала бы этот законный адрес, а
    // `https://openrouter.ai.evil.example` пропустила бы.
    expect(
      loadEnv(devEnv({ ...proxy, PROXY_LLM_BASE_URL: 'https://gw.internal/openrouter-compat' }))
        .PROXY_LLM_BASE_URL,
    ).toBe('https://gw.internal/openrouter-compat');
  });

  it('модель по умолчанию обязана входить в allowlist', () => {
    const problems = problemsOf(devEnv({ ...proxy, LLM_MODEL_ALLOWLIST: 'gw/model-b,gw/model-c' }));

    expect(problemAbout(problems, 'LLM_MODEL')).toContain('LLM_MODEL_ALLOWLIST');
    // Согласованная пара проходит.
    expect(
      loadEnv(devEnv({ ...proxy, LLM_MODEL_ALLOWLIST: 'gw/model-a,gw/model-b' })).LLM_MODEL,
    ).toBe('gw/model-a');
  });
});

describe('AUTH_MODE=local', () => {
  /** Минимально работоспособная локальная конфигурация. */
  const local = {
    AUTH_MODE: 'local',
    AUTH_LOCAL_LOGIN_HMAC_KEY: 'l'.repeat(44),
    AUDIT_HMAC_KEY: 'h'.repeat(44),
  } as const;

  it('допустим в production, в отличие от заглушки', () => {
    // Ради этого режим и существует: развёртывание без Keycloak обязано
    // подниматься в бою, а не только на машине разработчика.
    expect(loadEnv(prodEnv({ ...local, OIDC_ISSUER: undefined })).AUTH_MODE).toBe('local');
  });

  it('не требует OIDC_*: провайдера идентичности в этом режиме нет', () => {
    const env = loadEnv(
      prodEnv({
        ...local,
        OIDC_ISSUER: undefined,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: undefined,
      }),
    );

    expect(env.OIDC_ISSUER).toBeUndefined();
  });

  it('требует ключ HMAC троттлинга во всех окружениях, не только в production', () => {
    // Ключ нужен не журналу, а подсчёту попыток: без него защиты от перебора
    // нет вовсе, и это одинаково верно на стенде и в бою.
    const problems = problemsOf(devEnv({ ...local, AUTH_LOCAL_LOGIN_HMAC_KEY: undefined }));

    expect(problemAbout(problems, 'AUTH_LOCAL_LOGIN_HMAC_KEY')).toContain('троттлинг');
  });

  it('требует AUDIT_HMAC_KEY во всех окружениях', () => {
    const problems = problemsOf(devEnv({ ...local, AUDIT_HMAC_KEY: undefined }));

    expect(problemAbout(problems, 'AUDIT_HMAC_KEY')).toContain('AUTH_MODE=local');
  });

  it('отвергает короткий ключ HMAC', () => {
    const problems = problemsOf(devEnv({ ...local, AUTH_LOCAL_LOGIN_HMAC_KEY: 'short' }));

    expect(problemAbout(problems, 'AUTH_LOCAL_LOGIN_HMAC_KEY')).toContain('32');
  });

  it('отвергает ключ HMAC, оставленный заглушкой из .env.example', () => {
    const problems = problemsOf(devEnv({ ...local, AUTH_LOCAL_LOGIN_HMAC_KEY: 'changeme' }));

    expect(problemAbout(problems, 'AUTH_LOCAL_LOGIN_HMAC_KEY')).toBeDefined();
  });

  it('отвергает минимум длины пароля больше максимума', () => {
    const problems = problemsOf(
      devEnv({
        ...local,
        AUTH_LOCAL_PASSWORD_MIN_LENGTH: '200',
        AUTH_LOCAL_PASSWORD_MAX_LENGTH: '128',
      }),
    );

    expect(problemAbout(problems, 'AUTH_LOCAL_PASSWORD_MIN_LENGTH')).toContain('отвергала бы');
  });

  it('запрещает список разрешённых источников в production', () => {
    // Список существует ради dev-прокси; в бою лишний origin — это разрешение
    // слать форму входа с чужой страницы.
    const problems = problemsOf(
      prodEnv({ ...local, AUTH_LOCAL_ALLOWED_ORIGINS: 'https://evil.example' }),
    );

    expect(problemAbout(problems, 'AUTH_LOCAL_ALLOWED_ORIGINS')).toContain('production');
    // Вне production он законен.
    expect(
      loadEnv(devEnv({ ...local, AUTH_LOCAL_ALLOWED_ORIGINS: 'http://localhost:5173' }))
        .AUTH_LOCAL_ALLOWED_ORIGINS,
    ).toBe('http://localhost:5173');
  });

  it('опирается на безусловное требование TRUST_PROXY в production', () => {
    // Лимиты входа и регистрации считаются по адресу клиента. Отдельного
    // правила для local нет намеренно: требование уже безусловно для
    // production, и вторая его копия однажды разошлась бы с первой.
    const problems = problemsOf(prodEnv({ ...local, TRUST_PROXY: '' }));

    expect(problemAbout(problems, 'TRUST_PROXY')).toContain('production');
  });

  it('отвергает ключ локального входа в чужом режиме', () => {
    // Переменная, которая ничего не делает, хуже отсутствующей: администратор
    // считает защиту настроенной, а маршрутов, которые её читают, в приложении нет.
    const problems = problemsOf(
      devEnv({ AUTH_MODE: 'dev-stub', AUTH_LOCAL_LOGIN_HMAC_KEY: 'l'.repeat(44) }),
    );

    expect(problemAbout(problems, 'AUTH_LOCAL_LOGIN_HMAC_KEY')).toContain(
      'только при AUTH_MODE=local',
    );
  });

  it('разрешает только реализованный алгоритм хеширования', () => {
    // argon2id в конфигурации без реализации завёл бы хэш, который нечем
    // проверить: пользователь не смог бы войти без видимой причины.
    const problems = problemsOf(devEnv({ ...local, AUTH_LOCAL_HASH: 'argon2id' }));

    expect(problemAbout(problems, 'AUTH_LOCAL_HASH')).toBeDefined();
  });

  it('умолчания соответствуют профилю OWASP и стандарту', () => {
    const env = loadEnv(devEnv(local));

    expect(env.AUTH_LOCAL_SCRYPT_COST_LOG2).toBe(16);
    expect(env.AUTH_LOCAL_SCRYPT_PARALLELISM).toBe(2);
    expect(env.AUTH_LOCAL_PASSWORD_MIN_LENGTH).toBe(8);
    expect(env.AUTH_LOCAL_LOCKOUT_MINUTES).toBe(30);
    expect(env.AUTH_LOCAL_BACKOFF_MAX_SECONDS).toBe(30);
    expect(env.AUTH_LOCAL_REGISTRATION_ENABLED).toBe(true);
  });

  it('регистрация выключается строкой false, а не любым значением', () => {
    expect(
      loadEnv(devEnv({ ...local, AUTH_LOCAL_REGISTRATION_ENABLED: 'false' }))
        .AUTH_LOCAL_REGISTRATION_ENABLED,
    ).toBe(false);
    expect(
      loadEnv(devEnv({ ...local, AUTH_LOCAL_REGISTRATION_ENABLED: '0' }))
        .AUTH_LOCAL_REGISTRATION_ENABLED,
    ).toBe(true);
  });
});
