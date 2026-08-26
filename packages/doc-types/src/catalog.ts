/**
 * Каталог видов исполнительной документации.
 *
 * Источник состава — §8.1 плана. Пометка `observedInCorpus: true` стоит только
 * у типов, реально встреченных в корпусе двух разделов (кровля автостоянки и
 * несущие ЖБ конструкции). У остальных якоря и схемы полей — гипотезы из
 * нормативного состава, подлежащие калибровке при появлении новых разделов.
 *
 * Якоря — строки-исходники регулярных выражений; применяет их `matchDocTypes()`
 * из `matching.ts`, и его семантика диктует, как якорь обязан быть написан:
 *
 * - якорь проверяется на ОТДЕЛЬНОЙ строке, уже нормализованной: markdown-префиксы
 *   (`#####`, `>`, `*`, `-`), символы акцента и обрамляющие `|` сняты, пробелы
 *   схлопнуты. Поэтому `^\s*` и любые упоминания `#` в якоре бессмысленны;
 * - совпадение обязано начинаться с начала строки (`m.index === 0`), поэтому
 *   ведущий `^` избыточен, а завершающий `$` ломает совпадение: после заголовка
 *   почти всегда идёт номер или дата;
 * - после совпадения допускается хвост не длиннее 80 символов — это и отличает
 *   заголовок «ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б» от строки реестра
 *   «13 Документ о качестве; Раствор М-150 №АБС00001381 ООО "АБС Групп"»;
 * - якоря ищутся только в первых 20 строках блока (зона заголовка), а
 *   `bodyHints` — по всему блоку, но сами по себе тип не присваивают: они лишь
 *   повышают уверенность у типа, чей якорь уже сработал. `bodyHints` при этом
 *   компилируются без флага `m`, так что `^`/`$` в них означали бы границы
 *   всего блока; «строка целиком» выражается через явные `\n`.
 */

import type { DocTypeDefinition, FieldDefinition, FieldExtractor, FieldType } from './types.js';

/**
 * Компактный конструктор реквизита.
 *
 * Позиционный, потому что каталог содержит несколько сотен полей и запись
 * объектными литералами раздувает файл втрое без выигрыша в читаемости.
 *
 * @param code машинный код реквизита, уникальный внутри своего типа
 * @param label подпись для UI
 * @param type тип значения
 * @param required обязателен ли реквизит для валидного документа
 * @param extractor чем извлекается: детерминированным парсером или моделью
 */
const field = (
  code: string,
  label: string,
  type: FieldType,
  required: boolean,
  extractor: FieldExtractor,
): FieldDefinition => ({ code, label, type, required, extractor });

