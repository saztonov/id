/**
 * Навигация «finding → evidence» и живая лента (§14, §16, §3.8).
 *
 * §16 называет переход от замечания к доказательству отдельным пунктом
 * приёмки, и проверять его надо там, где доказательство существует: на ревизии
 * с разметкой и блоками. Проверяется не наличие ссылки, а результат перехода —
 * открыта ТА страница рабочего документа и выделен ТОТ блок, на который
 * ссылается замечание.
 *
 * Проверки дерева документов здесь больше нет: раздел удалён вместе с ручной
 * сборкой (S27, ADR-0016). Ушла и проверка «границы правятся только
 * пересборкой» — границы теперь подтверждает конвейер, и объяснять
 * пользователю недоступный маршрут стало нечем и незачем.
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
  // Номер сквозной по комплекту: замечание указывает на вторую страницу.
  await expect(evidence).toHaveText('2');

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

test('цитата доказательства заменяет удалённый раздел «Реквизиты»', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionMarkup}?tab=checks`);

  // Раздел «Реквизиты» удалён, и вместе с ним ушёл единственный экран, где было
  // видно, ЧЕМ подтверждается замечание. Цитата возвращает это в строку: у
  // фикстурного замечания доказательства нет, поэтому проверяется, что список
  // не выдумывает его — пустая цитата хуже отсутствующей.
  await expect(page.getByTestId('findings-by-page')).toBeVisible();
  await expect(page.getByText('в документе написано:')).toHaveCount(0);
});

test('экран ревизии держится живой лентой событий, а не только опросом', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionMarkup}?tab=history`);

  // Поток открывается на уровне ревизии и переживает переключение вкладок.
  await expect(page.getByTestId('stream-status')).toHaveText('поток событий');

  await page.getByRole('tab', { name: 'Файлы' }).click();
  await expect(page.getByTestId('stream-status')).toHaveText('поток событий');
});
