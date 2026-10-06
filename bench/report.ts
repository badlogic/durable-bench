import { labels, METRICS, sizes, value } from "./results.ts"

const cell = (v: number | undefined, unit: string) => v === undefined ? "-" : `${v.toFixed(unit === "MB" ? 2 : 0)} ${unit}`

console.log(`| turns | ${METRICS.flatMap(m => labels.map(l => `${l} ${m.name}`)).join(" | ")} |`)
console.log(`|---:|${METRICS.flatMap(() => labels.map(() => "---:")).join("|")}|`)
for (const turns of sizes) console.log(`| ${turns.toLocaleString()} | ${METRICS.flatMap(m => labels.map(l => cell(value(m, l, turns), m.unit))).join(" | ")} |`)
