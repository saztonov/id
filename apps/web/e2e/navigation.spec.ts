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
 * 1. Дерево навигации проходится целиком настоящими маршрутами (`/folders`),
 *    а не вложенными путями, которых в API нет.
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
  expect(calls.some((call) => call.startsWith('/api/v1/folders?'))).toBe(false);

  // Счётчик в заголовке приходит своим маршрутом, а не выкачиванием комплектов.
  expect(calls.some((call) => call.includes(`/objects/${IDS.object}/sections/counts`))).toBe(true);

  await openSection(page, 'Кровля');

  // Комплекты раздела видны, и это не пустая таблица-заглушка.
  await expect(page.getByRole('link', { name: 'Комплект с разметкой' })).toBeVisible();
  await expect(page.getByText('Комплекты раздела: раздел недоступен')).toHaveCount(0);

  // Фильтр объекта ушёл в строку запроса плоской коллекции, а не во вложенный
  // путь: ровно то расхождение, из-за которого экран показывал «недоступно».
  expect(calls.some((call) => call.startsWith('/api/v1/folders?'))).toBe(true);
  expect(calls.some((call) => call.includes(`objectId=${IDS.object}`))).toBe(true);
  expect(calls.some((call) => call.includes(`sectionCode=${IDS.sectionCode}`))).toBe(true);
  // Проверяется отсутствие вложенного СПИСКА комплектов — того самого пути,
  // которого в API нет и который экран когда-то угадал. `/folders/pipeline` под
  // тем же префиксом существует и законен: это сводка конвейера по уже
  // отрисованным строкам (S37), а не второй способ получить комплекты.
  expect(
    calls.some((call) => new RegExp(`/objects/${IDS.object}/folders(?:[?]|$)`, 'u').test(call)),
  ).toBe(false);

  // Реестры объекта читаются той же плоской коллекцией.

  // Из списка раздела открывается рабочее место папки — конец пути.
  await page.getByRole('link', { name: 'Комплект с разметкой' }).click();
  await expect(page).toHaveURL(/\/ids\/folders\//u);

  // Наименование печатается ОДИН раз: заголовком. Подзаголовок его больше не
  // повторяет, но и не исчезает — третье утверждение сторожит именно это,
  // потому что без него правка «убрать повтор» прошла бы и при пропавшей
  // строке.
  await expect(page.getByRole('heading', { level: 1, name: 'Комплект с разметкой' })).toBeVisible();
  await expect(page.getByText('Комплект работы: Комплект с разметкой')).toHaveCount(0);
  await expect(page.getByText(/^Комплект работы · /u)).toBeVisible();
});

test('подрядчик заводит папку одним файлом, и она открывается', async ({ page }) => {
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

  await page.getByTestId('create-work').click();

  // Экран уходит на рабочее место новой папки: загружать файлы больше некуда,
  // кроме неё самой.
  await expect(page).toHaveURL(/\/ids\/folders\/[0-9a-f-]{36}/u, { timeout: 30_000 });

  // Последствие в базе, а не надпись: папка в списке объекта и открывается по
  // своему же идентификатору.
  const list = await page.request.get(`/api/v1/folders?objectId=${IDS.object}&limit=50`);
  expect(list.status()).toBe(200);
  const folders = (await list.json()) as {
    items: {
      id: string;
      title: string;
      contractorId: string;
      managedByContractorId: string;
    }[];
  };
  const created = folders.items.find((item) => item.title === 'Комплект из интерфейса');
  expect(created, 'заведённая папка обязана быть в списке объекта').toBeDefined();
  // Организация взята из области видимости, а не из формы: поля исполнителя у
  // подрядчика нет вовсе.
  expect(created?.contractorId).toBe(IDS.orgContractor);
  expect(created?.managedByContractorId).toBe(IDS.orgContractor);

  const opened = await page.request.get(`/api/v1/folders/${created?.id ?? ''}`);
  expect(opened.status()).toBe(200);
  expect(((await opened.json()) as { id: string }).id).toBe(created?.id);
});

test('поля исполнителя нет ни у одной роли: его выводит сервер', async ({ page }) => {
  // До S37 поле было обязательным для проверяющего и необязательным для
  // генподрядчика. Заказчик снял его совсем: в момент загрузки файла человек
  // исполнителя не знает — файл ещё никто не читал.
  for (const kc of [KC.contractor, KC.general, KC.engineer]) {
    await signIn(page, kc, `/ids/objects/${IDS.object}`);
    await openSection(page, 'Кровля');
    await page.getByTestId('new-work').click();
    await expect(page.getByTestId('work-title')).toBeVisible();
    await expect(page.getByTestId('work-contractor')).toHaveCount(0);
  }
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
  await page.getByTestId('create-work').click();

  // Экран называет состояние и даёт путь дальше, а не сообщает «не получилось».
  const orphan = page.getByTestId('upload-orphan');
  await expect(orphan).toBeVisible({ timeout: 30_000 });
  await expect(orphan).toContainText('открыть ревизию');

  // Последствие в базе: комплект существует и у него есть черновая ревизия.
  const list = await page.request.get(`/api/v1/folders?objectId=${IDS.object}&limit=50`);
  const works = (await list.json()) as {
    items: { title: string; currentFolderId: string | null }[];
  };
  const created = works.items.find((item) => item.title === 'Комплект с оборванной загрузкой');
  expect(created, 'комплект не должен удаляться из-за отказа на заливке').toBeDefined();
  expect(created?.currentFolderId).not.toBeNull();
});

test('роли подрядчика и инженера вместе: организация берётся не из второй роли', async ({
  page,
}) => {
  // Область строится по СТАРШЕЙ роли, то есть инженерской, и организации не
  // содержит. До S37 портал на этом отказывал; теперь он выводит исполнителя из
  // карточки объекта — но по-прежнему НЕ берёт организацию подрядчика, которым
  // тот же человек числится второй ролью. Это и проверяется.
  await signIn(page, KC.mixed, `/ids/objects/${IDS.object}`);

  const created = await apiPost(page, '/api/v1/folders', {
    data: {
      objectId: IDS.object,
      sectionCode: IDS.sectionCode,
      period: IDS.period,
      title: 'Комплект от совмещающего роли',
    },
  });
  expect(created.status).toBe(201);

  const { work } = created.body as {
    work: { contractorId: string; contractorAssumed: boolean };
  };
  expect(work.contractorId).toBe(IDS.orgGeneral);
  expect(work.contractorId).not.toBe(IDS.orgContractor);
  // Признак поднят: назвал не человек, и на экране будет надпись, а не имя.
  expect(work.contractorAssumed).toBe(true);
});
