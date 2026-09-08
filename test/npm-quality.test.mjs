import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNpmQuality } from "../scripts/lib/npm-quality.mjs";

const CLI = fileURLToPath(new URL("../scripts/npm-quality.mjs", import.meta.url));
const AT = "2026-09-07T04:54:09.343Z";
const CAPTURED = "2026-09-07T03:00:00Z";
const NAME = "@example/plugin";
const CURRENT = "current-week";
const PREVIOUS = "previous-week";
const owned = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const capture = (url, body, status = 200) => ({
	url,
	body,
	status,
	fetchedAt: CAPTURED,
	responseSha256: digest(JSON.stringify(body)),
});
function point(pkg, day = "2026-08-29", period = "last-day", downloads = 1) {
	return capture(
		`https://api.npmjs.org/downloads/point/${period}${pkg ? `/${encodeURIComponent(pkg)}` : ""}`,
		{ start: day, end: day, downloads, ...(pkg ? { package: pkg } : {}) },
	);
}
function range(name = NAME) {
	return capture(
		`https://api.npmjs.org/downloads/range/2026-08-02:2026-08-29/${encodeURIComponent(name)}`,
		{
			package: name,
			start: "2026-08-02",
			end: "2026-08-29",
			downloads: Array.from({ length: 28 }, (_, index) => {
				const day = `2026-08-${String(index + 2).padStart(2, "0")}`;
				return { day, downloads: day === "2026-08-14" ? 0 : 2 };
			}),
		},
	);
}
function fixture() {
	return {
		manifest: {
			schemaVersion: 1,
			analysisAt: AT,
			corePackage: null,
			windows: [
				{ id: "days28", start: "2026-08-02", end: "2026-08-29" },
				{ id: CURRENT, start: "2026-08-23", end: "2026-08-29" },
				{ id: PREVIOUS, start: "2026-08-16", end: "2026-08-22" },
			],
			comparison: {
				current: CURRENT,
				previous: PREVIOUS,
				baseExclusions: [],
				groups: [{ id: "all", exclude: [] }],
			},
			packages: [
				{
					name: NAME,
					manifestId: "plugin",
					legacyFor: null,
					captures: { downloads: "downloads", registry: "registry", versions: "versions" },
				},
			],
			cutoffControls: [
				{ id: "core", package: "openclaw", capture: "core" },
				{ id: "global", package: null, capture: "global" },
				{ id: "plugin", package: NAME, capture: "plugin" },
			],
			anomalyProbes: [{ day: "2026-08-14", capture: "zero" }],
			pointProbes: [{ id: "beyond", package: "openclaw", day: "2026-09-06", capture: "explicit" }],
			packaging: "packaging",
			telemetry: { format: "query-window", capture: "telemetry" },
		},
		captures: new Map([
			["downloads", range()],
			[
				"registry",
				capture(`https://registry.npmjs.org/${encodeURIComponent(NAME)}`, {
					name: NAME,
					time: {
						created: "2025-01-01T00:00:00Z",
						modified: CAPTURED,
						"1.0.0": "2026-08-08T00:00:00Z",
						"0.0.0": "2026-08-06T10:47:22.607Z",
					},
				}),
			],
			[
				"versions",
				capture(`https://api.npmjs.org/versions/${encodeURIComponent(NAME)}/last-week`, {
					package: NAME,
					downloads: { "1.0.0": 10, "0.0.0": 2 },
				}),
			],
			["core", point("openclaw")],
			["global", point(null)],
			["plugin", point(NAME)],
			["zero", point(null, "2026-08-14", "2026-08-14", 0)],
			["explicit", point("openclaw", "2026-09-06", "2026-09-06", 0)],
			[
				"packaging",
				{
					capturedAt: CAPTURED,
					evidence: [
						{
							revision: "b".repeat(40),
							responseSha256: digest("synthetic packaging response"),
							url: `https://raw.githubusercontent.com/openclaw/openclaw/${"b".repeat(40)}/package.json`,
							excludedExtensions: ["plugin"],
							distInclusions: ["dist/"],
						},
					],
				},
			],
			[
				"telemetry",
				{
					queriedAt: CAPTURED,
					window: {
						startInclusive: "2026-08-23T00:00:00Z",
						endExclusive: "2026-08-30T00:00:00Z",
					},
				},
			],
		]),
	};
}
function workspace() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "npm-quality-test-")));
	owned.push(root);
	return root;
}
function save(input = fixture()) {
	const dir = workspace();
	const archive = join(dir, "archive");
	mkdirSync(archive, { mode: 0o700 });
	const files = [];
	for (const [id, value] of input.captures) {
		const file = `${id}.json`;
		const bytes = Buffer.from(json(value));
		writeFileSync(join(archive, file), bytes, { flag: "wx", mode: 0o600 });
		files.push({ id, file, bytes: bytes.length, sha256: digest(bytes) });
	}
	const manifest = join(archive, "manifest.json");
	writeFileSync(manifest, json({ ...input.manifest, files }), { flag: "wx", mode: 0o600 });
	return { dir, archive, manifest, output: join(dir, "result") };
}
function run(input = fixture()) {
	const files = save(input);
	return runNpmQuality(files);
}
const first = (input) => run(input).packages.find((pkg) => pkg.name === NAME);
function rewriteManifest(files, mutate) {
	const value = JSON.parse(readFileSync(files.manifest, "utf8"));
	mutate(value);
	writeFileSync(files.manifest, json(value));
}
function drop(input, id) {
	input.captures.delete(id);
	for (const pkg of input.manifest.packages)
		for (const [key, value] of Object.entries(pkg.captures)) {
			if (value === id) pkg.captures[key] = null;
		}
	for (const entry of [
		...input.manifest.cutoffControls,
		...input.manifest.anomalyProbes,
		...input.manifest.pointProbes,
	]) {
		if (entry.capture === id) entry.capture = null;
	}
	if (input.manifest.packaging === id) input.manifest.packaging = null;
	if (input.manifest.telemetry?.capture === id) input.manifest.telemetry = null;
}
function addPackage(input, name, id) {
	const captureId = `range-${id}`;
	input.manifest.packages.push({
		name,
		manifestId: id,
		legacyFor: null,
		captures: { downloads: captureId, registry: null, versions: null },
	});
	input.captures.set(captureId, range(name));
	return input.captures.get(captureId);
}
function cli(args) {
	return spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 65_536,
		env: { PATH: dirname(process.execPath), TZ: "UTC" },
	});
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dated capture quality", () => {
	it.each([
		[
			"array body",
			(c) => {
				c.body = [];
			},
			/body must be an object/,
		],
		[
			"object downloads",
			(c) => {
				c.body.downloads = {};
			},
			/dated array/,
		],
		[
			"wrong package",
			(c) => {
				c.body.package = "other";
			},
			/package mismatch/,
		],
		[
			"wrong URL",
			(c) => {
				c.url = "https://example.invalid/data";
			},
			/URL mismatch/,
		],
		[
			"URL credentials",
			(c) => {
				c.url = c.url.replace("https://", "https://fixture@");
			},
			/URL mismatch/,
		],
		[
			"URL query",
			(c) => {
				c.url += "?extra=1";
			},
			/URL mismatch/,
		],
		[
			"failed HTTP",
			(c) => {
				c.status = 503;
			},
			/HTTP status/,
		],
		[
			"string HTTP status",
			(c) => {
				c.status = "200";
			},
			/HTTP status/,
		],
		[
			"future capture",
			(c) => {
				c.fetchedAt = "2026-09-08T00:00:00Z";
			},
			/newer than analysis/,
		],
		[
			"invalid clock",
			(c) => {
				c.fetchedAt = "2026-09-07T24:00:00Z";
			},
			/invalid timestamp/,
		],
		[
			"missing timezone",
			(c) => {
				c.fetchedAt = "2026-09-07T03:00:00";
			},
			/timezone/,
		],
		[
			"invalid bounds",
			(c) => {
				c.body.end = "2026-08-32";
			},
			/calendar date/,
		],
		[
			"reversed bounds",
			(c) => {
				c.body.start = "2026-08-30";
			},
			/window must/,
		],
		[
			"invalid day",
			(c) => {
				c.body.downloads[0].day = "2026-02-30";
			},
			/calendar date/,
		],
		[
			"outside bounds",
			(c) => {
				c.body.downloads[0].day = "2026-08-01";
			},
			/outside returned bounds/,
		],
		[
			"duplicate day",
			(c) => {
				c.body.downloads.push(c.body.downloads[0]);
			},
			/duplicate dated row/,
		],
		[
			"missing count",
			(c) => {
				delete c.body.downloads[0].downloads;
			},
			/safe integer/,
		],
		[
			"negative count",
			(c) => {
				c.body.downloads[0].downloads = -1;
			},
			/safe integer/,
		],
		[
			"string count",
			(c) => {
				c.body.downloads[0].downloads = "2";
			},
			/safe integer/,
		],
		[
			"fractional count",
			(c) => {
				c.body.downloads[0].downloads = 0.5;
			},
			/safe integer/,
		],
		[
			"unsafe count",
			(c) => {
				c.body.downloads[0].downloads = Number.MAX_SAFE_INTEGER + 1;
			},
			/safe integer/,
		],
	])("invalidates %s without substituting zero", (_name, change, message) => {
		const input = fixture();
		change(input.captures.get("downloads"));
		const pkg = first(input);
		expect(pkg.series.status).toBe("invalid");
		expect(pkg.series.issues.join(" ")).toMatch(message);
		expect(pkg.windows.days28.observedSum).toBeNull();
		expect(pkg.windows.days28.eventQuality).toBe("unknown");
	});

	it("separates missing-date coverage from partial sums and unaffected subwindows", () => {
		const input = fixture();
		input.captures.get("downloads").body.downloads.shift();
		const pkg = first(input);
		expect(pkg.windows.days28).toMatchObject({
			dateCoverageComplete: false,
			missingDates: ["2026-08-02"],
			rawObservedSum: 52,
		});
		expect(pkg.windows[CURRENT]).toMatchObject({ dateCoverageComplete: true, observedSum: 14 });
	});

	it("rejects overflowing window and aggregate sums at their respective boundaries", () => {
		const input = fixture();
		input.captures.get("downloads").body.downloads[0].downloads = Number.MAX_SAFE_INTEGER;
		const pkg = first(input);
		expect(pkg.windows.days28).toMatchObject({ observedSum: null, availability: "invalid" });
		expect(pkg.windows.days28.issues.join(" ")).toMatch(/safe integer/);
		expect(pkg.windows[CURRENT].observedSum).toBe(14);
		const aggregate = fixture();
		addPackage(aggregate, "@example/second", "second").body.downloads.at(-1).downloads =
			Number.MAX_SAFE_INTEGER - 12;
		expect(() => run(aggregate)).toThrow(/safe integer/);
	});

	it("keeps synchronized gaps out of unaffected windows without claiming a census", () => {
		const result = run();
		expect(result.anomaly.gaps).toMatchObject([{ day: "2026-08-14", zeroSeries: 1 }]);
		expect(result.packages[0].windows.days28).toMatchObject({
			dateCoverageComplete: true,
			eventQuality: "known_gap",
			observedSum: 54,
		});
		for (const id of [CURRENT, PREVIOUS])
			expect(result.packages[0].windows[id]).toMatchObject({
				observedSum: 14,
				eventQuality: "no_known_gap",
				completeEventClaimAllowed: false,
			});
		const shorter = fixture();
		shorter.manifest.windows[0] = { id: "days28", start: "2026-08-28", end: "2026-08-29" };
		expect(first(shorter).windows.days28).toMatchObject({ bounds: { days: 2 }, observedSum: 4 });
	});

	it.each([
		"positive package count",
		"missing package date",
		"missing global probe",
		"failed global probe",
	])("leaves anomaly quality unknown for %s", (fault) => {
		const input = fixture();
		const downloads = input.captures.get("downloads").body.downloads;
		if (fault === "positive package count")
			downloads.find((row) => row.day === "2026-08-14").downloads = 2;
		if (fault === "missing package date") downloads.splice(12, 1);
		if (fault === "missing global probe") drop(input, "zero");
		if (fault === "failed global probe") input.captures.get("zero").status = 503;
		const result = run(input);
		expect(result.anomaly.status).toBe("unknown");
		expect(result.anomaly.gaps).toEqual([]);
		expect(result.packages[0].windows[CURRENT]).toMatchObject({
			observedSum: 14,
			eventQuality: "unknown",
		});
		expect(result.packages[0].windows.days28.eventQuality).toBe("unknown");
	});
});

