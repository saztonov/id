/**
 * Задача 3 конвейера — `bundle.build` (§12, §3.3).
 *
 * Собирает рабочий PDF ревизии: производный неизменяемый документ из ВСЕХ
 * файлов в заданном пользователем порядке. Именно он уезжает в RD WEB, и именно
 * на него ложится разметка. Оригиналы не меняются — они неизменяемы по
 * построению, и рабочий документ существует отдельно от них.
 *
 * ## Карта страниц — главный результат, а не побочный
 *
 * Помимо файла задача записывает `processing_bundle_pages`: соответствие
 * «страница рабочего PDF → исходный файл и страница в нём». Без него результат
 * распознавания невозможно связать с оригиналом: пользователь видит замечание к
 * странице 47 рабочего документа, а исправлять ему третий лист второго файла.
 * Поэтому карта строится ДО сборки, из состава и порядка (`planWorkingPdf()`),
 * а сборщик обязан лишь произвести документ ровно с таким числом страниц —
 * расхождение прекращает задачу, и bundle не сохраняется вовсе.
 *
 * ## Идемпотентность
 *
 * Задача перезапускается: воркер мог умереть на середине склейки 86 МБ. Второй
 * рабочий документ того же состава был бы и лишней копией, и неоднозначностью
 * «какой из двух отправляли», поэтому уже собранный bundle того же манифеста и
 * той же версии сборщика возвращается как есть, без повторной работы.
 *
 * Версия сборщика включает реализацию (`qpdf` или `pdf-lib`): байты выхода у
 * них разные, и считать эти два документа одним значило бы утверждать, что
 * отправлено то, чего не собирали.
 *
 * ## Порты вместо импортов
 *
 * Хранилище, разбор PDF и репозитории не входят в объявленную поверхность
 * `@id/api`, поэтому обработчик принимает уже связанные функции. Побочная
 * польза: задача проверяется без хранилища и без базы, а сборка PDF и запись
 * карты — на настоящих файлах и настоящей БД, каждая на своём уровне.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobContext, JobHandler } from '@id/api';

export const BUNDLE_BUILD_JOB_TYPE = 'bundle.build';

/**
 * Версия сборщика рабочего документа.
 *
 * Меняется при любом изменении того, ЧТО получается на выходе: порядка сборки,
 * набора метаданных, правил конвертации. Хранится в `processing_bundles` и
 * входит в ключ уникальности, поэтому смена версии означает пересборку, а не
 * молчаливое использование старого артефакта под новым кодом.
 */
export const BUNDLE_BUILDER = 'bundle/1';

/** Отметка о производности в метаданных PDF (§13). */
export const DERIVED_NOTE = 'Портал ИД: производная копия (рабочий документ ревизии)';

export interface BundlePlanPage {
  readonly sourcePageId: string;
  readonly filePageIndex: number;
}

export interface BundlePlanFile {
  readonly sourceFileId: string;
  readonly fileName: string;
  readonly sortOrder: number;
  readonly blobSha256: string;
  readonly sizeBytes: number;
  readonly s3Key: string;
  readonly verifyState: string;
  readonly pages: readonly BundlePlanPage[];
}

export interface BundlePlan {
  readonly revisionId: string;
  readonly status: string;
  readonly files: readonly BundlePlanFile[];
  readonly aggregateManifestHash: string;
  /** Пусто — можно собирать; иначе перечень причин, почему нельзя. */
  readonly blockers: readonly string[];
}

export interface WorkingPdfPart {
  readonly sourceFileId: string;
  readonly path: string;
  readonly byteSize: number;
  readonly pageCount: number;
}

export interface WorkingPageMapping {
  readonly workingPageIndex: number;
  readonly sourceFileId: string;
  readonly filePageIndex: number;
}

export interface BundleToolkit {
  readonly kind: 'qpdf' | 'pdf-lib';
  buildWorkingPdf(input: {
    readonly parts: readonly WorkingPdfPart[];
    readonly outputPath: string;
    readonly derivedNote?: string | undefined;
  }): Promise<{
    readonly pageCount: number;
    readonly map: readonly WorkingPageMapping[];
    readonly toolkit: 'qpdf' | 'pdf-lib';
  }>;
}

