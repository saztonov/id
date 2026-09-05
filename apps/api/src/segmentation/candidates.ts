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
