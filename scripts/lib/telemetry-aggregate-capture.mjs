import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	opendirSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { runTelemetryHistory } from "./telemetry-history.mjs";

const DAY = 86_400_000;
const HTTP_LIMIT = 10_000;
const TIMEOUT = 45_000;
const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const AE_ENDPOINT = "/client/v4/accounts/<account>/analytics_engine/sql";
const CONTRACT = "telemetry-aggregate-capture-pilot-v1";
const AE_COLUMNS = {
	bucket: "DateTime",
	weightedReports: "UInt64",
	queryRows: "UInt64",
	featureReports: "UInt64",
	featureQueryRows: "UInt64",
	minSampleInterval: "UInt32",
	maxSampleInterval: "UInt32",
	latestEventAt: "DateTime",
	latestFeatureAt: "DateTime",
};
const REQUIRED_FIELDS = [
	"count",
	"avg_sampleInterval",
	"dimensions_clientCountryName",
	"dimensions_clientRequestHTTPHost",
	"dimensions_clientRequestPath",
	"dimensions_requestSource",
	"dimensions_datetime",
];
const SETTINGS_QUERY = `query TelemetryMetadata($zoneTag: string) {
  viewer { zones(filter: {zoneTag: $zoneTag}) {
    settings { httpRequestsAdaptiveGroups {
      enabled notOlderThan maxDuration maxPageSize maxNumberOfFields availableFields
    } }
  } }
}`;
const COUNTRY_QUERY = `query CountryDay($zoneTag: string, $start: Time, $end: Time) {
  viewer {
    zones(filter: {zoneTag: $zoneTag}) {
      httpRequestsAdaptiveGroups(
        limit: 10000
        filter: {
          clientRequestHTTPHost: "telemetry.openclaw.ai"
          clientRequestPath: "/api/latest-version"
          requestSource: "eyeball"
          datetime_geq: $start
          datetime_lt: $end
        }
      ) {
        dimensions { clientCountryName }
        count
        avg { sampleInterval }
      }
    }
  }
}`;
const FILES = {
	"bundle-plan.json": 16_384,
	"ae/capture-plan.json": 16_384,
	"ae/q2/query.sql": 9500,
	"ae/q2/attempt.json": 16_384,
	"ae/q2/response.json": 4 * 1024 * 1024,
	"ae/q2/receipt.json": 65_536,
	"http/settings-request.json": 16_384,
	"http/settings-response.json": 256 * 1024,
	"http/settings-receipt.json": 16_384,
	"http/country-request.json": 16_384,
	"http/country-response.json": 2 * 1024 * 1024,
	"http/country-receipt.json": 16_384,
	"http/country.json": 2 * 1024 * 1024,
	"ae-daily/daily.json": 32_768,
	"ae-daily/daily.csv": 32_768,
	"ae-daily/manifest.json": 65_536,
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = (ms) => new Date(ms).toISOString();
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
class CaptureError extends Error {}
function requireValue(condition, message) {
	if (!condition) throw new CaptureError(message);
}
function keys(value, names) {
	requireValue(
		object(value) &&
			Object.keys(value).length === names.length &&
			names.every((name) => Object.hasOwn(value, name)),
		"unexpected capture schema",
	);
}
function decode(bytes) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new CaptureError("response is not valid UTF-8 JSON");
	}
}
function instant(value) {
	const ms = typeof value === "string" ? Date.parse(value) : NaN;
	requireValue(Number.isFinite(ms) && iso(ms) === value, "invalid capture clock");
	return ms;
}
function dayWindow(day) {
	requireValue(
		typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day),
		"day must be YYYY-MM-DD",
	);
	const start = Date.parse(`${day}T00:00:00.000Z`);
	requireValue(
		Number.isFinite(start) && start >= 0 && iso(start).slice(0, 10) === day,
		"invalid UTC calendar day",
	);
	const end = start + DAY;
	requireValue(end <= Date.now() && !iso(end).startsWith("+"), "day must be closed in UTC");
	return { startInclusive: iso(start), endExclusive: iso(end) };
}
function hourlySql(window) {
	const at = (value) => value.slice(0, 19).replace("T", " ");
	return (
		"SELECT toStartOfInterval(timestamp,INTERVAL '1' HOUR) AS bucket," +
		"sum(_sample_interval) AS weightedReports,count() AS queryRows," +
		"sumIf(_sample_interval,double1=1) AS featureReports," +
		"sum(if(double1=1,1,0)) AS featureQueryRows," +
		"min(_sample_interval) AS minSampleInterval,max(_sample_interval) AS maxSampleInterval," +
		"max(timestamp) AS latestEventAt," +
		"max(if(double1=1,timestamp,toDateTime('1970-01-01 00:00:00'))) AS latestFeatureAt " +
		`FROM openclaw_telemetry WHERE timestamp>=toDateTime('${at(window.startInclusive)}') ` +
		`AND timestamp<toDateTime('${at(window.endExclusive)}') GROUP BY bucket ORDER BY bucket LIMIT 26 FORMAT JSON`
	);
}
function requests(window, zoneId) {
	return {
		settings: json({ query: SETTINGS_QUERY, variables: { zoneTag: zoneId } }),
		country: json({
			query: COUNTRY_QUERY,
			variables: { zoneTag: zoneId, start: window.startInclusive, end: window.endExclusive },
		}),
	};
}
function plan(day, window, accountId, zoneId) {
	return {
		schemaVersion: 1,
		contract: CONTRACT,
		day,
		window,
		sourceIdentity: { aeAccountSha256: hash(accountId), httpZoneSha256: hash(zoneId) },
		ae: { queryContract: "ae-hourly-reports-v1", submittedSqlSha256: hash(hourlySql(window)) },
		http: {
			queryContract: "http-country-eyeball-v1",
			querySha256: hash(COUNTRY_QUERY),
			settingsQuerySha256: hash(SETTINGS_QUERY),
			limit: HTTP_LIMIT,
		},
	};
}
function noTraversal(path) {
	requireValue(
		typeof path === "string" &&
			path.length > 0 &&
			path.length <= 4096 &&
			!path.includes("\0") &&
			!path.includes("\\") &&
			!path.split("/").includes(".."),
		"an output path without traversal is required",
	);
}
function realDirectory(path) {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
		current = join(current, part);
		const info = lstatSync(current);
		requireValue(info.isDirectory() && !info.isSymbolicLink(), "symlink or non-directory rejected");
	}
	return absolute;
}
function privateMode(info, mode) {
	requireValue(
		(info.mode & 0o777) === mode &&
			(typeof process.getuid !== "function" || info.uid === process.getuid()),
		"bundle must be private and owned by the current operator",
	);
}
function readBytes(path, maximum) {
	const before = lstatSync(path);
	requireValue(
		before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
		"unsafe bundle file",
	);
	privateMode(before, 0o600);
	requireValue(before.size <= maximum, "bundle byte limit exceeded");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		requireValue(
			opened.isFile() &&
				opened.nlink === 1 &&
				opened.dev === before.dev &&
				opened.ino === before.ino &&
				opened.size === before.size,
			"bundle changed before reading",
		);
		privateMode(opened, 0o600);
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
			"bundle changed while reading",
		);
		return buffer.subarray(0, used);
	} finally {
		closeSync(fd);
	}
}
function bundleIO(root) {
	const claimed = lstatSync(root);
	const guard = (directory = root) => {
		realDirectory(directory);
		const now = lstatSync(root);
		requireValue(now.ino === claimed.ino && now.dev === claimed.dev, "bundle directory changed");
		privateMode(now, 0o700);
		privateMode(lstatSync(directory), 0o700);
	};
	guard();
	return {
		root,
		guard,
		read(name, maximum = FILES[name]) {
			guard(dirname(join(root, name)));
			return readBytes(join(root, name), maximum);
		},
		write(name, bytes) {
			requireValue(
				Buffer.byteLength(bytes) <= (FILES[name] ?? 65_536),
				"output byte limit exceeded",
			);
			guard(dirname(join(root, name)));
			const fd = openSync(
				join(root, name),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				privateMode(fstatSync(fd), 0o600);
				writeFileSync(fd, bytes);
			} finally {
				closeSync(fd);
			}
			guard();
		},
	};
}
function validateLayout(bundle, completed) {
	const expected = new Map();
	for (const file of [...Object.keys(FILES), ...(completed ? ["manifest.json"] : [])]) {
		const parts = file.split("/");
		for (let i = 0; i < parts.length; i++) {
			const parent = parts.slice(0, i).join("/");
			if (!expected.has(parent)) expected.set(parent, new Set());
			expected.get(parent).add(parts[i]);
		}
	}
	for (const [path, names] of expected) {
		bundle.guard(join(bundle.root, path));
		const dir = opendirSync(join(bundle.root, path));
		let count = 0;
		try {
			for (let entry; (entry = dir.readSync());) {
				requireValue(names.has(entry.name) && ++count <= names.size, "bundle conflicts");
			}
		} finally {
			dir.closeSync();
		}
		requireValue(count === names.size, "bundle is incomplete; no resume or overwrite");
	}
}
function zoneResult(value, field) {
	keys(value, ["data", "errors"]);
	requireValue(
		value.errors === null || (Array.isArray(value.errors) && value.errors.length === 0),
		"GraphQL returned errors",
	);
	keys(value.data, ["viewer"]);
	keys(value.data.viewer, ["zones"]);
	const zones = value.data.viewer.zones;
	requireValue(Array.isArray(zones) && zones.length === 1, "expected exactly one HTTP zone");
	keys(zones[0], [field]);
	return zones[0][field];
}
function settingsFrom(value) {
	const wrapper = zoneResult(value, "settings");
	keys(wrapper, ["httpRequestsAdaptiveGroups"]);
	const settings = wrapper.httpRequestsAdaptiveGroups;
	keys(settings, [
		"enabled",
		"notOlderThan",
		"maxDuration",
		"maxPageSize",
		"maxNumberOfFields",
		"availableFields",
	]);
	requireValue(settings.enabled === true, "HTTP dataset is not enabled");
	for (const key of ["notOlderThan", "maxDuration", "maxPageSize", "maxNumberOfFields"])
		requireValue(
			Number.isSafeInteger(settings[key]) && settings[key] > 0,
			"invalid HTTP dataset limits",
		);
	const fields = settings.availableFields;
	requireValue(
		Array.isArray(fields) &&
			fields.length <= 4096 &&
			fields.every((field) => typeof field === "string" && field.length <= 160) &&
			REQUIRED_FIELDS.every((field) => fields.includes(field)),
		"HTTP dataset lacks required fields or filters",
	);
	requireValue(
		settings.maxDuration >= DAY / 1000 &&
			settings.maxPageSize >= HTTP_LIMIT &&
			settings.maxNumberOfFields >= REQUIRED_FIELDS.length,
		"HTTP dataset duration, page, or field cap is insufficient",
	);
	return settings;
}
function checkLookback(settings, window, now) {
	requireValue(
		now >= instant(window.endExclusive) &&
			(now - instant(window.startInclusive)) / 1000 <= settings.notOlderThan,
		"requested day is outside current HTTP lookback; no country request was made",
	);
}
function countryOutput(value, window) {
	const rows = zoneResult(value, "httpRequestsAdaptiveGroups");
	requireValue(
		Array.isArray(rows) && rows.length < HTTP_LIMIT,
		"HTTP country limit reached or invalid rows",
	);
	const seen = new Set();
	const countries = rows.map((row) => {
		keys(row, ["dimensions", "count", "avg"]);
		keys(row.dimensions, ["clientCountryName"]);
		keys(row.avg, ["sampleInterval"]);
		const country = row.dimensions.clientCountryName;
		requireValue(
			country === null ||
				(typeof country === "string" &&
					Buffer.byteLength(country) <= 128 &&
					!/[\u0000-\u001f\u007f]/u.test(country)),
			"invalid country label",
		);
		requireValue(!seen.has(country), "duplicate country group");
		seen.add(country);
		requireValue(
			Number.isSafeInteger(row.count) && row.count >= 0,
			"HTTP count must be a nonnegative safe integer",
		);
		const interval = row.avg.sampleInterval;
		requireValue(
			interval === null ||
				(typeof interval === "number" && Number.isFinite(interval) && interval >= 1),
			"invalid HTTP sample interval",
		);
		return { country, estimatedRequests: String(row.count), sampleInterval: interval };
	});
	countries.sort((a, b) =>
		a.country === b.country
			? 0
			: a.country === null
				? -1
				: b.country === null
					? 1
					: a.country < b.country
						? -1
						: 1,
	);
	return {
		schemaVersion: 1,
		queryContract: "http-country-eyeball-v1",
		window,
		coverage: countries.length ? "returned_groups_only" : "unknown",
		estimatedRequests: countries.length
			? countries.reduce((sum, row) => sum + BigInt(row.estimatedRequests), 0n).toString()
			: null,
		countries,
		limitations: [
			"HTTP count is already estimated; sampleInterval is diagnostic, never another multiplier.",
			"Missing countries and empty results are unknown, not measured zero.",
			"All methods, statuses and bots within the exact host, path and eyeball scope are included.",
			"HTTP requests are not accepted AE reports, unique installations, users, or an opt-in rate.",
			"Country labels, including null and special values, are preserved without inference or joins.",
		],
	};
}
async function post(url, token, body, maximum, contentType, stage) {
	const controller = new AbortController();
	let timer;
	let reader;
	try {
		return await Promise.race([
			(async () => {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": contentType,
						Accept: "application/json",
						"Accept-Encoding": "identity",
					},
					body,
					redirect: "error",
					signal: controller.signal,
				});
				requireValue(
					!response.redirected && response.status === 200,
					`${stage} request failed (HTTP ${Number(response.status)}); redirects are rejected`,
				);
				const encoding = response.headers.get("content-encoding");
				requireValue(!encoding || encoding === "identity", "encoded wire response is unsupported");
				const length = response.headers.get("content-length");
				requireValue(
					length === null || (/^\d{1,10}$/u.test(length) && Number(length) <= maximum),
					"response byte limit exceeded",
				);
				requireValue(response.body, "response body is missing");
				reader = response.body.getReader();
				const bytes = Buffer.alloc(maximum);
				let used = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					requireValue(used + value.byteLength <= maximum, "response byte limit exceeded");
					bytes.set(value, used);
					used += value.byteLength;
				}
				requireValue(length === null || Number(length) === used, "response body is truncated");
				return { bytes: bytes.subarray(0, used), receivedAt: iso(Date.now()) };
			})(),
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new CaptureError(`${stage} request timed out; no retry`));
				}, TIMEOUT);
			}),
		]);
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		throw new CaptureError(
			`${stage} request failed; check explicit read credentials and connectivity; no retry`,
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
		if (reader) reader.cancel().catch(() => {});
	}
}
function httpReceipt(request, wire, requestedAt) {
	return {
		method: "POST",
		endpoint: GRAPHQL,
		requestSha256: hash(request),
		requestedAt,
		receivedAt: wire.receivedAt,
		status: 200,
		complete: true,
		wireBodyTruncated: false,
		responseRedacted: false,
		wireBytesRead: wire.bytes.length,
		wireSha256: hash(wire.bytes),
	};
}
function aePlan(spec, captureStartedAt) {
	const sql = hourlySql(spec.window);
	return {
		captureStartedAt,
		windowStartInclusive: spec.window.startInclusive,
		windowEndExclusive: spec.window.endExclusive,
		queries: [{ id: "q2", sql, sqlSha256: hash(sql), structuralMaxRows: 25, sqlLimit: 26 }],
	};
}
function aeAttempt(spec, requestedAt) {
	return {
		queryId: "q2",
		ordinal: 1,
		method: "POST",
		endpointTemplate: AE_ENDPOINT,
		accountSha256: spec.sourceIdentity.aeAccountSha256,
		sqlSha256: spec.ae.submittedSqlSha256,
		requestedAt,
	};
}
function validateAeContent(response) {
	keys(response, ["meta", "data", "rows", "rows_before_limit_at_least"]);
	const columns = Object.entries(AE_COLUMNS);
	requireValue(
		Array.isArray(response.meta) &&
			response.meta.length === columns.length &&
			response.meta.every((column, index) => {
				keys(column, ["name", "type"]);
				return column.name === columns[index][0] && column.type === columns[index][1];
			}),
		"unsupported AE response metadata",
	);
	requireValue(
		Array.isArray(response.data) &&
			response.data.length <= 25 &&
			response.rows === response.data.length &&
			response.rows_before_limit_at_least === response.data.length,
		"incomplete AE response rows",
	);
	// Reject unrequested fields and freeform error text before archiving any upstream bytes.
	// The unchanged exporter still owns hourly, sampling, watermark and coverage semantics.
	for (const row of response.data) {
		keys(row, Object.keys(AE_COLUMNS));
		for (const [name, type] of columns) {
			const value = row[name];
			const valid =
				type === "DateTime"
					? typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
					: type === "UInt64"
						? typeof value === "string" &&
							/^(?:0|[1-9]\d{0,19})$/u.test(value) &&
							BigInt(value) <= 18_446_744_073_709_551_615n
						: Number.isInteger(value) && value >= 1 && value <= 4_294_967_295;
			requireValue(valid, "unsupported AE response field representation");
		}
	}
}
function aeReceipt(spec, wire) {
	const response = decode(wire.bytes);
	validateAeContent(response);
	return {
		queryId: "q2",
		sqlSha256: spec.ae.submittedSqlSha256,
		complete: true,
		status: 200,
		receivedAt: wire.receivedAt,
		wireBytesRead: wire.bytes.length,
		wireSha256: hash(wire.bytes),
		wireBodyTruncated: false,
		responseRedacted: false,
		hardLimitReached: false,
		rowsReturned: response.data.length,
		declaredRows: response.rows,
		rowsBeforeLimitAtLeast: response.rows_before_limit_at_least,
		meta: response.meta,
	};
}
function history(bundle, output, pins) {
	try {
		bundle.guard(join(bundle.root, "ae/q2"));
		return runTelemetryHistory({
			archive: join(bundle.root, "ae"),
			query: "q2",
			...pins,
			output,
		});
	} catch {
		throw new CaptureError("AE archive failed unchanged history validation");
	}
}
function verifyBundle(bundle, spec, requestBodies, completed) {
	validateLayout(bundle, completed);
	const bytes = Object.fromEntries(Object.keys(FILES).map((name) => [name, bundle.read(name)]));
	const expectBytes = (name, expected) =>
		requireValue(
			bytes[name].equals(Buffer.from(expected)),
			"bundle content conflicts with its contract",
		);
	expectBytes("bundle-plan.json", json(spec));
	const files = Object.entries(bytes).map(([file, data]) => ({
		file,
		bytes: data.length,
		sha256: hash(data),
	}));
	let savedManifest;
	if (completed) {
		savedManifest = bundle.read("manifest.json", 65_536);
		const saved = decode(savedManifest);
		requireValue(
			saved?.complete === true && json(saved.files) === json(files),
			"bundle hashes conflict or completion is missing",
		);
	}
	const parsed = (name) => decode(bytes[name]);
	const capture = parsed("ae/capture-plan.json");
	const attempt = parsed("ae/q2/attempt.json");
	const receipt = parsed("ae/q2/receipt.json");
	expectBytes("ae/capture-plan.json", json(aePlan(spec, capture.captureStartedAt)));
	expectBytes("ae/q2/attempt.json", json(aeAttempt(spec, attempt.requestedAt)));
	expectBytes("ae/q2/query.sql", `${hourlySql(spec.window)}\n`);
	expectBytes(
		"ae/q2/receipt.json",
		json(
			aeReceipt(spec, {
				bytes: bytes["ae/q2/response.json"],
				receivedAt: receipt.receivedAt,
			}),
		),
	);
	const clocks = [instant(spec.window.endExclusive), instant(capture.captureStartedAt)];
	for (const name of ["settings", "country"]) {
		const path = `http/${name}`;
		const record = parsed(`${path}-receipt.json`);
		expectBytes(`${path}-request.json`, requestBodies[name]);
		expectBytes(
			`${path}-receipt.json`,
			json(
				httpReceipt(
					requestBodies[name],
					{
						bytes: bytes[`${path}-response.json`],
						receivedAt: record.receivedAt,
					},
					record.requestedAt,
				),
			),
		);
		if (name === "country") clocks.push(instant(attempt.requestedAt), instant(receipt.receivedAt));
		clocks.push(instant(record.requestedAt), instant(record.receivedAt));
	}
	requireValue(
		clocks.every((time, index) => !index || time >= clocks[index - 1]),
		"capture clock order mismatch",
	);
	const settings = settingsFrom(parsed("http/settings-response.json"));
	for (const name of ["settings", "country"])
		checkLookback(settings, spec.window, instant(parsed(`http/${name}-receipt.json`).requestedAt));
	const country = countryOutput(parsed("http/country-response.json"), spec.window);
	expectBytes("http/country.json", json(country));
	const pins = {
		planSha256: hash(bytes["ae/capture-plan.json"]),
		receiptSha256: hash(bytes["ae/q2/receipt.json"]),
	};
	// The unchanged exporter writes only to our scratch, never into the saved archive.
	const scratchParent = realDirectory(realpathSync(tmpdir()));
	const rel = relative(bundle.root, scratchParent);
	requireValue(
		rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel),
		"verification scratch must be outside the bundle",
	);
	const scratch = mkdtempSync(join(scratchParent, "telemetry-capture-verify-"));
	const claimed = lstatSync(scratch);
	let summary;
	try {
		privateMode(claimed, 0o700);
		const output = join(scratch, "daily");
		summary = history(bundle, output, pins).summary;
		for (const name of ["daily.json", "daily.csv", "manifest.json"])
			expectBytes(`ae-daily/${name}`, readBytes(join(output, name), FILES[`ae-daily/${name}`]));
	} finally {
		const now = lstatSync(scratch);
		requireValue(
			!now.isSymbolicLink() && now.ino === claimed.ino && now.dev === claimed.dev,
			"verification scratch changed",
		);
		rmSync(scratch, { recursive: true });
	}
	const manifest = {
		schemaVersion: 1,
		contract: CONTRACT,
		day: spec.day,
		sourceIdentity: spec.sourceIdentity,
		complete: true,
		completeness: "query_and_wire_only",
		pins,
		files,
		summary: {
			ae: summary,
			http: {
				countryGroups: country.countries.length,
				coverage: country.coverage,
				estimatedRequests: country.estimatedRequests,
			},
		},
		limitations: [
			"Pilot captures only hourly AE report aggregates and separate HTTP country aggregates.",
			"Completion certifies query and wire validation, not complete events, unique installations, or a census.",
			"Missing AE hours and empty HTTP results remain unknown, not measured zero.",
			"Pre-geography AE rows have unknown geography; HTTP countries do not enrich or join AE reports.",
			"No raw events, version/plugin distributions, finer geography, or full-dimensional/lossless backup.",
			"No replay, restore writes, upload, scheduling, storage provisioning, or retention policy is implemented.",
			"Hashes bind operator-selected local evidence, not independent server authentication.",
		],
	};
	const encoded = json(manifest);
	if (completed)
		requireValue(savedManifest.equals(Buffer.from(encoded)), "completion manifest conflicts");
	for (const [name, original] of Object.entries(bytes))
		requireValue(bundle.read(name).equals(original), "bundle changed during verification");
	validateLayout(bundle, completed);
	return { manifest: encoded, summary: manifest.summary };
}