export interface StoredWorkingPdf {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly s3Key: string;
}

export interface BundleRef {
  readonly id: string;
  readonly pageCount: number;
}

export interface BundleBuildDeps {
  readonly loadPlan: (revisionId: string) => Promise<BundlePlan | null>;
  readonly findExistingBundle: (target: {
    readonly revisionId: string;
    readonly aggregateManifestHash: string;
    readonly builderVersion: string;
  }) => Promise<BundleRef | null>;
  /** Выкладывает оригинал из хранилища во временный файл. */
  readonly fetchOriginal: (storageKey: string, destinationPath: string) => Promise<void>;
  /** Кладёт собранный документ в хранилище; хэш и ключ считает адаптер. */
  readonly storeWorkingPdf: (localPath: string) => Promise<StoredWorkingPdf>;
  readonly createBundle: (input: {
    readonly revisionId: string;
    readonly aggregateManifestHash: string;
    readonly builderVersion: string;
    readonly workingPdf: StoredWorkingPdf;
    readonly pages: readonly {
      readonly workingPageIndex: number;
      readonly sourcePageId: string;
    }[];
  }) => Promise<{ readonly bundle: BundleRef; readonly created: boolean }>;
  readonly toolkit: BundleToolkit;
  /** Каталог для временных копий; по умолчанию системный. */
  readonly workDirBase?: string | undefined;
}

export class BundleBuildError extends Error {
  readonly revisionId: string;

  constructor(message: string, revisionId: string) {
    super(message);
    this.name = 'BundleBuildError';
    this.revisionId = revisionId;
  }
}

export function createBundleBuildHandler(deps: BundleBuildDeps): JobHandler<'bundle.build'> {
  return async (ctx: JobContext<'bundle.build'>): Promise<void> => {
    const { revisionId } = ctx.payload;
    const builderVersion = `${BUNDLE_BUILDER}+${deps.toolkit.kind}`;

    const plan = await deps.loadPlan(revisionId);
    if (plan === null) {
      throw new BundleBuildError(
        `Ревизия ${revisionId} не найдена или недоступна в области видимости задачи.`,
        revisionId,
      );
    }
    if (plan.blockers.length > 0) {
      // Отказ ДО скачивания файлов: причины уже известны, и тратить на них
      // трафик и время сборки незачем.
      throw new BundleBuildError(
        `Рабочий документ собрать нельзя: ${plan.blockers.join('; ')}.`,
        revisionId,
      );
    }

    const existing = await deps.findExistingBundle({
      revisionId,
      aggregateManifestHash: plan.aggregateManifestHash,
      builderVersion,
    });
    if (existing !== null) {
      ctx.logger.info(
        {
          event: 'bundle_reused',
          bundle_id: existing.id,
          builder_version: builderVersion,
          page_count: existing.pageCount,
        },
        'рабочий документ этого состава уже собран',
      );
      await ctx.emit('bundle.ready', {
        bundleId: existing.id,
        pageCount: existing.pageCount,
        reused: true,
      });
      return;
    }

    const files = [...plan.files].sort((a, b) => a.sortOrder - b.sortOrder);
    const pageIds = indexPages(files, revisionId);
    const startedAt = Date.now();

    const workDir = await mkdtemp(join(deps.workDirBase ?? tmpdir(), 'id-bundle-'));
    try {
      const parts: WorkingPdfPart[] = [];
      for (const [position, file] of files.entries()) {
        throwIfAborted(ctx, revisionId);
        // Имя временного файла строится из позиции и идентификатора: имя,
        // данное пользователем, в путь файловой системы не попадает (§13).
        const path = join(workDir, `${String(position).padStart(4, '0')}-${file.sourceFileId}.pdf`);
        await deps.fetchOriginal(file.s3Key, path);
        parts.push({
          sourceFileId: file.sourceFileId,
          path,
          byteSize: file.sizeBytes,
          pageCount: file.pages.length,
        });
      }

      throwIfAborted(ctx, revisionId);
      const outputPath = join(workDir, 'working.pdf');
      const built = await deps.toolkit.buildWorkingPdf({
        parts,
        outputPath,
        derivedNote: DERIVED_NOTE,
      });

      // Карта строится ДО выкладки в хранилище, хотя пишется после. Порядок
      // существенный: `pageIdOf()` отказывает на странице без соответствия, а
      // выложенный к этому моменту объект остался бы в хранилище навсегда —
      // ссылок на него нет ни в `stored_blobs`, ни в `processing_bundles`.
      // На 86 МБ комплектах три повтора задачи означали бы четверть гигабайта
      // мусора за одну неудачу.
      const pages = built.map.map((entry) => ({
        workingPageIndex: entry.workingPageIndex,
        sourcePageId: pageIdOf(pageIds, entry, revisionId),
      }));
      const workingPdf = await deps.storeWorkingPdf(outputPath);

      const { bundle, created } = await deps.createBundle({
        revisionId,
        aggregateManifestHash: plan.aggregateManifestHash,
        builderVersion,
        workingPdf,
        pages,
      });

      ctx.logger.info(
        {
          event: 'bundle_built',
          bundle_id: bundle.id,
          builder_version: builderVersion,
          toolkit: built.toolkit,
          file_count: files.length,
          page_count: built.pageCount,
          size_bytes: workingPdf.sizeBytes,
          duration_ms: Date.now() - startedAt,
          created,
        },
        'рабочий документ собран',
      );

      await ctx.emit('bundle.ready', {
        bundleId: bundle.id,
        pageCount: built.pageCount,
        fileCount: files.length,
        reused: !created,
      });
    } finally {
      // Временные копии удаляются всегда: на 86 МБ комплектах оставленный
      // каталог кончается заполненным диском воркера, а не предупреждением.
      await rm(workDir, { recursive: true, force: true });
    }
  };
}

