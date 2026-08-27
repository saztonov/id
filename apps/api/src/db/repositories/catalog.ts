/**
 * Репозиторий справочников (§3.2): объекты, контрагенты, разделы работ и их
 * виды, версионные профили разделов, реестр РД, каталог видов ИД с наложениями
 * и очередь кандидатов в виды ИД.
 *
 * ## Справочники делятся на ДВА КЛАССА, и деление выражено в коде
 *
 * **Класс 1 — коммерческие сведения об участниках стройки.**
 * `construction_objects`, `counterparties`, `object_sections`, `rd_documents`.
 * Область видимости применяется к ним так же строго, как к данным ИД (§4.1):
 * состав объектов, реквизиты контрагентов и шифры рабочей документации — это
 * сведения о том, кто и что строит. Подрядчик с полным справочником контрагентов
 * получил бы ИНН, ОГРН и юрадреса конкурентов, а с полным списком объектов и РД —
 * картину чужих площадок. Условие берётся из `withScope()` и уходит в SQL:
 *
 * - `object_sections`, `rd_documents` — по собственной колонке `object_id`;
 * - `construction_objects` — по собственному `id`;
 * - `counterparties` — отдельным правилом (см. `counterpartyVisibility`), потому
 *   что «свой контрагент» задаётся не колонкой, а участием в поставках.
 *
 * У подрядчика связь с объектом КОСВЕННАЯ: объект виден, если на нём есть хотя
 * бы один его комплект. Это подзапрос `EXISTS` по `works`, а не список
 * объектов, собранный в приложении: список означал бы второй запрос, окно между
 * запросами и фильтр вне SQL — ровно тот способ, которым фильтрация теряется
 * молча. Фильтровать обязана база.
 *
 * **Класс 2 — конфигурация поведения системы.** `sections`,
 * `section_profiles`, `doc_types`, `doc_type_overrides`, `doc_type_candidates`.
 * Она читается всеми аутентифицированными и областью НЕ сужается. Отсутствие
 * `withScope()` здесь умышленное, а не забытое: это настройка портала — какие
 * виды ИД существуют, какие документы обязательны в разделе, какие правила
 * включены, — а не сведения об участниках. Ни одна строка этих таблиц не
 * принадлежит объекту или подрядчику, и колонок `object_id`/`contractor_id` в
 * них нет вовсе.
 *
 * Сужать их было бы ещё и вредно. Каталог видов ИД — это выпадающий список
 * подтверждения типа документа на экране разметки. Отдай подрядчику часть
 * каталога, и он выберет «не тот, зато видимый», а расхождение всплывёт уже при
 * проверке комплекта. То же у профилей разделов: они задают, что портал требует
 * от комплекта, и знать это требование должен тот, кто комплект собирает.
 *
 * Исключение «вырожденная пустая область» класс 2 больше не делает: с S37
 * пустых областей не бывает — деление стройки на назначенные и прочие объекты
 * снято, и «инженера без назначений» как состояния не существует.
 *
 * Класс каждой выборки назван на месте вызова: `objectVisibility()`,
 * `counterpartyVisibility()`, `configVisibility()`. Поэтому пропуска области не
 * бывает по невнимательности: у любой выборки условие видимости стоит явно.
 * Если в справочнике класса 2 появится колонка `object_id` или `contractor_id`,
 * он тем самым перестанет быть конфигурацией и переедет в класс 1 — вместе с
 * условием.
 *
 * ## Запись — только под правом администратора
 *
 * `settings.manage` и `doc_types.manage` (§4.1); проверяет `requirePermission`
 * на маршруте. Область администратора ничем не ограничена, поэтому UPDATE'ы ниже
 * условия области не несут: единственный, кто до них доходит, видит всё. Читает
 * же записанную строку та же функция, что отдаёт список, — с областью.
 *
 * Очередь кандидатов — исключение из «конфигурацию читают все»: в
 * `doc_type_candidates` лежат `observed_title_sample` и ссылки на ревизию и
 * страницу, то есть ФРАГМЕНТЫ ДОКУМЕНТОВ конкретного подрядчика. Сузить её
 * областью нечем — колонок области в ней нет, — поэтому чтение закрыто правом
 * `doc_types.manage` на маршруте, а не только наличием сессии.
 *
 * ## Ответ собирается чтением, а не `RETURNING`
 *
 * Записи возвращают идентификатор, а сущность читается той же функцией, что
 * отдаёт список. Так форма ответа существует в одном месте: иначе `POST` и
 * `GET` одного ресурса расходятся в полях, и расходятся молча. Побочная выгода —
 * метки времени приводятся к ISO-8601 в SQL (см. `isoTimestamp`) ровно один раз.
 *
 * ## Каждая изменяющая операция пишет `audit_log` — в своей транзакции
 *
 * Найдено воспроизведением: полный набор правок справочников не оставлял в
 * журнале ни одной строки, и вопросы «кто отключил резервный вид ИД», «кто
 * переименовал контрагента», «кто деактивировал объект» были неотвечаемы. А это
 * не любопытство: именно эти значения формируют вердикты `AOSR.HDR`,
 * `AOSR.P2/P6` и `REF` (§9.3), поэтому «почему проверка вчера проходила, а
 * сегодня нет» разбирается по журналу справочников или не разбирается вовсе.
 *
 * Запись и её след идут ОДНОЙ транзакцией: аудит, который может не записаться,
 * бесполезен — при сбое на второй операции остаётся изменение без автора.
 * Отсюда `db.transaction()` даже там, где меняется одна строка, и `Executor`
 * вместо `Database` во внутренних функциях. Действие называет репозиторий, а не
 * маршрут: имя действия — часть смысла изменения, и держать его рядом с самим
 * изменением значит, что перечень действий журнала не приходится собирать
 * чтением роутов.
 *
 * Отклонённая попытка тоже оставляет след, если отказ содержателен (попытка
 * отключить резервный вид ИД): это признак либо ошибки в интерфейсе, либо
 * попытки обойти инвариант открытого мира, и оба случая обязаны быть видны.
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, QueryBuilder, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  constructionObjects,
  counterparties,
  counterpartyKinds,
  docTypeCandidates,
  docTypeOverrides,
  docTypes,
  objectContractors,
  objectRuleProfiles,
  objectSections,
  rdDocuments,
  registries,
  registryItems,
  ruleDefinitions,
  sectionProfiles,
  sections,
  submissionRevisions,
  userObjectScopes,
  users,
  works,
} from '@id/db';
import type {
  AutonomyLevel,
  ConstructionObject,
  Counterparty,
  CounterpartyKind,
  CounterpartyKindEntry,
  JsonValue,
  ObjectContractor,
  ObjectSection,
  Section,
  SectionProfile,
} from '@id/contracts';
import type { DocTypeGroup, DocTypeKind } from '@id/doc-types';
import { type AuthScope } from '../../auth/scope.js';
import { driverField } from '../driver-errors.js';
import { withScope } from '../scoped.js';
import { appendAudit, type AuditActor } from './audit.js';
import {
  badRequest,
  conflict,
  internal,
  isHttpProblem,
  notFound,
  unprocessable,
} from '../../lib/problem.js';

export type Database = NodePgDatabase;

/**
 * Исполнитель запросов: сама база либо транзакция.
 *
 * Нужен потому, что изменение справочника и запись его следа в `audit_log`
 * обязаны быть одной транзакцией, а тип транзакции Drizzle — не
 * `NodePgDatabase`. Перечислены только используемые методы: подмена исполнителя
 * не может незаметно протащить сюда что-то ещё.
 */
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/** Статус кандидата в виды ИД (CHECK `doc_type_candidates_status_chk`). */
export type DocTypeCandidateStatus = 'new' | 'reviewing' | 'mapped' | 'ignored';

/**
 * Статусы, которые проверяющий ставит вручную.
 *
 * `mapped` сюда не входит: CHECK `doc_type_candidates_mapped_chk` требует при
 * нём непустой `mapped_doc_type_code`, поэтому этот статус ставится только
 * действиями «сопоставить» и «завести тип», где код типа известен.
 */
export type DocTypeCandidateReviewStatus = Exclude<DocTypeCandidateStatus, 'mapped'>;

export interface CatalogPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

export interface SectionKind {
  readonly code: string;
  readonly name: string;
}

export interface RdDocument {
  readonly id: string;
  readonly objectId: string;
  readonly cipher: string;
  readonly revision: string | null;
  readonly name: string | null;
  readonly designerId: string | null;
  readonly isActive: boolean;
}

/**
 * Вид ИД, каким его видит портал: базовый каталог плюс наложение.
 *
 * `isActive` живёт только в наложении — в `doc_types` такой колонки нет, потому
 * что seed не должен затирать решение администратора отключить тип. Отсюда
 * `coalesce(o.is_active, true)`: заведённый seed'ом тип активен, пока его не
 * отключили. `hasOverride` показывает в UI, что значения отличаются от
 * поставляемых с релизом.
 */
export interface DocTypeView {
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly groupCode: DocTypeGroup;
  readonly kind: DocTypeKind;
  readonly hasAnnexes: boolean;
  readonly matchHints: JsonValue;
  readonly fieldSchema: JsonValue;
  readonly isSystem: boolean;
  readonly isFallback: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly hasOverride: boolean;
}

export interface DocTypeCandidateView {
  readonly id: string;
  readonly observedTitleNorm: string;
  readonly observedTitleSample: string;
  readonly occurrences: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly sampleRevisionId: string | null;
  readonly sampleSourcePageId: string | null;
  readonly status: DocTypeCandidateStatus;
  readonly mappedDocTypeCode: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
}

// =====================================================================
// Область видимости: класс 1 (коммерческие данные) и класс 2 (конфигурация)
// =====================================================================

/**
 * Псевдонимы таблиц для коррелированных подзапросов области.
 *
 * Псевдоним, а не исходное имя: подзапрос ссылается на колонку ВНЕШНЕГО запроса,
 * и одноимённая таблица внутри и снаружи связала бы условие не с той стороной. С
 * псевдонимом такая ошибка невозможна — имена различны.
 */
const scopeWorks = alias(works, 'scope_works');
const scopeObjects = alias(constructionObjects, 'scope_objects');
const scopeRdDocuments = alias(rdDocuments, 'scope_rd_documents');

/**
 * Построитель подзапросов без соединения с БД.
 *
 * `EXISTS` собирается на уровне условия, где экземпляра `db` нет и быть не
 * должно: условие видимости — чистая функция от области, а не запрос.
 */
const subquery = new QueryBuilder();

/** Тело `EXISTS`: значение не используется, важен сам факт строки. */
const PRESENT = sql`1`;

/**
 * Класс 1: объект строительства в области видимости.
 *
 * Область по объектам снята заказчиком (S37), поэтому условие одно на все роли —
 * `TRUE`. Функция при этом ОСТАЁТСЯ, и не по инерции: она — имя границы. Пока
 * граница названа, её видно в двадцати с лишним местах вызова; растворив её в
 * отсутствии условия, вернуть или сузить пришлось бы поиском по всем
 * репозиториям.
 *
 * Что здесь было и почему исчезло. У подрядчика объект считался видимым по двум
 * признакам: закрепление `object_contractors` (оно делало объект видимым ДО
 * первого комплекта) и наличие собственных комплектов (чтобы снятие закрепления
 * не стирало ему его же историю). У остальных ролей объект брался из списка
 * назначений. Обе конструкции отвечали на вопрос «этот объект — ваш?», а
 * заказчик ответил, что такого вопроса на его стройке нет: портал внутренний, и
 * перечень объектов не является сведениями об участниках.
 *
 * **Что НЕ снято.** Комплекты подрядчика по-прежнему видит только он сам —
 * граница живёт в `scopeWhere()` и режет `works`, а не `construction_objects`.
 * Поэтому «объект видно всем» и «чужую ИД видно всем» — разные утверждения, и
 * второе ложно.
 */
export function objectVisibility(_scope: AuthScope, _objectId: PgColumn): SQL {
  return sql`true`;
}

/**
 * Класс 1: контрагент в области видимости.
 *
 * Инженер, руководитель и администратор видят справочник целиком, и это
 * требование §9.3: проверка АОСР сверяет ИНН, ОГРН и наименование из акта со
 * справочником и проверяет тройку ОГРН↔ИНН↔наименование, а сверять можно только
 * с полным списком. Условие у них то же, что у конфигурации.
 *
 * Подрядчику отдаётся ровно то, что он и так видит в своих документах:
 *
 * 1. он сам — его собственная строка справочника;
 * 2. участники объектов: застройщик, технический заказчик, генподрядчик — они
 *    печатаются в шапке его же актов;
 * 3. проектировщики РД этих объектов — шифр РД он видит, и `designerId` в нём
 *    обязан быть разрешим.
 *
 * Правило выражает один инвариант: контрагент читается тогда и только тогда,
 * когда его идентификатор уже встречается в видимой пользователю строке. Иначе
 * справочник либо отдаёт реквизиты конкурентов, либо оставляет в ответе
 * неразрешимые идентификаторы.
 *
 * Инвариант пережил снятие объектных областей (S37) без правки: объекты стали
 * видны все, и вместе с ними расширилось множество «уже видимых строк». Не
 * расширилось только одно — соседние субподрядчики в этот список по-прежнему не
 * входят, потому что в документах подрядчика они не встречаются.
 */
function counterpartyVisibility(scope: AuthScope): SQL {
  if (scope.kind !== 'contractor') return configVisibility(scope);

  // Область в обеих ветках берётся из withScope(): «строка справочника — это я»
  // выражается целью, где колонкой подрядчика служит сам первичный ключ.
  const itself = withScope(scope, {
    objectId: scopeWorks.objectId,
    contractorId: counterparties.id,
  });

  const participant = exists(
    subquery
      .select({ present: PRESENT })
      .from(scopeObjects)
      .where(
        and(
          objectVisibility(scope, scopeObjects.id),
          or(
            eq(scopeObjects.developerId, counterparties.id),
            eq(scopeObjects.techCustomerId, counterparties.id),
            eq(scopeObjects.generalContractorId, counterparties.id),
          ),
        ),
      ),
  );

  const designer = exists(
    subquery
      .select({ present: PRESENT })
      .from(scopeRdDocuments)
      .where(
        and(
          eq(scopeRdDocuments.designerId, counterparties.id),
          objectVisibility(scope, scopeRdDocuments.objectId),
        ),
      ),
  );

  return or(itself, participant, designer) ?? sql`false`;
}

