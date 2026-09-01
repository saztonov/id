/**
 * Каталог типов фоновых задач и их payload (§12).
 *
 * Одно определение на тип задачи, и в нём собрано всё, что о задаче должны
 * одинаково знать три разных места: постановщик (роут или другая задача),
 * исполнитель (воркер) и консоль администратора. Разнесённые по этим местам
 * очередь, число попыток и форма payload разъехались бы молча — постановщик
 * положил бы в payload одно поле, обработчик прочитал бы другое, и обнаружилось
 * бы это на первой поставке, а не на типах.
 *
 * ## Почему очередь выводится из типа, а не хранится колонкой
 *
 * В `jobs` колонки `queue` нет (миграция 0007), и добавлять её незачем: очередь
 * — это свойство того, чем задача занята, а не строки в таблице. Хранимое поле
 * пришлось бы поддерживать в согласии с этим файлом, то есть завести второй
 * источник правды. Захват фильтрует по списку типов очереди
 * (`jobTypesOfQueue()`), и индекс `ix_jobs_claim` этому не мешает.
 *
 * ## Как распределены очереди
 *
 * `cpu` — задачи, которые СЧИТАЮТ в процессе и держат файл в памяти: сборка
 * рабочего PDF, нарезка, превью, разбор загруженного файла, локальная детекция.
 * Их параллелизм низкий именно из-за памяти: 86 МБ комплект в pdf-lib даёт
 * 300+ МБ heap (ADR-0003), и четыре таких задачи разом — это OOM на одной VPS.
 *
 * `io` — задачи, время которых уходит на ОЖИДАНИЕ: вызовы RD WEB, S3 и запросы
 * к БД. Сюда же отнесены короткие сводные задачи (`graph.build`, `checks.*`,
 * `doc.parse_registry`): их длительность — это round-trip'ы к PostgreSQL, а не
 * счёт, и ставить их в очередь с параллелизмом 2 значило бы держать конвейер за
 * сборкой чужого PDF.
 *
 * `llm` — вызовы модели. Отдельная очередь нужна не только из-за бюджета и rate
 * limit провайдера (§10): её потолок — это ещё и число одновременных HTTP к
 * шлюзу, поэтому ВСЕ обращения к модели обязаны идти через неё (см. ниже про
 * зонд разворота, который до S41 стоял в `io`).
 */
import { z } from 'zod';
import { type ProcessingStage } from '@id/contracts';

// =====================================================================
// Очереди
// =====================================================================

export const JOB_QUEUES = ['io', 'cpu', 'llm'] as const;
export type JobQueue = (typeof JOB_QUEUES)[number];

/**
 * Диапазоны параллелизма и значение по умолчанию.
 *
 * Диапазон хранится рядом со значением намеренно: настройка воркера обязана
 * проверяться против плана, а не «сколько поставили». `clampConcurrency()`
 * не даёт выйти за границы, иначе одна переменная окружения превратила бы
 * `cpu` в четыре параллельных qpdf.
 *
 * ## Почему нижние границы опущены до 1, а умолчания снижены (S41)
 *
 * Исходные диапазоны (io 4–8, cpu 1–2, llm 2–4) писались под выделенную машину.
 * На общем VPS 2 vCPU они дали 11 одновременных задач: комплект на 220 страниц
 * запускает разметку и распознавание, и хост уходит в swap — вместе с соседними
 * порталами. Эксплуатация при этом была лишена и аварийной ручки: `min` не
 * пускал `io` ниже 4 и `llm` ниже 2, то есть «прижать воркер до утра» можно было
 * только правкой кода.
 *
 * Поэтому `min` теперь 1 у всех трёх очередей, а умолчания рассчитаны на две
 * реальные границы машины: сумма (4 + 1 + 2 = 7) обязана оставаться МЕНЬШЕ
 * `PG_POOL_MAX` (умолчание 10) — иначе задачи начинают ждать соединение, и это
 * ожидание попадает в `db_query_slow` как «медленная БД», уводя разбор не туда, —
 * и `cpu` держится на 1, потому что второй параллельный инференс ONNX на двух
 * ядрах не ускоряет разметку, а отбирает процессор у API соседей.
 *
 * Ноль не разрешён сознательно: «очередь выключена» — это не настройка, а
 * состояние, при котором задачи копятся молча. Не исполнять тип задач можно
 * единственным честным способом — не регистрировать обработчик.
 */
