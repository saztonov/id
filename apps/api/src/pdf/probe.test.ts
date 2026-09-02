/**
 * Разбор PDF проверяется на НАСТОЯЩИХ байтах.
 *
 * Синтетические фикстуры `tools/fixtures/pdf/` собраны генератором S0 и лежат
 * в репозитории, поэтому проверка не зависит ни от закрытого корпуса, ни от
 * внешних бинарников. Три случая, которых среди фикстур нет — шифрование,
 * объектные потоки и подпись внутри `ObjStm` — собираются здесь вручную
 * побайтово: именно так устроен наблюдаемый корпус (PDF-1.6 с `ObjStm`), и без
 * них разбор был бы проверен только на том, что умеет pdf-lib.
 */
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { evaluatePdfFile, probePdf, sha256Hex } from './probe.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'tools',
  'fixtures',
  'pdf',
);

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const A3_LANDSCAPE_WIDTH = 1190.55;

describe('probePdf на синтетических фикстурах', () => {
  it('multipage: четыре страницы A4 без поворота и без подписи', () => {
    const probe = probePdf(fixture('multipage.pdf'));

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.version).toBe('1.7');
    expect(probe.pageCount).toBe(4);
    for (const page of probe.pages) {
      expect(page.widthPt).toBeCloseTo(A4_WIDTH, 1);
      expect(page.heightPt).toBeCloseTo(A4_HEIGHT, 1);
      expect(page.rotation).toBe(0);
    }
    expect(probe.warnings).toEqual([]);
    expect(probe.signature.result).toBe('none_detected');
    expect(probe.signature.hasByteRange).toBe(false);
    expect(probe.signature.signatureFieldCount).toBe(0);
    expect(probe.signature.incrementalUpdates).toBe(0);
  });

  it('rotated: повороты 0/90/180/270 и разные размеры страниц', () => {
    const probe = probePdf(fixture('rotated.pdf'));

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pages.map((page) => page.rotation)).toEqual([0, 90, 180, 270]);

    // Размеры даны в пост-поворотном фрейме (§7.1): у страниц 90 и 270 стороны
    // меняются местами, и именно эти значения уезжают в source_pages.
    const [first, second, third, fourth] = probe.pages;
    expect(first?.widthPt).toBeCloseTo(A4_WIDTH, 1);
    expect(first?.heightPt).toBeCloseTo(A4_HEIGHT, 1);
    expect(second?.widthPt).toBeCloseTo(A4_HEIGHT, 1);
    expect(second?.heightPt).toBeCloseTo(A4_WIDTH, 1);
    expect(third?.widthPt).toBeCloseTo(A4_WIDTH, 1);
    expect(third?.heightPt).toBeCloseTo(A4_HEIGHT, 1);
    // Четвёртая — A3 альбомный, повёрнутый на 270: ширина и высота меняются.
    expect(fourth?.widthPt).toBeCloseTo(A4_HEIGHT, 1);
    expect(fourth?.heightPt).toBeCloseTo(A3_LANDSCAPE_WIDTH, 1);

    const distinctSizes = new Set(probe.pages.map((page) => `${page.widthPt}x${page.heightPt}`));
    expect(distinctSizes.size).toBeGreaterThan(1);
  });

  it('signed: подпись найдена, но НЕ признана действительной', () => {
    const bytes = fixture('signed.pdf');
    const probe = probePdf(bytes);

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.signature.result).toBe('detected_unverified');
    expect(probe.signature.hasByteRange).toBe(true);
    expect(probe.signature.subFilters).toEqual(['adbe.pkcs7.detached']);
    expect(probe.signature.signatureFieldCount).toBe(1);
    // Подпись накладывается инкрементальным обновлением — второй %%EOF.
    expect(probe.signature.incrementalUpdates).toBe(1);

    // Те же три признака — прямо в байтах фикстуры. Иначе тест утверждал бы
    // лишь самосогласованность зонда: он мог бы отвечать «подпись есть» на
    // файле без единого маркера, и это осталось бы незамеченным.
    const raw = bytes.toString('latin1');
    expect(raw).toContain('/ByteRange');
    expect(raw).toContain('/SubFilter /adbe.pkcs7.detached');
    expect(raw.split('%%EOF').length - 1).toBe(2);
  });

  it('malformed: обрубленный PDF не разбирается', () => {
    const probe = probePdf(fixture('malformed.pdf'));

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe('unparsable');
    // Про подпись такого файла нельзя утверждать ничего.
    expect(probe.signature.result).toBe('unknown');
    expect(probe.signature.probeError).not.toBeNull();
  });

  it('not-a-pdf: нет сигнатуры %PDF-', () => {
    const bytes = fixture('not-a-pdf.pdf');
    expect(bytes.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');

    const probe = probePdf(bytes);

    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe('not_a_pdf');
    expect(probe.signature.result).toBe('unknown');
  });

  /**
   * Решает заголовок, а не содержимое.
   *
   * Исправный PDF, спрятанный за килобайтами мусора, — это уже не PDF: читатели
   * его не откроют, а разбор «где-то в середине нашлось дерево страниц» принял
   * бы в обработку файл, которого пользователь не увидит. Проверка обязана
   * отвергнуть его по магическим байтам, не дойдя до разбора.
   */
  it('исправный PDF за мусорным заголовком отвергается как не-PDF', () => {
    const padded = Buffer.concat([Buffer.alloc(4096, 0x41), fixture('multipage.pdf')]);

    const probe = probePdf(padded);
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe('not_a_pdf');
    // Про страницы и подпись такого файла не утверждается ничего: разбора
    // не было.
    expect(probe.signature.result).toBe('unknown');

    // Контроль на невырожденность проверки: тот же PDF без мусора разбирается.
    expect(probePdf(fixture('multipage.pdf')).ok).toBe(true);
  });

  it('одностраничные фикстуры дают ровно одну страницу', () => {
    for (const name of ['single-1.pdf', 'single-2.pdf', 'single-3.pdf', 'split-part1.pdf']) {
      const probe = probePdf(fixture(name));
      expect(probe.ok, name).toBe(true);
      if (!probe.ok) continue;
      expect(probe.pageCount, name).toBe(1);
    }
  });
});

