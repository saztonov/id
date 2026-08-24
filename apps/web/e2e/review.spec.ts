/**
 * Просмотр замечаний и согласование (§9, §9.6, §14).
 *
 * Проверяется троичная логика на экране, переход к доказательству и то, что
 * approve действительно меняет статус ревизии в базе — а не «кнопка нажалась».
 */
import { expect, test } from '@playwright/test';
import { IDS, KC, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

test('замечание видно вместе с важностью, состоянием и источником', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);

  await expect(page.getByRole('cell', { name: 'AOSR.HDR.022' })).toBeVisible();
  await expect(page.getByText('ОГРН не проходит проверку контрольной суммы')).toBeVisible();
  // Источник замечания показан: находка правила и находка модели имеют разный
  // вес, и проверяющий обязан видеть, что перед ним (§3.7).
  await expect(page.getByRole('cell', { name: 'Правило' })).toBeVisible();
  await expect(page.getByTestId('blocking-count')).toContainText('блокирующих открытых: 0');

  // Подсказка по устранению — в раскрытии строки: замечание без способа
  // устранения бесполезно подрядчику (§9.1). Кнопка ищется по РУССКОЙ подписи:
  // портал собран с `locale={ruRU}`, и `aria-label` таблицы приходит оттуда же
  // («Развернуть строку»). Английское `Expand row` не нашлось бы никогда, а
  // выглядело бы это как «раскрытие строки не работает».
  await page.getByRole('button', { name: 'Развернуть строку' }).first().click();
  await expect(page.getByText('Сверьте значение с выпиской ЕГРЮЛ')).toBeVisible();
});

// Согласование живёт на вкладке «Проверка» с S24: решение принимают, глядя на
// список замечаний, а не на журнал. На «Истории» остался журнал без кнопок.
test('экран согласования показывает препятствия до нажатия', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);

  await expect(page.getByTestId('approval-card')).toBeVisible();
  await expect(page.getByTestId('revision-status')).toContainText('На проверке');
  // Подача уже состоялась, поэтому препятствие подаче названо, а кнопка выключена.
  await expect(page.getByText('Мешает отправить')).toBeVisible();
  await expect(page.getByTestId('submit-revision')).toBeDisabled();
});

test('вкладка «История» не предлагает действий', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=history`);

  await expect(page.getByTestId('revision-status')).toBeVisible();
  await expect(page.getByTestId('submit-revision')).toHaveCount(0);
  await expect(page.getByTestId('approve-revision')).toHaveCount(0);
});

test('согласование меняет статус ревизии в базе', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);

  await page.getByTestId('approve-revision').click();

  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/v1/revisions/${IDS.revisionReview}/workflow`);
      const body = (await response.json()) as { revision: { status: string } };
      return body.revision.status;
    })
    .toBe('approved');

  await expect(page.getByTestId('revision-status')).toContainText('Согласована');
});

test('согласованная ревизия заперта: правка производного содержимого недоступна', async ({
  page,
}) => {
  // Прежний адрес вкладки «Документы» обязан продолжать работать: он
  // переписывается на секцию «Проверки», а не открывает «Файлы» молча.
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=documents`);

  await expect(page.getByText('Ревизия в терминальном состоянии')).toBeVisible();
  await expect(page.getByTestId('confirm-document-1')).toBeDisabled();
});