describe("captured cutoff controls", () => {
	it.each([
		"post-cutoff zeros",
		"different probe capture day",
		"different series capture day",
		"unknown cutoff",
	])("does not classify unavailable anomaly evidence: %s", (fault) => {
		const input = fixture();
		if (fault === "post-cutoff zeros") {
			input.manifest.anomalyProbes[0].day = "2026-09-06";
			input.captures.set("zero", point(null, "2026-09-06", "2026-09-06", 0));
			input.captures.set(
				"downloads",
				capture(
					`https://api.npmjs.org/downloads/range/2026-09-06:2026-09-06/${encodeURIComponent(NAME)}`,
					{
						package: NAME,
						start: "2026-09-06",
						end: "2026-09-06",
						downloads: [{ day: "2026-09-06", downloads: 0 }],
					},
				),
			);
			input.manifest.windows.push({ id: "future", start: "2026-09-06", end: "2026-09-06" });
		}
		if (fault === "different probe capture day")
			input.captures.get("zero").fetchedAt = "2026-09-06T03:00:00Z";
		if (fault === "different series capture day")
			input.captures.get("downloads").fetchedAt = "2026-09-06T03:00:00Z";
		if (fault === "unknown cutoff") drop(input, "global");
		const result = run(input);
		expect(result.anomaly).toMatchObject({ status: "unknown", gaps: [] });
		for (const window of Object.values(result.packages[0].windows)) {
			expect(window.eventQuality).toBe("unknown");
		}
		if (fault === "post-cutoff zeros") {
			expect(result.packages[0].windows.future.availability).toBe("unavailable");
		}
	});

	it.each(
		["core", "global", "plugin"].flatMap((surface) =>
			["missing", "failed", "conflicting", "malformed", "different capture day"].map((fault) => [
				surface,
				fault,
			]),
		),
	)("requires %s: %s to agree with the frozen snapshot", (surface, fault) => {
		const input = fixture();
		const cap = input.captures.get(surface);
		if (fault === "missing") drop(input, surface);
		if (fault === "failed") cap.status = 500;
		if (fault === "conflicting") cap.body.start = cap.body.end = "2026-08-28";
		if (fault === "malformed") cap.body.downloads = null;
		if (fault === "different capture day") cap.fetchedAt = "2026-09-06T03:00:00Z";
		const result = run(input);
		expect(result.cutoff).toMatchObject({ status: "unknown", blocked: true });
		expect(result.packages[0].windows[CURRENT].observedSum).toBeNull();
	});

	it("measures lag at capture time, not the later analysis clock", () => {
		const input = fixture();
		input.manifest.analysisAt = "2026-09-10T00:00:00Z";
		expect(run(input).cutoff).toMatchObject({
			returnedCutoff: "2026-08-29",
			lagCompleteUTCdays: 8,
			analysisExpectedLastCompleteUTCday: "2026-09-09",
			surfaces: expect.arrayContaining([
				expect.objectContaining({ expectedLastCompleteUTCday: "2026-09-06" }),
			]),
		});
	});

	it.each(["later series", "future cutoff", "wrong control package", "wrong point bounds"])(
		"does not make an available sum from %s",
		(fault) => {
			const input = fixture();
			if (fault === "later series")
				input.captures.get("downloads").fetchedAt = "2026-09-06T03:00:00Z";
			if (fault === "future cutoff")
				input.captures.get("core").body.start = input.captures.get("core").body.end = "2026-09-07";
			if (fault === "wrong control package") input.captures.get("plugin").body.package = "other";
			if (fault === "wrong point bounds") input.captures.get("global").body.end = "2026-08-30";
			expect(first(input).windows[CURRENT].observedSum).toBeNull();
		},
	);

	it("keeps HTTP 200 zeros beyond the captured cutoff unavailable", () => {
		const input = fixture();
		expect(run(input).pointProbes[0]).toMatchObject({
			reportedDownloads: 0,
			availability: "unavailable",
		});
		input.manifest.windows.push({ id: "next", start: "2026-09-06", end: "2026-09-06" });
		input.captures.set(
			"downloads",
			capture(
				`https://api.npmjs.org/downloads/range/2026-09-06:2026-09-06/${encodeURIComponent(NAME)}`,
				{
					package: NAME,
					start: "2026-09-06",
					end: "2026-09-06",
					downloads: [{ day: "2026-09-06", downloads: 0 }],
				},
			),
		);
		expect(first(input).windows.next).toMatchObject({
			dateCoverageComplete: true,
			availability: "unavailable",
			rawObservedSum: 0,
			observedSum: null,
		});
	});

	it("does not bind a point probe from a different capture day to frozen controls", () => {
		const input = fixture();
		input.captures.get("explicit").fetchedAt = "2026-09-06T03:00:00Z";
		expect(run(input).pointProbes[0].availability).toBe("unknown");
	});
});

