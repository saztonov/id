/**
 * Создание прогона распознавания и постановка его головы.
 *
 * Вынесено из маршрута `POST /folders/{id}/recognize` по той же причине, что
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
import { enqueueJob, reviveFailedJobs } from '../../db/repositories/jobs.js';
import { startRecognitionRun } from '../../db/repositories/recognition.js';
import { execSyncMissingVars } from '../../integrations/rdweb-exec/index.js';
import { EXEC_SYNC_SCHEMA_VERSION } from '@id/execsync';
import { RECOGNITION_PROMPT_CODES } from '../../recognition/vlm/prompts.js';
import { dedupeKeyFor } from '../../jobs/types.js';
import { conflict, notFound } from '../../lib/problem.js';
import { tracePayload } from '../../observability/context.js';

/**
 * Готова ли стадия распознавания к запуску — ДО необратимых действий.
 *
 * Отдельная функция, а не строчки внутри `startRecognition`, потому что
 * вызывающих у проверки двое, и второй обязан спросить РАНЬШЕ. Кнопка
 * «2. Распознать» по дороге правит разметку (`modules/pipeline`: снимает остаток
 * детекции с очереди, доклеивает полностраничные блоки), и отказ после этого
 * оставил бы комплект изменённым ни за что.
 *
 * `requirePublication` различает двух вызывающих, и различие существенное.
 * Сквозной прогон обещает довести комплект до замечаний, поэтому в shadow-режиме
 * он обязан отказаться: выполнить его целиком означало бы потратить деньги и
 * время на результат, который никуда не поедет по построению, и оставить
 * человека перед пустым экраном без единого слова о причине. Гранулярный
 * маршрут ручного пути ничего подобного не обещает — он и есть инструмент
 * shadow-сравнения, и запрещать ему dry-run значило бы запретить сам режим.
 *
 * Проверка конфигурации у веток разная — модель против удостоверения, — а гейт
 * dry-run общий, и это существенно. Прежде он касался только VLM, потому что у
 * маршрута RD WEB не было развилки публикации вовсе; теперь она есть, и режим
 * сравнения провайдеров обязан вести себя одинаково с обеими ветками — иначе
 * сравнивать нечего.
 */
export async function assertRecognitionStageReady(
  db: Database,
  env: Env,
  options: { readonly requirePublication: boolean },
): Promise<void> {
  const recognition = await readRecognitionSettings(db);
  if (recognition.provider === 'openrouter_vlm') {
    assertVlmStageReady(env, recognition);
  } else {
    assertExecStageReady(env);
  }

  if (options.requirePublication && (await readAiDryRunOnly(db))) {
    throw conflict(
      'Портал в режиме dry-run: распознавание выполнится, но результат никуда не ' +
        'поедет — ни распознанного текста, ни документов, ни замечаний после него не ' +
        'появится. Выключите «ai.dry_run_only» в администрировании, либо запускайте ' +
        'распознавание отдельной кнопкой на вкладке «Разметка», если сравниваете ' +
        'провайдеров сознательно.',
    );
  }
}

/**
 * Два отказа ДО создания прогона — и оба про КОНФИГУРАЦИЮ, а не про процесс.
 *
 * Пустая модель и модель вне allowlist дают гарантированный отказ на первом же
 * сетевом вызове: прогон родился бы затем, чтобы умереть. Это не гейт конвейера,
 * который «мешает тестировать», а неверная настройка портала, и режим тестирования
 * её не отменяет — он ослабляет запреты своей базы, а не законы шлюза.
 *
 * Третьей проверки — публикации промптов — здесь БОЛЬШЕ НЕТ. Она требовала ручной
 * публикации текста, который лежит в коде и из которого генерируется сама
 * сид-миграция; теперь отсутствие опубликованной версии значит «взят встроенный
 * текст» (`recognitionPromptDefaultByCode`), а не отказ.
 */
function assertVlmStageReady(env: Env, recognition: { readonly vlmModel: string }): void {
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
}

