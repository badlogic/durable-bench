#!/usr/bin/env bash
# Sequential benchmark orchestrator. One process per measurement point; never runs two measurements at once.
#   bash scripts/bench.sh <step> <node|bun>     steps: smoke cold version dialogue-small dialogue-large app stream profile
#   bash scripts/bench.sh all                   every step, Node then Bun (what `npm run bench` runs)
# Results: results/results.jsonl (one JSON object per line), logs in results/logs/. Work DBs in work/ (not committed).
set -uo pipefail
cd "$(dirname "$0")/.."
STEP=${1:?step}
RT=${2:-node}
RUNS=${RUNS:-9}
WARMUP=${WARMUP:-2}
REOPEN_RUNS=${REOPEN_RUNS:-9}
COLD_RUNS=${COLD_RUNS:-9}
DIALOGUE_SMALL=${DIALOGUE_SMALL:-0,25,100,300}
DIALOGUE_LARGE=${DIALOGUE_LARGE:-1000,3000}
DIALOGUE_XL=${DIALOGUE_XL:-10000}
APP_SIZES=${APP_SIZES:-0,100,1000,10000,30000}
STREAM_DELTAS=${STREAM_DELTAS:-50}
export BUILD_BUDGET_S=${BUILD_BUDGET_S:-1800}
export APP_BUDGET_S=${APP_BUDGET_S:-600}
SYSTEMS=${SYSTEMS:-tardie pi pi-head}
export PI_HEAD_SHA=$(cat pi-head.sha)
mkdir -p results/logs results/profiles work/$RT
RES=results/results.jsonl
LOG=results/logs/$STEP-$RT.log
W=work/$RT
export BENCH_STEP=$STEP

if [ "$STEP" = all ]; then
  exec bash scripts/run-suite.sh
fi

# One bundle per (system, runtime): npm code (tardie, pi 1.0.4) or the pi checkout at pi-head.sha (pi-head).
if [ ! -f dist/node.mjs ] || [ ! -f dist/node-head.mjs ]; then node scripts/build.mjs >/dev/null; fi
if [ "$RT" = bun ] && { [ ! -f dist/bun-entry.js ] || [ ! -f dist/bun-head.js ]; }; then bun scripts/build-bun.ts >/dev/null; fi
cmd_for() { # system → command array in CMD
  case "$RT:$1" in
  node:pi-head) CMD=(node --expose-gc dist/node-head.mjs) ;;
  node:*) CMD=(node --expose-gc dist/node.mjs) ;;
  bun:pi-head) CMD=(bun ./dist/bun-head.js) ;;
  bun:*) CMD=(bun ./dist/bun-entry.js) ;;
  esac
}
bundle_map() { case "$1" in pi-head) echo "dist/node-head.mjs.map" ;; *) echo "dist/node.mjs.map" ;; esac; }

note() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
# run <args...>: one fresh process; RESULT lines go to $RES, everything to $LOG; failures become {"kind":"error"} records.
run() {
  local out code
  out=$(mktemp)
  cmd_for "$2"
  "${CMD[@]}" "$@" >"$out" 2>&1
  code=$?
  grep '^RESULT ' "$out" | sed 's/^RESULT //' >>"$RES"
  cat "$out" >>"$LOG"
  if [ $code -ne 0 ] && [ "${EXPECT_KILL:-}" != 1 ]; then
    note "FAILED ($code): $*"
    CODE=$code ERR_TAIL=$(tail -c 1500 "$out") node -e 'process.stdout.write(JSON.stringify({at:new Date().toISOString(),kind:"error",runtime:process.argv[1],step:process.argv[2],args:process.argv.slice(3).join(" "),code:Number(process.env.CODE),tail:process.env.ERR_TAIL})+"\n")' "$RT" "$STEP" "$@" >>"$RES"
  fi
  rm -f "$out"
  return 0
}
sizes_of() { ls "$W"/"$1"-[0-9]*.db 2>/dev/null | sed -E 's/.*-([0-9]+)\.db$/\1/' | sort -n | tr '\n' ' '; }

step_record() { # phase → {"kind":"step"} with host load and the frequency state of the CPUs we run on
  node -e '
const fs = require("fs");
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; } };
const cpus = (read("/sys/fs/cgroup/cpuset.cpus.effective") ?? "").split(",").filter(Boolean).map((c) => c.split("-")[0]);
const freq = Object.fromEntries(cpus.map((c) => [c, { governor: read(`/sys/devices/system/cpu/cpu${c}/cpufreq/scaling_governor`), curKHz: Number(read(`/sys/devices/system/cpu/cpu${c}/cpufreq/scaling_cur_freq`)) || null }]));
process.stdout.write(JSON.stringify({ at: new Date().toISOString(), kind: "step", step: process.argv[1], runtime: process.argv[2], phase: process.argv[3], loadavg: read("/proc/loadavg"), cpus: freq }) + "\n");
' "$STEP" "$RT" "$1" >>"$RES"
}
step_record start
trap 'step_record end' EXIT
note "step $STEP on $RT start (other bench processes: $(pgrep -fc 'dist/(node|node-head)\.mjs|dist/bun-(entry|head)\.js' || true))"
case "$STEP" in
smoke)
  for s in $SYSTEMS; do
    run build "$s" "$W/smoke" 0,2
  done
  # Same scripted dialogue (turns, manual compaction, reset) on 1.0.4 and HEAD: compare model requests and transcript.
  for s in $SYSTEMS; do
    [ "$s" = tardie ] || run correctness "$s" "$W/correctness-$s.db"
  done
  ;;
