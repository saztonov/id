/**
 * Веер извлечения реквизитов и его барьер (S44).
 *
 * Набор живёт отдельно от `segmentation.integration.test.ts` по той же причине,
 * что и `segmentation-graph.test.ts`: интеграция проходит цепочку целиком и
 * потому не может задать точечно состояние веера — «две задачи ещё считаются,
 * одна умерла». Здесь обработчики получают ровно то состояние, о котором идёт
 * речь, и вопрос остаётся один: что они из него выведут.
 *
 * Заглушки описывают только то, что обработчик читает.
 */
import { describe, expect, it } from 'vitest';

import type { FieldValueView, JobContext, LogicalDocumentView } from '@id/api';

import {
  createExtractFieldsHandler,
  createExtractFinalizeHandler,
  type SegmentationDeps,
} from './segmentation.js';

const FOLDER = '00000000-0000-4000-8000-000000000001';
const PLANNER_JOB = '00000000-0000-4000-8000-0000000000aa';

interface DocumentSpec {
  readonly id: string;
  readonly ordinal: number;
  readonly docTypeCode: string | null;
  readonly fields?: Readonly<Record<string, string>>;
  readonly actDate?: string;
}

function documentsOf(specs: readonly DocumentSpec[]): readonly LogicalDocumentView[] {
  return specs.map(
    (spec) =>
      ({
        id: spec.id,
        ordinal: spec.ordinal,
        docTypeCode: spec.docTypeCode,
        title: null,
      }) as LogicalDocumentView,
  );
}

function fieldsOf(spec: DocumentSpec): readonly FieldValueView[] {
  const rows: FieldValueView[] = [];
  const push = (fieldCode: string, value: { text?: string; date?: string }): void => {
    rows.push({
      id: `${spec.id}-${fieldCode}`,
      documentId: spec.id,
      fieldCode,
      valueText: value.text ?? null,
      valueDate: value.date ?? null,
      valueNum: null,
      valueJson: null,
      confidence: 1,
      isVerified: false,
      extractorVersion: 'test',
      pageTextVersionId: null,
      charSpan: null,
      quote: null,
      extractedBy: 'llm',
    });
  };
  if (spec.actDate !== undefined) push('act_date', { date: spec.actDate });
  for (const [fieldCode, text] of Object.entries(spec.fields ?? {})) push(fieldCode, { text });
  return rows;
}

interface Enqueued {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey: string | undefined;
}

function contextOf(
  payload: Record<string, unknown>,
  sink: { enqueued: Enqueued[]; emitted: { type: string; payload: unknown }[] },
): JobContext<'doc.extract_fields'> {
  return {
    jobId: PLANNER_JOB,
    payload,
    signal: new AbortController().signal,
    logger: { info: () => undefined, warn: () => undefined },
    emit: (type: string, eventPayload: unknown) => {
      sink.emitted.push({ type, payload: eventPayload });
      return Promise.resolve();
    },
    enqueue: (input: { type: string; payload: Record<string, unknown>; dedupeKey?: string }) => {
      sink.enqueued.push({
        type: input.type,
        payload: input.payload,
        dedupeKey: input.dedupeKey,
      });
      return Promise.resolve({ jobId: 'j', created: true });
    },
  } as unknown as JobContext<'doc.extract_fields'>;
}

