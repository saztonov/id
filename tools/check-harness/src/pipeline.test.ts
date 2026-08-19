/**
 * Смоук сквозного офлайн-прогона на СИНТЕТИЧЕСКОМ пакете.
 *
 * Значения выдуманы (§1.4): реальные тексты корпуса живут только в `temp/` и в
 * тесты не попадают. Проверяются инварианты конвейера, а не конкретные тексты:
 * гейт §1.6 (каждая страница ровно один раз), доказательства полей, полнота
 * журнала исполнения правил и PII-guard записи отчётов.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { RULE_CATALOG } from '@id/rules';

import { runPackage } from './pipeline.js';
import { assertUnderTemp, renderPackageReport, writePackageReport } from './report.js';

const MD = `# Document: synthetic.pdf

Path: Синтетика / synthetic.pdf

Generated: 2026-08-18 00:00:00 UTC

---

## Page 1

### BLOCK #1 [TEXT]: blk_00000000000000000000000000000001

> **Created:** 2026-08-18 00:00:00 UTC
> **Crop:** [Crop](https://example.invalid/api/crops/1)

##### АКТ

###### освидетельствования скрытых работ

№ 7-СИН от 15.03.2026

К освидетельствованию предъявлены следующие работы: устройство синтетического
основания из вымышленного материала МАРКА-100.

Разрешается производство последующих работ по устройству следующего слоя.

## Page 2

### BLOCK #1 [TEXT]: blk_00000000000000000000000000000002

> **Created:** 2026-08-18 00:00:00 UTC
> **Crop:** [Crop](https://example.invalid/api/crops/2)

##### Реестр приложений №1 к акту № 7-СИН

**Документы, подтверждающие качество применяемых материалов**

| № п/п | Наименование документа | № документа | Дата документа | Кол-во листов |
| --- | --- | --- | --- | --- |
| 1 | Паспорт качества | 42-СИН | 01.02.2026 | 2 |
`;

const BLOCKS = JSON.stringify({
  schema_version: 1,
  document_id: 'doc_synthetic',
  document_name: 'synthetic.pdf',
  document_path: 'Синтетика / synthetic.pdf',
  generated_at: '2026-08-18T00:00:00Z',
  coordinate_space: 'normalized_page_top_left',
  pages: [
    { page_index: 0, width_px: 2480, height_px: 3507, rotation: 0 },
    { page_index: 1, width_px: 2480, height_px: 3507, rotation: 0 },
  ],
  blocks: [
    { page_index: 0, ordinal: 1, block_type: 'text' },
    { page_index: 1, ordinal: 1, block_type: 'text' },
  ],
});

const dir = mkdtempSync(join(tmpdir(), 'check-harness-'));
writeFileSync(join(dir, 'synthetic_results.md'), MD, 'utf8');
writeFileSync(join(dir, 'synthetic_blocks.json'), BLOCKS, 'utf8');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runPackage', () => {
  const result = runPackage(dir, { today: '2026-08-19', unconfiguredProfile: false });

  it('каждая страница входа встречается ровно один раз (§1.6)', () => {
    const seen = new Map<string, number>();
    for (const document of result.segmentation.documents) {
      for (const page of document.pages) {
        seen.set(page.sourcePageId, (seen.get(page.sourcePageId) ?? 0) + 1);
      }
    }
    for (const page of result.segmentation.unassigned) {
      seen.set(page.sourcePageId, (seen.get(page.sourcePageId) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual(result.pages.map((p) => p.sourcePageId).sort());
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  });

  it('акт и реестр распознаны, реестр разобран и сверен', () => {
    const codes = result.graph.documents.map((document) => document.docTypeCode);
    expect(codes).toContain('aosr');
    expect(codes).toContain('annex_registry');

    expect(result.registries).toHaveLength(1);
    const registry = result.registries[0];
    expect(registry?.parsed.rows).toHaveLength(1);
    expect(registry?.parsed.rows[0]?.docNoRaw).toBe('42-СИН');
    expect(result.graph.registryRows).toHaveLength(1);
  });

  it('каждое доказательство поля — точный спан текста своей страницы', () => {
    const textOfPtv = new Map(
      result.pages.map((page) => [page.pageTextVersionId, page.text] as const),
    );
    let withEvidence = 0;
    for (const fields of result.fieldsByDocument.values()) {
      for (const field of fields) {
        if (field.evidence === null) continue;
        withEvidence += 1;
        const text = textOfPtv.get(field.evidence.pageTextVersionId);
        expect(text).toBeDefined();
        expect(text?.slice(field.evidence.charStart, field.evidence.charEnd)).toBe(
          field.evidence.quote,
        );
      }
    }
    expect(withEvidence).toBeGreaterThan(0);
  });

  it('журнал исполнения покрывает весь каталог правил', () => {
    expect(result.rules.counts.rulesTotal).toBe(RULE_CATALOG.length);
    const journal = result.rules.executions.length + Object.keys(result.rules.skipped).length;
    expect(journal).toBe(RULE_CATALOG.length);
    expect(result.rules.executions.length).toBeGreaterThan(0);
  });

  it('отчёт рендерится со всеми секциями', () => {
    const report = renderPackageReport(result);
    for (const heading of [
      '## 1. Сегментация',
      '## 2. Реквизиты',
      '## 3. Реестры приложений',
      '## 4. Правила',
      '## 5. Аномалии разбора',
    ]) {
      expect(report).toContain(heading);
    }
  });

  it('запись отчёта вне temp/ отклоняется (PII-guard)', () => {
    expect(() => assertUnderTemp(dir)).toThrow(/temp/u);
    expect(() => writePackageReport(join(dir, 'out'), result)).toThrow(/temp/u);
  });
});
