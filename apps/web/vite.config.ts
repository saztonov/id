import { createRequire } from 'node:module';
import { cp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Бинарные ресурсы pdf.js, которые обязаны лежать рядом со сборкой.
 *
 * Библиотека не носит их в бандле: шрифты, таблицы CMap, wasm-декодеры и
 * ICC-профиль она догружает по адресам, которые ей передают параметрами
 * `standardFontDataUrl`, `cMapUrl`, `wasmUrl` и `iccUrl` (см.
 * `src/features/markup/pdf/pdfjs.ts`). Пока каталогов не было в сборке, каждый
 * параметр оставался незаданным, и pdf.js на каждый стандартный шрифт бросал
 * `Ensure that the 'standardFontDataUrl' API parameter is provided`, а страницы
 * с изображениями JPEG2000 (`/Filter /JPXDecode` — в комплектах ИД такие есть)
 * не декодировались вовсе: их читает `wasm/openjpeg.wasm`.
 *
 * Список закрытый, а не «скопировать пакет целиком»: в `pdfjs-dist` лежат ещё
 * `build/`, `legacy/`, `web/` и `types/` — их раздача наружу увеличила бы
 * сборку в разы и вынесла бы на публичный адрес то, что бандлер уже собрал.
 */
const PDFJS_ASSET_DIRS = ['standard_fonts', 'cmaps', 'wasm', 'iccs'] as const;

/** Общий префикс раздачи; тот же литерал знает `pdfjs.ts` и `nginx.conf`. */
const PDFJS_URL_PREFIX = '/pdfjs/';

/** Корень установленного `pdfjs-dist` (в pnpm-воркспейсе это путь внутри `.pnpm`). */
function pdfjsPackageRoot(): string {
  // `require.resolve` вместо склейки с `node_modules`: в pnpm пакет лежит в
  // `.pnpm/pdfjs-dist@<версия>/node_modules/pdfjs-dist`, и относительный путь
  // ломался бы при каждом обновлении версии.
  return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
}

/**
 * Типы содержимого ресурсов pdf.js.
 *
 * `.wasm` назван явно: браузер отказывается компилировать модуль потоком
 * (`WebAssembly.instantiateStreaming`), если тип ответа не `application/wasm`, —
 * ровно та же ловушка, что уже случилась с `.mjs` воркера (история в
 * `nginx.conf`). Остальные — двоичные данные, и `application/octet-stream` для
 * них верен: pdf.js читает их как `ArrayBuffer`, а не как ресурс браузера.
 */
const PDFJS_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.pfb': 'application/octet-stream',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
};

/**
 * Копирование ресурсов pdf.js в сборку и их раздача в режиме разработки.
 *
 * Плагин собственный, а не `vite-plugin-static-copy`: задача — рекурсивно
 * скопировать четыре каталога, и ради неё не стоит заводить зависимость,
 * которую придётся проводить через контур без внешних адресов и сверять с
 * каждой мажорной версией Vite.
 *
 * Раздача в `dev` обязательна отдельно от копирования: `vite dev` не читает
 * `dist`, а каталога `public/` в проекте нет, и без middleware экран разметки
 * в разработке вёл бы себя не так, как собранный, — то есть дефект нашёлся бы
 * только в production, что с этими же файлами уже происходило.
 */
function pdfjsAssets(): Plugin {
  const root = pdfjsPackageRoot();

  return {
    name: 'id-pdfjs-assets',

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith(PDFJS_URL_PREFIX)) {
          next();
          return;
        }
        // Строка запроса и якорь в имя файла не входят.
        const path = decodeURIComponent(url.slice(PDFJS_URL_PREFIX.length).split(/[?#]/)[0] ?? '');
        const absolute = resolve(root, path);
        // Защита от выхода за пределы пакета: `..` в адресе иначе отдал бы
        // любой файл машины разработчика.
        const inside = PDFJS_ASSET_DIRS.some((dir) => {
          const base = join(root, dir);
          const rel = relative(base, absolute);
          return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
        });
        if (!inside) {
          next();
          return;
        }
        void stat(absolute)
          .then((info) => {
            if (!info.isFile()) {
              next();
              return;
            }
            const dot = absolute.lastIndexOf('.');
            const extension = dot === -1 ? '' : absolute.slice(dot).toLowerCase();
            res.setHeader(
              'content-type',
              PDFJS_CONTENT_TYPES[extension] ?? 'application/octet-stream',
            );
            res.setHeader('content-length', String(info.size));
            createReadStream(absolute).pipe(res);
          })
          .catch(() => {
            next();
          });
      });
    },

    /**
     * Копирование после записи бандла.
     *
     * `writeBundle`, а не `generateBundle`: файлы двоичные и в граф модулей не
     * входят, копировать их через `emitFile` значило бы прогонять полтора
     * мегабайта wasm через память сборщика без единой причины.
     */
    async writeBundle(options) {
      const outDir = options.dir ?? resolve('dist');
      await Promise.all(
        PDFJS_ASSET_DIRS.map((dir) =>
          cp(join(root, dir), join(outDir, 'pdfjs', dir), { recursive: true }),
        ),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  server: {
    port: 5173,
    // Same-origin: браузер ходит только в наш BFF, presigned URL наружу не выдаются.
    /**
     * Проксируется не только `/api`.
     *
     * `/auth` и `/me` живут вне версионного префикса, и без них в разработке не
     * работали ни выход, ни обновление CSRF-токена, ни сама проверка сессии —
     * SPA поднималась только собранной сборкой. Форма локального входа без
     * этого не проверяется вовсе.
     *
     * `changeOrigin: false` — тот же выбор, что в e2e-харнессе: заголовок Host
     * остаётся браузерным. Из-за этого `Origin` приходит как `:5173`, а
     * `PUBLIC_URL` указывает на `:3000`, поэтому в разработке нужен
     * `AUTH_LOCAL_ALLOWED_ORIGINS=http://localhost:5173` (в production эта
     * переменная запрещена).
     */
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/auth': { target: 'http://localhost:3000', changeOrigin: false },
      '/me': { target: 'http://localhost:3000', changeOrigin: false },
      '/health': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  /**
   * Идентификатор сборки для отчётов об ошибках браузера (§11, ADR-0010).
   *
   * Берётся из `APP_RELEASE`, того же значения, что уходит в журнал на сервере:
   * два разных идентификатора одной выкатки не дали бы сопоставить браузерную
   * ошибку с серверным рядом по релизам. В разработке переменной нет, и здесь
   * подставляется пустая строка — модуль отчётов трактует её как «сборка не
   * названа» и не выдумывает значение.
   */
  define: {
    __BUILD_ID__: JSON.stringify(process.env['APP_RELEASE'] ?? ''),
  },
});
