/**
 * Фаза 3 сегментации — декодер.
 *
 * Главный предмет проверки — non-degradable инвариант §1.6: каждая страница
 * ровно в одном документе либо в `unassigned`. Тест на него написан так,
 * чтобы ЛОВИТЬ поломку: он не только проверяет корректный сценарий, но и
 * требует, чтобы декодер БРОСАЛ на подсунутом нарушении.
 *
 * Второй предмет — открытый мир (§0.5): документ незнакомого вида получает
 * резервный тип, переносит наблюдённый заголовок в кандидаты и не сдвигает
 * границы соседних документов. Последнее проверяется сравнением двух
 * прогонов, а не глазами: иначе «границы те же» — это утверждение о коде,
 * а не о результате.
 *
 * Данные синтетические.
 */
import { describe, expect, it } from 'vitest';
import { BOUNDARY_CONFIDENCE_CEILING, CONFIDENT_BOUNDARY, decodeSegmentation } from './decoder.js';
import type { PageClassification, PageInput } from './types.js';

function page(id: string, text = ''): PageInput {
  return {
    sourcePageId: id,
    folderOrdinal: 1,
    sourceFileId: 'file-1',
    filePageIndex: 0,
    pageTextVersionId: `ptv-${id}`,
    text,
    blockTypes: ['text'],
    rotation: 0,
  };
}

const BASE: Omit<PageClassification, 'sourcePageId'> = {
  label: 'U',
  docTypeCode: null,
  typeOutcome: 'none',
  observedTitle: null,
  pageRoleCode: null,
  parentRef: null,
  confidence: 0,
  reason: '',
  source: 'anchor',
  alternatives: [],
  ambiguous: false,
  evidence: null,
};

function cls(id: string, patch: Partial<PageClassification> = {}): PageClassification {
  return { ...BASE, sourcePageId: id, ...patch };
}

/** Начало документа известного вида, опознанное якорем. */
function opensKnown(id: string, code: string, patch: Partial<PageClassification> = {}) {
  return cls(id, {
    label: 'B-DOC',
    docTypeCode: code,
    typeOutcome: 'known',
    confidence: 0.9,
    observedTitle: null,
    ...patch,
  });
}

