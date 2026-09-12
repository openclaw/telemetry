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
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTelemetryAggregateCapture } from "../scripts/lib/telemetry-aggregate-capture.mjs";
import {
	runTelemetryBackup,
	runTelemetryLifecyclePlan,
	runTelemetryRestore,
} from "../scripts/lib/telemetry-backup.mjs";

const CLI = fileURLToPath(new URL("../scripts/telemetry-backup.mjs", import.meta.url));
const NOW = Date.parse("2025-02-08T12:00:00Z");
const DAYS = [
	"2025-02-01",
	"2025-02-02",
	"2025-02-03",
	"2025-02-04",
	"2025-02-05",
	"2025-02-06",
	"2025-02-07",
];
const CONFIG = {
	schemaVersion: 1,
	accountId: "a".repeat(32),
	zoneId: "b".repeat(32),
	r2AccountId: "c".repeat(32),
	bucket: "synthetic-private-aggregates",
	lifecycle: {
		firstDay: "2025-02-01",
		lastDay: "2026-02-07",
		verifiedAt: "2025-02-08T11:00:00.000Z",
	},
};
const WRITE_KEY = "synthetic-write-key";
const READ_KEY = "synthetic-read-key";
const PRIVATE = "synthetic-secret-never-archive";
const CONTRACT = "telemetry-r2-daily-aggregate-v1";
const AMBIENT_AUTH = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_CONTAINER_CREDENTIALS_",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_EC2_METADATA_",
];
const MULTIPART_DEFAULT = {
	id: "Default multipart expiry",
	enabled: true,
	conditions: { prefix: "" },
	abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const key = (day) => `v1/${day}/aggregate.json`;
const owned = [];
let root;
let objects;
let requests;
let fetchMock;
let wireMock;
let beforeWire;
let afterWire;
let cloudResponse;

function output(name = "work") {
	return join(root, name);
}
function options(name) {
	return { execute: true, config: structuredClone(CONFIG), workDir: output(name) };
}
function defaultReadback() {
	const path = output("readback.json");
	writeFileSync(path, json({ rules: [MULTIPART_DEFAULT] }), { mode: 0o600, flag: "wx" });
	return path;
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
function hourly(day) {
	const columns = {
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
	const data = Array.from({ length: 24 }, (_, hour) => {
		const at = `${day} ${String(hour).padStart(2, "0")}`;
		return {
			bucket: `${at}:00:00`,
			weightedReports: "6",
			queryRows: "3",
			featureReports: "0",
			featureQueryRows: "0",
			minSampleInterval: 2,
			maxSampleInterval: 2,
			latestEventAt: `${at}:59:00`,
			latestFeatureAt: "1970-01-01 00:00:00",
		};
	});
	return {
		meta: Object.entries(columns).map(([name, type]) => ({ name, type })),
		data,
		rows: data.length,
		rows_before_limit_at_least: data.length,
	};
}
function countries() {
	return {
		data: {
			viewer: {
				zones: [
					{
						httpRequestsAdaptiveGroups: [
							{ dimensions: { clientCountryName: "XX" }, count: 5, avg: { sampleInterval: 10 } },
							{ dimensions: { clientCountryName: null }, count: 0, avg: { sampleInterval: null } },
						],
					},
				],
			},
		},
		errors: null,
	};
}
function reply(statusCode = 200, headers = {}, bytes = Buffer.alloc(0)) {
	return { response: { statusCode, headers, body: Readable.from([bytes]) } };
}
function objectHeaders(object) {
	return {
		"content-length": String(object.bytes.length),
		etag: object.etag,
		"x-amz-expiration": object.expiration,
		...Object.fromEntries(
			Object.entries(object.metadata).map(([name, value]) => [`x-amz-meta-${name}`, value]),
		),
	};
}
function storeObject(day, bytes, expiresAt = `2025-05-${day.slice(-2)}T00:00:00.000Z`) {
	const object = {
		bytes,
		etag: `"synthetic-${hash(bytes).slice(0, 16)}"`,
		expiration: `expiry-date="${new Date(expiresAt).toUTCString()}", rule-id="telemetry-v1-${day}"`,
		metadata: {
			sha256: hash(bytes),
			"source-day": day,
			"expires-at": expiresAt,
			contract: CONTRACT,
		},
	};
	objects.set(key(day), object);
	return object;
}
function exchange(request) {
	if (request.method === "HEAD" && !request.key) return reply();
	const object = objects.get(request.key);
	if (request.method === "HEAD") return object ? reply(200, objectHeaders(object)) : reply(404);
	if (request.method === "GET") {
		if (!object) return reply(404);
		if (request.headers["if-match"] !== object.etag) return reply(412);
		return reply(200, objectHeaders(object), object.bytes);
	}
	if (request.method === "PUT") {
		if (object && request.headers["if-none-match"] === "*") return reply(412);
		const saved = storeObject(
			request.headers["x-amz-meta-source-day"],
			Buffer.from(request.body),
			request.headers["x-amz-meta-expires-at"],
		);
		saved.metadata = Object.fromEntries(
			Object.entries(request.headers)
				.filter(([name]) => name.startsWith("x-amz-meta-"))
				.map(([name, value]) => [name.slice(11), value]),
		);
		return reply(200, { etag: saved.etag });
	}
	throw new Error("unexpected storage operation");
}
async function seed(day = DAYS[0], expiresAt) {
	const bundle = output(`source-${day}`);
	await runTelemetryAggregateCapture({
		day,
		output: bundle,
		accountId: CONFIG.accountId,
		zoneId: CONFIG.zoneId,
		execute: true,
	});
	const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json")));
	const files = [...manifest.files.map((file) => file.file), "manifest.json"].map((path) => {
		const bytes = readFileSync(join(bundle, path));
		return { path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") };
	});
	const expiry = expiresAt ?? `2025-05-${day.slice(-2)}T00:00:00.000Z`;
	const bytes = Buffer.from(
		json({
			schemaVersion: 1,
			contract: CONTRACT,
			day,
			expiresAt: expiry,
			sourceIdentity: {
				aeAccountSha256: hash(CONFIG.accountId),
				httpZoneSha256: hash(CONFIG.zoneId),
			},
			storageIdentity: {
				r2AccountSha256: hash(CONFIG.r2AccountId),
				bucketSha256: hash(CONFIG.bucket),
			},
			files,
		}),
	);
	return storeObject(day, bytes, expiry);
}
function repack(object, edit) {
	const archive = JSON.parse(object.bytes);
	edit(archive);
	object.bytes = Buffer.from(json(archive));
	object.metadata.sha256 = hash(object.bytes);
}
function snapshot(path) {
	return Object.fromEntries(
		readdirSync(path, { recursive: true })
			.sort()
			.map((name) => {
				const info = lstatSync(join(path, name));
				return [
					name,
					{
						mode: info.mode & 0o777,
						mtime: info.mtimeMs,
						hash: info.isFile() ? hash(readFileSync(join(path, name))) : null,
					},
				];
			}),
	);
}
function retainedText(path) {
	return readdirSync(path, { recursive: true })
		.map((name) => join(path, name))
		.filter((name) => lstatSync(name).isFile())
		.map((name) => readFileSync(name, "utf8"))
		.join("\n");
}
function forbidEnv(prefixes) {
	const original = process;
	vi.stubGlobal("process", {
		...original,
		env: new Proxy(original.env, {
			get(target, name) {
				if (prefixes.some((prefix) => String(name).startsWith(prefix)))
					throw new Error("forbidden credential access");
				return Reflect.get(target, name);
			},
		}),
	});
}
function restore(day = DAYS[0], name = "restored") {
	return runTelemetryRestore({ day, config: CONFIG, output: output(name) });
}

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "telemetry-backup-test-")));
	owned.push(root);
	objects = new Map();
	requests = [];
	beforeWire = afterWire = cloudResponse = undefined;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	for (const [name, value] of Object.entries({
		TELEMETRY_BACKUP_R2_WRITE_ACCESS_KEY_ID: WRITE_KEY,
		TELEMETRY_BACKUP_R2_WRITE_SECRET_ACCESS_KEY: PRIVATE,
		TELEMETRY_BACKUP_R2_READ_ACCESS_KEY_ID: READ_KEY,
		TELEMETRY_BACKUP_R2_READ_SECRET_ACCESS_KEY: `${PRIVATE}-read`,
		TELEMETRY_AE_READ_TOKEN: `${PRIVATE}-ae`,
		TELEMETRY_HTTP_READ_TOKEN: `${PRIVATE}-http`,
	}))
		vi.stubEnv(name, value);
	fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		let kind;
		let day;
		let value;
		if (init.body.startsWith("SELECT")) {
			kind = "ae";
			day = /timestamp>=toDateTime\('(\d{4}-\d{2}-\d{2})/u.exec(init.body)[1];
			value = hourly(day);
		} else {
			const request = JSON.parse(init.body);
			kind = request.query.includes("TelemetryMetadata") ? "settings" : "country";
			day = request.variables.start?.slice(0, 10);
			value = kind === "settings" ? settings() : countries();
		}
		value = (await cloudResponse?.(kind, day, value)) ?? value;
		return value instanceof Response ? value : new Response(json(value));
	});
	// Keep SDK signing, checksum middleware and deserialization real; replace only the wire.
	wireMock = vi.spyOn(NodeHttpHandler.prototype, "handle").mockImplementation(async (request) => {
		const record = {
			method: request.method,
			key: decodeURIComponent(request.path).replace(`/${CONFIG.bucket}`, "").replace(/^\//u, ""),
			hostname: request.hostname,
			headers: Object.fromEntries(
				Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
			),
			body: request.body,
		};
		requests.push(record);
		const result = (await beforeWire?.(record)) ?? exchange(record);
		return (await afterWire?.(record, result)) ?? result;
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("backup and immutable reconciliation", () => {
	it("plans seven closed UTC days without credentials, requests, or filesystem changes", async () => {
		forbidEnv(["TELEMETRY_", "AWS_"]);
		const result = await runTelemetryBackup({
			configFile: output("absent"),
			workDir: output("absent/child"),
		});
		expect(result).toEqual({
			status: "planned",
			days: DAYS.map((day) => ({ day, status: "planned" })),
		});
		expect(readdirSync(root)).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(wireMock).not.toHaveBeenCalled();
		const child = spawnSync(process.execPath, [CLI, "--config", output("absent")], {
			env: { PATH: process.env.PATH, TZ: "Pacific/Honolulu" },
			encoding: "utf8",
		});
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toMatchObject({ status: "planned", days: expect.any(Array) });
		expect(JSON.parse(child.stdout).days).toHaveLength(7);
	});

	it("uploads frozen oldest-first days with real conditional SDK requests and byte-preserving archives", async () => {
		afterWire = (request) => {
			if (request.method === "PUT") vi.setSystemTime(Date.parse("2025-02-09T00:00:01Z"));
		};
		const result = await runTelemetryBackup(options());
		expect(result).toEqual({
			status: "complete",
			days: DAYS.map((day) => ({ day, status: "uploaded" })),
		});
		const puts = requests.filter((request) => request.method === "PUT");
		expect(puts.map((request) => request.key)).toEqual(DAYS.map(key));
		for (const request of requests) {
			expect(request.hostname).toBe(`${CONFIG.r2AccountId}.r2.cloudflarestorage.com`);
			expect(request.headers.authorization).toContain(`Credential=${WRITE_KEY}/`);
			expect(request.headers.authorization).toContain("/auto/s3/aws4_request");
			expect(request.headers["x-amz-security-token"]).toBeUndefined();
			expect(request.headers["accept-encoding"]).toBe("identity");
		}
		for (const request of puts) {
			expect(request.headers["if-none-match"]).toBe("*");
			expect(request.headers["x-amz-sdk-checksum-algorithm"]).toBeUndefined();
			expect(request.headers["x-amz-checksum-crc32"]).toBeUndefined();
			expect(request.headers["content-encoding"]).not.toBe("aws-chunked");
			const object = objects.get(request.key);
			expect(hash(object.bytes)).toBe(request.headers["x-amz-meta-sha256"]);
			const archive = JSON.parse(object.bytes);
			expect(archive.files).toHaveLength(17);
			for (const file of archive.files) {
				const bytes = Buffer.from(file.base64, "base64");
				expect(bytes.length).toBe(file.bytes);
				expect(hash(bytes)).toBe(file.sha256);
			}
			const country = JSON.parse(
				Buffer.from(
					archive.files.find((file) => file.path === "http/country.json").base64,
					"base64",
				),
			);
			expect(country.estimatedRequests).toBe("5");
			expect(country.countries).toContainEqual({
				country: null,
				estimatedRequests: "0",
				sampleInterval: null,
			});
		}
		expect(readdirSync(output())).toEqual(["receipt.json"]);
		expect(lstatSync(output()).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(output(), "receipt.json")).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(result)).not.toContain("sha256");
		expect(JSON.stringify(result)).not.toContain(CONFIG.accountId);
		expect(retainedText(output())).not.toContain(PRIVATE);
	});

	it("treats verified remote bundles as authoritative without current capture credentials or lookback", async () => {
		for (const day of DAYS) await seed(day);
		const before = new Map([...objects].map(([name, object]) => [name, hash(object.bytes)]));
		fetchMock.mockClear().mockRejectedValue(new Error("query retention expired"));
		forbidEnv(["TELEMETRY_AE_", "TELEMETRY_HTTP_", "TELEMETRY_BACKUP_R2_READ_", ...AMBIENT_AUTH]);
		const result = await runTelemetryBackup(options());
		expect(result).toEqual({
			status: "complete",
			days: DAYS.map((day) => ({ day, status: "verified" })),
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
		expect(new Map([...objects].map(([name, object]) => [name, hash(object.bytes)]))).toEqual(
			before,
		);
	});

	it.each(["lost acknowledgment", "concurrent winner"])(
		"reconciles %s without a second PUT",
		async (kind) => {
			let winner;
			if (kind === "concurrent winner") {
				winner = await seed();
				objects.clear();
				vi.setSystemTime(NOW + 1000);
			}
			beforeWire = (request) => {
				if (request.method === "PUT" && request.key === key(DAYS[0]) && winner) {
					expect(request.body.equals(winner.bytes)).toBe(false);
					objects.set(request.key, winner);
					return reply(412, {}, Buffer.from(PRIVATE));
				}
			};
			afterWire = (request) => {
				if (
					kind === "lost acknowledgment" &&
					request.method === "PUT" &&
					request.key === key(DAYS[0])
				)
					throw new Error(PRIVATE);
			};
			const result = await runTelemetryBackup(options());
			expect(result.status).toBe("complete");
			expect(result.days[0]).toEqual({ day: DAYS[0], status: "reconciled" });
			expect(
				requests.filter((request) => request.method === "PUT" && request.key === key(DAYS[0])),
			).toHaveLength(1);
			if (winner) expect(objects.get(key(DAYS[0])).bytes.equals(winner.bytes)).toBe(true);
			expect(retainedText(output())).not.toContain(PRIVATE);
		},
	);

	it("leaves an unconfirmed PUT unresolved, continues newer days, and never archives an error body", async () => {
		beforeWire = (request) => {
			if (request.method === "PUT" && request.key === key(DAYS[0]))
				return reply(200, {}, Buffer.from(`<Error><Message>${PRIVATE}</Message></Error>`));
		};
		const result = await runTelemetryBackup(options());
		expect(result.status).toBe("failed");
		expect(result.days[0]).toEqual({ day: DAYS[0], status: "failed", reason: "put_not_confirmed" });
		expect(result.days.slice(1).every((day) => day.status === "uploaded")).toBe(true);
		expect(
			requests.filter((request) => request.method === "PUT" && request.key === key(DAYS[0])),
		).toHaveLength(1);
		expect(retainedText(output())).not.toContain(PRIVATE);
	});

	it.each(["WRITE", "READ"])(
		"rejects absent explicit %s credentials without falling back to ambient AWS auth",
		async (role) => {
			vi.stubEnv(`TELEMETRY_BACKUP_R2_${role}_ACCESS_KEY_ID`, "");
			vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-ambient-key");
			vi.stubEnv("AWS_SECRET_ACCESS_KEY", PRIVATE);
			forbidEnv(AMBIENT_AUTH);
			const result = role === "WRITE" ? await runTelemetryBackup(options()) : await restore();
			expect(result).toMatchObject({
				status: "failed",
				reason: "explicit_r2_credentials_required",
			});
			expect(requests).toEqual([]);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("continues newer days after an unresolved daily capture and reports overall failure", async () => {
		cloudResponse = (kind, day, value) => {
			if (kind === "ae" && day === DAYS[0]) value.data[0].unexpected = PRIVATE;
			return value;
		};
		const result = await runTelemetryBackup(options());
		expect(result.status).toBe("failed");
		expect(result.days).toHaveLength(7);
		expect(result.days[0]).toEqual({ day: DAYS[0], status: "failed", reason: "capture_failed" });
		expect(result.days.slice(1).every((day) => day.status === "uploaded")).toBe(true);
		expect(objects.has(key(DAYS[0]))).toBe(false);
		expect(retainedText(output())).not.toContain(PRIVATE);
	});

	it.each(["missing", "wrong"])(
		"stops uploads on %s native expiration and retains only an exact-object cleanup receipt",
		async (kind) => {
			afterWire = (request, result) => {
				if (request.method === "PUT") {
					const object = objects.get(request.key);
					object.expiration = kind === "missing" ? undefined : "incorrect-expiration";
				}
				return result;
			};
			const result = await runTelemetryBackup(options());
			expect(result.status).toBe("failed");
			expect(result.days).toEqual([
				{ day: DAYS[0], status: "failed", reason: "native_expiration_mismatch" },
			]);
			expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
			expect(requests.some((request) => request.method === "DELETE")).toBe(false);
			const receipt = JSON.parse(readFileSync(join(output(), "cleanup-required.json")));
			expect(receipt).toMatchObject({
				bucket: CONFIG.bucket,
				key: key(DAYS[0]),
				expectedExpiresAt: "2025-05-01T00:00:00.000Z",
			});
			expect(JSON.stringify(result)).not.toContain(CONFIG.bucket);
			expect(retainedText(output())).not.toContain(PRIVATE);
		},
	);

	it.each([301, 403, 404])(
		"fails globally on bucket HTTP %s without retries or upstream diagnostics",
		async (status) => {
			const body = Readable.from([Buffer.from(`<Error>${PRIVATE}</Error>`)]);
			beforeWire = () => ({
				response: { statusCode: status, headers: { location: "https://example.invalid/" }, body },
			});
			const result = await runTelemetryBackup(options());
			expect(result.status).toBe("failed");
			expect(requests).toHaveLength(1);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(body.destroyed).toBe(true);
			expect(JSON.stringify(result)).not.toContain(PRIVATE);
			expect(retainedText(output())).not.toContain(PRIVATE);
		},
	);

	it("stops after capture authentication fails and never publishes the upstream body", async () => {
		cloudResponse = () => new Response(PRIVATE, { status: 403 });
		const result = await runTelemetryBackup(options());
		expect(result.days).toEqual([
			{ day: DAYS[0], status: "failed", reason: "capture_auth_failed" },
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(objects.size).toBe(0);
		expect(retainedText(output())).not.toContain(PRIVATE);
	});

	it("fails outside the verified lifecycle horizon before capture or PUT", async () => {
		const opts = options();
		opts.config.lifecycle.firstDay = DAYS[1];
		const result = await runTelemetryBackup(opts);
		expect(result.days).toEqual([
			{ day: DAYS[0], status: "failed", reason: "outside_verified_lifecycle_horizon" },
		]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(objects.size).toBe(0);
	});

	it("accepts precise explicit UTC lifecycle readback times but rejects future sub-millisecond evidence", async () => {
		const opts = options();
		opts.config.lifecycle.verifiedAt = "2025-02-08T11:00:00.123456+00:00";
		expect((await runTelemetryBackup(opts)).status).toBe("complete");
		requests.length = 0;
		const future = options("future");
		future.config.lifecycle.verifiedAt = "2025-02-08T12:00:00.000001+00:00";
		expect(await runTelemetryBackup(future)).toMatchObject({
			status: "failed",
			reason: "invalid_lifecycle_horizon",
		});
		expect(requests).toEqual([]);
		expect(existsSync(future.workDir)).toBe(false);
	});

	it("claims the output before requesting and makes a concurrent loser fail without touching evidence", async () => {
		let release;
		let started;
		const pending = new Promise((resolve) => {
			started = resolve;
		});
		beforeWire = (request) => {
			if (request.method === "HEAD" && !request.key) {
				started();
				return new Promise((resolve) => {
					release = () => resolve(reply());
				});
			}
		};
		const winner = runTelemetryBackup(options());
		await pending;
		const before = snapshot(output());
		expect((await runTelemetryBackup(options())).status).toBe("failed");
		expect(requests).toHaveLength(1);
		expect(snapshot(output())).toEqual(before);
		release();
		expect((await winner).status).toBe("complete");
	});
});

describe("private restore and archive validation", () => {
	it.each([
		["restore", "missing"],
		["backup", "wrong"],
	])("stops %s when GET alone reports %s native expiration", async (mode, kind) => {
		const object = await seed();
		const original = hash(object.bytes);
		fetchMock.mockClear();
		beforeWire = (request) => {
			if (request.method !== "GET" || request.key !== key(DAYS[0])) return;
			const headers = objectHeaders(object);
			if (kind === "missing") delete headers["x-amz-expiration"];
			else headers["x-amz-expiration"] = "incorrect-expiration";
			return reply(200, headers, object.bytes);
		};
		const result = mode === "restore" ? await restore() : await runTelemetryBackup(options());
		if (mode === "restore")
			expect(result).toEqual({ status: "failed", reason: "native_expiration_mismatch" });
		else
			expect(result).toEqual({
				status: "failed",
				days: [{ day: DAYS[0], status: "failed", reason: "native_expiration_mismatch" }],
			});
		const destination = output(mode === "restore" ? "restored" : "work");
		expect(existsSync(join(destination, "bundle"))).toBe(false);
		expect(JSON.parse(readFileSync(join(destination, "cleanup-required.json")))).toMatchObject({
			key: key(DAYS[0]),
			expectedExpiresAt: "2025-05-01T00:00:00.000Z",
		});
		expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
		expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(hash(object.bytes)).toBe(original);
	});

	it("restores byte-identical source files with read credentials only and preserves the source", async () => {
		const object = await seed();
		const source = snapshot(output(`source-${DAYS[0]}`));
		fetchMock.mockClear().mockRejectedValue(new Error("offline only"));
		forbidEnv(["TELEMETRY_BACKUP_R2_WRITE_", "TELEMETRY_AE_", "TELEMETRY_HTTP_", ...AMBIENT_AUTH]);
		expect(await restore()).toEqual({ status: "restored", day: DAYS[0] });
		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			requests.every((request) =>
				request.headers.authorization.includes(`Credential=${READ_KEY}/`),
			),
		).toBe(true);
		expect(requests.every((request) => ["HEAD", "GET"].includes(request.method))).toBe(true);
		for (const file of JSON.parse(object.bytes).files) {
			const path = join(output("restored/bundle"), file.path);
			expect(readFileSync(path).equals(Buffer.from(file.base64, "base64"))).toBe(true);
			expect(lstatSync(path).mode & 0o777).toBe(0o600);
		}
		expect(snapshot(output(`source-${DAYS[0]}`))).toEqual(source);
		expect((await restore()).status).toBe("failed");
		expect(requests).toHaveLength(3);
	});

	it.each([
		[
			"wrong day",
			(archive) => {
				archive.day = DAYS[1];
			},
		],
		[
			"wrong identity",
			(archive) => {
				archive.sourceIdentity.aeAccountSha256 = "0".repeat(64);
			},
		],
		[
			"unrequested field",
			(archive) => {
				archive.extra = PRIVATE;
			},
		],
		[
			"traversal",
			(archive) => {
				archive.files[0].path = "../outside";
			},
		],
		[
			"duplicate file",
			(archive) => {
				archive.files[1] = archive.files[0];
			},
		],
		[
			"oversized file",
			(archive) => {
				archive.files[0].bytes = 5_000_000;
			},
		],
		[
			"noncanonical base64",
			(archive) => {
				archive.files[0].base64 = "!".repeat(archive.files[0].base64.length);
			},
		],
		[
			"file hash",
			(archive) => {
				archive.files[0].sha256 = "0".repeat(64);
			},
		],
		[
			"forged regenerated output",
			(archive) => {
				const file = archive.files.find((item) => item.path === "ae-daily/daily.csv");
				const bytes = Buffer.from("unsupported,replacement\n");
				Object.assign(file, {
					bytes: bytes.length,
					sha256: hash(bytes),
					base64: bytes.toString("base64"),
				});
			},
		],
	])("rejects %s without releasing or retaining an unsupported archive", async (_name, edit) => {
		const object = await seed();
		repack(object, edit);
		const result = await restore();
		expect(result.status).toBe("failed");
		expect(existsSync(output("restored/bundle"))).toBe(false);
		expect(readdirSync(output("restored"))).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(PRIVATE);
		expect(objects.get(key(DAYS[0]))).toBe(object);
	});

	it.each(["envelope hash", "oversized wire", "truncated wire", "redirect"])(
		"rejects %s at the download boundary",
		async (kind) => {
			const object = await seed();
			if (kind === "envelope hash") object.metadata.sha256 = "0".repeat(64);
			beforeWire = (request) => {
				if (request.method !== "GET") return;
				if (kind === "oversized wire")
					return reply(
						200,
						{ ...objectHeaders(object), "content-length": "20000000" },
						Buffer.from(PRIVATE),
					);
				if (kind === "truncated wire")
					return reply(200, objectHeaders(object), object.bytes.subarray(0, -1));
				if (kind === "redirect")
					return reply(307, { location: "https://example.invalid/" }, Buffer.from(PRIVATE));
			};
			expect((await restore()).status).toBe("failed");
			expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
			expect(readdirSync(output("restored"))).toEqual([]);
		},
	);

	it("aborts a stalled download at its deadline without retries, release, or a live body", async () => {
		const object = await seed();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(NOW);
		let started;
		const pending = new Promise((resolve) => {
			started = resolve;
		});
		const body = new Readable({ read() {} });
		beforeWire = (request) => {
			if (request.method === "GET") {
				started();
				return { response: { statusCode: 200, headers: objectHeaders(object), body } };
			}
		};
		const result = restore();
		await pending;
		await vi.advanceTimersByTimeAsync(45_001);
		expect(await result).toEqual({ status: "failed", reason: "r2_timeout" });
		expect(body.destroyed).toBe(true);
		expect(requests.filter((request) => request.method === "GET")).toHaveLength(1);
		expect(readdirSync(output("restored"))).toEqual([]);
	});

	it("isolates a malformed remote day without replacing it or starving newer days", async () => {
		const object = await seed();
		repack(object, (archive) => {
			archive.day = DAYS[1];
		});
		const before = hash(object.bytes);
		const result = await runTelemetryBackup(options());
		expect(result.status).toBe("failed");
		expect(result.days).toHaveLength(7);
		expect(result.days[0]).toMatchObject({
			status: "failed",
			reason: "archive_identity_or_contract",
		});
		expect(result.days.slice(1).every((day) => day.status === "uploaded")).toBe(true);
		expect(hash(objects.get(key(DAYS[0])).bytes)).toBe(before);
		expect(
			requests.some((request) => request.method === "PUT" && request.key === key(DAYS[0])),
		).toBe(false);
	});

	it.each(["before request", "before download", "before release"])(
		"enforces original-date expiry %s",
		async (stage) => {
			await seed();
			if (stage === "before request") vi.setSystemTime(Date.parse("2025-05-01T00:00:00Z"));
			else {
				vi.setSystemTime(Date.parse("2025-04-30T23:59:59.999Z"));
				afterWire = (request) => {
					const boundary = stage === "before download" ? "HEAD" : "GET";
					if (request.key && request.method === boundary)
						vi.setSystemTime(Date.parse("2025-05-01T00:00:00Z"));
				};
			}
			expect(await restore()).toEqual({ status: "failed", reason: "source_day_expired" });
			expect(existsSync(output("restored/bundle"))).toBe(false);
			expect(requests.filter((request) => request.method === "GET")).toHaveLength(
				stage === "before release" ? 1 : 0,
			);
			if (stage === "before request") expect(existsSync(output("restored"))).toBe(false);
			else expect(readdirSync(output("restored"))).toEqual([]);
		},
	);

	it("rejects output symlink ancestors and existing destinations without network or modifications", async () => {
		mkdirSync(output("real"), { mode: 0o700 });
		symlinkSync(output("real"), output("link"));
		expect((await restore(DAYS[0], "link/child")).status).toBe("failed");
		expect((await restore(DAYS[0], "real")).status).toBe("failed");
		expect(requests).toEqual([]);
		expect(readdirSync(output("real"))).toEqual([]);
	});
});

describe("native lifecycle plans", () => {
	it("is offline, clamps three calendar months and preserves all old rules on renewal", async () => {
		forbidEnv(["TELEMETRY_", "AWS_"]);
		const first = output("first.json");
		const child = spawnSync(
			process.execPath,
			[
				CLI,
				"lifecycle-plan",
				"--anchor",
				"2024-11-30",
				"--previous",
				defaultReadback(),
				"--output",
				first,
			],
			{ env: { PATH: process.env.PATH, TZ: "Pacific/Honolulu" }, encoding: "utf8" },
		);
		expect(child.status).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ status: "planned" });
		const original = readFileSync(first);
		const plan = JSON.parse(original);
		expect(plan.rules).toHaveLength(373);
		expect(plan.rules).toContainEqual({
			id: expect.any(String),
			enabled: true,
			conditions: { prefix: "" },
			abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
		});
		for (const [day, expiresAt] of [
			["2024-11-30", "2025-02-28"],
			["2024-12-31", "2025-03-31"],
			["2025-01-31", "2025-04-30"],
			["2025-02-28", "2025-05-28"],
		]) {
			expect(plan.rules.find((rule) => rule.id === `telemetry-v1-${day}`)).toEqual({
				id: `telemetry-v1-${day}`,
				enabled: true,
				conditions: { prefix: `v1/${day}/` },
				deleteObjectsTransition: {
					condition: { type: "Date", date: `${expiresAt}T00:00:00.000Z` },
				},
			});
		}
		const renewed = output("renewed.json");
		expect(
			await runTelemetryLifecyclePlan({
				anchor: "2025-11-30",
				previousFile: first,
				output: renewed,
			}),
		).toEqual({ status: "planned" });
		expect(JSON.parse(readFileSync(renewed)).rules).toEqual(expect.arrayContaining(plan.rules));
		expect(readFileSync(first).equals(original)).toBe(true);
		expect(lstatSync(renewed).mode & 0o777).toBe(0o600);
		expect(wireMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["empty conditions", {}],
		["empty prefix", { prefix: "" }],
	])("preserves the native seven-day multipart default with %s", async (_name, conditions) => {
		const rule = {
			id: "Default Multipart Abort Rule",
			enabled: true,
			conditions,
			abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
		};
		const previous = output("provider-default.json");
		writeFileSync(previous, json({ rules: [rule] }), { mode: 0o600 });
		const before = readFileSync(previous);
		const planned = output("with-default.json");
		expect(
			await runTelemetryLifecyclePlan({
				anchor: "2025-02-01",
				previousFile: previous,
				output: planned,
			}),
		).toEqual({ status: "planned" });
		const plan = JSON.parse(readFileSync(planned));
		expect(plan.rules).toHaveLength(373);
		expect(plan.rules[0]).toEqual(rule);
		expect(readFileSync(previous).equals(before)).toBe(true);
		for (const [name, change] of [
			[
				"different-age",
				{ abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 1 } } },
			],
			["object-deletion", { deleteObjectsTransition: { condition: { type: "Age", maxAge: 1 } } }],
			["extra-condition", { conditions: { ...conditions, extra: true } }],
			["missing-conditions", { conditions: undefined }],
			["null-conditions", { conditions: null }],
		]) {
			const path = output(`${name}.json`);
			writeFileSync(path, json({ rules: [{ ...rule, ...change }] }), { mode: 0o600 });
			expect(
				(
					await runTelemetryLifecyclePlan({
						anchor: "2025-02-01",
						previousFile: path,
						output: output(`${name}-plan.json`),
					})
				).status,
			).toBe("failed");
			expect(existsSync(output(`${name}-plan.json`))).toBe(false);
		}
		const empty = output("empty-readback.json");
		writeFileSync(empty, json({ rules: [] }), { mode: 0o600 });
		expect(
			await runTelemetryLifecyclePlan({
				anchor: "2025-02-01",
				previousFile: empty,
				output: output("missing-default"),
			}),
		).toMatchObject({
			status: "failed",
			reason: "multipart_default_readback_required",
		});
		expect(wireMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["symlink", "hardlink", "public mode"])(
		"rejects an unsafe %s readback without changing its source",
		async (kind) => {
			const source = defaultReadback();
			const before = readFileSync(source);
			let previous = source;
			if (kind === "public mode") chmodSync(source, 0o644);
			else {
				previous = output("unsafe.json");
				if (kind === "symlink") symlinkSync(source, previous);
				else linkSync(source, previous);
			}
			expect(
				(
					await runTelemetryLifecyclePlan({
						anchor: "2025-02-01",
						previousFile: previous,
						output: output("rejected.json"),
					})
				).status,
			).toBe("failed");
			expect(existsSync(output("rejected.json"))).toBe(false);
			expect(readFileSync(source).equals(before)).toBe(true);
			expect(requests).toEqual([]);
		},
	);

	it("fails closed on rule loss, conflicts, duplicates, rule-cap exhaustion and output overwrite", async () => {
		const previous = output("previous.json");
		await runTelemetryLifecyclePlan({
			anchor: "2024-02-01",
			previousFile: defaultReadback(),
			output: previous,
		});
		const plan = JSON.parse(readFileSync(previous));
		for (const [name, rules] of [
			["conflict", [{ ...plan.rules[0], enabled: false }]],
			["duplicate", [plan.rules[0], plan.rules[0]]],
			["unknown", [{ id: "unrelated", enabled: true, conditions: { prefix: "other/" } }]],
		]) {
			const input = output(`${name}-input.json`);
			writeFileSync(input, json({ rules }), { mode: 0o600 });
			expect(
				(
					await runTelemetryLifecyclePlan({
						anchor: "2025-02-01",
						previousFile: input,
						output: output(name),
					})
				).status,
			).toBe("failed");
			expect(existsSync(output(name))).toBe(false);
		}
		expect(
			(await runTelemetryLifecyclePlan({ anchor: "2025-02-01", output: output("ambiguous") }))
				.status,
		).toBe("failed");
		const second = output("second.json");
		await runTelemetryLifecyclePlan({
			anchor: "2025-02-01",
			previousFile: previous,
			output: second,
		});
		expect(
			await runTelemetryLifecyclePlan({
				anchor: "2026-02-01",
				previousFile: second,
				output: output("over-limit"),
			}),
		).toMatchObject({ status: "failed", reason: "lifecycle_limit" });
		const before = readFileSync(previous);
		expect(
			(
				await runTelemetryLifecyclePlan({
					anchor: "2024-02-01",
					previousFile: previous,
					output: previous,
				})
			).status,
		).toBe("failed");
		expect(readFileSync(previous).equals(before)).toBe(true);
	});
});