/**
 * Класс 2: конфигурация — читают все аутентифицированные.
 *
 * Разбор, почему область здесь не применяется, — в заголовке файла. Короткая
 * версия: это настройка поведения портала, а не сведения об участниках, и
 * интерфейсу она нужна целиком. Проверки на вырожденную пустую область здесь
 * больше нет: пустых областей не осталось вовсе (S37).
 */
function configVisibility(_scope: AuthScope): SQL {
  return sql`true`;
}

/**
 * Совмещает условие видимости с прикладными условиями выборки.
 *
 * Экспортируется вместе с `objectVisibility()` для профилей правил объекта
 * (`object-rule-profiles.ts`): у той таблицы `object_id` есть, а `contractor_id`
 * нет, поэтому область к ней применяется ровно этой парой функций. Второй
 * экземпляр той же логики в соседнем файле означал бы два источника правды для
 * правила доступа — то, что проект запрещает прямо.
 */
export function visibleWhere(visibility: SQL, ...conditions: (SQL | undefined)[]): SQL {
  const combined = and(visibility, ...conditions);
  // and() отдаёт undefined только на пустом списке, а первый аргумент задан
  // всегда; проверка нужна для сужения типа.
  return combined ?? sql`false`;
}

/**
 * Метка времени в ISO-8601 средствами PostgreSQL.
 *
 * `timestamp({ mode: 'string' })` в Drizzle отдаёт значение в форме драйвера:
 * `2026-08-17 12:00:00+00`, а если драйвер вернул `Date` — строку со смещением
 * ЛОКАЛЬНОЙ зоны процесса. Ни то, ни другое не является ISO-8601, которого ждут
 * схемы контрактов, и во втором случае ответ ещё и зависел бы от TZ контейнера.
 * Формат собирается в SQL, поэтому не зависит ни от драйвера, ни от зоны.
 */
function isoTimestamp(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** То же для nullable-колонки: NULL остаётся NULL. */
function isoTimestampOrNull(column: PgColumn): SQL<string | null> {
  return sql<string | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * Экранирование метасимволов LIKE.
 *
 * Без него поиск по `100%` или `a_b` означает не то, что ввёл пользователь, а
 * `%` в начале строки поиска превращает запрос в полный перебор таблицы.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function contains(term: string): string {
  return `%${escapeLike(term)}%`;
}

function startsWith(term: string): string {
  return `${escapeLike(term)}%`;
}

// =====================================================================
// Курсоры
// =====================================================================

const textCursorSchema = z.object({ k: z.string(), id: z.uuid() });
const countCursorSchema = z.object({ n: z.int(), id: z.uuid() });

type TextCursor = z.infer<typeof textCursorSchema>;
type CountCursor = z.infer<typeof countCursorSchema>;

function encodeCursor(cursor: TextCursor | CountCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Повреждённый курсор — ошибка запроса, а не «начнём заново».
 *
 * Молчаливый откат к первой странице выглядит для клиента как бесконечный
 * список: он листает, получает те же записи и снова тот же курсор.
 */
function decodeCursor<TCursor>(
  raw: string | null | undefined,
  schema: z.ZodType<TCursor>,
): TCursor | null {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // Ниже общий отказ: разница между «не base64» и «не та форма» клиенту
    // ничего не даёт.
  }
  throw badRequest('Курсор страницы недействителен.');
}

/**
 * Keyset по текстовому ключу, а не OFFSET.
 *
 * Явные приведения типов обязательны: ключ приходит параметром, и без `::text`
 * сравнение кортежей `(varchar, uuid) > (unknown, unknown)` PostgreSQL
 * разрешает не так, как ожидает индекс.
 */
function afterText(key: PgColumn, id: PgColumn, cursor: TextCursor): SQL {
  return sql`(${key}::text, ${id}) > (${cursor.k}::text, ${cursor.id}::uuid)`;
}

/** Keyset по убыванию счётчика: очередь кандидатов сортируется по частоте. */
function afterCount(count: PgColumn, id: PgColumn, cursor: CountCursor): SQL {
  return sql`(${count}, ${id}) < (${cursor.n}::integer, ${cursor.id}::uuid)`;
}

// =====================================================================
// Ошибки ограничений БД
// =====================================================================

interface ConstraintProblem {
  readonly status: 409 | 422;
  readonly pointer: string | null;
  readonly message: string;
}

/**
 * Ограничение БД → внятный ответ вместо 500.
 *
 * Список рукописный и привязан к именам ограничений из миграций. Без него
 * опечатка администратора в `developerId` даёт «внутреннюю ошибку сервера», по
 * которой невозможно понять, что не так с формой. Имена ограничений — часть
 * контракта миграций (S2 зафиксировал их как источник правды), поэтому
 * привязываться к ним допустимо; отсутствие имени в списке не ломает ничего,
 * просто ошибка остаётся 500 и попадает в `error_events`.
 */
const CONSTRAINT_PROBLEMS: Readonly<Record<string, ConstraintProblem>> = {
  construction_objects_code_key: {
    status: 409,
    pointer: '/code',
    message: 'Объект с таким кодом уже существует.',
  },
  construction_objects_developer_id_fkey: {
    status: 422,
    pointer: '/developerId',
    message: 'Застройщик не найден в справочнике контрагентов.',
  },
  construction_objects_tech_customer_id_fkey: {
    status: 422,
    pointer: '/techCustomerId',
    message: 'Технический заказчик не найден в справочнике контрагентов.',
  },
  construction_objects_general_contractor_id_fkey: {
    status: 422,
    pointer: '/generalContractorId',
    message: 'Генеральный подрядчик не найден в справочнике контрагентов.',
  },
  object_sections_section_code_fkey: {
    status: 422,
    pointer: '/sectionCode',
    message: 'Раздел работ не найден в справочнике.',
  },
  object_contractors_contractor_id_fkey: {
    status: 422,
    pointer: '/contractorId',
    message: 'Контрагент не найден в справочнике.',
  },
  sections_pkey: {
    status: 409,
    pointer: '/code',
    message: 'Раздел работ с таким кодом уже существует.',
  },
  sections_code_chk: {
    status: 422,
    pointer: '/code',
    message: 'Код раздела записывается латиницей: строчные буквы, цифры и подчёркивание.',
  },
  section_profiles_section_version_uq: {
    status: 409,
    pointer: null,
    message: 'Профиль этого раздела изменён параллельно. Повторите запрос.',
  },
  // Инвариант «на дату действует не более одного профиля» держит частичный
  // уникальный индекс 0011. Сюда попадает проигравший в гонке двух публикаций:
  // оба увидели по одному открытому периоду и оба его закрыли, но второй
  // фиксируется уже поверх чужой открытой версии.
  ux_section_profiles_open_period: {
    status: 409,
    pointer: null,
    message:
      'У этого раздела параллельно опубликован профиль с открытым периодом. ' +
      'Повторите запрос: закрывать период задним числом портал не станет.',
  },
  section_profiles_section_code_fkey: {
    status: 422,
    pointer: '/sectionCode',
    message: 'Раздел работ не найден в справочнике.',
  },
  rd_documents_designer_id_fkey: {
    status: 422,
    pointer: '/designerId',
    message: 'Проектировщик не найден в справочнике контрагентов.',
  },
  doc_types_code_key: {
    status: 409,
    pointer: '/code',
    message: 'Вид ИД с таким кодом уже существует.',
  },
  doc_type_candidates_mapped_doc_type_code_fkey: {
    status: 422,
    pointer: '/docTypeCode',
    message: 'Вид ИД с таким кодом не найден в каталоге.',
  },
  counterparties_inn_chk: {
    status: 422,
    pointer: '/inn',
    message: 'ИНН — 10 цифр у организации или 12 у физического лица.',
  },
  counterparties_kpp_chk: { status: 422, pointer: '/kpp', message: 'КПП — 9 цифр.' },
  counterparties_kind_fkey: {
    status: 422,
    pointer: '/kind',
    message: 'Вид контрагента не найден в справочнике.',
  },
  counterparty_kinds_pkey: {
    status: 409,
    pointer: '/code',
    message: 'Вид контрагента с таким кодом уже существует.',
  },
  counterparty_kinds_code_chk: {
    status: 422,
    pointer: '/code',
    message: 'Код вида — латиница в нижнем регистре, цифры и подчёркивание.',
  },
  counterparties_ogrn_chk: {
    status: 422,
    pointer: '/ogrn',
    message: 'ОГРН — 13 цифр у организации или 15 (ОГРНИП).',
  },
  object_rule_profiles_object_id_fkey: {
    status: 422,
    pointer: '/objectId',
    message: 'Объект строительства не найден.',
  },
  object_rule_profiles_section_id_fkey: {
    status: 422,
    pointer: '/sectionId',
    message: 'Раздел работ не найден.',
  },
  /** Составной FK: раздел обязан принадлежать тому же объекту, что и профиль. */
  object_rule_profiles_section_fk: {
    status: 422,
    pointer: '/sectionId',
    message: 'Раздел работ принадлежит другому объекту.',
  },
  ux_object_rule_profiles_section_version: {
    status: 409,
    pointer: null,
    message: 'Профиль правил этого раздела изменён параллельно. Повторите запрос.',
  },
  ux_object_rule_profiles_object_version: {
    status: 409,
    pointer: null,
    message: 'Профиль правил этого объекта изменён параллельно. Повторите запрос.',
  },
  object_rule_profiles_period_chk: {
    status: 422,
    pointer: '/effectiveTo',
    message: 'Начало действия профиля позже его окончания.',
  },
  /**
   * Отказ триггера `doc_type_overrides_keep_fallback_active` (миграция 0010).
   *
   * Имя в списке — не дубль проверки в коде: до триггера дело доходит при гонке
   * и при записи в обход API, и без перевода такой отказ стал бы 500 на штатно
   * запрещённой операции.
   */
  doc_type_overrides_fallback_active_chk: {
    status: 422,
    pointer: '/isActive',
    message:
      'Резервный вид ИД нельзя отключить: документу незнакомого вида станет некуда деться (§8.1).',
  },
};

/**
 * Выполняет запись, переводя нарушение ограничения в ответ 409 или 422.
 *
 * Незнакомая ошибка БД тоже не уходит наружу как есть, и это не перестраховка.
 * Сообщение `DrizzleQueryError` собрано как `Failed query: <весь SQL>\nparams:
 * <ВСЕ значения bind-параметров>`, а `toHttpProblem()` кладёт сообщение
 * необёрнутой ошибки в `logDetail`, то есть в журнал. Значения параметров
 * печатаются там без кавычек, и `normalizeErrorMessage()` вычёркивает из них
 * только числа и то, что взято в кавычки, — остальное осталось бы в журнале
 * дословно. Поэтому граница репозитория заменяет текст на свой: SQLSTATE и имя
 * ограничения для диагностики достаточно, а полный разбор ошибки остаётся в
 * `errorDigest`, который по построению берёт только безопасные поля.
 *
 * Экспортируется для `object-rule-profiles.ts`: `object_rule_profiles` —
 * справочник того же §3.2, и вторая таблица «ограничение → ответ» рядом означала
 * бы, что одно и то же нарушение отвечается по-разному в зависимости от файла.
 */
export async function guardConstraints<TResult>(
  operation: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    // Собственные отказы репозитория (422 автономии профиля и т. п.) проходят
    // насквозь: они брошены внутри транзакции и ошибкой драйвера не являются.
    if (isHttpProblem(error)) throw error;

    const name = driverField(error, 'constraint');
    const sqlState = driverField(error, 'code');
    const problem = name === null ? undefined : CONSTRAINT_PROBLEMS[name];

    if (problem === undefined) {
      throw internal({
        cause: error,
        logDetail: `запись справочника отвергнута базой (SQLSTATE ${sqlState ?? 'неизвестен'}, ограничение ${name ?? 'не указано'})`,
      });
    }

    const logDetail = `нарушено ограничение ${name ?? ''}`;
    if (problem.status === 409) {
      throw conflict(problem.message, { cause: error, logDetail });
    }
    throw unprocessable(
      [{ pointer: problem.pointer, code: 'constraint', message: problem.message }],
      problem.message,
      { cause: error, logDetail },
    );
  }
}

// =====================================================================
// След изменения в журнале
// =====================================================================

/**
 * Изменённые поля для `audit_log.payload`.
 *
 * `undefined` означает «поле не трогали», и в журнале ему места нет: запись
 * обязана отвечать, ЧТО изменилось, а не перечислять всю форму запроса. Значения
 * пишутся как есть: ни одно поле справочника не является ключом, токеном или
 * паролем, поэтому вопрос «а не секрет ли это» решается составом таблиц, а не
 * фильтром по именам полей.
 */
function changedFields(patch: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/**
 * Удаление строки справочника: только пока на неё никто не ссылается.
 *
 * ## Почему удаление вообще есть, если основной способ — отключение
 *
 * Отключение (`is_active = false`) сохраняет строку и всё, что на неё ссылается;
 * это правильный способ вывести организацию или объект из работы. Но у него
 * есть предел: заведённая по ошибке или задублированная импортом карточка, на
 * которую ещё ничего не ссылается, должна исчезать, а не оставаться навсегда
 * отключённым мусором в списке выбора.
 *
 * ## Почему ссылки считаются, а не ловится нарушение ключа
 *
 * Нарушение внешнего ключа даёт SQLSTATE 23503 и имя ограничения — то есть
 * «нельзя» без ответа на вопрос «из-за чего». Администратор, получивший
 * `works_contractor_id_fkey`, вынужден искать причину в чужой схеме. Поэтому
 * ссылки пересчитываются заранее и отказ называет их по-человечески; сам DELETE
 * при этом остаётся под защитой ключа — между подсчётом и удалением строку
 * может занять параллельный запрос, и 23503 в этом случае переводится в тот же
 * 409, а не в 500.
 */
interface ReferenceCheck {
  /** Как называется то, что ссылается, в родительном падеже множественного. */
  readonly label: string;
  readonly countRefs: (executor: Executor, id: string) => Promise<number>;
}

async function countWhere(executor: Executor, table: PgTable, where: SQL): Promise<number> {
  const rows = await executor
    .select({ total: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return rows[0]?.total ?? 0;
}

function refs(label: string, table: PgTable, column: PgColumn): ReferenceCheck {
  return { label, countRefs: (executor, id) => countWhere(executor, table, eq(column, id)) };
}

/**
 * Кто ссылается на контрагента.
 *
 * Список рукописный по той же причине, что и карта ограничений: он часть
 * контракта миграций. Забытая таблица не открывает удаление — её ключ всё равно
 * не пустит, — но лишает отказ внятности, поэтому список пополняется вместе со
 * схемой.
 */
const COUNTERPARTY_REFERENCES: readonly ReferenceCheck[] = [
  refs('пользователи портала', users, users.contractorId),
  refs('объекты (застройщик)', constructionObjects, constructionObjects.developerId),
  refs('объекты (технический заказчик)', constructionObjects, constructionObjects.techCustomerId),
  refs(
    'объекты (генеральный подрядчик)',
    constructionObjects,
    constructionObjects.generalContractorId,
  ),
  refs('шифры рабочей документации', rdDocuments, rdDocuments.designerId),
  refs('комплекты работ', works, works.contractorId),
  refs('комплекты (ведущая организация)', works, works.managedByContractorId),
  refs('закрепления за объектами', objectContractors, objectContractors.contractorId),
  refs('строки переданных реестров', registryItems, registryItems.contractorId),
];

/** Кто ссылается на объект строительства. */
const CONSTRUCTION_OBJECT_REFERENCES: readonly ReferenceCheck[] = [
  refs('включённые разделы работ', objectSections, objectSections.objectId),
  refs('шифры рабочей документации', rdDocuments, rdDocuments.objectId),
  refs('закреплённые подрядчики', objectContractors, objectContractors.objectId),
  refs('реестры', registries, registries.objectId),
  refs('комплекты работ', works, works.objectId),
  refs('профили правил объекта', objectRuleProfiles, objectRuleProfiles.objectId),
  refs('назначенные области видимости', userObjectScopes, userObjectScopes.objectId),
];

/** Перечень мешающих ссылок или `null`, если ссылок нет. */
async function blockingReferences(
  executor: Executor,
  checks: readonly ReferenceCheck[],
  id: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const check of checks) {
    const total = await check.countRefs(executor, id);
    if (total > 0) found.push(`${check.label}: ${String(total)}`);
  }
  return found;
}

/** SQLSTATE нарушения внешнего ключа: строку заняли между подсчётом и удалением. */
const FOREIGN_KEY_VIOLATION = '23503';

function referencedConflict(what: string, found: readonly string[]): never {
  const detail =
    found.length === 0
      ? 'На неё ссылаются данные портала.'
      : `На неё ссылаются: ${found.join(', ')}.`;
  throw conflict(
    `Удалить ${what} нельзя. ${detail} Выведите её из работы отключением: ` +
      'запись останется на месте, а выбрать её в новых документах будет нельзя.',
  );
}

// =====================================================================
// Объекты строительства
// =====================================================================

const OBJECT_SELECTION = {
  id: constructionObjects.id,
  code: constructionObjects.code,
  name: constructionObjects.name,
  fullName: constructionObjects.fullName,
  address: constructionObjects.address,
  isActive: constructionObjects.isActive,
  developerId: constructionObjects.developerId,
  techCustomerId: constructionObjects.techCustomerId,
  generalContractorId: constructionObjects.generalContractorId,
  actNumberPattern: constructionObjects.actNumberPattern,
  cadastralNumber: constructionObjects.cadastralNumber,
  permitIdentifier: constructionObjects.permitIdentifier,
};

export interface ObjectListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly search?: string | undefined;
  readonly isActive?: boolean | undefined;
}

export async function listConstructionObjects(
  db: Database,
  scope: AuthScope,
  params: ObjectListParams,
): Promise<CatalogPage<ConstructionObject>> {
  const after = decodeCursor(params.cursor, textCursorSchema);
  const rows = await db
    .select(OBJECT_SELECTION)
    .from(constructionObjects)
    .where(
      visibleWhere(
        objectVisibility(scope, constructionObjects.id),
        after === null
          ? undefined
          : afterText(constructionObjects.code, constructionObjects.id, after),
        params.isActive === undefined
          ? undefined
          : eq(constructionObjects.isActive, params.isActive),
        params.search === undefined
          ? undefined
          : or(
              ilike(constructionObjects.name, contains(params.search)),
              ilike(constructionObjects.fullName, contains(params.search)),
              ilike(constructionObjects.code, startsWith(params.search)),
            ),
      ),
    )
    .orderBy(asc(constructionObjects.code), asc(constructionObjects.id))
    // На одну больше запрошенного: наличие следующей страницы известно без
    // отдельного COUNT по тому же условию.
    .limit(params.limit + 1);

  return page(rows, params.limit, (row) => ({ k: row.code, id: row.id }));
}

export async function findConstructionObject(
  db: Database,
  scope: AuthScope,
  objectId: string,
): Promise<ConstructionObject | null> {
  const rows = await db
    .select(OBJECT_SELECTION)
    .from(constructionObjects)
    .where(
      visibleWhere(
        objectVisibility(scope, constructionObjects.id),
        eq(constructionObjects.id, objectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateConstructionObjectInput {
  readonly code: string;
  readonly name: string;
  readonly fullName: string;
  readonly address?: string | null | undefined;
  readonly developerId?: string | null | undefined;
  readonly techCustomerId?: string | null | undefined;
  readonly generalContractorId?: string | null | undefined;
  readonly actNumberPattern?: string | null | undefined;
  readonly cadastralNumber?: string | null | undefined;
  readonly permitIdentifier?: string | null | undefined;
}

export async function createConstructionObject(
  db: Database,
  scope: AuthScope,
  input: CreateConstructionObjectInput,
  actor: AuditActor,
): Promise<ConstructionObject> {
  const objectId = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(constructionObjects)
        .values({
          code: input.code,
          name: input.name,
          fullName: input.fullName,
          address: input.address ?? null,
          developerId: input.developerId ?? null,
          techCustomerId: input.techCustomerId ?? null,
          generalContractorId: input.generalContractorId ?? null,
          actNumberPattern: input.actNumberPattern ?? null,
          cadastralNumber: input.cadastralNumber ?? null,
          permitIdentifier: input.permitIdentifier ?? null,
        })
        .returning({ id: constructionObjects.id });

      const id = idOf(inserted);
      await appendAudit(tx, scope, {
        ...actor,
        action: 'object.created',
        entityType: 'construction_object',
        entityId: id,
        objectId: id,
        payload: changedFields(input),
      });
      return id;
    }),
  );

  return required(await findConstructionObject(db, scope, objectId), 'объект строительства');
}

/**
 * Правка объекта. `code` в неё не входит намеренно.
 *
 * Код объекта печатается в номерах актов (`act_number_pattern`) и участвует в
 * именовании выгрузок: смена задним числом рассогласовала бы уже выданные
 * документы с карточкой. Опечатка исправляется отключением объекта и созданием
 * нового — так же, как в любом справочнике с внешне значимым кодом.
 */
export interface UpdateConstructionObjectPatch {
  readonly name?: string | undefined;
  readonly fullName?: string | undefined;
  readonly address?: string | null | undefined;
  readonly isActive?: boolean | undefined;
  readonly developerId?: string | null | undefined;
  readonly techCustomerId?: string | null | undefined;
  readonly generalContractorId?: string | null | undefined;
  readonly actNumberPattern?: string | null | undefined;
  readonly cadastralNumber?: string | null | undefined;
  readonly permitIdentifier?: string | null | undefined;
}

export async function updateConstructionObject(
  db: Database,
  scope: AuthScope,
  objectId: string,
  patch: UpdateConstructionObjectPatch,
  actor: AuditActor,
): Promise<ConstructionObject | null> {
  const fields: Partial<typeof constructionObjects.$inferInsert> = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.fullName !== undefined ? { fullName: patch.fullName } : {}),
    ...(patch.address !== undefined ? { address: patch.address } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.developerId !== undefined ? { developerId: patch.developerId } : {}),
    ...(patch.techCustomerId !== undefined ? { techCustomerId: patch.techCustomerId } : {}),
    ...(patch.generalContractorId !== undefined
      ? { generalContractorId: patch.generalContractorId }
      : {}),
    ...(patch.actNumberPattern !== undefined ? { actNumberPattern: patch.actNumberPattern } : {}),
    ...(patch.cadastralNumber !== undefined ? { cadastralNumber: patch.cadastralNumber } : {}),
    ...(patch.permitIdentifier !== undefined ? { permitIdentifier: patch.permitIdentifier } : {}),
  };
  assertNonEmptyPatch(fields);

  const changed = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(constructionObjects)
        .set({ ...fields, updatedAt: sql`now()` })
        .where(eq(constructionObjects.id, objectId))
        .returning({ id: constructionObjects.id });
      if (updated.length === 0) return false;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'object.updated',
        entityType: 'construction_object',
        entityId: objectId,
        objectId,
        payload: changedFields(patch),
      });
      return true;
    }),
  );
  // Ненайденная строка следа не оставляет: состояние не изменилось, а 404 виден
  // в журнале запросов.
  if (!changed) return null;

  return findConstructionObject(db, scope, objectId);
}

