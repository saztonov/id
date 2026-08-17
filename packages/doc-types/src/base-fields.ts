/**
 * Базовые реквизиты доказательных документов.
 *
 * Извлечение двухуровневое (§8.4): базовая схема применяется ко ВСЕМ
 * доказательным документам, включая резервные и неопознанные типы, а
 * типо-специфичная — только при уверенно определённом типе. Именно это
 * позволяет проверить сроки и сверить с реестром приложений документ,
 * вид которого системе незнаком.
 */

import type { DocTypeKind, FieldDefinition } from './types.js';

/**
 * Обязательны только номер и дата выдачи — они есть у любого доказательного
 * документа. Остальное отсутствует штатно: у сертификата качества нет срока
 * действия, у сертификата соответствия — номера плавки. Требовать их значило
 * бы порождать ложные замечания на незнакомых разделах (§9.1).
 *
 * Выбор `extractor`: детерминированно берутся даты, номера, коды и партии —
 * у них есть форма. Наименования организаций и продукции идут через LLM,
 * потому что в документе они смешаны с адресами, телефонами и оговорками
 * («место нахождения», «адрес осуществления деятельности»), и границу
 * значения задаёт смысл, а не шаблон.
 */
export const BASE_EVIDENCE_FIELDS = [
  {
    code: 'number',
    label: 'Номер документа',
    type: 'text',
    required: true,
    extractor: 'rule',
  },
  {
    code: 'blank_number',
    label: 'Номер бланка',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'issued_at',
    label: 'Дата выдачи (регистрации)',
    type: 'date',
    required: true,
    extractor: 'rule',
  },
  {
    code: 'valid_from',
    label: 'Действителен с',
    type: 'date',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'valid_to',
    label: 'Действителен по',
    type: 'date',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'issuer',
    label: 'Организация, выдавшая документ',
    type: 'text',
    required: false,
    extractor: 'llm',
  },
  {
    code: 'issuer_accreditation',
    label: 'Аттестат (запись в реестре) об аккредитации',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'issuer_accreditation_valid_to',
    label: 'Аккредитация действительна до',
    type: 'date',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'applicant',
    label: 'Заявитель',
    type: 'text',
    required: false,
    extractor: 'llm',
  },
  {
    code: 'manufacturer',
    label: 'Изготовитель',
    type: 'text',
    required: false,
    extractor: 'llm',
  },
  {
    // ИНН — строка, а не число: ведущие нули значимы, а сверка идёт
    // по контрольной сумме и справочнику, а не по величине.
    code: 'manufacturer_inn',
    label: 'ИНН изготовителя',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'product_name',
    label: 'Наименование продукции',
    type: 'text',
    required: false,
    extractor: 'llm',
  },
  {
    code: 'product_marks',
    label: 'Марки (типы) продукции',
    type: 'list',
    required: false,
    extractor: 'llm',
  },
  {
    code: 'gost_tu',
    label: 'Нормативные документы (ГОСТ, СТО, ТУ)',
    type: 'list',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'okpd2',
    label: 'Код ОКПД 2',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'tnved',
    label: 'Код ТН ВЭД ЕАЭС',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'batch_no',
    label: 'Номер партии',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'heat_no',
    label: 'Номер плавки',
    type: 'text',
    required: false,
    extractor: 'rule',
  },
  {
    code: 'manufactured_at',
    label: 'Дата изготовления',
    type: 'date',
    required: false,
    extractor: 'rule',
  },
  {
    // «НА ОСНОВАНИИ» и «Доказательственные материалы» — сплошной абзац
    // из протоколов, актов и деклараций; разбор на элементы семантический.
    code: 'basis_documents',
    label: 'Документы, на основании которых выдан',
    type: 'list',
    required: false,
    extractor: 'llm',
  },
] as const satisfies readonly FieldDefinition[];

const BASE_FIELD_CODES: ReadonlySet<string> = new Set(
  BASE_EVIDENCE_FIELDS.map((field) => field.code),
);

/**
 * Эффективная схема реквизитов типа.
 *
 * Базовые поля получают `evidence` и `fallback`: неопознанный документ всё
 * равно должен отдать номер, даты и продукцию (§8.4). У `primary` (АОСР) и
 * `registry` (реестр приложений) реквизиты продукции и аккредитации смысла
 * не имеют — им возвращается только собственная схема.
 *
 * Порядок базовых полей сохраняется, специфичное определение с тем же `code`
 * встаёт на место базового: тип уточняет формулировку и обязательность, а не
 * добавляет второе поле с тем же кодом.
 */
export function fieldsForType(
  specific: readonly FieldDefinition[],
  kind: DocTypeKind,
): readonly FieldDefinition[] {
  if (kind === 'primary' || kind === 'registry') {
    return specific;
  }

  const overrides = new Map(specific.map((field) => [field.code, field]));
  const merged: FieldDefinition[] = BASE_EVIDENCE_FIELDS.map(
    (base) => overrides.get(base.code) ?? base,
  );

  const seen = new Set(BASE_FIELD_CODES);
  for (const field of specific) {
    if (seen.has(field.code)) {
      continue;
    }
    seen.add(field.code);
    merged.push(field);
  }

  return merged;
}
