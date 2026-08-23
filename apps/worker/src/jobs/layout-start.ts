/**
 * Звено «сборка → разметка» (S21).
 *
 * Кнопка «Разметить» нажимается тогда, когда рабочего документа ещё нет:
 * пользователь только что загрузил файлы. Поставить детекцию в этот момент
 * нечем — она адресуется ревизией разметки, а та создаётся от `bundleId`.
 * Поэтому маршрут ставит сборку с признаком «продолжить разметкой», сборка по
 * завершении ставит эту задачу, а она делает ровно то, что при готовом bundle
 * делает маршрут: черновик разметки и пачки детекции по настройке провайдера.
 *
 * Своей логики у задачи нет, и это намеренно: и она, и маршрут зовут один
 * `startMarkupOnBundle` из `@id/api`. Второе место, где читается
 * `detection.provider` и выбирается ветка RF-DETR/RD WEB, разошлось бы с первым
 * при первой же правке — ровно тот класс дефекта, которым кончилась легаси-пара
 * «детекция в роуте и детекция в адаптере».
 */
import type { JobContext, JobHandler } from '@id/api';
import type { Logger } from 'pino';

export interface LayoutStartResult {
  readonly layoutRevisionId: string;
  readonly bundleId: string;
  readonly provider: 'rdweb' | 'local';
  readonly jobsEnqueued: number;
}

export interface LayoutStartDeps {
  /**
   * Запускает разметку по последнему рабочему документу ревизии.
   *
   * `null` — рабочего документа нет. Это не «ещё не собрался»: задача ставится
   * ПОСЛЕ успешной сборки, поэтому отсутствие bundle здесь означает, что состав
   * ревизии успели сменить, и повторять нечего.
   */
  readonly start: (input: {
    readonly revisionId: string;
    readonly logger: Logger;
  }) => Promise<LayoutStartResult | null>;
}

export class LayoutStartStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutStartStateError';
  }
}

export function createLayoutStartHandler(deps: LayoutStartDeps): JobHandler<'layout.start'> {
  return async (ctx: JobContext<'layout.start'>): Promise<void> => {
    const { revisionId } = ctx.payload;

    const started = await deps.start({ revisionId, logger: ctx.logger });
    if (started === null) {
      throw new LayoutStartStateError(
        `Ревизия ${revisionId}: рабочего документа нет, разметку начать не с чего. ` +
          'Состав ревизии сменился после постановки сборки.',
      );
    }

    ctx.logger.info(
      {
        event: 'markup_started',
        layout_revision_id: started.layoutRevisionId,
        bundle_id: started.bundleId,
        provider: started.provider,
        jobs_enqueued: started.jobsEnqueued,
      },
      'разметка запущена вслед за сборкой рабочего документа',
    );

    await ctx.emit('layout.started', {
      layoutRevisionId: started.layoutRevisionId,
      bundleId: started.bundleId,
      provider: started.provider,
      jobsEnqueued: started.jobsEnqueued,
    });
  };
}
