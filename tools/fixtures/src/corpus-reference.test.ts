/**
 * Тесты эталонной разметки корпуса.
 *
 * Главный из них — не про метрики, а про ПДн: он читает УЖЕ ЗАКОММИЧЕННЫЕ
 * файлы `tools/fixtures/corpus/*.json` и падает, если в них нашлось хоть одно
 * персональное данное. Это постоянная защита, а не разовая вычитка: на S1
 * настоящие ФИО и отпечатки сертификатов ЭП попали в репозиторий именно
 * потому, что проверка была разовой (`docs/EXECUTION_LOG.md`, пункт 6).
 *
 * Входные данные тестов обезличивателя вымышлены целиком: реквизиты посчитаны
 * под нужные контрольные суммы, наименования и фамилии придуманы. Настоящих
 * строк корпуса здесь нет и быть не может — иначе тест сам стал бы утечкой.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { checkOgrn } from '@id/contracts';
import {
  PACKAGE_SPECS,
  REFERENCE_CORPUS_DIR,
  anonymizePackage,
  auditByPiiScanner,
  auditCorpusPii,
  buildReferencePackage,
  collectPackageMarkers,
  loadReferenceCorpus,
  parseSourcePackage,
  resolveGoldenCorpusDir,
  serializeReferencePackage,
  referenceFileName,
  type ReferencePackage,
  type SourcePage,
} from './corpus-reference.js';

const CORPUS = loadReferenceCorpus();

/**
 * Пустой список маркеров — заявление, а не умолчание.
 *
 * Значения закрытого корпуса на машине без `GOLDEN_CORPUS_DIR` недоступны, и
 * раньше их подменял список из `pii-scan.mjs`: обезличиватель читал ИСХОДНИК
 * сканера как справочник, а сканер ради этого хранил настоящие фамилии
 * открытым текстом. Связь разорвана, поэтому здесь работают два оставшихся
 * контролёра, которым значения не нужны: `containsPii` — по форме, сканер —
 * по хэшам.
 */
const NO_MARKERS: readonly string[] = [];

