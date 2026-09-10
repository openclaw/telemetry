import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { envelope, fixtureRows } from "./fixtures/stats-sql.js";

type MemoryCache = {
	store: Map<string, Response>;
	match(request: RequestInfo | URL): Promise<Response | undefined>;
	put(request: RequestInfo | URL, response: Response): Promise<void>;
};

function memoryCache(): MemoryCache {
	const store = new Map<string, Response>();
	return {
		store,
		async match(request) {
			const url = request instanceof Request ? request.url : String(request);
			return store.get(url)?.clone();
		},
		async put(request, response) {
			const url = request instanceof Request ? request.url : String(request);
			response.headers.set("age", "0");
			store.set(url, response);
		},
	};
}

function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		TELEMETRY: { writeDataPoint() {} },
		ACCOUNT_ID: "acct",
		ANALYTICS_READ_TOKEN: "tok",
		...overrides,
	};
}

function request(path = "/api/stats"): Request {
	return new Request(`https://telemetry.example${path}`, {
		headers: { "cf-connecting-ip": "203.0.113.9" },
	});
}

function countingLimiter() {
	const counts = new Map<string, number>();
	return {
		counts,
		async limit({ key }: { key: string }) {
			const count = (counts.get(key) ?? 0) + 1;
			counts.set(key, count);
			return { success: count <= 20 };
		},
	};
}

