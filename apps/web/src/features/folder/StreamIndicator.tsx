/**
 * Чем сейчас держится свежесть экрана ревизии (§3.8).
 *
 * Показывать это обязательно, и вот почему: поток и опрос дают внешне
 * одинаковый результат — данные обновляются, — но по-разному ведут себя при
 * отказе. Экран, который потерял поток и молча перешёл на опрос раз в пять
 * секунд, неотличим от экрана, который потерял и то и другое. Пользователь,
 * ждущий окончания распознавания, обязан видеть разницу между «обновляется
 * сейчас» и «обновится, когда я нажму».
 *
 * Состояние названо словом, а не только цветом: различение исключительно цветом
 * не проходит §17.
 */
import { type ReactNode } from 'react';
import { Button, Space, Tooltip } from 'antd';
import { ToneTag, type Tone } from '../../shared/tags.js';
import { useFolderStream, type StreamStatus } from './stream.js';

const LABELS: Record<StreamStatus, string> = {
  connecting: 'поток подключается',
  live: 'поток событий',
  reconnecting: 'поток восстанавливается',
  lost: 'поток потерян, идёт опрос',
};

/**
 * Тон намеренно спокойный у «живого» и заметный у «потерянного»: нормальная
 * работа не должна кричать, а деградация — должна.
 */
const TONES: Record<StreamStatus, Tone> = {
  connecting: 'neutral',
  live: 'success',
  reconnecting: 'warning',
  lost: 'danger',
};

export function StreamIndicator(): ReactNode {
  const stream = useFolderStream();
  if (stream === null) return null;

  const hint =
    stream.status === 'live'
      ? `Принято событий: ${String(stream.received)}. Последний номер: ${
          stream.lastEventId === null ? 'ещё не приходил' : String(stream.lastEventId)
        }. Опрос выключен: состояние обновляют события.`
      : `Свежесть держится опросом раз в 5 с. ${
          stream.error === null ? '' : `Причина разрыва: ${stream.error}. `
        }Попыток подряд: ${String(stream.attempts)}.`;

  return (
    <Space size={6} wrap>
      <Tooltip title={hint}>
        <span>
          <ToneTag tone={TONES[stream.status]} testId="stream-status">
            {LABELS[stream.status]}
          </ToneTag>
        </span>
      </Tooltip>
      {stream.truncated && (
        <Tooltip title="Часть ленты событий уже вне окна хранения. Состояние перечитано целиком по REST, но история событий за пропущенный период неполна.">
          <ToneTag tone="warning" testId="stream-truncated">
            лента обрывалась
          </ToneTag>
        </Tooltip>
      )}
      {stream.status === 'lost' && (
        <Button size="small" onClick={stream.reconnect} data-testid="stream-reconnect">
          Подключить заново
        </Button>
      )}
    </Space>
  );
}
