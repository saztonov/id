/**
 * Тесты обезличивателя.
 *
 * Входные данные повторяют структуру строк закрытого корпуса, но все реквизиты
 * и ФИО здесь вымышлены и вычислены под нужные контрольные суммы: настоящие
 * ПДн в git не попадают даже в виде тестовых фикстур.
 *
 * Главное, что проверяется, — обезличиватель не «чинит» дефекты: битый ОГРН из
 * 12 цифр обязан пережить обработку битым и двенадцатизначным, иначе
 * регрессионный тест на этот дефект станет бессмысленным.
 *
 * Судит о валидности `@id/contracts` — тот самый модуль, которым портал проверяет
 * реквизиты на входе и в правилах (§9.2). Своей проверки у теста нет намеренно: с
 * собственной копией он подтверждал бы согласие обезличивателя с самим собой, а
 * нужно согласие с порталом. Причём сравнивается ПРИЧИНА отказа, а не «невалидно»:
 * `length` — это дефект оформления документа (вердикт `fail`), а `checksum` —
 * дефект распознавания (`undetermined`), и подмена одного другим меняет смысл
 * замечания подрядчику.
 */
import { describe, it, expect } from 'vitest';
import { checkInn, checkOgrn, type IdentifierCheck, type IdentifierDefect } from '@id/contracts';
import { anonymizeText, containsPii } from './anonymize.js';

/** Реквизиты вымышлены; контрольные цифры посчитаны по официальному алгоритму. */
const VALID_INN_10 = '7712345671';
const INVALID_INN_10 = '7712345670';
const VALID_INN_12 = '771234567859';
const INVALID_INN_12 = '771234567850';
const VALID_OGRN_13 = '1234567890127';
const INVALID_OGRN_13 = '1234567890126';
const BROKEN_OGRN_12 = '123456789012';
const VALID_OGRN_15 = '123456789012343';

const SAMPLE = [
  '##### Застройщик, технический заказчик',
  '',
  `ООО "СЗ "АЛЬФА-АРЕНА", ОГРН ${VALID_OGRN_13}, ИНН ${VALID_INN_10}, 123456, Г.МОСКВА, УЛ. ПЕРВОМАЙСКАЯ, Д. 69/75, ПОМ I, ОФ 806, тел. 79001234567.`,
  `ООО "БЕТА-ПРОЕКТ", ОГРН ${BROKEN_OGRN_12}, ИНН ${VALID_INN_12}, 115114, Г.Москва, НАБ. РЕЧНАЯ, Д. 7, СТР. 9, тел. +7 (495) 111 22 33.`,
  'ИП Ковальчук Д. Е., ОГРНИП 123456789012343, ИНН / КПП: 7712345671 / 771201001.',
  '',
  'Главный инженер проекта Ковальчук Д. Е., приказ №28-04/25-02 от 28.04.2025',
  'Руководитель строительства Ковальчук Демьян Егорович',
  '',
  'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
  'Сертификат: 1A2B3C4D5E6F708192A3B4C5D6E7F801',
  'Владелец: Пилипенко Веньямин',
  'Действителен с 23.05.2025 по 23.08.2026',
  'Контакты: pilipenko.v@example-supplier.ru, +7 484 396 85 82',
  '',
  'Техноэласт ЭПП Сертификат соответствия №04УПС45.RU.C00022 с 19.11.2024 по 18.11.2027, Паспорт качества №491 от 01.02.2026',
  'Арматура А500С ГОСТ 34028-2016, СТО 36554501-021-2011, партия №25448 от 26.12.2025, плавка 123456, ОКПД2 24.10.62.110, ТН ВЭД 7214200000',
  '### BLOCK #1 [TEXT]: blk_3e200f327b7046049b4a7242f35f446f',
].join('\n');

/** Достаёт значение реквизита по метке. */
function requisite(text: string, label: string): string {
  const match = new RegExp(`${label}[^0-9\\n]{0,4}(\\d+)`).exec(text);
  return match?.[1] ?? '';
}

function anonymizeRequisite(label: string, value: string): string {
  return requisite(anonymizeText(`${label} ${value}`), label);
}

/** Причина отказа либо `null` у принятого значения: причины сравниваются прямо. */
function defectOf(result: IdentifierCheck): IdentifierDefect | null {
  return result.ok ? null : result.defect;
}

