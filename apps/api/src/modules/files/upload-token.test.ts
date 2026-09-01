/**
 * Талон загрузки: что он обязан нести и чего не должен позволять.
 *
 * Проверяется признак автозапуска разметки (S36) — единственное поле талона, у
 * которого есть последствия за пределами приёма файла: по нему `complete`
 * ставит сборку рабочего документа с продолжением разметкой. Поэтому важны обе
 * стороны — что признак переживает подпись и что его нельзя дописать снаружи.
 */
import { describe, expect, it } from 'vitest';

import { deriveTicketKey, signUploadTicket, verifyUploadTicket } from './upload-token.js';

const KEY = deriveTicketKey('secret-for-tests', 'folder-file');

function ticket(startMarkup?: boolean): Parameters<typeof signUploadTicket>[1] {
  return {
    uploadId: 'upload-1',
    targetId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    fileName: 'комплект.pdf',
    key: 'uploads/upload-1',
    expiresAt: Date.now() + 60_000,
    ...(startMarkup === undefined ? {} : { startMarkup }),
  };
}

describe('талон загрузки: признак автозапуска разметки', () => {
  it('переживает подпись и читается обратно', () => {
    const parsed = verifyUploadTicket(KEY, signUploadTicket(KEY, ticket(true)));
    expect(parsed?.startMarkup).toBe(true);
  });

  it('талон без признака читается как «не запускать», а не отвергается', () => {
    // Признак появился позже формата, и талоны, выданные до выката, обязаны
    // дожить свой срок годными.
    const parsed = verifyUploadTicket(KEY, signUploadTicket(KEY, ticket()));
    expect(parsed).not.toBeNull();
    expect(parsed?.startMarkup).toBe(false);
  });

  it('дописать признак к чужому талону нельзя: подпись не сходится', () => {
    const token = signUploadTicket(KEY, ticket());
    const [body = '', signature = ''] = token.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    forged['m'] = true;

    const tampered = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${signature}`;
    expect(verifyUploadTicket(KEY, tampered)).toBeNull();
  });
});
