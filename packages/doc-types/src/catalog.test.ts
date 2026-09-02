/**
 * Тесты каталога видов ИД (§8.1, §8.2).
 *
 * Сопоставление берётся готовым из `matching.ts` — тем же кодом, которым
 * пользуется классификатор страниц. Собственная реализация матчинга в тесте
 * означала бы, что зелёный тест каталога ничего не говорит о поведении
 * системы: разойдутся реализации — разойдутся и выводы.
 *
 * Проверяется не только то, что нужный тип срабатывает, но и то, что не
 * срабатывают лишние. В открытом мире (§0.5) ложный тип дороже пропуска:
 * он подменяет набор применимых правил и порождает замечания на документе,
 * к которому эти правила отношения не имеют, — а «резервный тип + кандидат
 * в справочник» является штатным исходом, а не ошибкой.
 */

import { describe, expect, it } from 'vitest';

import { DOC_TYPES } from './catalog.js';
import { matchDocTypes, matchPageRoles, normalizeLine, resolveDocType } from './matching.js';
import { PAGE_ROLES } from './page-roles.js';
import { compileAnchors } from './types.js';
import type { DocTypeDefinition, PageRoleDefinition } from './types.js';

// Через интерфейс, а не через литеральный тип кортежа: у типов без
// `negativeAnchors`/`bodyHints` этих свойств в выведенном типе просто нет.
const docTypes: readonly DocTypeDefinition[] = DOC_TYPES;
const pageRoles: readonly PageRoleDefinition[] = PAGE_ROLES;

const typeCodes = (text: string): string[] => matchDocTypes(text, docTypes).map((m) => m.code);
const roleCodes = (text: string): string[] => matchPageRoles(text, pageRoles).map((m) => m.code);

/**
 * Заголовки реальных форм из корпуса. Это названия бланков, а не ПДн.
 * Номера сохранены дословно: хвост после якоря участвует в решении — он не
 * должен быть длиннее служебного (номер, дата, скобочное уточнение).
 */
const H = {
  aosr: 'АКТ\nосвидетельствования скрытых работ',
  annexRegistry: 'Реестр приложений №1 к акту АОСР №336-АрмВК',
  certConformity: 'СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ RU.MCC.240.445.38406',
  declaration: 'ДЕКЛАРАЦИЯ О СООТВЕТСТВИИ',
  qualityPassport: 'ПАСПОРТ КАЧЕСТВА / QUALITY CERTIFICATE № 491',
  passportShort: 'Паспорт № 230126/2/126000477.1.1',
  technicalPassport: 'ТЕХНИЧЕСКИЙ ПАСПОРТ',
  millCertificate: 'СЕРТИФИКАТ КАЧЕСТВА № 2500037115',
  mixQuality:
    'ДОКУМЕНТ О КАЧЕСТВЕ БЕТОННОЙ СМЕСИ (РАСТВОРА) ЗАДАННОГО КАЧЕСТВА ПАРТИИ № 18-000002580',
  mixQualityShort: 'Документ о качестве № 18-000002580',
  productQualityDoc: 'ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б на камни бетонные стеновые по ГОСТ 6133-2019',
  labProtocol: 'Протокол об испытаниях №1753.КП/02.26',
  sanitaryConclusion: 'ЭКСПЕРТНОЕ ЗАКЛЮЧЕНИЕ',
  technicalConclusion: 'ЗАКЛЮЧЕНИЕ № 02(a)-2020',
  permitConformityMark: 'РАЗРЕШЕНИЕ\nна применение знака соответствия',
  copyStamp: 'КОПИЯ ВЕРНА',
  signature: 'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
} as const;

