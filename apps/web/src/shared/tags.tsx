/**
 * Метки состояний с контрастом, проходящим WCAG AA (§17).
 *
 * ## Почему пресеты antd не годятся
 *
 * `<Tag color="orange">` даёт текст `#d46b08` на подложке `#fff7e6` — 3.33:1 при
 * требуемых 4.5:1; `color="green"` — `#389e0d` на `#f6ffed`, 3.9:1. Гейт §17
 * ловит это как нарушение `color-contrast`, и правильно ловит: метка состояния
 * не украшение. По ней читают, подтверждён документ или нет, жив ли поток
 * событий, действует ли версия набора правил — и читать её обязано быть можно.
 *
 * Открытие сделано на S11 на экране проверки (важность замечания) и здесь
 * обобщено: один словарь тонов вместо повторения шестнадцатеричных кодов по
 * экранам. Рассыпанные по месту вызова цвета разъезжаются — одно и то же
 * состояние получает два оттенка, и «зелёный» перестаёт значить одно и то же.
 *
 * ## Тон называет смысл, а не цвет
 *
 * `success`, а не `green`: смысл переживает смену палитры, а название цвета —
 * нет. Каждая метка при этом несёт ТЕКСТ: различение исключительно цветом
 * недоступно примерно восьми процентам мужчин, и §17 закрывает это прямо.
 */
import type { ReactNode } from 'react';
import { Tag } from 'antd';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

interface ToneStyle {
  readonly color: string;
  readonly background: string;
  readonly borderColor: string;
}

/**
 * Палитра тонов.
 *
 * Текст взят на два-три шага темнее пресета antd при той же подложке: это
 * поднимает контраст выше 4.5:1, сохраняя узнаваемость цвета. Значения
 * проверяются гейтом §17 на четырёх экранах, а не «на глаз».
 */
export const TONE_STYLES: Record<Tone, ToneStyle> = {
  neutral: { color: '#262626', background: '#fafafa', borderColor: '#d9d9d9' },
  info: { color: '#0958d9', background: '#e6f4ff', borderColor: '#91caff' },
  success: { color: '#135200', background: '#f6ffed', borderColor: '#b7eb8f' },
  warning: { color: '#873800', background: '#fff7e6', borderColor: '#ffd591' },
  danger: { color: '#a8071a', background: '#fff1f0', borderColor: '#ffa39e' },
  accent: { color: '#22075e', background: '#f9f0ff', borderColor: '#d3adf7' },
};

export function ToneTag({
  tone,
  children,
  testId,
}: {
  tone: Tone;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  return (
    <Tag style={TONE_STYLES[tone]} {...(testId === undefined ? {} : { 'data-testid': testId })}>
      {children}
    </Tag>
  );
}
