import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTelemetryHistory } from "../scripts/lib/telemetry-history.mjs";
import { privateExportCheckouts } from "./helpers/private-export-checkouts.mjs";

const CLI = fileURLToPath(new URL("../scripts/telemetry-history.mjs", import.meta.url));
const HOUR = 3_600_000;
const owned = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const at = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function fixture({
	start = "2025-01-31T23:30:17Z",
	end = "2025-02-03T00:15:23Z",
	keep = () => true,
} = {}) {
	const from = Date.parse(start);
	const to = Date.parse(end);
	const structuralMaxRows = Math.ceil((to - from) / HOUR) + 1;
	const sqlLimit = structuralMaxRows + 1;
	// Independent capture-format fixture, not a call to the exporter's SQL validator.
	const sql = `SELECT toStartOfInterval(timestamp,INTERVAL '1' HOUR) AS bucket,sum(_sample_interval) AS weightedReports,count() AS queryRows,sumIf(_sample_interval,double1=1) AS featureReports,sum(if(double1=1,1,0)) AS featureQueryRows,min(_sample_interval) AS minSampleInterval,max(_sample_interval) AS maxSampleInterval,max(timestamp) AS latestEventAt,max(if(double1=1,timestamp,toDateTime('1970-01-01 00:00:00'))) AS latestFeatureAt FROM openclaw_telemetry WHERE timestamp>=toDateTime('${at(from)}') AND timestamp<toDateTime('${at(to)}') GROUP BY bucket ORDER BY bucket LIMIT ${sqlLimit} FORMAT JSON`;
	const meta = [
		{ name: "bucket", type: "DateTime" },
		{ name: "weightedReports", type: "UInt64" },
		{ name: "queryRows", type: "UInt64" },
		{ name: "featureReports", type: "UInt64" },
		{ name: "featureQueryRows", type: "UInt64" },
		{ name: "minSampleInterval", type: "UInt32" },
		{ name: "maxSampleInterval", type: "UInt32" },
		{ name: "latestEventAt", type: "DateTime" },
		{ name: "latestFeatureAt", type: "DateTime" },
	];
	const data = [];
	for (let ms = Math.floor(from / HOUR) * HOUR; ms < to; ms += HOUR) {
		if (!keep(at(ms))) continue;
		data.push({
			bucket: at(ms),
			weightedReports: "2",
			queryRows: "1",
			featureReports: "0",
			featureQueryRows: "0",
			minSampleInterval: 2,
			maxSampleInterval: 2,
			latestEventAt: at(Math.min(ms + HOUR, to) - 1000),
			latestFeatureAt: "1970-01-01 00:00:00",
		});
	}
	return {
		plan: {
			captureStartedAt: new Date(to + 1000).toISOString(),
			windowStartInclusive: start,
			windowEndExclusive: end,
			queries: [{ id: "q2", sql, sqlSha256: digest(sql), structuralMaxRows, sqlLimit }],
		},
		response: { meta, data, rows: data.length, rows_before_limit_at_least: data.length },
		receipt: {
			queryId: "q2",
			complete: true,
			status: 200,
			sqlSha256: digest(sql),
			receivedAt: new Date(to + 3000).toISOString(),
			wireBodyTruncated: false,
			responseRedacted: false,
			hardLimitReached: false,
			rowsReturned: data.length,
			declaredRows: data.length,
			rowsBeforeLimitAtLeast: data.length,
			meta: structuredClone(meta),
			headers: { private: "sensitive-marker" },
		},
		attempt: {
			queryId: "q2",
			ordinal: 2,
			method: "POST",
			endpointTemplate: "/client/v4/accounts/<account>/analytics_engine/sql",
			sqlSha256: digest(sql),
			requestedAt: new Date(to + 2000).toISOString(),
		},
		sqlFile: `${sql}\n`,
	};
}
function save(input = fixture()) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "telemetry-history-test-")));
	owned.push(root);
	const archive = join(root, "archive");
	mkdirSync(join(archive, "q2"), { recursive: true, mode: 0o700 });
	const response = json(input.response);
	const receipt = json({
		...input.receipt,
		wireBytesRead: Buffer.byteLength(response),
		wireSha256: digest(response),
	});
	const plan = json(input.plan);
	for (const [file, contents] of Object.entries({
		"capture-plan.json": plan,
		"q2/receipt.json": receipt,
		"q2/response.json": response,
		"q2/attempt.json": json(input.attempt),
		"q2/query.sql": input.sqlFile,
	}))
		writeFileSync(join(archive, file), contents, { flag: "wx", mode: 0o600 });
	return {
		root,
		archive,
		query: "q2",
		planSha256: digest(plan),
		receiptSha256: digest(receipt),
		output: join(root, "result"),
	};
}
const read = (files, name) => JSON.parse(readFileSync(join(files.output, name)));
function run(input = fixture()) {
	const files = save(input);
	const result = runTelemetryHistory(files);
	return {
		...result,
		daily: read(files, "daily.json").days,
		manifest: read(files, "manifest.json"),
	};
}
function cli(files, timezone = "Pacific/Honolulu") {
	return spawnSync(
		process.execPath,
		[
			CLI,
			"--archive",
			files.archive,
			"--query",
			files.query,
			"--plan-sha256",
			files.planSha256,
			"--receipt-sha256",
			files.receiptSha256,
			"--output",
			files.output,
		],
		{
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 65_536,
			env: { PATH: dirname(process.execPath), TZ: timezone },
		},
	);
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of owned.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daily report and coverage contract", () => {
	it("keeps UTC partial hours, closed days, and zero-feature epoch watermarks distinct", () => {
		const { daily, summary, manifest } = run();
		expect(
			daily.map((day) => [day.day, day.coverage, day.observedHours, day.comparisonEligible]),
		).toEqual([
			["2025-01-31", "partial_edge", 1, false],
			["2025-02-01", "complete_closed", 24, true],
			["2025-02-02", "complete_closed", 24, true],
			["2025-02-03", "partial_edge", 1, false],
		]);
		expect(daily[0].partialHours).toEqual(["2025-01-31T23:00:00.000Z"]);
		expect(daily.at(-1)).toMatchObject({
			partialHours: ["2025-02-03T00:00:00.000Z"],
			closedAtCapture: false,
			coveredEndExclusive: "2025-02-03T00:15:23.000Z",
			featureReports: "0",
			latestEventAt: "2025-02-03T00:15:22.000Z",
			latestFeatureAt: null,
		});
		expect(summary.completeClosedTotals).toEqual({
			weightedReports: "96",
			queryRows: "48",
			featureReports: "0",
			featureQueryRows: "0",
			minSampleInterval: 2,
			maxSampleInterval: 2,
			latestEventAt: "2025-02-02T23:59:59.000Z",
			latestFeatureAt: null,
		});
		expect(manifest.provenance.savedSqlRepresentation).toBe("submitted_plus_lf");
		expect(manifest.provenance.submittedSql.sha256).not.toBe(
			manifest.inputs.find((file) => file.file === "q2/query.sql").sha256,
		);
	});

	it("retains partial observed sums but excludes missing hours and never invents zero days", () => {
		const result = run(
			fixture({
				keep: (hour) => hour !== "2025-02-02 12:00:00" && !hour.startsWith("2025-02-03"),
			}),
		);
		expect(result.daily[2]).toMatchObject({
			coverage: "missing_hours",
			comparisonEligible: false,
			weightedReports: "46",
			missingHours: ["2025-02-02T12:00:00.000Z"],
		});
		expect(result.daily[3]).toMatchObject({
			coverage: "partial_edge",
			observedHours: 0,
			weightedReports: null,
			featureReports: null,
			minSampleInterval: null,
			latestEventAt: null,
			missingHours: ["2025-02-03T00:00:00.000Z"],
		});
		expect(result.summary.completeClosedTotals.weightedReports).toBe("48");
		const empty = run(fixture({ keep: () => false }));
		expect(empty.summary.completeClosedDays).toBe(0);
		expect(empty.summary.completeClosedTotals.queryRows).toBeNull();
		expect(empty.daily.every((day) => day.queryRows === null)).toBe(true);
	});

	it("preserves UInt64 inputs and larger exact daily sums without Number rounding", () => {
		const input = fixture();
		const row = input.response.data.find((row) => row.bucket === "2025-02-01 00:00:00");
		Object.assign(row, {
			weightedReports: "18446744073709551615",
			queryRows: "18446744073709551615",
			featureReports: "9007199254740993",
			featureQueryRows: "9007199254740993",
			minSampleInterval: 1,
			maxSampleInterval: 1,
			latestFeatureAt: row.latestEventAt,
		});
		const result = run(input);
		expect(result.daily[1]).toMatchObject({
			weightedReports: "18446744073709551661",
			queryRows: "18446744073709551638",
			featureReports: "9007199254740993",
			featureQueryRows: "9007199254740993",
			minSampleInterval: 1,
			maxSampleInterval: 2,
			latestFeatureAt: "2025-02-01T00:59:59.000Z",
		});
	});

	it("accepts an exact submitted SQL file and bounded three-month history", () => {
		const input = fixture({ start: "2025-01-01T00:00:00+00:00", end: "2025-04-01T00:00:00Z" });
		input.sqlFile = input.plan.queries[0].sql;
		const result = run(input);
		expect(result.summary).toMatchObject({ days: 90, completeClosedDays: 90, partialEdgeDays: 0 });
		expect(result.manifest.provenance.savedSqlRepresentation).toBe("submitted");
		expect(result.summary.completeClosedTotals.queryRows).toBe("2160");
	});
});

