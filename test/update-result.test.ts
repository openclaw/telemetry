import fixture from "./fixtures/update-result.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { buildUpdateResultPoint, parseUpdateResult, UPDATE_RESULT_USER_AGENT } from "../src/update-result.js";

const raw = JSON.stringify(fixture);
const versions = ["fromVersion", "targetVersion", "resultingVersion", "runningVersion"];

describe("strict update-result contract", () => {
	it("accepts the shared synthetic fixture and pins every stored column", () => {
		const parsed = parseUpdateResult(fixture)!;
		expect(parsed).toEqual(fixture);
		expect(buildUpdateResultPoint(parsed)).toEqual({
			indexes: ["2026.9.19"],
			blobs: ["update_result", "succeeded", "2026.9.4", "2026.9.19", "2026.9.19", "2026.9.19", "linux", "x64", "npm-global", "stable", "under-1m", "passed", "none", "none", "none", "not-needed", "unknown"],
			doubles: [2],
		});
	});
	it.each(Object.keys(fixture))("requires field %s with its exact type and vocabulary", (key) => {
		const missing: Record<string, unknown> = { ...fixture };
		delete missing[key];
		expect(parseUpdateResult(missing)).toBeUndefined();
		for (const value of [null, {}, [], true, 42, "private-value", "", "unknown\n"]) {
			expect(parseUpdateResult({ ...fixture, [key]: value })).toBeUndefined();
		}
	});
	it.each(["installId", "deviceId", "userId", "account", "hostname", "ip", "city", "country", "timezone", "trigger", "error", "stack", "logs", "__proto__"])("rejects additional %s", (key) => {
		expect(parseUpdateResult({ ...fixture, [key]: "private" })).toBeUndefined();
	});
	it.each(versions)("restricts %s to public release syntax", (key) => {
		for (const version of ["2026.9.19", "2026.9.19-1", "2026.9.19-beta.1", "2026.9.19-999-beta.999", "unknown"]) {
			expect(parseUpdateResult({ ...fixture, [key]: version })).toBeDefined();
		}
		for (const version of ["2026x9x19", "2026.9.19\n", "2026.9.19+abc123", "2026.9.19-private.1", "abcdef1234", "2026.09.19", "2026.13.1", "2026.9.19-0", "2026.9.19-1000", "2026.9.19-beta.0", "2026.9.19-beta.1000", "2030.1.1"]) {
			expect(parseUpdateResult({ ...fixture, [key]: version })).toBeUndefined();
		}
	});
	it.each(versions)("accepts client patch boundaries in %s without changing the wire shape", (key) => {
		for (const version of ["2026.8.0", "2026.8.32", "2026.8.33", "2026.8.123", "2026.8.999999", "2026.8.123-999-beta.999"]) {
			const payload = { ...fixture, [key]: version };
			expect(Object.keys(payload)).toHaveLength(18);
			expect(parseUpdateResult(payload)).toEqual(payload);
		}
	});
	it.each(versions)("rejects non-client patch syntax in %s", (key) => {
		for (const version of ["2026.8.1000000", "2026.8.00", "2026.8.033", "2026.8.000123", "2026.8.123-private.1", "2026.8.123+abc123", "2026.8.123\n"]) {
			expect(parseUpdateResult({ ...fixture, [key]: version })).toBeUndefined();
		}
	});
	it.each(["failedStage", "errorCategory", "errorCode"])("requires succeeded %s to be none", (key) => {
		const value = { failedStage: "verifying", errorCategory: "network", errorCode: "ENOTFOUND" }[key];
		expect(parseUpdateResult({ ...fixture, [key]: value })).toBeUndefined();
	});
	it.each(["failed", "rolled-back"])("accepts bounded %s diagnostics", (outcome) => {
		expect(parseUpdateResult({ ...fixture, outcome, failedStage: "restarting", errorCategory: "permission", errorCode: "EACCES", rollback: "succeeded", recovery: "safe" })).toBeDefined();
	});
});

