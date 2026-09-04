/**
 * Сборка тела снимка из строк портала — и три проверки, которых до сих пор не было.
 *
 * Функция чистая: на вход уже загруженные строки, на выход тело контракта и
 * перечень предупреждений. Ни БД, ни сети здесь нет намеренно — канонический
 * хеш §13 обязан проверяться эталонными примерами, а для этого сборка тела
 * должна быть воспроизводима без единого внешнего вызова.
 *
 * ## Почему отсев вырожденных блоков обязателен
 *
 * Контракт требует строгого `x0 < x1` и `y0 < y1` (§5), а наш CHECK допускает
 * равенство (`layout_blocks_coords_chk`, миграция 0004), и вырожденный блок в
 * базе реален: `boxesToNorm` клампит бокс, целиком уехавший за край страницы, а
 * флаг `degenerate_geometry` в `layout/attention.ts` заведён ровно под это
 * явление. Отправить такой блок нельзя, и цена ошибки несоразмерна: §5 отвергает
 * **весь манифест** (`invalid_manifest`), то есть один кривой блок стоил бы
 * комплекта на 220 страниц. Распознать его всё равно нечем — вырез вырожден.
 *
 * Поэтому блок выбрасывается из снимка, а прогон получает предупреждение с
 * номером страницы. Молча — нельзя: «блок пропал» и «блок не распознался» на
 * экране обязаны различаться.
 *
 * ## Почему габаритный прямоугольник полигона пересчитывается
 *
 * Контракт требует, чтобы `coords_norm` полигона описывал его габаритный
 * прямоугольник (§5). У нас координаты и точки пишутся независимо: ни
 * `createLayoutBlock`, ни `updateLayoutBlock` bbox из точек не пересчитывают, и
 * после правки формы прямоугольник может отстать. Считаем здесь — по точкам,
 * которые и есть форма.
 */
import {
  EXEC_SYNC_LIMITS,
  EXEC_SYNC_SCHEMA_VERSION,
  COORDINATE_SPACE,
  SNAPSHOT_MODE,
  type ExecSyncBlock,
  type ExecSyncMetadataValue,
  type ExecSyncSnapshotBody,
} from '@id/execsync';
import type { BlockType, RecognitionWarning, ShapeType } from '@id/contracts';

/** Блок портала в том виде, в каком он участвует в снимке. */
export interface SnapshotBlockInput {
  readonly externalBlockId: string;
  readonly revision: number;
  readonly workingPageIndex: number;
  readonly blockType: BlockType;
  readonly shapeType: ShapeType;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly sortOrder: number;
  readonly displayName: string | null;
  /**
   * Поправка разворота скана (ADR-0020), если она есть у страницы блока.
   *
   * Уезжает в `metadata`, а не в геометрию: вырез строит RD WEB, и величину,
   * которой ему не хватает, честнее передать, чем додумывать за него поворот.
   * По §7 правка одной `metadata` — это `metadata_only`, повторного
   * распознавания она не вызывает, то есть добавление безопасно.
   */
  readonly contentRotation: number;
  readonly forceReprocess: boolean;
}

export interface SnapshotDocumentInput {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly pageCount: number;
}

export interface BuildSnapshotInput {
  readonly externalSyncId: string;
  readonly externalProjectId: string;
  readonly projectName: string;
  readonly externalDocumentId: string;
  readonly documentName: string;
  readonly documentRevision: string;
  readonly baseGeneration: number;
  readonly syncGeneration: number;
  readonly document: SnapshotDocumentInput;
  readonly blocks: readonly SnapshotBlockInput[];
}

export interface BuildSnapshotResult {
  readonly body: ExecSyncSnapshotBody;
  readonly warnings: readonly RecognitionWarning[];
  /** Внешние идентификаторы блоков, не попавших в снимок. */
  readonly skipped: readonly string[];
}

/** Отказ сборки: снимок негоден и повтор его не исправит. */
export class SnapshotBuildError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = 'SnapshotBuildError';
  }
}

/** Минимальная сторона блока: ниже неё вырез вырожден и в каноне схлопнется. */
const MIN_SIDE = 1e-6;