describe('закоммиченный эталон', () => {
  it('состоит из трёх комплектов с нейтральными ключами', () => {
    expect(CORPUS.map((pkg) => pkg.packageKey)).toEqual(['package-a', 'package-b', 'package-c']);
    // Ключ не должен содержать ни номера акта, ни шифра раздела: имя папки
    // закрытого корпуса само по себе идентифицирует объект (§1.4).
    for (const pkg of CORPUS) expect(pkg.packageKey).toMatch(/^package-[a-z]$/);
  });

  it('покрывает 142 страницы двух разделов', () => {
    const pages = CORPUS.reduce((sum, pkg) => sum + pkg.pages.length, 0);
    expect(pages).toBe(142);
    expect(CORPUS.map((pkg) => pkg.pages.length)).toEqual([50, 9, 83]);
    expect([...new Set(CORPUS.map((pkg) => pkg.sectionKindCode))].sort()).toEqual([
      'concrete_frame',
      'roofing',
    ]);
  });

  it('ожидает 29 строк реестра в комплекте несущих конструкций', () => {
    // Специфический гейт S8 (§17): реестр приложений АОСР на 83 страницы
    // содержит ровно 29 позиций. Комплект без реестра объявляет это явно —
    // `null`, а не 0: «реестра нет» и «реестр пуст» ведут к разным правилам.
    const byKey = new Map(CORPUS.map((pkg) => [pkg.packageKey, pkg]));
    expect(byKey.get('package-c')?.expectedRegistryRowCount).toBe(29);
    expect(byKey.get('package-a')?.expectedRegistryRowCount).toBe(23);
    expect(byKey.get('package-b')?.expectedRegistryRowCount).toBeNull();
  });

  it('нумерует страницы подряд и хранит геометрию', () => {
    for (const pkg of CORPUS) {
      pkg.pages.forEach((page, index) => {
        expect(page.pageNo).toBe(index + 1);
        expect(page.widthPx).toBeGreaterThan(0);
        expect(page.heightPx).toBeGreaterThan(0);
        expect([0, 90, 180, 270]).toContain(page.rotation);
        for (const type of page.blockTypes) expect(['text', 'image', 'stamp']).toContain(type);
      });
    }
  });

  it('содержит страницы с поворотом и с блоками всех трёх типов', () => {
    // Без этого эталон не покрывает два реальных класса: повёрнутый скан и
    // страницу схемы, которая определяется только составом блоков.
    const pages = CORPUS.flatMap((pkg) => pkg.pages);
    expect(pages.some((page) => page.rotation !== 0)).toBe(true);
    const types = new Set(pages.flatMap((page) => page.blockTypes));
    expect([...types].sort()).toEqual(['image', 'stamp', 'text']);
  });

  it('назначает каждую страницу ровно одному документу или явно никому', () => {
    for (const pkg of CORPUS) {
      const starts = new Map<string, number>();
      for (const page of pkg.pages) {
        const { label, documentKey, pageRoleCode, docTypeCode, typeOutcome } = page.expected;
        if (label === 'U') {
          expect(documentKey).toBeNull();
          continue;
        }
        expect(documentKey).not.toBeNull();
        if (label === 'B-DOC') {
          expect(starts.has(documentKey ?? '')).toBe(false);
          starts.set(documentKey ?? '', page.pageNo);
          expect(pageRoleCode).toBeNull();
        }
        if (label === 'A-ROLE') {
          // Служебный лист не несёт собственного типа: тип принадлежит
          // документу, к которому лист присоединён.
          expect(pageRoleCode).not.toBeNull();
          expect(docTypeCode).toBeNull();
          expect(typeOutcome).toBe('none');
        }
        if (label === 'I-DOC') expect(pageRoleCode).toBeNull();
      }
      // У каждого документа есть начало: страница `I-DOC` или `A-ROLE` без
      // предшествующего `B-DOC` означала бы документ, начавшийся ниоткуда.
      for (const page of pkg.pages) {
        if (page.expected.documentKey === null) continue;
        expect(starts.get(page.expected.documentKey)).toBeLessThanOrEqual(page.pageNo);
      }
    }
  });

  it('использует только коды ролей из каталога', () => {
    const roles = new Set(
      CORPUS.flatMap((pkg) => pkg.pages.map((page) => page.expected.pageRoleCode)).filter(
        (role): role is string => role !== null,
      ),
    );
    for (const role of roles) {
      expect(['blank', 'copy_stamp', 'signature_visual', 'annex_continuation']).toContain(role);
    }
  });

  it('размечен без единой страницы, отданной классификатору наугад', () => {
    // Тип задан либо кодом каталога с исходом `known`, либо не задан вовсе.
    // `uncertain` в эталоне означал бы «разметчик не знал» — такие страницы
    // положено выносить в отчёт, а не прятать в числах.
    for (const pkg of CORPUS) {
      for (const page of pkg.pages) {
        const { docTypeCode, typeOutcome } = page.expected;
        if (docTypeCode === null) expect(typeOutcome).toBe('none');
        else expect(typeOutcome).toBe('known');
      }
    }
  });
});

