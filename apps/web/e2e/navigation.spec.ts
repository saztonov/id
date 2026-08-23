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
 * 2. Подрядчик заводит комплект сам, ОДНИМ ФАЙЛОМ: раздел берётся из узла
 *    дерева, наименование — из имени файла, и вместе с комплектом открывается
 *    первая ревизия. Отдельно проверено, что отказ на заливке байтов комплект
 *    не выбрасывает: он остаётся черновиком, и экран даёт на него ссылку.
 * 3. Генподрядчик собирает реестр из комплектов, заводит файл описи и передаёт
 *    папку; после передачи состав виден снимком и больше не правится.
 * 4. Отказы объяснены на экране: у пользователя с ролями подрядчика и инженера
 *    организация не берётся из тела запроса, а не существующий реестр даёт
 *    отказ, а не пустую таблицу.
 *
 * Порядок последовательный: сценарии меняют состояние объекта и реестра, и
 * параллельный прогон делил бы одну базу.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { IDS, KC, apiPost, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

const FIXTURE = fileURLToPath(
  new URL('../../../tools/fixtures/pdf/multipage.pdf', import.meta.url),
);

/**
 * Раскрыть панель раздела и дождаться его содержимого.
 *
 * Содержимое узла монтируется только раскрытым, поэтому «кликнуть и сразу
 * искать таблицу» — гонка: без ожидания тест ловил бы момент до запроса.
 */
async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(name, 'u') }).click();
  await expect(page.getByTestId('new-work').or(page.getByTestId('works-more')).first()).toBeVisible(
    {
      timeout: 30_000,
    },
  );
}

/** Месяц выбирается селектом: поля ввода даты у формы больше нет. */
async function selectPeriod(page: Page, period: string): Promise<void> {
  const names = [
    'январь',
    'февраль',
    'март',
    'апрель',
    'май',
    'июнь',
    'июль',
    'август',
    'сентябрь',
    'октябрь',
    'ноябрь',
    'декабрь',
  ];
  const month = Number(period.split('-')[1] ?? '1');
  const label = `${names[month - 1] ?? ''} ${period.slice(0, 4)}`;
  await page.getByTestId('work-period').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle(label).click();
}

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

  // До раскрытия раздела комплекты НЕ запрашиваются: содержимое узла грузится
  // лениво, и проверяется это по сети, а не по виду экрана.
  await expect(page.getByRole('button', { name: /Кровля/u })).toBeVisible();
  expect(calls.some((call) => call.startsWith('/api/v1/works?'))).toBe(false);

  // Счётчик в заголовке приходит своим маршрутом, а не выкачиванием комплектов.
  expect(calls.some((call) => call.includes(`/objects/${IDS.object}/sections/counts`))).toBe(true);

  await openSection(page, 'Кровля');

  // Комплекты раздела видны, и это не пустая таблица-заглушка.
  await expect(page.getByRole('link', { name: 'Комплект с разметкой' })).toBeVisible();
  await expect(page.getByText('Комплекты раздела: раздел недоступен')).toHaveCount(0);

  // Фильтр объекта ушёл в строку запроса плоской коллекции, а не во вложенный
  // путь: ровно то расхождение, из-за которого экран показывал «недоступно».
  expect(calls.some((call) => call.startsWith('/api/v1/works?'))).toBe(true);
  expect(calls.some((call) => call.includes(`objectId=${IDS.object}`))).toBe(true);
  expect(calls.some((call) => call.includes(`sectionCode=${IDS.sectionCode}`))).toBe(true);
  expect(calls.some((call) => call.includes(`/objects/${IDS.object}/works`))).toBe(false);

  // Реестры объекта читаются той же плоской коллекцией.
  expect(calls.some((call) => call.startsWith('/api/v1/registries?'))).toBe(true);

  // Из комплекта открывается рабочее место ревизии — конец пути.
  await page.getByRole('link', { name: 'Комплект с разметкой' }).click();
  await expect(page).toHaveURL(/\/ids\/revisions\//u);
  await expect(page.getByText('Комплект работы: Комплект с разметкой')).toBeVisible();
});

