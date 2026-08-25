/**
 * Список ошибок и согласование (§9, §9.6, §14, ADR-0016).
 *
 * Проверяется форма, которую назвал заказчик: «страница такая-то — тип
 * документа такой-то — ошибка такая-то». Прежний экран печатал вместо этого код
 * правила, состояние, источник и идентификатор цели — семь колонок, ни одна из
 * которых не отвечала на вопрос «что не так с комплектом».
 *
 * Здесь же — то, чего на экране быть НЕ должно: фильтра состояний, счётчика
 * блокирующих, разделов «Документы комплекта» и «Реквизиты». Утверждения-негативы
 * стоят рядом с положительными намеренно: «нет фильтра» проходит и на пустой
 * странице, поэтому оно имеет смысл только вместе с «а список есть».
 */
import { expect, test } from '@playwright/test';
import { IDS, KC, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

test('строка называет страницу, вид документа и что не так', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);

  const rows = page.getByTestId('findings-by-page');
  await expect(rows).toBeVisible();

  // Вид ИД приходит из справочника, а не кодом типа: «aosr» человеку ничего
  // не говорит, и добывать название вторым запросом фронт больше не обязан.
  await expect(rows).toContainText('Акт освидетельствования скрытых работ');
  await expect(rows).toContainText('ОГРН не проходит проверку контрольной суммы');
  // Номер страницы — сквозной по комплекту, тот же, которым лист подписан в
  // бумажной папке.
  await expect(rows.getByRole('link', { name: '1', exact: true })).toBeVisible();

  // Способ устранения виден сразу, а не в раскрытии строки: замечание без него
  // бесполезно подрядчику (§9.1), а раскрытие — это ещё одно нажатие ради
  // текста в две строки.
  await expect(rows).toContainText('Сверьте значение с выпиской ЕГРЮЛ');
  // Код правила остаётся — он нужен поддержке, — но серой строкой, не колонкой.
  await expect(rows).toContainText('AOSR.HDR.022');
});

test('сводка отвечает словами, а не счётчиком блокирующих', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);

  const summary = page.getByTestId('checks-summary');
  await expect(summary).toContainText('Найдено');
  await expect(summary).toContainText('предупреждение');

  // Прежний счётчик «блокирующих открытых: 0» отвечал на вопрос, которого у
  // пользователя нет.
  await expect(page.getByTestId('blocking-count')).toHaveCount(0);
});

test('на экране нет ни фильтра состояний, ни разделов ручной сборки', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);
  await expect(page.getByTestId('findings-by-page')).toBeVisible();

  // Вкладки с типами замечаний убраны решением заказчика: состояние видно
  // тегом в строке, а не переключателем над таблицей.
  await expect(page.getByRole('radiogroup', { name: 'Фильтр замечаний по состоянию' })).toHaveCount(
    0,
  );
  await expect(page.getByText('Документы комплекта')).toHaveCount(0);
  await expect(page.getByText('Реквизиты', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('work-reconciliation')).toHaveCount(0);
});

test('прежние адреса разделов ведут на «Проверку» и говорят об этом', async ({ page }) => {
  // По `?tab=documents` ходят сохранённые ссылки. Молча открыть другой экран
  // значило бы сделать вид, что ссылка привела куда просили.
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=documents`);

  await expect(page).toHaveURL(/tab=checks/);
  await expect(page.getByText(/Разделы «Документы» и «Реквизиты» удалены/u)).toBeVisible();
  await expect(page.getByTestId('findings-by-page')).toBeVisible();
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

test('препятствия согласованию не требуют ручной сборки документов', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=checks`);
  await expect(page.getByTestId('approval-card')).toBeVisible();

  // Границы подтверждает конвейер, и просить об этом человека больше нечем:
  // раздела с кнопкой «Подтвердить» на экране нет.
  await expect(page.getByText(/без подтверждения границ/u)).toHaveCount(0);
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

test('согласованная ревизия заперта: состав не правится', async ({ page }) => {
  await signIn(page, KC.engineer, `/ids/revisions/${IDS.revisionReview}?tab=files`);

  await expect(page.getByText('Ревизия в терминальном состоянии')).toBeVisible();
  await expect(page.getByTestId(`replace-file-${IDS.fileReview}`)).toBeDisabled();
});
