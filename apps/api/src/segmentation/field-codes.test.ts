/**
 * Предохранитель, которого не было и который сделал дефект невидимым.
 *
 * ## Что именно он ловит
 *
 * До S27 правила чек-листа АОСР читали семь реквизитов по именам, которых нет
 * ни в схеме типа `aosr` в каталоге, ни в одном экстракторе: `date_start`,
 * `date_end`, `work_name`, `p4_annexes`, `rd_cipher`, `signers`, `contractor_*`.
 * Правила исправно исполнялись и никогда ничего не находили — на реальном
 * корпусе восемь правил акта отвечали `undetermined`, а `AOSR.HDR.020` выдавал
 * ТРИ ложные ошибки на каждый комплект.
 *
 * Существующие тесты этого не видели по построению: `aosr.test.ts` и
 * `known-defects.test.ts` сами кладут в граф те же коды, которые читает
 * правило. Такой тест доказывает согласованность теста с правилом — но не
 * правила с конвейером, а разошлись именно они.
 *
 * ## Почему тест живёт в apps/api, а не рядом с правилами
 *
 * Ему нужны обе стороны расхождения: имена реквизитов из пакета правил и
 * список реализованных экстракторов из соседнего `extract.ts`. Пакет `@id/api`
 * зависит от `@id/rules`, обратной зависимости нет и быть не должно — поэтому
 * единственное место, откуда видны оба конца, здесь.
 *
 * ## Почему проверка НЕ глобальная
 *
 * Соблазн проверить «каждый код каталога с `extractor: 'rule'` реализован»
 * велик и невыполним: таких кодов 125, реализовано 33. Остальные 92 относятся к
 * видам документов, которых портал ещё не видел, и их отсутствие — осознанное
 * решение (см. шапку `TYPE_RULES` в `extract.ts`): код без правила просто не
 * даёт значения, а догадка по имени поля выдала бы совпадение по названию за
 * извлечённый факт.
 *
 * Поэтому полнота проверяется ровно там, где от неё зависит работающее
 * правило, — на реквизитах акта.
 */
import { DOC_TYPES, fieldsForType } from '@id/doc-types';
import { ACT_FIELDS, ACT_FIELD_CODES, ACT_LEGACY_FIELD_CODES, actFieldCodes } from '@id/rules';
import { describe, expect, it } from 'vitest';

import { RULE_EXTRACTED_FIELDS } from './extract.js';

/** Схема типа `aosr` с базовыми реквизитами, как её видит извлечение. */
const ACT_SCHEMA = (() => {
  const definition = DOC_TYPES.find((type) => type.code === 'aosr');
  if (definition === undefined) throw new Error('в каталоге нет типа aosr');
  return fieldsForType(definition.fieldSchema, definition.kind);
})();

const ACT_SCHEMA_CODES = new Set(ACT_SCHEMA.map((field) => field.code));

describe('коды реквизитов акта согласованы с каталогом', () => {
  it.each(ACT_FIELD_CODES)('%s объявлен в схеме типа aosr', (code) => {
    expect(
      ACT_SCHEMA_CODES.has(code),
      `правила читают «${code}», но в схеме типа aosr такого реквизита нет: ` +
        'правило будет исполняться и никогда ничего не находить',
    ).toBe(true);
  });

  it('каждый реквизит акта с extractor=rule реализован в extract.ts', () => {
    const implemented = new Set(RULE_EXTRACTED_FIELDS);
    const declared = ACT_SCHEMA.filter(
      (field) => field.extractor === 'rule' && ACT_SCHEMA_CODES.has(field.code),
    );

    const missing = declared
      .filter((field) => (ACT_FIELD_CODES as readonly string[]).includes(field.code))
      .filter((field) => !implemented.has(field.code))
      .map((field) => field.code);

    expect(
      missing,
      'реквизиты акта объявлены детерминированными, но экстрактора у них нет — ' +
        'их не выдаст никто, и читающие их правила молча не работают',
    ).toStrictEqual([]);
  });
});

describe('группы совместимости не пересекаются с живыми кодами', () => {
  it.each(ACT_LEGACY_FIELD_CODES)('исторический %s не объявлен в схеме типа aosr', (code) => {
    // Исторический код, оказавшийся живым реквизитом схемы, дал бы ДВА значения
    // одного смысла с выбором по уверенности — то есть монетку. Именно поэтому
    // `p2_project_docs` и `p4_documents` историческими именами быть не могут:
    // оба объявлены в схеме как самостоятельные реквизиты.
    expect(
      ACT_SCHEMA_CODES.has(code),
      `«${code}» объявлен в схеме типа aosr и историческим именем быть не может`,
    ).toBe(false);
  });

  it('ни один исторический код не принадлежит двум группам', () => {
    const seen = new Map<string, string>();
    for (const canonical of ACT_FIELD_CODES) {
      for (const legacy of actFieldCodes(canonical).slice(1)) {
        const owner = seen.get(legacy);
        expect(owner, `«${legacy}» назван историческим и у «${owner}», и у «${canonical}»`).toBe(
          undefined,
        );
        seen.set(legacy, canonical);
      }
    }
  });

  it('канонический код не является историческим именем другого поля', () => {
    const legacy = new Set(ACT_LEGACY_FIELD_CODES);
    for (const code of ACT_FIELD_CODES) {
      expect(legacy.has(code), `«${code}» одновременно канонический и исторический`).toBe(false);
    }
  });
});

describe('таблица кодов акта покрывает пункты бланка', () => {
  it('пункты 1-7 и реквизиты сторон названы', () => {
    // Не декоративная проверка: список читается как оглавление бланка РД-11-02,
    // и выпавший из него пункт означает непроверяемый раздел акта.
    expect(Object.keys(ACT_FIELDS).sort()).toStrictEqual(
      [
        'actDate',
        'actNumber',
        'attachments',
        'contractorInn',
        'contractorName',
        'contractorOgrn',
        'dateEnd',
        'dateStart',
        'documents',
        'materials',
        'nextWorks',
        'objectName',
        'rdCipher',
        'registryRef',
        'workLocation',
        'workName',
        'worksPerformedBy',
      ].sort(),
    );
  });
});