describe('барьер против персональных данных', () => {
  it('не находит ПДн в закоммиченном эталоне', async () => {
    const problems: string[] = [];
    for (const pkg of CORPUS) {
      for (const page of pkg.pages) {
        for (const problem of auditCorpusPii(page.text, NO_MARKERS)) {
          problems.push(`${pkg.packageKey} стр. ${page.pageNo}: ${problem}`);
        }
      }
    }
    // Сканер зовётся один раз на всём эталоне: он ищет по хэшам, и медленный
    // KDF окупается только на дедуплицированном множестве кандидатов. Номер
    // страницы для его вердикта не нужен — любая находка означает отказ.
    const whole = CORPUS.flatMap((pkg) => pkg.pages.map((page) => page.text)).join('\n');
    problems.push(...(await auditByPiiScanner(whole)));
    expect(problems).toEqual([]);
  }, 120_000);

  it('не находит ПДн в служебных полях эталона', async () => {
    // Ключи документов, коды типов и ролей тоже отслеживаются git и тоже могут
    // унести с собой номер акта или фамилию, если разметку делать «как есть».
    const meta = CORPUS.flatMap((pkg) => [
      pkg.packageKey,
      pkg.sectionKindCode,
      ...pkg.pages.flatMap((page) => [
        page.expected.documentKey ?? '',
        page.expected.docTypeCode ?? '',
        page.expected.pageRoleCode ?? '',
      ]),
    ]).join('\n');
    expect(auditCorpusPii(meta, NO_MARKERS)).toEqual([]);
    expect(await auditByPiiScanner(meta)).toEqual([]);
  });

  it('ловит подсаженный маркер и подсаженный реквизит', () => {
    // Маркер вымышлен: настоящему в отслеживаемом файле теста не место.
    expect(auditCorpusPii('Подпись: Верещалкин', ['Верещалкин']).length).toBeGreaterThan(0);
    // ИНН вне зарезервированного пространства `00…` считается настоящим.
    expect(auditCorpusPii('ИНН 7712345671', NO_MARKERS).length).toBeGreaterThan(0);
    expect(auditCorpusPii('ИНН 0012345678', NO_MARKERS)).toEqual([]);
  });

  it('берёт значения из комплекта, а не из исходника сканера', () => {
    // Инвариант развязки, выраженный поведением. Прежде маркеры выковыривались
    // регэкспом из `pii-scan.mjs`, и это была единственная причина, по которой
    // страж ПДн держал у себя двенадцать настоящих фамилий. Теперь набор
    // маркеров зависит РОВНО от переданного комплекта: чужой текст — чужие
    // маркеры, пустой комплект — пустой набор.
    const markers = collectPackageMarkers([
      'ООО «Вымышленная Артель», в лице: генерального директора, Верещалкин Пров',
    ]);
    expect(markers.length).toBeGreaterThan(0);
    for (const marker of markers) {
      expect('ООО «Вымышленная Артель» Верещалкин Пров').toContain(marker);
    }
    expect(collectPackageMarkers([])).toEqual([]);
  });
});

