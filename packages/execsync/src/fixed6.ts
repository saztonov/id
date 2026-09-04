/**
 * Рендер числа геометрии строкой с шестью знаками после точки (§13, правило 1).
 *
 * ## Почему не `toFixed(6)`
 *
 * Потому что `toFixed` — это не `%.6f`, и расхождение не теоретическое.
 * Спецификация ECMAScript предписывает `toFixed` выбирать при равенстве
 * БОЛЬШЕЕ по модулю значение (round-half-away-from-zero), а `printf("%.6f")` в
 * C и `'%.6f' %` в Python округляют половину К ЧЁТНОМУ. На двоичных «половинках»
 * они дают разные строки:
 *
 * | значение          | `toFixed(6)` | `'%.6f'`   |
 * | ----------------- | ------------ | ---------- |
 * | 0.0078125 (1/128) | 0.007813     | 0.007812   |
 * | 0.0390625 (5/128) | 0.039063     | 0.039062   |
 * | 0.0234375 (3/128) | 0.023438     | 0.023438   |
 *
 * Расхождение «через одну», и значения достижимы: нормированная координата
 * рождается делением пикселя на размер страницы (`rect.x / size.width`), а на
 * ширине, кратной степени двойки, такое частное точное. Один такой блок в
 * комплекте — и `manifest_sha256` не сойдётся, а отказ будет выглядеть как
 * «сервер капризничает».
 *
 * Второй, более тихий дефект `toFixed`: она работает не с точным двоичным
 * значением, а с его десятичным приближением, и на границах ведёт себя
 * неинтуитивно (`(1.005).toFixed(2) === '1.00'`). Здесь этого быть не должно —
 * хеш обязан считаться от того числа, которое лежит в памяти.
 *
 * ## Как считается
 *
 * Любой конечный double точно равен `sig * 2^e` с целыми `sig` и `e`. Значит
 * `value * 10^6` — точная рациональная дробь, и округлить её можно в целых
 * числах BigInt, без единого промежуточного double. Это не оптимизация, а
 * единственный способ получить тот же результат, что и `printf`, который тоже
 * работает с точным значением.
 */

/**
 * Правило округления при РОВНОЙ половине.
 *
 * `half_even` — поведение `printf("%.6f")` в C и Python, и именно оно
 * предполагается §13. Значение вынесено константой, потому что подтверждения от
 * команды RD WEB пока нет (эталонные примеры не переданы): если десять эталонных
 * случаев скажут иначе, правка стоит одной строки, а не переписывания модуля.
 */
export const TIE_BREAK: 'half_even' | 'half_away_from_zero' = 'half_even';

/** Знаков после точки в канонической проекции координат. */
export const GEOMETRY_SCALE = 6;

const SCALE_FACTOR = 10n ** BigInt(GEOMETRY_SCALE);

/** Ошибка непригодного для хеширования числа: отказ ДО отправки, а не молча. */
export class ExecSyncNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecSyncNumberError';
  }
}

const BITS = new DataView(new ArrayBuffer(8));

/**
 * Точное разложение конечного double на `sig * 2^e` с целыми `sig >= 0` и `e`.
 *
 * Читается из битов, а не выводится через `Math.frexp`-подобные операции: любое
 * промежуточное вычисление в double вернуло бы нас к той же приблизительности,
 * ради ухода от которой всё это и написано.
 */
function decompose(value: number): { sign: number; sig: bigint; exp: number } {
  BITS.setFloat64(0, value);
  const raw = BITS.getBigUint64(0);
  const sign = raw >> 63n === 1n ? -1 : 1;
  const biased = Number((raw >> 52n) & 0x7ffn);
  const fraction = raw & 0xf_ffff_ffff_ffffn;

  // Субнормальные: неявной единицы нет, показатель фиксирован.
  if (biased === 0) return { sign, sig: fraction, exp: -1074 };
  return { sign, sig: fraction | (1n << 52n), exp: biased - 1075 };
}

/**
 * `value * 10^6`, округлённое до целого по правилу `TIE_BREAK`.
 *
 * Возвращает модуль: знак применяется при печати, чтобы правило «ровно половина»
 * не зависело от того, с какой стороны нуля лежит число (у `half_even` не
 * зависит, у `half_away_from_zero` — тоже, но выражено это должно быть явно).
 */
function scaledMagnitude(sig: bigint, exp: number): bigint {
  if (sig === 0n) return 0n;

  // Показатель неотрицателен — дробной части нет вовсе, округлять нечего.
  if (exp >= 0) return sig * (1n << BigInt(exp)) * SCALE_FACTOR;

  const denominator = 1n << BigInt(-exp);
  const numerator = sig * SCALE_FACTOR;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  const twice = remainder * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;

  // Ровно половина — единственное место, где правила расходятся.
  if (TIE_BREAK === 'half_away_from_zero') return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/**
 * Число геометрии в канонической форме: ровно шесть знаков после точки.
 *
 * `-0` и всякое значение, округлившееся до нуля с отрицательной стороны, дают
 * `0.000000`: §13 требует этого прямо, и без нормализации одинаковая геометрия
 * давала бы два разных хеша.
 */
export function fixed6(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ExecSyncNumberError(
      `координата обязана быть конечным числом, получено ${String(value)}`,
    );
  }

  const { sign, sig, exp } = decompose(value);
  const magnitude = scaledMagnitude(sig, exp);
  const whole = magnitude / SCALE_FACTOR;
  const fraction = magnitude % SCALE_FACTOR;
  const digits = `${whole.toString()}.${fraction.toString().padStart(GEOMETRY_SCALE, '0')}`;

  // Минус ставится только у по-настоящему отрицательного результата.
  return sign < 0 && magnitude !== 0n ? `-${digits}` : digits;
}
