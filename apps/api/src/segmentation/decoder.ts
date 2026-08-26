/**
 * Фаза 3 сегментации — декодер последовательности меток в документы (§8.2).
 *
 * Чистая функция от страниц и их классификаций. Ни базы, ни сети: результат
 * записывает вызывающий, а держать инвариант обязан сам декодер.
 *
 * ## Non-degradable инвариант (§1.6)
 *
 * Каждая страница входа встречается РОВНО один раз суммарно в `documents[].pages`
 * и `unassigned`. Декодер проверяет это в конце и БРОСАЕТ при нарушении.
 * Проверка не декоративная: потерянная страница — это документ, ушедший на
 * согласование без листа, а лишняя — тот же лист в двух документах. Второй
 * рубеж (`UNIQUE(revision_id, source_page_id)` в `document_pages` и
 * представление непривязанных страниц) стоит в БД, но ловит нарушение уже
 * после записи половины строк.
 *
 * ## Почему автоприсоединение здесь такое скупое
 *
 * §16 называет тихую высокоуверенную ошибку границы более значимым критерием,
 * чем F1. Присоединить служебный лист «раз уж он между страницами документа»
 * дёшево и почти всегда верно — но там, где неверно, ошибку никто не заметит:
 * документ выглядит целым. Поэтому каждое автоприсоединение требует ЯВНОГО
 * основания, а его отсутствие даёт `unassigned` с названной причиной. Строка
 * непривязанной страницы существует явно (§3.6): «страница не учтена» и
 * «страница учтена и ждёт человека» обязаны различаться.
 */
import { DOC_TYPES, normalizeLines, PAGE_ROLES } from '@id/doc-types';
import { continuesTable } from './table-flow.js';
import type {
  ClassificationSource,
  DecodedDocument,
  DecodedPage,
  DecodedUnassigned,
  PageClassification,
  PageInput,
  Segmentation,
} from './types.js';

/** Общий резерв открытого мира, когда группа предполагаемого типа неизвестна. */
const UNKNOWN_DOCUMENT = 'unknown_document';

/** Порог, ниже которого документ уходит на ручную проверку. */
const HIGH_CONFIDENCE = 0.7;

/** Резервный тип каждой группы каталога: `group → code`. */
const FALLBACK_BY_GROUP: ReadonlyMap<string, string> = new Map(
  DOC_TYPES.filter((t) => t.isFallback && t.code !== UNKNOWN_DOCUMENT).map((t) => [
    t.group,
    t.code,
  ]),
);

/** Группа типа каталога: `code → group`. */
const GROUP_BY_CODE: ReadonlyMap<string, string> = new Map(DOC_TYPES.map((t) => [t.code, t.group]));

/** Автоприсоединение роли: `code → autoAttach`. */
const AUTO_ATTACH: ReadonlyMap<string, boolean> = new Map(
  PAGE_ROLES.map((r) => [r.code as string, r.autoAttach]),
);

const BLANK_ROLE = 'blank';
const ANNEX_ROLE = 'annex_continuation';
const SIGNATURE_ROLE = 'signature_visual';

/**
 * Резервный код для документа незнакомого вида (§0.5, §8.1).
 *
 * Группа берётся у предполагаемого типа, если он есть: «иной документ о
 * качестве» полезнее «документа неизвестного вида» — он попадает в ту же
 * папку дерева и к нему применимы групповые правила. Если гипотезы нет,
 * честный ответ — общий резерв.
 */
function fallbackCodeFor(classification: PageClassification): string {
  const hint = classification.docTypeCode ?? classification.alternatives[0] ?? null;
  if (hint === null) return UNKNOWN_DOCUMENT;
  const group = GROUP_BY_CODE.get(hint);
  if (group === undefined) return UNKNOWN_DOCUMENT;
  return FALLBACK_BY_GROUP.get(group) ?? UNKNOWN_DOCUMENT;
}