/** Строки, на которых каталог обязан промолчать. */
const FP = {
  certAnnex: 'ПРИЛОЖЕНИЕ\nК сертификату соответствия № 04УПС45.RU.C00022',
  // Печатная подсказка бланка РД-11-02: она есть на 100% актов, и якорь
  // схемы, сработавший на ней, давал ложный `exec_scheme` на каждом АОСР.
  aosrFormHint:
    '(исполнительные схемы и чертежи, результаты экспертизы, обследований, лабораторных ' +
    'и иных испытаний выполненных работ, проведенных в процессе строительного контроля)',
  registryRow:
    '| 13 | Документ о качестве; Раствор М-150 | №АБС00001381 от 27.02.2026 | ООО "АБС Групп" |',
} as const;

/**
 * Заголовок незнакомого типа из синтетических фикстур
 * (`tools/fixtures/src/synthetic.ts`, `FIXTURE_TEXTS['unknown-type']`).
 * Строка продублирована: зависимости на воркспейс фикстур у каталога нет.
 */
const UNKNOWN_TYPE_HEADING = 'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ';

describe('DOC_TYPES — целостность каталога', () => {
  it('коды типов уникальны', () => {
    const codes = docTypes.map((type) => type.code);

    expect(codes).toEqual([...new Set(codes)]);
  });

  it('sortOrder уникален внутри группы', () => {
    const byGroup = new Map<string, number[]>();
    for (const type of docTypes) {
      const orders = byGroup.get(type.group) ?? [];
      orders.push(type.sortOrder);
      byGroup.set(type.group, orders);
    }

    for (const [group, orders] of byGroup) {
      expect(orders, `дубли sortOrder в группе ${group}`).toEqual([...new Set(orders)]);
    }
  });

  it('все шаблоны компилируются', () => {
    for (const type of docTypes) {
      const { anchors, negativeAnchors, bodyHints } = type.matchHints;

      expect(() => compileAnchors(anchors), type.code).not.toThrow();
      expect(() => compileAnchors(negativeAnchors ?? []), type.code).not.toThrow();
      expect(() => compileAnchors(bodyHints ?? []), type.code).not.toThrow();
    }
  });

  it('у каждого не-резервного типа есть якоря', () => {
    for (const type of docTypes) {
      if (!type.isFallback) {
        expect(type.matchHints.anchors.length, `нет якорей у ${type.code}`).toBeGreaterThan(0);
      }
    }
  });

  it('есть общий резервный тип unknown_document', () => {
    const unknown = docTypes.find((type) => type.code === 'unknown_document');

    expect(unknown?.isFallback).toBe(true);
    expect(unknown?.group).toBe('fallback');
    expect(unknown?.kind).toBe('fallback');
  });

  it('у резервных типов якорей нет', () => {
    // Резервный тип присваивается решением классификатора «это документ, но
    // не из известных типов» (§8.2, фаза 2), а не совпадением по заголовку.
    // Якорь у него означал бы, что резерв способен перехватить документ
    // у настоящего типа.
    for (const type of docTypes) {
      if (type.isFallback) {
        expect(type.matchHints.anchors, `у резервного ${type.code} есть якоря`).toEqual([]);
        expect(type.kind, type.code).toBe('fallback');
        expect(type.observedInCorpus, `резерв ${type.code} не может быть встречен`).toBe(false);
      }
    }
  });

  it('в каждой группе ровно один резервный тип', () => {
    const groups = [...new Set(docTypes.map((type) => type.group))];

    for (const group of groups) {
      const fallbacks = docTypes.filter((type) => type.isFallback && type.group === group);

      expect(
        fallbacks.map((type) => type.code),
        `группа ${group}`,
      ).toHaveLength(1);
    }
  });
});