/**
 * Готовность ветки RD WEB — проверка КОНФИГУРАЦИИ до создания прогона.
 *
 * Прежде такой проверки не было вовсе, и это было не упущением, а следствием
 * прежнего контракта: там отказ приходил позже, из `startRecognitionRun`,
 * фразой «RD-документ прогона не создан». Теперь у ветки есть собственные
 * предусловия — адрес контура, удостоверение и проект, — и ненастроенная
 * интеграция даёт гарантированный отказ на первом же сетевом вызове. Прогон
 * родился бы затем, чтобы умереть; отказать надо раньше и по существу.
 *
 * Текст называет переменные окружения поимённо: администратор, увидевший это
 * сообщение, должен знать, что именно дозаполнить, а не идти читать код.
 */
function assertExecStageReady(env: Env): void {
  const missing = execSyncMissingVars(env);
  if (missing.length > 0) {
    throw conflict(
      `Интеграция RD WEB не настроена: не заданы ${missing.join(', ')}. ` +
        'Задайте их в окружении развёртывания либо переключите распознавание на ' +
        'VLM в настройках портала.',
    );
  }
}

/**
 * Коды стадии recognize, у которых нет опубликованной версии, — предупреждение, а
 * не отказ.
 *
 * Тот же приём, что у блокеров согласования в ADR-0015: «чего не хватает» полезно
 * и на этапе тестирования, мешает не список, а запрет.
 */
export async function recognitionPromptsOnBuiltinText(db: Database): Promise<readonly string[]> {
  const published = await readPublishedPromptCodes(db, RECOGNITION_PROMPT_CODES);
  return RECOGNITION_PROMPT_CODES.filter((code) => !published.has(code));
}

export interface StartRecognitionResult {
  readonly recognitionRunId: string;
  /** Создан ли прогон этим вызовом (а не подобран уже идущий). */
  readonly created: boolean;
  readonly jobId: string;
  readonly jobCreated: boolean;
  /**
   * Пойдёт ли прогон в shadow-режиме, то есть без публикации результата.
   *
   * Возвращается, потому что ручной путь обязан сказать, чем кончится: у
   * гранулярного маршрута гейта на dry-run нет намеренно, и без этого признака
   * «распознавание запущено» означало бы разное в двух режимах, не отличаясь ни
   * одним словом. Признак общий для обеих веток: с переходом на контракт
   * document-sync shadow-режим появился и у маршрута RD WEB.
   */
  readonly dryRun: boolean;
  /**
   * Сколько мёртвых задач этого прогона вернулось в очередь (S41).
   *
   * Нажатие кнопки — решение человека о мертвецах его собственного прогона, и
   * число полезно в журнале: «распознавание запущено» звучит одинаково и когда
   * работа началась с нуля, и когда она продолжила упавшую.
   */
  readonly revivedJobs: number;
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
    readonly folderId: string;
    readonly layoutId: string;
    readonly idempotencyKey: string;
    readonly autoContinue: boolean;
    /**
     * Прогон, который новый восстанавливает (S28).
     *
     * Передаётся, когда предыдущий прогон этой же разметки упал: совместимые
     * результаты будут перенесены до первого вызова модели, и повторно
     * оплачивается только то, что осталось непокрытым.
     */
    readonly repairOfRunId?: string | null | undefined;
    /**
     * Листы, которые прогон обязан перечитать заново (S40).
     *
     * Пустой массив и `undefined` — разные заказы, и различие видно в снимке:
     * пустой массив означает «перечитывать нечего», отсутствие — «ограничения
     * не ставилось». Значение идёт в `settings_snapshot`, а не в payload задачи,
     * потому что оно описывает СОДЕРЖАНИЕ прогона: по снимку прогон потом
     * доказывает, что именно он делал, и повтор задачи обязан прочитать тот же
     * заказ, а не собрать его заново по изменившимся с тех пор замечаниям.
     */
    readonly retryPages?: readonly number[] | undefined;
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
  let firstJobType: 'rd.sync_prepare' | 'vlm.start_recognition';
  let dryRun: boolean;