test('подрядчик заводит комплект одним файлом, и открывается первая ревизия', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/objects/${IDS.object}`);

  // Раздел берётся из узла дерева, а не из селекта: форма живёт внутри него.
  await openSection(page, 'Кровля');
  await page.getByTestId('new-work').click();

  await page.getByTestId('work-file').setInputFiles({
    name: 'Многостраничный.pdf',
    mimeType: 'application/pdf',
    buffer: readFileSync(FIXTURE),
  });

  // Наименование подставилось из имени файла — и правится тут же.
  await expect(page.getByTestId('work-title')).toHaveValue('Многостраничный.pdf');
  await page.getByTestId('work-title').fill('Комплект из интерфейса');

  await selectPeriod(page, IDS.period);
  await page.getByTestId('create-work').click();

  // Экран уходит на рабочее место новой ревизии: комплект без ревизии — это
  // карточка, в которую некуда загружать файлы.
  await expect(page).toHaveURL(/\/ids\/revisions\/[0-9a-f-]{36}/u, { timeout: 30_000 });

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
  await openSection(page, 'Кровля');
  await page.getByTestId('new-work').click();
  await expect(page.getByTestId('work-title')).toBeVisible();
  await expect(page.getByTestId('work-contractor')).toHaveCount(0);

  await signIn(page, KC.general, `/ids/objects/${IDS.object}`);
  await openSection(page, 'Кровля');
  await page.getByTestId('new-work').click();
  await expect(page.getByTestId('work-contractor')).toBeVisible();
});

test('файл, отвергнутый хранилищем, оставляет комплект черновиком со ссылкой на него', async ({
  page,
}) => {
  await signIn(page, KC.contractor, `/ids/objects/${IDS.object}`);

  // Отказ подделывается на самом PUT байтов — там, где он и случается в бою
  // (нет CORS-политики бакета, обрыв канала). Комплект к этому моменту уже
  // заведён, и проверяется именно то, что его не выбрасывают.
  await page.route('**/api/v1/uploads/local**', (route) => route.abort('failed'));

  await openSection(page, 'Кровля');
  await page.getByTestId('new-work').click();
  await page.getByTestId('work-file').setInputFiles({
    name: 'Оборванный.pdf',
    mimeType: 'application/pdf',
    buffer: readFileSync(FIXTURE),
  });
  await page.getByTestId('work-title').fill('Комплект с оборванной загрузкой');
  await selectPeriod(page, IDS.period);
  await page.getByTestId('create-work').click();

  // Экран называет состояние и даёт путь дальше, а не сообщает «не получилось».
  const orphan = page.getByTestId('upload-orphan');
  await expect(orphan).toBeVisible({ timeout: 30_000 });
  await expect(orphan).toContainText('открыть ревизию');

  // Последствие в базе: комплект существует и у него есть черновая ревизия.
  const list = await page.request.get(`/api/v1/works?objectId=${IDS.object}&limit=50`);
  const works = (await list.json()) as {
    items: { title: string; currentRevisionId: string | null }[];
  };
  const created = works.items.find((item) => item.title === 'Комплект с оборванной загрузкой');
  expect(created, 'комплект не должен удаляться из-за отказа на заливке').toBeDefined();
  expect(created?.currentRevisionId).not.toBeNull();
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

/**
 * Сверка описи: карточка папки принадлежит ведущему её, и только ему.
 *
 * Проверяются обе стороны разделения выдач: генподрядчик видит карточку и
 * запускает сверку, подрядчик не видит её вовсе и получает 403 на маршруте
 * сводки по папке. Свои расхождения он читает на экране своего комплекта — там
 * в ответе сервера нет ни одного поля о папке.
 */
test('сверка описи: карточка папки — только ведущему её', async ({ page }) => {
  await signIn(page, KC.general, `/ids/registries/${IDS.registryReady}`);

  const run = page.getByTestId('reconcile-run');
  await expect(run).toBeVisible();
  // Сверки ещё не было: вместо чисел — объяснение, что скан надо провести по
  // конвейеру. Пустая карточка читалась бы как «всё сошлось».
  await expect(page.getByTestId('reconciliation-empty')).toBeVisible();

  await run.click();
  await expect(page.getByText(/Сверка (поставлена|этой папки уже идёт)/u)).toBeVisible();

  // У подрядчика карточки нет вовсе, а не пустая.
  await signIn(page, KC.contractor, `/ids/registries/${IDS.registryReady}`);
  await expect(page.getByTestId('reconcile-run')).toHaveCount(0);

  const summary = await page.request.get(`/api/v1/registries/${IDS.registryReady}/reconciliation`);
  expect(summary.status()).toBe(403);
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
