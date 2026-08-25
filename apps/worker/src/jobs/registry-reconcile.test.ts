/**
 * Обработчик `registry.reconcile` на портах (S20).
 *
 * Проверяется не «сходятся ли номера» — это дело `transfer-registry.test.ts`, —
 * а решения ЗАДАЧИ: что она считает отказом, что состоянием мира, как относит
 * лишние документы и как сводит результат по каждому комплекту отдельно.
 *
 * ## Почему «лишние документы» проверяются отдельным случаем
 *
 * `matchRegistryRows` вызывается по одной группе за раз и возвращает документы,
 * не названные строками ЭТОГО вызова. Объединить такие множества — значит
 * объявить лишним почти каждый документ комплекта: то, что назвала группа 1, не
 * названо группой 2. Дефект тихий (сверка «работает», просто врёт), поэтому
 * инвариант проверяется прямо.
 */

import { describe, expect, it, vi } from 'vitest';
import type { JobContext, LogicalDocumentView, SegmentationInput } from '@id/api';
import {
  createRegistryReconcileHandler,
  ReconcileStateError,
  type RegistryReconcileDeps,
} from './registry-reconcile.js';

const REGISTRY = 'reg-1';
const OBJECT = 'obj-1';
const SCAN_WORK = 'work-scan';
const SCAN_REV = 'rev-scan';
const WORK_A = 'work-a';
const REV_A = 'rev-a';
const WORK_B = 'work-b';
const REV_B = 'rev-b';

/** Опись формы Б: две группы, у каждой свой акт и свои приложения. */
const OPIS = [
  '| № | № п/п | Наименование документа | Номер документа (шифр) | Организация составившая документ | Дата составления или срок действия | Кол-во листов, шт | Страница по списку |',
  '|---|---|---|---|---|---|---|---|',
  '| Устройство шпунта (ООО "Альфа") |  |  |  |  |  |  |  |',
  '| 1 | 1.1 | АОСР Устройство шпунта | №А-01 | ООО "Альфа" | от 02.08.2024 | 1 | 1 |',
  '|  | 1.2 | Сертификат соответствия | №С-11 | ООО "Альфа" | от 03.08.2024 | 1 | 2 |',
  '| Опорная стойка (ООО "Бета") |  |  |  |  |  |  |  |',
  '| 2 | 2.1 | АОСР Опорная стойка | №Б-01 | ООО "Бета" | от 04.08.2024 | 1 | 3 |',
  '|  | 2.2 | Паспорт качества | №П-22 | ООО "Бета" | от 05.08.2024 | 2 | 4-5 |',
].join('\n');

function document(
  over: Partial<LogicalDocumentView> & { id: string; revisionId: string },
): LogicalDocumentView {
  return {
    objectId: OBJECT,
    contractorId: 'org-a',
    docTypeCode: 'cert_conformity',
    ordinal: 1,
    title: null,
    folderGroup: null,
    typeConfidence: null,
    boundaryConfidence: null,
    needsReview: false,
    isConfirmed: false,
    confirmationSource: 'human',
    confirmedBy: null,
    confirmedAt: null,
    version: 0,
    pageCount: 1,
    ...over,
  };
}

const DOCUMENTS: readonly LogicalDocumentView[] = [
  document({ id: 'doc-a-act', revisionId: REV_A, docTypeCode: 'aosr', ordinal: 1 }),
  document({ id: 'doc-a-cert', revisionId: REV_A, ordinal: 2 }),
  document({ id: 'doc-a-extra', revisionId: REV_A, ordinal: 3 }),
  document({
    id: 'doc-b-act',
    revisionId: REV_B,
    docTypeCode: 'aosr',
    contractorId: 'org-b',
    ordinal: 1,
  }),
  document({
    id: 'doc-b-passport',
    revisionId: REV_B,
    contractorId: 'org-b',
    ordinal: 2,
    pageCount: 2,
  }),
];