function bboxOfPoints(
  points: readonly { readonly x: number; readonly y: number }[],
): [number, number, number, number] {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  return [x0, y0, x1, y1];
}

function warning(code: string, message: string, page: number | null): RecognitionWarning {
  return { code, message, workingPageIndex: page };
}

/**
 * Предполёт по лимитам §12 — ДО сборки тела и до единого байта трафика.
 *
 * Наши собственные потолки считаются НА ФАЙЛ (`MAX_UPLOAD_BYTES`,
 * `MAX_PAGES_PER_FILE`), а отправляем мы склейку: пять файлов по пятьсот
 * страниц дают 2500 при потолке контракта 2000, а два файла по 150 МиБ — 300
 * МиБ при потолке 256. То есть наши границы про эти не говорят ничего, и без
 * своей проверки портал узнавал бы о переполнении ответом 413 — после того, как
 * 86 МБ уже уехали по сети.
 *
 * Тот же приём и тот же довод, что у `bundle.build`, который отказывает по
 * блокерам до скачивания файлов.
 */
function assertWithinLimits(input: BuildSnapshotInput, blocks: readonly ExecSyncBlock[]): void {
  const problems: string[] = [];
  if (input.document.sizeBytes > EXEC_SYNC_LIMITS.documentBytes) {
    problems.push(
      `рабочий PDF ${String(input.document.sizeBytes)} байт при потолке ` +
        `${String(EXEC_SYNC_LIMITS.documentBytes)}`,
    );
  }
  if (input.document.pageCount > EXEC_SYNC_LIMITS.pageCount) {
    problems.push(
      `${String(input.document.pageCount)} страниц при потолке ` +
        `${String(EXEC_SYNC_LIMITS.pageCount)}`,
    );
  }
  if (blocks.length > EXEC_SYNC_LIMITS.blockCount) {
    problems.push(
      `${String(blocks.length)} блоков при потолке ${String(EXEC_SYNC_LIMITS.blockCount)}`,
    );
  }
  for (const id of [input.externalProjectId, input.externalDocumentId, input.externalSyncId]) {
    if (id.length > EXEC_SYNC_LIMITS.externalIdLength) {
      problems.push(
        `идентификатор «${id.slice(0, 32)}…» длиннее ${String(EXEC_SYNC_LIMITS.externalIdLength)} символов`,
      );
    }
  }
  if (problems.length > 0) {
    throw new SnapshotBuildError(
      `Комплект не укладывается в ограничения RD WEB: ${problems.join('; ')}. ` +
        'Разделите папку или согласуйте лимиты с эксплуатацией RD WEB.',
    );
  }
}