describe('инвариант назначения страниц (§1.6)', () => {
  it('каждая страница входа встречается ровно один раз', () => {
    const pages = [page('p1', 'СЕРТИФИКАТ СООТВЕТСТВИЯ № A-1'), page('p2'), page('p3'), page('p4')];
    const result = decodeSegmentation(pages, [
      opensKnown('p1', 'cert_conformity'),
      cls('p2', { label: 'I-DOC', confidence: 0.7 }),
      cls('p3', { label: 'A-ROLE', pageRoleCode: 'blank', confidence: 0.75 }),
      cls('p4'),
    ]);

    const placed = [
      ...result.documents.flatMap((d) => d.pages.map((p) => p.sourcePageId)),
      ...result.unassigned.map((u) => u.sourcePageId),
    ];
    expect(placed.slice().sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('бросает, если страница попала бы в результат дважды', () => {
    // Подсовываем одну и ту же страницу дважды: без проверки в декодере она
    // оказалась бы в двух документах, а поймал бы это только уникальный
    // индекс БД — уже после записи половины строк.
    expect(() =>
      decodeSegmentation(
        [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p1', 'ПАСПОРТ КАЧЕСТВА № 8')],
        [opensKnown('p1', 'quality_passport'), opensKnown('p1', 'quality_passport')],
      ),
    ).toThrow(/более чем в одно место/u);
  });

  it('бросает, если классификации не соответствуют страницам', () => {
    expect(() => decodeSegmentation([page('p1')], [cls('p2')])).toThrow(/другой странице/u);
    expect(() => decodeSegmentation([page('p1'), page('p2')], [cls('p1')])).toThrow(
      /2 страниц и 1 классификаций/u,
    );
  });
});

describe('присоединение служебных страниц', () => {
  it('пустой лист вплотную к документу становится его листом', () => {
    // Пустой оборот листа с мелкой печатью стоит внутри документа, и его уход
    // в непривязанные разрывал набор страниц: нарезка режет ОДИН отрезок и на
    // разрывном наборе отказывала, лишая выдачи весь комплект.
    const result = decodeSegmentation(
      [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p2'), page('p3')],
      [
        opensKnown('p1', 'quality_passport'),
        cls('p2', { label: 'A-ROLE', pageRoleCode: 'blank' }),
        cls('p3', { label: 'I-DOC', confidence: 0.7 }),
      ],
    );
    expect(result.documents[0]?.pages.map((p) => p.sourcePageId)).toEqual(['p1', 'p2', 'p3']);
    expect(result.documents[0]?.pages[1]?.pageRoleCode).toBe('blank');
    expect(result.unassigned).toHaveLength(0);
  });

  it('пустая страница, оторванная от документа, остаётся ничьей', () => {
    // Между документами пустой лист — разделитель, и присоединять его не к
    // чему: предыдущая страница текущему документу уже не принадлежит.
    const result = decodeSegmentation(
      [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p2'), page('p3')],
      [
        opensKnown('p1', 'quality_passport'),
        cls('p2', { label: 'U' }),
        cls('p3', { label: 'A-ROLE', pageRoleCode: 'blank' }),
      ],
    );
    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned.map((u) => u.sourcePageId)).toEqual(['p2', 'p3']);
    expect(result.unassigned[1]?.reason).toContain('разделитель');
  });

  it('лист визуализации подписи вплотную к документу становится его листом', () => {
    // Под ролью остаётся лист, на котором нет ничего, кроме штампа: страницу с
    // заголовком забирает якорь вида либо отрицательный якорь роли, страницу с
    // продолжением таблицы — фаза 1. Такой лист принадлежит документу, за
    // которым идёт, и его уход в непривязанные разрывал набор страниц ровно
    // так же, как уход пустого оборота.
    const result = decodeSegmentation(
      [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p2')],
      [
        opensKnown('p1', 'quality_passport'),
        cls('p2', { label: 'A-ROLE', pageRoleCode: 'signature_visual' }),
      ],
    );
    expect(result.documents[0]?.pages.map((p) => p.sourcePageId)).toEqual(['p1', 'p2']);
    expect(result.documents[0]?.pages[1]?.pageRoleCode).toBe('signature_visual');
    expect(result.unassigned).toHaveLength(0);
  });

  it('лист визуализации подписи, оторванный от документа, остаётся ничьим', () => {
    // Соседство — единственное основание привязки. Лист через страницу от
    // документа мог подписывать что угодно, и «наверное, предыдущий» здесь
    // было бы тихой ошибкой: документ выглядел бы целым.
    const result = decodeSegmentation(
      [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p2'), page('p3')],
      [
        opensKnown('p1', 'quality_passport'),
        cls('p2', { label: 'U' }),
        cls('p3', { label: 'A-ROLE', pageRoleCode: 'signature_visual' }),
      ],
    );
    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned.map((u) => u.sourcePageId)).toEqual(['p2', 'p3']);
    expect(result.unassigned[1]?.reason).toContain('вне документа');
  });

  it('заверение копии присоединяется, только пока лист примыкает к документу', () => {
    // Автоприсоединяемая роль опирается на непрерывность: лист принадлежит
    // документу, за страницей которого он идёт. Оторванный лист — не
    // «наверное, его», а неизвестно чей.
    const pages = [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p2'), page('p3'), page('p4')];
    const result = decodeSegmentation(pages, [
      opensKnown('p1', 'quality_passport'),
      cls('p2', { label: 'A-ROLE', pageRoleCode: 'copy_stamp', confidence: 0.75 }),
      // Страница без сигнала разрывает примыкание…
      cls('p3'),
      // …и следующий штамп уже неизвестно чей.
      cls('p4', { label: 'A-ROLE', pageRoleCode: 'copy_stamp', confidence: 0.75 }),
    ]);
    expect(result.documents[0]?.pages.map((p) => p.sourcePageId)).toEqual(['p1', 'p2']);
    expect(result.unassigned.map((u) => u.sourcePageId)).toEqual(['p3', 'p4']);
  });

  it('служебная страница до первого документа уходит в unassigned', () => {
    const result = decodeSegmentation(
      [page('p1'), page('p2', 'ПАСПОРТ КАЧЕСТВА № 7')],
      [
        cls('p1', { label: 'A-ROLE', pageRoleCode: 'copy_stamp' }),
        opensKnown('p2', 'quality_passport'),
      ],
    );
    expect(result.unassigned[0]?.reason).toContain('до первого документа');
    expect(result.documents).toHaveLength(1);
  });
});

describe('приложение-продолжение', () => {
  const parent = page('p1', '##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1 от 01.02.2026');

  const annexTo = (id: string, parentRef: string | null) =>
    cls(id, {
      label: 'A-ROLE',
      pageRoleCode: 'annex_continuation',
      ...(parentRef === null ? {} : { parentRef }),
      confidence: 0.75,
    });

  it('присоединяется при совпадении номера родителя', () => {
    const result = decodeSegmentation(
      [parent, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'A-1')],
    );
    expect(result.documents[0]?.pages).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
  });

  it('ссылка из нескольких слов подтверждается своим номером (S50)', () => {
    // Ссылку приложение печатает строкой, и рядом с номером стоят слова
    // системы сертификации. Сверка строки ЦЕЛИКОМ требовала от родителя того
    // же порядка слов — и приложения к свидетельству о госрегистрации
    // оставались ничьими при родителе, лежащем страницей выше.
    const parentDoc = page(
      'p1',
      '##### СВИДЕТЕЛЬСТВО о государственной регистрации\n№ RU.77.01.34.008.E.006609.08.12',
    );
    const result = decodeSegmentation(
      [parentDoc, page('p2')],
      [
        opensKnown('p1', 'state_registration_certificate'),
        annexTo('p2', 'RU.77.01.34.008.E.006609.08.12'),
      ],
    );

    expect(result.documents[0]?.pages).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
  });

  it('короткие куски ссылки подтверждением не считаются', () => {
    // «РОСС» и «RU» стоят на каждой второй странице комплекта: приняв их за
    // подтверждение, портал присоединил бы приложение к чужому документу.
    const result = decodeSegmentation(
      [page('p1', '##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ РОСС RU.12345.ОС01.ПБ01.1111'), page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'РОСС RU.99999.ОС01.ПБ01.9999')],
    );

    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned[0]?.reason).toContain('не назван');
  });

  it('сверяет номер со ВСЕМИ номерами страниц документа, а не с первым', () => {
    // Прямая находка замера на корпусе: первым по тексту сертификата стоит
    // номер аттестата аккредитации органа по сертификации, а собственный
    // номер документа идёт ниже. Разбор «первый № после заголовка» отправлял
    // верные приложения в unassigned.
    const parentWithAccreditation = page(
      'p1',
      'ОРГАН ПО СЕРТИФИКАЦИИ, аттестат аккредитации № РОСС RU.11111.04ТЕСТ0\n' +
        '##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ РОСС RU.TEST.ОС54.H005481 срок действия до 2028',
    );
    const result = decodeSegmentation(
      [parentWithAccreditation, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'РОСС RU.TEST.ОС54.H005481')],
    );
    expect(result.documents[0]?.pages).toHaveLength(2);
  });

  it('нуль вместо буквы «О» в номере родителя привязку не рвёт', () => {
    // Боевой случай папки «ИД Мастер апрель 2026»: на приложении к сертификату
    // пожарной безопасности АРТАЛИКС напечатано «…0С01…» (нуль), на самом
    // сертификате — «…ОС01…» (буква). Пять приложений из шести оставались
    // ничьими, а строки реестра получали «нет в комплекте».
    const artalix = page(
      'p1',
      '##### СЕРТИФИКАТ СООТВЕТСТВИЯ ПОЖАРНОЙ БЕЗОПАСНОСТИ\n№ РОСС RU.32311.ОС01.ПБ01.0539',
    );
    const result = decodeSegmentation(
      [artalix, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'РОСС RU.32311.0С01.ПБ01.0539')],
    );

    expect(result.documents[0]?.pages).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
  });

  it('одна буква расхождения в длинном номере привязку не рвёт, но помечает лист', () => {
    // Боевой случай той же папки: на сертификате пожарной безопасности
    // напечатано «…ОС01.ПВ01.0539», на приложениях — «…ОС01.ПБ01.0539».
    // «Б» и «В» различимы, поэтому фолдинг гомоглифов такую пару не сводит
    // и не должен; четыре листа из-за этого оставались ничьими.
    const parentSheet = page(
      'p1',
      `##### СЕРТИФИКАТ СООТВЕТСТВИЯ ПОЖАРНОЙ БЕЗОПАСНОСТИ\n№ РОСС RU.32311.ОС01.ПВ01.0539`,
    );
    const result = decodeSegmentation(
      [parentSheet, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'РОСС RU.32311.ОС01.ПБ01.0539')],
    );

    expect(result.documents[0]?.pages).toHaveLength(2);
    // Допуск не выдаётся за точное совпадение: лист помечен своей причиной.
    const attached = result.documents[0]?.pages[1];
    expect(attached?.needsReview).toBe(true);
    expect(attached?.reviewReason).toContain('отличается на один знак');
  });

  it('расхождение в два знака привязку рвёт', () => {
    const parentSheet = page('p1', `СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ РОСС RU.32311.ОС01.ПВ01.0539`);
    const result = decodeSegmentation(
      [parentSheet, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'РОСС RU.32311.ОС01.ПБ01.0577')],
    );

    expect(result.documents[0]?.pages).toHaveLength(1);
  });

  it('допуск не действует на коротких номерах', () => {
    // «A-1» и «A-2» — разные документы, а не разное чтение одного.
    const result = decodeSegmentation(
      [parent, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'A-2')],
    );

    expect(result.documents[0]?.pages).toHaveLength(1);
  });

  it('приставка «Не» вместо «№» на приложении привязку не рвёт', () => {
    // Та же общая нормализация: «Не» — то, во что OCR превращает «№», и в
    // папке так прочитано 35 номеров из 138.
    const result = decodeSegmentation(
      [parent, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'НеA-1')],
    );

    expect(result.documents[0]?.pages).toHaveLength(2);
  });

  it('не присоединяется при чужом номере родителя', () => {
    const result = decodeSegmentation(
      [parent, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'B-9')],
    );
    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned[0]?.reason).toContain('B-9');
  });

  it('без номера родителя присоединяется вплотную — но с пометкой «проверьте»', () => {
    /**
     * На боевой папке это 17 из 27 непривязанных листов: приложение лежит сразу
     * за страницей своего документа, а номера родителя на нём не напечатано.
     * Отбрасывание тут дороже присоединения — непривязанная страница уменьшает
     * покрытие, а по покрытию правила полноты решают, вправе ли они вообще
     * говорить «документа нет в комплекте».
     */
    const result = decodeSegmentation(
      [parent, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', null)],
    );

    expect(result.documents[0]?.pages).toHaveLength(2);
    // Догадка не выдаётся за факт: лист помечен своей причиной.
    const attached = result.documents[0]?.pages[1];
    expect(attached?.needsReview).toBe(true);
    expect(attached?.reviewReason).toContain('номер родительского документа');
    expect(result.unassigned).toEqual([]);
  });

  it('без номера родителя и в отрыве от документа остаётся ничьим', () => {
    // Отрицательный контроль к предыдущему: соседство — единственное основание,
    // и без него присоединять не к чему.
    const result = decodeSegmentation(
      [parent, page('p2'), page('p3')],
      [opensKnown('p1', 'cert_conformity'), cls('p2'), annexTo('p3', null)],
    );

    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned.map((u) => u.sourcePageId)).toEqual(['p2', 'p3']);
    expect(result.unassigned[1]?.reason).toContain('без номера родительского документа');
  });

  it('при непрочитанном номере документа присоединяется только вплотную к нему', () => {
    // Правило целиком: сверять не с чем, поэтому единственным основанием
    // остаётся непрерывность — приложение идёт сразу за страницей документа.
    const noNumber = page('p1', 'СЕРТИФИКАТ СООТВЕТСТВИЯ');

    const adjacent = decodeSegmentation(
      [noNumber, page('p2')],
      [opensKnown('p1', 'cert_conformity'), annexTo('p2', 'A-1')],
    );
    expect(adjacent.documents[0]?.pages).toHaveLength(2);

    const detached = decodeSegmentation(
      [noNumber, page('p2'), page('p3')],
      [opensKnown('p1', 'cert_conformity'), cls('p2'), annexTo('p3', 'A-1')],
    );
    expect(detached.documents[0]?.pages).toHaveLength(1);
    expect(detached.unassigned.map((u) => u.sourcePageId)).toEqual(['p2', 'p3']);
  });
});

