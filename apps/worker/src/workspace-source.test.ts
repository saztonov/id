/**
 * Тесты обязаны идти против ИСХОДНИКА внутренних пакетов, а не против сборки.
 *
 * ## Что было неверно
 *
 * У `@id/api` (как и у остальных пакетов воркспейса) `main` и `exports`
 * указывают на `dist` — так и надо в бою. Но под vitest это означало, что все
 * 130 тестов воркера исполняют ПРОШЛУЮ сборку API. Проверено мутацией: реальная
 * потеря страниц, внесённая в `apps/api/src/segmentation/decoder.ts`, оставляла
 * интеграционный набор целиком зелёным, и краснел он (16 из 25) только после
 * `pnpm --filter @id/api build`.
 *
 * Последствие не в конкретном дефекте, а в протоколе приёмки: «гейт зелёный»
 * получалось командой, которая гейт не исполняет. Порядок `build` перед `test`
 * это прячет, а не решает — он делает ответ верным сегодня и не гарантирует
 * ничего завтра, когда кто-нибудь запустит `pnpm test` отдельно.
 *
 * ## Что проверяется здесь
 *
 * Первое — что импорт `@id/api` действительно ведёт в `src`. Проверка идёт по
 * стеку исключения, брошенного КОДОМ пакета: путь кадра — единственное
 * наблюдаемое свидетельство того, какой файл на самом деле исполнился. Сравнение
 * значений здесь не годится: сборка и исходник по построению возвращают одно и
 * то же ровно до тех пор, пока их не рассинхронизировали.
 *
 * Второе — что список алиасов покрывает КАЖДЫЙ пакет воркспейса с
 * `src/index.ts`. Иначе следующий пакет молча вернёт тот же класс отказа: он
 * просто не попадёт в список, и никто этого не заметит.
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeSegmentation } from '@id/api';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Список алиасов читается ТЕКСТОМ, а не импортом конфигурации.
 *
 * Импорт `../../../vitest.shared.js` вывел бы файл за `rootDir` пакета, и
 * `tsc --noEmit` отказался бы собирать программу. Чтение текстом даёт ровно то,
 * что нужно проверке, — перечень имён пакетов, — и ничего не ломает.
 */
function aliasedRoots(): readonly string[] {
  const source = readFileSync(join(REPO_ROOT, 'vitest.shared.ts'), 'utf8');
  const block = /const packageRoots[\s\S]*?^\};/mu.exec(source)?.[0] ?? '';
  return [...block.matchAll(/'@id\/[a-z0-9-]+':\s*'([^']+)'/gu)].map((match) => match[1] ?? '');
}

describe('внутренние пакеты разрешаются в src, а не в dist', () => {
  it('исключение из @id/api приходит из файла исходника', () => {
    let stack = '';
    try {
      // Число страниц не совпадает с числом классификаций — декодер бросает.
      // Важен не отказ, а КАДР СТЕКА: он называет исполнившийся файл.
      decodeSegmentation([], [{ sourcePageId: 'p1' } as never]);
    } catch (error) {
      stack = (error as Error).stack ?? '';
    }

    expect(stack).not.toBe('');
    expect(stack).toMatch(/apps[\\/]api[\\/]src[\\/]segmentation[\\/]decoder\.ts/u);
    expect(stack).not.toMatch(/apps[\\/]api[\\/]dist[\\/]/u);
  });

  it('алиасом покрыт каждый пакет воркспейса с src/index.ts', () => {
    const aliased = new Set(aliasedRoots().map((root) => resolve(REPO_ROOT, root)));

    const found: string[] = [];
    for (const group of ['apps', 'packages', 'tools']) {
      const groupDir = join(REPO_ROOT, group);
      if (!existsSync(groupDir)) continue;
      for (const name of readdirSync(groupDir)) {
        if (!existsSync(join(groupDir, name, 'package.json'))) continue;
        if (!existsSync(join(groupDir, name, 'src', 'index.ts'))) continue;
        found.push(resolve(groupDir, name));
      }
    }

    // Цикл по нулю пакетов «проверил» бы что угодно — тот же дефект, который
    // S7 нашёл у трёх собственных проверок секретов.
    expect(found.length).toBeGreaterThan(5);
    expect(aliased.size).toBeGreaterThan(5);

    const missing = found.filter((path) => !aliased.has(path));
    expect(missing, `пакеты без алиаса на src: ${missing.join(', ')}`).toEqual([]);
  });
});
