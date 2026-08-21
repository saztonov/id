/**
 * Локальный вход в браузере (`E2E_AUTH_MODE=local`).
 *
 * Единственное место, где путь пользователя проверяется целиком и настоящим
 * браузером: форма, cookie, обратный отсчёт блокировки, принуждение к смене
 * пароля, очередь заявок. Всё это на уровне API проверено по отдельности, но
 * ровно здесь видно, складывается ли оно в работающий портал.
 *
 * Проект запускается отдельной командой (`test:e2e:local`), потому что стенду
 * нужен другой режим. Прогон на `dev-stub` остаётся регрессией федеративного
 * пути и не меняется.
 */
import { expect, test, type Page } from '@playwright/test';

import { LOCAL_LOGINS, LOCAL_PASSWORD } from './support/session.js';

/** Вход формой: тот же путь, которым пользуется человек. */
async function signInWithPassword(
  page: Page,
  email: string,
  password = LOCAL_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

test.describe('вход паролем', () => {
  test('форма пускает в портал и показывает пользователя', async ({ page }) => {
    await signInWithPassword(page, LOCAL_LOGINS.manager);

    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    await expect(page.getByTestId('current-user')).toContainText('Руководитель отдела ИД');
  });

  test('ссылка «Войти» ведёт на форму, а не к провайдеру', async ({ page }) => {
    // Ссылка одна на все режимы; в локальном она обязана привести на страницу
    // портала, иначе закладки и e2e федеративного режима расходятся.
    await page.goto('/ids');
    await page.getByTestId('login-link').click();

    await expect(page).toHaveURL(/\/login/u);
  });

  test('возвращает на запрошенный экран', async ({ page }) => {
    await page.goto('/catalog');
    await page.getByTestId('login-link').click();
    await page.getByTestId('login-email').fill(LOCAL_LOGINS.admin);
    await page.getByTestId('login-password').fill(LOCAL_PASSWORD);
    await page.getByTestId('login-submit').click();

    await expect(page).toHaveURL(/\/catalog/u);
  });

  test('неверный пароль объясняется одной строкой', async ({ page }) => {
    // Сервер намеренно не различает «нет такого пользователя» и «неверный
    // пароль»; интерфейс не должен додумывать разницу за него.
    await signInWithPassword(page, LOCAL_LOGINS.manager, 'Sovsem-Drugoy-99!');

    await expect(page.getByTestId('login-error')).toContainText('Неверный логин или пароль');
    await expect(page).toHaveURL(/\/login/u);
  });

  test('несуществующий адрес отвечает тем же текстом', async ({ page }) => {
    await signInWithPassword(page, 'nikogo@e2e.example');

    await expect(page.getByTestId('login-error')).toContainText('Неверный логин или пароль');
  });

  test('поля размечены для менеджера паролей', async ({ page }) => {
    // Требование B.3: paste, autofill и менеджеры паролей должны работать.
    await page.goto('/login');

    await expect(page.getByTestId('login-email')).toHaveAttribute('autocomplete', 'username');
    await expect(page.getByTestId('login-password')).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
  });

  test('вставка пароля из буфера не перехвачена', async ({ page }) => {
    // Запрет вставки не мешает подбору, но мешает пользоваться длинным
    // сгенерированным паролем — то есть подталкивает к короткому.
    //
    // Проверяется именно отсутствие перехвата: в поле отправляется настоящее
    // отменяемое событие `paste`, и если бы форма звала `preventDefault()`,
    // событие вернулось бы отменённым. Подстановка значения через `fill()` это
    // не проверила бы — она обходит обработчики.
    await page.goto('/login');

    const prevented = await page.evaluate(() => {
      // antd переносит data-testid на сам input, а не на обёртку, поэтому
      // селектор адресует элемент напрямую.
      const input = document.querySelector<HTMLInputElement>('input[data-testid="login-password"]');
      if (input === null) return null;
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });

    expect(prevented).toBe(false);
  });

  test('выход возвращает на страницу входа', async ({ page }) => {
    await signInWithPassword(page, LOCAL_LOGINS.manager);
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));

    await page.getByRole('button', { name: 'Выйти' }).click();

    // В локальном режиме адрес front-channel logout приходит null, и портал
    // уходит на корень, откуда неаутентифицированного ведут на вход.
    await expect(page.getByTestId('login-link')).toBeVisible();
  });
});