export const QUEUE_CONCURRENCY: Readonly<
  Record<JobQueue, { readonly min: number; readonly max: number; readonly default: number }>
> = {
  io: { min: 1, max: 8, default: 4 },
  cpu: { min: 1, max: 2, default: 1 },
  llm: { min: 1, max: 4, default: 2 },
};

export function clampConcurrency(queue: JobQueue, requested: number | undefined): number {
  const range = QUEUE_CONCURRENCY[queue];
  if (requested === undefined || !Number.isFinite(requested)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.trunc(requested)));
}

// =====================================================================
// Payload
// =====================================================================

/**
 * Общая часть payload любой задачи.
 *
 * `request_id` — сквозной идентификатор (§11), и ключ именно в snake_case:
 * его кладёт `tracePayload()` из слоя наблюдаемости, а воркер поднимает
 * контекст `requestIdFromPayload()`. Второе написание ключа означало бы
 * оборванную цепочку «HTTP → job → вызов RD WEB», причём молча.
 */
const basePayload = z.object({
  request_id: z.string().min(1).max(128).optional(),
});

const uuid = z.uuid();

/** Задача, работающая над ревизией поставки. Таких — большинство. */
const folderPayload = basePayload.extend({ folderId: uuid });

/**
 * Сквозной прогон: «доведи до конца, не спрашивая» (S21).
 *
 * До S21 конвейер стоял на пяти остановках, и каждую снимал человек отдельной
 * кнопкой. Заказчик потребовал двух: «Разметить» и «Проверить». Признак несёт
 * ИМЕННО ЭТО решение и передаётся по цепочке от звена к звену.
 *
 * Почему в payload, а не чтением настройки в момент стыка: настройку к тому
 * времени успевают сменить, и половина цепочки прошла бы по одному решению, а
 * половина — по другому. Ровно этим соображением ADR-0007 пиннит провайдера и
 * модель в снимке прогона, и здесь оно то же: задача обязана считать заказанным
 * то, что названо в payload.
 *
 * Отсутствие поля равно `false` — старый пошаговый путь инженера («Собрать
 * документы» отдельной кнопкой) не меняется вовсе и остаётся доступен.
 */
const autoContinue = z.boolean().optional();

/** Звено цепочки анализа: сквозной прогон протягивается через все шесть. */
const analysisPayload = folderPayload.extend({ autoContinue });

const filePayload = folderPayload.extend({ sourceFileId: uuid });

/**
 * Задачи разметки 4–6 и 9: рабочий документ И ревизия разметки.
 *
 * `layoutRevisionId` обязателен, хотя «текущий черновик этого bundle» найти
 * можно и без него. Нельзя: черновик у поставки один, но за время жизни
 * поставки их сменяется несколько (вытеснение №1 → создание №2), и задача,
 * поставленная для первой ревизии, отработала бы по второй, выдав диагностику,
 * противоположную факту. Цель обязана адресоваться явно — так же, как её уже
 * адресуют задачи 7 и 8.
 */
const markupPayload = folderPayload.extend({
  bundleId: uuid,
  layoutRevisionId: uuid,
});

/**
 * Вход зонда ориентации: ОДНА страница.
 *
 * `layoutRevisionId` нужен, чтобы по завершении поставить детекцию именно этой
 * разметки; `sourcePageId` — ключ строки разворота (он переживает пересборку
 * рабочего документа, в отличие от индекса листа).
 */
const orientationProbePayload = folderPayload.extend({
  layoutRevisionId: uuid,
  bundleId: uuid,
  sourcePageId: uuid,
  workingPageIndex: z.int().nonnegative(),
});

