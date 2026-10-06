#!/bin/bash
# Full run: pi-head (PI_SOURCE checkout) vs tardie, sequential, inside the dhb container.
set -euo pipefail
log() { echo "[$(date -u +%FT%TZ)] $* | load $(cut -d' ' -f1-3 /proc/loadavg)"; }
bun install --frozen-lockfile >/dev/null 2>&1
rm -rf results fixtures
SIZES="50 250 1000 3500"
log "seed pi-head $PI_HEAD_VERSION"; bun run seed pi-head $SIZES
log "seed tardie"; bun run seed tardie $SIZES
log "bench pi-head"; bun run bench pi-head $SIZES
log "bench tardie"; bun run bench tardie $SIZES
bun run report
log done
