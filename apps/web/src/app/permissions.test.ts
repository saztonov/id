/**
 * Копия матрицы прав на клиенте совпадает с матрицей сервера.
 *
 * ## Зачем эта сверка появилась (S52)
 *
 * `session.tsx` держит копию `PERMISSIONS` из
 * `apps/api/src/middleware/require-permission.ts` и в комментарии обещает, что
 * копия дословная. Копия неизбежна — сервер матрицу наружу не отдаёт, — но
 * обещание дословности до сих пор ничем не держалось, и к моменту написания
 * этого теста копия уже разошлась: в ней не было `submission.delete`, которое
 * сервер имеет с S37.
 *
 * Тот случай был безобиден: право выдано всем пяти ролям, и клиент кнопку не
 * гасил. Безобидность и есть причина, по которой расхождение прожило этап
 * незамеченным, — а следующее может оказаться другим.
 *
 * ## Чем это НЕ является
 *
 * Это не защита доступа. Права на клиенте — вопрос того, что показывать;
 * решение принимает сервер, и спрятанная кнопка не защищает ничего. Расхождение
 * ломает не безопасность, а объяснимость портала: роль видит действие, которого
 * ей не дадут, либо не видит того, на которое имеет право, и понять, почему,
 * из интерфейса нельзя.
 *
 * ## Почему сервер читается текстом
 *
 * `@id/api` не является зависимостью `@id/web` и не должен ею стать: клиенту
 * незачем тянуть Fastify ради одной таблицы. Читается исходник — тем же
 * приёмом, каким `modules/navigation/client-routes.test.ts` читает исходники
 * клиента со стороны сервера.
 *
 * Риск разборщика, который найдёт ноль строк и промолчит, закрыт
 * положительными контролями: он обязан найти не меньше двадцати прав и
 * конкретные известные.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from './session.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SERVER_SOURCE = join(ROOT, 'apps', 'api', 'src', 'middleware', 'require-permission.ts');

/**
 * Матрица сервера из его исходника.
 *
 * Разбирается только тело `PERMISSIONS`: за его границей в том же файле лежат
 * и другие таблицы, и docstring'и с примерами ролей в кавычках.
 */
function serverPermissions(): Readonly<Record<string, readonly string[]>> {
  const source = readFileSync(SERVER_SOURCE, 'utf8');
  const start = source.indexOf('export const PERMISSIONS = {');
  expect(start, 'таблица прав сервера не найдена — разборщик устарел').toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf('\n} as const satisfies');
  expect(end, 'не найден конец таблицы прав сервера').toBeGreaterThan(-1);
  const body = rest.slice(0, end);

  const parsed: Record<string, readonly string[]> = {};
  for (const match of body.matchAll(/^ {2}'([a-z_]+\.[a-z_]+)':\s*\[([^\]]*)\],/gmu)) {
    const permission = match[1] ?? '';
    const roles = (match[2] ?? '')
      .split(',')
      .map((role) => role.trim().replace(/^'|'$/gu, ''))
      .filter((role) => role !== '');
    parsed[permission] = roles;
  }
  return parsed;
}

describe('матрица прав клиента и сервера', () => {
  const server = serverPermissions();

  it('разборщик исходника сервера не сломан', () => {
    // Без этого контроля сверка ниже прошла бы молча на пустой таблице.
    expect(Object.keys(server).length).toBeGreaterThan(20);
    expect(server['users.manage']).toEqual(['admin']);
    expect(server['folder.override']).toEqual(['manager']);
    expect(server['markup.edit']).toEqual([
      'contractor',
      'general_contractor',
      'engineer',
      'admin',
    ]);
  });

  it('перечень прав совпадает', () => {
    // Право, которого нет у клиента, — это действие, которого роль не увидит,
    // имея на него право. Право, которого нет у сервера, — кнопка, ведущая в 403.
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(server).sort());
  });

  it('роли у каждого права совпадают', () => {
    const client = PERMISSIONS as Readonly<Record<string, readonly string[]>>;
    const different = Object.keys(server)
      .filter((permission) => client[permission] !== undefined)
      .map((permission) => ({
        permission,
        server: [...(server[permission] ?? [])].sort(),
        client: [...(client[permission] ?? [])].sort(),
      }))
      .filter((row) => JSON.stringify(row.server) !== JSON.stringify(row.client));

    expect(different).toEqual([]);
  });
});
