/**
 * Администрирование: набор правил, промты, настройки (§3.7, §10, §14).
 *
 * Проверяется не наличие кнопок, а последствие нажатия в базе: опубликованная
 * версия набора появляется в `/admin/rulesets`, переключение действующей меняет
 * указатель, откат промта возвращает прежнюю версию в `published`. Экран,
 * который «показал уведомление», но ничего не изменил, — это ровно тот отказ,
 * который проект ловит с S3.
 *
 * Файл идёт `serial`: состояние накапливается — сначала публикуется версия,
 * потом действующей делается прежняя.
 */
import { expect, test, type Page } from '@playwright/test';
import { KC, signIn } from './support/session.js';

test.describe.configure({ mode: 'serial' });

test('реестр правил читается: снимок набора собирается из него, а не из воздуха', async ({
  page,
}) => {
  await signIn(page, KC.admin, '/admin?tab=rules');

  await expect(page.getByText('Реестр правил', { exact: true })).toBeVisible();
  await expect(page.getByTestId('active-ruleset')).toHaveText('2026.08.1');
  // Правило из реестра видно вместе с тем, кто вправе его списать: без этого
  // «снять с обоснованием» на экране проверки выглядит доступным всем.
  await expect(page.getByRole('cell', { name: 'AOSR.HDR.022' }).first()).toBeVisible();
});

test('снимок опубликованной версии виден целиком, а не числом правил', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=rules');

  // Раскрытие строки версии — тот же путь, что у замечаний: подпись русская,
  // потому что портал собран с локалью ru-RU.
  await page.getByRole('button', { name: 'Развернуть строку' }).first().click();
  await expect(page.getByText('Снимок пуст')).toBeVisible();
});

test('публикация версии набора доходит до базы и делает её действующей', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=rules');

  await page.getByTestId('publish-ruleset').click();
  await page.getByTestId('ruleset-version').fill('2026.08.2');
  // Кнопка ищется ВНУТРИ диалога: снаружи стоит «Опубликовать новую версию», и
  // поиск по подстроке нашёл бы обе — ту, что открывает окно, и ту, что
  // подтверждает. Именно этим отличается «нажали не туда» от «кнопка не нашлась».
  await page
    .getByRole('dialog', { name: 'Публикация версии набора правил' })
    .getByRole('button', { name: 'Опубликовать', exact: true })
    .click();

  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/admin/rulesets?limit=100');
      const body = (await response.json()) as {
        items: { version: string; isActive: boolean; ruleCount: number }[];
      };
      const published = body.items.find((item) => item.version === '2026.08.2');
      return published === undefined
        ? null
        : { active: published.isActive, rules: published.ruleCount > 0 };
    })
    .toEqual({ active: true, rules: true });

  await expect(page.getByTestId('active-ruleset')).toHaveText('2026.08.2');
});

test('откат набора — переключение действующей версии, а не правка снимка', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=rules');

  await page.getByTestId('activate-ruleset-2026.08.1').click();
  // Подтверждение Popconfirm: кнопка окна, а не строки таблицы.
  await page
    .locator('.ant-popconfirm')
    .getByRole('button', { name: 'Сделать действующей' })
    .click();

  await expect(page.getByTestId('active-ruleset')).toHaveText('2026.08.1');

  // Снимок прежней версии не тронут: откат обязан оставить историю на месте.
  const response = await page.request.get('/api/v1/admin/rulesets?limit=100');
  const body = (await response.json()) as { items: { version: string; ruleCount: number }[] };
  const previous = body.items.find((item) => item.version === '2026.08.2');
  expect(previous?.ruleCount).toBeGreaterThan(0);
});

test('промты показаны версиями с состояниями, а не одним текстом', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=prompts');

  await expect(page.getByRole('cell', { name: 'page_classify_base' }).first()).toBeVisible();
  await expect(page.getByText('В эксплуатации')).toBeVisible();
  await expect(page.getByText('В архиве')).toBeVisible();
});

test('откат промта возвращает прежнюю версию в эксплуатацию', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=prompts');

  await page.getByTestId('prompt-rollback-page_classify_base-1').click();

  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/admin/prompts?limit=100');
      const body = (await response.json()) as { items: { version: number; state: string }[] };
      return Object.fromEntries(body.items.map((item) => [String(item.version), item.state]));
    })
    // Откат публикует первую версию и снимает вторую: у промта в эксплуатации
    // может быть только одна версия, и это свойство держит триггер 0008.
    .toEqual({ '1': 'published', '2': 'archived' });
});

