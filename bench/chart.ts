import { writeFileSync } from "node:fs"
import { labels, METRICS, sizes, value, type Metric } from "./results.ts"

const W = 1200
const H = 860
const PANEL = { w: 600, h: 400, top: 60 }
const PAD = { left: 64, right: 32, top: 52, bottom: 48 }
const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#8a8984", grid: "#e8e7e4", surface: "#fcfcfb" }
const SERIES = ["#2a78d6", "#eb6834"]
const NAMES: Record<string, string> = { pi: "pi-durable", tardie: "tardie" }

const name = (label: string) => `${NAMES[label.split(" ")[0]!] ?? label.split(" ")[0]} ${label.split(" ")[1]}`
const fmt = (n: number) => Math.round(n).toLocaleString("en-US")
const text = (x: number, y: number, body: string, attrs = "") => `<text x="${x}" y="${y}" ${attrs}>${body}</text>`

function niceMax(max: number) {
  const step = 10 ** Math.floor(Math.log10(max / 4))
  const unit = [1, 2, 2.5, 5, 10].map(m => m * step).find(s => s * 4 >= max)!
  return { max: unit * Math.ceil(max / unit), step: unit }
}

function frame(x: number, y: number, title: string, max: number) {
  const inner = { x: x + PAD.left, y: y + PAD.top, w: PANEL.w - PAD.left - PAD.right, h: PANEL.h - PAD.top - PAD.bottom }
  const scale = niceMax(max)
  const sy = (v: number) => inner.y + inner.h - (v / scale.max) * inner.h
  const ticks = Array.from({ length: Math.round(scale.max / scale.step) + 1 }, (_, i) => i * scale.step)
  const svg = [
    text(x + PAD.left, y + 24, title, `font-size="17" font-weight="600" fill="${INK.primary}"`),
    ...ticks.map(t => `<line x1="${inner.x}" x2="${inner.x + inner.w}" y1="${sy(t)}" y2="${sy(t)}" stroke="${t ? INK.grid : INK.muted}" stroke-width="1"/>`
      + text(inner.x - 10, sy(t) + 4, fmt(t), `font-size="12" text-anchor="end" fill="${INK.muted}"`)),
    text(inner.x + inner.w / 2, inner.y + inner.h + 40, "turns of history", `font-size="12" text-anchor="middle" fill="${INK.muted}"`),
  ]
  return { inner, sy, svg }
}

function bars(x: number, y: number, metric: Metric) {
  const values = sizes.map(s => labels.map(l => value(metric, l, s) ?? 0))
  const { inner, sy, svg } = frame(x, y, `${metric.name[0]!.toUpperCase()}${metric.name.slice(1)} turn (ms)`, Math.max(...values.flat()))
  const group = inner.w / sizes.length
  const width = 36
  sizes.forEach((size, i) => {
    const center = inner.x + group * (i + 0.5)
    svg.push(text(center, inner.y + inner.h + 20, size.toLocaleString("en-US"), `font-size="13" text-anchor="middle" fill="${INK.secondary}"`))
    values[i]!.forEach((v, j) => {
      const bx = center - width - 1 + j * (width + 2)
      const top = sy(v)
      const r = Math.min(4, inner.y + inner.h - top)
      svg.push(`<path d="M${bx},${inner.y + inner.h} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + width - r} Q${bx + width},${top} ${bx + width},${top + r} V${inner.y + inner.h} Z" fill="${SERIES[j]}"/>`)
      svg.push(text(bx + width / 2, top - 6, fmt(v), `font-size="12" text-anchor="middle" fill="${INK.secondary}"`))
    })
  })
  return svg
}

function trend(x: number, y: number, metric: Metric) {
  const series = labels.map(l => sizes.map(s => value(metric, l, s) ?? 0))
  const { inner, sy, svg } = frame(x, y, `${metric.name[0]!.toUpperCase()}${metric.name.slice(1)} turn vs history (ms)`, Math.max(...series.flat()))
  const right = inner.w - 96
  const sx = (turns: number) => inner.x + (turns / sizes.at(-1)!) * right
  const step = niceMax(sizes.at(-1)!).step
  for (let size = 0; size <= sizes.at(-1)!; size += step) svg.push(text(sx(size), inner.y + inner.h + 20, size.toLocaleString("en-US"), `font-size="13" text-anchor="middle" fill="${INK.secondary}"`))
  series.forEach((points, j) => {
    const xy = points.map((v, i) => [sx(sizes[i]!), sy(v)] as const)
    svg.push(`<polyline points="${xy.map(p => p.join(",")).join(" ")}" fill="none" stroke="${SERIES[j]}" stroke-width="2" stroke-linejoin="round"/>`)
    for (const [px, py] of xy) svg.push(`<circle cx="${px}" cy="${py}" r="5" fill="${SERIES[j]}" stroke="${INK.surface}" stroke-width="2"/>`)
    const [lx, ly] = xy.at(-1)!
    svg.push(text(lx + 12, ly + 4, `${name(labels[j]!).split(" ")[0]} ${fmt(points.at(-1)!)}`, `font-size="13" fill="${INK.secondary}"`))
  })
  return svg
}

const [cold, warm] = METRICS
const legend = labels.map((l, j) => `<rect x="${PAD.left + j * 200}" y="22" width="14" height="14" rx="3" fill="${SERIES[j]}"/>` + text(PAD.left + 22 + j * 200, 34, name(l), `font-size="14" fill="${INK.primary}"`))

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, -apple-system, system-ui, sans-serif">
<rect width="${W}" height="${H}" fill="${INK.surface}"/>
${[...legend, ...bars(0, PANEL.top, cold!), ...bars(PANEL.w, PANEL.top, warm!), ...trend(0, PANEL.top + PANEL.h, cold!), ...trend(PANEL.w, PANEL.top + PANEL.h, warm!)].join("\n")}
</svg>
`

writeFileSync("results/chart.svg", svg)
console.log("results/chart.svg")
