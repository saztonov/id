/**
 * Генерирует обезличенный эталон корпуса в `tools/fixtures/corpus/`.
 *
 * Запускается командой `pnpm corpus:generate` и требует закрытого корпуса на
 * машине (`GOLDEN_CORPUS_DIR`, по умолчанию `temp/MD`). Результат коммитится:
 * эталон обязан быть доступен там, где закрытого корпуса нет, иначе метрики
 * §16 нельзя посчитать ни в CI, ни на чужой машине.
 *
 * Барьер: если в результате нашлась хоть одна претензия `auditCorpusPii`,
 * файлы НЕ пишутся и процесс завершается ошибкой. Это не перестраховка — на S1
 * настоящие ФИО и отпечатки сертификатов ЭП уже попадали в репозиторий
 * (`docs/EXECUTION_LOG.md`, пункт 6), и удержала это не вычитка, а барьер.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PACKAGE_SPECS,
  REFERENCE_CORPUS_DIR,
  anonymizePackage,
  auditByPiiScanner,
  auditCorpusPii,
  buildReferencePackage,
  collectPackageMarkers,
  parseSourcePackage,
  referenceFileName,
  resolveGoldenCorpusDir,
  serializeReferencePackage,
  type SourcePage,
} from './corpus-reference.js';

async function main(): Promise<void> {
  const goldenDir = resolveGoldenCorpusDir();
  if (goldenDir === null) {
    console.warn(
      'GOLDEN_CORPUS_DIR не найден: закрытого корпуса на машине нет.\n' +
        'Эталон в tools/fixtures/corpus/ оставлен без изменений — он и рассчитан на то,\n' +
        'чтобы работать без закрытых файлов. Чтобы перегенерировать, укажите путь\n' +
        'к каталогу с комплектами: GOLDEN_CORPUS_DIR=<путь> pnpm corpus:generate',
    );
    return;
  }

  const sources = readSources(goldenDir);
  console.log(`Закрытый корпус: ${goldenDir} (комплектов: ${sources.size})`);

  mkdirSync(REFERENCE_CORPUS_DIR, { recursive: true });

  let changed = 0;
  for (const spec of PACKAGE_SPECS) {
    const pages = sources.get(spec.pageCount);
    if (pages === undefined) {
      throw new Error(
        `Комплект на ${spec.pageCount} страниц (${spec.packageKey}) в ${goldenDir} не найден: ` +
          `есть комплекты на ${[...sources.keys()].sort((a, b) => a - b).join(', ')} страниц`,
      );
    }

    // Маркеры — значения, которые обезличиватель нашёл и заменил в ЭТОМ
    // комплекте закрытого корпуса. Раньше их давал `pii-scan.mjs`, и ради
    // этого страж ПДн хранил настоящие фамилии открытым текстом; теперь
    // источник значений один — закрытый корпус, а сканер даёт только вердикт.
    const source = pages.map((page) => page.text);
    const markers = collectPackageMarkers(source);
    const anonymized = anonymizePackage(source);
    const problems = (
      await Promise.all(
        anonymized.map(async (text, index) =>
          [...auditCorpusPii(text, markers), ...(await auditByPiiScanner(text))].map(
            (problem) => `стр. ${index + 1}: ${problem}`,
          ),
        ),
      )
    ).flat();
    if (problems.length > 0) {
      console.error(`\n${spec.packageKey}: в обезличенном тексте остались персональные данные:`);
      for (const problem of problems.slice(0, 40)) console.error(`  ${problem}`);
      if (problems.length > 40) console.error(`  …и ещё ${problems.length - 40}`);
      throw new Error(
        'Эталон не записан: производный набор с ПДн в репозиторий не попадает (§1.4)',
      );
    }

    const pkg = buildReferencePackage(spec, pages, anonymized);
    const path = join(REFERENCE_CORPUS_DIR, referenceFileName(spec.packageKey));
    const next = serializeReferencePackage(pkg);
    const previous = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (previous !== next) {
      writeFileSync(path, next, 'utf8');
      changed += 1;
    }
    const documents = new Set(
      pkg.pages.map((page) => page.expected.documentKey).filter((key) => key !== null),
    );
    console.log(
      `  ${spec.packageKey.padEnd(10)} страниц ${String(pkg.pages.length).padStart(3)}, ` +
        `документов ${String(documents.size).padStart(2)}, ` +
        `строк реестра ${pkg.expectedRegistryRowCount ?? '—'}`,
    );
  }

  console.log(`Готово. Изменено файлов: ${changed}.`);
}

/**
 * Читает все комплекты и раскладывает их по числу страниц.
 *
 * Именно по числу страниц спецификация находит свой комплект: имена папок
 * содержат номер акта и шифр раздела, то есть идентифицируют объект, и в
 * репозиторий им нельзя (§1.4). Совпадение числа страниц у двух комплектов
 * сделало бы привязку неоднозначной, поэтому оно считается ошибкой, а не
 * поводом выбрать первый попавшийся.
 */
function readSources(goldenDir: string): ReadonlyMap<number, readonly SourcePage[]> {
  const sources = new Map<number, readonly SourcePage[]>();
  for (const entry of readdirSync(goldenDir)) {
    const dir = join(goldenDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir);
    if (!files.some((f) => f.endsWith('_results.md'))) continue;
    const pages = parseSourcePackage(dir);
    if (sources.has(pages.length)) {
      throw new Error(
        `В ${goldenDir} два комплекта по ${pages.length} страниц: привязка спецификации неоднозначна`,
      );
    }
    sources.set(pages.length, pages);
  }
  if (sources.size === 0) throw new Error(`В ${goldenDir} нет ни одного комплекта с *_results.md`);
  return sources;
}

main().catch((err: unknown) => {
  console.error('Генерация эталона провалена:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