describe('страница без сигнала внутри документа', () => {
  it('без подтверждающего сигнала не присоединяется', () => {
    // Молчаливое присоединение «раз уж лист между страницами документа» —
    // тихая высокоуверенная ошибка границы, а §16 называет такую ошибку
    // более значимым критерием качества, чем сама F1.
    const result = decodeSegmentation(
      [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'), page('p2', 'какой-то текст')],
      [opensKnown('p1', 'quality_passport'), cls('p2')],
    );
    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned[0]?.reason).toContain('требует подтверждения');
  });

  it('продолжение таблицы без шапки — достаточный структурный сигнал', () => {
    const first = page(
      'p1',
      'Реестр приложений № 1 к акту\n| № | Документ | Номер |\n| --- | --- | --- |\n| 1 | Сертификат | A-1 |',
    );
    const second = page('p2', '| 2 | Паспорт | П-2 |\n| 3 | Протокол | Р-3 |');
    const result = decodeSegmentation(
      [first, second],
      [opensKnown('p1', 'annex_registry'), cls('p2')],
    );
    expect(result.documents[0]?.pages).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
  });

  it('лишняя пустая графа у безголового продолжения не рвёт документ (S50)', () => {
    // Ширину таблицы считает OCR, и на длинной описи он ошибается на одну
    // графу. На боевой папке ширина шла 8 → 9 → 8 → 7, четырёхлистовая опись
    // распадалась на два документа, а двести её строк не разбирались вовсе.
    const first = page(
      'p1',
      'Реестр передачи\n| № | Документ | Номер |\n| --- | --- | --- |\n| 1 | Сертификат | A-1 |',
    );
    const second = page('p2', '| | | | |\n| --- | --- | --- | --- |\n| 2 | Паспорт | П-2 | 1 |');
    const result = decodeSegmentation(
      [first, second],
      [opensKnown('p1', 'transfer_registry'), cls('p2')],
    );

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.pages).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
  });

  it('расхождение в две графы продолжением не считается', () => {
    // Допуск лечит след распознавания, а не описывает другую таблицу: две
    // графы разницы — это уже другой документ, и склеивать их нельзя.
    const first = page(
      'p1',
      'Реестр передачи\n| № | Документ | Номер |\n| --- | --- | --- |\n| 1 | Сертификат | A-1 |',
    );
    const second = page(
      'p2',
      '| | | | | |\n| --- | --- | --- | --- | --- |\n| 2 | П | 1 | 2 | 3 |',
    );
    const result = decodeSegmentation(
      [first, second],
      [opensKnown('p1', 'transfer_registry'), cls('p2')],
    );

    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned).toHaveLength(1);
  });

  it('таблица с ЗАПОЛНЕННОЙ шапкой другой ширины — новая таблица', () => {
    const first = page(
      'p1',
      'Реестр передачи\n| № | Документ | Номер |\n| --- | --- | --- |\n| 1 | Сертификат | A-1 |',
    );
    const second = page(
      'p2',
      '| № | Материал | Партия | Дата |\n| --- | --- | --- | --- |\n| 1 | Бетон | 12 | 01.02.2026 |',
    );
    const result = decodeSegmentation(
      [first, second],
      [opensKnown('p1', 'transfer_registry'), cls('p2')],
    );

    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned).toHaveLength(1);
  });

  it('пустая «шапка» перед разделителем — это продолжение, а не новая таблица', () => {
    // Форма из корпуса: продолжение реестра приложений (АОСР № 336, стр. 4)
    // начинается строкой из пустых ячеек и следом строкой-разделителем. Иначе
    // OCR и не может — markdown ТРЕБУЕТ разделителя после первой строки
    // таблицы. Первая редакция правила считала такую страницу новой
    // таблицей, и четырнадцать строк реестра из двадцати девяти оставались за
    // пределами документа. Найдено сквозным прогоном S8, а не чтением кода.
    const first = page(
      'p1',
      [
        'Реестр приложений № 1 к акту',
        '| № | Документ | Номер | Орг |',
        '|---|---|---|---|',
        '| 1 | Сертификат | A-1 | Р |',
      ].join('\n'),
    );
    const second = page(
      'p2',
      ['| | | | |', '|---|---|---|---|', '| 2 | Паспорт | П-2 | Р |'].join('\n'),
    );
    const result = decodeSegmentation(
      [first, second],
      [opensKnown('p1', 'annex_registry'), cls('p2')],
    );
    expect(result.documents[0]?.pages).toHaveLength(2);
    expect(result.unassigned).toHaveLength(0);
  });

  it('таблица с собственной шапкой продолжением не считается', () => {
    const first = page(
      'p1',
      'Реестр приложений № 1 к акту\n| № | Документ | Номер |\n| 1 | С | A-1 |',
    );
    const second = page('p2', '| № | Документ | Номер |\n| --- | --- | --- |\n| 1 | П | П-2 |');
    const result = decodeSegmentation(
      [first, second],
      [opensKnown('p1', 'annex_registry'), cls('p2')],
    );
    expect(result.documents[0]?.pages).toHaveLength(1);
    expect(result.unassigned).toHaveLength(1);
  });
});

