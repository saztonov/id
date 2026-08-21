/**
 * Каноническая форма логина и ключи троттлинга (ADR-0009).
 *
 * Единственное место, где логин приводится к сравнимому виду. Функция обязана
 * применяться ВЕЗДЕ: при записи `user_credentials.login_key`, при поиске, при
 * вычислении ключа `auth_throttle` и при вычислении HMAC адреса для журнала.
 *
 * Почему это отдельный модуль, а не `toLowerCase()` по месту. Колонка
 * `login_key` объявлена `citext`, то есть база находит строку независимо от
 * регистра. Ключ троттлинга базой не считается — он считается в коде. Если
 * канонизация разойдётся, `User@Example.ru` и `user@example.ru` найдут ОДНУ
 * учётную запись, но получат РАЗНЫЕ ключи подсчёта попыток, и блокировка после
 * десяти неудач обходится сменой регистра. Ровно поэтому канонизация здесь одна
 * на все три применения.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env.js';

/**
 * NFKC, обрезка пробелов, нижний регистр.
 *
 * NFKC, а не NFC: составные и совместимые формы Unicode дают визуально
 * неразличимые адреса (например, полноширинные латинские буквы), и без
 * приведения к совместимой форме они считались бы разными учётными записями.
 * Тот же выбор нормализации применяется к паролям (SP 800-63B §5.1.1.2).
 *
 * Внутренние пробелы НЕ удаляются: адрес с пробелом внутри некорректен, и
 * молча «чинить» его значит принимать за верный тот логин, которого у
 * пользователя нет.
 */
export function canonicalizeLogin(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/**
 * Ключ строки `auth_throttle` для логина.
 *
 * HMAC, а не сам логин, по трём причинам: попытки надо считать и по
 * НЕСУЩЕСТВУЮЩИМ адресам (иначе разница в поведении выдаёт существование
 * учётной записи); строка на каждый перебранный адрес не должна быть строкой
 * ПДн; дамп базы не должен давать списка перебираемых адресов.
 *
 * Ключ — `AUTH_LOCAL_LOGIN_HMAC_KEY`, отдельный от `AUDIT_HMAC_KEY`: ротация
 * ключа журнала не должна массово снимать блокировки входа. Обязательность
 * обоих при `AUTH_MODE=local` проверяется в `config/env.ts`.
 */
export function loginThrottleKey(env: Env, canonicalLogin: string): string {
  return hmacHex(env.AUTH_LOCAL_LOGIN_HMAC_KEY, `login:${canonicalLogin}`);
}

/**
 * Ключ строки `auth_throttle` для адреса клиента.
 *
 * Адрес тоже хэшируется: `auth_throttle` не журнал, срок жизни строки — час, и
 * хранить в ней сетевые адреса дольше, чем нужно счётчику, незачем.
 */
export function ipThrottleKey(env: Env, ip: string | null): string {
  return hmacHex(env.AUTH_LOCAL_LOGIN_HMAC_KEY, `ip:${ip ?? 'unknown'}`);
}

function hmacHex(key: string | undefined, value: string): string {
  if (key === undefined) {
    // Недостижимо при загруженной конфигурации: crossChecks() требует ключ при
    // AUTH_MODE=local. Тихий возврат постоянной строки свёл бы все ключи
    // троттлинга в один, то есть заблокировал бы вход всему порталу после
    // десяти неудач любого пользователя.
    throw new Error('AUTH_LOCAL_LOGIN_HMAC_KEY не задан: ключ троттлинга неопределим');
  }
  return createHmac('sha256', key).update(value).digest('hex');
}

/**
 * Сравнение логинов без утечки через время.
 *
 * Применяется там, где сравнивается введённый логин с уже известным, а не при
 * поиске по базе: сравнение по базе выполняет `citext`, и время его ответа
 * ничего не выдаёт.
 */
export function loginEquals(a: string, b: string): boolean {
  const left = Buffer.from(canonicalizeLogin(a), 'utf8');
  const right = Buffer.from(canonicalizeLogin(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
