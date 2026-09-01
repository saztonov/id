/**
 * Три шага приёма файла (§4.2): `init` → PUT байтов → `complete`.
 *
 * Вынесено из `FilesTab`, потому что вызывающих стало три — обычная загрузка,
 * замена файла и форма «завести комплект файлом». Копия этих тридцати строк во
 * втором месте разошлась бы с первым на первой же правке, а расходятся здесь
 * вещи, о которых узнают поздно: заголовки, `credentials`, разбор отказа
 * preflight и число попыток.
 *
 * ## Почему PUT идёт голым `fetch`, а не через `api/http.ts`
 *
 * Адрес непрозрачен для клиента (в бою это presigned PUT в S3), и общая
 * обёртка приложила бы заголовок CSRF и наше JSON-оборачивание, которые S3
 * отвергнет подписью. Клиент, заливающий 200 МБ, cookie при этом не держит:
 * `same-origin` не мешает драйверу `local` на нашем origin и не отправляет
 * cookie чужому.
 *
 * ## Почему заливка повторяется, а `init` и `complete` — нет
 *
 * 5xx у хранилища — это заведомо ВРЕМЕННЫЙ отказ, и повтор с паузой является
 * штатным способом с ним обращаться: 26 августа 2026 года три подряд `HTTP 500`
 * от Cloud.ru стоили подрядчику всей загрузки, хотя часом раньше через тот же
 * бакет прошли 86 МБ. Повтор здесь безопасен: тело — тот же `File` и читается
 * заново, PUT по ключу `uploads/{uuid}` перезаписывает объект целиком, талон
 * живёт час, а `complete` вызывается только после успеха. У `init` и `complete`
 * такого свойства нет — они меняют состояние портала, и повтором занимается
 * общий транспорт вместе с ключом идемпотентности.
 */
import { files } from '../../api/endpoints.js';
import { describeStorageRejection, describeUploadFailure } from '../../api/problem.js';
import type { SourceFile, UploadTicket } from '../../api/types.js';
import { reportClientError } from '../../app/errorReporting.js';

/**
 * Сколько раз портал пробует отдать байты.
 *
 * Три попытки и паузы 1 с и 3 с — это не больше четырёх секунд ожидания сверх
 * самой заливки. Больше значило бы держать человека перед экраном, который
 * молчит, ради отказа, который уже выглядит постоянным.
 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** Пауза перед следующей попыткой. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Отказ, который стоит повторить.
 *
 * 5xx — временная поломка хранилища, 429 — просьба сбавить темп. Остальные
 * 4xx повторять бессмысленно: 403 означает просроченную или неверную подпись,
 * 413 — превышение лимита, и вторая попытка получит ровно то же самое.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

interface Failure {
  readonly retryable: boolean;
  readonly message: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly cause: unknown;
}

type Attempt = { readonly ok: true } | { readonly ok: false; readonly failure: Failure };

/**
 * Одна попытка отдать байты.
 *
 * Вынесена отдельно, потому что разбор ответа сам умеет бросать: сложи его в
 * общий `try` вокруг `fetch` — и собственное исключение разбора приехало бы в
 * `catch`, предназначенный для сетевого отказа, и было бы описано как обрыв.
 */
async function attemptPut(ticket: UploadTicket, file: File): Promise<Attempt> {
  let put: Response;
  try {
    put = await fetch(ticket.uploadUrl, {
      method: ticket.method,
      headers: ticket.headers,
      body: file,
      credentials: 'same-origin',
    });
  } catch (error) {
    // `TypeError` здесь — это и непройденный preflight, и обрыв соединения:
    // спецификация запрещает браузеру их различать. Повторяем оба — провал
    // preflight мгновенен, поэтому три попытки по нему ничего не стоят, а
    // обрыв — ровно тот случай, ради которого повтор и заведён.
    return {
      ok: false,
      failure: {
        retryable: error instanceof TypeError,
        message: describeUploadFailure(error),
        status: undefined,
        code: undefined,
        cause: error,
      },
    };
  }

  if (put.ok) return { ok: true };

  // Тело отказа читается, а не выбрасывается: в нём лежат `<Code>` и
  // `<RequestId>` — единственное, по чему временный отказ хранилища отличим от
  // испорченной подписи, и единственное, с чем идут в поддержку.
  const body = await put.text().catch(() => '');
  const rejection = describeStorageRejection(put.status, body);
  return {
    ok: false,
    failure: {
      retryable: isRetryableStatus(put.status),
      message: rejection.message,
      status: put.status,
      code: rejection.code ?? undefined,
      cause: undefined,
    },
  };
}

/** Ход повтора для экрана: он обязан объяснить, почему портал молчит. */
export type UploadRetryListener = (attempt: number, total: number, reason: string) => void;

/**
 * Заливка байтов по выданному талону. Общая часть приёма, замены и заведения
 * комплекта файлом.
 */
export async function uploadToTicket(
  ticket: UploadTicket,
  file: File,
  onRetry?: UploadRetryListener,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await attemptPut(ticket, file);
    if (result.ok) return;

    const { failure } = result;
    if (failure.retryable && attempt < MAX_ATTEMPTS) {
      onRetry?.(attempt + 1, MAX_ATTEMPTS, failure.message);
      await pause(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0);
      continue;
    }

    const error = new Error(failure.message, { cause: failure.cause });
    // Отчёт отправляется ЗДЕСЬ, а не в вызывающем: из трёх путей заливки два
    // идут мутациями react-query и попадают в журнал через `MutationCache`, а
    // вкладка «Файлы» ловит отказ обычным `try/catch` — и 26 августа 2026 года
    // из трёх отказов подряд в журнал портала приехал ровно один.
    const eventId = reportClientError(error, {
      kind: 'manual',
      ...(failure.status === undefined ? {} : { statusCode: failure.status }),
      ...(failure.code === undefined ? {} : { errorCode: failure.code }),
    });
    throw new Error(`${failure.message} (обращение ${eventId})`, { cause: failure.cause });
  }
}

/** Приём нового файла в ревизию. */
export async function uploadFile(
  folderId: string,
  file: File,
  onRetry?: UploadRetryListener,
): Promise<SourceFile> {
  const ticket = await files.initUpload(folderId, file.name, file.size);
  await uploadToTicket(ticket, file, onRetry);
  return files.completeUpload(folderId, ticket.uploadId);
}

/**
 * Замена файла: те же три шага, но своя пара маршрутов.
 *
 * Всё, что меняет базу, происходит на сервере одной транзакцией. Клиентская
 * последовательность «удалить → загрузить → переставить» непригодна: удаление
 * первым же шагом сносит файл вместе со всем производным, и любой отказ дальше
 * оставляет комплект без файла. Поменять шаги местами тоже нельзя — приём
 * файла отвергается, пока собран рабочий документ.
 */
export async function replaceFile(
  folderId: string,
  fileId: string,
  file: File,
  onRetry?: UploadRetryListener,
): Promise<SourceFile> {
  const ticket = await files.initReplacement(folderId, fileId, file.name, file.size);
  await uploadToTicket(ticket, file, onRetry);
  return files.completeReplacement(folderId, fileId, ticket.uploadId);
}