describe("publication and declaration-only cohorts", () => {
	it("keeps registry 404 and missing series unavailable, not zero", () => {
		const input = fixture();
		input.captures.get("registry").status = 404;
		input.captures.get("registry").body = { error: "Not found" };
		drop(input, "downloads");
		const result = run(input);
		expect(result.summary).toMatchObject({ registry404: 1, unacquiredSeries: 1 });
		expect(result.packages[0].windows.days28).toMatchObject({
			observedSum: null,
			publicationExposureUTCDates: null,
		});
		expect(result.sensitivity.rows[0]).toMatchObject({
			current: null,
			prior: null,
			net: null,
			unavailablePackages: [NAME],
		});
	});

	it("uses earliest version publication, including placeholders and partial UTC dates", () => {
		expect(first(fixture()).registry.firstPublication).toEqual({
			version: "0.0.0",
			at: "2026-08-06T10:47:22.607Z",
		});
		expect(first(fixture()).windows.days28.publicationExposureUTCDates).toBe(24);
		const input = fixture();
		input.captures.get("registry").body.time = {
			created: "2020-01-01T00:00:00Z",
			"1.0.0": "2026-08-29T23:59:59Z",
		};
		const pkg = first(input);
		expect(pkg.windows[CURRENT].publicationExposureUTCDates).toBe(1);
		expect(pkg.windows[PREVIOUS].publicationExposureUTCDates).toBe(0);
	});

	it.each([
		[
			"future publication",
			(c) => {
				c.body.time["1.0.0"] = "2026-09-08T00:00:00Z";
			},
		],
		[
			"invalid clock",
			(c) => {
				c.body.time["1.0.0"] = "2026-08-08T25:00:00Z";
			},
		],
		[
			"no timezone",
			(c) => {
				c.body.time["1.0.0"] = "2026-08-08T00:00:00";
			},
		],
		[
			"wrong package",
			(c) => {
				c.body.name = "other";
			},
		],
		[
			"empty versions",
			(c) => {
				c.body.time = { created: CAPTURED };
			},
		],
	])("rejects %s as publication evidence", (_name, mutate) => {
		const input = fixture();
		mutate(input.captures.get("registry"));
		expect(first(input).registry.status).toBe("invalid");
		expect(first(input).windows.days28.publicationExposureUTCDates).toBeNull();
	});

	it("keeps valid source declarations distinct from tarball or alias-equivalence proof", () => {
		const input = fixture();
		expect(first(input).cohort).toMatchObject({
			classification: "external_in_inspected_source_declarations",
			actualTarballsInspected: false,
			historicalPackagingUncertainty: true,
		});
		input.manifest.packages[0].legacyFor = "@example/successor";
		expect(first(input).cohort).toMatchObject({
			classification: "legacy_relationship_not_current_equivalence",
			legacyFor: "@example/successor",
		});
	});

	it.each([
		["empty", []],
		["unproven", [{ revision: "v1", excludedExtensions: ["plugin"] }]],
		[
			"malformed exclusions",
			[
				{
					revision: "b".repeat(40),
					responseSha256: digest("fixture"),
					url: `https://raw.githubusercontent.com/openclaw/openclaw/${"b".repeat(40)}/package.json`,
					excludedExtensions: [42],
					distInclusions: ["dist/"],
				},
			],
		],
	])("does not classify from %s packaging evidence", (_name, evidence) => {
		const input = fixture();
		input.captures.get("packaging").evidence = evidence;
		expect(first(input).cohort.classification).toBe("unknown");
	});

	it("does not confuse arbitrary comparison exclusions with the declared core package", () => {
		const input = fixture();
		input.manifest.comparison.baseExclusions = [NAME];
		expect(first(input).cohort.classification).toBe("external_in_inspected_source_declarations");
		input.manifest.corePackage = NAME;
		expect(first(input).cohort.classification).toBe("core_distribution");
	});
});