cold)
  for s in $SYSTEMS; do
    for i in $(seq 0 "$COLD_RUNS"); do
      [ "$i" = 0 ] && export BENCH_WARMUP=1 || unset BENCH_WARMUP
      BENCH_LAUNCH_NS=$(date +%s%N) run cold "$s" "$W"
    done
  done
  ;;
version)
  for s in $SYSTEMS; do
    ckpts="none"; [ "$s" = tardie ] && ckpts="none present"
    for mode in quiescent inflight; do
      for ck in $ckpts; do
        for change in control system tool schema; do
          db="$W/v-$s-$mode-$ck-$change.db"
          EXPECT_KILL=1 run vsetup "$s" "$db" "$mode" "$ck"
          run vreopen "$s" "$db" "$change" "$ck"
        done
      done
    done
  done
  ;;
dialogue-small | dialogue-large | dialogue-xl)
  SIZES=$DIALOGUE_SMALL; [ "$STEP" = dialogue-large ] && SIZES=$DIALOGUE_LARGE; [ "$STEP" = dialogue-xl ] && SIZES=$DIALOGUE_XL
  mkdir -p "$W/dlg"
  n_sys=$(echo $SYSTEMS | wc -w); i_sys=0
  for s in $SYSTEMS; do
    i_sys=$((i_sys + 1))
    if [ "$STEP" = dialogue-xl ]; then
      # Optional size: share the time left before SUITE_DEADLINE (minus 20 min for profiles and the report) among the
      # builds still to come (this runtime and, on node, bun too). The build's own projection skips what cannot fit.
      left=$(( ${SUITE_DEADLINE:-0} - $(date +%s) - 1200 ))
      builds_left=$(( n_sys - i_sys + 1 )); [ "$RT" = node ] && builds_left=$(( builds_left + n_sys ))
      if [ "$left" -le 0 ]; then note "skip $s $SIZES: past the suite deadline"; continue; fi
      export BUILD_EXTRA_BUDGET_S=$(( left / builds_left ))
      note "budget for $s to $SIZES: ${BUILD_EXTRA_BUDGET_S}s"
    fi
    note "build $s to $SIZES"
    run build "$s" "$W/dlg" "$SIZES"
    for n in ${SIZES//,/ }; do
      db="$W/dlg/$s-$n.db"
      [ -f "$db" ] || { note "skip $s $n (not built)"; continue; }
      note "measure $s $n"
      run warm "$s" "$db" tool "$RUNS" "$WARMUP"
      run warm "$s" "$db" chat "$RUNS" "$WARMUP"
      for i in $(seq 0 "$REOPEN_RUNS"); do
        [ "$i" = 0 ] && export BENCH_WARMUP=1 || unset BENCH_WARMUP
        run reopen "$s" "$db"
      done
      unset BENCH_WARMUP
    done
  done
  ;;
app)
  mkdir -p "$W/app"
  for sv in "tardie counter" "tardie array" "pi counter" "pi array" "pi entries" "pi-head counter" "pi-head array" "pi-head entries"; do
    set -- $sv
    case " $SYSTEMS " in *" $1 "*) ;; *) continue ;; esac
    note "appbuild $1 $2 to $APP_SIZES"
    run appbuild "$1" "$W/app" "$2" "$APP_SIZES"
    for n in ${APP_SIZES//,/ }; do
      db="$W/app/$1-app-$2-$n.db"
      [ -f "$db" ] && run appwarm "$1" "$db" "$2" "$RUNS" "$WARMUP"
    done
  done
  ;;
stream)
  for s in $SYSTEMS; do
    for n in $(sizes_of "dlg/$s"); do
      BENCH_DELTAS=$STREAM_DELTAS run warm "$s" "$W/dlg/$s-$n.db" chat "$RUNS" "$WARMUP"
    done
  done
  ;;
profile)
  [ "$RT" = node ] || { note "profiles are Node-only"; exit 0; }
  for s in $SYSTEMS; do
    n=$(sizes_of "dlg/$s" | awk '{print $NF}')
    [ -n "$n" ] || continue
    for what in turn commit; do
      out="results/profiles/$s-$n-$what.json"
      run profile "$s" "$W/dlg/$s-$n.db" "$what" 20 "$out"
      node scripts/profsum.mjs "$out" "$(bundle_map "$s")" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({at:new Date().toISOString(),kind:"profsum",runtime:"node",system:process.argv[1],turns:Number(process.argv[2]),what:process.argv[3],...r})+"\n")})' "$s" "$n" "$what" >>"$RES"
      gzip -f "$out"
    done
  done
  ;;
*)
  echo "unknown step $STEP" >&2
  exit 2
  ;;
esac
note "step $STEP on $RT done"