/**
 * Потолок уверенности в ГРАНИЦЕ документа по источнику решения.
 *
 * Уверенность в границе считается отдельно от уверенности в типе и по другим
 * основаниям: заголовок на странице — сильный признак начала документа
 * независимо от того, различил ли каталог подвид. И наоборот, схема,
 * опознанная по составу блоков, даёт слабую границу даже там, где тип угадан
 * верно. Одно число на оба вопроса скрывало бы ровно ту информацию, ради
 * которой инженер открывает документ.
 *
 * - `manual` — решение человека, потолка нет;
 * - `anchor` — якорный заголовок: сильнейший автоматический признак;
 * - `llm` — модель видит страницу и двух соседей, а не весь комплект, поэтому
 *   выше уверенности якоря её ответ о границе не поднимается даже при
 *   `confidence: 1`;
 * - `blocks` — состав блоков говорит «здесь схема», но ничего не говорит о
 *   том, где она началась: соседний лист мог быть её первой страницей.
 *
 * Таблица экспортируется НЕ для удобства: порог `CONFIDENT_BOUNDARY` обязан
 * быть с ней согласован, и согласование проверяется тестом. Пока потолок был
 * безымянной константой внутри функции, расхождение существовало и было
 * невидимым — см. ниже.
 */
export const BOUNDARY_CONFIDENCE_CEILING: Readonly<Record<ClassificationSource, number>> = {
  manual: 1,
  anchor: 0.9,
  llm: 0.8,
  blocks: 0.4,
};

/**
 * Порог «граница заявлена уверенно» — тот самый, по которому §16 считает ТИХУЮ
 * высокоуверенную ошибку, критерий более значимый, чем F1.
 *
 * ## Почему это число здесь, а не только в замере
 *
 * Замер держал порог 0.9, а фаза 2 не могла заявить больше 0.8. Значит ни одна
 * ошибка границы, поставленная моделью, не засчитывалась тихой НИ ПРИ КАКОЙ её
 * уверенности: критерий, на котором строится переход раздела в `automatic`,
 * к фазе 2 был структурно неприменим. Дефект жил в зазоре между двумя файлами,
 * ни один из которых по отдельности не был неправ.
 *
 * Порог приведён к потолку фазы 2, а не потолок к порогу. Направление выбрано
 * не по удобству: понижение порога может только УВЕЛИЧИТЬ число засчитанных
 * тихих ошибок, то есть ужесточает критерий. Поднять потолок значило бы
 * разрешить модели заявлять уверенность, которой у неё нет, ради того чтобы
 * критерий срабатывал, — это подгонка.
 *
 * ## Второе следствие: «либо уверенно, либо помечено»
 *
 * Граница, которую система не может назвать уверенной по собственной шкале,
 * обязана уйти на проверку (`needsReviewOf`). Иначе остаётся третье состояние —
 * «не уверены, но и не позвали никого», и ошибка в нём не видна ни человеку,
 * ни счётчику тихих ошибок.
 */
export const CONFIDENT_BOUNDARY = 0.8;

function boundaryConfidenceOf(c: PageClassification): number {
  const ceiling = BOUNDARY_CONFIDENCE_CEILING[c.source];
  // Только у модели уверенность в границе зависит от её собственного ответа:
  // якорь и состав блоков — признаки структурные, и их сила не меняется от
  // того, что модель о себе сообщила.
  return c.source === 'llm' ? Math.min(c.confidence, ceiling) : ceiling;
}

function typeConfidenceOf(c: PageClassification): number {
  return c.typeOutcome === 'none' ? 0 : c.confidence;
}

/**
 * Нужна ли документу ручная проверка.
 *
 * `other` сам по себе её НЕ требует: §0.5 прямо разделяет «это документ, но
 * вида такого нет» (уверенность допустима высокая, документ идёт в
 * `doc_type_candidates`) и «похоже на известный вид, но не уверен» (гипотеза
 * плюс `needs_review`). Свести их в одно значило бы вызывать человека на
 * каждый документ незнакомого раздела — то есть отменить автоматизацию ровно
 * там, где она нужнее всего.
 */
function needsReviewOf(c: PageClassification): boolean {
  if (c.source === 'manual') return false;
  if (c.ambiguous) return true;
  if (c.typeOutcome === 'uncertain') return true;
  // Граница ниже собственного порога уверенности системы — не «просто менее
  // надёжная», а не подтверждённая никем. Без этой строки существует состояние
  // «не уверены и никого не позвали», в котором ошибка невидима обоим: и
  // инженеру (пометки нет), и замеру (уверенность ниже порога).
  if (boundaryConfidenceOf(c) < CONFIDENT_BOUNDARY) return true;
  return c.confidence < HIGH_CONFIDENCE;
}

