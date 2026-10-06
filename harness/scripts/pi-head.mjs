// Resolve @earendil-works/* imports to the TypeScript sources of a pi git checkout (Pi Durable HEAD), for esbuild and
// Bun.build (same onResolve shape). Uses each package's `source` export condition; exports without one (pi-ai's
// `./utils/*`, `./models`, ...) are mapped from dist/*.js to src/*.ts. Third-party imports inside the checkout resolve
// from the checkout's own node_modules (installed with `npm ci --ignore-scripts`). The pi repo's build/test scripts
// are never run.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const piHeadSha = () => readFileSync(new URL("../pi-head.sha", import.meta.url), "utf8").trim();

export function piHeadPlugin(piDir) {
	const packages = new Map();
	for (const dir of readdirSync(join(piDir, "packages"))) {
		const file = join(piDir, "packages", dir, "package.json");
		if (!existsSync(file)) continue;
		const json = JSON.parse(readFileSync(file, "utf8"));
		packages.set(json.name, { dir: join(piDir, "packages", dir), exports: json.exports ?? {} });
	}
	const resolved = new Set();
	const resolveSpecifier = (spec) => {
		const m = /^(@earendil-works\/[^/]+)(?:\/(.+))?$/.exec(spec);
		const pkg = m && packages.get(m[1]);
		if (!pkg) return undefined;
		const key = m[2] ? `./${m[2]}` : ".";
		let target = pkg.exports[key];
		let star;
		if (target === undefined)
			for (const [pattern, value] of Object.entries(pkg.exports)) {
				if (!pattern.includes("*")) continue;
				const [pre, post] = pattern.split("*");
				if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length) {
					star = key.slice(pre.length, key.length - post.length);
					target = value;
					break;
				}
			}
		if (target === undefined) throw new Error(`pi-head: ${spec} is not exported by ${m[1]}`);
		let file = typeof target === "string" ? target : (target.source ?? target.import ?? target.default);
		if (star !== undefined) file = file.replace("*", star);
		if (typeof target === "string" || target.source === undefined) file = file.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts");
		const path = join(pkg.dir, file);
		if (!existsSync(path)) throw new Error(`pi-head: ${spec} → ${path} does not exist`);
		resolved.add(m[1]);
		return path;
	};
	return {
		/** Names of the pi packages the bundle took from the checkout. */
		resolved,
		plugin: {
			name: "pi-head",
			setup(build) {
				build.onResolve({ filter: /^@earendil-works\// }, (args) => {
					const path = resolveSpecifier(args.path);
					return path === undefined ? undefined : { path };
				});
			},
		},
	};
}
