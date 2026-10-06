// bun:sqlite facade for pi-durable's portable SqliteStorage core. A line-by-line mirror of the published
// Node adapter (@earendil-works/pi-durable/storage/sqlite/node): serial operation queue, statement cache by SQL
// text, BEGIN IMMEDIATE transactions, WAL + synchronous=NORMAL + wal_autocheckpoint=1000, busy timeout 5 s,
// wal_checkpoint(TRUNCATE) on close.
import { Database, type Statement } from "bun:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

const ignore = () => {};
class SerialOperationQueue {
	tail: Promise<unknown> = Promise.resolve();
	pending = 0;
	run<T>(operation: () => T): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		try {
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error);
		}
	}
	runAsync<T>(operation: () => Promise<T>): Promise<T> {
		if (this.pending > 0) return this.enqueue(operation);
		this.pending++;
		const { promise: barrier, resolve: releaseBarrier } = Promise.withResolvers<void>();
		this.tail = barrier;
		let started: Promise<T>;
		try {
			started = operation();
		} catch (error) {
			started = Promise.reject(error);
		}
		return started.finally(() => {
			this.pending--;
			releaseBarrier();
		});
	}
	enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
		this.pending++;
		return this.release(this.tail.then(operation));
	}
	release<T>(operation: Promise<T>): Promise<T> {
		const settled = operation.finally(() => {
			this.pending--;
		});
		this.tail = settled.then(ignore, ignore);
		return settled;
	}
}

abstract class BunSqliteExecutor implements SqliteExecutor {
	protected readonly database: Database;
	protected readonly statements: Map<string, Statement>;
	constructor(database: Database, statements: Map<string, Statement>) {
		this.database = database;
		this.statements = statements;
	}
	exec(sql: string): Promise<void> {
		return this.runOperation(() => {
			this.database.exec(sql);
		});
	}
	run(sql: string, ...params: SqliteValue[]): Promise<void> {
		return this.runOperation(() => {
			this.statement(sql).run(...(params as never[]));
		});
	}
	get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.runOperation(() => (this.statement(sql).get(...(params as never[])) ?? undefined) as T | undefined);
	}
	all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.runOperation(() => this.statement(sql).all(...(params as never[])) as T[]);
	}
	protected abstract runOperation<T>(operation: () => T): Promise<T>;
	private statement(sql: string): Statement {
		let statement = this.statements.get(sql);
		if (statement === undefined) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
}

class BunSqliteTransaction extends BunSqliteExecutor {
	private readonly scope: { active: boolean };
	constructor(database: Database, statements: Map<string, Statement>, scope: { active: boolean }) {
		super(database, statements);
		this.scope = scope;
	}
	protected async runOperation<T>(operation: () => T): Promise<T> {
		if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
		return operation();
	}
}

export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
	private readonly access = new SerialOperationQueue();
	private closed = false;
	constructor(database: Database) {
		super(database, new Map());
	}
	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.access.runAsync(async () => {
			this.database.exec("BEGIN IMMEDIATE");
			const scope = { active: true };
			try {
				const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
				scope.active = false;
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				scope.active = false;
				try {
					this.database.exec("ROLLBACK");
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed");
				}
				throw error;
			}
		});
	}
	close(): Promise<void> {
		return this.access.run(() => {
			if (this.closed) return;
			this.closed = true;
			for (const statement of this.statements.values()) statement.finalize();
			this.statements.clear();
			try {
				this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				this.database.close();
			}
		});
	}
	protected runOperation<T>(operation: () => T): Promise<T> {
		return this.access.run(operation);
	}
}

export async function openBunSqliteStorage(path: string): Promise<SqliteStorage> {
	const database = new Database(path, { create: true });
	database.exec("PRAGMA busy_timeout = 5000");
	const adapter = new BunSqliteDatabase(database);
	await adapter.exec("PRAGMA journal_mode = WAL");
	await adapter.exec("PRAGMA synchronous = NORMAL");
	await adapter.exec("PRAGMA wal_autocheckpoint = 1000");
	return SqliteStorage.open(adapter);
}