/**
 * Удаление объекта строительства.
 *
 * `null` — объекта нет или он вне области видимости; различать их снаружи
 * нельзя (§1.6), и маршрут отвечает на оба случая одинаково.
 */
export async function deleteConstructionObject(
  db: Database,
  scope: AuthScope,
  objectId: string,
  actor: AuditActor,
): Promise<boolean | null> {
  const existing = await findConstructionObject(db, scope, objectId);
  if (existing === null) return null;

  try {
    return await db.transaction(async (tx) => {
      const blocking = await blockingReferences(tx, CONSTRUCTION_OBJECT_REFERENCES, objectId);
      if (blocking.length > 0) referencedConflict('объект строительства', blocking);

      const removed = await tx
        .delete(constructionObjects)
        .where(eq(constructionObjects.id, objectId))
        .returning({ id: constructionObjects.id });
      if (removed.length === 0) return false;

      // Код и наименование попадают в след: после удаления карточки узнать,
      // что именно исчезло, будет неоткуда.
      await appendAudit(tx, scope, {
        ...actor,
        action: 'object.deleted',
        entityType: 'construction_object',
        entityId: objectId,
        objectId,
        payload: { code: existing.code, name: existing.name },
      });
      return true;
    });
  } catch (error) {
    if (isHttpProblem(error)) throw error;
    if (driverField(error, 'code') === FOREIGN_KEY_VIOLATION) {
      referencedConflict('объект строительства', []);
    }
    throw error;
  }
}

// =====================================================================
// Контрагенты
// =====================================================================

const COUNTERPARTY_SELECTION = {
  id: counterparties.id,
  name: counterparties.name,
  inn: counterparties.inn,
  kpp: counterparties.kpp,
  ogrn: counterparties.ogrn,
  legalAddress: counterparties.legalAddress,
  kind: counterparties.kind,
  isActive: counterparties.isActive,
};

export interface CounterpartyListParams extends ObjectListParams {
  readonly kind?: CounterpartyKind | undefined;
}

export async function listCounterparties(
  db: Database,
  scope: AuthScope,
  params: CounterpartyListParams,
): Promise<CatalogPage<Counterparty>> {
  const after = decodeCursor(params.cursor, textCursorSchema);
  const rows = await db
    .select(COUNTERPARTY_SELECTION)
    .from(counterparties)
    .where(
      visibleWhere(
        counterpartyVisibility(scope),
        after === null ? undefined : afterText(counterparties.name, counterparties.id, after),
        params.kind === undefined ? undefined : eq(counterparties.kind, params.kind),
        params.isActive === undefined ? undefined : eq(counterparties.isActive, params.isActive),
        params.search === undefined
          ? undefined
          : or(
              ilike(counterparties.name, contains(params.search)),
              ilike(counterparties.inn, startsWith(params.search)),
              ilike(counterparties.ogrn, startsWith(params.search)),
            ),
      ),
    )
    .orderBy(asc(counterparties.name), asc(counterparties.id))
    .limit(params.limit + 1);

  return page(rows.map(toCounterparty), params.limit, (row) => ({ k: row.name, id: row.id }));
}

export async function findCounterparty(
  db: Database,
  scope: AuthScope,
  counterpartyId: string,
): Promise<Counterparty | null> {
  const rows = await db
    .select(COUNTERPARTY_SELECTION)
    .from(counterparties)
    .where(visibleWhere(counterpartyVisibility(scope), eq(counterparties.id, counterpartyId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toCounterparty(row);
}

export interface CreateCounterpartyInput {
  readonly name: string;
  readonly kind: CounterpartyKind;
  readonly inn?: string | null | undefined;
  readonly kpp?: string | null | undefined;
  readonly ogrn?: string | null | undefined;
  readonly legalAddress?: string | null | undefined;
}

export async function createCounterparty(
  db: Database,
  scope: AuthScope,
  input: CreateCounterpartyInput,
  actor: AuditActor,
): Promise<Counterparty> {
  const counterpartyId = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(counterparties)
        .values({
          name: input.name,
          kind: input.kind,
          inn: input.inn ?? null,
          kpp: input.kpp ?? null,
          ogrn: input.ogrn ?? null,
          legalAddress: input.legalAddress ?? null,
        })
        .returning({ id: counterparties.id });

      const id = idOf(inserted);
      await appendAudit(tx, scope, {
        ...actor,
        action: 'counterparty.created',
        entityType: 'counterparty',
        entityId: id,
        // Контрагент общий для объектов: привязки к одному объекту у записи нет.
        objectId: null,
        payload: changedFields(input),
      });
      return id;
    }),
  );

  return required(await findCounterparty(db, scope, counterpartyId), 'контрагент');
}

export interface UpdateCounterpartyPatch {
  readonly name?: string | undefined;
  readonly kind?: CounterpartyKind | undefined;
  readonly inn?: string | null | undefined;
  readonly kpp?: string | null | undefined;
  readonly ogrn?: string | null | undefined;
  readonly legalAddress?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

export async function updateCounterparty(
  db: Database,
  scope: AuthScope,
  counterpartyId: string,
  patch: UpdateCounterpartyPatch,
  actor: AuditActor,
): Promise<Counterparty | null> {
  const fields: Partial<typeof counterparties.$inferInsert> = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.inn !== undefined ? { inn: patch.inn } : {}),
    ...(patch.kpp !== undefined ? { kpp: patch.kpp } : {}),
    ...(patch.ogrn !== undefined ? { ogrn: patch.ogrn } : {}),
    ...(patch.legalAddress !== undefined ? { legalAddress: patch.legalAddress } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
  };
  assertNonEmptyPatch(fields);