describe('открытый мир (§0.5)', () => {
  const unknownPage = page('u1', 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ № ГИ-77');
  const unknownCls = cls('u1', {
    label: 'B-DOC',
    typeOutcome: 'other',
    observedTitle: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ',
    confidence: 0.92,
    source: 'llm',
  });

  it('незнакомый вид получает резервный тип и не требует ручной проверки', () => {
    const result = decodeSegmentation([unknownPage], [unknownCls]);
    const doc = result.documents[0];
    expect(doc?.docTypeCode).toBe('unknown_document');
    // Заголовок обязан дожить до документа: из него растёт `doc_type_candidates`.
    expect(doc?.observedTitle).toBe('АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ');
    // `other` — это не «не уверен» (§0.5): высокая уверенность допустима.
    expect(doc?.needsReview).toBe(false);
  });

  it('гипотеза о виде выбирает резерв своей группы, а не общий', () => {
    const result = decodeSegmentation(
      [unknownPage],
      [{ ...unknownCls, alternatives: ['quality_passport'] }],
    );
    expect(result.documents[0]?.docTypeCode).toBe('other_quality_docs');
  });

  it('«uncertain» — это гипотеза плюс ручная проверка', () => {
    const result = decodeSegmentation(
      [page('p1', 'схема')],
      [
        cls('p1', {
          label: 'B-DOC',
          docTypeCode: 'exec_scheme',
          typeOutcome: 'uncertain',
          confidence: 0.35,
          source: 'blocks',
        }),
      ],
    );
    expect(result.documents[0]?.docTypeCode).toBe('exec_scheme');
    expect(result.documents[0]?.needsReview).toBe(true);
    // Наблюдённый заголовок в кандидаты не уходит: вид предположен, а не нов.
    expect(result.documents[0]?.observedTitle).toBeNull();
  });

  it('документ незнакомого вида не сдвигает границы соседних', () => {
    const before = page('p1', '##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1');
    const beforeTail = page('p2');
    const after = page('p3', '##### ПАСПОРТ КАЧЕСТВА\n№ 7');
    const afterTail = page('p4');

    const withoutUnknown = decodeSegmentation(
      [before, beforeTail, after, afterTail],
      [
        opensKnown('p1', 'cert_conformity'),
        cls('p2', { label: 'I-DOC', confidence: 0.7 }),
        opensKnown('p3', 'quality_passport'),
        cls('p4', { label: 'I-DOC', confidence: 0.7 }),
      ],
    );
    const withUnknown = decodeSegmentation(
      [before, beforeTail, unknownPage, after, afterTail],
      [
        opensKnown('p1', 'cert_conformity'),
        cls('p2', { label: 'I-DOC', confidence: 0.7 }),
        unknownCls,
        opensKnown('p3', 'quality_passport'),
        cls('p4', { label: 'I-DOC', confidence: 0.7 }),
      ],
    );

    const boundaries = (s: ReturnType<typeof decodeSegmentation>) =>
      s.documents
        .filter((d) => d.docTypeCode !== 'unknown_document')
        .map((d) => [d.docTypeCode, d.pages.map((p) => p.sourcePageId)]);

    expect(boundaries(withUnknown)).toEqual(boundaries(withoutUnknown));
    expect(withUnknown.unassigned).toHaveLength(0);
  });
});

describe('уверенности считаются раздельно', () => {
  it('уверенный тип при слабой границе и уверенная граница при слабом типе', () => {
    const strongBoundaryWeakType = decodeSegmentation(
      [page('p1', 'ПАСПОРТ КАЧЕСТВА № 7')],
      [
        cls('p1', {
          label: 'B-DOC',
          docTypeCode: 'quality_passport',
          typeOutcome: 'uncertain',
          confidence: 0.5,
          ambiguous: true,
          alternatives: ['declaration'],
        }),
      ],
    ).documents[0];
    expect(strongBoundaryWeakType?.boundaryConfidence).toBe(0.9);
    expect(strongBoundaryWeakType?.typeConfidence).toBe(0.5);

    const weakBoundaryStrongType = decodeSegmentation(
      [page('u1', 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ № ГИ-77')],
      [
        cls('u1', {
          label: 'B-DOC',
          typeOutcome: 'other',
          observedTitle: 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ',
          confidence: 0.95,
          source: 'llm',
        }),
      ],
    ).documents[0];
    // Модель видит страницу и двух соседей, а не комплект: её уверенность в
    // виде документа выше, чем основание для границы.
    expect(weakBoundaryStrongType?.typeConfidence).toBe(0.95);
    expect(weakBoundaryStrongType?.boundaryConfidence).toBe(0.8);
  });
});

describe('заголовок документа', () => {
  it('берётся со строки, на которой сработал якорь', () => {
    const text = '##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1';
    const result = decodeSegmentation(
      [page('p1', text)],
      [
        opensKnown('p1', 'cert_conformity', {
          evidence: {
            pageTextVersionId: 'ptv-p1',
            charStart: 6,
            charEnd: 29,
            quote: 'СЕРТИФИКАТ СООТВЕТСТВИЯ',
          },
        }),
      ],
    );
    expect(result.documents[0]?.title).toBe('СЕРТИФИКАТ СООТВЕТСТВИЯ');
  });
});

// =====================================================================
// Критерий тихой высокоуверенной ошибки применим к ОБЕИМ фазам (§16)
// =====================================================================

/**
 * §16 называет тихую высокоуверенную ошибку границы критерием более значимым,
 * чем F1, и требует «ни одной» для перехода раздела в `automatic`. Критерий
 * измерим только если оба его условия достижимы одновременно: решение может
 * быть НЕ помечено и при этом заявлено уверенно.
 *
 * До починки это было невозможно для фазы 2: потолок модели 0.8, порог замера
 * 0.9 — то есть ни одна ошибка модели не засчитывалась тихой ни при какой её
 * уверенности, а критерий, к которому нельзя привести ни одного примера,
 * ничего не проверяет.
 */
describe('порог уверенной границы согласован с потолками источников', () => {
  it('фаза 2 способна выдать неотмеченную границу выше порога', () => {
    const document = decodeSegmentation(
      [page('p1', 'НЕКИЙ ДОКУМЕНТ')],
      [
        cls('p1', {
          label: 'B-DOC',
          docTypeCode: 'cert_conformity',
          typeOutcome: 'known',
          confidence: 1,
          source: 'llm',
        }),
      ],
    ).documents[0];

    // Оба условия сразу. По отдельности каждое выполнимо и при рассогласовании:
    // при пороге 0.9 модель либо помечалась бы всегда (фаза 2 не автоматизирует
    // ничего), либо оставалась бы непомеченной ниже порога (ошибка невидима).
    expect(document?.needsReview).toBe(false);
    expect(document?.boundaryConfidence).toBeGreaterThanOrEqual(CONFIDENT_BOUNDARY);
    expect(BOUNDARY_CONFIDENCE_CEILING.llm).toBeGreaterThanOrEqual(CONFIDENT_BOUNDARY);
  });

  it('источник ниже порога помечается всегда: третьего состояния нет', () => {
    // `blocks` порога не достигает по существу — состав блоков не говорит, где
    // документ начался. Значит его решение обязано звать человека, и тогда его
    // ошибка тихой не бывает. Проверяется на классификации, которую ничто
    // другое не помечает: тип известен, уверенность высокая, неоднозначности нет.
    const document = decodeSegmentation(
      [page('p1', 'СХЕМА')],
      [
        cls('p1', {
          label: 'B-DOC',
          docTypeCode: 'exec_scheme',
          typeOutcome: 'known',
          confidence: 1,
          source: 'blocks',
        }),
      ],
    ).documents[0];

    expect(BOUNDARY_CONFIDENCE_CEILING.blocks).toBeLessThan(CONFIDENT_BOUNDARY);
    expect(document?.needsReview).toBe(true);
  });

  it('каждый источник либо достигает порога, либо всегда зовёт человека', () => {
    for (const source of ['anchor', 'blocks', 'llm'] as const) {
      const document = decodeSegmentation(
        [page('p1', 'ДОКУМЕНТ')],
        [
          cls('p1', {
            label: 'B-DOC',
            docTypeCode: 'cert_conformity',
            typeOutcome: 'known',
            confidence: 1,
            source,
          }),
        ],
      ).documents[0];

      const confident = (document?.boundaryConfidence ?? 0) >= CONFIDENT_BOUNDARY;
      expect(confident || document?.needsReview === true, source).toBe(true);
    }
  });
});
