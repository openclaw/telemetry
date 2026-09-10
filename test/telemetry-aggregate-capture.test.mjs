import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTelemetryAggregateCapture } from "../scripts/lib/telemetry-aggregate-capture.mjs";
import { runTelemetryHistory } from "../scripts/lib/telemetry-history.mjs";

const CLI = fileURLToPath(new URL("../scripts/telemetry-aggregate-capture.mjs", import.meta.url));
const DAY = "2025-02-03";
const NOW = Date.parse("2025-02-05T12:00:00Z");
const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const AE_TOKEN = "synthetic-ae-read-token";
const HTTP_TOKEN = "synthetic-http-read-token";
const owned = [];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
let fetchMock;

function options() {
	const parent = realpathSync(mkdtempSync(join(tmpdir(), "telemetry-capture-test-")));
	owned.push(parent);
	return {
		day: DAY,
		output: join(parent, "bundle"),
		accountId: ACCOUNT,
		zoneId: ZONE,
		execute: true,
	};
}
function settings() {
	return {
		data: {
			viewer: {
				zones: [
					{
						settings: {
							httpRequestsAdaptiveGroups: {
								enabled: true,
								notOlderThan: 10 * 86_400,
								maxDuration: 86_400,
								maxPageSize: 10_000,
								maxNumberOfFields: 20,
								availableFields: [
									"count",
									"avg_sampleInterval",
									"dimensions_clientCountryName",
									"dimensions_clientRequestHTTPHost",
									"dimensions_clientRequestPath",
									"dimensions_requestSource",
									"dimensions_datetime",
								],
							},
						},
					},
				],
			},
		},
		errors: null,
	};
}
function hourly() {
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
	const data = Array.from({ length: 24 }, (_, hour) => {
		const prefix = `${DAY} ${String(hour).padStart(2, "0")}`;
		return {
			bucket: `${prefix}:00:00`,
			weightedReports: "6",
			queryRows: "3",
			featureReports: "2",
			featureQueryRows: "1",
			minSampleInterval: 2,
			maxSampleInterval: 2,
			latestEventAt: `${prefix}:59:00`,
			latestFeatureAt: `${prefix}:58:00`,
		};
	});
	return { meta, data, rows: data.length, rows_before_limit_at_least: data.length };
}
const group = (country, count, sampleInterval) => ({
	dimensions: { clientCountryName: country },
	count,
	avg: { sampleInterval },
});
function country(
	rows = [group("XX", 7, 9), group(null, 3, 1), group("T1", 0, null), group("", 1, 2)],
) {
	return { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: rows }] } }, errors: null };
}
const response = (body, init = {}) =>
	new Response(typeof body === "string" || body instanceof Uint8Array ? body : json(body), init);
