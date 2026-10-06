// Tardie adapter: createActorStore + tardie's own sqlJournal, stock modelServices() fed by a deterministic fake
// LanguageModel (the provider boundary, like pi's custom provider), one echo library tool, compaction off.
import { writeFileSync } from "node:fs";
import { Effect, Layer, Schema, Stream } from "effect";
import { Rpc } from "effect/unstable/rpc";
import { LanguageModel, Response, type Prompt } from "effect/unstable/ai";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import * as Sql from "effect/unstable/sql/SqlClient";
import { atom, durableAtom, defineActor, effectAtom, event, createActorStore, type ActorRuntime } from "tardie/core";
import { actorContext, agentMethods, infer, inferenceState, messages, ModelInfo, tools as libraryTools } from "tardie/agent";
import { modelActs, modelServices, toolActs } from "tardie/agent/services";
import { defineLibrary, MethodDescription, MethodHints } from "tardie/libraries";
import { ModelLock, modelLockOf, modelLockService } from "tardie/model/lock";
import { BindingSettings, ModelSelection } from "tardie/model/settings";
import { requestPolicyOf } from "tardie/model/stream/request";
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
import type { Agent, OpenOptions, Variant } from "../driver.ts";

/** The journal factory is runtime specific (bun:sqlite client on Bun, node:sqlite port on Node). */
export type JournalFactory = (file: string) => { readonly close: Effect.Effect<void, unknown> };

/** synchronous=NORMAL on the journal's own connection (WAL is set by the client). */
export const withNormalSync = <E>(layer: Layer.Layer<SqlClient, E>) =>
	Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* Sql.SqlClient;
			yield* sql`PRAGMA synchronous = NORMAL`;
		}),
	).pipe(Layer.provideMerge(layer)) as unknown as Layer.Layer<SqlClient, Error>;

// ---- app state: N bookkeeping events reduced by durable atoms the model never reads ----
export const BenchNote = event({ type: "BenchNote", p: Schema.String });
const counterV1 = durableAtom({
	name: "bench.counter",
	input: BenchNote,
	schema: Schema.Struct({ count: Schema.Finite, last: Schema.String }),
	initial: { count: 0, last: "" },
	reduce: (s, e) => ({ count: s.count + 1, last: e.p }),
});
const counterV2 = durableAtom({
	name: "bench.counter",
	input: BenchNote,
	schema: Schema.Struct({ count: Schema.Finite, last: Schema.String, label: Schema.String }),
	initial: { count: 0, last: "", label: "v2" },
	reduce: (s, e) => ({ count: s.count + 1, last: e.p, label: s.label }),
});
export const BenchItem = event({ type: "BenchItem", p: Schema.String });
const items = durableAtom({
	name: "bench.items",
	input: BenchItem,
	schema: Schema.Struct({ items: Schema.Array(Schema.String) }),
	initial: { items: [] as string[] },
	reduce: (s, e) => ({ items: [...s.items, e.p] }),
});

// ---- tools ----
const echoLib = defineLibrary({
	name: "bench",
	description: "Benchmark tools",
	toolNames: { echo: TOOL_NAME },
	methods: [
		Rpc.make("echo", { payload: Schema.Struct({ text: Schema.String }), success: Schema.String })
			.annotate(MethodDescription, TOOL_DESCRIPTION)
			.annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
	],
});
const clockLib = defineLibrary({
	name: "clock",
	description: "Clock",
	toolNames: { now: EXTRA_TOOL_NAME },
	methods: [
		Rpc.make("now", { payload: Schema.Struct({ zone: Schema.String }), success: Schema.String })
			.annotate(MethodDescription, EXTRA_TOOL_DESCRIPTION)
			.annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
	],
});

export const makeActor = (v: Variant = {}) =>
	defineActor(
		"bench-agent",
		Effect.gen(function* () {
			const counter = v.stateV2 ? counterV2 : counterV1;
			const prompt = v.system === "v2" ? SYSTEM_PROMPT_V2 : SYSTEM_PROMPT;
			const tools = yield* libraryTools(v.extraTool ? [echoLib, clockLib] : [echoLib]);
			// Compaction off: the model sees the whole durable message list.
			const context = effectAtom((get) => ({ view: { position: "ready" as const, messages: get(messages) }, events: {}, acts: {} }));
			const agent = yield* infer(atom((get) => ({ system: prompt, tools: get(tools), context: get(context) })));
			// App state is part of the actor graph (so its events are accepted) but not of the model input.
			const root = atom((get) => {
				const out = get(agent);
				return { ...out, view: { agent: out.view, counter: get(counter).count, items: get(items).items.length } };
			});
			return { atom: root, methods: agentMethods };
		}),
	);

