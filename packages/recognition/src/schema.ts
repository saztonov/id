/**
 * Канонический контракт результата распознавания (RecognitionResult v2).
 *
 * ## Зачем он существует
 *
 * Сегодня распознавание приходит от RD WEB в виде markdown (`document.md`);
 * решением заказчика следующий провайдер — VLM-модели через OpenRouter — будет
 * отдавать СТРУКТУРИРОВАННЫЙ JSON. Алгоритмы проверки не должны зависеть от
 * того, кто распознавал: провайдер-специфичный выход приводится адаптером к
 * этому контракту, и всё ниже по конвейеру (сегментация, извлечение, правила)
 * видит только его.
 *
 * ## Почему v2
 *
 * «v1 по факту» — это `schema_version: 1` их `blocks.json` (только геометрия,
 * без содержимого). Нумерация продолжается, чтобы никто не спутал два формата.
 *
 * ## Принцип обязательности
 *
 * Обязательны только идентичность (версия схемы, провенанс источника, номер
 * страницы, вид блока). Всё содержательное — nullable, и `null` ≠ `''` ≠ `[]`:
 * «данных нет» (провайдер не смотрел) отличается от «пусто» (провайдер
 * посмотрел и не нашёл) — это тот же принцип троичности, что и в правилах §9.1.
 * Так в контракт укладываются оба мира: RD WEB-адаптер не умеет `fragments` и
 * `features`, будущий VLM-выход может не иметь `coordsNorm` и `ordinal`.
 *
 * ## §11: подписанные ссылки на кропы — секрет
 *
 * Канонический результат — долгоживущий артефакт, и подписанные ссылки на
 * кропы чужого сервера (`…/api/crops/…`) в него попадать не имеют права. Это
 * держит `superRefine`, а не дисциплина адаптеров. Запрещать ЛЮБОЙ абсолютный
 * URL нельзя: документы законно ссылаются на публичные реестры и сайты
 * производителей — проверено golden-прогоном по temp/MD (стр. 15 пакета
 * кладки несёт четыре таких ссылки в тексте сертификата).
 */
import { z } from 'zod';

export const RECOGNITION_RESULT_SCHEMA_VERSION = 'recognition.result.v2';

export const recognitionProviderSchema = z.enum(['rdweb_md', 'openrouter_vlm', 'synthetic']);
export type RecognitionProvider = z.infer<typeof recognitionProviderSchema>;

const cellRow = z.array(z.string());

/** Таблица со структурированными ячейками — вместо GFM-текста. */
export const canonicalTableSchema = z.object({
  /** `null` — шапки нет либо она не распознана. */
  header: cellRow.nullable(),
  rows: z.array(cellRow),
  title: z.string().nullish(),
});
export type CanonicalTable = z.infer<typeof canonicalTableSchema>;

/**
 * Упорядоченное структурное содержимое текстового блока.
 *
 * То, что VLM отдаёт нативно, а legacy-адаптер может вычислить из GFM — или
 * честно не заполнять (`fragments: null`).
 */
export const contentFragmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('paragraph'),
    text: z.string(),
    emphasis: z.enum(['none', 'strong']).default('none'),
  }),
  z.object({
    kind: z.literal('heading'),
    /** `null` — уровень неизвестен (VLM видит «заголовок», но не иерархию). */
    level: z.number().int().min(1).max(6).nullable(),
    text: z.string(),
  }),
  z.object({ kind: z.literal('table'), table: canonicalTableSchema }),
]);
export type ContentFragment = z.infer<typeof contentFragmentSchema>;

/**
 * Рукопись, подписи, печати — ПРИЗНАКИ, не текст.
 *
 * Троичность обязательна: `null` — провайдер на это не смотрел, `false` —
 * смотрел и не нашёл. Слить их значило бы потерять разницу между «неизвестно»
 * и «отсутствует» — ровно тот класс отказа, который §9.1 запрещает правилам.
 */
export const blockFeaturesSchema = z.object({
  handwritten: z.boolean().nullable().default(null),
  signatures: z.boolean().nullable().default(null),
  seals: z.boolean().nullable().default(null),
});
export type BlockFeatures = z.infer<typeof blockFeaturesSchema>;

const blockBase = {
  /** Идентификатор блока у провайдера (`blk_…` у RD WEB); `null` — нет. */
  blockId: z.string().nullable().default(null),
  /** Замороженный блок разметки портала, если известен. */
  layoutBlockId: z.string().nullable().default(null),
  ordinal: z.number().int().nullable().default(null),
  /** [x0, y0, x1, y1], нормализовано 0..1, начало координат — левый верх. */
  coordsNorm: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  modelId: z.string().nullable().default(null),
};

export const textBlockSchema = z.object({
  ...blockBase,
  blockType: z.literal('text'),
  /** Пустая строка законна: блок без текста — состояние, а не ошибка. */
  text: z.string(),
  /** `null` ≠ `[]`: «структуры нет» против «структура есть и пуста». */
  fragments: z.array(contentFragmentSchema).nullable().default(null),
  features: blockFeaturesSchema.nullable().default(null),
});