describe("capture validation", () => {
	it("preserves six-digit UTC capture timestamps and their exact order", () => {
		const input = fixture();
		input.plan.captureStartedAt = "2025-02-03T00:15:24.123456+00:00";
		input.attempt.requestedAt = "2025-02-03T00:15:24.123457+00:00";
		input.receipt.receivedAt = "2025-02-03T00:15:24.123458+00:00";
		const result = run(input);
		expect(result.manifest.provenance).toMatchObject({
			captureStartedAt: input.plan.captureStartedAt,
			requestedAt: input.attempt.requestedAt,
			receivedAt: input.receipt.receivedAt,
		});
		expect(result.summary.completeClosedDays).toBe(2);
	});

	it.each(["planning", "receipt"])("rejects sub-millisecond reversed %s order", (clock) => {
		const input = fixture();
		input.plan.captureStartedAt = "2025-02-03T00:15:24.123456+00:00";
		input.attempt.requestedAt = "2025-02-03T00:15:24.123457+00:00";
		input.receipt.receivedAt = "2025-02-03T00:15:24.123458+00:00";
		if (clock === "planning") input.plan.captureStartedAt = input.receipt.receivedAt;
		else input.receipt.receivedAt = input.plan.captureStartedAt;
		expect(() => run(input)).toThrow(/timestamp order/);
	});

	it("rejects sub-millisecond query bounds rather than rounding them into SQL seconds", () => {
		expect(() => run(fixture({ start: "2025-01-31T23:30:17.000001Z" }))).toThrow(/whole-second/);
	});

	it.each([
		[
			"incomplete receipt",
			(f) => {
				f.receipt.complete = false;
			},
			/complete/,
		],
		[
			"HTTP failure",
			(f) => {
				f.receipt.status = 503;
			},
			/complete/,
		],
		[
			"truncation",
			(f) => {
				f.receipt.wireBodyTruncated = true;
			},
			/complete/,
		],
		[
			"redaction",
			(f) => {
				f.receipt.responseRedacted = true;
			},
			/complete/,
		],
		[
			"hard limit",
			(f) => {
				f.receipt.hardLimitReached = true;
			},
			/complete/,
		],
		[
			"declared rows",
			(f) => {
				f.receipt.declaredRows++;
			},
			/row completeness/,
		],
		[
			"before-limit rows",
			(f) => {
				f.response.rows_before_limit_at_least++;
			},
			/row completeness/,
		],
		[
			"numeric count",
			(f) => {
				f.response.data[0].queryRows = 1;
			},
			/UInt64/,
		],
		[
			"UInt64 overflow",
			(f) => {
				f.response.data[0].weightedReports = "18446744073709551616";
			},
			/UInt64/,
		],
		[
			"noncanonical count",
			(f) => {
				f.response.data[0].weightedReports = "02";
			},
			/UInt64/,
		],
		[
			"sample overflow",
			(f) => {
				f.response.data[0].maxSampleInterval = 4294967296;
			},
			/UInt32/,
		],
		[
			"feature count mismatch",
			(f) => {
				f.response.data[0].featureReports = "1";
			},
			/same-query/,
		],
		[
			"feature sentinel mismatch",
			(f) => {
				f.response.data[0].latestFeatureAt = f.response.data[0].latestEventAt;
			},
			/feature watermark/,
		],
		[
			"event outside partial hour",
			(f) => {
				f.response.data[0].latestEventAt = "2025-01-31 23:30:16";
			},
			/event watermark/,
		],
		[
			"duplicate hour",
			(f) => {
				f.response.data[1].bucket = f.response.data[0].bucket;
			},
			/ordered, unique/,
		],
		[
			"hour at exclusive end",
			(f) => {
				f.response.data.at(-1).bucket = "2025-02-03 01:00:00";
			},
			/query window/,
		],
		[
			"wrong schema",
			(f) => {
				f.response.meta[1].type = "Float64";
			},
			/metadata schema/,
		],
		[
			"missing receipt metadata",
			(f) => {
				delete f.receipt.meta;
			},
			/metadata schema/,
		],
		[
			"changed SQL predicate",
			(f) => {
				f.plan.queries[0].sql = f.plan.queries[0].sql.replace("double1=1", "double1=0");
			},
			/audited hourly query/,
		],
		[
			"limit without headroom",
			(f) => {
				f.plan.queries[0].sqlLimit--;
			},
			/structural row/,
		],
		[
			"SQL extra space",
			(f) => {
				f.sqlFile += " ";
			},
			/saved SQL/,
		],
		[
			"SQL two LFs",
			(f) => {
				f.sqlFile += "\n";
			},
			/saved SQL/,
		],
		[
			"duplicate query",
			(f) => {
				f.plan.queries.push(f.plan.queries[0]);
			},
			/exactly once/,
		],
		[
			"local timestamp",
			(f) => {
				f.plan.windowStartInclusive = "2025-01-31T23:30:17";
			},
			/explicit UTC/,
		],
		[
			"invalid calendar date",
			(f) => {
				f.plan.windowStartInclusive = "2025-02-30T00:00:00Z";
			},
			/calendar/,
		],
		[
			"receipt before request",
			(f) => {
				f.receipt.receivedAt = f.plan.captureStartedAt;
			},
			/timestamp order/,
		],
		[
			"attempt SQL mismatch",
			(f) => {
				f.attempt.sqlSha256 = "0".repeat(64);
			},
			/provenance/,
		],
	])("rejects %s before creating output", (_name, mutate, error) => {
		const input = fixture();
		mutate(input);
		const files = save(input);
		expect(() => runTelemetryHistory(files)).toThrow(error);
		expect(existsSync(files.output)).toBe(false);
	});

	it.each(["capture-plan.json", "q2/receipt.json", "q2/response.json"])(
		"rejects changed exact bytes in %s even when the JSON is unchanged",
		(file) => {
			const files = save();
			const path = join(files.archive, file);
			writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
			expect(() => runTelemetryHistory(files)).toThrow(/digest/);
			expect(existsSync(files.output)).toBe(false);
		},
	);

	it("bounds raw bytes and windows before creating artifacts", () => {
		const files = save();
		writeFileSync(join(files.archive, "q2/response.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 32));
		expect(() => runTelemetryHistory(files)).toThrow(/byte limit/);
		expect(() =>
			run(fixture({ start: "2025-01-01T00:00:00Z", end: "2025-04-05T00:00:00Z" })),
		).toThrow(/93 days/);
	});
});

describe("offline private output and CLI", () => {
	it.each(["source", "linked"])("protects every checkout when running from %s", async (executing) => {
		const checkouts = privateExportCheckouts();
		owned.push(checkouts.root);
		const { runTelemetryHistory: runExport } = await import(
			pathToFileURL(join(checkouts[executing], "scripts/lib/telemetry-history.mjs"))
		);
		const files = save();
		for (const checkout of [
			checkouts.source, checkouts.linked,
			checkouts.source.toUpperCase(), checkouts.linked.toUpperCase(),
		].filter(existsSync)) {
			for (const parent of [checkout, join(checkout, "nested-repository")]) {
				files.output = join(parent, "results");
				expect(() => runExport(files)).toThrow(/outside telemetry source checkouts/);
				expect(existsSync(files.output)).toBe(false);
			}
		}
		for (const parent of [checkouts.root, checkouts.unrelated]) {
			files.output = join(parent, "results");
			expect(runExport(files).status).toBe("written");
			expect(runExport(files).status).toBe("unchanged");
			expect(statSync(files.output).mode & 0o777).toBe(0o700);
			for (const name of readdirSync(files.output)) {
				expect(statSync(join(files.output, name)).mode & 0o777).toBe(0o600);
			}
		}
	});

	it("preserves the archive boundary with filesystem case semantics", () => {
		const files = save();
		const alias = join(dirname(files.archive), "ARCHIVE");
		const shared = existsSync(alias);
		if (!shared) mkdirSync(alias);
		files.output = join(alias, "results");
		if (shared) {
			expect(() => runTelemetryHistory(files)).toThrow(/outside the input archive/);
			expect(existsSync(files.output)).toBe(false);
		} else {
			expect(runTelemetryHistory(files).status).toBe("written");
		}
	});

	it("rejects results inside the executing source checkout before creating files", () => {
		const files = save();
		files.output = join(dirname(dirname(CLI)), `telemetry-history-test-${digest(files.root).slice(0, 16)}`);
		owned.push(files.output);
		expect(() => runTelemetryHistory(files)).toThrow(/outside telemetry source checkouts/);
		expect(existsSync(files.output)).toBe(false);
	});

	it("writes deterministic private artifacts, omits freeform metadata, and verifies idempotent reuse", () => {
		const files = save();
		const forbidden = vi.fn(() => {
			throw new Error("network forbidden");
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(forbidden);
		vi.spyOn(net.Socket.prototype, "connect").mockImplementation(forbidden);
		const source = readFileSync(join(files.archive, "q2/response.json"));
		expect(runTelemetryHistory(files).status).toBe("written");
		const names = readdirSync(files.output).sort();
		expect(names).toEqual(["daily.csv", "daily.json", "manifest.json"]);
		expect(statSync(files.output).mode & 0o777).toBe(0o700);
		const before = names.map((file) => ({
			bytes: readFileSync(join(files.output, file)),
			mtime: statSync(join(files.output, file)).mtimeMs,
		}));
		expect(runTelemetryHistory(files).status).toBe("unchanged");
		const other = join(files.root, "second");
		runTelemetryHistory({ ...files, output: other });
		for (const [index, file] of names.entries()) {
			expect(statSync(join(files.output, file)).mode & 0o777).toBe(0o600);
			expect(statSync(join(files.output, file)).mtimeMs).toBe(before[index].mtime);
			expect(readFileSync(join(other, file))).toEqual(before[index].bytes);
			expect(before[index].bytes.toString()).not.toMatch(/sensitive-marker/);
			expect(before[index].bytes.toString()).not.toContain(files.root);
		}
		for (const entry of read(files, "manifest.json").outputs) {
			const bytes = readFileSync(join(files.output, entry.file));
			expect({ bytes: bytes.length, sha256: digest(bytes) }).toEqual({
				bytes: entry.bytes,
				sha256: entry.sha256,
			});
		}
		expect(readFileSync(join(files.archive, "q2/response.json"))).toEqual(source);
		expect(forbidden).not.toHaveBeenCalled();
	});

	it.each(["conflicting", "incomplete", "extra file", "nonprivate", "symlink"])(
		"never overwrites a %s destination",
		(kind) => {
			const files = save();
			runTelemetryHistory(files);
			const path = join(files.output, "daily.csv");
			if (kind === "conflicting") writeFileSync(path, "conflict");
			if (kind === "incomplete") rmSync(path);
			if (kind === "extra file") writeFileSync(join(files.output, "other"), "keep");
			if (kind === "nonprivate") chmodSync(path, 0o644);
			if (kind === "symlink") {
				rmSync(path);
				symlinkSync(join(files.archive, "q2/query.sql"), path);
			}
			const manifest = readFileSync(join(files.output, "manifest.json"));
			expect(() => runTelemetryHistory(files)).toThrow(/conflict|incomplete|private|symlink/);
			expect(readFileSync(join(files.output, "manifest.json"))).toEqual(manifest);
			if (kind === "conflicting") expect(readFileSync(path, "utf8")).toBe("conflict");
			if (kind === "incomplete") expect(existsSync(path)).toBe(false);
		},
	);

	it.each([
		"archive",
		"query directory",
		"input",
		"output parent",
		"output",
		"traversal",
		"inside archive",
	])("rejects unsafe %s paths", (kind) => {
		const files = save();
		const link = join(files.root, "linked");
		if (kind === "archive") {
			symlinkSync(files.archive, link);
			files.archive = link;
		}
		if (kind === "query directory") {
			symlinkSync(join(files.archive, "q2"), join(files.archive, "linked"));
			files.query = "linked";
		}
		if (kind === "input") {
			rmSync(join(files.archive, "q2/query.sql"));
			symlinkSync(join(files.archive, "capture-plan.json"), join(files.archive, "q2/query.sql"));
		}
		if (kind === "output parent") {
			symlinkSync(files.root, link);
			files.output = join(link, "out");
		}
		if (kind === "output") symlinkSync(files.archive, files.output);
		if (kind === "traversal") files.archive += "/../archive";
		if (kind === "inside archive") files.output = join(files.archive, "out");
		expect(() => runTelemetryHistory(files)).toThrow(/symlink|traversal|outside/);
	});

	it("runs the real CLI across host timezones and emits exact CSV counts", () => {
		const files = save();
		const result = cli(files);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).summary.completeClosedTotals.weightedReports).toBe("96");
		expect(JSON.parse(cli(files, "Asia/Tokyo").stdout).status).toBe("unchanged");
		const csv = readFileSync(join(files.output, "daily.csv"), "utf8");
		expect(csv).toContain('"[""2025-01-31T23:00:00.000Z""]"');
		expect(csv).toContain(",48,24,0,0,2,2,2025-02-01T23:59:59.000Z,");
		const invalid = spawnSync(process.execPath, [CLI, "--unknown"], {
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toMatch(/Usage:/);
		expect(invalid.stdout).toBe("");
	});
});
