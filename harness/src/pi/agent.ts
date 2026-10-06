// Pi Durable adapter: minimal custom pi-ai provider, one echo tool, compaction off.
import { writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
	type ConversationDocToken,
	createRegistry,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTool,
	Harness,
	type JsonObject,
	type Storage,
	section,
} from "@earendil-works/pi-durable";
import {
	BOOKKEEPING_PAYLOAD,
	blockFile,
	CHAT_ANSWER,
	CONTEXT_WINDOW,
	decide,
	deltas,
	EXTRA_TOOL_DESCRIPTION,
	EXTRA_TOOL_NAME,
	FINAL_ANSWER,
	SYSTEM_PROMPT,
	SYSTEM_PROMPT_V2,
	split,
	TOOL_ARG,
	TOOL_CALL_TEXT,
	TOOL_DESCRIPTION,
	TOOL_NAME,
	TOOL_OUTPUT,
	USAGE,
	userText,
} from "../common.ts";
import type { Agent, OpenOptions } from "../driver.ts";

const ctx = BACKGROUND_CONTEXT;
const API = "bench-fake";
const usage = {
	input: USAGE.input,
	output: USAGE.output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: USAGE.input + USAGE.output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Msg = { role: string; content?: unknown };
const textOf = (m: Msg | undefined): string => {
	if (!m) return "";
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) return m.content.map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("");
	return "";
};

let callCount = 0;
/** Model request messages, recorded only during the correctness script (cloning costs O(context) per call). */
const requestLog: unknown[] = [];
let recordRequests = false;
/** Deterministic fake provider: O(1) per call, constant usage, N text deltas. */
function fakeStream(model: { id: string; provider: string }, context: { messages: Msg[] }) {
	const stream = createAssistantMessageEventStream();
	// pi appends positional system entries (prompt/tool changes) right before a request; skip them.
	const last = context.messages.findLast((m) => m.role !== "system");
	const decision = decide(last?.role, textOf(last));
	const n = ++callCount;
	if (recordRequests) requestLog.push(structuredClone(context.messages));
	queueMicrotask(() => {
		const text = decision.kind === "tool-call" ? TOOL_CALL_TEXT : decision.kind === "final" ? FINAL_ANSWER : CHAT_ANSWER;
		const base = { role: "assistant" as const, api: API, provider: model.provider, model: model.id, usage, timestamp: Date.now() };
		// biome-ignore lint: event payloads follow pi-ai's AssistantMessageEvent union
		const partial: any = { ...base, content: [], stopReason: "pending" };
		stream.push({ type: "start", partial: { ...partial } });
		partial.content = [{ type: "text", text: "" }];
		stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
		for (const delta of split(text, deltas())) {
			partial.content[0].text += delta;
			stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...partial } });
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: { ...partial } });
		const content: unknown[] = [{ type: "text", text }];
		if (decision.kind === "tool-call") {
			const call = { type: "toolCall", id: `call_${n}`, name: TOOL_NAME, arguments: { text: TOOL_ARG } };
			partial.content = [...partial.content, { ...call, arguments: {} }];
			stream.push({ type: "toolcall_start", contentIndex: 1, partial: { ...partial } });
			partial.content[1] = call;
			stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: { ...partial } });
			content.push(call);
		}
		const message = { ...base, content, stopReason: decision.kind === "tool-call" ? "toolUse" : "stop" };
		// biome-ignore lint: see above
		stream.push({ type: "done", reason: message.stopReason as any, message: message as any });
		// biome-ignore lint: see above
		stream.end(message as any);
	});
	return stream;
}

const provider = createProvider({
	id: "fake",
	auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
	models: [
		{
			id: "fake",
			name: "Fake",
			api: API,
			provider: "fake",
			baseUrl: "http://localhost:0",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CONTEXT_WINDOW,
			maxTokens: 16384,
		},
	],
	// biome-ignore lint: provider stream signature is generic over the API union
	api: { stream: fakeStream as any, streamSimple: fakeStream as any },
	// biome-ignore lint: see above
} as any);

const echo = defineTool({
	name: TOOL_NAME,
	description: TOOL_DESCRIPTION,
	parameters: Type.Object({ text: Type.String() }),
	execute: async () => {
		const file = blockFile();
		if (file) {
			writeFileSync(file, "in-tool");
			await new Promise(() => {});
		}
		return { content: [{ type: "text" as const, text: TOOL_OUTPUT }] };
	},
});
const clock = defineTool({
	name: EXTRA_TOOL_NAME,
	description: EXTRA_TOOL_DESCRIPTION,
	parameters: Type.Object({ zone: Type.String() }),
	execute: async () => ({ content: [{ type: "text" as const, text: "2026-01-01T00:00:00Z" }] }),
});

