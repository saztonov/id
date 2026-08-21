/**
 * Хеширование паролей: обратимость проверки, разбор строки хэша, холостая
 * проверка и ограничитель параллелизма.
 *
 * Время исполнения здесь НЕ измеряется. Соблазн проверить unified latency
 * секундомером велик, но такой тест мигает на любой загруженной машине сборки и
 * первым же попаданием в «иногда красный» перестаёт что-либо значить. Вместо
 * времени проверяется наблюдаемый факт: холостая проверка действительно
 * выполняет вывод ключа, а холостой хэш готов до первого запроса.
 */
import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../../config/env.js';
import {
  HashLimiter,
  hashPassword,
  needsRehash,
  parseHash,
  randomPassword,
  resetDummyHashForTests,
  verifyDummy,
  verifyPassword,
  warmupDummyHash,
} from './passwords.js';

/**
 * Стоимость понижена до минимально допустимой схемой (2^15).
 *
 * Боевое значение 2^16 занимает ~240 мс на операцию, и полсотни проверок в
 * файле превратились бы в полминуты прогона. Понижается именно та величина,
 * которая на корректность не влияет: параметры записываются в строку хэша и
 * читаются обратно, поэтому путь исполнения одинаков.
 */
function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PUBLIC_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://id_app:local-only-pw@localhost:5432/id',
    AUTH_MODE: 'local',
    AUTH_LOCAL_LOGIN_HMAC_KEY: 'l'.repeat(44),
    AUDIT_HMAC_KEY: 'h'.repeat(44),
    AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://storage.yandexcloud.net',
    S3_BUCKET: 'id-portal',
    S3_ACCESS_KEY: 'unit-test-access-key-id',
    S3_SECRET_KEY: 'unit-test-access-key-material',
    ...overrides,
  });
}

describe('хеширование и проверка', () => {
  it('принимает свой пароль и отвергает чужой', async () => {
    const env = testEnv();
    const { encoded } = await hashPassword(env, 'Правильный-Пароль-42');

    await expect(verifyPassword('Правильный-Пароль-42', encoded)).resolves.toBe(true);
    await expect(verifyPassword('Правильный-Пароль-43', encoded)).resolves.toBe(false);
    await expect(verifyPassword('', encoded)).resolves.toBe(false);
  });

  it('два хэша одного пароля различаются: соль случайна', async () => {
    const env = testEnv();
    const first = await hashPassword(env, 'один-и-тот-же-пароль');
    const second = await hashPassword(env, 'один-и-тот-же-пароль');

    expect(first.encoded).not.toBe(second.encoded);
    await expect(verifyPassword('один-и-тот-же-пароль', second.encoded)).resolves.toBe(true);
  });

  it('не падает на боевых параметрах: maxmem задан явно', async () => {
    // При N=2^16, r=8 расход ~64 МБ, а умолчание crypto.scrypt — 32 МБ.
    // Без явного maxmem вызов вернул бы ERR_CRYPTO_INVALID_SCRYPT_PARAM,
    // то есть вход не работал бы вовсе именно с боевой конфигурацией.
    const env = testEnv({ AUTH_LOCAL_SCRYPT_COST_LOG2: '16', AUTH_LOCAL_SCRYPT_PARALLELISM: '2' });
    const { encoded } = await hashPassword(env, 'боевые-параметры');

    expect(encoded).toContain('N=65536,r=8,p=2');
    await expect(verifyPassword('боевые-параметры', encoded)).resolves.toBe(true);
  });

  it('нормализует Unicode: один пароль в разных формах совпадает сам с собой', async () => {
    const env = testEnv();
    // U+00E9 против «e» + U+0301: визуально одно и то же, байты разные.
    const composed = 'café-пароль-длинный';
    const decomposed = 'café-пароль-длинный';
    expect(composed).not.toBe(decomposed);

    const { encoded } = await hashPassword(env, composed);
    await expect(verifyPassword(decomposed, encoded)).resolves.toBe(true);
  });

  it('пароль максимальной длины не усекается', async () => {
    const env = testEnv();
    const long = 'A1b!'.repeat(32); // 128 символов
    const { encoded } = await hashPassword(env, long);

    await expect(verifyPassword(long, encoded)).resolves.toBe(true);
    // Усечение проявилось бы именно так: обрезанный пароль подошёл бы к хэшу.
    await expect(verifyPassword(long.slice(0, 72), encoded)).resolves.toBe(false);
  });
});

describe('разбор строки хэша', () => {
  it('строка самодостаточна: параметры читаются обратно', async () => {
    const env = testEnv({ AUTH_LOCAL_SCRYPT_COST_LOG2: '15', AUTH_LOCAL_SCRYPT_PARALLELISM: '3' });
    const { encoded } = await hashPassword(env, 'проверка-параметров');
    const parsed = parseHash(encoded);

    expect(parsed?.params).toEqual({ cost: 32_768, blockSize: 8, parallelism: 3 });
    expect(parsed?.key.byteLength).toBe(32);
    expect(parsed?.salt.byteLength).toBe(16);
  });

  it('мусор и чужие алгоритмы отвергаются без исключения', () => {
    for (const bad of [
      '',
      'мусор',
      'scrypt$N=65536,r=8,p=2$salt', // не хватает части
      'bcrypt$N=65536,r=8,p=2$c2FsdA$a2V5', // чужой алгоритм
      'scrypt$N=abc,r=8,p=2$c2FsdA$a2V5', // нечисловой параметр
      'scrypt$N=65535,r=8,p=2$c2FsdA$a2V5', // N не степень двойки
      'scrypt$N=1024,r=8,p=2$c2FsdA$a2V5', // N ниже допустимого
    ]) {
      expect(parseHash(bad), bad).toBeNull();
    }
  });

  it('непонятный хэш означает отказ во входе, а не пятисотку', async () => {
    await expect(verifyPassword('любой', 'испорченная-строка')).resolves.toBe(false);
  });

  it('подставленная в БД дешёвая стоимость не принимается', async () => {
    // Дамп с N=2 сделал бы проверку мгновенной и обесценил бы хеширование.
    expect(parseHash('scrypt$N=2,r=8,p=1$c2FsdHNhbHQ$a2V5')).toBeNull();
  });
});

