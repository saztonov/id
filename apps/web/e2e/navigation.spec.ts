/**
 * Навигация «объект → том → поставка → ревизия» через интерфейс (§3, §14).
 *
 * ## Зачем этот файл
 *
 * Экраны навигации писались раньше маршрутов и обращались к УГАДАННЫМ путям
 * (`/objects/{id}/volumes`, `/volumes/{id}/submissions`). Фактические маршруты
 * оказались другой формы — плоские коллекции с фильтром в строке запроса, — и
 * ни один существующий тест этого не ловил: экран на 404 показывал состояние
 * «раздел недоступен», то есть выглядел объяснимо. Поэтому здесь проверяется не
 * только то, что данные видны, но и то, ЧЕМ они получены: адрес фактического
 * запроса снимается с сети.
 *
 * ## Что доказывается
 *
 * 1. Дерево навигации проходится целиком настоящими маршрутами.
 * 2. Создание поставки заводит и её первую ревизию — одной операцией.
 * 3. Два ограничения модели объяснены в интерфейсе ДО нажатия и подтверждены
 *    сервером после: подрядчик не заводит первую поставку на объекте, а
 *    пользователь с ролями подрядчика и инженера получает отказ, потому что
 *    организация берётся из области видимости.
 * 4. Недоступное отличимо от пустого: несуществующий том даёт отказ на экране,
 *    а не пустую таблицу, и неотличим от чужого (§1.6).
 *
 * Порядок последовательный: сценарии меняют состояние тома (появляется новая
 * поставка), и параллельный прогон делил бы одну базу.
 */
import { expect, test, type Page } from '@playwright/test';
import { IDS, KC, apiPost, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

/** Адреса запросов к API, снятые с сети: контракт проверяется по факту. */
function recordApiCalls(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/v1/')) seen.push(`${url.pathname}${url.search}`);
  });
  return seen;
}

