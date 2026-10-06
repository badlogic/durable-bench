#!/usr/bin/env bash
# The whole suite, strictly sequential, in one process tree (used by the Docker image on the dedicated host and by
# `npm run bench`). Steps ≤ 3000 turns always run; the 10000-turn step runs while the deadline allows; then CPU
# profiles at the largest size and the report. Results land in results/ (mount it to keep them).
set -uo pipefail
cd "$(dirname "$0")/.."
export SUITE_DEADLINE=${SUITE_DEADLINE:-$(( $(date +%s) + ${SUITE_HOURS:-3} * 3600 ))}
mkdir -p results/logs
{
  echo "run: ${RUN_LABEL:-local} $(date -u +%FT%TZ)"
  echo "host: ${HOST_LABEL:-$(hostname)}"
  echo "node: $(node --version)"; echo "bun: $(bun --version)"
  echo "pi-head: $(cat pi-head.sha)"
  echo "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
  echo "cpuset: $(cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null || cat /sys/fs/cgroup/cpuset/cpuset.cpus 2>/dev/null || echo ?)"
  echo "memory limit: $(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo ?)"
  for c in $(cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null | tr ',' ' '); do
    d=/sys/devices/system/cpu/cpu${c%%-*}/cpufreq
    echo "cpu${c%%-*}: governor $(cat $d/scaling_governor 2>/dev/null || echo ?) driver $(cat $d/scaling_driver 2>/dev/null || echo ?) epp $(cat $d/energy_performance_preference 2>/dev/null || echo ?) max $(cat $d/scaling_max_freq 2>/dev/null || echo ?)"
  done
  echo "loadavg at start: $(cat /proc/loadavg)"
  [ -f "${OUT:-/nonexistent}/host-info.txt" ] && cat "$OUT/host-info.txt"
  npm ls --depth=0 2>/dev/null
} >results/environment.txt
# OUT: optional directory (a mounted volume) that receives a copy of the results after every step.
sync_out() { [ -n "${OUT:-}" ] && mkdir -p "$OUT" && cp -r results "$OUT/" && for f in charts README.md report.html; do [ -e "$f" ] && cp -r "$f" "$OUT/"; done; return 0; }
step() { bash scripts/bench.sh "$@"; sync_out; }
for rt in node bun; do
  for s in smoke cold version dialogue-small app stream dialogue-large; do step "$s" "$rt"; done
done
# DIALOGUE_XL=none skips the optional 10000-turn size (history build time grows quadratically with turns).
[ "${DIALOGUE_XL:-}" = none ] || for rt in node bun; do step dialogue-xl "$rt"; done
step profile node
echo "loadavg at end: $(cat /proc/loadavg)" >>results/environment.txt
node scripts/charts.mjs
sync_out
echo "suite done $(date -u +%FT%TZ)"