describe("GET | POST /api/latest-version", () => {
	const versionUrl = "https://registry.npmjs.org/openclaw/latest";
	const upstream = vi.fn<typeof fetch>();
	const writeDataPoint = vi.fn();
	const geography = {
		country: "US",
		regionCode: "CA",
		city: "San Francisco",
		timezone: "America/Los_Angeles",
	};
	const featureBody = {
		schema: 1,
		features: {
			channels: ["DISCORD", "private-channel"],
			providerFamilies: ["OPENAI", "private-provider"],
			plugins: ["CODEX", "private-plugin"],
			pluginsEnabled: 7,
			sessionsLast24h: 14,
		},
	};
	function updateRequest(cf: unknown, init: RequestInit = {}): Request {
		const headers = new Headers(init.headers);
		headers.set("user-agent", "openclaw/2026.9.2 (linux; node/v24.0.0; x64; gateway)");
		const request = new Request("https://telemetry.example/api/latest-version", { ...init, headers });
		// Node's Request does not provide the Worker's incoming metadata.
		Object.defineProperty(request, "cf", { value: cf });
		return request;
	}
	let cache: MemoryCache;
	let env: Env;
	const invalidBodies = [
		{ label: "malformed JSON", body: "{" },
		{ label: "null", body: "null" },
		{ label: "missing version", body: "{}" },
		{ label: "non-string version", body: '{"version":42}' },
		{ label: "empty version", body: '{"version":""}' },
		{ label: "whitespace version", body: '{"version":" \\n\\t "}' },
	];

	beforeEach(() => {
		cache = memoryCache();
		env = testEnv({ TELEMETRY: { writeDataPoint } });
		writeDataPoint.mockClear();
		upstream.mockReset().mockImplementation(async () => Response.json({ version: " 2026.9.2 " }));
		vi.stubGlobal("caches", { default: cache });
		vi.stubGlobal("fetch", upstream);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each(["GET", "POST"])("records Cloudflare geography on %s without changing feature or version contracts", async (method) => {
		const response = await worker.fetch(updateRequest(geography, {
			method,
			...(method === "POST" ? {
				headers: { "content-type": "application/json" },
				body: JSON.stringify(featureBody),
			} : {}),
		}), env);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ["2026.9.2"],
			blobs: [
				"2026.9.2", "linux", "x64", "node/v24.0.0", "gateway",
				...(method === "POST" ? ["discord", "openai", "codex"] : ["", "", ""]),
				"US", "CA", "San Francisco", "America/Los_Angeles",
			],
			doubles: method === "POST" ? [1, 7, 14] : [0, 0, 0],
		});
	});

	it("records an update-only request with empty geography when cf is absent", async () => {
		const response = await worker.fetch(updateRequest(undefined), env);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ["2026.9.2"],
			blobs: ["2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "", "", "", "", "", "", ""],
			doubles: [0, 0, 0],
		});
	});

	it.each([undefined, null, false, 1, "US", []].map((cf) => ({ cf })))(
		"preserves features when cf is not a metadata record: $cf",
		async ({ cf }) => {
			const response = await worker.fetch(updateRequest(cf, {
				method: "POST",
				body: JSON.stringify(featureBody),
			}), env);
			await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
			expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
				indexes: ["2026.9.2"],
				blobs: ["2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "discord", "openai", "codex", "", "", "", ""],
				doubles: [1, 7, 14],
			});
		},
	);

	it.each([
		{ label: "lowercase country", cf: { country: "us" }, stored: ["US", "", "", ""] },
		{ label: "numeric region", cf: { country: "FR", regionCode: "01" }, stored: ["FR", "01", "", ""] },
		{ label: "three-letter region", cf: { country: "GB", regionCode: "ENG" }, stored: ["GB", "ENG", "", ""] },
		{ label: "country sentinel", cf: { ...geography, country: "XX" }, stored: ["", "", "San Francisco", "America/Los_Angeles"] },
		{ label: "Tor sentinel", cf: { ...geography, country: "T1" }, stored: ["", "", "San Francisco", "America/Los_Angeles"] },
		{ label: "invalid country", cf: { ...geography, country: "USA" }, stored: ["", "", "San Francisco", "America/Los_Angeles"] },
		{ label: "non-string country", cf: { ...geography, country: 1 }, stored: ["", "", "San Francisco", "America/Los_Angeles"] },
		{ label: "unscoped region", cf: { regionCode: "CA", city: "San Francisco" }, stored: ["", "", "San Francisco", ""] },
		{ label: "region name only", cf: { country: "US", region: "California" }, stored: ["US", "", "", ""] },
		{ label: "lowercase region", cf: { country: "US", regionCode: "ca" }, stored: ["US", "", "", ""] },
		{ label: "full subdivision code", cf: { country: "US", regionCode: "US-CA" }, stored: ["US", "", "", ""] },
		{ label: "overlength region", cf: { country: "US", regionCode: "ABCD" }, stored: ["US", "", "", ""] },
		{ label: "non-string region", cf: { country: "US", regionCode: 1 }, stored: ["US", "", "", ""] },
		{ label: "Unicode NFC city", cf: { city: " Sa\u0303o Paulo " }, stored: ["", "", "S\u00e3o Paulo", ""] },
		{ label: "non-Latin city", cf: { city: "\u6771\u4eac" }, stored: ["", "", "\u6771\u4eac", ""] },
		{ label: "128-byte city", cf: { city: "\u00e9".repeat(64) }, stored: ["", "", "\u00e9".repeat(64), ""] },
		{ label: "named timezone", cf: { timezone: "Europe/Paris" }, stored: ["", "", "", "Europe/Paris"] },
		{ label: "UTC alias", cf: { timezone: "UTC" }, stored: ["", "", "", "UTC"] },
		{ label: "legacy alias", cf: { timezone: "US/Eastern" }, stored: ["", "", "", "US/Eastern"] },
		{ label: "Etc alias", cf: { timezone: "Etc/GMT+5" }, stored: ["", "", "", "Etc/GMT+5"] },
	])("records bounded geography: $label", async ({ cf, stored }) => {
		const response = await worker.fetch(updateRequest(cf, {
			method: "POST",
			body: JSON.stringify(featureBody),
		}), env);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
			indexes: ["2026.9.2"],
			blobs: ["2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "discord", "openai", "codex", ...stored],
			doubles: [1, 7, 14],
		});
	});

	it.each([
		{ field: "city", value: "\u00e9".repeat(65) },
		{ field: "city", value: "A".repeat(129) },
		{ field: "city", value: "New\nYork" },
		{ field: "city", value: "\tParis" },
		{ field: "city", value: "Paris\u0000" },
		{ field: "city", value: "Paris\u202e" },
		{ field: "city", value: "Paris\u200b" },
		{ field: "city", value: "Paris\ud800" },
		{ field: "city", value: "Paris\u2028" },
		{ field: "city", value: "\u3164" },
		{ field: "city", value: "   " },
		{ field: "city", value: {} },
		{ field: "timezone", value: "+05:00" },
		{ field: "timezone", value: "UTC+05:00" },
		{ field: "timezone", value: "Invalid/Zone" },
		{ field: "timezone", value: "Etc/" + "A".repeat(61) },
		{ field: "timezone", value: "UTC\n" },
		{ field: "timezone", value: " UTC" },
		{ field: "timezone", value: "Europe/P\u00e1ris" },
		{ field: "timezone", value: 300 },
	])("drops malformed $field without damaging valid siblings: $value", async ({ field, value }) => {
		const response = await worker.fetch(updateRequest({ ...geography, [field]: value }, {
			method: "POST",
			body: JSON.stringify(featureBody),
		}), env);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
			indexes: ["2026.9.2"],
			blobs: [
				"2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "discord", "openai", "codex",
				"US", "CA", field === "city" ? "" : "San Francisco", field === "timezone" ? "" : "America/Los_Angeles",
			],
			doubles: [1, 7, 14],
		});
	});

	it.each([false, true])("ignores spoofed geography and undocumented fields (cf present: %s)", async (present) => {
		const spoofed = { country: "FR", regionCode: "75", city: "Paris", timezone: "Europe/Paris" };
		const cf = present ? {
			...geography,
			ip: "192.0.2.1",
			latitude: "37.7749",
			longitude: "-122.4194",
			postalCode: "94103",
			region: "California",
			user: "example-user",
			deviceId: "example-device",
		} : undefined;
		await worker.fetch(updateRequest(cf, {
			method: "POST",
			headers: {
				"cf-ipcountry": "FR",
				"cf-region-code": "75",
				"cf-ipcity": "Paris",
				"cf-timezone": "Europe/Paris",
				"cf-connecting-ip": "192.0.2.1",
			},
			body: JSON.stringify({
				...featureBody,
				...spoofed,
				cf: spoofed,
				features: { ...featureBody.features, ...spoofed, runtimeUtcOffsetBucket: "utc_0" },
			}),
		}), env);
		expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
			indexes: ["2026.9.2"],
			blobs: [
				"2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "discord", "openai", "codex",
				...(present ? ["US", "CA", "San Francisco", "America/Los_Angeles"] : ["", "", "", ""]),
			],
			doubles: [1, 7, 14],
		});
	});

	it.each(["{", JSON.stringify({ schema: 2, features: {} }), "x".repeat(16_385)])(
		"retains baseline geography when the feature body is invalid: %#",
		async (body) => {
			const response = await worker.fetch(updateRequest(geography, { method: "POST", body }), env);
			await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
			expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
				indexes: ["2026.9.2"],
				blobs: ["2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "", "", "", "US", "CA", "San Francisco", "America/Los_Angeles"],
				doubles: [0, 0, 0],
			});
		},
	);

	it("still serves versions when a geography-enriched analytics write fails", async () => {
		writeDataPoint.mockImplementationOnce(() => { throw new Error("analytics unavailable"); });
		const response = await worker.fetch(updateRequest(geography), env);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
	});

	it("does not record geography when the recording quota is exhausted", async () => {
		const limit = vi.fn().mockResolvedValue({ success: false });
		const response = await worker.fetch(updateRequest(geography, {
			headers: { "cf-connecting-ip": "192.0.2.1" },
		}), { ...env, RATE_LIMIT: { limit } });
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(limit).toHaveBeenCalledExactlyOnceWith({ key: "192.0.2.1" });
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it.each([
		{ operation: "match", failure: "throws" },
		{ operation: "match", failure: "rejects" },
		{ operation: "put", failure: "throws" },
		{ operation: "put", failure: "rejects" },
	] as const)(
		"returns the upstream version when cache.$operation $failure",
		async ({ operation, failure }) => {
			const spy = vi.spyOn(cache, operation);
			if (failure === "throws") {
				spy.mockImplementationOnce(() => {
					throw new Error("cache unavailable");
				});
			} else {
				spy.mockRejectedValueOnce(new Error("cache unavailable"));
			}
			let response: Response;
			try {
				response = await worker.fetch(request("/api/latest-version"), env);
			} finally {
				expect(writeDataPoint).toHaveBeenCalledTimes(1);
			}
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
			expect(upstream).toHaveBeenCalledTimes(1);
		},
	);

	it.each(invalidBodies)("treats cached $label as a miss", async ({ body }) => {
		cache.store.set(versionUrl, new Response(body));
		let response: Response;
		try {
			response = await worker.fetch(request("/api/latest-version"), env);
		} finally {
			expect(writeDataPoint).toHaveBeenCalledTimes(1);
		}
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(upstream).toHaveBeenCalledTimes(1);
	});

	it("normalizes a valid cache hit without fetching upstream", async () => {
		cache.store.set(versionUrl, Response.json({ version: " 2026.9.2 " }));
		const response = await worker.fetch(request("/api/latest-version"), env);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(upstream).not.toHaveBeenCalled();
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
	});

	it("caches a valid upstream answer for five minutes and records each request once", async () => {
		for (let index = 0; index < 2; index++) {
			const response = await worker.fetch(request("/api/latest-version"), env);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("public, max-age=300");
			await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		}
		expect(cache.store.get(versionUrl)?.headers.get("cache-control")).toBe("public, max-age=300");
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(writeDataPoint).toHaveBeenCalledTimes(2);
	});

	it.each(invalidBodies)("returns 503 for upstream $label without caching it", async ({ body }) => {
		upstream.mockImplementationOnce(async () => new Response(body));
		const response = await worker.fetch(request("/api/latest-version"), env);
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toEqual({ error: "version_unavailable" });
		expect(cache.store.size).toBe(0);
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
	});

	it.each(["rejects", "unavailable"] as const)(
		"returns 503 when upstream %s despite a cache read failure",
		async (failure) => {
			vi.spyOn(cache, "match").mockRejectedValueOnce(new Error("cache unavailable"));
			if (failure === "rejects") upstream.mockRejectedValueOnce(new Error("upstream unavailable"));
			else upstream.mockImplementationOnce(async () => new Response(null, { status: 503 }));
			let response: Response;
			try {
				response = await worker.fetch(request("/api/latest-version"), env);
			} finally {
				expect(writeDataPoint).toHaveBeenCalledTimes(1);
			}
			expect(response.status).toBe(503);
			await expect(response.json()).resolves.toEqual({ error: "version_unavailable" });
			expect(cache.store.size).toBe(0);
		},
	);
});

