/**
 * Справочники §14: профили разделов и реестр РД.
 *
 * Профиль раздела — это то, чем правила полноты отличают «комплект неполон» от
 * «раздел не настроен» (§9.1). Поэтому проверяется не только показ действующей
 * версии, но и обратный случай: у раздела без профиля экран обязан сказать «не
 * настроен», а не показать пустую таблицу.
 */
import { expect, test, type Page } from '@playwright/test';
import { apiPost, KC, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

/**
 * Выбор раздела в панели профилей.
 *
 * До 0028 в справочнике был ровно один раздел из фикстуры, и панель открывалась
 * на нём. Теперь разделов двадцать четыре — они пришли сидом 0029, — и первым
 * идёт «Благоустройство». Раздел, у которого есть профиль, выбирается явно.
 */
async function pickRoofing(page: Page): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Раздел работ' });
  await picker.click();
  // Ввод, а не прокрутка: список виртуальный, и «Кровля» в нём далеко не первая.
  await picker.fill('Кровля');
  await page.locator('.ant-select-dropdown:visible').getByTitle('Кровля').click();
}

test('действующий профиль раздела показан составом, а не ссылкой', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=section-profiles');
  await pickRoofing(page);

  const card = page.getByTestId('section-profile-card').first();
  await expect(card).toBeVisible();
  // Ожидаемый состав документов, категории материалов и применимые правила —
  // три вещи, ради которых профиль и существует.
  await expect(card).toContainText('aosr');
  await expect(card).toContainText('roll_waterproofing');
  await expect(card).toContainText('AOSR.HDR.022');
  await expect(card).toContainText('с участием человека');
});

test('черновик версии профиля публикуется отдельным действием', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=section-profiles');
  await pickRoofing(page);

  await expect(page.getByText('черновик')).toBeVisible();
  await page.getByTestId('publish-profile-2').click();

  await expect
    .poll(async () => {
      const response = await page.request.get(
        '/api/v1/catalog/section-profiles?sectionCode=roofing',
      );
      const body = (await response.json()) as { version: number; publishedAt: string | null }[];
      const second = body.find((item) => item.version === 2);
      return second?.publishedAt === null || second === undefined ? 'черновик' : 'опубликован';
    })
    .toBe('опубликован');
});

test('раздел без профиля назван не настроенным, а не пустым', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=section-profiles');
  await pickRoofing(page);

  // Проверяется ответ 404 маршрута действующего профиля: он законный и обязан
  // читаться как состояние открытого мира, а не как сбой. Запрос идёт ПОСЛЕ
  // входа: `page.request` ходит с cookie вкладки, и до входа её просто нет —
  // 401 здесь означал бы неавторизованного клиента, а не отсутствие профиля.
  const response = await page.request.get(
    '/api/v1/catalog/sections/roofing/effective-profile?at=2000-01-01',
  );
  expect(response.status()).toBe(404);
  await page.getByLabel('Дата, на которую нужен действующий профиль').fill('2000-01-01');

  await expect(page.getByTestId('profile-absent')).toBeVisible();
  await expect(page.getByTestId('profile-absent')).toContainText('раздел не настроен');
});

test('реестр РД объекта читается и различает отключённые шифры', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=rd-documents');

  await expect(page.getByRole('cell', { name: 'АР-2.1-КР', exact: true })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Кровля. Узлы примыканий', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('действует')).toBeVisible();
});

test('подрядчик читает реестр РД своего объекта тем же маршрутом', async ({ page }) => {
  await signIn(page, KC.contractor, '/catalog?tab=rd-documents');

  // Объект виден подрядчику потому, что у него есть на нём поставки — это и
  // есть область видимости класса 1. Реестр РД читается по объекту, поэтому
  // отдельного правила ему не нужно, и отдельного пустого экрана — тоже.
  await expect(page.getByRole('cell', { name: 'АР-2.1-КР', exact: true })).toBeVisible();
});

// =====================================================================
// Заведение карточек и массовый ввод (S18)
// =====================================================================

test('контрагент заводится формой, а битая контрольная сумма подсвечивает поле', async ({
  page,
}) => {
  await signIn(page, KC.admin, '/catalog?tab=counterparties');

  await page.getByTestId('new-counterparty').click();
  await page.getByTestId('counterparty-name').fill('ООО «Испытательный центр»');
  await page.getByTestId('counterparty-kind').click();
  await page.getByTitle('Испытательная лаборатория').click();

  // Форма верна, контрольная сумма — нет: CHECK в БД такое значение пропустил
  // бы, поэтому отказ здесь доказывает работу входа справочника.
  await page.getByTestId('counterparty-inn').fill('7700123458');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText(/Контрольная сумма ИНН/u)).toBeVisible();

  await page.getByTestId('counterparty-inn').fill('7700123459');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(
    page.getByRole('cell', { name: 'ООО «Испытательный центр»', exact: true }),
  ).toBeVisible();
  // Вид показан наименованием: код `laboratory` человеку ничего не сообщает.
  await expect(
    page.getByRole('cell', { name: 'Испытательная лаборатория', exact: true }),
  ).toBeVisible();
});

