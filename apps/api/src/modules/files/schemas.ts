/**
 * Схемы запросов и ответов приёма файлов (§4.2, §14).
 *
 * Две вещи здесь сделаны намеренно и легко «исправить» неверно.
 *
 * **1. Имя файла нормализуется на входе, а не при выдаче.** Пользователь
 * присылает имя из своей файловой системы: с путём, управляющими символами,
 * переводами строк. Оно попадает в `Content-Disposition` при скачивании и в
 * журнал, поэтому нормализуется один раз здесь. В ключ объекта имя не попадает
 * вовсе (§13), так что это вопрос корректности заголовка и журнала, а не
 * безопасности хранилища.
 *
 * **2. Поле с адресом загрузки называется `uploadUrl`.** Имя не косметическое:
 * `uploadUrl` входит в список полей-адресов слоя журналирования (§11), у
 * которых вычёркивается строка запроса, — а именно в ней едет подпись presigned
 * PUT. Переименование поля молча снимет эту защиту.
 */
import { z } from 'zod';
import {
  isoDateTimeSchema,
  signatureProbeSchema,
  sourceFileSchema,
  uuidSchema,
} from '@id/contracts';

/** Длина колонки `source_files.file_name` в контрактах — 500. */
const MAX_FILE_NAME = 255;

/**
 * Имя файла: без путей и управляющих символов.
 *
 * Путь отрезается, а не отвергается: браузеры некоторых версий присылают
 * `C:\fakepath\скан.pdf`, и отказ на этом был бы отказом по причине, которую
 * пользователь не может ни увидеть, ни исправить.
 */
export const fileNameSchema = z
  .string()
  .min(1)
  .max(500)
  .transform((value) => {
    const withoutPath = value.split(/[\\/]/).at(-1) ?? value;
    // Управляющие символы уходят: перевод строки в имени — это инъекция в
    // заголовок ответа и разрыв строки в журнале.
    return withoutPath
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .trim()
      .slice(0, MAX_FILE_NAME);
  })
  .refine((value) => value.length > 0, 'Имя файла не может быть пустым');

export const revisionIdParamSchema = z.object({ revisionId: uuidSchema });
export const fileIdParamSchema = z.object({ fileId: uuidSchema });
export const revisionFileParamSchema = z.object({
  revisionId: uuidSchema,
  fileId: uuidSchema,
});

/** Токен «презигнутого» PUT драйвера `local`: тело.подпись в base64url. */
/**
 * Токен приёма едет в query, а не в сегменте пути: длина сегмента ограничена
 * maxParamLength Fastify, и подписанный токен упирался в неё, давая 414.
 */
export const localUploadQuerySchema = z.object({
  token: z.string().min(16).max(4096),
});

export const uploadInitBodySchema = z.object({
  fileName: fileNameSchema,
  /** Заявленный размер: нужен для отказа ДО загрузки 200 МБ, а не после. */
  sizeBytes: z.int().positive(),
});

export const uploadInitResponseSchema = z.object({
  /** Подписанный талон: предъявляется на `complete`, см. `upload-token.ts`. */
  uploadId: z.string().min(1),
  uploadUrl: z.string().min(1),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: isoDateTimeSchema,
  maxBytes: z.int().positive(),
});

export const uploadCompleteBodySchema = z.object({
  uploadId: z.string().min(1).max(4096),
});

/**
 * Файл ревизии в ответе.
 *
 * Форма расширяет контракт §3.3 тем, что лежит в `stored_blobs` и в
 * `source_pages`: размер, тип и число страниц — это первое, что спрашивает
 * экран «Файлы», и второй запрос за ними был бы запросом на каждую строку.
 * Ключ хранилища в ответ НЕ входит ни в каком виде.
 */
export const sourceFileViewSchema = sourceFileSchema.extend({
  sizeBytes: z.int().nonnegative(),
  mime: z.string().min(1).max(255),
  pageCount: z.int().nonnegative(),
  createdAt: isoDateTimeSchema,
  // Зонд подписи пишет портал, но схема ответа не должна ронять выдачу списка
  // из-за строки, сохранённой прежней версией: расхождение даёт null, а не 500.
  signatureProbe: signatureProbeSchema.nullable().catch(null),
});

export const sourceFileListSchema = z.object({
  items: z.array(sourceFileViewSchema),
});

/**
 * Порядок файлов ревизии.
 *
 * Полный список, а не «переместить файл X на позицию N»: порядок задаёт
 * пользователь целиком и до начала разметки (§3.3), а частичная операция
 * оставляла бы результат зависимым от того, что уже лежало в базе.
 */
export const fileOrderBodySchema = z.object({
  fileIds: z.array(uuidSchema).min(1).max(500),
});
