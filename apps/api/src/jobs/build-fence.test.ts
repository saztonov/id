/**
 * Забор сборки: таблица исходов и чтение каталога миграций (S58).
 *
 * Решение — чистая функция, и здесь проверяется вся таблица: какое состояние
 * даёт каждая комбинация «своя метка / объявленная / production / схема /
 * время с момента старта». Работа забора с настоящей базой и настоящим
 * захватом задач — в `runner.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { bundledSchemaVersion, decideFence, holdsClaims, type FenceInput } from './build-fence.js';

const BASE: FenceInput = {
  own: 'aaa',
  announced: 'aaa',
  production: true,
  bundled: '0080',
  dbSchema: '0080',
  matchedBefore: false,
  sinceStartMs: 0,
  graceMs: 90_000,
};

describe('решение забора', () => {
  it('совпавшие метки — current, захват идёт', () => {
    expect(decideFence(BASE)).toEqual({ state: 'current', reason: null });
    expect(holdsClaims('current')).toBe(false);
  });

  it('расхождение внутри окна старта — unverified: API ещё поднимается', () => {
    // `up -d` стартует API и воркер вместе, и воркер может увидеть объявление
    // ПРЕДЫДУЩЕЙ выкатки. Это ожидание, а не приговор — но захват удержан.
    const decision = decideFence({ ...BASE, announced: 'bbb', sinceStartMs: 10_000 });
    expect(decision).toEqual({ state: 'unverified', reason: null });
    expect(holdsClaims('unverified')).toBe(true);
  });

  it('расхождение после окна старта — stale', () => {
    expect(decideFence({ ...BASE, announced: 'bbb', sinceStartMs: 90_000 })).toEqual({
      state: 'stale',
      reason: 'release_mismatch',
    });
    expect(holdsClaims('stale')).toBe(true);
  });

  it('расхождение после прежнего совпадения — stale сразу: выкатка прошла мимо', () => {
    // Ровно случай дубликата стека: процесс жил, совпадал, а после выкатки
    // объявление сменилось. Ждать окно старта здесь нечего.
    expect(
      decideFence({ ...BASE, announced: 'bbb', matchedBefore: true, sinceStartMs: 1_000 }),
    ).toEqual({ state: 'stale', reason: 'release_mismatch' });
  });

  it('объявления нет — unannounced: захват идёт', () => {
    // Первая выкатка с забором или API ещё не поднимался ни разу: единственный
    // исполнитель не должен встать из-за пустой строки.
    expect(decideFence({ ...BASE, announced: null })).toEqual({
      state: 'unannounced',
      reason: null,
    });
    expect(holdsClaims('unannounced')).toBe(false);
  });

  it('без своей метки вне production — disabled', () => {
    expect(decideFence({ ...BASE, own: undefined, production: false })).toEqual({
      state: 'disabled',
      reason: null,
    });
    expect(holdsClaims('disabled')).toBe(false);
  });

  it('без своей метки в production — ожидание, затем stale/unlabeled', () => {
    // Так выглядел бы сирота, поднятый без переменной: сверять нечего, а
    // работать вслепую нельзя.
    expect(decideFence({ ...BASE, own: undefined, sinceStartMs: 0 })).toEqual({
      state: 'unverified',
      reason: null,
    });
    expect(decideFence({ ...BASE, own: undefined, sinceStartMs: 90_000 })).toEqual({
      state: 'stale',
      reason: 'unlabeled',
    });
  });

  it('база новее образа — stale/schema_newer независимо от меток', () => {
    // Окно `--migrate`: схема уже новая, объявление ещё старое. Метки могут
    // даже совпадать — код всё равно старше схемы.
    expect(decideFence({ ...BASE, dbSchema: '0081' })).toEqual({
      state: 'stale',
      reason: 'schema_newer',
    });
    expect(decideFence({ ...BASE, own: undefined, production: false, dbSchema: '0081' })).toEqual({
      state: 'stale',
      reason: 'schema_newer',
    });
  });

  it('образ новее базы — не расхождение: миграции ещё не накатили', () => {
    expect(decideFence({ ...BASE, dbSchema: '0079' })).toEqual({ state: 'current', reason: null });
  });

  it('без журнала или без каталога зонд схемы молчит', () => {
    expect(decideFence({ ...BASE, dbSchema: null })).toEqual({ state: 'current', reason: null });
    expect(decideFence({ ...BASE, bundled: null, dbSchema: '0099' })).toEqual({
      state: 'current',
      reason: null,
    });
  });
});

describe('каталог миграций образа', () => {
  const dir = mkdtempSync(join(tmpdir(), 'id-fence-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('берёт старший номер по именам файлов и не читает SQL', () => {
    writeFileSync(join(dir, '0001_init.sql'), 'не sql вовсе');
    writeFileSync(join(dir, '0012_later.sql'), '');
    writeFileSync(join(dir, '0009_middle.sql'), '');
    // Мусор рядом — README, черновик без номера, файл не .sql — не считается.
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, 'draft.sql'), '');
    writeFileSync(join(dir, '0100_notes.txt'), '');
    expect(bundledSchemaVersion(dir)).toBe('0012');
  });

  it('отсутствующий каталог — null, а не отказ', () => {
    expect(bundledSchemaVersion(join(dir, 'нет-такого'))).toBeNull();
  });
});
