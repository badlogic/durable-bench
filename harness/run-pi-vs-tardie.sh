#!/bin/bash
# The published run: inside the image built from this directory's Dockerfile, with the pi checkout mounted at /pi-head,
# its commit in /bench/pi-head.sha, and /out mounted to receive results/. Node, tardie vs pi-head only.
set -uo pipefail
cd /bench
rm -rf results work dist
export PI_HEAD_DIR=/pi-head SYSTEMS="tardie pi-head"
node scripts/build.mjs && bun scripts/build-bun.ts
for s in smoke cold version dialogue-small dialogue-large; do bash scripts/bench.sh "$s" node; done
bash scripts/bench.sh profile node
cp -r results /out/
echo done
