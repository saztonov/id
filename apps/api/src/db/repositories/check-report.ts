/**
 * Отчёт о составе комплекта и результате проверки (S29).
 *
 * ## Зачем он появился
 *
 * ADR-0016 свёл вкладку «Проверка» к списку ошибок — и это было верно ровно до
 * первого чистого комплекта. Экран, отвечающий только на вопрос «что не так»,
 * при отсутствии ошибок показывает пустую таблицу, и заказчик, прогнав комплект
 * из 83 страниц, сказал прямо: «результат распознавания невозможно понять» —
 * непонятно даже, прочитал ли портал хоть что-нибудь.
 *
 * Отчёт отвечает на вопрос «что портал прочитал и что с этим не так» в порядке,
 * названном заказчиком: **АОСР → строки внутреннего реестра → паспорта,
 * сертификаты и прочее**, с подтверждением в каждой строке.
 *
 * ## Это НЕ возврат раздела «Документы комплекта»
 *
 * ADR-0016 убрал не показ состава, а требование СОБИРАТЬ его руками: границы
 * документов подтверждает конвейер, нарезка идёт сама. Здесь нет ни одного
 * действия, меняющего состав, — только чтение. Убранные тогда кнопки убранными
 * и остаются.
 *
 * ## Собирает сервер
 *
 * По тому же доводу, по которому сервер собирает подпись замечания (ADR-0016,
 * решение 2): номер страницы, эффективное название вида ИД (`doc_types` с
 * наложением `doc_type_overrides`), состояние сверки с реестром и вердикты
 * правил живут только в БД. Клиент добывал бы их четырьмя запросами и всё равно
 * не знал бы, как их сложить.
 *
 * ## Чего здесь намеренно нет
 *
 * **Вердикта «чисто/не чисто».** Его считает экран (`grouping.ts:runStateOf`)
 * по сводке замечаний и покрытия. Второе место, отвечающее на тот же вопрос,
 * разошлось бы с первым при первой же правке условия — а условие это заказчик
 * задал строгим, и ошибиться в нём означает поставить зелёную плашку над
 * таблицей с крестиками.
 *
 * ## Инвариант полноты
 *
 * Каждое видимое замечание (`open` либо `undetermined`) попадает в отчёт РОВНО
 * ОДИН раз. Те, которым не нашлось документа, — замечания о материале, о партии,
 * о непривязанной странице, о пересобранном объекте — собираются в последнюю
 * секцию `unplaced`, а не исчезают: молча потерянное замечание хуже показанного
 * дважды. Проверяется тестом, а не намерением.
 */
import { asc, eq } from 'drizzle-orm';
import { ruleDefinitions, folders } from '@id/db';
import { isAnalysisAnchor, isQualityDocCode, isRegistryCode } from '@id/doc-types';

import type { AuthScope } from '../../auth/scope.js';
import { withScope, type ScopeTarget } from '../scoped.js';
import {
  collectFindings,
  loadFindingContext,
  readRunJournal,
  resolveShownRun,
  type DocumentFacts,
  type FindingContext,
  type FindingView,
} from './checks.js';
import { listFieldValuesOfFolders, listRegistryRows } from './documents.js';
import type { RegistryRowView } from './documents.js';
import type { Database } from './users.js';

type ReadExecutor = Pick<Database, 'select'>;

const FOLDER_SCOPE: ScopeTarget = {
  objectId: folders.objectId,
  contractorId: folders.contractorId,
};

/**
 * Состояние строки отчёта.
 *
 * `unchecked` — прогона правил не было, и портал НЕ ЗНАЕТ, верны ли данные.
 * Смешать его с `ok` было бы ровно той ложью, из-за которой экран и переделан:
 * «Ошибок не найдено» печаталось там, где ошибок не искали.
 */
export type ReportRowStatus = 'ok' | 'error' | 'warning' | 'undetermined' | 'missing' | 'unchecked';

/**
 * Состояние пункта чек-листа.
 *
 * Троичность §0.5 сохранена целиком: `not_applicable` (правило неприменимо к
 * этому комплекту) и `not_run` (правило не исполнялось — выключено в наборе или
 * не входит в профиль) не сливаются ни с успехом, ни с ошибкой. Галочка
 * ставится ТОЛЬКО вердикту `pass`.
 */
export type ReportItemStatus =
  'ok' | 'error' | 'warning' | 'undetermined' | 'not_applicable' | 'not_run';

