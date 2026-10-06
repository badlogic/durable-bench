# Benchmark image for running the suite on a dedicated host (scripts/slayer.sh). Everything is pinned:
#   Node 24.21.0 (Debian bookworm) by digest, Bun 1.4.2 from the official release zip with its published SHA-256,
#   npm dependencies from package-lock.json, Pi Durable HEAD from the commit in pi-head.sha. No lifecycle scripts run.
FROM node:24.21.0-bookworm@sha256:22f6fe5f59fb7fed238b19623506d573dffaa932ce33b84ce541a9a2e0eade28

ARG BUN_VERSION=1.4.2
ARG BUN_SHA256=36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
 && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun && rm -rf /tmp/bun*

WORKDIR /bench
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm install --no-save --ignore-scripts --no-audit --no-fund @resvg/resvg-js@2.6.2
COPY pi-head.sha ./
COPY scripts/fetch-pi-head.sh scripts/
RUN PI_HEAD_DIR=/bench/work/pi-head bash scripts/fetch-pi-head.sh
COPY . .
RUN node scripts/build.mjs && bun scripts/build-bun.ts && chmod -R a+rwX /bench
ENV HOME=/tmp
CMD ["bash", "scripts/run-suite.sh"]
