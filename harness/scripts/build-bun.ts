// Bundle the Bun entry with Bun's bundler (tardie's home runtime) → dist/bun-entry.js, and dist/bun-head.js with the
// pi packages from the checkout in $PI_HEAD_DIR (see scripts/pi-head.mjs).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { piHeadPlugin, piHeadSha } from "./pi-head.mjs";

const piDir = resolve(process.env.PI_HEAD_DIR ?? "work/pi-head");
const head = existsSync(`${piDir}/packages/durable`) ? piHeadPlugin(piDir) : undefined;
for (const [naming, plugin] of [
	["bun-entry.js", undefined],
	["bun-head.js", head?.plugin],
] as const) {
	if (naming === "bun-head.js" && !plugin) {
		console.log(`skipped dist/bun-head.js: no pi checkout at ${piDir}`);
		continue;
	}
	const result = await Bun.build({
		entrypoints: ["src/entry-bun.ts"],
		target: "bun",
		outdir: "dist",
		naming,
		sourcemap: "linked",
		ignoreDCEAnnotations: true,
		plugins: (plugin ? [plugin] : []) as never,
		...(plugin ? { define: { "globalThis.__BENCH_PI_HEAD__": JSON.stringify(piHeadSha()) } } : {}),
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	if (!existsSync(`dist/${naming}`)) throw new Error(`unexpected outputs: ${result.outputs.map((o) => o.path).join(", ")}`);
	if (plugin && !head?.resolved.has("@earendil-works/pi-durable")) throw new Error("pi-head: pi-durable was not taken from the checkout");
	console.log(`built dist/${naming}`);
}