function transport({ metadata = settings(), ae = hourly(), http = country(), afterAe } = {}) {
	let index = 0;
	fetchMock.mockImplementation(async () => {
		const next = [metadata, ae, http][index++];
		if (index === 2) afterAe?.();
		if (next === undefined) throw new Error("unexpected extra request");
		return next instanceof Response ? next : response(next);
	});
	return fetchMock;
}
const read = (opts, name) => JSON.parse(readFileSync(join(opts.output, name)));
function snapshot(root) {
	return Object.fromEntries(
		readdirSync(root, { recursive: true })
			.sort()
			.map((name) => {
				const path = join(root, name);
				const stat = lstatSync(path);
				return [
					name,
					{
						mode: stat.mode & 0o777,
						mtime: stat.mtimeMs,
						hash: stat.isFile() ? digest(readFileSync(path)) : null,
					},
				];
			}),
	);
}
function retainedText(opts) {
	return readdirSync(opts.output, { recursive: true })
		.map((name) => join(opts.output, name))
		.filter((path) => lstatSync(path).isFile())
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
}
function forbidCredentials() {
	const original = process;
	vi.stubGlobal("process", {
		...original,
		env: new Proxy(original.env, {
			get(target, key) {
				if (key === "TELEMETRY_AE_READ_TOKEN" || key === "TELEMETRY_HTTP_READ_TOKEN")
					throw new Error("credentials accessed");
				return Reflect.get(target, key);
			},
		}),
	});
}
function repin(opts, name, contents) {
	writeFileSync(join(opts.output, name), contents);
	const manifest = read(opts, "manifest.json");
	const entry = manifest.files.find((file) => file.file === name);
	entry.bytes = Buffer.byteLength(contents);
	entry.sha256 = digest(contents);
	writeFileSync(join(opts.output, "manifest.json"), json(manifest));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	vi.stubEnv("TELEMETRY_AE_READ_TOKEN", AE_TOKEN);
	vi.stubEnv("TELEMETRY_HTTP_READ_TOKEN", HTTP_TOKEN);
	fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("planning and exclusive capture", () => {
	it("defaults to a closed-day plan without reading credentials, touching output, or requesting data", async () => {
		const opts = options();
		opts.output = join(opts.output, "missing-parent", "result");
		forbidCredentials();
		const result = await runTelemetryAggregateCapture({ ...opts, execute: false });
		expect(result).toMatchObject({
			status: "planned",
			window: { startInclusive: `${DAY}T00:00:00.000Z`, endExclusive: "2025-02-04T00:00:00.000Z" },
			ae: { structuralMaxRows: 25, sqlLimit: 26 },
		});
		expect(result.ae.sql).toContain("LIMIT 26 FORMAT JSON");
		expect(JSON.stringify(result)).not.toContain(ACCOUNT);
		expect(JSON.stringify(result)).not.toContain(ZONE);
		expect(existsSync(dirname(dirname(opts.output)))).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["2025-02-30", "2025-02-05", "2025-02-06", "2025-02-03T00:00:00Z"])(
		"rejects an invalid or unclosed day: %s",
		async (day) => {
			await expect(runTelemetryAggregateCapture({ day })).rejects.toThrow(/day/);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(["missing HTTP", "shared token", "header injection", "bad identity", "missing parent"])(
		"validates local prerequisites before claiming output: %s",
		async (kind) => {
			const opts = options();
			if (kind === "missing HTTP") vi.stubEnv("TELEMETRY_HTTP_READ_TOKEN", "");
			if (kind === "shared token") vi.stubEnv("TELEMETRY_HTTP_READ_TOKEN", AE_TOKEN);
			if (kind === "header injection") vi.stubEnv("TELEMETRY_AE_READ_TOKEN", "bad\r\nheader");
			if (kind === "bad identity") opts.accountId = "../invalid";
			if (kind === "missing parent") opts.output = join(opts.output, "child");
			await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow();
			expect(existsSync(opts.output)).toBe(false);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("makes a concurrent output loser fail without a request or repair", async () => {
		const opts = options();
		let release;
		fetchMock
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValueOnce(response(hourly()))
			.mockResolvedValueOnce(response(country()));
		const winner = runTelemetryAggregateCapture(opts);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const pending = snapshot(opts.output);
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/incomplete/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(snapshot(opts.output)).toEqual(pending);
		release(response(settings()));
		await expect(winner).resolves.toMatchObject({ status: "written" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("captures separate estimates, exact SQL representations and a PR17-compatible archive", async () => {
		const opts = options();
		const ae = hourly();
		Object.assign(ae.data[0], {
			weightedReports: "18446744073709551615",
			queryRows: "18446744073709551615",
			featureReports: "0",
			featureQueryRows: "0",
			minSampleInterval: 1,
			maxSampleInterval: 1,
			latestFeatureAt: "1970-01-01 00:00:00",
		});
		transport({ ae });
		const result = await runTelemetryAggregateCapture(opts);
		expect(result).toMatchObject({
			status: "written",
			summary: {
				ae: {
					completeClosedDays: 1,
					completeClosedTotals: {
						weightedReports: "18446744073709551753",
						queryRows: "18446744073709551684",
						featureReports: "46",
						featureQueryRows: "23",
					},
				},
				http: { estimatedRequests: "11", countryGroups: 4, coverage: "returned_groups_only" },
			},
		});
		expect(read(opts, "http/country.json").countries).toEqual([
			{ country: null, estimatedRequests: "3", sampleInterval: 1 },
			{ country: "", estimatedRequests: "1", sampleInterval: 2 },
			{ country: "T1", estimatedRequests: "0", sampleInterval: null },
			{ country: "XX", estimatedRequests: "7", sampleInterval: 9 },
		]);
		const calls = fetchMock.mock.calls;
		expect(calls.map(([url]) => url)).toEqual([
			"https://api.cloudflare.com/client/v4/graphql",
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
			"https://api.cloudflare.com/client/v4/graphql",
		]);
		expect(calls.map(([, init]) => init.headers.Authorization)).toEqual([
			`Bearer ${HTTP_TOKEN}`,
			`Bearer ${AE_TOKEN}`,
			`Bearer ${HTTP_TOKEN}`,
		]);
		expect(calls.every(([, init]) => init.method === "POST" && init.redirect === "error")).toBe(
			true,
		);
		const request = JSON.parse(calls[2][1].body);
		expect(request.variables).toEqual({
			zoneTag: ZONE,
			start: `${DAY}T00:00:00.000Z`,
			end: "2025-02-04T00:00:00.000Z",
		});
		for (const filter of [
			'clientRequestHTTPHost: "telemetry.openclaw.ai"',
			'clientRequestPath: "/api/latest-version"',
			'requestSource: "eyeball"',
			"datetime_geq: $start",
			"datetime_lt: $end",
		])
			expect(request.query).toContain(filter);
		const manifest = read(opts, "manifest.json");
		expect(manifest).toMatchObject({ complete: true, completeness: "query_and_wire_only" });
		const sql = readFileSync(join(opts.output, "ae/q2/query.sql"), "utf8");
		expect(sql).toBe(`${calls[1][1].body}\n`);
		expect(read(opts, "ae/q2/receipt.json").sqlSha256).toBe(digest(calls[1][1].body));
		expect(digest(sql)).not.toBe(digest(calls[1][1].body));
		const standalone = join(dirname(opts.output), "standalone");
		runTelemetryHistory({
			archive: join(opts.output, "ae"),
			query: "q2",
			...manifest.pins,
			output: standalone,
		});
		for (const name of ["daily.json", "daily.csv", "manifest.json"])
			expect(readFileSync(join(standalone, name))).toEqual(
				readFileSync(join(opts.output, "ae-daily", name)),
			);
		expect(lstatSync(opts.output).mode & 0o777).toBe(0o700);
		for (const [name, stat] of Object.entries(snapshot(opts.output))) {
			expect(stat.mode).toBe(stat.hash === null ? 0o700 : 0o600);
			if (stat.hash !== null) {
				const text = readFileSync(join(opts.output, name), "utf8");
				expect(text).not.toContain(AE_TOKEN);
				expect(text).not.toContain(HTTP_TOKEN);
				expect(text).not.toContain(opts.output);
			}
		}
	});

	it.each([0, 23])(
		"keeps %s observed hours distinct from complete events or measured zero",
		async (hours) => {
			const opts = options();
			const ae = hourly();
			ae.data = ae.data.slice(0, hours);
			ae.rows = ae.rows_before_limit_at_least = hours;
			transport({ ae, http: country([]) });
			await runTelemetryAggregateCapture(opts);
			expect(read(opts, "manifest.json").complete).toBe(true);
			expect(read(opts, "http/country.json")).toMatchObject({
				coverage: "unknown",
				estimatedRequests: null,
				countries: [],
			});
			const day = read(opts, "ae-daily/daily.json").days[0];
			expect(day).toMatchObject({
				coverage: "missing_hours",
				comparisonEligible: false,
				observedHours: hours,
				weightedReports: hours === 0 ? null : "138",
			});
			expect(day.missingHours).toHaveLength(24 - hours);
		},
	);

	it("sums safe HTTP integers exactly without multiplying the sampling diagnostic", async () => {
		const opts = options();
		transport({
			http: country([
				group("AA", Number.MAX_SAFE_INTEGER, 5),
				group("BB", Number.MAX_SAFE_INTEGER, 7),
			]),
		});
		await runTelemetryAggregateCapture(opts);
		expect(read(opts, "http/country.json").estimatedRequests).toBe("18014398509481982");
	});
});

describe("offline immutable bundle verification", () => {
	it("verifies byte-identical reruns after retention expires without credentials or network", async () => {
		const opts = options();
		transport();
		await runTelemetryAggregateCapture(opts);
		const original = snapshot(opts.output);
		fetchMock.mockClear();
		forbidCredentials();
		vi.setSystemTime("2026-02-05T12:00:00Z");
		await expect(runTelemetryAggregateCapture(opts)).resolves.toMatchObject({
			status: "unchanged",
		});
		await expect(
			runTelemetryAggregateCapture({ ...opts, execute: false, verify: true }),
		).resolves.toMatchObject({ status: "unchanged" });
		expect(snapshot(opts.output)).toEqual(original);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"partial",
		"different day",
		"different account",
		"different zone",
		"changed bytes",
		"extra file",
		"nonprivate",
		"symlink",
		"hardlink",
	])("rejects %s output offline without overwriting evidence", async (kind) => {
		const opts = options();
		transport();
		await runTelemetryAggregateCapture(opts);
		if (kind === "partial") rmSync(join(opts.output, "manifest.json"));
		if (kind === "different day") opts.day = "2025-02-02";
		if (kind === "different account") opts.accountId = "c".repeat(32);
		if (kind === "different zone") opts.zoneId = "d".repeat(32);
		const path = join(opts.output, "http/country.json");
		if (kind === "changed bytes") writeFileSync(path, "changed");
		if (kind === "extra file") writeFileSync(join(opts.output, "extra"), "keep");
		if (kind === "nonprivate") chmodSync(path, 0o644);
		if (kind === "symlink" || kind === "hardlink") {
			rmSync(path);
			(kind === "symlink" ? symlinkSync : linkSync)(join(opts.output, "bundle-plan.json"), path);
		}
		fetchMock.mockClear();
		forbidCredentials();
		const original = snapshot(opts.output);
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(
			/incomplete|conflict|private|unsafe|symlink/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(snapshot(opts.output)).toEqual(original);
	});

	it.each(["daily output", "SQL", "HTTP query", "AE count"])(
		"rejects repinned %s tampering by contract or offline regeneration",
		async (kind) => {
			const opts = options();
			transport();
			await runTelemetryAggregateCapture(opts);
			if (kind === "daily output") {
				const data = read(opts, "ae-daily/daily.json");
				data.days[0].weightedReports = "999";
				repin(opts, "ae-daily/daily.json", json(data));
			}
			if (kind === "SQL")
				repin(
					opts,
					"ae/q2/query.sql",
					`${readFileSync(join(opts.output, "ae/q2/query.sql"), "utf8")}\n`,
				);
			if (kind === "HTTP query") {
				const body = read(opts, "http/country-request.json");
				body.query = body.query.replace('requestSource: "eyeball"', 'requestSource: "all"');
				repin(opts, "http/country-request.json", json(body));
			}
			if (kind === "AE count") {
				const body = read(opts, "ae/q2/response.json");
				body.data[0].weightedReports = 6;
				const encoded = json(body);
				repin(opts, "ae/q2/response.json", encoded);
				const receipt = read(opts, "ae/q2/receipt.json");
				receipt.wireSha256 = digest(encoded);
				receipt.wireBytesRead = Buffer.byteLength(encoded);
				repin(opts, "ae/q2/receipt.json", json(receipt));
			}
			fetchMock.mockClear();
			forbidCredentials();
			const original = snapshot(opts.output);
			await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(
				/conflict|history validation|AE response/,
			);
			expect(snapshot(opts.output)).toEqual(original);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("rejects symlink parents and scratch within the bundle without writing into them", async () => {
		const opts = options();
		const alias = join(dirname(opts.output), "alias");
		symlinkSync(dirname(opts.output), alias);
		await expect(
			runTelemetryAggregateCapture({ ...opts, output: join(alias, "bundle") }),
		).rejects.toThrow(/symlink/);
		expect(fetchMock).not.toHaveBeenCalled();
		transport();
		await runTelemetryAggregateCapture(opts);
		const original = snapshot(opts.output);
		fetchMock.mockClear();
		vi.stubEnv("TMPDIR", opts.output);
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/scratch/);
		expect(snapshot(opts.output)).toEqual(original);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("fail-closed HTTP and AE boundaries", () => {
	it.each([
		[
			"disabled",
			(s) => {
				s.enabled = false;
			},
		],
		[
			"unsupported filter",
			(s) => {
				s.availableFields = s.availableFields.filter((v) => v !== "dimensions_clientRequestPath");
			},
		],
		[
			"expired lookback",
			(s) => {
				s.notOlderThan = 86_400;
			},
		],
		[
			"duration",
			(s) => {
				s.maxDuration = 86_399;
			},
		],
		[
			"page cap",
			(s) => {
				s.maxPageSize = 9999;
			},
		],
		[
			"field cap",
			(s) => {
				s.maxNumberOfFields = 2;
			},
		],
	])("stops after metadata for %s", async (_name, mutate) => {
		const opts = options();
		const metadata = settings();
		mutate(metadata.data.viewer.zones[0].settings.httpRequestsAdaptiveGroups);
		transport({ metadata });
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/HTTP/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
		expect(existsSync(join(opts.output, "ae/q2/response.json"))).toBe(false);
	});

	it("rechecks lookback immediately after a delayed AE request and retains incomplete evidence", async () => {
		const opts = options();
		const metadata = settings();
		metadata.data.viewer.zones[0].settings.httpRequestsAdaptiveGroups.notOlderThan =
			(NOW - Date.parse(`${DAY}T00:00:00Z`)) / 1000 + 2;
		transport({ metadata, afterAe: () => vi.setSystemTime(NOW + 3000) });
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/lookback/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(existsSync(join(opts.output, "ae-daily/manifest.json"))).toBe(true);
		expect(existsSync(join(opts.output, "http/country-response.json"))).toBe(false);
		expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
		fetchMock.mockClear();
		forbidCredentials();
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/incomplete/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"redirect",
		"expired token",
		"GraphQL errors",
		"unrequested metadata field",
		"oversize header",
		"oversize stream",
		"truncated",
		"invalid UTF-8",
		"read failure",
	])("retains an incomplete claim and never retries %s", async (kind) => {
		const opts = options();
		let metadata;
		if (kind === "redirect")
			metadata = response("redirect", {
				status: 302,
				headers: { Location: "https://example.invalid/" },
			});
		if (kind === "expired token") metadata = response(HTTP_TOKEN, { status: 401 });
		if (kind === "GraphQL errors")
			metadata = { data: null, errors: [{ message: `upstream echo: ${HTTP_TOKEN}` }] };
		if (kind === "unrequested metadata field")
			metadata = { ...settings(), debug: { echo: HTTP_TOKEN } };
		if (kind === "oversize header")
			metadata = response("{}", { headers: { "content-length": String(256 * 1024 + 1) } });
		if (kind === "oversize stream") metadata = response(Buffer.alloc(256 * 1024 + 1, 32));
		if (kind === "truncated") metadata = response("{}", { headers: { "content-length": "3" } });
		if (kind === "invalid UTF-8") metadata = response(Buffer.from([0xff]));
		if (kind === "read failure")
			metadata = new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error(`transport ${HTTP_TOKEN}`));
					},
				}),
			);
		transport({ metadata });
		const error = await runTelemetryAggregateCapture(opts).catch((error) => error);
		expect(error).toBeInstanceOf(Error);
		if (kind === "expired token")
			expect(error.message).toMatch(/^HTTP settings request failed \(HTTP 401\)/);
		for (const secret of [HTTP_TOKEN, AE_TOKEN, ZONE, ACCOUNT, opts.output])
			expect(error.message).not.toContain(secret);
		expect(retainedText(opts).includes(HTTP_TOKEN)).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
	});

	it("bounds a stalled request and aborts it without retry", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const opts = options();
		fetchMock.mockImplementation(() => new Promise(() => {}));
		const result = expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/timed out/);
		await vi.advanceTimersByTimeAsync(45_000);
		await result;
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
		expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
	});

	it("does not relax the unchanged AE exporter to complete a bundle", async () => {
		const opts = options();
		const ae = hourly();
		ae.data[0].featureReports = "4";
		transport({ ae });
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(/history validation/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
	});

	it.each(["error envelope", "unrequested row field", "invalid typed field"])(
		"rejects upstream AE %s before retaining an echoed token",
		async (kind) => {
			const opts = options();
			let ae = hourly();
			if (kind === "error envelope") ae = { errors: [{ message: AE_TOKEN }] };
			if (kind === "unrequested row field") ae.data[0].debug = AE_TOKEN;
			if (kind === "invalid typed field") ae.data[0].weightedReports = AE_TOKEN;
			transport({ ae });
			await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow();
			expect(retainedText(opts).includes(AE_TOKEN)).toBe(false);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(existsSync(join(opts.output, "ae/q2/response.json"))).toBe(false);
			expect(existsSync(join(opts.output, "ae/q2/receipt.json"))).toBe(false);
			expect(existsSync(join(opts.output, "ae/q2/attempt.json"))).toBe(true);
			expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
		},
	);

	it.each([
		"duplicate country",
		"unsafe integer",
		"fractional count",
		"page limit",
		"GraphQL errors",
		"unrequested country field",
	])("rejects %s without a completion manifest", async (kind) => {
		const opts = options();
		let http = country();
		if (kind === "duplicate country") http = country([group(null, 1, 1), group(null, 2, 1)]);
		if (kind === "unsafe integer") http = country([group("XX", Number.MAX_SAFE_INTEGER + 1, 1)]);
		if (kind === "fractional count") http = country([group("XX", 1.5, 1)]);
		if (kind === "page limit")
			http = response(
				JSON.stringify(country(Array.from({ length: 10_000 }, () => group("XX", 1, 1)))),
			);
		if (kind === "GraphQL errors")
			http = { data: null, errors: [{ message: `upstream echo: ${HTTP_TOKEN}` }] };
		if (kind === "unrequested country field")
			http.data.viewer.zones[0].httpRequestsAdaptiveGroups[0].debug = HTTP_TOKEN;
		transport({ http });
		await expect(runTelemetryAggregateCapture(opts)).rejects.toThrow(
			/country|integer|GraphQL|schema/,
		);
		expect(retainedText(opts).includes(HTTP_TOKEN)).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(existsSync(join(opts.output, "http/country-response.json"))).toBe(false);
		expect(existsSync(join(opts.output, "http/country-receipt.json"))).toBe(false);
		expect(existsSync(join(opts.output, "manifest.json"))).toBe(false);
		expect(existsSync(join(opts.output, "ae/q2/response.json"))).toBe(true);
	});
});

it("runs the real CLI in default-plan and offline-verify modes without leaking arguments", async () => {
	const opts = options();
	transport();
	await runTelemetryAggregateCapture(opts);
	const original = snapshot(opts.output);
	const run = (args) =>
		spawnSync(process.execPath, [CLI, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 65_536,
			env: { PATH: dirname(process.execPath), TZ: "Pacific/Honolulu" },
		});
	const planned = run(["--day", DAY]);
	expect(planned.status, planned.stderr).toBe(0);
	expect(JSON.parse(planned.stdout).status).toBe("planned");
	const verified = run([
		"--verify",
		"--day",
		DAY,
		"--output",
		opts.output,
		"--account-id",
		ACCOUNT,
		"--zone-id",
		ZONE,
	]);
	expect(verified.status, verified.stderr).toBe(0);
	expect(JSON.parse(verified.stdout).status).toBe("unchanged");
	expect(snapshot(opts.output)).toEqual(original);
	for (const privateValue of [opts.output, ACCOUNT, ZONE, AE_TOKEN, HTTP_TOKEN])
		expect(verified.stdout + verified.stderr).not.toContain(privateValue);
	const invalid = run(["--unknown", "private-marker"]);
	expect(invalid.status).toBe(1);
	expect(invalid.stderr).toMatch(/Usage:/);
	expect(invalid.stderr).not.toContain("private-marker");
});
