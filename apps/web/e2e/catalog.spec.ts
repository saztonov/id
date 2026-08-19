/**
 * Справочники §14: профили разделов и реестр РД.
 *
 * Профиль вида раздела — это то, чем правила полноты отличают «комплект
 * неполон» от «раздел не настроен» (§9.1). Поэтому проверяется не только показ
 * действующей версии, но и обратный случай: у вида раздела без профиля экран
 * обязан сказать «не настроен», а не показать пустую таблицу.
 */
import { expect, test } from '@playwright/test';
import { KC, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

test('действующий профиль вида раздела показан составом, а не ссылкой', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=section-profiles');

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

  await expect(page.getByText('черновик')).toBeVisible();
  await page.getByTestId('publish-profile-2').click();

  await expect
    .poll(async () => {
      const response = await page.request.get(
        '/api/v1/catalog/section-profiles?sectionKindCode=roofing',
      );
      const body = (await response.json()) as { version: number; publishedAt: string | null }[];
      const second = body.find((item) => item.version === 2);
      return second?.publishedAt === null || second === undefined ? 'черновик' : 'опубликован';
    })
    .toBe('опубликован');
});

test('вид раздела без профиля назван не настроенным, а не пустым', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=section-profiles');

  // Проверяется ответ 404 маршрута действующего профиля: он законный и обязан
  // читаться как состояние открытого мира, а не как сбой. Запрос идёт ПОСЛЕ
  // входа: `page.request` ходит с cookie вкладки, и до входа её просто нет —
  // 401 здесь означал бы неавторизованного клиента, а не отсутствие профиля.
  const response = await page.request.get(
    '/api/v1/catalog/section-kinds/roofing/effective-profile?at=2000-01-01',
  );
  expect(response.status()).toBe(404);
  await page.getByLabel('Дата, на которую нужен действующий профиль').fill('2000-01-01');

  await expect(page.getByTestId('profile-absent')).toBeVisible();
  await expect(page.getByTestId('profile-absent')).toContainText('раздел не настроен');
});

test('реестр РД объекта читается и различает отключённые шифры', async ({ page }) => {
  await signIn(page, KC.admin, '/catalog?tab=rd-documents');

  await expect(page.getByRole('cell', { name: 'АР-2.1-КР' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Кровля. Узлы примыканий' })).toBeVisible();
  await expect(page.getByText('действует')).toBeVisible();
});

test('подрядчик читает реестр РД своего объекта тем же маршрутом', async ({ page }) => {
  await signIn(page, KC.contractor, '/catalog?tab=rd-documents');

  // Объект виден подрядчику потому, что у него есть на нём поставки — это и
  // есть область видимости класса 1. Реестр РД читается по объекту, поэтому
  // отдельного правила ему не нужно, и отдельного пустого экрана — тоже.
  await expect(page.getByRole('cell', { name: 'АР-2.1-КР' })).toBeVisible();
});