export type ReportSectionKind = 'act' | 'registry' | 'quality' | 'other' | 'unplaced';

export interface ReportDates {
  readonly issuedAt: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  /**
   * Дата составления акта (S40).
   *
   * Отдельным полем, а не под видом `issuedAt`: акт никто не выдаёт, его
   * составляет комиссия, и «выдан 21.11.2024» о нём — неверная фраза. До S40
   * колонка дат у акта показывала «выдан 10.04.2023, до 01.08.2026»: первая
   * дата была взята из договора строительного контроля в шапке, вторая — из
   * сертификата, названного в п. 3. Извлечение этих реквизитов у акта
   * прекращено, и, чтобы колонка не осталась пустой у главного документа
   * комплекта, сюда приходит его настоящая дата.
   */
  readonly composedAt: string | null;
}

export interface ReportItem {
  readonly code: string;
  readonly title: string;
  readonly status: ReportItemStatus;
  readonly detail: string | null;
  /** Способ устранения из правила: без него замечание бесполезно (§9.1). */
  readonly hint: string | null;
}

export interface ReportRow {
  readonly id: string;
  readonly kind: 'document' | 'registry_row' | 'finding';
  readonly title: string;
  readonly subtitle: string | null;
  /** Адрес для перехода на разметку; `null` — идти некуда. */
  readonly page: { readonly number: number; readonly workingPageIndex: number | null } | null;
  /** Диапазон страниц документа для печати: «1–3» либо «8». */
  readonly pages: string | null;
  readonly dates: ReportDates | null;
  readonly status: ReportRowStatus;
  readonly statusText: string;
  /**
   * Способ устранения — рядом со строкой, а не в раскрытии.
   *
   * ADR-0016 записал это отдельным решением: замечание без способа устранения
   * бесполезно подрядчику, а раскрытие — ещё одно нажатие ради двух строк
   * текста. Берётся у того же замечания, которое дало `statusText`.
   */
  readonly statusHint: string | null;
  /**
   * Код правила и блок замечания, давшего строке её состояние.
   *
   * §16 называет переход «замечание → доказательство» отдельным пунктом
   * приёмки: ссылка обязана открыть ТУ страницу и выделить ТОТ блок, а не
   * начало документа. Без этих двух полей строка вела бы на первый лист акта, и
   * проверяющий, не найдя обещанного, перестал бы верить остальным строкам.
   */
  readonly statusRuleCode: string | null;
  readonly blockId: string | null;
  readonly findingIds: readonly string[];
  readonly items: readonly ReportItem[];
}

export interface ReportSection {
  readonly kind: ReportSectionKind;
  readonly title: string;
  /** Заявление о секции целиком: «реестр приложений в комплекте не найден». */
  readonly note: string | null;
  readonly rows: readonly ReportRow[];
}

export interface CheckReportView {
  /** Прогон, по которому собран отчёт; `null` — проверки не было. */
  readonly runId: string | null;
  readonly sections: readonly ReportSection[];
}

/**
 * Реквизиты, попадающие в отчёт.
 *
 * Список закрыт намеренно: строка таблицы отвечает на «что это и до какого числа
 * годно», а не показывает все два десятка извлечённых полей. Читать всё и
 * выбрасывать лишнее значило бы возить по сети содержимое каждого документа
 * комплекта ради трёх дат.
 */
const REPORT_FIELD_CODES = [
  'number',
  'issued_at',
  'valid_from',
  'valid_to',
  'manufacturer',
  'product_name',
  'act_number',
  'act_date',
  'registry_number',
] as const;

/** Пункты чек-листа акта — по префиксу кода, а не списком (см. `aosr.ts`). */
const CHECKLIST_PREFIX = 'AOSR.';

