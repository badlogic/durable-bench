// Shared workload definition. Both systems use exactly these strings and sizes.
import { readFileSync } from "node:fs";
import { cpus } from "node:os";

const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
/** Deterministic filler text of exactly `n` characters. */
export const filler = (n: number, seed = 0): string => {
	let s = "";
	for (let i = 0; s.length < n; i++) s += `${words[(i * 7 + seed) % 10]} `;
	return s.slice(0, n);
};

export const SYSTEM_PROMPT = `You are a benchmark assistant. Answer briefly and use the echo tool when asked. ${filler(220, 1)}`;
export const SYSTEM_PROMPT_V2 = `You are a benchmark assistant speaking like a pirate. Use the echo tool when asked. ${filler(200, 2)}`;
export const TOOL_NAME = "echo";
export const TOOL_DESCRIPTION = "Echo text back (fixed-size output)";
export const EXTRA_TOOL_NAME = "clock";
export const EXTRA_TOOL_DESCRIPTION = "Return a fixed timestamp";
/** User text prefixes select the fake model's behaviour. */
export const TOOL_PREFIX = "[tool] ";
export const CHAT_PREFIX = "[chat] ";
export const userText = (kind: "tool" | "chat", i: number) => `${kind === "tool" ? TOOL_PREFIX : CHAT_PREFIX}${i} ${filler(150, i)}`;
export const TOOL_CALL_TEXT = "Let me check that with the echo tool.";
export const TOOL_ARG = filler(64, 3);
export const TOOL_OUTPUT = filler(256, 4);
export const FINAL_ANSWER = filler(300, 5);
export const CHAT_ANSWER = filler(300, 6);
export const BOOKKEEPING_PAYLOAD = "x".repeat(88);
/** Constant usage reported by both fakes on every call (never derived from the prompt). */
export const USAGE = { input: 1000, output: 100 };
export const CONTEXT_WINDOW = 100_000_000;
/** Text deltas per model answer; the streaming axis raises it. */
export const deltas = () => Math.max(1, Number(process.env.BENCH_DELTAS ?? 1));
/** Split text into `n` nearly equal deltas. */
export const split = (text: string, n: number): string[] => {
	const size = Math.ceil(text.length / n);
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
};

export type Decision = { kind: "tool-call" } | { kind: "final" } | { kind: "chat" };
/** Shared decision rule: last message is a tool result → final answer; user "[tool]" → tool call; otherwise chat answer. */
export const decide = (lastRole: string | undefined, lastText: string): Decision => {
	if (lastRole === "tool" || lastRole === "toolResult") return { kind: "final" };
	if (lastText.startsWith(TOOL_PREFIX)) return { kind: "tool-call" };
	return { kind: "chat" };
};

/** Tool blocking: when this env var names a file, the tool writes it and never returns (crash simulation). */
export const blockFile = () => process.env.BENCH_BLOCK_TOOL;

export const runtimeName = (): "bun" | "node" => ("Bun" in globalThis ? "bun" : "node");
export const runtimeVersion = (): string => (runtimeName() === "bun" ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}` : `node ${process.version}`);
const cpuModel = () => {
	const model = cpus()[0]?.model;
	if (model) return model;
	try {
		return /^(model name|Hardware)\s*:\s*(.+)$/m.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[2] ?? "unknown";
	} catch {
		return "unknown";
	}
};
/** Commit of the pi checkout this bundle was built from (Pi Durable HEAD bundles only; set by the bundler). */
export const piHeadSha = (): string | undefined => (globalThis as { __BENCH_PI_HEAD__?: string }).__BENCH_PI_HEAD__;
export const env = () => ({
	runtime: runtimeName(),
	runtimeVersion: runtimeVersion(),
	step: process.env.BENCH_STEP ?? null,
	warmup: process.env.BENCH_WARMUP === "1",
	cpu: cpuModel(),
	cpus: cpus().length,
	platform: `${process.platform}-${process.arch}`,
	...(piHeadSha() ? { piHeadSha: piHeadSha() } : {}),
});

export const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length === 0 ? Number.NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const stats = (xs: number[]) => ({ median: r3(median(xs)), min: r3(Math.min(...xs)), max: r3(Math.max(...xs)), n: xs.length, samples: xs.map(r3) });

export const gc = () => {
	const g = globalThis as unknown as { gc?: () => void; Bun?: { gc: (force: boolean) => void } };
	if (g.Bun) g.Bun.gc(true);
	else if (g.gc) {
		g.gc();
		g.gc();
	}
};
export const memory = () => {
	gc();
	const m = process.memoryUsage();
	return { heapUsedMB: r3(m.heapUsed / 2 ** 20), rssMB: r3(m.rss / 2 ** 20) };
};

/** One JSON result line on stdout, prefixed so the orchestrator can filter it from logs. */
export const emit = (record: Record<string, unknown>) => {
	process.stdout.write(`RESULT ${JSON.stringify({ at: new Date().toISOString(), ...env(), ...record })}\n`);
};
