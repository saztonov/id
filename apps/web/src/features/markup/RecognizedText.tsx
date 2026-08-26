/**
 * Распознанный текст страницы на вкладке «Разметка».
 *
 * ## Зачем он здесь, а не только в артефактах прогона
 *
 * Разметка отвечает на вопрос «что портал считает блоком», а распознавание — на
 * вопрос «что он в этом блоке прочитал». Пока второй ответ лежал только в
 * артефактах прогона, любая проверка качества требовала выгрузки файла: увидеть,
 * что штамп схемы прочитан без номера, было негде. Экран, показывающий рамки без
 * текста, заставляет доверять распознаванию вслепую.
 *
 * ## Источник — последний ЗАВЕРШЁННЫЙ прогон, и это сказано вслух
 *
 * Берётся последний прогон со статусом `done`. Прогон в режиме dry-run тоже
 * завершается честным `done`, но ничего не публикует, поэтому пустой ответ здесь
 * — законное состояние, а не сбой: панель говорит «текста нет», а не показывает
 * пустоту, неотличимую от неработающего запроса.
 *
 * Текст показывается КАК ЕСТЬ, без markdown-рендера: он же лежит в
 * `page_text_versions` и адресуется смещениями (`utf16-code-unit`), по которым
 * §8.4 указывает цитаты. Отрисованный markdown сдвинул бы то, что человек
 * сверяет глазами с доказательством.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { Alert, Collapse, Spin, Typography } from 'antd';

import type { PageText } from '../../api/types.js';

const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  maxHeight: '32vh',
  overflowY: 'auto',
  // Горизонтального потолка тоже нет по умолчанию: `pre-wrap` даёт max-content по
  // самой длинной строке текста, и без `maxWidth` эта строка раздувала колонку
  // разметки — распознанный текст решал, стоит ли картинка рядом с лентой
  // страниц или под ней.
  maxWidth: '100%',
};

export interface RecognizedTextProps {
  /** Текст страницы последнего завершённого прогона; `null` — прогона нет. */
  readonly text: PageText | null;
  readonly loading: boolean;
  /** Есть ли вообще завершённый прогон распознавания у ревизии. */
  readonly hasRun: boolean;
}

export function RecognizedText(props: RecognizedTextProps): ReactNode {
  return (
    <Collapse
      size="small"
      style={{ marginTop: 12 }}
      defaultActiveKey={['text']}
      items={[
        {
          key: 'text',
          label: 'Распознанный текст страницы',
          children: <RecognizedTextBody {...props} />,
        },
      ]}
    />
  );
}

function RecognizedTextBody(props: RecognizedTextProps): ReactNode {
  if (props.loading) return <Spin size="small" />;

  if (!props.hasRun) {
    return (
      <Typography.Text type="secondary">
        Распознавание ещё не выполнялось: текста для этой страницы нет.
      </Typography.Text>
    );
  }

  if (props.text === null) {
    // Прогон был, а страницы в нём нет: либо она не попала в распознавание,
    // либо прогон шёл в режиме dry-run и ничего не публиковал.
    return (
      <Alert
        type="info"
        showIcon
        message="Последний прогон не оставил текста этой страницы"
        description="Так бывает, если страница не участвовала в прогоне или прогон шёл без публикации результата (dry-run)."
      />
    );
  }

  if (props.text.textMd.trim() === '') {
    return (
      <Typography.Text type="secondary">
        Страница распознана, но текста в ней не найдено.
      </Typography.Text>
    );
  }

  return <pre style={MONO}>{props.text.textMd}</pre>;
}
