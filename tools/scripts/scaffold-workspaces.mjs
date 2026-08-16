/**
 * Разовый генератор каркаса воркспейсов (этап S0).
 *
 * Создаёт package.json, tsconfig.json и заглушку src/index.ts для каждого
 * воркспейса, если файла ещё нет. Существующие файлы не перезаписываются —
 * скрипт идемпотентен и безопасен для повторного запуска.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TS = '6.0.3';
const VITEST = '4.1.10';

/** Общие для всех воркспейсов npm-скрипты. */
const libScripts = {
  build: 'tsc -p tsconfig.json',
  typecheck: 'tsc -p tsconfig.json --noEmit',
  lint: 'eslint src --max-warnings 0',
  test: 'vitest run --passWithNoTests',
};

/** @type {Array<{dir:string,name:string,deps?:Record<string,string>,devDeps?:Record<string,string>,scripts?:Record<string,string>,doc:string}>} */
const workspaces = [
  {
    dir: 'packages/doc-types',
    name: '@id/doc-types',
    doc: 'Каталог видов исполнительной документации и ролей страниц. Наполняется на S1.',
    deps: { zod: '4.4.3' },
  },
  {
    dir: 'packages/rules',
    name: '@id/rules',
    doc: 'Реализации правил проверки ИД. Чистые функции (graph, params) => Finding[]. Наполняется на S9.',
    deps: { '@id/contracts': 'workspace:*', '@id/doc-types': 'workspace:*' },
  },
  {
    dir: 'apps/api',
    name: '@id/api',
    doc: 'HTTP API портала (Fastify). Наполняется начиная с S3.',
    deps: {
      '@id/contracts': 'workspace:*',
      '@id/doc-types': 'workspace:*',
      '@id/rules': 'workspace:*',
      '@fastify/cookie': '11.1.2',
      '@fastify/csrf-protection': '8.0.1',
      '@fastify/helmet': '13.1.0',
      '@fastify/rate-limit': '11.2.0',
      '@fastify/static': '10.1.3',
      'drizzle-orm': '0.45.2',
      fastify: '5.12.0',
      'fastify-type-provider-zod': '7.0.0',
      jose: '6.2.9',
      'openid-client': '6.8.5',
      pg: '8.23.0',
      pino: '10.3.1',
      'pino-http': '11.0.0',
      'prom-client': '15.1.3',
      zod: '4.4.3',
    },
    devDeps: { 'drizzle-kit': '0.31.10' },
  },
  {
    dir: 'apps/worker',
    name: '@id/worker',
    doc: 'Исполнитель фоновых задач. Тот же образ, отдельная точка входа. Наполняется с S5.',
    deps: {
      '@id/contracts': 'workspace:*',
      '@id/doc-types': 'workspace:*',
      '@id/rules': 'workspace:*',
      'drizzle-orm': '0.45.2',
      'pdf-lib': '1.17.1',
      pg: '8.23.0',
      pino: '10.3.1',
      zod: '4.4.3',
    },
  },
  {
    dir: 'tools/fake-rdweb',
    name: '@id/fake-rdweb',
    doc: 'Офлайн-двойник RD WEB по его реальным контрактам. Наполняется на S6.',
    deps: { fastify: '5.12.0', zod: '4.4.3' },
  },
  {
    dir: 'tools/fixtures',
    name: '@id/fixtures',
    doc: 'Генератор синтетических PDF-фикстур и обезличиватель закрытого корпуса.',
    deps: { 'pdf-lib': '1.17.1' },
    scripts: { ...libScripts, generate: 'node src/generate.ts' },
  },
  {
    dir: 'tools/db-harness',
    name: '@id/db-harness',
    doc: 'Тестовая БД: pglite для локальных гейтов, реальная PostgreSQL при заданном TEST_DATABASE_URL.',
    deps: { '@electric-sql/pglite': '0.5.5', 'drizzle-orm': '0.45.2' },
    scripts: { ...libScripts, probe: 'node src/probe.ts' },
  },
];

let created = 0;
for (const ws of workspaces) {
  const base = join(ROOT, ws.dir);
  mkdirSync(join(base, 'src'), { recursive: true });

  const pkgPath = join(base, 'package.json');
  if (!existsSync(pkgPath)) {
    const pkg = {
      name: ws.name,
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      main: './dist/index.js',
      types: './dist/index.d.ts',
      scripts: ws.scripts ?? libScripts,
      ...(ws.deps ? { dependencies: ws.deps } : {}),
      devDependencies: { ...(ws.devDeps ?? {}), typescript: TS, vitest: VITEST },
    };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    created++;
  }

  const tsPath = join(base, 'tsconfig.json');
  if (!existsSync(tsPath)) {
    const up = relative(base, ROOT).split('\\').join('/');
    const tsconfig = {
      extends: `${up}/tsconfig.base.json`,
      compilerOptions: { rootDir: './src', outDir: './dist' },
      include: ['src/**/*.ts'],
    };
    writeFileSync(tsPath, JSON.stringify(tsconfig, null, 2) + '\n', 'utf8');
    created++;
  }

  const idxPath = join(base, 'src', 'index.ts');
  if (!existsSync(idxPath)) {
    writeFileSync(idxPath, `/**\n * ${ws.doc}\n */\nexport {};\n`, 'utf8');
    created++;
  }
}

console.log(`scaffold: создано файлов ${created}`);