/** Plan without side effects, capture one explicit day, or verify an existing bundle offline. */
export async function runTelemetryAggregateCapture({
	day,
	output,
	accountId,
	zoneId,
	execute = false,
	verify = false,
}) {
	try {
		requireValue(
			typeof execute === "boolean" && typeof verify === "boolean" && !(execute && verify),
			"select either execute or verify",
		);
		const window = dayWindow(day);
		if (!execute && !verify) {
			return {
				status: "planned",
				contract: CONTRACT,
				day,
				window,
				ae: {
					endpointTemplate: AE_ENDPOINT,
					sql: hourlySql(window),
					structuralMaxRows: 25,
					sqlLimit: 26,
				},
				http: { endpoint: GRAPHQL, ...requests(window, "<zone>") },
				requires: [
					"explicit operator output",
					"separate AE and HTTP read tokens",
					"current HTTP capability and lookback checks",
				],
			};
		}
		for (const value of [accountId, zoneId])
			requireValue(
				typeof value === "string" && /^[a-f0-9]{32}$/u.test(value),
				"explicit account and zone identities must be 32 lowercase hex characters",
			);
		noTraversal(output);
		const root = resolve(output);
		realDirectory(dirname(root));
		const spec = plan(day, window, accountId, zoneId);
		const requestBodies = requests(window, zoneId);
		let exists = false;
		try {
			lstatSync(root);
			exists = true;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		// Reruns must work offline even after retention or credentials have expired.
		if (exists) {
			const result = verifyBundle(bundleIO(root), spec, requestBodies, true);
			return { status: "unchanged", day, summary: result.summary };
		}
		requireValue(!verify, "bundle is missing; offline verification cannot create it");
		const aeToken = process.env.TELEMETRY_AE_READ_TOKEN;
		const httpToken = process.env.TELEMETRY_HTTP_READ_TOKEN;
		for (const token of [aeToken, httpToken])
			requireValue(
				typeof token === "string" && /^[\x21-\x7e]{1,4096}$/u.test(token),
				"separate explicit AE and HTTP read credentials are required",
			);
		requireValue(aeToken !== httpToken, "AE and HTTP read credentials must be separate");
		requireValue(typeof globalThis.fetch === "function", "fetch is unavailable");
		mkdirSync(root, { mode: 0o700 });
		const bundle = bundleIO(root);
		for (const path of ["ae", "ae/q2", "http"]) {
			bundle.guard();
			mkdirSync(join(root, path), { mode: 0o700 });
		}
		bundle.write("bundle-plan.json", json(spec));
		bundle.write("ae/capture-plan.json", json(aePlan(spec, iso(Date.now()))));
		bundle.write("ae/q2/query.sql", `${hourlySql(window)}\n`);
		bundle.write("http/settings-request.json", requestBodies.settings);
		const metadataAt = iso(Date.now());
		const metadataWire = await post(
			GRAPHQL,
			httpToken,
			requestBodies.settings,
			FILES["http/settings-response.json"],
			"application/json",
			"HTTP settings",
		);
		const settings = settingsFrom(decode(metadataWire.bytes));
		bundle.write("http/settings-response.json", metadataWire.bytes);
		bundle.write(
			"http/settings-receipt.json",
			json(httpReceipt(requestBodies.settings, metadataWire, metadataAt)),
		);
		checkLookback(settings, window, Date.now());
		const requestedAt = iso(Date.now());
		bundle.write("ae/q2/attempt.json", json(aeAttempt(spec, requestedAt)));
		const aeWire = await post(
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
			aeToken,
			hourlySql(window),
			FILES["ae/q2/response.json"],
			"text/plain",
			"AE hourly",
		);
		const receipt = aeReceipt(spec, aeWire);
		bundle.write("ae/q2/response.json", aeWire.bytes);
		bundle.write("ae/q2/receipt.json", json(receipt));
		history(bundle, join(root, "ae-daily"), {
			planSha256: hash(bundle.read("ae/capture-plan.json")),
			receiptSha256: hash(bundle.read("ae/q2/receipt.json")),
		});
		bundle.write("http/country-request.json", requestBodies.country);
		const countryAt = iso(Date.now());
		checkLookback(settings, window, instant(countryAt));
		const countryWire = await post(
			GRAPHQL,
			httpToken,
			requestBodies.country,
			FILES["http/country-response.json"],
			"application/json",
			"HTTP country",
		);
		const country = countryOutput(decode(countryWire.bytes), window);
		bundle.write("http/country-response.json", countryWire.bytes);
		bundle.write(
			"http/country-receipt.json",
			json(httpReceipt(requestBodies.country, countryWire, countryAt)),
		);
		bundle.write("http/country.json", json(country));
		const result = verifyBundle(bundle, spec, requestBodies, false);
		bundle.write("manifest.json", result.manifest);
		return { status: "written", day, summary: result.summary };
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		throw new CaptureError(
			error?.code === "EEXIST"
				? "output already exists; no resume or overwrite"
				: error?.code === "ENOENT"
					? "bundle is incomplete or output parent is missing"
					: "unable to read or write private bundle; incomplete evidence is retained",
		);
	}
}
