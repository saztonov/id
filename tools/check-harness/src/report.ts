/**
 * Отчёты прогона: `report.md` + `report.json` на пакет и сводный `summary.md`.
 *
 * ## Почему запись разрешена только под `<repo>/temp/`
 *
 * Отчёт дословно цитирует реальные документы (§1.4 — это персональные данные).
 * `temp/` игнорируется git'ом, и это единственное место, где таким данным
 * можно лежать. Guard fail-closed: путь вне `temp/` — ошибка, а не молчаливое
 * согласие, тот же принцип, что у corpus-генератора в `@id/fixtures`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';

import { DOC_TYPES, fieldsForType } from '@id/doc-types';
import type { PreparedFinding, RuleExecution } from '@id/rules';

import type { PackageRunResult } from './pipeline.js';

/** tools/check-harness/src → корень репозитория. В dist глубина та же. */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export function assertUnderTemp(outDir: string): string {
  const tempRoot = resolve(REPO_ROOT, 'temp');
  const resolved = resolve(outDir);
  if (resolved !== tempRoot && !resolved.startsWith(tempRoot + sep)) {
    throw new Error(
      `Отчёты содержат реальные данные и пишутся только под ${tempRoot}; получено: ${resolved}`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Markdown-помощники
// ---------------------------------------------------------------------------

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function clip(value: string | null | undefined, max = 80): string {
  if (value === null || value === undefined) return '—';
  const oneLine = value.replaceAll('\n', ' ');
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Отчёт по пакету
// ---------------------------------------------------------------------------

function segmentationSection(result: PackageRunResult): string {
  const { segmentation, classifications, pages } = result;
  const uCount = classifications.filter((c) => c.label === 'U').length;
  const uncertain = classifications.filter((c) => c.typeOutcome === 'uncertain').length;
  const fallback = segmentation.documents.filter(
    (d) => result.graph.documents.find((g) => g.id === `doc-${d.ordinal}`)?.isFallbackType,
  ).length;

  const pageRows = classifications.map((c) => {
    const docOf = segmentation.documents.find((d) =>
      d.pages.some((p) => p.sourcePageId === c.sourcePageId),
    );
    return [
      cell(c.sourcePageId),
      cell(c.label),
      cell(c.source),
      cell(c.confidence.toFixed(2)),
      cell(c.docTypeCode),
      cell(c.typeOutcome),
      cell(c.pageRoleCode),
      cell(docOf === undefined ? '—' : `doc-${docOf.ordinal}`),
      cell(clip(c.reason, 60)),
    ];
  });

  const documentRows = segmentation.documents.map((d) => {
    const node = result.graph.documents.find((g) => g.id === `doc-${d.ordinal}`);
    return [
      cell(`doc-${d.ordinal}`),
      cell(d.docTypeCode),
      cell(node?.isKnownType === true ? 'да' : 'нет'),
      cell(d.typeConfidence === null ? '—' : d.typeConfidence.toFixed(2)),
      cell(d.boundaryConfidence === null ? '—' : d.boundaryConfidence.toFixed(2)),
      cell(d.needsReview ? 'да' : 'нет'),
      cell(d.pages.map((p) => p.sourcePageId).join(', ')),
      cell(clip(d.observedTitle ?? d.title, 50)),
    ];
  });

  const unassignedRows = segmentation.unassigned.map((u) => [
    cell(u.sourcePageId),
    cell(clip(u.reason, 100)),
  ]);

  return [
    '## 1. Сегментация',
    '',
    `Страниц: ${pages.length}; документов: ${segmentation.documents.length}; ` +
      `непривязанных: ${segmentation.unassigned.length}; ` +
      `меток U: ${uCount}; тип uncertain: ${uncertain}; резервных типов: ${fallback}; ` +
      `страниц, ожидающих LLM-фазу (здесь не выполняется): ${result.llmPending}.`,
    '',
    '### Страницы',
    '',
    table(
      ['стр.', 'label', 'источник', 'ув.', 'тип', 'исход', 'роль', 'документ', 'причина'],
      pageRows,
    ),
    '',
    '### Документы',
    '',
    table(
      ['id', 'тип', 'известный', 'ув. типа', 'ув. границ', 'review', 'страницы', 'заголовок'],
      documentRows,
    ),
    '',
    '### Непривязанные страницы',
    '',
    unassignedRows.length === 0 ? 'Нет.' : table(['стр.', 'причина'], unassignedRows),
  ].join('\n');
}

function fieldsSection(result: PackageRunResult): string {
  const parts: string[] = ['## 2. Реквизиты', ''];

  for (const document of result.graph.documents) {
    const extracted = result.fieldsByDocument.get(document.id) ?? [];
    parts.push(`### ${document.id} (${document.docTypeCode ?? 'тип не присвоен'})`, '');
    if (extracted.length === 0) {
      parts.push('Полей не извлечено.', '');
    } else {
      parts.push(
        table(
          ['код', 'значение', 'ув.', 'кем', 'цитата'],
          extracted.map((field) => [
            cell(field.fieldCode),
            cell(clip(field.valueText ?? field.valueDate ?? field.valueNum, 60)),
            cell(field.confidence.toFixed(2)),
            cell(field.extractedBy),
            cell(clip(field.evidence?.quote ?? null, 80)),
          ]),
        ),
        '',
      );
    }

    // Пустые rule-поля схемы вида: что извлечение должно было дать, но не дало.
    const spec = DOC_TYPES.find((type) => type.code === document.docTypeCode);
    if (spec !== undefined && result.typeConfidentByDocument.get(document.id) === true) {
      const expected = fieldsForType(spec.fieldSchema, spec.kind).filter(
        (field) => field.extractor === 'rule',
      );
      const got = new Set(extracted.map((field) => field.fieldCode));
      const missing = expected.filter((field) => !got.has(field.code));
      if (missing.length > 0) {
        parts.push(`Пустые rule-поля схемы: ${missing.map((field) => field.code).join(', ')}.`, '');
      }
    }
  }

  return parts.join('\n');
}

function registriesSection(result: PackageRunResult): string {
  if (result.registries.length === 0) {
    return '## 3. Реестры приложений\n\nРеестров в пакете не распознано.';
  }
  const parts: string[] = ['## 3. Реестры приложений', ''];
  for (const registry of result.registries) {
    const { parsed, match } = registry;
    const matched = match.rows.filter((row) => row.matchState === 'matched').length;
    const missing = match.rows.filter((row) => row.matchState === 'missing').length;
    const ambiguous = match.rows.filter((row) => row.matchState === 'ambiguous').length;
    parts.push(
      `### ${registry.documentId}`,
      '',
      `Строк: ${parsed.rows.length}; сверка: matched ${matched}, missing ${missing}, ` +
        `ambiguous ${ambiguous}; лишних документов (extra): ${match.extraDocumentIds.length}.`,
      '',
      table(
        ['№', 'раздел', 'наименование', 'номер', 'даты', 'сверка', 'документ'],
        parsed.rows.map((row, index) => {
          const decision = match.rows[index];
          const dates = [row.issuedAt, row.validFrom, row.validTo].filter((d) => d !== null);
          return [
            cell(row.rowNo),
            cell(clip(row.sectionTitle, 40)),
            cell(clip(row.docNameRaw, 60)),
            cell(row.docNoRaw),
            cell(dates.length === 0 ? '—' : dates.join(' / ')),
            cell(decision?.matchState ?? '—'),
            cell(decision?.matchedDocumentId ?? '—'),
          ];
        }),
      ),
      '',
    );
    if (parsed.warnings.length > 0) {
      parts.push('Предупреждения разбора:', '', ...parsed.warnings.map((w) => `- ${w}`), '');
    }
    if (match.extraDocumentIds.length > 0) {
      parts.push(`Документы вне реестра: ${match.extraDocumentIds.join(', ')}.`, '');
    }
  }
  return parts.join('\n');
}

function findingLine(finding: PreparedFinding): string {
  const target =
    finding.targetId === null ? finding.targetType : `${finding.targetType} ${finding.targetId}`;
  const hint = finding.hint == null ? '' : ` Подсказка: ${finding.hint}`;
  return `- **${finding.ruleCode}** [${finding.severity}${finding.isBlocking ? ', blocking' : ''}] (${target}): ${finding.message}${hint}`;
}

function rulesSection(result: PackageRunResult): string {
  const { rules } = result;
  const byVerdict = (verdict: RuleExecution['verdict']): readonly RuleExecution[] =>
    rules.executions.filter((execution) => execution.verdict === verdict);

  const offlineNoise = rules.findings.filter(
    (finding) => finding.origin === 'external_unavailable',
  );
  const open = rules.findings.filter(
    (finding) => finding.state === 'open' && finding.origin !== 'external_unavailable',
  );
  const undetermined = rules.findings.filter(
    (finding) => finding.state === 'undetermined' && finding.origin !== 'external_unavailable',
  );

  const parts: string[] = [
    '## 4. Правила',
    '',
    `Всего правил: ${rules.counts.rulesTotal}; исполнено: ${rules.counts.executed}; ` +
      `pass: ${rules.counts.passed}; fail: ${rules.counts.failed}; ` +
      `undetermined: ${rules.counts.undetermined}; n/a: ${rules.counts.notApplicable}; ` +
      `пропущено: ${rules.counts.skipped}. Замечаний: ${rules.counts.findings} ` +
      `(error ${rules.counts.errors} / warning ${rules.counts.warnings} / info ${rules.counts.infos}), ` +
      `блокирующих: ${rules.counts.blocking}, внешние реестры недоступны: ${rules.counts.externalUnavailable}.`,
    '',
    '### Открытые замечания (open)',
    '',
    ...(open.length === 0 ? ['Нет.'] : open.map(findingLine)),
    '',
    '### Неопределённые (undetermined)',
    '',
    ...(undetermined.length === 0 ? ['Нет.'] : undetermined.map(findingLine)),
    '',
    '### Ожидаемый офлайн-шум',
    '',
    'В офлайн-графе нет контрагентов, шифров РД и внешних реестров, а LLM-извлечение',
    'выключено — поэтому замечания о незаполненных LLM-реквизитах (наименования сторон',
    'акта, объект, изготовитель — AOSR.HDR.010/020 и родственные) и вердикты ниже',
    'предсказуемы для харнеса и находками по документам НЕ являются.',
    '',
    ...(offlineNoise.length === 0 ? ['Нет.'] : offlineNoise.map(findingLine)),
    '',
    '### Журнал исполнения',
    '',
    table(
      ['правило', 'вердикт', 'находок', 'причина n/a'],
      rules.executions.map((execution) => [
        cell(execution.ruleCode),
        cell(execution.verdict),
        cell(execution.findingCount),
        cell(clip(execution.reason, 90)),
      ]),
    ),
  ];

  const skippedEntries = Object.entries(rules.skipped);
  if (skippedEntries.length > 0) {
    parts.push(
      '',
      '### Пропущенные правила',
      '',
      ...skippedEntries.map(([code, reason]) => `- ${code}: ${reason}`),
    );
  }

  const failed = byVerdict('fail');
  if (failed.length > 0) {
    parts.push('', `Правила с вердиктом fail: ${failed.map((e) => e.ruleCode).join(', ')}.`);
  }

  return parts.join('\n');
}

function anomaliesSection(result: PackageRunResult): string {
  return [
    '## 5. Аномалии разбора',
    '',
    ...(result.anomalies.length === 0 ? ['Не замечено.'] : result.anomalies.map((a) => `- ${a}`)),
  ].join('\n');
}

export function renderPackageReport(result: PackageRunResult): string {
  return [
    `# Пакет: ${result.packageName}`,
    '',
    `Каталог: ${result.packageDir}`,
    '',
    `Дата графа (today): ${result.options.today}; профиль раздела: ` +
      `${result.options.unconfiguredProfile ? 'НЕ настроен (строка 2 матрицы §9.1)' : 'настроен (умолчания харнеса)'}; ` +
      'LLM-фаза сегментации: выключена.',
    '',
    segmentationSection(result),
    '',
    fieldsSection(result),
    '',
    registriesSection(result),
    '',
    rulesSection(result),
    '',
    anomaliesSection(result),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Сериализация в JSON
// ---------------------------------------------------------------------------

function toSerializable(result: PackageRunResult): unknown {
  return {
    packageDir: result.packageDir,
    packageName: result.packageName,
    options: result.options,
    llmPending: result.llmPending,
    classifications: result.classifications,
    segmentation: result.segmentation,
    typeConfidentByDocument: Object.fromEntries(result.typeConfidentByDocument),
    fieldsByDocument: Object.fromEntries(result.fieldsByDocument),
    registries: result.registries,
    graph: {
      documents: result.graph.documents,
      registryRows: result.graph.registryRows,
      relations: result.graph.relations,
      materials: result.graph.materials,
      today: result.graph.today,
    },
    rules: result.rules,
    anomalies: result.anomalies,
  };
}

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

export function writePackageReport(outDir: string, result: PackageRunResult): void {
  const target = assertUnderTemp(outDir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'report.md'), renderPackageReport(result), 'utf8');
  writeFileSync(
    join(target, 'report.json'),
    JSON.stringify(toSerializable(result), null, 2),
    'utf8',
  );
}

export function renderSummary(results: readonly PackageRunResult[]): string {
  const rows = results.map((result) => {
    const known = result.graph.documents.filter((document) => document.isKnownType).length;
    const registryRowCount = result.graph.registryRows.length;
    const open = result.rules.findings.filter(
      (finding) => finding.state === 'open' && finding.origin !== 'external_unavailable',
    ).length;
    return [
      cell(result.packageName),
      cell(result.pages.length),
      cell(result.graph.documents.length),
      cell(`${known}/${result.graph.documents.length}`),
      cell(result.segmentation.unassigned.length),
      cell(result.llmPending),
      cell(registryRowCount),
      cell(result.rules.counts.failed),
      cell(result.rules.counts.undetermined),
      cell(open),
    ];
  });
  return [
    '# Сводка прогона',
    '',
    table(
      [
        'пакет',
        'стр.',
        'док.',
        'известных',
        'непривяз.',
        'LLM-ожид.',
        'строк реестров',
        'fail',
        'undet.',
        'открытых замечаний',
      ],
      rows,
    ),
    '',
  ].join('\n');
}

export function writeSummary(outDir: string, results: readonly PackageRunResult[]): void {
  const target = assertUnderTemp(outDir);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'summary.md'), renderSummary(results), 'utf8');
}
