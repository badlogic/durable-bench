// System-neutral interface the CLI drives. Each runtime entry (entry-node.ts / entry-bun.ts) supplies the storage layer.

export type TurnKind = "tool" | "chat";
export type AppState = "counter" | "array" | "entries";
export interface Variant {
	/** System prompt version. */
	readonly system?: "v1" | "v2";
	/** Offer a second tool. */
	readonly extraTool?: boolean;
	/** Durable app-state schema v2 (tardie durableAtom schema / pi document version 2 with migrate). */
	readonly stateV2?: boolean;
}
export interface OpenOptions {
	readonly variant?: Variant;
	/** Tardie only: "manual" disables threshold checkpoints. */
	readonly checkpoint?: "default" | "manual";
}
export interface Agent {
	/** Time to open storage and the agent/thread (including replay) in ms. */
	readonly openMs: number;
	/** One full turn: input commit → (tool call → tool result →) final answer. */
	turn(kind: TurnKind, onCommitted?: () => void): Promise<{ ms: number; commitMs: number }>;
	/** Admit a turn's input and return without waiting (crash simulation). */
	start(kind: TurnKind): Promise<void>;
	/** One app-state edit in its own commit. */
	bookkeep(kind: AppState, i: number): Promise<void>;
	/** Read the counter app state (versioning test). */
	readState(): Promise<unknown>;
	/** Continue unfinished work after reopen; describe how the in-flight turn settled. */
	recover(): Promise<Record<string, unknown>>;
	/** Pi only: scripted dialogue with compaction + reset; model requests and final transcript for comparison. */
	scripted?(): Promise<{ steps: string[]; requests: unknown[]; transcript: unknown[]; context: unknown }>;
	/** Tardie only: write a checkpoint now. */
	checkpoint?(): Promise<void>;
	close(): Promise<void>;
}
export type SystemName = "tardie" | "pi" | "pi-head";
export interface Platform {
	open(system: SystemName, file: string, options: OpenOptions): Promise<Agent>;
	/** Native record counts and storage breakdown read from a closed DB file. */
	records(system: SystemName, file: string): Record<string, number>;
}