export function buildSnapshotBody(input: BuildSnapshotInput): BuildSnapshotResult {
  const warnings: RecognitionWarning[] = [];
  const skipped: string[] = [];
  const blocks: ExecSyncBlock[] = [];

  for (const block of input.blocks) {
    if (block.workingPageIndex >= input.document.pageCount) {
      // Блок за пределами числа страниц отвергается контрактом целиком (§5).
      skipped.push(block.externalBlockId);
      warnings.push(
        warning(
          'block_page_out_of_range',
          `Блок ссылается на лист ${String(block.workingPageIndex + 1)}, которого нет в рабочем документе.`,
          block.workingPageIndex,
        ),
      );
      continue;
    }

    const isPolygon = block.shapeType === 'polygon' && block.points.length >= 3;
    let polygonPoints: [number, number][] | null = null;
    let coords: [number, number, number, number] = [block.x0, block.y0, block.x1, block.y1];

    if (block.shapeType === 'polygon') {
      if (block.points.length < 3) {
        // Полигон из двух точек — не форма. Деградируем в прямоугольник, а не
        // отвергаем: габаритный прямоугольник у него всё равно есть, и он
        // описывает вырез не хуже, чем отсутствие блока.
        warnings.push(
          warning(
            'polygon_degraded',
            `Полигон блока содержит ${String(block.points.length)} точек — отправлен прямоугольником.`,
            block.workingPageIndex,
          ),
        );
      } else if (block.points.length > EXEC_SYNC_LIMITS.polygonPoints) {
        // Прореживать контур нельзя: маску по нему строит ИХ сторона, и наше
        // прореживание изменило бы вход модели незаметно для всех.
        warnings.push(
          warning(
            'polygon_too_many_points',
            `Полигон блока содержит ${String(block.points.length)} точек при потолке ` +
              `${String(EXEC_SYNC_LIMITS.polygonPoints)} — отправлен прямоугольником.`,
            block.workingPageIndex,
          ),
        );
      } else {
        polygonPoints = block.points.map((point) => [point.x, point.y]);
        coords = bboxOfPoints(block.points);
      }
    }

    if (!(coords[2] - coords[0] > MIN_SIDE) || !(coords[3] - coords[1] > MIN_SIDE)) {
      skipped.push(block.externalBlockId);
      warnings.push(
        warning(
          'block_degenerate_geometry',
          `Блок на листе ${String(block.workingPageIndex + 1)} вырожден по стороне и не отправлен: ` +
            'контракт RD WEB отвергает такой манифест целиком.',
          block.workingPageIndex,
        ),
      );
      continue;
    }

    const metadata: Record<string, ExecSyncMetadataValue> = {};
    if (block.contentRotation !== 0) {
      metadata['content_rotation'] = block.contentRotation;
    }

    blocks.push({
      external_block_id: block.externalBlockId,
      revision: block.revision,
      page_index: block.workingPageIndex,
      block_type: block.blockType,
      // Форма объявляется по тому, что реально уехало: полигон, у которого точки
      // не прошли, — это прямоугольник, и назвать его полигоном значило бы
      // соврать в поле, по которому их сторона выбирает способ выреза.
      shape_type: isPolygon && polygonPoints !== null ? 'polygon' : 'rectangle',
      coords_norm: coords,
      polygon_points: polygonPoints,
      linked_external_block_id: null,
      display_name: block.displayName,
      sort_order: block.sortOrder,
      force_reprocess: block.forceReprocess,
      metadata,
    });
  }

  assertWithinLimits(input, blocks);

  if (blocks.length === 0) {
    throw new SnapshotBuildError(
      'В снимке не осталось ни одного пригодного блока: распознавать нечего.',
    );
  }

  const body: ExecSyncSnapshotBody = {
    schema_version: EXEC_SYNC_SCHEMA_VERSION,
    external_sync_id: input.externalSyncId,
    external_project_id: input.externalProjectId,
    project_name: input.projectName,
    external_document_id: input.externalDocumentId,
    document_name: input.documentName,
    document_revision: input.documentRevision,
    base_generation: input.baseGeneration,
    sync_generation: input.syncGeneration,
    snapshot_mode: SNAPSHOT_MODE,
    coordinate_space: COORDINATE_SPACE,
    document: {
      file_name: input.document.fileName,
      mime_type: 'application/pdf',
      size_bytes: input.document.sizeBytes,
      sha256: input.document.sha256,
      page_count: input.document.pageCount,
    },
    blocks,
  };

  const rotated = new Set(
    input.blocks.filter((block) => block.contentRotation !== 0).map((b) => b.workingPageIndex),
  );
  if (rotated.size > 0) {
    /*
     * Страницы, где скан лёг боком (ADR-0020).
     *
     * На маршруте VLM поправку применяет построение кропа; здесь вырез строит
     * RD WEB, и о поправке он не знает. Величину мы передали в `metadata`, но
     * обязать их ею воспользоваться не можем — значит риск обязан быть виден.
     * Молчаливая деградация качества на повёрнутых листах — ровно тот случай,
     * который ADR-0020 описывает по реальному комплекту: модель сняла строчный
     * текст и потеряла таблицу целиком.
     */
    warnings.push(
      warning(
        'content_rotation_unsupported',
        `Скан лёг боком на ${String(rotated.size)} листах; RD WEB строит вырез по контракту без ` +
          'нашей поправки разворота — качество на этих листах требует проверки.',
        null,
      ),
    );
  }

  return { body, warnings, skipped };
}
