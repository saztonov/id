/**
 * Задача 19 `graph.build`: какие рёбра портал вправе утверждать (S40).
 *
 * Набор живёт отдельно от `segmentation.integration.test.ts` намеренно. Тот
 * проходит цепочку целиком через pglite, RD WEB и настоящие PDF — и именно
 * поэтому не может задать входы точечно: реквизит `p3_materials` заполняет
 * LLM-стадия, которой в интеграции нет. Здесь же обработчик получает ровно те
 * документы и реквизиты, о которых идёт речь, и вопрос остаётся один: какие
 * рёбра он из них выведет.
 *
 * Заглушки описывают только то, что обработчик читает. Всё остальное поле
 * `SegmentationDeps` не подставляется вовсе: подстановка неиспользуемого
 * означала бы, что тест знает о задаче больше, чем задача о себе.
 */
import { describe, expect, it } from 'vitest';

import type {
  DocumentRelationInput,
  FieldValueView,
  JobContext,
  LogicalDocumentView,
  RegistryRowView,
} from '@id/api';

import { createGraphBuildHandler, type SegmentationDeps } from './segmentation.js';

interface DocumentSpec {
  readonly id: string;
  readonly ordinal: number;
  readonly docTypeCode: string | null;
  readonly title?: string | null;
  readonly fields?: Readonly<Record<string, string>>;
  /** `p3_materials` приходит списком: LLM-стадия пишет его в `valueJson`. */
  readonly item3?: readonly string[];
}

function fieldsOf(spec: DocumentSpec): readonly FieldValueView[] {
  const rows: FieldValueView[] = [];
  for (const [fieldCode, valueText] of Object.entries(spec.fields ?? {})) {
    rows.push(field(spec.id, fieldCode, { valueText }));
  }
  if (spec.item3 !== undefined) {
    rows.push(field(spec.id, 'p3_materials', { valueJson: spec.item3 }));
  }
  return rows;
}

function field(
  documentId: string,
  fieldCode: string,
  value: { readonly valueText?: string; readonly valueJson?: unknown },
): FieldValueView {
  return {
    id: `${documentId}-${fieldCode}`,
    documentId,
    fieldCode,
    valueText: value.valueText ?? null,
    valueDate: null,
    valueNum: null,
    valueJson: value.valueJson ?? null,
    confidence: 1,
    isVerified: false,
    extractorVersion: 'test',
    pageTextVersionId: null,
    charSpan: null,
    quote: null,
    extractedBy: 'llm',
  };
}

/** Прогон обработчика на заданном составе; возвращает записанные рёбра. */
async function relationsOf(
  documents: readonly DocumentSpec[],
  registryRows: readonly Partial<RegistryRowView>[] = [],
): Promise<readonly DocumentRelationInput[]> {
  let saved: readonly DocumentRelationInput[] = [];

  const deps = {
    listDocuments: () =>
      Promise.resolve(
        documents.map(
          (spec) =>
            ({
              id: spec.id,
              ordinal: spec.ordinal,
              docTypeCode: spec.docTypeCode,
              title: spec.title ?? null,
            }) as LogicalDocumentView,
        ),
      ),
    listRegistryRows: () => Promise.resolve(registryRows as readonly RegistryRowView[]),
    listFieldValues: (documentId: string) =>
      Promise.resolve(fieldsOf(documents.find((spec) => spec.id === documentId) as DocumentSpec)),
    saveDocumentRelations: (input: { readonly relations: readonly DocumentRelationInput[] }) => {
      saved = input.relations;
      return Promise.resolve({ removed: 0, written: input.relations.length, skipped: 0 });
    },
  } as unknown as SegmentationDeps;

  const ctx = {
    payload: { folderId: 'rev-1' },
    logger: { info: () => undefined, warn: () => undefined },
    emit: () => Promise.resolve(),
    enqueue: () => Promise.resolve({ jobId: 'j', created: true }),
  } as unknown as JobContext<'graph.build'>;

  await createGraphBuildHandler(deps)(ctx);
  return saved;
}

