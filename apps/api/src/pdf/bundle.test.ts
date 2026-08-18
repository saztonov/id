/**
 * Рабочий документ ревизии: сборка, карта страниц и хэш манифеста (§3.3, §12).
 *
 * Проверяется цепочка целиком на настоящих байтах: состав файлов → карта
 * страниц → собранный PDF → `aggregate_manifest_hash`. Файлы — синтетические
 * фикстуры S0, библиотека — настоящий `pdf-lib` (ADR-0003), хэш — та самая
 * функция, которой пользуется репозиторий, а не её копия в тесте.
 *
 * ## Почему карта сверяется с содержимым страниц, а не сама с собой
 *
 * `buildWorkingPdf()` возвращает карту, построенную `planWorkingPdf()` из
 * состава. Сверять её с тем же `planWorkingPdf()` бессмысленно: совпадение
 * гарантировано определением, и такой тест остался бы зелёным, даже если бы
 * сборщик перепутал файлы местами или потерял страницу. Поэтому каждая строка
 * карты проверяется по СОДЕРЖИМОМУ: текст страницы N рабочего документа обязан
 * совпасть с текстом страницы `filePageIndex` файла `sourceFileId`, а её
 * геометрия — с геометрией той же страницы оригинала (от неё зависят координаты
 * разметки, §7.1). Отсюда `pageTexts()` ниже: он вытаскивает текст каждой
 * страницы из потока содержимого, потому что в PDF текст лежит сжатым и
 * подстрокой в байтах не ищется (урок S0).
 *
 * ## Что здесь НЕ проверяется
 *
 * Запись bundle и его карты в БД, область видимости и идемпотентность — в
 * `db/repositories/bundles.test.ts`; поведение задачи `bundle.build` — в
 * `apps/worker/src/jobs/pipeline.test.ts`. Здесь только то, что относится к
 * самим PDF и к хэшу состава.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeAggregateManifestHash, type ManifestFile } from '../db/repositories/bundles.js';
import { asPdfLibModule, createPdfLibToolkit, type PdfLibModule } from './pdf-lib.js';
import { probePdf, sha256Hex } from './probe.js';
import type { PdfToolkit, WorkingPageMapping, WorkingPdfPart } from './toolkit.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURES_DIR = join(REPO_ROOT, 'tools', 'fixtures', 'pdf');

/** Воркспейсы, объявившие pdf-lib: в `apps/api` его нет (см. `pdf-lib.ts`). */
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

// =====================================================================
// Состав комплекта
// =====================================================================

interface Fixture {
  readonly name: string;
  readonly pageCount: number;
}

const MULTIPAGE: Fixture = { name: 'multipage', pageCount: 4 };
const SINGLE_1: Fixture = { name: 'single-1', pageCount: 1 };
const SINGLE_2: Fixture = { name: 'single-2', pageCount: 1 };
const SINGLE_3: Fixture = { name: 'single-3', pageCount: 1 };
const ROTATED: Fixture = { name: 'rotated', pageCount: 4 };

/** Состав §3.3: рабочий документ собирается из ВСЕХ файлов ревизии. */
const COMPOSITION: readonly Fixture[] = [MULTIPAGE, SINGLE_1, SINGLE_2, SINGLE_3];

function fixturePath(fixture: Fixture): string {
  return join(FIXTURES_DIR, `${fixture.name}.pdf`);
}

function fixtureBytes(fixture: Fixture): Buffer {
  return readFileSync(fixturePath(fixture));
}

function partOf(fixture: Fixture): WorkingPdfPart {
  return {
    sourceFileId: fixture.name,
    path: fixturePath(fixture),
    byteSize: fixtureBytes(fixture).byteLength,
    pageCount: fixture.pageCount,
  };
}

/**
 * Манифест состава в том виде, в каком его строит репозиторий.
 *
 * Позиция — порядковый номер файла в комплекте, содержимое — SHA-256 байтов.
 * Ни имени файла, ни идентификатора строки: тот же комплект, поданный заново
 * после возврата, обязан дать тот же хэш (§5.2).
 */
