// Native record counts from a closed DB file, through a minimal runtime-specific query function.
export type Query = (file: string, sql: string) => Record<string, unknown> | undefined;

export function readRecords(query: Query, system: string, file: string): Record<string, number> {
	const num = (sql: string) => Number(Object.values(query(file, sql) ?? { v: 0 })[0] ?? 0);
	if (system === "tardie") {
		return {
			native: num("SELECT count(*) FROM experimental_events"),
			checkpointBytes: num("SELECT coalesce(max(byte_length), 0) FROM checkpoint"),
			checkpointPosition: num("SELECT coalesce(max(position), 0) FROM checkpoint"),
		};
	}
	return {
		native: num("SELECT count(*) FROM entries"),
		tasks: num("SELECT count(*) FROM tasks"),
		submissions: num("SELECT count(*) FROM submissions"),
		documentRevisions: num("SELECT count(*) FROM document_revisions"),
	};
}
