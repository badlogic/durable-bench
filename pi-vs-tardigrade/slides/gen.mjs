// Generates the slide HTML files (1600x900) from benchmark results. Run: node gen.mjs; then shoot.sh renders PNGs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = new URL(".", import.meta.url).pathname;
const jsonl = (file) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ── Data ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SIZES = [50, 250, 1000, 3500];
const clavia = [...jsonl(`${DIR}../data/durable-bench-pi-head-vs-tardie.jsonl`), ...jsonl(`${DIR}../data/durable-bench-pi-1.0.4.jsonl`)];
const seeds = [...jsonl(`${DIR}../data/durable-bench-seeding.jsonl`), ...jsonl(`${DIR}../data/durable-bench-seeding-pi-1.0.4.jsonl`)];
const of = (target, turns) => clavia.filter((r) => r.target === target && r.turns === turns);
const metric = {
	cold: (rows) => median(rows.map((r) => r.open + r.turn[0])),
	warm: (rows) => median(rows.map((r) => median(r.turn.slice(1)))),
	mb: (rows) => median(rows.map((r) => r.bytes)) / 1e6,
	rss: (rows) => median(rows.map((r) => r.rss)),
	open: (rows) => median(rows.map((r) => r.open)),
};
const series = (target, name) => SIZES.map((n) => metric[name](of(target, n)));
const seed = (target, turns) => seeds.find((s) => s.target === target && s.turns === turns)?.seedMs / 1000;
const PI = "pi-head";
const TARDIE = "tardie";
const PI_VERSION = clavia.find((r) => r.target === PI)?.version ?? "?";
const TARDIE_VERSION = clavia.find((r) => r.target === TARDIE)?.version ?? "?";

const harness = jsonl(`${DIR}../data/harness-pi-head-vs-tardie.jsonl`);
const H_SIZES = [0, 25, 100, 300, 1000, 3000];
const dbTurns = (r) => Number(/-(\d+)\.db$/.exec(r.db ?? "")?.[1]);
const hWarm = (system, turns) =>
	harness.find((r) => r.kind === "warm" && !r.warmup && r.system === system && r.turnKind === "tool" && dbTurns(r) === turns);
const hReopen = (system, turns) =>
	harness.filter((r) => r.kind === "reopen" && !r.warmup && r.system === system && dbTurns(r) === turns);
const versions = harness
	.filter((r) => r.kind === "version")
	.map((r) => {
		const [, system, mode, ckpt, change] = /^v-(.+)-(quiescent|inflight)-(none|present)-(\w+)\.db$/.exec(r.db) ?? [];
		return { system, mode, ckpt, change, pass: r.pass, error: String(r.open ?? "").startsWith("FAIL") ? r.open.slice(6) : r.error };
	});

