/**
 * Тесты синтетических фикстур.
 *
 * Их задача — гарантировать, что фикстуры действительно обладают теми
 * свойствами, ради которых созданы. Иначе тесты более поздних этапов
 * будут «зелёными» на данных, которые ничего не проверяют.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { FIXTURES, FIXTURE_TEXTS, malformedPdf, notAPdf, signedPdf } from './synthetic.js';

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

describe('синтетические PDF-фикстуры', () => {
  it('генерация детерминирована', async () => {
    const a = await FIXTURES.multipage();
    const b = await FIXTURES.multipage();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('обычный PDF не содержит признаков подписи — как в реальном корпусе', async () => {
    const s = latin1(await FIXTURES.multipage());
    expect(s).not.toContain('/ByteRange');
    expect(s).not.toContain('/SubFilter');
    expect(s.match(/%%EOF/g)).toHaveLength(1);
  });

  it('подписанный PDF даёт все структурные признаки для детектора', async () => {
    const s = latin1(await signedPdf());
    expect(s).toMatch(/\/ByteRange\s*\[/);
    expect(s).toContain('/SubFilter /adbe.pkcs7.detached');
    expect(s).toMatch(/\/Type\s*\/Sig/);
    // Подпись всегда накладывается инкрементальным обновлением → второй %%EOF.
    expect((s.match(/%%EOF/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('файл с поворотами содержит все четыре ориентации и смену формата', async () => {
    const s = latin1(await FIXTURES.rotated());
    for (const angle of [90, 180, 270]) {
      expect(s).toMatch(new RegExp(`/Rotate\\s+${angle}`));
    }
    // A3 альбомный шире A4 — проверяем, что размеры страниц различаются.
    const boxes = [...s.matchAll(/\/MediaBox\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s/g)].map((m) =>
      Number(m[1]),
    );
    expect(new Set(boxes).size).toBeGreaterThan(1);
  });

  it('документ неизвестного типа — валидный одностраничный PDF', async () => {
    // Содержимое страницы лежит в сжатом потоке, поэтому проверяем структуру,
    // а текст для сегментации берётся из FIXTURE_TEXTS.
    const pdf = await PDFDocument.load(await FIXTURES.unknownType());
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('unknown-type');
  });

  it('текст неизвестного типа не совпадает ни с одним якорем каталога', () => {
    const text = FIXTURE_TEXTS['unknown-type']?.[0] ?? '';
    expect(text).toContain('ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ');
    // Ни один якорь известных типов не должен срабатывать на этом документе,
    // иначе фикстура не проверяет поведение в открытом мире.
    const knownAnchors = [
      /освидетельствования\s+скрытых\s+работ/i,
      /СЕРТИФИКАТ\s+СООТВЕТСТВИЯ/i,
      /ДЕКЛАРАЦИЯ\s+О\s+СООТВЕТСТВИИ/i,
      /ПАСПОРТ\s+КАЧЕСТВА/i,
      /ПРОТОКОЛ\s+(об\s+)?испытани[йя]/i,
      /Реестр\s+приложений/i,
    ];
    for (const re of knownAnchors) expect(text).not.toMatch(re);
  });

  it('текстовые фикстуры покрывают все PDF-фикстуры с содержанием', () => {
    for (const name of ['multipage', 'split-part1', 'split-part2', 'unknown-type']) {
      expect(FIXTURE_TEXTS[name], `нет текста для ${name}`).toBeDefined();
    }
    // Многостраничный комплект: у каждой страницы PDF есть свой текст.
    expect(FIXTURE_TEXTS['multipage']).toHaveLength(4);
  });

  it('повреждённый файл имеет сигнатуру PDF, но не имеет EOF', () => {
    const s = latin1(malformedPdf());
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s).not.toContain('%%EOF');
  });

  it('не-PDF не имеет сигнатуры — проверка magic bytes', () => {
    expect(latin1(notAPdf()).startsWith('%PDF-')).toBe(false);
  });
});
