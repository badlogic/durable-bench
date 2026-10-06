# durable-bench

A comparison of [`pi-durable`](https://github.com/earendil-works/pi-durable) and [`tardigrade`](https://github.com/tardigrade-dev/tardigrade) on SQLite-backed Cloudflare Durable Objects, running locally with Miniflare. It compares warm and cold threads across conversation sizes, measuring response latency, SQLite storage growth, startup and open time, memory use, and CPU load. Both targets use the same scripted model and tool.

Sample run on a MacBook Air (Apple M5, 10 cores, 32 GB RAM, macOS 26.6.2).

```text
response latency (ms)            pi-durable              tardigrade
turns                        cold       warm         cold           warm
   50                        █  41      █  20        ██  78         █  27
  250                        ██  59     █  37        ██ 122         █  33
1,000                        ███ 125    ██  94       █████ 388      █  50
3,500                        █████ 365  █████ 313    █████████ 880  ██ 123
```

## Fork: pi-durable from source

This fork adds a `pi-head` target: the same benchmark agent (`src/pi-head.ts`) with `pi-durable`, `pi-ai`, and `chord` built from the TypeScript sources of a pi checkout (`PI_SOURCE`, default `../pi`; label it with `PI_HEAD_VERSION`). It opens storage with pi-durable's own Durable Object adapter, `openDurableObjectSqliteStorage(ctx.storage)`, instead of the hand-written facade in `src/pi.ts`. Everything else (scripted model, tool, turns, sizes, measurements) is unchanged.

Results and slides comparing Tardigrade with pi-durable are in [`pi-vs-tardigrade/`](pi-vs-tardigrade). A second benchmark outside of Durable Objects, covering commit latency, reopen, memory, and versioning, is in [`harness/`](harness).

```sh
PI_SOURCE=../pi PI_HEAD_VERSION=$(git -C ../pi rev-parse --short HEAD) bun run seed pi-head
PI_SOURCE=../pi PI_HEAD_VERSION=$(git -C ../pi rev-parse --short HEAD) bun run bench pi-head
```

## Setup

Install [Bun](https://bun.sh), then run from the repository root:

```sh
bun install
bun run check
```

## Quick run

Seed a small conversation history for each target, benchmark it, then print a comparison:

```sh
bun run seed pi 50
bun run seed tardie 50
bun run bench pi 50
bun run bench tardie 50
bun run report
```

## Full benchmark

Omit the history size to use the defaults: 50, 250, 1,000, and 3,500 turns.

```sh
bun run seed pi
bun run seed tardie
bun run bench pi
bun run bench tardie
bun run report
```

Each size gets three samples in a fresh runtime. The benchmark waits for CPU usage below 8%, then runs ten eight-tool call turns. Seed larger histories sequentially on an otherwise idle machine. Historical turns repeat a one-tool, one-tool, zero-tool pattern.

Use ascending custom sizes and optionally override samples or the CPU threshold:

```sh
bun run seed pi 100 500
SAMPLES=1 CPU_MAX=0.15 bun run bench pi 100 500
```

Repeat with `tardie` to compare the same sizes.

## Results

Runs append measurements to `results/results.jsonl`. `bun run report` prints a Markdown table with:

- **cold:** median agent-open time plus first-turn time, excluding runtime startup.
- **warm:** median time across the remaining nine turns in each sample.
- **storage:** median SQLite database size after the measured turns, in decimal MB.