export async function buildCheckReport(
  db: Database,
  scope: AuthScope,
  folderId: string,
): Promise<CheckReportView> {
  return db.transaction(async (tx) => {
    /**
     * Область видимости проверяется ОТДЕЛЬНО и ПЕРВОЙ.
     *
     * Не формальность: `loadFindingContext` читает страницы, документы и строки
     * реестра БЕЗ `withScope` — он частный помощник выдачи замечаний, и права
     * там доказаны запросом к `findings`, который уже отфильтрован областью.
     * Отчёт зовёт его напрямую и по любому идентификатору, поэтому без этой
     * проверки состав чужого комплекта уезжал бы в ответ целиком. Дефект был
     * пойман тестом изоляции, а не обзором кода, — как и утечка времени чужого
     * прогона на S27.
     *
     * Отказ — пустой отчёт, а не 404: маршрут отдаёт список, и по решению модуля
     * список чужой ревизии это 200 с пустым содержимым. Пустота одинакова для
     * чужой и для несуществующей ревизии, поэтому о существовании соседней
     * поставки ответ не сообщает ничего (§16).
     */
    const visible = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(withScope(scope, FOLDER_SCOPE, eq(folders.id, folderId)))
      .limit(1);
    if (visible.length === 0) return { runId: null, sections: [] };

    const { shownRunId } = await resolveShownRun(tx, scope, folderId, undefined);

    const findings =
      shownRunId === null ? [] : await collectFindings(tx, scope, folderId, shownRunId);
    // Контекст читается ВСЕГДА, в том числе без прогона: состав комплекта виден
    // и до проверки — ровно это заказчик и не мог увидеть на пустом экране.
    const context = await loadFindingContext(
      tx,
      folderId,
      findings.map((finding) => finding.id),
    );
    const registry = await listRegistryRows(tx, scope, folderId);
    const fields = await listFieldValuesOfFolders(tx, scope, [folderId], REPORT_FIELD_CODES);
    const journal =
      shownRunId === null
        ? null
        : await readRunJournal(tx, { validationRunId: shownRunId, folderId });
    const titles = await loadRuleTitles(tx);

    const facts = new ReportFacts({
      context,
      fields,
      findings,
      journal,
      titles,
      checked: shownRunId !== null,
    });

    const sections = [
      facts.documentSection('act', 'Акт освидетельствования', (code) => isAnalysisAnchor(code)),
      facts.registrySection(registry),
      facts.documentSection('quality', 'Паспорта, сертификаты и документы о качестве', (code) =>
        isQualityDocCode(code),
      ),
      facts.documentSection(
        'other',
        'Прочие документы комплекта',
        (code) => !isAnalysisAnchor(code) && !isQualityDocCode(code) && !isRegistryCode(code),
      ),
      facts.unplacedSection(),
    ].filter((section) => section.rows.length > 0 || section.note !== null);

    return { runId: shownRunId, sections };
  });
}

async function loadRuleTitles(db: ReadExecutor): Promise<ReadonlyMap<string, string>> {
  const rows = await db
    .select({ code: ruleDefinitions.code, title: ruleDefinitions.title })
    .from(ruleDefinitions)
    .orderBy(asc(ruleDefinitions.code));
  return new Map(rows.map((row) => [row.code, row.title]));
}

interface FieldRow {
  readonly documentId: string;
  readonly fieldCode: string;
  readonly valueText: string | null;
  readonly valueDate: string | null;
}

interface FactsInput {
  readonly context: FindingContext;
  readonly fields: readonly FieldRow[];
  readonly findings: readonly FindingView[];
  readonly journal: { readonly executions?: unknown; readonly skippedCodes?: unknown } | null;
  readonly titles: ReadonlyMap<string, string>;
  readonly checked: boolean;
}

interface Execution {
  readonly verdict: string;
  readonly reason: string | null;
}

/**
 * Разложенные по документам факты и сборка строк.
 *
 * Класс, а не набор функций с восемью параметрами: карты строятся один раз и
 * читаются пятью методами, и протаскивание их через сигнатуры превратило бы
 * каждую в список из восьми одинаковых аргументов.
 */
class ReportFacts {
  private readonly context: FindingContext;
  private readonly checked: boolean;
  private readonly titles: ReadonlyMap<string, string>;
  private readonly executions = new Map<string, Execution>();
  private readonly skipped = new Map<string, string>();
  private readonly fieldsByDocument = new Map<string, Map<string, FieldRow>>();
  private readonly findingsByDocument = new Map<string, FindingView[]>();
  private readonly pageNumbers = new Map<string, number[]>();
  /** Идентификаторы замечаний, уже разложенных по строкам: инвариант полноты. */
  private readonly placed = new Set<string>();
  private readonly visible: readonly FindingView[];

