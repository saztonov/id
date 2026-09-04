/**
 * Разбор результата блока RD WEB.
 *
 * Главное утверждение файла — не «поля переложились», а «штамп собирается ТЕМИ
 * ЖЕ правилами, что на маршруте VLM». Разойдись они, один и тот же штамп давал
 * бы два разных канонических штампа, и сравнение провайдеров потеряло бы смысл.
 */
import { describe, expect, it } from 'vitest';

import type { ExecBlockResultRow } from '../../integrations/rdweb-exec/port.js';
import { mapStampResponse } from '../vlm/map.js';
import { mapExecBlockResult, type ExecMapContext } from './map.js';

const CONTEXT: ExecMapContext = {
  layoutBlockId: '11111111-1111-4111-8111-111111111111',
  blockType: 'text',
  sortOrder: 3,
  coordsNorm: [0.1, 0.2, 0.8, 0.5],
};

function row(overrides: Partial<ExecBlockResultRow> = {}): ExecBlockResultRow {
  return {
    externalBlockId: 'blk-000007',
    externalBlockRevision: 2,
    status: 'success',
    isDeleted: false,
    reconciliationAction: 'recognition_required',
    reconciliationReason: ['new_block'],
    reusedWithoutModel: false,
    ocrMarkdown: null,
    ocrText: null,
    ocrJson: null,
    resultStatus: 'ok',
    updatedAt: null,
    ...overrides,
  };
}

describe('текстовый блок', () => {
  it('markdown читается первым', () => {
    const outcome = mapExecBlockResult(
      row({ ocrMarkdown: '# Общие указания', ocrText: 'запасной' }),
      CONTEXT,
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'text') throw new Error('не текст');
    expect(outcome.block.text).toBe('# Общие указания');
    // Структуры нет — и это `null`, а не пустой список: «структуры нет» и
    // «структура есть и пуста» в каноне различаются.
    expect(outcome.block.fragments).toBeNull();
  });

  it('без markdown берётся ocr_text', () => {
    const outcome = mapExecBlockResult(row({ ocrText: 'простой текст' }), CONTEXT);
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'text') throw new Error('не текст');
    expect(outcome.block.text).toBe('простой текст');
  });

  it('пустой блок — состояние, а не ошибка', () => {
    const outcome = mapExecBlockResult(row(), CONTEXT);
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'text') throw new Error('не текст');
    expect(outcome.block.text).toBe('');
  });

  it('внешний идентификатор блока попадает в канон, модель — нет', () => {
    const outcome = mapExecBlockResult(row({ ocrText: 'x' }), CONTEXT);
    if (outcome.kind !== 'ok') throw new Error('не ok');
    expect(outcome.block.blockId).toBe('blk-000007');
    expect(outcome.block.layoutBlockId).toBe(CONTEXT.layoutBlockId);
    expect(outcome.block.ordinal).toBe(3);
    // Модель выбирает RD WEB и не называет её: `null` честнее выдуманного слага.
    expect(outcome.block.modelId).toBeNull();
    expect(outcome.block.confidence).toBeNull();
  });
});

