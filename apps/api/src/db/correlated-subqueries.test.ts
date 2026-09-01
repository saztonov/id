/**
 * Коррелированные подзапросы в выборках репозиториев ссылаются на внешнюю
 * таблицу ТЕКСТОМ, а не подстановкой колонки.
 *
 * ## Почему это отдельный тест, а не дисциплина автора
 *
 * Drizzle рендерит колонку в СПИСКЕ ВЫБОРКИ без имени таблицы, когда в запросе
 * одна таблица (в `where` — квалифицирует, там дефекта нет). Поэтому фрагмент
 *
 *     (select count(*)::int from ${sourcePages} where ${sourcePages.sourceFileId} = ${sourceFiles.id})
 *
 * уезжает в БД как `... where "source_file_id" = "id"`, и обе стороны
 * связываются с ВНУТРЕННЕЙ областью подзапроса. Условие ложно всегда, счётчик —
 * вечный ноль. Ни типы, ни SQL-синтаксис этого не ловят: запрос корректен,
 * просто отвечает не на тот вопрос.
 *
 * Класс уже стрелял дважды. Первый раз — `hasBundle` в `findFolderForFiles`:
 * запрет «состав ревизии зафиксирован разметкой» не срабатывал ни разу. Второй —
 * счётчик страниц в `saveFileVerdict`: задача `file.verify` каждый раз пыталась
 * записать геометрию, уже записанную приёмом файла, и умирала на
 * `source_pages_file_index_uq`, унося с собой и запись вердикта. Оба раза дефект
 * был невидим на тестах и жил в проде.
 *
 * ## Правило
 *
 * Во фрагменте, который начинается с `(select` или `exists (select` (то есть
 * годится в список выборки), подстановка `${Таблица.колонка}` разрешена ТОЛЬКО
 * для таблицы, которая тут же названа в `from ${Таблица}`. Внешняя таблица
 * пишется литералом: `... where p.source_file_id = source_files.id`.
 *
 * Подстановки значений (`${input.code}`, `${folderId}`) правилом не
 * затрагиваются: база подстановки сверяется со списком таблиц `@id/db`, а
 * значение таблицей не является.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as dbSchema from '@id/db';
import { describe, expect, it } from 'vitest';

const REPOSITORIES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'repositories');

/** Содержимое шаблона `sql`…`` / `sql<T>`…``. Вложенных обратных кавычек в этих фрагментах нет. */
const SQL_TEMPLATE = /sql(?:<[^>]*>)?`([^`]*)`/g;
/** Подстановка вида `${identifier.property}` — кандидат в ссылку на колонку. */
const COLUMN_INTERPOLATION = /\$\{([A-Za-z_$][\w$]*)\.([\w$]+)\}/g;
/** Таблица, названная подстановкой сразу после `from`. */
const FROM_INTERPOLATION = /from\s+\$\{([A-Za-z_$][\w$]*)\}/;
/** Фрагмент, пригодный в список выборки: скалярный подзапрос или `exists`. */
const SELECTION_SUBQUERY = /^(?:\(select|exists\s*\(select)/i;

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly reference: string;
}

function scanFile(fileName: string): Offence[] {
  const source = readFileSync(join(REPOSITORIES_DIR, fileName), 'utf8');
  const offences: Offence[] = [];

  for (const template of source.matchAll(SQL_TEMPLATE)) {
    const body = (template[1] ?? '').trim();
    if (!SELECTION_SUBQUERY.test(body)) continue;

    const innerTable = FROM_INTERPOLATION.exec(body)?.[1] ?? null;

    for (const interpolation of body.matchAll(COLUMN_INTERPOLATION)) {
      const base = interpolation[1] as string;
      // Не таблица — значит подстановка значения, а не колонки.
      if (!(base in dbSchema)) continue;
      if (base === innerTable) continue;
      offences.push({
        file: fileName,
        line: source.slice(0, template.index).split('\n').length,
        reference: `\${${base}.${String(interpolation[2])}}`,
      });
    }
  }

  return offences;
}

describe('коррелированные подзапросы репозиториев', () => {
  it('ссылаются на внешнюю таблицу текстом, а не подстановкой колонки', () => {
    const files = readdirSync(REPOSITORIES_DIR).filter(
      (name) => name.endsWith('.ts') && !name.includes('.test.'),
    );
    // Пустой список означал бы, что тест смотрит не туда и молча проходит.
    expect(files.length).toBeGreaterThan(10);

    const offences = files.flatMap((name) => scanFile(name));

    expect(
      offences.map((o) => `${o.file}:${String(o.line)} — ${o.reference}`),
      'внешняя таблица в подзапросе выборки подставлена колонкой: Drizzle отрендерит её ' +
        'без имени таблицы, и ссылка свяжется с внутренней областью. Пишите литералом: ' +
        '`where p.source_file_id = source_files.id`',
    ).toEqual([]);
  });

  it('находит нарушение, если оно появится', () => {
    // Проверка самого сканера: правило, которое не умеет падать, ничего не стоит.
    const body = '(select count(*)::int from ${sourcePages} where ${sourceFiles.id} = 1)';
    const matches = [...body.matchAll(COLUMN_INTERPOLATION)].map((m) => m[1]);
    expect(SELECTION_SUBQUERY.test(body)).toBe(true);
    expect(FROM_INTERPOLATION.exec(body)?.[1]).toBe('sourcePages');
    expect(matches).toContain('sourceFiles');
    expect('sourceFiles' in dbSchema).toBe(true);
  });
});
