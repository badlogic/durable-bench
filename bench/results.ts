import { readFileSync } from "node:fs"

export type Line = { target: string; version: string; turns: number; open: number; turn: number[]; bytes: number }
export type Metric = { name: string; unit: string; of: (group: Line[]) => number }

export const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export const lines = readFileSync("results/results.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line) as Line)
export const label = (line: Line) => `${line.target} ${line.version}`
export const labels = [...new Set(lines.map(label))].sort()
export const sizes = [...new Set(lines.map(l => l.turns))].sort((a, b) => a - b)

export const METRICS: Metric[] = [
  { name: "cold", unit: "ms", of: g => median(g.map(l => l.open + l.turn[0]!)) },
  { name: "warm", unit: "ms", of: g => median(g.flatMap(l => l.turn.slice(1))) },
  { name: "storage", unit: "MB", of: g => median(g.map(l => l.bytes)) / 1e6 },
]

export const value = (metric: Metric, target: string, turns: number) => {
  const group = lines.filter(l => label(l) === target && l.turns === turns)
  return group.length ? metric.of(group) : undefined
}
