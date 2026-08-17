import { describe, expect, it } from 'vitest';

import { BASE_EVIDENCE_FIELDS, fieldsForType } from './base-fields.js';
import { matchPageRoles } from './matching.js';
import { PAGE_ROLES } from './page-roles.js';
import { compileAnchors } from './types.js';
import type { FieldDefinition, PageRoleDefinition } from './types.js';

const codes = (fields: readonly FieldDefinition[]): string[] => fields.map((f) => f.code);

const uniqueCodes = (fields: readonly FieldDefinition[]): string[] => [...new Set(codes(fields))];

describe('BASE_EVIDENCE_FIELDS', () => {
  it('не содержит дублей кодов', () => {
    expect(codes(BASE_EVIDENCE_FIELDS)).toEqual(uniqueCodes(BASE_EVIDENCE_FIELDS));
  });

  it('покрывает базовую схему из §8.4', () => {
    expect(codes(BASE_EVIDENCE_FIELDS)).toEqual([
      'number',
      'blank_number',
      'issued_at',
      'valid_from',
      'valid_to',
      'issuer',
      'issuer_accreditation',
      'issuer_accreditation_valid_to',
      'applicant',
      'manufacturer',
      'manufacturer_inn',
      'product_name',
      'product_marks',
      'gost_tu',
      'okpd2',
      'tnved',
      'batch_no',
      'heat_no',
      'manufactured_at',
      'basis_documents',
    ]);
  });

  it('даты извлекаются правилами', () => {
    for (const field of BASE_EVIDENCE_FIELDS) {
      if (field.type === 'date') {
        expect(field.extractor).toBe('rule');
      }
    }
  });
});

describe('fieldsForType', () => {
  const specificOverride: FieldDefinition = {
    code: 'valid_to',
    label: 'Срок действия сертификата',
    type: 'date',
    required: true,
    extractor: 'rule',
  };
  const specificOwn: FieldDefinition = {
    code: 'certification_scheme',
    label: 'Схема сертификации',
    type: 'text',
    required: false,
    extractor: 'rule',
  };

  it('добавляет базовые поля доказательному типу', () => {
    const result = fieldsForType([specificOwn], 'evidence');

    expect(codes(result)).toContain('number');
    expect(codes(result)).toContain('certification_scheme');
    expect(result).toHaveLength(BASE_EVIDENCE_FIELDS.length + 1);
  });

  it('специфичное определение перекрывает базовое, а не дублирует его', () => {
    const result = fieldsForType([specificOverride], 'evidence');

    expect(codes(result)).toEqual(uniqueCodes(result));
    expect(result).toHaveLength(BASE_EVIDENCE_FIELDS.length);
    expect(result.find((f) => f.code === 'valid_to')).toEqual(specificOverride);
  });

  it('перекрытое поле остаётся на месте базового', () => {
    const base = codes(BASE_EVIDENCE_FIELDS);
    const result = codes(fieldsForType([specificOverride], 'evidence'));

    expect(result).toEqual(base);
  });

  it('собственные поля идут после базовых', () => {
    const result = codes(fieldsForType([specificOwn, specificOverride], 'evidence'));

    expect(result.at(-1)).toBe('certification_scheme');
  });

  it('резервный тип тоже получает базовые поля', () => {
    // §8.4: базовая схема применяется всегда, включая неопознанные документы, —
    // иначе на новом разделе не сработают ни проверки сроков, ни сверка с реестром.
    expect(codes(fieldsForType([], 'fallback'))).toEqual(codes(BASE_EVIDENCE_FIELDS));
  });

  it('primary и registry получают только собственные поля', () => {
    expect(fieldsForType([specificOwn], 'primary')).toEqual([specificOwn]);
    expect(fieldsForType([specificOwn], 'registry')).toEqual([specificOwn]);
  });

  it('не порождает дублей при дублях во входных данных', () => {
    const result = fieldsForType([specificOwn, specificOwn, specificOverride], 'evidence');

    expect(codes(result)).toEqual(uniqueCodes(result));
  });
});

// Через интерфейс, а не через литеральный тип кортежа: у ролей без
// `negativeAnchors`/`bodyHints` этих свойств в выведенном типе просто нет.
const roles: readonly PageRoleDefinition[] = PAGE_ROLES;
const roleCodes: readonly string[] = roles.map((role) => role.code);

