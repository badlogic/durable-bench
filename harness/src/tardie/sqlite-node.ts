// node:sqlite port of @effect/sql-sqlite-bun@4.0.0-rc.115 SqliteClient (the client tardie's Bun platform uses).
// Same structure: one connection behind a semaphore, BEGIN IMMEDIATE transactions, busy_timeout 5 s, WAL, a prepared
// statement cache keyed by SQL text (bun's db.query() caches the same way). Only the driver differs.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { Context, Effect, Fiber, Layer, Scope, Semaphore, Stream } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const classifyError = (cause: unknown, message: string, operation: string) => classifySqliteError(cause, { message, operation });

export interface NodeSqliteClientConfig {
	readonly filename: string;
}

const make = (options: NodeSqliteClientConfig) =>
	Effect.gen(function* () {
		const compiler = Statement.makeCompilerSqlite();
		const db = new DatabaseSync(options.filename, { timeout: 5000 });
		yield* Effect.addFinalizer(() => Effect.sync(() => db.close()));
		db.exec("PRAGMA journal_mode = WAL;");
		const cache = new Map<string, StatementSync>();
		const prepare = (sql: string, useSafeIntegers: boolean) => {
			let statement = cache.get(sql);
			if (!statement) {
				statement = db.prepare(sql);
				cache.set(sql, statement);
			}
			statement.setReadBigInts(useSafeIntegers);
			return statement;
		};
		const run = (sql: string, params: ReadonlyArray<unknown> = [], arrays = false) =>
			Effect.withFiber<Array<any>, SqlError>((fiber) => {
				const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers);
				try {
					const statement = prepare(sql, useSafeIntegers);
					statement.setReturnArrays(arrays);
					return Effect.succeed(statement.all(...(params as never[])) as Array<any>);
				} catch (cause) {
					return Effect.fail(new SqlError({ reason: classifyError(cause, "Failed to execute statement", arrays ? "executeValues" : "execute") }));
				}
			});
		const connection: Connection = {
			execute(sql, params, transformRows) {
				return transformRows ? Effect.map(run(sql, params), transformRows) : run(sql, params);
			},
			executeRaw(sql, params) {
				return run(sql, params);
			},
			executeValues(sql, params) {
				return run(sql, params, true);
			},
			executeValuesUnprepared(sql, params) {
				return run(sql, params, true);
			},
			executeUnprepared(sql, params, transformRows) {
				return this.execute(sql, params, transformRows);
			},
			executeStream() {
				return Stream.die("executeStream not implemented");
			},
		};
		const semaphore = yield* Semaphore.make(1);
		const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
		const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
			const fiber = Fiber.getCurrent()!;
			const scope = Context.getUnsafe(fiber.context, Scope.Scope);
			return Effect.as(
				Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
				connection,
			);
		});
		return yield* Client.make({
			acquirer,
			compiler,
			transactionAcquirer,
			beginTransaction: "BEGIN IMMEDIATE",
			spanAttributes: [["db.system.name", "sqlite"]],
		});
	});

export const layer = (config: NodeSqliteClientConfig): Layer.Layer<Client.SqlClient> =>
	Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