describe('якоря написаны под построчную семантику', () => {
  /**
   * Якорь применяется к УЖЕ нормализованной строке и обязан совпадать с её
   * начала (`m.index === 0` в `matching.ts`). Отсюда три запрета:
   * `^` избыточен; `$` ломает совпадение, потому что после заголовка почти
   * всегда идёт номер или дата; ведущий `\s*` бессмыслен — пробелы схлопнуты
   * и обрезаны нормализацией, а markdown-префикс уже снят.
   */
  const problems = (source: string): string[] => {
    const found: string[] = [];
    if (source.includes('^')) {
      found.push('содержит ^');
    }
    if (source.includes('$')) {
      found.push('содержит $');
    }
    if (source.startsWith('\\s*')) {
      found.push('начинается с \\s*');
    }
    return found;
  };

  const scan = (pick: (type: DocTypeDefinition) => readonly string[]): string[] =>
    docTypes.flatMap((type) =>
      pick(type).flatMap((source) => problems(source).map((p) => `${type.code}: ${p} — ${source}`)),
    );

  it('ни один якорь не содержит ^, $ или ведущий \\s*', () => {
    expect(scan((type) => type.matchHints.anchors)).toEqual([]);
  });

  it('то же верно для отрицательных якорей — их проверяет та же функция', () => {
    expect(scan((type) => type.matchHints.negativeAnchors ?? [])).toEqual([]);
  });
});

describe('покрытие корпусом', () => {
  const observed = docTypes.filter((type) => type.observedInCorpus).map((type) => type.code);

  it('корпус двух разделов подтверждает не менее 12 типов', () => {
    expect(observed.length).toBeGreaterThanOrEqual(12);
  });

  it('подтверждённые типы включают ядро комплекта АОСР', () => {
    // Эти шесть образуют минимальный комплект: акт, его реестр приложений и
    // четыре класса доказательных документов, встреченных в обоих разделах.
    for (const code of [
      'aosr',
      'annex_registry',
      'cert_conformity',
      'quality_passport',
      'mill_certificate',
      'mix_quality_doc',
    ]) {
      expect(observed, `${code} должен быть помечен observedInCorpus`).toContain(code);
    }
  });
});

describe('реальный заголовок даёт ровно один ожидаемый тип', () => {
  const cases = [
    { name: 'АОСР', text: H.aosr, code: 'aosr' },
    { name: 'реестр приложений', text: H.annexRegistry, code: 'annex_registry' },
    { name: 'сертификат соответствия', text: H.certConformity, code: 'cert_conformity' },
    { name: 'декларация о соответствии', text: H.declaration, code: 'declaration' },
    { name: 'паспорт качества, двуязычный', text: H.qualityPassport, code: 'quality_passport' },
    { name: 'паспорт с номером', text: H.passportShort, code: 'quality_passport' },
    { name: 'технический паспорт', text: H.technicalPassport, code: 'technical_passport' },
    { name: 'сертификат качества завода', text: H.millCertificate, code: 'mill_certificate' },
    { name: 'документ о качестве смеси', text: H.mixQuality, code: 'mix_quality_doc' },
    {
      name: 'документ о качестве смеси, краткий',
      text: H.mixQualityShort,
      code: 'mix_quality_doc',
    },
    { name: 'документ о качестве изделия', text: H.productQualityDoc, code: 'product_quality_doc' },
    { name: 'экспертное заключение', text: H.sanitaryConclusion, code: 'sanitary_conclusion' },
    { name: 'техническое заключение', text: H.technicalConclusion, code: 'technical_conclusion' },
    { name: 'разрешение на знак', text: H.permitConformityMark, code: 'permit_conformity_mark' },
  ] as const;

  for (const { name, text, code } of cases) {
    it(`${name} → ${code}`, () => {
      expect(typeCodes(text), text).toEqual([code]);
    });
  }

  it('протокол без подзаголовка опознаётся как протокол, но подвид не выдумывается', () => {
    // Заголовок «Протокол об испытаниях № …» одинаков у протоколов бетона,
    // металла, УЗК и гидроизоляции: подвид виден только из подзаголовка.
    // Терять такой документ нельзя, но и назначать ему конкретный подвид
    // по одному лишь заголовку — значит выдумать данные.
    const resolved = resolveDocType(matchDocTypes(H.labProtocol, DOC_TYPES), DOC_TYPES);

    expect(resolved.code).toBe('lab_protocol_generic');
    expect(resolved.ambiguous).toBe(false);
  });

  it('подзаголовок поднимает подвид над обобщающим типом', () => {
    const text =
      'Протокол об испытаниях №1753.КП/02.26 от 04.02.2026\nпо определению прочности раствора по контрольным образцам-кубам';
    const resolved = resolveDocType(matchDocTypes(text, DOC_TYPES), DOC_TYPES);

    expect(resolved.code).toBe('lab_protocol_concrete');
    expect(resolved.alternatives).toContain('lab_protocol_generic');
    expect(resolved.ambiguous).toBe(false);
  });

  it('соседние по словарю формы не путаются между собой', () => {
    // «ПАСПОРТ КАЧЕСТВА», «ТЕХНИЧЕСКИЙ ПАСПОРТ» и «СЕРТИФИКАТ КАЧЕСТВА №»
    // лежат в одной подшивке, а схемы реквизитов у них разные: плавка и
    // химсостав против показателей ОТК.
    expect(typeCodes(H.qualityPassport)).not.toContain('technical_passport');
    expect(typeCodes(H.qualityPassport)).not.toContain('mill_certificate');
    expect(typeCodes(H.technicalPassport)).not.toContain('quality_passport');
    expect(typeCodes(H.millCertificate)).not.toContain('cert_conformity');
    expect(typeCodes(H.sanitaryConclusion)).not.toContain('technical_conclusion');
    expect(typeCodes(H.productQualityDoc)).not.toContain('mix_quality_doc');
    expect(typeCodes(H.mixQuality)).not.toContain('product_quality_doc');
  });
});

