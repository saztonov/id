/**
 * Результат блока от RD WEB → канонический блок `@id/recognition`.
 *
 * ## Почему сборка штампа и картинки НЕ пишется здесь заново
 *
 * Правила `buildSheet` / `buildRevisions` / `buildExtra` уже реализованы в
 * `recognition/vlm/map.ts`, и написаны они были ПОД ФОРМУ RD WEB: список
 * `IMAGE_FRAGMENT_TYPES` в комментарии прямо назван «21 значение дословно из
 * RD WEB», а плоский строковый штамп — наследие их же markdown-строки. Вторая
 * реализация тех же правил разошлась бы с первой при первой правке, и один и
 * тот же штамп давал бы два разных канонических штампа на двух маршрутах — то
 * есть shadow-сравнение провайдеров, ради которого существует `ai.dry_run_only`,
 * перестало бы что-либо значить.
 *
 * Поэтому здесь только разбор их JSON в ту же форму и вызов тех же функций.
 *
 * ## Почему схемы разбора МЯГКИЕ, а не strict
 *
 * У VLM-пути схема строгая, и это правильно: там она же служит `response_format`,
 * то есть ограничением для модели, и лишнее поле означает, что модель нарушила
 * контракт. Здесь она разбирает ответ ЧУЖОГО сервиса, который вправе добавить
 * поле в своей версии, — и уронить из-за этого весь блок значило бы отказаться
 * от распознанного текста ради формальности. Незнакомое отбрасывается, знакомое
 * проверяется по типу (§0.5 портала: незнакомое обязано обрабатываться, а не
 * проваливаться).
 */
import type { BlockType } from '@id/contracts';
import type { RecognitionBlock } from '@id/recognition';
import { z } from 'zod';

import type { ExecBlockResultRow } from '../../integrations/rdweb-exec/port.js';
import { mapImageResponse, mapStampResponse, type VlmBlockContext } from '../vlm/map.js';
import { IMAGE_FRAGMENT_TYPES } from '../vlm/schemas.js';
import { textBlockSchema } from '@id/recognition';

/**
 * Версия адаптера этого маршрута.
 *
 * Описывает весь путь превращения ответа RD WEB в канон: разбор `ocr_json`,
 * правила сборки штампа и картинки, версию рендера фрагментов. Содержательное
 * изменение любого из них меняет канонический результат при тех же пикселях —
 * и обязано поднять эту строку, иначе старые артефакты неотличимы от новых.
 */
export const ADAPTER_VERSION_RDWEB_EXEC = 'rdweb-exec.v1';

const nullableString = z.string().nullable().catch(null);

/**
 * `fragment_type` вне известного перечня не роняет блок.
 *
 * Список закрыт у нас, но принадлежит им: они вправе завести двадцать второй
 * тип фрагмента раньше, чем мы о нём узнаем. «Не определено» — их собственное
 * значение для этого случая, и оно честнее, чем потеря описания картинки
 * целиком.
 */
const fragmentTypeSchema = z
  .enum(IMAGE_FRAGMENT_TYPES)
  .catch(IMAGE_FRAGMENT_TYPES[IMAGE_FRAGMENT_TYPES.length - 1] as 'Не определено');

const execImageSchema = z.object({
  fragment_type: fragmentTypeSchema,
  location: z
    .object({
      grid_lines: nullableString,
      zone_name: nullableString,
      level_or_elevation: nullableString,
    })
    .catch({ grid_lines: null, zone_name: null, level_or_elevation: null }),
  content_summary: z.string().catch(''),
  detailed_description: z.string().catch(''),
  verification_recommendations: z.string().catch(''),
  key_entities: z.array(z.string()).catch([]),
});