describe('обезличиватель корпуса', () => {
  it('детерминирован: два прогона дают одинаковый результат', () => {
    expect(anonymizeText(SAMPLE)).toBe(anonymizeText(SAMPLE));
  });

  it('seed меняет результат, но каждый seed сам по себе стабилен', () => {
    const a = anonymizeText(SAMPLE, { seed: 'a' });
    const b = anonymizeText(SAMPLE, { seed: 'b' });
    expect(a).not.toBe(b);
    expect(anonymizeText(SAMPLE, { seed: 'a' })).toBe(a);
  });

  describe('контрольные суммы ИНН', () => {
    it('валидный ИНН из 10 цифр заменяется на валидный', () => {
      const result = anonymizeRequisite('ИНН', VALID_INN_10);
      expect(result).toHaveLength(10);
      expect(result).not.toBe(VALID_INN_10);
      expect(checkInn(result)).toEqual({ ok: true });
    });

    it('невалидный ИНН из 10 цифр остаётся невалидным С ТОЙ ЖЕ ПРИЧИНОЙ', () => {
      expect(defectOf(checkInn(INVALID_INN_10))).toBe('checksum');
      const result = anonymizeRequisite('ИНН', INVALID_INN_10);
      expect(result).toHaveLength(10);
      expect(defectOf(checkInn(result))).toBe(defectOf(checkInn(INVALID_INN_10)));
    });

    it('валидный ИНН из 12 цифр заменяется на валидный', () => {
      const result = anonymizeRequisite('ИНН', VALID_INN_12);
      expect(result).toHaveLength(12);
      expect(result).not.toBe(VALID_INN_12);
      expect(checkInn(result)).toEqual({ ok: true });
    });

    it('невалидный ИНН из 12 цифр остаётся невалидным С ТОЙ ЖЕ ПРИЧИНОЙ', () => {
      expect(defectOf(checkInn(INVALID_INN_12))).toBe('checksum');
      const result = anonymizeRequisite('ИНН', INVALID_INN_12);
      expect(result).toHaveLength(12);
      expect(defectOf(checkInn(result))).toBe(defectOf(checkInn(INVALID_INN_12)));
    });
  });

  describe('контрольные суммы ОГРН', () => {
    it('валидный ОГРН из 13 цифр заменяется на валидный', () => {
      const result = anonymizeRequisite('ОГРН', VALID_OGRN_13);
      expect(result).toHaveLength(13);
      expect(result).not.toBe(VALID_OGRN_13);
      expect(checkOgrn(result)).toEqual({ ok: true });
    });

    it('невалидный ОГРН из 13 цифр остаётся невалидным по контрольной сумме', () => {
      expect(defectOf(checkOgrn(INVALID_OGRN_13))).toBe('checksum');
      expect(defectOf(checkOgrn(anonymizeRequisite('ОГРН', INVALID_OGRN_13)))).toBe('checksum');
    });

    it('валидный ОГРНИП из 15 цифр заменяется на валидный', () => {
      // Делитель 15-значного — 13, а не 11. Реализация, применившая к ОГРНИП
      // правило 13-значного, закрепила бы в корпусе «невалидность» настоящего
      // реквизита — и проверять корпус стало бы нечем.
      const result = anonymizeRequisite('ОГРНИП', VALID_OGRN_15);
      expect(result).toHaveLength(15);
      expect(checkOgrn(result)).toEqual({ ok: true });
    });

    it('битый ОГРН из 12 цифр остаётся из 12 цифр и битым ИМЕННО ПО ДЛИНЕ', () => {
      // Тот самый дефект корпуса, ради которого модуль писался. Причина обязана
      // остаться `length`: подмена на `checksum` превратила бы дефект оформления
      // документа (`fail`) в дефект распознавания (`undetermined`).
      expect(defectOf(checkOgrn(BROKEN_OGRN_12))).toBe('length');
      const result = anonymizeRequisite('ОГРН', BROKEN_OGRN_12);
      expect(result).toHaveLength(12);
      expect(result).not.toBe(BROKEN_OGRN_12);
      expect(defectOf(checkOgrn(result))).toBe('length');
    });

    it('битый ОГРН переживает обработку и в составе полной строки', () => {
      const result = anonymizeText(SAMPLE);
      const value = requisite(result.split('\n')[3] ?? '', 'ОГРН');
      expect(value).toHaveLength(12);
      expect(defectOf(checkOgrn(value))).toBe('length');
    });

    it('две причины отказа не сливаются в одну на обезличенных значениях', () => {
      // Если бы обезличиватель судил своей копией арифметики, здесь и была бы
      // точка расхождения: оба значения «невалидны», но вердикты у них разные.
      const byLength = anonymizeRequisite('ОГРН', BROKEN_OGRN_12);
      const bySum = anonymizeRequisite('ОГРН', INVALID_OGRN_13);
      expect(defectOf(checkOgrn(byLength))).not.toBe(defectOf(checkOgrn(bySum)));
    });
  });

  describe('не трогает то, на чём держатся тесты сверки', () => {
    const result = anonymizeText(SAMPLE);

    it.each([
      ['номер сертификата соответствия', '№04УПС45.RU.C00022'],
      ['срок действия сертификата', 'с 19.11.2024 по 18.11.2027'],
      ['номер паспорта качества', '№491 от 01.02.2026'],
      ['ГОСТ', 'ГОСТ 34028-2016'],
      ['СТО', 'СТО 36554501-021-2011'],
      ['номер партии', 'партия №25448 от 26.12.2025'],
      ['номер плавки', 'плавка 123456'],
      ['ОКПД2', 'ОКПД2 24.10.62.110'],
      ['ТН ВЭД', 'ТН ВЭД 7214200000'],
      ['наименование продукции', 'Арматура А500С'],
      ['номер приказа и дата', 'приказ №28-04/25-02 от 28.04.2025'],
      ['срок действия подписи', 'Действителен с 23.05.2025 по 23.08.2026'],
      ['идентификатор блока разметки', 'blk_3e200f327b7046049b4a7242f35f446f'],
    ])('%s не изменился', (_name, fragment) => {
      expect(result).toContain(fragment);
    });
  });

  describe('замены', () => {
    const result = anonymizeText(SAMPLE);

    it('серийный номер ЭП заменён на строку той же длины', () => {
      const match = /Сертификат: ([0-9A-Fa-f]+)/.exec(result);
      expect(match?.[1]).toHaveLength(32);
      expect(match?.[1]).not.toBe('1A2B3C4D5E6F708192A3B4C5D6E7F801');
    });

    it('телефон заменён, соседняя дата — нет', () => {
      expect(result).not.toContain('79001234567');
      expect(result).not.toContain('+7 (495) 111 22 33');
      expect(result).toContain('от 28.04.2025');
    });

    it('почтовый индекс, улица и номер дома заменены', () => {
      expect(result).not.toContain('123456, Г.МОСКВА');
      expect(result).not.toContain('115114');
      expect(result).toMatch(/0\d{5}, Г\.МОСКВА/);
      expect(result).not.toContain('ПЕРВОМАЙСКАЯ');
      expect(result).not.toContain('Д. 69/75');
      expect(result).toMatch(/УЛ\. [А-ЯЁ]+/);
    });

    it('адрес правится только там, где он есть: «д.8» диаметра не трогается', () => {
      const line = 'Сертификат качества; Арматура А240С, д.8, плавка 123456';
      expect(anonymizeText(line)).toBe(line);
    });

    it('адрес электронной почты уходит в зарезервированный домен', () => {
      const out = anonymizeText('Контакт: pilipenko.v@example-supplier.ru, тел. 79001234567');
      expect(out).not.toContain('pilipenko.v@example-supplier.ru');
      expect(out).toContain('@example.invalid');
    });

    it('одна и та же фамилия в разных местах заменяется одинаково', () => {
      const lines = result.split('\n');
      const withInitials = /проекта (\S+) /.exec(lines[6] ?? '')?.[1];
      const withPatronymic = /строительства (\S+) /.exec(lines[7] ?? '')?.[1];
      expect(withInitials).toBeDefined();
      expect(withInitials).not.toBe('Ковальчук');
      expect(withInitials).toBe(withPatronymic);
    });

    it('инициалы согласованы с полной формой имени и отчества', () => {
      const lines = result.split('\n');
      const initials = /проекта \S+ ([А-ЯЁ])\. ([А-ЯЁ])\./.exec(lines[6] ?? '');
      const full = /строительства \S+ (\S+) (\S+)/.exec(lines[7] ?? '');
      expect(initials).not.toBeNull();
      expect(full).not.toBeNull();
      expect(full?.[1]?.charAt(0)).toBe(initials?.[1]);
      expect(full?.[2]?.charAt(0)).toBe(initials?.[2]);
    });

    it('двухсловное ФИО владельца сертификата заменено', () => {
      expect(result).not.toContain('Пилипенко');
      expect(result).toMatch(/Владелец: [А-ЯЁ][а-яё]+ [А-ЯЁ][а-яё]+$/m);
    });
  });

  describe('containsPii', () => {
    it('на обезличенном тексте возвращает clean: true', () => {
      const report = containsPii(anonymizeText(SAMPLE));
      expect(report.findings).toEqual([]);
      expect(report.clean).toBe(true);
    });

    it('на исходном тексте находит ФИО, ИНН, ОГРН и адрес', () => {
      const report = containsPii(SAMPLE);
      expect(report.clean).toBe(false);
      const kinds = new Set(report.findings.map((finding) => finding.split(':')[0]));
      expect(kinds).toContain('ФИО');
      expect(kinds).toContain('ИНН');
      expect(kinds).toContain('ОГРН');
      expect(kinds).toContain('почтовый индекс');
      expect(kinds).toContain('улица');
      expect(kinds).toContain('телефон');
      expect(kinds).toContain('сертификат ЭП');
      expect(kinds).toContain('электронная почта');
    });

    it('чистый технический текст без ПДн проходит проверку', () => {
      const report = containsPii(
        'Арматура А500С ГОСТ 34028-2016, партия №25448 от 26.12.2025, плавка 123456',
      );
      expect(report.findings).toEqual([]);
    });
  });
});
