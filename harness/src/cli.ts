// One command per process. Results are printed as `RESULT {json}` lines; scripts/bench.sh collects them.
//
//   build <system> <dir> <turns csv>                 grow one dialogue with tool turns, snapshot <dir>/<system>-<turns>.db
//   warm <system> <db> <tool|chat> <runs> <warmup>   warm turn latency (+ input-commit latency, memory)
//   reopen <system> <db>                             one restart: open (+replay) and the first turn (call R times)
//   cold <system> <dir>                              process launch → first answer on an empty DB
//   appbuild <system> <dir> <counter|array|entries> <N csv>   short dialogue + N app-state edits, snapshots
//   appwarm <system> <db> <variant> <runs> <warmup>  warm chat turn + one app-state commit at that size
//   vsetup <system> <db> <quiescent|inflight> <none|present>   versioning: create history (inflight self-SIGKILLs)
//   vreopen <system> <db> <control|system|tool|schema> <none|present>  versioning: reopen with changed code
//   profile <system> <db> <turn|commit> <runs> <out.cpuprofile>   Node only: CPU profile of measured windows
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { emit, memory, piHeadSha, r3, stats } from "./common.ts";
import type { Agent, AppState, Platform, SystemName, TurnKind, Variant } from "./driver.ts";

const files = (path: string) => ["", "-wal", "-shm"].map((s) => path + s);
const remove = (path: string) => {
	for (const f of files(path)) rmSync(f, { force: true });
};
const copyDb = (from: string, to: string) => {
	remove(to);
	for (const [i, f] of files(from).entries()) if (existsSync(f) && i < 2) copyFileSync(f, files(to)[i]!);
};
const dbBytes = (path: string) => files(path).reduce((sum, f) => sum + (existsSync(f) ? statSync(f).size : 0), 0);
const work = (db: string) => `${db}.work-${process.pid}`;

async function timedTurns(agent: Agent, kind: TurnKind, runs: number, warmup: number) {
	const ms: number[] = [];
	const commit: number[] = [];
	for (let i = 0; i < warmup + runs; i++) {
		const r = await agent.turn(kind);
		if (i >= warmup) {
			ms.push(r.ms);
			commit.push(r.commitMs);
		}
	}
	return { turn: stats(ms), commit: stats(commit) };
}