  const changed = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(counterparties)
        .set({ ...fields, updatedAt: sql`now()` })
        .where(eq(counterparties.id, counterpartyId))
        .returning({ id: counterparties.id });
      if (updated.length === 0) return false;

      // «Кто переименовал контрагента» — вопрос к вердикту AOSR.HDR: он сверяет
      // наименование и реквизиты из акта именно с этой строкой (§9.3).
      await appendAudit(tx, scope, {
        ...actor,
        action: 'counterparty.updated',
        entityType: 'counterparty',
        entityId: counterpartyId,
        objectId: null,
        payload: changedFields(patch),
      });
      return true;
    }),
  );
  if (!changed) return null;

  return findCounterparty(db, scope, counterpartyId);
}

/** Удаление контрагента. `null` — не найден либо вне области видимости. */
export async function deleteCounterparty(
  db: Database,
  scope: AuthScope,
  counterpartyId: string,
  actor: AuditActor,
): Promise<boolean | null> {
  const existing = await findCounterparty(db, scope, counterpartyId);
  if (existing === null) return null;

  try {
    return await db.transaction(async (tx) => {
      const blocking = await blockingReferences(tx, COUNTERPARTY_REFERENCES, counterpartyId);
      if (blocking.length > 0) referencedConflict('контрагента', blocking);

      const removed = await tx
        .delete(counterparties)
        .where(eq(counterparties.id, counterpartyId))
        .returning({ id: counterparties.id });
      if (removed.length === 0) return false;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'counterparty.deleted',
        entityType: 'counterparty',
        entityId: counterpartyId,
        objectId: null,
        payload: { name: existing.name, kind: existing.kind },
      });
      return true;
    });
  } catch (error) {
    if (isHttpProblem(error)) throw error;
    if (driverField(error, 'code') === FOREIGN_KEY_VIOLATION) {
      referencedConflict('контрагента', []);
    }
    throw error;
  }
}

// =====================================================================
// Виды контрагентов
// =====================================================================

/**
 * Виды контрагентов — конфигурация, а не коммерческие данные.
 *
 * Читаются всеми аутентифицированными наравне с видами разделов и каталогом
 * видов ИД: это подписи в форме, а не сведения об участниках стройки.
 * Отключённые виды остаются в выдаче с признаком — форма их не предлагает, но
 * карточка, заведённая раньше, обязана показывать свой вид, а не пустую графу.
 */
export async function listCounterpartyKinds(
  db: Database,
  scope: AuthScope,
): Promise<readonly CounterpartyKindEntry[]> {
  return db
    .select({
      code: counterpartyKinds.code,
      name: counterpartyKinds.name,
      sortOrder: counterpartyKinds.sortOrder,
      isActive: counterpartyKinds.isActive,
    })
    .from(counterpartyKinds)
    .where(configVisibility(scope))
    .orderBy(asc(counterpartyKinds.sortOrder), asc(counterpartyKinds.code));
}

export interface CreateCounterpartyKindInput {
  readonly code: string;
  readonly name: string;
  readonly sortOrder?: number | undefined;
}

export async function createCounterpartyKind(
  db: Database,
  scope: AuthScope,
  input: CreateCounterpartyKindInput,
  actor: AuditActor,
): Promise<CounterpartyKindEntry> {
  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx.insert(counterpartyKinds).values({
        code: input.code,
        name: input.name,
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'counterparty_kind.created',
        entityType: 'counterparty_kind',
        entityId: input.code,
        objectId: null,
        payload: changedFields(input),
      });
    }),
  );

  const created = (await listCounterpartyKinds(db, scope)).find((k) => k.code === input.code);
  return required(created ?? null, 'вид контрагента');
}

// =====================================================================
// Разделы работ: справочник, включённость на объекте, закрепление подрядчиков
// =====================================================================

/**
 * Справочник разделов — КОНФИГУРАЦИЯ, а не коммерческие сведения.
 *
 * Читается всеми аутентифицированными наравне с каталогом видов ИД: перечень
 * названий работ ничего не сообщает о конкретной стройке. Коммерческим он
 * становится ровно там, где привязан к объекту, — и это уже `object_sections`
 * ниже, у которых область видимости объектная.
 */
export async function listSections(
  db: Database,
  scope: AuthScope,
  filter: { readonly isActive?: boolean | undefined } = {},
): Promise<readonly Section[]> {
  return db
    .select({
      code: sections.code,
      name: sections.name,
      sortOrder: sections.sortOrder,
      isActive: sections.isActive,
    })
    .from(sections)
    .where(
      visibleWhere(
        configVisibility(scope),
        filter.isActive === undefined ? undefined : eq(sections.isActive, filter.isActive),
      ),
    )
    .orderBy(asc(sections.sortOrder), asc(sections.code));
}

export interface CreateSectionInput {
  readonly code: string;
  readonly name: string;
  readonly sortOrder?: number | undefined;
}

export async function createSection(
  db: Database,
  scope: AuthScope,
  input: CreateSectionInput,
  actor: AuditActor,
): Promise<Section> {
  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx.insert(sections).values({
        code: input.code,
        name: input.name,
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'section.created',
        entityType: 'section',
        entityId: input.code,
        objectId: null,
        payload: changedFields(input),
      });
    }),
  );

  const created = (await listSections(db, scope)).find((row) => row.code === input.code);
  return required(created ?? null, 'раздел работ');
}

export interface UpdateSectionPatch {
  readonly name?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly isActive?: boolean | undefined;
}

/**
 * Правка раздела. `code` в неё не входит.
 *
 * Код раздела — ссылка: на него смотрят профили правил, наложения объектов,
 * комплекты и реестры. Смена задним числом означала бы, что уже переданные
 * реестры ссылаются в пустоту. Опечатка исправляется отключением раздела и
 * заведением нового — так же, как у кода объекта.
 */
export async function updateSection(
  db: Database,
  scope: AuthScope,
  code: string,
  patch: UpdateSectionPatch,
  actor: AuditActor,
): Promise<Section | null> {
  const fields: Partial<typeof sections.$inferInsert> = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
  };
  assertNonEmptyPatch(fields);

  const changed = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(sections)
        .set(fields)
        .where(eq(sections.code, code))
        .returning({ code: sections.code });
      if (updated.length === 0) return false;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'section.updated',
        entityType: 'section',
        entityId: code,
        objectId: null,
        payload: changedFields(patch),
      });
      return true;
    }),
  );
  if (!changed) return null;

  return (await listSections(db, scope)).find((row) => row.code === code) ?? null;
}

/**
 * Разделы объекта: ВЕСЬ справочник с отметкой о включённости.
 *
 * Не только включённые, и это не расточительность. Экран объекта — то место,
 * где раздел включают, и список из одних включённых не дал бы способа включить
 * первый. `sectionIsActive` отделён от `isActive` намеренно: раздел, отключённый
 * в справочнике, нельзя включить на объекте, и различить «выключен здесь» от
 * «выключен везде» обязан интерфейс, а не догадка пользователя.
 */
export async function listObjectSections(
  db: Database,
  scope: AuthScope,
  objectId: string,
  filter: { readonly isActive?: boolean | undefined } = {},
): Promise<readonly ObjectSection[]> {
  const rows = await db
    .select({
      objectId: sql<string>`${objectId}::uuid`.as('object_id'),
      sectionCode: sections.code,
      name: sections.name,
      sortOrder: sections.sortOrder,
      isActive: sql<boolean>`coalesce(${objectSections.isActive}, false)`.as('enabled'),
      sectionIsActive: sections.isActive,
    })
    .from(sections)
    .leftJoin(
      objectSections,
      and(eq(objectSections.sectionCode, sections.code), eq(objectSections.objectId, objectId)),
    )
    .where(visibleWhere(configVisibility(scope)))
    .orderBy(asc(sections.sortOrder), asc(sections.code));

  return filter.isActive === undefined
    ? rows
    : rows.filter((row) => row.isActive === filter.isActive);
}

/**
 * Включение и отключение раздела на объекте.
 *
 * Отключение не удаляет строку: у отключённого раздела остаются реестры и
 * комплекты прошлых месяцев, и «раздел исчез» читалось бы как потеря данных.
 * Новый комплект в отключённый раздел не заводится — это держит проверка при
 * заведении, а не удаление строки.
 */
export async function setObjectSection(
  db: Database,
  scope: AuthScope,
  objectId: string,
  sectionCode: string,
  isActive: boolean,
  actor: AuditActor,
): Promise<ObjectSection | null> {
  const known = await db
    .select({ isActive: sections.isActive })
    .from(sections)
    .where(eq(sections.code, sectionCode))
    .limit(1);
  const section = known[0];
  if (section === undefined) return null;
  if (isActive && !section.isActive) {
    throw conflict(
      'Раздел отключён в справочнике: включить его на объекте нельзя. ' +
        'Сначала включите сам раздел.',
    );
  }

  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(objectSections)
        .values({ objectId, sectionCode, isActive })
        .onConflictDoUpdate({
          target: [objectSections.objectId, objectSections.sectionCode],
          set: { isActive },
        });

      await appendAudit(tx, scope, {
        ...actor,
        action: isActive ? 'object_section.enabled' : 'object_section.disabled',
        entityType: 'object_section',
        entityId: `${objectId}:${sectionCode}`,
        objectId,
        payload: { sectionCode, isActive },
      });
    }),
  );

  return (
    (await listObjectSections(db, scope, objectId)).find(
      (row) => row.sectionCode === sectionCode,
    ) ?? null
  );
}

/**
 * Подрядчики, закреплённые за объектом.
 *
 * До 0028 закрепления не существовало вовсе, и признаком его была уже
 * существующая поставка — из-за чего подрядчик не мог завести первую. Теперь это
 * явная связь, и она же цель составного внешнего ключа комплекта: маршрут,
 * забывший проверить закрепление, не станет способом его обойти.
 */
export async function listObjectContractors(
  db: Database,
  scope: AuthScope,
  objectId: string,
): Promise<readonly ObjectContractor[]> {
  return db
    .select({
      objectId: objectContractors.objectId,
      contractorId: objectContractors.contractorId,
      name: counterparties.name,
      inn: counterparties.inn,
      isActive: objectContractors.isActive,
    })
    .from(objectContractors)
    .innerJoin(counterparties, eq(counterparties.id, objectContractors.contractorId))
    .where(
      visibleWhere(
        objectVisibility(scope, objectContractors.objectId),
        eq(objectContractors.objectId, objectId),
      ),
    )
    .orderBy(asc(counterparties.name));
}

/**
 * Организации, закреплённые за объектом, — с реквизитами для сопоставления.
 *
 * Отдельно от `listObjectContractors`, и по двум причинам сразу. Во-первых,
 * здесь нужен ОГРН: сопоставление организации из акта идёт тройкой
 * ИНН → ОГРН → наименование (`matchCounterparty`), и без третьего признака
 * половина актов корпуса не сходится. Во-вторых, здесь нет области видимости:
 * зовёт конвейер, у которого пользователя нет, и проверять его правами
 * человека было бы подлогом — исполнитель не решение пользователя, а
 * прочитанный факт (то же основание, что у `fillWorkPeriodIfEmpty`).
 *
 * Отбираются только АКТИВНЫЕ закрепления: неактивное не пройдёт составной ключ
 * `works_contractor_fk`, и подставить его значило бы получить отказ базы вместо
 * записи.
 */
export async function listObjectContractorParties(
  db: Database,
  objectId: string,
): Promise<readonly { id: string; name: string; inn: string | null; ogrn: string | null }[]> {
  return db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      inn: counterparties.inn,
      ogrn: counterparties.ogrn,
    })
    .from(objectContractors)
    .innerJoin(counterparties, eq(counterparties.id, objectContractors.contractorId))
    .where(and(eq(objectContractors.objectId, objectId), eq(objectContractors.isActive, true)))
    .orderBy(asc(counterparties.name));
}

export async function setObjectContractor(
  db: Database,
  scope: AuthScope,
  objectId: string,
  contractorId: string,
  isActive: boolean,
  actor: AuditActor,
): Promise<ObjectContractor | null> {
  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(objectContractors)
        .values({ objectId, contractorId, isActive })
        .onConflictDoUpdate({
          target: [objectContractors.objectId, objectContractors.contractorId],
          set: { isActive },
        });

      await appendAudit(tx, scope, {
        ...actor,
        action: isActive ? 'object_contractor.assigned' : 'object_contractor.released',
        entityType: 'object_contractor',
        entityId: `${objectId}:${contractorId}`,
        objectId,
        payload: { contractorId, isActive },
      });
    }),
  );

  return (
    (await listObjectContractors(db, scope, objectId)).find(
      (row) => row.contractorId === contractorId,
    ) ?? null
  );
}

// =====================================================================
// Профили разделов (версионные)
// =====================================================================

const SECTION_PROFILE_SELECTION = {
  id: sectionProfiles.id,
  sectionCode: sectionProfiles.sectionCode,
  version: sectionProfiles.version,
  effectiveFrom: sectionProfiles.effectiveFrom,
  effectiveTo: sectionProfiles.effectiveTo,
  expectedDocTypes: sectionProfiles.expectedDocTypes,
  materialCategories: sectionProfiles.materialCategories,
  materialMatrix: sectionProfiles.materialMatrix,
  enabledRuleCodes: sectionProfiles.enabledRuleCodes,
  thresholds: sectionProfiles.thresholds,
  autonomyLevel: sectionProfiles.autonomyLevel,
  publishedAt: isoTimestampOrNull(sectionProfiles.publishedAt),
  publishedBy: sectionProfiles.publishedBy,
};

export async function listSectionProfiles(
  db: Database,
  scope: AuthScope,
  filter: { readonly sectionCode?: string | undefined } = {},
): Promise<readonly SectionProfile[]> {
  const rows = await db
    .select(SECTION_PROFILE_SELECTION)
    .from(sectionProfiles)
    .where(
      visibleWhere(
        configVisibility(scope),
        filter.sectionCode === undefined
          ? undefined
          : eq(sectionProfiles.sectionCode, filter.sectionCode),
      ),
    )
    .orderBy(asc(sectionProfiles.sectionCode), desc(sectionProfiles.version));
  return rows.map(toSectionProfile);
}

