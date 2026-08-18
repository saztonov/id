/**
 * Фаза 1 сегментации.
 *
 * Тесты написаны от требований §8.2 и от четырёх классов документов, которые
 * замер S1 объявил неразрешимыми текстом (`docs/CORPUS_FINDINGS.md`). Данные
 * синтетические: реквизиты, номера и наименования выдуманы, реальные значения
 * корпуса в репозиторий не переносятся (§1.4, `pnpm pii:scan`).
 *
 * Отдельная забота — ЦЕНА склейки разорванного заголовка. Положительный тест
 * без отрицательного здесь бесполезен: склейку легко сделать всеядной, и она
 * начнёт сшивать заголовок с соседней содержательной строкой. Поэтому на
 * каждый случай «поймала» есть случай «не сшила».
 */
import { describe, expect, it } from 'vitest';
import { classifyPages, PHASE1_CONFIDENCE } from './classify.js';
import type { PageClassification, PageInput, SegmentationBlockType } from './types.js';

/**
 * Копия `FIXTURE_TEXTS` из `tools/fixtures/src/synthetic.ts`.
 *
 * Копия, а не импорт: `@id/fixtures` не входит в зависимости `@id/api`, и
 * тянуть генератор PDF-фикстур в граф зависимостей приложения ради одного
 * теста дороже, чем продублировать восемь строк. Риск расхождения принят и
 * записан в отчёте этапа: тексты синтетические и меняются вместе с фикстурами.
 */
const FIXTURE_TEXTS: Readonly<Record<string, readonly string[]>> = {
  multipage: [
    'АКТ\nосвидетельствования скрытых работ\n№ 01-TEST\nЛист 1 из 2',
    'п.3 При выполнении работ применены\nЛист 2 из 2',
    'Реестр приложений №1 к акту АОСР № 01-TEST\n| 1 | Сертификат | №A-1 | ООО "Тест" |',
    'СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1\nСрок действия с 01.01.2025 по 01.01.2028',
  ],
  rotated: ['Портрет 0', 'Альбом 90', 'Портрет 180', 'A3 альбом 270'],
  'split-part1': ['ПРОТОКОЛ об испытаниях\n№ P-1\nЛист 1 из 2'],
  'split-part2': ['Лист 2 из 2\nВывод: соответствует'],
  'unknown-type': [
    'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ\n№ ГИ-77 от 12.05.2026\nДавление 1,0 МПа, выдержка 10 мин',
  ],
  'single-1': ['Скан 1\nЛист 1 из 3'],
  'single-2': ['Скан 2\nЛист 2 из 3'],
  'single-3': ['Скан 3\nЛист 3 из 3'],
};

function page(id: string, text: string, extra: Partial<PageInput> = {}): PageInput {
  return {
    sourcePageId: id,
    revisionOrdinal: Number(id.replace(/\D/gu, '')) || 1,
    sourceFileId: 'file-1',
    filePageIndex: 0,
    pageTextVersionId: `ptv-${id}`,
    text,
    blockTypes: ['text'] as readonly SegmentationBlockType[],
    rotation: 0,
    ...extra,
  };
}

function only(input: PageInput): PageClassification {
  const [result] = classifyPages([input]);
  return result as PageClassification;
}