/** Соответствие «файл + страница в файле» → идентификатор строки `source_pages`. */
function indexPages(files: readonly BundlePlanFile[], revisionId: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const file of files) {
    for (const page of file.pages) {
      const key = pageKey(file.sourceFileId, page.filePageIndex);
      if (index.has(key)) {
        throw new BundleBuildError(
          `У файла «${file.fileName}» две страницы с индексом ${page.filePageIndex}.`,
          revisionId,
        );
      }
      index.set(key, page.sourcePageId);
    }
  }
  return index;
}

function pageKey(sourceFileId: string, filePageIndex: number): string {
  return `${sourceFileId}:${filePageIndex}`;
}

/**
 * Строка карты для страницы рабочего документа.
 *
 * Отсутствие страницы — отказ, а не пропуск: карта с дырой означала бы
 * страницу рабочего PDF, которой не соответствует ничего в оригиналах, и
 * обнаружилось бы это при разборе замечания, то есть через недели.
 */
function pageIdOf(
  index: ReadonlyMap<string, string>,
  entry: WorkingPageMapping,
  revisionId: string,
): string {
  const id = index.get(pageKey(entry.sourceFileId, entry.filePageIndex));
  if (id === undefined) {
    throw new BundleBuildError(
      `Странице ${entry.workingPageIndex} рабочего документа не найдено соответствие ` +
        `(файл ${entry.sourceFileId}, страница ${entry.filePageIndex}).`,
      revisionId,
    );
  }
  return id;
}

/**
 * Кооперативная отмена (§12).
 *
 * Проверяется между файлами, а не внутри склейки: оборвать внешний процесс или
 * работу библиотеки сигнал всё равно не может, а вот не начинать скачивание
 * следующих 80 МБ при остановке воркера — может.
 */
function throwIfAborted(ctx: JobContext<'bundle.build'>, revisionId: string): void {
  if (ctx.signal.aborted) {
    throw new BundleBuildError(
      'Сборка рабочего документа прервана: воркер останавливается или истекла аренда задачи.',
      revisionId,
    );
  }
}