describe("GET /api/stats", () => {
	let sqlCalls: number;
	let sqlAvailable: boolean;
	let cache: MemoryCache;

	beforeEach(() => {
		sqlCalls = 0;
		sqlAvailable = true;
		cache = memoryCache();
		vi.stubGlobal("caches", { default: cache });
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/analytics_engine/sql")) {
				sqlCalls += 1;
				return sqlAvailable ? Response.json(envelope(fixtureRows(String(init?.body)))) : new Response(null, { status: 503 });
			}
			if (url === "https://registry.npmjs.org/openclaw/latest") {
				return Response.json({ version: "2026.8.2" });
			}
			throw new Error(`unexpected fetch ${url}`);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("runs six Analytics Engine queries on a cold request", async () => {
		const response = await worker.fetch(
			new Request("https://telemetry.example/api/stats"),
			testEnv(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=600");
		expect(sqlCalls).toBe(6);
		const body = (await response.json()) as { versions: Array<{ version: string }> };
		expect(body.versions[0]?.version).toBe("2026.8.2");
		expect(Object.keys(body).sort()).toEqual([
			"channels", "featureMetadata", "generatedAt", "platforms", "plugins",
			"providerFamilies", "summary", "versions", "windowDays", "windowEnd", "windowStart",
		]);
	});

	it("restores the stats TTL on cache hits without resetting their age or using SQL or quota", async () => {
		const limit = vi.fn().mockResolvedValue({ success: true });
		const env = testEnv({ RATE_LIMIT: { limit } });
		const first = await worker.fetch(
			new Request("https://telemetry.example/api/stats"),
			env,
		);
		const firstBody = await first.json();
		expect(sqlCalls).toBe(6);
		limit.mockResolvedValue({ success: false });
		for (const stored of cache.store.values()) {
			stored.headers.set("age", "590");
			stored.headers.set("cache-control", "public, max-age=14400");
		}

		const second = await worker.fetch(
			new Request("https://telemetry.example/api/stats"),
			env,
		);
		expect(second.status).toBe(200);
		expect(sqlCalls).toBe(6);
		expect(cache.store.size).toBe(1);
		expect(limit).toHaveBeenCalledTimes(1);
		expect(second.headers.get("access-control-allow-origin")).toBe("*");
		expect(second.headers.get("age")).toBe("590");
		expect(second.headers.get("cache-control")).toBe("public, max-age=600");
		for (const stored of cache.store.values()) {
			expect(stored.headers.get("cache-control")).toBe("public, max-age=14400");
		}
		await expect(second.json()).resolves.toEqual(firstBody);
	});

	it.each([
		{ age: "600", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "14400", available: true, allowed: true, status: 200, queries: 12 },
		{ age: null, available: true, allowed: true, status: 200, queries: 12 },
		{ age: "invalid", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "1.5", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "1e-3", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "+1", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "-0", available: true, allowed: true, status: 200, queries: 12 },
		{ age: "601", available: false, allowed: true, status: 503, queries: 12 },
		{ age: "601", available: true, allowed: false, status: 429, queries: 6 },
	])("treats cache age $age as a miss (available=$available, allowed=$allowed)", async ({ age, available, allowed, status, queries }) => {
		const limit = vi.fn().mockResolvedValue({ success: true });
		const env = testEnv({ RATE_LIMIT: { limit } });
		expect((await worker.fetch(request(), env)).status).toBe(200);
		for (const stored of cache.store.values()) {
			stored.headers.set("cache-control", "public, max-age=14400");
			if (age === null) stored.headers.delete("age");
			else stored.headers.set("age", age);
		}
		sqlAvailable = available;
		limit.mockResolvedValue({ success: allowed });

		const response = await worker.fetch(request(), env);
		expect(response.status).toBe(status);
		expect(sqlCalls).toBe(queries);
		expect(limit).toHaveBeenCalledTimes(2);
		expect(response.headers.get("age")).toBeNull();
		expect(response.headers.get("cache-control")).toBe(status === 200 ? "public, max-age=600" : "no-store");
		if (status !== 200) {
			await expect(response.json()).resolves.toEqual({
				error: status === 429 ? "rate_limited" : "stats_unavailable",
			});
		}
	});

	it("rate-limits a cache miss before queryPublicStats", async () => {
		const limiter = {
			calls: 0,
			async limit() {
				limiter.calls += 1;
				return { success: false };
			},
		};
		const response = await worker.fetch(
			new Request("https://telemetry.example/api/stats", {
				headers: { "cf-connecting-ip": "203.0.113.9" },
			}),
			testEnv({ RATE_LIMIT: limiter }),
		);
		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
		expect(limiter.calls).toBe(1);
		expect(sqlCalls).toBe(0);
		expect(cache.store.size).toBe(0);
	});

	it("does not cache unavailable SQL and recovers on the next request", async () => {
		sqlAvailable = false;
		const unavailable = await worker.fetch(request(), testEnv());
		expect(unavailable.status).toBe(503);
		expect(unavailable.headers.get("cache-control")).toBe("no-store");
		await expect(unavailable.json()).resolves.toEqual({ error: "stats_unavailable" });
		expect(cache.store.size).toBe(0);
		sqlAvailable = true;
		const recovered = await worker.fetch(request(), testEnv());
		expect(recovered.status).toBe(200);
		expect(sqlCalls).toBe(12);
	});

	it.each(["match", "put"] as const)("serves successful SQL when cache.%s rejects", async (operation) => {
		vi.spyOn(cache, operation).mockRejectedValueOnce(new Error("cache unavailable"));
		const response = await worker.fetch(request(), testEnv());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=600");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		await expect(response.json()).resolves.toMatchObject({
			versions: [{ version: "2026.8.2", pings: 4 }],
		});
		expect(sqlCalls).toBe(6);
		if (operation === "put") {
			expect(cache.store.size).toBe(0);
			expect((await worker.fetch(request(), testEnv())).status).toBe(200);
			expect(sqlCalls).toBe(12);
		}
	});

	it("does not let recording traffic exhaust the stats budget", async () => {
		const limiter = countingLimiter();
		const writeDataPoint = vi.fn();
		const env = testEnv({ RATE_LIMIT: limiter, TELEMETRY: { writeDataPoint } });
		for (let i = 0; i < 21; i++) {
			expect((await worker.fetch(request("/api/latest-version"), env)).status).toBe(200);
		}
		expect(writeDataPoint).toHaveBeenCalledTimes(20);
		expect((await worker.fetch(request(), env)).status).toBe(200);
		expect(sqlCalls).toBe(6);
	});

	it("preserves the existing recording counter when stats misses exhaust their budget", async () => {
		const limiter = countingLimiter();
		// Recording traffic from before the change must keep its original counter.
		limiter.counts.set("203.0.113.9", 19);
		const writeDataPoint = vi.fn();
		const env = testEnv({ RATE_LIMIT: limiter, TELEMETRY: { writeDataPoint } });
		sqlAvailable = false;
		for (let i = 0; i < 20; i++) {
			expect((await worker.fetch(request(), env)).status).toBe(503);
		}
		expect((await worker.fetch(request(), env)).status).toBe(429);
		expect(sqlCalls).toBe(120);
		for (let i = 0; i < 2; i++) {
			expect((await worker.fetch(request("/api/latest-version"), env)).status).toBe(200);
		}
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
	});
});