describe('контракт фазы 1', () => {
  it('возвращает ровно одно решение на страницу в том же порядке', () => {
    const pages = [
      page('p1', 'СЕРТИФИКАТ СООТВЕТСТВИЯ № A-1'),
      page('p2', ''),
      page('p3', 'что-то'),
    ];
    const result = classifyPages(pages);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.sourcePageId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('ручная разметка приоритетна и не переопределяется якорями', () => {
    // На странице настоящий заголовок сертификата, а человек сказал «это акт».
    // Побеждает человек: §8.2 объявляет ручную разметку приоритетной.
    const result = only(
      page('p1', 'СЕРТИФИКАТ СООТВЕТСТВИЯ № A-1', {
        manual: { label: 'B-DOC', docTypeCode: 'aosr', pageRoleCode: null },
      }),
    );
    expect(result.source).toBe('manual');
    expect(result.docTypeCode).toBe('aosr');
    expect(result.confidence).toBe(PHASE1_CONFIDENCE.manual);
  });
});

describe('якоря каталога', () => {
  it('заголовок даёт B-DOC с точным диапазоном в исходном тексте', () => {
    const text = 'Шапка листа\n\n##### СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1 от 01.02.2026\n';
    const result = only(page('p1', text));

    expect(result.label).toBe('B-DOC');
    expect(result.docTypeCode).toBe('cert_conformity');
    expect(result.typeOutcome).toBe('known');
    expect(result.evidence).not.toBeNull();

    const ev = result.evidence as NonNullable<PageClassification['evidence']>;
    // Диапазон измеряется по ИСХОДНОМУ тексту, а не по нормализованному:
    // именно так его прочитает подсветка в UI и `finding_evidence`.
    expect(text.slice(ev.charStart, ev.charEnd)).toBe(ev.quote);
    expect(ev.quote).toBe('СЕРТИФИКАТ СООТВЕТСТВИЯ');
    // Markdown-префикс в цитату не попадает: он разметка OCR, а не заголовок.
    expect(ev.quote.startsWith('#')).toBe(false);
  });

  it('без версии текста доказательство не выдумывается', () => {
    const result = only(page('p1', 'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ № Д-1', { pageTextVersionId: null }));
    expect(result.docTypeCode).toBe('declaration');
    expect(result.evidence).toBeNull();
  });

  it('два кандидата равного приоритета дают uncertain, а не молчаливый выбор', () => {
    const result = only(page('p1', 'ПАСПОРТ КАЧЕСТВА № 7\nДЕКЛАРАЦИЯ О СООТВЕТСТВИИ № Д-8'));
    expect(result.ambiguous).toBe(true);
    expect(result.typeOutcome).toBe('uncertain');
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.confidence).toBe(PHASE1_CONFIDENCE.anchorAmbiguous);
  });

  it('незнакомый вид документа фаза 1 не притягивает к известному типу', () => {
    // Открытый мир (§0.5, п.1). Ответ здесь не «сигнала нет», а содержательный:
    // «это документ, и вида такого у меня нет». Различие не косметическое —
    // именно other даёт резервный тип и запись в doc_type_candidates (§16),
    // причём БЕЗ участия внешней модели. Если бы фаза 1 отвечала none,
    // требование §16 держалось бы подключённым провайдером, то есть в CI
    // не проверялось бы вовсе.
    const result = only(page('p1', FIXTURE_TEXTS['unknown-type']?.[0] as string));
    expect(result.label).toBe('B-DOC');
    expect(result.typeOutcome).toBe('other');
    // Ни один известный код не присвоен — вот что значит «не притягивает».
    expect(result.docTypeCode).toBeNull();
    expect(result.observedTitle).toBe('АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ');
    expect(result.confidence).toBe(PHASE1_CONFIDENCE.unknownHeading);
  });

  it('заголовком документа считается только открывающее слово из закрытого списка', () => {
    // Цена шага 8: без закрытого списка любая строка прописными открывала бы
    // документ, и вторая страница бланка АОСР разрывала бы акт пополам.
    const result = only(
      page(
        'p1',
        `ОБЪЕКТ КАПИТАЛЬНОГО СТРОИТЕЛЬСТВА
сведения о работах`,
      ),
    );
    expect(result.label).toBe('U');
    expect(result.typeOutcome).toBe('none');
  });

  it('строка реестра заголовком неизвестного документа не становится', () => {
    // Каждая строка реестра приложений начинается словом из того же списка.
    // Табличный разделитель — единственное, что отличает перечень от заголовка.
    const result = only(page('p1', '| 3 | Сертификат соответствия Плита | №A-1 | ООО «Ромашка» |'));
    expect(result.typeOutcome).toBe('none');
  });
});

describe('роли страниц', () => {
  it('роль документа не открывает', () => {
    const result = only(page('p1', 'КОПИЯ ВЕРНА\nСпециалист отдела'));
    expect(result.label).toBe('A-ROLE');
    expect(result.pageRoleCode).toBe('copy_stamp');
    expect(result.docTypeCode).toBeNull();
  });

  it('приложение отдаёт номер родителя из захвата якоря', () => {
    const result = only(page('p1', 'ПРИЛОЖЕНИЕ\nК сертификату соответствия № RU.TEST.001.H.00042'));
    expect(result.label).toBe('A-ROLE');
    expect(result.pageRoleCode).toBe('annex_continuation');
    expect(result.parentRef).toBe('RU.TEST.001.H.00042');
  });

  it('дочитывает номер родителя со строки ниже якоря', () => {
    // Заголовок приложения в корпусе трёхстрочный, и якорь роли видит только
    // одну строку: `page-roles.ts` явно оставил дочитывание сегментатору.
    const result = only(
      page('p1', '##### ПРИЛОЖЕНИЕ № 1\nК СЕРТИФИКАТУ СООТВЕТСТВИЯ\nRU.TEST.001.H.00271'),
    );
    expect(result.pageRoleCode).toBe('annex_continuation');
    expect(result.parentRef).toBe('RU.TEST.001.H.00271');
  });

  it('не дочитывает номер там, где родитель не назван', () => {
    // Под одиноким «ПРИЛОЖЕНИЕ» идёт содержание приложения, а не номер
    // родителя, и принять его за номер значило бы привязать лист наугад.
    const result = only(page('p1', 'ПРИЛОЖЕНИЕ № 2\nПеречень продукции по ГОСТ 32314-2012'));
    expect(result.pageRoleCode).toBe('annex_continuation');
    expect(result.parentRef).toBeNull();
  });
});

describe('классификация по составу блоков', () => {
  it('графика вместе со штампом без якорей — кандидат в исполнительную схему', () => {
    // Прямой ответ на замер S1: `exec_scheme` не поймался ни разу из четырёх,
    // потому что слов «исполнительная схема» на таких листах нет вовсе.
    const result = only(
      page('p1', 'Условные обозначения\nОтм. -0.300\nМ 1:100', {
        blockTypes: ['image', 'text', 'stamp'],
      }),
    );
    expect(result.label).toBe('B-DOC');
    expect(result.docTypeCode).toBe('exec_scheme');
    expect(result.source).toBe('blocks');
    // Признак косвенный: уверенность низкая и исход `uncertain`, чтобы декодер
    // поставил `needs_review`. Иначе это была бы тихая высокоуверенная ошибка.
    expect(result.typeOutcome).toBe('uncertain');
    expect(result.confidence).toBe(PHASE1_CONFIDENCE.blocks);
  });

  it('настоящий заголовок сильнее состава блоков', () => {
    const result = only(
      page('p1', 'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ № Д-1', { blockTypes: ['image', 'stamp'] }),
    );
    expect(result.docTypeCode).toBe('declaration');
    expect(result.source).toBe('anchor');
  });

  it('страница, отданная одним image-блоком без текста, остаётся U с названной причиной', () => {
    const result = only(page('p1', '', { blockTypes: ['image'] }));
    expect(result.label).toBe('U');
    expect(result.reason).toContain('содержимое в графике');
  });
});

describe('внутридокументные счётчики', () => {
  it('«лист 2 из 2» — продолжение документа', () => {
    const result = only(page('p2', 'Лист 2 из 2\nПродолжение перечня показателей'));
    expect(result.label).toBe('I-DOC');
    expect(result.pageRoleCode).toBe('doc_continuation');
    expect(result.confidence).toBe(PHASE1_CONFIDENCE.sheetCounter);
  });

  it('«лист 1 из 2» продолжением НЕ является и остаётся U с подсказкой', () => {
    // Роль `doc_continuation` ловит оба случая одним якорем, и присоединение
    // первой страницы к предыдущему документу разорвало бы сразу два.
    const result = only(page('p1', 'Лист 1 из 2\nНачало ведомости'));
    expect(result.label).toBe('U');
    expect(result.reason).toContain('лист 1 из 2');
  });

  it('заявленный объём документа попадает в объяснение, но решения не принимает', () => {
    const result = only(page('p1', 'Всего на 17 страницах, заверенных печатью'));
    expect(result.label).toBe('U');
    expect(result.reason).toContain('Всего на 17 страницах');
  });
});

describe('склейка разорванного заголовка', () => {
  it('ловит заголовок, разорванный OCR на две строки', () => {
    const text = 'КОПИЯ\n\nСЕРТИФИКАТ\nСООТВЕТСТВИЯ\n№ A-1 от 01.02.2026';
    const result = only(page('p1', text));
    expect(result.docTypeCode).toBe('cert_conformity');
    expect(result.confidence).toBe(PHASE1_CONFIDENCE.gluedAnchor);
    expect(result.reason).toContain('склейке');

    const ev = result.evidence as NonNullable<PageClassification['evidence']>;
    // Диапазон накрывает обе исходные строки и остаётся точным срезом текста.
    expect(text.slice(ev.charStart, ev.charEnd)).toBe(ev.quote);
    expect(ev.quote).toBe('СЕРТИФИКАТ\nСООТВЕТСТВИЯ');
  });

  it('не сшивает заголовок с соседней содержательной строкой', () => {
    // Цена склейки: вторая строка длинная и в смешанном регистре — это текст
    // документа, а не обрывок заголовка. Сшивание дало бы ложный тип.
    const result = only(
      page('p1', 'СЕРТИФИКАТ\nСоответствия требованиям технического регламента подтверждено'),
    );
    // Проверяется отсутствие ПРИСВОЕННОГО типа: шаг 8 открытого мира назовёт
    // такой лист документом неизвестного вида, и это верно — ложным было бы
    // только присвоение конкретного кода каталога.
    expect(result.docTypeCode).toBeNull();
  });

  it('не сшивает с длинной строкой, даже набранной прописными', () => {
    // Условие длины здесь единственная защита: строка сплошь в верхнем
    // регистре и без завершающей пунктуации — типовая вёрстка сертификатов.
    const result = only(
      page('p1', 'СЕРТИФИКАТ\nСООТВЕТСТВИЯ ТРЕБОВАНИЯМ ТЕХНИЧЕСКОГО РЕГЛАМЕНТА ПОДТВЕРЖДЕНО'),
    );
    // Проверяется отсутствие ПРИСВОЕННОГО типа: шаг 8 открытого мира назовёт
    // такой лист документом неизвестного вида, и это верно — ложным было бы
    // только присвоение конкретного кода каталога.
    expect(result.docTypeCode).toBeNull();
  });

  it('не сшивает обрывки через содержательную строку между ними', () => {
    const result = only(page('p1', 'СЕРТИФИКАТ\nвыдан на основании протокола\nСООТВЕТСТВИЯ'));
    // Проверяется отсутствие ПРИСВОЕННОГО типа: шаг 8 открытого мира назовёт
    // такой лист документом неизвестного вида, и это верно — ложным было бы
    // только присвоение конкретного кода каталога.
    expect(result.docTypeCode).toBeNull();
  });

  it('цена условия «верхний регистр»: разрыв строчными фаза 1 не ловит', () => {
    // Тест фиксирует принятую плату, а не желаемое поведение: снять условие
    // верхнего регистра — значит начать сшивать соседние строки обычного
    // текста. Такой разрыв достаётся фазе 2, где решение подтверждается
    // цитатой, а не догадкой.
    const result = only(page('p1', 'Сертификат\nСоответствия\n№ A-1'));
    // Проверяется отсутствие ПРИСВОЕННОГО типа: шаг 8 открытого мира назовёт
    // такой лист документом неизвестного вида, и это верно — ложным было бы
    // только присвоение конкретного кода каталога.
    expect(result.docTypeCode).toBeNull();
  });

  it('не сшивает строку, законченную пунктуацией', () => {
    const result = only(page('p1', 'СЕРТИФИКАТ.\nСООТВЕТСТВИЯ'));
    expect(result.typeOutcome).toBe('none');
  });

  it('не превращает заголовок приложения в заголовок его родителя', () => {
    // Самый дорогой ложный случай: лист приложения, склеенный до
    // «ПРИЛОЖЕНИЕ № 1 К СЕРТИФИКАТУ СООТВЕТСТВИЯ», открыл бы новый документ
    // вместо присоединения к сертификату — потеря обеих границ сразу.
    const result = only(
      page('p1', 'ПРИЛОЖЕНИЕ № 1\nК СЕРТИФИКАТУ СООТВЕТСТВИЯ\nRU.TEST.001.H.00042'),
    );
    expect(result.typeOutcome).toBe('none');
    expect(result.pageRoleCode).toBe('annex_continuation');
  });

  it('на синтетических фикстурах склейка не создаёт ни одного типа', () => {
    // Замер цены на всём наборе `FIXTURE_TEXTS`: ожидаемые метки перечислены
    // поимённо, поэтому любое новое срабатывание склейки уронит тест.
    const expected: Record<string, readonly (string | null)[]> = {
      multipage: ['aosr', null, 'annex_registry', 'cert_conformity'],
      rotated: [null, null, null, null],
      'split-part1': ['lab_protocol_generic'],
      'split-part2': [null],
      'unknown-type': [null],
      'single-1': [null],
      'single-2': [null],
      'single-3': [null],
    };
    for (const [name, texts] of Object.entries(FIXTURE_TEXTS)) {
      const result = classifyPages(texts.map((t, i) => page(`${name}-${i}`, t)));
      expect(
        result.map((c) => c.docTypeCode),
        name,
      ).toEqual(expected[name]);
    }
  });
});

describe('слабые приоры', () => {
  it('смена файла и смена ориентации метку не меняют', () => {
    // Документ штатно продолжается в другом одностраничном файле, а A3-схема
    // штатно меняет ориентацию внутри документа. Решение по ним не принимается.
    const pages = [
      page('p1', 'ПАСПОРТ КАЧЕСТВА № 7'),
      page('p2', 'Лист 2 из 2\nПродолжение', { sourceFileId: 'file-2', rotation: 90 }),
    ];
    const [, second] = classifyPages(pages);
    const result = second as PageClassification;
    expect(result.label).toBe('I-DOC');
    expect(result.reason).toContain('слабый приор');
  });
});