  constructor(input: FactsInput) {
    this.context = input.context;
    this.checked = input.checked;
    this.titles = input.titles;

    for (const execution of asExecutions(input.journal?.executions)) {
      this.executions.set(execution.ruleCode, {
        verdict: execution.verdict,
        reason: execution.reason,
      });
    }
    for (const [code, reason] of Object.entries(asRecord(input.journal?.skippedCodes))) {
      this.skipped.set(code, String(reason));
    }

    for (const field of input.fields) {
      const own = this.fieldsByDocument.get(field.documentId) ?? new Map<string, FieldRow>();
      own.set(field.fieldCode, field);
      this.fieldsByDocument.set(field.documentId, own);
    }

    this.visible = input.findings.filter(
      (finding) => finding.state === 'open' || finding.state === 'undetermined',
    );
    for (const finding of this.visible) {
      const documentId = finding.document?.id;
      if (documentId === undefined) continue;
      const own = this.findingsByDocument.get(documentId) ?? [];
      own.push(finding);
      this.findingsByDocument.set(documentId, own);
    }

    for (const facts of input.context.pages.values()) {
      if (facts.documentId === null) continue;
      const own = this.pageNumbers.get(facts.documentId) ?? [];
      own.push(facts.number);
      this.pageNumbers.set(facts.documentId, own);
    }
  }

  /** Документы секции, упорядоченные по первой странице — как их листают. */
  documentSection(
    kind: ReportSectionKind,
    title: string,
    belongs: (docTypeCode: string | null) => boolean,
  ): ReportSection {
    const rows = [...this.context.documents.entries()]
      .filter(([, facts]) => belongs(facts.docTypeCode))
      .sort((a, b) => this.firstPageNumber(a[0]) - this.firstPageNumber(b[0]))
      .map(([id, facts]) => this.documentRow(id, facts));
    return { kind, title, note: null, rows };
  }

  /**
   * Реестр приложений: сам документ-реестр и КАЖДАЯ его строка.
   *
   * Строка реестра — не документ комплекта, а обещание, что документ в нём есть.
   * Ровно на этот вопрос отвечает `match_state`, и он считается сверкой по
   * НОМЕРУ, а не по виду (находка корпуса: реестр называет все двенадцать
   * документов о качестве просто «Документ о качестве»).
   *
   * Состояние сверки живёт независимо от прогона правил — его пишет
   * `doc.match_registry` на стадии анализа. Поэтому строки реестра остаются
   * осмысленными и до проверки, и гасить их в `unchecked` было бы враньём в
   * обратную сторону.
   */
  registrySection(rows: readonly RegistryRowView[]): ReportSection {
    const documents = [...this.context.documents.entries()]
      .filter(([, facts]) => isRegistryCode(facts.docTypeCode))
      .sort((a, b) => this.firstPageNumber(a[0]) - this.firstPageNumber(b[0]));

    const out: ReportRow[] = [];
    const taken = new Set<string>();
    for (const [id, facts] of documents) {
      out.push(this.documentRow(id, facts));
      for (const row of rows.filter((candidate) => candidate.documentId === id)) {
        taken.add(row.id);
        out.push(this.registryRow(row));
      }
    }
    // Строки без своего документа-реестра быть не должно (внешний ключ), но
    // терять её при рассинхроне нельзя: пропавшая строка реестра читается как
    // «реестр сошёлся».
    for (const row of rows.filter((candidate) => !taken.has(candidate.id))) {
      out.push(this.registryRow(row));
    }

    /**
     * «Реестра нет» говорится только про РАЗОБРАННЫЙ комплект.
     *
     * На ревизии, где документов нет вовсе, эта фраза читалась бы как дефект
     * комплекта, хотя портал просто ещё ничего не разбирал. Заявление о
     * полноте обязано отличать «искали и не нашли» от «не искали» — та же
     * граница, из-за которой переделан текст сводки.
     */
    const note =
      this.context.documents.size === 0
        ? null
        : documents.length === 0
          ? 'Реестр приложений в комплекте не найден: сверять состав не с чем.'
          : rows.length === 0
            ? 'Реестр приложений найден, но ни одна его строка не разобрана.'
            : null;

    return { kind: 'registry', title: 'Реестр приложений', note, rows: out };
  }