const NoteEntry = defineEntry<{ p: string }>("bench.note");
type CounterDoc = { count: number; last: string; label?: string };
type ArrayDoc = { items: string[] };
const counterV1 = defineDoc<CounterDoc>({
	kind: "bench.counter",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ count: 0, last: "" }),
});
const counterV2 = defineDoc<CounterDoc>({
	kind: "bench.counter",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ count: 0, last: "", label: "v2" }),
	migrate: (value) => ({ ...value, label: "v2" }),
});
const arrayDoc = defineDoc<ArrayDoc>({
	kind: "bench.array",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

export async function openPi(storage: Storage, options: OpenOptions): Promise<Agent> {
	const models = createModels();
	models.setProvider(provider);
	const registry = createRegistry();
	const prompt = options.variant?.system === "v2" ? SYSTEM_PROMPT_V2 : SYSTEM_PROMPT;
	registry.install(
		defineExtension({
			name: "bench",
			tools: options.variant?.extraTool ? [echo, clock] : [echo],
			sections: [section("preamble", () => prompt, { tag: false })],
		}),
	);
	const t0 = performance.now();
	const harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false } } }, ctx);
	const root = await harness.root(ctx, { agent: { model: { provider: "fake", modelId: "fake" } } });
	const openMs = performance.now() - t0;
	const counter = options.variant?.stateV2 ? counterV2 : counterV1;
	const docToken = (kind: "counter" | "array") => (kind === "counter" ? counter : arrayDoc) as unknown as ConversationDocToken<JsonObject>;
	let n = 0;
	const agent: Agent = {
		openMs,
		async turn(kind, onCommitted) {
			const i = n++;
			const a = performance.now();
			const sub = await root.submit({ type: "input", content: userText(kind, i) }, ctx);
			const b = performance.now();
			onCommitted?.();
			const settled = await sub.wait(ctx);
			const c = performance.now();
			if (settled.status !== "done") throw new Error(`pi turn not done: ${JSON.stringify(settled).slice(0, 400)}`);
			return { ms: c - a, commitMs: b - a };
		},
		async start(kind) {
			await root.submit({ type: "input", content: userText(kind, n++) }, ctx);
		},
		async bookkeep(kind, i) {
			await root.commit(async (tx) => {
				if (kind === "entries") {
					await tx.appendEntry(NoteEntry, root.id, { data: { p: BOOKKEEPING_PAYLOAD } });
					return;
				}
				const doc = (await tx.doc(docToken(kind), root.id)) as unknown as CounterDoc & ArrayDoc;
				if (kind === "array") doc.items.push(BOOKKEEPING_PAYLOAD);
				else {
					doc.count = i + 1;
					doc.last = BOOKKEEPING_PAYLOAD;
				}
			}, ctx);
		},
		async scripted() {
			// Short scripted dialogue with a manual compaction and a reset; returns every model request and the final
			// transcript for comparison across pi variants.
			requestLog.length = 0;
			recordRequests = true;
			const steps: string[] = [];
			await agent.turn("tool");
			await agent.turn("chat");
			await agent.turn("tool");
			const compaction = await root.compact("Keep the echo results", ctx);
			const settled = await harness.waitForTask(compaction, ctx);
			steps.push(`compaction:${(settled.state as { outcome?: { status?: string } }).outcome?.status ?? "?"}`);
			await root.waitForIdle(ctx);
			await agent.turn("tool");
			await root.reset("Continue from this handoff note.", ctx);
			await root.waitForIdle(ctx);
			await agent.turn("chat");
			await agent.turn("tool");
			const entries = [];
			let cursor: Parameters<typeof root.entries>[2];
			do {
				const page = await root.entries({}, 256, cursor, ctx);
				entries.push(...page.items);
				cursor = page.next;
			} while (cursor !== undefined);
			recordRequests = false;
			const finalContext = (await root.context(ctx)).messages;
			return { steps, requests: structuredClone(requestLog), transcript: entries.reverse(), context: finalContext };
		},
		async readState() {
			return (await harness.snapshot(docToken("counter") as never, root.id, ctx)) as unknown;
		},
		async recover() {
			harness.resume();
			await root.waitForIdle(ctx);
			const view = await root.context(ctx);
			const tail = view.messages.slice(-4).map((m) => {
				const msg = m as Msg & { isError?: boolean; stopReason?: string };
				const text = textOf(msg).slice(0, 80);
				return `${msg.role}${msg.isError ? "(error)" : ""}${msg.stopReason ? `[${msg.stopReason}]` : ""}: ${text}`;
			});
			return { tail };
		},
		async close() {
			await harness.close(ctx);
		},
	};
	return agent;
}
