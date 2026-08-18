/**
 * Запуск проверок, прогоны и замечания (§9, §14).
 *
 * ## Почему проверка запускается действием, а не сама
 *
 * §12 ставит между задачей 19 и задачей 20 останов «документы»: границы
 * документов и их типы подтверждает человек, и правила, исполненные до
 * подтверждения, дали бы заключение по чужой разбивке. Автоматический переход
 * тут был бы тем же классом ошибки, что автопрогон между разметкой и OCR (§6.3).
 *
 * ## Идемпотентность
 *
 * `Idempotency-Key` (§14) участвует в ключе дедупликации задачи: повторное
 * нажатие «Проверить» не должно давать второй прогон над теми же данными, а
 * ОСОЗНАННЫЙ повторный запуск после правки — должен. Разделяет их сам
 * пользователь, присылая новый ключ; без заголовка ключ строится по ревизии, и
 * повтор сливается с уже стоящей задачей.
 */
import { RULE_CATALOG } from '@id/rules';
import type { AppInstance } from '../../app.js';
import { notFound } from '../../lib/problem.js';
import { currentAuth } from '../../middleware/require-auth.js';
import { requirePermission } from '../../middleware/require-permission.js';
import { tracePayload, updateContext } from '../../observability/context.js';
import { listFindings, listValidationRuns } from '../../db/repositories/checks.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { findRevisionForFiles } from '../../db/repositories/files.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import {
  findingListSchema,
  findingQuerySchema,
  revisionIdParamSchema,
  ruleCatalogListSchema,
  runChecksResponseSchema,
  validationRunListSchema,
} from './schemas.js';

const PREFIX = '/api/v1';

const runChecks = requirePermission('checks.run');
const readChecks = requirePermission('submission.read');
const readCatalog = requirePermission('rules.publish');

export function registerCheckRoutes(app: AppInstance): void {
  app.post(
    `${PREFIX}/revisions/:revisionId/checks`,
    {
      preHandler: runChecks,
      schema: {
        params: revisionIdParamSchema,
        response: { 202: runChecksResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { revisionId } = request.params;

      const revision = await findRevisionForFiles(app.db, scope, revisionId);
      if (revision === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ revisionId, objectId: revision.objectId });

      const header = request.headers['idempotency-key'];
      const key = Array.isArray(header) ? header[0] : header;

      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'checks.run',
        payload: tracePayload({ revisionId }),
        dedupeKey: dedupeKeyFor('checks.run', revisionId, key ?? 'default'),
      });

      return reply.code(202).send({ jobId, created });
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/checks`,
    {
      preHandler: readChecks,
      schema: {
        params: revisionIdParamSchema,
        response: { 200: validationRunListSchema },
      },
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const items = await listValidationRuns(app.db, scope, request.params.revisionId);
      return { items: items.map((item) => ({ ...item })) };
    },
  );

  app.get(
    `${PREFIX}/revisions/:revisionId/findings`,
    {
      preHandler: readChecks,
      schema: {
        params: revisionIdParamSchema,
        querystring: findingQuerySchema,
        response: { 200: findingListSchema },
      },
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const items = await listFindings(app.db, scope, {
        revisionId: request.params.revisionId,
        validationRunId: request.query.validationRunId,
      });
      return { items: items.map((item) => ({ ...item })) };
    },
  );

  /**
   * Каталог правил с умолчаниями.
   *
   * Нужен администратору, чтобы опубликовать первую версию набора: без него
   * severity, blocking и параметры пришлось бы набивать руками по сорока с
   * лишним кодам, и любая опечатка означала бы правило, ведущее себя не так,
   * как задумано его реализацией. Значения по умолчанию живут в каталоге кода,
   * а не в `rule_definitions`: второе место, задающее поведение правила,
   * лишило бы снимок статуса единственного источника (§3.7).
   */
  app.get(
    `${PREFIX}/admin/rule-catalog`,
    { preHandler: readCatalog, schema: { response: { 200: ruleCatalogListSchema } } },
    async () => ({
      items: RULE_CATALOG.map((spec) => ({
        code: spec.code,
        title: spec.title,
        docTypeCode: spec.docTypeCode,
        level: spec.level,
        kind: spec.kind,
        defaultSeverity: spec.defaultSeverity,
        defaultBlocking: spec.defaultBlocking,
        requiresSectionProfile: spec.requiresSectionProfile,
        requiresExternalRegistry: spec.requiresExternalRegistry,
        defaultParams: { ...spec.defaultParams },
      })),
    }),
  );
}
