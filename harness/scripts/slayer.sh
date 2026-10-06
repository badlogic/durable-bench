#!/usr/bin/env bash
# Run the suite on the dedicated host "slayer" in one pinned container, detached, and pull the results back.
#   bash scripts/slayer.sh start    copy the tree, build the image, start the run (prints host state)
#   bash scripts/slayer.sh status   container state, current step, host load
#   bash scripts/slayer.sh pull     copy results/, charts/, README.md, report.html back into this checkout
#   bash scripts/slayer.sh stop     stop the run
# Transfers use tar over ssh. Host rules: nothing is installed on the host; only names prefixed "dhb-" and ~/durable-harness-bench are touched.
# CPU: --cpuset-cpus=4 = one hardware thread of a P-core on the i9-13900 (its HT sibling 5 is left unused by us).
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=${SLAYER_KEY:-$HOME/.pi/mobile/ssh/keys/slayer}
SSH_OPTS=(-i "$KEY" -o UserKnownHostsFile="$HOME/.pi/mobile/ssh/known_hosts" -o HostKeyAlias=pi-env-slayer -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=30)
HOST=${SLAYER_HOST:-badlogic@slayer.marioslab.io}
REMOTE=durable-harness-bench
IMAGE=dhb-bench
NAME=dhb-run
CPUS=${CPUS:-4}
# The host drops bursts of new connections; retry connection failures (exit 255) with backoff.
ssh_() {
  local i code
  for i in 1 2 3 4 5; do
    ssh "${SSH_OPTS[@]}" "$HOST" "$@" && return 0
    code=$?
    [ $code -eq 255 ] || return $code
    sleep $((i * 15))
  done
  return 255
}
# tar over ssh (no rsync needed on either side): the tree is replaced, never merged.

case "${1:-}" in
start)
  if ssh_ "docker ps -q -f name=^${NAME}\$" | grep -q .; then echo "$NAME is already running"; exit 1; fi
  ssh_ "mkdir -p ~/$REMOTE/src ~/$REMOTE/out"
  tar czf - --exclude=./node_modules --exclude=./dist --exclude=./work --exclude=./.git --exclude=./results --exclude=./charts . \
    | ssh_ "rm -rf ~/$REMOTE/src && mkdir -p ~/$REMOTE/src && tar xzf - -C ~/$REMOTE/src"
  ssh_ "cd ~/$REMOTE/src && docker build -q -t $IMAGE:latest . >/dev/null && echo image built: \$(docker image inspect -f '{{.Id}}' $IMAGE:latest)"
  ssh_ "rm -rf ~/$REMOTE/out/* 2>/dev/null; f=~/$REMOTE/out/host-info.txt; { echo host cpu: \$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2-); echo host kernel: \$(uname -r); echo docker: \$(docker version --format '{{.Server.Version}}'); echo image: \$(docker image inspect -f '{{.Id}}' $IMAGE:latest); for c in $CPUS 5; do d=/sys/devices/system/cpu/cpu\$c; echo cpu\$c: siblings \$(cat \$d/topology/thread_siblings_list) governor \$(cat \$d/cpufreq/scaling_governor) driver \$(cat \$d/cpufreq/scaling_driver) epp \$(cat \$d/cpufreq/energy_performance_preference 2>/dev/null) max_khz \$(cat \$d/cpufreq/scaling_max_freq); done; echo host loadavg before: \$(cat /proc/loadavg); echo host containers running: \$(docker ps -q | wc -l); } > \$f; cat \$f"
  # Size/run-count overrides (for a quick plumbing pass) are passed through when set locally.
  ENVS=""; for v in RUNS WARMUP REOPEN_RUNS COLD_RUNS DIALOGUE_SMALL DIALOGUE_LARGE DIALOGUE_XL APP_SIZES; do [ -n "${!v:-}" ] && ENVS="$ENVS -e $v=${!v}"; done
  ssh_ "docker run -d --rm --name $NAME$ENVS --cpuset-cpus=$CPUS --memory=8g --memory-swap=8g --user \$(id -u):\$(id -g) -e OUT=/out -e RUN_LABEL=slayer -e HOST_LABEL=slayer -e SUITE_HOURS=${SUITE_HOURS:-3} -v ~/$REMOTE/out:/out $IMAGE:latest"
  ;;
status)
  ssh_ "docker ps -f name=^${NAME}\$ --format '{{.Names}} {{.Status}}'; echo load: \$(cat /proc/loadavg); ls -t ~/$REMOTE/out/results/logs 2>/dev/null | head -1 | xargs -I{} tail -n 3 ~/$REMOTE/out/results/logs/{}; wc -l < ~/$REMOTE/out/results/results.jsonl 2>/dev/null"
  ;;
pull)
  rm -rf results charts
  ssh_ "cd ~/$REMOTE/out && tar czf - results \$(ls -d charts README.md report.html 2>/dev/null)" | tar xzf -
  echo "pulled: $(wc -l < results/results.jsonl) result lines"
  ;;
stop)
  ssh_ "docker stop $NAME"
  ;;
*)
  echo "usage: $0 start|status|pull|stop" >&2
  exit 2
  ;;
esac
