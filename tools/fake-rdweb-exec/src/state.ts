/**
 * Состояние двойника: документы, объявленные блоки, отправки и их планы.
 *
 * Правила §7 («что вызывает повторное распознавание») реализованы здесь, а не в
 * маршрутах, потому что именно они — предмет проверки. Портал обязан построить
 * снимок так, чтобы неизменившийся блок оказался `unchanged`, а подвинутая рамка
 * — `recognition_required`; двойник это решает по СОДЕРЖИМОМУ снимка, как и
 * настоящий сервер, а не по подсказке теста.
 */
import type { ExecSyncBlock, ExecSyncSnapshotBody } from '@id/execsync';

export type BlockStatus =
  'success' | 'suspicious' | 'error' | 'non_retriable' | 'reused' | 'unchanged' | 'deleted';

export type ReconciliationAction =
  'unchanged' | 'metadata_only' | 'recognition_required' | 'reuse_result_without_model' | 'deleted';

export interface DeclaredBlock {
  readonly revision: number;
  /** Каноническая часть, влияющая на вырез. Её изменение требует распознавания. */
  readonly recognitionKey: string;
  /** Часть, не влияющая на вырез: имя, порядок, metadata. */
  readonly metadataKey: string;
  status: BlockStatus;
  action: ReconciliationAction;
  reason: readonly string[];
  reusedWithoutModel: boolean;
  ocrMarkdown: string | null;
  ocrJson: unknown;
  blockType: 'text' | 'image' | 'stamp';
  pageIndex: number;
  deleted: boolean;
  /** Последнее объявленное тело блока: вход фабрики результата. */
  declared: ExecSyncBlock;
}

export interface DocumentState {
  readonly externalDocumentId: string;
  readonly externalProjectId: string;
  /** Последняя ПРИНЯТАЯ генерация. */
  generation: number;
  readonly blocks: Map<string, DeclaredBlock>;
  /** PDF, которые сервер уже видел: тот же файл не грузится дважды (§3). */
  readonly knownPdfSha: Set<string>;
}

export interface SyncState {
  readonly syncId: string;
  readonly externalSyncId: string;
  readonly externalDocumentId: string;
  readonly manifestSha256: string;
  readonly syncGeneration: number;
  readonly baseGeneration: number;
  readonly documentSha256: string;
  state: string;
  uploadToken: string | null;
  uploadRequired: boolean;
  uploaded: boolean;
  pollsLeft: number;
  counters: Record<string, number>;
}

/** Что двойник обязан подсунуть вместо штатного поведения. */
export interface FakeExecFaults {
  /** Внешние идентификаторы блоков, которым выдаётся `suspicious`. */
  suspiciousBlocks: readonly string[];
  /** Внешние идентификаторы блоков, которым выдаётся отказ. */
  failingBlocks: readonly string[];
  /** Следующая отправка завершится `superseded`. */
  supersedeNext: boolean;
  /** Следующая отправка завершится `error`. */
  errorNext: boolean;
  /** Ответить 429 на следующий вызов init и назвать Retry-After. */
  rateLimitNextInit: number | null;
}

export const EMPTY_FAULTS: FakeExecFaults = {
  suspiciousBlocks: [],
  failingBlocks: [],
  supersedeNext: false,
  errorNext: false,
  rateLimitNextInit: null,
};

/**
 * Ключ «влияет ли на вырез».
 *
 * §7 относит к `metadata_only` ровно три поля: `display_name`, `sort_order` и
 * `metadata`. Всё остальное — геометрия, тип, страница, полигон, связь — меняет
 * вырез и требует распознавания. Разделение выражено двумя ключами, а не
 * сравнением объектов целиком: иначе «правка только имени» была бы неотличима
 * от «сдвинули рамку», и главный экономический инвариант контракта перестал бы
 * проверяться.
 */
export function recognitionKeyOf(block: ExecSyncBlock): string {
  return JSON.stringify([
    block.page_index,
    block.block_type,
    block.shape_type,
    block.coords_norm,
    block.polygon_points,
    block.linked_external_block_id,
  ]);
}

export function metadataKeyOf(block: ExecSyncBlock): string {
  return JSON.stringify([block.display_name, block.sort_order, block.metadata]);
}

export interface ResultFactory {
  (block: ExecSyncBlock): { ocrMarkdown: string | null; ocrJson: unknown };
}

/** Правдоподобный результат по типу блока. Тесты вправе подменить. */
export const defaultResultFactory: ResultFactory = (block) => {
  if (block.block_type === 'text') {
    return {
      ocrMarkdown: `Текст блока ${block.external_block_id} на листе ${String(block.page_index + 1)}`,
      ocrJson: null,
    };
  }
  if (block.block_type === 'image') {
    return {
      ocrMarkdown: null,
      ocrJson: {
        fragment_type: 'План',
        location: { grid_lines: null, zone_name: null, level_or_elevation: null },
        content_summary: `Фрагмент ${block.external_block_id}`,
        detailed_description: 'Описание фрагмента.',
        verification_recommendations: '',
        key_entities: [],
      },
    };
  }
  return {
    ocrMarkdown: null,
    ocrJson: {
      document_code: 'СТ26/01-14-ДК2-РД',
      project_name: 'Корпус 1',
      sheet_name: 'Лист',
      stage: 'РД',
      sheet_number: String(block.page_index + 1),
      total_sheets: '12',
      organization: 'ООО «Проект»',
      signatures: [],
      revisions: [],
    },
  };
};

