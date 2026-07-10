# syntax=docker/dockerfile:1

# One Dockerfile, parameterized by APP_NAME, builds any of the 4 apps in this
# monorepo (api-gateway | orchestrator | agent-worker | synthesizer) plus a
# `migrator` stage used only to run Prisma migrations before the apps start.
# Kept as one file rather than 4 near-identical ones so the build recipe
# can't drift between apps.

ARG NODE_VERSION=22-slim

# ── deps: install once, reused by every downstream stage ────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# Never let puppeteer (pulled in transitively via md-to-pdf) try to download
# its own Chromium — the runtime stage installs one explicitly via apt, and
# only api-gateway's image needs it at all.
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
# `postinstall` runs `prisma generate`, which needs the schema present.
COPY prisma ./prisma
RUN npm ci

# ── build: compile the one app named by APP_NAME ─────────────────────────────
FROM deps AS build
ARG APP_NAME
COPY . .
RUN test -n "$APP_NAME" || (echo "APP_NAME build arg is required" && exit 1)
RUN npx nest build ${APP_NAME}

# ── migrator: full source + full deps, runs `prisma migrate deploy` ─────────
FROM deps AS migrator
COPY . .
CMD ["npx", "prisma", "migrate", "deploy"]

# ── runtime: prod deps only + the one compiled app ───────────────────────────
FROM node:${NODE_VERSION} AS runtime
ARG APP_NAME
ARG INSTALL_CHROMIUM=false
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Only meaningful when INSTALL_CHROMIUM=true (api-gateway, for PDF export);
# an unused env var on the other 3 images is harmless.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN if [ "$INSTALL_CHROMIUM" = "true" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

# @terrastruct/d2 carries a ~22MB WASM binary (x2 — an ESM and a CJS copy) and
# only the synthesizer ever renders a diagram. api-gateway inlines SVG the
# synthesizer already produced, so it needs the strings, not the renderer.
# Dropping it saves ~58MB on three of the four images.
RUN if [ "$APP_NAME" != "synthesizer" ]; then rm -rf node_modules/@terrastruct; fi

COPY --from=build /app/dist/apps/${APP_NAME} ./dist
# nest build's outDir mirrors the full source path (apps/<app>/src/... +
# libs/common/src/...) because each app's tsconfig also compiles the shared
# lib inline — so the real entry point is nested, not dist/main.js directly.
RUN ln -s "/app/dist/apps/${APP_NAME}/src/main.js" /app/dist/main.js

USER node
CMD ["node", "dist/main.js"]
