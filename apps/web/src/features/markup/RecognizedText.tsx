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
 * ## Почему это отдельная КОЛОНКА, а не сворачиваемая панель под картинкой
 *
 * Прежде текст жил в `Collapse` под канвой, внутри той же колонки. Сверять
 * прочитанное с листом приходилось прокруткой: страница и текст не помещались в
 * поле зрения одновременно — то есть работа, ради которой панель и заведена,
 * требовала попеременно смотреть то туда, то сюда по памяти.
 *
 * Собственный `Collapse` вместе с переездом снят: сворачивать текст внутри
 * сворачиваемой колонки — два механизма на одно действие, и человек, свернувший
 * внутренний, увидел бы пустую колонку без объяснения. Колонку целиком убирает
 * кнопка в панели вида.
 *
 * ## Текст показывается КАК ЕСТЬ
 *
 * Без markdown-рендера: он же лежит в `page_text_versions` и адресуется
 * смещениями (`utf16-code-unit`), по которым §8.4 указывает цитаты.
 * Отрисованный markdown сдвинул бы то, что человек сверяет глазами с
 * доказательством.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { Alert, Spin, Typography } from 'antd';

import type { PageText } from '../../api/types.js';

const MONO: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  // Высоту задаёт колонка, а не число: прежние `32vh` были догадкой о том,
  // сколько места останется под канвой, — а места под канвой больше нет.
  flex: '1 1 0',
  minHeight: 0,
  overflowY: 'auto',
  // Горизонтальный потолок остаётся страховкой. Прежняя его причина исчезла
  // (панель `Splitter` не даёт содержимому раздувать колонку по построению), но
  // `pre-wrap` по-прежнему даёт max-content по самой длинной строке, и строка
  // без потолка стала бы проблемой при первой же смене `overflow` у панели.
  maxWidth: '100%',
};

const COLUMN: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  padding: '4px 8px',
  gap: 6,
};

/**
 * Секция текста выделенного блока: доля колонки, а не доля окна.
 *
 * Потолок нужен — иначе длинный блок вытеснил бы текст страницы, ради которого
 * колонка и заведена. Считается он в процентах от КОЛОНКИ (у `COLUMN` задана
 * `height: 100%`), а не в `vh`: доля окна была бы догадкой о высоте колонки,
 * ровно той, от которой этот файл уже однажды избавился.
 */
const BLOCK_SECTION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  maxHeight: '40%',
};

export interface RecognizedTextProps {
  /** Текст страницы последнего завершённого прогона; `null` — прогона нет. */
  readonly text: PageText | null;
  /**
   * Текст ЕДИНСТВЕННОГО выделенного блока; `null` — выделен не один или текста нет.
   *
   * Прежде текст каждого блока стоял в списке блоков справа. Списка больше нет —
   * выбор блока, смена типа и удаление уехали в панель инструментов, — но
   * возможность сверить прочитанное с ОДНОЙ рамкой осталась здесь: проверяют
   * всегда тот блок, чью рамку сейчас правят.
   */
  readonly blockText: { readonly title: string; readonly text: string } | null;
  /** Номер страницы для человека: в отдельной колонке заголовок без него безадресен. */
  readonly pageNumber: number;
  readonly loading: boolean;
  /** Есть ли вообще завершённый прогон распознавания у ревизии. */
  readonly hasRun: boolean;
}

export function RecognizedText(props: RecognizedTextProps): ReactNode {
  return (
    <section style={COLUMN} aria-label="Распознанный текст страницы">
      {props.blockText !== null && (
        // Текст блока стоит НАД текстом страницы: это ответ на вопрос «что
        // прочитано в рамке, которую я держу», и он теряет смысл, если за ним
        // надо прокручивать страницу целиком.
        <section
          aria-label="Распознанный текст выделенного блока"
          data-testid="selected-block-text"
          style={BLOCK_SECTION}
        >
          {/*
            Подпись блока — жирный текст, а не заголовок: она стоит НАД `h2`
            колонки, и заголовок третьего уровня перед вторым сломал бы порядок
            заголовков, который проверяет гейт доступности. Имя у секции есть —
            оно в `aria-label`.
          */}
          <Typography.Text strong style={{ fontSize: 13 }}>
            {props.blockText.title}
          </Typography.Text>
          <pre style={MONO}>{props.blockText.text}</pre>
        </section>
      )}
      <Typography.Title level={2} style={{ fontSize: 14, margin: 0 }}>
        Распознанный текст страницы {props.pageNumber}
      </Typography.Title>
      <RecognizedTextBody {...props} />
    </section>
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