describe("separate version snapshots and UTC comparison", () => {
	it("compares exact instants but never converts distribution events to users", () => {
		const input = fixture();
		let result = run(input);
		expect(result.telemetryAlignment.conversionAllowed).toBe(false);
		expect(result.telemetryAlignment.windows[CURRENT].exactUTCInstantsMatch).toBe(true);
		input.captures.get("telemetry").window = {
			startInclusive: "2026-08-23T08:00:00+08:00",
			endExclusive: "2026-08-30T08:00:00+08:00",
		};
		expect(run(input).telemetryAlignment.windows[CURRENT].exactUTCInstantsMatch).toBe(true);
		input.captures.get("telemetry").window = {
			startInclusive: "2026-08-23T04:34:46Z",
			endExclusive: "2026-08-30T04:34:46Z",
		};
		result = run(input);
		expect(result.telemetryAlignment.windows[CURRENT].exactUTCInstantsMatch).toBe(false);
		expect(result.versionSnapshots[0]).toMatchObject({
			boundsStatus: "unknown_not_returned",
			bounds: null,
			observedSum: 12,
			keptSeparateFromDatedSeries: true,
		});
		expect(result.sensitivity.rows[0].current).toBe(14);
	});

	it("validates the explicitly selected public-stats capture without inferring its window", () => {
		const input = fixture();
		input.manifest.telemetry.format = "public-stats";
		const cap = {
			status: 200,
			receivedAt: CAPTURED,
			body: {
				windowStart: "2026-08-23T04:50:35.000Z",
				windowEnd: "2026-08-30T04:50:35.000Z",
				generatedAt: CAPTURED,
			},
		};
		input.captures.set("telemetry", cap);
		expect(run(input).telemetryAlignment.windows[CURRENT]).toMatchObject({
			exactUTCInstantsMatch: false,
			telemetryCapturedAt: CAPTURED,
		});
		cap.status = 503;
		expect(run(input).telemetryAlignment.windows[CURRENT].status).toBe("invalid");
		cap.status = 200;
		cap.receivedAt = "2026-09-08T00:00:00Z";
		expect(run(input).telemetryAlignment.windows[CURRENT].status).toBe("invalid");
		cap.receivedAt = CAPTURED;
		cap.body.generatedAt = "sensitive-marker";
		expect(run(input).telemetryAlignment.windows[CURRENT].status).toBe("invalid");
	});

	it.each([
		[
			"URL",
			(c) => {
				c.url = "https://api.npmjs.org/versions/other/last-week";
			},
		],
		[
			"package",
			(c) => {
				c.body.package = "other";
			},
		],
		[
			"status",
			(c) => {
				c.status = 404;
			},
		],
		[
			"count",
			(c) => {
				c.body.downloads["1.0.0"] = "10";
			},
		],
		[
			"sum",
			(c) => {
				c.body.downloads["1.0.0"] = Number.MAX_SAFE_INTEGER;
			},
		],
		[
			"bounds",
			(c) => {
				c.body.start = "2026-08-23";
			},
		],
		[
			"shape",
			(c) => {
				c.body.downloads = [];
			},
		],
		[
			"empty identifier",
			(c) => {
				c.body.downloads[""] = 10;
			},
		],
	])("invalidates version %s without falling back to dated totals", (_name, mutate) => {
		const input = fixture();
		mutate(input.captures.get("versions"));
		const result = run(input);
		expect(result.versionSnapshots[0].status).toBe("invalid");
		expect(result.versionSnapshots[0].observedSum).toBeUndefined();
		expect(result.packages[0].windows[CURRENT].observedSum).toBe(14);
	});
});

