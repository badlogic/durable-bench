// Node entry: tardie's own sqlJournal over a node:sqlite port of its Bun SqlClient; pi's published Node SQLite storage.
import { DatabaseSync } from "node:sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { sqlJournal } from "../node_modules/tardie/src/platform/shared/sql-journal.ts";
import { main } from "./cli.ts";
import type { Platform } from "./driver.ts";
import { openPi } from "./pi/agent.ts";
import { readRecords } from "./records.ts";
import { openTardie, withNormalSync } from "./tardie/agent.ts";
import { layer } from "./tardie/sqlite-node.ts";

const platform: Platform = {
	async open(system, file, options) {
		if (system === "tardie") {
			return openTardie((filename) => sqlJournal({ actor: "events", layer: withNormalSync(layer({ filename })) }) as never, file, options);
		}
		return openPi(await openNodeSqliteStorage(file), options);
	},
	records: (system, file) =>
		readRecords(
			(f, sql) => {
				const db = new DatabaseSync(f, { readOnly: true });
				try {
					return db.prepare(sql).get() as Record<string, unknown> | undefined;
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
