FROM node:22-bookworm-slim AS base

WORKDIR /usr/src/app

ARG DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata \
        curl \
        ffmpeg \
        intel-media-va-driver \
        libva-drm2 \
        vainfo \
        xz-utils \
        unzip; \
    \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN set -eux; \
    export NPM_CONFIG_LOGLEVEL=warn; \
    export NPM_CONFIG_IGNORE_SCRIPTS=true; \
    export NPM_CONFIG_UPDATE_NOTIFIER=false; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi; \
    # ignore-scripts skips lifecycle scripts, so better-sqlite3's native
    # prebuild is never fetched; rebuild that one package with scripts on.
    npm rebuild better-sqlite3 --ignore-scripts=false; \
    node -e "require('better-sqlite3'); console.log('better-sqlite3 native binding OK')"; \
    rm -rf /root/.npm

COPY . .

ENV NODE_ENV=production \
    PORT=5174 \
    GHARMONIZE_WEB_BINARIES=1 \
    GHARMONIZE_WEB_BINARIES_IN_DOCKER=1 \
    GHARMONIZE_WEB_CACHE_DIR=/opt/gharmonize/cache/binaries \
    CHROME_DRIVERLESS_URL=http://chrome-driverless:9223 \
    CHROME_DRIVERLESS_DATA_DIR=/data/driverless \
    GHARMONIZE_BINARY_TMP_DIR=/usr/src/app/temp/binary-tmp \
    TMPDIR=/usr/src/app/temp/binary-tmp \
    TMP=/usr/src/app/temp/binary-tmp \
    TEMP=/usr/src/app/temp/binary-tmp \
    DISABLE_QSV_IN_DOCKER=1 \
    DISABLE_VAAPI_IN_DOCKER=1

# Only the runtime-writable dirs get their own tiny layer; chmod -R on the
# whole app would duplicate every file's metadata into this layer.
RUN mkdir -p uploads outputs temp/binary-tmp local-inputs cookies data/db \
  && chmod -R 0775 uploads outputs temp local-inputs cookies data

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 5174) + '/').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "app.js"]
