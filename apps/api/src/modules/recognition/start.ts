/**
 * Создание прогона распознавания и постановка его головы.
 *
 * Вынесено из маршрута `POST /revisions/{id}/recognize` по той же причине, что
 * и запуск разметки (`modules/layout/start.ts`): вызывающих стало двое — прежний
 * гранулярный маршрут и кнопка S21 «Проверить». Копия здесь означала бы второе
 * место, где читается `recognition.provider`, проверяется allowlist моделей и
 * собирается `settings_snapshot`, — а снимок это ровно то, чему разойтись
 * нельзя: по нему прогон потом доказывает, чем он выполнен.
 */
import type { Env } from '../../config/env.js';
import {
  parseModelAllowlist,
  readAiDryRunOnly,
  readRecognitionSettings,
} from '../../config/portal-settings.js';
import type { AuthScope } from '../../auth/scope.js';
import type { Database } from '../../db/repositories/users.js';
import { readPublishedPromptCodes } from '../../db/repositories/admin.js';
import { enqueueJob } from '../../db/repositories/jobs.js';
import { startRecognitionRun } from '../../db/repositories/recognition.js';
import { recognitionSelections } from '../../integrations/rdweb/index.js';
import { RECOGNITION_PROMPT_CODES } from '../../recognition/vlm/prompts.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { conflict, notFound } from '../../lib/problem.js';
import { tracePayload } from '../../observability/context.js';

/**
 * Готова ли стадия распознавания к запуску — ДО необратимых действий.
 *
 * Отдельная функция, а не строчки внутри `startRecognition`, потому что
 * вызывающих у проверки двое, и второй обязан спросить РАНЬШЕ. Кнопка
 * «2. Распознать» по дороге замораживает черновую разметку (`modules/pipeline`), и
 * отказ после заморозки оставил бы ревизию с необратимо замороженной разметкой
 * ни за что — правкой это уже не лечится, только новой ревизией разметки.
 *
 * Ветка RD WEB проверок не имеет: ни модели, ни промптов стадии recognize у неё нет.
 */
export async function assertRecognitionStageReady(db: Database, env: Env): Promise<void> {
  const recognition = await readRecognitionSettings(db);
  if (recognition.provider !== 'openrouter_vlm') return;
  await assertVlmStageReady(db, env, recognition);
}

/**
 * Три отказа ДО создания прогона, все по одной причине: иначе прогон умер бы, не
 * сделав ничего, а человек узнал бы об этом из журнала задач, а не из ответа на
 * своё нажатие.
 *
 * Третий — публикация промптов. `vlm.start_recognition` требует опубликованными все
 * коды стадии recognize, а сид-миграция 0020 кладёт их черновиками: публикация
 * задумана как осознанное действие администратора. Без этой проверки каждое нажатие
 * создаёт прогон и задачу ровно затем, чтобы они умерли через 50 мс.
 *
 * Перечисляются ВСЕ недостающие коды сразу: гейт воркера падает на первом же и
 * заставляет узнавать их по одному — тремя нажатиями и тремя мёртвыми прогонами.
 */
async function assertVlmStageReady(
  db: Database,
  env: Env,
  recognition: { readonly vlmModel: string },
): Promise<void> {
  if (recognition.vlmModel === '') {
    throw conflict(
      'Модель распознавания не выбрана: задайте recognition.vlm_model в настройках портала.',
    );
  }

  const allowlist = parseModelAllowlist(env.LLM_MODEL_ALLOWLIST);
  if (allowlist !== null && !allowlist.includes(recognition.vlmModel)) {
    // Политика провайдера отвергла бы модель на первом же вызове.
    throw conflict(
      `Модель «${recognition.vlmModel}» не входит в LLM_MODEL_ALLOWLIST: ` +
        'согласуйте слаг с эксплуатацией.',
    );
  }

  const published = await readPublishedPromptCodes(db, RECOGNITION_PROMPT_CODES);
  const missing = RECOGNITION_PROMPT_CODES.filter((code) => !published.has(code));
  if (missing.length > 0) {
    throw conflict(
      `Стадия распознавания не готова: промпты ${missing.join(', ')} не опубликованы. ` +
        'Откройте раздел администрирования → «AI и промты» и проведите каждый из них ' +
        'по маршруту черновик → на испытание → опубликовать.',
    );
  }
}

