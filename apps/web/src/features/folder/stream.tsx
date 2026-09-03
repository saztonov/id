/**
 * Живая лента ревизии: SSE с `Last-Event-ID` и восстановлением (§3.8, §14).
 *
 * ## Поток уведомляет, состояние читается по REST
 *
 * Событие говорит «посмотри ещё раз», а не «вот как теперь всё устроено».
 * Поэтому здесь нет ни одной строки, которая раскладывала бы полезную нагрузку
 * события по экрану: обработка события — это инвалидация ключей TanStack Query,
 * после которой данные приходят обычным GET. Прямое следствие требования §3.8:
 * потеря потока не должна ломать экран — она делает его лишь менее свежим.
 *
 * ## Опрос остаётся, но только когда поток не живой
 *
 * Совмещать опрос с потоком постоянно значило бы платить обоими способами и не
 * заметить, что один из них умер. Поэтому интервал опроса выключается, пока
 * поток жив, и включается, как только он потерян: `pollingIntervalMs` — это
 * ответ «чем сейчас держится свежесть экрана», и он же виден пользователю.
 *
 * ## Пропущенное запрашивается, а не додумывается
 *
 * Номер последнего принятого события хранится и уходит в `Last-Event-ID` при
 * каждом переподключении, включая первое после монтирования. Если сервер
 * отвечает `reset` (лента уже вне окна хранения), экран не делает вид, что
 * ничего не случилось: состояние перечитывается целиком, а факт разрыва ленты
 * остаётся видимым — иначе дыра в истории была бы ненаблюдаемой.
 *
 * ## Неизвестное имя события — причина перечитать, а не пропустить
 *
 * Карта префиксов знает про сегодняшние события. Событие, которого в ней нет,
 * не игнорируется: перечитывается вся ветка ревизии. Открытый мир §0.5 здесь
 * буквален — экран, молча пропускающий незнакомое, выглядит работающим и врёт.
 *
 * ## Пачка событий обесценивает одно и то же один раз (S24)
 *
 * Разметка комплекта в сотню страниц — это сотни задач, а каждая задача шлёт по
 * два события (`job.started`, `job.succeeded`). Сервер отдаёт их пачками до
 * двухсот кадров подряд (`BATCH_LIMIT` в `modules/events/sse.ts`), и каждый кадр
 * обесценивал сводку конвейера отдельно. Хуже того, `invalidateQueries` в
 * TanStack Query v5 идёт с `cancelRefetch: true` по умолчанию: он не
 * присоединяется к идущему запросу, а отменяет его и начинает новый. Двести
 * кадров превращались в двести запросов и выбивали серверный лимит за секунды.
 *
 * Поэтому ключи копятся и сбрасываются пачкой: первое событие после тишины
 * применяется сразу (одиночное событие обязано отзываться мгновенно), всё, что
 * пришло следом в пределах `COALESCE_MS`, — одним сбросом по трейлингу.
 * Инвалидация при этом идёт с `cancelRefetch: false`: идущий запрос доведёт
 * дело до конца, а не будет брошен ради точно такого же следующего.
 *
 * Это НЕ дублирует дедупликацию в `api/queue.ts`. Очередь схлопывает запросы,
 * пересёкшиеся в полёте; пришедшие подряд она честно выполнит все. Знание «эта
 * пачка событий говорит об одном и том же» есть только здесь.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { folderEvents } from '../../api/endpoints.js';
import { readEventStream, StreamRejected } from '../../api/stream.js';
import { layoutKeys, navigationKeys, folderKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';

export type StreamStatus =
  /** Соединение устанавливается — первое или после разрыва. */
  | 'connecting'
  /** Поток открыт: экран обновляется событиями. */
  | 'live'
  /** Разрыв, ждём паузу до следующей попытки. */
  | 'reconnecting'
  /** Попытки исчерпаны: свежесть держится только опросом. */
  | 'lost';

export interface FolderStreamState {
  readonly status: StreamStatus;
  /** Номер последнего принятого события: он же уходит в `Last-Event-ID`. */
  readonly lastEventId: number | null;
  readonly lastEventType: string | null;
  readonly received: number;
  readonly attempts: number;
  readonly error: string | null;
  /**
   * Сервер сообщил, что часть ленты уже вне окна хранения.
   *
   * Показывается пользователю: состояние перечитано, но история событий
   * неполна, и «ничего не произошло» здесь было бы неправдой.
   */
  readonly truncated: boolean;
  /**
   * Интервал опроса, которым экран держится сейчас. `false` — опрос не нужен,
   * свежесть даёт поток. Значение отдаётся прямо в `refetchInterval`.
   */
  readonly pollingIntervalMs: number | false;
  readonly reconnect: () => void;
}

