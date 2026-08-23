# Один образ: api | worker | migrate.
# bookworm (не alpine): onnxruntime-node и sharp требуют glibc.
# Build context = корень монорепо.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
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
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @id/migrator... --filter @id/api... --filter @id/worker... build

FROM base AS runtime
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends qpdf poppler-utils wget \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r id && useradd -r -g id -d /app -s /usr/sbin/nologin id
COPY --from=build --chown=id:id /app /app
USER id
CMD ["node", "apps/api/dist/server.js"]
