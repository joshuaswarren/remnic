FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')" @tobilu/qmd@2.5.3

COPY . .

RUN pnpm install --frozen-lockfile

RUN REMNIC_DOCKER_RUNTIME_BUILD=1 pnpm --filter @remnic/core build \
  && pnpm --filter @remnic/server exec tsup src/index.ts --format esm --target es2022 --platform node --outDir dist \
  && pnpm --filter @remnic/server run verify:bin \
  && CI=true pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
  HOME=/data \
  REMNIC_HOME=/data \
  REMNIC_HOST=0.0.0.0 \
  REMNIC_PORT=4318 \
  REMNIC_MEMORY_DIR=/data/memory \
  REMNIC_ADMIN_CONSOLE_ENABLED=true \
  REMNIC_ADMIN_CONSOLE_PUBLIC_DIR=/app/admin-console/public

WORKDIR /app

RUN mkdir -p /data /app \
  && chown -R node:node /data /app

# QMD was installed via npm install -g in the build stage (where python3 is available
# for node-gyp native addons). npm creates a symlink at /usr/local/bin/qmd pointing
# to <package-dir>/bin/qmd. COPY preserves the link destination, so use --link to
# keep the symlink intact and copy the full package tree for resolved requires.
COPY --from=build /usr/local/lib/node_modules/@tobilu /usr/local/lib/node_modules/@tobilu
RUN ln -s /usr/local/lib/node_modules/@tobilu/qmd/bin/qmd /usr/local/bin/qmd

COPY --from=build --chown=node:node /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/admin-console ./admin-console

USER node

VOLUME ["/data"]
EXPOSE 4318

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD ["node", "packages/remnic-server/bin/remnic-server.js", "--healthcheck", "--port", "4318"]

CMD ["node", "packages/remnic-server/bin/remnic-server.js", "--host", "0.0.0.0", "--port", "4318"]