describe('doc.extract_fields раскладывает работу, а не делает её', () => {
  it('на каждый документ ставится своя задача, и все они одного поколения', async () => {
    const specs: DocumentSpec[] = [
      { id: 'act', ordinal: 1, docTypeCode: 'aosr' },
      { id: 'annex', ordinal: 2, docTypeCode: 'annex_registry' },
      { id: 'cert', ordinal: 3, docTypeCode: 'cert_conformity' },
    ];
    const deps = {
      listDocuments: () => Promise.resolve(documentsOf(specs)),
    } as unknown as SegmentationDeps;
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await createExtractFieldsHandler(deps)(contextOf({ folderId: FOLDER }, sink));

    const fan = sink.enqueued.filter((job) => job.type === 'doc.extract_document');
    expect(fan.map((job) => job.payload['documentId'])).toEqual(['act', 'annex', 'cert']);
    // Поколение — идентификатор задачи-постановщика: повторная попытка попадёт
    // в те же ключи дедупликации и переиспользует уже поставленный веер.
    expect(new Set(fan.map((job) => job.payload['generation']))).toEqual(new Set([PLANNER_JOB]));
    expect(fan.map((job) => job.dedupeKey)).toEqual([
      `doc.extract_document:${PLANNER_JOB}:act`,
      `doc.extract_document:${PLANNER_JOB}:annex`,
      `doc.extract_document:${PLANNER_JOB}:cert`,
    ]);

    const barrier = sink.enqueued.filter((job) => job.type === 'doc.extract_finalize');
    expect(barrier).toHaveLength(1);
    expect(barrier[0]?.payload['generation']).toBe(PLANNER_JOB);
  });

  it('переизвлечение ОДНОГО документа барьера не ставит', async () => {
    // Барьер выводит месяц по самому раннему акту папки. За переизвлечением
    // одного документа остальные акты в веер не попали, и «самый ранний» вышел
    // бы не самым ранним.
    const specs: DocumentSpec[] = [
      { id: 'act', ordinal: 1, docTypeCode: 'aosr' },
      { id: 'cert', ordinal: 2, docTypeCode: 'cert_conformity' },
    ];
    const deps = {
      listDocuments: () => Promise.resolve(documentsOf(specs)),
    } as unknown as SegmentationDeps;
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await createExtractFieldsHandler(deps)(
      contextOf({ folderId: FOLDER, documentId: 'cert' }, sink),
    );

    expect(sink.enqueued.map((job) => job.type)).toEqual(['doc.extract_document']);
    expect(sink.enqueued[0]?.payload['documentId']).toBe('cert');
  });

  it('папка без документов — отказ, а не тихий успех', async () => {
    const deps = { listDocuments: () => Promise.resolve([]) } as unknown as SegmentationDeps;
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await expect(
      createExtractFieldsHandler(deps)(contextOf({ folderId: FOLDER }, sink)),
    ).rejects.toThrow(/документов нет/u);
  });
});

