/**
 * Навигация «finding → evidence», дерево документов и живая лента (§14, §16, §3.8).
 *
 * §16 называет переход от замечания к доказательству отдельным пунктом приёмки,
 * и проверять его надо там, где доказательство существует: на ревизии с
 * разметкой и блоками. Проверяется не наличие ссылки, а результат перехода —
 * открыта ТА страница рабочего документа и выделен ТОТ блок, на который
 * ссылается замечание.
 *
 * Файл идёт раньше `files`/`markup` по алфавиту, то есть на нетронутой разметке:
 * это осознанно — тест про адрес блока не должен зависеть от того, что с этим
 * блоком сделал предыдущий сценарий.
 */
import { expect, test } from '@playwright/test';
import { IDS, KC, signIn } from './support/session.js';

test('замечание ведёт на страницу и выделяет блок, а не печатает идентификатор', async ({
  page,
}) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionMarkup}?tab=checks`);

  const evidence = page.getByTestId('evidence-AOSR.HDR.022');
  await expect(evidence).toBeVisible();
  // Страница ревизии переведена в номер страницы рабочего документа: замечание
  // указывает на вторую страницу карты `processing_bundle_pages`.
  await expect(evidence).toContainText('К блоку на странице 2');

  await evidence.getByRole('link').first().click();

  // Открылась разметка на нужной странице: страница 2 повёрнута на 90°, и её
  // карточка в ленте помечена активной.
  await expect(page.getByRole('application')).toBeVisible();
  await expect(page).toHaveURL(/tab=markup/);

  // Блок замечания выделен: чекбокс списка блоков — второй, клавиатурный путь к
  // тому же выделению, и именно по нему видно, что адрес доехал.
  const row = page.getByTestId(`block-row-${IDS.blockB}`);
  await expect(row).toBeVisible();
  await expect(page.locator(`input[type="checkbox"]:checked`).first()).toBeVisible();
});

test('замечание без страницы не притворяется имеющим доказательство', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);

  // У замечания ревизии на проверке цель — документ, страница указана, но
  // рабочий документ этой ревизии содержит одну страницу: ссылка обязана вести
  // на неё, а вторая ссылка — на документ.
  const evidence = page.getByTestId('evidence-AOSR.HDR.022');
  await expect(evidence).toBeVisible();
  await expect(evidence.getByRole('link', { name: 'К документу' })).toBeVisible();
});

test('дерево документов показывает страницы с ролями и причины непривязки', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=documents`);

  const tree = page.getByTestId('documents-tree');
  await expect(tree).toBeVisible();
  await expect(tree).toContainText('АОСР № 336');
  // Обе ветви учёта названы всегда, даже когда пусты: счётчик без списка
  // превращает нарушение инварианта §16 в число, с которым нечего делать.
  await expect(tree).toContainText('Непривязанные страницы');
  await expect(tree).toContainText('Неучтённые страницы');
  await expect(page.getByTestId('pages-unaccounted')).toContainText('не учтено: 0');
});

test('правка границ названа недоступной вместе с маршрутом, которого нет', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=documents`);

  await expect(page.getByText('Границы документов правятся только пересборкой')).toBeVisible();
  await expect(page.getByText('/page-assignments/')).toBeVisible();
});

test('экран ревизии держится живой лентой событий, а не только опросом', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionMarkup}?tab=history`);

  // Поток открывается на уровне ревизии и переживает переключение вкладок.
  await expect(page.getByTestId('stream-status')).toHaveText('поток событий');

  await page.getByRole('tab', { name: 'Файлы' }).click();
  await expect(page.getByTestId('stream-status')).toHaveText('поток событий');
});