/** Пауза опроса, когда поток недоступен. Совпадает с прежним §14-интервалом. */
const FALLBACK_POLL_MS = 5_000;
/** Начальная пауза до повтора; сервер может назвать свою полем `retry`. */
const BASE_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;
/** Сколько подряд неудачных попыток до перехода на опрос. */
const MAX_ATTEMPTS = 5;

/**
 * Ключи, которые обесцениваются событием.
 *
 * Разбор по префиксу имени, а не по полному совпадению: имена событий портала
 * пространственны (`layout.block_updated`, `documents.segmented`), и новая
 * операция внутри известной области попадает в свою группу сама.
 */
function invalidateFor(
  schedule: (queryKey: readonly unknown[]) => void,
  folderId: string,
  eventType: string,
): void {
  const invalidate = schedule;

  // Сводка стадий — производная от `job_runs`, и её меняет практически любое
  // событие конвейера. Поэтому она обновляется всегда, а не по своей группе.
  invalidate(folderKeys.processingStatus(folderId));

  const area = eventType.split('.')[0] ?? '';
  switch (area) {
    case 'file':
    case 'bundle':
      invalidate(folderKeys.files(folderId));
      invalidate(folderKeys.bundles(folderId));
      break;
    case 'layout':
      // Обновляется СПИСОК ревизий разметки, но НЕ блоки открытого черновика.
      //
      // Это не экономия запроса, а требование §7.2. Если поток подтянет чужую
      // правку в открытый редактор, вместе с блоками приедет и новая версия —
      // и следующая правка пользователя уйдёт с ней, то есть ляжет поверх
      // чужой работы без единого вопроса. Сравнение версий, которое §7.2
      // требует показать, не появится никогда: сервер ответит 200 вместо 412.
      //
      // Механизм оповещения о чужой правке в редакторе разметки уже есть, и он
      // сильнее уведомления: `If-Match` отвергает правку по устаревшей версии,
      // экран перечитывает набор и показывает расхождение, а решение —
      // принять серверную версию или применить свою заново — принимает человек.
      // Поток события лишь дублировал бы его и при этом отключал.
      invalidate(layoutKeys.folders(folderId));
      break;
    case 'recognition':
      invalidate(folderKeys.recognitionRuns(folderId));
      break;
    case 'documents':
      invalidate(folderKeys.documents(folderId));
      invalidate(folderKeys.pages(folderId));
      invalidate(folderKeys.registry(folderId));
      invalidate(folderKeys.classifications(folderId));
      // Отчёт о составе — это те же документы и те же строки реестра, только
      // сложенные вместе. Пересегментация меняет его целиком, и без этой
      // строки экран показывал бы прежнюю нарезку как актуальную.
      invalidate(folderKeys.checkReport(folderId));
      break;
    case 'checks':
      invalidate(folderKeys.checkRuns(folderId));
      invalidate(folderKeys.findings(folderId));
      invalidate(folderKeys.checkReport(folderId));
      break;
    case 'folder':
      /**
       * Карточка папки изменилась: конвейер дописал месяц (S30) или
       * исполнителя (S37), либо папка только что заведена.
       *
       * Обесценивается ПРЕФИКС `['nav']`, а не точный ключ: ключи списков несут
       * сериализованный фильтр раздела, и точное совпадение не нашло бы ни
       * одного живого запроса. Идентификатора объекта в событии нет — поток
       * адресуется папкой, — поэтому счётчики разделов обесцениваются той же
       * веткой.
       *
       * До S45 здесь стояли `workflow` и `archive`: согласование и архив сняты
       * в S44 вместе со своими экранами, а событие о правке карточки клиент
       * ждал в области `work`, которой сервер не эмитит вовсе. В сумме поток не
       * обновлял ничего: человек, вернувшийся на объект, видел «После OCR» у
       * папки, месяц которой портал уже прочитал.
       */
      invalidate(navigationKeys.root);
      break;
    case 'job':
      // Жизненный цикл задачи меняет только сводку — она уже обесценена выше.
      break;
    case 'pipeline':
      /**
       * Остановка человеком (S50): снятые задачи меняют и сводку конвейера, и
       * состояние прогона распознавания, который маршрут закрыл вместе с ними.
       * Сводка обесценена выше; прогоны — здесь, иначе полоса продолжила бы
       * показывать «идёт» по прогону, которого больше нет.
       */
      invalidate(folderKeys.recognitionRuns(folderId));
      break;
    default:
      // Незнакомая область: перечитывается вся ветка ревизии. Пропустить её
      // значило бы показать устаревший экран как актуальный.
      invalidate(['folders', folderId]);
      break;
  }
}

