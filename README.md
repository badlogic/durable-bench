# durable-bench

A comparison of [`pi-durable`](https://github.com/earendil-works/pi-durable) and [`tardigrade`](https://github.com/tardigrade-dev/tardigrade) on SQLite-backed Cloudflare Durable Objects, running locally with Miniflare. It compares warm and cold threads across conversation sizes, measuring response latency, SQLite storage growth, startup and open time, memory use, and CPU load. Both targets use the same scripted model and tool.

Sample run on a MacBook Air (Apple M5, 10 cores, 32 GB RAM, macOS 26.6.2). Lower is better; each bar is roughly 50 ms.

```text
response latency (ms)            pi-durable              tardigrade
turns                        cold       warm         cold           warm
   50                        █  41      █  20        ██  78         █  27
  250                        ██  59     █  37        ██ 122         █  33
1,000                        ███ 125    ██  94       █████ 388      █  50
3,500                        █████ 365  █████ 313    █████████ 880  ██ 123
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
