/**
 * Маппинг разобранных ответов VLM в канонические блоки `@id/recognition`.
 *
 * ## Гарантия формы — парсером канона, а не доверием
 *
 * Каждый собранный блок прогоняется через zod-схему канонического контракта
 * (`textBlockSchema`/`imageBlockSchema`/`stampBlockSchema`): маппинг не имеет
 * права выпустить объект, который канон не примет, и это проверяется в момент
 * сборки, а не при финальной валидации всего результата, где путь до дефекта
 * уже потерян.
 *
 * ## Правила штампа (решения зафиксированы здесь)
 *
 * Канонический штамп плоский и строковый (наследие RD WEB-строки
 * `> **Stamp:** …`), а ответ VLM структурный — сборка детерминирована:
 *
 * - `sheet` ← `sheet_number`/`total_sheets`: «N из M» | только «N» | `null`.
 *   `total_sheets` БЕЗ номера листа не образует обозначение листа и уходит в
 *   `extra.total_sheets` — данные не выбрасываются, но и не выдумывается
 *   строка вида «из 12».
 * - `revisions` ← строки таблицы изменений: внутри строки непустые части
 *   `change_num doc_num date` через пробел, строки через «; »; полностью
 *   пустые строки пропускаются; пустой итог — `null` (список без строк — не
 *   информация).
 * - `signatures` → `extra`: ключи `signature_1…` по порядку ЭМИТА (полностью
 *   пустые строки подписей пропускаются, нумерация без дыр), значение —
 *   `role — surname, date` с опусканием пустых частей.
 * - Пустая строка в СОСТАВНОЙ строке неотличима от отсутствия и опускается
 *   наравне с `null`; прямые скаляры (`code`, `stage`, `object`, `name`,
 *   `organization`) переносятся как есть — различие `null` ≠ `''` канона там
 *   сохраняется.
 *
 * ## Версия адаптера
 *
 * `ADAPTER_VERSION_OPENROUTER_VLM` живёт ЗДЕСЬ, а не в assemble.ts: версия
 * описывает весь VLM-путь превращения ответа в канон — тексты промптов и
 * схемы (prompts.ts, schemas.ts), правила этого маппинга и версию рендера
 * фрагментов (`RENDER_FRAGMENTS_VERSION`). Содержательное изменение любого из
 * них меняет канонический результат при тех же пикселях — и обязано поднять
 * эту строку, чтобы `source.adapterVersion` отличал старые canonical-артефакты
 * от новых.
 */
import {
  imageBlockSchema,
  renderFragmentsToMarkdown,
  stampBlockSchema,
  textBlockSchema,
  type ContentFragment,
} from '@id/recognition';
import type { z } from 'zod';

import type { VlmImageResponse, VlmStampResponse, VlmTextResponse } from './schemas.js';

export const ADAPTER_VERSION_OPENROUTER_VLM = 'openrouter-vlm.v1';

export type CanonicalTextBlock = z.infer<typeof textBlockSchema>;
export type CanonicalImageBlock = z.infer<typeof imageBlockSchema>;
export type CanonicalStampBlock = z.infer<typeof stampBlockSchema>;

/** Контекст замороженного блока — идентичность результата в каноне. */
export interface VlmBlockContext {
  readonly layoutBlockId: string;
  /** `ordinal` канона = `sortOrder` замороженного блока (детерминированный порядок). */
  readonly sortOrder: number;
  readonly coordsNorm: readonly [number, number, number, number];
  /** ФАКТИЧЕСКИ отработавшая модель (`VlmResponse.model`), не заказанная. */
  readonly modelId: string;
}

