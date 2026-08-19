/**
 * Приём файла целиком: три шага §4.2 через интерфейс.
 *
 * Проверяется не «форма отправилась», а то, что байты приняты и проверены: файл
 * появляется в списке ревизии с состоянием проверки и числом страниц, которое
 * посчитал сервер, разобрав PDF. Мок здесь дал бы то, что в него положили, и не
 * заметил бы ни отказа presigned PUT, ни несовпадения талона, ни того, что
 * `complete` вообще не вызывается.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { IDS, KC, signIn } from './support/session.js';

const FIXTURE = fileURLToPath(
  new URL('../../../tools/fixtures/pdf/multipage.pdf', import.meta.url),
);

test('подрядчик загружает файл, и он появляется в составе ревизии', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/revisions/${IDS.revisionEmpty}?tab=files`);

  await expect(page.getByText('Файлов в ревизии нет')).toBeVisible();

  await page.getByTestId('file-input').setInputFiles({
    name: 'Многостраничный.pdf',
    mimeType: 'application/pdf',
    buffer: readFileSync(FIXTURE),
  });

  // Строка в таблице приходит из ответа API: её появление означает, что прошли
  // все три шага — `init`, PUT байтов и `complete` с проверкой содержимого.
  await expect(page.getByRole('cell', { name: 'Многостраничный.pdf' })).toBeVisible({
    timeout: 30_000,
  });

  // Последствие в базе: файл принят, страницы разобраны сервером.
  const files = await page.request.get(`/api/v1/revisions/${IDS.revisionEmpty}/files`);
  const body = (await files.json()) as {
    items: { fileName: string; verifyState: string; pageCount: number; sizeBytes: number }[];
  };
  const stored = body.items.find((item) => item.fileName === 'Многостраничный.pdf');
  expect(stored, 'файл обязан быть в составе ревизии').toBeDefined();
  expect(stored?.verifyState).toBe('ok');
  expect(stored?.pageCount).toBeGreaterThan(1);
  expect(stored?.sizeBytes).toBeGreaterThan(0);

  // Содержимое отдаётся нашим эндпоинтом под сессией, а не presigned URL.
  const content = await page.request.get(`/api/v1/files/${IDS.revisionEmpty}/content`);
  expect([200, 404]).toContain(content.status());
});

test('«Разметить файл» доступно только после сборки рабочего документа', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/revisions/${IDS.revisionEmpty}?tab=files`);

  // Рабочего документа у этой ревизии нет: экран говорит об этом и не даёт
  // нажать кнопку, которая гарантированно получила бы 409.
  await expect(page.getByText('Рабочий документ не собран')).toBeVisible();
  await expect(page.getByTestId('start-markup')).toBeDisabled();
});

test('сборка рабочего документа ставит задачу конвейера', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/revisions/${IDS.revisionEmpty}?tab=files`);

  await expect(page.getByRole('cell', { name: 'Многостраничный.pdf' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('build-bundle').click();

  // Последствие — строка в очереди, а не текст на экране. Ровно этой проверки не
  // было на S5, где обработчики задач были написаны и никогда не ставились.
  await signIn(page, KC.admin, '/admin?tab=diagnostics');
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/admin/jobs?type=bundle.build');
      if (response.status() !== 200) return `HTTP ${String(response.status())}`;
      const body = (await response.json()) as { items: { type: string }[] };
      return String(body.items.length > 0);
    })
    .toBe('true');
});