export interface StartRecognitionResult {
  readonly recognitionRunId: string;
  /** Создан ли прогон этим вызовом (а не подобран уже идущий). */
  readonly created: boolean;
  readonly jobId: string;
  readonly jobCreated: boolean;
}

/**
 * Прогон по ЗАМОРОЖЕННОЙ разметке.
 *
 * `autoContinue` кладётся в payload головы и оттуда доезжает до финализации,
 * которая и решает, ставить ли анализ. В `settings_snapshot` он не пишется
 * намеренно: снимок отвечает на вопрос «чем распознано» и попадает в выдачу
 * прогона, а «доводить ли до проверок» — свойство нажатия, а не результата.
 */
export async function startRecognition(
  db: Database,
  env: Env,
  scope: AuthScope,
  input: {
    readonly revisionId: string;
    readonly frozenLayoutId: string;
    readonly idempotencyKey: string;
    readonly autoContinue: boolean;
  },
): Promise<StartRecognitionResult> {
  /**
   * Ветвление провайдера (ADR-0007): настройка читается ЗДЕСЬ, на постановке, и
   * фиксируется снимком — выполняющийся прогон смену настройки не видит. Снимок
   * настроек — REDACTED по построению (§3.9, B): только провайдер, модель и
   * режимы; ни секретов, ни адресов, ни подписанных ссылок — их здесь просто
   * нет, а не «вырезаны фильтром».
   */
  const recognition = await readRecognitionSettings(db);
  let settingsSnapshot: Record<string, unknown>;
  let firstJobType: 'layout.reconcile' | 'vlm.start_recognition';

  if (recognition.provider === 'openrouter_vlm') {
    await assertVlmStageReady(db, env, recognition);

    settingsSnapshot = {
      version: 2,
      provider: 'openrouter_vlm',
      model: recognition.vlmModel,
      // Промпты, растеризатор и crop policy дополняет vlm.start_recognition:
      // они известны воркеру, а не роуту.
      dryRun: await readAiDryRunOnly(db),
    };
    firstJobType = 'vlm.start_recognition';
  } else {
    const selections = recognitionSelections(env);
    settingsSnapshot = {
      version: 1,
      documentMode: false,
      blockTypes: selections.map((selection) => selection.blockType),
      provider: selections[0]?.providerType ?? null,
      model: selections[0]?.modelId ?? null,
      promptProfiles: Object.fromEntries(
        selections
          .filter((selection) => selection.promptProfileId !== undefined)
          .map((selection) => [selection.blockType, selection.promptProfileId]),
      ),
    };
    firstJobType = 'layout.reconcile';
  }

  const { run, created } = await startRecognitionRun(db, scope, {
    layoutRevisionId: input.frozenLayoutId,
    settingsSnapshot,
    // Ветке RD WEB без RD-документа OCR запускать негде; у VLM-прогона его нет
    // по построению (ADR-0007).
    requireRdDocument: recognition.provider !== 'openrouter_vlm',
  });
  if (run.revisionId !== input.revisionId) {
    // Разметка чужой ревизии в теле запроса. Область её бы пропустила, если
    // ревизии принадлежат одному подрядчику, поэтому сверка явная.
    throw notFound('Ревизия разметки не относится к указанной ревизии поставки.');
  }

  const { jobId, created: jobCreated } = await enqueueJob(db, scope, {
    type: firstJobType,
    payload: tracePayload({
      revisionId: input.revisionId,
      recognitionRunId: run.id,
      ...(input.autoContinue ? { autoContinue: true } : {}),
    }),
    dedupeKey: dedupeKeyFor(firstJobType, run.id, input.idempotencyKey),
  });

  return { recognitionRunId: run.id, created, jobId, jobCreated };
}