const NUMBERS: Record<string, string> = {
  'doc-a-act': 'А-01',
  'doc-a-cert': 'С-11',
  'doc-a-extra': 'Х-99',
  'doc-b-act': 'Б-01',
  'doc-b-passport': 'П-22',
};

function pages(text: string): SegmentationInput {
  return {
    recognitionRunId: 'run-1',
    pages: [
      {
        sourcePageId: 'p1',
        revisionOrdinal: 0,
        sourceFileId: 'f1',
        filePageIndex: 0,
        workingPageIndex: 0,
        pageTextVersionId: 'ptv-1',
        text,
        blockTypes: ['text'],
        rotation: 0,
        manual: null,
      },
    ],
  };
}

interface Saved {
  input: Parameters<RegistryReconcileDeps['save']>[0];
}

function deps(over: Partial<RegistryReconcileDeps> = {}): {
  deps: RegistryReconcileDeps;
  saved: Saved;
} {
  const saved = {} as Saved;

  const base: RegistryReconcileDeps = {
    findScan: async () => ({
      workId: SCAN_WORK,
      objectId: OBJECT,
      kind: 'registry',
      registryId: REGISTRY,
      currentRevisionId: SCAN_REV,
    }),
    findRegistry: async () => ({ id: REGISTRY, objectId: OBJECT, number: '8', folderNo: '4' }),
    loadPages: async () => pages(OPIS),
    listComplectRevisions: async () => [
      {
        workId: WORK_A,
        revisionId: REV_A,
        objectId: OBJECT,
        contractorId: 'org-a',
        managedByContractorId: 'org-a',
        title: 'Устройство шпунта',
      },
      {
        workId: WORK_B,
        revisionId: REV_B,
        objectId: OBJECT,
        contractorId: 'org-b',
        managedByContractorId: 'org-b',
        title: 'Опорная стойка',
      },
    ],
    listContractorNames: async () =>
      new Map([
        ['org-a', 'ООО "Альфа"'],
        ['org-b', 'ООО "Бета"'],
      ]),
    listDocuments: async () => DOCUMENTS,
    listFieldValues: async (_objectId, revisionIds) =>
      DOCUMENTS.filter((doc) => revisionIds.includes(doc.revisionId)).flatMap((doc) => [
        {
          documentId: doc.id,
          revisionId: doc.revisionId,
          fieldCode: 'number',
          valueText: NUMBERS[doc.id] ?? null,
          valueDate: null,
        },
      ]),
    save: async (input) => {
      saved.input = input;
      return {
        id: 'recon-1',
        registryId: input.registryId,
        revisionId: input.revisionId,
        verdict: input.verdict,
        version: 0,
        headerRegistryNo: input.headerRegistryNo,
        headerFolderNo: input.headerFolderNo,
        headerMismatch: input.headerMismatch,
        parserVersion: input.parserVersion,
        matcherVersion: input.matcherVersion,
        finishedAt: '2026-08-23T00:00:00Z',
        groupsTotal: input.groups.length,
        groupsMatched: input.groups.filter((g) => g.matchState === 'matched').length,
        groupsMissing: input.groups.filter((g) => g.matchState === 'missing').length,
        groupsAmbiguous: input.groups.filter((g) => g.matchState === 'ambiguous').length,
        rowsTotal: input.rows.length,
        rowsMatched: input.rows.filter((r) => r.matchState === 'matched').length,
        rowsMissing: input.rows.filter((r) => r.matchState === 'missing').length,
        rowsAmbiguous: input.rows.filter((r) => r.matchState === 'ambiguous').length,
        rowsFieldMismatch: input.rows.filter((r) => r.fieldMismatches.length > 0).length,
        worksTotal: input.works.length,
        worksExtra: input.works.filter((w) => w.state === 'extra').length,
        extraDocuments: input.extraDocuments.length,
        warnings: [...input.warnings],
        reviewedBy: null,
        reviewedAt: null,
        reviewedNote: null,
      };
    },
    emit: async () => undefined,
    ...over,
  };

  return { deps: base, saved };
}

