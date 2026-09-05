/**
 * Опись передачи в заданиях 17 и 18 (S47).
 *
 * Набор живёт отдельно от интеграционного прогона по той же причине, что и
 * `segmentation-graph.test.ts`: интеграция проходит цепочку целиком и не может
 * задать вход точечно, а вопрос здесь ровно один — как строки описи делятся по
 * комплектам и с чем каждая из них сверяется. Заглушки описывают только то,
 * что обработчик читает.
 */
import { describe, expect, it } from 'vitest';

import type {
  FieldValueView,
  JobContext,
  LogicalDocumentView,
  PageAssignmentView,
  RegistryRowView,
} from '@id/api';

import {
  createMatchRegistryHandler,
  createParseRegistryHandler,
  type SegmentationDeps,
} from './segmentation.js';

interface DocumentSpec {
  readonly id: string;
  readonly ordinal: number;
  readonly docTypeCode: string | null;
  readonly complectId?: string | null;
  readonly title?: string | null;
  readonly number?: string;
  readonly pages?: readonly string[];
}

/**
 * Опись формы Б: восемь граф, разделы — баннером с работой и исполнителем.
 *
 * Форма снята с боевой папки «ИД Мастер апрель 2026», значения синтетические.
 */
const TRANSFER_PAGE = [
  'Реестр исполнительной документации № 205 от 14.04.2026г.',
  '',
  '| № | № п/п | Наименование документа | Номер документа (шифр) | Организация составившая документ | Дата составления | Кол-во листов, шт | Страница по списку |',
  '|---|---|---|---|---|---|---|---|',
  '| Устройство шпатлевки стен (ООО "СИНТЕТИК") | | | | | | | |',
  '| 1 | 1.1 | АОСР Устройство шпатлевки стен | № 48-ОТ | ООО "СИНТЕТИК" | 10.04.2026г. | 1 | 1 |',
  '| | 1.2 | Паспорт | № 357 | ООО "ЗАВОД" | от 21.04.2025г. | 1 | 2 |',
  '| Устройство окраски стен (ООО "СИНТЕТИК") | | | | | | | |',
  '| 2 | 2.1 | АОСР Устройство окраски стен | № 49-ОТ | ООО "СИНТЕТИК" | 14.04.2026г. | 1 | 3 |',
  '| | 2.2 | Паспорт | № 357 | ООО "ЗАВОД" | от 21.04.2025г. | 1 | 4 |',
].join('\n');

function fieldsOf(spec: DocumentSpec): readonly FieldValueView[] {
  if (spec.number === undefined) return [];
  return [
    {
      id: `${spec.id}-number`,
      documentId: spec.id,
      fieldCode: 'number',
      valueText: spec.number,
      valueDate: null,
      valueNum: null,
      valueJson: null,
      confidence: 1,
      isVerified: false,
      extractorVersion: 'test',
      pageTextVersionId: null,
      charSpan: null,
      quote: null,
      extractedBy: 'rule',
    },
  ];
}

function ctxOf<T extends 'doc.parse_registry' | 'doc.match_registry'>(): JobContext<T> {
  return {
    payload: { folderId: 'folder-1' },
    logger: { info: () => undefined, warn: () => undefined },
    emit: () => Promise.resolve(),
    enqueue: () => Promise.resolve({ jobId: 'j', created: true }),
  } as unknown as JobContext<T>;
}

/** Разбор описи: возвращает строки, которые обработчик собрался записать. */
async function parsedRowsOf(
  documents: readonly DocumentSpec[],
  pageTexts: Readonly<Record<string, string>>,
): Promise<readonly Record<string, unknown>[]> {
  let saved: readonly Record<string, unknown>[] = [];

  const deps = {
    listDocuments: () =>
      Promise.resolve(
        documents.map(
          (spec) =>
            ({
              id: spec.id,
              ordinal: spec.ordinal,
              docTypeCode: spec.docTypeCode,
              complectId: spec.complectId ?? null,
              contractorId: 'contractor-1',
              title: spec.title ?? null,
            }) as LogicalDocumentView,
        ),
      ),
    loadPages: () =>
      Promise.resolve({
        pages: Object.entries(pageTexts).map(([sourcePageId, text]) => ({
          sourcePageId,
          pageTextVersionId: `${sourcePageId}-v1`,
          text,
        })),
      }),
    listPageAssignments: () =>
      Promise.resolve(
        documents.flatMap((spec, index) =>
          (spec.pages ?? []).map(
            (sourcePageId, position) =>
              ({
                sourcePageId,
                documentId: spec.id,
                sortOrder: index * 10 + position,
              }) as PageAssignmentView,
          ),
        ),
      ),
    listFieldValues: (documentId: string) =>
      Promise.resolve(fieldsOf(documents.find((spec) => spec.id === documentId) as DocumentSpec)),
    saveRegistryRows: (input: { readonly rows: readonly Record<string, unknown>[] }) => {
      if (input.rows.length > 0) saved = input.rows;
      return Promise.resolve({ removed: 0, written: input.rows.length });
    },
  } as unknown as SegmentationDeps;

  await createParseRegistryHandler(deps)(ctxOf<'doc.parse_registry'>());
  return saved;
}

