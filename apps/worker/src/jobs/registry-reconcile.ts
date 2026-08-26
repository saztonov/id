/**
 * Задача `registry.reconcile`: сверка описи передачи с комплектами папки (S20).
 *
 * ## Почему отдельный файл, а не ещё один обработчик в `segmentation.ts`
 *
 * Там уже живёт `doc.match_registry` — сверка реестра ПРИЛОЖЕНИЙ внутри одного
 * АОСР. Это другая сверка другого документа, и две «сверки реестра» в одном
 * файле путают не читателя, а автора правки: первый же вопрос «а тут какой
 * реестр» задаётся через полгода и не на код-ревью.
 *
 * ## Опись — эталон, и сверка ничего не блокирует
 *
 * Заказчик снял посылку S19 «реестр — акт передачи»: из портала документация
 * никуда не передаётся и подписей на ней не ставится. Отсюда поведение задачи:
 * она НЕ ставит ничего дальше по конвейеру, не трогает статусы и не добавляет
 * блокеров. Её единственный выход — строки сверки, которые прочитает человек.
 *
 * ## Открытый мир: чего задача не имеет права считать отказом
 *
 * «Распознавания скана ещё не было» — состояние мира, а не дефект портала:
 * вердикт `unparsed` с предупреждением, задача успешна. А вот «прогон есть,
 * страниц нет» — рассогласование данных, от повтора оно не изменится, и потому
 * это нерепробируемый отказ: три попытки с backoff здесь означали бы четверть
 * часа «работающего» конвейера.
 *
 * ## Порядок шагов обязателен именно такой
 *
 * Документы и их номера читаются ДО сопоставления групп, а не после. Первая
 * ступень лестницы сравнивает номер АОСР группы с реквизитом `number`
 * документов комплекта (`docs/CORPUS_FINDINGS.md`: сверять можно только по
 * номеру), то есть требует их заранее. Обратный порядок оставил бы лестницу
 * без первой ступени и свёл бы сверку к сопоставлению по прозе.
 */

import {
  documentNumbersOf,
  DOCUMENT_NUMBER_FIELD_CODES,
  matchRegistryRows,
  matchTransferGroups,
  normalizeRegistryName,
  parseTransferRegistry,
  TRANSFER_MATCHER_VERSION,
  TRANSFER_PARSER_VERSION,
  type DocumentFieldValue,
  type JobContext,
  type JobHandler,
  type LogicalDocumentView,
  type MatchableDocument,
  type ParsedRegistryRow,
  type ParsedTransferRow,
  type RegistryComplectRevision,
  type SaveReconciliationInput,
  type SegmentationInput,
  type TransferGroupCandidate,
} from '@id/api';
import type {
  ReconciliationExtraDocument,
  ReconciliationGroup,
  ReconciliationRow,
  ReconciliationVerdict,
  ReconciliationWork,
  RegistryReconciliation,
} from '@id/contracts';

/**
 * Отказ сверки, при котором повтор бессмыслен.
 *
 * Класс объявляет `retriable = false` сам — тем же приёмом, что
 * `SegmentationStateError`: `classifyFailure()` читает поле по форме, а не по
 * перечислению классов, и без него «задача адресована в никуда» уходила бы в
 * три попытки с экспоненциальной задержкой.
 */
export class ReconcileStateError extends Error {
  readonly retriable = false;

  constructor(message: string) {
    super(message);
    this.name = 'ReconcileStateError';
  }
}

/** Комплект-файл описи, прочитанный по ревизии из payload. */
export interface ReconcileScanWork {
  readonly workId: string;
  readonly objectId: string;
  readonly kind: string;
  readonly registryId: string | null;
  readonly currentRevisionId: string | null;
}

/** Карточка реестра: с ней сверяется шапка описи. */
export interface ReconcileRegistry {
  readonly id: string;
  readonly objectId: string;
  readonly number: string | null;
  readonly folderNo: string | null;
}

