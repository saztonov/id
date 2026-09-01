/**
 * Accessibility — часть гейта §17.
 *
 * Две линии, и обе нужны.
 *
 * **Автоматическая (axe-core)** ловит то, что проверяется механически: контраст,
 * отсутствующие подписи, роли, порядок заголовков. Правила отбираются по
 * WCAG 2.1 A/AA — уровень, на который портал и рассчитан.
 *
 * **Ручные утверждения** ловят то, чего axe увидеть не может по построению.
 * Главное из них — редактор блоков: Konva рисует в `<canvas>`, и внутри него для
 * скринридера НЕТ ничего. Автоматическая проверка канвы всегда «чистая», потому
 * что проверять нечего. Значит, доступность редактора держится не на канве, а на
 * том, что у каждого действия есть второй путь: список блоков с чекбоксами и
 * кнопки панели. Это и проверяется прямо — обходом с клавиатуры.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { IDS, KC, signIn } from './support/session.js';

/** Уровни WCAG, по которым идёт проверка. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function analyze(page: Page, selector = 'body'): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).include(selector).analyze();

  // Отчёт печатается целиком: «упало 3 нарушения» без их имён не сообщает, что
  // именно чинить, и превращает гейт в препятствие вместо указания.
  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'без оценки'}): ${violation.help}\n  ` +
        violation.nodes.map((node) => node.target.join(' ')).join('\n  '),
    )
    .join('\n');
  expect(summary, `нарушения доступности на ${page.url()}`).toBe('');
}

test('раздел ИД проходит проверку axe', async ({ page }) => {
  await signIn(page, KC.engineer, '/ids');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await analyze(page);
});

/**
 * Экран объекта — с раскрытым разделом и открытой формой заведения.
 *
 * Свёрнутое дерево проверяет не то: и панель отбора, и таблица комплектов, и
 * форма с полем выбора файла появляются только раскрытыми, а разметку без них
 * axe объявит чистой просто потому, что её нет.
 */
test('экран объекта проходит axe с раскрытым разделом', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/objects/${IDS.object}`);
  await page.getByRole('button', { name: /Кровля/u }).click();
  await expect(page.getByTestId('new-work')).toBeVisible({ timeout: 30_000 });
  await analyze(page);

  await page.getByTestId('new-work').click();
  await expect(page.getByTestId('work-title')).toBeVisible();
  await analyze(page);
});

test('свёрнутое боковое меню остаётся доступным', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // Иконка без доступного имени для скринридера нема, поэтому в свёрнутом виде
  // название раздела остаётся в разметке визуально скрытым.
  await page.getByTestId('nav-toggle').click();
  await expect(page.getByRole('link', { name: 'Справочники' })).toBeVisible();
  await analyze(page);
});

test('формы справочника проходят axe', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=counterparties');
  await page.getByTestId('new-counterparty').click();
  await expect(page.getByTestId('counterparty-name')).toBeVisible();
  await analyze(page);
});

test('экран разметки проходит проверку axe', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/folders/${IDS.folderMarkup}?tab=markup`);
  await expect(page.getByRole('application')).toBeVisible();
  // Комбобокс типа страницы обязан иметь доступное имя с номером страницы:
  // панель стоит над канвой Konva, и это единственный путь к действию для
  // скринридера.
  await expect(
    page.getByTestId('page-type-panel').getByRole('combobox', { name: 'Вид ИД страницы 1' }),
  ).toBeVisible();
  await analyze(page);
});

test('экран проверки и согласования проходит axe', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/folders/${IDS.folderReview}?tab=checks`);
  await expect(page.getByTestId('checks-report')).toBeVisible();
  await analyze(page);
});

/**
 * Ревизия, у которой проверки ещё не было.
 *
 * Отдельный прогон, потому что это ДРУГАЯ разметка: вместо таблицы на экране
 * плашка состояния, и проверять её на ревизии с замечаниями нельзя — там её
 * нет вовсе.
 */
test('пустая проверка проходит axe и объясняет себя', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderEmpty}?tab=checks`);
  await expect(page.getByTestId('checks-run-state')).toContainText('Проверка ещё не выполнялась');
  await analyze(page);
});

test('модалка замены файла проходит axe', async ({ page }) => {
  await signIn(page, KC.contractor, `/ids/folders/${IDS.folderMarkup}?tab=files`);
  await page.getByTestId(`replace-file-${IDS.fileMarkup}`).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await analyze(page);
});

test('администрирование проходит axe', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=diagnostics');
  await expect(page.getByText('Глубина очереди')).toBeVisible();
  await analyze(page);
});

/**
 * Ряд вкладок администрирования на узком экране.
 *
 * Проверка существует ровно потому, что горизонтальный ряд однажды уже сломался
 * доступностью: при переполнении `Tabs` antd добавляет кнопку свёртки, а она
 * кладёт внутрь `tablist` элемент, вкладкой не являющийся —
 * `aria-required-children`, нарушение критического уровня. Ради этого вкладки
 * держались столбцом; вернув ряд, их сократили до семи. Утверждение «семи хватает»
 * обязано проверяться прогоном, а не глазомером, и именно на том вьюпорте, где
 * места меньше всего.
 */
