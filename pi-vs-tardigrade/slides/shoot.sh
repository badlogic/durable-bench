#!/bin/bash
# Renders html/*.html to png/*.png with Playwright's Chromium (Docker) and reports overflowing content.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p png .npm
docker run --rm --name dhb-shoot -v "$PWD":/slides -w /slides -e HOME=/slides/.npm mcr.microsoft.com/playwright:v1.55.0-noble bash -c '
[ -d node_modules/playwright-core ] || npm install --no-save --ignore-scripts --no-audit --no-fund playwright-core@1.55.0 >/dev/null 2>&1
CHROME=$(ls /ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell | head -1) node shoot.mjs
chown -R '"$(id -u):$(id -g)"' png node_modules .npm'
