import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { build, type Plugin } from "esbuild"
import { Miniflare } from "miniflare"

export const SIZES = [50, 250, 1000, 3500]
export const MEASURED_TURNS = 10
export const SAMPLES = 3
export const CPU_MAX = 0.08
export const CPU_WINDOW_MS = 1000

const version = (name: string) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version as string

// A pi checkout to build pi-durable, pi-ai, and chord from source for the "pi-head" target.
const PI_SOURCE = process.env.PI_SOURCE ?? "../pi"

export const TARGETS = {
  pi: { entry: "src/pi.ts", objects: { PI: "PiDO" }, version: version("@earendil-works/pi-durable") },
  "pi-head": { entry: "src/pi-head.ts", objects: { PI: "PiDO" }, version: process.env.PI_HEAD_VERSION ?? "head" },
  tardie: { entry: "src/tardie.ts", objects: { ACTORS: "ActorDO", THREADS: "ThreadDO" }, version: version("tardie") },
}

// Resolves @earendil-works packages to the TypeScript sources of the pi checkout through their export maps.
const fromSource: Plugin = {
  name: "pi-source",
  setup(b) {
    const dirs: Record<string, string> = { "pi-durable": "durable", "pi-ai": "ai", chord: "chord" }
    b.onResolve({ filter: /^@earendil-works\/(pi-durable|pi-ai|chord)(\/.*)?$/ }, args => {
      const [, pkg, sub = ""] = /^@earendil-works\/([^/]+)(\/.*)?$/.exec(args.path)!
      const root = join(process.cwd(), PI_SOURCE, "packages", dirs[pkg!]!)
      const exports = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports as Record<string, unknown>
      const key = "." + sub
      let entry = exports[key]
      let star = ""
      if (entry === undefined) {
        const pattern = Object.keys(exports).find(k => k.endsWith("*") && key.startsWith(k.slice(0, -1)))
        if (!pattern) throw new Error("No export " + key + " in " + pkg)
        star = key.slice(pattern.length - 1)
        entry = exports[pattern]
      }
      const conditions = entry as { source?: string; import?: string }
      const target = typeof entry === "string" ? entry : (conditions.source ?? conditions.import!)
      const file = target.replace("*", star).replace(/^\.\/dist\/(.*)\.js$/, "./src/$1.ts")
      return { path: join(root, file) }
    })
  },
}

export type Target = keyof typeof TARGETS

export const target = (name: string | undefined) => {
  if (!name || !(name in TARGETS)) throw new Error(`target: ${Object.keys(TARGETS).join(" | ")}`)
  return name as Target
}

export const fixture = (name: Target, turns: number) => `fixtures/${name}-${turns}`

export function stage(name: Target, turns: number) {
  const dir = mkdtempSync(join(tmpdir(), "durable-bench-"))
  cpSync(fixture(name, turns), dir, { recursive: true })
  for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) if (file.isFile()) readFileSync(join(file.parentPath, file.name))
  return dir
}

const bundles = new Map<Target, Promise<string>>()

const bundle = (name: Target) => bundles.get(name) ?? bundles.set(name, (async () => {
  const outfile = `dist/${name}.mjs`
  await build({
    entryPoints: [TARGETS[name].entry], outfile, bundle: true, format: "esm", platform: "neutral", target: "es2024",
    conditions: ["workerd", "worker", "browser", "import"], mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*", ...builtinModules], logLevel: "error",
    plugins: name === "pi-head" ? [fromSource] : [],
  })
  return outfile
})()).get(name)!

export async function prepare(name: Target) {
  await bundle(name)
}

export async function start(name: Target, persist: string) {
  const mf = new Miniflare({
    modules: [{ type: "ESModule", path: await bundle(name) }],
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: Object.fromEntries(Object.entries(TARGETS[name].objects).map(([binding, className]) => [binding, { className, useSQLite: true }])),
    durableObjectsPersist: persist,
    handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
      stdout.on("data", chunk => process.stdout.write(chunk))
      createInterface({ input: stderr }).on("line", line => { if (!line.includes("NOSENTRY")) process.stderr.write(`${line}\n`) })
    },
  })
  await mf.ready
  return mf
}

export async function call<T = unknown>(mf: Miniflare, path: string, body?: unknown): Promise<T> {
  const response = await mf.dispatchFetch(`http://bench${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} ${response.status}: ${await response.text()}`)
  return await response.json() as T
}

const ticks = () => cpus().reduce((sum, { times }) => {
  const total = times.user + times.nice + times.sys + times.irq + times.idle
  return { busy: sum.busy + total - times.idle, total: sum.total + total }
}, { busy: 0, total: 0 })

export async function busy(windowMs = CPU_WINDOW_MS) {
  const before = ticks()
  await sleep(windowMs)
  const after = ticks()
  return (after.busy - before.busy) / (after.total - before.total)
}

export async function quiet(max = CPU_MAX) {
  for (;;) {
    const value = await busy()
    if (value <= max) return value
    process.stderr.write(`cpu ${(value * 100).toFixed(0)}% > ${(max * 100).toFixed(0)}%, waiting\n`)
  }
}

export function rss() {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
  const tree = new Set([process.pid])
  for (let grew = true; grew;) {
    grew = false
    for (const [pid, ppid] of rows) if (tree.has(ppid!) && !tree.has(pid!)) { tree.add(pid!); grew = true }
  }
  return rows.filter(([pid]) => pid !== process.pid && tree.has(pid!)).reduce((sum, [, , kb]) => sum + kb!, 0) / 1024
}