describe('формы temp/MD/new (значения синтетические)', () => {
  it('АОСР по приказу №344/пр: титул после шапки, на 31-й строке', () => {
    // В этой форме перед титулом идёт шапка с объектом и четырьмя участниками;
    // на пяти реальных актах якорная строка была 28–31-й. Строки — синтетика.
    const header = Array.from({ length: 29 }, (_, i) => `строка шапки бланка ${i + 1}`).join('\n');
    const text = `${header}\nАКТ\nосвидетельствования скрытых работ`;
    const resolved = resolveDocType(matchDocTypes(text, docTypes), docTypes);

    expect(resolved.code).toBe('aosr');
  });

  /**
   * Рендер VLM: титул склеен в ОДНУ строку.
   *
   * Корпус `temp/MD` распознан RD WEB, и там титул бланка разбит на две
   * строки — «АКТ» и «освидетельствования скрытых работ», — поэтому якорь
   * совпадал с началом второй и тип присваивался. Провайдер VLM склеивает их:
   * совпадение начинается с индекса 4, а `matchesAsHeading` требует начала
   * строки, и на проде тип не присваивался вовсе (`typeOutcome: none`,
   * `confidence 0.00`).
   *
   * Дефект невоспроизводим на корпусе по построению — рендер другой, — поэтому
   * оба варианта закреплены здесь. Это единственное место, где разница между
   * провайдерами распознавания видна тесту.
   */
  it('АОСР в рендере VLM: титул одной строкой', () => {
    expect(typeCodes('АКТ освидетельствования скрытых работ')).toEqual(['aosr']);
  });

  it('АОСР в рендере RD WEB: титул двумя строками', () => {
    expect(typeCodes('АКТ\nосвидетельствования скрытых работ')).toEqual(['aosr']);
  });

  it('оба рендера с markdown-заголовком и номером в хвосте', () => {
    expect(typeCodes('###### АКТ освидетельствования скрытых работ № 01-Бл/П')).toEqual(['aosr']);
    expect(typeCodes('**АКТ**\n**освидетельствования скрытых работ**')).toEqual(['aosr']);
  });

  it('упоминание акта в перечне приложений типом не является', () => {
    // Хвост длиннее служебного номера: это ссылка на акт, а не его заголовок.
    expect(
      typeCodes(
        'Приложение к АКТ освидетельствования скрытых работ, составленному ' +
          'в отношении конструкций, предъявленных к освидетельствованию комиссией',
      ),
    ).toEqual([]);
  });

  it('«Реестр № N к АОСР №…» — реестр приложений', () => {
    expect(typeCodes('Реестр № 1 к АОСР №01-СИН/П от 21.11.2024г.')).toEqual(['annex_registry']);
  });

  it('«Реестр № N к №…» без слова АОСР — тоже реестр приложений', () => {
    expect(typeCodes('Реестр № 2 к №СИН/ОВ1/От/32 от 31.12.2024 г.')).toEqual(['annex_registry']);
  });

  it('упоминание «Реестр №2 от …» в тексте акта реестром не является', () => {
    expect(typeCodes('Реестр №2 от 31.12.2024 г.')).toEqual([]);
  });

  it('реестр передачи исполнительной документации — свой тип', () => {
    expect(typeCodes('Реестр исполнительной документации')).toEqual(['transfer_registry']);
    expect(typeCodes('Реестр передачи исполнительной документации')).toEqual(['transfer_registry']);
  });

  it('свидетельство о государственной регистрации — свой тип, а не сертификат', () => {
    // Лист лежит следом за сертификатом соответствия, и до появления типа
    // разбор считал его продолжением: номер СГР уезжал в реквизиты
    // сертификата, а строка реестра «Сертификат соответствия» не находила
    // своего документа. В корпусе так испорчены все двенадцать комплектов.
    // Две строки бланка ТС: вторая набрана строчными, и склейка заголовка
    // её не собирает — тип держится на якоре по этой самой строке.
    expect(typeCodes('СВИДЕТЕЛЬСТВО\nо государственной регистрации')).toEqual([
      'state_registration_certificate',
    ]);
    expect(typeCodes('СВИДЕТЕЛЬСТВО о государственной регистрации')).toEqual([
      'state_registration_certificate',
    ]);
  });

  it('строка реестра о свидетельстве документом не становится', () => {
    // Тот же текст, но это перечисление: хвост строки длиннее служебного
    // номера, и заголовком она не считается.
    const row =
      '| | 1.5 | Свидетельство о государственной регистрации | ' +
      '№ RU.00.01.00.000.E.000000.00.00 | ООО «СИНТЕТИК» | от 06.12.2016г. | 1 | 5 |';

    expect(typeCodes(row)).toEqual([]);
  });

  it('приложение к свидетельству о госрегистрации типом не является', () => {
    // Это лист того же документа: его присоединяет роль annex_continuation.
    expect(typeCodes('ПРИЛОЖЕНИЕ\nК СВИДЕТЕЛЬСТВУ О ГОСУДАРСТВЕННОЙ РЕГИСТРАЦИИ')).toEqual([]);
  });

  it('письмо органа по сертификации без заголовка — отказное письмо', () => {
    // Форма «Эксперт-С»: документ не озаглавлен вовсе, после шапки органа
    // сразу идёт обращение. Три листа письма опознавались продолжением
    // соседнего паспорта качества.
    expect(typeCodes('На Ваш запрос в порядке информации сообщаем, что согласно:')).toEqual([
      'refusal_letter',
    ]);
  });

  it('второй лист санзаключения техническим заключением не становится', () => {
    // На нём «ЗАКЛЮЧЕНИЕ» — подзаголовок вывода. Отличает лист его начало:
    // гигиеническая таблица, с которой он открывается.
    const secondSheet =
      'Гигиеническая характеристика продукции:\n' +
      'Запах воздушной среды, балл | 1 | до 2\n' +
      'ЗАКЛЮЧЕНИЕ\n' +
      'Санитарно-эпидемиологическая экспертиза проведена в соответствии';

    expect(typeCodes(secondSheet)).not.toContain('technical_conclusion');
  });

  it('техническое заключение с собственным титулом типом остаётся', () => {
    expect(typeCodes('ЗАКЛЮЧЕНИЕ\n№ 02(а)-2020')).toEqual(['technical_conclusion']);
  });

  it('учётный лист журнала авторского надзора — журнал АН', () => {
    // В комплект подшивается не журнал, а его лист; реестр называет его
    // «ЖАН №2, учетные листы №118».
    expect(typeCodes('УЧЕТНЫЙ ЛИСТ № 118')).toEqual(['author_supervision_log']);
    expect(typeCodes('УЧЁТНЫЙ ЛИСТ № 118')).toEqual(['author_supervision_log']);
  });

  it('титул листа-сертификата подписей ЭДО — роль страницы, а не тип', () => {
    const sheet =
      'Документ подготовлен и подписан в СИНТЕТ-ЭДО: Исполнительная документация\n' +
      '| Представитель лица | Имя и должность владельца сертификата | ' +
      'Отпечаток и реквизиты сертификата | Дата и время подписания |';

    expect(roleCodes(sheet)).toContain('signature_visual');
    expect(typeCodes(sheet)).toEqual([]);
  });

  it('подвал «Подписано в …» на содержательной странице ролью не является', () => {
    const footer =
      'АКТ\nосвидетельствования скрытых работ\nПодписано в СИНТЕТ-ЭДО: Исполнительная документация\nСтраница 1 из 3';

    expect(roleCodes(footer)).not.toContain('signature_visual');
  });
});

