// Generate charts (SVG, plus PNG when @resvg/resvg-js is installed), the README results section and report.html
// from results/results.jsonl. No dependencies.   node scripts/charts.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const rows = existsSync(`${ROOT}results/results.jsonl`)
	? readFileSync(`${ROOT}results/results.jsonl`, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
	: [];
const envText = existsSync(`${ROOT}results/environment.txt`) ? readFileSync(`${ROOT}results/environment.txt`, "utf8") : "";
mkdirSync(`${ROOT}charts`, { recursive: true });

// ---------- data helpers ----------
const sizeOf = (db) => Number(/-(\d+)\.db$/.exec(db ?? "")?.[1]);
const headSha = rows.find((r) => r.piHeadSha)?.piHeadSha ?? (existsSync(`${ROOT}pi-head.sha`) ? readFileSync(`${ROOT}pi-head.sha`, "utf8").trim() : "?");
const SYS = {
	tardie: { label: "Tardigrade", color: "#d9480f" },
	pi: { label: "Pi Durable 1.0.4", color: "#1971c2" },
	"pi-head": { label: `Pi Durable HEAD ${headSha.slice(0, 9)}`, color: "#2f9e44" },
};
const RT_DASH = { node: "", bun: "9 6" };
const RTS = ["node", "bun"];
const SYSTEMS = ["tardie", "pi", "pi-head"];
const real = rows.filter((r) => !r.warmup);
const errors = rows.filter((r) => r.kind === "error");
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length === 0 ? Number.NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (v, digits = 1) => {
	if (v === undefined || v === null || Number.isNaN(v)) return "–";
	if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} s`;
	return `${v.toFixed(v < 10 ? 2 : digits)} ms`;
};
const fmtMs = (v) => (v === undefined || Number.isNaN(v) ? "–" : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const bytes = (b) => (b === undefined ? "–" : b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);

const warm = (runtime, system, kind, step = /^dialogue/) =>
	real
		.filter((r) => r.kind === "warm" && r.runtime === runtime && r.system === system && r.turnKind === kind && step.test(r.step ?? ""))
		.map((r) => ({ x: sizeOf(r.db), y: r.turn.median, lo: r.turn.min, hi: r.turn.max, commit: r.commit, r }))
		.sort((a, b) => a.x - b.x);
const builds = (runtime, system) =>
	real
		.filter((r) => r.kind === "build" && r.runtime === runtime && r.system === system && r.step !== "smoke")
		.sort((a, b) => a.turns - b.turns);
const reopen = (runtime, system) => {
	const by = new Map();
	for (const r of real.filter((r) => r.kind === "reopen" && r.runtime === runtime && r.system === system)) {
		const n = sizeOf(r.db);
		if (!by.has(n)) by.set(n, []);
		by.get(n).push(r);
	}
	return [...by]
		.sort((a, b) => a[0] - b[0])
		.map(([x, rs]) => ({ x, open: rs.map((r) => r.openMs), first: rs.map((r) => r.firstTurnMs), heap: rs.map((r) => r.mem.heapUsedMB), rss: rs.map((r) => r.mem.rssMB) }));
};
const apps = (runtime, system, variant) =>
	real
		.filter((r) => r.kind === "appwarm" && r.runtime === runtime && r.system === system && r.variant === variant)
		.map((r) => ({ x: sizeOf(r.db), y: r.turn.median, lo: r.turn.min, hi: r.turn.max, app: r.appCommit, r }))
		.sort((a, b) => a.x - b.x);
const appBuilds = (runtime, system, variant) =>
	real.filter((r) => r.kind === "appbuild" && r.runtime === runtime && r.system === system && r.variant === variant).sort((a, b) => a.n - b.n);
const profs = real.filter((r) => r.kind === "profsum");
const runsOf = (system, turns, what) => real.find((r) => r.kind === "profile" && r.system === system && sizeOf(r.db) === turns && r.what === what)?.runs ?? 20;
/** Log-log slope over the points with x ≥ 100 (least squares). */
const slope = (pts) => {
	const p = pts.filter((q) => q.x >= 100 && q.y > 0);
	if (p.length < 2) return undefined;
	const xs = p.map((q) => Math.log(q.x));
	const ys = p.map((q) => Math.log(q.y));
	const mx = xs.reduce((a, b) => a + b) / xs.length;
	const my = ys.reduce((a, b) => a + b) / ys.length;
	let num = 0;
	let den = 0;
	for (let i = 0; i < xs.length; i++) {
		num += (xs[i] - mx) * (ys[i] - my);
		den += (xs[i] - mx) ** 2;
	}
	return num / den;
};

// ---------- SVG primitives (phone-first: 520 px viewBox, 16–24 px text ≈ 11–17 px on a phone) ----------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Dynamic text inside markdown (also rendered to HTML): no raw angle brackets. */
const mdSafe = (s) => String(s).replace(/</g, "‹").replace(/>/g, "›").replace(/\|/g, "/");
const FONT = `font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"`;
const WIDTH = 520;
const text = (x, y, s, { size = 17, anchor = "start", weight = "normal", fill = "#222", rotate } = {}) =>
	`<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" fill="${fill}"${rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : ""}>${esc(s)}</text>`;
const wrap = (s, max) => {
	const out = [];
	let line = "";
	for (const w of String(s).split(" ")) {
		if ((line + " " + w).trim().length > max) {
			out.push(line.trim());
			line = w;
		} else line += ` ${w}`;
	}
	if (line.trim()) out.push(line.trim());
	return out;
};
const niceTicksLog = (min, max) => {
	const ticks = [];
	for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++)
		for (const m of [1, 2, 5]) {
			const v = m * 10 ** e;
			if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
		}
	return ticks.length > 7 ? ticks.filter((v) => /^1/.test(String(v))) : ticks;
};
const niceTicksLin = (min, max) => {
	const span = max - min || 1;
	const step = 10 ** Math.floor(Math.log10(span / 4));
	const s = [1, 2, 5, 10].map((m) => m * step).find((st) => span / st <= 6) ?? step * 10;
	const ticks = [];
	for (let v = Math.ceil(min / s) * s; v <= max + 1e-9; v += s) ticks.push(Number(v.toPrecision(6)));
	return ticks;
};
const tickLabel = (v, unit) => {
	if (unit === "ms") return v >= 1000 ? `${v / 1000} s` : `${v} ms`;
	if (unit === "MB") return `${v} MB`;
	return v >= 1000 ? `${v / 1000}k` : String(v);
};
/** Title + wrapped subtitle; returns [svg, height]. */
const heading = (title, subtitle, x = 10) => {
	const out = [];
	let y = 30;
	for (const l of wrap(title, 34)) {
		out.push(text(x, y, l, { size: 23, weight: "bold" }));
		y += 28;
	}
	for (const l of subtitle ? wrap(subtitle, 54) : []) {
		out.push(text(x, y, l, { size: 16, fill: "#555" }));
		y += 21;
	}
	return [out.join("\n"), y + 6];
};
/** Colored paragraphs under a chart; returns [svg, height]. */
const paragraphs = (items, y0, x = 10) => {
	const out = [];
	let y = y0;
	for (const it of items) {
		if (it.heading) {
			out.push(text(x, y + 18, it.heading, { size: 19, weight: "bold" }));
			y += 30;
			continue;
		}
		const lines = wrap(it.text, 52);
		out.push(`<rect x="${x}" y="${y + 4}" width="5" height="${lines.length * 21}" fill="${it.color ?? "#999"}"/>`);
		lines.forEach((l, i) => out.push(text(x + 14, y + 19 + i * 21, l, { size: 16, fill: "#222", weight: i === 0 && it.boldFirst ? "bold" : "normal" })));
		y += lines.length * 21 + 12;
	}
	return [out.join("\n"), y];
};