function context(): JobContext<'registry.reconcile'> {
  return {
    payload: { registryId: REGISTRY },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as JobContext<'registry.reconcile'>;
}

async function run(over: Partial<RegistryReconcileDeps> = {}): Promise<Saved> {
  const { deps: port, saved } = deps(over);
  await createRegistryReconcileHandler(port)(context());
  return saved;
}

describe('registry.reconcile', () => {
  it('сводит результат по КАЖДОМУ комплекту отдельно', async () => {
    const saved = await run();

    expect(saved.input.works).toHaveLength(2);
    const a = saved.input.works.find((work) => work.workId === WORK_A);
    const b = saved.input.works.find((work) => work.workId === WORK_B);

    // У комплекта А лишний документ — вердикт `mismatch`; у Б расхождений нет.
    expect(a?.state).toBe('matched');
    expect(a?.extraDocuments).toBe(1);
    expect(a?.verdict).toBe('mismatch');
    expect(b?.verdict).toBe('clean');
    expect(b?.rowsTotal).toBe(2);
    expect(b?.rowsMatched).toBe(2);
  });

  it('лишние документы считаются ПЕРЕСЕЧЕНИЕМ, а не объединением по группам', async () => {
    const saved = await run();

    // Документов пять, названы описью четыре. Если бы множества «не названных
    // этой группой» объединялись, лишними оказались бы почти все.
    expect(saved.input.extraDocuments.map((doc) => doc.documentId)).toStrictEqual(['doc-a-extra']);
    expect(saved.input.extraDocuments[0]?.workId).toBe(WORK_A);
    expect(saved.input.extraDocuments[0]?.contractorId).toBe('org-a');
  });

  it('строка описи несёт комплект и исполнителя: по ним её отдают подрядчику', async () => {
    const saved = await run();
    const rows = saved.input.rows;

    expect(rows.filter((row) => row.workId === WORK_A)).toHaveLength(2);
    expect(rows.filter((row) => row.workId === WORK_B)).toHaveLength(2);
    expect(rows.every((row) => row.contractorId !== null)).toBe(true);
  });

  it('расхождение числа листов поднимается, а пустой реквизит — нет', async () => {
    const saved = await run({
      listDocuments: async () =>
        DOCUMENTS.map((doc) => (doc.id === 'doc-b-passport' ? { ...doc, pageCount: 7 } : doc)),
    });

    const row = saved.input.rows.find((item) => item.docNoRaw === 'П-22');
    expect(row?.fieldMismatches).toStrictEqual(['sheets']);

    // У остальных строк реквизиты документа не извлечены вовсе — это «не
    // извлечено», а не «не совпало», и расхождением быть не может.
    const cert = saved.input.rows.find((item) => item.docNoRaw === 'С-11');
    expect(cert?.fieldMismatches).toStrictEqual([]);
  });

  it('расхождение даты поднимается только при обеих заполненных', async () => {
    const saved = await run({
      listFieldValues: async () => [
        {
          documentId: 'doc-b-passport',
          revisionId: REV_B,
          fieldCode: 'number',
          valueText: 'П-22',
          valueDate: null,
        },
        {
          documentId: 'doc-b-passport',
          revisionId: REV_B,
          fieldCode: 'issued_at',
          valueText: null,
          valueDate: '2020-01-01',
        },
      ],
    });

    const row = saved.input.rows.find((item) => item.docNoRaw === 'П-22');
    expect(row?.fieldMismatches).toContain('issued_at');
  });

  it('комплект, не названный описью, получает state=extra и свой вердикт', async () => {
    const saved = await run({
      listComplectRevisions: async () => [
        {
          workId: WORK_A,
          revisionId: REV_A,
          objectId: OBJECT,
          contractorId: 'org-a',
          managedByContractorId: 'org-a',
          title: 'Устройство шпунта',
        },
        {
          workId: 'work-c',
          revisionId: 'rev-c',
          objectId: OBJECT,
          contractorId: 'org-c',
          managedByContractorId: 'org-c',
          title: 'Работа, которой нет в описи',
        },
      ],
    });

    const extra = saved.input.works.find((work) => work.workId === 'work-c');
    expect(extra?.state).toBe('extra');
    expect(extra?.verdict).toBe('mismatch');
    expect(saved.input.verdict).toBe('mismatch');
  });

  it('расхождение шапки описи с карточкой реестра — расхождение папки', async () => {
    const saved = await run({
      loadPages: async () => pages(`Реестр исполнительной документации №8\n\n${OPIS}`),
      findRegistry: async () => ({
        id: REGISTRY,
        objectId: OBJECT,
        number: '99',
        folderNo: null,
      }),
    });

    expect(saved.input.headerRegistryNo).toBe('8');
    expect(saved.input.headerMismatch).toBe(true);
    expect(saved.input.verdict).toBe('mismatch');
  });

  it('незаполненная шапка расхождением НЕ считается', async () => {
    // В форме А номера реестра на бумаге может не быть вовсе. Считать это
    // расхождением значило бы обвинить папку в дефекте оформления, которого
    // нет, — тот же открытый мир, что и у пустого реквизита.
    const saved = await run({
      findRegistry: async () => ({ id: REGISTRY, objectId: OBJECT, number: '99', folderNo: '99' }),
    });

    expect(saved.input.headerRegistryNo).toBeNull();
    expect(saved.input.headerMismatch).toBe(false);
  });

  it('распознавания не было — вердикт unparsed, а не отказ задачи', async () => {
    const saved = await run({
      loadPages: async () => ({ recognitionRunId: null, pages: [] }),
    });

    expect(saved.input.verdict).toBe('unparsed');
    expect(saved.input.warnings.join(' ')).toContain('распознавания');
    expect(saved.input.rows).toHaveLength(0);
  });

  it('прогон есть, страниц нет — нерепробируемый отказ', async () => {
    const { deps: port } = deps({
      loadPages: async () => ({ recognitionRunId: 'run-1', pages: [] }),
    });

    await expect(createRegistryReconcileHandler(port)(context())).rejects.toThrow(
      ReconcileStateError,
    );
  });

  it('опись разобрана в ноль строк при непустом составе — unparsed, а не clean', async () => {
    const saved = await run({ loadPages: async () => pages('Ни одной таблицы здесь нет.') });

    expect(saved.input.rows).toHaveLength(0);
    expect(saved.input.verdict).toBe('unparsed');
  });

  it('файла описи нет — задача отказывает и не пишет ничего', async () => {
    const save = vi.fn();
    const { deps: port } = deps({ findScan: async () => null, save });

    await expect(createRegistryReconcileHandler(port)(context())).rejects.toThrow(
      ReconcileStateError,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('комплект, найденный по папке, обязан быть файлом описи', async () => {
    const { deps: port } = deps({
      findScan: async () => ({
        workId: SCAN_WORK,
        objectId: OBJECT,
        kind: 'complect',
        registryId: REGISTRY,
        currentRevisionId: SCAN_REV,
      }),
    });

    await expect(createRegistryReconcileHandler(port)(context())).rejects.toThrow(
      ReconcileStateError,
    );
  });

  it('строки несопоставленной группы матчеру не показываются', async () => {
    const saved = await run({
      listComplectRevisions: async () => [
        {
          workId: WORK_A,
          revisionId: REV_A,
          objectId: OBJECT,
          contractorId: 'org-a',
          managedByContractorId: 'org-a',
          title: 'Устройство шпунта',
        },
      ],
    });

    // Группа «Опорная стойка» комплекта не нашла: её строки получают `missing`
    // с СОБСТВЕННОЙ причиной, а не «документ не найден».
    const orphan = saved.input.rows.filter((row) => row.workId === null);
    expect(orphan).toHaveLength(2);
    expect(orphan.every((row) => row.reason.includes('группа описи'))).toBe(true);
    expect(orphan.every((row) => row.matchedDocumentId === null)).toBe(true);
  });
});
