import { readFileSync } from "node:fs"

type Line = { target: string; version: string; turns: number; open: number; turn: number[]; bytes: number }

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const lines = readFileSync("results/results.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line) as Line)
const labels = [...new Set(lines.map(l => `${l.target} ${l.version}`))].sort()
const sizes = [...new Set(lines.map(l => l.turns))].sort((a, b) => a - b)
const cell = (label: string, turns: number, metric: (group: Line[]) => number, unit: string) => {
  const group = lines.filter(l => `${l.target} ${l.version}` === label && l.turns === turns)
  return group.length ? `${metric(group).toFixed(unit === "MB" ? 2 : 0)} ${unit}` : "-"
}

const metrics: [string, (group: Line[]) => number, string][] = [
  ["cold", g => median(g.map(l => l.open + l.turn[0]!)), "ms"],
  ["warm", g => median(g.flatMap(l => l.turn.slice(1))), "ms"],
  ["storage", g => median(g.map(l => l.bytes)) / 1e6, "MB"],
]

console.log(`| turns | ${metrics.flatMap(([m]) => labels.map(l => `${l} ${m}`)).join(" | ")} |`)
console.log(`|---:|${metrics.flatMap(() => labels.map(() => "---:")).join("|")}|`)
for (const turns of sizes) console.log(`| ${turns.toLocaleString()} | ${metrics.flatMap(([, metric, unit]) => labels.map(l => cell(l, turns, metric, unit))).join(" | ")} |`)
