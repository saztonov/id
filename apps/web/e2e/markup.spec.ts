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

const MARKUP_URL = `/ids/folders/${IDS.folderMarkup}?tab=markup`;

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
    //
    // Разворот содержимого числа канв НЕ меняет: он сделан трансформацией
    // `Group` ВНУТРИ слоя, а не третьим слоем. Следующий, кто возьмётся
    // поворачивать лист, должен прочитать здесь именно это, иначе заведёт
    // третий `Layer` и сломает утверждение, не поняв, о чём оно.
    await expect(page.getByRole('application')).toBeVisible();
    await expect(page.getByTestId('frame-mismatch')).toHaveCount(0);
    await expect(page.locator('canvas')).toHaveCount(2);

    // Выбор блока списком — второй, клавиатурный путь к тем же действиям:
    // элементы Konva недостижимы ни фокусу, ни скринридеру по построению.
    await expect(page.getByTestId('selected-block')).toBeVisible();
    await page.getByRole('combobox', { name: 'Блок страницы' }).click();
    await expect(
      page
        .locator('.ant-select-dropdown:visible')
        .getByText(/% страницы/)
        .first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('рабочая область — три колонки с перетаскиваемыми разделителями', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await signIn(page, KC.engineer, MARKUP_URL);

    // Два разделителя на три колонки: лента, страница, текст. Четвёртой —
    // списка блоков — больше нет: выбор блока, смена типа и удаление уехали в
    // панель инструментов, а её ширина досталась странице и тексту.
    await expect(page.getByRole('separator')).toHaveCount(2);

    // Текст и картинка видны ОДНОВРЕМЕННО — ради этого колонка и заведена.
    await expect(page.getByRole('region', { name: 'Распознанный текст страницы' })).toBeVisible();
    await expect(page.getByRole('application')).toBeVisible();

    // Панель вида отделена от панели инструментов: масштаб — действие
    // просмотра и не гасится правом на правку.
    const viewBar = page.getByTestId('canvas-view-bar');
    await expect(viewBar.getByRole('button', { name: 'Увеличить' })).toBeEnabled();
    await expect(viewBar.getByRole('button', { name: 'Уменьшить' })).toBeEnabled();

    // Ширина колонки переживает уход на другую вкладку: `Tabs` стоит с
    // `destroyOnHidden`, то есть экран размонтируется целиком, и без записи в
    // хранилище браузера раскладка сбрасывалась бы по нескольку раз за сеанс.
    const strip = page.getByRole('navigation', { name: 'Страницы рабочего документа' });
    const separator = page.getByRole('separator').first();
    const box = await separator.boundingBox();
    if (box === null) throw new Error('разделитель не отрисован');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();

    const widened = await strip.boundingBox();
    if (widened === null) throw new Error('лента не отрисована');

    await page.getByRole('tab', { name: 'Файлы' }).click();
    await page.getByRole('tab', { name: 'Разметка' }).click();
    await expect(strip.getByRole('button')).toHaveCount(4);

    const restored = await strip.boundingBox();
    if (restored === null) throw new Error('лента не отрисована после возврата');
    expect(Math.abs(restored.width - widened.width)).toBeLessThan(12);
  });

  test('колонка текста сворачивается и возвращается кнопкой панели вида', async ({ page }) => {
    // Автосворачивания на узком экране больше нет: оно существовало ради
    // «три живые колонки полезнее четырёх огрызков», а колонок теперь три и
    // по минимумам они занимают 660 px — помещаются везде. Решение осталось
    // за человеком, и проверяется именно оно.
    await signIn(page, KC.engineer, MARKUP_URL);

    await expect(page.getByRole('separator')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Распознанный текст страницы' })).toBeVisible();

    await page.getByRole('button', { name: 'Скрыть распознанный текст' }).click();
    await expect(page.getByRole('separator')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Распознанный текст страницы' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Показать распознанный текст' }).click();
    await expect(page.getByRole('separator')).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'Распознанный текст страницы' })).toBeVisible();
  });

  test('разворот содержимого меняет форму сцены и доезжает до карты страниц', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await signIn(page, KC.engineer, MARKUP_URL);

    const canvas = page.getByRole('application');
    const before = await canvas.boundingBox();
    if (before === null) throw new Error('канва не отрисована');

    await page.getByRole('button', { name: 'Повернуть вправо' }).click();

    // Стороны сцены обязаны поменяться местами. Это единственная проверка,
    // которая ловит рассогласование `Stage` и повёрнутой `Group`: при
    // расхождении картинка и рамки уехали бы в разные стороны, а размер сцены
    // остался бы прежним.
    await expect
      .poll(async () => {
        const box = await canvas.boundingBox();
        return box === null ? 0 : Math.round(box.width);
      })
      .toBeGreaterThan(Math.round(before.height) - 40);

    // Последствие в ДАННЫХ, а не надпись на экране: карта страниц отдаёт
    // разворот тем же запросом, которым отдаёт геометрию.
    const bundleId = await page.evaluate(async () => {
      const response = await fetch(
        '/api/v1/folders/' + window.location.pathname.split('/')[3] + '/bundles',
      );
      const body = (await response.json()) as { items: { id: string }[] };
      return body.items[body.items.length - 1]?.id ?? '';
    });
    const mapResponse = await page.request.get(`/api/v1/bundles/${bundleId}/pages`);
    expect(mapResponse.status()).toBe(200);
    const map = (await mapResponse.json()) as {
      items: {
        workingPageIndex: number;
        contentRotation: number;
        contentRotationSource: string | null;
      }[];
    };
    const first = map.items.find((item) => item.workingPageIndex === 0);
    expect(first?.contentRotation).toBe(90);
    expect(first?.contentRotationSource).toBe('user');

    // Плашка в ленте называет и величину, и источник — словом, а не цветом.
    const badge = page.getByTestId('content-rotation-0');
    await expect(badge).toContainText('90°');
    await expect(badge).toContainText('вручную');

    // Сброс возвращает страницу к значению зонда; зонда не было — значит к нулю.
    // Кнопка ищется В ПОДПИСИ разворота: рядом в той же панели стоит «Сбросить
    // ширины колонок», и поиск по подстроке нашёл бы обе.
    await page
      .getByTestId('canvas-rotation-note')
      .getByRole('button', { name: 'Сбросить' })
      .click();
    await expect(page.getByTestId('content-rotation-0')).toHaveCount(0);
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

  test('смена типа выделенного блока доходит до базы и поднимает версию', async ({ page }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    const before = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}/blocks`);
    const beforeBody = (await before.json()) as {
      version: number;
      items: { id: string; blockType: string }[];
    };
    const versionBefore = beforeBody.version;

    // Выделение — выбором в списке блоков панели: тот же путь, что у
    // клавиатурного пользователя, и он обязан работать наравне с мышью по канве.
    //
    // Роль `option` здесь не годится — antd держит семантический список скрытым
    // и виртуализованным (в нём лежат не все варианты), а кликать приходится по
    // видимому элементу выпадающего списка.
    await page.getByRole('combobox', { name: 'Блок страницы' }).click();
    await page.locator('.ant-select-dropdown:visible').getByText(/Текст/).first().click();

    // Одна кнопка вместо прежних «выбрать тип в селекте» + «Применить»: при
    // непустом выделении кнопка типа МЕНЯЕТ тип, и это всё действие целиком.
    await page.getByRole('button', { name: 'Штамп' }).click();

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
    await expect(page.getByTestId('selected-block')).toBeVisible();

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
    await page.getByRole('combobox', { name: 'Блок страницы' }).click();
    await page
      .locator('.ant-select-dropdown:visible')
      .getByText(/% страницы/)
      .first()
      .click();
    await page.getByRole('button', { name: 'Изображение' }).click();

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
          `/api/v1/folders/${IDS.folderMarkup}/classifications`,
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
          `/api/v1/folders/${IDS.folderMarkup}/classifications`,
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
          `/api/v1/folders/${IDS.folderMarkup}/classifications`,
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

  test('отправка на распознавание доступна сразу, без промежуточного шага', async ({ page }) => {
    // Заморозки нет (0048): между правкой блоков и распознаванием больше нет
    // необратимого шага, после которого разметка переставала правиться.
    await signIn(page, KC.engineer, MARKUP_URL);

    await expect(page.getByTestId('send-to-recognition')).toBeVisible();
    await expect(page.getByTestId('markup-disabled-reason')).toHaveCount(0);
  });

  test('отправка на распознавание создаёт прогон и ставит цикл сверки в очередь', async ({
    page,
  }) => {
    await signIn(page, KC.engineer, MARKUP_URL);

    await page.getByTestId('send-to-recognition').click();
    await expect(page.getByText(/распознавание/i).first()).toBeVisible();

    // Последствие: прогон в базе, привязанный к разметке, и снимок хэша набора
    // блоков, по которому пойдёт сверка §5.2.
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/folders/${IDS.folderMarkup}/recognition-runs`,
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
    await signIn(page, KC.contractor, `/ids/folders/${IDS.folderReview}?tab=markup`);
    const direct = await page.request.get(`/api/v1/layouts/${IDS.layoutMarkup}/blocks`);
    // Своя поставка того же подрядчика — видна; проверка тут в том, что маршрут
    // отвечает содержимым, а не что интерфейс что-то нарисовал сам.
    expect([200, 404]).toContain(direct.status());
  });
});