  /**
   * Замечания, которым не нашлось строки.
   *
   * О материале, которого в комплекте нет; о партии; о непривязанной странице;
   * об объекте, пересобранном после проверки. У них нет документа по
   * построению — они о том, чего НЕ ХВАТАЕТ, — и прочерк в колонке читался бы
   * как дефект портала (ADR-0016).
   */
  unplacedSection(): ReportSection {
    const rows = this.visible
      .filter((finding) => !this.placed.has(finding.id))
      .map<ReportRow>((finding) => ({
        id: finding.id,
        kind: 'finding',
        title: finding.target.label,
        subtitle: finding.target.detail,
        page: finding.page === null ? null : { ...finding.page },
        pages: null,
        dates: null,
        status: statusOfSeverity(finding),
        statusText: finding.text,
        statusHint: finding.hint,
        statusRuleCode: finding.ruleCode,
        blockId: finding.blockId,
        findingIds: [finding.id],
        items: [],
      }));

    return {
      kind: 'unplaced',
      title: 'Замечания без адреса в комплекте',
      note:
        rows.length === 0
          ? null
          : 'Эти замечания не привязаны к документу: они о том, чего в комплекте не хватает.',
      rows,
    };
  }

  // ===================================================================
  // Строки
  // ===================================================================

  private documentRow(id: string, facts: DocumentFacts): ReportRow {
    const own = this.findingsByDocument.get(id) ?? [];
    for (const finding of own) this.placed.add(finding.id);

    const checklist = isAnalysisAnchor(facts.docTypeCode) ? this.checklistItems(own) : [];
    const items = [...checklist, ...this.findingItems(own, checklist)];
    const verdict = this.verdictOf(own, checklist);

    return {
      id,
      kind: 'document',
      title: this.documentTitle(id, facts),
      subtitle: this.documentSubtitle(id),
      // Страница замечания точнее первой страницы документа и уже посчитана
      // сервером по той же лестнице «явная → доказательство → реквизит →
      // начало документа» (`resolveSubject`).
      page: verdict.source?.page ?? this.pageOf(facts.firstPageId),
      pages: this.pageRange(id),
      dates: this.datesOf(id),
      status: verdict.status,
      statusText: verdict.text,
      statusHint: verdict.hint,
      statusRuleCode: verdict.source?.ruleCode ?? null,
      blockId: verdict.source?.blockId ?? null,
      findingIds: own.map((finding) => finding.id),
      items,
    };
  }

  private registryRow(row: RegistryRowView): ReportRow {
    const matched = row.matchedDocumentId;
    const page =
      matched === null
        ? null
        : this.pageOf(this.context.documents.get(matched)?.firstPageId ?? null);

    /**
     * Совпадение по КУСКУ номера не выдаётся за проверенный факт.
     *
     * Сверка отдаёт такие строки с пониженным счётом (`match.ts`, последняя
     * ступень лестницы): документ найден, но совпал не весь номер. Показать это
     * как «данные верны» значило бы скрыть от проверяющего единственное место,
     * где решение принял порог, а не равенство.
     */
    const partial = row.matchState === 'matched' && (row.matchScore ?? 1) < 1;

    const status: ReportRowStatus =
      row.matchState === 'matched'
        ? partial
          ? 'warning'
          : 'ok'
        : row.matchState === 'missing'
          ? 'error'
          : row.matchState === 'ambiguous'
            ? 'warning'
            : row.matchState === 'candidate'
              ? 'warning'
              : 'warning';
    const where = page === null ? '' : `, стр. ${String(page.number)}`;
    const statusText =
      row.matchState === 'matched'
        ? partial
          ? `номер совпал не полностью — проверьте документ${where}`
          : `найден в комплекте${where}`
        : row.matchState === 'missing'
          ? 'нет в комплекте'
          : row.matchState === 'ambiguous'
            ? 'номер подошёл нескольким документам — какой именно, неизвестно'
            : row.matchState === 'candidate'
              ? // Кандидат ничего не утверждает: номер не совпал, а похожий
                // документ в комплекте есть. Решает человек — и решать ему
                // нечем, пока строка не называет, ЧТО именно похоже: «похожих
                // документов 2» отправляет проверяющего листать комплект
                // руками, хотя страницы известны серверу.
                `номер не совпал; сверьте вручную${this.candidatePages(row.candidateDocumentIds)}`
              : 'документ комплекта не назван ни одной строкой реестра';

    return {
      id: row.id,
      kind: 'registry_row',
      title: row.rowNo === null ? row.docNameRaw : `${String(row.rowNo)}. ${row.docNameRaw}`,
      subtitle:
        [row.docNoRaw === null ? null : `№ ${row.docNoRaw}`, row.orgRaw]
          .filter((part): part is string => part !== null && part !== '')
          .join(' · ') || null,
      page,
      pages: null,
      dates: {
        issuedAt: row.issuedAt,
        validFrom: row.validFrom,
        validTo: row.validTo,
        // У строки реестра даты составления нет: составляют акт, а не строку.
        composedAt: null,
      },
      status,
      statusText,
      statusHint: null,
      statusRuleCode: null,
      blockId: null,
      findingIds: [],
      items: [],
    };
  }

