/**
 * Реестр настроек: у ключа есть читатель, а у значения — согласованный контрол.
 *
 * Оба теста появились после разбора экрана «Администрирование», на котором из
 * двадцати четырёх ключей шесть не читал никто: `ai.enabled`, `rdweb.enabled`,
 * `checks.autorun_after_documents`, `doc_type_candidates.min_occurrences`,
 * `portal.maintenance_notice` и `ai.monthly_budget_rub` — последний ещё и
 * дублировал переменную окружения `LLM_BUDGET_MONTHLY`, показывая ноль там, где
 * настоящий лимит живёт в другом месте. Мёртвая настройка хуже отсутствующей:
 * администратор её видит, меняет и вправе ждать, что портал станет вести себя
 * иначе.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SETTING_KEYS, SETTINGS_REGISTRY, type SettingDefinition } from './schemas.js';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Где ищутся читатели.
 *
 * Миграции входят в список: `core.enforce_immutability` спрашивает SQL-функция
 * `immutability_enforced()` из миграции 0035, а не только код.
 *
 * `apps/web` НЕ входит, и это не упущение. Экран настроек перечисляет ключи в
 * своих группах, то есть содержит их литералами; считай он читателем — мёртвый
 * ключ проходил бы проверку ровно потому, что его показывают на экране. Читатель
 * — тот, кто по значению меняет поведение портала, а таких на клиенте нет.
 */
const SOURCE_ROOTS = ['apps/api/src', 'apps/worker/src', 'packages', 'tools', 'migrations'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.sql', '.mjs', '.cjs'];

/** Файл, в котором ключи объявлены: он читателем не считается. */
const REGISTRY_FILE = join('apps', 'api', 'src', 'modules', 'admin', 'schemas.ts');

function collectSources(relativeRoot: string, into: string[]): void {
  const absolute = join(REPO_ROOT, relativeRoot);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const relative = join(relativeRoot, entry);
    const stats = statSync(join(REPO_ROOT, relative));
    if (stats.isDirectory()) {
      collectSources(relative, into);
      continue;
    }
    // Тест читателем не считается: ключ, который упоминает только тест, всё
    // равно ни на что не влияет.
    if (relative.includes('.test.') || relative.includes('.spec.')) continue;
    if (relative === REGISTRY_FILE) continue;
    if (!SOURCE_EXTENSIONS.some((extension) => relative.endsWith(extension))) continue;
    into.push(relative);
  }
}

describe('реестр настроек портала', () => {
  it('у каждого ключа есть читатель вне реестра', () => {
    const files: string[] = [];
    for (const root of SOURCE_ROOTS) collectSources(root, files);
    expect(files.length).toBeGreaterThan(100);

    const contents = files.map((file) => readFileSync(join(REPO_ROOT, file), 'utf8'));

    const orphans = SETTING_KEYS.filter(
      (key) => !contents.some((content) => content.includes(key)),
    );

    expect(
      orphans,
      `Настройки без читателя: ${orphans.join(', ')}. Ключ, который никто не спрашивает, ` +
        'нужно либо подключить, либо убрать из реестра — на экране он обещает поведение, ' +
        'которого нет.',
    ).toEqual([]);
  });

  it('значение по умолчанию проходит собственную схему', () => {
    for (const key of SETTING_KEYS) {
      const definition = SETTINGS_REGISTRY[key];
      const parsed = definition.schema.safeParse(definition.defaultValue);
      expect(parsed.success, `${key}: значение по умолчанию не проходит схему ключа`).toBe(true);
    }
  });

  /**
   * Дескриптор объявлен рядом со схемой и потому может с ней разойтись: тест
   * гоняет через схему ровно то, что контрол разрешит человеку ввести.
   */
  it('дескриптор согласован со схемой', () => {
    for (const key of SETTING_KEYS) {
      // Тип расширяется до объявленного: обращение по литеральному ключу
      // сужает контрол до конкретной формы, и необязательного `nullable` у неё
      // просто нет — а тест обязан спросить именно про него.
      const definition: SettingDefinition = SETTINGS_REGISTRY[key];
      const { schema, control } = definition;
      const accepts = (value: unknown): boolean => schema.safeParse(value).success;

      if (control.kind === 'enum') {
        for (const option of control.options) {
          expect(accepts(option), `${key}: вариант «${option}» не проходит схему`).toBe(true);
        }
        continue;
      }

      if (control.kind === 'boolean') {
        expect(accepts(true), `${key}: схема не принимает true`).toBe(true);
        expect(accepts(false), `${key}: схема не принимает false`).toBe(true);
        expect(accepts(null), `${key}: пустое значение и схема разошлись`).toBe(
          control.nullable === true,
        );
        continue;
      }

      if (control.kind === 'number') {
        if (control.min !== undefined) {
          expect(accepts(control.min), `${key}: нижняя граница не проходит схему`).toBe(true);
          expect(accepts(control.min - 1), `${key}: схема пропускает значение ниже границы`).toBe(
            false,
          );
        }
        if (control.max !== undefined) {
          expect(accepts(control.max), `${key}: верхняя граница не проходит схему`).toBe(true);
          expect(accepts(control.max + 1), `${key}: схема пропускает значение выше границы`).toBe(
            false,
          );
        }
        expect(accepts(null), `${key}: пустое значение и схема разошлись`).toBe(
          control.nullable === true,
        );
        continue;
      }

      if (control.kind === 'string') {
        expect(accepts(42), `${key}: схема приняла число там, где контрол даёт строку`).toBe(false);
        continue;
      }

      expect(accepts('строка'), `${key}: схема приняла строку там, где контрол даёт объект`).toBe(
        false,
      );
    }
  });
});
