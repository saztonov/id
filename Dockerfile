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