/** Line chart; series: [{name, color, dash, width, points:[{x,y,lo,hi}], endLabel}]. Log X maps x = 0 to the left edge. */
function lineChart({ title, subtitle, xLabel, yLabel, yUnit = "ms", xUnit = "", series, logX = true, logY = true, plotH = 330, footer = [], raw = false }) {
	series = series.filter((s) => s.points.some((p) => Number.isFinite(p.y)));
	const pts = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.y));
	if (!pts.length) return undefined;
	const [head, T0] = heading(title, subtitle);
	const L = 64;
	const R = 14;
	const T = T0 + 8;
	const W = WIDTH - L - R;
	const H = plotH;
	const xsPos = pts.map((p) => p.x).filter((x) => x > 0);
	const xLo = Math.min(...pts.map((p) => p.x));
	const xMin = logX ? Math.min(...xsPos, 10) / 2 : xLo;
	const xMax = Math.max(...pts.map((p) => p.x));
	const ys = pts.flatMap((p) => [p.y, p.lo ?? p.y, p.hi ?? p.y]).filter((y) => y > 0);
	let yMin = logY ? Math.min(...ys) / 1.3 : 0;
	let yMax = Math.max(...ys) * (logY ? 1.3 : 1.1);
	if (logY) {
		yMin = 10 ** Math.floor(Math.log10(yMin));
		yMax = Math.max(yMax, yMin * 10);
	}
	const fx = (x) => (logX ? L + ((Math.log10(x <= 0 ? xMin : x) - Math.log10(xMin)) / (Math.log10(xMax * 1.12) - Math.log10(xMin))) * W : L + ((x - xLo) / (xMax - xLo || 1)) * W);
	const fy = (y) => (logY ? T + H - ((Math.log10(Math.max(y, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * H : T + H - ((y - yMin) / (yMax - yMin)) * H);
	const out = [head];
	for (const v of logY ? niceTicksLog(yMin, yMax) : niceTicksLin(yMin, yMax)) {
		const y = fy(v);
		out.push(`<line x1="${L}" x2="${L + W}" y1="${y}" y2="${y}" stroke="#e3e3e3"/>`);
		out.push(text(L - 6, y + 5, tickLabel(v, yUnit), { size: 15, anchor: "end", fill: "#555" }));
	}
	let lastX = -1e9;
	for (const v of [...new Set(pts.map((p) => p.x))].sort((a, b) => a - b)) {
		const x = fx(v);
		out.push(`<line x1="${x}" x2="${x}" y1="${T}" y2="${T + H}" stroke="#eee"/>`);
		if (x - lastX > 34) {
			out.push(text(x, T + H + 20, tickLabel(v, xUnit), { size: 15, anchor: "middle", fill: "#555" }));
			lastX = x;
		}
	}
	out.push(`<rect x="${L}" y="${T}" width="${W}" height="${H}" fill="none" stroke="#999"/>`);
	out.push(text(L + W / 2, T + H + 44, xLabel, { size: 16, anchor: "middle" }));
	out.push(text(16, T + H / 2, yLabel, { size: 16, anchor: "middle", rotate: -90 }));
	for (const s of series) {
		const p = s.points.filter((q) => Number.isFinite(q.y)).sort((a, b) => a.x - b.x);
		for (const q of p)
			if (q.lo !== undefined && q.hi !== undefined) out.push(`<line x1="${fx(q.x)}" x2="${fx(q.x)}" y1="${fy(q.lo)}" y2="${fy(q.hi)}" stroke="${s.color}" stroke-width="2" opacity="0.4"/>`);
		out.push(`<polyline fill="none" stroke="${s.color}" stroke-width="${s.width ?? 3.5}" stroke-dasharray="${s.dash ?? ""}" stroke-linejoin="round" points="${p.map((q) => `${fx(q.x).toFixed(1)},${fy(q.y).toFixed(1)}`).join(" ")}"/>`);
		for (const q of p) out.push(`<circle cx="${fx(q.x)}" cy="${fy(q.y)}" r="${(s.width ?? 3.5) + 0.5}" fill="${s.color}"/>`);
		if (s.endLabel) {
			const q = p.at(-1);
			out.push(`<text x="${fx(q.x) - 9}" y="${fy(q.y) + (s.endLabelDy ?? -9)}" font-size="16" font-weight="bold" text-anchor="end" fill="${s.color}" stroke="#fff" stroke-width="4" paint-order="stroke">${esc(s.endLabel)}</text>`);
		}
	}
	let y = T + H + 62;
	for (const s of series) {
		out.push(`<line x1="12" x2="50" y1="${y - 5}" y2="${y - 5}" stroke="${s.color}" stroke-width="${Math.max(3, s.width ?? 3.5)}" stroke-dasharray="${s.dash ?? ""}"/>`);
		out.push(text(58, y, s.name, { size: 16 }));
		y += 24;
	}
	const [foot, h] = paragraphs(footer, y);
	out.push(foot);
	const height = Math.ceil(h + 8);
	const body = out.join("\n");
	if (raw) return { body, height };
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" ${FONT}><rect width="100%" height="100%" fill="#fff"/>\n${body}\n</svg>`;
}

const CAT = [
	["storage read/parse", "#1c7ed6"],
	["JSON/validation", "#74c0fc"],
	["replay/derivation", "#e8590c"],
	["checkpoint", "#f59f00"],
	["hashing", "#ae3ec9"],
	["GC", "#868e96"],
	["model/tool fake", "#40c057"],
	["other", "#ced4da"],
];
/** Horizontal stacked bars, one per row {label, parts:{cat: ms}}; returns [svg, bottom]. */
function stackedBars(rows, y0) {
	const max = Math.max(...rows.map((r) => Object.values(r.parts).reduce((a, b) => a + b, 0)), 1);
	const out = [];
	let y = y0;
	const BW = WIDTH - 20 - 80;
	for (const r of rows) {
		for (const l of wrap(r.label, 48)) {
			out.push(text(10, y + 16, l, { size: 16, weight: "bold" }));
			y += 20;
		}
		y += 4;
		let x = 10;
		const sum = Object.values(r.parts).reduce((a, b) => a + b, 0);
		for (const [cat, color] of CAT) {
			const v = r.parts[cat] ?? 0;
			const w = (v / max) * BW;
			if (w <= 0) continue;
			out.push(`<rect x="${x}" y="${y}" width="${w}" height="30" fill="${color}"/>`);
			if (w > 34) out.push(text(x + w / 2, y + 21, `${Math.round((v / sum) * 100)}%`, { size: 14, anchor: "middle", fill: ["other", "JSON/validation", "checkpoint"].includes(cat) ? "#222" : "#fff" }));
			x += w;
		}
		out.push(text(x + 6, y + 21, `${fmtMs(sum)} ms`, { size: 16, weight: "bold" }));
		y += 46;
	}
	let lx = 10;
	let ly = y + 8;
	for (const [cat, color] of CAT) {
		const w = cat.length * 8.2 + 34;
		if (lx + w > WIDTH - 10) {
			lx = 10;
			ly += 26;
		}
		out.push(`<rect x="${lx}" y="${ly - 13}" width="16" height="16" fill="${color}"/>`);
		out.push(text(lx + 22, ly, cat, { size: 15 }));
		lx += w;
	}
	return [out.join("\n"), ly + 16];
}

function barChart({ title, subtitle, bars, unit = "ms" }) {
	if (!bars.length) return undefined;
	const [head, T] = heading(title, subtitle);
	const L = 200;
	const rowH = 40;
	const height = T + bars.length * rowH + 20;
	const max = Math.max(...bars.map((b) => b.hi ?? b.value));
	const W = WIDTH - L - 80;
	const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" ${FONT}>`, `<rect width="100%" height="100%" fill="#fff"/>`, head];
	bars.forEach((b, i) => {
		const y = T + i * rowH;
		out.push(text(L - 8, y + 22, b.label, { size: 16, anchor: "end" }));
		const w = (b.value / max) * W;
		out.push(`<rect x="${L}" y="${y + 4}" width="${Math.max(w, 1)}" height="26" fill="${b.color}" opacity="${b.opacity ?? 1}"/>`);
		if (b.lo !== undefined) out.push(`<line x1="${L + (b.lo / max) * W}" x2="${L + (b.hi / max) * W}" y1="${y + 17}" y2="${y + 17}" stroke="#222" stroke-width="2"/>`);
		out.push(text(L + Math.max(w, ((b.hi ?? 0) / max) * W) + 6, y + 22, unit === "ms" ? `${fmtMs(b.value)} ms` : `${b.value}`, { size: 16 }));
	});
	out.push(`</svg>`);
	return out.join("\n");
}

// ---------- build charts ----------
const charts = {};
const seriesFor = (fn, systems = SYSTEMS, opts = {}) =>
	RTS.flatMap((rt) => systems.map((sys) => ({ name: `${SYS[sys].label} · ${rt}`, color: SYS[sys].color, dash: RT_DASH[rt], points: fn(rt, sys), ...opts }))).filter((s) => s.points.length);
const recordsAt = (sys, rt, n) => builds(rt, sys).find((b) => b.turns === n)?.records;
/** Local log-log slope between the two largest sizes. */
const tailSlope = (p) => (p.length >= 2 && p.at(-2).x > 0 ? Math.log(p.at(-1).y / p.at(-2).y) / Math.log(p.at(-1).x / p.at(-2).x) : undefined);
const profileOf = (sys, what) => profs.filter((r) => r.system === sys && r.what === what).sort((a, b) => b.turns - a.turns)[0];
const shares = (p) => {
	if (!p) return "";
	const total = Object.values(p.categories).reduce((a, b) => a + b, 0) || 1;
	return Object.entries(p.categories)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`)
		.join(", ");
};

// Headline: warm tool turn scaling with causes + where the milliseconds go.
{
	const ser = [];
	for (const rt of RTS)
		for (const sys of SYSTEMS) {
			const points = warm(rt, sys, "tool");
			const last = points.at(-1);
			ser.push({ name: `${SYS[sys].label} · ${rt}`, color: SYS[sys].color, dash: RT_DASH[rt], points, endLabel: rt === "node" && last ? fmt(last.y) : undefined, endLabelDy: sys === "pi" ? -10 : 20 });
		}
	const why = [{ heading: "Why the curves bend (Node, largest size)" }];
	for (const sys of SYSTEMS) {
		const p = warm("node", sys, "tool");
		const last = p.at(-1);
		if (!last) continue;
		const k = tailSlope(p);
		const recs = recordsAt(sys, "node", last.x)?.native;
		const prof = shares(profileOf(sys, "turn"));
		const head = `${SYS[sys].label}: ${fmt(last.y)} at ${last.x} turns${recs ? ` (${recs.toLocaleString("en")} ${sys === "tardie" ? "journal events" : "entries"})` : ""}${k !== undefined ? `, local slope n^${k.toFixed(2)}` : ""}.`;
		const cause =
			sys === "tardie"
				? "Each journal event re-validates durable-atom state, copying and walking every growing array (conversation, turns, spend: core/atoms/incremental/validate.ts); each model call rebuilds the whole prompt (effect ai Prompt); a checkpoint every 500 events re-encodes all state (16 MB at 3000 turns)."
				: sys === "pi"
					? "Each model call re-reads every transcript row from SQLite and JSON-parses it (storage/sqlite/storage.ts parseJson), in both the prepare and the request phase of every generation (harness/generation.ts)."
					: "Same per-call transcript read, but the request phase reuses the range its prepare phase scanned within one task invocation and only reads newer entries (harness/context.ts readContextFrom), so each generation does one full scan instead of two.";
		why.push({ color: SYS[sys].color, boldFirst: true, text: `${head} CPU: ${prof}. ${cause}` });
	}
	const chart = lineChart({
		title: "Warm tool turn vs dialogue length",
		subtitle: "Median of ≥9 runs, min–max bars, log-log. Solid = Node 24, dashed = Bun. Same instant fake model, one echo tool, compaction off.",
		xLabel: "dialogue turns already in the thread",
		yLabel: "tool-turn latency",
		series: ser,
		footer: why,
		raw: true,
	});
	if (chart) {
		const rowsBar = [];
		for (const sys of SYSTEMS) {
			const p = profileOf(sys, "turn");
			if (!p) continue;
			const runs = runsOf(sys, p.turns, "turn");
			rowsBar.push({ label: `${SYS[sys].label}, ${p.turns} turns: CPU ms per tool turn`, parts: Object.fromEntries(Object.entries(p.categories).map(([k, v]) => [k, v / runs])) });
		}
		let body = chart.body;
		let h = chart.height;
		if (rowsBar.length) {
			const [hd, y1] = paragraphs([{ heading: "Where the milliseconds go (CPU profile, Node)" }], h + 4);
			const [bars, bottom] = stackedBars(rowsBar, y1);
			body += hd + bars;
			h = bottom + 10;
		}
		charts.headline = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${h}" width="${WIDTH}" height="${h}" ${FONT}><rect width="100%" height="100%" fill="#fff"/>\n${body}\n</svg>`;
	}
}
charts["warm-chat"] = lineChart({
	title: "Warm no-tool turn vs dialogue length",
	subtitle: "user → answer. Median, min–max bars. Solid = Node, dashed = Bun.",
	xLabel: "dialogue turns in the thread",
	yLabel: "turn latency",
	series: seriesFor((rt, sys) => warm(rt, sys, "chat")),
});
charts.commit = lineChart({
	title: "Input commit vs dialogue length",
	subtitle: "Time for the input admission call to return (tardie runtime.send / pi conversation.submit). Median of the warm tool turns.",
	xLabel: "dialogue turns in the thread",
	yLabel: "commit latency",
	series: seriesFor((rt, sys) => warm(rt, sys, "tool").map((p) => ({ x: p.x, y: p.commit.median, lo: p.commit.min, hi: p.commit.max }))),
});
charts.build = lineChart({
	title: "Cumulative time to build N turns",
	subtitle: "Sum of tool-turn latencies through the real agent loop. Slope 1 = linear total (constant per turn), slope 2 = quadratic.",
	xLabel: "dialogue turns",
	yLabel: "cumulative build time",
	series: seriesFor((rt, sys) => builds(rt, sys).filter((b) => b.turns > 0).map((b) => ({ x: b.turns, y: b.cumulativeMs }))),
});
charts.reopen = lineChart({
	title: "Restart: reopen, and reopen + first turn",
	subtitle: "Fresh process per run (median of ≥9). Thin = reopen only (open + replay), thick = reopen + first tool turn.",
	xLabel: "dialogue turns in the thread",
	yLabel: "latency",
	series: [
		...seriesFor((rt, sys) => reopen(rt, sys).map((p) => ({ x: p.x, y: median(p.first), lo: Math.min(...p.first), hi: Math.max(...p.first) }))),
		...seriesFor((rt, sys) => reopen(rt, sys).map((p) => ({ x: p.x, y: median(p.open) })), SYSTEMS, { width: 2 }).map((s) => ({ ...s, name: `${s.name} (reopen only)` })),
	],
});
charts.disk = lineChart({
	title: "On-disk size vs dialogue length",
	subtitle: "SQLite file after close (WAL checkpointed). Thin dotted = tardie checkpoint payload alone.",
	xLabel: "dialogue turns",
	yLabel: "bytes (MB)",
	yUnit: "MB",
	series: [
		...seriesFor((rt, sys) => builds(rt, sys).filter((b) => b.turns > 0).map((b) => ({ x: b.turns, y: b.dbBytes / 2 ** 20 }))),
		...["node"].map((rt) => ({ name: "Tardigrade checkpoint payload", color: SYS.tardie.color, dash: "2 5", width: 2, points: builds(rt, "tardie").filter((b) => b.turns > 0 && b.records?.checkpointBytes).map((b) => ({ x: b.turns, y: b.records.checkpointBytes / 2 ** 20 })) })),
	],
});
charts.memory = lineChart({
	title: "Memory with the thread in use",
	subtitle: "heapUsed after forced GC, after open + 11 turns (warm tool-turn process). Thin = RSS. Heap right after open is in the table.",
	xLabel: "dialogue turns in the thread",
	yLabel: "MB",
	yUnit: "MB",
	series: [
		...seriesFor((rt, sys) => warm(rt, sys, "tool").map((p) => ({ x: p.x, y: p.r.memAfterTurns.heapUsedMB }))).map((s) => ({ ...s, name: `${s.name} heap` })),
		...seriesFor((rt, sys) => warm(rt, sys, "tool").map((p) => ({ x: p.x, y: p.r.memAfterTurns.rssMB })), SYSTEMS, { width: 1.5 }).map((s) => ({ ...s, name: `${s.name} RSS` })),
	],
});
charts.stream = lineChart({
	title: "Streaming: no-tool turn with 50 deltas",
	subtitle: "Same as the warm no-tool turn, but the fake model emits the 300-char answer as 50 text deltas (instant).",
	xLabel: "dialogue turns in the thread",
	yLabel: "turn latency",
	series: seriesFor((rt, sys) => warm(rt, sys, "chat", /^stream$/)),
});
for (const rt of RTS) {
	const ser = [
		{ name: "Tardigrade: durableAtom counter", color: SYS.tardie.color, dash: "", points: apps(rt, "tardie", "counter") },
		{ name: "Tardigrade: durableAtom growing array", color: SYS.tardie.color, dash: "2 5", points: apps(rt, "tardie", "array") },
		{ name: "Pi 1.0.4: document counter (idiomatic)", color: SYS.pi.color, dash: "", points: apps(rt, "pi", "counter") },
		{ name: "Pi 1.0.4: document growing array", color: SYS.pi.color, dash: "2 5", points: apps(rt, "pi", "array") },
		{ name: "Pi 1.0.4: transcript entries (non-idiomatic) *", color: "#7048e8", dash: "12 7", width: 3, points: apps(rt, "pi", "entries") },
		{ name: "Pi HEAD: document counter", color: SYS["pi-head"].color, dash: "", width: 2.5, points: apps(rt, "pi-head", "counter") },
		{ name: "Pi HEAD: document growing array", color: SYS["pi-head"].color, dash: "2 5", width: 2.5, points: apps(rt, "pi-head", "array") },
		{ name: "Pi HEAD: transcript entries (non-idiomatic) *", color: "#0ca678", dash: "12 7", width: 3, points: apps(rt, "pi-head", "entries") },
	];
	charts[`appstate-${rt}`] = lineChart({
		title: `Warm turn vs app-state growth (${rt})`,
		subtitle: "Short dialogue (3 tool turns) + N app-state edits, one commit each, 88-byte payload, never read by the model. No-tool turn.",
		xLabel: "app-state edits N",
		yLabel: "turn latency",
		series: ser,
		footer: [{ color: "#7048e8", text: "* What the vendor chart likely measured: bookkeeping stored as N custom transcript entries, which pi's context read scans on every model call. Idiomatic pi app state lives in documents (defineDoc), which the model path never reads." }],
	});
}
{
	const bars = [];
	for (const rt of RTS)
		for (const sys of SYSTEMS) {
			const rs = real.filter((r) => r.kind === "cold" && r.runtime === rt && r.system === sys && r.launchToAnswerMs != null);
			if (!rs.length) continue;
			const v = rs.map((r) => r.launchToAnswerMs);
			bars.push({ label: `${SYS[sys].label} · ${rt}`, value: median(v), lo: Math.min(...v), hi: Math.max(...v), color: SYS[sys].color, opacity: rt === "bun" ? 0.6 : 1 });
		}
	charts.cold = barChart({ title: "Cold start: process launch → first answer", subtitle: "Empty DB, one no-tool turn, fresh process each run (median, min–max). Bundled code on both runtimes.", bars });
}

// ---------- write charts ----------
let resvg;
try {
	resvg = (await import("@resvg/resvg-js")).Resvg;
} catch {}
const written = [];
for (const [name, svg] of Object.entries(charts)) {
	if (!svg) continue;
	writeFileSync(`${ROOT}charts/${name}.svg`, svg);
	written.push(name);
	if (resvg) {
		try {
			const png = new resvg(svg, { fitTo: { mode: "width", value: 1350 }, font: { loadSystemFonts: true } }).render().asPng();
			writeFileSync(`${ROOT}charts/${name}.png`, png);
		} catch (e) {
			console.error(`png ${name}: ${e.message}`);
		}
	}
}

// ---------- tables (markdown) ----------
const md = [];
const table = (head, body) => {
	if (!body.length) return;
	md.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...body.map((r) => `| ${r.join(" | ")} |`), "");
};
const sizes = [...new Set(real.filter((r) => r.kind === "warm" && /^dialogue/.test(r.step)).map((r) => sizeOf(r.db)))].sort((a, b) => a - b);
const cell = (p) => (p ? `${fmtMs(p.y)} (${fmtMs(p.lo)}–${fmtMs(p.hi)})` : "–");
const img = (name, alt) => (written.includes(name) ? `![${alt}](charts/${name}.svg)\n` : "");

const meta = rows.find((r) => r.runtime === "node" && r.cpu);
const runLine = /^run: (.+)$/m.exec(envText)?.[1] ?? "";
const cpuset = /^cpuset: (.+)$/m.exec(envText)?.[1];
const where = runLine.startsWith("http") ? `CI run: ${runLine}.` : runLine ? `Host: ${runLine.split(" ")[0]}${cpuset ? `, one container pinned to CPU ${cpuset}` : ""}.` : "";
md.push(`${where} Run: ${rows[0]?.at?.slice(0, 16) ?? "?"} → ${rows.at(-1)?.at?.slice(0, 16) ?? "?"} UTC. CPU: ${meta?.cpu ?? "?"}${cpuset ? "" : ` (${meta?.cpus ?? "?"} vCPU)`}. ${[...new Set(rows.map((r) => r.runtimeVersion).filter(Boolean))].join(", ")}. Pi HEAD: \`${headSha}\`. Times in ms; median (min–max) of ≥9 runs unless noted.`, "");
if (errors.length) md.push(`**${errors.length} measurement process(es) failed**; see "Errors" at the end.`, "");
md.push("### Headline", "", img("headline", "Warm tool turn vs dialogue length, with causes and a CPU breakdown"));

// Key findings, computed from this run's data so they stay true on reruns.
const at = (pts, n) => pts.find((p) => p.x === n);
/** HEAD vs 1.0.4 on every pi metric: [{metric, runtime, n, base, head, baseRange, headRange}]. */
const headComparisons = (() => {
	const out = [];
	const add = (metric, rt, n, base, head, unit = "ms") => {
		if (!base || !head || !Number.isFinite(base.v) || !Number.isFinite(head.v)) return;
		out.push({ metric, rt, n, base, head, unit });
	};
	const range = (xs) => ({ v: median(xs), lo: Math.min(...xs), hi: Math.max(...xs) });
	for (const rt of RTS) {
		for (const kind of ["tool", "chat"])
			for (const p of warm(rt, "pi", kind)) {
				const h = at(warm(rt, "pi-head", kind), p.x);
				if (!h) continue;
				add(`warm ${kind === "tool" ? "tool" : "no-tool"} turn`, rt, p.x, { v: p.y, lo: p.lo, hi: p.hi }, { v: h.y, lo: h.lo, hi: h.hi });
				if (kind === "tool") {
					add("input commit", rt, p.x, { v: p.commit.median, lo: p.commit.min, hi: p.commit.max }, { v: h.commit.median, lo: h.commit.min, hi: h.commit.max });
					add("heap after 11 turns", rt, p.x, { v: p.r.memAfterTurns.heapUsedMB }, { v: h.r.memAfterTurns.heapUsedMB }, "MB");
					add("RSS after 11 turns", rt, p.x, { v: p.r.memAfterTurns.rssMB }, { v: h.r.memAfterTurns.rssMB }, "MB");
				}
			}
		for (const p of warm(rt, "pi", "chat", /^stream$/)) {
			const h = at(warm(rt, "pi-head", "chat", /^stream$/), p.x);
			if (h) add("streaming no-tool turn (50 deltas)", rt, p.x, { v: p.y, lo: p.lo, hi: p.hi }, { v: h.y, lo: h.lo, hi: h.hi });
		}
		for (const p of reopen(rt, "pi")) {
			const h = reopen(rt, "pi-head").find((q) => q.x === p.x);
			if (!h) continue;
			add("reopen + first turn", rt, p.x, range(p.first), range(h.first));
			add("heap after open", rt, p.x, { v: median(p.heap) }, { v: median(h.heap) }, "MB");
		}
		for (const v of ["counter", "array", "entries"])
			for (const p of apps(rt, "pi", v)) {
				const h = at(apps(rt, "pi-head", v), p.x);
				if (!h) continue;
				add(`app-state ${v}: no-tool turn`, rt, p.x, { v: p.y, lo: p.lo, hi: p.hi }, { v: h.y, lo: h.lo, hi: h.hi });
				add(`app-state ${v}: one edit commit`, rt, p.x, { v: p.app.median, lo: p.app.min, hi: p.app.max }, { v: h.app.median, lo: h.app.min, hi: h.app.max });
			}
		for (const b of builds(rt, "pi").filter((q) => q.turns > 0)) {
			const h = builds(rt, "pi-head").find((q) => q.turns === b.turns);
			if (!h) continue;
			add("cumulative build", rt, b.turns, { v: b.cumulativeMs }, { v: h.cumulativeMs });
			add("DB size", rt, b.turns, { v: b.dbBytes / 2 ** 20 }, { v: h.dbBytes / 2 ** 20 }, "MB");
		}
		const cold = (s) => real.filter((r) => r.kind === "cold" && r.runtime === rt && r.system === s).map((r) => r.launchToAnswerMs);
		if (cold("pi").length && cold("pi-head").length) add("cold start", rt, 0, range(cold("pi")), range(cold("pi-head")));
	}
	return out;
})();
/** A regression: HEAD ≥ 10% worse and, where min–max ranges exist, the ranges do not overlap. */
const regressed = (c) => c.head.v > c.base.v * 1.1 && (c.unit === "MB" ? c.head.v - c.base.v > 1 : c.head.lo === undefined || c.head.lo > c.base.hi) && !(c.unit === "ms" && c.head.v - c.base.v < 0.5);
const improved = (c) => c.head.v < c.base.v / 1.1 && (c.unit === "MB" ? c.base.v - c.head.v > 1 : c.head.hi === undefined || c.head.hi < c.base.lo);
const fmtU = (v, unit) => (unit === "MB" ? `${v.toFixed(1)} MB` : fmt(v));
{
	const f = [];
	for (const rt of RTS) {
		const t = warm(rt, "tardie", "tool");
		const p = warm(rt, "pi", "tool");
		const h = warm(rt, "pi-head", "tool");
		if (!t.length || !p.length) continue;
		const n = t.at(-1).x;
		const show = (k) => `Tardigrade ${fmt(at(t, k)?.y)} / 1.0.4 ${fmt(at(p, k)?.y)} / HEAD ${fmt(at(h, k)?.y)}`;
		const cross = (q) => t.find((x) => at(q, x.x) && x.y < at(q, x.x).y);
		f.push(
			`**Warm tool turn (${rt})**: empty thread ${show(0)}; ${[1000, 3000, 10000].filter((k) => k < n && at(t, k)).map((k) => `at ${k} turns ${show(k)}; `).join("")}at ${n} turns ${show(n)}. ${cross(p) ? `Tardigrade beats 1.0.4 from ${cross(p).x} turns` : "1.0.4 beats Tardigrade at every size"}; ${h.length ? (cross(h) ? `Tardigrade beats HEAD from ${cross(h).x} turns.` : "HEAD beats Tardigrade at every size.") : ""} Local slope between the two largest sizes: Tardigrade n^${tailSlope(t)?.toFixed(2)}, 1.0.4 n^${tailSlope(p)?.toFixed(2)}, HEAD n^${tailSlope(h)?.toFixed(2)}.`,
		);
		f.push(`**Input commit (${rt})**: Tardigrade grows with history (${fmt(t[0].commit.median)} → ${fmt(t.at(-1).commit.median)} at ${n} turns); Pi stays flat (1.0.4 ${fmt(at(p, n)?.commit.median)}, HEAD ${fmt(at(h, n)?.commit.median)} at ${n} turns).`);
	}
	{
		const n = reopen("node", "tardie").at(-1)?.x;
		const r = (s) => reopen("node", s).find((q) => q.x === n);
		if (r("tardie") && r("pi"))
			f.push(`**Restart (node, ${n} turns)**: Tardigrade reopen ${fmt(median(r("tardie").open))} (checkpoint decode + suffix replay) + first turn ${fmt(median(r("tardie").first))}; Pi opens lazily in ~${fmt(median(r("pi").open))} and pays on the first turn (1.0.4 ${fmt(median(r("pi").first))}, HEAD ${fmt(median(r("pi-head")?.first ?? [Number.NaN]))}).`);
		const w = (s) => warm("node", s, "tool").at(-1);
		const b = (s) => builds("node", s).at(-1);
		if (w("tardie") && w("pi"))
			f.push(`**Memory and disk (node, ${w("tardie").x} turns)**: heap after 11 turns (forced GC) Tardigrade ${w("tardie").r.memAfterTurns.heapUsedMB.toFixed(0)} MB / 1.0.4 ${w("pi").r.memAfterTurns.heapUsedMB.toFixed(0)} MB / HEAD ${w("pi-head")?.r.memAfterTurns.heapUsedMB.toFixed(0) ?? "–"} MB; SQLite file ${bytes(b("tardie")?.dbBytes)} / ${bytes(b("pi")?.dbBytes)} / ${bytes(b("pi-head")?.dbBytes)}, of which Tardigrade's single checkpoint is ${bytes(b("tardie")?.records?.checkpointBytes)}.`);
	}
	for (const rt of ["node"]) {
		const nmax = Math.max(...real.filter((r) => r.kind === "appwarm" && r.runtime === rt).map((r) => sizeOf(r.db)));
		const g = (s, v) => at(apps(rt, s, v), nmax);
		if (Number.isFinite(nmax) && g("pi", "entries"))
			f.push(`**App-state growth (${rt}, N = ${nmax.toLocaleString("en")} edits)**: warm no-tool turn stays flat for Tardigrade atoms (${fmt(g("tardie", "counter")?.y)}) and Pi documents (1.0.4 ${fmt(g("pi", "counter")?.y)}, HEAD ${fmt(g("pi-head", "counter")?.y)}); only the non-idiomatic variant that stores bookkeeping as transcript entries grows (1.0.4 ${fmt(at(apps(rt, "pi", "entries"), 0)?.y)} → ${fmt(g("pi", "entries")?.y)}, HEAD → ${fmt(g("pi-head", "entries")?.y)}), the shape of the vendor's chart. A growing array costs per edit in all (one commit: Tardigrade ${fmt(g("tardie", "array")?.app.median)}, Pi 1.0.4 ${fmt(g("pi", "array")?.app.median)}, HEAD ${fmt(g("pi-head", "array")?.app.median)}).`);
	}
	{
		const v = real.filter((r) => r.kind === "version" && r.change !== "control");
		const sum = (s) => `${v.filter((r) => r.system === s && r.pass).length}/${v.filter((r) => r.system === s).length}`;
		if (v.length) f.push(`**Versioning**: changed-code reopen cases passed: Tardigrade ${sum("tardie")}, Pi 1.0.4 ${sum("pi")}, Pi HEAD ${sum("pi-head")} (both runtimes). Tardigrade rejects a changed system prompt or tool set whenever the replayed suffix contains model requests ("Effect request differs from its proposal"), and a changed durableAtom schema whenever a checkpoint holds the old state ("Missing key"); see §9.`);
	}
	{
		const c = (rt, s) => median(real.filter((r) => r.kind === "cold" && r.runtime === rt && r.system === s).map((r) => r.launchToAnswerMs));
		if (Number.isFinite(c("node", "tardie"))) f.push(`**Cold start** (launch → first answer): node Tardigrade ${fmt(c("node", "tardie"))} / 1.0.4 ${fmt(c("node", "pi"))} / HEAD ${fmt(c("node", "pi-head"))}; bun ${fmt(c("bun", "tardie"))} / ${fmt(c("bun", "pi"))} / ${fmt(c("bun", "pi-head"))}.`);
	}
	for (const rt of RTS) {
		const n = Math.max(...headComparisons.filter((c) => c.rt === rt && c.metric === "warm tool turn").map((c) => c.n));
		const c = (m) => headComparisons.find((x) => x.rt === rt && x.n === n && x.metric === m);
		const d = (m) => (c(m) ? `${fmtU(c(m).base.v, c(m).unit)} → ${fmtU(c(m).head.v, c(m).unit)} (${c(m).head.v <= c(m).base.v ? "−" : "+"}${Math.abs((1 - c(m).head.v / c(m).base.v) * 100).toFixed(0)}%)` : "–");
		if (Number.isFinite(n)) f.push(`**HEAD vs 1.0.4 (${rt}, ${n} turns)**: tool turn ${d("warm tool turn")}; no-tool turn ${d("warm no-tool turn")}; reopen + first turn ${d("reopen + first turn")}; heap after 11 turns ${d("heap after 11 turns")}; RSS ${d("RSS after 11 turns")}.`);
	}
	{
		const reg = headComparisons.filter(regressed);
		f.push(reg.length ? `**HEAD regressions vs 1.0.4** (≥10% worse, ranges not overlapping): ${reg.length}; listed in "HEAD vs 1.0.4".` : "**HEAD regressions vs 1.0.4**: none (no metric ≥10% worse with non-overlapping min–max ranges).");
	}
	if (f.length) md.push("### Key findings (computed from this run)", "", ...f.map((x) => `- ${x}`), "");
}

md.push("### 1. Warm turn latency vs dialogue length", "");
for (const kind of ["tool", "chat"]) {
	md.push(`**${kind === "tool" ? "Tool turn" : "No-tool turn"}** (ms)`, "");
	table(
		["turns", ...RTS.flatMap((rt) => SYSTEMS.map((s) => `${SYS[s].label} · ${rt}`))],
		sizes.map((n) => [String(n), ...RTS.flatMap((rt) => SYSTEMS.map((s) => cell(warm(rt, s, kind).find((p) => p.x === n))))]),
	);
}
md.push(img("warm-chat", "Warm no-tool turn"));
md.push("**Native records per size** (tardie journal events; pi transcript entries + tasks + submissions)", "");
table(
	["turns", ...RTS.flatMap((rt) => [`tardie events · ${rt}`, `pi 1.0.4 entries/tasks/subs · ${rt}`, `pi HEAD entries/tasks/subs · ${rt}`])],
	sizes.map((n) => [
		String(n),
		...RTS.flatMap((rt) => {
			const t = recordsAt("tardie", rt, n);
			const pi = (s) => {
				const p = recordsAt(s, rt, n);
				return p ? `${p.native} / ${p.tasks} / ${p.submissions}` : "–";
			};
			return [t ? String(t.native) : "–", pi("pi"), pi("pi-head")];
		}),
	]),
);

md.push("### 2. Warm turn vs app-state growth", "");
for (const rt of RTS) {
	const ns = [...new Set(real.filter((r) => r.kind === "appwarm" && r.runtime === rt).map((r) => sizeOf(r.db)))].sort((a, b) => a - b);
	if (!ns.length) continue;
	md.push(`**${rt}**: no-tool turn ms, and one app-state commit ms (in brackets)`, "");
	const variants = [
		["tardie", "counter", "tardie atom counter"],
		["tardie", "array", "tardie atom array"],
		["pi", "counter", "pi 1.0.4 doc counter"],
		["pi", "array", "pi 1.0.4 doc array"],
		["pi", "entries", "pi 1.0.4 entries (non-idiomatic)"],
		["pi-head", "counter", "pi HEAD doc counter"],
		["pi-head", "array", "pi HEAD doc array"],
		["pi-head", "entries", "pi HEAD entries (non-idiomatic)"],
	];
	table(
		["N", ...variants.map((v) => v[2])],
		ns.map((n) => [String(n), ...variants.map(([s, v]) => {
			const p = apps(rt, s, v).find((q) => q.x === n);
			return p ? `${fmtMs(p.y)} [${fmtMs(p.app.median)}]` : "–";
		})]),
	);
	md.push(img(`appstate-${rt}`, `App-state growth ${rt}`));
}

md.push("### 3. Single input-commit latency vs history", "");
table(
	["turns", ...RTS.flatMap((rt) => SYSTEMS.map((s) => `${SYS[s].label} · ${rt}`))],
	sizes.map((n) => [String(n), ...RTS.flatMap((rt) => SYSTEMS.map((s) => {
		const p = warm(rt, s, "tool").find((q) => q.x === n);
		return p ? `${fmtMs(p.commit.median)} (${fmtMs(p.commit.min)}–${fmtMs(p.commit.max)})` : "–";
	}))]),
);
md.push(img("commit", "Input commit latency"));

md.push("### 4. Cumulative build time to N turns", "");
const bsizes = [...new Set(real.filter((r) => r.kind === "build" && r.step !== "smoke").map((r) => r.turns))].sort((a, b) => a - b).filter((n) => n > 0);
table(
	["turns", ...RTS.flatMap((rt) => SYSTEMS.map((s) => `${SYS[s].label} · ${rt}`))],
	bsizes.map((n) => [String(n), ...RTS.flatMap((rt) => SYSTEMS.map((s) => {
		const b = builds(rt, s).find((q) => q.turns === n);
		return b ? `${fmt(b.cumulativeMs)} (${fmtMs(b.segmentMsPerTurn)} ms/turn)` : "–";
	}))]),
);
const skips = real.filter((r) => r.kind === "build-skip");
for (const s of skips) md.push(`- Not built: ${s.system}${s.variant ? ` ${s.variant}` : ""} on ${s.runtime} to ${s.target} (projected ${fmt(s.projectedMs)} over the ${fmt(s.budgetMs)} budget; reached ${s.reached}).`);
if (skips.length) md.push("");
md.push(img("build", "Cumulative build time"));

md.push("### 5. Restart: reopen and first turn", "");
table(
	["turns", ...RTS.flatMap((rt) => SYSTEMS.map((s) => `${SYS[s].label} · ${rt} reopen / +first turn`))],
	sizes.map((n) => [String(n), ...RTS.flatMap((rt) => SYSTEMS.map((s) => {
		const p = reopen(rt, s).find((q) => q.x === n);
		return p ? `${fmtMs(median(p.open))} / ${fmtMs(median(p.first))}` : "–";
	}))]),
);
md.push(img("reopen", "Reopen"));

md.push("### 6. On-disk size", "");
table(
	["turns", ...RTS.flatMap((rt) => [`tardie DB · ${rt}`, `tardie checkpoint · ${rt}`, `pi DB · ${rt}`])],
	bsizes.map((n) => [String(n), ...RTS.flatMap((rt) => {
		const t = builds(rt, "tardie").find((b) => b.turns === n);
		const p = builds(rt, "pi").find((b) => b.turns === n);
		return [bytes(t?.dbBytes), bytes(t?.records?.checkpointBytes), bytes(p?.dbBytes)];
	})]),
);
md.push(img("disk", "Disk size"));

md.push("### 7. Memory with the thread open", "");
{
	const cols = RTS.flatMap((rt) => SYSTEMS.map((s) => [rt, s]));
	table(
		["turns", ...cols.map(([rt, s]) => `${SYS[s].label} · ${rt}: heap after open / after 11 turns / RSS MB`)],
		sizes.map((n) => [String(n), ...cols.map(([rt, s]) => {
			const p = reopen(rt, s).find((q) => q.x === n);
			const w = warm(rt, s, "tool").find((q) => q.x === n);
			return p || w ? `${p ? median(p.heap).toFixed(1) : "–"} / ${w ? w.r.memAfterTurns.heapUsedMB.toFixed(1) : "–"} / ${w ? w.r.memAfterTurns.rssMB.toFixed(0) : "–"}` : "–";
		})]),
	);
}
md.push(img("memory", "Memory"));

md.push("### 8. Cold start", "");
table(
	["system · runtime", "launch → first answer", "in-process (open + turn)"],
	RTS.flatMap((rt) => SYSTEMS.map((s) => {
		const rs = real.filter((r) => r.kind === "cold" && r.runtime === rt && r.system === s);
		if (!rs.length) return undefined;
		const v = rs.map((r) => r.launchToAnswerMs);
		return [`${SYS[s].label} · ${rt}`, `${fmtMs(median(v))} (${fmtMs(Math.min(...v))}–${fmtMs(Math.max(...v))})`, `${fmtMs(median(rs.map((r) => r.openMs + r.firstTurnMs)))}`];
	}).filter(Boolean)),
);
md.push(img("cold", "Cold start"));

md.push("### 9. Versioning / evolution matrix", "");
md.push("Each cell: a fresh DB with 3 tool turns (+1 app-state edit per turn), then reopened by code with one change. **quiescent** = closed cleanly; **in-flight** = the process SIGKILLed itself inside the echo tool of a 4th turn. Pass = reopen, recovery of unfinished work, a new tool turn and an app-state read all succeed.", "");
const vrows = real.filter((r) => r.kind === "version");
const vcases = [...new Set(vrows.map((r) => `${r.system}|${/-(quiescent|inflight)-/.exec(r.db)?.[1]}|${r.ckpt}`))];
for (const rt of RTS) {
	const rs = vrows.filter((r) => r.runtime === rt);
	if (!rs.length) continue;
	md.push(`**${rt}**`, "");
	table(
		["system", "history state", "control (no change)", "system prompt changed", "tool added", "state schema v2"],
		vcases.map((c) => {
			const [s, mode, ck] = c.split("|");
			return [
				SYS[s].label,
				`${mode === "inflight" ? "in-flight (killed in tool)" : "quiescent"}${s === "tardie" ? `, checkpoint ${ck}` : ""}`,
				...["control", "system", "tool", "schema"].map((ch) => {
					const r = rs.find((q) => q.system === s && q.ckpt === ck && q.db.includes(`-${mode}-`) && q.change === ch);
					if (!r) return "–";
					if (r.pass) return "✅ pass";
					const failed = ["open", "recover", "newTurn", "readState"].find((k) => r[k] && r[k] !== "ok");
					return `❌ ${failed}: ${mdSafe(String(r[failed] ?? "").replace(/^FAIL: /, "").replace(/\s+/g, " ").slice(0, 140))}`;
				}),
			];
		}),
	);
}
const inflightNotes = vrows.filter((r) => r.runtime === "node" && r.change === "control" && r.db.includes("-inflight-"));
for (const r of inflightNotes) md.push(`- ${SYS[r.system].label} in-flight recovery (control${r.system === "tardie" ? `, checkpoint ${r.ckpt}` : ""}): \`${mdSafe(JSON.stringify(r.recovered)).slice(0, 300)}\``);
md.push("");

md.push("### 10. Where the time goes (CPU profiles, Node, largest size)", "");
table(
	["system", "turns", "window", ...CAT.map((c) => c[0])],
	profs.map((p) => {
		const runs = runsOf(p.system, p.turns, p.what);
		return [SYS[p.system].label, String(p.turns), `${p.what} (ms per ${p.what})`, ...CAT.map(([c]) => fmtMs((p.categories[c] ?? 0) / runs))];
	}),
);
for (const p of profs) md.push(`<details><summary>Top self-time functions: ${SYS[p.system].label}, ${p.what}, ${p.turns} turns</summary>\n\n${p.top.slice(0, 15).map((t) => `- ${fmtMs(t.ms / runsOf(p.system, p.turns, p.what))} ms/${p.what} — \`${mdSafe(t.fn)}\``).join("\n")}\n\n</details>\n`);

md.push("### HEAD vs 1.0.4", "");
md.push(`Pi Durable HEAD is earendil-works/pi at \`${headSha}\` (from \`pi-head.sha\`), bundled from its TypeScript sources; 1.0.4 is the npm release. "Regression" = HEAD at least 10% worse with non-overlapping min–max ranges (for single values such as memory: at least 10% and 1 MB worse).`, "");
{
	const corr = real.filter((r) => r.kind === "correctness");
	if (corr.length) {
		md.push("**Request equivalence** (scripted dialogue: 3 turns, manual compaction, 1 turn, reset, 2 turns; hashes of every model request's messages and of the final transcript, timestamps removed):", "");
		table(
			["runtime", "system", "compaction", "model requests", "requests hash", "transcript entries", "transcript hash"],
			corr.map((r) => [r.runtime, SYS[r.system]?.label ?? r.system, r.steps.join(", "), String(r.requests), `\`${r.requestsHash}\``, String(r.transcriptEntries), `\`${r.transcriptHash}\``]),
		);
		for (const rt of RTS) {
			const a = corr.find((r) => r.runtime === rt && r.system === "pi");
			const b = corr.find((r) => r.runtime === rt && r.system === "pi-head");
			if (a && b) md.push(`- ${rt}: ${a.requestsHash === b.requestsHash && a.transcriptHash === b.transcriptHash ? "✅ identical model requests and transcript" : "❌ HEAD differs from 1.0.4 (requests or transcript)"}.`);
		}
		md.push("");
	}
	const reg = headComparisons.filter(regressed);
	const imp = headComparisons.filter(improved);
	md.push(`**Regressions (${reg.length})**`, "");
	if (reg.length) table(["metric", "runtime", "size", "1.0.4", "HEAD", "change"], reg.map((c) => [c.metric, c.rt, String(c.n), fmtU(c.base.v, c.unit), fmtU(c.head.v, c.unit), `+${((c.head.v / c.base.v - 1) * 100).toFixed(0)}%`]));
	else md.push("None.", "");
	const noisy = headComparisons.filter((c) => !regressed(c) && c.head.v > c.base.v * 1.1);
	md.push(`**HEAD ≥10% worse but within noise (${noisy.length})** (min–max ranges overlap, or below the 0.5 ms / 1 MB floor)`, "");
	if (noisy.length) table(["metric", "runtime", "size", "1.0.4", "HEAD", "change"], noisy.map((c) => [c.metric, c.rt, String(c.n), `${fmtU(c.base.v, c.unit)}${c.base.lo !== undefined ? ` (${fmtMs(c.base.lo)}–${fmtMs(c.base.hi)})` : ""}`, `${fmtU(c.head.v, c.unit)}${c.head.lo !== undefined ? ` (${fmtMs(c.head.lo)}–${fmtMs(c.head.hi)})` : ""}`, `+${((c.head.v / c.base.v - 1) * 100).toFixed(0)}%`]));
	else md.push("None.", "");
	md.push(`**Improvements (${imp.length})** (at least 10% better, ranges not overlapping)`, "");
	if (imp.length) table(["metric", "runtime", "size", "1.0.4", "HEAD", "change"], imp.map((c) => [c.metric, c.rt, String(c.n), fmtU(c.base.v, c.unit), fmtU(c.head.v, c.unit), `−${((1 - c.head.v / c.base.v) * 100).toFixed(0)}%`]));
}