// ── Номер документа и его сверка с номером родителя у приложения ───────────

/**
 * Все номера, названные на странице документа.
 *
 * Не «номер документа», а именно ВСЕ номера, и это принципиально. Замер на
 * корпусе показал, почему выбор одного номера здесь не работает: в шапке
 * сертификата первым по тексту стоит номер аттестата аккредитации органа по
 * сертификации, а собственный номер документа идёт ниже. Разбор «первый №
 * после заголовка» ошибался на трёх приложениях из шести и отправлял в
 * `unassigned` верные привязки.
 *
 * Вопрос, на который отвечает эта функция, ставится иначе: «названо ли на
 * странице родителя ровно то число, на которое ссылается приложение». Это и
 * есть подтверждение привязки, и оно не зависит от того, какой из номеров
 * страницы главный.
 */
function pageNumbers(text: string): readonly string[] {
  const out: string[] = [];
  for (const line of normalizeLines(text)) {
    const re = /№\s*([^\n|]{1,60})/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      let value = (m[1] as string).trim();
      const cut = /\s+(?:от|к)\s/iu.exec(value);
      if (cut) value = value.slice(0, cut.index);
      value = value.trim();
      if (value.length > 0 && /[\p{L}\p{N}]/u.test(value)) out.push(value);
    }
  }
  return out;
}