describe('PAGE_ROLES', () => {
  it('содержит пять ролей без дублей', () => {
    expect(roleCodes).toEqual([
      'blank',
      'copy_stamp',
      'signature_visual',
      'annex_continuation',
      'doc_continuation',
    ]);
    expect(roleCodes).toEqual([...new Set(roleCodes)]);
  });

  it('автоприсоединяются только роли, которые не бывают содержательным листом', () => {
    // `signature_visual` — `false`, и это главное изменение после замера
    // корпуса: штамп ЭП печатается в подвале содержательных страниц
    // (сертификат «Листок жизни» стр. 45, его приложение стр. 46, разрешение
    // стр. 47, обе страницы АОСР). С `true` настоящий документ присоединялся
    // бы к предыдущему как служебный лист — восемь документов из трёх
    // комплектов.
    //
    // `blank` — `false`: пустая страница бывает разделителем (§8.2, фаза 3).
    expect(Object.fromEntries(roles.map((role) => [role.code, role.autoAttach]))).toEqual({
      blank: false,
      copy_stamp: true,
      signature_visual: false,
      annex_continuation: true,
      doc_continuation: true,
    });
  });

  it('все шаблоны компилируются', () => {
    for (const role of roles) {
      expect(() => compileAnchors(role.matchHints.anchors), role.code).not.toThrow();
      expect(() => compileAnchors(role.matchHints.negativeAnchors ?? []), role.code).not.toThrow();
      expect(() => compileAnchors(role.matchHints.bodyHints ?? []), role.code).not.toThrow();
    }
  });
});

/**
 * Проверка настоящим матчером, а не только компиляцией якорей.
 *
 * `matchPageRoles` подаёт якорю по одной нормализованной строке и не требует
 * совпадения с начала строки — поведение якоря роли по фрагменту текста иначе
 * не предскажешь. Фрагменты дословные, из `temp/MD/*_results.md`.
 */
describe('роли на фрагментах корпуса', () => {
  const codesOf = (text: string): string[] => matchPageRoles(text, roles).map((m) => m.code);

  it('штамп ЭП в подвале сертификата листом визуализации страницу не делает', () => {
    // Комплект 336, стр. 45: сертификат «Листок жизни» целиком, штамп внизу.
    const cert = [
      'СЕРТИФИКАТ',
      'СООТВЕТСТВИЯ',
      '№ РОСС RU.04ЧГ.ЭС413',
      'ОБЪЕКТ СЕРТИФИКАЦИИ',
      'Документ подписан электронной подписью',
      'Сертификат: 5145A30023B05AB540B6100EF9B72303',
    ].join('\n');

    expect(codesOf(cert)).toEqual([]);
  });

  it('отдельный лист со штампом ЭП роль получает', () => {
    const sheet = [
      'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
      'Сертификат: 0A1B2C3D4E5F60718293A4B5C6D7E8F9',
      'Владелец: Тестов Пётр',
      'Действителен с 03.06.2025 по 03.06.2026',
    ].join('\n');

    expect(codesOf(sheet)).toEqual(['signature_visual']);
  });

  it('многострочный заголовок приложения ловится по строке родителя', () => {
    // Комплект 336, стр. 28: «№» перед номером родителя нет, а сам номер —
    // на следующей строке. Одним якорём это не поймать, номер достаёт
    // сегментатор.
    const annex = [
      'Б № 000603',
      '##### ПРИЛОЖЕНИЕ № 1',
      'К СЕРТИФИКАТУ СООТВЕТСТВИЯ',
      'RU.СМИК.001.Н.00271',
    ].join('\n');
    const [match] = matchPageRoles(annex, roles);

    expect(match?.code).toBe('annex_continuation');
    expect(match?.parentRef).toBeUndefined();
  });

  it('номер родителя из той же строки захватывается', () => {
    // Комплект 336, стр. 46.
    const annex = ['#### ПРИЛОЖЕНИЕ', '№ 0413*', 'К сертификату соответствия № РОСС RU.04ЧГ.ЭС413']
      .join('\n')
      .concat('\n');

    expect(matchPageRoles(annex, roles)[0]?.parentRef).toBe('РОСС RU.04ЧГ.ЭС413');
  });

  it('упоминание приложения в теле документа роли не даёт', () => {
    // Три реальные строки корпуса, на которых якорь без привязки к началу
    // строки присоединил бы содержательный лист к предыдущему документу.
    expect(codesOf('(см. приложение к сертификату) и их производство')).toEqual([]);
    expect(
      codesOf('Декларация принята на основании документов, приложение №1 на 1-м листе'),
    ).toEqual([]);
    expect(
      codesOf('Приложение Б\nДОКУМЕНТ О КАЧЕСТВЕ БЕТОННОЙ СМЕСИ ПАРТИИ № АБ000000389'),
    ).toEqual([]);
  });

  it('маркер продолжения таблицы даёт doc_continuation', () => {
    // Комплект 336, стр. 11–17: техзаключение на 17 листах, таблица идёт
    // через пять страниц.
    expect(codesOf('Таблица 2\n\nпродолжение\n\n| Марка | Плотность |')).toEqual([
      'doc_continuation',
    ]);
  });

  it('«Всего на N страницах» продолжением не считается', () => {
    // Комплект 336, стр. 6 — ПЕРВАЯ страница заключения № 02(a)-2020.
    // Якорь на этой фразе присоединил бы титул 17-страничного документа
    // к предыдущему.
    const title = ['ЗАКЛЮЧЕНИЕ', '№ 02(a)-2020', 'Всего на 17 страницах, заверенных печатью'].join(
      '\n',
    );

    expect(codesOf(title)).toEqual([]);
  });

  it('колонцифра не делает страницу с текстом пустой', () => {
    // До отрицательного якоря `blank` срабатывал на 54 блоках из 158: строка
    // с номером страницы есть почти на каждом листе.
    expect(codesOf('СЕРТИФИКАТ КАЧЕСТВА № 2500037115\nПлавка 12345\n27')).toEqual([]);
    expect(codesOf('27')).toEqual(['blank']);
  });

  it('«КОПИЯ ВЕРНА», разорванная OCR на две строки, ловится', () => {
    // Комплект 336, стр. 65, 69 и 75.
    expect(codesOf('КОПИЯ\nВЕРНА\nООО "Тест-Строй"\nСамуиленко М. В.')).toEqual(['copy_stamp']);
  });
});