const execStampSchema = z.object({
  document_code: nullableString,
  /**
   * `sheet_code` у RD WEB нет — и это известное ограничение маршрута.
   *
   * Собственный номер листа, которым исполнительную схему называет реестр
   * приложений (правило S46), в их `StampBlockResult` не предусмотрен. Поле
   * читается на случай, если появится, но отсутствие — штатное состояние:
   * номер доедет текстовым блоком верхней надписи, который добавляет
   * `detection.large_sheet_number_zone`. Достраивать его эвристикой из
   * `sheet_name` нельзя — выдуманный номер документа это ровно тот класс
   * ошибки, ради устранения которого правило S46 и появилось.
   */
  sheet_code: nullableString,
  project_name: nullableString,
  sheet_name: nullableString,
  stage: nullableString,
  sheet_number: nullableString,
  total_sheets: nullableString,
  organization: nullableString,
  signatures: z
    .array(
      z.object({ role: nullableString, surname: nullableString, date: nullableString }).catch({
        role: null,
        surname: null,
        date: null,
      }),
    )
    .catch([]),
  revisions: z
    .array(
      z
        .object({ change_num: nullableString, doc_num: nullableString, date: nullableString })
        .catch({ change_num: null, doc_num: null, date: null }),
    )
    .catch([]),
});

export interface ExecMapContext {
  readonly layoutBlockId: string;
  readonly blockType: BlockType;
  readonly sortOrder: number;
  readonly coordsNorm: readonly [number, number, number, number];
}

export type ExecMapOutcome =
  | { readonly kind: 'ok'; readonly block: RecognitionBlock }
  | { readonly kind: 'unmappable'; readonly reason: string };

/**
 * Разбор результата одного блока.
 *
 * Модель в канон не попадает (`modelId: null`): её выбирает RD WEB и в ручке
 * блоков не называет. Подставить сюда заказанный слаг было бы ложью — заказа
 * модели на этом маршруте нет вовсе.
 */
export function mapExecBlockResult(
  row: ExecBlockResultRow,
  context: ExecMapContext,
): ExecMapOutcome {
  const base: VlmBlockContext = {
    layoutBlockId: context.layoutBlockId,
    sortOrder: context.sortOrder,
    coordsNorm: context.coordsNorm,
    modelId: null,
    blockId: row.externalBlockId,
  };

  if (context.blockType === 'text') {
    /*
     * Текст берётся как есть и обратно во фрагменты НЕ разбирается.
     *
     * Опыт `rdweb-md.ts` показывает, что восстановление структуры из GFM — это
     * потеря с непроверяемым результатом. В каноне для этого случая есть
     * честное значение: `fragments: null` означает «структуры нет», в отличие
     * от `[]` — «структура есть и пуста».
     */
    const text = row.ocrMarkdown ?? row.ocrText ?? '';
    return {
      kind: 'ok',
      block: textBlockSchema.parse({
        blockId: base.blockId,
        layoutBlockId: base.layoutBlockId,
        ordinal: base.sortOrder,
        coordsNorm: [...base.coordsNorm],
        confidence: null,
        modelId: null,
        blockType: 'text',
        text,
        fragments: null,
        features: null,
      }) as RecognitionBlock,
    };
  }

  if (row.ocrJson === null || row.ocrJson === undefined) {
    // Штамп и картинка без структурного результата — не штамп и не картинка.
    // Выдумывать здесь нечего, и текстовый фолбэк был бы подменой типа блока.
    return { kind: 'unmappable', reason: 'RD WEB не вернул ocr_json для структурного блока' };
  }

  if (context.blockType === 'image') {
    const parsed = execImageSchema.safeParse(row.ocrJson);
    if (!parsed.success) {
      return { kind: 'unmappable', reason: 'ocr_json картинки не разобран' };
    }
    return { kind: 'ok', block: mapImageResponse(parsed.data, base) };
  }

  const parsed = execStampSchema.safeParse(row.ocrJson);
  if (!parsed.success) {
    return { kind: 'unmappable', reason: 'ocr_json штампа не разобран' };
  }
  return { kind: 'ok', block: mapStampResponse(parsed.data, base) };
}
