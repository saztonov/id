/**
 * Навигация «объект → комплект → ревизия» и сборка реестра через интерфейс
 * (§3, §14).
 *
 * ## Зачем этот файл
 *
 * Экраны навигации писались раньше маршрутов и обращались к УГАДАННЫМ путям.
 * Фактические маршруты оказались другой формы — плоские коллекции с фильтром в
 * строке запроса, — и ни один существующий тест этого не ловил: экран на 404
 * показывал состояние «раздел недоступен», то есть выглядел объяснимо. Поэтому
 * здесь проверяется не только то, что данные видны, но и то, ЧЕМ они получены:
 * адрес фактического запроса снимается с сети.
 *
 * ## Что доказывается
 *
 * 1. Дерево навигации проходится целиком настоящими маршрутами (`/works`,
 *    `/registries`), а не вложенными путями, которых в API нет.
 * 2. Подрядчик заводит комплект сам: объект, раздел, месяц — и вместе с ним
 *    открывается первая ревизия.
 * 3. Генподрядчик собирает реестр из комплектов, заводит файл описи и передаёт
 *    папку; после передачи состав виден снимком и больше не правится.
 * 4. Отказы объяснены на экране: у пользователя с ролями подрядчика и инженера
 *    организация не берётся из тела запроса, а не существующий реестр даёт
 *    отказ, а не пустую таблицу.
 *
 * Порядок последовательный: сценарии меняют состояние объекта и реестра, и
 * параллельный прогон делил бы одну базу.
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

  // Комплекты объекта видны, и это не пустая таблица-заглушка.
  await expect(page.getByRole('link', { name: 'Комплект с разметкой' })).toBeVisible();
  await expect(page.getByText('Комплекты объекта: раздел недоступен')).toHaveCount(0);

  // Фильтр объекта ушёл в строку запроса плоской коллекции, а не во вложенный
  // путь: ровно то расхождение, из-за которого экран показывал «недоступно».
  expect(calls.some((call) => call.startsWith('/api/v1/works?'))).toBe(true);
  expect(calls.some((call) => call.includes(`objectId=${IDS.object}`))).toBe(true);
  expect(calls.some((call) => call.includes(`/objects/${IDS.object}/works`))).toBe(false);

  // Реестры объекта читаются той же плоской коллекцией.
  expect(calls.some((call) => call.startsWith('/api/v1/registries?'))).toBe(true);

  // Из комплекта открывается рабочее место ревизии — конец пути.
  await page.getByRole('link', { name: 'Комплект с разметкой' }).click();
  await expect(page).toHaveURL(/\/ids\/revisions\//u);
  await expect(page.getByText('Комплект работы: Комплект с разметкой')).toBeVisible();
});

test('подрядчик заводит комплект, и вместе с ним открывается первая ревизия', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/objects/${IDS.object}`);

  await page.getByTestId('work-section').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('Кровля').click();
  await page.getByTestId('work-period').fill(IDS.period);
  await page.getByTestId('work-title').fill('Комплект из интерфейса');
  await page.getByTestId('create-work').click();

  // Экран уходит на рабочее место новой ревизии: комплект без ревизии — это
  // карточка, в которую некуда загружать файлы.
  await expect(page).toHaveURL(/\/ids\/revisions\/[0-9a-f-]{36}/u);

  // Последствие в базе, а не надпись: комплект в списке объекта и ровно одна
  // ревизия — первая, черновик, без родителя.
  const list = await page.request.get(`/api/v1/works?objectId=${IDS.object}&limit=50`);
  expect(list.status()).toBe(200);
  const works = (await list.json()) as {
    items: {
      id: string;
      title: string;
      contractorId: string;
      managedByContractorId: string;
      currentRevisionId: string | null;
      registryId: string | null;
    }[];
  };
  const created = works.items.find((item) => item.title === 'Комплект из интерфейса');
  expect(created, 'заведённый комплект обязан быть в списке объекта').toBeDefined();
  // Организация взята из области видимости, а не из формы: поля исполнителя у
  // подрядчика нет вовсе.
  expect(created?.contractorId).toBe(IDS.orgContractor);
  expect(created?.managedByContractorId).toBe(IDS.orgContractor);
  expect(created?.registryId).toBeNull();
  expect(created?.currentRevisionId).not.toBeNull();

  const revisions = await page.request.get(`/api/v1/works/${created?.id ?? ''}/revisions`);
  const body = (await revisions.json()) as {
    items: { revisionNo: number; status: string; parentRevisionId: string | null }[];
  };
  expect(body.items).toHaveLength(1);
  expect(body.items[0]?.revisionNo).toBe(1);
  expect(body.items[0]?.status).toBe('draft');
  expect(body.items[0]?.parentRevisionId).toBeNull();
});

test('у подрядчика нет поля исполнителя, у генподрядчика — есть', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/objects/${IDS.object}`);
  await expect(page.getByTestId('work-title')).toBeVisible();
  await expect(page.getByTestId('work-contractor')).toHaveCount(0);

  await signIn(page, KC.general, `/ids/objects/${IDS.object}`);
  await expect(page.getByTestId('work-contractor')).toBeVisible();
});

test('генподрядчик собирает реестр: номер, состав, файл описи', async ({ page }) => {
  await signIn(page, KC.general, `/ids/registries/${IDS.registry}`);

  // Пока нет ни номера, ни состава, ни файла — препятствия названы списком, а
  // не по одному за попытку.
  const blockers = page.getByTestId('issue-blockers');
  await expect(blockers).toBeVisible();
  await expect(blockers).toContainText('Не присвоен номер реестра.');
  await expect(blockers).toContainText('В реестр не включён ни один комплект.');
  await expect(blockers).toContainText('Не загружен подписанный файл реестра.');
  await expect(page.getByTestId('issue-registry')).toBeDisabled();

  await page.getByTestId('header-number').fill('8');
  await page.getByTestId('save-header').click();
  await expect(page.getByText('Реквизиты сохранены')).toBeVisible();

  // Комплект на проверке подан — он и войдёт в опись.
  await page.getByTestId('add-work').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('Комплект на проверке').click();
  await page.getByRole('button', { name: 'Включить' }).click();
  await expect(page.getByRole('link', { name: 'Комплект на проверке' })).toBeVisible();

  // Файл описи — обычный комплект того же конвейера: заводится здесь, грузится
  // на своей ревизии.
  await page.getByTestId('attach-file').click();
  await expect(page.getByText('Открыть ревизию файла')).toBeVisible();

  // Препятствие сменилось, а не исчезло: файл заведён, но не подан. Разница
  // существенна — «нет файла» чинит ПТО, «файл не подан» чинит тот же ПТО, но
  // другим действием.
  await expect(blockers).not.toContainText('Не присвоен номер реестра.');
  await expect(blockers).toContainText('Файл реестра загружен, но не подан');
  await expect(page.getByTestId('issue-registry')).toBeDisabled();

  // Состав записан в базу, а не только отрисован.
  const view = await page.request.get(`/api/v1/registries/${IDS.registry}`);
  const body = (await view.json()) as {
    registry: { number: string | null };
    works: { id: string }[];
    file: { kind: string; autoRunEnabled: boolean } | null;
  };
  expect(body.registry.number).toBe('8');
  expect(body.works.map((work) => work.id)).toContain(IDS.workReview);
  expect(body.file?.kind).toBe('registry');
  // Разметку описи человек не ведёт: она нужна целиком и сразу для сверки.
  expect(body.file?.autoRunEnabled).toBe(true);
});

test('передача фиксирует опись, приёмку делает инженер', async ({ page }) => {
  // Реестр готов заранее: подача ревизии описи требует собранного рабочего
  // документа, а стенд поднимается без воркера.
  await signIn(page, KC.general, `/ids/registries/${IDS.registryReady}`);

  await expect(page.getByTestId('issue-blockers')).toHaveCount(0);
  await page.getByTestId('issue-registry').click();

  await expect(page.getByText('Папка передана')).toBeVisible();
  await expect(page.getByText('Опись на момент передачи')).toBeVisible();
  await expect(page.getByTestId('issue-registry')).toHaveCount(0);

  // Снимок записан: строка описи ссылается на ту ревизию, что была подана.
  const items = await page.request.get(`/api/v1/registries/${IDS.registryReady}/items`);
  const snapshot = (await items.json()) as { workId: string; revisionId: string }[];
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]?.workId).toBe(IDS.workIssued);
  expect(snapshot[0]?.revisionId).toBe(IDS.revisionIssued);

  // Форма шапки после передачи не показывается вовсе: заполненные поля с
  // отказом при сохранении читались бы как поломка, а не как свойство.
  await expect(page.getByTestId('header-number')).toHaveCount(0);
  await expect(page.getByTestId('add-work')).toHaveCount(0);

  // Принимает сторона заказчика: тот, кто передал, не принимает сам у себя.
  await signIn(page, KC.engineer, `/ids/registries/${IDS.registryReady}`);
  await page.getByTestId('accept-registry').click();
  await expect(page.getByText('Папка принята')).toBeVisible();
});

test('подрядчик видит реестр, но не состав чужой папки', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/registries/${IDS.registryReady}`);

  await expect(page.getByTestId('registry-hidden')).toBeVisible();
  await expect(page.getByText('Состав', { exact: true })).toHaveCount(0);

  // Снимок ему отдаётся, но только собственными строками.
  const items = await page.request.get(`/api/v1/registries/${IDS.registryReady}/items`);
  expect(items.status()).toBe(200);
  const snapshot = (await items.json()) as { contractorId: string }[];
  for (const row of snapshot) expect(row.contractorId).toBe(IDS.orgContractor);
});

test('роли подрядчика и инженера вместе: отказ подтверждён сервером', async ({ page }) => {
  await signIn(page, KC.mixed, `/ids/objects/${IDS.object}`);

  const refused = await apiPost(page, '/api/v1/works', {
    data: {
      objectId: IDS.object,
      sectionCode: IDS.sectionCode,
      period: IDS.period,
      title: 'Комплект от совмещающего роли',
    },
  });
  expect(refused.status).toBe(403);
  const problem = refused.body as { type?: string; detail?: string };
  expect(problem.type).toBe('urn:id-portal:problem:forbidden');
  expect(problem.detail).toContain('организации');
});

test('несуществующий реестр неотличим от чужого и не выглядит пустой таблицей', async ({
  page,
}) => {
  const absent = '00000000-0000-4000-8000-0000000009ff';
  await signIn(page, KC.contractor, `/ids/registries/${absent}`);

  // Экран говорит об отказе. Пустая таблица состава здесь была бы худшим из
  // возможных ответов: она выглядит рабочей.
  await expect(page.getByText('Реестр недоступен')).toBeVisible();

  const direct = await page.request.get(`/api/v1/registries/${absent}`);
  expect(direct.status()).toBe(404);
  expect(direct.headers()['content-type']).toContain('application/problem+json');
});