export class FakeExecState {
  readonly documents = new Map<string, DocumentState>();
  readonly syncs = new Map<string, SyncState>();
  /** Тела отправок по `external_sync_id`: ключ идемпотентности §9. */
  readonly bodiesBySyncId = new Map<string, string>();
  readonly uploads = new Map<string, { syncId: string; sha256: string | null }>();
  readonly calls: { method: string; path: string; requestId: string | null }[] = [];
  faults: FakeExecFaults = { ...EMPTY_FAULTS };
  resultFactory: ResultFactory = defaultResultFactory;
  pollsBeforeTerminal: number;

  constructor(pollsBeforeTerminal: number) {
    this.pollsBeforeTerminal = pollsBeforeTerminal;
  }

  documentOf(body: ExecSyncSnapshotBody): DocumentState {
    const existing = this.documents.get(body.external_document_id);
    if (existing !== undefined) return existing;
    const created: DocumentState = {
      externalDocumentId: body.external_document_id,
      externalProjectId: body.external_project_id,
      generation: 0,
      blocks: new Map(),
      knownPdfSha: new Set(),
    };
    this.documents.set(created.externalDocumentId, created);
    return created;
  }

  /**
   * Сверка снимка с прошлым состоянием документа — §7 дословно.
   *
   * Возвращает решения по каждому блоку. Результаты при этом ещё не
   * появляются: они рождаются на `complete`, когда работа считается принятой.
   */
  reconcile(document: DocumentState, body: ExecSyncSnapshotBody): void {
    const seen = new Set<string>();

    for (const block of body.blocks) {
      seen.add(block.external_block_id);
      const recognitionKey = recognitionKeyOf(block);
      const metadataKey = metadataKeyOf(block);
      const previous = document.blocks.get(block.external_block_id);

      if (previous === undefined) {
        document.blocks.set(block.external_block_id, {
          revision: block.revision,
          recognitionKey,
          metadataKey,
          status: 'success',
          action: 'recognition_required',
          reason: ['new_block'],
          reusedWithoutModel: false,
          ocrMarkdown: null,
          ocrJson: null,
          blockType: block.block_type,
          pageIndex: block.page_index,
          deleted: false,
          declared: block,
        });
        continue;
      }

      const geometryChanged = previous.recognitionKey !== recognitionKey;
      const metadataChanged = previous.metadataKey !== metadataKey;

      const next: DeclaredBlock = {
        ...previous,
        revision: block.revision,
        recognitionKey,
        metadataKey,
        blockType: block.block_type,
        pageIndex: block.page_index,
        deleted: false,
        reusedWithoutModel: false,
        declared: block,
      };

      if (block.force_reprocess) {
        next.action = 'recognition_required';
        next.reason = ['forced_reprocess'];
      } else if (geometryChanged) {
        next.action = 'recognition_required';
        next.reason = ['geometry_changed'];
      } else if (metadataChanged) {
        next.action = 'metadata_only';
        next.reason = ['metadata_only'];
        next.status = 'unchanged';
      } else {
        next.action = 'unchanged';
        next.reason = [];
        next.status = 'unchanged';
      }
      document.blocks.set(block.external_block_id, next);
    }

    // Блок, которого нет в новом снимке, считается удалённым, но строка
    // остаётся: «блока нет, потому что вы его удалили» и «блока нет, потому что
    // мы его потеряли» — разные факты (§14).
    for (const [id, block] of document.blocks) {
      if (seen.has(id)) continue;
      block.deleted = true;
      block.status = 'deleted';
      block.action = 'deleted';
      block.reason = [];
    }
  }

  /**
   * Распознавание: выполняется на `complete`, как и у настоящего сервера.
   *
   * Идёт по СОСТОЯНИЮ документа, а не по телу отправки: тело не хранится, а
   * восстановленное по состоянию теряло бы поля блока — и фабрика результата
   * получала бы не тот блок, для которого его зовут.
   */
  recognize(document: DocumentState): Record<string, number> {
    const counters = { recognized: 0, unchanged: 0, suspicious: 0, failed: 0 };
    for (const [externalBlockId, declared] of document.blocks) {
      if (declared.deleted) continue;

      if (declared.action === 'unchanged' || declared.action === 'metadata_only') {
        counters.unchanged += 1;
        continue;
      }

      if (this.faults.failingBlocks.includes(externalBlockId)) {
        declared.status = 'error';
        declared.ocrMarkdown = null;
        declared.ocrJson = null;
        counters.failed += 1;
        continue;
      }

      const produced = this.resultFactory(declared.declared);
      declared.ocrMarkdown = produced.ocrMarkdown;
      declared.ocrJson = produced.ocrJson;
      if (this.faults.suspiciousBlocks.includes(externalBlockId)) {
        declared.status = 'suspicious';
        counters.suspicious += 1;
      } else {
        declared.status = 'success';
        counters.recognized += 1;
      }
    }
    return counters;
  }
}