test('публикация промта, называющего раздел работ, отклоняется с перечислением слов', async ({
  page,
}) => {
  await signIn(page, KC.admin, '/admin?tab=prompts');

  await page.getByTestId('new-prompt').click();
  await page.getByTestId('prompt-code').fill('roofing_probe');
  await page
    .getByTestId('prompt-system')
    .fill('Ты работаешь с разделом «кровля» и знаешь его состав.');
  await page.getByTestId('prompt-user').fill('Текст страницы: {{text}}');
  await page.getByRole('button', { name: 'Создать черновик' }).click();

  // Черновик создаётся: §0.5 п. 6 проверяется публикацией, а не сохранением —
  // иначе итеративная правка текста была бы невозможна.
  await expect(page.getByTestId('prompt-promote-roofing_probe-1')).toBeVisible();

  await page.getByTestId('prompt-promote-roofing_probe-1').click();
  await page.getByTestId('prompt-publish-roofing_probe-1').click();

  const refusal = page.getByTestId('prompt-refusal');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('кровл');

  // Отказ не оставил промт опубликованным: состояние в базе прежнее.
  const response = await page.request.get('/api/v1/admin/prompts?code=roofing_probe&limit=100');
  const body = (await response.json()) as { items: { state: string }[] };
  expect(body.items.map((item) => item.state)).toEqual(['test']);
});

test('«Связь проверена» показывает значение сервера, а не печатает своё', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=settings');

  const response = await page.request.get('/api/v1/admin/settings');
  const body = (await response.json()) as { integrations: { name: string; verified: boolean }[] };
  // Сервер сегодня отвечает литеральным `false` по всем интеграциям: живой
  // пробы подключения нет. Тест сверяет ЭКРАН С ОТВЕТОМ, а не с ожидаемой
  // строкой, — иначе он проверял бы, что текст не изменился, а не что значение
  // читается.
  expect(body.integrations.every((item) => item.verified === false)).toBe(true);

  await expect(page.getByText('нет: живой пробы подключения не выполнялось').first()).toBeVisible();
  await expect(page.getByText('сервер не прислал признак')).toHaveCount(0);
});

/** Значение и источник одного настроечного ключа из GET /admin/settings. */
async function settingOf(
  page: Page,
  key: string,
): Promise<{ value: unknown; isDefault: boolean } | null> {
  const response = await page.request.get('/api/v1/admin/settings');
  const body = (await response.json()) as {
    settings: { key: string; value: unknown; isDefault: boolean }[];
  };
  const found = body.settings.find((item) => item.key === key);
  return found === undefined ? null : { value: found.value, isDefault: found.isDefault };
}

test('переключение провайдера распознавания доходит до настроек и предупреждает о шлюзе', async ({
  page,
}) => {
  await signIn(page, KC.admin, '/admin?tab=settings');

  // До переключения ключ отвечает значением реестра: строки в app_settings нет.
  expect(await settingOf(page, 'recognition.provider')).toEqual({
    value: 'rdweb',
    isDefault: true,
  });

  await page.getByTestId('recognition-provider-select').click();
  await page.locator('.ant-select-dropdown:visible').getByTitle('VLM через OpenRouter').click();

  // Последствие в базе, а не надпись: значение записано и перестало быть
  // умолчанием. Настройка действует только на новые прогоны, поэтому больше
  // ничего от переключения не ждётся.
  await expect
    .poll(async () => {
      const setting = await settingOf(page, 'recognition.provider');
      return setting === null ? 'нет' : `${String(setting.value)}:${String(setting.isDefault)}`;
    })
    .toBe('openrouter_vlm:false');

  // Стенд поднят без PROXY_LLM_* (LLM_PROVIDER=none): предупреждение о шлюзе
  // обязано быть видно, пока канал OpenRouter не через что вести.
  await expect(page.getByTestId('proxy-llm-warning')).toBeVisible();
});

test('невалидный слаг модели ловится у поля и не пишется; валидный сохраняется', async ({
  page,
}) => {
  await signIn(page, KC.admin, '/admin?tab=settings');

  // Поле модели видно: провайдер openrouter_vlm выбран предыдущим тестом.
  const input = page.getByTestId('recognition-model-input');
  await expect(input).toBeVisible();

  await input.fill('слаг без вендора');
  await page.getByTestId('recognition-model-save').click();

  // Ошибка стоит У ПОЛЯ — тем же текстом, что ответил бы сервер, — и записи
  // не было: ключ по-прежнему отвечает умолчанием.
  await expect(page.getByTestId('setting-error-recognition.vlm_model')).toContainText(
    'vendor/model',
  );
  expect(await settingOf(page, 'recognition.vlm_model')).toEqual({ value: '', isDefault: true });

  await input.fill('qwen/qwen3-vl-235b');
  await page.getByTestId('recognition-model-save').click();

  await expect
    .poll(async () => {
      const setting = await settingOf(page, 'recognition.vlm_model');
      return setting === null ? 'нет' : `${String(setting.value)}:${String(setting.isDefault)}`;
    })
    .toBe('qwen/qwen3-vl-235b:false');
  // Ошибка поля снята: сохранённое значение прошло и клиентское зеркало, и сервер.
  await expect(page.getByTestId('setting-error-recognition.vlm_model')).toHaveCount(0);
});

