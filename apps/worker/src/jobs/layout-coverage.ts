/**
 * Анализ покрытия страницы блоками и флаги внимания (§7.3).
 *
 * Задача пережила снятие легаси-маршрута RD WEB и живёт теперь отдельно от
 * него. Это не косметика: к RD WEB она никогда и не относилась — считает флаги
 * по НАШЕЙ разметке, чем бы та ни была получена, и стояла в общем файле
 * `markup.ts` лишь потому, что там стояла вся стадия разметки целиком.
 *
 * ## Почему флаги считаются по пину, а не по настройке
 *
 * Правило разметки берётся из `markupPolicy` ревизии. Анализ покрытия идёт
 * после каждой пачки детекции, растянутой на минуты, и настройка, сменившаяся
 * посреди, дала бы страницы, размеченные одним правилом и оценённые другим.
 */
import {
  analyzePages,
  type AnalyzedPage,
  type JobContext,
  type JobHandler,
  type LayoutThresholds,
  type PageAnalysis,
} from '@id/api';
import {
  pageMarkupMode,
  type AttentionFlag,
  type BlockType,
  type MarkupPolicy,
} from '@id/contracts';

/** Состояние, при котором считать нечего: дефект постановщика, не сбой. */
export class CoverageStateError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = 'CoverageStateError';
  }
}

export interface CoverageTarget {
  readonly layoutRevisionId: string;
  readonly folderId: string;
  readonly bundleId: string;
  readonly thresholds: LayoutThresholds;
  readonly layoutProfileVersion: number | null;
  readonly markupPolicy: MarkupPolicy;
}

export interface PageBlocksSnapshot {
  readonly workingPageIndex: number;
  readonly sourcePageId: string;
  /**
   * Размеры листа в пунктах (S42): по ним анализ узнаёт, что портал на этой
   * странице искал. Достаются бесплатно — карта страниц читается и так, чтобы
   * страница без единого блока попала в анализ.
   */
  readonly widthPt: number;
  readonly heightPt: number;
  readonly blocks: readonly {
    readonly blockType: BlockType;
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  }[];
}

export interface CoverageDeps {
  loadTargetByLayout(input: {
    readonly folderId: string;
    readonly layoutRevisionId: string;
  }): Promise<CoverageTarget | null>;

  loadPageBlocks(input: {
    readonly folderId: string;
    readonly layoutRevisionId: string;
  }): Promise<readonly PageBlocksSnapshot[]>;

  saveFlags(input: {
    readonly folderId: string;
    readonly flags: ReadonlyMap<string, readonly AttentionFlag[]>;
  }): Promise<{ readonly written: boolean; readonly reason?: string }>;
}

/**
 * Сводка анализа: сколько страниц, сколько флагованных и сколько раз какой флаг.
 *
 * Разбивка по флагам обязательна: «флагов 12» без неё не отличает двенадцать
 * пустых страниц от двенадцати маленьких блоков, а решения это разные.
 */
export function summarizeAnalysis(analysis: readonly PageAnalysis[]): {
  readonly pages: number;
  readonly flagged: number;
  readonly byFlag: Record<string, number>;
} {
  const byFlag: Record<string, number> = {};
  let flagged = 0;
  for (const page of analysis) {
    if (page.flags.length > 0) flagged += 1;
    for (const flag of page.flags) {
      byFlag[flag] = (byFlag[flag] ?? 0) + 1;
    }
  }
  return { pages: analysis.length, flagged, byFlag };
}

export function createAnalyzeCoverageHandler(
  deps: CoverageDeps,
): JobHandler<'layout.analyze_coverage'> {
  return async (ctx: JobContext<'layout.analyze_coverage'>) => {
    const target = await deps.loadTargetByLayout({
      folderId: ctx.payload.folderId,
      layoutRevisionId: ctx.payload.layoutRevisionId,
    });
    if (target === null) throw new CoverageStateError('Ревизия разметки не найдена');

    const snapshots = await deps.loadPageBlocks({
      folderId: target.folderId,
      layoutRevisionId: target.layoutRevisionId,
    });

    const pages: AnalyzedPage[] = snapshots.map((page) => ({
      workingPageIndex: page.workingPageIndex,
      markupMode: pageMarkupMode(page.widthPt, page.heightPt, target.markupPolicy),
      blocks: page.blocks.map((block) => ({
        blockType: block.blockType,
        x0: block.x0,
        y0: block.y0,
        x1: block.x1,
        y1: block.y1,
      })),
    }));

    const analysis = analyzePages(pages, target.thresholds);
    const byPage = new Map(snapshots.map((page) => [page.workingPageIndex, page.sourcePageId]));

    const flags = new Map<string, readonly AttentionFlag[]>();
    for (const page of analysis) {
      const sourcePageId = byPage.get(page.workingPageIndex);
      if (sourcePageId !== undefined) flags.set(sourcePageId, page.flags);
    }

    const outcome = await deps.saveFlags({ folderId: target.folderId, flags });
    const summary = summarizeAnalysis(analysis);

    await ctx.emit('layout.coverage_analyzed', {
      layoutRevisionId: target.layoutRevisionId,
      pages: summary.pages,
      flaggedPages: summary.flagged,
      byFlag: summary.byFlag,
      layoutProfileVersion: target.layoutProfileVersion,
      flagsWritten: outcome.written,
      // Полностраничный блок НЕ добавлен ни на одну страницу: замена страницы
      // одним блоком — явное действие пользователя (§5.3).
      fullPagePatchApplied: false,
    });

    ctx.logger.info(
      {
        event: 'coverage_analyzed',
        pages: summary.pages,
        flagged_pages: summary.flagged,
        by_flag: summary.byFlag,
        flags_written: outcome.written,
        flags_skip_reason: outcome.reason ?? null,
        layout_profile_version: target.layoutProfileVersion,
      },
      'флаги внимания рассчитаны',
    );
  };
}
