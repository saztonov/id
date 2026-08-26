/**
 * Нормализация номера документа (§8.3).
 *
 * Проверки контрольных сумм ИНН и ОГРН покрыты в `apps/api/src/lib/validators.test.ts`
 * и `tools/fixtures/src/anonymize.test.ts` на значениях корпуса; здесь — только
 * `normalizeDocNo`, у которой своя, независимая от арифметики ответственность.
 *
 * Значения синтетические всюду, кроме эталонной пары форм одной декларации:
 * она приведена в §8.3 плана и в `docs/CORPUS_FINDINGS.md` как обоснование
 * фолдинга, реквизитом участника не является и в списке маркеров `pii:scan`
 * не состоит.
 */

import { describe, expect, it } from 'vitest';
import { normalizeDocNo } from './identifiers.js';

/** Первая форма: после `Д-` латиница, орган сертификации тоже латиницей. */
const DECLARATION_LATIN = 'РОСС RU Д-RU.PA01.B.17254/23';

/** Вторая форма того же номера: после `Д-` кириллица. */
const DECLARATION_CYRILLIC = 'РОСС RU Д-РУ.РА01.В.17254/23';

describe('normalizeDocNo', () => {
  it('сохраняет исходное значение дословно', () => {
    expect(normalizeDocNo(' № 16005 ').raw).toBe(' № 16005 ');
  });

  it('убирает пробелы, «№» и кавычки, поднимает регистр', () => {
    expect(normalizeDocNo('№ 79 825').normalized).toBe('79825');
    expect(normalizeDocNo('«АБС00000730»').normalized).toBe('АБС00000730');
    expect(normalizeDocNo('ru.mcc.240.445.38406').normalized).toBe('RU.MCC.240.445.38406');
  });

  it('приводит тире всех начертаний к дефису', () => {
    const forms = ['ГИ‑77', 'ГИ–77', 'ГИ—77', 'ГИ−77', 'ГИ-77'];
    const normalized = new Set(forms.map((form) => normalizeDocNo(form).normalized));

    expect([...normalized]).toEqual(['ГИ-77']);
  });

  it('сохраняет точки и слэши: ими разделены значащие поля номера', () => {
    // Без точек `230126/2/126000477.1.1` и `230126/2/1260004771 11` слились бы
    // в одно значение, и два разных паспорта считались бы одним документом.
    expect(normalizeDocNo('№ 230126/2/126000477.1.1').normalized).toBe('230126/2/126000477.1.1');
  });

  it('точка с запятой на месте переноса строки не разводит один номер на два', () => {
    // OCR ставит `;` там, где в ячейке был перенос строки. До починки
    // `RU.MCC.240;.445.38406` и `RU.MCC.240.445.38406` были разными номерами,
    // и строка реестра получала `missing` при документе, лежащем в комплекте.
    expect(normalizeDocNo('№RU.MCC.240;.445.38406').normalized).toBe('RU.MCC.240.445.38406');
    expect(normalizeDocNo('№RU.MCC.240;.445.38406').normalized).toBe(
      normalizeDocNo('№RU.MCC.240.445.38406').normalized,
    );
    // Фолдинг тоже обязан сойтись: сверка сначала пробует точное сравнение,
    // затем folded, и разойдись они здесь — второй путь остался бы закрыт.
    expect(normalizeDocNo('№ 16033; ').folded).toBe(normalizeDocNo('№16033').folded);
  });

  it('точки и слэши по-прежнему различают номера: выброшена только `;`', () => {
    // Отрицательный контроль к предыдущему: расширение списка выбрасываемых
    // символов легко превращается в схлопывание разных номеров в один.
    expect(normalizeDocNo('230126/2/126000477.1.1').normalized).not.toBe(
      normalizeDocNo('230126/2/126000477.11').normalized,
    );
  });

  it('хвостовая пунктуация снимается, внутренняя — нет', () => {
    // На листе исполнительной схемы напечатано «…схемы № 001.», и точка
    // кончает предложение, а не номер: строка реестра «ИС №001» не находила
    // документ ни одной ступенью лестницы.
    expect(normalizeDocNo('001.').normalized).toBe('001');
    expect(normalizeDocNo('001.').normalized).toBe(normalizeDocNo('№ 001').normalized);
    // Внутренняя точка значаща и остаётся на месте.
    expect(normalizeDocNo('RU.MCC.240.445.38406.').normalized).toBe('RU.MCC.240.445.38406');
    expect(normalizeDocNo('230126/2/126000477.1.1').normalized).toBe('230126/2/126000477.1.1');
  });

  it('дословная форма хвостовую пунктуацию сохраняет', () => {
    // `raw` показывается человеку и обязан совпадать с листом.
    expect(normalizeDocNo('001.').raw).toBe('001.');
  });

  it('пустая строка не является особым случаем', () => {
    expect(normalizeDocNo('')).toEqual({ raw: '', normalized: '', folded: '' });
  });

  describe('фолдинг гомоглифов', () => {
    it('две формы одной декларации различны в normalized и совпадают в folded', () => {
      const latin = normalizeDocNo(DECLARATION_LATIN);
      const cyrillic = normalizeDocNo(DECLARATION_CYRILLIC);

      // Это и есть эталон §8.3: точное сравнение обязано их РАЗЛИЧАТЬ,
      // иначе теряется различие «нашли точно» и «нашли через фолдинг»,
      // а сравнение после фолдинга — СВОДИТЬ, иначе документ, который в
      // комплекте лежит, получает `missing`.
      expect(latin.normalized).not.toBe(cyrillic.normalized);
      expect(latin.folded).toBe(cyrillic.folded);
    });

    it('фолдинг идёт в латиницу и не трогает буквы без латинской пары', () => {
      // `Д` (U+0414) латинского двойника не имеет и остаётся собой:
      // приведение «на всякий случай» склеивало бы разные номера.
      expect(normalizeDocNo(DECLARATION_LATIN).folded).toBe('POCCPUД-PU.PA01.B.17254/23');
    });

    it('покрыты все десять пар §8.3', () => {
      const cyrillic = 'САРОЕМТХВК';

      expect(normalizeDocNo(cyrillic).folded).toBe('CAPOEMTXBK');
    });

    it('цифры и латиница остаются на месте', () => {
      expect(normalizeDocNo('ABC-123/45').folded).toBe('ABC-123/45');
    });

    it('фолдинг не делает разные номера одинаковыми по цифрам', () => {
      // Класс `{R, Р, P}` шире гомоглифов, и его цена измерима: он обязан
      // склеивать только буквенную часть, а не номер целиком.
      expect(normalizeDocNo('RU.MCC.240.445.38406').folded).not.toBe(
        normalizeDocNo('RU.MCC.240.445.38407').folded,
      );
    });
  });
});
