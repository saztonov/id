/**
 * Тесты барьера ПДн `tools/scripts/pii-scan.mjs`.
 *
 * Тест живёт здесь, а не рядом со сканером: `tools/scripts` — не пакет
 * воркспейса, и `pnpm -r test` туда не заглядывает. Сканер грузится
 * динамическим импортом по вычисляемому пути: статический вытащил бы
 * исполняемый скрипт вне `src` в `rootDir` сборки.
 *
 * ## Почему здесь нет ни одного настоящего значения
 *
 * Тест сам является отслеживаемым файлом, и сканер его проверяет. Написать
 * «ловится фамилия Иванов» настоящей фамилией — значит внести ПДн в
 * репозиторий и покрасить гейт собственным тестом. Поэтому:
 *
 * - настоящие ИНН и ОГРН берутся во время прогона из `docs/CORPUS_FINDINGS.md`
 *   — единственного файла, которому они разрешены, и заодно первоисточника
 *   утверждения «их десять»; в памяти теста они живут, в исходнике — нет;
 * - фамилии и отпечатки сертификатов не разрешены нигде, поэтому классы
 *   проверяются синтетической фикстурой сканера, а полнота НАСТОЯЩЕГО списка —
 *   fail-closed проверкой числа маркеров и отпечатка множества.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { PII_SCANNER_PATH, REFERENCE_CORPUS_DIR } from './corpus-reference.js';

interface Hit {
  readonly class: string;
  readonly value: string;
}

interface MarkerSet {
  readonly surname: readonly string[];
  readonly cert: readonly string[];
  readonly id: readonly string[];
  readonly org: readonly string[];
}

interface Scanner {
  readonly MARKER_SET: MarkerSet;
  readonly MARKER_SET_EXPECTED: {
    readonly counts: Readonly<Record<string, number>>;
    readonly digest: string;
  };
  readonly SELF_TEST_TEXT: string;
  readonly SELF_TEST_MARKERS: {
    readonly surname: string;
    readonly id: string;
    readonly cert: string;
  };
  scanText(
    text: string,
    options?: { set?: MarkerSet; includeCodeOnly?: boolean },
  ): Promise<readonly Hit[]>;
  selfTest(set?: MarkerSet): Promise<void>;
  verifyMarkerSet(set?: MarkerSet, expected?: unknown): void;
  markerSetDigest(set: MarkerSet): string;
  collectCandidates(text: string): { surname: Set<string>; cert: Set<string>; id: Set<string> };
}

/**
 * Запас по времени: медленный KDF здесь не досадная деталь, а суть проверки.
 *
 * Каждое обращение к числовому классу стоит около 150 мс, тестов с числовыми
 * маркерами полтора десятка, и идут они одновременно с корпусными тестами,
 * которые заняли весь пул libuv. Пятисекундного умолчания vitest не хватает, а
 * ускорять сканер ради теста значило бы ослаблять барьер.
 */
vi.setConfig({ testTimeout: 120_000 });

const scanner = (await import(pathToFileURL(PII_SCANNER_PATH).href)) as unknown as Scanner;

/** Корень репозитория: `REFERENCE_CORPUS_DIR` — это `tools/fixtures/corpus`. */
const REPO_ROOT = join(REFERENCE_CORPUS_DIR, '..', '..', '..');
const FINDINGS_PATH = join(REPO_ROOT, 'docs', 'CORPUS_FINDINGS.md');
const FINDINGS = readFileSync(FINDINGS_PATH, 'utf8');

/**
 * Достаёт из вычитанного документа перечисленные там реквизиты.
 *
 * Заголовок утверждения (`ИНН — все десять валидны`) взят частью шаблона
 * намеренно: если раздел переименуют или значения из него уберут, тест не
 * начнёт молча проверять пустое множество, а упадёт на явной проверке длины.
 */