/** Сравнимая форма номера: регистр, пробелы и вид дефиса не значимы. */
function foldNumber(value: string): string {
  return value
    .toLocaleUpperCase('ru')
    .replace(/[\s№"'«»]/gu, '')
    .replace(/[–—−]/gu, '-');
}

/**
 * Длина номера, начиная с которой допускается поиск подстрокой.
 *
 * Номер вида «РОСС RU Д-RU.PA01.B.17254/23» в тексте родителя может стоять
 * с хвостом («…/23 срок действия»), и точное равенство его не найдёт.
 * Короткие номера («1», «А») подстрокой искать нельзя: они встречаются на
 * любой странице и дали бы ложную привязку.
 */
const SUBSTRING_MATCH_MIN_CHARS = 6;

/** Подтверждает ли текст родительской страницы ссылку приложения. */
function confirmsParent(parentText: string, parentRef: string): boolean {
  const needle = foldNumber(parentRef);
  if (needle.length === 0) return false;
  if (pageNumbers(parentText).some((n) => foldNumber(n) === needle)) return true;
  if (needle.length < SUBSTRING_MATCH_MIN_CHARS) return false;
  return foldNumber(parentText).includes(needle);
}

// ── Сборка ────────────────────────────────────────────────────────────────

interface OpenDocument {
  readonly ordinal: number;
  readonly docTypeCode: string | null;
  readonly title: string | null;
  readonly typeConfidence: number;
  readonly boundaryConfidence: number;
  readonly needsReview: boolean;
  readonly observedTitle: string | null;
  /** Текст уже собранных страниц: по нему подтверждается ссылка приложения. */
  readonly texts: string[];
  readonly pages: DecodedPage[];
}

function openDocument(ordinal: number, page: PageInput, c: PageClassification): OpenDocument {
  const code = c.typeOutcome === 'other' ? fallbackCodeFor(c) : c.docTypeCode;
  return {
    ordinal,
    docTypeCode: code,
    title: c.observedTitle ?? c.evidence?.quote ?? null,
    typeConfidence: typeConfidenceOf(c),
    boundaryConfidence: boundaryConfidenceOf(c),
    needsReview: needsReviewOf(c),
    // Наблюдённый заголовок переносится в документ только у резервного типа:
    // именно он уходит в `doc_type_candidates` и пополняет каталог (§3.2).
    observedTitle: c.typeOutcome === 'other' ? c.observedTitle : null,
    texts: [page.text],
    pages: [{ sourcePageId: page.sourcePageId, sortOrder: 1, pageRoleCode: c.pageRoleCode }],
  };
}

function attach(doc: OpenDocument, page: PageInput, c: PageClassification): void {
  doc.texts.push(page.text);
  doc.pages.push({
    sourcePageId: page.sourcePageId,
    sortOrder: doc.pages.length + 1,
    pageRoleCode: c.pageRoleCode,
  });
}

function freeze(doc: OpenDocument): DecodedDocument {
  return {
    ordinal: doc.ordinal,
    docTypeCode: doc.docTypeCode,
    title: doc.title,
    typeConfidence: doc.typeConfidence,
    boundaryConfidence: doc.boundaryConfidence,
    needsReview: doc.needsReview,
    observedTitle: doc.observedTitle,
    pages: doc.pages,
  };
}

/**
 * Собирает документы и непривязанные страницы из последовательности меток.
 *
 * @throws если классификации не соответствуют страницам по числу или порядку,
 *         либо если итог нарушает инвариант назначения страниц.
 */
export function decodeSegmentation(
  pages: readonly PageInput[],
  classifications: readonly PageClassification[],
): Segmentation {
  if (pages.length !== classifications.length) {
    throw new Error(
      `декодер получил ${pages.length} страниц и ${classifications.length} классификаций`,
    );
  }

  const documents: DecodedDocument[] = [];
  const unassigned: DecodedUnassigned[] = [];
  let current: OpenDocument | null = null;
  /** Принадлежит ли ПРЕДЫДУЩАЯ страница входа текущему документу. */
  let previousInCurrent = false;

  const drop = (page: PageInput, reason: string): void => {
    unassigned.push({ sourcePageId: page.sourcePageId, reason, needsReview: true });
    previousInCurrent = false;
  };

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i] as PageInput;
    const c = classifications[i] as PageClassification;
    if (c.sourcePageId !== page.sourcePageId) {
      throw new Error(`классификация на позиции ${i} относится к другой странице`);
    }
    const previousPage = i > 0 ? (pages[i - 1] as PageInput) : null;

    if (c.label === 'B-DOC') {
      if (current) documents.push(freeze(current));
      current = openDocument(documents.length + 1, page, c);
      previousInCurrent = true;
      continue;
    }

    if (current === null) {
      drop(
        page,
        c.label === 'A-ROLE'
          ? 'служебная страница до первого документа комплекта'
          : 'страница-продолжение до первого документа комплекта',
      );
      continue;
    }

    if (c.label === 'I-DOC') {
      attach(current, page, c);
      previousInCurrent = true;
      continue;
    }

    if (c.label === 'A-ROLE') {
      const role = c.pageRoleCode;
      if (role === null) {
        drop(page, 'служебная страница без опознанной роли: присоединение решает человек');
        continue;
      }
      if (role === BLANK_ROLE || role === SIGNATURE_ROLE) {
        /**
         * Лист без собственного содержания ВНУТРИ документа — его лист, а не
         * ничей. Таких два: пустой оборот и визуализация электронной подписи.
         *
         * ## Пустой оборот
         *
         * Прежде пустая страница уходила в непривязанные всегда: «разделитель
         * или лист документа, решает человек». На реальных комплектах решать
         * оказалось нечего и некому — пустой оборот листа с мелкой печатью
         * стоит между содержательными страницами одного документа, и его уход
         * в непривязанные РАЗРЫВАЛ набор страниц. Нарезка (§12, задача 22)
         * режет один отрезок и на разрывном наборе отказывалась, то есть
         * пустой оборот лишал комплект выдачи целиком.
         *
         * Решает соседство — тем же признаком, что и остальные
         * автоприсоединяемые роли ниже: лист принадлежит документу, за
         * страницей которого он идёт. Пустая страница до первого документа
         * или после разрыва по-прежнему ничья: там это разделитель, и
         * присоединять его не к чему.
         *
         * ## Лист визуализации подписи
         *
         * `CORPUS_FINDINGS` (причина 5) запрещает этой роли `autoAttach: true`,
         * и запрет остаётся в силе: штамп ЭП печатается и в подвале
         * СОДЕРЖАТЕЛЬНЫХ листов, а присоединять содержательный лист к
         * предыдущему документу — прямая потеря документа. Запрет снят не с
         * присоединения, а с того случая, ради которого роль и заведена:
         * «на листе нет ничего, кроме штампа».
         *
         * Содержательная страница сюда больше не доходит — её забирает одно
         * из трёх, и каждое стоит выше по порядку решений фазы 1: якорь вида
         * (шаги 3–5), отрицательный якорь роли по списку открывающих слов
         * (`page-roles.ts`) или продолжение таблицы предыдущего листа (шаг 6).
         * Последнее — прямая находка боевого комплекта: хвост реестра
         * приложений с позициями 13–15 и блоком подписей внизу уходил в
         * непривязанные целиком, и три позиции реестра терялись молча.
         */
        if (!previousInCurrent) {
          drop(
            page,
            role === BLANK_ROLE
              ? 'пустая страница вне документа: разделитель, привязка не подтверждена'
              : 'лист визуализации подписи вне документа: привязка не подтверждена',
          );
          continue;
        }
        attach(current, page, c);
        previousInCurrent = true;
        continue;
      }
      if (AUTO_ATTACH.get(role) !== true) {
        drop(page, `роль ${role} не присоединяется автоматически: решает человек`);
        continue;
      }
      if (role === ANNEX_ROLE) {
        if (c.parentRef === null) {
          drop(
            page,
            'приложение-продолжение без номера родительского документа: привязка не подтверждена',
          );
          continue;
        }
        const parentText = current.texts.join('\n');
        if (pageNumbers(parentText).length > 0) {
          if (!confirmsParent(parentText, c.parentRef)) {
            drop(
              page,
              `приложение ссылается на документ № ${c.parentRef}, но этот номер на страницах текущего документа не назван`,
            );
            continue;
          }
        } else if (!previousInCurrent) {
          // На страницах текущего документа не названо ни одного номера, и
          // приложение идёт НЕ сразу за ним — сверить нечем и опереться не на что.
          drop(
            page,
            'номера текущего документа нет в тексте, а приложение отделено от него другими страницами',
          );
          continue;
        }
        attach(current, page, c);
        previousInCurrent = true;
        continue;
      }
      // Остальные автоприсоединяемые роли (заверение копии, продолжение)
      // опираются на непрерывность: служебный лист принадлежит документу,
      // за страницей которого он идёт. Оторванный от документа лист —
      // не «наверное, его», а неизвестно чей.
      if (!previousInCurrent) {
        drop(page, `служебный лист роли ${role} отделён от документа: привязка не подтверждена`);
        continue;
      }
      attach(current, page, c);
      previousInCurrent = true;
      continue;
    }

    // `U` внутри документа. Присоединяется ТОЛЬКО при подтверждающем сигнале.
    const confirmations: string[] = [];
    if (previousInCurrent && previousPage && continuesTable(previousPage.text, page.text)) {
      confirmations.push('таблица предыдущей страницы продолжается без шапки');
    }
    if (confirmations.length === 0) {
      drop(
        page,
        'страница без сигнала внутри документа: присоединение требует подтверждения человеком',
      );
      continue;
    }
    attach(current, page, c);
    previousInCurrent = true;
  }

  if (current) documents.push(freeze(current));

  assertEveryPageAccountedFor(pages, { documents, unassigned });
  return { documents, unassigned };
}