  if (recognition.provider === 'openrouter_vlm') {
    assertVlmStageReady(env, recognition);

    dryRun = await readAiDryRunOnly(db);
    settingsSnapshot = {
      version: 2,
      provider: 'openrouter_vlm',
      model: recognition.vlmModel,
      // Промпты, растеризатор и crop policy дополняет vlm.start_recognition:
      // они известны воркеру, а не роуту.
      dryRun,
      ...(input.retryPages === undefined ? {} : { recheck: { pages: [...input.retryPages] } }),
    };
    firstJobType = 'vlm.start_recognition';
  } else {
    assertExecStageReady(env);

    /*
     * Снимок v3: контракт document-sync.
     *
     * `model: null` — не упущение. Модель выбирает RD WEB (§1: выбор выреза,
     * модели и промта принадлежит им целиком), и в ручке результатов её не
     * называет. Записать сюда что-нибудь значило бы соврать о том, чем
     * распознано, — а снимок существует ровно затем, чтобы прогон это доказывал.
     *
     * `dryRun` у этой ветки появляется впервые. Прежний маршрут развилки
     * публикации не имел, и это обесценивало сам режим: `ai.dry_run_only`
     * заводился ради СРАВНЕНИЯ провайдеров, а сравнивать было не с чем, пока
     * одна из двух веток его игнорировала. Денег он здесь не экономит — модель
     * отработает и будет оплачена, — но смысл сохраняет полностью: canonical
     * пишется, публикация пропускается, downstream прогона не видит.
     */
    dryRun = await readAiDryRunOnly(db);
    settingsSnapshot = {
      version: 3,
      provider: 'rdweb',
      contract: EXEC_SYNC_SCHEMA_VERSION,
      externalProjectId: env.RDWEB_EXEC_PROJECT_ID ?? null,
      model: null,
      dryRun,
      ...(input.retryPages === undefined ? {} : { recheck: { pages: [...input.retryPages] } }),
    };
    firstJobType = 'rd.sync_prepare';
  }

  const { run, created } = await startRecognitionRun(db, scope, {
    layoutRevisionId: input.layoutId,
    settingsSnapshot,
    /*
     * RD-документа не требует НИ ОДНА ветка.
     *
     * У прежнего маршрута RD WEB он был условием запуска OCR, и именно поэтому
     * комбинация «детекция local + распознавание rdweb» была тупиком: локальная
     * разметка RD-документа не создаёт, и прогон отвечал 409. У контракта
     * document-sync документ заводится самой отправкой, а блоки в снимке наши —
     * то есть эта комбинация стала единственным и штатным маршрутом.
     */
    requireRdDocument: false,
    // Восстановление возможно только у ветки VLM: перенос результатов
    // выполняет `vlm.start_recognition`, у ветки RD WEB такого шага нет.
    repairOfRunId: recognition.provider === 'openrouter_vlm' ? (input.repairOfRunId ?? null) : null,
  });
  if (run.folderId !== input.folderId) {
    // Разметка чужой ревизии в теле запроса. Область её бы пропустила, если
    // ревизии принадлежат одному подрядчику, поэтому сверка явная.
    throw notFound('Ревизия разметки не относится к указанной ревизии поставки.');
  }

  /**
   * Мёртвые задачи ЭТОГО прогона оживают до постановки головной задачи (S41).
   *
   * Существующий прогон возвращается как есть (`created: false`), и повторное
   * нажатие «Распознать» на нём не ставило ничего: мёртвые страницы держали
   * свои ключи дедупликации, а head-задача склеивалась с прежней. Прогон
   * оставался вечно незаконченным, и единственным выходом была консоль задач.
   *
   * Скоуп — прогон, а не ревизия: мертвецы ЧУЖОГО прогона относятся к работе,
   * предмет которой уже сменился, и оживлять их этой кнопкой нельзя.
   */
  const revived = await reviveFailedJobs(db, {
    folderId: input.folderId,
    stage: 'recognition',
    scopeKey: 'recognitionRunId',
    scopeValue: run.id,
  });

  const { jobId, created: jobCreated } = await enqueueJob(db, scope, {
    type: firstJobType,
    payload: tracePayload({
      folderId: input.folderId,
      recognitionRunId: run.id,
      ...(input.autoContinue ? { autoContinue: true } : {}),
    }),
    dedupeKey: dedupeKeyFor(firstJobType, run.id, input.idempotencyKey),
  });

  return { recognitionRunId: run.id, created, jobId, jobCreated, dryRun, revivedJobs: revived };
}
