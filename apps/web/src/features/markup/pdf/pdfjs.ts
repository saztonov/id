/**
 * Настройка pdf.js для просмотра страниц разметки (§7.1, §4.2).
 *
 * ## Байты приходят через наш эндпоинт, а не по presigned URL
 *
 * `PREVIEW_MODE=pdfjs` — режим по умолчанию: страницы рендерит браузер, а байты
 * он получает по адресу `/api/v1/files/{id}/content` — same-origin, под cookie
 * сессии, с поддержкой `Range`. Presigned URL наружу не выдаётся никогда: он
 * утекает в историю браузера и обходит RBAC на время своего TTL, а стандарт сам
 * относит его к секретам. Никакого другого источника байтов в этом модуле нет и
 * появиться не должно — `getDocument` вызывается только с нашим путём.
 *
 * ## «Запуск без исполнения встроенного JavaScript» в версии 6.2.108
 *
 * План называет опцию `isEvalSupported`. В pdf.js 6 её НЕТ: проверено прямым
 * поиском по `build/pdf.mjs` и `build/pdf.worker.mjs` — ноль совпадений, а в
 * `DocumentInitParameters` такого поля не объявлено. Библиотека перестала
 * использовать `eval` вовсе, поэтому опция, которой можно было бы это запретить,
 * исчезла вместе с причиной. Ставить её «на всякий случай» нельзя: при
 * `exactOptionalPropertyTypes` это ошибка типа, а в рантайме — молча
 * игнорируемое поле, создающее видимость защиты.
 *
 * Требование плана в этой версии обеспечивается тремя настройками, каждая из
 * которых что-то действительно выключает:
 *
 * * `enableXfa: false` — XFA это форма, поведение которой задаётся скриптом;
 *   выключение движка XFA и есть отказ от исполнения встроенной логики;
 * * `annotationMode: AnnotationMode.DISABLE` при рендере — аннотации не
 *   исполняются и не рисуются, значит `/OpenAction`, `/AA` и `/JS` в них
 *   недостижимы;
 * * слой аннотаций не строится вовсе, а `docBaseUrl` не задаётся, поэтому
 *   относительная ссылка внутри документа не может быть восстановлена в
 *   абсолютную и открыта. Авто-открытия внешних ссылок в портале нет, потому что
 *   нет кода, который бы их открывал: страница рисуется в `<canvas>`, и
 *   кликабельных элементов документа на ней не существует.
 *
 * ## Range, а не «скачать 86 МБ»
 *
 * `disableStream: true` вместе с `disableAutoFetch: true` — это условие того,
 * что по сети идут единицы мегабайт: без выключенного стриминга pdf.js
 * продолжает докачивать документ целиком, и опция `disableAutoFetch`, по её
 * собственной документации, не работает.
 */
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
// Воркер отдаётся сборщиком как отдельный ресурс: `?url` даёт адрес файла,
// который Vite положит в сборку. Загружать воркер с CDN нельзя — портал
// работает в контуре без внешних адресов.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Режим аннотаций при рендере: не исполнять и не рисовать. */
export const SAFE_ANNOTATION_MODE: number = AnnotationMode.DISABLE;

/**
 * Кэш открытых документов на файл.
 *
 * Экран разметки листает страницы одного комплекта, и открывать документ заново
 * на каждый переход означало бы заново читать таблицу xref по сети. Ключ —
 * идентификатор файла: содержимое неизменяемо (§3.3), поэтому кэш не может
 * устареть.
 */
const documents = new Map<string, Promise<PDFDocumentProxy>>();

export function openDocument(fileId: string, contentUrl: string): Promise<PDFDocumentProxy> {
  const cached = documents.get(fileId);
  if (cached !== undefined) return cached;

  const task = getDocument({
    url: contentUrl,
    // Форма XFA не рендерится: см. заголовок модуля.
    enableXfa: false,
    // Оба флага нужны вместе, иначе докачка продолжится.
    disableStream: true,
    disableAutoFetch: true,
    // Шрифты, которых нет в документе, не подменяются системными: это лишний
    // источник расхождения того, что видит разметчик, с тем, что распознаёт OCR.
    useSystemFonts: false,
    // `docBaseUrl` не задаётся намеренно: без него относительная ссылка внутри
    // документа не восстанавливается в абсолютную.
  }).promise;

  documents.set(fileId, task);
  // Неудачное открытие не должно застревать в кэше: следующий заход обязан
  // попробовать снова, иначе один сетевой сбой закрывает файл до перезагрузки.
  task.catch(() => documents.delete(fileId));
  return task;
}

/** Освобождение документов: вызывается при уходе с экрана разметки. */
export async function closeDocuments(): Promise<void> {
  const opened = [...documents.values()];
  documents.clear();
  await Promise.all(
    opened.map(async (task) => {
      try {
        const document = await task;
        await document.cleanup();
      } catch {
        // Документ не открылся — освобождать нечего.
      }
    }),
  );
}

export type { PDFDocumentProxy, PDFPageProxy };