export async function findSectionProfile(
  db: Database,
  scope: AuthScope,
  profileId: string,
): Promise<SectionProfile | null> {
  const rows = await db
    .select(SECTION_PROFILE_SELECTION)
    .from(sectionProfiles)
    .where(visibleWhere(configVisibility(scope), eq(sectionProfiles.id, profileId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSectionProfile(row);
}

/**
 * Профиль, действующий на дату.
 *
 * Только опубликованные версии: черновик, попавший в прогон, менял бы результат
 * проверки, не будучи решением администратора.
 *
 * ## Разрешение по дате — для ПИННИНГА, а не для воспроизведения
 *
 * Эта функция отвечает на вопрос «какой профиль настроен сейчас» и вызывается
 * один раз — в момент старта прогона, чтобы записать ответ в
 * `validation_runs.section_profile_id` (0011). Воспроизведение прошлого прогона
 * читает уже записанный идентификатор, а не спрашивает дату снова: иначе смысл
 * версионности теряется — прогон месячной давности «переезжал» бы на другой
 * профиль при каждой правке истории или сдвиге периода.
 *
 * ## Единственность здесь проверяется, а не предполагается
 *
 * Сортировка по `effective_from desc` была ошибкой, и не в порядке колонок:
 * прежний код молча выбирал ОДНУ строку из перекрывающихся, поэтому дефект
 * версионности (два открытых периода) выглядел как исправная работа — на одну
 * дату отвечал старый профиль, на другую новый. Инвариант «на любую дату
 * действует не более одного профиля» держит частичный уникальный индекс 0011,
 * а чтение берёт две строки и ОТКАЗЫВАЕТ, если их две: испорченные данные
 * обязаны быть видны, а не разрешаться жребием сортировки. Порядок по версии
 * оставлен как определённость запроса, а не как способ выбрать «правильную».
 */
export async function findEffectiveSectionProfile(
  db: Database,
  scope: AuthScope,
  sectionCode: string,
  onDate: string,
): Promise<SectionProfile | null> {
  const rows = await db
    .select(SECTION_PROFILE_SELECTION)
    .from(sectionProfiles)
    .where(
      visibleWhere(
        configVisibility(scope),
        eq(sectionProfiles.sectionCode, sectionCode),
        sql`${sectionProfiles.publishedAt} is not null`,
        sql`${sectionProfiles.effectiveFrom} <= ${onDate}::date`,
        sql`(${sectionProfiles.effectiveTo} is null or ${sectionProfiles.effectiveTo} >= ${onDate}::date)`,
      ),
    )
    .orderBy(desc(sectionProfiles.version))
    .limit(2);

  if (rows.length > 1) {
    throw internal({
      logDetail:
        `на дату ${onDate} у раздела ${sectionCode} действует больше одного ` +
        'опубликованного профиля: нарушен ux_section_profiles_open_period',
    });
  }

  const row = rows[0];
  return row === undefined ? null : toSectionProfile(row);
}

// ---------------------------------------------------------------------
// Инварианты версионности профиля
// ---------------------------------------------------------------------

/**
 * Строка того же раздела в объёме, который нужен инвариантам периода.
 *
 * `effectiveFrom` и `effectiveTo` — тип `date`, драйвер отдаёт их строкой
 * `YYYY-MM-DD`. Такие строки сравниваются лексикографически ровно так же, как
 * даты, поэтому ниже сравнение идёт строками и без разбора в `Date`: разбор внёс
 * бы зависимость от часового пояса процесса там, где её нет в данных.
 */
interface ProfilePeriodRow {
  readonly version: number;
  readonly effectiveFrom: string;
  readonly publishedAt: string | null;
}

/** Минимум поставок раздела для перехода в `automatic` (§16). */
const AUTONOMY_MIN_WORKS = 5;

/** Порог доли документов с ручной правкой типа (§16); измеряется на S8. */
const AUTONOMY_MAX_MANUAL_TYPE_SHARE = 0.1;

/** Что мешает включить `automatic` прямо сейчас. */
interface AutonomyRefusal {
  readonly code: 'autonomy_bootstrap' | 'autonomy_insufficient_data';
  readonly message: string;
}

export interface AutonomyReadiness {
  readonly ready: boolean;
  /** Комплектов этого раздела, доведённых до подачи. */
  readonly works: number;
  readonly requiredWorks: number;
  readonly refusals: readonly AutonomyRefusal[];
  /** Критерии §16, которых пока нечем измерить: они названы, а не забыты. */
  readonly unmeasured: readonly string[];
}

/**
 * Готовность раздела работ к автоматическому режиму (§16).
 *
 * Отдельная экспортируемая функция, а не условие внутри записи, по двум
 * причинам. Во-первых, тот же ответ нужен экрану администрирования: «до
 * автоматизма не хватает двух комплектов» — это то, что администратор обязан
 * видеть ДО попытки переключения, а не узнавать из 422. Во-вторых, гейт §16
 * численный, и численное правило должно быть проверяемо само по себе.
 *
 * Считаются комплекты, ДОВЕДЁННЫЕ ДО ПОДАЧИ (`submitted_at is not null`), а не
 * все заведённые: черновик не даёт ни одной единицы статистики распознавания, и
 * засчитывать его значило бы открывать автоматизм на пустых записях. Ревизий у
 * комплекта много, поэтому счёт идёт по `distinct` комплектам — §16 говорит о
 * поданных комплектах раздела, а не о попытках их подать.
 *
 * TODO(S8): второй и третий критерии §16 — доля документов, тип которых человек
 * изменил вручную (порог `AUTONOMY_MAX_MANUAL_TYPE_SHARE`), и отсутствие тихих
 * высокоуверенных ошибок границы документа. Их источник — подтверждения разметки
 * и классификации, которые появляются вместе с конвейером S8. До тех пор гейт
 * держится на числе комплектов, и неизмеренные критерии перечислены в
 * `unmeasured` явно: молчаливо считать их выполненными нельзя.
 */
export async function evaluateSectionAutonomyReadiness(
  executor: Executor,
  sectionCode: string,
  siblings: readonly ProfilePeriodRow[],
): Promise<AutonomyReadiness> {
  const refusals: AutonomyRefusal[] = [];

  // §0.5, п.5: автоматизм включается на статистике, которая набирается, пока
  // действует ОПУБЛИКОВАННЫЙ профиль. Поэтому условие — наличие опубликованной
  // версии, а не «версия не первая»: иначе автоматизм включался бы черновиком.
  if (!siblings.some((row) => row.publishedAt !== null)) {
    refusals.push({
      code: 'autonomy_bootstrap',
      message:
        'Новый раздел стартует в режиме assisted: автоматический режим ' +
        'включается только после опубликованной версии профиля.',
    });
  }

  // Раздел теперь лежит на самом комплекте, поэтому цепочка «поставка → том →
  // раздел объекта» схлопнулась в одно условие. Файлы реестров в
  // счёт не идут: это не работы, и автоматизм по ним не калибруется.
  const counted = await executor
    .select({ total: sql<number>`count(distinct ${works.id})::int` })
    .from(works)
    .innerJoin(submissionRevisions, eq(submissionRevisions.workId, works.id))
    .where(
      and(
        eq(works.sectionCode, sectionCode),
        eq(works.kind, 'complect'),
        sql`${submissionRevisions.submittedAt} is not null`,
      ),
    );
  const delivered = counted[0]?.total ?? 0;

  if (delivered < AUTONOMY_MIN_WORKS) {
    refusals.push({
      code: 'autonomy_insufficient_data',
      message:
        `Недостаточно данных: поданных комплектов ${delivered} из ${AUTONOMY_MIN_WORKS}. ` +
        'Автоматический режим включается по накопленной статистике раздела (§16), ' +
        'а не сразу после публикации первой версии профиля.',
    });
  }

  return {
    ready: refusals.length === 0,
    works: delivered,
    requiredWorks: AUTONOMY_MIN_WORKS,
    refusals,
    unmeasured: [
      `доля документов с ручной правкой типа ниже ${AUTONOMY_MAX_MANUAL_TYPE_SHARE * 100}%`,
      'ни одной тихой высокоуверенной ошибки границы документа',
    ],
  };
}

/**
 * Переход в `automatic` без подтверждения статистикой не проходит.
 *
 * Молчаливого перехода быть не должно: до этой проверки гейт §16 обходился двумя
 * запросами — опубликовать пустой assisted-профиль, затем сразу automatic, — и
 * численные критерии не проверялись нигде.
 */
async function assertAutonomyConfirmed(
  executor: Executor,
  sectionCode: string,
  siblings: readonly ProfilePeriodRow[],
): Promise<void> {
  const readiness = await evaluateSectionAutonomyReadiness(executor, sectionCode, siblings);
  if (readiness.ready) return;

  throw unprocessable(
    readiness.refusals.map((refusal) => ({
      pointer: '/autonomyLevel',
      code: refusal.code,
      message: refusal.message,
    })),
    'Автоматический режим недоступен: переход требует подтверждения по накопленной ' +
      'статистике раздела (§16).',
  );
}

/** Дата начала самой поздней ОПУБЛИКОВАННОЙ версии или `null`, если её нет. */
function latestPublishedStart(siblings: readonly ProfilePeriodRow[]): string | null {
  return siblings
    .filter((row) => row.publishedAt !== null)
    .reduce<string | null>(
      (latest, row) => (latest === null || row.effectiveFrom > latest ? row.effectiveFrom : latest),
      null,
    );
}

/**
 * История опубликованных периодов не переписывается.
 *
 * Без этого правила публикация профиля с ранней `effective_from` давала два
 * открытых периода: закрыть предшественника датой «начало нового минус день»
 * нельзя, когда новый начинается РАНЬШЕ, — `effective_to` вышел бы меньше
 * `effective_from` и не прошёл CHECK `section_profiles_period_chk`. Отсюда
 * прежний код просто не закрывал такую версию, и на одну дату действовали два
 * профиля, а на другую — тот, который на неё не настраивали вовсе.
 *
 * Правильный ответ здесь — отказ, а не изобретательное закрытие периодов.
 * Профиль задаёт, что портал требовал от комплекта; изменить это задним числом
 * значит изменить вердикты уже выполненных прогонов. Исправление вносится новой
 * версией «с сегодня», и именно так это и сказано администратору.
 */
function assertHistoryNotRewritten(
  siblings: readonly ProfilePeriodRow[],
  effectiveFrom: string,
): void {
  const latest = latestPublishedStart(siblings);
  if (latest === null || effectiveFrom > latest) return;

  throw unprocessable(
    [
      {
        pointer: '/effectiveFrom',
        code: 'profile_history_immutable',
        message:
          `У этого раздела уже опубликован профиль с началом действия ${latest}. ` +
          'История версий не переписывается: опубликуйте новую версию с датой начала позже ' +
          `${latest} — например, с сегодняшней.`,
      },
    ],
    'Начало действия профиля попадает в уже опубликованный период.',
  );
}

/**
 * Закрывает периоды опубликованных версий, которые новая версия перекрывает.
 *
 * Условие — именно пересечение периодов, а не «дата начала меньше»: версия с
 * заданным `effective_to`, который заканчивается ПОСЛЕ начала новой, тоже
 * перекрывается и тоже обязана быть закрыта. Прежний код смотрел только на
 * `effective_to IS NULL` и такую версию не трогал.
 *
 * Закрываются только ОПУБЛИКОВАННЫЕ версии, и только при публикации новой.
 * Черновик ничего не заканчивает: закрой период действующего профиля черновиком,
 * который потом не опубликуют, — и у раздела не станет действующего профиля
 * вовсе, причём молча.
 *
 * `effective_from < новая дата` в условии оставлено сознательно: только такую
 * версию можно закрыть днём ранее, не нарушив CHECK периода. Версий с более
 * поздним началом здесь быть не может — их отсекает
 * `assertHistoryNotRewritten()`, и это единственное место, где такое состояние
 * вообще могло бы возникнуть.
 */
async function closeSupersededPeriods(
  executor: Executor,
  sectionCode: string,
  effectiveFrom: string,
  exceptProfileId: string | null,
): Promise<void> {
  await executor
    .update(sectionProfiles)
    .set({ effectiveTo: sql`(${effectiveFrom}::date - 1)` })
    .where(
      and(
        eq(sectionProfiles.sectionCode, sectionCode),
        sql`${sectionProfiles.publishedAt} is not null`,
        lt(sectionProfiles.effectiveFrom, effectiveFrom),
        or(
          isNull(sectionProfiles.effectiveTo),
          sql`${sectionProfiles.effectiveTo} >= ${effectiveFrom}::date`,
        ),
        // Публикация черновика: сам себя он не закрывает.
        exceptProfileId === null ? undefined : ne(sectionProfiles.id, exceptProfileId),
      ),
    );
}

/** Коды из запроса, которых нет в справочнике. */
function absentCodes(
  requested: readonly string[],
  known: readonly { readonly code: string }[],
): readonly string[] {
  const present = new Set(known.map((row) => row.code));
  return requested.filter((code) => !present.has(code));
}

/**
 * Профиль не принимает висячих ссылок на виды ИД и правила.
 *
 * Это не формальная строгость. По §9.1 правило, не попавшее в
 * `enabled_rule_codes`, НЕ ИСПОЛНЯЕТСЯ, а вид ИД, которого нет в каталоге, не
 * попадает в ожидаемый состав комплекта. Значит опечатка в коде выключает
 * проверку — и выключает молча: профиль сохраняется, прогон отвечает «замечаний
 * нет», и отличить это от исправной работы нельзя ничем. При публикации набора
 * правил такая сверка уже есть (422 «правило не заведено в реестре»); профиль
 * влияет на результат проверки не меньше.
 *
 * Неизвестные коды перечисляются ВСЕ и сразу: администратор правит список из
 * десятка кодов, и отказ по первому превратил бы правку в десять запросов.
 *
 * Категории материалов проверяются не здесь, а схемой входа
 * (`materialCategoryCodeSchema`): их перечень закрыт кодом — категория
 * осмысленна лишь настолько, насколько её понимают правила §9.4, — и потому
 * является вопросом формы, а не состояния БД.
 */
export async function assertKnownProfileReferences(
  executor: Executor,
  references: {
    readonly expectedDocTypes: readonly string[];
    readonly enabledRuleCodes: readonly string[];
  },
): Promise<void> {
  const requestedDocTypes = [...new Set(references.expectedDocTypes)];
  const requestedRules = [...new Set(references.enabledRuleCodes)];

  const knownDocTypes =
    requestedDocTypes.length === 0
      ? []
      : await executor
          .select({ code: docTypes.code })
          .from(docTypes)
          .where(inArray(docTypes.code, requestedDocTypes));
  const knownRules =
    requestedRules.length === 0
      ? []
      : await executor
          .select({ code: ruleDefinitions.code })
          .from(ruleDefinitions)
          .where(inArray(ruleDefinitions.code, requestedRules));

  const errors = [
    ...absentCodes(requestedDocTypes, knownDocTypes).map((code) => ({
      pointer: '/expectedDocTypes',
      code: 'unknown-doc-type',
      message: `Вид ИД ${code} не заведён в каталоге`,
    })),
    ...absentCodes(requestedRules, knownRules).map((code) => ({
      pointer: '/enabledRuleCodes',
      code: 'unknown-rule',
      message: `Правило ${code} не заведено в реестре`,
    })),
  ];
  if (errors.length === 0) return;

  throw unprocessable(
    errors,
    'Профиль ссылается на коды, которых нет в справочниках: такая ссылка молча ' +
      'отключила бы проверку (§9.1).',
  );
}

export interface CreateSectionProfileInput {
  readonly sectionCode: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null | undefined;
  readonly expectedDocTypes: readonly string[];
  readonly materialCategories: readonly string[];
  readonly materialMatrix: JsonValue;
  readonly enabledRuleCodes: readonly string[];
  readonly thresholds: JsonValue;
  readonly autonomyLevel: AutonomyLevel;
  readonly publish: boolean;
}

/**
 * Новая версия профиля раздела.
 *
 * Всё, что делается здесь, а не в обработчике маршрута, — вопросы к состоянию
 * БД, и потому решается в одной транзакции с самой вставкой:
 *
 * 1. **Ссылки на справочники** — виды ИД и правила обязаны существовать, иначе
 *    опечатка молча выключает проверку (`assertKnownProfileReferences`).
 * 2. **Номер версии** — `max(version) + 1` по этому виду раздела. Гонка закрыта
 *    UNIQUE `section_profiles_kind_version_uq`: проигравший получает 409 и
 *    повторяет запрос, а не переписывает чужую версию.
 * 3. **`automatic` требует подтверждения статистикой** (§0.5 п.5, §16) —
 *    `assertAutonomyConfirmed()`, а не «есть опубликованная версия».
 * 4. **История не переписывается, а периоды не перекрываются** —
 *    `assertHistoryNotRewritten()` плюс `closeSupersededPeriods()`.
 *
 * Проверки истории и закрытие периодов относятся к ПУБЛИКАЦИИ, а не к созданию
 * записи: черновик — рабочая копия администратора, он не действует ни на какую
 * дату (§9.1 отличает «профиль не настроен» от «комплект неполон») и потому
 * ничьего периода не заканчивает. Тот же набор проверок повторяет
 * `publishSectionProfile()` — черновик может дожидаться публикации сколько
 * угодно, и к её моменту состояние БД уже другое.
 */
export async function createSectionProfile(
  db: Database,
  scope: AuthScope,
  input: CreateSectionProfileInput,
  actor: AuditActor,
): Promise<SectionProfile> {
  const profileId = await guardConstraints(() =>
    db.transaction(async (tx) => {
      await assertKnownProfileReferences(tx, input);

      const existing = await tx
        .select({
          version: sectionProfiles.version,
          effectiveFrom: sectionProfiles.effectiveFrom,
          publishedAt: sectionProfiles.publishedAt,
        })
        .from(sectionProfiles)
        .where(eq(sectionProfiles.sectionCode, input.sectionCode));

      const nextVersion = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

      if (input.autonomyLevel === 'automatic') {
        await assertAutonomyConfirmed(tx, input.sectionCode, existing);
      }

      if (input.publish) {
        assertHistoryNotRewritten(existing, input.effectiveFrom);
        await closeSupersededPeriods(tx, input.sectionCode, input.effectiveFrom, null);
      }

      const inserted = await tx
        .insert(sectionProfiles)
        .values({
          sectionCode: input.sectionCode,
          version: nextVersion,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          expectedDocTypes: [...input.expectedDocTypes],
          materialCategories: [...input.materialCategories],
          materialMatrix: input.materialMatrix,
          enabledRuleCodes: [...input.enabledRuleCodes],
          thresholds: input.thresholds,
          autonomyLevel: input.autonomyLevel,
          ...(input.publish
            ? { publishedAt: sql`now()`, publishedBy: scope.userId }
            : { publishedAt: null, publishedBy: null }),
        })
        .returning({ id: sectionProfiles.id });

      const id = idOf(inserted);
      await appendAudit(tx, scope, {
        ...actor,
        // Публикация версии в момент создания и создание черновика — разные
        // события: первое сразу меняет результат прогонов, второе не меняет
        // ничего. Разные имена действия, а не флаг в payload, потому что вопрос
        // «когда сменился действующий профиль» задаётся к списку действий.
        action: input.publish ? 'section_profile.published' : 'section_profile.created',
        entityType: 'section_profile',
        entityId: id,
        // Профиль принадлежит ВИДУ раздела, а не объекту: одна версия действует
        // на всех объектах, где такой раздел есть.
        objectId: null,
        payload: {
          sectionCode: input.sectionCode,
          version: nextVersion,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          autonomyLevel: input.autonomyLevel,
          published: input.publish,
        },
      });
      return id;
    }),
  );

  return required(await findSectionProfile(db, scope, profileId), 'профиль раздела');
}

/**
 * Публикация профиля.
 *
 * Отдельным действием, а не флагом в правке: опубликованный профиль участвует в
 * прогонах проверок, и переход «черновик → опубликован» обязан иметь автора
 * (`published_by`) и время. Повторная публикация отвергается — иначе `published_at`
 * поехал бы вперёд у профиля, по которому уже выполнены прогоны.
 *
 * Публикация проходит те же четыре проверки, что и создание опубликованной
 * версии, и повторяет их НЕ ради симметрии: черновик мог быть заведён месяц
 * назад, и с тех пор у раздела появился профиль с более поздним периодом,
 * вид ИД мог не появиться в каталоге, а `automatic` в черновике не значит, что
 * статистика §16 набрана. Проверить состояние можно только сейчас — и в той же
 * транзакции, которая ставит `published_at`.
 */
export async function publishSectionProfile(
  db: Database,
  scope: AuthScope,
  profileId: string,
  actor: AuditActor,
): Promise<SectionProfile | null> {
  const current = await findSectionProfile(db, scope, profileId);
  if (current === null) return null;
  if (current.publishedAt !== null) {
    throw conflict('Профиль уже опубликован.');
  }

  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await assertKnownProfileReferences(tx, current);

      const siblings = await tx
        .select({
          version: sectionProfiles.version,
          effectiveFrom: sectionProfiles.effectiveFrom,
          publishedAt: sectionProfiles.publishedAt,
        })
        .from(sectionProfiles)
        .where(eq(sectionProfiles.sectionCode, current.sectionCode));

      if (current.autonomyLevel === 'automatic') {
        await assertAutonomyConfirmed(tx, current.sectionCode, siblings);
      }
      assertHistoryNotRewritten(siblings, current.effectiveFrom);
      await closeSupersededPeriods(tx, current.sectionCode, current.effectiveFrom, profileId);

      // Условие `publishedAt is null` остаётся в самом UPDATE: между чтением
      // выше и этой записью профиль мог опубликовать другой администратор, и
      // проверка по прочитанному значению относилась бы к прошлому состоянию.
      const published = await tx
        .update(sectionProfiles)
        .set({ publishedAt: sql`now()`, publishedBy: scope.userId })
        .where(and(eq(sectionProfiles.id, profileId), isNull(sectionProfiles.publishedAt)))
        .returning({ id: sectionProfiles.id });
      if (published.length === 0) return;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'section_profile.published',
        entityType: 'section_profile',
        entityId: profileId,
        objectId: null,
        payload: {
          sectionCode: current.sectionCode,
          version: current.version,
          effectiveFrom: current.effectiveFrom,
        },
      });
    }),
  );

  return findSectionProfile(db, scope, profileId);
}

