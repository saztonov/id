/**
 * Сборка интеграции RD WEB из конфигурации (§5.1, §15).
 *
 * Фабрика здесь, а не в точке вызова, по той же причине, что и у хранилища:
 * адаптер, собранный на месте, остался бы без метрик, без порога
 * `SLOW_EXTERNAL_MS` и без сквозного `request_id`. Ровно так на S3 слой
 * наблюдаемости оказался мёртвым кодом.
 *
 * Пароль служебного аккаунта берётся из окружения и НИКОГДА не попадает ни в
 * `app_settings` (§10: только masked-ссылка и статус подключения), ни в журнал.
 */
import type { Logger } from 'pino';
import type { Env } from '../../config/env.js';
import type { Metrics } from '../../observability/metrics.js';
import { LegacyRdWebAdapter } from './legacy-adapter.js';
import type { RdWebPort } from './port.js';

export * from './port.js';
export { LegacyRdWebAdapter, DETECT_BATCH_LIMIT } from './legacy-adapter.js';
export { RdWebClient, RDWEB_SERVICE } from './client.js';
export type { RdWebClientOptions, RdWebCredentials } from './client.js';
export type { LegacyRdWebAdapterOptions } from './legacy-adapter.js';

export interface CreateRdWebOptions {
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Адаптер или `null`, если интеграция не настроена.
 *
 * `null`, а не исключение: портал обязан подниматься и работать со стадиями
 * приёма даже без доступа к RD WEB — иначе недоступная интеграция превращала бы
 * загрузку файлов в отказ старта. Задачи 4–9 при этом честно падают с внятным
 * сообщением, а не делают вид, что работают.
 */
export function createRdWeb(env: Env, options: CreateRdWebOptions): RdWebPort | null {
  const projectId = firstAllowedProject(env);
  if (
    env.RDWEB_BASE_URL === undefined ||
    env.RDWEB_USER === undefined ||
    env.RDWEB_PASSWORD === undefined ||
    projectId === undefined
  ) {
    return null;
  }

  return new LegacyRdWebAdapter({
    baseUrl: env.RDWEB_BASE_URL,
    user: env.RDWEB_USER,
    password: env.RDWEB_PASSWORD,
    projectId,
    metrics: options.metrics,
    logger: options.logger,
    slowExternalMs: env.SLOW_EXTERNAL_MS,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/**
 * Первый проект из allowlist.
 *
 * Allowlist — это ограничение прав служебного аккаунта (§5.1), а не выбор из
 * многих: портал создаёт документы прогонов в одном своём проекте. Список
 * существует, чтобы конфигурация была проверяемой, а не чтобы код гадал.
 */
export function firstAllowedProject(env: Env): string | undefined {
  const list = (env.RDWEB_PROJECT_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return list[0];
}