// =====================================================================
// Собранные вручную случаи, которых нет среди фикстур
// =====================================================================

/** Минимальный PDF из перечисленных объектов и классического трейлера. */
function buildPdf(objects: readonly string[], trailer: string): Buffer {
  let body = '%PDF-1.6\n';
  objects.forEach((object, i) => {
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  body += `trailer\n${trailer}\nstartxref\n0\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/**
 * Зашифрованный PDF: среди фикстур S0 его нет, поэтому он собирается здесь.
 *
 * Генератор фикстур строит документы через pdf-lib, а тот шифрование не пишет.
 * Случай при этом обязателен: файл под паролем портал прочитать не может ни на
 * одном шаге конвейера, и решение о карантине принимается именно по `/Encrypt`.
 */
function encryptedPdf(): Buffer {
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      '<< /Filter /Standard /V 4 /R 4 >>',
    ],
    '<< /Root 1 0 R /Encrypt 4 0 R /Size 5 >>',
  );
}

/**
 * Страница A4 с одной картинкой заданного размера в ресурсах.
 *
 * Пиксели картинки не нужны: разрешение выводится из `/Width` и `/Height`
 * словаря XObject, а поток зонд для этого не читает.
 */
function pageWithImage(
  widthPx: number,
  heightPx: number,
  options: { readonly resourcesOnParent?: boolean } = {},
): Buffer {
  const resources = '/Resources << /XObject << /Im0 4 0 R >> >>';
  const onParent = options.resourcesOnParent === true;
  return buildPdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [3 0 R] /Count 1 ${onParent ? resources : ''} >>`,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ${onParent ? '' : resources} >>`,
      `<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} >>`,
    ],
    '<< /Root 1 0 R /Size 5 >>',
  );
}

function firstPage(bytes: Buffer) {
  const probe = probePdf(bytes);
  expect(probe.ok).toBe(true);
  if (!probe.ok) throw new Error('зонд отверг документ');
  return probe.pages[0];
}

describe('разрешение покрывающего растра', () => {
  it('скан на всю страницу даёт своё разрешение', () => {
    // 1653 / (595/72) = 200.06; 2338 / (842/72) = 199.94 — оси сходятся.
    expect(firstPage(pageWithImage(1653, 2338))?.nativeDpi).toBe(200);
  });

  it('скан в 300 dpi так и остаётся тремястами', () => {
    expect(firstPage(pageWithImage(2480, 3508))?.nativeDpi).toBe(300);
  });

  it('ресурсы наследуются от узла дерева страниц', () => {
    expect(firstPage(pageWithImage(1653, 2338, { resourcesOnParent: true }))?.nativeDpi).toBe(200);
  });

  it('подпись или логотип покрывающим растром не считается', () => {
    // 378 / (595/72) = 45.8 против 65 / (842/72) = 5.6: оси расходятся в восемь
    // раз, и покрыть лист такая картинка не может.
    expect(firstPage(pageWithImage(378, 65))?.nativeDpi).toBeNull();
  });

  it('картинка в две страницы высотой отвергается', () => {
    // 200 dpi по ширине против 400 по высоте — склейка двух листов, а не скан
    // этого.
    expect(firstPage(pageWithImage(1653, 4676))?.nativeDpi).toBeNull();
  });

  it('слишком мелкий растр отвергается, даже когда оси сошлись', () => {
    // 60 / (595/72) = 7.3 и 85 / (842/72) = 7.3: пропорции листа соблюдены, но
    // рендерить страницу в 7 dpi нельзя.
    expect(firstPage(pageWithImage(60, 85))?.nativeDpi).toBeNull();
  });

  it('страница без картинок разрешения не имеет', () => {
    const probe = probePdf(fixture('multipage.pdf'));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pages.every((page) => page.nativeDpi === null)).toBe(true);
  });
});

describe('случаи, которых нет среди фикстур', () => {
  it('зашифрованный файл распознаётся по /Encrypt в трейлере', () => {
    const probe = probePdf(encryptedPdf());
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(probe.reason).toBe('encrypted');
    expect(probe.detail).toMatch(/парол/i);
  });

  /**
   * PDF-1.6 с объектным потоком — форма наблюдаемого корпуса.
   *
   * Каталог и дерево страниц лежат ВНУТРИ сжатого потока, поэтому файл,
   * разбираемый только сканированием тела, дал бы «страниц не найдено».
   */
  it('дерево страниц внутри /ObjStm разбирается', () => {
    const inner = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Rotate 90 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 1191] >>',
    ];
    const offsets: number[] = [];
    let payload = '';
    for (const object of inner) {
      offsets.push(payload.length);
      payload += `${object} `;
    }
    const header = inner.map((_, i) => `${i + 1} ${offsets[i]}`).join(' ') + '\n';
    const uncompressed = Buffer.from(header + payload, 'latin1');
    const compressed = deflateSync(uncompressed);

    const parts = [
      Buffer.from('%PDF-1.6\n', 'latin1'),
      Buffer.from(
        `5 0 obj\n<< /Type /ObjStm /N ${inner.length} /First ${header.length} ` +
          `/Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`,
        'latin1',
      ),
      compressed,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n', 'latin1'),
    ];
    const probe = probePdf(Buffer.concat(parts));

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pageCount).toBe(2);
    expect(probe.pages[0]?.rotation).toBe(90);
    // Поворот 90 меняет стороны местами.
    expect(probe.pages[0]?.widthPt).toBeCloseTo(842, 1);
    expect(probe.pages[0]?.heightPt).toBeCloseTo(595, 1);
    expect(probe.pages[1]?.widthPt).toBeCloseTo(842, 1);
    expect(probe.signature.result).toBe('none_detected');
  });

  it('поле подписи внутри /ObjStm тоже считается найденной подписью', () => {
    const inner = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      '<< /FT /Sig /T (Signature1) >>',
    ];
    const offsets: number[] = [];
    let payload = '';
    for (const object of inner) {
      offsets.push(payload.length);
      payload += `${object} `;
    }
    const header = inner.map((_, i) => `${i + 1} ${offsets[i]}`).join(' ') + '\n';
    const compressed = deflateSync(Buffer.from(header + payload, 'latin1'));

    const probe = probePdf(
      Buffer.concat([
        Buffer.from('%PDF-1.6\n', 'latin1'),
        Buffer.from(
          `5 0 obj\n<< /Type /ObjStm /N 4 /First ${header.length} /Filter /FlateDecode ` +
            `/Length ${compressed.length} >>\nstream\n`,
          'latin1',
        ),
        compressed,
        Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
      ]),
    );

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    // ByteRange в байтах нет — но поле подписи есть, и молчать о нём нельзя.
    expect(probe.signature.hasByteRange).toBe(false);
    expect(probe.signature.signatureFieldCount).toBe(1);
    expect(probe.signature.result).toBe('detected_unverified');
  });

  it('инкрементальное обновление не теряет переопределённый объект', () => {
    const base = buildPdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
      ],
      '<< /Root 1 0 R /Size 4 >>',
    );
    const update = Buffer.from(
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n' +
        '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] >>\nendobj\n' +
        'trailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n0\n%%EOF\n',
      'latin1',
    );

    const probe = probePdf(Buffer.concat([base, update]));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pageCount).toBe(2);
    expect(probe.pages[1]?.widthPt).toBeCloseTo(200, 1);
    expect(probe.signature.incrementalUpdates).toBe(1);
  });

  it('байты потока не порождают фантомных объектов', () => {
    // Внутри данных потока лежит текст, который сканер принял бы за объект,
    // если бы не перепрыгивал через содержимое потока по /Length.
    const trap = '9 0 obj\n<< /Type /Page /MediaBox [0 0 10 10] >>\nendobj\n';
    const pdf = Buffer.from(
      '%PDF-1.6\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' +
        `4 0 obj\n<< /Length ${trap.length} >>\nstream\n${trap}\nendstream\nendobj\n` +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    );

    const probe = probePdf(pdf);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.pageCount).toBe(1);
    expect(probe.pages[0]?.widthPt).toBeCloseTo(595, 1);
  });
});

// =====================================================================
// Политика приёмки
// =====================================================================

describe('evaluatePdfFile', () => {
  const policy = { maxBytes: 10_000_000, maxPages: 500 };

  it('исправный файл принимается вместе с геометрией и sha256', () => {
    const bytes = fixture('multipage.pdf');
    const verdict = evaluatePdfFile(bytes, { ...policy, expectedSha256: sha256Hex(bytes) });

    expect(verdict.state).toBe('ok');
    if (verdict.state !== 'ok') return;
    expect(verdict.pageCount).toBe(4);
    expect(verdict.pages).toHaveLength(4);
  });

  it('расхождение sha256 отправляет файл в карантин', () => {
    const verdict = evaluatePdfFile(fixture('multipage.pdf'), {
      ...policy,
      expectedSha256: 'f'.repeat(64),
    });

    expect(verdict.state).toBe('quarantined');
    if (verdict.state !== 'quarantined') return;
    expect(verdict.reason).toBe('hash_mismatch');
  });

  it('превышение лимита страниц отправляет файл в карантин', () => {
    const verdict = evaluatePdfFile(fixture('multipage.pdf'), { ...policy, maxPages: 3 });

    expect(verdict.state).toBe('quarantined');
    if (verdict.state !== 'quarantined') return;
    expect(verdict.reason).toBe('too_many_pages');
    expect(verdict.detail).toContain('4');
  });

  it('зашифрованный PDF уходит в карантин, а не в обработку', () => {
    const verdict = evaluatePdfFile(encryptedPdf(), policy);

    expect(verdict.state).toBe('quarantined');
    if (verdict.state !== 'quarantined') return;
    expect(verdict.reason).toBe('encrypted');
    // Причина обязана быть отличима от «повреждён»: пользователю нужно снять
    // пароль, а не переделывать скан.
    expect(verdict.detail).toMatch(/парол/i);
    // sha256 считается и у карантинного файла: он остаётся виден подрядчику.
    expect(verdict.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('исправный PDF за мусорным заголовком тоже уходит в карантин', () => {
    const verdict = evaluatePdfFile(
      Buffer.concat([Buffer.alloc(4096, 0x41), fixture('multipage.pdf')]),
      policy,
    );

    expect(verdict.state).toBe('quarantined');
    if (verdict.state !== 'quarantined') return;
    expect(verdict.reason).toBe('not_a_pdf');
  });

  it('не-PDF и повреждённый PDF уходят в карантин с разными причинами', () => {
    const notPdf = evaluatePdfFile(fixture('not-a-pdf.pdf'), policy);
    const malformed = evaluatePdfFile(fixture('malformed.pdf'), policy);

    expect(notPdf.state === 'quarantined' && notPdf.reason).toBe('not_a_pdf');
    expect(malformed.state === 'quarantined' && malformed.reason).toBe('unparsable');
  });

  it('чужой MIME отвергается до разбора', () => {
    const verdict = evaluatePdfFile(fixture('multipage.pdf'), {
      ...policy,
      declaredMime: 'image/png',
    });

    expect(verdict.state).toBe('quarantined');
    if (verdict.state !== 'quarantined') return;
    expect(verdict.reason).toBe('unsupported_mime');
  });

  it('превышение размера отвергается до разбора', () => {
    const verdict = evaluatePdfFile(fixture('multipage.pdf'), { ...policy, maxBytes: 10 });

    expect(verdict.state).toBe('quarantined');
    if (verdict.state !== 'quarantined') return;
    expect(verdict.reason).toBe('too_large');
  });
});