// ── Style ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const C = { bg: "#0b0f17", panel: "#121826", line: "#243046", text: "#e6edf3", muted: "#8b98a8", pi: "#38bdf8", tardie: "#fb923c", good: "#4ade80", bad: "#f87171" };
const fmt = (v, digits = 0) => (v === undefined || Number.isNaN(v) ? "–" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const css = `
@font-face { font-family: Inter; src: url(../fonts/inter-latin-wght-normal.woff2) format("woff2"); font-weight: 100 900; }
@font-face { font-family: Mono; src: url(../fonts/jetbrains-mono-latin-wght-normal.woff2) format("woff2"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1600px; height: 900px; background: ${C.bg}; color: ${C.text}; font-family: Inter, sans-serif; }
body { padding: 56px 72px; display: flex; flex-direction: column; gap: 28px; }
h1 { font-size: 46px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; }
h2 { font-size: 22px; font-weight: 500; color: ${C.muted}; line-height: 1.4; }
.row { display: flex; gap: 28px; flex: 1; min-height: 0; }
.col { display: flex; flex-direction: column; gap: 16px; flex: 1; min-width: 0; }
.panel { background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 18px; padding: 26px 30px; }
.pi { color: ${C.pi}; } .tardie { color: ${C.tardie}; } .muted { color: ${C.muted}; } .good { color: ${C.good}; } .bad { color: ${C.bad}; }
.foot { font-size: 15px; color: ${C.muted}; line-height: 1.45; }
.mono { font-family: Mono, monospace; }
ul { list-style: none; display: flex; flex-direction: column; gap: 12px; }
li { font-size: 21px; line-height: 1.38; padding-left: 26px; position: relative; }
li::before { content: ""; position: absolute; left: 4px; top: 11px; width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.6; }
.legend { display: flex; gap: 26px; font-size: 18px; font-weight: 600; }
.dot { display: inline-block; width: 14px; height: 14px; border-radius: 4px; margin-right: 8px; vertical-align: -1px; }
.brand { position: absolute; right: 72px; bottom: 34px; font-size: 15px; color: ${C.muted}; }
`;
const legend = `<div class="legend"><span><span class="dot" style="background:${C.pi}"></span>pi-durable <span class="muted mono">${PI_VERSION}</span></span><span><span class="dot" style="background:${C.tardie}"></span>Tardigrade <span class="muted mono">${TARDIE_VERSION}</span></span></div>`;
const page = (title, body) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${body}<div class="brand">github.com/badlogic/durable-bench · fork of clavia-labs/durable-bench · one i9-13900 P-core</div></body></html>`;

/** Grouped bar chart: one group per x label, one bar per series, value labels on top. */
function bars({ width, height, labels, series: sets, unit = "", digits = 0, axis = "turns of history" }) {
	const pad = { left: 16, right: 16, top: 34, bottom: 58 };
	const max = Math.max(...sets.flatMap((s) => s.values.filter((v) => v !== undefined))) * 1.12;
	const innerW = width - pad.left - pad.right;
	const innerH = height - pad.top - pad.bottom;
	const group = innerW / labels.length;
	const barW = Math.min(64, (group * 0.7) / sets.length);
	let svg = `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:100%;display:block" xmlns="http://www.w3.org/2000/svg">`;
	svg += `<line x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top + innerH}" y2="${pad.top + innerH}" stroke="${C.line}" stroke-width="2"/>`;
	labels.forEach((label, i) => {
		const gx = pad.left + group * i + group / 2;
		sets.forEach((s, j) => {
			const v = s.values[i];
			if (v === undefined) return;
			const h = (v / max) * innerH;
			const x = gx - (sets.length * barW) / 2 + j * barW + 3;
			const y = pad.top + innerH - h;
			svg += `<rect x="${x}" y="${y}" width="${barW - 6}" height="${h}" rx="6" fill="${s.color}"/>`;
			svg += `<text x="${x + (barW - 6) / 2}" y="${y - 10}" fill="${s.color}" font-size="19" font-weight="700" text-anchor="middle" font-family="Inter">${fmt(v, digits)}${unit}</text>`;
		});
		svg += `<text x="${gx}" y="${pad.top + innerH + 32}" fill="${C.text}" font-size="20" font-weight="600" text-anchor="middle" font-family="Inter">${label}</text>`;
	});
	svg += `<text x="${width / 2}" y="${height - 4}" fill="${C.muted}" font-size="16" text-anchor="middle" font-family="Inter">${axis}</text>`;
	return `${svg}</svg>`;
}

