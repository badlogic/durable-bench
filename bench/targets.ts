import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import { cpus } from "node:os"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import { build } from "esbuild"
import { Miniflare } from "miniflare"

export const SIZES = [50, 250, 1000, 3500]
export const MEASURED_TURNS = 10
export const SAMPLES = 3
export const CPU_MAX = 0.08
export const CPU_WINDOW_MS = 1000

const version = (name: string) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version as string

export const TARGETS = {
  pi: { entry: "src/pi.ts", objects: { PI: "PiDO" }, version: version("@earendil-works/pi-durable") },
  tardie: { entry: "src/tardie.ts", objects: { ACTORS: "ActorDO", THREADS: "ThreadDO" }, version: version("tardie") },
}

export type Target = keyof typeof TARGETS

export const target = (name: string | undefined) => {
  if (!name || !(name in TARGETS)) throw new Error(`target: ${Object.keys(TARGETS).join(" | ")}`)
  return name as Target
}

export const fixture = (name: Target, turns: number) => `fixtures/${name}-${turns}`

const bundles = new Map<Target, Promise<string>>()

const bundle = (name: Target) => bundles.get(name) ?? bundles.set(name, (async () => {
  const outfile = `dist/${name}.mjs`
  await build({
    entryPoints: [TARGETS[name].entry], outfile, bundle: true, format: "esm", platform: "neutral", target: "es2024",
    conditions: ["workerd", "worker", "browser", "import"], mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*", ...builtinModules], logLevel: "error",
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
      stdout.pipe(process.stdout)
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