describe('обезличивание производного набора', () => {
  /** Вымышленный комплект: реквизиты посчитаны, наименования придуманы. */
  const SAMPLE: readonly string[] = [
    [
      '##### Объект капитального строительства',
      'ООО "СЗ "АРЕНА "ВОСХОД", ОГРН 123456789012, ИНН 7712345671, 123456, Г.МОСКВА, ВН.ТЕР.Г. МУНИЦИПАЛЬНЫЙ ОКРУГ ЛЕСНОЙ, УЛ. ПЕРВОМАЙСКАЯ, Д. 69/75, тел. (495) 1234567.',
      'Главный инженер проекта Ковальчук Д. Е., приказ №28-04/25-02 от 28.04.2025',
      'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
      'КОПИЯ ВЕРНА',
      'ООО "АРЕНА "ВОСХОД"',
      'Пилипенко М. В.',
      '06DDEE9D00FIB20AA54136D1B5B55A1ADF',
      '| 1 | Декларация о соответствии | №РОСС RU Д-РУ.РА01.В.36916/24 | Заказчик: ООО "ВОСХОД" |',
    ].join('\n'),
    [
      '#### СЕРТИФИКАТ СООТВЕТСТВИЯ',
      '№ РОСС RU Д-RU.PA01.B.36916/24',
      'ИЗГОТОВИТЕЛЬ SUNRISE Russia Group:',
      'Печать: «ОТРИ 1234567890126», контрагент',
      'Г.А.Тимофеева',
      'И.Н Пилипенко',
      'Подпись ОТК Ковальчук.Е.Н Дата: 26.11.2025г.',
      'Тимофеева Ирина',
      'В ЛИЦЕ: ГЕНЕРАЛЬНЫЙ ДИРЕКТОР, ПИЛИПЕНКО МАРК',
      'Заявитель',
      'ПИЛИПЕНКО МАРК',
      '117335, Москва г, Первомайская ул, дом № 69/75, оф. 806',
      'Заозёрская область, г. Приморск, ул. Заводская д.3',
      'тел./факс +7 (484) 39 6-85-82; 39 5-75-65',
      'www.example-supplier.ru',
      'Исполнитель: ООО "ВОСХОД"',
    ].join('\n'),
  ];

  const anonymized = anonymizePackage(SAMPLE);
  const joined = anonymized.join('\n');

  it('детерминирован', () => {
    expect(anonymizePackage(SAMPLE)).toEqual(anonymized);
  });

  it('сохраняет намеренно битый ОГРН битым и двенадцатизначным', () => {
    // Ради этого свойства обезличивание идёт через `anonymizeText` (§1.4):
    // «починенный» ОГРН превратил бы регрессионный тест §16 в проверку пустоты.
    const value = /ОГРН\s+(\d+)/.exec(anonymized[0] ?? '')?.[1] ?? '';
    expect(value).toHaveLength(12);
    expect(checkOgrn(value).ok).toBe(false);
    expect(value).not.toBe('123456789012');
  });

  it('обезличивает ОГРН без метки, оставляя его несходящимся', () => {
    // На печати OCR прочитал «ОГРН» как «ОТРИ», и значение прошло бы мимо
    // обезличивателя, который ищет по метке.
    expect(joined).not.toContain('1234567890126');
    const value = /ОТРИ\s+(\d+)/.exec(anonymized[1] ?? '')?.[1] ?? '';
    expect(value).toHaveLength(13);
    expect(checkOgrn(value).ok).toBe(false);
  });

  it('заменяет наименования организаций во всём комплекте согласованно', () => {
    expect(joined).not.toContain('ВОСХОД');
    expect(joined).not.toContain('SUNRISE');
    // Одно и то же наименование получает одну и ту же замену на всех страницах
    // комплекта — иначе сверка реестра с комплектом в производном наборе
    // перестаёт быть проверяемой. Сбор идёт по всему комплекту сразу именно
    // ради этого.
    const inRegistry = /Заказчик: ООО "([^"]+)"/.exec(anonymized[0] ?? '')?.[1];
    const inDocument = /Исполнитель: ООО "([^"]+)"/.exec(anonymized[1] ?? '')?.[1];
    expect(inRegistry).toBeDefined();
    expect(inDocument).toBe(inRegistry);
  });

  it('заменяет серийный номер ЭП, изувеченный OCR', () => {
    expect(joined).not.toContain('06DDEE9D00FIB20AA54136D1B5B55A1ADF');
    expect(joined).toMatch(/0000[0-9A-F]{20,}/);
  });

  it('заменяет ФИО во всех записанных в корпусе формах', () => {
    for (const name of ['Тимофеева', 'Пилипенко', 'Ковальчук', 'ПИЛИПЕНКО', 'Ирина']) {
      expect(joined).not.toContain(name);
    }
  });

  it('не принимает адрес за человека', () => {
    // «Г.МОСКВА» — это город, а не «Г. М. Осква»: шаблон инициалов обязан
    // требовать разделитель, иначе адрес превращается в подписанта.
    expect(anonymized[0]).toContain('Г.МОСКВА');
  });

  it('заменяет улицу, индекс, округ и область', () => {
    expect(joined).not.toContain('ПЕРВОМАЙСКАЯ');
    expect(joined).not.toContain('Первомайская');
    expect(joined).not.toContain('117335');
    expect(joined).not.toContain('ЛЕСНОЙ');
    expect(joined).not.toContain('Заозёрская');
  });

  it('сохраняет структуру страницы и Unicode-классы', () => {
    // Markdown-префиксы и таблицы — те самые структурные признаки, на которых
    // ломались якоря S1; кириллические гомоглифы в номере декларации — то, ради
    // чего существует фолдинг при сверке с реестром.
    expect(anonymized[0]).toContain('##### Объект капитального строительства');
    expect(anonymized[0]).toContain('| 1 | Декларация о соответствии |');
    expect(anonymized[0]).toContain('РОСС RU Д-РУ.РА01.В.36916/24');
    expect(anonymized[1]).toContain('РОСС RU Д-RU.PA01.B.36916/24');
    expect(anonymized[0]).toContain('КОПИЯ ВЕРНА');
    expect(anonymized[0]?.split('\n')).toHaveLength(SAMPLE[0]?.split('\n').length ?? 0);
  });

  it('не оставляет ни одного значения, которое сам же нашёл', async () => {
    // Это и есть проверка полноты: `collectPackageMarkers` возвращает то, что
    // обезличиватель нашёл в ИСХОДНОМ комплекте и обязался заменить, и ни одно
    // из этих значений не должно пережить обезличивание. Раньше на этом месте
    // стоял чужой список из `pii-scan.mjs`, который про конкретный комплект не
    // знал ничего.
    const markers = collectPackageMarkers(SAMPLE);
    expect(markers.some((marker) => marker.includes('ВОСХОД'))).toBe(true);
    // Каждый маркер обязан быть взят из самого комплекта, а не откуда-то ещё.
    const source = SAMPLE.join('\n');
    for (const marker of markers) expect(source).toContain(marker);
    for (const text of anonymized) expect(auditCorpusPii(text, markers)).toEqual([]);
    expect(await auditByPiiScanner(anonymized.join('\n'))).toEqual([]);
  }, 120_000);
});