describe("outcome receiver isolation", () => {
	const daily = vi.fn();
	const outcomes = vi.fn();
	const upstream = vi.fn();
	let env: Env;
	function request(body: BodyInit = raw, headers: Record<string, string> = {}): Request {
		const req = new Request("https://telemetry.example/api/latest-version", {
			method: "POST", body, headers: { "user-agent": UPDATE_RESULT_USER_AGENT, "content-type": "application/json", "cf-connecting-ip": "192.0.2.1", "cookie": "private-cookie", ...headers },
		});
		Object.defineProperty(req, "cf", { get() { throw new Error("outcome must not read geography"); } });
		return req;
	}
	beforeEach(() => {
		vi.resetAllMocks();
		env = { TELEMETRY: { writeDataPoint: daily }, UPDATE_RESULTS: { writeDataPoint: outcomes } };
		vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
		upstream.mockResolvedValue(Response.json({ version: "2026.9.19" }));
		vi.stubGlobal("fetch", upstream);
	});
	afterEach(() => { vi.unstubAllGlobals(); });
	it.each([UPDATE_RESULT_USER_AGENT, "untrusted-agent"])("discriminates schema without storing UA %s or metadata", async (ua) => {
		const response = await worker.fetch(request(raw, { "user-agent": ua }), env);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.19" });
		expect(outcomes).toHaveBeenCalledExactlyOnceWith(buildUpdateResultPoint(parseUpdateResult(fixture)!));
		expect(daily).not.toHaveBeenCalled();
	});
	it.each(["{", "null", "[]", "", JSON.stringify({ schema: 2, features: {} }), JSON.stringify({ ...fixture, installId: "secret" }), JSON.stringify({ ...fixture, runningVersion: "private-sha" })])("rejects invalid outcome without fallback: %#", async (body) => {
		const response = await worker.fetch(request(body), env);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({ error: "invalid_update_result" });
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(outcomes).not.toHaveBeenCalled();
		expect(daily).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});
	it.each([UPDATE_RESULT_USER_AGENT, "other-agent"])("enforces exact body bytes including BOM for %s", async (ua) => {
		for (const [body, status] of [[raw.padEnd(4096), 200], [raw.padEnd(4097), 400], ["\uFEFF" + raw.padEnd(4094), 400]] as const) {
			upstream.mockResolvedValueOnce(Response.json({ version: "2026.9.19" }));
			expect((await worker.fetch(request(body, { "user-agent": ua }), env)).status).toBe(status);
		}
		expect(outcomes).toHaveBeenCalledTimes(1);
		expect(daily).not.toHaveBeenCalled();
	});
	it.each(["4097", "-1", "NaN", "1.5"])("rejects invalid declared length %s", async (length) => {
		expect((await worker.fetch(request(raw, { "content-length": length }), env)).status).toBe(400);
		expect(outcomes).not.toHaveBeenCalled();
		expect(daily).not.toHaveBeenCalled();
	});
	it("rejects malformed UTF-8", async () => {
		expect((await worker.fetch(request(new Uint8Array([0xff])), env)).status).toBe(400);
		expect(outcomes).not.toHaveBeenCalled();
		expect(daily).not.toHaveBeenCalled();
	});
	it("caps a chunked stream without Content-Length and cancels excess", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.enqueue(new Uint8Array(4096)); }, cancel });
		const req = request();
		Object.defineProperty(req, "body", { value: stream });
		expect((await worker.fetch(req, env)).status).toBe(400);
		expect(cancel).toHaveBeenCalledOnce();
		expect(outcomes).not.toHaveBeenCalled();
		expect(daily).not.toHaveBeenCalled();
	});
	it.each(["missing", "throws"])("fails closed when outcome dataset %s", async (mode) => {
		if (mode === "missing") delete env.UPDATE_RESULTS;
		else outcomes.mockImplementationOnce(() => { throw new Error("private backend diagnostic"); });
		const response = await worker.fetch(request(), env);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({ error: "update_results_unavailable" });
		expect(daily).not.toHaveBeenCalled();
	});
	it.each([false, true, "unavailable"])("preserves limiter behavior: %s", async (success) => {
		const limit = success === "unavailable" ? vi.fn().mockRejectedValue(new Error("offline")) : vi.fn().mockResolvedValue({ success });
		const response = await worker.fetch(request(), { ...env, RATE_LIMIT: { limit } });
		expect(response.status).toBe(200);
		expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.1" });
		expect(outcomes).toHaveBeenCalledTimes(success === false ? 0 : 1);
		expect(daily).not.toHaveBeenCalled();
	});
	it.each([false, true])("advertises capability only with a binding: %s", async (present) => {
		if (!present) delete env.UPDATE_RESULTS;
		const limit = vi.fn();
		const req = new Request("https://telemetry.example/api/latest-version?configured=1", { method: "HEAD" });
		for (const property of ["body", "cf"]) {
			Object.defineProperty(req, property, { get() { throw new Error("HEAD must not read " + property); } });
		}
		const response = await worker.fetch(req, { ...env, RATE_LIMIT: { limit } });
		expect(response.status).toBe(present ? 204 : 503);
		expect(response.headers.get("openclaw-update-results")).toBe(present ? "2" : null);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("");
		expect(limit).not.toHaveBeenCalled();
		expect(outcomes).not.toHaveBeenCalled();
		expect(daily).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});
	it.each([UPDATE_RESULT_USER_AGENT, "openclaw/2026.9.19 (linux; node/v24.0.0; x64; cli)"])("answers quota-exhausted unfinished POST without reading the body: %s", async (ua) => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode("{")); } });
		const req = request();
		req.headers.set("user-agent", ua);
		Object.defineProperty(req, "body", { value: stream });
		const limit = vi.fn().mockResolvedValue({ success: false });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				worker.fetch(req, { ...env, RATE_LIMIT: { limit } }),
				new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("awaited unfinished body")), 250); }),
			]);
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ version: "2026.9.19" });
			expect(stream.locked).toBe(false);
			expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.1" });
			expect(outcomes).not.toHaveBeenCalled();
			expect(daily).not.toHaveBeenCalled();
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			controller.close();
		}
	});
	it.each(["GET", "POST"])("consumes one quota decision for legacy %s", async (method) => {
		const limit = vi.fn().mockResolvedValue({ success: true });
		const req = new Request("https://telemetry.example/api/latest-version", {
			method, ...(method === "POST" ? { body: JSON.stringify({ schema: 1, features: {} }) } : {}),
		});
		expect((await worker.fetch(req, { ...env, RATE_LIMIT: { limit } })).status).toBe(200);
		expect(limit).toHaveBeenCalledOnce();
		expect(daily).toHaveBeenCalledOnce();
		expect(outcomes).not.toHaveBeenCalled();
	});
	it("does not add an individual report route", async () => {
		for (const path of ["/api/update-results", "/api/update-result", "/api/stats"]) {
			expect((await worker.fetch(new Request("https://telemetry.example" + path), env)).status).toBe(404);
		}
	});
});