export const DOC_TYPES = [
  // ── Акты освидетельствования и приёмки ────────────────────────────────────
  {
    code: 'aosr',
    name: 'Акт освидетельствования скрытых работ',
    shortName: 'АОСР',
    group: 'acts',
    kind: 'primary',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Одинокое «АКТ» якорем быть не может: оно притянуло бы любой другой акт,
      // а мир открытый и таких актов много. В бланке РД-11-02 заголовок вообще
      // разбит на две строки — «АКТ» и «освидетельствования скрытых работ», —
      // и различает акт именно вторая.
      // Две записи одного титула, а не одна с необязательным словом. Рендер
      // RD WEB разбивает заголовок бланка на две строки — «АКТ» и
      // «освидетельствования скрытых работ», — и якорь совпадает со второй
      // целиком. Рендер VLM склеивает их в одну строку «АКТ освидетельствования
      // скрытых работ»: там совпадение начинается с индекса 4, а `matchesAsHeading`
      // требует начала строки, и тип не присваивался вовсе (`typeOutcome: none`,
      // `confidence 0.00` в проде). Явная альтернатива закрывает второй рендер,
      // не расширяя поведение остальных типов каталога.
      anchors: [
        'освидетельствовани[яе]\\s+скрытых\\s+работ',
        'АКТ\\s+освидетельствовани[яе]\\s+скрытых\\s+работ',
      ],
      // В бланке по приказу №344/пр титул идёт ПОСЛЕ шапки с объектом и всеми
      // участниками: на пяти актах temp/MD/new якорная строка — 28–31-я, то
      // есть за пределами общего окна в 20 строк. Окно расширено только этому
      // типу: глобальные 40 строк на том же замере дали ложные типы
      // (quality_passport → declaration на упоминании в глубине страницы).
      headingLines: 40,
      bodyHints: [
        // Подсказка «строка целиком состоит из слова АКТ». Через `\n`, а не
        // через `^…$`: bodyHints компилируются без флага `m`.
        '\\nАКТ\\n',
        'К\\s+освидетельствованию\\s+предъявлены\\s+следующие\\s+работы',
        'произвели\\s+осмотр\\s+работ,\\s*выполненных',
        'Разрешается\\s+производство\\s+последующих\\s+работ',
      ],
    },
    fieldSchema: [
      // `act_number` и `act_date` — поля бланка АОСР, а не базовые реквизиты
      // доказательного документа из base-fields.ts: у акта они участвуют в
      // проверке AOSR.ACT (act.date >= date_end >= date_start) и в шаблоне номера.
      field('object_name', 'Объект капитального строительства', 'text', true, 'llm'),
      field('developer', 'Застройщик, технический заказчик', 'text', true, 'llm'),
      field('builder', 'Лицо, осуществляющее строительство', 'text', true, 'llm'),
      field('designer', 'Лицо, осуществляющее подготовку ПД', 'text', true, 'llm'),
      // Реквизиты ЛИЦА, ВЫПОЛНИВШЕГО РАБОТЫ, отдельными полями: их читают
      // AOSR.HDR.020–023 (заполненность, контрольные суммы, сверка тройки со
      // справочником), и до S27 этих кодов не было в каталоге вовсе — правила
      // работали и никогда ничего не находили.
      //
      // Извлечение только моделью, и это не осторожность, а необходимость: в
      // шапке РД-11-02 ИНН и ОГРН напечатаны у ЧЕТЫРЁХ участников подряд
      // (застройщик, техзаказчик, строительство, подрядчик). Шаблон `ИНН\s*(\d+)`
      // взял бы первый попавшийся, выдал бы ИНН застройщика за ИНН подрядчика с
      // пометкой `extractedBy: 'rule'` — и AOSR.HDR.023 объявил бы расхождение
      // со справочником. Значение, выглядящее проверенным фактом и им не
      // являющееся, — худший вид дефекта (см. шапку `extract.ts`).
      field('contractor_name', 'Лицо, выполнившее работы: наименование', 'text', true, 'llm'),
      field('contractor_inn', 'Лицо, выполнившее работы: ИНН', 'text', true, 'llm'),
      field('contractor_ogrn', 'Лицо, выполнившее работы: ОГРН', 'text', true, 'llm'),
      // `act_number` и приказы подписантов переведены с `rule` на `llm` (S27):
      // детерминированного экстрактора у них не было ни одного, то есть их не
      // выдавал никто, а объявление `rule` обещало обратное. Номер акта на
      // бланке стоит рядом с титулом и различается по нему, приказ — внутри
      // строки подписанта; и то и другое читается по ЯРЛЫКУ, а не по форме.
      field('act_number', 'Номер акта', 'text', true, 'llm'),
      field('act_date', 'Дата составления акта', 'date', true, 'rule'),
      field('rep_developer', 'Представитель застройщика по стройконтролю', 'text', true, 'llm'),
      field('rep_developer_nrs', 'НРС представителя застройщика', 'text', false, 'llm'),
      field('rep_developer_order', 'Приказ представителя застройщика', 'text', true, 'llm'),
      field('rep_builder', 'Представитель лица, осуществляющего стр-во', 'text', true, 'llm'),
      field('rep_builder_order', 'Приказ представителя строительства', 'text', true, 'llm'),
      field('rep_builder_control', 'Представитель строительства по СК', 'text', true, 'llm'),
      field('rep_builder_control_nrs', 'НРС представителя по стройконтролю', 'text', false, 'llm'),
      field('rep_builder_control_order', 'Приказ представителя по СК', 'text', true, 'llm'),
      field('rep_designer', 'Представитель проектировщика, авторский надзор', 'text', false, 'llm'),
      field('rep_designer_order', 'Приказ представителя проектировщика', 'text', false, 'llm'),
      field('rep_contractor', 'Представитель лица, выполнившего работы', 'text', true, 'llm'),
      field('rep_contractor_order', 'Приказ представителя подрядчика', 'text', false, 'llm'),
      field('works_performed_by', 'Лицо, выполнившее работы', 'text', true, 'llm'),
      field('p1_works', 'п. 1: предъявленные к освидетельствованию работы', 'text', true, 'llm'),
      field('p1_location', 'п. 1: привязка — оси, отметки, захватки', 'text', false, 'llm'),
      field('p2_project_docs', 'п. 2: проектная документация и изменение', 'list', true, 'llm'),
      field('p3_materials', 'п. 3: применённые материалы и документы', 'list', true, 'llm'),
      field('p3_registry_ref', 'п. 3: ссылка на реестр приложений', 'text', false, 'rule'),
      field('p4_documents', 'п. 4: предъявленные подтверждающие документы', 'list', true, 'llm'),
      field('p5_date_start', 'п. 5: дата начала работ', 'date', true, 'rule'),
      field('p5_date_end', 'п. 5: дата окончания работ', 'date', true, 'rule'),
      field('p6_compliance_docs', 'п. 6: нормативные и проектные документы', 'list', true, 'llm'),
      field('p7_next_works', 'п. 7: разрешённые последующие работы', 'text', true, 'llm'),
      field('additional_info', 'Дополнительные сведения', 'text', false, 'llm'),
      field('copies_count', 'Количество экземпляров акта', 'number', false, 'llm'),
      field('annexes', 'Приложения', 'list', true, 'llm'),
    ],
    sortOrder: 10,
  },
  {
    code: 'aosr_responsible_structures',
    name: 'Акт освидетельствования ответственных конструкций',
    shortName: 'АООК',
    group: 'acts',
    kind: 'primary',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['освидетельствовани[яе]\\s+ответственных\\s+конструкций'],
      bodyHints: ['\\nАКТ\\n', 'к\\s+приемке\\s+предъявлены\\s+следующие\\s+конструкции'],
    },
    fieldSchema: [
      field('structures', 'Предъявленные ответственные конструкции', 'text', true, 'llm'),
      field('location', 'Привязка — оси, отметки, этаж', 'text', false, 'llm'),
      field('date_start', 'Дата начала работ', 'date', true, 'rule'),
      field('date_end', 'Дата окончания работ', 'date', true, 'rule'),
      field('next_works', 'Разрешённые последующие работы', 'text', false, 'llm'),
    ],
    sortOrder: 20,
  },
  {
    code: 'aosr_networks',
    name: 'Акт освидетельствования участков сетей инженерно-технического обеспечения',
    shortName: 'Акт участка сетей',
    group: 'acts',
    kind: 'primary',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'освидетельствовани[яе]\\s+участков\\s+сетей\\s+инженерно[\\s-]технического\\s+обеспечения',
      ],
      bodyHints: ['\\nАКТ\\n', 'участок\\s+сети'],
    },
    fieldSchema: [
      field('network_kind', 'Вид сети', 'text', true, 'llm'),
      field('section', 'Участок сети — от, до, протяжённость', 'text', true, 'llm'),
      field('date_start', 'Дата начала работ', 'date', true, 'rule'),
      field('date_end', 'Дата окончания работ', 'date', true, 'rule'),
    ],
    sortOrder: 30,
  },
  {
    code: 'act_geodetic_base',
    name: 'Акт приёмки геодезической разбивочной основы',
    shortName: 'Акт ГРО',
    group: 'acts',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        '(разбивки|приемки|приёмки)\\s+геодезической\\s+разбивочной\\s+основы',
        'геодезическ(ой|ая)\\s+разбивочн(ой|ая)\\s+основ',
      ],
      bodyHints: ['пункт[ыа]\\s+закреплени', 'координаты', 'реперы'],
    },
    fieldSchema: [
      field('points', 'Переданные пункты и знаки', 'table', true, 'llm'),
      field('coordinate_system', 'Система координат и высот', 'text', false, 'rule'),
    ],
    sortOrder: 40,
  },
  {
    code: 'act_axes_layout',
    name: 'Акт разбивки осей объекта на местности',
    shortName: 'Акт разбивки осей',
    group: 'acts',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['разбивк[аи]\\s+ос(ей|ных\\s+линий)\\s+объекта', 'АКТ\\s+разбивки\\s+осей'],
      bodyHints: ['вынос\\s+в\\s+натуру', 'знаки\\s+закрепления\\s+осей'],
    },
    fieldSchema: [
      field('axes', 'Закреплённые оси', 'list', true, 'llm'),
      field('marks', 'Знаки закрепления', 'table', false, 'llm'),
    ],
    sortOrder: 50,
  },
  {
    code: 'act_incoming_control',
    name: 'Акт входного контроля материалов и изделий',
    shortName: 'Акт входного контроля',
    group: 'acts',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['входного\\s+контроля'],
      bodyHints: ['поступил[аи]\\s+на\\s+объект', 'сопроводительн(ая|ые)\\s+документаци'],
    },
    fieldSchema: [
      field('items', 'Проверенные материалы и изделия', 'table', true, 'llm'),
      field('verdict', 'Решение по результатам контроля', 'text', true, 'llm'),
    ],
    sortOrder: 60,
  },
  {
    code: 'act_formwork',
    name: 'Акт освидетельствования опалубки',
    shortName: 'Акт опалубки',
    group: 'acts',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['(освидетельствовани[яе]|приемки|приёмки)\\s+опалубки', 'опалубочных\\s+работ'],
      bodyHints: ['геометрические\\s+размеры', 'отклонения\\s+от\\s+проектного\\s+положения'],
    },
    fieldSchema: [
      field('structure', 'Конструкция, для которой смонтирована опалубка', 'text', true, 'llm'),
      field('formwork_system', 'Тип опалубочной системы', 'text', false, 'llm'),
      field('deviations', 'Фактические отклонения', 'table', false, 'llm'),
    ],
    sortOrder: 70,
  },
  {
    code: 'act_piles_acceptance',
    name: 'Акт приёмки свайного поля',
    shortName: 'Акт приёмки свай',
    group: 'acts',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        '(приемки|приёмки)\\s+сва(й|йного\\s+поля)',
        'сводная\\s+ведомость\\s+(забитых|погруженных|устроенных)\\s+свай',
      ],
      bodyHints: ['отказ\\s+сваи', 'проектная\\s+отметка\\s+острия'],
    },
    fieldSchema: [
      field('piles', 'Ведомость свай', 'table', true, 'llm'),
      field('pile_type', 'Тип и сечение свай', 'text', true, 'llm'),
    ],
    sortOrder: 80,
  },
  {
    code: 'other_acts',
    name: 'Иной акт, тип не определён',
    shortName: 'Иной акт',
    group: 'acts',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 90,
  },

  // ── Исполнительные схемы ──────────────────────────────────────────────────
  //
  // ВНИМАНИЕ: `exec_scheme` текстом не определяется. Все четыре листа
  // исполнительных схем в корпусе (01-ДК2-СЦ, стр. 3, 5, 7 и 10-ДК2-ГИ, стр. 3)
  // не содержат слов «исполнительная схема» ни в тексте, ни в штампе листа: на
  // странице только чертёж, легенда «УСЛОВНЫЕ ОБОЗНАЧЕНИЯ» и штамп. Присваивать
  // тип обязан классификатор по составу блоков страницы — наличие `image` рядом
  // со `stamp` при отсутствующем заголовке. Это задача этапа S8, и до неё схемы
  // остаются неопознанными; якоря ниже оставлены под настоящий заголовок схемы
  // на случай других разделов и в наблюдаемом корпусе не срабатывают ни разу.
  {
    code: 'exec_scheme',
    name: 'Исполнительная схема',
    shortName: 'Исп. схема',
    group: 'exec_schemes',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['исполнительн\\S*\\s+(геодезическ\\S*\\s+)?схем', 'исполнительн\\S*\\s+съемк'],
      // Отрицательные якоря отсекают не «похожий тип», а страницу-источник
      // упоминания. Схема упоминается в бланке АОСР (п. 4 «Предъявлены
      // документы…») и в реестре приложений — там она названа по имени, но
      // самой схемой такая страница не является.
      negativeAnchors: [
        '(\\d+\\.\\s*)?Предъявлены\\s+документы,?\\s+подтверждающие',
        'Реестр\\s+приложений',
      ],
      bodyHints: [
        'УСЛОВНЫЕ\\s+ОБОЗНАЧЕНИЯ',
        'Зона\\s+выполненных\\s+работ',
        'Объ[её]м\\s+выполненных\\s+работ',
        'в/о\\s+\\S+',
        'на\\s+отм\\.',
      ],
    },
    fieldSchema: [
      field('scheme_title', 'Наименование схемы', 'text', true, 'llm'),
      field('scheme_number', 'Шифр схемы', 'text', true, 'rule'),
      field('axes', 'Оси', 'list', false, 'llm'),
      field('elevations', 'Отметки', 'list', false, 'llm'),
      field('work_volume', 'Объём выполненных работ', 'text', false, 'llm'),
      field('executor', 'Организация, составившая схему', 'text', true, 'llm'),
      field('sheet_no', 'Номер листа схемы', 'text', false, 'rule'),
    ],
    sortOrder: 100,
  },
  {
    code: 'exec_scheme_base',
    name: 'Исполнительная схема геодезической разбивочной основы',
    shortName: 'Исп. схема ГРО',
    group: 'exec_schemes',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'исполнительн\\S*\\s+схем\\S*\\s+геодезическо[йг]\\S*\\s+разбивочно[йг]\\S*\\s+основ',
        'схема\\s+геодезической\\s+разбивочной\\s+основы',
      ],
    },
    fieldSchema: [
      field('points', 'Пункты основы с координатами', 'table', true, 'llm'),
      field('coordinate_system', 'Система координат и высот', 'text', false, 'rule'),
    ],
    sortOrder: 110,
  },
  {
    code: 'exec_master_plan',
    name: 'Исполнительный генеральный план',
    shortName: 'Исп. генплан',
    group: 'exec_schemes',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'исполнительн\\S*\\s+генеральн\\S*\\s+план',
        'исполнительн\\S*\\s+съемк\\S*\\s+генплана',
      ],
    },
    fieldSchema: [
      field('plan_number', 'Шифр генплана', 'text', true, 'rule'),
      field('surveyed_objects', 'Снятые объекты', 'list', false, 'llm'),
    ],
    sortOrder: 120,
  },
  {
    code: 'exec_piles',
    name: 'Исполнительная схема свайного поля',
    shortName: 'Исп. схема свай',
    group: 'exec_schemes',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'исполнительн\\S*\\s+схем\\S*\\s+сва',
        'схема\\s+(фактического\\s+)?расположения\\s+свай',
      ],
      bodyHints: ['отклонение\\s+в\\s+плане', 'номер\\s+сваи'],
    },
    fieldSchema: [
      field('piles', 'Сваи с фактическими отклонениями', 'table', true, 'llm'),
      field('tolerance', 'Допустимое отклонение по проекту', 'text', false, 'llm'),
    ],
    sortOrder: 130,
  },
  {
    code: 'exec_networks',
    name: 'Исполнительная схема инженерных сетей',
    shortName: 'Исп. схема сетей',
    group: 'exec_schemes',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'исполнительн\\S*\\s+схем\\S*\\s+(наружн\\S*\\s+)?(сет|трубопровод|кабельн|воздуховод)',
        'исполнительн\\S*\\s+съемк\\S*\\s+сетей',
      ],
    },
    fieldSchema: [
      field('network_kind', 'Вид сети', 'text', true, 'llm'),
      field('section', 'Участок — от, до, протяжённость', 'text', true, 'llm'),
      field('depths', 'Отметки заложения', 'list', false, 'llm'),
    ],
    sortOrder: 140,
  },
  {
    code: 'other_exec_schemes',
    name: 'Иная исполнительная схема, тип не определён',
    shortName: 'Иная исп. схема',
    group: 'exec_schemes',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 150,
  },

  // ── Реестры и журналы ─────────────────────────────────────────────────────
  {
    code: 'annex_registry',
    name: 'Реестр приложений к акту',
    shortName: 'Реестр приложений',
    group: 'registries_logs',
    kind: 'registry',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Только форма «…к акту»: одинокое «Реестр приложений №1» — это строка
      // раздела «Приложения:» на второй странице самого акта, она есть на
      // 100% АОСР и типизировала реестром сам акт.
      //
      // Второй якорь — форма temp/MD/new: «Реестр № 1 к АОСР №…», «Реестр № 2
      // к №МР/ОВ1/От/32…». Обязательное «к АОСР/акту/№» отличает заголовок от
      // упоминания «Реестр №2 от 31.12.2024 г.» в п. 3–4 самого акта.
      anchors: [
        'Реестр\\s+приложений.{0,20}к\\s+акту',
        'Реестр\\s*№\\s*[\\d.]+\\s+к\\s+(?:АОСР|акту|№)',
      ],
      bodyHints: [
        '№\\s*чертежа,\\s*акта,\\s*разрешения',
        'Организация,\\s*составившая\\s+документ',
        'Документы,\\s*подтверждающие\\s+качество\\s+применяемых\\s+материалов',
      ],
    },
    fieldSchema: [
      field('registry_number', 'Номер реестра', 'text', true, 'rule'),
      field('act_number', 'Номер акта, к которому составлен реестр', 'text', true, 'rule'),
      field('act_date', 'Дата акта', 'date', true, 'rule'),
      field('object_name', 'Объект', 'text', true, 'llm'),
      field('sections', 'Разделы реестра', 'list', false, 'llm'),
      field('entries', 'Строки реестра: наименование, номер, организация', 'table', true, 'rule'),
    ],
    sortOrder: 160,
  },
  {
    // Сопроводительный реестр передачи папки ИД («Реестр исполнительной
    // документации», опись + объёмы + Сдал/Принял). Наблюдён в temp/MD/new
    // (Реестр_передачи_папки_№27); в эталонный корпус двух разделов не входит,
    // поэтому observedInCorpus остаётся false.
    code: 'transfer_registry',
    name: 'Реестр передачи исполнительной документации',
    shortName: 'Реестр передачи',
    group: 'registries_logs',
    kind: 'registry',
    hasAnnexes: false,
    isFallback: false,
    // Наблюдён в корпусе двумя формами: пятиграфной (группа — строка с «№ п/п»)
    // и восьмиграфной (группа — слитый баннер «работа (исполнитель)»). Обе
    // разбирает `transfer-registry.ts` начиная с S20.
    observedInCorpus: true,
    matchHints: {
      anchors: ['Реестр\\s+(?:передачи\\s+)?исполнительной\\s+документации'],
      bodyHints: [
        'Сдал[:\\s]',
        'Принял[:\\s]',
        'Кол-во\\s+экз',
        'передан\\S*\\s+данным\\s+реестром',
      ],
    },
    fieldSchema: [
      field('folder_ref', 'Номер папки или раздела', 'text', false, 'llm'),
      field('transfer_date', 'Дата передачи', 'date', false, 'llm'),
      field(
        'entries',
        'Строки описи: наименование, номер, дата, кол-во экз.',
        'table',
        true,
        'llm',
      ),
    ],
    sortOrder: 165,
  },
  {
    code: 'general_work_log',
    name: 'Общий журнал работ',
    shortName: 'ОЖР',
    group: 'registries_logs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ОБЩИЙ\\s+ЖУРНАЛ\\s+РАБОТ'],
      bodyHints: ['РД[\\s-]11[\\s-]05', 'Сведения\\s+о\\s+выполнении\\s+работ'],
    },
    fieldSchema: [
      field('log_number', 'Номер журнала', 'text', false, 'rule'),
      field('period', 'Период ведения', 'date_range', true, 'rule'),
      field('records', 'Записи журнала', 'table', false, 'llm'),
    ],
    sortOrder: 170,
  },
  {
    code: 'special_work_log',
    name: 'Специальный журнал работ',
    shortName: 'СЖР',
    group: 'registries_logs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['СПЕЦИАЛЬНЫЙ\\s+ЖУРНАЛ\\s+РАБОТ', 'журнал\\s+производства\\s+\\S+\\s+работ'],
    },
    fieldSchema: [
      field('work_kind', 'Вид работ', 'text', true, 'llm'),
      field('period', 'Период ведения', 'date_range', true, 'rule'),
      field('records', 'Записи журнала', 'table', false, 'llm'),
    ],
    sortOrder: 180,
  },
  {
    code: 'welding_log',
    name: 'Журнал сварочных работ',
    shortName: 'Журнал сварки',
    group: 'registries_logs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ЖУРНАЛ\\s+сварочных\\s+работ'],
      bodyHints: ['клеймо\\s+сварщика', 'номер\\s+шва', 'марка\\s+электрод'],
    },
    fieldSchema: [
      field('welders', 'Сварщики с клеймами и удостоверениями', 'table', true, 'llm'),
      field('joints', 'Сварные соединения', 'table', true, 'llm'),
      field('consumables', 'Сварочные материалы', 'list', false, 'llm'),
    ],
    sortOrder: 190,
  },
  {
    code: 'concrete_log',
    name: 'Журнал бетонных работ',
    shortName: 'Журнал бетона',
    group: 'registries_logs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ЖУРНАЛ\\s+бетонных\\s+работ', 'ЖУРНАЛ\\s+ухода\\s+за\\s+бетоном'],
      bodyHints: ['температура\\s+бетонной\\s+смеси', 'прочность\\s+на\\s+момент'],
    },
    fieldSchema: [
      field('pours', 'Захватки бетонирования', 'table', true, 'llm'),
      field('mix_grade', 'Класс и марка смеси', 'text', true, 'llm'),
      field('curing', 'Условия и сроки ухода', 'text', false, 'llm'),
    ],
    sortOrder: 200,
  },
  {
    code: 'anticorrosion_log',
    name: 'Журнал антикоррозионной защиты сварных соединений',
    shortName: 'Журнал АКЗ',
    group: 'registries_logs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'ЖУРНАЛ\\s+антикорро(зионной|зийной)\\s+защиты',
        'антикорро(зионной|зийной)\\s+защиты\\s+сварных\\s+соединений',
      ],
    },
    fieldSchema: [
      field('joints', 'Защищённые соединения', 'table', true, 'llm'),
      field('coating', 'Состав покрытия и число слоёв', 'text', true, 'llm'),
    ],
    sortOrder: 210,
  },
  {
    code: 'author_supervision_log',
    name: 'Журнал авторского надзора',
    shortName: 'Журнал АН',
    group: 'registries_logs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ЖУРНАЛ\\s+авторского\\s+надзора'],
      bodyHints: ['замечани[яе]\\s+авторского\\s+надзора', 'отметка\\s+об\\s+устранении'],
    },
    fieldSchema: [
      field('records', 'Записи и замечания', 'table', true, 'llm'),
      field('designer_org', 'Организация авторского надзора', 'text', true, 'llm'),
    ],
    sortOrder: 220,
  },
  {
    code: 'other_registries_logs',
    name: 'Иной реестр или журнал, тип не определён',
    shortName: 'Иной журнал',
    group: 'registries_logs',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 230,
  },

  // ── Документы качества материалов ─────────────────────────────────────────
  {
    code: 'cert_conformity',
    name: 'Сертификат соответствия',
    shortName: 'Сертификат',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['СЕРТИФИКАТ\\s+СООТВЕТСТВИЯ'],
      // «ПРИЛОЖЕНИЕ» без уточнений здесь безопасно, потому что отрицательный
      // якорь тоже проверяется с начала строки: упоминание в теле сертификата
      // «Продукция (см. приложение - бланк № 0000057)» совпадением не будет.
      //
      // Требование «№» после «К сертификату соответствия» снято: в корпусе
      // номер родителя вынесен на следующую строку («ПРИЛОЖЕНИЕ № 1» /
      // «К СЕРТИФИКАТУ СООТВЕТСТВИЯ» / «RU.СМИК.001.Н.00271»), и с «№»
      // приложения к сертификату ловились только у части поставщиков.
      negativeAnchors: [
        'ПРИЛОЖЕНИЕ',
        'К\\s+сертификату\\s+соответствия',
        // Сертификат СМК — самостоятельный тип: у него другой предмет
        // (система менеджмента, а не продукция) и другая схема реквизитов.
        'СЕРТИФИКАТ\\s+(СООТВЕТСТВИЯ\\s+)?СИСТЕМЫ\\s+МЕНЕДЖМЕНТА',
      ],
      bodyHints: [
        'ОРГАН\\s+ПО\\s+СЕРТИФИКАЦИИ',
        'СООТВЕТСТВУЕТ\\s+ТРЕБОВАНИЯМ',
        'СЕРТИФИКАТ\\s+ВЫДАН',
        'Срок\\s+действия\\s+с',
      ],
    },
    fieldSchema: [
      field('certification_system', 'Система сертификации', 'text', false, 'llm'),
      field('certification_scheme', 'Схема сертификации', 'text', false, 'rule'),
      field('is_voluntary', 'Добровольная сертификация', 'text', false, 'rule'),
      field('annex_blank_numbers', 'Номера бланков приложений', 'list', false, 'rule'),
      field('manufacturer_branches', 'Филиалы изготовителя', 'list', false, 'llm'),
      field('validity_confirmations', 'Отметки о подтверждении действия', 'table', false, 'rule'),
    ],
    sortOrder: 240,
  },
  {
    code: 'iso_certificate',
    name: 'Сертификат системы менеджмента качества',
    shortName: 'Сертификат СМК',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    // В корпусе самого сертификата нет — есть только ссылка на него в перечне
    // доказательственных материалов декларации РОКВУЛ («Сертификат системы
    // менеджмента качества на соответствие требованиям ГОСТ Р ИСО 9001-2015
    // (ISO 9001:2015) № РОСС RU.ФК82.00186»). Якоря — гипотеза по этой ссылке.
    observedInCorpus: false,
    matchHints: {
      // Предмет сертификации — система менеджмента, а не продукция, поэтому
      // тип отделён от `cert_conformity`: у него нет ни партии, ни ОКПД 2,
      // зато есть область сертификации и площадки.
      anchors: ['СЕРТИФИКАТ\\s+(СООТВЕТСТВИЯ\\s+)?СИСТЕМЫ\\s+МЕНЕДЖМЕНТА', 'СЕРТИФИКАТ\\s+СМК'],
      bodyHints: [
        'ГОСТ\\s+Р\\s+ИСО\\s+9001',
        'ISO\\s*9001',
        'система\\s+менеджмента\\s+качества',
        'область\\s+сертификации',
      ],
    },
    fieldSchema: [
      field('standard', 'Стандарт системы менеджмента', 'text', true, 'rule'),
      field('scope', 'Область сертификации', 'text', true, 'llm'),
      field('sites', 'Площадки, на которые распространяется', 'list', false, 'llm'),
      field('certification_body', 'Орган по сертификации', 'text', true, 'llm'),
    ],
    sortOrder: 245,
  },
  {
    code: 'permit_conformity_mark',
    name: 'Разрешение на применение знака соответствия',
    shortName: 'Разрешение на знак',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Слово «РАЗРЕШЕНИЕ» в заголовке стоит отдельной строкой (стр. 47 файла
      // 336, «Листок жизни», рег. № ЭС413/23), поэтому якорем служит вторая
      // строка. Одинокое «РАЗРЕШЕНИЕ» якорем быть не может: под него подпадут
      // разрешение на строительство и разрешение на ввод в эксплуатацию —
      // документы совсем другого веса. Пересечений с их якорями нет: те
      // требуют «НА СТРОИТЕЛЬСТВО» и «НА ВВОД ОБЪЕКТА В ЭКСПЛУАТАЦИЮ».
      anchors: ['(РАЗРЕШЕНИЕ\\s+)?на\\s+применение\\s+знака\\s+соответствия'],
      bodyHints: [
        'Разрешает\\s+применение\\s+знака\\s+соответствия',
        'РАЗРЕШЕНИЕ\\s+ВЫДАНО',
        'СРОК\\s+ДЕЙСТВИЯ\\s+РАЗРЕШЕНИЯ',
        'УСЛОВИЯ\\s+ПРИМЕНЕНИЯ\\s+ЗНАКА\\s+СООТВЕТСТВИЯ',
      ],
    },
    fieldSchema: [
      field('permit_number', 'Регистрационный номер разрешения', 'text', true, 'rule'),
      field('certification_system', 'Система добровольной сертификации', 'text', true, 'llm'),
      field('holder', 'Кому выдано разрешение', 'text', true, 'llm'),
      field('parent_certificate', 'Сертификат-основание', 'text', true, 'rule'),
      field('valid_until', 'Срок действия разрешения', 'date', true, 'rule'),
      field('usage_conditions', 'Условия применения знака', 'text', false, 'llm'),
    ],
    sortOrder: 248,
  },
  {
    code: 'declaration',
    name: 'Декларация о соответствии',
    shortName: 'Декларация',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['ДЕКЛАРАЦИЯ\\s+О\\s+СООТВЕТСТВИИ'],
      // По аналогии с сертификатом: «Приложение № 1 / к декларации о
      // соответствии № РОСС RU Д-RU.PA01.B.17254/23» — доказательственные
      // материалы к декларации, а не сама декларация.
      negativeAnchors: ['ПРИЛОЖЕНИЕ', 'к\\s+декларации\\s+о\\s+соответствии'],
      bodyHints: [
        'заявляет,?\\s+что',
        'РОСС\\s+RU\\s+Д',
        'принята\\s+на\\s+основании',
        'Декларация\\s+о\\s+соответствии\\s+действительна\\s+по',
      ],
    },
    fieldSchema: [
      field('declaration_scheme', 'Схема декларирования', 'text', false, 'rule'),
      field('technical_regulations', 'Технические регламенты или перечень', 'list', false, 'llm'),
      field('registration_authority', 'Орган регистрации декларации', 'text', false, 'llm'),
    ],
    sortOrder: 250,
  },
  {
    code: 'quality_passport',
    name: 'Паспорт качества',
    shortName: 'Паспорт качества',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Третий якорь — под форму без слова «качества» («Паспорт № 230126/2/…»
      // ООО «РОКВУЛ», стр. 80 файла 336). Перехватить «Технический паспорт №»
      // он не может: совпадение обязано начинаться с начала строки, а там
      // строка начинается словом «Технический».
      anchors: ['ПАСПОРТ\\s+КАЧЕСТВА', 'QUALITY\\s+CERTIFICATE', 'Паспорт\\s*№\\s*\\S'],
      bodyHints: [
        'Норма\\s+по\\s+НД',
        'Фактически',
        '№\\s*Партии',
        'Дата\\s+изготовления',
        // «Строка начинается с ОТК» — через `\n`, потому что bodyHints
        // компилируются без флага `m`.
        '\\nОТК',
      ],
    },
    fieldSchema: [
      field('shift_number', 'Номер смены', 'text', false, 'rule'),
      field('batch_volume', 'Объём или количество в партии', 'text', false, 'rule'),
      field('indicators', 'Показатели: норма по НД и фактически', 'table', true, 'rule'),
      field('conclusion', 'Заключение о соответствии', 'text', true, 'llm'),
      field('qc_inspector', 'Отметка и подпись ОТК', 'text', false, 'llm'),
      field('fire_hazard', 'Показатели пожарной опасности', 'text', false, 'llm'),
    ],
    sortOrder: 260,
  },
  {
    code: 'technical_passport',
    name: 'Технический паспорт изделия',
    shortName: 'Техпаспорт',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['ТЕХНИЧЕСКИЙ\\s+ПАСПОРТ'],
      bodyHints: [
        'Отметка\\s+ОТК',
        'Условное\\s+обозначение',
        'Технические\\s+требования',
        'выдан\\s+отделом\\s+технического\\s+контроля',
      ],
    },
    fieldSchema: [
      field('items', 'Изделия: обозначение, ТУ, партия, количество', 'table', true, 'rule'),
      field('nd_requirements', 'Технические требования, ГОСТ или ТУ', 'text', true, 'rule'),
      field('qc_mark', 'Отметка ОТК', 'text', false, 'llm'),
    ],
    sortOrder: 270,
  },
  {
    code: 'mill_certificate',
    name: 'Сертификат качества завода-изготовителя',
    shortName: 'Сертификат качества',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['СЕРТИФИКАТ\\s+КАЧЕСТВА\\s*№'],
      bodyHints: [
        'Номер\\s+партии',
        'Химический\\s+состав',
        'Механические\\s+свойства',
        'Условие\\s+отбора\\s+проб',
        'Показатели\\s+качества\\s+товара',
      ],
    },
    fieldSchema: [
      field('positions', 'Позиции: партия, диаметр, класс, масса', 'table', true, 'rule'),
      field('steel_grade', 'Марка стали или класс проката', 'text', true, 'rule'),
      field('chemical_composition', 'Химический состав плавки', 'table', false, 'rule'),
      field('mechanical_properties', 'Механические свойства', 'table', true, 'rule'),
      field('sampling_condition', 'Условие отбора и подготовки проб', 'text', false, 'rule'),
    ],
    sortOrder: 280,
  },
  {
    code: 'mix_quality_doc',
    name: 'Документ о качестве бетонной смеси или раствора',
    shortName: 'Документ о качестве смеси',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Три поставщика — три вёрстки. Якорь плана «ДОКУМЕНТ О КАЧЕСТВЕ
      // БЕТОННОЙ СМЕСИ (РАСТВОРА)» на корпусе не срабатывает: скобочной формы
      // нет ни разу, зато есть два раздельных длинных заголовка и — у ООО
      // «АСФАЛЬТОБЕТОН» — короткий «Документ о качестве № 18-000002580».
      // Короткая форма в корпусе каноническая: реестр приложений называет так
      // все десять документов подряд.
      anchors: [
        'ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ\\s+(БЕТОННОЙ\\s+СМЕСИ|РАСТВОРА|СМЕСИ)',
        'ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ\\s+\\S+\\s+ЗАДАННОГО\\s+КАЧЕСТВА',
        'ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ\\s*№',
      ],
      // Плата за короткий якорь — он же годится документу о качестве изделий.
      // Разделяет их предмет: смесь измеряют объёмом и удобоукладываемостью,
      // изделия — штуками и маркой по прочности, и в заголовке изделия названы
      // прямо: «ДОКУМЕНТ О КАЧЕСТВЕ №8985/Б» / «на камни бетонные стеновые по
      // ГОСТ 6133-2019». Оба варианта вёрстки, в одну строку и в две.
      negativeAnchors: [
        'ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ.{0,40}на\\s+(камн|блок|плит|кирпич|издели|сва|панел)',
        'на\\s+(камни|блоки|плиты|кирпич|издели[яй]|сваи|панели).{0,60}(по\\s+)?(ГОСТ|ТУ)\\s',
      ],
      bodyHints: [
        'ЗАДАННОГО\\s+КАЧЕСТВА\\s+ПАРТИИ',
        'ГОСТ\\s+7473',
        'ГОСТ\\s+Р?\\s*58766',
        'удобоукладываемост',
        'сохраняемост',
      ],
    },
    fieldSchema: [
      field('mix_kind', 'Вид смеси: бетонная или растворная', 'text', true, 'llm'),
      field('strength_class', 'Класс по прочности', 'text', true, 'rule'),
      field('grade', 'Марка смеси', 'text', true, 'rule'),
      field('workability', 'Марка по удобоукладываемости', 'text', false, 'rule'),
      field('frost_resistance', 'Марка по морозостойкости', 'text', false, 'rule'),
      field('water_resistance', 'Марка по водонепроницаемости', 'text', false, 'rule'),
      field('shipped_at', 'Дата и время отгрузки партии', 'date', true, 'rule'),
      field('keeping_time', 'Сохраняемость смеси', 'text', false, 'rule'),
      field('volume', 'Объём партии', 'text', false, 'rule'),
      field('structure_destination', 'Конструкция назначения смеси', 'text', false, 'llm'),
    ],
    sortOrder: 290,
  },
  {
    code: 'product_quality_doc',
    name: 'Документ о качестве штучных изделий',
    shortName: 'Документ о качестве изделий',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Отдельный тип от `mix_quality_doc`, потому что схема полей смеси к
      // изделиям неприменима: у камня бетонного стенового нормируются марка по
      // прочности M400, класс бетона B30, морозостойкость F200, отпускная
      // прочность, масса и средняя плотность — вместо удобоукладываемости,
      // сохраняемости и времени отгрузки, которых у штучного изделия нет.
      //
      // Якоря зеркальны отрицательным якорям `mix_quality_doc`: заголовок
      // называет изделия и ГОСТ на них. Вторая форма — под вёрстку в две
      // строки (стр. 41 файла 336, ООО «БЕКАМ»), где номер остаётся в первой
      // строке, а предмет переносится во вторую.
      anchors: [
        'ДОКУМЕНТ\\s+О\\s+КАЧЕСТВЕ.{0,40}на\\s+(камн|блок|плит|кирпич|издели|сва|панел)',
        'на\\s+(камни|блоки|плиты|кирпич|издели[яй]|сваи|панели).{0,60}(по\\s+)?(ГОСТ|ТУ)\\s',
      ],
      bodyHints: [
        'Марка\\s+по\\s+прочности',
        'Класс\\s+бетона\\s+по\\s+прочности',
        'Марка\\s+по\\s+морозостойкости',
        'отпускная\\s+прочность',
        'Средняя\\s+плотность',
        'Отгружаемое\\s+количество',
      ],
    },
    fieldSchema: [
      field('product_name', 'Наименование и марка изделий', 'text', true, 'llm'),
      field('designation', 'Условное обозначение изделия', 'text', false, 'rule'),
      field('nd_reference', 'ГОСТ или ТУ на изделие', 'text', true, 'rule'),
      field('batch_number', 'Номер партии', 'text', true, 'rule'),
      field('quantity', 'Отгружаемое количество, шт', 'number', true, 'rule'),
      field('manufactured_at', 'Дата изготовления', 'date', true, 'rule'),
      field('strength_grade', 'Марка по прочности', 'text', true, 'rule'),
      field('concrete_class', 'Класс бетона по прочности на сжатие', 'text', false, 'rule'),
      field('frost_resistance', 'Марка по морозостойкости', 'text', false, 'rule'),
      field('release_strength', 'Нормируемая отпускная прочность, МПа', 'number', false, 'rule'),
      field('mass', 'Масса изделия, кг', 'number', false, 'rule'),
      field('density', 'Средняя плотность, кг/м³', 'number', false, 'rule'),
      field('qc_mark', 'Отметка ОТК', 'text', false, 'llm'),
    ],
    sortOrder: 295,
  },
  {
    code: 'fire_certificate',
    name: 'Сертификат пожарной безопасности',
    shortName: 'Пожарный сертификат',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'СЕРТИФИКАТ\\s+ПОЖАРНОЙ\\s+БЕЗОПАСНОСТИ',
        'требовани(й|ям)\\s+пожарной\\s+безопасности',
      ],
      bodyHints: [
        'ТР\\s*ЕАЭС\\s*043/2017',
        'Технический\\s+регламент\\s+о\\s+требованиях\\s+пожарной',
      ],
    },
    fieldSchema: [
      field('fire_class', 'Класс пожарной опасности', 'text', true, 'rule'),
      field('flammability_group', 'Группа горючести и воспламеняемости', 'text', false, 'rule'),
    ],
    sortOrder: 300,
  },
  {
    code: 'refusal_letter',
    name: 'Отказное письмо',
    shortName: 'Отказное письмо',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // В корпусе документ озаглавлен «Информационное письмо по сертификации
      // продукции», а «отказным письмом» его называет только реестр приложений.
      // Заголовок разбит на две строки, поэтому якорь взят по первой из них.
      anchors: ['отказн[а-яё]+\\s+письм', 'Информационное\\s+письмо'],
      bodyHints: [
        'не\\s+входит\\s+в\\s+перечень\\s+товаров',
        'не\\s+подлежит\\s+обязательн(ой|ому)\\s+(сертификации|подтверждению)',
        'постановлени\\S*\\s+Правительства\\s+РФ\\s*№\\s*2425',
      ],
    },
    fieldSchema: [
      field('legal_basis', 'Нормативное основание освобождения', 'text', true, 'rule'),
      field('statement', 'Формулировка вывода', 'text', true, 'llm'),
    ],
    sortOrder: 310,
  },
  {
    code: 'equipment_passport',
    name: 'Паспорт оборудования',
    shortName: 'Паспорт оборудования',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'ПАСПОРТ\\s+(и\\s+руководство\\s+по\\s+эксплуатации|оборудования)',
        'Руководство\\s+по\\s+эксплуатации',
      ],
      bodyHints: ['заводской\\s+номер', 'год\\s+выпуска', 'комплект\\s+поставки'],
    },
    fieldSchema: [
      field('equipment_name', 'Наименование и марка оборудования', 'text', true, 'llm'),
      field('serial_number', 'Заводской номер', 'text', true, 'rule'),
      field('manufactured_year', 'Год выпуска', 'text', false, 'rule'),
      field('specifications', 'Технические характеристики', 'table', false, 'llm'),
    ],
    sortOrder: 320,
  },
  {
    code: 'ttn',
    name: 'Товарно-транспортная накладная',
    shortName: 'ТТН',
    group: 'quality_docs',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'ТОВАРНО[\\s-]ТРАНСПОРТНАЯ\\s+НАКЛАДНАЯ',
        'ТРАНСПОРТНАЯ\\s+НАКЛАДНАЯ',
        'УНИВЕРСАЛЬНЫЙ\\s+ПЕРЕДАТОЧНЫЙ\\s+ДОКУМЕНТ',
      ],
      bodyHints: ['Грузоотправитель', 'Грузополучатель', 'государственный\\s+номер'],
    },
    fieldSchema: [
      field('shipper', 'Грузоотправитель', 'text', true, 'llm'),
      field('consignee', 'Грузополучатель', 'text', true, 'llm'),
      field('shipped_at', 'Дата отгрузки', 'date', true, 'rule'),
      field('cargo', 'Позиции груза', 'table', true, 'rule'),
    ],
    sortOrder: 330,
  },
  {
    code: 'other_quality_docs',
    name: 'Иной документ о качестве, тип не определён',
    shortName: 'Иной документ качества',
    group: 'quality_docs',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 340,
  },

  // ── Испытания и заключения ────────────────────────────────────────────────
  {
    // Обобщающий протокол: ловит сам заголовок «Протокол об испытаниях № …».
    // Подвиды различаются подзаголовком («по определению прочности раствора»,
    // «механических свойств металла») и потому имеют приоритет выше. Если
    // подзаголовок не распознан или отсутствует, документ не теряется —
    // остаётся опознан как протокол, а подвид уточняет человек либо LLM.
    code: 'lab_protocol_generic',
    name: 'Протокол испытаний (вид не определён)',
    shortName: 'Протокол испытаний',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    priority: 0,
    matchHints: {
      anchors: ['ПРОТОКОЛ\\s+(об\\s+)?испытани[йяе]'],
      bodyHints: ['Аттестат\\s+аккредитации', 'Методика\\s+испытани', 'Заказчик'],
    },
    fieldSchema: [],
    sortOrder: 345,
  },
  {
    priority: 10,
    code: 'lab_protocol_concrete',
    name: 'Протокол испытаний бетона или раствора',
    shortName: 'Протокол бетона',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Общий заголовок «Протокол об испытаниях №...» одинаков у всех лабораторных
      // протоколов и потому лежит в bodyHints. Тип разделяет подзаголовок,
      // который в образцах стоит отдельной строкой сразу под заголовком.
      anchors: [
        'по\\s+определению\\s+прочности\\s+(бетона|раствора)',
        'контрольным\\s+образцам[\\s-]*кубам',
      ],
      bodyHints: [
        'ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]',
        'Проектная\\s+марка',
        'Возраст\\s+(бетона|раствора)',
        '%\\s*от\\s+требуемой\\s+прочности',
      ],
    },
    fieldSchema: [
      field('structure_name', 'Наименование и привязка конструкции', 'text', true, 'llm'),
      field('design_grade', 'Проектный класс или марка', 'text', true, 'rule'),
      field('sample_marks', 'Маркировка образцов', 'list', true, 'rule'),
      field('made_at', 'Дата изготовления образцов', 'date', true, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
      field('age_days', 'Возраст на момент испытания, сут', 'number', true, 'rule'),
      field('strength_mpa', 'Средняя прочность в серии, МПа', 'number', true, 'rule'),
      field('percent_of_required', 'Процент от требуемой прочности', 'number', true, 'rule'),
      field('curing_conditions', 'Условия твердения', 'text', false, 'llm'),
      field('method', 'Методика испытаний', 'text', true, 'rule'),
      field('equipment', 'Оборудование и сроки поверки', 'list', false, 'rule'),
    ],
    sortOrder: 350,
  },
  {
    priority: 10,
    code: 'lab_protocol_metal',
    name: 'Протокол испытаний металла и арматуры',
    shortName: 'Протокол металла',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: [
        'по\\s+определению\\s+механических\\s+свойств\\s+металла',
        'испытани[йя]\\s+на\\s+растяжение\\s+арматур',
      ],
      bodyHints: [
        'ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]',
        'Предел\\s+текучести',
        'Временное\\s+сопротивление',
        'ГОСТ\\s+12004',
      ],
    },
    fieldSchema: [
      field('steel_class', 'Класс арматуры или марка стали', 'text', true, 'rule'),
      field('diameter', 'Номинальный диаметр проката, мм', 'number', true, 'rule'),
      field('yield_strength', 'Предел текучести, Н/мм²', 'number', true, 'rule'),
      field('tensile_strength', 'Временное сопротивление, Н/мм²', 'number', true, 'rule'),
      field('elongation', 'Относительное удлинение, %', 'number', false, 'rule'),
      field('bend_test', 'Испытание на изгиб', 'text', false, 'llm'),
      field('sampled_at', 'Дата отбора проб', 'date', true, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
      field('method', 'Методика испытаний', 'text', true, 'rule'),
      field('equipment', 'Оборудование и сроки поверки', 'list', false, 'rule'),
    ],
    sortOrder: 360,
  },
  {
    priority: 10,
    code: 'lab_protocol_welding',
    name: 'Протокол механических испытаний сварных соединений',
    shortName: 'Протокол сварки',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'механических\\s+испытани[йя]\\s+сварных\\s+соединений',
        'испытани[йя]\\s+сварных\\s+соединений',
      ],
      bodyHints: ['ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]', 'клеймо\\s+сварщика', 'разрушение\\s+по'],
    },
    fieldSchema: [
      field('joints', 'Испытанные соединения', 'table', true, 'llm'),
      field('welder_stamp', 'Клеймо сварщика', 'text', false, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
    ],
    sortOrder: 370,
  },
  {
    priority: 10,
    code: 'lab_protocol_ndt',
    name: 'Протокол неразрушающего контроля',
    shortName: 'Протокол НК',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'ультразвуково\\S*\\s+контрол',
        'неразрушающего\\s+контрол',
        'радиографическ\\S*\\s+контрол',
      ],
      bodyHints: [
        'ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]',
        'дефектоскоп',
        'уровень\\s+чувствительности',
      ],
    },
    fieldSchema: [
      field('method', 'Метод контроля', 'text', true, 'rule'),
      field('joints', 'Проконтролированные соединения', 'table', true, 'llm'),
      field('defects', 'Обнаруженные дефекты', 'table', false, 'llm'),
      field('tested_at', 'Дата контроля', 'date', true, 'rule'),
    ],
    sortOrder: 380,
  },
  {
    priority: 10,
    code: 'lab_protocol_waterproofing',
    name: 'Протокол испытаний гидроизоляции',
    shortName: 'Протокол гидроизоляции',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'испытани[йя]\\s+гидроизоляц',
        'герметичности\\s+гидроизоляционного\\s+ковра',
        'сплошности\\s+гидроизоляц',
      ],
      bodyHints: ['ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]', 'залив\\s+водой', 'адгези'],
    },
    fieldSchema: [
      field('method', 'Метод проверки', 'text', true, 'rule'),
      field('area', 'Проверенный участок', 'text', true, 'llm'),
      field('result', 'Результат проверки', 'text', true, 'llm'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
    ],
    sortOrder: 390,
  },
  {
    priority: 10,
    code: 'lab_protocol_piles',
    name: 'Протокол испытаний свай',
    shortName: 'Протокол свай',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        '(статическ|динамическ)\\S*\\s+испытани\\S*\\s+сва',
        'испытани[йя]\\s+свай\\s+(вдавливающей|выдергивающей)?\\s*нагрузк',
      ],
      bodyHints: ['ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]', 'осадка\\s+сваи', 'несущая\\s+способность'],
    },
    fieldSchema: [
      field('pile_numbers', 'Номера испытанных свай', 'list', true, 'rule'),
      field('load', 'Испытательная нагрузка', 'text', true, 'rule'),
      field('settlement', 'Зафиксированная осадка', 'text', true, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
    ],
    sortOrder: 400,
  },
  // ── Метрология средств измерений ──────────────────────────────────────────
  //
  // Три вида, без которых лабораторный протокол не имеет доказательной силы:
  // прибор, которым получен результат, обязан быть поверен, откалиброван либо
  // аттестован. В комплекте `№01_Бл_П` реестр приложений называет пять таких
  // документов из девяти, и до их появления в каталоге ни один не получал
  // якоря: лист оставался без типа, а штамп «КОПИЯ ВЕРНА» уносил его в
  // служебные (`classify.ts`, `COPY_STAMP_ROLE`).
  //
  // Приоритет 10 у всех трёх — как у подвидов лабораторного протокола: иначе
  // обобщающий `lab_protocol_generic` перехватывал бы «ПРОТОКОЛ АТТЕСТАЦИИ»
  // своим якорем `ПРОТОКОЛ\s+(об\s+)?испытани[йяе]`… он его не перехватывает,
  // но подвид обязан выигрывать у обобщения по построению, а не по удаче
  // формулировки соседнего якоря.
  {
    priority: 10,
    code: 'metrology_verification',
    name: 'Свидетельство о поверке средства измерений',
    shortName: 'Свидетельство о поверке',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Только «о поверке». Написание «о проверке» в корпусе встречается
      // дважды и ОБА раза — в строке реестра приложений, где документ назвал
      // подрядчик; заголовки самих листов оба раза «СВИДЕТЕЛЬСТВО О ПОВЕРКЕ».
      // Каталог классифицирует документ, а не то, как его назвали в перечне,
      // и сверка реестра наименованиями всё равно не пользуется.
      anchors: ['СВИДЕТЕЛЬСТВО\\s+о\\s+поверке'],
      bodyHints: [
        'Средство\\s+измерений',
        'Действительно\\s+до',
        'заводской\\s+\\(серийный\\)\\s+номер',
        'поверк[аи]',
      ],
    },
    fieldSchema: [
      field('instrument_name', 'Средство измерений', 'text', true, 'llm'),
      field('instrument_serial', 'Заводской (серийный) номер прибора', 'text', true, 'rule'),
      field(
        'instrument_registry_no',
        'Регистрационный номер типа в Госреестре',
        'text',
        false,
        'rule',
      ),
      field('verification_method', 'Методика поверки', 'text', false, 'rule'),
    ],
    sortOrder: 402,
  },
  {
    priority: 10,
    code: 'metrology_calibration',
    name: 'Сертификат калибровки средства измерений',
    shortName: 'Сертификат калибровки',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['СЕРТИФИКАТ\\s+калибровки'],
      bodyHints: ['Объект\\s+калибровки', 'Метод\\s+калибровки', 'Результаты\\s+калибровки'],
    },
    fieldSchema: [
      field('instrument_name', 'Объект калибровки', 'text', true, 'llm'),
      field('instrument_serial', 'Заводской (серийный) номер прибора', 'text', true, 'rule'),
      field('calibration_method', 'Методика калибровки', 'text', false, 'rule'),
    ],
    sortOrder: 404,
  },
  {
    priority: 10,
    code: 'metrology_attestation',
    name: 'Протокол аттестации испытательного оборудования',
    shortName: 'Протокол аттестации',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['ПРОТОКОЛ\\s+аттестации'],
      bodyHints: [
        'испытательного\\s+оборудования',
        'Наименование\\s+испытательного\\s+оборудования',
        'Владелец',
      ],
    },
    fieldSchema: [
      field('instrument_name', 'Наименование испытательного оборудования', 'text', true, 'llm'),
      field('instrument_serial', 'Заводской (серийный) номер', 'text', false, 'rule'),
      field('owner', 'Владелец оборудования', 'text', false, 'llm'),
    ],
    sortOrder: 406,
  },
  {
    code: 'sampling_act',
    name: 'Акт отбора проб и образцов',
    shortName: 'Акт отбора проб',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    // План помечает тип как встреченный, но сплошной поиск по трём образцам
    // самостоятельного акта отбора не нашёл: в корпусе есть только дата отбора
    // внутри протокола и графа «Условие отбора проб» в сертификате качества,
    // а в протоколах прямо сказано «Образцы предоставлены заказчиком».
    observedInCorpus: false,
    matchHints: {
      anchors: ['АКТ\\s+отбора\\s+(проб|образцов)', 'отбора\\s+проб\\s+бетонной\\s+смеси'],
      bodyHints: ['место\\s+отбора', 'количество\\s+образцов', 'маркировка\\s+образцов'],
    },
    fieldSchema: [
      field('sampled_at', 'Дата и время отбора', 'date', true, 'rule'),
      field('sample_count', 'Количество отобранных образцов', 'number', true, 'rule'),
      field('sample_marks', 'Маркировка образцов', 'list', true, 'rule'),
      field('structure_name', 'Конструкция или партия для отбора проб', 'text', true, 'llm'),
      field('participants', 'Присутствовавшие представители', 'list', false, 'llm'),
    ],
    sortOrder: 410,
  },
  {
    code: 'technical_conclusion',
    name: 'Техническое заключение о пригодности продукции',
    shortName: 'Техзаключение',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      // Якоря плана «ЗАКЛЮЧЕНИЕ №» недостаточно: в образце номер вынесен на
      // следующую строку («ЗАКЛЮЧЕНИЕ» \n «№ 02(а)-2020»), так что якорь обязан
      // ловить и одинокое слово. Отрицательный просмотр отсекает «Заключение:»
      // — так озаглавлен раздел вывода внутри чужого документа
      // (санитарно-эпидемиологического заключения), а не документ целиком.
      anchors: ['ЗАКЛЮЧЕНИЕ(?!\\s*[:.])', 'Техническ(ая|ое)\\s+оценк[аи]\\s+пригодности'],
      // Заключение о соответствии построенного объекта — приёмо-сдаточный
      // документ ГСН, а не техническая оценка продукции.
      negativeAnchors: ['ЗАКЛЮЧЕНИЕ\\s+о\\s+соответствии\\s+построенного'],
      bodyHints: [
        'пригодности\\s+для\\s+применения\\s+в\\s+строительстве',
        'Техническое\\s+свидетельство',
        'ОБЩИЕ\\s+ПОЛОЖЕНИЯ',
      ],
    },
    fieldSchema: [
      field('assessment_subject', 'Объект технической оценки', 'text', true, 'llm'),
      field('application_scope', 'Область применения продукции', 'text', true, 'llm'),
      field('conclusion_text', 'Вывод заключения', 'text', true, 'llm'),
    ],
    sortOrder: 420,
  },
  {
    code: 'sanitary_conclusion',
    name: 'Экспертное санитарно-эпидемиологическое заключение',
    shortName: 'Санзаключение',
    group: 'tests_conclusions',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: true,
    matchHints: {
      anchors: ['ЭКСПЕРТНОЕ\\s+ЗАКЛЮЧЕНИЕ', 'САНИТАРНО[\\s-]ЭПИДЕМИОЛОГИЧЕСКОЕ\\s+ЗАКЛЮЧЕНИЕ'],
      bodyHints: [
        'санитарно[\\s-]эпидемиологическ',
        'гигиеническим\\s+требованиям',
        'подлежащим\\s+санитарно[\\s-]эпидемиологическому\\s+надзору',
      ],
    },
    fieldSchema: [
      field('requirements', 'Требования, на соответствие которым проверено', 'text', true, 'llm'),
      field('application_area', 'Область применения продукции', 'text', false, 'llm'),
      field('conclusion_result', 'Результат: соответствует или нет', 'text', true, 'llm'),
    ],
    sortOrder: 430,
  },
  {
    code: 'other_tests_conclusions',
    name: 'Иное испытание или заключение, тип не определён',
    shortName: 'Иное заключение',
    group: 'tests_conclusions',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 440,
  },

  // ── Инженерные сети и оборудование ────────────────────────────────────────
  // Раздела инженерных сетей в корпусе не было: весь блок — нормативные гипотезы.
  {
    code: 'act_pressure_test',
    name: 'Акт гидравлического или пневматического испытания трубопровода',
    shortName: 'Акт опрессовки',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        '(гидравлическо|пневматическо)\\S*\\s+испытани',
        'испытани\\S*\\s+трубопровод\\S*\\s+на\\s+(прочность|герметичность)',
      ],
      bodyHints: ['испытательное\\s+давление', 'падение\\s+давления', 'манометр'],
    },
    fieldSchema: [
      field('system', 'Испытанная система', 'text', true, 'llm'),
      field('test_pressure', 'Испытательное давление', 'text', true, 'rule'),
      field('hold_time', 'Время выдержки', 'text', true, 'rule'),
      field('pressure_drop', 'Зафиксированное падение давления', 'text', false, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
    ],
    sortOrder: 450,
  },
  {
    code: 'act_flushing',
    name: 'Акт промывки и дезинфекции трубопроводов',
    shortName: 'Акт промывки',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['промывки\\s+и\\s+дезинфекции', 'АКТ\\s+\\S*\\s*промывки'],
      bodyHints: ['хлорирован', 'бактериологическ', 'расход\\s+воды'],
    },
    fieldSchema: [
      field('system', 'Промытая система', 'text', true, 'llm'),
      field('agent', 'Реагент и концентрация', 'text', false, 'rule'),
      field('lab_confirmation', 'Реквизиты подтверждающего анализа', 'text', false, 'rule'),
      field('performed_at', 'Дата промывки', 'date', true, 'rule'),
    ],
    sortOrder: 460,
  },
  {
    code: 'act_individual_test',
    name: 'Акт индивидуального испытания оборудования',
    shortName: 'Акт индивид. испытания',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'индивидуальн\\S*\\s+испытани\\S*\\s+оборудования',
        'индивидуальн\\S*\\s+опробовани',
      ],
      bodyHints: ['вхолостую', 'под\\s+нагрузкой', 'продолжительность\\s+испытания'],
    },
    fieldSchema: [
      field('equipment_name', 'Оборудование', 'text', true, 'llm'),
      field('test_mode', 'Режим испытания', 'text', true, 'llm'),
      field('duration', 'Продолжительность', 'text', false, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
    ],
    sortOrder: 470,
  },
  {
    code: 'act_complex_test',
    name: 'Акт комплексного опробования систем',
    shortName: 'Акт комплексного опробования',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['комплексного\\s+опробования'],
      bodyHints: ['совместная\\s+работа', 'проектные\\s+параметры', '72\\s*час'],
    },
    fieldSchema: [
      field('systems', 'Опробованные системы', 'list', true, 'llm'),
      field('duration', 'Продолжительность опробования', 'text', true, 'rule'),
      field('parameters', 'Достигнутые параметры', 'table', false, 'llm'),
      field('tested_at', 'Дата опробования', 'date', true, 'rule'),
    ],
    sortOrder: 480,
  },
  {
    code: 'protocol_insulation_resistance',
    name: 'Протокол измерения сопротивления изоляции',
    shortName: 'Протокол изоляции',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['сопротивления\\s+изоляции'],
      bodyHints: ['мегаомметр', 'МОм', 'испытательное\\s+напряжение'],
    },
    fieldSchema: [
      field('circuits', 'Измеренные цепи и результаты', 'table', true, 'rule'),
      field('norm', 'Нормируемое значение', 'text', true, 'rule'),
      field('instrument', 'Прибор и срок поверки', 'text', true, 'rule'),
      field('measured_at', 'Дата измерения', 'date', true, 'rule'),
    ],
    sortOrder: 490,
  },
  {
    code: 'protocol_grounding',
    name: 'Протокол измерения сопротивления заземления и петли фаза-ноль',
    shortName: 'Протокол заземления',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['сопротивления\\s+заземл', 'петл[иья]\\s*«?фаза[\\s-]ноль»?'],
      bodyHints: ['Ом', 'заземляющее\\s+устройство', 'ток\\s+однофазного\\s+замыкания'],
    },
    fieldSchema: [
      field('measurements', 'Точки измерения и результаты', 'table', true, 'rule'),
      field('norm', 'Нормируемое значение', 'text', true, 'rule'),
      field('instrument', 'Прибор и срок поверки', 'text', true, 'rule'),
      field('measured_at', 'Дата измерения', 'date', true, 'rule'),
    ],
    sortOrder: 500,
  },
  {
    code: 'act_balancing',
    name: 'Акт балансировки и наладки систем',
    shortName: 'Акт балансировки',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['балансировк[аи]\\s+систем', 'наладк[аи]\\s+систем'],
      bodyHints: ['проектный\\s+расход', 'фактический\\s+расход', 'отклонение,?\\s*%'],
    },
    fieldSchema: [
      field('system', 'Наладенная система', 'text', true, 'llm'),
      field('flows', 'Проектные и фактические расходы', 'table', true, 'rule'),
      field('performed_at', 'Дата наладки', 'date', true, 'rule'),
    ],
    sortOrder: 510,
  },
  {
    code: 'equipment_list',
    name: 'Ведомость смонтированного оборудования',
    shortName: 'Ведомость оборудования',
    group: 'networks',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ВЕДОМОСТЬ\\s+смонтированного\\s+оборудования', 'смонтированного\\s+оборудования'],
      bodyHints: ['заводской\\s+номер', 'позиция\\s+по\\s+проекту'],
    },
    fieldSchema: [
      field('items', 'Позиции оборудования', 'table', true, 'rule'),
      field('project_reference', 'Шифр проектной документации', 'text', false, 'rule'),
    ],
    sortOrder: 520,
  },
  {
    code: 'other_networks',
    name: 'Иной документ по инженерным сетям, тип не определён',
    shortName: 'Иной документ сетей',
    group: 'networks',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 530,
  },

  // ── Фасады и светопрозрачные конструкции ──────────────────────────────────
  {
    code: 'facade_system_passport',
    name: 'Паспорт фасадной системы',
    shortName: 'Паспорт фасада',
    group: 'facade',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      // «Навесная фасадная система» вынесена в bodyHints: словосочетание
      // встречается в теле техзаключений на минвату и якорем даёт ложный тип.
      anchors: ['ПАСПОРТ\\s+\\S*\\s*(фасадной\\s+системы|навесной\\s+фасадной)'],
      bodyHints: [
        'навесн\\S*\\s+фасадн\\S*\\s+систем',
        'подконструкц',
        'техническое\\s+свидетельство',
        'кронштейн',
      ],
    },
    fieldSchema: [
      field('system_name', 'Наименование фасадной системы', 'text', true, 'llm'),
      field('technical_certificate', 'Реквизиты технического свидетельства', 'text', false, 'rule'),
      field('layers', 'Состав системы по слоям', 'table', false, 'llm'),
    ],
    sortOrder: 540,
  },
  {
    code: 'glazing_passport',
    name: 'Паспорт светопрозрачной конструкции',
    shortName: 'Паспорт СПК',
    group: 'facade',
    kind: 'evidence',
    hasAnnexes: true,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'ПАСПОРТ\\s+\\S*\\s*(светопрозрачн|стеклопакет|оконн)',
        'ПАСПОРТ\\s+издели[йя]\\s+из\\s+(ПВХ|алюмини)',
      ],
      bodyHints: ['формула\\s+стеклопакета', 'приведенное\\s+сопротивление\\s+теплопередаче'],
    },
    fieldSchema: [
      field('product_type', 'Тип конструкции и профильная система', 'text', true, 'llm'),
      field('glass_formula', 'Формула стеклопакета', 'text', false, 'rule'),
      field('thermal_resistance', 'Приведённое сопротивление теплопередаче', 'text', false, 'rule'),
    ],
    sortOrder: 550,
  },
  {
    code: 'protocol_air_permeability',
    name: 'Протокол испытаний на воздухопроницаемость',
    shortName: 'Протокол воздухопроницаемости',
    group: 'facade',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      // Одинокое «воздухопроницаемость» якорем быть не может: это строка
      // таблицы показателей в паспорте качества любой минваты.
      anchors: [
        'ПРОТОКОЛ\\s+\\S*\\s*испытани\\S*\\s+\\S*\\s*воздухопроницаемост',
        'испытани[йя]\\s+на\\s+воздухопроницаемост',
        'определени[юя]\\s+воздухопроницаемост',
      ],
      bodyHints: ['ПРОТОКОЛ\\s+(об\\s+)?испытани[йя]', 'перепад\\s+давлени', 'ГОСТ\\s+26602'],
    },
    fieldSchema: [
      field('specimen', 'Испытанный образец конструкции', 'text', true, 'llm'),
      field('result_class', 'Полученный класс воздухопроницаемости', 'text', true, 'rule'),
      field('tested_at', 'Дата испытания', 'date', true, 'rule'),
    ],
    sortOrder: 560,
  },
  {
    code: 'other_facade',
    name: 'Иной документ по фасадам, тип не определён',
    shortName: 'Иной документ фасада',
    group: 'facade',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 570,
  },

  // ── Организационно-распорядительные документы ─────────────────────────────
  {
    code: 'order_appointment',
    name: 'Приказ о назначении ответственных лиц',
    shortName: 'Приказ о назначении',
    group: 'org',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ПРИКАЗ', 'о\\s+назначении\\s+ответственн'],
      bodyHints: ['ПРИКАЗЫВАЮ', 'ответственн\\S*\\s+за\\s+производство\\s+работ', 'НРС'],
    },
    fieldSchema: [
      field('order_number', 'Номер приказа', 'text', true, 'rule'),
      field('order_date', 'Дата приказа', 'date', true, 'rule'),
      field('persons', 'Назначенные лица и их полномочия', 'table', true, 'llm'),
      field('organization', 'Организация, издавшая приказ', 'text', true, 'llm'),
    ],
    sortOrder: 580,
  },
  {
    code: 'ppr',
    name: 'Проект производства работ',
    shortName: 'ППР',
    group: 'org',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      // `(?!\S)` вместо `(\s|$)`: аббревиатура должна кончиться на границе
      // строки или пробеле, но `$` в якоре запрещён — он оборвал бы совпадение
      // на заголовке «ППР № 07/25».
      anchors: ['ПРОЕКТ\\s+ПРОИЗВОДСТВА\\s+РАБОТ', 'ППР(?!\\S)'],
      bodyHints: ['технологическая\\s+карта', 'календарный\\s+план', 'стройгенплан'],
    },
    fieldSchema: [
      field('ppr_code', 'Шифр ППР', 'text', true, 'rule'),
      field('work_kind', 'Вид работ', 'text', true, 'llm'),
      field('approved_by', 'Кем утверждён', 'text', false, 'llm'),
    ],
    sortOrder: 590,
  },
  {
    code: 'construction_permit',
    name: 'Разрешение на строительство',
    shortName: 'Разрешение на стр-во',
    group: 'org',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['РАЗРЕШЕНИЕ\\s+НА\\s+СТРОИТЕЛЬСТВО'],
      bodyHints: ['Срок\\s+действия\\s+настоящего\\s+разрешения', 'кадастровый\\s+номер'],
    },
    fieldSchema: [
      field('permit_number', 'Номер разрешения', 'text', true, 'rule'),
      field('authority', 'Выдавший орган', 'text', true, 'llm'),
      field('valid_until', 'Срок действия разрешения', 'date', true, 'rule'),
      field('cadastral_number', 'Кадастровый номер участка', 'text', false, 'rule'),
    ],
    sortOrder: 600,
  },
  {
    code: 'power_of_attorney',
    name: 'Доверенность',
    shortName: 'Доверенность',
    group: 'org',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['ДОВЕРЕННОСТЬ'],
      bodyHints: [
        'уполномочивает',
        'настоящая\\s+доверенность\\s+выдана',
        'без\\s+права\\s+передоверия',
      ],
    },
    fieldSchema: [
      field('principal', 'Доверитель', 'text', true, 'llm'),
      field('attorney', 'Представитель', 'text', true, 'llm'),
      field('powers', 'Перечень полномочий', 'text', true, 'llm'),
      field('valid_until', 'Срок действия', 'date', true, 'rule'),
    ],
    sortOrder: 610,
  },
  {
    code: 'other_org',
    name: 'Иной организационно-распорядительный документ, тип не определён',
    shortName: 'Иной ОРД',
    group: 'org',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 620,
  },

  // ── Приёмо-сдаточные документы ────────────────────────────────────────────
  {
    code: 'acceptance_act',
    name: 'Акт приёмки законченного строительством объекта',
    shortName: 'Акт приёмки объекта',
    group: 'handover',
    kind: 'primary',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'приемки\\s+законченного\\s+строительством',
        'приёмки\\s+законченного\\s+строительством',
        'приемо[\\s-]сдаточн\\S*\\s+акт',
      ],
      bodyHints: ['КС[\\s-]11', 'КС[\\s-]14', 'предъявлен\\s+к\\s+приемке'],
    },
    fieldSchema: [
      field('object_name', 'Объект приёмки', 'text', true, 'llm'),
      field('commission', 'Состав приёмочной комиссии', 'table', false, 'llm'),
      field('accepted_at', 'Дата приёмки', 'date', true, 'rule'),
    ],
    sortOrder: 630,
  },
  {
    code: 'commissioning_act',
    name: 'Акт ввода в эксплуатацию',
    shortName: 'Акт ввода',
    group: 'handover',
    kind: 'primary',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['АКТ\\s+ввода\\s+в\\s+эксплуатацию', 'ввод[аe]?\\s+объекта\\s+в\\s+эксплуатацию'],
    },
    fieldSchema: [
      field('object_name', 'Вводимый объект', 'text', true, 'llm'),
      field('commissioned_at', 'Дата ввода', 'date', true, 'rule'),
    ],
    sortOrder: 640,
  },
  {
    code: 'zos',
    name: 'Заключение о соответствии построенного объекта',
    shortName: 'ЗОС',
    group: 'handover',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: [
        'ЗАКЛЮЧЕНИЕ\\s+о\\s+соответствии\\s+построенного',
        'о\\s+соответствии\\s+построенного,?\\s*реконструированного\\s+объекта',
      ],
      bodyHints: [
        'государственн\\S*\\s+строительн\\S*\\s+надзор',
        'требованиям\\s+проектной\\s+документации',
      ],
    },
    fieldSchema: [
      field('zos_number', 'Номер заключения', 'text', true, 'rule'),
      field('authority', 'Орган государственного строительного надзора', 'text', true, 'llm'),
      field('issued_date', 'Дата выдачи', 'date', true, 'rule'),
    ],
    sortOrder: 650,
  },
  {
    code: 'commissioning_permit',
    name: 'Разрешение на ввод объекта в эксплуатацию',
    shortName: 'РВЭ',
    group: 'handover',
    kind: 'evidence',
    hasAnnexes: false,
    isFallback: false,
    observedInCorpus: false,
    matchHints: {
      anchors: ['РАЗРЕШЕНИЕ\\s+НА\\s+ВВОД\\s+ОБЪЕКТА\\s+В\\s+ЭКСПЛУАТАЦИЮ'],
      bodyHints: ['разрешает\\s+ввод\\s+в\\s+эксплуатацию', 'кадастровый\\s+номер'],
    },
    fieldSchema: [
      field('permit_number', 'Номер разрешения', 'text', true, 'rule'),
      field('authority', 'Выдавший орган', 'text', true, 'llm'),
      field('issued_date', 'Дата выдачи', 'date', true, 'rule'),
    ],
    sortOrder: 660,
  },
  {
    code: 'other_handover',
    name: 'Иной приёмо-сдаточный документ, тип не определён',
    shortName: 'Иной приёмо-сдаточный',
    group: 'handover',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 670,
  },

  // ── Общий резерв открытого мира ───────────────────────────────────────────
  {
    code: 'unknown_document',
    name: 'Документ неизвестного вида',
    shortName: 'Неизвестный документ',
    group: 'fallback',
    kind: 'fallback',
    hasAnnexes: false,
    isFallback: true,
    observedInCorpus: false,
    // Якорей нет намеренно: тип присваивается решением классификатора
    // `doc_type = other`, а не совпадением по заголовку. Заголовок такого
    // документа уходит в `doc_type_candidates`.
    matchHints: { anchors: [] },
    fieldSchema: [],
    sortOrder: 680,
  },
] as const satisfies readonly DocTypeDefinition[];

export type DocTypeCode = (typeof DOC_TYPES)[number]['code'];
