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
import {
  countFindings,
  listFindingsView,
  listValidationRuns,
  loadChecksCoverage,
} from '../../db/repositories/checks.js';
import { buildCheckReport } from '../../db/repositories/check-report.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { findFolderForFiles } from '../../db/repositories/files.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import {
  checkReportSchema,
  findingListSchema,
  findingQuerySchema,
  folderIdParamSchema,
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
    `${PREFIX}/folders/:folderId/checks`,
    {
      preHandler: runChecks,
      schema: {
        params: folderIdParamSchema,
        response: { 202: runChecksResponseSchema },
      },
    },
    async (request, reply) => {
      const { scope } = currentAuth(request);
      const { folderId } = request.params;

      const folder = await findFolderForFiles(app.db, scope, folderId);
      if (folder === null) throw notFound('Ревизия поставки не найдена.');
      updateContext({ folderId, objectId: folder.objectId });

      const header = request.headers['idempotency-key'];
      const key = Array.isArray(header) ? header[0] : header;

      const { jobId, created } = await enqueueJob(app.db, scope, {
        type: 'checks.run',
        payload: tracePayload({ folderId }),
        dedupeKey: dedupeKeyFor('checks.run', folderId, key ?? 'default'),
      });

      return reply.code(202).send({ jobId, created });
    },
  );

  app.get(
    `${PREFIX}/folders/:folderId/checks`,
    {
      preHandler: readChecks,
      schema: {
        params: folderIdParamSchema,
        response: { 200: validationRunListSchema },
      },
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const items = await listValidationRuns(app.db, scope, request.params.folderId);
      return { items: items.map((item) => ({ ...item })) };
    },
  );

  app.get(
    `${PREFIX}/folders/:folderId/findings`,
    {
      preHandler: readChecks,
      schema: {
        params: folderIdParamSchema,
        querystring: findingQuerySchema,
        response: { 200: findingListSchema },
      },
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const { folderId } = request.params;
      const view = await listFindingsView(app.db, scope, {
        folderId,
        validationRunId: request.query.validationRunId,
      });
      const coverage = await loadChecksCoverage(app.db, scope, folderId);

      // Счётчики считаются по уже загруженному списку, а не отдельным запросом:
      // второй запрос считал бы то же самое в другой момент, и число в сводке
      // могло бы разойтись со списком под ней. По этому расхождению
      // пользователь решал бы, все ли ошибки он увидел.
      return {
        items: view.items.map((item) => ({
          ...item,
          evidence: item.evidence.map((quote) => ({ ...quote })),
        })),
        summary: {
          latestRun: view.latestRun === null ? null : { ...view.latestRun },
          shownRunId: view.shownRunId,
          coverage: { ...coverage, unassignedPageNumbers: [...coverage.unassignedPageNumbers] },
          counts: countFindings(view.items),
        },
      };
    },
  );

  /**
   * Состав комплекта и результат проверки по каждой его позиции (S29).
   *
   * Право то же, что у замечаний: отчёт не показывает ничего, чего не показывал
   * бы список, — он показывает то же самое в порядке комплекта и вместе с
   * ответом «здесь всё в порядке».
   *
   * Отдельный адрес, а не поле в `findings`: у ответов разный размер и разная
   * частота обновления, и подмешивать состав комплекта в список замечаний
   * значило бы возить весь состав на каждое обновление списка после снятия
   * одного замечания.
   */
  app.get(
    `${PREFIX}/folders/:folderId/check-report`,
    {
      preHandler: readChecks,
      schema: { params: folderIdParamSchema, response: { 200: checkReportSchema } },
    },
    async (request) => {
      const { scope } = currentAuth(request);
      const { folderId } = request.params;
      updateContext({ folderId });
      const report = await buildCheckReport(app.db, scope, folderId);
      return {
        runId: report.runId,
        groups: report.groups.map((group) => ({
          ...group,
          sections: group.sections.map((section) => ({
            ...section,
            rows: section.rows.map((row) => ({
              ...row,
              findingIds: [...row.findingIds],
              items: row.items.map((item) => ({ ...item })),
            })),
          })),
        })),
      };
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