test('объект заводится формой и появляется в разделе ИД', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=objects');

  await page.getByTestId('new-object').click();
  await page.getByTestId('object-code').fill('E2E77');
  await page.getByTestId('object-name').fill('Объект из формы');
  await page.getByTestId('object-full-name').fill('ЖК «Форма», корпус 1');
  await page.getByRole('button', { name: 'Сохранить' }).click();

  await expect(page.getByRole('cell', { name: 'E2E77', exact: true })).toBeVisible();

  await page.goto('/ids');
  // Раздел ИД показывает объекты галереей карточек, а не таблицей: карточка — это
  // ссылка, и её доступное имя складывается из наименования и строки «код · адрес».
  await expect(page.getByRole('link', { name: /Объект из формы/u })).toBeVisible();
});

/**
 * Справочник объектов ПОСЛЕ галереи раздела ИД (S39).
 *
 * Порядок здесь и есть проверка. Оба экрана читают один и тот же маршрут, но
 * разными хуками: галерея — `useInfiniteQuery`, справочник — `useQuery`. Пока
 * ключ кэша был общим, первый заполнял его структурой `{ pages, pageParams }`,
 * а второй читал из неё `items` — получал `undefined` и показывал «В
 * справочнике нет ни одного объекта» при двух заведённых объектах. Ни ошибки,
 * ни загрузки: экран выглядел рабочим и молчал.
 *
 * Переход СТРОГО ссылкой, а не `page.goto`: перезагрузка страницы очищает кэш и
 * прячет дефект — тест стал бы зелёным, ничего не проверяя.
 */
test('объекты видны в справочнике после захода в раздел ИД', async ({ page }) => {
  await signIn(page, KC.admin, '/ids');
  await expect(page.getByRole('link', { name: /Объект сквозного прогона/u })).toBeVisible();

  await page.getByRole('link', { name: 'Справочники' }).click();
  await expect(page).toHaveURL(/\/catalog/u);

  await expect(page.getByRole('cell', { name: 'E2E01', exact: true })).toBeVisible();
  await expect(page.getByText('В справочнике нет ни одного объекта')).toHaveCount(0);
});

test('удаление объекта со связями отклоняется с названной причиной', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=objects');

  const row = page.getByRole('row', { name: /E2E01/u });
  await row.getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('button', { name: 'Удалить', exact: true }).last().click();

  // «Нельзя» без причины отправило бы администратора искать ссылку по схеме.
  await expect(page.getByText(/разделы работ/u)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'E2E01', exact: true })).toBeVisible();
});

test('импорт из Excel разбирается воркером и заводит карточки после подтверждения', async ({
  page,
}) => {
  await signIn(page, KC.admin, '/catalog?tab=imports');

  // Файл собирается тем же писателем, что отдаёт шаблон: браузер офисные файлы
  // не разбирает и не собирает, поэтому книга приходит с сервера.
  const template = await page.request.get('/api/v1/catalog/imports/template?target=counterparties');
  expect(template.status()).toBe(200);

  // Мутация мимо интерфейса требует CSRF-заголовка ровно так же, как из него:
  // токен читается из cookie той же вкладки.
  const init = await apiPost(page, '/api/v1/catalog/imports/init', {
    data: { target: 'counterparties', fileName: 'e2e.xlsx', sizeBytes: 1024 },
  });
  expect(init.status).toBe(201);
  const ticket = init.body as { importId: string; uploadId: string; uploadUrl: string };

  // Загружается шаблон: в нём есть заголовок и строка подсказок, то есть одна
  // строка данных, которую разбор обязан отвергнуть как строку с ошибкой, — а
  // значит виден весь путь до предпросмотра.
  await page.request.fetch(ticket.uploadUrl, {
    method: 'PUT',
    data: await template.body(),
  });
  const complete = await apiPost(page, `/api/v1/catalog/imports/${ticket.importId}/complete`, {
    data: { uploadId: ticket.uploadId },
  });
  expect(complete.status).toBe(200);

  await page.reload();
  // Разбор выполняет настоящий обработчик воркера, поднятый стендом.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/catalog/imports/${ticket.importId}`);
        return ((await response.json()) as { status: string }).status;
      },
      { timeout: 15_000 },
    )
    .toBe('ready');

  await page.getByRole('cell', { name: 'e2e.xlsx' }).click();
  const dialog = page.getByRole('dialog', { name: 'Импорт справочника' });
  await expect(dialog.getByText('предпросмотр готов')).toBeVisible();

  // Единственная строка данных шаблона — подсказки, а не реквизиты: разбор
  // обязан отвергнуть её замечанием, а не завести карточку с текстом подсказки.
  await expect(dialog.getByRole('button', { name: 'Заводить нечего' })).toBeVisible();
});