export async function main(platform: Platform, argv: string[]) {
	const [cmd, systemArg, ...rest] = argv;
	if (cmd === "build" || cmd === "appbuild" || cmd === "cold") mkdirSync(rest[0]!, { recursive: true });
	const system = systemArg as SystemName;
	// A series label must match the code in the bundle: pi-head only from a HEAD bundle, pi (1.0.4) only from npm.
	if ((system === "pi-head") !== (piHeadSha() !== undefined) && system !== "tardie") throw new Error(`system ${system} does not match this bundle (pi HEAD ${piHeadSha() ?? "absent"})`);
	const open = (file: string, variant?: Variant, checkpoint?: "default" | "manual") => platform.open(system, file, { variant, checkpoint });
	switch (cmd) {
		case "build": {
			const [dir, sizesCsv] = rest;
			const sizes = sizesCsv!.split(",").map(Number);
			let budgetMs = Number(process.env.BUILD_BUDGET_S ?? 3600) * 1000;
			const file = `${dir}/${system}-grow.db`;
			const stateFile = `${dir}/${system}-grow.json`;
			remove(file);
			let turns = 0;
			let cumulativeMs = 0;
			let lastSegment: { turns: number; ms: number; target: number } | undefined;
			// Resume from the largest earlier snapshot (the CI job builds small sizes first, large sizes in a later step).
			if (existsSync(stateFile)) {
				({ turns, cumulativeMs, lastSegment } = JSON.parse(readFileSync(stateFile, "utf8")));
				copyDb(`${dir}/${system}-${turns}.db`, file);
			}
			// BUILD_EXTRA_BUDGET_S: time allowed for the segments this process adds (on top of what was already built).
			if (process.env.BUILD_EXTRA_BUDGET_S) budgetMs = cumulativeMs + Number(process.env.BUILD_EXTRA_BUDGET_S) * 1000;
			let agent = await open(file);
			const wall0 = performance.now();
			for (const target of sizes) {
				if (target < turns) continue;
				if (lastSegment && lastSegment.turns > 0) {
					const perTurn = lastSegment.ms / lastSegment.turns;
					const projected = (target - turns) * perTurn * (target / Math.max(1, lastSegment.target)) * 1.0;
					if (cumulativeMs + projected > budgetMs) {
						emit({ kind: "build-skip", system, target, reached: turns, cumulativeMs: r3(cumulativeMs), projectedMs: r3(projected), budgetMs });
						break;
					}
				}
				const segStart = cumulativeMs;
				const segTurns = target - turns;
				while (turns < target) {
					cumulativeMs += (await agent.turn("tool")).ms;
					turns++;
				}
				lastSegment = { turns: segTurns, ms: cumulativeMs - segStart, target };
				await agent.close();
				const snap = `${dir}/${system}-${target}.db`;
				copyDb(file, snap);
				emit({
					kind: "build",
					system,
					turns: target,
					cumulativeMs: r3(cumulativeMs),
					segmentMsPerTurn: segTurns > 0 ? r3(lastSegment.ms / segTurns) : null,
					wallMs: r3(performance.now() - wall0),
					dbBytes: dbBytes(snap),
					records: platform.records(system, snap),
				});
				writeFileSync(stateFile, JSON.stringify({ turns, cumulativeMs, lastSegment }));
				agent = await open(file);
			}
			await agent.close();
			remove(file);
			break;
		}
		case "warm": {
			const [db, kind, runs, warmup] = rest;
			const w = work(db!);
			copyDb(db!, w);
			const agent = await open(w);
			const afterOpen = memory();
			const r = await timedTurns(agent, kind as TurnKind, Number(runs), Number(warmup));
			const afterTurns = memory();
			await agent.close();
			remove(w);
			emit({ kind: "warm", system, db: db!.split("/").pop(), turnKind: kind, openMs: r3(agent.openMs), ...r, memAfterOpen: afterOpen, memAfterTurns: afterTurns });
			break;
		}
		case "reopen": {
			const [db] = rest;
			const w = work(db!);
			copyDb(db!, w);
			const agent = await open(w);
			const mem = memory();
			const first = await agent.turn("tool");
			await agent.close();
			remove(w);
			emit({ kind: "reopen", system, db: db!.split("/").pop(), openMs: r3(agent.openMs), firstTurnMs: r3(first.ms), firstCommitMs: r3(first.commitMs), mem });
			break;
		}
		case "cold": {
			const [dir] = rest;
			const file = `${dir}/cold-${system}-${process.pid}.db`;
			remove(file);
			const agent = await open(file);
			const first = await agent.turn("chat");
			const launchNs = process.env.BENCH_LAUNCH_NS;
			const sinceLaunch = launchNs ? Date.now() - Number(BigInt(launchNs) / 1_000_000n) : null;
			await agent.close();
			remove(file);
			emit({ kind: "cold", system, launchToAnswerMs: sinceLaunch, inProcessMs: r3(performance.now()), openMs: r3(agent.openMs), firstTurnMs: r3(first.ms) });
			break;
		}
		case "appbuild": {
			const [dir, variant, sizesCsv] = rest;
			const sizes = sizesCsv!.split(",").map(Number);
			const file = `${dir}/${system}-app-${variant}-grow.db`;
			remove(file);
			let agent = await open(file);
			for (let i = 0; i < 3; i++) await agent.turn("tool");
			let n = 0;
			let cumulativeMs = 0;
			const budgetMs = Number(process.env.APP_BUDGET_S ?? 600) * 1000;
			for (const target of sizes) {
				if (cumulativeMs > 0 && n > 0 && cumulativeMs * (target / n) ** 1.5 > budgetMs) {
					emit({ kind: "build-skip", system, variant, target, reached: n, cumulativeMs: r3(cumulativeMs), budgetMs });
					break;
				}
				const t = performance.now();
				while (n < target) await agent.bookkeep(variant as AppState, n++);
				cumulativeMs += performance.now() - t;
				await agent.close();
				const snap = `${dir}/${system}-app-${variant}-${target}.db`;
				copyDb(file, snap);
				emit({ kind: "appbuild", system, variant, n: target, cumulativeMs: r3(cumulativeMs), dbBytes: dbBytes(snap), records: platform.records(system, snap) });
				agent = await open(file);
			}
			await agent.close();
			remove(file);
			break;
		}
		case "appwarm": {
			const [db, variant, runs, warmup] = rest;
			const w = work(db!);
			copyDb(db!, w);
			const agent = await open(w);
			const mem = memory();
			const r = await timedTurns(agent, "chat", Number(runs), Number(warmup));
			const commits: number[] = [];
			for (let i = 0; i < Number(warmup) + Number(runs); i++) {
				const t = performance.now();
				await agent.bookkeep(variant as AppState, 1_000_000 + i);
				if (i >= Number(warmup)) commits.push(performance.now() - t);
			}
			await agent.close();
			remove(w);
			emit({ kind: "appwarm", system, variant, db: db!.split("/").pop(), openMs: r3(agent.openMs), ...r, appCommit: stats(commits), mem });
			break;
		}
		case "vsetup": {
			const [db, mode, ckpt] = rest;
			remove(db!);
			const agent = await open(db!, undefined, ckpt === "none" ? "manual" : "default");
			for (let i = 0; i < 3; i++) {
				await agent.turn("tool");
				await agent.bookkeep("counter", i);
			}
			if (ckpt === "present") await agent.checkpoint?.();
			if (mode === "inflight") {
				// From now on the tool writes the marker file and blocks; we SIGKILL ourselves mid tool call.
				const marker = `${db}.marker`;
				rmSync(marker, { force: true });
				process.env.BENCH_BLOCK_TOOL = marker;
				await agent.start("tool");
				while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 5));
				rmSync(marker, { force: true });
				emit({ kind: "vsetup", system, mode, ckpt, killed: true });
				process.kill(process.pid, "SIGKILL");
			}
			await agent.close();
			emit({ kind: "vsetup", system, mode, ckpt, killed: false });
			break;
		}
		case "vreopen": {
			const [db, change, ckpt] = rest;
			const variant: Variant = change === "system" ? { system: "v2" } : change === "tool" ? { extraTool: true } : change === "schema" ? { stateV2: true } : {};
			const out: Record<string, unknown> = { kind: "version", system, change, ckpt, db: db!.split("/").pop() };
			const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
				try {
					const v = await Promise.race([fn(), new Promise<never>((_, j) => setTimeout(() => j(new Error(`timeout after 30 s`)), 30_000))]);
					out[name] = "ok";
					return v;
				} catch (error) {
					out[name] = `FAIL: ${String((error as Error)?.message ?? error).slice(0, 700)}`;
					return undefined;
				}
			};
			const agent = await step("open", () => open(db!, variant, ckpt === "none" ? "manual" : "default"));
			if (agent) {
				const recovered = await step("recover", () => agent.recover());
				if (recovered) out.recovered = recovered;
				const turn = await step("newTurn", () => agent.turn("tool"));
				if (turn) out.newTurnMs = r3(turn.ms);
				const state = await step("readState", () => agent.readState());
				if (state !== undefined) out.state = state;
				await step("close", () => agent.close());
			}
			out.pass = ["open", "recover", "newTurn", "readState"].every((k) => out[k] === "ok");
			emit(out);
			break;
		}
		case "correctness": {
			// Same scripted dialogue for every pi variant; hashes of normalized requests/transcript are compared in charts.mjs.
			const [file] = rest;
			remove(file!);
			const agent = await open(file!);
			const out = await agent.scripted!();
			await agent.close();
			remove(file!);
			const volatile = new Set(["timestamp", "createdAt", "updatedAt", "responseId", "at"]);
			const normalize = (v: unknown) => JSON.stringify(v, (k, x) => (volatile.has(k) ? undefined : x));
			const hash = (v: unknown) => createHash("sha256").update(normalize(v)).digest("hex").slice(0, 16);
			emit({
				kind: "correctness",
				system,
				steps: out.steps,
				requests: out.requests.length,
				requestMessages: out.requests.map((r) => (r as unknown[]).length),
				requestsHash: hash(out.requests),
				perRequest: out.requests.map(hash),
				transcriptEntries: out.transcript.length,
				transcriptHash: hash(out.transcript),
				contextHash: hash(out.context),
			});
			break;
		}
		case "profile": {
			const [db, what, runs, outFile] = rest;
			const { profileWindows } = await import("./profile.ts");
			const w = work(db!);
			copyDb(db!, w);
			const agent = await open(w);
			for (let i = 0; i < 3; i++) await agent.turn("tool");
			const result = await profileWindows(outFile!, Number(runs), async (mark) => {
				mark.start();
				// Commit window: only the input-admission call; the rest of the turn runs outside the window.
				await agent.turn("tool", what === "commit" ? mark.end : undefined);
				if (what === "turn") mark.end();
			});
			await agent.close();
			remove(w);
			emit({ kind: "profile", system, what, db: db!.split("/").pop(), ...result });
			break;
		}
		default:
			throw new Error(`unknown command ${cmd}`);
	}
}
