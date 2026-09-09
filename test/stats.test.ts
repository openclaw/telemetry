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

	it.each([
		{ label: "valid", bucket: "pos_6_12", stored: "pos_6_12" },
		{ label: "absent", bucket: undefined, stored: "" },
		{ label: "invalid", bucket: "Asia/Singapore", stored: "" },
	])("records a $label UTC-offset bucket without changing the version response", async ({ bucket, stored }) => {
		const response = await worker.fetch(new Request("https://telemetry.example/api/latest-version", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "openclaw/2026.9.2 (linux; node/v24.0.0; x64; gateway)",
			},
			body: JSON.stringify({
				schema: 1,
				features: {
					channels: ["DISCORD", "private-channel"],
					providerFamilies: ["OPENAI", "private-provider"],
					plugins: ["CODEX", "private-plugin"],
					pluginsEnabled: 7,
					sessionsLast24h: 14,
					...(bucket === undefined ? {} : { runtimeUtcOffsetBucket: bucket }),
				},
			}),
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
				"discord", "openai", "codex", stored,
			],
			doubles: [1, 7, 14],
		});
	});

	it("records an update-only request with an empty offset column", async () => {
		const response = await worker.fetch(new Request("https://telemetry.example/api/latest-version", {
			headers: { "user-agent": "openclaw/2026.9.2 (linux; node/v24.0.0; x64; gateway)" },
		}), env);
		await expect(response.json()).resolves.toEqual({ version: "2026.9.2" });
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
		expect(writeDataPoint).toHaveBeenCalledWith({
			indexes: ["2026.9.2"],
			blobs: ["2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "", "", "", ""],
			doubles: [0, 0, 0],
		});
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