describe('ложные срабатывания', () => {
  it('приложение к сертификату сертификатом не является', () => {
    expect(typeCodes(FP.certAnnex)).not.toContain('cert_conformity');
  });

  it('печатная подсказка бланка АОСР не делает страницу исполнительной схемой', () => {
    // Совпадение внутри скобок начинается не с начала строки, и именно это
    // отсекает подсказку формы РД-11-02 от настоящего заголовка схемы.
    expect(typeCodes(FP.aosrFormHint)).not.toContain('exec_scheme');
  });

  it('строка реестра приложений не даёт вообще никакого типа', () => {
    expect(normalizeLine(FP.registryRow)).toBe(
      '13 | Документ о качестве; Раствор М-150 | №АБС00001381 от 27.02.2026 | ООО "АБС Групп"',
    );
    expect(typeCodes(FP.registryRow)).toEqual([]);
  });

  it('шапка реестра приложений даёт только сам реестр', () => {
    const registry =
      'Реестр приложений №1 к акту АОСР №336-АрмВК от 09.03.2026\n' +
      '№ чертежа, акта, разрешения\nОрганизация, составившая документ\n' +
      '| 13 | Документ о качестве; Раствор М-150 | №АБС00001381 | ООО "АБС Групп" |\n' +
      '| 14 | Сертификат соответствия | № RU.MCC.240.445.38406 | ООО "Стройсертификация" |';

    expect(typeCodes(registry)).toEqual(['annex_registry']);
  });

  it('упоминание приложения в теле самого сертификата тип не отменяет', () => {
    const certWithMention =
      'СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ ЕАЭС RU С-RU.НА46.В.00043/23\n' +
      'Серия RU № 0362518\nПродукция (см. приложение - бланк № 0000057)';

    expect(typeCodes(certWithMention)).toEqual(['cert_conformity']);
  });

  it('ни один якорь не срабатывает на пустом тексте', () => {
    // Страховка от чрезмерно общего шаблона вроде `\s*`: такой якорь сделал бы
    // свой тип победителем на любой странице, и открытый мир перестал бы
    // отличаться от закрытого.
    expect(typeCodes('')).toEqual([]);
  });
});

