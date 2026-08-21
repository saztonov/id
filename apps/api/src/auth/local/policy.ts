/**
 * Политика пароля (B.3).
 *
 * Единственное требование — минимальная длина. Проверки сложности (классы
 * символов, словарь распространённых паролей, прогулки по клавиатуре,
 * последовательности, вхождение личных данных) сняты по требованию заказчика:
 * портал не должен отказывать во входе из-за неудобной формы пароля.
 *
 * Проверка выполняется ТОЛЬКО на сервере. Фронт повторяет требование текстом
 * подсказки в `apps/web/src/features/auth/passwordHints.ts`; решение принимает
 * этот файл.
 *
 * Длина считается в code points, а не в `.length`: `'a'.length` для суррогатной
 * пары равен двум, и пароль из эмодзи проходил бы порог вдвое дешевле. Границы
 * берутся из конфигурации, и оттуда же их берут схемы тела запросов — два
 * независимых максимума однажды разошлись бы, и пароль, принятый формой,
 * отвергался бы политикой без внятного объяснения.
 */
import type { Env } from '../../config/env.js';

export interface PolicyViolation {
  readonly code: string;
  /** Текст для пользователя: попадает в 422 и показывается формой. */
  readonly message: string;
}

/** Длина в code points: суррогатная пара — один символ, а не два. */
export function passwordLength(password: string): number {
  return [...password.normalize('NFKC')].length;
}

/**
 * Нарушения политики. Пустой массив — пароль принят.
 *
 * Возвращается СПИСОК, а не первое нарушение: форма разбирает ответ 422 по
 * полям, и та же форма ответа используется вызывающим для добавления claim
 * «новый пароль совпадает с текущим».
 */
export function checkPasswordPolicy(password: string, env: Env): readonly PolicyViolation[] {
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

  return violations;
}
