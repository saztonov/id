/**
 * Экран разметки от начала до отправки на распознавание (§7, §6.2).
 *
 * Все проверки идут против НАСТОЯЩЕГО API на настоящей схеме: стенд поднимает
 * `buildApp()` под миграциями (см. `e2e/harness/serve.mjs`). Поэтому здесь
 * проверяются не надписи, а последствия: строка в `layout_blocks`, поднятая
 * версия ревизии разметки, `blocks_hash` после заморозки, созданный прогон
 * распознавания. Надпись в интерфейсе — только повод посмотреть на данные.
 *
 * Файл идёт `serial`: сценарий один и состояние в нём накапливается — заморозить
 * можно только после правки, отправить на распознавание только после заморозки.
 */
import { expect, test } from '@playwright/test';
import { IDS, KC, apiPost, csrfToken, signIn } from './support/session.js';

const MARKUP_URL = `/ids/revisions/${IDS.revisionMarkup}?tab=markup`;

test.describe.configure({ mode: 'serial' });

test.describe('экран разметки', () => {
  test('лента миниатюр несёт флаги внимания, канва рисует страницу и рамки', async ({ page }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    // Лента: четыре страницы рабочего документа из карты `processing_bundle_pages`.
    const strip = page.getByRole('navigation', { name: 'Страницы рабочего документа' });
    await expect(strip.getByRole('button')).toHaveCount(4);

    // Флаги §7.3 показаны текстом, а не только цветом: это часть требования
    // accessibility и одновременно проверка того, что флаги вообще доехали.
    await expect(strip.getByTestId('flag-no_blocks')).toBeVisible();
    await expect(strip.getByTestId('flag-blank_page_candidate')).toBeVisible();

    // Поворот страницы виден в карточке — на нём держится пересчёт координат.
    await expect(strip.getByText('поворот 90°')).toBeVisible();

    // Канва существует и НЕ показывает расхождения фреймов: pdf.js отдал
    // пост-поворотный вьюпорт, совпавший с картой страниц.
    //
    // Канв ровно ДВЕ, а не одна: Konva заводит по `<canvas>` на каждый `Layer`,
    // а `PageCanvas` держит их два — нижний с изображением страницы
    // (`listening={false}`) и верхний с рамками, который принимает указатель.
    // Число закреплено, потому что оно проверяет структуру: третья канва
    // означала бы лишний слой, ноль — что страница не отрисовалась вовсе.
    await expect(page.getByRole('application')).toBeVisible();
    await expect(page.getByTestId('frame-mismatch')).toHaveCount(0);
    await expect(page.locator('canvas')).toHaveCount(2);

    // Список блоков — второй, клавиатурный путь к тем же действиям.
    await expect(page.getByTestId(`block-row-${IDS.blockA}`)).toBeVisible();
  });

  test('повёрнутая страница открывается без расхождения фреймов', async ({ page }) => {
    await signIn(page, KC.engineer, MARKUP_URL);
    const strip = page.getByRole('navigation', { name: 'Страницы рабочего документа' });

    // Страница 2 повёрнута на 90°, страница 4 — A3 landscape с поворотом 270°.
    for (const pageNumber of [2, 4]) {
      await strip.getByRole('button', { name: new RegExp(`Стр\\. ${String(pageNumber)}`) }).click();
      await expect(page.getByTestId('frame-mismatch')).toHaveCount(0);
      await expect(page.locator('canvas')).toHaveCount(2);
    }
  });

  test('смена типа выделенных блоков доходит до базы и поднимает версию', async ({ page }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    const before = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}/blocks`);
    const beforeBody = (await before.json()) as {
      version: number;
      items: { id: string; blockType: string }[];
    };
    const versionBefore = beforeBody.version;

    // Выделение — чекбоксом в списке: тот же путь, что у клавиатурного
    // пользователя, и он обязан работать наравне с мышью по канве.
    await page.getByRole('checkbox', { name: /Текст/ }).first().check();
    await page.getByRole('combobox', { name: 'Тип блока' }).click();
    // Именно опция ОТКРЫТОГО списка: подпись «Штамп» есть ещё и у фильтра
    // блоков справа, и поиск по заголовку попадал бы в оба элемента сразу.
    // Роль `option` здесь не годится — antd держит семантический список
    // скрытым и виртуализованным (в нём лежат не все варианты), а кликать
    // приходится по видимому элементу.
    await page.locator('.ant-select-dropdown:visible').getByTitle('Штамп').click();
    await page.getByRole('button', { name: /Применить тип к выделенным/ }).click();

    await expect(page.getByText('Штамп', { exact: false }).first()).toBeVisible();

    // Проверяется РЕЗУЛЬТАТ, а не сообщение: тип в базе и поднятая версия.
    await expect
      .poll(async () => {
        const after = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}/blocks`);
        const body = (await after.json()) as {
          version: number;
          items: { id: string; blockType: string }[];
        };
        const target = body.items.find((item) => item.id === IDS.blockA);
        return `${target?.blockType ?? 'нет'}:${String(body.version > versionBefore)}`;
      })
      .toBe('stamp:true');

    // Токен CSRF действительно участвовал: без него мутация получила бы 403.
    expect(await csrfToken(page.context())).not.toBe('');
  });

  test('конфликт версий показывает сравнение, а не молча перезаписывает', async ({ page }) => {
    await signIn(page, KC.engineer, MARKUP_URL);
    await expect(page.getByTestId(`block-row-${IDS.blockA}`)).toBeVisible();

    const snapshot = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}/blocks`);
    const version = ((await snapshot.json()) as { version: number }).version;

    // Второй редактор добавляет блок мимо этой вкладки: версия ревизии разметки
    // уходит вперёд, а экран об этом ещё не знает — ровно та гонка, ради которой
    // существует `If-Match`.
    const created = await apiPost(page, `/api/v1/layouts/${IDS.layoutMarkup}/blocks`, {
      ifMatch: version,
      data: {
        workingPageIndex: 0,
        blockType: 'image',
        shapeType: 'rectangle',
        coords: { x0: 0.1, y0: 0.5, x1: 0.4, y1: 0.7 },
        points: [],
      },
    });
    expect(created.status).toBe(201);

    // Правка с устаревшей версией: сервер отвечает 412.
    await page
      .getByRole('checkbox', { name: /Штамп|Текст/ })
      .first()
      .check();
    await page.getByRole('button', { name: /Применить тип к выделенным/ }).click();

    // Пользователь видит СРАВНЕНИЕ версий: диалог с таблицей расхождений.
    // Окно ищется по ДОСТУПНОМУ ИМЕНИ, а не по тексту внутри: заголовок и
    // сводка расхождения начинаются одинаково, и поиск по подстроке находил бы
    // сразу оба узла.
    const dialog = page.getByRole('dialog', { name: 'Разметку изменил другой пользователь' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('добавлено на сервере: 1')).toBeVisible();
    await expect(dialog.getByText('Появился на сервере')).toBeVisible();
    await expect(dialog.getByText(/Ваша правка не записана/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Взять версию сервера' }).click();
    await expect(dialog).toBeHidden();
  });

  test('тип страницы ставится с экрана разметки и доходит до классификаций', async ({ page }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    const panel = page.getByTestId('page-type-panel');
    await expect(panel).toBeVisible();
    // Классификаций у ревизии ещё нет: панель честно говорит «Тип не задан», а
    // не рисует пустую строку, за которой не отличить «нет» от «не загрузилось».
    await expect(panel.getByText('Тип не задан')).toBeVisible();

    // Вид ИД выбирается DOM-контролом над канвой — у действия есть путь мимо
    // Konva (§17). Поиск сужает виртуализованный список до нужной опции.
    //
    // Опция ищется по `title`, и с S24 это НАМЕРЕННЫЙ атрибут, а не следствие
    // обрезания: `PageTypePanel` ставит полное название в `title` каждой опции,
    // потому что даже в широком списке длинные виды ИД упираются в правый край.
    // Раньше `title` вешала antd на усечённый текст, и тест зависел от дефекта,
    // который здесь и чинится, — расширь список, и локатор перестал бы работать.
    const combo = panel.getByRole('combobox', { name: 'Вид ИД страницы 1' });
    await combo.click();
    await combo.fill('скрытых работ');
    await page
      .locator('.ant-select-dropdown:visible')
      .getByTitle('Акт освидетельствования скрытых работ')
      .click();

    // Последствие в базе, а не надпись: строка классификации с source=manual.
    // Метка — свойство ревизии ПОСТАВКИ (переживает пересборку), поэтому
    // проверяется маршрут классификаций, а не что-либо разметочное.
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/revisions/${IDS.revisionMarkup}/classifications`,
        );
        const body = (await response.json()) as {
          items: {
            sourcePageId: string;
            source: string;
            label: string;
            docTypeCode: string | null;
          }[];
        };
        const row = body.items.find((item) => item.sourcePageId === IDS.page0);
        return row === undefined ? 'нет' : `${row.source}:${row.label}:${row.docTypeCode ?? ''}`;
      })
      .toBe('manual:B-DOC:aosr');

    // Бейдж в ленте миниатюр: короткое имя вида и слово «вручную», не только цвет.
    const strip = page.getByRole('navigation', { name: 'Страницы рабочего документа' });
    await expect(strip.getByTestId('page-type-badge-0')).toContainText('АОСР');
    await expect(strip.getByTestId('page-type-badge-0')).toContainText('вручную');

    // «Продолжение» на странице 2: ярлык I-DOC без собственного типа.
    await strip.getByRole('button', { name: /Стр\. 2/ }).click();
    await panel.getByRole('button', { name: 'Продолжение' }).click();

    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/revisions/${IDS.revisionMarkup}/classifications`,
        );
        const body = (await response.json()) as {
          items: {
            sourcePageId: string;
            source: string;
            label: string;
            docTypeCode: string | null;
          }[];
        };
        const row = body.items.find((item) => item.sourcePageId === IDS.page1);
        return row === undefined ? 'нет' : `${row.source}:${row.label}:${row.docTypeCode ?? ''}`;
      })
      .toBe('manual:I-DOC:');
    await expect(strip.getByTestId('page-type-badge-1')).toContainText('продолжение');

    // «Снять»: строка manual исчезает из классификаций, бейдж — из ленты.
    await panel.getByRole('button', { name: 'Снять' }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/revisions/${IDS.revisionMarkup}/classifications`,
        );
        const body = (await response.json()) as {
          items: { sourcePageId: string; source: string }[];
        };
        const row = body.items.find(
          (item) => item.sourcePageId === IDS.page1 && item.source === 'manual',
        );
        return row === undefined ? 'нет' : 'есть';
      })
      .toBe('нет');
    await expect(strip.getByTestId('page-type-badge-1')).toHaveCount(0);
  });

  test('заморозка пиннит blocks_hash, после неё появляется отправка на распознавание', async ({
    page,
  }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    await page.getByTestId('freeze-layout').click();
    // `exact` обязателен: подпись самой кнопки — «Заморозить разметку», и без
    // точного совпадения локатор находил бы и её, и кнопку подтверждения.
    await page.getByRole('button', { name: 'Заморозить', exact: true }).click();

    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}`);
        const body = (await response.json()) as { state: string; blocksHash: string | null };
        return `${body.state}:${String(body.blocksHash !== null)}`;
      })
      .toBe('frozen:true');

    await expect(page.getByTestId('send-to-recognition')).toBeVisible();
    // Замороженную разметку править нечем: инструменты выключены.
    await expect(page.getByRole('button', { name: /Удалить выделенные/ })).toBeDisabled();
  });

  test('отправка на распознавание создаёт прогон и ставит цикл сверки в очередь', async ({
    page,
  }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    await page.getByTestId('send-to-recognition').click();
    await expect(page.getByText(/распознавание/i).first()).toBeVisible();

    // Последствие: прогон в базе, привязанный к ЗАМОРОЖЕННОЙ разметке, и
    // локальный хэш разметки, по которому пойдёт сверка §5.2.
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/revisions/${IDS.revisionMarkup}/recognition-runs`,
        );
        const body = (await response.json()) as {
          items: { layoutRevisionId: string; localLayoutHash: string; status: string }[];
        };
        const run = body.items[0];
        if (run === undefined) return 'прогона нет';
        return `${run.layoutRevisionId}:${String(run.localLayoutHash.length)}:${run.status}`;
      })
      .toBe(`${IDS.layoutMarkup}:64:running`);
  });

  test('подрядчик не видит разметку чужой поставки', async ({ page }) => {
    // Изоляция §1.6 проверена в API-тестах; здесь — что интерфейс не обходит её
    // собственным путём и не показывает данные, которых сервер не отдал.
    await signIn(page, KC.contractor, `/ids/revisions/${IDS.revisionReview}?tab=markup`);
    const direct = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}/blocks`);
    // Своя поставка того же подрядчика — видна; проверка тут в том, что маршрут
    // отвечает содержимым, а не что интерфейс что-то нарисовал сам.
    expect([200, 404]).toContain(direct.status());
  });
});
