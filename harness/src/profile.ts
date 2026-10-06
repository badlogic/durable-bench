// Node-only CPU profiling of measured windows. Writes {profile, windows} where windows are [startUs, endUs] on V8's
// monotonic clock (process.hrtime and V8 TimeTicks both use CLOCK_MONOTONIC on Linux), so the summarizer keeps only
// samples inside the measured windows (no open/replay/warmup).
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

export async function profileWindows(outFile: string, runs: number, iteration: (mark: { start: () => void; end: () => void }) => Promise<void>) {
	const session = new Session();
	session.connect();
	await session.post("Profiler.enable");
	await session.post("Profiler.setSamplingInterval", { interval: 200 });
	const windows: [number, number][] = [];
	let open: number | undefined;
	const mark = {
		start: () => {
			open = nowUs();
		},
		end: () => {
			if (open !== undefined) windows.push([open, nowUs()]);
			open = undefined;
		},
	};
	await session.post("Profiler.start");
	const t0 = performance.now();
	for (let i = 0; i < runs; i++) await iteration(mark);
	const wallMs = performance.now() - t0;
	const { profile } = await session.post("Profiler.stop");
	session.disconnect();
	writeFileSync(outFile, JSON.stringify({ windows, profile }));
	const windowMs = windows.reduce((s, [a, b]) => s + (b - a), 0) / 1000;
	return { runs, wallMs, windowMs, file: outFile.split("/").pop() };
}