describe('перехэширование', () => {
  it('видит устаревшую стоимость и не трогает актуальную', async () => {
    const weak = await hashPassword(testEnv({ AUTH_LOCAL_SCRYPT_COST_LOG2: '15' }), 'пароль');
    const strong = await hashPassword(testEnv({ AUTH_LOCAL_SCRYPT_COST_LOG2: '16' }), 'пароль');
    const target = testEnv({ AUTH_LOCAL_SCRYPT_COST_LOG2: '16' });

    expect(needsRehash(target, weak.encoded)).toBe(true);
    expect(needsRehash(target, strong.encoded)).toBe(false);
  });

  it('нечитаемый хэш требует перехэширования', () => {
    expect(needsRehash(testEnv(), 'мусор')).toBe(true);
  });
});

describe('холостая проверка', () => {
  it('выполняет настоящий вывод ключа', async () => {
    const env = testEnv();
    resetDummyHashForTests();
    await warmupDummyHash(env);

    // Наблюдаемый признак работы вместо секундомера: холостая проверка занимает
    // место в ограничителе, то есть действительно уходит в scrypt.
    const limiter = new HashLimiter(1);
    const release = await limiter.acquire();
    expect(release).not.toBeNull();

    await expect(verifyDummy(env, 'любой-пароль')).resolves.toBe(false);
    release?.();
  });

  it('готовится заранее: первый неизвестный логин не дороже последующих', async () => {
    const env = testEnv();
    resetDummyHashForTests();

    // Пока хэш не подготовлен, verifyDummy обязана его посчитать сама — иначе
    // ПЕРВЫЙ неизвестный логин отвечал бы заметно дольше остальных, что и есть
    // оракул существования учётной записи.
    await warmupDummyHash(env);
    const before = process.hrtime.bigint();
    await verifyDummy(env, 'первый');
    const first = process.hrtime.bigint() - before;

    const between = process.hrtime.bigint();
    await verifyDummy(env, 'второй');
    const second = process.hrtime.bigint() - between;

    // Сравниваются два ПОДГОТОВЛЕННЫХ вызова между собой, а не с порогом:
    // абсолютное время зависит от машины, а вот кратная разница означала бы,
    // что первый вызов посчитал ещё и сам холостой хэш.
    expect(Number(first)).toBeLessThan(Number(second) * 8);
  });
});

describe('ограничитель параллелизма', () => {
  it('пропускает столько, сколько мест, и ставит остальных в очередь', async () => {
    const limiter = new HashLimiter(2);
    const first = await limiter.acquire();
    const second = await limiter.acquire();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    let thirdEntered = false;
    const third = limiter.acquire().then((release) => {
      thirdEntered = true;
      return release;
    });

    await Promise.resolve();
    expect(thirdEntered, 'третий вошёл, не дождавшись места').toBe(false);

    first?.();
    const release = await third;
    expect(thirdEntered).toBe(true);
    release?.();
    second?.();
  });

  it('отказывает при переполненной очереди, а не копит ожидание', async () => {
    const limiter = new HashLimiter(1);
    const held = await limiter.acquire();

    // Ёмкость очереди — вчетверо от числа мест.
    const queued = [limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()];
    await Promise.resolve();

    // Пятый ждущий обязан получить отказ: он превратится в 429, а не в запрос,
    // висящий до таймаута.
    await expect(limiter.acquire()).resolves.toBeNull();

    held?.();
    for (const pending of queued) (await pending)?.();
  });

  it('повторный release не выдаёт лишних мест', async () => {
    const limiter = new HashLimiter(1);
    const release = await limiter.acquire();

    release?.();
    release?.();

    // Если бы двойной release уменьшил счётчик дважды, здесь появилось бы
    // второе место, и предел перестал бы существовать.
    const next = await limiter.acquire();
    expect(next).not.toBeNull();
    let extraEntered = false;
    void limiter.acquire().then(() => (extraEntered = true));
    await Promise.resolve();
    expect(extraEntered).toBe(false);
    next?.();
  });
});

describe('генерация пароля', () => {
  it('нужной длины, без визуально неоднозначных символов', () => {
    const password = randomPassword();

    expect(password).toHaveLength(24);
    expect(password).not.toMatch(/[0O1lI]/);
    expect(password).toMatch(/^[A-Za-z2-9]+$/);
  });

  it('не повторяется', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomPassword()));

    expect(seen.size).toBe(50);
  });

  it('проходит собственную проверку', async () => {
    const env = testEnv();
    const password = randomPassword();
    const { encoded } = await hashPassword(env, password);

    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
  });
});