describe('роли страниц не смешиваются с типами документов', () => {
  it('«КОПИЯ ВЕРНА» — роль страницы, а не вид ИД', () => {
    expect(roleCodes(H.copyStamp)).toEqual(['copy_stamp']);
    expect(typeCodes(H.copyStamp)).toEqual([]);
  });

  it('лист визуализации ЭП — роль страницы, а не вид ИД', () => {
    expect(roleCodes(H.signature)).toEqual(['signature_visual']);
    expect(typeCodes(H.signature)).toEqual([]);
  });
});

describe('открытый мир', () => {
  it('заголовок незнакомого типа не совпадает ни с одним якорем каталога', () => {
    // §0.5: документ незнакомого вида — штатное состояние. Он обязан получить
    // резервный тип и попасть в `doc_type_candidates`, а не быть притянутым к
    // ближайшему знакомому типу.
    //
    // ВНИМАНИЕ, конфликт в плане: §8.1 включает в каталог `act_pressure_test`
    // («акт гидравлического или пневматического испытания»), а фикстуры (§2)
    // объявляют этот же заголовок «намеренно отсутствующим в каталоге».
    // Одновременно верным быть не может; тест фиксирует требование открытого
    // мира из задания.
    expect(
      typeCodes(UNKNOWN_TYPE_HEADING),
      'незнакомый заголовок притянут якорем каталога',
    ).toEqual([]);
  });

  it('незнакомый заголовок не опознаётся и как роль страницы', () => {
    expect(roleCodes(UNKNOWN_TYPE_HEADING)).toEqual([]);
  });
});