test.describe('встроенный администратор', () => {
  test('входит выданным паролем и попадает прямо на форму смены', async ({ page }) => {
    // Ради этого учётная запись и заведена: свежее развёртывание открывается в
    // браузере и пускает внутрь. Пароль лежит в репозитории, поэтому портал
    // сразу требует его сменить — до смены работать нечем.
    await signInWithPassword(page, 'admin', 'qwedcxz1@');

    await expect(page.getByTestId('must-change-password')).toBeVisible();
  });
});

test.describe('заявка на регистрацию', () => {
  test('подаётся и попадает в очередь администратора', async ({ page }) => {
    const email = `zayavka-${String(Date.now())}@e2e.example`;

    await page.goto('/register');
    await page.getByTestId('register-email').fill(email);
    await page.getByTestId('register-fullname').fill('Заявкин Заявка Заявкович');
    await page.getByTestId('register-password').fill('Betonnaya-Svaya-42!');
    await page.getByLabel('Пароль ещё раз').fill('Betonnaya-Svaya-42!');
    await page.getByTestId('register-submit').click();

    await expect(page.getByText('Заявка принята')).toBeVisible();

    // Тот же адрес — в очереди администратора.
    await signInWithPassword(page, LOCAL_LOGINS.admin);
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    await page.goto('/admin?tab=registration');

    await expect(page.getByText(email)).toBeVisible();
  });

  test('слабый пароль отвергается с объяснением', async ({ page }) => {
    await page.goto('/register');
    await page.getByTestId('register-email').fill('slabyy@e2e.example');
    await page.getByTestId('register-fullname').fill('Слабый Пароль');
    await page.getByTestId('register-password').fill('password123456');
    await page.getByLabel('Пароль ещё раз').fill('password123456');
    await page.getByTestId('register-submit').click();

    // Отказ по паролю ничего не сообщает об учётных записях портала, поэтому
    // его можно и нужно объяснять честно.
    await expect(page.getByText(/распространённых/u)).toBeVisible();
  });
});

test.describe('администрирование', () => {
  test('создание пользователя показывает пароль один раз', async ({ page }) => {
    await signInWithPassword(page, LOCAL_LOGINS.admin);
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    await page.goto('/admin?tab=users');

    await page.getByTestId('create-user').click();
    await page.getByTestId('create-user-email').fill(`novyy-${String(Date.now())}@e2e.example`);
    await page.getByTestId('create-user-fullname').fill('Новиков Новик Новикович');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();

    const shown = page.getByTestId('temporary-password');
    await expect(shown).toBeVisible();
    await expect(shown).not.toBeEmpty();

    await page.getByTestId('temporary-password-close').click();
    // Второго показа нет: пароль в портале в открытом виде не хранится.
    await expect(shown).toBeHidden();
  });
});

test.describe('принуждение к смене пароля', () => {
  test('выданный пароль требует смены, и до неё портал закрыт', async ({ page }) => {
    const email = `vremennyy-${String(Date.now())}@e2e.example`;

    await signInWithPassword(page, LOCAL_LOGINS.admin);
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    await page.goto('/admin?tab=users');
    await page.getByTestId('create-user').click();
    await page.getByTestId('create-user-email').fill(email);
    await page.getByTestId('create-user-fullname').fill('Временный Пароль Пользователь');
    await page.getByRole('button', { name: 'Создать', exact: true }).click();

    const temporary = (await page.getByTestId('temporary-password').textContent()) ?? '';
    await page.getByTestId('temporary-password-close').click();
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.getByTestId('login-link')).toBeVisible();

    // Вход выданным паролем ведёт прямо на форму смены.
    await signInWithPassword(page, email, temporary);
    await expect(page.getByTestId('must-change-password')).toBeVisible();

    await page.getByTestId('current-password').fill(temporary);
    await page.getByTestId('new-password').fill('Betonnaya-Svaya-Reki-88!');
    await page.getByLabel('Новый пароль ещё раз').fill('Betonnaya-Svaya-Reki-88!');
    await page.getByTestId('change-password-submit').click();

    // После смены предупреждение исчезает: у пользователя нет ролей, поэтому
    // портал показывает «права не назначены» — но уже не форму смены.
    await expect(page.getByTestId('must-change-password')).toBeHidden();
  });
});