const layoutPayload = folderPayload.extend({
  layoutRevisionId: uuid,
  /**
   * Страницы пачкой: детекция у RD WEB синхронная и постраничная (§5.2, п.3),
   * поэтому одна задача = одна пачка, а не весь комплект.
   */
  pageIndices: z.array(z.int().nonnegative()).min(1).max(20).optional(),
  /**
   * Перезаписать уже размеченные страницы (§5.3, «повторить детекцию»).
   *
   * Ставится ТОЛЬКО явным действием пользователя (`POST /layouts/{id}/detect`).
   * Первичная цепочка «Разметить файл» его не ставит: автоматическая
   * переразметка не имеет права стирать сделанное. Без флага удалённая сторона
   * возвращает такие страницы в `skipped_pages`, и импорт их не трогает.
   */
  overwriteExisting: z.boolean().optional(),
});

const recognitionPayload = folderPayload.extend({ recognitionRunId: uuid, autoContinue });

/** Обслуживание: ревизии у такой задачи нет, и это не упущение payload. */
const maintenancePayload = basePayload.extend({
  /** Ограничение объёма одного прохода: сборка мусора не должна идти часами. */
  batchLimit: z.int().positive().max(10_000).optional(),
});

// =====================================================================
// Определения задач
// =====================================================================

export interface JobDefinition<TPayload extends z.ZodType = z.ZodType> {
  readonly queue: JobQueue;
  readonly payload: TPayload;
  /**
   * Стадия конвейера для вычисляемого `processing_status` (§3.8).
   *
   * `null` — обслуживающая задача: она не относится к поставке, и включать её
   * в сводку по ревизии нельзя.
   */
  readonly stage: ProcessingStage | null;
  readonly maxAttempts: number;
  /**
   * Аренда: сколько задача может выполняться без продления, прежде чем reaper
   * сочтёт воркера мёртвым. Продлевается сердцебиением (`runner.ts`), поэтому
   * значение — это не «сколько задача идёт», а «через сколько после смерти
   * воркера её подберут заново».
   */
  readonly leaseMs: number;
  /** Больше — раньше в очереди. Совпадает с `jobs.priority`. */
  readonly priority: number;
}

const DEFAULT_LEASE_MS = 60_000;
/** Внешний вызов может ждать минутами, и сердцебиение не должно быть единственной защитой. */
const EXTERNAL_LEASE_MS = 180_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PRIORITY = 100;

/**
 * Полный список задач §12 в порядке конвейера.
 *
 * Тип объявлен здесь даже тогда, когда обработчика ещё нет (он появится на
 * своём этапе): отсутствие обработчика — это отказ конкретной задачи с внятным
 * классом ошибки, а отсутствие типа — расхождение постановщика и исполнителя,
 * которое типами уже не ловится.
 */
