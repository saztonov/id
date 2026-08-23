/**
 * Список блоков страницы с чекбоксами и фильтром (§7.2).
 *
 * Это не дублирование канвы, а второй полноценный путь к тем же действиям.
 * Элементы Konva живут в `<canvas>` и недостижимы ни для фокуса, ни для
 * скринридера, поэтому «выделить несколько», «сменить тип», «удалить» обязаны
 * работать здесь — с клавиатуры, чекбоксами и настоящими кнопками. Без этого
 * редактор блоков не проходит accessibility-часть гейта §17, каким бы удобным он
 * ни был мышью.
 *
 * Фильтр применяется к списку и НЕ применяется к канве. Так и должно быть:
 * скрытая на канве рамка означала бы, что пользователь рисует поверх блока,
 * которого не видит.
 */
import { type ReactNode } from 'react';
import { Checkbox, Empty, Segmented, Space, Switch, Typography } from 'antd';
import type { BlockType } from '@id/contracts';
import type { LayoutBlock } from '../../api/types.js';
import { BLOCK_STYLES, describeBlock, type BlockFilter } from './blocks.js';
import { PROVENANCE_LABELS } from '../../shared/labels.js';

export interface BlockListProps {
  readonly blocks: readonly LayoutBlock[];
  readonly visible: readonly LayoutBlock[];
  readonly ranks: ReadonlyMap<string, number>;
  readonly selection: ReadonlySet<string>;
  readonly filter: BlockFilter;
  readonly onFilterChange: (patch: Partial<BlockFilter>) => void;
  readonly onToggle: (blockId: string) => void;
  readonly onSelectMany: (blockIds: readonly string[]) => void;
}

const ALL_TYPES: readonly BlockType[] = ['text', 'image', 'stamp'];

export function BlockList(props: BlockListProps): ReactNode {
  const { blocks, visible, ranks, selection, filter } = props;
  const allVisibleSelected =
    visible.length > 0 && visible.every((block) => selection.has(block.id));

  return (
    <section aria-label="Блоки страницы">
      <Typography.Title level={2} style={{ fontSize: 15, marginTop: 0 }}>
        Блоки страницы: {blocks.length}
      </Typography.Title>

      <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
        <Segmented<string>
          size="small"
          value={filter.types.length === ALL_TYPES.length ? 'all' : (filter.types[0] ?? 'all')}
          onChange={(value) => {
            props.onFilterChange({
              types: value === 'all' ? ALL_TYPES : ([value] as BlockType[]),
            });
          }}
          options={[
            { label: 'Все типы', value: 'all' },
            ...ALL_TYPES.map((type) => ({ label: BLOCK_STYLES[type].label, value: type })),
          ]}
          aria-label="Фильтр списка по типу блока"
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch
            size="small"
            checked={filter.onlyManual}
            onChange={(checked) => props.onFilterChange({ onlyManual: checked })}
          />
          <span>Только правленные вручную</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Switch
            size="small"
            checked={filter.onlySelected}
            onChange={(checked) => props.onFilterChange({ onlySelected: checked })}
          />
          <span>Только выделенные</span>
        </label>
      </Space>

      {visible.length === 0 ? (
        <Empty
          description={
            blocks.length === 0 ? 'На странице нет блоков' : 'Фильтр скрыл все блоки страницы'
          }
        />
      ) : (
        <>
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={!allVisibleSelected && visible.some((b) => selection.has(b.id))}
            onChange={(event) => {
              props.onSelectMany(event.target.checked ? visible.map((block) => block.id) : []);
            }}
            style={{ marginBottom: 8 }}
          >
            Выделить показанные ({visible.length})
          </Checkbox>

          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map((block) => {
              const rank = ranks.get(block.id) ?? 0;
              const style = BLOCK_STYLES[block.blockType];
              return (
                <li
                  key={block.id}
                  style={{
                    padding: '6px 8px',
                    borderLeft: `4px solid ${style.stroke}`,
                    background: selection.has(block.id) ? '#f0f5ff' : 'transparent',
                    marginBottom: 4,
                  }}
                >
                  <Checkbox
                    checked={selection.has(block.id)}
                    onChange={() => props.onToggle(block.id)}
                    aria-label={describeBlock(block, rank)}
                  >
                    <span data-testid={`block-row-${block.id}`}>{describeBlock(block, rank)}</span>
                  </Checkbox>
                  <div style={{ fontSize: 12, color: '#595959', paddingLeft: 24 }}>
                    {PROVENANCE_LABELS[block.detectorProvenance]}
                    {/*
                      Уверенность показывается только когда она есть. У ручных
                      блоков и у блоков от легаси-API RD WEB её нет, и рисовать
                      там ноль значило бы утверждать «детектор не был уверен»
                      про блок, который детектор вообще не создавал.
                    */}
                    {block.detectionScore !== null &&
                      `, уверенность ${block.detectionScore.toFixed(2)}`}
                    {block.shapeType === 'polygon' && ', полигон'}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