function documentedIds(heading: string, length: number): readonly string[] {
  const start = FINDINGS.indexOf(heading);
  if (start < 0) throw new Error(`В ${FINDINGS_PATH} нет утверждения «${heading}»`);
  const chunk = FINDINGS.slice(start, start + 400);
  return [
    ...new Set([...chunk.matchAll(/\d+/g)].map((m) => m[0]).filter((v) => v.length === length)),
  ];
}

const DOCUMENTED_INN = documentedIds('**ИНН — все десять валидны**', 10);
const DOCUMENTED_OGRN = documentedIds('**ОГРН — пять из семи валидны**', 13);

/** Уменьшает множество на один маркер — модель «список усох». */
function shrink(set: MarkerSet, cls: keyof MarkerSet): MarkerSet {
  return { ...set, [cls]: set[cls].slice(1) };
}

describe('множество маркеров', () => {
  it('совпадает с закоммиченной формой', () => {
    expect(() => scanner.verifyMarkerSet()).not.toThrow();
    expect(scanner.markerSetDigest(scanner.MARKER_SET)).toBe(scanner.MARKER_SET_EXPECTED.digest);
  });

  it('fail-closed: усохший список — отказ, а не «чисто»', () => {
    for (const cls of ['surname', 'cert', 'id', 'org'] as const) {
      expect(() => scanner.verifyMarkerSet(shrink(scanner.MARKER_SET, cls))).toThrow(/повреждено/);
    }
  });

  it('fail-closed: подмена маркера ломает отпечаток при том же числе', () => {
    const swapped: MarkerSet = {
      ...scanner.MARKER_SET,
      surname: [...scanner.MARKER_SET.surname.slice(1), '0'.repeat(64)],
    };
    expect(swapped.surname.length).toBe(scanner.MARKER_SET.surname.length);
    expect(() => scanner.verifyMarkerSet(swapped)).toThrow(/отпечаток множества/);
  });
});

describe('само-проверка', () => {
  it('краснеет на синтетической фикстуре во всех трёх классах', async () => {
    const hits = await scanner.scanText(scanner.SELF_TEST_TEXT);
    expect([...new Set(hits.map((hit) => hit.class))].sort()).toEqual(['cert', 'id', 'surname']);
    await expect(scanner.selfTest()).resolves.toBeUndefined();
  });

  it('отказывает, если фикстура перестала ловиться', async () => {
    // Модель протухшего детектора: маркер фикстуры выпал из множества.
    // Без этого шага сломанный сканер выглядел бы как чистое дерево.
    const withoutFixture: MarkerSet = {
      ...scanner.MARKER_SET,
      surname: [],
      cert: [],
      id: [],
    };
    await expect(scanner.selfTest(withoutFixture)).rejects.toThrow(/Само-проверка не сработала/);
  });
});

describe('детектор', () => {
  it('ловит все ИНН и ОГРН, перечисленные в вычитанном документе', async () => {
    // Прежний сканер знал шесть ИНН из десяти: файл с одним из четырёх
    // остальных давал «чисто». Здесь это утверждение проверяется поимённо.
    expect(DOCUMENTED_INN.length).toBe(10);
    expect(DOCUMENTED_OGRN.length).toBe(5);
    for (const value of [...DOCUMENTED_INN, ...DOCUMENTED_OGRN]) {
      const hits = await scanner.scanText(`Реквизиты: ${value}.`);
      expect(hits.map((hit) => hit.class)).toContain('id');
    }
  });

  it('ловит фамилию и отпечаток сертификата', async () => {
    const { surname, cert } = scanner.SELF_TEST_MARKERS;
    // Фамилия ловится и в другом падеже, и в другом регистре: маркер ищется
    // подстрокой цепочки, а не целым словом и не посимвольно.
    const hits = await scanner.scanText(`Утвердил ${surname}ым. Сертификат ${cert.toLowerCase()}.`);
    expect(hits.map((hit) => hit.class).sort()).toEqual(['cert', 'surname']);
  });

  it('ловит маркер, приклеенный к соседним символам', async () => {
    const value = DOCUMENTED_INN[0] ?? '';
    const hits = await scanner.scanText(`ИНН${value}0/КПП770101001`);
    expect(hits.map((hit) => hit.class)).toContain('id');
  });

  it('положительный контроль: чистый текст даёт «чисто»', async () => {
    const clean = [
      '## Акт освидетельствования скрытых работ № 12',
      'Застройщик: ООО «Пример», ИНН 0012345678, ОГРН 0000000000000.',
      'Подписал Синеглазов П. Р., сертификат 00112233445566778899AABBCCDDEEFF.',
      'ГОСТ 34028-2016, СП 70.13330.2012, дата 12.03.2025.',
    ].join('\n');
    expect(await scanner.scanText(clean)).toEqual([]);
  });

  it('кандидаты вырезаются по всем классам сразу', () => {
    const candidates = scanner.collectCandidates(
      'Иванченко 7712345671 ABCDEF0123456789ABCDEF0123456789',
    );
    expect(candidates.id.has('7712345671')).toBe(true);
    expect(candidates.cert.has('abcdef0123456789abcdef0123456789')).toBe(true);
    expect(candidates.surname.has('иванченко')).toBe(true);
  });
});

