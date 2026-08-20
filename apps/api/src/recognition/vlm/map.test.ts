/**
 * Маппинг ответов VLM → канонические блоки: тождественность text-пути,
 * переименования image-полей и правила сборки штампа.
 */
import { describe, expect, it } from 'vitest';

import {
  ADAPTER_VERSION_OPENROUTER_VLM,
  mapImageResponse,
  mapStampResponse,
  mapTextResponse,
  type VlmBlockContext,
} from './map.js';
import type { VlmStampResponse } from './schemas.js';

const context: VlmBlockContext = {
  layoutBlockId: '0b3f6f66-5cc7-4a56-8d2f-2a53a1f00001',
  sortOrder: 4,
  coordsNorm: [0.1, 0.2, 0.9, 0.4],
  modelId: 'qwen/qwen3-vl-235b-a22b-instruct',
};

function stamp(patch: Partial<VlmStampResponse>): VlmStampResponse {
  return {
    document_code: null,
    project_name: null,
    sheet_name: null,
    stage: null,
    sheet_number: null,
    total_sheets: null,
    organization: null,
    signatures: [],
    revisions: [],
    ...patch,
  };
}

describe('map: общая идентичность блока', () => {
  it('layoutBlockId/ordinal/coords/modelId переносятся, confidence и blockId — null', () => {
    const block = mapTextResponse({ fragments: [] }, context);

    expect(block).toMatchObject({
      blockType: 'text',
      blockId: null,
      layoutBlockId: context.layoutBlockId,
      ordinal: 4,
      coordsNorm: [0.1, 0.2, 0.9, 0.4],
      confidence: null,
      modelId: context.modelId,
    });
  });

  it('версия адаптера VLM-пути зафиксирована', () => {
    expect(ADAPTER_VERSION_OPENROUTER_VLM).toBe('openrouter-vlm.v1');
  });
});

describe('map: text', () => {
  it('фрагменты становятся каноном (таблица вкладывается), text — рендер', () => {
    const block = mapTextResponse(
      {
        fragments: [
          { kind: 'heading', level: 2, text: 'Ведомость' },
          { kind: 'paragraph', text: '1. Пункт', emphasis: 'none' },
          { kind: 'table', title: null, header: ['А', 'Б'], rows: [['1', '2']] },
        ],
      },
      context,
    );

    expect(block.fragments).toEqual([
      { kind: 'heading', level: 2, text: 'Ведомость' },
      { kind: 'paragraph', text: '1. Пункт', emphasis: 'none' },
      { kind: 'table', table: { header: ['А', 'Б'], rows: [['1', '2']], title: null } },
    ]);
    expect(block.text).toBe(
      '## Ведомость\n\n1. Пункт\n\n| А | Б |\n| --- | --- |\n| 1 | 2 |',
    );
    expect(block.features).toBeNull();
  });

  it('пустой ответ — пустой текст и ПУСТОЙ (не null) список фрагментов', () => {
    const block = mapTextResponse({ fragments: [] }, context);
    expect(block.text).toBe('');
    expect(block.fragments).toEqual([]);
  });
});

describe('map: image', () => {
  it('переименования полей RD WEB → канон; verification "" → null', () => {
    const block = mapImageResponse(
      {
        fragment_type: 'Схема стояков',
        location: { grid_lines: '5.А-5.К', zone_name: 'ИТП', level_or_elevation: null },
        content_summary: 'Схема стояков В1.',
        detailed_description: 'Стояки В1-1…В1-4.',
        verification_recommendations: '   ',
        key_entities: ['В1-1', 'DN50'],
      },
      context,
    );

    expect(block.image).toEqual({
      imageType: 'Схема стояков',
      axes: '5.А-5.К',
      zone: 'ИТП',
      level: null,
      summary: 'Схема стояков В1.',
      description: 'Стояки В1-1…В1-4.',
      entities: ['В1-1', 'DN50'],
      verification: null,
    });
  });

  it('непустая рекомендация сохраняется дословно', () => {
    const block = mapImageResponse(
      {
        fragment_type: 'Не определено',
        location: { grid_lines: null, zone_name: null, level_or_elevation: null },
        content_summary: '',
        detailed_description: '',
        verification_recommendations: 'Проверить обрезанную ось справа.',
        key_entities: [],
      },
      context,
    );
    expect(block.image.verification).toBe('Проверить обрезанную ось справа.');
  });
});

describe('map: stamp', () => {
  it('полный штамп: sheet «N из M», revisions строкой, signatures в extra', () => {
    const block = mapStampResponse(
      stamp({
        document_code: 'СТ26/01-14-АР5-3-РД',
        project_name: 'Жилой дом',
        sheet_name: 'План на отм. 0,000',
        stage: 'РД',
        sheet_number: '3',
        total_sheets: '12',
        organization: 'ООО «Проект»',
        signatures: [
          { role: 'Разраб.', surname: 'Иванов', date: '05.26' },
          { role: null, surname: 'Петров', date: null },
        ],
        revisions: [
          { change_num: '1', doc_num: 'И-25', date: '04.26' },
          { change_num: '2', doc_num: null, date: null },
        ],
      }),
      context,
    );

    expect(block.stamp).toEqual({
      code: 'СТ26/01-14-АР5-3-РД',
      stage: 'РД',
      sheet: '3 из 12',
      object: 'Жилой дом',
      name: 'План на отм. 0,000',
      organization: 'ООО «Проект»',
      revisions: '1 И-25 04.26; 2',
      extra: {
        signature_1: 'Разраб. — Иванов, 05.26',
        signature_2: 'Петров',
      },
    });
  });

  it('sheet: только номер — «N»; оба null — null', () => {
    expect(mapStampResponse(stamp({ sheet_number: '7' }), context).stamp.sheet).toBe('7');
    expect(mapStampResponse(stamp({}), context).stamp.sheet).toBeNull();
  });

  it('total_sheets без номера листа уходит в extra, а не в выдуманный sheet', () => {
    const block = mapStampResponse(stamp({ total_sheets: '12' }), context);
    expect(block.stamp.sheet).toBeNull();
    expect(block.stamp.extra).toEqual({ total_sheets: '12' });
  });

  it('пустой список revisions — null; полностью пустые строки пропускаются', () => {
    expect(mapStampResponse(stamp({}), context).stamp.revisions).toBeNull();
    const onlyEmptyRows = stamp({
      revisions: [{ change_num: null, doc_num: null, date: '' }],
    });
    expect(mapStampResponse(onlyEmptyRows, context).stamp.revisions).toBeNull();
  });

  it('подписи: пустые части опускаются, пустые строки не создают ключей', () => {
    const block = mapStampResponse(
      stamp({
        signatures: [
          { role: null, surname: null, date: null },
          { role: 'ГИП', surname: null, date: '05.26' },
        ],
      }),
      context,
    );
    // Нумерация по порядку эмита — без дыры от пустой первой строки.
    expect(block.stamp.extra).toEqual({ signature_1: 'ГИП, 05.26' });
  });

  it('пустой штамп: все скаляры null, extra пустой', () => {
    const block = mapStampResponse(stamp({}), context);
    expect(block.stamp).toEqual({
      code: null,
      stage: null,
      sheet: null,
      object: null,
      name: null,
      organization: null,
      revisions: null,
      extra: {},
    });
  });
});