// =====================================================================
// Журнал ошибок (§11)
// =====================================================================

/** Проблема из фикстуры: открытая, 42 события и один пример. */
const JOURNAL_ISSUE_TITLE = 'Error: пул соединений исчерпан';

test('журнал показывает проблему и различает события и примеры', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=journal');

  const panel = page.getByRole('tabpanel', { name: 'Журнал и качество' });

  // Три величины подписаны по отдельности. Именно это проверяется первым:
  // одна общая цифра «ошибок за сутки» была бы правдоподобной и неверной.
  // Запас по времени — на холодный старт стенда: первый запрос к API поднимает
  // соединение и прогревает пул, и 10 секунд по умолчанию на него не хватает.
  await expect(panel).toContainText('Событий', { timeout: 30_000 });
  await expect(panel).toContainText('Примеров сохранено');

  await expect(page.getByRole('cell', { name: JOURNAL_ISSUE_TITLE })).toBeVisible();
  // 42 события против одного примера: числа в фикстуре расходятся намеренно.
  await expect(page.getByRole('cell', { name: '42', exact: true })).toBeVisible();
});

test('взятие в работу меняет статус проблемы в базе', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=journal');

  await page
    .getByRole('row', { name: new RegExp(JOURNAL_ISSUE_TITLE) })
    .getByRole('button')
    .click();
  await page.getByRole('button', { name: 'Взять в работу' }).click();

  // Проверяется последствие в БД, а не текст на экране: экран мог бы показать
  // успех и при неудачной записи.
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/admin/errors?status=ack');
      const body = (await response.json()) as { items: { title: string }[] };
      return body.items.map((item) => item.title);
    })
    .toContain(JOURNAL_ISSUE_TITLE);
});

test('закрытая проблема показывает, чем её чинили в прошлый раз', async ({ page }) => {
  await signIn(page, KC.admin, '/admin?tab=journal');

  // `Segmented` в antd — группа radio, но сам input скрыт стилями: кликать
  // нужно по видимой подписи внутри группы, иначе Playwright бесконечно ждёт
  // видимости элемента, которым управляют через label.
  await page
    .getByRole('radiogroup', { name: 'Фильтр по статусу' })
    .getByText('Закрытые', { exact: true })
    .click();
  const row = page.getByRole('row', { name: /LlmTimeoutError/ });
  await expect(row).toBeVisible();
  await row.getByRole('button').click();

  await expect(page.getByText('Чем чинили в прошлый раз')).toBeVisible();
  await expect(page.getByText('поднят PROXY_LLM_TIMEOUT_MS')).toBeVisible();
});

test('отчёт браузера об ошибке доезжает до журнала без сессии', async ({ page }) => {
  // Запрос уходит ИЗ страницы, а не из тестового контекста: только так
  // проверяется, что маршрут проходит `sameOriginGuard` с настоящими
  // заголовками браузера и не требует CSRF-токена.
  await page.goto('/login');

  const eventId = '00000000-0000-4000-8000-00000000beef';
  const status = await page.evaluate(async (id) => {
    const response = await fetch('/api/v1/client-errors', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'ChunkLoadError',
        message: 'Loading chunk failed',
        kind: 'render',
        clientEventId: id,
        repeatCount: 1,
      }),
    });
    return response.status;
  }, eventId);

  expect(status, 'отчёт с экрана входа отвергнут: именно его поломка самая опасная').toBe(204);

  await signIn(page, KC.admin, '/admin?tab=journal');

  // Проверяется последствие в БД: запись обязана появиться с источником `web`.
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/v1/admin/errors?source=web');
        const body = (await response.json()) as { items: { title: string }[] };
        return body.items.map((item) => item.title);
      },
      // Писатель сбрасывает накопитель раз в две секунды: запись появляется не
      // мгновенно, и ожидание здесь — часть проверки, а не борьба с флаки.
      { timeout: 20_000 },
    )
    .toContain('ChunkLoadError: Loading chunk failed');
});
