/**
 * Обратная связь конвейера: запись дефектов качества обработки (§11, ADR-0010).
 *
 * ## Чем это отличается от журнала ошибок
 *
 * Журнал ошибок регистрирует исключения. Здесь регистрируется результат,
 * который получен без единого исключения и при этом неверен: модель вернула
 * JSON не по схеме, отказалась отвечать, детектор не нашёл обводок,
 * классификатор не уверен, инженер поправил распознанное. Такие дефекты — не
 * инциденты эксплуатации, а данные для доработки конвейера, и потому у них
 * своя таблица, свой срок хранения и своя политика записи.
 *
 * ## Прореживания здесь нет и не будет
 *
 * Ради этого модуль и существует отдельно от `journal-writer.ts`. Вопрос, на
 * который он обязан отвечать, — «какая доля вызовов этим промтом даёт
 * невалидный JSON». Доля по выборке отвечает на него неверно, а неверный ответ
 * здесь дороже отсутствующего: по нему принимают решение править промт.
 *
 * Объём при этом ограничен по построению: запись приходится на блок или
 * страницу, а не на HTTP-запрос, то есть растёт вместе с обработанными
 * документами, а не с трафиком.
 *
 * ## Приёмник не бросает никогда
 *
 * Его вызывают из середины прогона распознавания. Дефект качества, уронивший
 * прогон, ради которого он записан, — худшее, что может сделать наблюдаемость.
 */
import type { Logger } from 'pino';
import type { ProcessingFeedbackReason, ProcessingFeedbackType } from '@id/contracts';
import { currentContext } from './context.js';
import { redactDeep } from './logger.js';
import { errorClassOf, type SqlExecutor } from './errors.js';

/** Стадия обработки; шире `ProcessingStage` на два шага, которых там нет. */
export type FeedbackStage =
  | 'uploaded'
  | 'layout'
  | 'recognition'
  | 'analysis'
  | 'checks'
  | 'ready'
  | 'failed'
  | 'detect'
  | 'match';

export interface ProcessingFeedbackEvent {
  readonly feedbackType: ProcessingFeedbackType;
  readonly reasonCode: ProcessingFeedbackReason;
  readonly severity?: 'info' | 'warn' | 'error' | undefined;

  readonly revisionId?: string | undefined;
  readonly recognitionRunId?: string | undefined;
  readonly sourcePageId?: string | undefined;
  readonly workingPageIndex?: number | undefined;
  readonly layoutBlockId?: string | undefined;
  /** Код реквизита, а не его значение: значение — это ПДн. */
  readonly fieldCode?: string | undefined;
  readonly findingId?: string | undefined;
  readonly jobRunId?: string | undefined;
  readonly aiRunId?: string | undefined;

  readonly docTypeCode?: string | undefined;
  readonly pipelineStage?: FeedbackStage | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly promptCode?: string | undefined;
  readonly promptVersion?: number | undefined;
  readonly detectorModelVersion?: string | undefined;
  readonly rulesetVersion?: string | undefined;

  readonly score?: number | undefined;
  /**
   * Что наблюдалось и что ожидалось.
   *
   * Только коды, счётчики, имена полей и геометрия. Значения полей, текст
   * страницы и ответ модели сюда не кладут: таблица живёт два года, и §11
   * относит это к ПДн. Оба поля всё равно проходят общую очистку — дисциплина
   * вызывающего кода не единственный рубеж.
   */
  readonly observed?: Record<string, unknown> | undefined;
  readonly expected?: Record<string, unknown> | undefined;
}

export interface ProcessingFeedbackSink {
  record(event: ProcessingFeedbackEvent): Promise<void>;
}

const INSERT_FEEDBACK = `
  INSERT INTO processing_feedback (
    feedback_type, reason_code, severity,
    revision_id, recognition_run_id, source_page_id, working_page_index, layout_block_id,
    field_code, finding_id, job_run_id, ai_run_id,
    doc_type_code, pipeline_stage, provider, model, prompt_code, prompt_version,
    detector_model_version, ruleset_version, app_release,
    score, observed, expected, request_id
  ) VALUES (
    $1, $2, $3,
    $4::uuid, $5::uuid, $6::uuid, $7, $8::uuid,
    $9, $10::uuid, $11::uuid, $12::uuid,
    $13, $14, $15, $16, $17, $18,
    $19, $20, $21,
    $22, $23::jsonb, $24::jsonb, $25
  )
`;

export interface DbProcessingFeedbackSinkOptions {
  readonly sql: SqlExecutor;
  readonly logger: Logger;
  readonly release?: string | undefined;
}

export class DbProcessingFeedbackSink implements ProcessingFeedbackSink {
  readonly #sql: SqlExecutor;
  readonly #logger: Logger;
  readonly #release: string | undefined;

  constructor(options: DbProcessingFeedbackSinkOptions) {
    this.#sql = options.sql;
    this.#logger = options.logger;
    this.#release = options.release;
  }

  async record(event: ProcessingFeedbackEvent): Promise<void> {
    // Идентификатор запроса берётся из области выполнения: он связывает запись
    // с журналом ошибок и с `ai_runs` того же прогона.
    const requestId = currentContext()?.requestId ?? null;

    try {
      await this.#sql.query(INSERT_FEEDBACK, [
        event.feedbackType,
        event.reasonCode,
        event.severity ?? 'warn',
        event.revisionId ?? null,
        event.recognitionRunId ?? null,
        event.sourcePageId ?? null,
        event.workingPageIndex ?? null,
        event.layoutBlockId ?? null,
        event.fieldCode ?? null,
        event.findingId ?? null,
        event.jobRunId ?? null,
        event.aiRunId ?? null,
        event.docTypeCode ?? null,
        event.pipelineStage ?? null,
        event.provider ?? null,
        event.model ?? null,
        event.promptCode ?? null,
        event.promptVersion ?? null,
        event.detectorModelVersion ?? null,
        event.rulesetVersion ?? null,
        this.#release ?? null,
        event.score ?? null,
        event.observed === undefined ? null : JSON.stringify(redactDeep(event.observed)),
        event.expected === undefined ? null : JSON.stringify(redactDeep(event.expected)),
        requestId,
      ]);
    } catch (error) {
      // Не бросаем: вызов идёт из середины прогона распознавания, и уронить
      // его записью о качестве значит потерять результат ради заметки о нём.
      this.#logger.error(
        {
          event: 'processing_feedback_failed',
          reason_code: event.reasonCode,
          error_class: errorClassOf(error),
        },
        'не удалось записать обратную связь конвейера',
      );
    }
  }
}

/** Пустой приёмник: тесты и запуск без БД. */
export class NoopProcessingFeedbackSink implements ProcessingFeedbackSink {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
