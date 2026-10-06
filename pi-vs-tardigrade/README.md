# pi-durable vs Tardigrade

Tardigrade's benchmark ([clavia-labs/durable-bench](https://github.com/clavia-labs/durable-bench)) rerun with an added `pi-head` target: pi-durable built from [earendil-works/pi](https://github.com/earendil-works/pi) main `da866ada`, using its own Durable Object adapter. The scenario is unchanged: scripted model, one lookup tool, histories built by real turns, measured turns with 8 tool calls, SQLite-backed Durable Objects on Miniflare.

Host: one Docker container pinned to two performance-core threads of an i9-13900, Bun 1.4.2. Cold = open + first turn in a fresh runtime. Warm = median of the next 9 turns. 3 fresh runtimes per size.

| turns | pi-durable cold | Tardigrade cold | pi-durable warm | Tardigrade warm |
|---:|---:|---:|---:|---:|
| 50 | 70 ms | 158 ms | 34 ms | 59 ms |
| 250 | 75 ms | 244 ms | 38 ms | 70 ms |
| 1,000 | 109 ms | 712 ms | 47 ms | 103 ms |
| 3,500 | 183 ms | 1,617 ms | 82 ms | 234 ms |

Building the 3,500-turn history: 34 s (pi-durable) vs 139 s (Tardigrade 0.44.0).

## Contents

- `slides/png/`: the slides. `slides/gen.mjs` renders them from `data/` (`node gen.mjs`, then `shoot.sh`, which uses Docker and the Chromium of the Playwright image).
- `data/durable-bench-*.jsonl`: raw results of this benchmark, including an earlier run of pi-durable 1.0.4 on the same host.
- `data/harness-pi-head-vs-tardie.jsonl`: raw results of our second benchmark (Node 24, same pi-durable commit vs tardie 0.44.0): warm turns, commit latency, reopen, memory, and the versioning matrix. `harness-run.sh` is the command used.

Reproduce the main benchmark from the repository root, with a pi checkout next to it:

```sh
bun install
export PI_SOURCE=../pi PI_HEAD_VERSION=$(git -C ../pi rev-parse --short=8 HEAD)
bun run seed pi-head && bun run bench pi-head
bun run seed tardie && bun run bench tardie
bun run report
```