/**
 * Проверяет non-degradable инвариант §1.6 прямо в декодере.
 *
 * Не «на всякий случай»: единственный уникальный индекс в БД сработает уже
 * после того, как часть строк записана, а транзакция отката не вернёт
 * потерянную страницу в отчёт инженеру. Ошибка здесь громкая и ранняя.
 */
function assertEveryPageAccountedFor(pages: readonly PageInput[], result: Segmentation): void {
  const seen = new Map<string, number>();
  const count = (id: string): void => {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  };
  for (const doc of result.documents) for (const p of doc.pages) count(p.sourcePageId);
  for (const u of result.unassigned) count(u.sourcePageId);

  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    throw new Error(`страницы попали более чем в одно место: ${duplicated.join(', ')}`);
  }
  const missing = pages.filter((p) => !seen.has(p.sourcePageId)).map((p) => p.sourcePageId);
  if (missing.length > 0) {
    throw new Error(`страницы потеряны при сборке документов: ${missing.join(', ')}`);
  }
  const known = new Set(pages.map((p) => p.sourcePageId));
  const alien = [...seen.keys()].filter((id) => !known.has(id));
  if (alien.length > 0) {
    throw new Error(`в результат попали страницы, которых не было во входе: ${alien.join(', ')}`);
  }
}
