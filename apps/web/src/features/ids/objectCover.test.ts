/**
 * Обложка объекта: буквы и контраст палитры.
 *
 * Проверка контраста стоит здесь, а не в гейте доступности, и это не дублирование.
 * `linear-gradient` — это `background-image`, и правило `color-contrast` в axe
 * возвращает на нём `incomplete`, а прогон §17 смотрит только `violations`. То
 * есть автоматика обложку НЕ проверяет ни при каком старании, и требование
 * «белые буквы читаются на любом цвете» без этого теста осталось бы комментарием
 * над таблицей — то есть договорённостью, которую первая же правка палитры
 * молча нарушит.
 *
 * Порог взят строгий, 4.5:1, хотя буквы на карточке набраны 22px полужирным и
 * считаются крупным текстом с порогом 3:1. Запас нужен на смену кегля: уменьшить
 * буквы — правка одного числа в разметке, и она не должна ронять читаемость.
 */
import { describe, expect, it } from 'vitest';
import { COVER_STOPS, coverGradient, objectInitials } from './objectCover.js';

/** Относительная яркость по WCAG 2.1 (та же формула, что у axe). */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

/** Контраст цвета с белым: белым набраны буквы обложки. */
function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

describe('палитра обложек', () => {
  it('на каждом стопе белые буквы держат 4.5:1', () => {
    const failing = COVER_STOPS.flat()
      .map((hex) => ({ hex, contrast: contrastWithWhite(hex) }))
      .filter((stop) => stop.contrast < 4.5)
      .map((stop) => `${stop.hex} = ${stop.contrast.toFixed(2)}:1`);

    expect(failing).toEqual([]);
  });

  it('не содержит повторяющихся цветов', () => {
    const stops = COVER_STOPS.flat();
    expect(new Set(stops).size).toBe(stops.length);
  });

  it('нижний стоп темнее верхнего — градиент направлен, а не случаен', () => {
    for (const [top, bottom] of COVER_STOPS) {
      expect(luminance(bottom), `${top} → ${bottom}`).toBeLessThan(luminance(top));
    }
  });
});

describe('coverGradient', () => {
  it('детерминирован: один код — один цвет', () => {
    expect(coverGradient('zil18')).toBe(coverGradient('zil18'));
  });

  it('не зависит от регистра: код объекта им не различается', () => {
    expect(coverGradient('ZIL18')).toBe(coverGradient('zil18'));
  });

  /**
   * Главное, ради чего таблица заменила формулу портала смет: та считала оттенок
   * по первому символу и красила все коды одной стройки одинаково.
   */
  it('разводит коды одной стройки по разным цветам', () => {
    const codes = ['zil18', 'zil19', 'zil27'];
    expect(new Set(codes.map(coverGradient)).size).toBe(codes.length);
  });

  it('принимает кириллический код: контракт допускает любые буквы', () => {
    expect(coverGradient('ЖК1')).toMatch(
      /^linear-gradient\(135deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)$/u,
    );
  });
});

describe('objectInitials', () => {
  it.each([
    ['ЖК ЗИЛАРТ лот18,19,27', 'ЖЗ'],
    ['Останкино', 'ОС'],
    ['ЖК «Символ», корпус 4', 'ЖС'],
    ['Детский сад №7', 'ДС'],
    ['Nagatino i-Land', 'NI'],
    ['  двойные   пробелы  ', 'ДП'],
  ])('%s → %s', (name, expected) => {
    expect(objectInitials(name)).toBe(expected);
  });

  /** Цифра опознавательным знаком не работает: она повторяется у половины объектов. */
  it('пропускает слова, начинающиеся с цифры', () => {
    expect(objectInitials('1-я очередь строительства')).toBe('ЯО');
  });

  it('обходится с наименованием без букв', () => {
    expect(objectInitials('123')).toBe('1');
  });

  it('не падает на пустом наименовании', () => {
    expect(objectInitials('   ')).toBe('?');
  });
});
