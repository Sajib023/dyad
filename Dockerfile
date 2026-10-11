# syntax=docker/dockerfile:1.7
#
# Self-hosted web build of Dyad.
#
# The image runs the real Dyad main process (IPC handlers, sqlite, git, app
# runtime) under plain Node via `web/server/register.cjs`, and serves the
# React renderer built by `vite.web-renderer.config.mts`.
#
#   docker build -t dyad-web .
#   docker run --rm -p 3000:3000 -v dyad-data:/data dyad-web
#
# Native modules (better-sqlite3, node-pty) are compiled here, so the base
# image must keep a toolchain: `node:24-bookworm` is based on buildpack-deps
# and ships gcc/g++/make/python3/git/curl.

FROM node:24-bookworm

# Set before npm ci so the layer is cached on its own; BuildKit mounts keep
# the npm download cache across builds.
ENV npm_config_cache=/root/.npm

WORKDIR /app

# --- dependencies -----------------------------------------------------------
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# --- source ----------------------------------------------------------------
COPY . .

# --- builds ----------------------------------------------------------------
# Renderer SPA (index.web.html -> dist-web/index.html)
RUN npm run build:web
# Workers forked by the main process (code explorer, sql sandbox, supabase)
RUN npm run build:web-workers

# --- runtime ----------------------------------------------------------------
ENV NODE_ENV=development \
    DYAD_WEB=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/data \
    DYAD_DEV_USER_DATA_DIR=/data/userData \
    DYAD_WEB_RENDERER_DIR=/app/dist-web \
    DYAD_WEB_PUBLIC_ORIGIN=http://localhost:3000 \
    npm_config_cache=/data/.npm

# /data holds sqlite + settings + encrypted secrets (`userData`), the generated
# apps folder (`$HOME/dyad-apps`), managed node/pnpm downloads and logs.
RUN mkdir -p /data && chmod 777 /data

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "web/server/start.cjs"]
