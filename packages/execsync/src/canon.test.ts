/**
 * Канонизация §13 — пять пар ловушек, каждая с негативным контролем.
 *
 * Пара «должны совпасть» без пары «должны разойтись» доказывает только то, что
 * функция возвращает константу. Поэтому у каждого правила здесь два теста.
 *
 * Строки в NFD и астральные символы записаны `\u`-эскейпами намеренно: набранные
 * буквами, они нормализуются редактором или системой контроля версий, и тест
 * начинает проверять не то, что написано.
 */
import { describe, expect, it } from 'vitest';

import { canonicalManifestJson, manifestSha256, sealSnapshot } from './canon.js';
import { ExecSyncCanonError } from './safety.js';
import {
  COORDINATE_SPACE,
  EXEC_SYNC_SCHEMA_VERSION,
  SNAPSHOT_MODE,
  type ExecSyncBlock,
  type ExecSyncMetadataValue,
  type ExecSyncSnapshotBody,
} from './wire.js';

function block(overrides: Partial<ExecSyncBlock> = {}): ExecSyncBlock {
  return {
    external_block_id: 'blk-0001',
    revision: 4,
    page_index: 0,
    block_type: 'text',
    shape_type: 'rectangle',
    coords_norm: [0.123456, 0.0821, 0.8579, 0.3445],
    polygon_points: null,
    linked_external_block_id: null,
    display_name: 'Общие указания',
    sort_order: 10,
    force_reprocess: false,
    metadata: {},
    ...overrides,
  };
}