  // ===================================================================
  // Чек-лист и замечания строки
  // ===================================================================

  /**
   * Пункты чек-листа акта из журнала исполнения правил.
   *
   * Журнал ведётся по КОДУ ПРАВИЛА, а не по документу: при двух актах в
   * комплекте пройденное правило считается пройденным для обоих, а
   * провалившееся привязывается к акту замечанием (`finding.document`). Для
   * комплекта одной работы (ADR-0011: «один АОСР со своими приложениями»)
   * неоднозначности нет вовсе.
   */
  private checklistItems(own: readonly FindingView[]): readonly ReportItem[] {
    const codes = new Set<string>();
    for (const code of this.executions.keys())
      if (code.startsWith(CHECKLIST_PREFIX)) codes.add(code);
    for (const code of this.skipped.keys()) if (code.startsWith(CHECKLIST_PREFIX)) codes.add(code);
    for (const finding of own) {
      if (finding.ruleCode.startsWith(CHECKLIST_PREFIX)) codes.add(finding.ruleCode);
    }

    return [...codes]
      .sort((a, b) => a.localeCompare(b, 'ru'))
      .map<ReportItem>((code) => {
        const failed = own.filter((finding) => finding.ruleCode === code);
        const execution = this.executions.get(code);
        const skip = this.skipped.get(code);

        if (failed.length > 0) {
          const worst = failed[0] as FindingView;
          return {
            code,
            title: this.titleOf(code),
            status: statusOfSeverity(worst),
            detail: worst.text,
            hint: worst.hint,
          };
        }
        if (execution?.verdict === 'pass') {
          return { code, title: this.titleOf(code), status: 'ok', detail: null, hint: null };
        }
        if (execution?.verdict === 'n_a') {
          return {
            code,
            title: this.titleOf(code),
            status: 'not_applicable',
            detail: execution.reason,
            hint: null,
          };
        }
        if (execution?.verdict === 'undetermined') {
          return {
            code,
            title: this.titleOf(code),
            status: 'undetermined',
            detail: execution.reason,
            hint: null,
          };
        }
        return {
          code,
          title: this.titleOf(code),
          status: 'not_run',
          detail: skip === undefined ? null : skipReason(skip),
          hint: null,
        };
      });
  }

  /** Замечания документа, не показанные чек-листом. */
  private findingItems(
    own: readonly FindingView[],
    checklist: readonly ReportItem[],
  ): readonly ReportItem[] {
    const shown = new Set(checklist.map((item) => item.code));
    return own
      .filter((finding) => !shown.has(finding.ruleCode))
      .map<ReportItem>((finding) => ({
        code: finding.ruleCode,
        title: this.titleOf(finding.ruleCode),
        status: statusOfSeverity(finding),
        detail: finding.text,
        hint: finding.hint,
      }));
  }

  private verdictOf(
    own: readonly FindingView[],
    checklist: readonly ReportItem[],
  ): { status: ReportRowStatus; text: string; hint: string | null; source: FindingView | null } {
    if (!this.checked) {
      return {
        status: 'unchecked',
        text: 'проверка по правилам не выполнялась',
        hint: null,
        source: null,
      };
    }

    for (const status of ['error', 'warning', 'undetermined'] as const) {
      const found = own.find((finding) => statusOfSeverity(finding) === status);
      if (found !== undefined) {
        return { status, text: withRest(found.text, own, status), hint: found.hint, source: found };
      }
    }

    if (checklist.length > 0) {
      const passed = checklist.filter((item) => item.status === 'ok').length;
      const applicable = checklist.filter(
        (item) => item.status !== 'not_applicable' && item.status !== 'not_run',
      ).length;
      return {
        status: 'ok',
        text: `чек-лист пройден: ${String(passed)} из ${String(applicable)}`,
        hint: null,
        source: null,
      };
    }
    return { status: 'ok', text: 'данные верны', hint: null, source: null };
  }

