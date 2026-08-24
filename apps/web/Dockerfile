# Статика портала ИД. Build context = корень монорепо.

FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
# Бинарники CUDA у `onnxruntime-node` НЕ входят в npm-пакет и тянутся postinstall'ом
# из nuget — это сотни мегабайт и основная часть времени `pnpm install`. Порталу
# они не нужны никогда: локальная детекция RF-DETR считается на CPU (ADR-0008),
# а CPU-библиотека в пакете уже лежит (`bin/napi-v6/linux/x64/libonnxruntime.so.1`),
# и `skip` её не трогает — он пропускает только НЕ вложенные в пакет файлы.
#
# Это не оптимизация ради красоты: сборка двух образов на VPS с 8 ГБ, где уже
# работают два десятка контейнеров, дважды качала эти пакеты одновременно и
# укладывала машину в memory pressure до потери SSH.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @id/contracts build

# Идентификатор выкатки: вшивается в бандл и в `version.json` — по нему вкладка
# узнаёт, что работает на устаревшем коде (§11). Подставляет `deploy-id.sh`
# (короткий SHA коммита), в compose — build-аргумент службы `id-web`.
#
# Сборка фронта вынесена отдельным слоем ровно из-за этого аргумента: `.dockerignore`
# прячет `.git`, `docs` и `*.md`, поэтому коммит без правок кода не меняет
# контекст сборки, но меняет SHA. Одним слоем такой коммит тянул бы повторный
# `pnpm install` — а на VPS с 8 ГБ это та самая нагрузка, из-за которой сборка
# образов разведена по очереди (см. deploy/deploy-id.sh).
ARG APP_RELEASE=""
RUN APP_RELEASE="$APP_RELEASE" pnpm --filter @id/web exec vite build

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