describe("comparable windows and concentration", () => {
	it.each([
		[
			"unequal duration",
			(m) => {
				m.windows.find((w) => w.id === CURRENT).start = "2026-08-24";
			},
		],
		[
			"overlap",
			(m) => {
				m.windows.find((w) => w.id === PREVIOUS).start = "2026-08-17";
				m.windows.find((w) => w.id === PREVIOUS).end = "2026-08-23";
			},
		],
		[
			"reverse order",
			(m) => {
				[m.comparison.current, m.comparison.previous] = [PREVIOUS, CURRENT];
			},
		],
		[
			"same window",
			(m) => {
				m.comparison.previous = CURRENT;
			},
		],
		[
			"unknown window",
			(m) => {
				m.comparison.previous = "missing";
			},
		],
	])("rejects a %s comparison before emitting growth", (_name, mutate) => {
		const input = fixture();
		mutate(input.manifest);
		expect(() => run(input)).toThrow(/comparison/);
	});

	it.each(["baseExclusions", "group"])(
		"rejects unknown %s identities instead of implying no impact",
		(kind) => {
			const input = fixture();
			if (kind === "group") input.manifest.comparison.groups[0].exclude = ["@example/typo"];
			else input.manifest.comparison.baseExclusions = ["@example/typo"];
			expect(() => run(input)).toThrow(/absent from inventory/);
		},
	);

	it("computes declared concentration exclusions with independent totals", () => {
		const input = fixture();
		for (const [name, id, current, prior] of [
			["@example/large", "large", 1000, 500],
			["@example/declining", "declining", 100, 200],
			["openclaw", "core", 9999, 9999],
		]) {
			const c = addPackage(input, name, id);
			for (const row of c.body.downloads)
				row.downloads = row.day === "2026-08-29" ? current : row.day === "2026-08-22" ? prior : 0;
		}
		input.manifest.corePackage = "openclaw";
		input.manifest.comparison.baseExclusions = ["openclaw"];
		input.manifest.comparison.groups = [
			{ id: "all", exclude: [] },
			{ id: "without-large", exclude: ["@example/large"] },
			{ id: "without-two", exclude: ["@example/large", "@example/declining"] },
		];
		const result = run(input);
		expect(
			result.sensitivity.rows.map((row) => [
				row.id,
				row.includedPackages,
				row.current,
				row.prior,
				row.net,
				row.percentChange,
			]),
		).toEqual([
			["all", 3, 1114, 714, 400, 56.022409],
			["without-large", 2, 114, 214, -100, -46.728972],
			["without-two", 1, 14, 14, 0, 0],
		]);
		expect(result.sensitivity.packageDeltas).toContainEqual({
			package: "@example/large",
			net: 500,
		});
		expect(result.sensitivity.packageDeltas).toContainEqual({
			package: "@example/declining",
			net: -100,
		});
	});

	it("returns null percent for a measured zero prior", () => {
		const input = fixture();
		for (const row of input.captures.get("downloads").body.downloads) {
			if (row.day >= "2026-08-16" && row.day <= "2026-08-22") row.downloads = 0;
		}
		expect(run(input).sensitivity.rows[0]).toMatchObject({
			prior: 0,
			net: 14,
			percentChange: null,
		});
	});

	it.each(
		["@example/large", "@example/declining"].flatMap((name, index) =>
			["unacquired", "missing current day", "missing prior day", "valid zero"].map((fault) => [
				name,
				`extra-${index}`,
				fault,
			]),
		),
	)("distinguishes %s %s %s from measured zero", (name, id, fault) => {
		const input = fixture();
		const c = addPackage(input, name, id);
		if (fault === "unacquired") drop(input, `range-${id}`);
		else if (fault !== "valid zero") {
			const missing = fault === "missing current day" ? "2026-08-23" : "2026-08-16";
			c.body.downloads = c.body.downloads.filter((row) => row.day !== missing);
		}
		const result = run(input).sensitivity;
		expect(result.rows[0].net).not.toBeNull();
		expect(result.packageDeltas.find((pkg) => pkg.package === name).net).toBe(
			fault === "valid zero" ? 0 : null,
		);
		expect(result.rows[0].unavailablePackages).toEqual(fault === "valid zero" ? [] : [name]);
	});
});

