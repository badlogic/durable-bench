# Harness benchmark

Our second benchmark, run outside of Durable Objects: Node 24 and Bun 1.4.2, SQLite files, one process per measurement. It complements the main benchmark in this repository with the axes that one does not cover: commit latency, reopen, memory, app-state growth, versioning, and CPU profiles.

Systems:

- **Tardigrade** (`tardie@0.44.0` from npm, [clavia-labs/tardigrade](https://github.com/clavia-labs/tardigrade)): event-sourced actor runtime; every change is a journal event, state is derived by reducers/atoms, with periodic checkpoints.
- **Pi Durable 1.0.4** (`@earendil-works/pi-durable@1.0.4` from npm, with `pi-ai`/`chord` 1.0.4): transcript entries + typed documents + durable tasks, committed in SQLite transactions.
- **Pi Durable HEAD**: [earendil-works/pi](https://github.com/earendil-works/pi) at the commit in [`pi-head.sha`](pi-head.sha), or a local checkout in `$PI_HEAD_DIR`.

The results in [`../pi-vs-tardigrade/data/harness-pi-head-vs-tardie.jsonl`](../pi-vs-tardigrade/data/harness-pi-head-vs-tardie.jsonl) compare Tardigrade with Pi Durable HEAD `da866ada` on Node. They were produced by [`run-pi-vs-tardie.sh`](run-pi-vs-tardie.sh) in the Docker image built from [`Dockerfile`](Dockerfile), pinned to one P-core hardware thread of an i9-13900.

**Pi HEAD build.** `scripts/fetch-pi-head.sh` fetches the pinned commit and runs `npm ci --ignore-scripts` in the checkout. `scripts/pi-head.mjs` resolves `@earendil-works/*` imports to the checkout's TypeScript sources through each package's `source` export condition; pi-ai's `dist/*.js` exports, including `utils/*`, are mapped to `src/*.ts`. esbuild (Node) and `Bun.build` (Bun) bundle that like the npm code. The pi repo's own build and test scripts never run.

Run from this directory: `npm ci --ignore-scripts && bash scripts/fetch-pi-head.sh && npm run bench` (Node and Bun needed). For a quick pass, set `DIALOGUE_SMALL=0,5 DIALOGUE_LARGE=20 DIALOGUE_XL=none APP_SIZES=0,50 RUNS=3`. One step: `bash scripts/bench.sh dialogue-small node`; `SYSTEMS="tardie pi-head"` selects systems. Charts and report from `results/`: `npm run charts`.

## What is measured

The unit is a **dialogue turn**: user message → assistant text + one `echo` tool call → tool result → final answer (a "tool turn"), plus a short **no-tool turn** (user → answer). Histories are built through each system's real agent loop, never by inserting rows.

| # | Axis | How |
|---|---|---|
| 1 | Warm turn latency vs dialogue length | Turns ∈ 0, 25, 100, 300, 1000, 3000. 10000 is optional (`DIALOGUE_XL`); it was skipped in this run because building a history costs time quadratic in its length (per-turn cost grows linearly). Fresh process per point: open a copy of the snapshot, 2 warm-up turns, then 9 measured turns; tool and no-tool turns in separate processes. |
| 2 | Warm turn vs app-state growth | Short dialogue (3 tool turns) + N app-state edits (one commit each, 88-byte payload, never read by the model). Tardigrade: N `BenchNote` events reduced by a `durableAtom` (counter) / N `BenchItem` events into a growing-array atom. Pi, idiomatic: N edits of a conversation-scoped `defineDoc` document (counter overwrite / growing array). Pi, non-idiomatic: N custom transcript entries without model messages — plotted dashed as "what the vendor chart likely measured". |
| 3 | Single input-commit latency | Time until the input-admission call returns (`runtime.send([TurnRequested])` / `conversation.submit()`), from the warm tool turns. |
| 4 | Cumulative build time | Sum of tool-turn latencies while growing the history (exposes linear vs super-linear growth). |
| 5 | Restart | Fresh process per run (1 warm-up + 9): open + replay ("reopen only"), then the first tool turn. |
| 6 | Disk | SQLite file size after close; Tardigrade checkpoint payload size. |
| 7 | Memory | `heapUsed` after forced GC right after opening the thread (fresh restart process), and `heapUsed`/RSS after open + 11 turns (warm process). |
| 8 | Cold start | Shell timestamp before launching the process → first answer on an empty DB. |
| 9 | Versioning | Pass/fail matrix with error text: change system prompt, add a tool, change the durable state schema (Tardigrade `durableAtom` schema / pi document version 2 with `migrate`); reopened after quiescence and after a SIGKILL inside a tool call; Tardigrade with and without a checkpoint. |
| 10 | Explanation | V8 CPU profiles (Node, `node:inspector`) of the measured windows only, at the largest size, for the warm tool turn and the input commit; `scripts/profsum.mjs` maps samples back through the bundle's source map and sums them into categories. |
| – | Streaming | No-tool turn with the answer streamed as 50 instant deltas, at the small sizes (≤ 300 turns). |
| – | Request equivalence | Pi 1.0.4 vs HEAD, informational: one scripted dialogue (3 turns, manual compaction, 1 turn, reset, 2 turns); hashes of every model request's messages and of the final transcript (timestamps removed). |

## Fairness rules

- **Pinned versions from npm**: `tardie@0.44.0`, `@earendil-works/pi-durable@1.0.4`, `@earendil-works/pi-ai@1.0.4`, `@earendil-works/chord@1.0.4`, `effect@4.0.0-rc.115` (tardie's own pin), `@effect/sql-sqlite-bun@4.0.0-rc.115`. Exact versions, lockfile committed, `npm ci --ignore-scripts`. Pi HEAD uses the third-party dependency versions from the pi repo's own lockfile at the pinned commit.
- **Runtimes**: the full suite runs on **Node 24.21.0** and on **Bun 1.4.2** for all three. All are bundled the same way (esbuild for Node, `bun build` for Bun) so cold start compares like with like; tardie ships TypeScript with constructs Node's type stripping rejects, so it cannot run unbundled on Node.
- **Storage**: SQLite, WAL, `synchronous=NORMAL`, one connection per DB, `BEGIN IMMEDIATE` transactions, statement cache, 5 s busy timeout, for both systems on both runtimes.
  - Tardigrade uses its own `sqlJournal` (`platform/shared/sql-journal.ts`) — on Bun with `@effect/sql-sqlite-bun` exactly as `bunJournal()` does, on Node with a line-for-line `node:sqlite` port of that Effect SQL client (`src/tardie/sqlite-node.ts`). `synchronous=NORMAL` is added on the journal's connection (the Bun client sets WAL but leaves `synchronous` at SQLite's default FULL; we set NORMAL for parity). Default checkpoint policy (every 500 events).
  - Pi (1.0.4 and HEAD) uses its own `openNodeSqliteStorage` on Node; on Bun its portable `SqliteStorage` core over a `bun:sqlite` facade that mirrors the Node adapter line by line (`src/pi/sqlite-bun.ts`).
- **One deterministic fake model**, written for each system at its provider boundary: a minimal pi-ai provider (`createProvider`, `src/pi/agent.ts`) and a fake Effect `LanguageModel` consumed by tardie's stock `modelServices()` Model service (`src/tardie/agent.ts`). Both are O(1) per call (they look only at the last message), instant, return fixed payloads (tool-call text 37 chars + a 64-char argument, final answer 300 chars), report constant usage (1000 in / 100 out) — pi's built-in faux provider is *not* used because its token estimate serialises the whole context on every call. The answer is one text delta (50 on the streaming axis).
- **Same agent**: same ~300-char system prompt, one `echo` tool returning a fixed 256-char string, compaction off (pi `settings.compaction.enabled=false`; tardie's context atom passes the durable message list straight to `infer` without the `compact` wrapper), 100M-token context window.
- **Native records** per size are reported (tardie journal events; pi entries, tasks, submissions).
- **Fresh process per measurement point**, warm-up then median with min–max of ≥9 runs; every result line records timestamp, runtime, version and CPU model. Nothing is cached across runs; histories are rebuilt every run.

## Caveats

- One run on one pinned hardware thread of a production host. Other services keep running, the CPU's frequency is managed by `powersave`/intel_pstate (turbo up to 5.3 GHz), and the HT sibling may be scheduled by other work. Compare shapes and ratios rather than absolute milliseconds, and look at the min–max bars and the recorded load (`{"kind":"step"}` lines).
- The measured warm turns themselves add 11 turns to the history (2 warm-up + 9); at size 0 the "warm" thread therefore holds 0–11 turns.
- Tardigrade's Node journal driver is our port (the vendor ships only a Bun driver); its SQL and transaction structure is identical, and Bun numbers use the vendor's own driver.
- The fakes sit at different but equivalent layers: pi's provider receives pi-ai's normalised transcript; tardie's fake `LanguageModel` receives the `Prompt` tardie's `modelServices()` builds (including its per-call toolkit/JSON-schema conversion). Both are what a real provider adapter would receive.
- The versioning matrix records what happens with this harness setup; "fail" means the documented reopen path raised, not that no migration path exists.
- Profiles are Node only (V8 sampling at 200 µs); category rules are in `scripts/profsum.mjs` and are approximate by nature. "storage read/parse" includes SQLite statement execution for writes too. Profiled CPU per turn is a mean over 20 turns (Tardigrade's include the occasional checkpoint turn) plus profiler overhead, so it is higher than the median latency.
- Pi opens a conversation lazily: its "reopen only" time is near-constant and the history read moves into the first turn. Compare "reopen + first turn".
- One process per measurement, one core: garbage collection and the JIT share that core with the measured work, as they would on a busy server.
- "HEAD regressions" use a simple rule: at least 10% worse with non-overlapping min–max ranges (≥ 1 MB for memory). Changes of 10% or more that fall within the noise are listed separately.

## Results

Raw results of the published run: [`../pi-vs-tardigrade/data/harness-pi-head-vs-tardie.jsonl`](../pi-vs-tardigrade/data/harness-pi-head-vs-tardie.jsonl), one JSON object per process result. `npm run charts` renders charts, a results section, and `report.html` from `results/results.jsonl`.

<!-- RESULTS:START -->
<!-- RESULTS:END -->

## Layout

- `src/common.ts` workload constants and measurement helpers; `src/driver.ts` the system-neutral interface; `src/cli.ts` one command per process.
- `src/tardie/*`, `src/pi/*` the adapters (the pi adapter serves 1.0.4 and HEAD); `src/entry-node.ts`, `src/entry-bun.ts` runtime-specific storage wiring.
- `scripts/run-suite.sh` the whole suite in order; `scripts/bench.sh` one step; `scripts/build.mjs` / `scripts/build-bun.ts` bundles; `scripts/pi-head.mjs` + `scripts/fetch-pi-head.sh` the HEAD build; `scripts/slayer.sh` + `Dockerfile` the dedicated-host run; `scripts/profsum.mjs` profile categories; `scripts/charts.mjs` charts, README results, `report.html`.
- `results/results.jsonl` raw results (one JSON object per process result), `results/logs/`, `results/profiles/*.json.gz`, `results/environment.txt`; `charts/*.svg` (+ `.png`).
