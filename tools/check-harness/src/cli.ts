/**
 * CLI офлайн-прогона проверок: `pnpm harness:run [--dir …] [--out …]`.
 *
 * Пути разрешаются от корня репозитория, а не от cwd: pnpm запускает скрипт
 * из `tools/check-harness`, и относительный `temp/MD/new` иначе указывал бы
 * внутрь пакета.
 *
 * `--today` фиксирует дату графа для воспроизводимого повтора; по умолчанию —
 * текущая дата (и она печатается, чтобы прогоны были сравнимы осознанно).
 */
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { listPackageDirs } from './discover.js';
import { runPackage, type PackageRunResult } from './pipeline.js';
import { REPO_ROOT, writePackageReport, writeSummary } from './report.js';

function fromRepoRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

function slugOf(name: string, index: number): string {
  const cleaned = name
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
    .replaceAll(/_{2,}/gu, '_')
    .slice(0, 60);
  return `${String(index + 1).padStart(2, '0')}-${cleaned}`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: 'temp/MD/new' },
      out: { type: 'string', default: 'temp/reports' },
      today: { type: 'string' },
      unconfigured: { type: 'boolean', default: false },
    },
  });

  const root = fromRepoRoot(values.dir);
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  const runId = `run-${new Date().toISOString().replaceAll(/[:.]/gu, '-').slice(0, 19)}`;
  const outDir = join(fromRepoRoot(values.out), runId);

  const packageDirs = listPackageDirs(root);
  if (packageDirs.length === 0) {
    console.error(`В ${root} не найдено ни одного пакета (*_results.md + *_blocks.json).`);
    process.exitCode = 1;
    return;
  }

  console.log(`Пакетов: ${packageDirs.length}; today=${today}; отчёты: ${outDir}`);

  const results: PackageRunResult[] = [];
  for (const [index, dir] of packageDirs.entries()) {
    const started = Date.now();
    try {
      const result = runPackage(dir, { today, unconfiguredProfile: values.unconfigured });
      results.push(result);
      writePackageReport(join(outDir, slugOf(result.packageName, index)), result);
      console.log(
        `[${index + 1}/${packageDirs.length}] ${result.packageName}: ` +
          `${result.pages.length} стр., ${result.segmentation.documents.length} док., ` +
          `fail ${result.rules.counts.failed}, undetermined ${result.rules.counts.undetermined} ` +
          `(${Date.now() - started} мс)`,
      );
    } catch (error) {
      console.error(`[${index + 1}/${packageDirs.length}] ${dir}: ОШИБКА — ${String(error)}`);
      process.exitCode = 1;
    }
  }

  if (results.length > 0) {
    writeSummary(outDir, results);
    console.log(`Сводка: ${join(outDir, 'summary.md')}`);
  }
}

main();