describe('политика по файлам', () => {
  it('реквизиты юрлиц допустимы в вычитанном документе, фамилии — нет', async () => {
    const value = DOCUMENTED_INN[0] ?? '';
    const { surname } = scanner.SELF_TEST_MARKERS;

    const asDocs = await scanner.scanText(`ИНН ${value}, подписал ${surname}`, {
      includeCodeOnly: false,
    });
    expect(asDocs.map((hit) => hit.class)).toEqual(['surname']);

    const asCode = await scanner.scanText(`ИНН ${value}`);
    expect(asCode.map((hit) => hit.class)).toEqual(['id']);
  });

  it('сам docs/CORPUS_FINDINGS.md проходит по своей политике', async () => {
    expect(await scanner.scanText(FINDINGS, { includeCodeOnly: false })).toEqual([]);
    // А по строгой политике — нет: реквизиты в нём настоящие и лежат осознанно.
    const strict = await scanner.scanText(FINDINGS);
    expect(strict.map((hit) => hit.class)).toContain('id');
  });
});

describe('сканер не является справочником значений', () => {
  /**
   * Инвариант 4б, проверенный машиной: в исходнике сканера не осталось ни
   * одного значения, которое обезличиватель мог бы прочитать как маркер.
   *
   * Проверяет это сам детектор: если бы в файле лежала настоящая фамилия или
   * настоящий отпечаток, их хэши есть в множестве, и находка была бы здесь.
   * Разрешены ровно две вещи: синтетическая фикстура само-проверки и открытый
   * список наименований организаций (обоснование — в шапке сканера).
   */
  it('в его исходнике нет ни фамилий корпуса, ни отпечатков, ни реквизитов', async () => {
    const source = readFileSync(PII_SCANNER_PATH, 'utf8');
    const hits = await scanner.scanText(source);
    const fixture = new Set(
      (await scanner.scanText(scanner.SELF_TEST_TEXT)).map((hit) => hit.value),
    );
    const leaked = hits.filter((hit) => hit.class !== 'org' && !fixture.has(hit.value));
    expect(leaked.map((hit) => hit.class)).toEqual([]);
  });

  it('в его исходнике нет hex-литералов длины отпечатка', () => {
    // Второе утверждение, независимое от множества хэшей: отпечаток сертификата
    // — это 32–33 шестнадцатеричных символа, и таких литералов в файле быть не
    // должно вовсе, даже если бы соответствующий маркер из множества выпал.
    // Хэши маркеров длиной 64 под шаблон не подпадают.
    const source = readFileSync(PII_SCANNER_PATH, 'utf8')
      .split(scanner.SELF_TEST_MARKERS.cert)
      .join('<фикстура>');
    expect(source.match(/(?<![0-9a-fA-F])[0-9a-fA-F]{32,33}(?![0-9a-fA-F])/g) ?? []).toEqual([]);
  });
});