describe("manifest and resource boundaries", () => {
	it("bounds the package/window date cross-product before expanding missing dates", () => {
		const input = fixture();
		const window = (id, start) => ({
			id,
			start,
			end: new Date(Date.parse(`${start}T00:00:00Z`) + 3659 * 86_400_000)
				.toISOString()
				.slice(0, 10),
		});
		input.manifest.windows = [window(PREVIOUS, "2000-01-01"), window(CURRENT, "2011-01-01")];
		input.captures.get("downloads").body.downloads = [];
		for (let n = 0; n < 34; n++) addPackage(input, `@example/p${n}`, `p${n}`).body.downloads = [];
		expect(() => run(input)).toThrow(/assessment date limit/);
	}, 15_000);

	it.each([
		[
			"schema version",
			(m) => {
				m.schemaVersion = 2;
			},
		],
		[
			"schema type",
			(m) => {
				m.schemaVersion = "1";
			},
		],
		[
			"extra field",
			(m) => {
				m.interpretation = "sensitive-marker";
			},
		],
		[
			"mapping metadata",
			(m) => {
				m.packages[0].evidence = "sensitive-marker";
			},
		],
		[
			"package value",
			(m) => {
				m.packages[0].name = "<script>";
			},
		],
		[
			"manifest identity",
			(m) => {
				m.packages[0].manifestId = 7;
			},
		],
		[
			"legacy target",
			(m) => {
				m.packages[0].legacyFor = NAME;
			},
		],
		[
			"duplicate package",
			(m) => {
				m.packages.push(structuredClone(m.packages[0]));
			},
		],
		[
			"duplicate window",
			(m) => {
				m.windows.push(structuredClone(m.windows[0]));
			},
		],
		[
			"unknown core",
			(m) => {
				m.corePackage = "other";
			},
		],
		[
			"unknown capture",
			(m) => {
				m.packages[0].captures.downloads = "absent";
			},
		],
		[
			"duplicate cutoff package",
			(m) => {
				m.cutoffControls[2].package = "openclaw";
			},
		],
		[
			"invalid exclusion value",
			(m) => {
				m.comparison.groups[0].exclude = [3];
			},
		],
		[
			"duplicate exclusions",
			(m) => {
				m.comparison.groups[0].exclude = [NAME, NAME];
			},
		],
		[
			"invalid telemetry format",
			(m) => {
				m.telemetry.format = "auto";
			},
		],
		[
			"invalid analysis timestamp",
			(m) => {
				m.analysisAt = "2026-02-30T00:00:00Z";
			},
		],
	])("rejects %s at the manifest boundary", (_name, mutate) => {
		const input = fixture();
		mutate(input.manifest);
		expect(() => run(input)).toThrow();
	});

	it.each([
		[
			"traversal",
			(m) => {
				m.files[0].file = "../capture.json";
			},
			/traversal/,
		],
		[
			"absolute input",
			(m, f) => {
				m.files[0].file = join(f.dir, "capture.json");
			},
			/relative file/,
		],
		[
			"backslash",
			(m) => {
				m.files[0].file = "nested\\capture.json";
			},
			/traversal/,
		],
		[
			"digest type",
			(m) => {
				m.files[0].sha256 = {};
			},
			/digest/,
		],
		[
			"digest mismatch",
			(m) => {
				m.files[0].sha256 = "0".repeat(64);
			},
			/digest mismatch/,
		],
		[
			"size mismatch",
			(m) => {
				m.files[0].bytes++;
			},
			/size mismatch/,
		],
		[
			"nonnumeric bytes",
			(m) => {
				m.files[0].bytes = "12";
			},
			/safe integer/,
		],
		[
			"duplicate path",
			(m) => {
				m.files[0].file = m.files[1].file;
			},
			/duplicate/,
		],
		[
			"unreferenced input",
			(m) => {
				m.files.push({ id: "unused", file: "unused.json", bytes: 2, sha256: digest("{}") });
			},
			/unreferenced/,
		],
		[
			"per-file bytes",
			(m) => {
				m.files[0].bytes = 4 * 1024 * 1024 + 1;
			},
			/byte limit/,
		],
		[
			"aggregate bytes",
			(m) => {
				for (const file of m.files) file.bytes = 4 * 1024 * 1024;
			},
			/total input byte limit/,
		],
		[
			"file count",
			(m) => {
				m.files = Array(1025).fill(m.files[0]);
			},
			/array length/,
		],
		[
			"package count",
			(m) => {
				m.packages = Array(513).fill(m.packages[0]);
			},
			/array length/,
		],
		[
			"window count",
			(m) => {
				m.windows = Array(17).fill(m.windows[0]);
			},
			/array length/,
		],
	])("fails closed for %s before output creation", (_name, mutate, message) => {
		const files = save();
		rewriteManifest(files, (m) => mutate(m, files));
		expect(() => runNpmQuality(files)).toThrow(message);
		expect(readdirSync(files.dir)).toEqual(["archive"]);
	});

	it("bounds actual input bytes even when the claimed size is small", () => {
		const files = save();
		writeFileSync(join(files.archive, "downloads.json"), Buffer.alloc(4 * 1024 * 1024 + 1, 32));
		expect(() => runNpmQuality(files)).toThrow(/byte limit/);
		writeFileSync(files.manifest, Buffer.alloc(1024 * 1024 + 1, 32));
		expect(() => runNpmQuality(files)).toThrow(/byte limit/);
	});

	it("bounds per-series, per-version, and aggregate observation counts", () => {
		const seriesInput = fixture();
		seriesInput.captures.get("downloads").body.downloads = Array(3661).fill({
			day: "2026-08-02",
			downloads: 0,
		});
		expect(first(seriesInput).series.status).toBe("invalid");
		const versionsInput = fixture();
		versionsInput.captures.get("versions").body.downloads = Object.fromEntries(
			Array.from({ length: 20_001 }, (_, index) => [`1.0.${index}`, 0]),
		);
		expect(run(versionsInput).versionSnapshots[0].status).toBe("invalid");
		const aggregate = fixture();
		drop(aggregate, "versions");
		for (let index = 0; index < 13; index++) {
			const name = `@example/p${index}`;
			addPackage(aggregate, name, `p${index}`);
			const id = `versions-${index}`;
			aggregate.manifest.packages.at(-1).captures.versions = id;
			aggregate.captures.set(
				id,
				capture(`https://api.npmjs.org/versions/${encodeURIComponent(name)}/last-week`, {
					package: name,
					downloads: Object.fromEntries(Array.from({ length: 20_000 }, (_, n) => [`1.0.${n}`, 0])),
				}),
			);
		}
		expect(() => run(aggregate)).toThrow(/aggregate record limit/);
	}, 15_000);

	it("rejects malformed JSON and invalid UTF-8 without copying source bytes into errors", () => {
		const files = save();
		writeFileSync(files.manifest, '{"sensitive-marker":broken');
		expect(() => runNpmQuality(files)).toThrow(/^input is not valid UTF-8 JSON$/);
		writeFileSync(files.manifest, Buffer.from([0xff]));
		expect(() => runNpmQuality(files)).toThrow(/^input is not valid UTF-8 JSON$/);
	});
});