function blockBase(context: VlmBlockContext): {
  blockId: null;
  layoutBlockId: string;
  ordinal: number;
  coordsNorm: [number, number, number, number];
  confidence: null;
  modelId: string;
} {
  return {
    /** Идентификатора провайдера у VLM-пути нет — блок определяет layoutBlockId. */
    blockId: null,
    layoutBlockId: context.layoutBlockId,
    ordinal: context.sortOrder,
    coordsNorm: [...context.coordsNorm],
    /** Провайдер уверенность по блоку не сообщает; 0 был бы ложью (§9.1). */
    confidence: null,
    modelId: context.modelId,
  };
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

/** Плоский табличный фрагмент ответа → вложенная каноническая форма. */
function toCanonicalFragments(fragments: VlmTextResponse['fragments']): ContentFragment[] {
  return fragments.map((fragment): ContentFragment => {
    switch (fragment.kind) {
      case 'paragraph':
        return { kind: 'paragraph', text: fragment.text, emphasis: fragment.emphasis };
      case 'heading':
        return { kind: 'heading', level: fragment.level, text: fragment.text };
      case 'table':
        return {
          kind: 'table',
          table: { header: fragment.header, rows: fragment.rows, title: fragment.title },
        };
    }
  });
}

export function mapTextResponse(
  response: VlmTextResponse,
  context: VlmBlockContext,
): CanonicalTextBlock {
  const fragments = toCanonicalFragments(response.fragments);
  return textBlockSchema.parse({
    ...blockBase(context),
    blockType: 'text',
    /** Текст — ДЕТЕРМИНИРОВАННЫЙ рендер фрагментов; см. RENDER_FRAGMENTS_VERSION. */
    text: renderFragmentsToMarkdown(fragments),
    fragments,
    /** Признаки рукописи/подписей/печатей text-схема v1 не спрашивает. */
    features: null,
  });
}

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

export function mapImageResponse(
  response: VlmImageResponse,
  context: VlmBlockContext,
): CanonicalImageBlock {
  return imageBlockSchema.parse({
    ...blockBase(context),
    blockType: 'image',
    image: {
      imageType: response.fragment_type,
      axes: response.location.grid_lines,
      zone: response.location.zone_name,
      level: response.location.level_or_elevation,
      summary: response.content_summary,
      description: response.detailed_description,
      entities: [...response.key_entities],
      // Пустая строка у RD WEB — штатное «причины проверять нет»; в каноне
      // это состояние выражает null, а не пустой текст рекомендации.
      verification:
        response.verification_recommendations.trim() === ''
          ? null
          : response.verification_recommendations,
    },
    features: null,
  });
}

// ---------------------------------------------------------------------------
// stamp
// ---------------------------------------------------------------------------

function present(value: string | null): value is string {
  return value !== null && value.trim() !== '';
}

function buildSheet(response: VlmStampResponse): string | null {
  const number = response.sheet_number;
  const total = response.total_sheets;
  if (present(number) && present(total)) return `${number} из ${total}`;
  if (present(number)) return number;
  return null;
}

function buildRevisions(response: VlmStampResponse): string | null {
  const rows = response.revisions
    .map((row) => [row.change_num, row.doc_num, row.date].filter(present).join(' '))
    .filter((row) => row !== '');
  return rows.length === 0 ? null : rows.join('; ');
}

function buildExtra(response: VlmStampResponse): Record<string, string> {
  const extra: Record<string, string> = {};
  let emitted = 0;
  for (const signature of response.signatures) {
    const person = [signature.role, signature.surname].filter(present).join(' — ');
    const line = [person, signature.date ?? ''].filter((part) => part.trim() !== '').join(', ');
    if (line === '') continue; // Полностью пустая строка подписи — не данные.
    emitted += 1;
    extra[`signature_${emitted}`] = line;
  }
  if (!present(response.sheet_number) && present(response.total_sheets)) {
    extra['total_sheets'] = response.total_sheets;
  }
  return extra;
}

export function mapStampResponse(
  response: VlmStampResponse,
  context: VlmBlockContext,
): CanonicalStampBlock {
  return stampBlockSchema.parse({
    ...blockBase(context),
    blockType: 'stamp',
    stamp: {
      code: response.document_code,
      stage: response.stage,
      sheet: buildSheet(response),
      object: response.project_name,
      name: response.sheet_name,
      organization: response.organization,
      revisions: buildRevisions(response),
      extra: buildExtra(response),
    },
  });
}