export interface RegistryReconcileDeps {
  /**
   * Комплект-файл описи ПАПКИ и его текущая ревизия.
   *
   * Ищется по ключу (`works.registry_id`, `kind = 'registry'`), а не по
   * ревизии из payload: ревизии там нет вовсе. Рубеж доступа создал маршрут
   * (`findRegistry` по области), и повторять его здесь значило бы завести
   * второй источник правды о том, кому видна папка.
   */
  readonly findScan: (registryId: string) => Promise<ReconcileScanWork | null>;
  readonly findRegistry: (
    objectId: string,
    registryId: string,
  ) => Promise<ReconcileRegistry | null>;
  readonly loadPages: (revisionId: string) => Promise<SegmentationInput>;
  readonly listComplectRevisions: (
    registryId: string,
  ) => Promise<readonly RegistryComplectRevision[]>;
  readonly listContractorNames: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  readonly listDocuments: (
    objectId: string,
    revisionIds: readonly string[],
  ) => Promise<readonly LogicalDocumentView[]>;
  readonly listFieldValues: (
    objectId: string,
    revisionIds: readonly string[],
    fieldCodes: readonly string[],
  ) => Promise<readonly DocumentFieldValue[]>;
  readonly save: (input: SaveReconciliationInput) => Promise<RegistryReconciliation>;
  /**
   * Событие ленты ревизии скана.
   *
   * Отдельный порт, а не `ctx.emit`: контекст задачи привязывает событие к
   * `job.revisionId`, а у этой задачи ревизии в payload нет. Лента при этом
   * нужна — экран реестра слушает именно её.
   */
  readonly emit: (
    revisionId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}

/**
 * Реквизиты, участвующие в сверке.
 *
 * `issuer` — организация: в каталоге она называется так, а не `organization`
 * (`packages/doc-types/src/base-fields.ts`). `manufacturer` берётся вторым
 * кандидатом: опись пишет в графу «Организация составившая документ
 * (производитель)» то одно, то другое, и требовать совпадения именно с
 * `issuer` значило бы поднимать расхождение на паспорте качества, где выдал
 * изготовитель.
 */
const FIELD_CODES = [
  ...DOCUMENT_NUMBER_FIELD_CODES,
  'issued_at',
  'issuer',
  'manufacturer',
] as const;

/** Коды расхождений реквизитов; попадают в `field_mismatches` строки. */
const MISMATCH_ISSUED_AT = 'issued_at';
const MISMATCH_ORGANIZATION = 'organization';
const MISMATCH_SHEETS = 'sheets';

interface DocumentFacts {
  /** Все номера документа; первый — для показа в строке «лишний документ». */
  readonly numbers: readonly string[];
  readonly issuedAt: string | null;
  readonly organizations: readonly string[];
}

const ORGANIZATION_CODES: ReadonlySet<string> = new Set(['issuer', 'manufacturer']);

function factsByDocument(
  values: readonly DocumentFieldValue[],
): ReadonlyMap<string, DocumentFacts> {
  const grouped = new Map<string, DocumentFieldValue[]>();
  for (const value of values) {
    const bucket = grouped.get(value.documentId);
    if (bucket === undefined) grouped.set(value.documentId, [value]);
    else bucket.push(value);
  }

  return new Map(
    [...grouped].map(([id, own]) => [
      id,
      {
        numbers: documentNumbersOf(own),
        issuedAt: own.find((value) => value.fieldCode === 'issued_at')?.valueDate ?? null,
        // Организации перечислены ПОИМЁННО, а не «всё, что не номер и не дата».
        // Прежняя редакция брала остаток, и расширение списка номеров тут же
        // подмешало бы шифр схемы в наименования организаций.
        organizations: own
          .filter((value) => ORGANIZATION_CODES.has(value.fieldCode))
          .map((value) => value.valueText ?? '')
          .filter((text) => text !== ''),
      },
    ]),
  );
}

/**
 * Сравнение наименований организаций — терпимое намеренно.
 *
 * «ООО „Баутранс“» в описи и «ООО Баутранс» в документе — одна организация,
 * различие внесено кавычками и распознаванием. Строгое равенство подняло бы
 * расхождение на каждой второй строке, а §9.1 прямо запрещает ложные
 * замечания: они разрушают доверие быстрее пропусков. Поэтому кавычки
 * снимаются, регистр гасится, и совпадением считается вхождение одного в
 * другое.
 */
function sameOrganization(left: string, right: string): boolean {
  const strip = (value: string): string =>
    normalizeRegistryName(value)
      .toLowerCase()
      .replace(/[«»"'`„“”]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim();

  const a = strip(left);
  const b = strip(right);
  if (a === '' || b === '') return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Расхождения реквизитов сопоставленной строки.
 *
 * Пустое значение с ЛЮБОЙ стороны расхождением не считается. Это не поблажка:
 * «реквизит не извлечён» и «реквизит не совпал» — разные факты, и объявить
 * первое вторым значило бы обвинить подрядчика в ошибке документа там, где
 * ошибся распознаватель (§9.1, открытый мир).
 */
function fieldMismatches(
  row: ParsedTransferRow,
  facts: DocumentFacts | undefined,
  document: LogicalDocumentView | undefined,
): string[] {
  const codes: string[] = [];

  if (row.issuedAt !== null && facts?.issuedAt != null && row.issuedAt !== facts.issuedAt) {
    codes.push(MISMATCH_ISSUED_AT);
  }

  if (row.orgRaw !== null && facts !== undefined && facts.organizations.length > 0) {
    const matched = facts.organizations.some((org) => sameOrganization(row.orgRaw as string, org));
    if (!matched) codes.push(MISMATCH_ORGANIZATION);
  }

  if (row.sheets !== null && document !== undefined && row.sheets !== document.pageCount) {
    codes.push(MISMATCH_SHEETS);
  }

  return codes;
}

/** Вердикт по набору расхождений. `unparsed` решается отдельно вызывающим. */
function verdictOf(input: {
  readonly rowsMissing: number;
  readonly rowsAmbiguous: number;
  readonly rowsFieldMismatch: number;
  readonly groupsMissing: number;
  readonly groupsAmbiguous: number;
  readonly worksExtra: number;
  readonly extraDocuments: number;
  readonly headerMismatch: boolean;
}): ReconciliationVerdict {
  const clean =
    input.rowsMissing === 0 &&
    input.rowsAmbiguous === 0 &&
    input.rowsFieldMismatch === 0 &&
    input.groupsMissing === 0 &&
    input.groupsAmbiguous === 0 &&
    input.worksExtra === 0 &&
    input.extraDocuments === 0 &&
    !input.headerMismatch;
  return clean ? 'clean' : 'mismatch';
}

/** Шапка описи против карточки реестра: сравниваются только заполненные поля. */
function headerMismatchOf(
  header: { readonly registryNo: string | null; readonly folderNo: string | null },
  registry: ReconcileRegistry,
): boolean {
  const same = (left: string | null, right: string | null): boolean => {
    if (left === null || right === null) return true;
    return normalizeRegistryName(left).toLowerCase() === normalizeRegistryName(right).toLowerCase();
  };
  return !same(header.registryNo, registry.number) || !same(header.folderNo, registry.folderNo);
}

/**
 * Адаптер к `matchRegistryRows`.
 *
 * У строки описи номер позиции — текст («6.23») или его нет вовсе, а
 * `ParsedRegistryRow.rowNo` объявлен обязательным числом. Суррогат — порядок
 * строки: сам он никуда не записывается, а результат разбирается ПОЗИЦИОННО,
 * как это уже делает `doc.match_registry`.
 */
function toMatchableRows(rows: readonly ParsedTransferRow[]): readonly ParsedRegistryRow[] {
  return rows.map((row, index) => ({
    rowNo: index + 1,
    sectionTitle: null,
    docNameRaw: row.docNameRaw,
    docNoRaw: row.docNoRaw,
    orgRaw: row.orgRaw,
    docNoNorm: row.docNoNorm,
    docNoFolded: row.docNoFolded,
    validFrom: row.validFrom,
    validTo: row.validTo,
    issuedAt: row.issuedAt,
  }));
}

export function createRegistryReconcileHandler(
  deps: RegistryReconcileDeps,
): JobHandler<'registry.reconcile'> {
  return async (ctx: JobContext<'registry.reconcile'>) => {
    const { registryId } = ctx.payload;

    // ---------------------------------------------------------------
    // 1. Скан описи — по ключу папки, до всякого чтения данных
    // ---------------------------------------------------------------
    // Ревизии в payload нет намеренно (см. докстринг типа задачи): её незачем
    // проверять на принадлежность папке, если она найдена ПО папке. Остаются
    // проверки состояния: файла может не быть вовсе, он может быть не подан,
    // а найденный комплект — оказаться не файлом описи.
    const scan = await deps.findScan(registryId);
    if (scan === null || scan.currentRevisionId === null) {
      throw new ReconcileStateError(
        `Реестр ${registryId}: подписанный файл описи не загружен — сверять нечего.`,
      );
    }
    if (scan.kind !== 'registry') {
      throw new ReconcileStateError(
        `Реестр ${registryId}: найденный комплект не является файлом описи.`,
      );
    }
    const revisionId = scan.currentRevisionId;

    const registry = await deps.findRegistry(scan.objectId, registryId);
    if (registry === null) {
      throw new ReconcileStateError(`Реестр ${registryId} не найден на объекте файла описи.`);
    }

    const base = {
      objectId: registry.objectId,
      registryId,
      workId: scan.workId,
      revisionId,
      parserVersion: TRANSFER_PARSER_VERSION,
      matcherVersion: TRANSFER_MATCHER_VERSION,
    };

    // ---------------------------------------------------------------
    // 2. Текст скана
    // ---------------------------------------------------------------
    const input = await deps.loadPages(revisionId);
    if (input.recognitionRunId === null) {
      // Состояние открытого мира, а не дефект: скан ещё не прогнали по
      // конвейеру. Задача успешна, вердикт честен.
      const saved = await deps.save({
        ...base,
        verdict: 'unparsed',
        headerRegistryNo: null,
        headerFolderNo: null,
        headerMismatch: false,
        warnings: ['завершённого распознавания файла описи нет: сверять нечего'],
        works: [],
        groups: [],
        rows: [],
        extraDocuments: [],
      });
      ctx.logger.info({ registryId }, 'опись не распознана: сверка отложена');
      await deps.emit(revisionId, 'registry.reconciled', {
        verdict: saved.verdict,
        registryId,
      });
      return;
    }
    if (input.pages.length === 0) {
      // Прогон есть, страниц нет — рассогласование данных. От повтора оно не
      // изменится, поэтому отказ нерепробируемый.
      throw new ReconcileStateError(
        `Ревизия ${revisionId}: распознавание есть, а страниц нет — состав рассогласован.`,
      );
    }

    // ---------------------------------------------------------------
    // 3. Разбор описи
    // ---------------------------------------------------------------
    const parsed = parseTransferRegistry({
      pages: input.pages.map((page) => ({
        sourcePageId: page.sourcePageId,
        pageTextVersionId: page.pageTextVersionId,
        text: page.text,
      })),
    });

    const complects = await deps.listComplectRevisions(registryId);
    const revisionIds = complects.map((complect) => complect.revisionId);

    // ---------------------------------------------------------------
    // 4. Документы и их номера — ДО сопоставления групп
    // ---------------------------------------------------------------
    const [documents, values, contractorNames] = await Promise.all([
      deps.listDocuments(registry.objectId, revisionIds),
      deps.listFieldValues(registry.objectId, revisionIds, [...FIELD_CODES]),
      deps.listContractorNames(complects.map((complect) => complect.contractorId)),
    ]);
    const facts = factsByDocument(values);

    const documentsByRevision = new Map<string, LogicalDocumentView[]>();
    for (const document of documents) {
      const bucket = documentsByRevision.get(document.revisionId);
      if (bucket === undefined) documentsByRevision.set(document.revisionId, [document]);
      else bucket.push(document);
    }

    const candidates: readonly TransferGroupCandidate[] = complects.map((complect) => ({
      workId: complect.workId,
      revisionId: complect.revisionId,
      contractorId: complect.contractorId,
      contractorName: contractorNames.get(complect.contractorId) ?? null,
      title: complect.title,
      actNumbers: (documentsByRevision.get(complect.revisionId) ?? [])
        .filter(
          (document) => document.docTypeCode !== null && document.docTypeCode.startsWith('aosr'),
        )
        // Номера АОСР — все формы, какие у документа нашлись: группа описи
        // называет акт одним номером, а комплект мог записать его и бланком.
        .flatMap((document) => facts.get(document.id)?.numbers ?? []),
    }));

    // ---------------------------------------------------------------
    // 5. Сопоставление групп и построчная сверка
    // ---------------------------------------------------------------
    const groupOutcome = matchTransferGroups(parsed.groups, candidates);
    const groupById = new Map(groupOutcome.groups.map((group) => [group.groupOrdinal, group]));

    const savedRows: ReconciliationRow[] = [];
    /** Документы, названные описью хотя бы одной группой ЭТОЙ ревизии. */
    const namedByRevision = new Map<string, Set<string>>();

    for (const group of parsed.groups) {
      const decision = groupById.get(group.ordinal);
      const rowsOfGroup = parsed.rows.filter((row) => row.groupOrdinal === group.ordinal);
      if (rowsOfGroup.length === 0) continue;

      if (decision === undefined || decision.state !== 'matched' || decision.revisionId === null) {
        // Строки несопоставленной группы матчеру не показываются: сравнивать
        // их не с чем, и подставить «какой-нибудь» комплект значило бы выдумать
        // факт. Причина у них своя, а не «документ не найден».
        const groupState = decision?.state === 'ambiguous' ? 'ambiguous' : 'missing';
        for (const row of rowsOfGroup) {
          savedRows.push(toMissingRow(row, groupState));
        }
        continue;
      }

      const revisionDocuments = documentsByRevision.get(decision.revisionId) ?? [];
      const matchable: readonly MatchableDocument[] = revisionDocuments.map((document) => ({
        documentId: document.id,
        docTypeCode: document.docTypeCode,
        numbers: facts.get(document.id)?.numbers ?? [],
        title: document.title,
      }));
      const byId = new Map(revisionDocuments.map((document) => [document.id, document]));

      const outcome = matchRegistryRows(toMatchableRows(rowsOfGroup), matchable);

      const named = namedByRevision.get(decision.revisionId) ?? new Set<string>();
      namedByRevision.set(decision.revisionId, named);

      for (const [index, verdict] of outcome.rows.entries()) {
        const row = rowsOfGroup[index];
        if (row === undefined) continue;
        if (verdict.matchedDocumentId !== null) named.add(verdict.matchedDocumentId);

        const document =
          verdict.matchedDocumentId === null ? undefined : byId.get(verdict.matchedDocumentId);
        const mismatches =
          verdict.matchState === 'matched'
            ? fieldMismatches(
                row,
                verdict.matchedDocumentId === null
                  ? undefined
                  : facts.get(verdict.matchedDocumentId),
                document,
              )
            : [];

        savedRows.push({
          ordinal: row.ordinal,
          groupOrdinal: row.groupOrdinal,
          workId: decision.workId,
          contractorId: decision.contractorId,
          rowNo: row.rowNo,
          docNameRaw: row.docNameRaw,
          docNoRaw: row.docNoRaw,
          docNoNorm: row.docNoNorm,
          orgRaw: row.orgRaw,
          issuedAt: row.issuedAt,
          validFrom: row.validFrom,
          validTo: row.validTo,
          sheets: row.sheets,
          copies: row.copies,
          pagesRaw: row.pagesRaw,
          matchedDocumentId: verdict.matchedDocumentId,
          // `matchRegistryRows` знает и значение `'extra'`, но строкам его не
          // присваивает ни одна ветка: у строки описи такого состояния нет.
          matchState: verdict.matchState === 'extra' ? 'missing' : verdict.matchState,
          matchScore: verdict.matchScore,
          fieldMismatches: mismatches,
          reason: verdict.reason,
        });
      }

      // `outcome.extraDocumentIds` здесь НЕ используется намеренно: он
      // отвечает на вопрос «кого не назвала эта группа», а нужен ответ на
      // «кого не назвала опись». Их объединение по группам объявило бы лишним
      // почти каждый документ — см. шаг 6.
    }

    // ---------------------------------------------------------------
    // 6. Лишние документы — ПЕРЕСЕЧЕНИЕ по ревизии, а не объединение
    // ---------------------------------------------------------------
    // `matchRegistryRows` возвращает документы, не названные строками ЭТОГО
    // вызова. При вызове по одной группе объединение таких множеств объявило бы
    // лишним почти каждый документ: то, что назвала группа 1, не названо
    // группой 2. Поэтому копится множество НАЗВАННЫХ по всем группам ревизии, а
    // лишние — это дополнение к нему.
    const extraDocuments: ReconciliationExtraDocument[] = [];
    const matchedComplects = new Set(
      groupOutcome.groups
        .filter((group) => group.state === 'matched' && group.workId !== null)
        .map((group) => group.workId as string),
    );

    for (const complect of complects) {
      if (!matchedComplects.has(complect.workId)) continue;
      const named = namedByRevision.get(complect.revisionId) ?? new Set<string>();
      for (const document of documentsByRevision.get(complect.revisionId) ?? []) {
        if (named.has(document.id)) continue;
        extraDocuments.push({
          documentId: document.id,
          workId: complect.workId,
          revisionId: complect.revisionId,
          contractorId: complect.contractorId,
          docNoRaw: facts.get(document.id)?.numbers[0] ?? null,
          docNameRaw: document.title,
          docTypeCode: document.docTypeCode,
        });
      }
    }

    // ---------------------------------------------------------------
    // 7. Свод по КАЖДОМУ комплекту
    // ---------------------------------------------------------------
    const works: ReconciliationWork[] = complects.map((complect) => {
      const rowsOfWork = savedRows.filter((row) => row.workId === complect.workId);
      const extraOfWork = extraDocuments.filter((doc) => doc.workId === complect.workId);
      const state: ReconciliationWork['state'] = matchedComplects.has(complect.workId)
        ? 'matched'
        : 'extra';

      const rowsMissing = rowsOfWork.filter((row) => row.matchState === 'missing').length;
      const rowsAmbiguous = rowsOfWork.filter((row) => row.matchState === 'ambiguous').length;
      const rowsFieldMismatch = rowsOfWork.filter((row) => row.fieldMismatches.length > 0).length;

      const verdict: ReconciliationVerdict =
        state === 'extra'
          ? 'mismatch'
          : verdictOf({
              rowsMissing,
              rowsAmbiguous,
              rowsFieldMismatch,
              groupsMissing: 0,
              groupsAmbiguous: 0,
              worksExtra: 0,
              extraDocuments: extraOfWork.length,
              headerMismatch: false,
            });

      return {
        workId: complect.workId,
        matchedRevisionId: complect.revisionId,
        contractorId: complect.contractorId,
        title: complect.title,
        contractorName: contractorNames.get(complect.contractorId) ?? null,
        state,
        verdict,
        rowsTotal: rowsOfWork.length,
        rowsMatched: rowsOfWork.filter((row) => row.matchState === 'matched').length,
        rowsMissing,
        rowsAmbiguous,
        rowsFieldMismatch,
        extraDocuments: extraOfWork.length,
      };
    });

    // ---------------------------------------------------------------
    // 8. Сводка по папке и запись
    // ---------------------------------------------------------------
    const groups: readonly ReconciliationGroup[] = parsed.groups.map((group) => {
      const decision = groupById.get(group.ordinal);
      return {
        ordinal: group.ordinal,
        groupNo: group.groupNo,
        titleRaw: group.titleRaw,
        actNoRaw: group.actNoRaw,
        actNoNorm: group.actNoNorm,
        contractorRaw: group.contractorRaw,
        matchedWorkId: decision?.workId ?? null,
        matchedRevisionId: decision?.revisionId ?? null,
        matchedContractorId: decision?.contractorId ?? null,
        matchState: decision?.state ?? 'missing',
        matchScore: decision?.score ?? null,
        reason: decision?.reason ?? 'группа описи не сопоставлена',
      };
    });

    const headerMismatch = headerMismatchOf(parsed.header, registry);
    const worksExtra = works.filter((work) => work.state === 'extra').length;

    // Ноль строк при непустом составе — это «опись не разобрана», а не
    // «расхождений нет». Двузначный вердикт соврал бы здесь `clean`.
    const verdict: ReconciliationVerdict =
      parsed.rows.length === 0 && complects.length > 0
        ? 'unparsed'
        : verdictOf({
            rowsMissing: savedRows.filter((row) => row.matchState === 'missing').length,
            rowsAmbiguous: savedRows.filter((row) => row.matchState === 'ambiguous').length,
            rowsFieldMismatch: savedRows.filter((row) => row.fieldMismatches.length > 0).length,
            groupsMissing: groups.filter((group) => group.matchState === 'missing').length,
            groupsAmbiguous: groups.filter((group) => group.matchState === 'ambiguous').length,
            worksExtra,
            extraDocuments: extraDocuments.length,
            headerMismatch,
          });

    const saved = await deps.save({
      ...base,
      verdict,
      headerRegistryNo: parsed.header.registryNo,
      headerFolderNo: parsed.header.folderNo,
      headerMismatch,
      warnings: parsed.warnings,
      works,
      groups,
      rows: savedRows,
      extraDocuments,
    });

    const counts = {
      verdict: saved.verdict,
      groups: saved.groupsTotal,
      groupsMissing: saved.groupsMissing,
      rows: saved.rowsTotal,
      rowsMissing: saved.rowsMissing,
      rowsFieldMismatch: saved.rowsFieldMismatch,
      worksExtra: saved.worksExtra,
      extraDocuments: saved.extraDocuments,
    };
    ctx.logger.info({ registryId, counts }, 'опись сверена с комплектами папки');
    await deps.emit(revisionId, 'registry.reconciled', counts);
  };
}

/** Строка описи, чью группу не удалось отнести к комплекту. */
function toMissingRow(
  row: ParsedTransferRow,
  groupState: 'missing' | 'ambiguous',
): ReconciliationRow {
  return {
    ordinal: row.ordinal,
    groupOrdinal: row.groupOrdinal,
    workId: null,
    contractorId: null,
    rowNo: row.rowNo,
    docNameRaw: row.docNameRaw,
    docNoRaw: row.docNoRaw,
    docNoNorm: row.docNoNorm,
    orgRaw: row.orgRaw,
    issuedAt: row.issuedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    sheets: row.sheets,
    copies: row.copies,
    pagesRaw: row.pagesRaw,
    matchedDocumentId: null,
    matchState: 'missing',
    matchScore: null,
    fieldMismatches: [],
    reason:
      groupState === 'ambiguous'
        ? 'группа описи подходит нескольким комплектам: строки не сверялись'
        : 'группа описи не сопоставлена ни одному комплекту папки',
  };
}
