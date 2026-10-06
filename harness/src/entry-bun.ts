// Bun entry: tardie's official Bun platform journal (sqlJournal + @effect/sql-sqlite-bun, as bunJournal() does);
// pi's portable SqliteStorage over a bun:sqlite facade that mirrors pi's Node adapter.
import { Database } from "bun:sqlite";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { sqlJournal } from "tardie/platform/bun";
import { main } from "./cli.ts";
import type { Platform } from "./driver.ts";
import { openPi } from "./pi/agent.ts";
import { openBunSqliteStorage } from "./pi/sqlite-bun.ts";
import { readRecords } from "./records.ts";
import { openTardie, withNormalSync } from "./tardie/agent.ts";

const platform: Platform = {
	async open(system, file, options) {
		if (system === "tardie") {
			return openTardie((filename) => sqlJournal({ actor: "events", layer: withNormalSync(SqliteClient.layer({ filename })) }) as never, file, options);
		}
		return openPi(await openBunSqliteStorage(file), options);
	},
	records: (system, file) =>
		readRecords(
			(f, sql) => {
				const db = new Database(f, { readonly: true });
				try {
					return (db.query(sql).get() ?? undefined) as Record<string, unknown> | undefined;
				} finally {
					db.close();
				}
			},
			system,
			file,
		),
};
await main(platform, process.argv.slice(2));
process.exit(0);
