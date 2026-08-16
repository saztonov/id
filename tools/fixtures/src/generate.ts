/**
 * Записывает синтетические PDF-фикстуры в `tools/fixtures/pdf/`.
 *
 * Запускается командой `pnpm fixtures:generate`. Результат коммитится:
 * фикстуры должны быть доступны в CI без закрытого корпуса. Генерация
 * детерминирована, поэтому повторный запуск не создаёт diff.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FIXTURES, malformedPdf, notAPdf, signedPdf } from './synthetic.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pdf');

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const files: Array<[string, Uint8Array]> = [
    ['multipage.pdf', await FIXTURES.multipage()],
    ['rotated.pdf', await FIXTURES.rotated()],
    ['split-part1.pdf', await FIXTURES.splitPart1()],
    ['split-part2.pdf', await FIXTURES.splitPart2()],
    ['unknown-type.pdf', await FIXTURES.unknownType()],
    ['single-1.pdf', await FIXTURES.singlePage(1)],
    ['single-2.pdf', await FIXTURES.singlePage(2)],
    ['single-3.pdf', await FIXTURES.singlePage(3)],
    ['signed.pdf', await signedPdf()],
    ['malformed.pdf', malformedPdf()],
    ['not-a-pdf.pdf', notAPdf()],
  ];

  let changed = 0;
  const manifest: Record<string, string> = {};

  for (const [name, bytes] of files) {
    const path = join(OUT_DIR, name);
    const sha = createHash('sha256').update(bytes).digest('hex');
    manifest[name] = sha;

    const prev = existsSync(path) ? readFileSync(path) : null;
    if (!prev || !prev.equals(Buffer.from(bytes))) {
      writeFileSync(path, bytes);
      changed++;
    }
    console.log(
      `  ${name.padEnd(20)} ${bytes.length.toString().padStart(7)} байт  ${sha.slice(0, 16)}`,
    );
  }

  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Готово. Изменено файлов: ${changed}.`);
}

main().catch((err: unknown) => {
  console.error('Генерация провалена:', err);
  process.exitCode = 1;
});