// ---- deterministic fake model at the provider boundary ----
let calls = 0;
const lastOf = (prompt: Prompt.Prompt) => {
	const last = prompt.content.at(-1);
	const text = last?.role === "user" ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
	return decide(last?.role, text);
};
const usage = Response.Usage.make({
	inputTokens: { uncached: USAGE.input, total: USAGE.input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: USAGE.output, text: USAGE.output, reasoning: 0 },
});
const textParts = (id: string, text: string) => [
	Response.makePart("text-start", { id }),
	...split(text, deltas()).map((delta) => Response.makePart("text-delta", { id, delta })),
	Response.makePart("text-end", { id }),
];
const fakeModel = Layer.effect(
	LanguageModel.LanguageModel,
	LanguageModel.make({
		generateText: () => Effect.succeed([Response.makePart("text", { text: "summary" })]),
		streamText: (input) =>
			Stream.suspend(() => {
				const n = ++calls;
				const decision = lastOf(input.prompt);
				const parts =
					decision.kind === "tool-call"
						? [
								...textParts("t", TOOL_CALL_TEXT),
								Response.makePart("tool-call", { id: `call_${n}`, name: TOOL_NAME, params: { text: TOOL_ARG }, providerExecuted: false }),
								Response.makePart("finish", { reason: "tool-calls", usage }),
							]
						: [...textParts("a", decision.kind === "final" ? FINAL_ANSWER : CHAT_ANSWER), Response.makePart("finish", { reason: "stop", usage })];
				return Stream.fromIterable(parts as never[]);
			}),
	} as never),
);
const fixture = { provider: "fake", model_id: "fake" };
const lock = modelLockService(
	modelLockOf({
		schema: 2,
		providers: { fake: { protocol: "openai-chat-completions", baseUrl: "https://fake.invalid", env: [] } },
		models: [{ provider: "fake", model_id: "fake", contextWindowTokens: CONTEXT_WINDOW }],
	}),
	{ allow: "*", default: fixture } as never,
);
const settings = { provider: "fake", protocol: "openai-chat-completions", model: "fake", endpoint: "https://fake.invalid", policy: requestPolicyOf({}) };

const services = Layer.mergeAll(
	Layer.succeed(ModelInfo, { model: fixture, contextWindowTokens: CONTEXT_WINDOW }),
	modelActs.pipe(
		Layer.provide(
			modelServices().pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(ModelLock, lock),
						fakeModel,
						Layer.succeed(ModelSelection, { settings: () => Effect.succeed(settings) } as never),
						Layer.succeed(BindingSettings, settings as never),
					),
				),
			),
		),
	),
	toolActs([
		echoLib.implement({
			echo: () =>
				Effect.promise(async () => {
					const file = blockFile();
					if (file) {
						writeFileSync(file, "in-tool");
						await new Promise(() => {});
					}
					return TOOL_OUTPUT;
				}),
		}),
		clockLib.implement({ now: () => Effect.succeed("2026-01-01T00:00:00Z") }),
	] as never),
);

type Store = {
	wait: Effect.Effect<void, Error>;
	recover: Effect.Effect<void, Error>;
	close: Effect.Effect<void>;
	checkpoint: Effect.Effect<void, Error>;
	get: <V>(node: unknown) => V;
};

export async function openTardie(makeJournal: JournalFactory, file: string, options: OpenOptions): Promise<Agent> {
	const t0 = performance.now();
	const j = makeJournal(file);
	let runtime!: ActorRuntime<object>;
	const store = (await Effect.runPromise(
		createActorStore({
			actor: makeActor(options.variant) as never,
			journal: j as never,
			actorContext: actorContext as never,
			...(options.checkpoint === "manual" ? { checkpoint: { mode: "manual" as const } } : {}),
			services: ((r: ActorRuntime<object>) => {
				runtime = r;
				return services;
			}) as never,
		}) as never,
	)) as Store;
	await Effect.runPromise(store.recover);
	const openMs = performance.now() - t0;
	let n = 0;
	const send = (events: object[]) => Effect.runPromise(runtime.send(events as never));
	const turnRequest = (kind: "tool" | "chat") => {
		const i = n++;
		return { type: "TurnRequested", turnId: `turn-${Date.now()}-${i}`, text: userText(kind, i), source: "user" };
	};
	return {
		openMs,
		async turn(kind, onCommitted) {
			const a = performance.now();
			const request = turnRequest(kind);
			await send([request]);
			const b = performance.now();
			onCommitted?.();
			await Effect.runPromise(store.wait);
			const c = performance.now();
			const state = store.get<{ turns: readonly { turnId: string; settlement: string | null; failure: string | null }[] }>(inferenceState);
			const turn = state.turns.find((t) => t.turnId === request.turnId);
			if (turn?.settlement !== "completed") throw new Error(`tardie turn not completed: ${JSON.stringify(turn).slice(0, 400)}`);
			return { ms: c - a, commitMs: b - a };
		},
		async start(kind) {
			await send([turnRequest(kind)]);
		},
		async bookkeep(kind, _i) {
			if (kind === "entries") throw new Error("tardie has no transcript-entry variant");
			await send([kind === "counter" ? { type: "BenchNote", p: BOOKKEEPING_PAYLOAD } : { type: "BenchItem", p: BOOKKEEPING_PAYLOAD }]);
			await Effect.runPromise(store.wait);
		},
		async readState() {
			return store.get(options.variant?.stateV2 ? counterV2 : counterV1);
		},
		async recover() {
			await Effect.runPromise(store.wait);
			const state = store.get<{ turns: readonly { turnId: string; settlement: string | null; failure: string | null; answer: string | null }[] }>(inferenceState);
			const last = state.turns.at(-1);
			return { lastTurn: last ? { settlement: last.settlement, failure: last.failure?.slice(0, 300) ?? null, answered: last.answer !== null } : null };
		},
		async checkpoint() {
			await Effect.runPromise(store.checkpoint);
		},
		async close() {
			const t = performance.now();
			await Effect.runPromise(store.close);
			const u = performance.now();
			await Effect.runPromise(j.close);
			if (process.env.BENCH_DEBUG) console.error(`tardie close: store ${(u - t).toFixed(1)} ms, journal ${(performance.now() - u).toFixed(1)} ms`);
		},
	};
}
