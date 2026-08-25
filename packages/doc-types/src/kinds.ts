/**
 * Принадлежность кода каталога: категория, группа, резерв, якорь анализа.
 *
 * ## Почему это отдельный модуль, а не три регулярки по месту
 *
 * Принадлежность вида документа к группе объявлена в каталоге полями `group` и
 * `kind` — и ровно те же вопросы три файла задавали регулярными выражениями,
 * каждый своей копией:
 *
 * * `packages/rules/helpers.ts` — `QUALITY_TYPES`, `PRIMARY_TYPES`, `PROTOCOL_TYPES`;
 * * `apps/worker/src/jobs/segmentation.ts` — те же три при построении графа;
 * * `tools/check-harness/src/relations.ts` — те же три в офлайн-зеркале.
 *
 * Копии уже разъехались: в версии из `helpers.ts` нет `other_quality_docs`,
 * который есть в двух других, — то есть «иной документ о качестве» для правил
 * документом о качестве не является, а для графа является. Это тот же класс
 * дефекта, что на S2 дал нулевое пересечение имён ограничений между схемой
 * Drizzle и SQL: два представления одного факта расходятся молча.
 *
 * Здесь представление одно, и оно выводится из каталога, а не повторяет его.
 * Новый вид документа, заведённый в `catalog.ts` с `group: 'quality_docs'`,
 * попадает во все три места сразу и без правки регулярки.
 */
import { DOC_TYPES } from './catalog.js';
import type { DocTypeGroup, DocTypeKind } from './types.js';

/**
 * Порог, ниже которого вид документа не считается определённым УВЕРЕННО.
 *
 * Живёт здесь, а не в слое доступа к БД, откуда переехал: величина — общий
 * доменный контракт, и её читают трое, у которых нет и не должно быть общей
 * зависимости от репозитория, — сборка графа проверки, задача извлечения
 * реквизитов и офлайн-харнес.
 *
 * Пока копий было две (0.8 в графе и 0.7 в извлечении), между ними жила щель:
 * документ с уверенностью 0.75 получал типо-специфичное извлечение, а
 * типо-специфичные правила отвечали на него `n_a`. То есть портал читал
 * реквизиты по форме, которой сам не доверял.
 */
export const KNOWN_TYPE_MIN_CONFIDENCE = 0.8;

const KIND_BY_CODE: ReadonlyMap<string, DocTypeKind> = new Map(
  DOC_TYPES.map((type) => [type.code, type.kind]),
);

const GROUP_BY_CODE: ReadonlyMap<string, DocTypeGroup> = new Map(
  DOC_TYPES.map((type) => [type.code, type.group]),
);

/** Категория вида: `null` — кода нет в каталоге. */
export function kindOf(code: string | null | undefined): DocTypeKind | null {
  if (code === null || code === undefined) return null;
  return KIND_BY_CODE.get(code) ?? null;
}

/** Группа каталога: `null` — кода нет в каталоге. */
export function groupOf(code: string | null | undefined): DocTypeGroup | null {
  if (code === null || code === undefined) return null;
  return GROUP_BY_CODE.get(code) ?? null;
}

/** Коды группы каталога. */
export function codesOfGroup(group: DocTypeGroup): readonly string[] {
  return DOC_TYPES.filter((type) => type.group === group).map((type) => type.code);
}

/**
 * Резервный код открытого мира (§8.1).
 *
 * Определяется по суффиксу и по общему коду, а не списком: группы резервных
 * типов заводятся эксплуатацией, и закрытый список в коде превратил бы
 * появление инженерных сетей в задачу на разработку.
 */
export function isFallbackCode(code: string | null | undefined): boolean {
  if (code === null || code === undefined) return false;
  return code === 'unknown_document' || code.startsWith('other_');
}

/**
 * Документ, вокруг которого строится проверка комплекта.
 *
 * ## Почему НЕ `kind === 'primary'`
 *
 * `primary` в каталоге носят пять типов, и три из них якорем анализа не
 * являются: `acceptance_act` и `commissioning_act` — акты приёмки объекта,
 * они завершают стройку, а не освидетельствуют работы, и приложений в смысле
 * §8.3 у них нет. Привязать к `primary` чтение п.1–п.7, реестр приложений и
 * связь «документ качества относится к акту» значило бы применять форму
 * РД-11-02 к бумагам, которые по ней не составляются.
 *
 * Якорь — семейство актов освидетельствования: скрытых работ, ответственных
 * конструкций, участков сетей. У всех трёх одна печатная форма и один состав
 * пунктов.
 */
export function isAnalysisAnchor(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && code.startsWith('aosr');
}

/**
 * Документы о качестве материалов — ровно группа каталога.
 *
 * Здесь группа отвечает на вопрос точно, и именно поэтому прежний список кодов
 * успел разойтись: в копии из `packages/rules` не было `other_quality_docs`,
 * а в двух других он был. Группа шире прежнего перечня ещё на три вида
 * (`iso_certificate`, `permit_conformity_mark`, `product_quality_doc`) — и это
 * то расширение, ради которого замена и делается: документ качества незнакомой
 * формы обязан давать материал наравне со знакомым (§0.5).
 */
export function isQualityDocCode(code: string | null | undefined): boolean {
  return groupOf(code) === 'quality_docs';
}

/**
 * Реестр приложений и прочие перечни состава.
 *
 * Категория, а не группа: `registries_logs` содержит ещё и журналы работ,
 * которые перечнем состава не являются.
 */
export function isRegistryCode(code: string | null | undefined): boolean {
  return kindOf(code) === 'registry';
}