function manifestOf(composition: readonly Fixture[]): readonly ManifestFile[] {
  return composition.map((fixture, index) => ({
    sortOrder: index,
    blobSha256: sha256Hex(fixtureBytes(fixture)),
  }));
}

// =====================================================================
// Чтение текста страниц собранного PDF
// =====================================================================

interface RawObject {
  /** Смещение тела объекта в файле: по нему находится начало данных потока. */
  readonly bodyOffset: number;
  readonly body: string;
}

/**
 * Текст каждой страницы документа, в порядке дерева страниц.
 *
 * Разбор здесь намеренно наивный и работает только на файлах без объектных
 * потоков — ровно таковы и фикстуры S0, и выход `pdf-lib` (он пишется с
 * `useObjectStreams: false`). Полноценный разбор живёт в `probe.ts`, но он
 * отвечает на другие вопросы и содержимое страниц не декодирует.
 *
 * Текст лежит в потоке `/Contents` сжатым, а строки записаны шестнадцатеричными
 * литералами `<…> Tj`, поэтому поток распаковывается, а литералы декодируются.
 */
function pageTexts(pdf: Buffer): readonly string[] {
  const text = pdf.toString('latin1');
  const objects = new Map<number, RawObject>();

  const objectPattern = /(\d+)\s+0\s+obj/g;
  let match = objectPattern.exec(text);
  while (match !== null) {
    const bodyOffset = match.index + match[0].length;
    const end = text.indexOf('endobj', bodyOffset);
    objects.set(Number(match[1]), {
      bodyOffset,
      body: text.slice(bodyOffset, end === -1 ? undefined : end),
    });
    match = objectPattern.exec(text);
  }

  const kids = pageKids(objects);
  return kids.map((kid) => {
    const page = objects.get(kid);
    if (page === undefined) throw new Error(`объект страницы ${kid} не найден`);
    // `/Contents` бывает и ссылкой, и массивом из одной ссылки: фикстуры S0
    // пишут массив, pdf-lib — ссылку.
    const reference = /\/Contents\s*(?:\[\s*)?(\d+)\s+0\s+R/.exec(page.body);
    if (reference === null) throw new Error(`у страницы ${kid} нет потока содержимого`);
    return decodeContent(pdf, objects, Number(reference[1]));
  });
}

function pageKids(objects: ReadonlyMap<number, RawObject>): readonly number[] {
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Pages/.test(object.body)) continue;
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(object.body);
    if (kids?.[1] === undefined) continue;
    return [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((entry) => Number(entry[1]));
  }
  throw new Error('в документе не найдено дерево страниц');
}

