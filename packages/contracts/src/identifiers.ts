/**
 * Контрольные суммы ИНН и ОГРН, формат КПП — ЕДИНСТВЕННАЯ реализация в портале.
 *
 * Модуль лежит в контрактах, а не в API, потому что одну и ту же арифметику
 * обязаны считать три места: вход справочника контрагентов (§3.2), обезличиватель
 * закрытого корпуса (§1.4) и движок правил (§9.2). Пока копий было две — в
 * `apps/api/src/lib/validators.ts` и в обезличивателе — они совпадали до цифры, и
 * именно это делало их опасными: расхождение оказалось бы МОЛЧАЛИВЫМ. §1.4
 * требует, чтобы обезличиватель сохранял валидность или намеренную невалидность
 * реквизита ровно так, как её понимает портал; разойдись веса на один знак —
 * «битый ОГРН» производного корпуса стал бы валидным для проверок, и
 * регрессионный тест на этот дефект перестал бы проверять хоть что-нибудь, не
 * покраснев ни разу.
 *
 * Поэтому наружу выдаётся не только ПРОВЕРКА значения, но и ПОРОЖДЕНИЕ
 * контрольных цифр (`innControlDigits`, `ogrnControlDigit`): обезличивателю нужно
 * строить синтетические значения с верной либо намеренно неверной суммой, и если
 * бы он считал цифру сам, веса и модули снова лежали бы в двух местах. Проверка
 * здесь сама построена на этих же функциях, так что «сошлись» они не по
 * дисциплине автора, а структурно.
 *
 * ## Отказ называет ПРИЧИНУ, а не только факт
 *
 * Веса и модули проверены на реальных значениях корпуса: десять ИНН из актов
 * проходят, пять ОГРН из семи проходят, два не проходят — и это ДВА РАЗНЫХ
 * случая, ради различения которых функции возвращают причину отказа, а не
 * `boolean`:
 *
 * | Класс из корпуса           | Причина             | Что это          | Правило S9     |
 * | -------------------------- | ------------------- | ---------------- | -------------- |
 * | 12 цифр вместо 13          | `length` (12 из 13) | дефект документа | `fail`         |
 * | 13 цифр, сумма не сходится | `checksum`          | дефект OCR       | `undetermined` |
 *
 * Сами значения лежат в `docs/CORPUS_FINDINGS.md` и в исходники не переносятся:
 * реквизиты участников здесь не нужны, и это держит `pnpm pii:scan`. Второе из
 * них вычитано с круглой печати, перекрытой подписью, где тот же OCR прочитал
 * слово «ОГРН» как «ОТРИ». Правило, поднявшее бы здесь `error`, обвинило бы
 * подрядчика в подделке реквизитов. Поэтому «не та длина» и «сумма не сходится»
 * обязаны быть различимы вызывающим кодом, а не сливаться в одно «невалидно».
 *
 * Значение НЕ нормализуется: пробелы, дефисы и неразрывные пробелы дают
 * `non_digits`, а не молча удаляются. Решение «здесь пробел лишний» принимает
 * нормализация извлечённого реквизита, которая видит контекст страницы; проверка
 * контрольной суммы такого контекста не имеет и додумывать за неё не должна.
 */

/**
 * Почему значение отвергнуто.
 *
 * Порядок проверок фиксирован: пустое → посторонние символы → длина → сумма.
 * Первая же несовпавшая ступень и есть причина, потому что следующие на
 * непригодном значении не имеют смысла.
 */
export type IdentifierDefect = 'empty' | 'non_digits' | 'length' | 'checksum';

/** Контрольная цифра: какая должна быть и какая стоит в значении. */
export interface IdentifierChecksum {
  readonly expected: string;
  readonly actual: string;
}

export interface IdentifierAccepted {
  readonly ok: true;
}

export interface IdentifierRejected {
  readonly ok: false;
  readonly defect: IdentifierDefect;
  /**
   * Заполнено только при `defect === 'checksum'`.
   *
   * Нужно тексту замечания: «ожидалась 0, стоит 8» — это то, по чему инженер
   * решает, читать ли реквизит с оригинала заново.
   */
  readonly checksum: IdentifierChecksum | null;
}

/**
 * Тип-сумма, а не `{ valid: boolean; reason?: string }`.
 *
 * При объекте с необязательным полем «причина» забытая ветка давала бы
 * `undefined`, то есть отказ без причины, и правило S9 не смогло бы выбрать
 * между `fail` и `undetermined`. У разъединённого типа причина существует
 * ровно тогда, когда есть отказ.
 */
export type IdentifierCheck = IdentifierAccepted | IdentifierRejected;

/** Веса контрольной цифры ИНН организации: тело — 9 цифр. */
const INN_10_WEIGHTS: readonly number[] = [2, 4, 10, 3, 5, 9, 4, 6, 8];

/** Веса первой контрольной цифры ИНН физического лица: тело — 10 цифр. */
const INN_12_FIRST_WEIGHTS: readonly number[] = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

/** Веса второй: считается по телу ВМЕСТЕ с первой контрольной цифрой — 11 цифр. */
const INN_12_SECOND_WEIGHTS: readonly number[] = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

/**
 * Делитель контрольной цифры ОГРН по длине его тела.
 *
 * У 13-значного ОГРН это 11, у 15-значного ОГРНИП — 13. Смешать их нельзя в обе
 * стороны: правило 13-значного, применённое к ОГРНИП, принимает подделанный
 * последний знак и отвергает настоящий реквизит.
 */
const OGRN_MODULUS: Readonly<Record<number, bigint>> = { 12: 11n, 14: 13n };

const ONLY_DIGITS = /^[0-9]+$/;

const ACCEPTED: IdentifierCheck = { ok: true };

