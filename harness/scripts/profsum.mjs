// Summarise window-filtered CPU profiles into cost categories.
//   node scripts/profsum.mjs <profile.json> [bundle.mjs.map]  → prints JSON {categories, top, aligned}
//
// Samples outside the measured windows (open, replay, warmup, waiting between commits) are dropped. Each kept sample
// is attributed to the first matching category, checking the whole synchronous stack (leaf → root):
//   GC                    leaf is "(garbage collector)"
//   hashing               a frame computes a digest: tardie input-digest/checkpointDigest, node:crypto, sha256
//   checkpoint            tardie checkpoint encode/decode/chunking, snapshot.checkpoint()
//   storage read/parse    SQLite driver + storage adapter: pi storage/sqlite, tardie sql-journal, effect/unstable/sql,
//                         node:sqlite / bun:sqlite facades (includes JSON.parse/stringify of rows done there)
//   model/tool fake       the benchmark's fake provider/model and echo tool
//   JSON/validation       leaf JSON.parse/stringify/structuredClone, effect Schema, typebox, tardie incremental validate
//   replay/derivation     tardie runtime/atoms (replay, execution, log views, atoms, agent atoms), effect reactivity;
//                         pi harness context/view/session/transaction, chord
//   other                 everything else (runtime scheduling, effect fibers, promises, (program))
import { readFileSync } from "node:fs";

const [file, mapFile] = process.argv.slice(2);
const { windows, profile } = JSON.parse(readFileSync(file, "utf8"));

// ---- minimal source map lookup (VLQ) ----
const B64 = Object.fromEntries([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
function decodeMap(path) {
	const map = JSON.parse(readFileSync(path, "utf8"));
	const lines = [];
	let src = 0;
	let orig = 0;
	for (const line of map.mappings.split(";")) {
		const segs = [];
		let col = 0;
		for (const seg of line.split(",")) {
			if (!seg) continue;
			const vals = [];
			let v = 0;
			let shift = 0;
			for (const ch of seg) {
				const d = B64[ch];
				v += (d & 31) << shift;
				if (d & 32) shift += 5;
				else {
					vals.push(v & 1 ? -(v >> 1) : v >> 1);
					v = 0;
					shift = 0;
				}
			}
			col += vals[0];
			if (vals.length > 1) {
				src += vals[1];
				orig += vals[2];
			}
			segs.push([col, src, orig]);
		}
		lines.push(segs);
	}
	return { lines, sources: map.sources };
}
const sm = mapFile ? decodeMap(mapFile) : undefined;
const sourceOf = (cf) => {
	if (sm && /node(-head)?\.mjs$/.test(cf.url)) {
		const segs = sm.lines[cf.lineNumber];
		let best;
		for (const s of segs ?? []) {
			if (s[0] <= cf.columnNumber) best = s;
			else break;
		}
		if (best) return { src: sm.sources[best[1]], line: best[2] + 1 };
	}
	return { src: cf.url, line: cf.lineNumber + 1 };
};

// ---- samples ----
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
let t = profile.startTime;
const inWindow = (ts) => windows.some(([a, b]) => ts >= a && ts <= b);
const aligned = windows.length > 0 && windows[0][0] >= profile.startTime - 1e6 && windows.at(-1)[1] <= profile.endTime + 1e6;
const frameCache = new Map();
const frame = (id) => {
	let f = frameCache.get(id);
	if (!f) {
		const cf = byId.get(id).callFrame;
		const where = sourceOf(cf);
		f = { fn: cf.functionName || "(anonymous)", src: where.src.replace(/^.*node_modules\//, ""), line: where.line };
		frameCache.set(id, f);
	}
	return f;
};
const rules = [
	["hashing", (f) => /input-digest|core\/services\/checkpoint\.ts/.test(f.src) && /digest|hash/i.test(f.fn) || /^node:crypto|internal\/crypto/.test(f.src) || /sha256|createHash|digest/i.test(f.fn) && f.src === ""],
	["checkpoint", (f) => /checkpoint-chunks|core\/services\/checkpoint\.ts/.test(f.src) || (/core\/runtime\/replay\.ts/.test(f.src) && /checkpoint/i.test(f.fn))],
	["storage read/parse", (f) => /(pi-durable\/(dist|src)|packages\/durable\/src)\/storage\/|sql-journal|effect\/(dist|src)\/unstable\/sql|sqlite-node\.ts|sqlite-bun\.ts|node:sqlite/.test(f.src)],
	["model/tool fake", (f) => /src\/(pi|tardie)\/agent\.ts/.test(f.src) && /fake|stream|textParts|split|decide|lastOf|echo|textOf/i.test(f.fn) || /src\/common\.ts/.test(f.src)],
];
const jsonLeaf = (f) => (f.src === "" && /^(parse|stringify|structuredClone|JSONParse|JSONStringify)$/.test(f.fn)) || /validat/i.test(f.fn) || /effect\/(dist|src)\/(Schema|SchemaAST|SchemaParser|internal\/schema)|typebox|incremental\/validate|validateToolArguments/.test(f.src);
const derivation = (f) => /tardie\/src\/(core|agent)\/|effect\/(dist|src)\/unstable\/reactivity|(pi-durable\/(dist|src)|packages\/durable\/src)\/(harness|session|documents|entries)|chord\/(dist|src)/.test(f.src);

const totals = {};
const self = new Map();
let kept = 0;
let all = 0;
for (let i = 0; i < profile.samples.length; i++) {
	t += profile.timeDeltas[i] ?? 0;
	const dt = profile.timeDeltas[i + 1] ?? 0;
	const id = profile.samples[i];
	const leaf = frame(id);
	if (leaf.fn === "(idle)") continue;
	all += dt;
	if (aligned && !inWindow(t)) continue;
	kept += dt;
	const stack = [];
	for (let n = id; n !== undefined; n = parent.get(n)) stack.push(frame(n));
	let cat;
	if (leaf.fn === "(garbage collector)") cat = "GC";
	for (const [name, test] of rules) {
		if (cat) break;
		if (stack.some(test)) cat = name;
	}
	if (!cat && stack.slice(0, 3).some(jsonLeaf)) cat = "JSON/validation";
	if (!cat && stack.some(derivation)) cat = "replay/derivation";
	cat ??= "other";
	totals[cat] = (totals[cat] ?? 0) + dt;
	const key = `${leaf.fn} ${leaf.src}:${leaf.line}`;
	self.set(key, (self.get(key) ?? 0) + dt);
}
const ms = (us) => Math.round(us / 10) / 100;
const order = ["storage read/parse", "JSON/validation", "replay/derivation", "checkpoint", "hashing", "GC", "model/tool fake", "other"];
console.log(
	JSON.stringify({
		aligned,
		keptMs: ms(kept),
		profiledMs: ms(all),
		categories: Object.fromEntries(order.map((k) => [k, ms(totals[k] ?? 0)])),
		top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => ({ fn: k, ms: ms(v) })),
	}),
);
