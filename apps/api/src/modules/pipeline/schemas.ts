/**
 * Схемы двух кнопок S21.
 *
 * Ответ называет СТАДИЮ, с которой прогон продолжился, а не просто «принято».
 * Без этого экран не может сказать пользователю, что происходит: он нажал одну
 * кнопку, а портал мог начать с распознавания, с анализа или с прогона правил —
 * в зависимости от того, где ревизия остановилась в прошлый раз.
 */
import { z } from 'zod';

export const revisionIdParamSchema = z.object({ revisionId: z.uuid() });
export const runIdParamSchema = z.object({ runId: z.uuid() });

/**
 * Стадия, с которой продолжился сквозной прогон.
 *
 * Перечисление закрытое: экран печатает по нему фразу пользователю, и
 * незнакомое значение означало бы «идёт что-то», то есть отсутствие ответа.
 */
export const pipelineStageSchema = z.enum(['recognition', 'analysis', 'checks']);

export const startMarkupPipelineResponseSchema = z.object({
  /**
   * `false` — рабочий документ ещё собирается, и разметка пойдёт следом сама
   * (задача `layout.start`). Экран по этому полю выбирает формулировку: «идёт
   * сборка» против «идёт детекция», и обе честны.
   */
  bundleReady: z.boolean(),
  bundleId: z.string().nullable(),
  layoutRevisionId: z.string().nullable(),
  /**
   * `null` — задачи не ставились вовсе.
   *
   * Прежде здесь стояла пустая строка: локальная ветка отдаёт список задач, и
   * маршрут брал из него первый элемент с запасным `''`. Пока задачи ставились
   * всегда, запас был недостижим; с появлением ветки «модель детекции не
   * загружена» он стал достижим — и пустая строка выдавала бы себя за
   * идентификатор задачи, которой нет.
   */
  jobId: z.string().nullable(),
  jobCreated: z.boolean(),
  /**
   * Детекция не запускалась, потому что запускать нечем.
   *
   * Черновик разметки при этом создан, и страницы размечаются вручную — то есть
   * нажатие не пропало впустую. Признак существует ради честной формулировки на
   * экране: «идёт детекция» над очередью, в которую ничего не положили, — это
   * ложь, а молчание оставило бы пользователя ждать результата, которого не будет.
   */
  detectionSkipped: z.boolean(),
  /** Почему детекция пропущена. `null`, когда она не пропускалась. */
  detectionSkipReason: z.string().max(500).nullable(),
});

export const checkResponseSchema = z.object({
  stage: pipelineStageSchema,
  /** Заморожена ли разметка этим нажатием (а не раньше, руками). */
  frozen: z.boolean(),
  recognitionRunId: z.string().nullable(),
  jobId: z.string(),
  jobCreated: z.boolean(),
});

export const recognitionProgressSchema = z.object({
  recognitionRunId: z.string(),
  status: z.string(),
  pagesTotal: z.number(),
  pagesDone: z.number(),
  pagesFailed: z.number(),
  pagesPending: z.number(),
  blocksTotal: z.number(),
  blocksRecognized: z.number(),
  blocksInvalid: z.number(),
  blocksRefused: z.number(),
});
