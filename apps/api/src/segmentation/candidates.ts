/**
 * Выборки кандидатов сверки: среди каких документов ищется строка перечня.
 *
 * ## Почему это отдельный модуль
 *
 * Правило «кого показывать строке» жило в двух местах сразу: в задании 18
 * воркера (`apps/worker/src/jobs/segmentation.ts`) и в офлайн-стенде
 * (`tools/check-harness/src/pipeline.ts`). Копии разошлись молча: стенд не
 * исключал перечни вовсе и пропускал строки описи без комплекта, воркер
 * исключал ВСЕ разобранные перечни и такие строки искал по всей папке. Из-за
 * этого мутация сверки, ради которой стенд и заведён, на нём не краснела:
 * стенд судил папку не тем правилом, которым судит портал.
 *
 * Здесь правило одно, и обе стороны читают его отсюда.
 *
 * ## Почему опись видит реестры приложений, а перечень приложений — нет
 *
 * Опись передачи перечисляет ВСЁ, что лежит в папке, и реестр приложений в ней
 * стоит отдельной строкой («Реестр к АОСР № 48-ОТ/-1 этаж») наравне с
 * паспортом и сертификатом. Исключать его из выборки — значит объявлять
 * имеющийся документ отсутствующим: в папке «ИД Мастер апрель 2026» так
 * получалось двенадцать «строка описи не найдена» и двенадцать «документ папки
 * не назван описью» об одних и тех же двенадцати реестрах.
 *
 * Перечень приложений АКТА — список материальных документов, и себя он не
 * перечисляет. Для его строк перечни остаются исключёнными: это не выборка
 * поуже, а другой вопрос.
 *
 * ## Почему исключение по ВИДУ, а не по «у документа есть разобранные строки»
 *
 * Прежний признак — «документ владеет строками в `registry_rows`» — зависел от
 * того, удался ли разбор. Перечень, у которого распознавание не дало ни одной
 * строки, переставал быть перечнем и попадал в кандидаты к самому себе. Вид
 * документа такому не подвержен и известен до разбора.
 */
import { isRegistryCode } from '@id/doc-types';

import type { MatchableDocument } from './match.js';
import { TRANSFER_TYPE } from './transfer-registry.js';

/** Документ папки в том виде, в каком выборка о нём судит. */
export interface ScopedDocument extends MatchableDocument {
  /** Комплект документа; `null` — документ уровня папки (опись, титул). */
  readonly complectId: string | null;
}

/** Строки одного перечня и выборка, в которой они ищут свои документы. */
export interface RegistryPartition<Row> {
  readonly documents: readonly ScopedDocument[];
  readonly rows: readonly Row[];
}

/**
 * Кандидаты строк перечня приложений: документы комплекта его акта.
 *
 * Комплект и задаёт границу: перечень принадлежит одному акту, и искать его
 * строки за пределами этого акта незачем. Прежде сверка искала по всей папке, и
 * на папке из двенадцати актов это давало 72 «сопоставлено неоднозначно» из
 * 138 — один и тот же сертификат лежит в приложениях каждого акта.
 *
 * Перечень без комплекта кандидатов не получает вовсе: акта у него нет, а вся
 * папка ответила бы двойниками.
 */
export function annexCandidates(
  documents: readonly ScopedDocument[],
  registryComplectId: string | null,
): readonly ScopedDocument[] {
  if (registryComplectId === null) return [];
  return documents.filter(
    (document) =>
      document.complectId === registryComplectId && !isRegistryCode(document.docTypeCode),
  );
}

/**
 * Строки описи, разложенные на выборки по комплектам своих разделов.
 *
 * Раздел, нашедший акт, ищет документы среди документов этого акта. Раздел без
 * акта отправляет строки искать по всей папке: строка названа, документ у неё
 * где-то есть, и отказываться искать его только потому, что не опознан раздел,
 * значило бы объявить документ отсутствующим по своей же причине. Двойники в
 * такой выборке дадут честное «неоднозначно».
 */
export function transferPartitions<Row extends { readonly complectId: string | null }>(
  documents: readonly ScopedDocument[],
  rows: readonly Row[],
): readonly RegistryPartition<Row>[] {
  const searchable = documents.filter((document) => document.docTypeCode !== TRANSFER_TYPE);

  const byComplect = new Map<string | null, Row[]>();
  for (const row of rows) {
    const bucket = byComplect.get(row.complectId);
    if (bucket === undefined) byComplect.set(row.complectId, [row]);
    else bucket.push(row);
  }

  return [...byComplect.entries()].map(([complectId, rowsOfComplect]) => ({
    documents:
      complectId === null
        ? searchable
        : searchable.filter((document) => document.complectId === complectId),
    rows: rowsOfComplect,
  }));
}

/** Выборка вместе с ключом, по которому её адресует веер сверки (S57). */
export interface KeyedPartition<Row> extends RegistryPartition<Row> {
  readonly key: string;
  readonly registryDocumentId: string;
  readonly complectId: string | null;
}

/** Чем перечень является для выборки: описью папки или перечнем приложений акта. */
export interface RegistryFacts {
  readonly isTransfer: boolean;
  /** Комплект самого перечня; у описи не используется — комплект несёт строка. */
  readonly complectId: string | null;
}

/**
 * Все выборки папки с устойчивыми ключами (S57).
 *
 * Ключ нужен потому, что выборку теперь считает одна задача, а обрабатывает
 * другая: между ними лежит очередь, и передавать содержимое выборки в payload
 * значило бы хранить в очереди копию папки. Ключ должен переживать пересчёт —
 * поэтому он собран из идентификаторов, а не из порядкового номера: строки
 * перенумеровываются при каждом разборе перечня.
 *
 * Функция общая для задачи 18, веера сверки моделью и офлайн-стенда по той же
 * причине, что и остальное в этом файле: разошедшиеся копии правила «кого
 * показывать строке» уже приводили к тому, что стенд судил папку не тем
 * правилом, которым судит портал.
 */
export function registryPartitions<
  Row extends { readonly documentId: string; readonly complectId: string | null },
>(
  documents: readonly ScopedDocument[],
  rows: readonly Row[],
  factsOf: (registryDocumentId: string) => RegistryFacts,
): readonly KeyedPartition<Row>[] {
  const byRegistry = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = byRegistry.get(row.documentId);
    if (bucket === undefined) byRegistry.set(row.documentId, [row]);
    else bucket.push(row);
  }

  const out: KeyedPartition<Row>[] = [];
  for (const [registryDocumentId, rowsOfRegistry] of byRegistry) {
    const facts = factsOf(registryDocumentId);
    if (!facts.isTransfer) {
      out.push({
        key: `${registryDocumentId}:annex`,
        registryDocumentId,
        complectId: facts.complectId,
        documents: annexCandidates(documents, facts.complectId),
        rows: rowsOfRegistry,
      });
      continue;
    }

    for (const partition of transferPartitions(documents, rowsOfRegistry)) {
      const complectId = partition.rows[0]?.complectId ?? null;
      out.push({
        key: `${registryDocumentId}:${complectId ?? 'none'}`,
        registryDocumentId,
        complectId,
        documents: partition.documents,
        rows: partition.rows,
      });
    }
  }

  return out;
}
