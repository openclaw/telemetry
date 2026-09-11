import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	opendirSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { isTelemetryCheckoutPath, isWithinDirectory } from "./private-export-path.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_DAYS = 93;
const MAX_HOURS = MAX_DAYS * 24 + 1;
const SHA = /^[a-f0-9]{64}$/u;
const COUNTS = ["weightedReports", "queryRows", "featureReports", "featureQueryRows"];
const SCHEMA = [
	["bucket", "DateTime"],
	...COUNTS.map((name) => [name, "UInt64"]),
	["minSampleInterval", "UInt32"],
	["maxSampleInterval", "UInt32"],
	["latestEventAt", "DateTime"],
	["latestFeatureAt", "DateTime"],
];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;
const floorDay = (ms) => Math.floor(ms / DAY) * DAY;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

class HistoryError extends Error {}
function requireValue(condition, message) {
	if (!condition) throw new HistoryError(message);
}
function exactKeys(value, names) {
	requireValue(
		object(value) &&
			Object.keys(value).length === names.length &&
			names.every((name) => Object.hasOwn(value, name)),
		"unexpected response schema",
	);
}
function utc(value) {
	requireValue(typeof value === "string", "timestamp must be explicit UTC");
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/u.exec(value);
	requireValue(match, "timestamp must be explicit UTC with at most microsecond precision");
	const ms = Date.parse(`${match[1]}Z`);
	requireValue(
		Number.isFinite(ms) && iso(ms) === `${match[1]}.000Z`,
		"invalid UTC calendar timestamp",
	);
	// Capture clocks can differ within one millisecond; retain their exact ordering.
	return BigInt(ms) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function sqlTime(value) {
	requireValue(
		typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value),
		"invalid SQL UTC timestamp",
	);
	return Number(utc(`${value.replace(" ", "T")}Z`) / 1000n);
}
function uint64(value) {
	requireValue(
		typeof value === "string" &&
			/^(?:0|[1-9]\d{0,19})$/u.test(value) &&
			BigInt(value) <= 18_446_744_073_709_551_615n,
		"count must be a lossless UInt64 decimal string",
	);
	return BigInt(value);
}
function sample(value) {
	requireValue(
		Number.isInteger(value) && value >= 1 && value <= 4_294_967_295,
		"sample interval must be a positive UInt32",
	);
	return BigInt(value);
}
function noTraversal(path) {
	requireValue(
		typeof path === "string" &&
			path.length > 0 &&
			path.length <= 4096 &&
			!path.includes("\0") &&
			!path.includes("\\") &&
			!path.split("/").includes(".."),
		"path traversal is not allowed",
	);
}
function realDirectory(path) {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
		current = join(current, part);
		const info = lstatSync(current);
		requireValue(
			info.isDirectory() && !info.isSymbolicLink(),
			"symlink or non-directory parent rejected",
		);
	}
	return absolute;
}
function readBytes(path, maximum, privateOutput = false) {
	const before = lstatSync(path);
	requireValue(before.isFile() && !before.isSymbolicLink(), "expected a regular non-symlink file");
	requireValue(before.size <= maximum, "input byte limit exceeded");
	if (privateOutput)
		requireValue(
			(before.mode & 0o777) === 0o600 && before.nlink === 1,
			"existing output file is not private",
		);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		requireValue(
			opened.isFile() &&
				opened.dev === before.dev &&
				opened.ino === before.ino &&
				opened.size === before.size,
			"file changed before reading",
		);
		// A growing file cannot force an unbounded read or allocation.
		const buffer = Buffer.alloc(opened.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const n = readSync(fd, buffer, used, buffer.length - used, used);
			if (!n) break;
			used += n;
		}
		const after = fstatSync(fd);
		requireValue(
			used === opened.size &&
				after.size === opened.size &&
				after.mtimeMs === opened.mtimeMs &&
				after.ctimeMs === opened.ctimeMs,
			"file changed while reading",
		);
		return buffer.subarray(0, used);
	} finally {
		closeSync(fd);
	}
}
function parseJson(bytes) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new HistoryError("input is not valid UTF-8 JSON");
	}
}
function validateSchema(meta) {
	requireValue(
		Array.isArray(meta) &&
			meta.length === SCHEMA.length &&
			meta.every((entry, index) => {
				exactKeys(entry, ["name", "type"]);
				return entry.name === SCHEMA[index][0] && entry.type === SCHEMA[index][1];
			}),
		"hourly metadata schema mismatch",
	);
}
function auditedSql(start, end, limit) {
	const at = (ms) => iso(ms).slice(0, 19).replace("T", " ");
	return (
		"SELECT toStartOfInterval(timestamp,INTERVAL '1' HOUR) AS bucket," +
		"sum(_sample_interval) AS weightedReports,count() AS queryRows," +
		"sumIf(_sample_interval,double1=1) AS featureReports," +
		"sum(if(double1=1,1,0)) AS featureQueryRows," +
		"min(_sample_interval) AS minSampleInterval,max(_sample_interval) AS maxSampleInterval," +
		"max(timestamp) AS latestEventAt," +
		"max(if(double1=1,timestamp,toDateTime('1970-01-01 00:00:00'))) AS latestFeatureAt " +
		`FROM openclaw_telemetry WHERE timestamp>=toDateTime('${at(start)}') ` +
		`AND timestamp<toDateTime('${at(end)}') GROUP BY bucket ORDER BY bucket LIMIT ${limit} FORMAT JSON`
	);
}
function validateCapture(plan, queryId, receipt, attempt, response, sqlBytes, responseBytes) {
	requireValue(object(plan) && Array.isArray(plan.queries), "capture plan is missing queries");
	requireValue(plan.queries.length <= 64, "capture plan query limit exceeded");
	const matches = plan.queries.filter((query) => object(query) && query.id === queryId);
	requireValue(matches.length === 1, "query must occur exactly once in the plan");
	const query = matches[0];
	const startMicros = utc(plan.windowStartInclusive);
	const endMicros = utc(plan.windowEndExclusive);
	requireValue(
		startMicros >= 0n &&
			startMicros < endMicros &&
			endMicros - startMicros <= BigInt(MAX_DAYS * DAY) * 1000n &&
			startMicros % 1_000_000n === 0n &&
			endMicros % 1_000_000n === 0n,
		"query window must span at most 93 days at whole-second UTC bounds",
	);
	const start = Number(startMicros / 1000n);
	const end = Number(endMicros / 1000n);
	const plannedAt = utc(plan.captureStartedAt);
	requireValue(endMicros <= plannedAt, "query window extends beyond capture planning time");
	const structuralMax = Math.ceil((end - start) / HOUR) + 1;
	requireValue(
		query.structuralMaxRows === structuralMax && query.sqlLimit === structuralMax + 1,
		"query limit must exceed the audited structural row bound",
	);
	requireValue(
		query.sql === auditedSql(start, end, query.sqlLimit),
		"submitted SQL does not match the audited hourly query",
	);
	const submitted = Buffer.from(query.sql);
	requireValue(query.sqlSha256 === hash(submitted), "plan submitted SQL digest mismatch");
	const representation = sqlBytes.equals(submitted)
		? "submitted"
		: sqlBytes.equals(Buffer.concat([submitted, Buffer.from("\n")]))
			? "submitted_plus_lf"
			: null;
	requireValue(representation, "saved SQL must equal submitted SQL or submitted SQL plus one LF");
	requireValue(object(receipt) && object(attempt), "receipt or attempt is missing");
	requireValue(
		receipt.queryId === queryId &&
			attempt.queryId === queryId &&
			receipt.sqlSha256 === query.sqlSha256 &&
			attempt.sqlSha256 === query.sqlSha256 &&
			attempt.method === "POST" &&
			attempt.endpointTemplate === "/client/v4/accounts/<account>/analytics_engine/sql" &&
			Number.isSafeInteger(attempt.ordinal) &&
			attempt.ordinal > 0,
		"query provenance mismatch",
	);
	const requestedAt = utc(attempt.requestedAt);
	const receivedAt = utc(receipt.receivedAt);
	requireValue(
		plannedAt <= requestedAt && requestedAt <= receivedAt,
		"capture timestamp order mismatch",
	);
	requireValue(
		receipt.complete === true &&
			receipt.status === 200 &&
			receipt.wireBodyTruncated === false &&
			receipt.responseRedacted === false &&
			receipt.hardLimitReached === false,
		"receipt does not certify a complete unredacted response",
	);
	requireValue(
		receipt.wireBytesRead === responseBytes.length && receipt.wireSha256 === hash(responseBytes),
		"response wire size or digest mismatch",
	);
	exactKeys(response, ["meta", "data", "rows", "rows_before_limit_at_least"]);
	validateSchema(response.meta);
	validateSchema(receipt.meta);
	requireValue(
		Array.isArray(response.data) && response.data.length <= MAX_HOURS,
		"hourly response row limit exceeded",
	);
	const n = response.data.length;
	requireValue(
		n <= structuralMax &&
			n < query.sqlLimit &&
			[
				response.rows,
				response.rows_before_limit_at_least,
				receipt.rowsReturned,
				receipt.declaredRows,
				receipt.rowsBeforeLimitAtLeast,
			].every((count) => count === n),
		"response row completeness mismatch",
	);
	return {
		start,
		end,
		receivedAt,
		provenance: {
			queryId,
			captureStartedAt: plan.captureStartedAt,
			requestedAt: attempt.requestedAt,
			receivedAt: receipt.receivedAt,
			window: { startInclusive: iso(start), endExclusive: iso(end) },
			submittedSql: { sha256: hash(submitted), bytes: submitted.length },
			savedSqlRepresentation: representation,
			responseWireHashRecomputed: true,
			structuralMaxRows: structuralMax,
			sqlLimit: query.sqlLimit,
			returnedHourlyRows: n,
		},
	};
}
function hourlyRows(data, start, end) {
	const rows = new Map();
	let previous = -Infinity;
	for (const row of data) {
		exactKeys(
			row,
			SCHEMA.map(([name]) => name),
		);
		const bucket = sqlTime(row.bucket);
		requireValue(
			bucket % HOUR === 0 && bucket >= floorHour(start) && bucket < end && bucket > previous,
			"hourly buckets must be ordered, unique, aligned, and within the query window",
		);
		previous = bucket;
		const counts = Object.fromEntries(COUNTS.map((key) => [key, uint64(row[key])]));
		const { weightedReports, queryRows, featureReports, featureQueryRows } = counts;
		const min = sample(row.minSampleInterval);
		const max = sample(row.maxSampleInterval);
		requireValue(
			min <= max &&
				queryRows > 0n &&
				featureQueryRows <= queryRows &&
				featureReports <= weightedReports &&
				weightedReports >= queryRows * min &&
				weightedReports <= queryRows * max &&
				featureReports >= featureQueryRows * min &&
				featureReports <= featureQueryRows * max &&
				weightedReports - featureReports >= (queryRows - featureQueryRows) * min &&
				weightedReports - featureReports <= (queryRows - featureQueryRows) * max,
			"inconsistent same-query counts or sample intervals",
		);
		const latestEventAt = sqlTime(row.latestEventAt);
		const latestFeatureAt = sqlTime(row.latestFeatureAt);
		requireValue(
			latestEventAt >= Math.max(start, bucket) && latestEventAt < Math.min(end, bucket + HOUR),
			"event watermark is outside its covered hour",
		);
		requireValue(
			featureQueryRows === 0n
				? latestFeatureAt === 0
				: latestFeatureAt >= Math.max(start, bucket) && latestFeatureAt <= latestEventAt,
			"feature watermark disagrees with its same-query count or covered hour",
		);
		rows.set(bucket, {
			...counts,
			minSampleInterval: row.minSampleInterval,
			maxSampleInterval: row.maxSampleInterval,
			latestEventAt: iso(latestEventAt),
			latestFeatureAt: featureQueryRows === 0n ? null : iso(latestFeatureAt),
		});
	}
	return rows;
}
function aggregate(rows) {
	const latest = (key) =>
		rows
			.map((row) => row[key])
			.filter(Boolean)
			.sort()
			.at(-1) ?? null;
	return {
		...Object.fromEntries(
			COUNTS.map((key) => [
				key,
				rows.length ? rows.reduce((total, row) => total + BigInt(row[key]), 0n).toString() : null,
			]),
		),
		minSampleInterval: rows.length ? Math.min(...rows.map((row) => row.minSampleInterval)) : null,
		maxSampleInterval: rows.length ? Math.max(...rows.map((row) => row.maxSampleInterval)) : null,
		latestEventAt: latest("latestEventAt"),
		latestFeatureAt: latest("latestFeatureAt"),
	};
}
function dailyRows(rows, { start, end, receivedAt }) {
	const daily = [];
	for (let day = floorDay(start); day < end; day += DAY) {
		const coveredStart = Math.max(day, start);
		const coveredEnd = Math.min(day + DAY, end);
		const expected = [];
		for (let hour = floorHour(coveredStart); hour < coveredEnd; hour += HOUR) expected.push(hour);
		const present = expected.filter((hour) => rows.has(hour));
		const missingHours = expected.filter((hour) => !rows.has(hour)).map(iso);
		const partialHours = expected
			.filter((hour) => hour < coveredStart || hour + HOUR > coveredEnd)
			.map(iso);
		const partialDay = coveredStart !== day || coveredEnd !== day + DAY;
		const closedAtCapture = BigInt(day + DAY) * 1000n <= receivedAt;
		const comparisonEligible = !partialDay && !missingHours.length && closedAtCapture;
		daily.push({
			day: iso(day).slice(0, 10),
			startInclusive: iso(day),
			endExclusive: iso(day + DAY),
			coveredStartInclusive: iso(coveredStart),
			coveredEndExclusive: iso(coveredEnd),
			coverage: partialDay
				? "partial_edge"
				: missingHours.length
					? "missing_hours"
					: "complete_closed",
			closedAtCapture,
			comparisonEligible,
			expectedHours: expected.length,
			observedHours: present.length,
			missingHours,
			partialHours,
			...aggregate(present.map((hour) => rows.get(hour))),
		});
	}
	return daily;
}
function csv(daily) {
	const columns = Object.keys(daily[0]);
	const cell = (value) => {
		const text = value === null ? "" : Array.isArray(value) ? JSON.stringify(value) : String(value);
		return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	return `${[columns.join(","), ...daily.map((row) => columns.map((key) => cell(row[key])).join(","))].join("\n")}\n`;
}
function writeOutputs(output, files, root) {
	noTraversal(output);
	const absolute = resolve(output);
	realDirectory(dirname(absolute));
	requireValue(!isTelemetryCheckoutPath(absolute), "output must be outside telemetry source checkouts");
	requireValue(!isWithinDirectory(absolute, root), "output must be outside the input archive");
	let existing = false;
	try {
		mkdirSync(absolute, { mode: 0o700 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		existing = true;
	}
	const claimed = lstatSync(absolute);
	const unchanged = () => {
		realDirectory(absolute);
		const now = lstatSync(absolute);
		requireValue(
			now.ino === claimed.ino && now.dev === claimed.dev && (now.mode & 0o777) === 0o700,
			"output directory changed or is not private",
		);
	};
	unchanged();
	if (existing) {
		const names = [];
		const dir = opendirSync(absolute);
		try {
			for (let entry; (entry = dir.readSync());) {
				names.push(entry.name);
				requireValue(names.length <= Object.keys(files).length, "existing output conflicts");
			}
		} finally {
			dir.closeSync();
		}
		requireValue(
			names.length === Object.keys(files).length &&
				names.every((name) => Object.hasOwn(files, name)),
			"existing output is incomplete or conflicts",
		);
		for (const [name, content] of Object.entries(files)) {
			unchanged();
			const bytes = Buffer.from(content);
			requireValue(
				readBytes(join(absolute, name), bytes.length, true).equals(bytes),
				"existing output conflicts",
			);
		}
		unchanged();
		return "unchanged";
	}
	for (const [name, content] of Object.entries(files)) {
		unchanged();
		const fd = openSync(
			join(absolute, name),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			requireValue((fstatSync(fd).mode & 0o777) === 0o600, "output file is not private");
			writeFileSync(fd, content);
		} finally {
			closeSync(fd);
		}
	}
	unchanged();
	return "written";
}

/** Export one hash-pinned archived hourly query, without network access or replay. */
export function runTelemetryHistory({ archive, query, planSha256, receiptSha256, output }) {
	try {
		noTraversal(archive);
		requireValue(
			typeof query === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(query),
			"invalid query identifier",
		);
		requireValue(
			typeof planSha256 === "string" &&
				SHA.test(planSha256) &&
				typeof receiptSha256 === "string" &&
				SHA.test(receiptSha256),
			"plan and receipt SHA-256 pins are required",
		);
		const root = realDirectory(archive);
		const inputs = [];
		const read = (name, maximum, pin) => {
			const path = join(root, name);
			realDirectory(dirname(path));
			const bytes = readBytes(path, maximum);
			const sha256 = hash(bytes);
			if (pin) requireValue(sha256 === pin, "pinned capture digest mismatch");
			inputs.push({ file: name, bytes: bytes.length, sha256 });
			return bytes;
		};
		const plan = parseJson(read("capture-plan.json", 1024 * 1024, planSha256));
		const receipt = parseJson(read(`${query}/receipt.json`, 64 * 1024, receiptSha256));
		const attempt = parseJson(read(`${query}/attempt.json`, 16 * 1024));
		const sqlBytes = read(`${query}/query.sql`, 9500);
		const responseBytes = read(`${query}/response.json`, 4 * 1024 * 1024);
		const response = parseJson(responseBytes);
		const capture = validateCapture(
			plan,
			query,
			receipt,
			attempt,
			response,
			sqlBytes,
			responseBytes,
		);
		const rows = hourlyRows(response.data, capture.start, capture.end);
		const daily = dailyRows(rows, capture);
		const complete = daily.filter((day) => day.comparisonEligible);
		const summary = {
			days: daily.length,
			completeClosedDays: complete.length,
			partialEdgeDays: daily.filter((day) => day.coverage === "partial_edge").length,
			daysWithMissingHours: daily.filter((day) => day.missingHours.length).length,
			completeClosedTotals: aggregate(complete),
		};
		const dailyJson = json({ schemaVersion: 1, days: daily });
		const dailyCsv = csv(daily);
		const manifest = {
			schemaVersion: 1,
			queryContract: "ae-hourly-reports-v1",
			provenance: capture.provenance,
			inputs,
			outputs: Object.entries({ "daily.json": dailyJson, "daily.csv": dailyCsv }).map(
				([file, content]) => ({
					file,
					bytes: Buffer.byteLength(content),
					sha256: hash(content),
				}),
			),
			summary,
			coverage: daily.map(({ day, coverage, comparisonEligible, missingHours, partialHours }) => ({
				day,
				coverage,
				comparisonEligible,
				missingHours,
				partialHours,
			})),
			limitations: [
				"Weighted report estimates and queryRows are distinct; neither counts unique installations or users.",
				"Feature counts share this query's sample, not another query's denominator; this is not an opt-in rate.",
				"Complete closed days certify calendar coverage only, not complete events or a census.",
				"Missing hours and dates outside the query window are unknown, not measured zero; observed partial sums are not full-day totals.",
				"Geography is unknown in this export, including pre-geography rows; no location is inferred.",
				"Hashes bind operator-selected saved evidence, not independently authenticated server provenance; attempt metadata is recorded, not externally pinned.",
				"No raw events are restored, no overlapping captures are merged, and backups are separately planned.",
				"Counts are decimal strings with exact integer sums; CSV consumers must not coerce them to floating-point numbers.",
			],
		};
		const status = writeOutputs(
			output,
			{
				"daily.json": dailyJson,
				"daily.csv": dailyCsv,
				"manifest.json": json(manifest),
			},
			root,
		);
		return { status, summary };
	} catch (error) {
		if (error instanceof HistoryError) throw error;
		throw new HistoryError(
			error?.code === "ENOENT"
				? "input file or output parent is missing"
				: error?.code === "ELOOP"
					? "symlink path rejected"
					: "unable to read inputs or write private outputs",
		);
	}
}
