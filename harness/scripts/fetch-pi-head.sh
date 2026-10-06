#!/usr/bin/env bash
# Clone earendil-works/pi at the commit in pi-head.sha into $PI_HEAD_DIR (default work/pi-head) and install its
# dependencies from its own lockfile without lifecycle scripts. Nothing of the pi repo's build or test tooling runs.
set -euo pipefail
cd "$(dirname "$0")/.."
SHA=$(cat pi-head.sha)
DIR=${PI_HEAD_DIR:-work/pi-head}
if [ ! -d "$DIR/.git" ]; then
  git init -q "$DIR"
  git -C "$DIR" remote add origin https://github.com/earendil-works/pi.git
fi
git -C "$DIR" fetch -q --depth 1 origin "$SHA"
git -C "$DIR" checkout -q --detach FETCH_HEAD
test "$(git -C "$DIR" rev-parse HEAD)" = "$SHA"
(cd "$DIR" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
echo "pi HEAD $SHA in $DIR ($(node -p "require('./$DIR/packages/durable/package.json').version"))"