/** Пауза схлопывания пачки. Секунда — граница «мгновенно» для обновления сводки. */
const COALESCE_MS = 1_000;

/**
 * Планировщик инвалидаций: копит ключи и сбрасывает их пачкой.
 *
 * Ключ сравнивается по сериализации, а не по ссылке: `folderKeys.files(id)`
 * возвращает НОВЫЙ массив на каждый вызов, и `Set` по ссылкам не схлопнул бы
 * ничего.
 *
 * Первый сброс — немедленный, и это не оптимизация, а требование к отзывчивости:
 * одиночное событие (человек нажал кнопку на соседней вкладке) обязано менять
 * экран сразу, а не через секунду. Схлопывается то, что идёт следом.
 */
function useInvalidationBatch(client: QueryClient): (queryKey: readonly unknown[]) => void {
  const pending = useRef(new Map<string, readonly unknown[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlush = useRef(0);

  const flush = useCallback(() => {
    timer.current = null;
    lastFlush.current = Date.now();
    const keys = [...pending.current.values()];
    pending.current.clear();
    for (const queryKey of keys) {
      // `cancelRefetch: false` — иначе каждый сброс бросал бы идущий запрос ради
      // точно такого же следующего, и при частых событиях завершался бы только
      // последний. Именно это умножало запросы до отказа по лимиту.
      void client.invalidateQueries({ queryKey }, { cancelRefetch: false });
    }
  }, [client]);

  // Незавершённая пачка при размонтировании отбрасывается намеренно: экрана, для
  // которого её собирали, уже нет, а таймер, доживший до следующего, обновил бы
  // чужие данные.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (queryKey: readonly unknown[]) => {
      pending.current.set(JSON.stringify(queryKey), queryKey);
      if (timer.current !== null) return;
      const quiet = Date.now() - lastFlush.current >= COALESCE_MS;
      if (quiet) {
        flush();
        return;
      }
      timer.current = setTimeout(flush, COALESCE_MS);
    },
    [flush],
  );
}

const StreamContext = createContext<FolderStreamState | null>(null);

