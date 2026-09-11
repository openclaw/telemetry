import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { isTelemetryCheckoutPath, isWithinDirectory } from "./private-export-path.mjs";

const DAY = 86_400_000;
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const PUBLIC_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const REVISION = /^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/u;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/u;
const LIMIT = {
	manifestBytes: 1024 * 1024,
	fileBytes: 4 * 1024 * 1024,
	totalBytes: 32 * 1024 * 1024,
	files: 1024,
	packages: 512,
	windows: 16,
	controls: 16,
	days: 3660,
	versions: 20_000,
	records: 250_000,
	assessmentDates: 250_000,
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sorted = (values) => [...values].sort();
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
class QualityError extends Error {}
function requireValue(condition, message) {
	if (!condition) throw new QualityError(message);
}
function keys(value, allowed, required = allowed) {
	requireValue(object(value), "expected an object");
	requireValue(
		Object.keys(value).every((key) => allowed.includes(key)),
		"unsupported field",
	);
	requireValue(
		required.every((key) => Object.hasOwn(value, key)),
		"missing required field",
	);
}
function list(value, maximum, minimum = 0) {
	requireValue(
		Array.isArray(value) && value.length >= minimum && value.length <= maximum,
		"array length exceeds its allowed bounds",
	);
	return value;
}
function unique(values) {
	requireValue(new Set(values).size === values.length, "duplicate identity");
	return values;
}
function id(value) {
	requireValue(typeof value === "string" && ID.test(value), "invalid identifier");
	return value;
}
function packageName(value) {
	requireValue(
		typeof value === "string" && value.length <= 214 && PACKAGE.test(value),
		"invalid package identity",
	);
	return value;
}
function count(value) {
	requireValue(
		Number.isSafeInteger(value) && value >= 0,
		"count must be a nonnegative safe integer",
	);
	return value;
}
const sum = (values) => values.reduce((total, value) => count(total + count(value)), 0);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function date(value) {
	requireValue(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value), "invalid UTC date");
	const ms = Date.parse(`${value}T00:00:00Z`);
	requireValue(Number.isFinite(ms) && utcDay(ms) === value, "invalid calendar date");
	return ms;
}
function instant(value) {
	requireValue(typeof value === "string", "timestamp needs an explicit timezone");
	const match =
		/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(
			value,
		);
	requireValue(match, "timestamp needs an explicit timezone and millisecond-or-coarser precision");
	date(match[1]);
	requireValue(
		Number(match[2]) < 24 &&
			Number(match[3]) < 60 &&
			Number(match[4]) < 60 &&
			(match[5] === "Z" || (Number(match[6]) < 24 && Number(match[7]) < 60)),
		"invalid timestamp",
	);
	const ms = Date.parse(value);
	requireValue(Number.isFinite(ms), "invalid timestamp");
	return ms;
}
function windowBounds(window) {
	const start = date(window.start);
	const endExclusive = date(window.end) + DAY;
	const days = (endExclusive - start) / DAY;
	requireValue(days > 0 && days <= LIMIT.days, "window must contain 1..3660 UTC dates");
	const end = new Date(endExclusive).toISOString();
	requireValue(!end.startsWith("+"), "window endpoint out of range");
	return {
		start: window.start,
		end: window.end,
		startInclusive: new Date(start).toISOString(),
		endExclusive: end,
		days,
	};
}
function attempt(fn) {
	try {
		return fn();
	} catch (error) {
		if (!(error instanceof QualityError)) throw error;
		return { status: "invalid", issues: [error.message] };
	}
}
function noTraversal(path) {
	requireValue(
		typeof path === "string" &&
			path.length > 0 &&
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
function inputPath(root, path) {
	noTraversal(path);
	requireValue(
		!isAbsolute(path) &&
			path.split("/").every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(part)),
		"input path must be a plain relative file path",
	);
	const full = join(root, path);
	realDirectory(dirname(full));
	return full;
}
function readBytes(path, maximum, expected) {
	const before = lstatSync(path);
	requireValue(
		before.isFile() && !before.isSymbolicLink(),
		"input must be a regular non-symlink file",
	);
	requireValue(before.size <= maximum, "input byte limit exceeded");
	if (expected) requireValue(before.size === expected.bytes, "saved-file size mismatch");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(fd);
		requireValue(
			opened.isFile() &&
				opened.dev === before.dev &&
				opened.ino === before.ino &&
				opened.size === before.size,
			"input changed before reading",
		);
		// Read at most the declared size plus one; growth cannot cause an unbounded allocation.
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
			"input changed while reading",
		);
		const bytes = buffer.subarray(0, used);
		if (expected) requireValue(hash(bytes) === expected.sha256, "saved-file digest mismatch");
		return bytes;
	} finally {
		closeSync(fd);
	}
}
function parseJson(bytes) {
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new QualityError("input is not valid UTF-8 JSON");
	}
}
function validateManifest(manifest) {
	keys(manifest, [
		"schemaVersion",
		"analysisAt",
		"corePackage",
		"windows",
		"comparison",
		"files",
		"packages",
		"cutoffControls",
		"anomalyProbes",
		"pointProbes",
		"packaging",
		"telemetry",
	]);
	requireValue(manifest.schemaVersion === 1, "unsupported manifest schemaVersion");
	instant(manifest.analysisAt);
	const fileIds = new Set();
	const paths = new Set();
	let totalBytes = 0;
	for (const file of list(manifest.files, LIMIT.files, 1)) {
		keys(file, ["id", "file", "bytes", "sha256"]);
		id(file.id);
		requireValue(
			!fileIds.has(file.id) && !paths.has(file.file),
			"duplicate input identity or path",
		);
		fileIds.add(file.id);
		paths.add(file.file);
		noTraversal(file.file);
		requireValue(
			typeof file.sha256 === "string" && SHA.test(file.sha256),
			"invalid saved-file digest",
		);
		requireValue(count(file.bytes) <= LIMIT.fileBytes, "input byte limit exceeded");
		totalBytes += file.bytes;
	}
	requireValue(totalBytes <= LIMIT.totalBytes, "total input byte limit exceeded");
	const referenced = new Set();
	const reference = (value, optional = false) => {
		if (optional && value === null) return;
		id(value);
		requireValue(fileIds.has(value), "unknown capture reference");
		referenced.add(value);
	};
	const windows = new Map();
	for (const window of list(manifest.windows, LIMIT.windows, 1)) {
		keys(window, ["id", "start", "end"]);
		id(window.id);
		requireValue(!windows.has(window.id), "duplicate window identity");
		windows.set(window.id, windowBounds(window));
	}
	const names = new Set();
	for (const pkg of list(manifest.packages, LIMIT.packages, 1)) {
		keys(pkg, ["name", "manifestId", "legacyFor", "captures"]);
		packageName(pkg.name);
		requireValue(!names.has(pkg.name), "duplicate package identity");
		names.add(pkg.name);
		requireValue(
			pkg.manifestId === null ||
				(typeof pkg.manifestId === "string" && PUBLIC_ID.test(pkg.manifestId)),
			"invalid public manifest identity",
		);
		if (pkg.legacyFor !== null) {
			packageName(pkg.legacyFor);
			requireValue(pkg.legacyFor !== pkg.name, "legacy relationship must name a different package");
		}
		keys(pkg.captures, ["downloads", "registry", "versions"]);
		for (const value of Object.values(pkg.captures)) reference(value, true);
	}
	if (manifest.corePackage !== null) {
		packageName(manifest.corePackage);
		requireValue(names.has(manifest.corePackage), "core package is absent from inventory");
	}
	// Missing dates are synthesized output, so input record bounds alone do not bound this work.
	requireValue(
		manifest.packages.length * sum([...windows.values()].map((window) => window.days)) <=
			LIMIT.assessmentDates,
		"assessment date limit exceeded",
	);
	const comparison = manifest.comparison;
	keys(comparison, ["current", "previous", "baseExclusions", "groups"]);
	requireValue(
		windows.has(comparison.current) &&
			windows.has(comparison.previous) &&
			comparison.current !== comparison.previous,
		"comparison must name two different windows",
	);
	const current = windows.get(comparison.current);
	const previous = windows.get(comparison.previous);
	requireValue(
		current.days === previous.days && previous.end < current.start,
		"comparison windows must be equal length, ordered, and nonoverlapping",
	);
	const exclusions = (values) =>
		unique(
			list(values, LIMIT.packages).map((name) => {
				packageName(name);
				requireValue(names.has(name), "excluded package is absent from inventory");
				return name;
			}),
		);
	exclusions(comparison.baseExclusions);
	unique(
		list(comparison.groups, LIMIT.controls, 1).map((group) => {
			keys(group, ["id", "exclude"]);
			exclusions(group.exclude);
			requireValue(
				group.exclude.every((name) => !comparison.baseExclusions.includes(name)),
				"group exclusions repeat a base exclusion",
			);
			return id(group.id);
		}),
	);
	unique(
		list(manifest.cutoffControls, LIMIT.controls, 1).map((control) => {
			keys(control, ["id", "package", "capture"]);
			if (control.package !== null) packageName(control.package);
			reference(control.capture, true);
			return id(control.id);
		}),
	);
	requireValue(
		new Set(manifest.cutoffControls.map((control) => control.package)).size ===
			manifest.cutoffControls.length,
		"duplicate cutoff control package",
	);
	unique(
		list(manifest.anomalyProbes, LIMIT.controls).map((probe) => {
			keys(probe, ["day", "capture"]);
			date(probe.day);
			reference(probe.capture, true);
			return probe.day;
		}),
	);
	unique(
		list(manifest.pointProbes, LIMIT.controls).map((probe) => {
			keys(probe, ["id", "package", "day", "capture"]);
			if (probe.package !== null) packageName(probe.package);
			date(probe.day);
			reference(probe.capture, true);
			return id(probe.id);
		}),
	);
	reference(manifest.packaging, true);
	if (manifest.telemetry !== null) {
		keys(manifest.telemetry, ["format", "capture"]);
		requireValue(
			["public-stats", "query-window"].includes(manifest.telemetry.format),
			"unsupported telemetry capture format",
		);
		reference(manifest.telemetry.capture);
	}
	requireValue(referenced.size === fileIds.size, "unreferenced input file");
	return windows;
}
function envelope(capture, origin, pathname, analysisAt, statuses = [200]) {
	requireValue(object(capture), "capture unacquired");
	let url;
	try {
		url = new URL(capture.url);
	} catch {
		throw new QualityError("capture URL mismatch");
	}
	let path;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		throw new QualityError("capture URL mismatch");
	}
	requireValue(
		url.origin === origin &&
			path === pathname &&
			!url.search &&
			!url.hash &&
			!url.username &&
			!url.password,
		"capture URL mismatch",
	);
	requireValue(statuses.includes(capture.status), "capture HTTP status is not usable");
	requireValue(instant(capture.fetchedAt) <= instant(analysisAt), "capture is newer than analysis");
	requireValue(object(capture.body), "capture body must be an object");
	return capture.body;
}
function point(capture, pkg, period, analysisAt) {
	const body = envelope(
		capture,
		"https://api.npmjs.org",
		`/downloads/point/${period}${pkg ? `/${pkg}` : ""}`,
		analysisAt,
	);
	requireValue(pkg ? body.package === pkg : body.package === undefined, "point package mismatch");
	date(body.start);
	requireValue(
		body.start === body.end && (period === "last-day" || body.start === period),
		"point bounds mismatch",
	);
	count(body.downloads);
	return { start: body.start, end: body.end, downloads: body.downloads };
}
function cutoffs(manifest, captures) {
	const surfaces = [...manifest.cutoffControls]
		.sort((a, b) => compare(a.id, b.id))
		.map((control) => ({
			id: control.id,
			package: control.package,
			...attempt(() => {
				const capture = captures.get(control.capture);
				const body = point(capture, control.package, "last-day", manifest.analysisAt);
				const captureDay = utcDay(instant(capture.fetchedAt));
				const expected = utcDay(date(captureDay) - DAY);
				const lag = (date(expected) - date(body.end)) / DAY;
				requireValue(lag >= 0, "cutoff is beyond its captured last complete UTC day");
				return {
					status: "known",
					evidenceCapturedAt: capture.fetchedAt,
					captureDay,
					expectedLastCompleteUTCday: expected,
					returnedCutoff: body.end,
					lagCompleteUTCdays: lag,
				};
			}),
		}));
	const known =
		surfaces.every((entry) => entry.status === "known") &&
		new Set(surfaces.map((entry) => entry.returnedCutoff)).size === 1 &&
		new Set(surfaces.map((entry) => entry.captureDay)).size === 1;
	return {
		status: known ? "known" : "unknown",
		blocked: !known,
		surfaces,
		binding: "Only the manifest's cutoff controls apply to its captured dated series",
		analysisExpectedLastCompleteUTCday: utcDay(date(utcDay(instant(manifest.analysisAt))) - DAY),
		returnedCutoff: known ? surfaces[0].returnedCutoff : null,
		captureDay: known ? surfaces[0].captureDay : null,
		lagCompleteUTCdays: known ? surfaces[0].lagCompleteUTCdays : null,
	};
}
function series(capture, pkg, analysisAt, records) {
	if (!capture) return { status: "unacquired", issues: ["dated series unacquired, not zero"] };
	return attempt(() => {
		const body = capture.body;
		requireValue(object(body), "series body must be an object");
		const bounds = windowBounds(body);
		envelope(
			capture,
			"https://api.npmjs.org",
			`/downloads/range/${body.start}:${body.end}/${pkg}`,
			analysisAt,
		);
		requireValue(body.package === pkg, "series package mismatch");
		requireValue(Array.isArray(body.downloads), "downloads must be a dated array");
		records(list(body.downloads, LIMIT.days).length);
		const values = new Map();
		for (const row of body.downloads) {
			requireValue(object(row), "invalid dated row");
			date(row.day);
			requireValue(row.day >= body.start && row.day <= body.end, "row outside returned bounds");
			requireValue(!values.has(row.day), "duplicate dated row");
			values.set(row.day, count(row.downloads));
		}
		return { status: "valid", bounds, values, capturedAt: capture.fetchedAt, issues: [] };
	});
}
function publication(capture, pkg, analysisAt, records) {
	if (!capture) return { status: "unacquired", firstPublication: null };
	return attempt(() => {
		const body = envelope(capture, "https://registry.npmjs.org", `/${pkg}`, analysisAt, [200, 404]);
		if (capture.status === 404) return { status: "registry_404", firstPublication: null };
		requireValue(body.name === pkg && object(body.time), "registry name/time mismatch");
		const versions = Object.entries(body.time).filter(
			([version]) => !["created", "modified"].includes(version),
		);
		records(list(versions, LIMIT.versions, 1).length);
		for (const [version, at] of versions) {
			requireValue(
				VERSION.test(version) && instant(at) <= instant(capture.fetchedAt),
				"invalid version publication timestamp or identifier",
			);
		}
		versions.sort((a, b) => instant(a[1]) - instant(b[1]) || compare(a[0], b[0]));
		return {
			status: "valid",
			evidenceCapturedAt: capture.fetchedAt,
			firstPublication: { version: versions[0][0], at: versions[0][1] },
			meaning:
				"Earliest recorded version timestamp, including placeholders; not product availability",
		};
	});
}
function packagingEvidence(capture, analysisAt, records) {
	if (!capture) return { status: "unacquired", sources: [] };
	return attempt(() => {
		requireValue(
			object(capture) && instant(capture.capturedAt) <= instant(analysisAt),
			"packaging capture timestamp is invalid",
		);
		const evidence = list(capture.evidence, 64, 1);
		records(evidence.length);
		const sources = evidence.map((entry) => {
			requireValue(
				object(entry) &&
					typeof entry.revision === "string" &&
					REVISION.test(entry.revision) &&
					entry.revision.length <= 128 &&
					typeof entry.responseSha256 === "string" &&
					SHA.test(entry.responseSha256) &&
					entry.url ===
						`https://raw.githubusercontent.com/openclaw/openclaw/${entry.revision}/package.json`,
				"invalid public packaging source",
			);
			const excluded = unique(
				list(entry.excludedExtensions, LIMIT.packages).map((name) => {
					requireValue(
						typeof name === "string" && PUBLIC_ID.test(name),
						"invalid excluded manifest identity",
					);
					return name;
				}),
			);
			const inclusions = unique(
				list(entry.distInclusions, 16).map((path) => {
					requireValue(path === "dist/" || path === "dist", "unsupported dist inclusion");
					return path;
				}),
			);
			records(excluded.length + inclusions.length);
			return {
				revision: entry.revision,
				recordedHttpResponseSha256: entry.responseSha256,
				excludedExtensions: sorted(excluded),
				distInclusions: sorted(inclusions),
			};
		});
		unique(sources.map((source) => source.revision));
		return { status: "valid", sources: sources.sort((a, b) => compare(a.revision, b.revision)) };
	});
}
function cohort(pkg, packaging, corePackage) {
	let classification = "unknown";
	if (packaging.status === "valid") {
		if (corePackage === pkg.name) classification = "core_distribution";
		else if (pkg.legacyFor) classification = "legacy_relationship_not_current_equivalence";
		else if (pkg.manifestId) {
			const excluded = packaging.sources.filter((entry) =>
				entry.excludedExtensions.includes(pkg.manifestId),
			).length;
			classification =
				excluded === packaging.sources.length
					? "external_in_inspected_source_declarations"
					: excluded > 0
						? "mixed_inspected_source_declarations"
						: "bundling_unresolved";
		}
	}
	return {
		classification,
		manifestId: pkg.manifestId,
		legacyFor: pkg.legacyFor,
		mappingBasis: "Operator-declared public mapping; not independently verified by this tool",
		confidence: packaging.status === "valid" ? "captured_declarative_source_only" : "unknown",
		actualTarballsInspected: false,
		historicalPackagingUncertainty: true,
	};
}
function exposure(first, bounds) {
	if (!first) return null;
	const start = Math.max(instant(first.at), instant(bounds.startInclusive));
	const end = instant(bounds.endExclusive);
	return start >= end ? 0 : (end - date(utcDay(start))) / DAY;
}
function anomalies(manifest, captures, valid, cutoff) {
	const probes = [...manifest.anomalyProbes]
		.sort((a, b) => compare(a.day, b.day))
		.map((probe) => ({
			day: probe.day,
			...attempt(() => {
				const capture = captures.get(probe.capture);
				const zero = point(capture, null, probe.day, manifest.analysisAt);
				requireValue(valid.length > 0, "no valid dated-series evidence");
				const available =
					cutoff.status === "known" &&
					probe.day <= cutoff.returnedCutoff &&
					utcDay(instant(capture.fetchedAt)) === cutoff.captureDay &&
					valid.every((entry) => utcDay(instant(entry.capturedAt)) === cutoff.captureDay);
				if (!available) {
					return {
						status: "unknown",
						issues: ["Probe or dated series is not bound to the available captured cutoff"],
					};
				}
				if (zero.downloads === 0 && !valid.every((entry) => entry.values.get(probe.day) === 0)) {
					return {
						status: "unknown",
						issues: [
							"Global zero has positive or missing package-day evidence; contradiction or partial backfill is unresolved",
						],
					};
				}
				return {
					status: "assessed",
					synchronizedZero: zero.downloads === 0,
					zeroSeries: zero.downloads === 0 ? valid.length : 0,
				};
			}),
		}));
	return {
		status:
			probes.length && probes.every((probe) => probe.status === "assessed")
				? "assessed"
				: "unknown",
		probes,
		gaps: probes
			.filter((probe) => probe.synchronizedZero)
			.map((probe) => ({
				day: probe.day,
				zeroSeries: probe.zeroSeries,
				globalDownloads: 0,
				interpretation: "Synchronized zero anomaly; source-ingestion cause unproved",
			})),
	};
}
function assessWindow(parsed, bounds, cutoff, anomaly) {
	const initial = {
		bounds,
		dateCoverageComplete: false,
		availability: parsed.status,
		eventQuality: "unknown",
		completeEventClaimAllowed: false,
		rawObservedSum: null,
		observedSum: null,
		missingDates: [],
		knownGapDates: [],
		issues: parsed.issues ?? [],
	};
	if (parsed.status !== "valid") return initial;
	const evaluated = attempt(() => {
		const wanted = [];
		for (let ms = instant(bounds.startInclusive); ms < instant(bounds.endExclusive); ms += DAY)
			wanted.push(utcDay(ms));
		const missing = wanted.filter((day) => !parsed.values.has(day));
		const rawObservedSum = sum(
			wanted.filter((day) => parsed.values.has(day)).map((day) => parsed.values.get(day)),
		);
		const bound =
			cutoff.status === "known" && utcDay(instant(parsed.capturedAt)) === cutoff.captureDay;
		const availability = !bound
			? "unknown"
			: bounds.end > cutoff.returnedCutoff
				? "unavailable"
				: "available";
		const gaps = anomaly.gaps.filter((gap) => wanted.includes(gap.day)).map((gap) => gap.day);
		return {
			status: "evaluated",
			dateCoverageComplete: missing.length === 0,
			availability,
			rawObservedSum,
			observedSum: availability === "available" ? rawObservedSum : null,
			missingDates: missing,
			knownGapDates: gaps,
			eventQuality: gaps.length
				? "known_gap"
				: missing.length === 0 && availability === "available" && anomaly.status === "assessed"
					? "no_known_gap"
					: "unknown",
			issues: [
				...(missing.length ? ["missing dates"] : []),
				...(!bound ? ["cutoff unknown or snapshot capture date mismatch"] : []),
				...(availability === "unavailable"
					? ["after captured cutoff: zeros are unavailable, not demand zero"]
					: []),
			],
		};
	});
	return {
		...initial,
		...evaluated,
		...(evaluated.status === "invalid" ? { availability: "invalid" } : {}),
	};
}
function versionSnapshot(capture, pkg, analysisAt, records) {
	return {
		package: pkg,
		...attempt(() => {
			const body = envelope(
				capture,
				"https://api.npmjs.org",
				`/versions/${pkg}/last-week`,
				analysisAt,
			);
			requireValue(
				body.package === pkg && object(body.downloads),
				"version package/downloads mismatch",
			);
			const entries = Object.entries(body.downloads);
			records(list(entries, LIMIT.versions).length);
			requireValue(
				entries.every(([version]) => VERSION.test(version)),
				"invalid version identifier",
			);
			const total = sum(entries.map(([, value]) => value));
			let bounds = null;
			if (body.start !== undefined || body.end !== undefined) bounds = windowBounds(body);
			return {
				status: "valid",
				evidenceCapturedAt: capture.fetchedAt,
				httpStatus: capture.status,
				nominalPeriod: "previous seven days",
				bounds,
				boundsStatus: bounds ? "returned" : "unknown_not_returned",
				observedSum: total,
				versions: Object.fromEntries(entries.sort(([a], [b]) => compare(a, b))),
				keptSeparateFromDatedSeries: true,
			};
		}),
	};
}
function telemetryWindow(spec, captures, analysisAt) {
	if (!spec) return { status: "unacquired" };
	return attempt(() => {
		const capture = captures.get(spec.capture);
		requireValue(object(capture), "telemetry capture unacquired");
		const publicResponse = spec.format === "public-stats";
		if (publicResponse)
			requireValue(
				capture.status === 200 && object(capture.body),
				"telemetry capture HTTP status or body is not usable",
			);
		const window = publicResponse
			? {
					startInclusive: capture.body.windowStart,
					endExclusive: capture.body.windowEnd,
				}
			: capture.window;
		const capturedAt = publicResponse ? capture.receivedAt : capture.queriedAt;
		requireValue(
			instant(capturedAt) <= instant(analysisAt),
			"telemetry capture is newer than analysis",
		);
		requireValue(object(window), "telemetry window unavailable");
		requireValue(
			instant(window.startInclusive) < instant(window.endExclusive),
			"invalid telemetry bounds",
		);
		const generatedAt = publicResponse ? (capture.body.generatedAt ?? null) : null;
		if (generatedAt !== null)
			requireValue(
				instant(generatedAt) <= instant(analysisAt),
				"telemetry generation timestamp is newer than analysis",
			);
		return {
			status: "valid",
			window: {
				startInclusive: window.startInclusive,
				endExclusive: window.endExclusive,
			},
			capturedAt,
			generatedAt,
		};
	});
}
function sensitivity(packages, comparison) {
	const eligible = (pkg) =>
		[comparison.current, comparison.previous].every((key) => {
			const window = pkg.windows[key];
			return window.dateCoverageComplete && window.observedSum !== null;
		});
	const rows = [...comparison.groups]
		.sort((a, b) => compare(a.id, b.id))
		.map((group) => {
			const excluded = new Set([...comparison.baseExclusions, ...group.exclude]);
			const candidates = packages.filter((pkg) => !excluded.has(pkg.name));
			const included = candidates.filter(eligible);
			const current = sum(included.map((pkg) => pkg.windows[comparison.current].observedSum));
			const prior = sum(included.map((pkg) => pkg.windows[comparison.previous].observedSum));
			const delta = current - prior;
			return {
				id: group.id,
				excluded: sorted(group.exclude),
				includedPackages: included.length,
				unavailablePackages: candidates.filter((pkg) => !eligible(pkg)).map((pkg) => pkg.name),
				current: included.length ? current : null,
				prior: included.length ? prior : null,
				net: included.length ? delta : null,
				percentChange:
					included.length && prior !== 0 ? Number(((delta / prior) * 100).toFixed(6)) : null,
				eventQuality: Object.fromEntries(
					[comparison.current, comparison.previous].map((key) => {
						const states = included.map((pkg) => pkg.windows[key].eventQuality);
						return [
							key,
							states.includes("known_gap")
								? "known_gap"
								: !states.length || states.includes("unknown")
									? "unknown"
									: "no_known_gap",
						];
					}),
				),
			};
		});
	return {
		currentWindow: comparison.current,
		previousWindow: comparison.previous,
		baseExclusions: sorted(comparison.baseExclusions),
		units:
			"Distribution events and net arithmetic, not usage, adoption, users, breadth of growth, or causal attribution",
		rows,
		packageDeltas: packages
			.filter((pkg) => !comparison.baseExclusions.includes(pkg.name))
			.map((pkg) => ({
				package: pkg.name,
				net: eligible(pkg)
					? pkg.windows[comparison.current].observedSum -
						pkg.windows[comparison.previous].observedSum
					: null,
			})),
	};
}
function analyze(manifest, captures, windows, snapshotId) {
	let recordCount = 0;
	const records = (n) => {
		recordCount += n;
		requireValue(recordCount <= LIMIT.records, "aggregate record limit exceeded");
	};
	const cutoff = cutoffs(manifest, captures);
	const inventory = [...manifest.packages].sort((a, b) => compare(a.name, b.name));
	const parsed = new Map(
		inventory.map((pkg) => [
			pkg.name,
			series(captures.get(pkg.captures.downloads), pkg.name, manifest.analysisAt, records),
		]),
	);
	const valid = [...parsed.values()].filter((entry) => entry.status === "valid");
	const anomaly = anomalies(manifest, captures, valid, cutoff);
	const packaging = packagingEvidence(
		captures.get(manifest.packaging),
		manifest.analysisAt,
		records,
	);
	const requestedWindows = Object.fromEntries([...windows].sort(([a], [b]) => compare(a, b)));
	const packages = inventory.map((pkg) => {
		const registry = publication(
			captures.get(pkg.captures.registry),
			pkg.name,
			manifest.analysisAt,
			records,
		);
		const parsedSeries = parsed.get(pkg.name);
		return {
			name: pkg.name,
			registry,
			series: {
				status: parsedSeries.status,
				issues: parsedSeries.issues,
				returnedBounds: parsedSeries.bounds ?? null,
				evidenceCapturedAt: parsedSeries.capturedAt ?? null,
			},
			cohort: cohort(pkg, packaging, manifest.corePackage),
			windows: Object.fromEntries(
				Object.entries(requestedWindows).map(([key, bounds]) => [
					key,
					{
						...assessWindow(parsedSeries, bounds, cutoff, anomaly),
						publicationExposureUTCDates: exposure(registry.firstPublication, bounds),
						publicationExposureMeaning:
							"Intersecting UTC dates including partial publication day; not elapsed full days or availability",
					},
				]),
			),
		};
	});
	const telemetry = telemetryWindow(manifest.telemetry, captures, manifest.analysisAt);
	const versionSnapshots = inventory
		.filter((pkg) => pkg.captures.versions !== null)
		.map((pkg) =>
			versionSnapshot(captures.get(pkg.captures.versions), pkg.name, manifest.analysisAt, records),
		);
	requireValue(recordCount <= LIMIT.records, "aggregate record limit exceeded");
	return {
		schemaVersion: 1,
		analysisAt: manifest.analysisAt,
		snapshotId,
		scope: "Offline npm distribution quality; no collector or network",
		summary: {
			identities: inventory.length,
			validDatedSeries: valid.length,
			registry404: packages.filter((pkg) => pkg.registry.status === "registry_404").length,
			unacquiredSeries: packages.filter((pkg) => pkg.series.status === "unacquired").length,
		},
		cutoff,
		anomaly,
		packaging,
		requestedWindows,
		packages,
		versionSnapshots,
		pointProbes: [...manifest.pointProbes]
			.sort((a, b) => compare(a.id, b.id))
			.map((probe) => ({
				id: probe.id,
				package: probe.package,
				...attempt(() => {
					const capture = captures.get(probe.capture);
					const body = point(capture, probe.package, probe.day, manifest.analysisAt);
					const bound =
						cutoff.status === "known" && utcDay(instant(capture.fetchedAt)) === cutoff.captureDay;
					return {
						status: "observed",
						day: probe.day,
						reportedDownloads: body.downloads,
						availability: !bound
							? "unknown"
							: probe.day > cutoff.returnedCutoff
								? "unavailable"
								: "available",
						meaning: "A reported zero beyond the captured cutoff is unavailable, not zero demand",
					};
				}),
			})),
		telemetryAlignment: {
			conversionAllowed: false,
			reason:
				"Different units and cohorts prohibit conversion even when UTC bounds match; aliases are not deduplicated users",
			source: "Saved telemetry snapshot only, not a live-current read",
			windows: Object.fromEntries(
				Object.entries(requestedWindows).map(([key, bounds]) => [
					key,
					telemetry.status !== "valid"
						? telemetry
						: {
								status: "compared",
								exactUTCInstantsMatch:
									instant(bounds.startInclusive) === instant(telemetry.window.startInclusive) &&
									instant(bounds.endExclusive) === instant(telemetry.window.endExclusive),
								telemetryWindow: telemetry.window,
								telemetryCapturedAt: telemetry.capturedAt,
								telemetryGeneratedAt: telemetry.generatedAt,
							},
				]),
			),
		},
		sensitivity: sensitivity(packages, manifest.comparison),
		limitations: [
			"No imputation or extrapolation",
			"no_known_gap does not certify complete events or a census",
			"Calendar coverage and event quality are independent",
			"Saved-file digests do not reproduce HTTP wire hashes of projected captures",
			"Historical packaging and legacy relationships remain uncertain; source declarations are not tarball inspection",
			"Core and plugin distribution cohorts need not overlap telemetry reporters",
		],
	};
}
function markdown(quality) {
	const current = quality.requestedWindows[quality.sensitivity.currentWindow];
	const prior = quality.requestedWindows[quality.sensitivity.previousWindow];
	const dates = (window) => `${window.start} through ${window.end} (inclusive UTC dates)`;
	const lines = [
		"# npm distribution quality",
		"",
		`Analysis: ${quality.analysisAt}`,
		`Snapshot: ${quality.snapshotId}`,
		"",
		`${quality.summary.validDatedSeries}/${quality.summary.identities} valid dated series; ${quality.summary.registry404} registry 404s; ${quality.summary.unacquiredSeries} unacquired series (not zeros).`,
		`Captured cutoff: ${quality.cutoff.returnedCutoff ?? "unknown"}; lag: ${quality.cutoff.lagCompleteUTCdays ?? "unknown"} complete UTC days.`,
		"No imputation, extrapolation, census-completeness claim, or telemetry conversion.",
		"",
		...quality.anomaly.gaps.map(
			(gap) =>
				`${gap.day}: synchronized zero anomaly across ${gap.zeroSeries} dated package series and the global point response; source-ingestion cause unproved.`,
		),
		`Anomaly assessment: ${quality.anomaly.status}.`,
		"Event quality: known_gap flags an observed anomaly; unknown means evidence is incomplete or contradictory; no_known_gap means no detected gap in the assessed evidence, not complete events or a census.",
		"Calendar date coverage is separate from event quality.",
		"",
		"## Observed distribution sensitivity",
		"",
		`Current: ${dates(current)}.`,
		`Prior: ${dates(prior)}.`,
		`Base exclusions: ${quality.sensitivity.baseExclusions.join(", ") || "none"}.`,
		"",
		"| Group | Additional exclusions | Packages | Current | Prior | Net | Change % | Current / prior event quality |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
	];
	for (const row of quality.sensitivity.rows) {
		lines.push(
			`| ${row.id} | ${row.excluded.join(", ") || "none"} | ${row.includedPackages} | ${row.current ?? "unavailable"} | ${row.prior ?? "unavailable"} | ${row.net ?? "unavailable"} | ${row.percentChange ?? "n/a"} | ${row.eventQuality[quality.sensitivity.currentWindow]} / ${row.eventQuality[quality.sensitivity.previousWindow]} |`,
		);
	}
	lines.push(
		"",
		quality.sensitivity.units,
		"",
		"## Per-package windows",
		"",
		"| Package | Window | Dates present | Availability | Observed sum | Event quality | Publication UTC dates |",
		"| --- | --- | --- | --- | ---: | --- | ---: |",
	);
	for (const pkg of quality.packages)
		for (const [name, window] of Object.entries(pkg.windows)) {
			lines.push(
				`| ${pkg.name} | ${name}: ${window.bounds.start} to ${window.bounds.end} | ${window.dateCoverageComplete} | ${window.availability} | ${window.observedSum ?? "unavailable"} | ${window.eventQuality} | ${window.publicationExposureUTCDates ?? "unknown"} |`,
			);
		}
	lines.push(
		"",
		"## Limits",
		"",
		...quality.limitations.map((value) => `- ${value}`),
		"- First-publication timestamps, missing dates, declaration-only cohorts, separate version snapshots, and exact UTC comparisons are retained in quality.json.",
		"- Only the declared saved captures were analyzed; no fresh probes refresh a frozen series.",
		"",
	);
	return lines.join("\n");
}
function writeOutputs(output, files, inputRoot) {
	noTraversal(output);
	const absolute = resolve(output);
	const parent = realDirectory(dirname(absolute));
	requireValue(!isTelemetryCheckoutPath(absolute), "output must be outside telemetry source checkouts");
	requireValue(!isWithinDirectory(absolute, inputRoot), "output must be outside the input archive");
	mkdirSync(absolute, { mode: 0o700 });
	const claimed = lstatSync(absolute);
	requireValue(
		claimed.isDirectory() && (claimed.mode & 0o777) === 0o700,
		"output directory is not private",
	);
	for (const [name, content] of Object.entries(files)) {
		realDirectory(parent);
		const now = lstatSync(absolute);
		requireValue(
			!now.isSymbolicLink() && now.ino === claimed.ino && now.dev === claimed.dev,
			"output directory changed",
		);
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
}

/** Analyze only manifest-bound saved bytes; this module never fetches data. */
export function runNpmQuality({ manifest: manifestPath, output }) {
	try {
		noTraversal(manifestPath);
		const absolute = resolve(manifestPath);
		const root = realDirectory(dirname(absolute));
		const manifestBytes = readBytes(absolute, LIMIT.manifestBytes);
		const manifest = parseJson(manifestBytes);
		const windows = validateManifest(manifest);
		const captures = new Map();
		const inputs = [];
		for (const file of [...manifest.files].sort((a, b) => compare(a.id, b.id))) {
			const bytes = readBytes(inputPath(root, file.file), LIMIT.fileBytes, file);
			const value = parseJson(bytes);
			requireValue(object(value), "capture must be an object");
			const recorded = value.responseSha256 ?? null;
			requireValue(
				recorded === null || (typeof recorded === "string" && SHA.test(recorded)),
				"invalid recorded HTTP response digest",
			);
			captures.set(file.id, value);
			inputs.push({
				id: file.id,
				savedFileSha256: hash(bytes),
				savedFileBytes: bytes.length,
				recordedHttpResponseSha256: recorded,
				httpResponseHashRecomputed: false,
			});
		}
		const quality = analyze(manifest, captures, windows, hash(manifestBytes));
		writeOutputs(
			output,
			{
				"quality.json": json(quality),
				"quality.md": markdown(quality),
				"input-hashes.json": json({
					schemaVersion: 1,
					manifest: { savedFileSha256: hash(manifestBytes), savedFileBytes: manifestBytes.length },
					hashMeaning:
						"Digests cover the exact saved bytes analyzed, not HTTP wire bytes; projected captures cannot reproduce wire hashes",
					inputs,
				}),
			},
			root,
		);
		return quality;
	} catch (error) {
		if (error instanceof QualityError) throw error;
		const message =
			error?.code === "EEXIST"
				? "output already exists; never overwrite a previous analysis"
				: error?.code === "ENOENT"
					? "input file or output parent is missing"
					: error?.code === "ELOOP"
						? "symlink path rejected"
						: "unable to read inputs or write private outputs";
		throw new QualityError(message);
	}
}