/**
 * S34: метрология средств измерений.
 *
 * Прибор, которым получен результат, обязан быть поверен, откалиброван либо
 * аттестован, и реестр приложений называет такие документы наравне с
 * протоколами. До появления видов ни один из них не получал якоря.
 */
describe('метрологические виды', () => {
  it('свидетельство о поверке опознаётся по своему титулу', () => {
    expect(
      resolveDocType(
        matchDocTypes('СВИДЕТЕЛЬСТВО О ПОВЕРКЕ\n№ С-ТЕСТ/00-00-2024/1', docTypes),
        docTypes,
      ).code,
    ).toBe('metrology_verification');
  });

  it('сертификат калибровки не притягивается сертификатом соответствия', () => {
    const resolved = resolveDocType(
      matchDocTypes('СЕРТИФИКАТ КАЛИБРОВКИ\nНомер сертификата №000000', docTypes),
      docTypes,
    );

    expect(resolved.code).toBe('metrology_calibration');
    expect(resolved.ambiguous).toBe(false);
  });

  it('протокол аттестации выигрывает у обобщающего протокола испытаний', () => {
    const resolved = resolveDocType(
      matchDocTypes(
        'ПРОТОКОЛ АТТЕСТАЦИИ № 00000\n1. Наименование испытательного оборудования',
        docTypes,
      ),
      docTypes,
    );

    expect(resolved.code).toBe('metrology_attestation');
    expect(resolved.ambiguous).toBe(false);
  });

  /**
   * Написание «о проверке» в корпусе встречается только в СТРОКЕ РЕЕСТРА, где
   * документ назвал подрядчик; заголовки самих листов всегда «о поверке».
   * Каталог классифицирует документ, а не перечень, и якорь на подрядческое
   * написание типизировал бы строку реестра как документ.
   */
  it('написание «о проверке» видом документа не считается', () => {
    expect(typeCodes('Свидетельство о проверке Весы электронные лабораторные')).toEqual([]);
  });

  it('упоминание поверки прибора в примечании схемы заголовком не считается', () => {
    const notes = [
      'ПРИМЕЧАНИЕ:',
      '5. Съемка выполнена тахеометром Leica TS06 №0000000.',
      'Свидетельство о поверке',
      '№С-ТЕСТ/00-00-2023/000000 от 16.11.2023.',
    ].join('\n');

    expect(typeCodes(notes)).toEqual([]);
  });
});