function snapshot(overrides: Partial<ExecSyncSnapshotBody> = {}): ExecSyncSnapshotBody {
  return {
    schema_version: EXEC_SYNC_SCHEMA_VERSION,
    external_sync_id: 'sync-2026-09-04-0001',
    external_project_id: 'idp-object-1',
    project_name: 'Корпус 1',
    external_document_id: 'folder/1f0f2b1e-0000-4000-8000-000000000001',
    document_name: 'АР-01 Планы',
    document_revision: 'R17',
    base_generation: 17,
    sync_generation: 18,
    snapshot_mode: SNAPSHOT_MODE,
    coordinate_space: COORDINATE_SPACE,
    document: {
      file_name: 'AR-01_R17.pdf',
      mime_type: 'application/pdf',
      size_bytes: 18_442_891,
      sha256: 'a'.repeat(64),
      page_count: 28,
    },
    blocks: [block()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Пара 1. Целые против дробных координат
// ---------------------------------------------------------------------------

describe('целые и дробные координаты одного значения', () => {
  it('дают один хеш', () => {
    const integers = snapshot({ blocks: [block({ coords_norm: [0, 0, 1, 1] })] });
    const fractions = snapshot({ blocks: [block({ coords_norm: [0.0, 0.0, 1.0, 1.0] })] });
    expect(manifestSha256(integers)).toBe(manifestSha256(fractions));
  });

  it('печатаются строкой фиксированного формата, а не числом', () => {
    const json = canonicalManifestJson(
      snapshot({ blocks: [block({ coords_norm: [0, 0, 1, 1] })] }),
    );
    expect(json).toContain('"coords_norm":["0.000000","0.000000","1.000000","1.000000"]');
    // Главная ловушка §13 названа прямо: JSON.stringify(1.0) даёт «1», не «1.0».
    expect(json).not.toContain('"coords_norm":[0,0,1,1]');
  });

  it('шестой знак значим, седьмой — нет', () => {
    const base = snapshot({ blocks: [block({ coords_norm: [0.1, 0, 1, 1] })] });
    const beyond = snapshot({ blocks: [block({ coords_norm: [0.1000004, 0, 1, 1] })] });
    const within = snapshot({ blocks: [block({ coords_norm: [0.100001, 0, 1, 1] })] });
    expect(manifestSha256(base)).toBe(manifestSha256(beyond));
    expect(manifestSha256(base)).not.toBe(manifestSha256(within));
  });

  it('целые НЕ-геометрии остаются числами', () => {
    const json = canonicalManifestJson(snapshot());
    expect(json).toContain('"sync_generation":18');
    expect(json).not.toContain('"sync_generation":"18.000000"');
    expect(json).toContain('"page_index":0');
    expect(json).toContain('"sort_order":10');
  });
});

// ---------------------------------------------------------------------------
// Пара 2. NFC против NFD
// ---------------------------------------------------------------------------

/** «Й»: одной кодовой точкой U+0419 и разложенной парой «И» + U+0306. */
const YI_NFC = 'Й';
const YI_NFD = 'Й';

describe('нормализация строк в NFC', () => {
  it('исходные данные теста действительно различны до нормализации', () => {
    expect(YI_NFC).not.toBe(YI_NFD);
    expect(YI_NFD.normalize('NFC')).toBe(YI_NFC);
  });

  it('значение в NFD даёт тот же хеш, что в NFC', () => {
    expect(manifestSha256(snapshot({ project_name: `${YI_NFC}ошкар-Ола` }))).toBe(
      manifestSha256(snapshot({ project_name: `${YI_NFD}ошкар-Ола` })),
    );
  });

  it('ключ metadata в NFD даёт тот же хеш, что в NFC', () => {
    const nfc = snapshot({ blocks: [block({ metadata: { [YI_NFC]: 'да' } })] });
    const nfd = snapshot({ blocks: [block({ metadata: { [YI_NFD]: 'да' } })] });
    expect(manifestSha256(nfc)).toBe(manifestSha256(nfd));
  });

  it('нормализация выполняется ДО сортировки ключей', () => {
    /*
     * Ключ, меняющий место среди соседей при нормализации: разложенная форма
     * «Ǖ» начинается с латинской «U» (U+0055) и стоит ПЕРЕД «Ā» (U+0100), а
     * собранная — это U+01D5 и стоит ПОСЛЕ неё. Отсортировав до нормализации,
     * мы посчитали бы порядок по одним байтам, а напечатали по другим.
     */
    const decomposed = 'Ǖ';
    const composed = 'Ǖ';
    const macronA = 'Ā';
    expect(decomposed.normalize('NFC')).toBe(composed);
    // Контроль исходных данных: до нормализации порядок обратный печатаемому.
    expect([decomposed, macronA].sort()).toEqual([decomposed, macronA]);

    const raw = snapshot({ blocks: [block({ metadata: { [decomposed]: 'a', [macronA]: 'b' } })] });
    const normalized = snapshot({
      blocks: [block({ metadata: { [composed]: 'a', [macronA]: 'b' } })],
    });
    expect(manifestSha256(raw)).toBe(manifestSha256(normalized));

    const json = canonicalManifestJson(raw);
    expect(json.indexOf(macronA)).toBeLessThan(json.indexOf(composed));
  });

  it('схлопывание двух ключей в один после NFC — отказ, а не тихая потеря', () => {
    const collided = snapshot({
      blocks: [block({ metadata: { [YI_NFC]: 'первый', [YI_NFD]: 'второй' } })],
    });
    expect(() => manifestSha256(collided)).toThrow(ExecSyncCanonError);
  });

  it('разные строки остаются разными', () => {
    expect(manifestSha256(snapshot({ project_name: 'Корпус 1' }))).not.toBe(
      manifestSha256(snapshot({ project_name: 'Корпус 2' })),
    );
  });
});

// ---------------------------------------------------------------------------
// Пара 3. Отсутствующее поле против явного null
// ---------------------------------------------------------------------------

describe('удаление null-полей', () => {
  it('явный null и отсутствие поля неразличимы в каноне', () => {
    const withNulls = snapshot({
      blocks: [block({ polygon_points: null, linked_external_block_id: null, display_name: null })],
    });
    const json = canonicalManifestJson(withNulls);
    expect(json).not.toContain('polygon_points');
    expect(json).not.toContain('linked_external_block_id');
    expect(json).not.toContain('display_name');
    expect(json).not.toContain('null');
  });

  it('null внутри metadata удаляется наравне с полями блока', () => {
    const withNull = snapshot({ blocks: [block({ metadata: { a: null, b: 'x' } })] });
    const without = snapshot({ blocks: [block({ metadata: { b: 'x' } })] });
    expect(manifestSha256(withNull)).toBe(manifestSha256(without));
  });

  it('null внутри МАССИВА metadata — отказ: длина массива это данные', () => {
    const list: readonly ExecSyncMetadataValue[] = ['a', null, 'b'];
    const inArray = snapshot({ blocks: [block({ metadata: { list } })] });
    expect(() => manifestSha256(inArray)).toThrow(ExecSyncCanonError);
  });

  it('заполненное поле меняет хеш', () => {
    expect(manifestSha256(snapshot({ blocks: [block({ display_name: null })] }))).not.toBe(
      manifestSha256(snapshot({ blocks: [block({ display_name: 'Общие указания' })] })),
    );
  });
});

// ---------------------------------------------------------------------------
// Пара 4. Перестановки: снимок это множество, полигон — форма
// ---------------------------------------------------------------------------

describe('порядок', () => {
  const first = block({ external_block_id: 'blk-0001' });
  const second = block({ external_block_id: 'blk-0002', page_index: 3 });

  it('порядок блоков в массиве значения не имеет (§6)', () => {
    expect(manifestSha256(snapshot({ blocks: [first, second] }))).toBe(
      manifestSha256(snapshot({ blocks: [second, first] })),
    );
  });

  it('порядок ключей metadata значения не имеет', () => {
    const straight = snapshot({ blocks: [block({ metadata: { a: '1', b: '2' } })] });
    const reversed = snapshot({ blocks: [block({ metadata: { b: '2', a: '1' } })] });
    expect(manifestSha256(straight)).toBe(manifestSha256(reversed));
  });

  it('обмен содержимым между блоками хеш МЕНЯЕТ', () => {
    const swapped = snapshot({
      blocks: [
        block({ external_block_id: 'blk-0001', page_index: 3 }),
        block({ external_block_id: 'blk-0002', page_index: 0 }),
      ],
    });
    expect(manifestSha256(snapshot({ blocks: [first, second] }))).not.toBe(manifestSha256(swapped));
  });

  it('порядок точек полигона значим — он задаёт саму форму', () => {
    const points: [number, number][] = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.5, 0.9],
    ];
    const straight = snapshot({
      blocks: [block({ shape_type: 'polygon', polygon_points: [...points] })],
    });
    const reversed = snapshot({
      blocks: [block({ shape_type: 'polygon', polygon_points: [...points].reverse() })],
    });
    expect(manifestSha256(straight)).not.toBe(manifestSha256(reversed));
  });

  it('дубль external_block_id — отказ: множество не содержит элемент дважды', () => {
    const duplicated = snapshot({ blocks: [first, block({ external_block_id: 'blk-0001' })] });
    expect(() => manifestSha256(duplicated)).toThrow(ExecSyncCanonError);
  });
});

// ---------------------------------------------------------------------------
// Пара 5. Сортировка ключей: не порядок V8 и не порядок UTF-16
// ---------------------------------------------------------------------------

describe('сортировка ключей', () => {
  it('целочисленные ключи не всплывают наверх, как это делает V8', () => {
    const json = canonicalManifestJson(
      snapshot({ blocks: [block({ metadata: { ['10']: 'a', ['9']: 'b' } })] }),
    );
    expect(json).toContain('{"10":"a","9":"b"}');
    // Контроль: движок напечатал бы «9» первым — ради этого текст и собирается вручную.
    expect(JSON.stringify({ ['10']: 'a', ['9']: 'b' })).toBe('{"9":"b","10":"a"}');
  });

  it('ключи сортируются по кодовым точкам, а не по кодовым единицам UTF-16', () => {
    const fullwidth = '＀'; // U+FF00, 65280
    const emoji = '\u{1F600}'; // U+1F600, 128512 — суррогатная пара D83D DE00
    const json = canonicalManifestJson(
      snapshot({ blocks: [block({ metadata: { [fullwidth]: 'a', [emoji]: 'b' } })] }),
    );
    expect(json.indexOf(fullwidth)).toBeLessThan(json.indexOf(emoji));
    // Контроль: `Array.sort()` сравнивает по UTF-16 и даёт обратный порядок.
    expect([fullwidth, emoji].sort()).toEqual([emoji, fullwidth]);
  });

  it('не-ASCII не экранируется', () => {
    const json = canonicalManifestJson(snapshot({ project_name: 'Корпус 1' }));
    expect(json).toContain('"Корпус 1"');
    expect(json).not.toContain('\\u041a');
  });
});

// ---------------------------------------------------------------------------
// Форма результата и предполёт
// ---------------------------------------------------------------------------

describe('sealSnapshot', () => {
  it('добавляет manifest_sha256 и не меняет остальное', () => {
    const body = snapshot();
    const sealed = sealSnapshot(body);
    expect(sealed.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.manifest_sha256).toBe(manifestSha256(body));
    const { manifest_sha256: _hash, ...rest } = sealed;
    expect(rest).toEqual(body);
  });

  it('хеш считается по телу БЕЗ поля manifest_sha256', () => {
    // Проверяется снаружи единственным способом: тело, отличающееся только
    // наличием запечатанного поля, обязано дать тот же хеш.
    const body = snapshot();
    const sealed = sealSnapshot(body);
    const { manifest_sha256: _hash, ...rest } = sealed;
    expect(manifestSha256(rest)).toBe(sealed.manifest_sha256);
  });
});

describe('предполёт metadata', () => {
  it('дробное число — отказ: пороги экспоненты у JS и Python разные', () => {
    const fractional = snapshot({ blocks: [block({ metadata: { ratio: 0.5 } })] });
    expect(() => manifestSha256(fractional)).toThrow(ExecSyncCanonError);
  });

  it('число вне безопасного диапазона — отказ', () => {
    const huge = snapshot({ blocks: [block({ metadata: { big: 1e16 } })] });
    expect(() => manifestSha256(huge)).toThrow(ExecSyncCanonError);
  });

  it('вложенность глубже восьми — отказ (§12)', () => {
    let nested: ExecSyncMetadataValue = 'дно';
    for (let depth = 0; depth < 9; depth += 1) nested = { level: nested };
    const deep = snapshot({ blocks: [block({ metadata: { root: nested } })] });
    expect(() => manifestSha256(deep)).toThrow(ExecSyncCanonError);
  });

  it('metadata тяжелее 4096 байт — отказ (§12)', () => {
    const heavy = snapshot({ blocks: [block({ metadata: { text: 'я'.repeat(3000) } })] });
    expect(() => manifestSha256(heavy)).toThrow(ExecSyncCanonError);
  });

  it('одиночный суррогат — отказ: такую строку нельзя закодировать в UTF-8', () => {
    const broken = snapshot({ project_name: 'Корпус \uD800' });
    expect(() => manifestSha256(broken)).toThrow(ExecSyncCanonError);
  });

  it('целое, булево и строка в metadata законны', () => {
    const ok = snapshot({
      blocks: [block({ metadata: { content_rotation: 90, forced: true, note: 'скан боком' } })],
    });
    expect(manifestSha256(ok)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('бюджет', () => {
  it('снимок на 20 000 блоков канонизируется за разумное время', () => {
    const blocks = Array.from({ length: 20_000 }, (_unused, index) =>
      block({
        external_block_id: `blk-${String(index).padStart(6, '0')}`,
        page_index: Math.floor(index / 10),
      }),
    );
    const started = Date.now();
    expect(manifestSha256(snapshot({ blocks }))).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
