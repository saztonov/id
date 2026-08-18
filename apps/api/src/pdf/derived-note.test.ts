/**
 * Отметка о производности: шаблон для qpdf и проверка готового файла (§13).
 *
 * ## Что здесь считается доказательством
 *
 * Не «функция вернула байты», а то, что НАСТОЯЩАЯ библиотека читает наш
 * рукописный PDF и видит в нём ровно ту отметку, которую мы записали. Разбор
 * чужим кодом — единственная форма проверки, при которой ошибка в собственном
 * писателе не подтверждает сама себя.
 *
 * Вторая половина набора — чувствительность `verifyDerivedNote`: проверка,
 * которая отвечает «да» на что угодно, хуже отсутствующей, потому что делает
 * поле `derived_note_applied` бессмысленным при зелёных тестах.
 *
 * `pdf-lib` резолвится вручную — он объявлен зависимостью воркспейса воркера
 * (см. `pdf-lib.test.ts`). Если библиотека не найдена, набор пропускается с
 * явной причиной, а не зеленеет молча.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDerivedNotePdf, pdfTextString, verifyDerivedNote } from './derived-note.js';
import { probePdf } from './probe.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PDF_LIB_HOSTS = ['apps/worker', 'tools/fixtures'];

function resolvePdfLib(): string | null {
  for (const host of PDF_LIB_HOSTS) {
    try {
      const require = createRequire(pathToFileURL(join(REPO_ROOT, host, 'package.json')).href);
      return require.resolve('pdf-lib');
    } catch {
      continue;
    }
  }
  return null;
}

const PDF_LIB_PATH = resolvePdfLib();

interface InfoReader {
  readonly PDFDocument: {
    load(
      bytes: Uint8Array,
      options: { updateMetadata: boolean },
    ): Promise<{
      getPageCount(): number;
      getProducer(): string | undefined;
      getCreator(): string | undefined;
      getSubject(): string | undefined;
      getKeywords(): string | undefined;
    }>;
  };
}

const NOTE = 'Портал ИД: производная копия документа. Подпись оригинала к копии не относится.';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'id-derived-note-'));
});

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

describe('шаблон отметки о производности', () => {
  it('структурно разбирается: xref, каталог и дерево страниц найдены', () => {
    const probe = probePdf(buildDerivedNotePdf(NOTE));
    // Наш разбор доходит до дерева страниц и отвергает документ ровно потому,
    // что страниц в нём ноль, — то есть заголовок, таблица перекрёстных ссылок,
    // каталог и дерево страниц прочитаны. Ноль страниц здесь и требуется: это
    // то же, что даёт `qpdf --empty`, и лишним листам взяться неоткуда.
    expect(probe.ok).toBe(false);
    expect(probe.ok === false ? probe.reason : null).toBe('unparsable');
    expect(probe.ok === false ? probe.detail : '').toContain('ни одной страницы');
  });

  it.skipIf(PDF_LIB_PATH === null)(
    'читается настоящей pdf-lib со всеми полями отметки',
    async () => {
      const loaded = (await import(pathToFileURL(PDF_LIB_PATH as string).href)) as {
        PDFDocument?: InfoReader['PDFDocument'];
        default?: InfoReader;
      };
      const pdfLib: InfoReader =
        loaded.PDFDocument !== undefined
          ? { PDFDocument: loaded.PDFDocument }
          : (loaded.default as InfoReader);

      const document = await pdfLib.PDFDocument.load(buildDerivedNotePdf(NOTE), {
        updateMetadata: false,
      });

      expect(document.getPageCount()).toBe(0);
      expect(document.getProducer()).toBe(NOTE);
      expect(document.getCreator()).toBe(NOTE);
      expect(document.getSubject()).toBe(NOTE);
      expect(document.getKeywords()).toBe(NOTE);
    },
  );

  it('кодирует кириллицу как UTF-16BE с BOM', () => {
    // Без BOM читатель разберёт строку как PDFDocEncoding, то есть покажет
    // мусор вместо отметки. Проверяется именно префикс.
    expect(pdfTextString('А')).toBe('<FEFF0410>');
  });
});

describe('проверка отметки в готовом файле', () => {
  it('находит отметку и не находит другую', async () => {
    const path = join(workDir, 'template.pdf');
    await writeFile(path, buildDerivedNotePdf(NOTE));

    await expect(verifyDerivedNote(path, NOTE)).resolves.toBe(true);
    // Чувствительность: другой текст обязан дать «нет». Иначе `true` означало
    // бы лишь «файл существует».
    await expect(verifyDerivedNote(path, 'Совсем другая отметка о чём-то ещё')).resolves.toBe(
      false,
    );
  });

  it('находит отметку, лежащую на границе читаемых кусков', async () => {
    const path = join(workDir, 'padded.pdf');
    const template = buildDerivedNotePdf(NOTE);
    // Мегабайт мусора перед документом сдвигает отметку так, что она заведомо
    // не помещается в один кусок чтения: перекрытие между кусками обязано
    // работать, иначе проверка молча начнёт отвечать «нет» на больших файлах.
    await writeFile(path, Buffer.concat([Buffer.alloc(1 << 20, 0x20), template]));
    await expect(verifyDerivedNote(path, NOTE)).resolves.toBe(true);
  });

  it('латинская отметка ищется и в литеральной форме', async () => {
    const path = join(workDir, 'latin.txt');
    await writeFile(path, Buffer.from('/Producer (Portal derived copy)', 'latin1'));
    await expect(verifyDerivedNote(path, 'Portal derived copy')).resolves.toBe(true);
  });
});
