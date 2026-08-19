/**
 * Офлайн-вывод связей документов — зеркало задачи 19 `graph.build`
 * (`apps/worker/src/jobs/segmentation.ts`, `createGraphBuildHandler`).
 *
 * Логика скопирована, а не вынесена: воркер работает поверх БД-представлений,
 * и общая чистая функция потребовала бы менять его сигнатуры ради инструмента.
 * Плата за копию — обязанность держать её в согласии с оригиналом; при
 * расхождении харнес измеряет не прод. Ссылки на строки оригинала — в
 * комментариях по месту.
 */
import type { DocumentNode, RegistryRowNode, RelationNode } from '@id/rules';

/** Зеркало констант graph.build (segmentation.ts:1034-1037). */
const PROTOCOL_TYPES = /^lab_protocol_|^sampling_act$|^protocol_/u;
const QUALITY_TYPES =
  /^cert_conformity$|^declaration$|^quality_passport$|^technical_passport$|^mill_certificate$|^mix_quality_doc$|^fire_certificate$|^refusal_letter$|^equipment_passport$|^ttn$|^other_quality_docs$/u;
const PRIMARY_TYPES = /^aosr/u;
const REGISTRY_TYPE = 'annex_registry';

export function deriveOfflineRelations(
  documents: readonly DocumentNode[],
  registryRows: readonly RegistryRowNode[],
): readonly RelationNode[] {
  const ordered = [...documents].sort((a, b) => a.ordinal - b.ordinal);
  const byId = new Map(ordered.map((document) => [document.id, document]));
  const relations: RelationNode[] = [];
  const seen = new Set<string>();

  const add = (parentDocumentId: string, childDocumentId: string, relation: string): void => {
    if (parentDocumentId === childDocumentId) return;
    const key = `${parentDocumentId}|${childDocumentId}|${relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push({ parentDocumentId, childDocumentId, relation });
  };

  // Акт → его реестр: ближайший предшествующий акт (segmentation.ts:1090-1102).
  const registryOwner = new Map<string, string>();
  let currentAct: string | null = null;
  for (const document of ordered) {
    if (document.docTypeCode !== null && PRIMARY_TYPES.test(document.docTypeCode)) {
      currentAct = document.id;
      continue;
    }
    if (document.docTypeCode === REGISTRY_TYPE && currentAct !== null) {
      registryOwner.set(document.id, currentAct);
      add(currentAct, document.id, 'annex');
    }
  }

  // Акт → документ, названный строкой его реестра (segmentation.ts:1104-1118).
  for (const row of registryRows) {
    if (row.matchState !== 'matched' || row.matchedDocumentId === null) continue;
    const parent = registryOwner.get(row.registryDocumentId);
    if (parent === undefined) continue;
    const child = byId.get(row.matchedDocumentId);
    if (child === undefined) continue;
    const code = child.docTypeCode ?? '';
    const relation = PROTOCOL_TYPES.test(code)
      ? 'protocol'
      : QUALITY_TYPES.test(code)
        ? 'quality_doc'
        : 'annex';
    add(parent, child.id, relation);
  }

  // Дубли: одинаковый вид и номер (segmentation.ts:1120-1138).
  const numbers = new Map<string, string[]>();
  for (const document of ordered) {
    const number = document.fields.find((field) => field.fieldCode === 'number')?.valueText ?? null;
    if (number === null || number.trim() === '') continue;
    const key = `${document.docTypeCode ?? '-'}|${number.trim().toUpperCase()}`;
    const list = numbers.get(key) ?? [];
    list.push(document.id);
    numbers.set(key, list);
  }
  for (const list of numbers.values()) {
    if (list.length < 2) continue;
    const [first, ...rest] = list;
    if (first === undefined) continue;
    for (const other of rest) add(first, other, 'duplicate');
  }

  return relations;
}