// =====================================================================
// Реестр рабочей документации
// =====================================================================

const RD_SELECTION = {
  id: rdDocuments.id,
  objectId: rdDocuments.objectId,
  cipher: rdDocuments.cipher,
  revision: rdDocuments.revision,
  name: rdDocuments.name,
  designerId: rdDocuments.designerId,
  isActive: rdDocuments.isActive,
};

export interface RdDocumentListParams extends ObjectListParams {
  readonly objectId: string;
}

export async function listRdDocuments(
  db: Database,
  scope: AuthScope,
  params: RdDocumentListParams,
): Promise<CatalogPage<RdDocument>> {
  const after = decodeCursor(params.cursor, textCursorSchema);
  const rows = await db
    .select(RD_SELECTION)
    .from(rdDocuments)
    .where(
      visibleWhere(
        objectVisibility(scope, rdDocuments.objectId),
        eq(rdDocuments.objectId, params.objectId),
        after === null ? undefined : afterText(rdDocuments.cipher, rdDocuments.id, after),
        params.isActive === undefined ? undefined : eq(rdDocuments.isActive, params.isActive),
        params.search === undefined
          ? undefined
          : or(
              ilike(rdDocuments.cipher, contains(params.search)),
              ilike(rdDocuments.name, contains(params.search)),
            ),
      ),
    )
    .orderBy(asc(rdDocuments.cipher), asc(rdDocuments.id))
    .limit(params.limit + 1);

  return page(rows, params.limit, (row) => ({ k: row.cipher, id: row.id }));
}

export async function findRdDocument(
  db: Database,
  scope: AuthScope,
  rdDocumentId: string,
): Promise<RdDocument | null> {
  const rows = await db
    .select(RD_SELECTION)
    .from(rdDocuments)
    .where(
      visibleWhere(objectVisibility(scope, rdDocuments.objectId), eq(rdDocuments.id, rdDocumentId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateRdDocumentInput {
  readonly cipher: string;
  readonly revision?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly designerId?: string | null | undefined;
}

export async function createRdDocument(
  db: Database,
  scope: AuthScope,
  objectId: string,
  input: CreateRdDocumentInput,
  actor: AuditActor,
): Promise<RdDocument> {
  const rdDocumentId = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const inserted = await tx
        .insert(rdDocuments)
        .values({
          objectId,
          cipher: input.cipher,
          revision: input.revision ?? null,
          name: input.name ?? null,
          designerId: input.designerId ?? null,
        })
        .returning({ id: rdDocuments.id });

      const id = idOf(inserted);
      await appendAudit(tx, scope, {
        ...actor,
        action: 'rd_document.created',
        entityType: 'rd_document',
        entityId: id,
        objectId,
        payload: changedFields(input),
      });
      return id;
    }),
  );

  return required(await findRdDocument(db, scope, rdDocumentId), 'документ РД');
}

export interface UpdateRdDocumentPatch {
  readonly cipher?: string | undefined;
  readonly revision?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly designerId?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

export async function updateRdDocument(
  db: Database,
  scope: AuthScope,
  rdDocumentId: string,
  patch: UpdateRdDocumentPatch,
  actor: AuditActor,
): Promise<RdDocument | null> {
  const fields: Partial<typeof rdDocuments.$inferInsert> = {
    ...(patch.cipher !== undefined ? { cipher: patch.cipher } : {}),
    ...(patch.revision !== undefined ? { revision: patch.revision } : {}),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.designerId !== undefined ? { designerId: patch.designerId } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
  };
  assertNonEmptyPatch(fields);

  const changed = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(rdDocuments)
        .set(fields)
        .where(eq(rdDocuments.id, rdDocumentId))
        .returning({ id: rdDocuments.id, objectId: rdDocuments.objectId });
      const row = updated[0];
      if (row === undefined) return false;

      // Шифр РД сверяют вердикты AOSR.P2/P6 (§9.3): «шифр в акте есть, а в
      // реестре нет» после правки реестра объясняется только журналом.
      await appendAudit(tx, scope, {
        ...actor,
        action: 'rd_document.updated',
        entityType: 'rd_document',
        entityId: rdDocumentId,
        objectId: row.objectId,
        payload: changedFields(patch),
      });
      return true;
    }),
  );
  if (!changed) return null;

  return findRdDocument(db, scope, rdDocumentId);
}

// =====================================================================
// Каталог видов ИД: базовые значения плюс наложения
// =====================================================================

/**
 * Эффективное значение = наложение, иначе базовый каталог.
 *
 * Базовые строки `doc_types` приходят seed-миграцией и правке из портала не
 * подлежат: следующий seed их перезапишет, и настройка администратора исчезла бы
 * без следа. Поэтому портал пишет `doc_type_overrides`, а читает `coalesce`.
 */
const EFFECTIVE_SORT_ORDER = sql<number>`coalesce(${docTypeOverrides.sortOrder}, ${docTypes.sortOrder})`;
const EFFECTIVE_IS_ACTIVE = sql<boolean>`coalesce(${docTypeOverrides.isActive}, true)`;

const DOC_TYPE_SELECTION = {
  code: docTypes.code,
  name: sql<string>`coalesce(${docTypeOverrides.name}, ${docTypes.name})`,
  shortName: docTypes.shortName,
  groupCode: docTypes.groupCode,
  kind: docTypes.kind,
  hasAnnexes: docTypes.hasAnnexes,
  matchHints: sql<unknown>`coalesce(${docTypeOverrides.matchHints}, ${docTypes.matchHints})`,
  fieldSchema: docTypes.fieldSchema,
  isSystem: docTypes.isSystem,
  isFallback: docTypes.isFallback,
  sortOrder: EFFECTIVE_SORT_ORDER,
  isActive: EFFECTIVE_IS_ACTIVE,
  hasOverride: sql<boolean>`(${docTypeOverrides.docTypeCode} is not null)`,
};

export interface DocTypeFilter {
  readonly groupCode?: DocTypeGroup | undefined;
  readonly kind?: DocTypeKind | undefined;
  /** По умолчанию отключённые наложением типы не выдаются. */
  readonly includeInactive?: boolean | undefined;
}

/**
 * Каталог видов ИД целиком, без курсора.
 *
 * Клиенту он нужен весь: это выпадающий список подтверждения типа документа на
 * экране разметки. Страница выдачи означала бы, что часть типов в списке
 * отсутствует, и инженер выбрал бы «не тот, зато видимый».
 */
