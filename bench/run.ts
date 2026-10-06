import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import { MEASURED_TOOLS, turn, type Stats } from "../src/plan.ts"
import { call, CPU_MAX, fixture, MEASURED_TURNS, prepare, quiet, rss, SAMPLES, SIZES, start, target, TARGETS } from "./targets.ts"

const name = target(process.argv[2])
const sizes = process.argv.length > 3 ? process.argv.slice(3).map(Number) : SIZES
const samples = Number(process.env.SAMPLES ?? SAMPLES)
const cpuMax = Number(process.env.CPU_MAX ?? CPU_MAX)

await prepare(name)
mkdirSync("results", { recursive: true })

for (const size of sizes) {
  for (let sample = 0; sample < samples; sample++) {
    const dir = mkdtempSync(join(tmpdir(), "durable-bench-"))
    cpSync(fixture(name, size), dir, { recursive: true })
    const cpu = await quiet(cpuMax)
    const load = loadavg()[0]
    let at = performance.now()
    const mf = await start(name, dir)
    const startup = performance.now() - at
    at = performance.now()
    await call(mf, "/wake")
    const open = performance.now() - at
    const turns: number[] = []
    for (let i = 0; i < MEASURED_TURNS; i++) {
      at = performance.now()
      await call(mf, "/turn", turn(`m${i}`, MEASURED_TOOLS))
      turns.push(performance.now() - at)
    }
    const memory = rss()
    const stats = await call<Stats>(mf, "/stats")
    await mf.dispose()
    rmSync(dir, { recursive: true, force: true })
    const line = { target: name, version: TARGETS[name].version, turns: size, sample, startup, open, turn: turns, rss: memory, ...stats, cpu, load, at: new Date().toISOString() }
    appendFileSync("results/results.jsonl", JSON.stringify(line) + "\n")
    process.stderr.write(`${name} ${size} #${sample} open ${open.toFixed(0)}ms turn ${turns.map(t => t.toFixed(0)).join(",")}ms\n`)
  }
}
