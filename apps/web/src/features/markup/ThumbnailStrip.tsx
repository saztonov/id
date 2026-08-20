/**
 * Лента миниатюр с бейджами флагов внимания (§7.2, §7.3).
 *
 * Миниатюра — не картинка страницы, а её карточка: номер, формат, поворот, число
 * блоков и флаги. Рендерить 83 страницы в PDF ради ленты нельзя — это восемьдесят
 * три задачи pdf.js на открытие экрана, — а карточка отвечает на тот вопрос, для
 * которого лента и нужна: куда смотреть в первую очередь.
 *
 * Флаг внимания подписан текстом, а не только цветом (§17, accessibility), и
 * назван наблюдением, а не вердиктом: по §5.3 решение принимает пользователь.
 *
 * Список — настоящий `<ul>` с кнопками: страницы обходятся Tab и стрелками,
 * активная помечена `aria-current`. Полоса из `<div onClick>` смотрелась бы так
 * же и была бы недостижима с клавиатуры.
 */
import { type ReactNode } from 'react';
import { Badge, Tooltip } from 'antd';
import type { AttentionFlag } from '@id/contracts';
import type { BundlePage } from '../../api/types.js';
import { ATTENTION_FLAG_LABELS } from '../../shared/labels.js';

/**
 * Бейдж типа страницы на карточке.
 *
 * `manual` подписывается словом «вручную», а не цветом рамки: различение
 * исключительно цветом недоступно, и §17 закрывает это прямо — тем же приёмом,
 * что и флаги внимания ниже.
 */
export interface PageTypeBadge {
  /** Короткое имя вида ИД (`shortName`) либо «продолжение» для I-DOC. */
  readonly text: string;
  /** Метка поставлена вручную, а не выведена конвейером. */
  readonly manual: boolean;
}

export interface ThumbnailStripProps {
  readonly pages: readonly BundlePage[];
  readonly flagsByPage: ReadonlyMap<number, readonly AttentionFlag[]>;
  readonly blockCountByPage: ReadonlyMap<number, number>;
  /** Тип страницы из классификаций; страницы без строки в карте нет. */
  readonly typeByPage: ReadonlyMap<number, PageTypeBadge>;
  readonly current: number;
  readonly onSelect: (workingPageIndex: number) => void;
}

export function ThumbnailStrip(props: ThumbnailStripProps): ReactNode {
  const { pages, flagsByPage, blockCountByPage, typeByPage, current } = props;

  return (
    <nav aria-label="Страницы рабочего документа">
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {pages.map((page) => {
          const flags = flagsByPage.get(page.workingPageIndex) ?? [];
          const blocks = blockCountByPage.get(page.workingPageIndex) ?? 0;
          const pageType = typeByPage.get(page.workingPageIndex);
          const active = page.workingPageIndex === current;
          return (
            <li key={page.workingPageIndex}>
              <button
                type="button"
                onClick={() => props.onSelect(page.workingPageIndex)}
                aria-current={active ? 'page' : undefined}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  cursor: 'pointer',
                  border: active ? '2px solid #1d4ed8' : '1px solid #d9d9d9',
                  borderRadius: 6,
                  background: active ? '#eff4ff' : '#ffffff',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>Стр. {page.workingPageIndex + 1}</strong>
                  <span style={{ color: '#595959' }}>
                    блоков: {blocks}
                    {flags.length > 0 && (
                      <Badge
                        count={flags.length}
                        color="#d4380d"
                        style={{ marginLeft: 6 }}
                        title={`Флагов внимания: ${String(flags.length)}`}
                      />
                    )}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#595959' }}>
                  {page.widthPx}×{page.heightPx}
                  {page.rotation !== 0 && `, поворот ${page.rotation}°`}
                </div>
                <div style={{ fontSize: 12, color: '#595959', overflowWrap: 'anywhere' }}>
                  {page.fileName}, лист {page.filePageIndex + 1}
                </div>
                {pageType !== undefined && (
                  <div
                    data-testid={`page-type-badge-${page.workingPageIndex}`}
                    style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 10,
                        border: '1px solid #91caff',
                        background: '#e6f4ff',
                        color: '#0958d9',
                      }}
                    >
                      {pageType.text}
                    </span>
                    {pageType.manual && (
                      // Признак ручной метки — словом, как и флаги ниже: цветная
                      // рамка без текста читалась бы не всеми и не читалась бы
                      // скринридером вовсе.
                      <span
                        style={{
                          fontSize: 11,
                          padding: '1px 6px',
                          borderRadius: 10,
                          border: '1px solid #b7eb8f',
                          background: '#f6ffed',
                          color: '#135200',
                        }}
                      >
                        вручную
                      </span>
                    )}
                  </div>
                )}
                {flags.length > 0 && (
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: '4px 0 0',
                      padding: 0,
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 4,
                    }}
                  >
                    {flags.map((flag) => (
                      <li key={flag}>
                        <Tooltip title={ATTENTION_FLAG_LABELS[flag]}>
                          <span
                            data-testid={`flag-${flag}`}
                            style={{
                              fontSize: 11,
                              padding: '1px 6px',
                              borderRadius: 10,
                              border: '1px solid #ffa39e',
                              background: '#fff1f0',
                              color: '#a8071a',
                            }}
                          >
                            {ATTENTION_FLAG_LABELS[flag]}
                          </span>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
