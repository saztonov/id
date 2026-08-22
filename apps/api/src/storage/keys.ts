/**
 * Ключи объектов в хранилище (§13, §4.2).
 *
 * Правило одно и оно жёсткое: **ключ строится только из uuid и sha256**. Ни имя
 * файла, ни код объекта строительства, ни название подрядчика в путь не
 * попадают. Имя приходит от пользователя, то есть это и произвольный Unicode
 * (кодировка ключа), и путь обхода (`../`), и утечка смысла тому, кто увидит
 * список ключей: «Кровля_корпус3_АОСР_336.pdf» рассказывает о стройке больше,
 * чем строка журнала. Человекочитаемое имя живёт в `source_files.file_name` и
 * подставляется в `Content-Disposition` при скачивании.
 *
 * ## Почему blob'ы адресуются содержимым, а не деревом ревизии
 *
 * §13 рисует дерево `objects/{objectId}/works/{workId}/rev{N}/…`, и для
 * производных артефактов (превью, экспорт, архив) оно верное. Но для
 * ОРИГИНАЛОВ такое дерево несовместимо со схемой БД: у `stored_blobs` первичный
 * ключ — `sha256`, а `s3_key` объявлен UNIQUE. То есть на одно содержимое
 * приходится ровно один объект в хранилище, глобально, и любой префикс с
 * идентификатором ревизии стал бы ложью для второй ревизии, которая тот же файл
 * переиспользует. А переиспользование — не редкость, а штатный сценарий §3.3:
 * возврат комплекта и повторная подача тех же файлов.
 *
 * Отсюда `blobs/{aa}/{bb}/{sha256}`. Побочные следствия, которые нужно знать:
 *
 * - удаление ревизии по retention НЕ может удалять её объекты по префиксу —
 *   объект может быть нужен другой ревизии. Сборка мусора обязана считать
 *   ссылки по БД, и ровно для этого в §12 заведена отдельная задача
 *   `storage.gc` с ограниченной ролью;
 * - дедупликация глобальна, то есть одни и те же байты, поданные двумя
 *   подрядчиками, лежат одним объектом. Изоляция от этого не страдает: доступ
 *   даёт строка `source_files`, привязанная к ревизии и проверяемая областью
 *   видимости, а не знание ключа.
 *
 * Два уровня по два символа — ради драйвера `local`: каталог с сотней тысяч
 * файлов в одной директории на ext4 читается заметно медленнее. Для S3 это
 * безразлично.
 */

/** Ключ приёма: сюда клиент кладёт байты до проверки (§4.2, три шага). */
const UPLOAD_PREFIX = 'uploads';

/** Ключ проверенного содержимого. Адресуется sha256, а не ревизией. */
const BLOB_PREFIX = 'blobs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Допустимый ключ целиком.
 *
 * Проверяется не только при построении, но и на входе драйверов: `local`
 * превращает ключ в путь файловой системы, и `..` в ключе — это запись за
 * пределы `LOCAL_STORAGE_DIR`. Ключи строит только этот модуль, поэтому
 * проверка избыточна ровно до первого места, где кто-то соберёт ключ руками.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9/._-]{0,511}$/;

export class InvalidStorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStorageKeyError';
  }
}

export function isValidStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes('..') && !key.includes('//');
}

/** Бросает, если ключ непригоден. Драйверы вызывают её до любого ввода-вывода. */
export function assertStorageKey(key: string): void {
  if (!isValidStorageKey(key)) {
    // Значение ключа в сообщение не подставляется: сообщение уходит в журнал,
    // а непригодный ключ — это ровно то, что прислали снаружи.
    throw new InvalidStorageKeyError('Недопустимый ключ объекта в хранилище');
  }
}

/**
 * Ключ проверенного содержимого.
 *
 * Ключ детерминирован: повторная подача того же файла даёт тот же ключ, поэтому
 * второй объект в хранилище не появляется, а перезапись — это запись тех же
 * байт по тому же адресу.
 */