describe('задание 17: опись передачи разбирается наравне с реестрами приложений', () => {
  const documents: readonly DocumentSpec[] = [
    { id: 'transfer', ordinal: 1, docTypeCode: 'transfer_registry', pages: ['p1'] },
    { id: 'act-1', ordinal: 2, docTypeCode: 'aosr', complectId: 'complect-1', number: '48-ОТ' },
    { id: 'act-2', ordinal: 3, docTypeCode: 'aosr', complectId: 'complect-2', number: '49-ОТ' },
  ];

  it('строки получают комплект своего раздела', async () => {
    const rows = await parsedRowsOf(documents, { p1: TRANSFER_PAGE });

    expect(rows.length).toBeGreaterThan(0);
    const complects = new Set(rows.map((row) => row['complectId']));
    // Разделов два, и оба нашли свой акт по номеру АОСР.
    expect(complects).toEqual(new Set(['complect-1', 'complect-2']));
  });

  it('раздел без своего акта оставляет строки без комплекта', async () => {
    const rows = await parsedRowsOf([documents[0] as DocumentSpec, documents[1] as DocumentSpec], {
      p1: TRANSFER_PAGE,
    });

    // Второй акт папке неизвестен: его строки сверятся со всей папкой.
    expect(rows.some((row) => row['complectId'] === null)).toBe(true);
    expect(rows.some((row) => row['complectId'] === 'complect-1')).toBe(true);
  });

  it('сквозной номер строки положителен и не повторяется', async () => {
    const rows = await parsedRowsOf(documents, { p1: TRANSFER_PAGE });
    const numbers = rows.map((row) => row['rowNo'] as number);

    expect(numbers.every((value) => value > 0)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

/** Сверка: возвращает решение по каждой строке в порядке входа. */
async function matchedStatesOf(
  documents: readonly DocumentSpec[],
  stored: readonly Partial<RegistryRowView>[],
): Promise<readonly { readonly id: string; readonly state: string }[]> {
  let decisions: readonly { readonly id: string; readonly state: string }[] = [];

  const deps = {
    listRegistryRows: () => Promise.resolve(stored as readonly RegistryRowView[]),
    listDocuments: () =>
      Promise.resolve(
        documents.map(
          (spec) =>
            ({
              id: spec.id,
              ordinal: spec.ordinal,
              docTypeCode: spec.docTypeCode,
              complectId: spec.complectId ?? null,
              contractorId: 'contractor-1',
              title: spec.title ?? null,
            }) as LogicalDocumentView,
        ),
      ),
    listFieldValues: (documentId: string) =>
      Promise.resolve(fieldsOf(documents.find((spec) => spec.id === documentId) as DocumentSpec)),
    saveRegistryMatches: (input: {
      readonly matches: readonly { readonly registryRowId: string; readonly matchState: string }[];
    }) => {
      decisions = input.matches.map((match) => ({
        id: match.registryRowId,
        state: match.matchState,
      }));
      return Promise.resolve({ updated: input.matches.length, skipped: 0 });
    },
  } as unknown as SegmentationDeps;

  await createMatchRegistryHandler(deps)(ctxOf<'doc.match_registry'>());
  return decisions;
}

describe('задание 18: строки описи сверяются со своим комплектом', () => {
  const documents: readonly DocumentSpec[] = [
    { id: 'transfer', ordinal: 1, docTypeCode: 'transfer_registry' },
    { id: 'act-1', ordinal: 2, docTypeCode: 'aosr', complectId: 'complect-1', number: '48-ОТ' },
    {
      id: 'passport-1',
      ordinal: 3,
      docTypeCode: 'quality_passport',
      complectId: 'complect-1',
      number: '357',
    },
    { id: 'act-2', ordinal: 4, docTypeCode: 'aosr', complectId: 'complect-2', number: '49-ОТ' },
    {
      id: 'passport-2',
      ordinal: 5,
      docTypeCode: 'quality_passport',
      complectId: 'complect-2',
      number: '357',
    },
  ];

  const row = (id: string, complectId: string | null): Partial<RegistryRowView> => ({
    id,
    documentId: 'transfer',
    ordinal: Number(id.slice(-1)),
    rowNo: Number(id.slice(-1)),
    sectionTitle: `раздел ${complectId ?? 'без акта'}`,
    docNameRaw: 'Паспорт',
    docNoRaw: '357',
    docNoNorm: '357',
    docNoFolded: '357',
    orgRaw: null,
    validFrom: null,
    validTo: null,
    issuedAt: null,
    matchedDocumentId: null,
    matchScore: null,
    matchState: 'missing',
    complectId,
    candidateDocumentIds: [],
  });

  it('одинаковые паспорта разных комплектов не становятся неоднозначными', async () => {
    // Именно ради этого строка описи несёт комплект: по всей папке номер 357
    // отвечает сразу двум документам, и сверка честно отказалась бы выбирать.
    const decisions = await matchedStatesOf(documents, [
      row('row-1', 'complect-1'),
      row('row-2', 'complect-2'),
    ]);

    expect(decisions).toEqual([
      { id: 'row-1', state: 'matched' },
      { id: 'row-2', state: 'matched' },
    ]);
  });

  it('строка раздела без акта ищется по всей папке и получает «неоднозначно»', async () => {
    const decisions = await matchedStatesOf(documents, [row('row-3', null)]);

    expect(decisions).toEqual([{ id: 'row-3', state: 'ambiguous' }]);
  });
});

describe('задание 18: реестр приложений — кандидат описи, а не исключение из неё (S53)', () => {
  /**
   * Опись перечисляет реестры приложений так же, как всё остальное.
   *
   * В папке «ИД Мастер апрель 2026» строка «Реестр к АОСР № 48-ОТ/-1 этаж»
   * стоит в каждом из двенадцати разделов, и ни одна из них документа не
   * нашла: выборка описи исключала ВСЕ разобранные перечни, а не только саму
   * опись. Портал объявлял двенадцать имеющихся реестров отсутствующими и
   * добавлял к ним двенадцать «документ папки не назван описью» — двадцать
   * четыре замечания об одном и том же несуществующем дефекте.
   */
  const documents: readonly DocumentSpec[] = [
    { id: 'transfer', ordinal: 1, docTypeCode: 'transfer_registry' },
    { id: 'act-1', ordinal: 2, docTypeCode: 'aosr', complectId: 'complect-1', number: '48-ОТ' },
    {
      id: 'annex-1',
      ordinal: 3,
      docTypeCode: 'annex_registry',
      complectId: 'complect-1',
      number: '1.1',
    },
    {
      id: 'passport-1',
      ordinal: 4,
      docTypeCode: 'quality_passport',
      complectId: 'complect-1',
      number: '357',
    },
  ];

  const transferRow: Partial<RegistryRowView> = {
    id: 'row-annex',
    documentId: 'transfer',
    ordinal: 1,
    rowNo: 1,
    sectionTitle: 'раздел 1',
    docNameRaw: 'Реестр к АОСР № 48-ОТ',
    docNoRaw: '1.1',
    docNoNorm: '1.1',
    docNoFolded: '1.1',
    orgRaw: null,
    validFrom: null,
    validTo: null,
    issuedAt: null,
    matchedDocumentId: null,
    matchScore: null,
    matchState: 'missing',
    complectId: 'complect-1',
    candidateDocumentIds: [],
  };

  /** Строка самого реестра приложений: без неё выборки описи не отличить. */
  const annexRow: Partial<RegistryRowView> = {
    id: 'row-material',
    documentId: 'annex-1',
    ordinal: 1,
    rowNo: 1,
    sectionTitle: null,
    docNameRaw: 'Паспорт',
    docNoRaw: '357',
    docNoNorm: '357',
    docNoFolded: '357',
    orgRaw: null,
    validFrom: null,
    validTo: null,
    issuedAt: null,
    matchedDocumentId: null,
    matchScore: null,
    matchState: 'missing',
    complectId: null,
    candidateDocumentIds: [],
  };

  it('строка описи находит реестр приложений своего комплекта', async () => {
    const decisions = await matchedStatesOf(documents, [transferRow, annexRow]);

    expect(decisions).toContainEqual({ id: 'row-annex', state: 'matched' });
  });

  it('строка реестра приложений сам перечень кандидатом не считает', async () => {
    // Обратная сторона того же правила: перечень приложений перечисляет
    // материалы, а не себя и не соседний перечень.
    const decisions = await matchedStatesOf(documents, [
      transferRow,
      { ...annexRow, docNameRaw: 'Реестр', docNoRaw: '1.1', docNoNorm: '1.1', docNoFolded: '1.1' },
    ]);

    expect(decisions).toContainEqual({ id: 'row-material', state: 'missing' });
  });
});
