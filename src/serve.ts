import type { Stats, Turn } from "./plan.ts"

export interface Bench {
  wake(): Promise<void>
  turn(turn: Turn): Promise<void>
  seed(turns: Turn[]): Promise<string>
  stats(): Promise<Stats>
}

export function tables(sql: SqlStorage) {
  const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").toArray()
  return Object.fromEntries(names.map(({ name }) => [name, sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).one().n]))
}

export const serve = <Env>(bench: (env: Env) => Bench, setup?: (env: Env) => Promise<void>) => ({
  async fetch(request: Request, env: Env) {
    const target = bench(env)
    const body = request.method === "POST" ? await request.json() : undefined
    switch (new URL(request.url).pathname) {
      case "/setup": return Response.json(await setup?.(env) ?? null)
      case "/wake": return Response.json(await target.wake() ?? null)
      case "/turn": return Response.json(await target.turn(body as Turn) ?? null)
      case "/seed": return Response.json(await target.seed(body as Turn[]))
      case "/stats": return Response.json(await target.stats())
      default: return new Response("not found", { status: 404 })
    }
  },
})