export async function listDocTypes(
  db: Database,
  scope: AuthScope,
  filter: DocTypeFilter = {},
): Promise<readonly DocTypeView[]> {
  const rows = await db
    .select(DOC_TYPE_SELECTION)
    .from(docTypes)
    .leftJoin(docTypeOverrides, eq(docTypeOverrides.docTypeCode, docTypes.code))
    .where(
      visibleWhere(
        configVisibility(scope),
        filter.groupCode === undefined ? undefined : eq(docTypes.groupCode, filter.groupCode),
        filter.kind === undefined ? undefined : eq(docTypes.kind, filter.kind),
        filter.includeInactive === true ? undefined : sql`${EFFECTIVE_IS_ACTIVE} is true`,
      ),
    )
    .orderBy(asc(docTypes.groupCode), asc(EFFECTIVE_SORT_ORDER), asc(docTypes.code));
  return rows.map(toDocTypeView);
}

export async function findDocType(
  db: Database,
  scope: AuthScope,
  code: string,
): Promise<DocTypeView | null> {
  const rows = await db
    .select(DOC_TYPE_SELECTION)
    .from(docTypes)
    .leftJoin(docTypeOverrides, eq(docTypeOverrides.docTypeCode, docTypes.code))
    .where(visibleWhere(configVisibility(scope), eq(docTypes.code, code)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toDocTypeView(row);
}

export interface CreateDocTypeInput {
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly groupCode: DocTypeGroup;
  readonly kind: DocTypeKind;
  readonly hasAnnexes?: boolean | undefined;
  readonly matchHints?: JsonValue | undefined;
  readonly fieldSchema?: JsonValue | undefined;
  readonly sortOrder?: number | undefined;
}

/**
 * Новый вид ИД, заведённый администратором.
 *
 * `is_system` и `is_fallback` клиентом не задаются: системным тип делает
 * поставка (seed), резервным — конструкция каталога открытого мира. Позволить
 * ставить их из портала значило бы дать возможность объявить резервным любой
 * тип и тем самым увести под него все неопознанные документы.
 */
export async function createDocType(
  db: Database,
  scope: AuthScope,
  input: CreateDocTypeInput,
  actor: AuditActor,
): Promise<DocTypeView> {
  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(docTypes)
        .values({
          code: input.code,
          name: input.name,
          shortName: input.shortName,
          groupCode: input.groupCode,
          kind: input.kind,
          isSystem: false,
          isFallback: false,
          ...(input.hasAnnexes === undefined ? {} : { hasAnnexes: input.hasAnnexes }),
          ...(input.matchHints === undefined ? {} : { matchHints: input.matchHints }),
          ...(input.fieldSchema === undefined ? {} : { fieldSchema: input.fieldSchema }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        })
        .returning({ code: docTypes.code });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'doc_type.created',
        entityType: 'doc_type',
        entityId: input.code,
        objectId: null,
        payload: docTypeAuditPayload(input),
      });
    }),
  );

  return required(await findDocType(db, scope, input.code), 'вид ИД');
}

/**
 * Поля нового вида ИД для журнала — без `matchHints` и `fieldSchema`.
 *
 * Эти два jsonb достигают килобайтов (см. seed 0009), и в журнале они отвечали
 * бы на вопрос, который к журналу не задают: текущее значение читается из
 * каталога, а различить «кто и когда завёл тип» они не помогают. Наложение
 * подсказок, напротив, в журнал попадает целиком — там это и есть само
 * решение администратора.
 */
function docTypeAuditPayload(input: CreateDocTypeInput): Record<string, unknown> {
  const { matchHints: _matchHints, fieldSchema: _fieldSchema, ...rest } = input;
  return changedFields(rest);
}

export interface DocTypeOverridePatch {
  readonly name?: string | null | undefined;
  readonly isActive?: boolean | null | undefined;
  readonly sortOrder?: number | null | undefined;
  readonly matchHints?: JsonValue | null | undefined;
}

/**
 * Наложение на вид ИД. `null` в поле означает «вернуть базовое значение».
 *
 * Различие между «поля нет в запросе» и «поле равно null» здесь содержательно:
 * первое оставляет наложение как есть, второе снимает именно его. Слить их в
 * одно — значит лишить администратора возможности отменить одну настройку, не
 * сбрасывая остальные.
 */
export async function setDocTypeOverride(
  db: Database,
  scope: AuthScope,
  code: string,
  patch: DocTypeOverridePatch,
  actor: AuditActor,
): Promise<DocTypeView | null> {
  const base = await findDocType(db, scope, code);
  if (base === null) return null;

  await assertFallbackIntact(db, scope, base, patch, actor);

  const fields: Partial<typeof docTypeOverrides.$inferInsert> = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    ...(patch.matchHints !== undefined ? { matchHints: patch.matchHints } : {}),
  };
  assertNonEmptyPatch(fields);

  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx
        .insert(docTypeOverrides)
        .values({ docTypeCode: code, ...fields })
        .onConflictDoUpdate({
          target: docTypeOverrides.docTypeCode,
          set: { ...fields, updatedAt: sql`now()` },
        });

      await appendAudit(tx, scope, {
        ...actor,
        action: 'doc_type.override_set',
        entityType: 'doc_type',
        entityId: code,
        objectId: null,
        // Значения наложения — само решение администратора, поэтому пишутся
        // целиком, включая подсказки сопоставления: «кто отключил вид ИД» и «кто
        // переписал его подсказки» — вопросы к одному и тому же следу.
        payload: changedFields(patch),
      });
    }),
  );

  return findDocType(db, scope, code);
}

/**
 * Поля наложения, допустимые у резервного вида ИД поставки.
 *
 * Тип `keyof DocTypeOverridePatch`, а не `string`: новое поле наложения не
 * пройдёт мимо этого списка молча — либо оно перечислено здесь, либо `denied`
 * ниже его запретит, и оба исхода осознанны.
 */
const FALLBACK_EDITABLE_FIELDS: readonly (keyof DocTypeOverridePatch)[] = ['name', 'sortOrder'];

/**
 * Резервный вид ИД поставки нельзя отключить или переопределить по существу.
 *
 * Найдено воспроизведением: `PATCH /catalog/doc-types/other_acts
 * {isActive:false}` отвечал 200, и резервных типов в каталоге становилось 9 из
 * 10; тем же запросом отключался `unknown_document`. По §8.1 классификатору
 * обязано быть куда положить документ, который является документом, но не
 * относится ни к одному известному типу, а §16 делает наличие резервного типа
 * критерием приёмки. Обнаружилось бы это только на S8 — когда документу стало бы
 * некуда деться, то есть на конвейере, а не на настройке.
 *
 * Что именно запрещено и почему не «всё, кроме имени»:
 *
 * - `isActive: false` — отнимает у каталога резервный тип. Запрещено;
 * - `isActive: true` — законно всегда: это возврат типа в выдачу, в том числе
 *   если строку наложения кто-то оставил до появления этого запрета;
 * - `null` в любом поле — снятие наложения, то есть возврат к поставляемому
 *   (активному) значению. Законно;
 * - `matchHints` — резервный тип по построению принимает то, что не опознано
 *   ничем другим; собственные подсказки делают его обычным типом с якорями и
 *   меняют смысл «резервного». Запрещено;
 * - `name` и `sortOrder` — оформление выдачи, инварианта не касаются.
 *
 * Отказ 422, а не 403: право у администратора есть, а вот запрошенное состояние
 * каталога недопустимо. И отклонённая попытка оставляет след: это признак либо
 * ошибки интерфейса, либо попытки обойти инвариант, и различить их можно только
 * по журналу — поэтому запись идёт ДО отказа, отдельной транзакцией, которая
 * фиксируется независимо от того, что операция не состоялась.
 */
async function assertFallbackIntact(
  db: Database,
  scope: AuthScope,
  base: DocTypeView,
  patch: DocTypeOverridePatch,
  actor: AuditActor,
): Promise<void> {
  // `is_fallback` ставит только seed: портал заводит типы с `isFallback: false`,
  // поэтому «резервный И системный» описывает ровно те строки, которые вернутся
  // следующей поставкой, а не решение администратора.
  if (!(base.isFallback && base.isSystem)) return;

  const denied = Object.entries(patch)
    .filter(([field, value]) => {
      if (value === undefined || value === null) return false;
      if (field === 'isActive' && value === true) return false;
      return !FALLBACK_EDITABLE_FIELDS.includes(field as keyof DocTypeOverridePatch);
    })
    .map(([field]) => field);

  if (denied.length === 0) return;

  await appendAudit(db, scope, {
    ...actor,
    action: 'doc_type.override_rejected',
    entityType: 'doc_type',
    entityId: base.code,
    objectId: null,
    payload: { rejectedFields: denied, requested: changedFields(patch), reason: 'fallback_type' },
  });

  throw unprocessable(
    denied.map((field) => ({
      pointer: `/${field}`,
      code: 'fallback_protected',
      message:
        field === 'isActive'
          ? 'Резервный вид ИД нельзя отключить: документу незнакомого вида станет некуда деться'
          : 'У резервного вида ИД настраиваются только отображаемое имя и порядок',
    })),
    `Вид ИД «${base.code}» — резервный (§8.1): классификатору обязано быть куда положить ` +
      'документ незнакомого вида, поэтому отключение и подмена подсказок ему недоступны.',
  );
}

/** Снять наложение целиком: тип возвращается к поставляемым значениям. */
export async function clearDocTypeOverride(
  db: Database,
  scope: AuthScope,
  code: string,
  actor: AuditActor,
): Promise<DocTypeView | null> {
  const base = await findDocType(db, scope, code);
  if (base === null) return null;

  await guardConstraints(() =>
    db.transaction(async (tx) => {
      // Снятие всегда законно, в том числе у резервного типа: поставляемое
      // значение активно, поэтому возврат к нему инвариант не нарушает.
      const removed = await tx
        .delete(docTypeOverrides)
        .where(eq(docTypeOverrides.docTypeCode, code))
        .returning({
          name: docTypeOverrides.name,
          isActive: docTypeOverrides.isActive,
          sortOrder: docTypeOverrides.sortOrder,
        });
      // Наложения не было — снимать нечего и записывать нечего.
      const row = removed[0];
      if (row === undefined) return;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'doc_type.override_cleared',
        entityType: 'doc_type',
        entityId: code,
        objectId: null,
        // Снятые значения: без них журнал не отвечает, что именно было отменено.
        payload: { cleared: row },
      });
    }),
  );

  return findDocType(db, scope, code);
}

// =====================================================================
// Кандидаты в виды ИД — цикл роста каталога (§0.5, п.3)
// =====================================================================

const CANDIDATE_SELECTION = {
  id: docTypeCandidates.id,
  observedTitleNorm: docTypeCandidates.observedTitleNorm,
  observedTitleSample: docTypeCandidates.observedTitleSample,
  occurrences: docTypeCandidates.occurrences,
  firstSeenAt: isoTimestamp(docTypeCandidates.firstSeenAt),
  lastSeenAt: isoTimestamp(docTypeCandidates.lastSeenAt),
  sampleRevisionId: docTypeCandidates.sampleRevisionId,
  sampleSourcePageId: docTypeCandidates.sampleSourcePageId,
  status: docTypeCandidates.status,
  mappedDocTypeCode: docTypeCandidates.mappedDocTypeCode,
  reviewedBy: docTypeCandidates.reviewedBy,
  reviewedAt: isoTimestampOrNull(docTypeCandidates.reviewedAt),
};

/**
 * Нормализация наблюдённого заголовка — ключ кластеризации кандидатов (§3.2).
 *
 * Смысл ключа один: «АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ № ГИ-77 от
 * 12.05.2026» и такой же акт с другим номером и другой датой обязаны дать ОДНУ
 * строку очереди с `occurrences = 2`. Без этого администратор увидел бы не
 * «встречено 14 документов такого вида, типа нет», а четырнадцать одиночных
 * записей, то есть механизм роста каталога перестал бы отвечать на свой
 * единственный вопрос — что заводить в первую очередь.
 *
 * Пять шагов, каждый закрывает свой источник расхождения:
 *
 * 1. **markdown-обвязка.** Текст страницы приходит из распознавания в Markdown:
 *    заголовок бывает `## АКТ`, `> **АКТ**`, `| АКТ |` и `1. АКТ`. Это ровно та
 *    находка S1, из-за которой якоря каталога были в основном мертвы;
 * 2. **регистр и `Ё`.** Один и тот же бланк печатается и капсом, и обычным
 *    текстом, а `Ё` OCR читает то так, то эдак;
 * 3. **номер после `№`.** Именно он различает экземпляры одного вида;
 * 4. **даты** — «от 12.05.2026» и голая дата в хвосте;
 * 5. **пробелы и хвостовая пунктуация.**
 *
 * Пустой результат не принимается как ключ: строка из одних номеров дала бы
 * пустой `observed_title_norm`, и в НЕГО склеились бы все незнакомые документы
 * всех поставок разом. Поэтому при пустом остатке ключом становится заголовок
 * без снятия номера, а совсем пустой заголовок отвергается.
 */