describe('doc.extract_finalize ждёт свой веер', () => {
  function finalizeDeps(input: {
    readonly fan: { live: number; dead: number; done: number; total: number };
    readonly specs?: readonly DocumentSpec[];
    readonly contractors?: readonly {
      id: string;
      name: string;
      inn: string | null;
      ogrn: string | null;
    }[];
    readonly sink?: { period: string | null; contractorId: string | null; raw: string | null };
  }): SegmentationDeps {
    const specs = input.specs ?? [];
    return {
      extractFanState: () => Promise.resolve(input.fan),
      listDocuments: () => Promise.resolve(documentsOf(specs)),
      listFieldValues: (documentId: string) =>
        Promise.resolve(fieldsOf(specs.find((spec) => spec.id === documentId) as DocumentSpec)),
      fillFolderPeriod: (_folderId: string, period: string) => {
        if (input.sink !== undefined) input.sink.period = period;
        return Promise.resolve(true);
      },
      listMatchableContractors: () => Promise.resolve(input.contractors ?? []),
      replaceAssumedContractor: (_folderId: string, contractorId: string) => {
        if (input.sink !== undefined) input.sink.contractorId = contractorId;
        return Promise.resolve(true);
      },
      rememberContractorRaw: (_folderId: string, raw: string) => {
        if (input.sink !== undefined) input.sink.raw = raw;
        return Promise.resolve(true);
      },
    } as unknown as SegmentationDeps;
  }

  it('живая задача веера — отсрочка, а не отказ и не итог', async () => {
    const deps = finalizeDeps({ fan: { live: 2, dead: 0, done: 10, total: 12 } });
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await expect(
      createExtractFinalizeHandler(deps)(
        contextOf(
          { folderId: FOLDER, generation: PLANNER_JOB },
          sink,
        ) as unknown as JobContext<'doc.extract_finalize'>,
      ),
    ).rejects.toMatchObject({ deferred: true });

    // Ничего не выведено и ничего не поставлено: барьер не подводит итог по
    // недосчитанному вееру.
    expect(sink.enqueued).toEqual([]);
    expect(sink.emitted).toEqual([]);
  });

  it('мёртвая задача веера папку не останавливает, а считается', async () => {
    // Отказ одного документа не убивает папку (дух ADR-0017): он остаётся с
    // базовыми реквизитами правил, а барьер называет число таких в событии.
    const sinkOfFolder = {
      period: null as string | null,
      contractorId: null as string | null,
      raw: null as string | null,
    };
    const deps = finalizeDeps({
      fan: { live: 0, dead: 1, done: 11, total: 12 },
      specs: [
        { id: 'act-late', ordinal: 1, docTypeCode: 'aosr', actDate: '2026-04-14' },
        { id: 'act-early', ordinal: 2, docTypeCode: 'aosr', actDate: '2026-02-03' },
      ],
      sink: sinkOfFolder,
    });
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await createExtractFinalizeHandler(deps)(
      contextOf(
        { folderId: FOLDER, generation: PLANNER_JOB },
        sink,
      ) as unknown as JobContext<'doc.extract_finalize'>,
    );

    expect(sink.emitted[0]).toEqual({
      type: 'documents.fields_extracted',
      payload: { documents: 12, failed: 1, anchors: 2 },
    });
    // Месяц — по САМОМУ РАННЕМУ акту, а не по первому встреченному.
    expect(sinkOfFolder.period).toBe('2026-02-01');
    expect(sink.enqueued.map((job) => job.type)).toEqual(['doc.parse_registry']);
  });

  it('исполнитель выводится по первому акту с непустой тройкой', async () => {
    const sinkOfFolder = {
      period: null as string | null,
      contractorId: null as string | null,
      raw: null as string | null,
    };
    const deps = finalizeDeps({
      fan: { live: 0, dead: 0, done: 2, total: 2 },
      specs: [
        // У первого акта тройки нет вовсе: гадать по нему нечего, и барьер
        // обязан идти дальше, а не объявлять исполнителя непрочитанным.
        { id: 'act-1', ordinal: 1, docTypeCode: 'aosr', actDate: '2026-04-01' },
        {
          id: 'act-2',
          ordinal: 2,
          docTypeCode: 'aosr',
          actDate: '2026-04-02',
          fields: { contractor_name: 'ООО «Подрядчик»', contractor_inn: '7701234567' },
        },
      ],
      contractors: [{ id: 'org-1', name: 'ООО «Подрядчик»', inn: '7701234567', ogrn: null }],
      sink: sinkOfFolder,
    });
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await createExtractFinalizeHandler(deps)(
      contextOf(
        { folderId: FOLDER, generation: PLANNER_JOB },
        sink,
      ) as unknown as JobContext<'doc.extract_finalize'>,
    );

    expect(sinkOfFolder.contractorId).toBe('org-1');
    expect(sinkOfFolder.raw).toBeNull();
  });

  it('папка без актов доходит до конца, ничего не выводя', async () => {
    // Так выглядит отдельно загруженная опись передачи: якорей нет, выводить
    // месяц не из чего, и это законное состояние, а не отказ.
    const sinkOfFolder = {
      period: null as string | null,
      contractorId: null as string | null,
      raw: null as string | null,
    };
    const deps = finalizeDeps({
      fan: { live: 0, dead: 0, done: 1, total: 1 },
      specs: [{ id: 'registry', ordinal: 1, docTypeCode: 'transfer_registry' }],
      sink: sinkOfFolder,
    });
    const sink = {
      enqueued: [] as Enqueued[],
      emitted: [] as { type: string; payload: unknown }[],
    };

    await createExtractFinalizeHandler(deps)(
      contextOf(
        { folderId: FOLDER, generation: PLANNER_JOB },
        sink,
      ) as unknown as JobContext<'doc.extract_finalize'>,
    );

    expect(sinkOfFolder.period).toBeNull();
    expect(sink.emitted.map((event) => event.type)).toEqual(['documents.fields_extracted']);
    expect(sink.enqueued.map((job) => job.type)).toEqual(['doc.parse_registry']);
  });
});