test('дерево навигации проходится настоящими маршрутами', async ({ page }) => {
  const calls = recordApiCalls(page);
  await signIn(page, KC.engineer, `/ids/objects/${IDS.object}`);

  // Тома объекта видны, и это не пустая таблица-заглушка.
  await expect(page.getByRole('cell', { name: 'V-1' })).toBeVisible();
  await expect(page.getByText('Тома объекта: раздел недоступен')).toHaveCount(0);

  // Фильтр объекта ушёл в строку запроса плоской коллекции, а не во вложенный
  // путь: ровно то расхождение, из-за которого экран показывал «недоступно».
  expect(calls.some((call) => call.startsWith(`/api/v1/volumes?`))).toBe(true);
  expect(calls.some((call) => call.includes(`objectId=${IDS.object}`))).toBe(true);
  expect(calls.some((call) => call.includes(`/objects/${IDS.object}/volumes`))).toBe(false);

  await page.getByRole('link', { name: 'V-1' }).click();

  // Поставки тома: три из фикстуры, и все три подрядчика видны инженеру,
  // потому что объект ему назначен.
  await expect(page.getByRole('cell', { name: 'Поставка без файлов' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Поставка с разметкой' })).toBeVisible();
  expect(calls.some((call) => call.includes(`/api/v1/submissions?`))).toBe(true);
  expect(calls.some((call) => call.includes(`volumeId=${IDS.volume}`))).toBe(true);

  // Ревизии поставки — вложенная коллекция, и она тоже настоящая.
  await expect(page.getByText('Ревизии: Поставка без файлов')).toBeVisible();
  await expect
    .poll(() => calls.some((call) => /\/api\/v1\/submissions\/[0-9a-f-]+\/revisions/u.test(call)))
    .toBe(true);

  // Из ревизии открывается рабочее место — конец пути.
  await page.getByRole('link', { name: '1', exact: true }).first().click();
  await expect(page).toHaveURL(/\/ids\/revisions\//u);
});

test('подрядчик создаёт поставку, и вместе с ней открывается первая ревизия', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/volumes/${IDS.volume}`);

  await page.getByTestId('new-submission-title').fill('Поставка из интерфейса');
  await page.getByTestId('new-submission-number').fill('7');
  await page.getByTestId('create-submission').click();

  // Экран уходит на рабочее место новой ревизии: поставка без ревизии — это
  // карточка, в которую некуда загружать файлы.
  await expect(page).toHaveURL(/\/ids\/revisions\/[0-9a-f-]{36}/u);

  // Последствие в базе, а не надпись: поставка в списке тома и ровно одна
  // ревизия — первая, черновик, без родителя.
  const list = await page.request.get(`/api/v1/submissions?volumeId=${IDS.volume}&limit=50`);
  expect(list.status()).toBe(200);
  const submissions = (await list.json()) as {
    items: { id: string; title: string; number: string | null; currentRevisionId: string | null }[];
  };
  const created = submissions.items.find((item) => item.title === 'Поставка из интерфейса');
  expect(created, 'созданная поставка обязана быть в списке тома').toBeDefined();
  expect(created?.number).toBe('7');
  expect(created?.currentRevisionId).not.toBeNull();

  const revisions = await page.request.get(`/api/v1/submissions/${created?.id ?? ''}/revisions`);
  const body = (await revisions.json()) as {
    items: { revisionNo: number; status: string; parentRevisionId: string | null }[];
  };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.revisionNo).toBe(1);
  expect(body.items[0]?.status).toBe('draft');
  expect(body.items[0]?.parentRevisionId).toBeNull();
});

test('подрядчику названо ограничение: первую поставку на объекте он не заводит', async ({
  page,
}) => {
  await signIn(page, KC.contractor, `/ids/volumes/${IDS.volume}`);

  const limitation = page.getByTestId('first-submission-limit');
  await expect(limitation).toBeVisible();
  await expect(limitation).toContainText('связи «подрядчик закреплён за томом»');

  // Ограничение — свойство модели, а не поломка: том, который виден, работает.
  await expect(page.getByTestId('create-submission')).toBeEnabled();
});

test('роли подрядчика и инженера вместе: отказ объяснён до нажатия и подтверждён сервером', async ({
  page,
}) => {
  await signIn(page, KC.mixed, `/ids/volumes/${IDS.volume}`);

  // Право есть — карточка создания показана, — но область видимости построена
  // по старшей роли, и это сказано прямо.
  const explained = page.getByTestId('create-blocked-scope');
  await expect(explained).toBeVisible();
  await expect(explained).toContainText('организация');
  await expect(explained).toContainText('engineer');

  // И это не догадка интерфейса: сервер отвечает 403 на прямой запрос.
  const refused = await apiPost(page, '/api/v1/submissions', {
    data: { volumeId: IDS.volume, title: 'Поставка от совмещающего роли' },
  });
  expect(refused.status).toBe(403);
  const problem = refused.body as { type?: string; detail?: string };
  expect(problem.type).toBe('urn:id-portal:problem:forbidden');
  expect(problem.detail).toContain('организации');
});

test('закрытый том: создание выключено и причина названа', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/volumes/${IDS.volumeClosed}`);

  await expect(page.getByTestId('volume-state')).toHaveText('Закрыт');
  await expect(page.getByTestId('volume-closed')).toBeVisible();
  await expect(page.getByTestId('create-submission')).toBeDisabled();
});

test('ручное открытие ревизии при живом черновике отклоняется с объяснением', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/volumes/${IDS.volume}`);

  await page.getByTestId(`open-revision-${IDS.submissionEmpty}`).click();

  // 409 сервера показывается дословно, а не прячется: следующая ревизия не
  // открывается, пока у поставки есть незакрытая.
  await expect(page.getByTestId(`revision-conflict-${IDS.submissionEmpty}`)).toBeVisible();
  await expect(page.getByTestId(`revision-conflict-${IDS.submissionEmpty}`)).toContainText(
    'У поставки уже открыта черновая ревизия',
  );
});

test('несуществующий том неотличим от чужого и не выглядит пустой таблицей', async ({ page }) => {
  const absent = '00000000-0000-4000-8000-0000000009ff';
  await signIn(page, KC.contractor, `/ids/volumes/${absent}`);

  // Экран говорит об отказе. Пустая таблица поставок здесь была бы худшим из
  // возможных ответов: она выглядит рабочей.
  await expect(page.getByText('Том недоступен')).toBeVisible();

  const direct = await page.request.get(`/api/v1/volumes/${absent}`);
  expect(direct.status()).toBe(404);
  expect(direct.headers()['content-type']).toContain('application/problem+json');
});
