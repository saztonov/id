/**
 * Синтетические PDF-фикстуры для CI.
 *
 * Эти файлы не содержат персональных данных и коммитятся в репозиторий,
 * поэтому критические тесты (повороты, повреждённые файлы, шифрование,
 * межфайловый документ, неизвестный тип документа) выполняются всегда,
 * а не пропускаются при отсутствии закрытого корпуса.
 *
 * Генерация детерминирована: одинаковый вход даёт побайтово одинаковый
 * выход, иначе фикстуры шумели бы в git при каждом перегенерировании.
 */
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

/** Фиксированная дата: pdf-lib иначе пишет текущее время в метаданные. */
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/** A4 в пунктах (72 dpi). */
const A4: readonly [number, number] = [595.28, 841.89];
/** A3 альбомный — проверка смены формата внутри одного файла. */
const A3_LANDSCAPE: readonly [number, number] = [1190.55, 841.89];

export interface PageSpec {
  /** Заголовок документа, по которому работают якорные правила сегментации. */
  readonly title?: string;
  /** Строки тела страницы. */
  readonly body?: readonly string[];
  /** Поворот страницы: проверка пересчёта coords_norm в пост-поворотном фрейме. */
  readonly rotate?: 0 | 90 | 180 | 270;
  /** Размер страницы. */
  readonly size?: readonly [number, number];
}

async function buildDocument(pages: readonly PageSpec[], title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('id-portal fixtures');
  pdf.setCreator('id-portal fixtures');
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (const spec of pages) {
    const [w, h] = spec.size ?? A4;
    const page = pdf.addPage([w, h]);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));

    let y = h - 60;
    if (spec.title) {
      page.drawText(spec.title, { x: 50, y, size: 14, font, color: rgb(0, 0, 0) });
      y -= 30;
    }
    for (const line of spec.body ?? []) {
      page.drawText(line, { x: 50, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
      y -= 16;
    }
  }

  return pdf.save({ useObjectStreams: false });
}

/**
 * Латиница в кириллических по смыслу заголовках — вынужденная мера:
 * StandardFonts не содержит кириллических глифов, а тащить шрифтовой
 * файл в репозиторий ради фикстур избыточно. Якорные правила проверяются
 * на текстовом уровне отдельными unit-тестами, здесь важна структура PDF.
 */
export const FIXTURES = {
  /** Многостраничный «скан-подобный» комплект: акт, реестр, сертификат. */
  async multipage(): Promise<Uint8Array> {
    return buildDocument(
      [
        { title: 'AKT osvidetelstvovaniya skrytyh rabot', body: ['No 01-TEST', 'Page 1 of 2'] },
        { title: '', body: ['p.3 Pri vypolnenii rabot primeneny', 'Page 2 of 2'] },
        { title: 'Reestr prilozheniy No 1', body: ['1 | Sertifikat | No A-1 | OOO Test'] },
        {
          title: 'SERTIFIKAT SOOTVETSTVIYA',
          body: ['No A-1', 'Srok deystviya s 01.01.2025 po 01.01.2028'],
        },
      ],
      'multipage',
    );
  },

  /** Разные форматы и повороты в одном файле. */
  async rotated(): Promise<Uint8Array> {
    return buildDocument(
      [
        { title: 'Portrait 0', body: ['rotation 0'] },
        { title: 'Landscape 90', body: ['rotation 90'], rotate: 90 },
        { title: 'Portrait 180', body: ['rotation 180'], rotate: 180 },
        { title: 'A3 landscape 270', body: ['rotation 270'], rotate: 270, size: A3_LANDSCAPE },
      ],
      'rotated',
    );
  },

  /** Первая половина документа, продолжающегося в другом файле. */
  async splitPart1(): Promise<Uint8Array> {
    return buildDocument(
      [{ title: 'PROTOKOL ob ispytaniyah', body: ['No P-1', 'List 1 iz 2'] }],
      'split-part1',
    );
  },

  /** Вторая половина: продолжение без собственного заголовка. */
  async splitPart2(): Promise<Uint8Array> {
    return buildDocument([{ body: ['List 2 iz 2', 'Vyvod: sootvetstvuet'] }], 'split-part2');
  },

  /**
   * Документ типа, которого намеренно нет в каталоге (§0.5 плана).
   * Проверяет поведение в открытом мире: резервный тип, запись в кандидаты,
   * отсутствие ложных ошибок.
   */
  async unknownType(): Promise<Uint8Array> {
    return buildDocument(
      [
        {
          title: 'AKT GIDRAVLICHESKOGO ISPYTANIYA TRUBOPROVODOV',
          body: ['No GI-77 ot 12.05.2026', 'Davlenie 1.0 MPa, vyderzhka 10 min'],
        },
      ],
      'unknown-type',
    );
  },

  /** Одностраничные файлы, вместе образующие один логический документ. */
  async singlePage(n: number): Promise<Uint8Array> {
    return buildDocument([{ title: `Skan ${n}`, body: [`List ${n} iz 3`] }], `single-${n}`);
  },
} as const;