describe('якоря ролей на реальных фрагментах', () => {
  const matchAny = (patterns: readonly string[], text: string): RegExpExecArray | null => {
    for (const { regex } of compileAnchors(patterns)) {
      const match = regex.exec(text);
      if (match) {
        return match;
      }
    }
    return null;
  };

  const anchorsOf = (code: string): readonly string[] => {
    const role = PAGE_ROLES.find((r) => r.code === code);
    if (!role) {
      throw new Error(`Роль не найдена: ${code}`);
    }
    return role.matchHints.anchors;
  };

  it('blank ловит страницу без текста и одну колонцифру', () => {
    expect(matchAny(anchorsOf('blank'), '')).not.toBeNull();
    expect(matchAny(anchorsOf('blank'), '  \n \n')).not.toBeNull();
    expect(matchAny(anchorsOf('blank'), '\n27\n')).not.toBeNull();
  });

  it('blank не срабатывает на странице с текстом', () => {
    // Флаг `m` включён всегда, поэтому наивный `^\s*$` совпал бы с пустой
    // строкой внутри документа — эта проверка страхует именно от такого якоря.
    expect(
      matchAny(anchorsOf('blank'), 'СЕРТИФИКАТ СООТВЕТСТВИЯ\n\nБ № 000602\n\n27\n'),
    ).toBeNull();
  });

  it('copy_stamp и signature_visual ловят свои штампы', () => {
    const stamp = 'КОПИЯ ВЕРНА\nООО "Тест-Строй"\nТестов П. П.\n1B2C3D4E5F60718293A4B5C6D7E8F9A0';
    const sign =
      'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ\nСертификат: 2C3D4E5F607182939A0\n' +
      'Владелец: Тестов Пётр Петрович\nДействителен с 03.06.2025 по 03.06.2026';

    expect(matchAny(anchorsOf('copy_stamp'), stamp)).not.toBeNull();
    expect(matchAny(anchorsOf('signature_visual'), sign)).not.toBeNull();
  });

  it('annex_continuation захватывает номер документа-родителя', () => {
    const decl = 'Приложение № 1\nк декларации о соответствии № РОСС RU Д-RU.PA01.B.17254/23\n';
    const cert = 'ПРИЛОЖЕНИЕ\nк сертификату соответствия № RU.СМИК.001.Н.00271 от 25.05.2023\n';

    expect(matchAny(anchorsOf('annex_continuation'), decl)?.[1]).toBe(
      'РОСС RU Д-RU.PA01.B.17254/23',
    );
    expect(matchAny(anchorsOf('annex_continuation'), cert)?.[1]).toBe('RU.СМИК.001.Н.00271');
  });
});