const ACT_ITEM3 = [
  '1.Песок для строительных работ (Паспорт №0297 от 26.09.2024г., Сертификат ' +
    'соответствия №RU.MCC.234.435.37815 (с 01.08.2023г. по 01.08.2026г.). ' +
    '2.Полотно полиэфирное геотекстильное (Сертификат №275 от 08.08.2024г.).',
];

describe('акт → документ, названный в п. 3 акта', () => {
  it('перечисленные в п. 3 документы получают ребро quality_doc', async () => {
    const relations = await relationsOf([
      { id: 'act', ordinal: 1, docTypeCode: 'aosr', title: 'АКТ', item3: ACT_ITEM3 },
      {
        id: 'passport',
        ordinal: 2,
        docTypeCode: 'quality_passport',
        fields: { number: '0297' },
      },
      {
        id: 'cert',
        ordinal: 3,
        docTypeCode: 'cert_conformity',
        fields: { number: 'RU.MCC.234.435.37815' },
      },
    ]);

    expect(relations).toEqual(
      expect.arrayContaining([
        { parentDocumentId: 'act', childDocumentId: 'passport', relation: 'quality_doc' },
        { parentDocumentId: 'act', childDocumentId: 'cert', relation: 'quality_doc' },
      ]),
    );
  });

  it('протокол из п. 3 получает ребро protocol, а не quality_doc', async () => {
    // Имя связи выводится из вида ДОКУМЕНТА, как и на ветке реестра: правила
    // дат читают их по-разному.
    const relations = await relationsOf([
      {
        id: 'act',
        ordinal: 1,
        docTypeCode: 'aosr',
        item3: ['Протокол испытаний №2410-04/10 от 04.10.2024г.'],
      },
      {
        id: 'lab',
        ordinal: 2,
        docTypeCode: 'lab_protocol_generic',
        fields: { number: '2410-04/10' },
      },
    ]);

    expect(relations).toContainEqual({
      parentDocumentId: 'act',
      childDocumentId: 'lab',
      relation: 'protocol',
    });
  });

  it('документ, в п. 3 не названный, ребра не получает', async () => {
    // Отрицательный контроль: ребро строится по прочитанному номеру, а не по
    // присутствию документа в комплекте.
    const relations = await relationsOf([
      { id: 'act', ordinal: 1, docTypeCode: 'aosr', item3: ACT_ITEM3 },
      {
        id: 'other',
        ordinal: 2,
        docTypeCode: 'metrology_verification',
        fields: { number: 'С-ЕВЧ/17-04-2024/333067628' },
      },
    ]);

    expect(relations).toEqual([]);
  });

  it('акт без п. 3 рёбер не порождает', async () => {
    const relations = await relationsOf([
      { id: 'act', ordinal: 1, docTypeCode: 'aosr' },
      { id: 'passport', ordinal: 2, docTypeCode: 'quality_passport', fields: { number: '0297' } },
    ]);

    expect(relations).toEqual([]);
  });
});

describe('дубль по номеру', () => {
  it('два чертежа с одним шифром из штампа дублем не объявляются', async () => {
    // У чертежа своего номера на листе нет: в штамп печатается шифр рабочей
    // документации, один на весь файл. Две исполнительные схемы комплекта
    // `№01_Бл_П` сняты с разных осей и разных отметок.
    const relations = await relationsOf([
      { id: 's1', ordinal: 1, docTypeCode: 'exec_scheme', fields: { number: '02-200223-ГПЗ.1' } },
      { id: 's2', ordinal: 2, docTypeCode: 'exec_scheme', fields: { number: '02-200223-ГПЗ.1' } },
    ]);

    expect(relations).toEqual([]);
  });

  it('два паспорта с одним номером дублем остаются', async () => {
    // Положительный контроль: вычет касается чертежей, а не самого правила.
    const relations = await relationsOf([
      { id: 'p1', ordinal: 1, docTypeCode: 'quality_passport', fields: { number: '0297' } },
      { id: 'p2', ordinal: 2, docTypeCode: 'quality_passport', fields: { number: '0297' } },
    ]);

    expect(relations).toContainEqual({
      parentDocumentId: 'p1',
      childDocumentId: 'p2',
      relation: 'duplicate',
    });
  });
});