/** Line chart over numeric x, one polyline per series, labelled end values. */
function lines({ width, height, xs, series: sets, unit = "", digits = 0, axis = "turns of history" }) {
	const pad = { left: 60, right: 110, top: 24, bottom: 58 };
	const max = Math.max(...sets.flatMap((s) => s.values.filter((v) => v !== undefined))) * 1.1;
	const innerW = width - pad.left - pad.right;
	const innerH = height - pad.top - pad.bottom;
	const sx = (x) => pad.left + (x / xs.at(-1)) * innerW;
	const sy = (v) => pad.top + innerH - (v / max) * innerH;
	let svg = `<svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;max-height:100%;display:block" xmlns="http://www.w3.org/2000/svg">`;
	for (let i = 0; i <= 4; i++) {
		const v = (max / 4) * i;
		svg += `<line x1="${pad.left}" x2="${width - pad.right}" y1="${sy(v)}" y2="${sy(v)}" stroke="${C.line}" stroke-width="1"/>`;
		svg += `<text x="${pad.left - 10}" y="${sy(v) + 6}" fill="${C.muted}" font-size="15" text-anchor="end" font-family="Inter">${fmt(v)}</text>`;
	}
	for (const x of xs) svg += `<text x="${sx(x)}" y="${pad.top + innerH + 30}" fill="${C.text}" font-size="17" text-anchor="middle" font-family="Inter">${fmt(x)}</text>`;
	for (const s of sets) {
		const pts = xs.map((x, i) => [x, s.values[i]]).filter(([, v]) => v !== undefined);
		svg += `<polyline points="${pts.map(([x, v]) => `${sx(x)},${sy(v)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
		for (const [x, v] of pts) svg += `<circle cx="${sx(x)}" cy="${sy(v)}" r="6" fill="${s.color}"/>`;
		const [lx, lv] = pts.at(-1);
		svg += `<text x="${sx(lx) + 14}" y="${sy(lv) + 7}" fill="${s.color}" font-size="21" font-weight="800" font-family="Inter">${fmt(lv, digits)}${unit}</text>`;
	}
	svg += `<text x="${pad.left + innerW / 2}" y="${height - 4}" fill="${C.muted}" font-size="16" text-anchor="middle" font-family="Inter">${axis}</text>`;
	return `${svg}</svg>`;
}

const ratio = (a, b) => `${fmt(b / a, 1)}×`;
const last = (target, name) => metric[name](of(target, 3500));
const slides = [];

// 1. Cover
{
	const warm = [last(PI, "warm"), last(TARDIE, "warm")];
	const cold = [last(PI, "cold"), last(TARDIE, "cold")];
	const mb = [last(PI, "mb"), last(TARDIE, "mb")];
	const sd = [seed(PI, 3500), seed(TARDIE, 3500)];
	const card = (label, p, t, unit, digits, note) => `<div class="panel col" style="gap:10px">
		<div style="font-size:20px;font-weight:600" class="muted">${label}</div>
		<div style="font-size:54px;font-weight:800;letter-spacing:-0.02em" class="pi">${fmt(p, digits)}<span style="font-size:28px">${unit}</span></div>
		<div style="font-size:24px;font-weight:600" class="tardie">vs ${fmt(t, digits)}${unit}</div>
		<div style="font-size:19px" class="good">${note}</div></div>`;
	slides.push(
		page(
			"cover",
			`<h1>pi-durable vs Tardigrade,<br>rerun on Tardigrade's own benchmark</h1>
		<h2>Same scripted agent and tool, 8 tool calls per turn, conversations up to 3,500 turns, SQLite on Cloudflare Durable Objects (Miniflare). Numbers at 3,500 turns.</h2>
		${legend}
		<div class="row" style="flex:0 0 auto">
			${card("Warm turn (thread already open)", warm[0], warm[1], " ms", 0, `${ratio(warm[0], warm[1])} faster`)}
			${card("Cold start (open + first turn)", cold[0], cold[1], " ms", 0, `${ratio(cold[0], cold[1])} faster`)}
			${card("SQLite database", mb[0], mb[1], " MB", 1, `${ratio(mb[0], mb[1])} smaller`)}
			${card("Building the history", sd[0], sd[1], " s", 0, `${ratio(sd[0], sd[1])} faster`)}
		</div>
		<div class="foot">pi-durable main <span class="mono">${PI_VERSION}</span> with its own Durable Object SQLite adapter, Tardigrade (tardie) ${TARDIE_VERSION}. Bun 1.4.2, Miniflare, Docker pinned to one i9-13900 performance core. Median of 3 fresh runtimes × 9 warm turns; both systems produce identical transcripts.</div>`,
		),
	);
}

// 2. Latency
slides.push(
	page(
		"latency",
		`<h1>Latency as conversations grow</h1>
	<h2>Warm: one more 8-tool turn on an open thread. Cold: open the agent, then the first turn. Lower is better.</h2>
	${legend}
	<div class="row">
		<div class="panel col"><div style="font-size:24px;font-weight:700">Warm turn, ms</div>${bars({ width: 680, height: 520, labels: SIZES.map((n) => fmt(n)), series: [{ color: C.pi, values: series(PI, "warm") }, { color: C.tardie, values: series(TARDIE, "warm") }] })}</div>
		<div class="panel col"><div style="font-size:24px;font-weight:700">Cold start, ms</div>${bars({ width: 680, height: 520, labels: SIZES.map((n) => fmt(n)), series: [{ color: C.pi, values: series(PI, "cold") }, { color: C.tardie, values: series(TARDIE, "cold") }] })}</div>
	</div>`,
	),
);

// 3. What changed in pi-durable
{
	const before = { warm: last("pi", "warm"), cold: last("pi", "cold"), seed: seed("pi", 3500) };
	const after = { warm: last(PI, "warm"), cold: last(PI, "cold"), seed: seed(PI, 3500) };
	const row = (label, b, a, unit) => `<div style="display:flex;align-items:baseline;gap:18px;font-size:26px">
		<div style="width:330px" class="muted">${label}</div><div class="bad" style="width:170px;text-align:right;text-decoration:line-through;opacity:0.8">${fmt(b)}${unit}</div>
		<div style="font-size:34px;font-weight:800" class="pi">${fmt(a)}${unit}</div><div class="good" style="font-size:20px">${ratio(a, b)} faster</div></div>`;
	slides.push(
		page(
			"changed",
			`<h1>Their benchmark found a real problem. Fixed.</h1>
		<h2>Tardigrade's chart showed pi-durable's warm turns growing with history. The cause was ours, not the architecture's.</h2>
		<div class="row">
			<div class="panel col" style="justify-content:center;gap:26px">
				<div style="font-size:22px;font-weight:700">pi-durable 1.0.4 → main, at 3,500 turns</div>
				${row("Warm turn", before.warm, after.warm, " ms")}
				${row("Cold start", before.cold, after.cold, " ms")}
				${row("Build 3,500-turn history", before.seed, after.seed, " s")}
			</div>
			<div class="panel col" style="gap:20px">
				<div style="font-size:22px;font-weight:700">What changed</div>
				<ul>
					<li><b>1.0.4</b> re-read the whole transcript from SQLite and re-derived the model context twice per model call: <b>18 full reads</b> for one 8-tool turn.</li>
					<li><b>main</b> keeps each conversation's derived context in memory while it is busy, and for 10 minutes after. Later reads fetch only the new entries.</li>
					<li>Still durable: the cache is derived, never persisted. After a crash the first read rebuilds it.</li>
					<li>Memory stays bounded: idle conversations drop it; nothing else is held.</li>
				</ul>
			</div>
		</div>`,
		),
	);
}

// 4. Design
slides.push(
	page(
		"design",
		`<h1>Two ways to be durable</h1>
	<h2>Both survive a crash mid-tool-call. They pay for it in different places.</h2>
	<div class="row">
		<div class="panel col" style="border-color:${C.tardie}55">
			<div style="font-size:28px;font-weight:800" class="tardie">Tardigrade: event sourcing</div>
			<div style="font-size:20px" class="muted">Every change is an event. State = replay(all events).</div>
			<ul>
				<li>An open thread keeps its <b>entire history in memory</b>: every event, every request and result, every message.</li>
				<li>Each commit re-derives state and checks recorded requests against the current code.</li>
				<li>Every 500 events, a checkpoint <b>rewrites the full state</b>, so it grows with history.</li>
				<li>Cold open = decode that checkpoint, then replay the events after it.</li>
			</ul>
		</div>
		<div class="panel col" style="border-color:${C.pi}55">
			<div style="font-size:28px;font-weight:800" class="pi">pi-durable: records and documents</div>
			<div style="font-size:20px" class="muted">Immutable transcript entries plus small typed documents, committed atomically.</div>
			<ul>
				<li>History stays on disk. Only an active conversation's model context is held in memory.</li>
				<li>Documents keep an operation log of small deltas, folded into a new base by policy; "latest" documents drop their history.</li>
				<li>A commit writes the new entries and deltas: constant cost, however long the conversation.</li>
				<li>Cold open reads the context and each document's latest base plus the deltas after it. No full-state snapshot.</li>
			</ul>
		</div>
	</div>`,
	),
);

// 5. Memory & storage
{
	const heap = (system) => H_SIZES.map((n) => hWarm(system, n)?.memAfterTurns?.heapUsedMB);
	const haveHeap = heap(PI).some((v) => v !== undefined);
	slides.push(
		page(
			"memory",
			`<h1>Memory and storage</h1>
		<h2>${haveHeap ? "JS heap with the thread open after 11 turns (forced GC), Node 24, our harness benchmark." : ""} Process memory and database size on their benchmark.</h2>
		${legend}
		<div class="row">
			${haveHeap ? `<div class="panel col"><div style="font-size:24px;font-weight:700">Heap in use, MB</div>${lines({ width: 470, height: 500, xs: H_SIZES, series: [{ color: C.pi, values: heap(PI) }, { color: C.tardie, values: heap(TARDIE) }], unit: " MB" })}</div>` : ""}
			<div class="panel col"><div style="font-size:24px;font-weight:700">Process memory (Bun + workerd), MB</div>${bars({ width: haveHeap ? 470 : 680, height: 500, labels: SIZES.map((n) => fmt(n)), series: [{ color: C.pi, values: series(PI, "rss") }, { color: C.tardie, values: series(TARDIE, "rss") }] })}</div>
			<div class="panel col"><div style="font-size:24px;font-weight:700">SQLite database, MB</div>${bars({ width: haveHeap ? 470 : 680, height: 500, labels: SIZES.map((n) => fmt(n)), series: [{ color: C.pi, values: series(PI, "mb") }, { color: C.tardie, values: series(TARDIE, "mb") }], digits: 1 })}</div>
		</div>`,
		),
	);
}

// 6. Turn, write, and reopen cost (harness)
{
	const warm = (system) => H_SIZES.map((n) => hWarm(system, n)?.turn?.median);
	const commit = (system) => H_SIZES.map((n) => hWarm(system, n)?.commit?.median);
	const reopen = (system) =>
		H_SIZES.map((n) => {
			const rows = hReopen(system, n);
			return rows.length ? median(rows.map((r) => r.openMs + r.firstTurnMs)) : undefined;
		});
	if (commit(PI).some((v) => v !== undefined)) {
		const panel = (title, values, note, digits = 0) => `<div class="panel col"><div style="font-size:23px;font-weight:700">${title}</div>${lines({ width: 520, height: 470, xs: H_SIZES, series: [{ color: C.pi, values: values(PI) }, { color: C.tardie, values: values(TARDIE) }], unit: " ms", digits })}<div class="foot">${note}</div></div>`;
		slides.push(
			page(
				"costs",
				`<h1>What grows with history, and what doesn't</h1>
			<h2>Our harness benchmark, Node 24: same scripted agent, tool turns, history up to 3,000 turns. Lower is better.</h2>
			${legend}
			<div class="row">
				${panel("Warm tool turn, ms", warm, "pi-durable reads only new entries; Tardigrade re-derives state from its in-memory log.", 1)}
				${panel("Saving one user message, ms", commit, "pi-durable writes one row and its documents; Tardigrade re-derives and re-validates state on every commit.", 1)}
				${panel("Reopen + first turn, ms", reopen, "Tardigrade decodes a full-state checkpoint and replays; pi-durable reads the transcript once.")}
			</div>`,
			),
		);
	}
}

// 7. Changing your agent (versioning)
{
	const changes = ["control", "system", "tool", "schema"];
	const names = { control: "No change", system: "System prompt edited", tool: "Tool added", schema: "State schema v2" };
	const groups = [
		[PI, "quiescent", "none", "idle"],
		[PI, "inflight", "none", "crashed mid-tool"],
		[TARDIE, "quiescent", "none", "idle, before a checkpoint"],
		[TARDIE, "quiescent", "present", "idle, after a checkpoint"],
		[TARDIE, "inflight", "none", "crashed mid-tool, before a checkpoint"],
		[TARDIE, "inflight", "present", "crashed mid-tool, after a checkpoint"],
	];
	const cell = (system, mode, ckpt, change) => {
		const r = versions.find((v) => v.system === system && v.mode === mode && v.ckpt === ckpt && v.change === change);
		if (!r) return `<td class="muted">–</td>`;
		const error = String(r.error ?? "fails").split("\n")[0];
		return `<td style="padding:12px 8px;font-weight:700" class="${r.pass ? "good" : "bad"}">${r.pass ? "✓ continues" : `✗ ${error}`}</td>`;
	};
	if (versions.length > 0) {
		const pass = (system) => versions.filter((v) => v.system === system && v.change !== "control");
		const score = (system) => `${pass(system).filter((v) => v.pass).length}/${pass(system).length}`;
		slides.push(
			page(
				"versioning",
				`<h1>Shipping a new version of your agent</h1>
			<h2>Write three turns, change the code, reopen the same database. Do existing conversations continue? pi-durable ${score(PI)}, Tardigrade ${score(TARDIE)}.</h2>
			<div class="panel" style="flex:1;padding:14px 26px"><table style="width:100%;border-collapse:collapse;font-size:19px">
				<tr class="muted" style="text-align:left"><th style="padding:10px 8px">Conversation before the update</th>${changes.map((c) => `<th style="padding:10px 8px">${names[c]}</th>`).join("")}</tr>
				${groups.map(([system, mode, ckpt, label]) => `<tr style="border-top:1px solid ${C.line}"><td style="padding:12px 8px"><span class="${system === PI ? "pi" : "tardie"}" style="font-weight:800">${system === PI ? "pi-durable" : "Tardigrade"}</span> <span class="muted">${label}</span></td>${changes.map((c) => cell(system, mode, ckpt, c)).join("")}</tr>`).join("")}
			</table></div>
			<div class="foot">Tardigrade replays recorded model requests through the new code and rejects any that differ; its checkpoints hold the old state shape. Its documented migration is a new thread seeded from converted state. pi-durable never replays history through code: the next turn simply uses the new prompt and tools, and documents and tasks carry a version with <span class="mono">migrate()</span>.</div>`,
			),
		);
	}
}

// 8. Features
{
	const rows = [
		["Survives a crash mid-tool-call", "✓", "✓"],
		["Change prompt or tools of a running agent", "✓ the next turn uses them", "✗ reopen fails while replayed history holds older requests"],
		["Evolve stored state", "✓ versioned documents with migrate()", "✗ fails once a checkpoint holds the old shape"],
		["Fork a conversation at any message", "✓ conversation.fork(entry)", "✗ only in the deprecated host"],
		["Durable subagents", "✓ owned child conversations, recovered after restart", "✗ child actors run in memory"],
		["Coding tools", "✓ read, write, edit, bash", "fetch, key-value workspace, alarms"],
		["Storage", "SQLite, JSONL, memory, Cloudflare DO", "SQLite on Cloudflare DO and Bun"],
		["Runtimes", "Node, Bun, Cloudflare Workers", "Bun, Cloudflare Workers"],
		["Memory per open conversation", "its model context, while active", "its entire history, while open"],
	];
	slides.push(
		page(
			"features",
			`<h1>Beyond speed</h1>
		<h2>What each harness gives you today (pi-durable main, Tardigrade ${TARDIE_VERSION} current API).</h2>
		<div class="panel" style="flex:1;padding:18px 28px"><table style="width:100%;border-collapse:collapse;font-size:21px">
			<tr style="text-align:left"><th style="padding:12px 8px;width:30%"></th><th class="pi" style="padding:12px 8px">pi-durable</th><th class="tardie" style="padding:12px 8px">Tardigrade</th></tr>
			${rows.map(([label, p, t]) => `<tr style="border-top:1px solid ${C.line}"><td style="padding:11px 8px;font-weight:600">${label}</td><td style="padding:11px 8px" class="${p.startsWith("✗") ? "bad" : ""}">${p}</td><td style="padding:11px 8px" class="${t.startsWith("✗") ? "bad" : ""}">${t}</td></tr>`).join("")}
		</table></div>`,
		),
	);
}

// 9. Method
slides.push(
	page(
		"method",
		`<h1>How this was measured</h1>
	<div class="row"><div class="panel col"><ul>
		<li>Tardigrade's benchmark, <span class="mono">clavia-labs/durable-bench</span>, with its scenario unchanged: scripted model, one lookup tool, histories built by real turns (tool, tool, no tool), measured turns with 8 tool calls.</li>
		<li>Our fork, <span class="mono">github.com/badlogic/durable-bench</span>, adds one target: pi-durable built from source (main <span class="mono">${PI_VERSION}</span>) with pi-durable's own Durable Object adapter instead of the benchmark's hand-written one. Same transcripts. Raw results and these slides are in the fork.</li>
		<li>Bun 1.4.2, Miniflare (workerd, SQLite-backed Durable Objects), Docker pinned to one performance core of an i9-13900, nothing else running in the container.</li>
		<li>Cold = open + first turn in a fresh runtime. Warm = median of the next 9 turns. 3 fresh runtimes per size.</li>
		<li>Memory, commit, reopen, and versioning: our own harness benchmark (Node 24), tardie ${TARDIE_VERSION} vs the same pi-durable commit.</li>
		<li>Their published chart ran on an Apple M5, so absolute numbers differ. Thanks to the Tardigrade team for the benchmark: it found a real problem.</li>
	</ul></div></div>`,
	),
);

mkdirSync(`${DIR}html`, { recursive: true });
slides.forEach((html, i) => writeFileSync(`${DIR}html/${String(i + 1).padStart(2, "0")}.html`, html));
console.log(`${slides.length} slides`);
