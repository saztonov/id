/**
 * Разбор отказа хранилища на заливке байтов.
 *
 * Проверяется не форматирование, а то, ради чего разбор написан: код отказа
 * `<Code>` доезжает отдельным полем (он становится осью журнала), номер запроса
 * попадает в текст пользователю (с ним идут в поддержку хранилища), а совет
 * различает временный отказ и просроченную ссылку — это разные действия.
 *
 * Тела здесь настоящие: так S3 отвечает на PUT.
 */
import { describe, expect, it } from 'vitest';
import { describeStorageRejection } from './problem.js';

const INTERNAL_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message><RequestId>TX00000abcdef</RequestId><HostId>hostid</HostId></Error>`;

const FORBIDDEN = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match.</Message><RequestId>TX0000fedcba</RequestId></Error>`;

describe('describeStorageRejection', () => {
  it('достаёт код и номер запроса и советует повторить', () => {
    const rejection = describeStorageRejection(500, INTERNAL_ERROR);

    expect(rejection.code).toBe('InternalError');
    expect(rejection.requestId).toBe('TX00000abcdef');
    expect(rejection.message).toContain('HTTP 500');
    expect(rejection.message).toContain('InternalError');
    expect(rejection.message).toContain('TX00000abcdef');
    expect(rejection.message).toContain('временный отказ');
  });

  it('у просроченной подписи советует начать загрузку заново, а не ждать', () => {
    const rejection = describeStorageRejection(403, FORBIDDEN);

    expect(rejection.code).toBe('SignatureDoesNotMatch');
    expect(rejection.message).toContain('начните загрузку заново');
    // Совет «подождите минуту» здесь был бы вредным: ссылка не оживёт.
    expect(rejection.message).not.toContain('временный отказ');
  });

  it('обрыв тела назван обрывом, а не поломкой хранилища', () => {
    const rejection = describeStorageRejection(
      400,
      '<Error><Code>IncompleteBody</Code><Message>x</Message></Error>',
    );

    expect(rejection.code).toBe('IncompleteBody');
    expect(rejection.requestId).toBeNull();
    expect(rejection.message).toContain('дошёл не целиком');
  });

  it('пустое тело оставляет один статус, а не выдумывает код', () => {
    const rejection = describeStorageRejection(503, '');

    expect(rejection.code).toBeNull();
    expect(rejection.requestId).toBeNull();
    expect(rejection.message).toContain('HTTP 503');
    // Скобок с подробностями быть не должно: подробностей нет.
    expect(rejection.message).not.toContain('(');
    expect(rejection.message).toContain('временный отказ');
  });

  it('не-XML тело от прокси не ломает разбор', () => {
    const rejection = describeStorageRejection(502, '<html><body>502 Bad Gateway</body></html>');

    expect(rejection.code).toBeNull();
    expect(rejection.message).toContain('HTTP 502');
  });
});