describe("offline filesystem and CLI contract", () => {
	it("writes exact-byte digests and exclusive private outputs without network access", () => {
		const files = save();
		const forbidden = vi.fn(() => {
			throw new Error("network forbidden");
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(forbidden);
		vi.spyOn(http, "request").mockImplementation(forbidden);
		vi.spyOn(http, "get").mockImplementation(forbidden);
		vi.spyOn(https, "request").mockImplementation(forbidden);
		vi.spyOn(https, "get").mockImplementation(forbidden);
		vi.spyOn(net.Socket.prototype, "connect").mockImplementation(forbidden);
		runNpmQuality(files);
		expect(forbidden).not.toHaveBeenCalled();
		const names = readdirSync(files.output).sort();
		expect(names).toEqual(["input-hashes.json", "quality.json", "quality.md"]);
		expect(statSync(files.output).mode & 0o777).toBe(0o700);
		for (const name of names) expect(statSync(join(files.output, name)).mode & 0o777).toBe(0o600);
		const hashes = JSON.parse(readFileSync(join(files.output, "input-hashes.json")));
		expect(hashes.manifest.savedFileSha256).toBe(digest(readFileSync(files.manifest)));
		const registry = hashes.inputs.find((entry) => entry.id === "registry");
		expect(registry.savedFileSha256).toBe(
			digest(readFileSync(join(files.archive, "registry.json"))),
		);
		expect(registry.savedFileSha256).not.toBe(registry.recordedHttpResponseSha256);
		expect(registry.httpResponseHashRecomputed).toBe(false);
		expect(json(hashes)).not.toContain(files.dir);
		const before = names.map((name) => digest(readFileSync(join(files.output, name))));
		expect(() => runNpmQuality(files)).toThrow(/already exists/);
		expect(names.map((name) => digest(readFileSync(join(files.output, name))))).toEqual(before);
	});

	it.each(["manifest", "capture", "input parent", "output parent", "output"])(
		"rejects a symlink at the %s boundary",
		(kind) => {
			const files = save();
			if (kind === "manifest") {
				symlinkSync(files.manifest, join(files.archive, "manifest-link.json"));
				files.manifest = join(files.archive, "manifest-link.json");
			} else if (kind === "capture") {
				symlinkSync(
					join(files.archive, "downloads.json"),
					join(files.archive, "capture-link.json"),
				);
				rewriteManifest(files, (m) => {
					m.files.find((f) => f.id === "downloads").file = "capture-link.json";
				});
			} else if (kind === "input parent") {
				symlinkSync(files.archive, join(files.archive, "nested"));
				rewriteManifest(files, (m) => {
					m.files.find((f) => f.id === "downloads").file = "nested/downloads.json";
				});
			} else if (kind === "output parent") {
				symlinkSync(files.dir, join(files.dir, "linked"));
				files.output = join(files.dir, "linked", "result");
			} else symlinkSync(files.archive, files.output);
			expect(() => runNpmQuality(files)).toThrow(/symlink|already exists/);
			expect(readdirSync(files.archive)).not.toContain("quality.json");
		},
	);

	it("rejects output inside the input archive and missing or non-file inputs", () => {
		const files = save();
		expect(() => runNpmQuality({ ...files, output: join(files.archive, "result") })).toThrow(
			/outside/,
		);
		expect(() => runNpmQuality({ ...files, manifest: files.archive })).toThrow(/regular/);
		expect(() => runNpmQuality({ ...files, manifest: join(files.archive, "absent.json") })).toThrow(
			/missing/,
		);
		expect(() => runNpmQuality({ ...files, output: join(files.dir, "missing", "result") })).toThrow(
			/missing/,
		);
	});

	it("projects approved metadata only and rejects freeform recorded hashes", () => {
		const input = fixture();
		const marker = "sensitive-marker";
		for (const value of input.captures.values()) {
			value.headers = { private: marker };
			value.interpretation = marker;
			if (value.body) value.body.unused = marker;
		}
		input.captures.get("packaging").evidence[0].mappingEvidence = marker;
		input.captures.get("telemetry").window.extra = marker;
		const files = save(input);
		runNpmQuality(files);
		for (const file of readdirSync(files.output)) {
			const bytes = readFileSync(join(files.output, file), "utf8");
			expect(bytes).not.toContain(marker);
			expect(bytes).not.toContain(files.dir);
		}
		input.captures.get("downloads").responseSha256 = marker;
		expect(() => run(input)).toThrow(/recorded HTTP response digest/);
	});

	it("produces byte-identical artifacts on repeated analysis into distinct fresh directories", () => {
		const files = save();
		runNpmQuality(files);
		const other = join(files.dir, "second");
		runNpmQuality({ ...files, output: other });
		for (const file of readdirSync(files.output)) {
			expect(readFileSync(join(other, file))).toEqual(readFileSync(join(files.output, file)));
		}
	});

	it.each([[], ["--unknown"], ["--manifest", "manifest.json"]].map((args) => ({ args })))(
		"reports missing or unsupported CLI arguments: $args",
		({ args }) => {
			const result = cli(args);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/Usage:/);
			expect(result.stdout).toBe("");
		},
	);

	it("executes the real CLI, renders dated interpretation limits, and rejects reuse", () => {
		const files = save();
		const args = ["--manifest", files.manifest, "--output", files.output];
		const result = cli(args);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			status: "written",
			identities: 1,
			validDatedSeries: 1,
			registry404: 0,
			unacquiredSeries: 0,
		});
		expect(result.stderr).toBe("");
		const md = readFileSync(join(files.output, "quality.md"), "utf8");
		const header = md.slice(0, md.indexOf("| Group |"));
		expect(header).toMatch(/Current: 2026-08-23 through 2026-08-29 \(inclusive UTC dates\)/);
		expect(header).toMatch(/Prior: 2026-08-16 through 2026-08-22 \(inclusive UTC dates\)/);
		expect(header).toMatch(/2026-08-14: synchronized zero anomaly/);
		expect(header).toMatch(/unknown.*incomplete or contradictory/);
		expect(header).toMatch(/no_known_gap.*not complete events or a census/);
		const repeated = cli(args);
		expect(repeated.status).toBe(1);
		expect(repeated.stderr).toMatch(/already exists/);
		expect(repeated.stderr).not.toContain(files.dir);
	});
});