/**
 * Ожидаемый текст страниц по каждой фикстуре — то, что вернул бы OCR.
 *
 * Тесты сегментации работают именно с ним, а не с байтами PDF: содержимое
 * страницы в PDF лежит в сжатом потоке, и искать в нём подстроку нельзя.
 * Здесь текст кириллический, как в реальных документах, — в самом PDF он
 * латиницей только потому, что StandardFonts не имеет кириллических глифов.
 */
export const FIXTURE_TEXTS: Readonly<Record<string, readonly string[]>> = {
  multipage: [
    'АКТ\nосвидетельствования скрытых работ\n№ 01-TEST\nЛист 1 из 2',
    'п.3 При выполнении работ применены\nЛист 2 из 2',
    'Реестр приложений №1 к акту АОСР № 01-TEST\n| 1 | Сертификат | №A-1 | ООО "Тест" |',
    'СЕРТИФИКАТ СООТВЕТСТВИЯ\n№ A-1\nСрок действия с 01.01.2025 по 01.01.2028',
  ],
  rotated: ['Портрет 0', 'Альбом 90', 'Портрет 180', 'A3 альбом 270'],
  'split-part1': ['ПРОТОКОЛ об испытаниях\n№ P-1\nЛист 1 из 2'],
  'split-part2': ['Лист 2 из 2\nВывод: соответствует'],
  // Тип, которого намеренно нет в каталоге: проверка поведения в открытом мире.
  'unknown-type': [
    'АКТ ГИДРАВЛИЧЕСКОГО ИСПЫТАНИЯ ТРУБОПРОВОДОВ\n№ ГИ-77 от 12.05.2026\nДавление 1,0 МПа, выдержка 10 мин',
  ],
  'single-1': ['Скан 1\nЛист 1 из 3'],
  'single-2': ['Скан 2\nЛист 2 из 3'],
  'single-3': ['Скан 3\nЛист 3 из 3'],
} as const;

/** Заведомо повреждённый PDF: корректная сигнатура, обрубленное тело. */
export function malformedPdf(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.6\n1 0 obj\n<< /Type /Catalog');
}

/** Не-PDF с расширением .pdf: проверка контроля magic bytes. */
export function notAPdf(): Uint8Array {
  return new TextEncoder().encode('Это обычный текст, а не PDF.');
}

/**
 * PDF со словарём подписи и `ByteRange`.
 *
 * Собирается вручную, а не через pdf-lib: нужен именно инкрементальный
 * апдейт со вторым `%%EOF` и прямым (не в ObjStm) словарём подписи —
 * ровно то, что ищет структурный детектор. Криптографически подпись
 * недействительна, и это правильно: детектор обязан вернуть
 * `detected_unverified`, а не `valid`.
 */
export async function signedPdf(): Promise<Uint8Array> {
  const base = await buildDocument([{ title: 'Signed document', body: ['test'] }], 'signed');
  const baseText = Buffer.from(base).toString('latin1');

  const increment =
    '\n' +
    '100 0 obj\n' +
    '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ' +
    `/ByteRange [0 ${base.length} ${base.length + 200} 200] ` +
    '/Contents <308006092A864886F70D010702A0803080020101> >>\n' +
    'endobj\n' +
    'trailer\n<< /Root 1 0 R >>\n' +
    `startxref\n${base.length}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(baseText + increment, 'latin1'));
}
