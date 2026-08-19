/**
 * Поиск пакетов распознанных документов на диске.
 *
 * Пакет — каталог, в котором лежит пара `*_results.md` + `*_blocks.json`
 * (ровно тот признак, по которому их читает `parseSourcePackage` из
 * `@id/fixtures`). Привязка по суффиксу имени файла, а не по имени каталога:
 * в именах папок корпуса встречаются `№`, кавычки-ёлочки, скобки и точки с
 * запятой, а `document_name` внутри JSON не всегда совпадает с именем на
 * диске (двойная точка перед расширением).
 *
 * Обход на два уровня: `temp/MD` содержит и пакеты первого уровня, и
 * подкаталог `new/` с новыми — одна команда читает оба.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function isPackageDir(dir: string): boolean {
  try {
    const files = readdirSync(dir);
    return (
      files.some((f) => f.endsWith('_results.md')) && files.some((f) => f.endsWith('_blocks.json'))
    );
  } catch {
    return false;
  }
}

export function listPackageDirs(root: string): readonly string[] {
  const found: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (isPackageDir(dir)) {
      found.push(dir);
      return;
    }
    if (depth >= 2) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.localeCompare(b, 'ru'))) {
      const child = join(dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
  return found;
}
