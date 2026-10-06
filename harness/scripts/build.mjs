// Bundle the Node entry (tardie ships TypeScript with parameter properties, which Node's type stripping rejects;
// pi ships JS). All systems go through the same bundler, so cold start compares like with like.
//   node scripts/build.mjs   → dist/node.mjs (npm: tardie 0.44.0 + pi-durable 1.0.4)
//                              dist/node-head.mjs (pi packages from the checkout in $PI_HEAD_DIR, default work/pi-head)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { piHeadPlugin, piHeadSha } from "./pi-head.mjs";

const common = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	sourcemap: "linked",
	logLevel: "warning",
	// package.json "sideEffects" lists dist paths; the HEAD bundle maps them to src, so annotations are ignored in every
	// bundle alike rather than risk dropping side-effect imports.
	ignoreAnnotations: true,
	// CommonJS deps inside an ESM bundle need require().
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
	entryPoints: ["src/entry-node.ts"],
};
await build({ ...common, outfile: "dist/node.mjs" });
console.log("built dist/node.mjs");
const piDir = resolve(process.env.PI_HEAD_DIR ?? "work/pi-head");
if (existsSync(`${piDir}/packages/durable`)) {
	const head = piHeadPlugin(piDir);
	await build({
		...common,
		outfile: "dist/node-head.mjs",
		plugins: [head.plugin],
		// Fallback for a checkout without node_modules (local smoke only); CI installs the checkout's own dependencies.
		nodePaths: [resolve("node_modules")],
		define: { "globalThis.__BENCH_PI_HEAD__": JSON.stringify(piHeadSha()) },
	});
	if (!head.resolved.has("@earendil-works/pi-durable")) throw new Error("pi-head: pi-durable was not taken from the checkout");
	console.log(`built dist/node-head.mjs from ${piDir} (${[...head.resolved].join(", ")})`);
} else console.log(`skipped dist/node-head.mjs: no pi checkout at ${piDir} (run scripts/fetch-pi-head.sh)`);