test('ряд вкладок администрирования не переполняется на узком экране', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await signIn(page, KC.admin, '/admin?tab=diagnostics');
  await expect(page.getByText('Глубина очереди')).toBeVisible();

  // Кнопки свёртки быть не должно: её появление и есть тот дефект, а axe ниже
  // назвал бы его невнятно — «внутри tablist посторонний элемент».
  await expect(page.locator('.ant-tabs-nav-more')).toBeHidden();
  await analyze(page);
});

test('журнал ошибок проходит axe', async ({ page }) => {
  // `?tab=journal` — алиас на «Диагностику» с открытым разделом журнала.
  await signIn(page, KC.admin, '/admin?tab=journal');
  const panel = page.getByRole('tabpanel', { name: 'Диагностика' });
  await expect(panel).toContainText('Примеров сохранено', { timeout: 30_000 });
  await analyze(page);

  // Остальные разделы журнала: у каждого своя разметка и свои таблицы.
  const sections = page.getByRole('radiogroup', { name: 'Раздел журнала' });

  await sections.getByText('Аномалии и скорость', { exact: true }).click();
  await expect(panel).toContainText('Это счётчики за сутки');
  await analyze(page);

  await sections.getByText('Качество конвейера', { exact: true }).click();
  await expect(panel).toContainText('Здесь дефекты качества');
  await analyze(page);
});

test('справочник профилей разделов проходит проверку axe', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=section-profiles');
  // Панель открывается на первом разделе справочника, а профиль заведён у
  // кровли: раздел выбирается явно, иначе проверялась бы пустая карточка.
  const picker = page.getByRole('combobox', { name: 'Раздел работ' });
  await picker.click();
  // Ввод, а не прокрутка: список виртуальный, и «Кровля» в нём далеко не первая.
  await picker.fill('Кровля');
  await page.locator('.ant-select-dropdown:visible').getByTitle('Кровля').click();
  await expect(page.getByTestId('section-profile-card').first()).toBeVisible();
  await analyze(page);
});

test('правила и наборы правил проходят проверку axe', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=rules');
  await expect(page.getByText('Реестр правил', { exact: true })).toBeVisible();
  await analyze(page);
});

test('раздел промтов проходит проверку axe', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=prompts');
  await expect(page.getByRole('cell', { name: 'page_classify_base' }).first()).toBeVisible();
  await analyze(page);
});

test('ориентиры страницы и ссылка «к содержимому» на месте', async ({ page }) => {
  await signIn(page, KC.engineer, '/ids');

  // Ориентиры: без них скринридер обходит страницу линейно.
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toHaveCount(1);
  // Ровно один h1 на страницу.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  // Активный раздел помечен не только цветом.
  await expect(page.locator('a[aria-current="page"]')).toHaveCount(1);

  // Первый Tab даёт ссылку «к содержимому»: иначе клавиатурный пользователь
  // проходит навигацию заново на каждом переходе.
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveText('Перейти к содержимому');
});

test('редактор блоков управляется с клавиатуры, а не только мышью по канве', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/folders/${IDS.folderMarkup}?tab=markup`);

  // Канва объявлена приложением и несёт описание: скринридер получает хотя бы
  // сведения о странице и числе блоков.
  const canvasArea = page.getByRole('application');
  await expect(canvasArea).toHaveAttribute('aria-label', /Страница 1, блоков: \d+/);

  // Второй путь к блокам: выбор блока списком в панели инструментов. Элементы
  // Konva живут в `<canvas>` и недостижимы ни фокусу, ни скринридеру, поэтому
  // весь набор — выбрать, сменить тип, удалить — обязан существовать в DOM.
  const blockSelect = page.getByRole('combobox', { name: 'Блок страницы' });
  await expect(blockSelect).toBeVisible();
  await blockSelect.focus();
  await page.keyboard.press('Enter');
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText(/% страницы/)
    .first()
    .click();

  // Действия над выделенным — настоящие кнопки, а не обработчики на канве.
  // Кнопка типа при непустом выделении меняет тип, кнопка удаления — удаляет.
  await expect(page.getByRole('button', { name: 'Штамп' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Удалить' })).toBeEnabled();

  // Сама канва тоже попадает в обход табом: без этого её клавиши (Delete, Esc)
  // достались бы только тем, кто уже кликнул по ней мышью.
  await expect(canvasArea).toHaveAttribute('tabindex', '0');

  // Страницы ленты — кнопки в списке, с пометкой активной.
  const strip = page.getByRole('navigation', { name: 'Страницы рабочего документа' });
  await expect(strip.locator('button[aria-current="page"]')).toHaveCount(1);
});