export function FolderStreamProvider({
  folderId,
  children,
}: {
  folderId: string;
  children: ReactNode;
}): ReactNode {
  const value = useFolderEventStream(folderId);
  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

/**
 * Состояние потока для вкладок ревизии.
 *
 * Вне провайдера возвращает `null`, а не бросает: вкладка обязана работать и
 * тогда, когда её открыли отдельно, — REST остаётся источником состояния.
 */
export function useFolderStream(): FolderStreamState | null {
  return useContext(StreamContext);
}

/**
 * Интервал опроса для запроса на вкладке ревизии.
 *
 * Одна точка решения вместо `refetchInterval: 5_000`, рассыпанного по экранам:
 * пока поток жив, опроса нет вовсе; как только он потерян — интервал возвращается.
 */
export function usePollingInterval(fallbackMs: number = FALLBACK_POLL_MS): number | false {
  const stream = useFolderStream();
  if (stream === null) return fallbackMs;
  return stream.pollingIntervalMs;
}

function useFolderEventStream(folderId: string): FolderStreamState {
  const queryClient = useQueryClient();
  const scheduleInvalidate = useInvalidationBatch(queryClient);

  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [lastEventId, setLastEventId] = useState<number | null>(null);
  const [lastEventType, setLastEventType] = useState<string | null>(null);
  const [received, setReceived] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  /** Ручное переподключение: смена значения перезапускает эффект. */
  const [restartToken, setRestartToken] = useState(0);

  // Номер последнего события живёт в ref, а не только в состоянии: он нужен
  // внутри цикла переподключения, который не перезапускается на каждый рендер.
  const cursor = useRef<number | null>(null);
  const retryHint = useRef<number>(BASE_RETRY_MS);

  useEffect(() => {
    cursor.current = null;
    retryHint.current = BASE_RETRY_MS;
  }, [folderId]);

  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const wait = async (ms: number): Promise<void> => {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    };

    const loop = async (): Promise<void> => {
      let failures = 0;

      while (!stopped) {
        setStatus(failures === 0 ? 'connecting' : 'reconnecting');
        try {
          const base = folderEvents.streamUrl(folderId);
          const seq = cursor.current;
          await readEventStream({
            // Номер дублируется и в запросе: заголовок `Last-Event-ID` теряется
            // на некоторых прокси, а параметр — нет, и сервер принимает оба.
            url: seq === null ? base : `${base}?lastEventId=${String(seq)}`,
            lastEventId: seq === null ? null : String(seq),
            signal: controller.signal,
            onOpen: () => {
              failures = 0;
              setAttempts(0);
              setError(null);
              setStatus('live');
            },
            onRetryHint: (delayMs) => {
              retryHint.current = Math.min(Math.max(delayMs, 1_000), MAX_RETRY_MS);
            },
            onFrame: (frame) => {
              if (stopped) return;

              if (frame.event === 'reset') {
                // Пропущенное потеряно: честный ответ — перечитать всё и
                // сказать об этом, а не продолжить с текущего момента.
                //
                // Блоки открытого черновика разметки не перечитываются и здесь,
                // по той же причине, что в `invalidateFor`: чужую правку в
                // редакторе показывает сравнение версий §7.2, а не фоновое
                // обновление, которое это сравнение и отменяет.
                setTruncated(true);
                void queryClient.invalidateQueries({ queryKey: ['folders', folderId] });
                void queryClient.invalidateQueries({
                  queryKey: layoutKeys.folders(folderId),
                });
                return;
              }

              if (frame.id !== null) {
                const parsed = Number(frame.id);
                if (Number.isInteger(parsed)) {
                  cursor.current = parsed;
                  setLastEventId(parsed);
                }
              }
              setLastEventType(frame.event);
              setReceived((count) => count + 1);
              invalidateFor(scheduleInvalidate, folderId, frame.event);
            },
          });

          // Штатное завершение: сервер закрывает соединение по потолку жизни
          // (30 минут), и это не отказ — переподключаемся сразу.
          if (stopped) return;
          failures = 0;
          setStatus('reconnecting');
          await wait(500);
          continue;
        } catch (streamError) {
          if (stopped || controller.signal.aborted) return;

          // Отказ по лимиту запросов НЕ считается неудачной попыткой.
          //
          // Поток не сломан: у вкладки кончился бюджет, и сервер назвал, когда
          // возвращаться. Считать это отказом значило бы за пять таких ответов
          // увести экран в `lost`, где свежесть держит опрос раз в пять
          // секунд, — то есть исчерпание лимита включало бы режим, который
          // тратит ЕЩЁ больше запросов, и выйти из него можно было бы только
          // кнопкой. Счётчик попыток остаётся нетронутым, а тесноту разводит
          // пауза, которую назвал сервер.
          if (streamError instanceof StreamRejected && streamError.status === 429) {
            setStatus('reconnecting');
            setError(streamError.message);
            await wait(Math.min(streamError.retryAfterMs ?? BASE_RETRY_MS, MAX_RETRY_MS));
            continue;
          }

          failures += 1;
          setAttempts(failures);
          setError(describeError(streamError));

          if (failures >= MAX_ATTEMPTS) {
            // Дальше молотить бессмысленно: свежесть держит опрос, а кнопка
            // «Подключить заново» остаётся у пользователя.
            setStatus('lost');
            return;
          }

          setStatus('reconnecting');
          const backoff = Math.min(retryHint.current * 2 ** (failures - 1), MAX_RETRY_MS);
          await wait(backoff);
        }
      }
    };

    void loop();

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
  }, [folderId, restartToken, queryClient, scheduleInvalidate]);

  const reconnect = useCallback(() => {
    setError(null);
    setAttempts(0);
    setRestartToken((token) => token + 1);
  }, []);

  return useMemo<FolderStreamState>(
    () => ({
      status,
      lastEventId,
      lastEventType,
      received,
      attempts,
      error,
      truncated,
      pollingIntervalMs: status === 'live' ? false : FALLBACK_POLL_MS,
      reconnect,
    }),
    [status, lastEventId, lastEventType, received, attempts, error, truncated, reconnect],
  );
}
