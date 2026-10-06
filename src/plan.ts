export const CYCLE = [1, 1, 0]
export const MEASURED_TOOLS = 8

export type Turn = { id: string; text: string }
export type Message = { role: "user" | "assistant" | "tool"; text: string; calls?: number[] }
export type Step = { call: number } | { answer: string }
export type Stats = { bytes: number; tables: Record<string, number>; checkpoint?: number | undefined }

export const turn = (id: string, tools: number): Turn => ({ id, text: `turn ${id} tools=${tools}` })

export const history = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => turn(`h${from + i}`, CYCLE[(from + i) % CYCLE.length]!))

export const payload = (n: number) => {
  const head = `record ${n}: `
  return head + "x".repeat((n % 97 === 0 ? 8192 : 256) - head.length)
}

export function next(context: readonly Message[]): Step {
  const last = context.findLastIndex(m => m.role === "user")
  const planned = Number(/tools=(\d+)/.exec(context[last]?.text ?? "")?.[1] ?? 0)
  const total = context.filter(m => m.role === "tool").length
  const done = context.slice(last + 1).filter(m => m.role === "tool").length
  return done < planned ? { call: total + 1 } : { answer: `done after ${done} lookups` }
}

export async function fingerprint(context: readonly Message[]) {
  const bytes = new TextEncoder().encode(JSON.stringify(context.map(m => [m.role, m.text, m.calls ?? []])))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, "0")).join("")
}