  // ===================================================================
  // Мелочи печати
  // ===================================================================

  /**
   * Страницы похожих документов строки: «: похоже на стр. 19, 20».
   *
   * Пустая строка, когда сказать нечего: страницы кандидатов неизвестны либо
   * кандидатов нет вовсе. Число кандидатов отдельно не печатается — оно видно
   * по перечню, а «похожих документов 2» без перечня не помогает никому.
   */
  private candidatePages(documentIds: readonly string[]): string {
    const pages = documentIds
      .map((id) => this.pageOf(this.context.documents.get(id)?.firstPageId ?? null)?.number)
      .filter((number): number is number => number !== undefined)
      .sort((left, right) => left - right);

    return pages.length === 0 ? '' : `: похоже на стр. ${pages.join(', ')}`;
  }

  private titleOf(code: string): string {
    // Название правила берётся из БД: администратор правит их в портале, и
    // каталог в коде разошёлся бы с ним при первой же правке.
    return this.titles.get(code) ?? code;
  }

  private documentTitle(id: string, facts: DocumentFacts): string {
    const number =
      this.fieldOf(id, 'act_number') ??
      this.fieldOf(id, 'registry_number') ??
      this.fieldOf(id, 'number');
    return number === null ? facts.label : `${facts.label} № ${number}`;
  }

  private documentSubtitle(id: string): string | null {
    return this.fieldOf(id, 'product_name') ?? this.fieldOf(id, 'manufacturer');
  }

  private fieldOf(documentId: string, code: string): string | null {
    const value = this.fieldsByDocument.get(documentId)?.get(code);
    if (value === undefined) return null;
    const text = value.valueText ?? value.valueDate;
    return text === null || text === '' ? null : text;
  }

  private datesOf(documentId: string): ReportDates | null {
    const own = this.fieldsByDocument.get(documentId);
    if (own === undefined) return null;
    const dates: ReportDates = {
      issuedAt: own.get('issued_at')?.valueDate ?? null,
      validFrom: own.get('valid_from')?.valueDate ?? null,
      validTo: own.get('valid_to')?.valueDate ?? null,
      composedAt: own.get('act_date')?.valueDate ?? null,
    };
    return dates.issuedAt === null &&
      dates.validFrom === null &&
      dates.validTo === null &&
      dates.composedAt === null
      ? null
      : dates;
  }

  private pageOf(
    pageId: string | null,
  ): { readonly number: number; readonly workingPageIndex: number | null } | null {
    if (pageId === null) return null;
    const facts = this.context.pages.get(pageId);
    return facts === undefined
      ? null
      : { number: facts.number, workingPageIndex: facts.workingPageIndex };
  }

  private firstPageNumber(documentId: string): number {
    const numbers = this.pageNumbers.get(documentId);
    // Документ без страниц ставится в конец, а не в начало: строка без адреса
    // среди первых читалась бы как самая важная.
    return numbers === undefined || numbers.length === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.min(...numbers);
  }

  private pageRange(documentId: string): string | null {
    const numbers = this.pageNumbers.get(documentId);
    if (numbers === undefined || numbers.length === 0) return null;
    const first = Math.min(...numbers);
    const last = Math.max(...numbers);
    return first === last ? String(first) : `${String(first)}–${String(last)}`;
  }
}

function statusOfSeverity(finding: FindingView): ReportRowStatus & ReportItemStatus {
  if (finding.state === 'undetermined') return 'undetermined';
  return finding.severity === 'error' ? 'error' : 'warning';
}

function withRest(text: string, own: readonly FindingView[], status: ReportRowStatus): string {
  const rest = own.filter((finding) => statusOfSeverity(finding) === status).length - 1;
  return rest <= 0 ? text : `${text} (и ещё ${String(rest)})`;
}

/** Причина, по которой правило не исполнялось, — словами, а не кодом движка. */
function skipReason(reason: string): string {
  switch (reason) {
    case 'absent_from_snapshot':
      return 'правила нет в опубликованном наборе';
    case 'disabled_in_snapshot':
      return 'правило выключено в наборе';
    case 'not_in_profile':
      return 'правило не входит в профиль раздела';
    default:
      return reason;
  }
}

function asExecutions(
  value: unknown,
): readonly { ruleCode: string; verdict: string; reason: string | null }[] {
  return Array.isArray(value)
    ? (value as { ruleCode: string; verdict: string; reason: string | null }[])
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