// =====================================================================
// Проверка значения
// =====================================================================

/**
 * ИНН: 10 цифр у организации, 12 у физического лица и ИП.
 *
 * У 12-значного две контрольные цифры, и обе обязательны: значение, прошедшее
 * первую и не прошедшее вторую, отвергается — иначе одна OCR-ошибка в последнем
 * знаке проходила бы насквозь. Цифры сравниваются по очереди, а не парой: в
 * замечании обязана стоять та пара «ожидалась / указана», на которой значение
 * действительно разошлось.
 */
export function checkInn(value: string): IdentifierCheck {
  const shape = checkShape(value, [10, 12]);
  if (shape !== null) return shape;

  if (value.length === 10) {
    return compareControlDigits(innControlDigits(value.slice(0, 9)), value.slice(9));
  }

  const control = innControlDigits(value.slice(0, 10));
  const first = compareControlDigits(control.slice(0, 1), value.slice(10, 11));
  if (!first.ok) return first;

  return compareControlDigits(control.slice(1), value.slice(11));
}

/**
 * ОГРН: 13 цифр у организации, 15 у ИП (ОГРНИП).
 */
export function checkOgrn(value: string): IdentifierCheck {
  const shape = checkShape(value, [13, 15]);
  if (shape !== null) return shape;

  const bodyLength = value.length - 1;
  return compareControlDigits(
    ogrnControlDigit(value.slice(0, bodyLength)),
    value.slice(bodyLength),
  );
}

/**
 * КПП: девять цифр.
 *
 * Контрольной суммы у КПП не существует, поэтому `checkKpp` никогда не вернёт
 * `checksum` — проверить можно только форму. Латинские буквы в 5–6 знаке (код
 * причины постановки на учёт у иностранных организаций) не принимаются
 * намеренно: ровно так же ограничивает значение CHECK
 * `counterparties_kpp_chk`, и расхождение схемы с БД дало бы 500 вместо
 * внятного отказа на границе.
 */
export function checkKpp(value: string): IdentifierCheck {
  const shape = checkShape(value, [9]);
  return shape ?? ACCEPTED;
}

// =====================================================================
// Порождение контрольных цифр
// =====================================================================

/**
 * Контрольные цифры ИНН по его телу: 9 цифр тела дают одну, 10 цифр — две.
 *
 * Возвращается строка, а не число: у 12-значного ИНН контрольных цифр две, и
 * «06» — это не 6.
 *
 * Тело неверной длины или с посторонними символами — ошибка вызывающего, а не
 * значение с плохой суммой, поэтому здесь исключение, а не отказ и не ноль.
 * Молчаливый ноль превратил бы рассогласование в ЛОЖНОЕ подтверждение реквизита:
 * проверка сказала бы «сумма сходится» о значении, которого не считала.
 */
export function innControlDigits(body: string): string {
  requireDigits(body, 'ИНН');

  if (body.length === 9) return weightedDigit(body, INN_10_WEIGHTS);
  if (body.length === 10) {
    const eleventh = weightedDigit(body, INN_12_FIRST_WEIGHTS);
    return eleventh + weightedDigit(body + eleventh, INN_12_SECOND_WEIGHTS);
  }

  throw new RangeError(`Тело ИНН — 9 или 10 цифр, получено ${body.length}`);
}

/**
 * Контрольная цифра ОГРН по его телу: 12 цифр (ОГРН) или 14 (ОГРНИП).
 *
 * Остаток от деления числа, составленного из всех цифр кроме последней, на 11
 * либо 13, взятый по модулю 10. Делимое собирается через `BigInt`: остаток тогда
 * точен при любой длине и не зависит от границы 2^53, за которой целые числа в
 * `Number` перестают быть представимыми. Тело ОГРНИП (14 цифр) в `Number` ещё
 * влезает, но выбор сделан на длину вперёд — внутренние коды и реквизиты ЕАЭС
 * бывают длиннее.
 */
export function ogrnControlDigit(body: string): string {
  requireDigits(body, 'ОГРН');

  const modulus = OGRN_MODULUS[body.length];
  if (modulus === undefined) {
    throw new RangeError(`Тело ОГРН — 12 или 14 цифр, получено ${body.length}`);
  }

  return ((BigInt(body) % modulus) % 10n).toString();
}

// =====================================================================
// Внутреннее
// =====================================================================

/** Пустота, посторонние символы, длина. `null` — форма пригодна. */
function checkShape(value: string, allowedLengths: readonly number[]): IdentifierRejected | null {
  if (value.length === 0) return rejected('empty');
  if (!ONLY_DIGITS.test(value)) return rejected('non_digits');
  if (!allowedLengths.includes(value.length)) return rejected('length');
  return null;
}

function rejected(defect: IdentifierDefect): IdentifierRejected {
  return { ok: false, defect, checksum: null };
}

function requireDigits(body: string, label: string): void {
  if (!ONLY_DIGITS.test(body)) {
    throw new TypeError(`Тело ${label} состоит только из цифр, получено «${body}»`);
  }
}

/**
 * Взвешенная сумма по модулю 11, затем по модулю 10.
 *
 * Число весов равно числу читаемых цифр — это держат проверки длины у обеих
 * порождающих функций, поэтому выхода за строку здесь быть не может.
 */
function weightedDigit(digits: string, weights: readonly number[]): string {
  const sum = weights.reduce<number>(
    (total, weight, index) => total + weight * (digits.charCodeAt(index) - 48),
    0,
  );
  return String((sum % 11) % 10);
}

function compareControlDigits(expected: string, actual: string): IdentifierCheck {
  if (expected === actual) return ACCEPTED;
  return { ok: false, defect: 'checksum', checksum: { expected, actual } };
}
