/**
 * Подсказка к полю пароля.
 *
 * КОПИЯ серверной политики (`apps/api/src/auth/local/policy.ts`), и это
 * сознательно. Решение принимает сервер: он проверяет длину, и его отказ
 * приходит списком в ответе 422. Здесь — только текст, чтобы человек узнал
 * требование до отправки формы, а не после.
 *
 * Тот же приём и та же оговорка, что у копии матрицы прав в `app/session.tsx`:
 * расхождение копии с оригиналом ухудшает подсказку, но не открывает доступ.
 */

/** Умолчание совпадает с `AUTH_LOCAL_PASSWORD_MIN_LENGTH`. */
const FALLBACK_MIN_LENGTH = 8;

export function passwordHints(minLength: number | undefined): string {
  const min = minLength ?? FALLBACK_MIN_LENGTH;

  return `Не короче ${String(min)} символов.`;
}