export function normalizeObservedTitle(title: string): string {
  const withoutMarkdown = title
    // Обвязка ячейки таблицы и цитаты, заголовочные решётки, маркеры списка и
    // нумерация пункта — всё это «где напечатано», а не «что напечатано».
    .replace(/[|>]/gu, ' ')
    .replace(/^[\s#*_-]+/u, ' ')
    .replace(/[*_`]/gu, ' ')
    .replace(/^\s*\d+[.)]\s+/u, ' ');

  const upper = withoutMarkdown.toUpperCase().replace(/Ё/gu, 'Е');

  const withoutIdentity = upper
    // Номер: после «№» идёт один непробельный токен — это и есть экземпляр.
    .replace(/№\s*\S+/gu, ' ')
    // Границы слова `\b` здесь не годятся: они ASCII-ориентированы, и между
    // пробелом и кириллической «О» границы нет — правило молча не срабатывало
    // бы, оставляя «… ТРУБОПРОВОДОВ ОТ» отдельным кандидатом.
    .replace(/(^|\s)ОТ\s+\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/gu, ' ')
    .replace(/\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/gu, ' ');

  const collapse = (value: string): string =>
    value
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/[\s.,;:\-–—]+$/u, '')
      .trim();

  const normalized = collapse(withoutIdentity);
  return normalized === '' ? collapse(upper) : normalized;
}

export interface ObserveCandidateInput {
  readonly observedTitle: string;
  /** Ревизия и страница-пример: по ним администратор откроет исходный документ. */
  readonly revisionId: string;
  readonly sourcePageId: string;
}

export interface ObserveCandidateOutcome {
  readonly created: boolean;
  readonly occurrences: number;
  readonly observedTitleNorm: string;
  readonly status: DocTypeCandidateStatus;
}

/**
 * Наблюдение незнакомого заголовка — вход в цикл роста каталога (§3.2).
 *
 * Вызывается конвейером на каждой странице с исходом `other`: документ, не
 * опознанный ни правилами, ни моделью, не имеет права пропасть — это основной
 * механизм, которым система покрывает разделы работ, отсутствовавшие в корпусе
 * (§0.5), и §16 проверяет его отдельным пунктом приёмки.
 *
 * ## Решение администратора конвейер не отменяет
 *
 * `DO UPDATE` трогает ровно две колонки: счётчик и метку последней встречи.
 * Кандидат, помеченный `mapped` или `ignored`, НЕ возвращается в `new` от того,
 * что документ встретился снова. Иначе разобранная очередь наполнялась бы
 * заново каждой поставкой, а «шум OCR», однажды скрытый администратором,
 * всплывал бы бесконечно. Счётчик при этом растёт — частота остаётся честной, и
 * по ней видно, что скрытый заголовок встречается всё чаще.
 *
 * ## Область видимости
 *
 * Читается очередь всеми (кандидаты — конфигурация портала, решение S4), но
 * ЗАПИСЬ примера идёт под областью вызывающего: `sample_revision_id` и
 * `sample_source_page_id` — это указатели на конкретную страницу конкретной
 * поставки, и записать сюда чужую ревизию значило бы дать администратору (а
 * через него и очереди) ссылку, которой у писавшего не было права.
 *
 * Пример НЕ перезаписывается при повторной встрече: первая ссылка стабильна,
 * администратор возвращается к тому же документу. Обновляется он только если
 * прежнего нет вовсе — так строка лечится после удаления поставки по retention
 * (`ON DELETE SET NULL`, 0003).
 *
 * Строки в `audit_log` здесь нет намеренно: это не действие пользователя, а
 * наблюдение конвейера, и запись на каждую страницу открытого мира утопила бы
 * журнал справочников, ради читаемости которого он и заводился (S4).
 */
export async function observeDocTypeCandidate(
  db: Database,
  scope: AuthScope,
  input: ObserveCandidateInput,
): Promise<ObserveCandidateOutcome> {
  const norm = normalizeObservedTitle(input.observedTitle);
  if (norm === '') {
    // Тот же инвариант, что и CHECK `page_classifications_observed_title_chk`:
    // заголовок из одних пробелов не является наблюдением.
    throw unprocessable(
      [
        {
          pointer: '/observedTitle',
          code: 'empty',
          message: 'Наблюдённый заголовок пуст: кластеризовать нечего.',
        },
      ],
      'Наблюдённый заголовок пуст.',
    );
  }

  const visible = await db
    .select({ id: submissionRevisions.id })
    .from(submissionRevisions)
    .where(
      withScope(
        scope,
        {
          objectId: submissionRevisions.objectId,
          contractorId: submissionRevisions.contractorId,
        },
        eq(submissionRevisions.id, input.revisionId),
      ),
    )
    .limit(1);
  if (visible[0] === undefined) throw notFound('Ревизия поставки не найдена.');

  const sample = input.observedTitle.trim().slice(0, 2000);

  const result = await db.execute<{
    occurrences: number | string;
    status: string;
    created: boolean;
  }>(sql`
    insert into ${docTypeCandidates}
      (observed_title_norm, observed_title_sample, sample_revision_id, sample_source_page_id)
    values (${norm}, ${sample}, ${input.revisionId}::uuid, ${input.sourcePageId}::uuid)
    on conflict (observed_title_norm) do update
       set occurrences = ${docTypeCandidates}.occurrences + 1,
           last_seen_at = now(),
           -- Пример не перезаписывается: обновляется только отсутствующий.
           sample_revision_id = coalesce(
             ${docTypeCandidates}.sample_revision_id, excluded.sample_revision_id),
           sample_source_page_id = coalesce(
             ${docTypeCandidates}.sample_source_page_id, excluded.sample_source_page_id)
    returning occurrences, status, (xmax = 0) as created
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw internal({ logDetail: 'UPSERT кандидата в виды ИД не вернул строку' });
  }
  return {
    created: row.created === true,
    occurrences: Number(row.occurrences),
    observedTitleNorm: norm,
    status: row.status as DocTypeCandidateStatus,
  };
}

export interface CandidateListParams {
  readonly limit: number;
  readonly cursor?: string | null | undefined;
  readonly status?: DocTypeCandidateStatus | undefined;
}

/**
 * Очередь кандидатов, самые частые заголовки первыми.
 *
 * Сортировка по частоте — не украшение: администратор обязан начинать с
 * «встречено 14 документов с таким заголовком», а не с единичного артефакта
 * OCR. Курсор по паре `(occurrences, id)` в одном направлении, иначе листание
 * пропускало бы строки с равной частотой.
 */
export async function listDocTypeCandidates(
  db: Database,
  scope: AuthScope,
  params: CandidateListParams,
): Promise<CatalogPage<DocTypeCandidateView>> {
  const after = decodeCursor(params.cursor, countCursorSchema);
  const rows = await db
    .select(CANDIDATE_SELECTION)
    .from(docTypeCandidates)
    .where(
      visibleWhere(
        configVisibility(scope),
        after === null
          ? undefined
          : afterCount(docTypeCandidates.occurrences, docTypeCandidates.id, after),
        params.status === undefined ? undefined : eq(docTypeCandidates.status, params.status),
      ),
    )
    .orderBy(desc(docTypeCandidates.occurrences), desc(docTypeCandidates.id))
    .limit(params.limit + 1);

  return page(rows.map(toCandidateView), params.limit, (row) => ({
    n: row.occurrences,
    id: row.id,
  }));
}

export async function findDocTypeCandidate(
  db: Database,
  scope: AuthScope,
  candidateId: string,
): Promise<DocTypeCandidateView | null> {
  const rows = await db
    .select(CANDIDATE_SELECTION)
    .from(docTypeCandidates)
    .where(visibleWhere(configVisibility(scope), eq(docTypeCandidates.id, candidateId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toCandidateView(row);
}

/** Взять кандидата в работу, вернуть в очередь или скрыть как шум OCR. */
export async function setDocTypeCandidateStatus(
  db: Database,
  scope: AuthScope,
  candidateId: string,
  status: DocTypeCandidateReviewStatus,
  actor: AuditActor,
): Promise<DocTypeCandidateView | null> {
  const changed = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(docTypeCandidates)
        .set({
          status,
          // Возврат в очередь снимает и разбор: иначе в очереди осталась бы
          // запись «рассмотрено» без результата рассмотрения.
          ...(status === 'new'
            ? { reviewedBy: null, reviewedAt: null, mappedDocTypeCode: null }
            : { reviewedBy: scope.userId, reviewedAt: sql`now()` }),
        })
        .where(eq(docTypeCandidates.id, candidateId))
        .returning({ id: docTypeCandidates.id });
      if (updated.length === 0) return false;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'doc_type_candidate.status_changed',
        entityType: 'doc_type_candidate',
        entityId: candidateId,
        objectId: null,
        // Заголовок-образец в журнал не переносится: в нём фрагмент документа
        // конкретного подрядчика, а `entityId` и так ведёт к самой записи очереди.
        payload: { status },
      });
      return true;
    }),
  );
  if (!changed) return null;

  return findDocTypeCandidate(db, scope, candidateId);
}

/** Действие «сопоставить с существующим»: заголовок относится к известному типу. */
export async function mapDocTypeCandidate(
  db: Database,
  scope: AuthScope,
  candidateId: string,
  docTypeCode: string,
  actor: AuditActor,
): Promise<DocTypeCandidateView | null> {
  const changed = await guardConstraints(() =>
    db.transaction(async (tx) => {
      const updated = await tx
        .update(docTypeCandidates)
        .set({
          status: 'mapped',
          mappedDocTypeCode: docTypeCode,
          reviewedBy: scope.userId,
          reviewedAt: sql`now()`,
        })
        .where(eq(docTypeCandidates.id, candidateId))
        .returning({ id: docTypeCandidates.id });
      if (updated.length === 0) return false;

      await appendAudit(tx, scope, {
        ...actor,
        action: 'doc_type_candidate.mapped',
        entityType: 'doc_type_candidate',
        entityId: candidateId,
        objectId: null,
        payload: { docTypeCode },
      });
      return true;
    }),
  );
  if (!changed) return null;

  return findDocTypeCandidate(db, scope, candidateId);
}

export interface DocTypeFromCandidate {
  readonly docType: DocTypeView;
  readonly candidate: DocTypeCandidateView;
}

/**
 * Действие «завести тип»: создать вид ИД и сопоставить кандидата с ним.
 *
 * Одной транзакцией, потому что половина результата хуже отказа: созданный тип
 * при неотмеченном кандидате оставляет ту же запись в очереди, и администратор
 * заведёт тип второй раз — теперь уже с конфликтом по коду.
 */
export async function createDocTypeFromCandidate(
  db: Database,
  scope: AuthScope,
  candidateId: string,
  input: CreateDocTypeInput,
  actor: AuditActor,
): Promise<DocTypeFromCandidate | null> {
  const existing = await findDocTypeCandidate(db, scope, candidateId);
  if (existing === null) return null;

  await guardConstraints(() =>
    db.transaction(async (tx) => {
      await tx.insert(docTypes).values({
        code: input.code,
        name: input.name,
        shortName: input.shortName,
        groupCode: input.groupCode,
        kind: input.kind,
        isSystem: false,
        isFallback: false,
        ...(input.hasAnnexes === undefined ? {} : { hasAnnexes: input.hasAnnexes }),
        ...(input.matchHints === undefined ? {} : { matchHints: input.matchHints }),
        ...(input.fieldSchema === undefined ? {} : { fieldSchema: input.fieldSchema }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      });

      await tx
        .update(docTypeCandidates)
        .set({
          status: 'mapped',
          mappedDocTypeCode: input.code,
          reviewedBy: scope.userId,
          reviewedAt: sql`now()`,
        })
        .where(eq(docTypeCandidates.id, candidateId));

      // Одна запись, а не две: «завести тип по кандидату» — одно решение
      // администратора, и разложенное на два действия оно читалось бы в журнале
      // как совпадение двух независимых событий.
      await appendAudit(tx, scope, {
        ...actor,
        action: 'doc_type.created_from_candidate',
        entityType: 'doc_type',
        entityId: input.code,
        objectId: null,
        payload: { ...docTypeAuditPayload(input), candidateId },
      });
    }),
  );

  return {
    docType: required(await findDocType(db, scope, input.code), 'вид ИД'),
    candidate: required(await findDocTypeCandidate(db, scope, candidateId), 'кандидат в виды ИД'),
  };
}

// =====================================================================
// Отображение строк и мелкие помощники
// =====================================================================

function page<TItem, TCursor extends TextCursor | CountCursor>(
  rows: readonly TItem[],
  limit: number,
  cursorOf: (row: TItem) => TCursor,
): CatalogPage<TItem> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null;
  return { items, nextCursor };
}

/**
 * Значения перечислений и jsonb приводятся к типам контрактов приведением.
 *
 * Их состав держит CHECK в БД (`counterparties_kind_chk`,
 * `section_profiles_autonomy_chk`, `doc_types_group_chk`, `doc_types_kind_chk`),
 * а форму ответа дополнительно проверяет схема сериализации маршрута. Разбор
 * схемой ещё и здесь означал бы третью проверку одного инварианта и 500 на
 * строке, которую БД считает корректной.
 */
function toCounterparty(row: {
  id: string;
  name: string;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  kind: string;
  isActive: boolean;
}): Counterparty {
  return { ...row, kind: row.kind as CounterpartyKind };
}

function toSectionProfile(row: {
  id: string;
  sectionCode: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  expectedDocTypes: string[];
  materialCategories: string[];
  materialMatrix: unknown;
  enabledRuleCodes: string[];
  thresholds: unknown;
  autonomyLevel: string;
  publishedAt: string | null;
  publishedBy: string | null;
}): SectionProfile {
  return {
    ...row,
    materialMatrix: row.materialMatrix as JsonValue,
    thresholds: row.thresholds as JsonValue,
    autonomyLevel: row.autonomyLevel as AutonomyLevel,
  };
}

function toDocTypeView(row: {
  code: string;
  name: string;
  shortName: string;
  groupCode: string;
  kind: string;
  hasAnnexes: boolean;
  matchHints: unknown;
  fieldSchema: unknown;
  isSystem: boolean;
  isFallback: boolean;
  sortOrder: number;
  isActive: boolean;
  hasOverride: boolean;
}): DocTypeView {
  return {
    ...row,
    groupCode: row.groupCode as DocTypeGroup,
    kind: row.kind as DocTypeKind,
    matchHints: row.matchHints as JsonValue,
    fieldSchema: row.fieldSchema as JsonValue,
  };
}

function toCandidateView(row: {
  id: string;
  observedTitleNorm: string;
  observedTitleSample: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleRevisionId: string | null;
  sampleSourcePageId: string | null;
  status: string;
  mappedDocTypeCode: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}): DocTypeCandidateView {
  return { ...row, status: row.status as DocTypeCandidateStatus };
}

function assertNonEmptyPatch(fields: Record<string, unknown>): void {
  if (Object.keys(fields).length === 0) {
    // Пустая правка дошла бы до `set()` без полей и упала бы в драйвере, а в
    // таблицах с `updated_at` молча обновила бы только метку времени.
    throw badRequest('Запрос не содержит ни одного изменяемого поля.');
  }
}

function idOf(rows: readonly { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    // INSERT без RETURNING-строки означает, что вставки не было: это ошибка
    // сборки запроса, а не ситуация данных.
    throw notFound('Запись не создана.', { logDetail: 'INSERT не вернул строку' });
  }
  return row.id;
}

/**
 * Только что записанная строка обязана читаться.
 *
 * Если её нет, дело не в данных, а в области видимости или в условии чтения —
 * и молчаливый `null` в ответе спрятал бы именно эту ошибку.
 */
function required<TValue>(value: TValue | null, what: string): TValue {
  if (value === null) {
    throw notFound(`Запись справочника не найдена: ${what}.`, {
      logDetail: `запись справочника (${what}) не читается сразу после записи`,
    });
  }
  return value;
}