describe('сборка эталона из разметки', () => {
  const pages: readonly SourcePage[] = [1, 2, 3].map((pageNo) => ({
    pageNo,
    text: `страница ${pageNo}`,
    blockTypes: ['text'] as const,
    widthPx: 100,
    heightPx: 200,
    rotation: 0,
  }));

  it('выводит метки из состава документов', () => {
    const pkg = buildReferencePackage(
      {
        packageKey: 'package-x',
        sectionKindCode: 'roofing',
        pageCount: 3,
        expectedRegistryRowCount: null,
        documents: [
          {
            key: 'doc-01',
            docTypeCode: 'aosr',
            typeOutcome: 'known',
            pages: [1, 2, 3],
            roles: { 3: 'copy_stamp' },
          },
        ],
      },
      pages,
      pages.map((page) => page.text),
    );
    expect(pkg.pages.map((page) => page.expected.label)).toEqual(['B-DOC', 'I-DOC', 'A-ROLE']);
    expect(pkg.pages[2]?.expected.pageRoleCode).toBe('copy_stamp');
    expect(pkg.pages[2]?.expected.docTypeCode).toBeNull();
  });

  it('помечает непокрытую страницу как непривязанную, а не теряет её', () => {
    const pkg = buildReferencePackage(
      {
        packageKey: 'package-x',
        sectionKindCode: 'roofing',
        pageCount: 3,
        expectedRegistryRowCount: null,
        documents: [{ key: 'doc-01', docTypeCode: 'aosr', typeOutcome: 'known', pages: [1, 2] }],
      },
      pages,
      pages.map((page) => page.text),
    );
    expect(pkg.pages[2]?.expected).toEqual({
      label: 'U',
      docTypeCode: null,
      typeOutcome: 'none',
      pageRoleCode: null,
      documentKey: null,
    });
  });

  it('отказывается собирать эталон, где страница отдана двум документам', () => {
    // Инвариант назначения страниц — non-degradable гейт §1.6. Эталон, его
    // нарушающий, сделал бы измерение этого гейта бессмысленным.
    expect(() =>
      buildReferencePackage(
        {
          packageKey: 'package-x',
          sectionKindCode: 'roofing',
          pageCount: 3,
          expectedRegistryRowCount: null,
          documents: [
            { key: 'doc-01', docTypeCode: 'aosr', typeOutcome: 'known', pages: [1, 2] },
            { key: 'doc-02', docTypeCode: 'aosr', typeOutcome: 'known', pages: [2, 3] },
          ],
        },
        pages,
        pages.map((page) => page.text),
      ),
    ).toThrow(/назначена дважды/);
  });
});

/**
 * Тесты, требующие закрытого корпуса.
 *
 * Их нет ни в CI, ни на машине без `GOLDEN_CORPUS_DIR`, и это не пробел, а
 * условие §1.4: 142 реальные страницы в репозиторий не попадают. Всё, что
 * можно проверить без них, проверено выше.
 */
const goldenDir = resolveGoldenCorpusDir();

