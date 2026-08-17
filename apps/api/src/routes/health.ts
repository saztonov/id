/**
 * Проверки живости и готовности.
 *
 * Разделение не формальность: `/health/live` отвечает всегда и говорит только
 * «процесс жив» — если бы он проверял БД, кратковременная недоступность
 * кластера приводила бы к перезапуску контейнера, то есть к потере всех
 * соединений в момент, когда БД как раз возвращается. `/health/ready`
 * проверяет зависимости и снимает экземпляр с балансировки, не убивая его.
 *
 * Обе пробы доступны без аутентификации, поэтому обе обязаны быть дёшевы для
 * атакующего. `/health/ready` ходит в managed-кластер, и без ограничений это
 * готовый усилитель нагрузки: один запрос снаружи — один запрос к PostgreSQL.
 * Отсюда кэш результата ниже: частота запросов к кластеру перестаёт зависеть
 * от частоты запросов снаружи.
 */
import { z } from 'zod';
import { problemDetailsSchema } from '@id/contracts';
import type { AppInstance } from '../app.js';
import {
  problemBody,
  PROBLEM_JSON_CONTENT_TYPE,
  requestInstance,
  unavailable,
} from '../lib/problem.js';

const READINESS_TIMEOUT_MS = 2000;

/**
 * Срок годности результата проверки БД.
 *
 * Пробы балансировщика идут раз в 1–5 секунд, поэтому две секунды кэша не
 * задерживают ни снятие с балансировки, ни возврат в неё заметно, зато делают
 * частоту запросов к кластеру независимой от частоты запросов снаружи.
 */
const READINESS_CACHE_MS = 2000;

/**
 * Проверка готовности НЕ ограничивается по числу запросов.
 *
 * Лимит здесь опаснее того, от чего защищал. Ключ лимита — адрес клиента, а
 * при пустом `TRUST_PROXY` (значение по умолчанию, и это правильное значение)
 * за nginx все клиенты сходятся в один ключ и делят одно ведро. Тогда 121
 * запрос от постороннего исчерпывает его, и следующая проба балансировщика
 * получает 429 — то есть неаутентифицированный клиент снимает экземпляр
 * с балансировки. Проверено воспроизведением: 125 запросов дали 120 успешных
 * и 5 отказов, после чего проба получила 429.
 *
 * Исходная причина, ради которой лимит вводился, — усиление нагрузки на
 * managed-кластер запросом к БД на каждую пробу. Она закрыта кэшем
 * `READINESS_CACHE_MS`: 130 проб дают один запрос к базе. Лимит поверх кэша
 * ничего не защищает и создаёт способ вытеснить экземпляр.
 */
const READINESS_RATE_LIMIT = false;

const liveResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
});

/**
 * Длительности проверки в ответе нет.
 *
 * Время ответа БД — сведение о внутреннем устройстве и о состоянии кластера, а
 * неаутентифицированному клиенту достаточно `ok`. В журнал оно пишется.
 */
const readyResponseSchema = z.object({
  status: z.literal('ok'),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean() })),
});

interface ReadinessProbe {
  readonly ok: boolean;
  readonly durationMs: number;
  /** Отдан кэш, а не свежий результат: попадает в журнал, но не в ответ. */
  readonly cached: boolean;
}

export function registerHealthRoutes(app: AppInstance): void {
  const readiness = createReadinessChecker(app);

  app.get(
    '/health/live',
    // Без лимита намеренно: обработчик читает только uptime процесса, а 429
    // здесь означал бы, что оркестратор перезапустит исправный контейнер.
    { schema: { response: { 200: liveResponseSchema } }, config: { rateLimit: false } },
    () => ({ status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()) }),
  );

  app.get(
    '/health/ready',
    {
      // 503 объявлена схемой наравне с 200: сериализатор zod иначе проверял бы
      // ответ о недоступности схемой успешного ответа.
      schema: { response: { 200: readyResponseSchema, 503: problemDetailsSchema } },
      config: { rateLimit: READINESS_RATE_LIMIT },
    },
    async (request, reply) => {
      const probe = await readiness();

      if (!probe.ok) {
        request.log.warn(
          { check: 'database', durationMs: probe.durationMs, cached: probe.cached },
          'проверка готовности не прошла',
        );
        // Отправляется напрямую, а не через throw: обработчик ошибок пишет 5xx
        // в журнал уровнем error, и опрос балансировщика раз в секунду забил бы
        // журнал ошибками о состоянии, которое уже видно из статуса ответа.
        return reply
          .code(503)
          .type(PROBLEM_JSON_CONTENT_TYPE)
          .send(
            problemBody(unavailable('База данных недоступна.'), {
              requestId: request.id,
              instance: requestInstance(request.url),
            }),
          );
      }

      return reply.code(200).send({
        status: 'ok' as const,
        checks: [{ name: 'database', ok: true }],
      });
    },
  );
}

/**
 * Проверка готовности с кэшем и склейкой одновременных вызовов.
 *
 * Склейка так же важна, как кэш: без неё сотня одновременных запросов до
 * появления первого результата дала бы сотню запросов к кластеру, и кэш от них
 * не защитил бы — он заполняется только по завершении проверки.
 */
function createReadinessChecker(app: AppInstance): () => Promise<ReadinessProbe> {
  let cached: { readonly probe: ReadinessProbe; readonly expiresAt: number } | null = null;
  let inFlight: Promise<ReadinessProbe> | null = null;

  return async function readiness(): Promise<ReadinessProbe> {
    const now = Date.now();
    if (cached !== null && cached.expiresAt > now) return { ...cached.probe, cached: true };
    if (inFlight !== null) return inFlight;

    inFlight = (async (): Promise<ReadinessProbe> => {
      const started = process.hrtime.bigint();
      const ok = await checkDatabase(app);
      const probe: ReadinessProbe = {
        ok,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        cached: false,
      };
      cached = { probe, expiresAt: Date.now() + READINESS_CACHE_MS };
      return probe;
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  };
}

/**
 * `SELECT 1` с потолком по времени.
 *
 * Гонка с таймером нужна потому, что зависший запрос к недоступному кластеру
 * держит соединение до `connectionTimeoutMillis`, а проба готовности обязана
 * ответить быстрее, чем балансировщик решит, что не ответил весь процесс.
 */
async function checkDatabase(app: AppInstance): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  // Отказ запроса обрабатывается здесь же, а не через try/catch вокруг гонки:
  // проигравшая гонку отклонённая промис-цепочка иначе всплыла бы как
  // unhandledRejection уже после ответа.
  const query = app.pool.query('select 1').then(
    () => 'ok' as const,
    () => 'failed' as const,
  );
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, READINESS_TIMEOUT_MS);
  });

  try {
    return (await Promise.race([query, timeout])) === 'ok';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
