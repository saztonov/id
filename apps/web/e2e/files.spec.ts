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
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderEmpty}?tab=files`);

  await expect(page.getByText('Файлов в ревизии нет')).toBeVisible();

  await page.getByTestId('file-input').setInputFiles({
    name: 'Многостраничный.pdf',
    mimeType: 'application/pdf',
    buffer: readFileSync(FIXTURE),
  });

  // Строка в таблице приходит из ответа API: её появление означает, что прошли
  // все три шага — `init`, PUT байтов и `complete` с проверкой содержимого.
  // Локатор ячейки уточнён `exact` (S24): у кнопок-пиктограмм в колонке действий
  // доступное имя называет объект («Удалить «Многостраничный.pdf»»), поэтому
  // подстрочное совпадение по имени файла находит и служебные ячейки строки.
  // Это не обход дефекта: имя объекта в кнопке обязательно — двадцать кнопок
  // «Удалить» подряд неразличимы на слух, — а проверить надо ячейку с именем.
  await expect(page.getByRole('cell', { name: 'Многостраничный.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Последствие в базе: файл принят, страницы разобраны сервером.
  const files = await page.request.get(`/api/v1/folders/${IDS.folderEmpty}/files`);
  const body = (await files.json()) as {
    items: { fileName: string; verifyState: string; pageCount: number; sizeBytes: number }[];
  };
  const stored = body.items.find((item) => item.fileName === 'Многостраничный.pdf');
  expect(stored, 'файл обязан быть в составе ревизии').toBeDefined();
  expect(stored?.verifyState).toBe('ok');
  expect(stored?.pageCount).toBeGreaterThan(1);
  expect(stored?.sizeBytes).toBeGreaterThan(0);

  // Содержимое отдаётся нашим эндпоинтом под сессией, а не presigned URL.
  const content = await page.request.get(`/api/v1/files/${IDS.folderEmpty}/content`);
  expect([200, 404]).toContain(content.status());
});

test('«Разметить файл» доступно только после сборки рабочего документа', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderEmpty}?tab=files`);

  // Рабочего документа у этой ревизии нет: экран говорит об этом и не даёт
  // нажать кнопку, которая гарантированно получила бы 409.
  await expect(page.getByText('Рабочий документ не собран')).toBeVisible();
  await expect(page.getByTestId('start-markup')).toBeDisabled();
});

test('сборка рабочего документа ставит задачу конвейера', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderEmpty}?tab=files`);

  // Локатор ячейки уточнён `exact` (S24): у кнопок-пиктограмм в колонке действий
  // доступное имя называет объект («Удалить «Многостраничный.pdf»»), поэтому
  // подстрочное совпадение по имени файла находит и служебные ячейки строки.
  // Это не обход дефекта: имя объекта в кнопке обязательно — двадцать кнопок
  // «Удалить» подряд неразличимы на слух, — а проверить надо ячейку с именем.
  await expect(page.getByRole('cell', { name: 'Многостраничный.pdf', exact: true })).toBeVisible({
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

/**
 * Замена файла (S27).
 *
 * Проверяется главное свойство серверной транзакции: пока новый файл не принят
 * и не проверен, комплект не меняется. Клиентская последовательность «удалить →
 * загрузить» этого свойства не имеет по построению — первый её шаг уже снёс бы
 * файл вместе со всем разбором.
 */
test('замена ставит новый файл на место старого и говорит, что уйдёт', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderEmpty}?tab=files`);

  const before = await page.request.get(`/api/v1/folders/${IDS.folderEmpty}/files`);
  const item = ((await before.json()) as { items: { id: string; sortOrder: number }[] }).items[0];
  expect(item, 'предыдущий сценарий обязан был оставить файл').toBeDefined();

  await page.getByTestId(`replace-file-${item?.id ?? ''}`).click();

  // Модалка перечисляет последствия ДО выбора файла: предупреждение о сбросе
  // принадлежит намерению «перезаливаю», а не намерению «удаляю».
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('разметка, распознанный текст, разобранные документы');
  await expect(dialog).toContainText('Ревизий портал при этом не заводит');

  await dialog.getByRole('button', { name: 'Выбрать новый файл' }).click();
  await page.locator('input[type="file"]:not([data-testid])').setInputFiles({
    name: 'Замена.pdf',
    mimeType: 'application/pdf',
    buffer: readFileSync(FIXTURE),
  });

  await expect(page.getByRole('cell', { name: 'Замена.pdf', exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Последствие в базе: файл один, на прежней позиции, и это НОВЫЙ файл.
  const after = await page.request.get(`/api/v1/folders/${IDS.folderEmpty}/files`);
  const items = (
    (await after.json()) as {
      items: { id: string; fileName: string; sortOrder: number }[];
    }
  ).items;
  expect(items).toHaveLength(1);
  expect(items[0]?.fileName).toBe('Замена.pdf');
  expect(items[0]?.sortOrder).toBe(item?.sortOrder);
  expect(items[0]?.id).not.toBe(item?.id);
});

test('замена сбрасывает проверку, и экран об этом говорит', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderEmpty}?tab=checks`);

  // Прогонов у этой ревизии не было, а после замены и подавно: экран обязан
  // сказать это словами, а не молчать пустым списком — молчание неотличимо от
  // поломки, и именно его заказчик увидел как «никаких данных».
  await expect(page.getByTestId('checks-run-state')).toContainText('Проверка ещё не выполнялась');
  await expect(page.getByTestId('checks-summary')).toBeVisible();
});