function decodeContent(
  pdf: Buffer,
  objects: ReadonlyMap<number, RawObject>,
  objectNumber: number,
): string {
  const stream = objects.get(objectNumber);
  if (stream === undefined) throw new Error(`поток ${objectNumber} не найден`);

  const marker = /stream\r?\n/.exec(stream.body);
  const length = /\/Length\s+(\d+)/.exec(stream.body);
  if (marker === null || length === null) {
    throw new Error(`поток ${objectNumber} не разобран: нет stream или /Length`);
  }

  const start = stream.bodyOffset + marker.index + marker[0].length;
  const raw = pdf.subarray(start, start + Number(length[1]));
  const decoded = /\/FlateDecode/.test(stream.body) ? inflateSync(raw) : raw;

  return [...decoded.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((literal) => Buffer.from(literal[1] ?? '', 'hex').toString('latin1'))
    .join(' / ');
}

// =====================================================================
// Сборка
// =====================================================================

interface Built {
  readonly path: string;
  readonly bytes: Buffer;
  readonly map: readonly WorkingPageMapping[];
  readonly texts: readonly string[];
}

let toolkit: PdfToolkit;
let workDir: string;
let sequence = 0;

async function build(composition: readonly Fixture[]): Promise<Built> {
  sequence += 1;
  const outputPath = join(workDir, `working-${sequence}.pdf`);
  const result = await toolkit.buildWorkingPdf({
    parts: composition.map(partOf),
    outputPath,
    derivedNote: 'Портал ИД: производная копия (тест)',
  });
  const bytes = readFileSync(outputPath);
  return { path: outputPath, bytes, map: result.map, texts: pageTexts(bytes) };
}

describe.skipIf(PDF_LIB_PATH === null)('рабочий документ ревизии', () => {
  beforeAll(async () => {
    const loaded: unknown = await import(pathToFileURL(PDF_LIB_PATH ?? '').href);
    const pdfLib: PdfLibModule = asPdfLibModule(loaded);
    // Фиксированное «сейчас»: иначе метаданные производной копии зависели бы от
    // момента прогона и повторная сборка давала бы другие байты.
    toolkit = createPdfLibToolkit(pdfLib);
    workDir = await mkdtemp(join(tmpdir(), 'id-bundle-test-'));
    // Запас по времени задан явно: `pdf-lib` — крупный CJS-пакет, и на полном
    // прогоне сьюта его загрузка конкурирует за процессор с двумя десятками
    // файлов тестов. Стандартные 10 секунд hook'а там исчерпываются, и падал бы
    // не дефект, а расписание.
  }, 120_000);

  afterAll(async () => {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  it('собирается из multipage и single-1..3 в заданном порядке', async () => {
    const built = await build(COMPOSITION);

    const probe = probePdf(built.bytes);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pageCount).toBe(7);

    // Порядок проверяется по содержимому, а не по числу страниц: три
    // одностраничных скана неразличимы по геометрии и различаются только
    // текстом, поэтому перестановка файлов иначе осталась бы незамеченной.
    const expected = COMPOSITION.flatMap((fixture) => pageTexts(fixtureBytes(fixture)));
    expect(built.texts).toEqual(expected);
    expect(built.texts[4]).toContain('Skan 1');
    expect(built.texts[6]).toContain('Skan 3');

    // Производная копия помечена как производная (§13) и не выдаёт себя за
    // подписанный оригинал.
    expect(probe.signature.result).toBe('none_detected');
  });

  it('карта отображает КАЖДУЮ страницу рабочего PDF на файл и страницу в нём', async () => {
    // Составом взят комплект с поворотами и форматом A3: тогда сверка
    // геометрии различает страницы, а не подтверждает «все A4 равны всем A4».
    const composition = [MULTIPAGE, ROTATED, SINGLE_2];
    const built = await build(composition);

    const probe = probePdf(built.bytes);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    // Карта покрывает документ целиком: столько же строк, сколько страниц,
    // индексы сплошные и без повторов.
    expect(built.map).toHaveLength(probe.pageCount);
    expect(built.map.map((entry) => entry.workingPageIndex)).toEqual(
      built.map.map((_entry, index) => index),
    );

    const sources = new Map(
      composition.map((fixture) => {
        const bytes = fixtureBytes(fixture);
        const sourceProbe = probePdf(bytes);
        if (!sourceProbe.ok) throw new Error(`фикстура ${fixture.name} не разобралась`);
        return [fixture.name, { texts: pageTexts(bytes), pages: sourceProbe.pages }] as const;
      }),
    );

    const seen = new Set<string>();
    for (const entry of built.map) {
      const source = sources.get(entry.sourceFileId);
      expect(source, `в карте назван неизвестный файл ${entry.sourceFileId}`).toBeDefined();
      if (source === undefined) continue;

      const key = `${entry.sourceFileId}:${entry.filePageIndex}`;
      expect(seen.has(key), `страница ${key} названа в карте дважды`).toBe(false);
      seen.add(key);

      const workingPage = probe.pages[entry.workingPageIndex];
      const sourcePage = source.pages[entry.filePageIndex];
      expect(
        sourcePage,
        `в файле ${entry.sourceFileId} нет страницы ${entry.filePageIndex}`,
      ).toBeDefined();
      if (workingPage === undefined || sourcePage === undefined) continue;

      // Утверждение карты проверяется по самой странице: её текст и её
      // геометрия обязаны совпасть с оригиналом. Без этого карта проверялась бы
      // сама собой — она построена той же функцией, что и план.
      expect(built.texts[entry.workingPageIndex], `текст страницы ${entry.workingPageIndex}`).toBe(
        source.texts[entry.filePageIndex],
      );
      expect(workingPage.rotation, `поворот страницы ${entry.workingPageIndex}`).toBe(
        sourcePage.rotation,
      );
      expect(workingPage.widthPt).toBeCloseTo(sourcePage.widthPt, 1);
      expect(workingPage.heightPt).toBeCloseTo(sourcePage.heightPt, 1);
    }

    // Ни одна страница оригиналов не потеряна по дороге.
    expect(seen.size).toBe(composition.reduce((sum, fixture) => sum + fixture.pageCount, 0));
  });

  it('повторная сборка того же состава даёт тот же aggregate_manifest_hash', async () => {
    const first = await build(COMPOSITION);
    const second = await build(COMPOSITION);

    expect(computeAggregateManifestHash(manifestOf(COMPOSITION))).toBe(
      computeAggregateManifestHash(manifestOf(COMPOSITION)),
    );
    // Хэш не зависит и от абсолютных значений позиций: перенумерация без
    // изменения порядка — тот же состав (§3.3).
    const renumbered = manifestOf(COMPOSITION).map((file, index) => ({
      ...file,
      sortOrder: (index + 1) * 10,
    }));
    expect(computeAggregateManifestHash(renumbered)).toBe(
      computeAggregateManifestHash(manifestOf(COMPOSITION)),
    );

    // И сам документ воспроизводится: карта, состав страниц и содержимое те же.
    expect(second.map).toEqual(first.map);
    expect(second.texts).toEqual(first.texts);
  });

  it('изменение порядка файлов меняет хэш и карту', async () => {
    const reversed = [...COMPOSITION].reverse();

    const straightHash = computeAggregateManifestHash(manifestOf(COMPOSITION));
    const reversedHash = computeAggregateManifestHash(manifestOf(reversed));

    // Иначе манифест не описывал бы состав: перестановка меняет и рабочий
    // документ, и нумерацию страниц ревизии, а хэш утверждал бы, что ничего
    // не изменилось, — и §5.2 переиспользовала бы чужой результат.
    expect(reversedHash).not.toBe(straightHash);

    const built = await build(reversed);
    expect(built.map[0]).toEqual({
      workingPageIndex: 0,
      sourceFileId: 'single-3',
      filePageIndex: 0,
    });
    expect(built.texts[0]).toContain('Skan 3');
    expect(built.texts).toEqual(reversed.flatMap((fixture) => pageTexts(fixtureBytes(fixture))));
  });

  it('оригиналы после сборки не изменились', async () => {
    const before = COMPOSITION.map((fixture) => sha256Hex(fixtureBytes(fixture)));

    await build(COMPOSITION);
    await build([...COMPOSITION].reverse());

    const after = COMPOSITION.map((fixture) => sha256Hex(fixtureBytes(fixture)));
    expect(after).toEqual(before);

    // Сверка не только «до и после», но и с манифестом фикстур: он
    // зафиксирован в репозитории, поэтому проверка ловит и порчу, случившуюся
    // до начала теста.
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8'),
    ) as Record<string, string>;
    for (const [index, fixture] of COMPOSITION.entries()) {
      expect(after[index], `sha256 фикстуры ${fixture.name}`).toBe(manifest[`${fixture.name}.pdf`]);
    }
  });

  it('рабочий документ — отдельный объект, а не подменённый оригинал', async () => {
    const built = await build(COMPOSITION);
    const originals = new Set(COMPOSITION.map((fixture) => sha256Hex(fixtureBytes(fixture))));

    // Хэш собранного документа обязан отличаться от любого исходного: он
    // ложится в `stored_blobs` отдельной строкой и в `processing_bundles`.
    expect(originals.has(createHash('sha256').update(built.bytes).digest('hex'))).toBe(false);
  });
});