md.push("### Streaming", "");
md.push(img("stream", "Streaming 50 deltas"));
if (errors.length) {
	md.push("### Errors", "");
	for (const e of errors) md.push(`- ${e.runtime} ${e.step}: \`${mdSafe(e.args)}\` exited ${e.code}: \`${mdSafe(String(e.tail).replace(/\s+/g, " ").slice(-400))}\``);
	md.push("");
}
const results = md.join("\n");

// ---------- README + report ----------
const readmePath = `${ROOT}README.md`;
const readme = readFileSync(readmePath, "utf8");
const START = "<!-- RESULTS:START -->";
const END = "<!-- RESULTS:END -->";
const updated = readme.includes(START) ? readme.replace(new RegExp(`${START}[\\s\\S]*${END}`), `${START}\n${results}\n${END}`) : `${readme}\n${START}\n${results}\n${END}\n`;
writeFileSync(readmePath, updated);

// Minimal markdown → HTML for the README subset we write (headings, paragraphs, lists, tables, code, images, details).
const inline = (s) =>
	s
		.replace(/!\[([^\]]*)\]\(charts\/([\w-]+)\.svg\)/g, (_, alt, name) => (charts[name] ? `<figure>${charts[name].replace(/width="\d+" height="\d+"/, 'width="100%"')}<figcaption>${alt}</figcaption></figure>` : ""))
		.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