export const JOB_DEFINITIONS = {
  // 1–3. Приём файлов и сборка рабочего документа (§4.2, §3.3).
  'file.verify': {
    queue: 'cpu',
    payload: filePayload,
    stage: 'uploaded',
    maxAttempts: 3,
    leaseMs: 300_000,
    priority: 200,
  },
  'file.signature_probe': {
    queue: 'cpu',
    payload: filePayload,
    stage: 'uploaded',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: 150,
  },
  'bundle.build': {
    queue: 'cpu',
    payload: folderPayload.extend({
      /**
       * Продолжить разметкой сразу после сборки (кнопка S21 «Разметить»).
       *
       * Разметка ложится на страницы рабочего документа, поэтому в момент
       * нажатия ставить её нечем — bundle ещё не существует. Признак несёт
       * заказ «за сборкой идёт детекция», и обработчик выполняет его сам.
       * Прежняя кнопка «Собрать рабочий документ» его не ставит и работает
       * ровно как раньше.
       */
      startMarkup: z.boolean().optional(),
    }),
    stage: 'uploaded',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: 150,
  },

  // 4–9. Разметка (§6.1).
  'rd.create_run_document': {
    queue: 'io',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'rd.upload_working_pdf': {
    queue: 'io',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },
  'rd.wait_pages': {
    queue: 'io',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: 30,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Звено «сборка → разметка» кнопки S21 «Разметить».
   *
   * Существует ровно потому, что разметка ложится на страницы РАБОЧЕГО
   * документа: в момент нажатия его ещё нет, и поставить детекцию нечем —
   * `layout.detect_local` требует `layoutRevisionId`, а черновик разметки
   * создаётся от `bundleId`. Задача выполняет то, что при готовом bundle делает
   * маршрут: черновик разметки, чтение `detection.provider`, постановка пачек
   * (`startMarkupOnBundle`, общий с маршрутом код).
   *
   * Очередь `io`: время уходит на чтение карты страниц и постановку задач.
   * Собственной стадии не заводит — она принадлежит разметке, как и всё, что
   * ставит.
   */
  'layout.start': {
    queue: 'io',
    payload: folderPayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'layout.detect_pages': {
    queue: 'io',
    payload: layoutPayload,
    stage: 'layout',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Локальная детекция RF-DETR (ADR-0008): растеризация страницы на воркере и
   * ONNX-инференс на CPU. Ставится вместо цепочки `rd.*` при
   * `detection.provider='local'`. Очередь cpu: рендер и инференс держат ядро
   * и сотни мегабайт на страницу.
   */
  'layout.detect_local': {
    queue: 'cpu',
    payload: layoutPayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Зонд ориентации страницы (ADR-0020): в какую сторону повёрнут скан.
   *
   * ОТДЕЛЬНАЯ задача, а не шаг детекции, и не шаг распознавания. По времени она
   * обязана отработать ДО детекции — значит внутри `vlm.recognize_page` быть не
   * может. По существу она не должна быть и шагом `layout.detect_local`: у них
   * разные последствия (тот же довод, что в шапке `signature-probe.ts`). Отказ
   * детекции — страница без блоков; отказ зонда не имеет права останавливать
   * конвейер. Смешав их, мы дали бы одному таймауту шлюза сжигать
   * 600-секундную аренду очереди `cpu` и переигрывать вместе с собой
   * ONNX-инференс.
   *
   * Одна СТРАНИЦА на задачу: цикл по восьмидесяти трём держал бы аренду на
   * восемьдесят три вызова модели и переигрывал бы сделанное при падении.
   *
   * ## Очередь `llm`, хотя вызов короткий (S41)
   *
   * Прежде зонд стоял в `io` — «вызов один, на маленькой картинке, это сеть, а
   * не поток распознавания». Довод оказался неверным в главном: очередь `llm`
   * ограничивает не только бюджет провайдера, но и число одновременных
   * обращений к шлюзу. Зонд, стоя в `io`, добавлял к трём распознаваниям ещё
   * шесть параллельных вызовов — девять к шлюзу с одного воркера, и комплект на
   * 220 страниц выпускал их залпом, потому что зонд ставится на каждую страницу
   * сразу. Всякое обращение к модели обязано идти через одну очередь, иначе её
   * потолок ничего не значит.
   *
   * Приоритет выше обычного: зонд — вход разметки, и ждать за листами чужого
   * распознавания ему незачем. Он короткий и слот освобождает быстро.
   *
   * Стадия `layout`: зонд принадлежит разметке — он готовит её вход.
   */
  'page.orientation_probe': {
    queue: 'llm',
    payload: orientationProbePayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: 120_000,
    priority: 150,
  },
  'layout.analyze_coverage': {
    queue: 'io',
    payload: layoutPayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'preview.cache_pages': {
    queue: 'cpu',
    payload: markupPayload,
    stage: 'layout',
    maxAttempts: 3,
    leaseMs: 600_000,
    // Ниже остальных: превью — ускорение экрана, а не условие продолжения.
    priority: 50,
  },

  // 10–13. Распознавание (§5.2, §6.2).
  //
  // Все четыре адресуют ПРОГОН, а не ревизию разметки: прогон уже пиннит и
  // ревизию разметки, и её `blocks_hash`, и рабочий PDF, и RD-документ, то есть
  // всё, что задача обязана считать заказанным. Payload, называющий только
  // разметку, позволил бы задаче цикла сверки отработать по одному прогону, а
  // старту OCR — по другому, и хэши сравнивались бы не с тем, что заказано.
  'layout.reconcile': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'rd.start_recognition': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    // Повтор старта OCR — это второй прогон на GPU. Единственная попытка:
    // неуспех обязан разбираться человеком, а не переигрываться автоматом.
    maxAttempts: 1,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'rd.poll_recognition': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: 60,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'rd.fetch_export_once': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },

  // Распознавание через OpenRouter VLM (ADR-0007). Ставится вместо цепочки
  // rd.start/poll/fetch при settings_snapshot.provider='openrouter_vlm'.
  // Прогресс и покрытие живут в recognition_run_pages/block_results, а не в
  // payload'ах: повтор любой задачи опирается на состояние БД.
  'vlm.start_recognition': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Одна страница = одна задача: кропы блоков страницы уходят в VLM
   * последовательными вызовами, checkpoint — в block_results (ON CONFLICT).
   * Параллелизм даёт сама очередь llm; внутренняя конкуренция сорвала бы
   * потолок одновременности шлюза (3 на клиента).
   */
  'vlm.recognize_page': {
    queue: 'llm',
    payload: recognitionPayload.extend({ pageIndex: z.int().nonnegative() }),
    stage: 'recognition',
    /**
     * Восемь попыток, а не общие пять (S41).
     *
     * Повтор этой задачи дёшев по построению: чекпоинт в `block_results`
     * пропускает уже записанные блоки, и вторая попытка платит только за то,
     * что осталось. Дорого обратное — потерять страницу, потому что окно
     * недоступности шлюза совпало с её пятью попытками. Предохранитель очереди
     * такие окна теперь пережидает, но попытки, потраченные до паузы, задаче
     * никто не вернёт, и запас нужен именно на них.
     */
    maxAttempts: 8,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Идемпотентный сборщик: ждёт терминальности всех строк
   * recognition_run_pages (паттерн poll, как rd.poll_recognition), затем
   * собирает RecognitionResult, валидирует и публикует одной транзакцией.
   *
   * `maxAttempts` — 240, и это не «на всякий случай». Ожидание страниц теперь
   * записывается исходом `deferred`, а не `failed`, поэтому попытки здесь
   * измеряются не отказами, а вопросами «уже готово?»: при потолке
   * `DEFERRAL_BACKOFF` в минуту 240 вопросов дают около четырёх часов
   * терпения. Прежние 60 при том же потолке кончались за час — на комплекте,
   * где очередь `llm` разбирает восемьдесят страниц по три за раз, этого мало,
   * и прогон закрывался отказом ровно тогда, когда работа шла.
   */
  'vlm.finalize_run': {
    queue: 'io',
    payload: recognitionPayload,
    stage: 'recognition',
    maxAttempts: 240,
    leaseMs: EXTERNAL_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },

  // 14–19. Сегментация и извлечение (§8).
  'doc.classify_pages': {
    queue: 'llm',
    payload: analysisPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  'doc.segment': {
    queue: 'llm',
    payload: analysisPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Постановщик веера, а не сама работа (S44).
   *
   * До S44 это была ОДНА задача на всю папку с потолком аренды в десять минут.
   * На боевой папке из 134 документов три попытки по 600 011 мс кончились
   * `JobTimeout`, и прогон встал красной плашкой «задача исчерпала попытки».
   * Теперь задача только раскладывает работу по документам и ставит барьер;
   * своих вызовов модели у неё нет, и десяти минут ей хватает с запасом.
   */
  'doc.extract_fields': {
    queue: 'llm',
    payload: analysisPayload.extend({ documentId: uuid.optional() }),
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Реквизиты ОДНОГО документа: единица веера (S44).
   *
   * `generation` — идентификатор задачи-постановщика. Он же в барьере: без него
   * финализатор не отличил бы задачи своего прогона от задач следующего, а
   * повторная сегментация ставит веер заново, пока предыдущий ещё разбирается.
   *
   * Две минуты аренды, а не десять: документ — это один-два вызова модели, и
   * потолок обязан отличать «шлюз завис» от «работа идёт». Отказ одного
   * документа не убивает папку (дух ADR-0017): он остаётся с базовыми
   * реквизитами правил, а барьер называет число таких в событии.
   */
  'doc.extract_document': {
    queue: 'llm',
    payload: analysisPayload.extend({ documentId: uuid, generation: uuid }),
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: 120_000,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * Барьер веера и единственный преемник полного прогона (S44).
   *
   * Очередь `io`, а не `llm`, и это существенно: потолок одновременности `llm`
   * по умолчанию два, и барьер, ждущий свой же веер в той же очереди, занимал
   * бы одно из двух мест — то есть тормозил бы ровно то, чего ждёт.
   *
   * 240 попыток по тем же основаниям, что у `vlm.finalize_run`: ожидание
   * записывается исходом `deferred`, а не отказом, и при потолке
   * `DEFERRAL_BACKOFF` в минуту это около четырёх часов терпения.
   */
  'doc.extract_finalize': {
    queue: 'io',
    payload: analysisPayload.extend({ generation: uuid }),
    stage: 'analysis',
    maxAttempts: 240,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'doc.parse_registry': {
    queue: 'io',
    payload: analysisPayload.extend({ documentId: uuid.optional() }),
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'doc.match_registry': {
    queue: 'io',
    payload: analysisPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'graph.build': {
    queue: 'io',
    payload: analysisPayload,
    stage: 'analysis',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },

  /**
   * Сверка ОПИСИ ПЕРЕДАЧИ с комплектами папки (S20).
   *
   * ## Почему payload называет ПАПКУ, а не ревизию
   *
   * Так адресуется единственная задача конвейера, у которой нет «своей»
   * ревизии: сверяется папка целиком, а скан описи — лишь один из её входов.
   * Решение не косметическое, и вот почему.
   *
   * `enqueueJob` проверяет областью `folderId` из payload — рубеж против
   * «поставить задачу на чужую поставку, зная её идентификатор» (§16). Но скан
   * описи подан ГЕНПОДРЯДЧИКОМ, а запускать сверку вправе и субподрядчик: ему
   * важно знать об ошибках в своих документах. Назови payload ревизию скана —
   * и подрядчик получал бы 422 на собственной папке, а «починка» этого через
   * обход проверки открыла бы ровно ту дыру, ради которой она стоит.
   *
   * Поэтому рубежом служит сам реестр: маршрут начинается с `findRegistry` по
   * области, а ревизию скана обработчик находит САМ по ключу. Payload при этом
   * нечему соврать — ревизии в нём нет вовсе.
   *
   * `stage: null` — следствие: сводка конвейера (§3.8) считается над задачами
   * ревизии, и сверка папки выглядела бы в ней стадией чужой поставки.
   *
   * Очередь `io`: время уходит на запросы к БД по всем комплектам папки, а не
   * на счёт. Задача терминальная — ничего не ставит дальше.
   */
  'registry.reconcile': {
    queue: 'io',
    payload: basePayload.extend({ registryId: uuid }),
    stage: null,
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },

  // 20–23. Проверки и выдача (§9, §10 плана: нарезка после подтверждения границ).
  'checks.run': {
    queue: 'io',
    payload: folderPayload.extend({ validationRunId: uuid.optional() }),
    stage: 'checks',
    maxAttempts: 3,
    leaseMs: 600_000,
    priority: DEFAULT_PRIORITY,
  },
  /**
   * ИИ-проверка заполнения (§9.1, S21) — второй этап проверки.
   *
   * Пишет в ТОТ ЖЕ `validation_run`, что и `checks.run`, поэтому его
   * идентификатор обязателен в payload: собственный прогон означал бы две
   * строки «проверка от 12:31» на один вопрос. Ставится между `checks.run` и
   * `checks.summarize` — сводка обязана считаться уже с её замечаниями.
   *
   * Очередь `llm`: время уходит на вызовы модели, по одному на документ.
   */
  'checks.llm_review': {
    queue: 'llm',
    payload: folderPayload.extend({ validationRunId: uuid }),
    stage: 'checks',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },
  'checks.summarize': {
    queue: 'io',
    payload: folderPayload.extend({ validationRunId: uuid }),
    stage: 'checks',
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'doc.materialize_pdf': {
    queue: 'cpu',
    payload: folderPayload.extend({ documentId: uuid.optional() }),
    stage: 'ready',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },
  'submission.build_archive': {
    queue: 'cpu',
    payload: folderPayload,
    stage: 'ready',
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: DEFAULT_PRIORITY,
  },

  // 24–25. Обслуживание.
  'jobs.reaper': {
    queue: 'io',
    payload: maintenancePayload,
    stage: null,
    maxAttempts: 1000,
    leaseMs: DEFAULT_LEASE_MS,
    // Выше всех: освобождение зависших аренд — условие работы остальных.
    priority: 500,
  },
  'storage.gc': {
    queue: 'io',
    payload: maintenancePayload,
    stage: null,
    maxAttempts: 3,
    leaseMs: 900_000,
    priority: 10,
  },

  // 26–27. Массовый ввод справочников (0027). К ревизии отношения не имеют,
  // поэтому `stage` у них пуст: сводка конвейера (§3.8) считается над задачами
  // ревизии, и импорт справочника в ней выглядел бы стадией чужой поставки.
  'catalog.import.parse': {
    // Очередь `cpu`, а не `io`: задача держит книгу в памяти и разбирает XML —
    // это счёт, а не ожидание. В `io` она конкурировала бы за слоты с
    // короткими сводными задачами конвейера.
    queue: 'cpu',
    payload: basePayload.extend({ importId: uuid }),
    stage: null,
    // Повтор не поможет: файл не изменится между попытками, а разбор
    // детерминирован. Единственная причина второй попытки — падение воркера
    // до записи результата.
    maxAttempts: 2,
    leaseMs: DEFAULT_LEASE_MS,
    priority: DEFAULT_PRIORITY,
  },
  'catalog.import.expire': {
    queue: 'io',
    payload: maintenancePayload,
    stage: null,
    maxAttempts: 3,
    leaseMs: DEFAULT_LEASE_MS,
    priority: 10,
  },
} as const satisfies Record<string, JobDefinition>;

export type JobType = keyof typeof JOB_DEFINITIONS;

export const JOB_TYPES = Object.keys(JOB_DEFINITIONS) as readonly JobType[];

/** Типизованный payload по типу задачи: обработчик получает разобранное значение. */
export type JobPayloadMap = {
  [K in JobType]: z.infer<(typeof JOB_DEFINITIONS)[K]['payload']>;
};

export type JobPayload<K extends JobType = JobType> = JobPayloadMap[K];

/** Payload любой задачи в виде, пригодном для чтения общим кодом. */
export type AnyJobPayload = Record<string, unknown> & {
  readonly request_id?: string;
  readonly folderId?: string;
};

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && Object.hasOwn(JOB_DEFINITIONS, value);
}

export function jobDefinition<K extends JobType>(type: K): (typeof JOB_DEFINITIONS)[K] {
  return JOB_DEFINITIONS[type];
}

export function queueOf(type: JobType): JobQueue {
  return JOB_DEFINITIONS[type].queue;
}

export function stageOf(type: JobType): ProcessingStage | null {
  return JOB_DEFINITIONS[type].stage;
}

export function jobTypesOfQueue(queue: JobQueue): readonly JobType[] {
  return JOB_TYPES.filter((type) => JOB_DEFINITIONS[type].queue === queue);
}

/**
 * Разбор payload по схеме типа.
 *
 * Возвращает результат, а не бросает: непригодный payload — это дефект
 * постановщика, и задача обязана уйти в dead с внятным сообщением, а не
 * повторяться пять раз с одинаковым исходом.
 */
export function parseJobPayload<K extends JobType>(
  type: K,
  raw: unknown,
): { ok: true; payload: JobPayloadMap[K] } | { ok: false; problems: string[] } {
  const parsed = JOB_DEFINITIONS[type].payload.safeParse(raw);
  if (parsed.success) return { ok: true, payload: parsed.data as JobPayloadMap[K] };
  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(корень)'}: ${issue.message}`,
    ),
  };
}

/** Ревизия из payload, если задача к ней относится. Нужна и `job_runs`, и контексту. */
export function folderIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as { folderId?: unknown }).folderId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// =====================================================================
// Идемпотентность и отпечаток payload
// =====================================================================

/**
 * Ключ дедупликации (§12).
 *
 * Частичный уникальный индекс `ux_jobs_dedupe_key` действует, пока задача не
 * выполнена и не отменена, поэтому ключ отвечает на вопрос «эта работа уже
 * поставлена?», а не «эта работа когда-либо выполнялась?». Второй вопрос
 * решается состоянием домена (bundle собран, файл проверен), а не очередью:
 * иначе повторная подача после возврата ревизии не запустила бы конвейер.
 *
 * Отменённая задача ключ отпускает (0039), мёртвая — держит: «сняли сами» и
 * «отказало насмерть» требуют разного продолжения.
 *
 * Части ключа склеиваются через `:` и сам тип идёт первым — ключ читается
 * глазами в консоли задач, и «чей это ключ» не должно требовать запроса.
 */
export function dedupeKeyFor(type: JobType, ...parts: readonly string[]): string {
  return [type, ...parts].join(':');
}

/**
 * Отпечаток payload для `job_runs.payload_digest` НЕ считается здесь.
 *
 * Он вычисляется в SQL прямо в операторе захвата (`claimJobs`): `jsonb` хранится
 * с нормализованным порядком ключей, поэтому `payload::text` канонический, а
 * подсчёт на стороне Node потребовал бы второго round-trip'а между захватом
 * задачи и записью попытки — то есть окна, в котором попытка идёт, а строки
 * `job_runs` о ней нет.
 */

// =====================================================================
// Повторы
// =====================================================================

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly factor: number;
  readonly capMs: number;
  /** Доля случайного разброса: 0.2 — ±20%. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 5_000,
  factor: 2,
  capMs: 600_000,
  jitter: 0.2,
};

/**
 * Отдельная политика для ОТСРОЧЕК — не отказов.
 *
 * Повтор после отказа и повтор после «условие ещё не наступило» решают разные
 * задачи, и общая политика была бы неверна для обоих. Отказ повторяют редко и
 * всё реже: внешний сервис надо дать в покое, а десятиминутный потолок — цена
 * одной неудачной поставки. Ожидание — наоборот: спрашивать надо часто, потому
 * что ответ «уже готово» может прийти в любую секунду, и десять минут молчания
 * над готовым результатом означали бы, что конвейер стоит на ровном месте.
 *
 * Отсюда мягкий множитель (1.6 против 2) и потолок в минуту против десяти:
 * ждать дольше минуты бессмысленно, а расти вовсе — вредно, поскольку число
 * попыток здесь измеряется сотнями и каждая стоит одного запроса к своей базе.
 */
export const DEFERRAL_BACKOFF: BackoffPolicy = {
  baseMs: 5_000,
  factor: 1.6,
  capMs: 60_000,
  jitter: 0.2,
};

/**
 * Задержка перед следующей попыткой: экспонента с потолком и разбросом (§12).
 *
 * Потолок обязателен: без него шестая попытка ушла бы на часы, и падение
 * внешнего сервиса на минуту стоило бы поставке половины дня. Разброс — чтобы
 * сотня задач, упавших от одного сбоя RD WEB, не пошла в повтор одной секундой.
 */
export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = Math.min(policy.capMs, policy.baseMs * Math.pow(policy.factor, exponent));
  const spread = raw * policy.jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(raw + delta));
}