export function blobKey(sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new InvalidStorageKeyError(
      'sha256 обязан быть 64 шестнадцатеричными цифрами в нижнем регистре',
    );
  }
  return `${BLOB_PREFIX}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/**
 * Ключ незавершённой загрузки.
 *
 * Отдельный префикс, а не сразу `blobs/`, по двум причинам. Во-первых, до
 * проверки sha256 неизвестен — его считает сервер по фактическим байтам, а не
 * клиент по своим словам. Во-вторых, presigned PUT прямо в `blobs/{sha256}`
 * позволил бы затереть ЧУЖОЙ проверенный объект: достаточно назвать чужой
 * хэш. Стейджинг делает такую перезапись невозможной — клиент пишет только по
 * адресу, выданному ему на один раз.
 */
export function uploadKey(uploadId: string): string {
  if (!UUID_PATTERN.test(uploadId)) {
    throw new InvalidStorageKeyError('Идентификатор загрузки обязан быть uuid');
  }
  return `${UPLOAD_PREFIX}/${uploadId}`;
}

/** Незавершённая загрузка: по этому признаку `storage.gc` (§12) чистит брошенное. */
export function isUploadKey(key: string): boolean {
  return key.startsWith(`${UPLOAD_PREFIX}/`);
}

/** Неизменяемые артефакты прогона распознавания (§13). */
const ARTIFACT_PREFIX = 'artifacts';

export type ArtifactKind = 'zip' | 'md' | 'html' | 'blocks_json' | 'qa' | 'canonical';

const ARTIFACT_EXTENSIONS: Readonly<Record<ArtifactKind, string>> = {
  zip: 'zip',
  md: 'md',
  html: 'html',
  blocks_json: 'json',
  qa: 'json',
  // Сериализованный RecognitionResult v2 (ADR-0006/0007) — производит VLM-путь.
  canonical: 'json',
};

/**
 * Ключ артефакта прогона: `artifacts/{runId}/{kind}.{ext}` (§13).
 *
 * Адресуется ПРОГОНОМ, а не содержимым: в отличие от оригиналов, артефакт —
 * доказательство «что именно вернул RD WEB по этому прогону», и дедупликация
 * двух прогонов с побайтово совпавшим экспортом свела бы два разных факта к
 * одному объекту. Один вид на прогон — это же ограничение держит
 * `artifact_versions_run_kind_uq`, и второй артефакт того же вида означает не
 * новую версию, а повторный забор экспорта, запрещённый §5.2.
 */
export function artifactKey(recognitionRunId: string, kind: ArtifactKind): string {
  if (!UUID_PATTERN.test(recognitionRunId)) {
    throw new InvalidStorageKeyError('Идентификатор прогона распознавания обязан быть uuid');
  }
  return `${ARTIFACT_PREFIX}/${recognitionRunId}/${kind}.${ARTIFACT_EXTENSIONS[kind]}`;
}

/** Производная нарезка логического документа (§13, задача 22). */
const DOCUMENT_PREFIX = 'documents';

/**
 * Ключ производного PDF логического документа: `documents/{documentId}.pdf`.
 *
 * Адресуется ДОКУМЕНТОМ, а не содержимым, в отличие от оригиналов. Причин две.
 *
 * Во-первых, нарезка принадлежит ровно одному документу. Content-addressing
 * склеил бы две побайтово одинаковых нарезки разных документов (а такое бывает:
 * один и тот же сертификат, приложенный к двум актам, даёт одинаковые байты) в
 * один объект, и удаление по retention одной ревизии унесло бы файл другой.
 * `storage.gc` пришлось бы считать ссылки на объект, которых в схеме нет:
 * `logical_documents.derived_pdf_blob_sha256` — это хэш ЦЕЛОСТНОСТИ, а не
 * внешний ключ на `stored_blobs`, и заводить его таковым значило бы объявить
 * производную копию блобом наравне с оригиналом.
 *
 * Во-вторых, ключ детерминирован, поэтому повторная нарезка того же документа
 * перезаписывает свой файл, а не плодит осиротевшие копии при каждом повторе
 * задачи. Именно этим порядком закрыт мусор от неудачной сборки bundle (S5).
 */
export function documentPdfKey(documentId: string): string {
  if (!UUID_PATTERN.test(documentId)) {
    throw new InvalidStorageKeyError('Идентификатор логического документа обязан быть uuid');
  }
  return `${DOCUMENT_PREFIX}/${documentId}.pdf`;
}

/** Архив согласованной ревизии (§13, задача 23). */
const ARCHIVE_PREFIX = 'archive';

/**
 * Ключ архива: `archive/{revisionId}/rev{N}-approved.zip` (§13).
 *
 * §13 рисует имя `rev{N}-approved.zip` внутри поддерева ревизии; поддерево у
 * нас выражено идентификатором ревизии, потому что код объекта и номер поставки
 * в ключ не попадают (см. заголовок файла). Номер ревизии в имени остаётся: он
 * не является сведением об участниках, зато делает выгруженный файл узнаваемым
 * без обращения к порталу — ровно то, ради чего §13 его и называет.
 */
export function archiveKey(revisionId: string, revisionNo: number): string {
  if (!UUID_PATTERN.test(revisionId)) {
    throw new InvalidStorageKeyError('Идентификатор ревизии поставки обязан быть uuid');
  }
  if (!Number.isInteger(revisionNo) || revisionNo <= 0) {
    throw new InvalidStorageKeyError('Номер ревизии обязан быть положительным целым');
  }
  return `${ARCHIVE_PREFIX}/${revisionId}/rev${revisionNo}-approved.zip`;
}

/** Модель локальной детекции RF-DETR (ADR-0008). */
const DETECTION_MODEL_PREFIX = 'models/detection';

/**
 * Версия модели детекции: слаг, задаваемый настройкой `detection.model_version`.
 *
 * Формат жёстче общего KEY_PATTERN намеренно: версия приходит из настройки
 * администратора, то есть снаружи, и становится сегментом пути.
 */
const DETECTION_MODEL_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function assertDetectionModelVersion(version: string): void {
  if (!DETECTION_MODEL_VERSION_PATTERN.test(version) || version.includes('..')) {
    throw new InvalidStorageKeyError(
      'Версия модели детекции — слаг из латиницы, цифр, точки, дефиса и подчёркивания',
    );
  }
}

/**
 * Ключ весов ONNX: `models/detection/{version}/model.onnx`.
 *
 * Адресуется версией, а не содержимым: пара «веса + манифест» обязана лежать
 * под одним префиксом, а целостность доказывает sha256 из манифеста при
 * загрузке в воркер, не адрес. Замена весов под той же версией запрещена
 * процедурой (новая модель — новая версия), а не хранилищем.
 */
export function detectionModelKey(version: string): string {
  assertDetectionModelVersion(version);
  return `${DETECTION_MODEL_PREFIX}/${version}/model.onnx`;
}

/** Ключ манифеста экспорта: `models/detection/{version}/manifest.json`. */
export function detectionManifestKey(version: string): string {
  assertDetectionModelVersion(version);
  return `${DETECTION_MODEL_PREFIX}/${version}/manifest.json`;
}

/** Кэш превью страниц (§13) — только при `PREVIEW_MODE=cached`. */
const PREVIEW_PREFIX = 'preview';

export type PreviewTier = 'thumb' | 'view';

/**
 * Ключ превью страницы рабочего документа.
 *
 * Адресуется рабочим документом, а не ревизией поставки: превью — это картинка
 * страницы КОНКРЕТНОЙ склейки, и при пересборке комплекта нумерация страниц
 * меняется. Ключ по ревизии пришлось бы инвалидировать вручную, а по bundle он
 * инвалидируется сам — новый bundle, новый префикс.
 *
 * Расширение `.png`: тиры webp появятся вместе с `sharp` (§7.1, фолбэк
 * `cached`), а до тех пор портал кладёт то, что отдал RD WEB, не выдавая
 * непережатый файл за пережатый.
 */
export function previewPageKey(
  bundleId: string,
  tier: PreviewTier,
  workingPageIndex: number,
): string {
  if (!UUID_PATTERN.test(bundleId)) {
    throw new InvalidStorageKeyError('Идентификатор рабочего документа обязан быть uuid');
  }
  if (!Number.isInteger(workingPageIndex) || workingPageIndex < 0) {
    throw new InvalidStorageKeyError('Индекс страницы обязан быть неотрицательным целым');
  }
  const page = String(workingPageIndex).padStart(4, '0');
  return `${PREVIEW_PREFIX}/${bundleId}/${tier}/p${page}.png`;
}