const toHtml = (src) => {
	const out = [];
	const lines = src.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (l.startsWith("```")) {
			const code = [];
			while (++i < lines.length && !lines[i].startsWith("```")) code.push(esc(lines[i]));
			out.push(`<pre><code>${code.join("\n")}</code></pre>`);
		} else if (/^#{1,4} /.test(l)) {
			const n = l.indexOf(" ");
			out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`);
		} else if (l.startsWith("|")) {
			const t = [];
			while (i < lines.length && lines[i].startsWith("|")) t.push(lines[i++]);
			i--;
			const cells = (r) => r.slice(1, -1).split(" | ").map((c) => c.trim());
			out.push(`<div class="t"><table><thead><tr>${cells(t[0]).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${t.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
		} else if (/^\s*- /.test(l)) {
			const items = [];
			while (i < lines.length && /^\s*- /.test(lines[i])) items.push(lines[i++].replace(/^\s*- /, ""));
			i--;
			out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
		} else if (l.startsWith("<")) out.push(l.includes("<!--") ? "" : inline(l));
		else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
	}
	return out.join("\n");
};
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tardigrade vs Pi Durable benchmark</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:980px;margin:0 auto;padding:12px;color:#222}figure{margin:16px 0}svg{max-width:100%;height:auto}figcaption{color:#666;font-size:14px}.t{overflow-x:auto}table{border-collapse:collapse;font-size:14px}td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top}th{background:#f5f5f5}code{background:#f3f3f3;padding:0 3px;border-radius:3px;font-size:90%}pre{background:#f6f8fa;padding:8px;overflow-x:auto}details{margin:6px 0}</style></head><body>
${toHtml(updated)}
<h2>Environment</h2><pre>${esc(envText)}</pre>
</body></html>`;
writeFileSync(`${ROOT}report.html`, html);
console.log(`charts: ${written.join(", ")}${resvg ? " (+png)" : ""}; README results and report.html updated (${rows.length} rows, ${errors.length} errors)`);