describe('картинка', () => {
  const imageJson = {
    fragment_type: 'План',
    location: { grid_lines: '5.А-5.К', zone_name: null, level_or_elevation: '+3,300' },
    content_summary: 'План этажа',
    detailed_description: 'Подробности',
    verification_recommendations: '',
    key_entities: ['А1', 'Б2'],
  };

  it('раскладывается по каноническим полям', () => {
    const outcome = mapExecBlockResult(row({ ocrJson: imageJson }), {
      ...CONTEXT,
      blockType: 'image',
    });
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'image')
      throw new Error('не картинка');
    expect(outcome.block.image.imageType).toBe('План');
    expect(outcome.block.image.axes).toBe('5.А-5.К');
    expect(outcome.block.image.level).toBe('+3,300');
    expect(outcome.block.image.entities).toEqual(['А1', 'Б2']);
    // Пустая строка рекомендаций — «причины проверять нет», в каноне это null.
    expect(outcome.block.image.verification).toBeNull();
  });

  it('незнакомый fragment_type не роняет блок', () => {
    const outcome = mapExecBlockResult(
      row({ ocrJson: { ...imageJson, fragment_type: 'Изометрия' } }),
      { ...CONTEXT, blockType: 'image' },
    );
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'image')
      throw new Error('не картинка');
    expect(outcome.block.image.imageType).toBe('Не определено');
  });

  it('лишнее поле в ocr_json не роняет блок', () => {
    const outcome = mapExecBlockResult(row({ ocrJson: { ...imageJson, unknown_field_v2: 42 } }), {
      ...CONTEXT,
      blockType: 'image',
    });
    expect(outcome.kind).toBe('ok');
  });

  it('структурный блок без ocr_json — unmappable, а не текстовый фолбэк', () => {
    const outcome = mapExecBlockResult(row({ ocrMarkdown: 'текст' }), {
      ...CONTEXT,
      blockType: 'image',
    });
    expect(outcome.kind).toBe('unmappable');
  });
});

describe('штамп', () => {
  const stampJson = {
    document_code: 'СТ26/01-14-ДК2-РД',
    project_name: 'Корпус 14.5',
    sheet_name: 'План перекрытия',
    stage: 'РД',
    sheet_number: '3',
    total_sheets: '12',
    organization: 'ООО «Проект»',
    signatures: [{ role: 'ГИП', surname: 'Иванов', date: '01.02.2026' }],
    revisions: [{ change_num: '1', doc_num: 'И-1', date: '03.03.2026' }],
  };

  it('собирается ТЕМИ ЖЕ правилами, что на маршруте VLM', () => {
    const outcome = mapExecBlockResult(row({ ocrJson: stampJson }), {
      ...CONTEXT,
      blockType: 'stamp',
    });
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'stamp') throw new Error('не штамп');

    const viaVlm = mapStampResponse(
      { ...stampJson, sheet_code: null },
      {
        layoutBlockId: CONTEXT.layoutBlockId,
        sortOrder: CONTEXT.sortOrder,
        coordsNorm: CONTEXT.coordsNorm,
        modelId: null,
        blockId: 'blk-000007',
      },
    );
    expect(outcome.block).toEqual(viaVlm);
  });

  it('sheetCode отсутствует: у RD WEB такого поля нет, и выдумывать его нельзя', () => {
    const outcome = mapExecBlockResult(row({ ocrJson: stampJson }), {
      ...CONTEXT,
      blockType: 'stamp',
    });
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'stamp') throw new Error('не штамп');
    expect(outcome.block.stamp.sheetCode).toBeNull();
    // Остальное при этом на месте — потери одного поля, а не блока.
    expect(outcome.block.stamp.code).toBe('СТ26/01-14-ДК2-РД');
    expect(outcome.block.stamp.sheet).toBe('3 из 12');
  });

  it('если поле однажды появится — оно будет прочитано', () => {
    const outcome = mapExecBlockResult(
      row({ ocrJson: { ...stampJson, sheet_code: 'К14/ДК2-СЦ4' } }),
      { ...CONTEXT, blockType: 'stamp' },
    );
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'stamp') throw new Error('не штамп');
    expect(outcome.block.stamp.sheetCode).toBe('К14/ДК2-СЦ4');
  });

  it('подписи уходят в extra по правилам VLM-пути', () => {
    const outcome = mapExecBlockResult(row({ ocrJson: stampJson }), {
      ...CONTEXT,
      blockType: 'stamp',
    });
    if (outcome.kind !== 'ok' || outcome.block.blockType !== 'stamp') throw new Error('не штамп');
    expect(outcome.block.stamp.extra['signature_1']).toBe('ГИП — Иванов, 01.02.2026');
  });
});