export const imageBlockSchema = z.object({
  ...blockBase,
  blockType: z.literal('image'),
  image: z.object({
    /** «План», «Схема», «Схема стояков», «Таблица», «Смешанный фрагмент»… */
    imageType: z.string().nullable().default(null),
    axes: z.string().nullable().default(null),
    zone: z.string().nullable().default(null),
    level: z.string().nullable().default(null),
    summary: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    entities: z.array(z.string()).default([]),
    verification: z.string().nullable().default(null),
  }),
  features: blockFeaturesSchema.nullable().default(null),
});

export const stampBlockSchema = z.object({
  ...blockBase,
  blockType: z.literal('stamp'),
  stamp: z.object({
    code: z.string().nullable().default(null),
    /**
     * Собственный номер листа, напечатанный отдельной ячейкой рядом со штампом.
     *
     * Отдельно от `code` намеренно: `code` — «Обозначение» проекта по ГОСТ Р
     * 21.101 (`СТ26/01-14-ДК2-РД`), общее у всех листов раздела, а здесь номер
     * ЭТОГО листа (`К14/ДК2-СЦ4`) — тот самый, которым исполнительную схему
     * называет реестр приложений. Пока их не различали, сверка не находила ни
     * одной схемы: у документа не было номера вовсе.
     */
    sheetCode: z.string().nullable().default(null),
    stage: z.string().nullable().default(null),
    sheet: z.string().nullable().default(null),
    object: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
    organization: z.string().nullable().default(null),
    revisions: z.string().nullable().default(null),
    /** Поля штампа, которых контракт пока не знает по имени. */
    extra: z.record(z.string(), z.string()).default({}),
  }),
});

export const recognitionBlockSchema = z.discriminatedUnion('blockType', [
  textBlockSchema,
  imageBlockSchema,
  stampBlockSchema,
]);
export type RecognitionBlock = z.infer<typeof recognitionBlockSchema>;

export const recognitionPageSchema = z.object({
  /** Индекс страницы рабочего PDF, с нуля. */
  workingPageIndex: z.number().int().min(0),
  rotation: z.number().int().default(0),
  widthPx: z.number().int().positive().nullable().default(null),
  heightPx: z.number().int().positive().nullable().default(null),
  /**
   * Пре-отрендеренный текст страницы.
   *
   * Legacy-адаптер заполняет его ДОСЛОВНО — байт-в-байт с сегодняшним текстом
   * страницы, и это гарантия неизменности всех офсетов и цитат. `null` — текст
   * собирает рендерер из блоков (`renderPageText`, путь VLM).
   */
  text: z.string().nullable().default(null),
  /** Пусто — законно: страница без блоков (пустой лист скана). */
  blocks: z.array(recognitionBlockSchema),
});
export type RecognitionPage = z.infer<typeof recognitionPageSchema>;

/** Форма подписанной ссылки на кроп RD WEB — известный секрет §11. */
const SIGNED_CROP_URL = /https?:\/\/[^\s)]*\/api\/crops\//iu;

function findSignedCropUrl(value: unknown, path: readonly (string | number)[]): string | null {
  if (typeof value === 'string') return SIGNED_CROP_URL.test(value) ? path.join('.') : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSignedCropUrl(item, [...path, index]);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const found = findSignedCropUrl(item, [...path, key]);
      if (found !== null) return found;
    }
  }
  return null;
}

export const recognitionResultSchema = z
  .object({
    schemaVersion: z.literal(RECOGNITION_RESULT_SCHEMA_VERSION),
    source: z.object({
      provider: recognitionProviderSchema,
      /** `rdweb-md.v1`, `openrouter.v…` — версия адаптера, а не модели. */
      adapterVersion: z.string().min(1),
      modelId: z.string().nullable().default(null),
      generatedAt: z.string().nullable().default(null),
    }),
    pages: z.array(recognitionPageSchema),
    warnings: z.array(z.string()).default([]),
  })
  .superRefine((result, ctx) => {
    const url = findSignedCropUrl(result, []);
    if (url !== null) {
      ctx.addIssue({
        code: 'custom',
        message: `подписанная ссылка на кроп в каноническом результате запрещена (§11): ${url}`,
      });
    }
    for (let i = 1; i < result.pages.length; i += 1) {
      const prev = result.pages[i - 1];
      const current = result.pages[i];
      if (prev !== undefined && current !== undefined) {
        if (current.workingPageIndex <= prev.workingPageIndex) {
          ctx.addIssue({
            code: 'custom',
            message: `страницы обязаны идти строго по возрастанию workingPageIndex (позиция ${i})`,
          });
          break;
        }
      }
    }
  });
export type RecognitionResult = z.infer<typeof recognitionResultSchema>;