describe.skipIf(goldenDir === null)('сверка с закрытым корпусом', () => {
  it('генерация из корпуса даёт ровно то, что закоммичено', () => {
    // Дрейф между разметкой в коде и файлом эталона иначе обнаруживается
    // только глазами и только случайно.
    const sources = new Map<number, readonly SourcePage[]>();
    for (const entry of listPackageDirs(goldenDir ?? '')) {
      const parsed = parseSourcePackage(entry);
      sources.set(parsed.length, parsed);
    }
    for (const spec of PACKAGE_SPECS) {
      const pages = sources.get(spec.pageCount);
      expect(pages, `комплект на ${spec.pageCount} страниц`).toBeDefined();
      const pkg: ReferencePackage = buildReferencePackage(
        spec,
        pages ?? [],
        anonymizePackage((pages ?? []).map((page) => page.text)),
      );
      const committed = readFileSync(
        join(REFERENCE_CORPUS_DIR, referenceFileName(spec.packageKey)),
        'utf8',
      );
      expect(serializeReferencePackage(pkg)).toBe(committed);
    }
  });
});

/** Папки комплектов закрытого корпуса. Вынесено, чтобы тест читался. */
function listPackageDirs(dir: string): readonly string[] {
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => readdirSync(path).some((file) => file.endsWith('_results.md')));
}

// =====================================================================
// Разбор исходного комплекта: страницы без блоков (синтетика)
// =====================================================================

describe('parseSourcePackage — страницы, отсутствующие в md', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function packageOf(markdown: string, blocks: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-source-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'syn_results.md'), markdown, 'utf8');
    writeFileSync(join(dir, 'syn_blocks.json'), JSON.stringify(blocks), 'utf8');
    return dir;
  }

  const page = (index: number) => ({
    page_index: index,
    width_px: 2480,
    height_px: 3507,
    rotation: 0,
  });

  it('страница без единого блока законно отсутствует в md и получает пустой текст', () => {
    // Генератор md не печатает `## Page N` для страницы, на которой нет
    // блоков: в temp/MD/new таких три (пустые листы сканов). Требование
    // «страниц в md столько же, сколько в blocks.json» роняло весь комплект.
    const dir = packageOf(
      '# Document: syn.pdf\n\n## Page 1\n\nтекст первой страницы\n\n## Page 3\n\nтекст третьей страницы\n',
      {
        schema_version: 1,
        pages: [page(0), page(1), page(2)],
        blocks: [
          { page_index: 0, ordinal: 1, block_type: 'text' },
          { page_index: 2, ordinal: 1, block_type: 'text' },
        ],
      },
    );

    const parsed = parseSourcePackage(dir);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]?.text).toContain('первой');
    expect(parsed[1]?.text).toBe('');
    expect(parsed[1]?.blockTypes).toEqual([]);
    expect(parsed[2]?.text).toContain('третьей');
  });

  it('страница с не-stamp блоками, отсутствующая в md, — усечённый экспорт', () => {
    const dir = packageOf('# Document: syn.pdf\n\n## Page 1\n\nтекст\n', {
      schema_version: 1,
      pages: [page(0), page(1)],
      blocks: [
        { page_index: 0, ordinal: 1, block_type: 'text' },
        { page_index: 1, ordinal: 1, block_type: 'text' },
      ],
    });

    expect(() => parseSourcePackage(dir)).toThrow(/усечён/u);
  });

  it('страница md, которой нет в blocks.json, — ошибка', () => {
    const dir = packageOf(
      '# Document: syn.pdf\n\n## Page 1\n\nтекст\n\n## Page 5\n\nчужая страница\n',
      {
        schema_version: 1,
        pages: [page(0)],
        blocks: [{ page_index: 0, ordinal: 1, block_type: 'text' }],
      },
    );

    expect(() => parseSourcePackage(dir)).toThrow(/нет в blocks\.json/u);
  });

  it('страница только со stamp-блоками может отсутствовать в md', () => {
    // stamp-блоки не имеют собственных секций в md; страница из одних штампов
    // в md не печатается, и это не усечение.
    const dir = packageOf('# Document: syn.pdf\n\n## Page 1\n\nтекст\n', {
      schema_version: 1,
      pages: [page(0), page(1)],
      blocks: [
        { page_index: 0, ordinal: 1, block_type: 'text' },
        { page_index: 1, ordinal: null, block_type: 'stamp' },
      ],
    });

    const parsed = parseSourcePackage(dir);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.text).toBe('');
  });
});
