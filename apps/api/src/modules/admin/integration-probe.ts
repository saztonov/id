/**
 * Проверка связи с внешними интеграциями: `/api/v1/admin/integrations/*`.
 *
 * ## Зачем ручка
 *
 * Карточка настроек до сих пор отвечала на вопрос «настроено ли», а не «работает
 * ли»: она перечисляла недостающие переменные, а `verified` стоял литеральным
 * `false` — заданная переменная не означает живой связи. Разницу между этими
 * двумя вопросами портал узнавал единственным способом: администратор запускал
 * распознавание и получал отказ посреди работы, кодом контракта вместо действия.
 *
 * Ручка задаёт второй вопрос прямо и отвечает вердиктом: удостоверение, права,
 * список проектов, рубильник контура или адрес — чинить каждый раз надо разное.
 *
 * ## Почему POST, а не GET
 *
 * Проба ходит наружу и стоит времени, поэтому она не должна выполняться от
 * простого открытия экрана, случайного повтора кэшем или обхода ссылок. GET,
 * дёргающий чужой сервис, вдобавок оказался бы кандидатом на предзагрузку.
 *
 * ## Право
 *
 * `settings.manage`, как у ручного прогона reaper, а не `diagnostics.read`: в
 * портале проба ничего не меняет, но она дёргает внешний мир от имени
 * удостоверения развёртывания и оставляет след в чужом журнале.
 *
 * ## Что не попадает в ответ
 *
 * Удостоверение — никогда. Текст удалённой стороны доезжает до экрана как есть,
 * потому что без него отличить «сломан их обработчик» от «сломано наше тело»
 * стоило полдня (см. докблок `failureOf` в клиенте), но токен из него вычеркнут
 * ещё в клиенте — до обрезки и до попадания в объект ошибки.
 */
import { z } from 'zod';
import type { AppInstance } from '../../app.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { execSyncMissingVars } from '../../integrations/rdweb-exec/index.js';

const PREFIX = '/api/v1/admin/integrations';

const manageSettings = requirePermission('settings.manage');

const probeStepSchema = z.object({
  step: z.enum(['init', 'read']),
  outcome: z.enum([
    'ok',
    'unreachable',
    'credential',
    'scope',
    'project',
    'disabled',
    'rate_limited',
    'server',
    'unexpected',
  ]),
  status: z.int().nullable(),
  code: z.string().nullable(),
  message: z.string(),
  detail: z.string().nullable(),
});

const probeResultSchema = z.object({
  /** Настроена ли интеграция вообще: без переменных пробе не с чем идти. */
  configured: z.boolean(),
  missing: z.array(z.string()),
  ok: z.boolean(),
  steps: z.array(probeStepSchema),
});

export function registerIntegrationProbeRoutes(app: AppInstance): void {
  app.post(
    `${PREFIX}/rdweb-exec/check`,
    { preHandler: manageSettings, schema: { response: { 200: probeResultSchema } } },
    async () => {
      if (app.execSyncProbe === null) {
        // Не отказ ручки, а результат пробы: «не настроено» — такой же ответ на
        // вопрос «работает ли связь», как и «удостоверение не признано», и
        // экран показывает его тем же местом.
        return {
          configured: false,
          missing: [...execSyncMissingVars(app.env)],
          ok: false,
          steps: [],
        };
      }
      const result = await app.execSyncProbe.run();
      return { configured: true, missing: [], ok: result.ok, steps: [...result.steps] };
    },
  );
}
