import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
import { envelope, fixtureRows } from "./fixtures/stats-sql.js";

// Reuse Wrangler's pinned bundler and workerd harness without another toolchain.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Response: RuntimeResponse, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });

describe("stats over workerd HTTP", () => {
	let script;
	let recordingScript;
	let runtime;
	let sqlCalls;
	let sqlAvailable;

	beforeAll(async () => {
		const bundle = await build({
			entryPoints: ["src/index.ts"],
			bundle: true,
			format: "esm",
			platform: "browser",
			write: false,
		});
		script = bundle.outputFiles[0].text;
		const recordingBundle = await build({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
					import worker from "./src/index.ts";
					export default {
						async fetch(request, env) {
							let point;
							// Inject Unicode here: Miniflare's cf override header corrupts it in transit.
							const incoming = new Request(request, {
								cf: { ...request.cf, city: " Sa\\u0303o Paulo " },
							});
							const response = await worker.fetch(incoming, {
								...env,
								TELEMETRY: { writeDataPoint(value) {
									env.TELEMETRY.writeDataPoint(value);
									point = value;
								} },
							});
							return Response.json({ status: response.status, body: await response.json(), point });
						},
					};
				`,
			},
			bundle: true,
			format: "esm",
			platform: "browser",
			write: false,
		});
		recordingScript = recordingBundle.outputFiles[0].text;
	});

	afterEach(async () => {
		await runtime?.dispose();
	});

	async function start(workerScript = script) {
		// Real binding windows reset on wall-clock boundaries. Start with time for the quota assertions.
		const period = rawConfig.ratelimits.find(({ name }) => name === "RATE_LIMIT").simple.period * 1000;
		const remaining = period - Date.now() % period;
		if (remaining < 5000) await delay(remaining + 50);
		sqlCalls = 0;
		sqlAvailable = true;
		runtime = new Miniflare(convertV4MiniflareOptions({
			modules: true,
			script: workerScript,
			compatibilityDate: rawConfig.compatibility_date,
			compatibilityFlags: rawConfig.compatibility_flags,
			port: 0,
			cf: false,
			bindings: { ACCOUNT_ID: "test-account", ANALYTICS_READ_TOKEN: "test-token" },
			ratelimits: Object.fromEntries(rawConfig.ratelimits.map(({ name, ...limit }) => [name, limit])),
			analyticsEngineDatasets: { TELEMETRY: { dataset: "test_telemetry" } },
			outboundService: async (request) => {
				const url = new URL(request.url);
				if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/analytics_engine/sql")) {
					sqlCalls++;
					if (!sqlAvailable) return new Response(null, { status: 503 });
					const sql = await request.text();
					return Response.json(envelope(fixtureRows(sql)));
				}
				if (url.href === "https://registry.npmjs.org/openclaw/latest") {
					return Response.json({ version: "2026.8.2" });
				}
				throw new Error("unexpected outbound request");
			},
		}));
		await runtime.ready;
	}

	async function get(path = "/api/stats", ip = "203.0.113.9") {
		return fetch(new URL(path, await runtime.ready), {
			headers: { "cf-connecting-ip": ip },
		});
	}

	it("validates named timezones and Unicode geography inside the pinned workerd runtime", async () => {
		await start(recordingScript);
		for (const [timezone, stored] of [
			["America/Los_Angeles", "America/Los_Angeles"],
			["UTC", "UTC"],
			["US/Eastern", "US/Eastern"],
			["Etc/GMT+5", "Etc/GMT+5"],
			["+05:00", ""],
			["Invalid/Zone", ""],
		]) {
			const response = await runtime.dispatchFetch("https://telemetry.example/api/latest-version", {
				headers: { "user-agent": "openclaw/2026.9.2 (linux; node/v24.0.0; x64; gateway)" },
				cf: { country: "BR", regionCode: "SP", timezone },
			});
			await expect(response.json()).resolves.toEqual({
				status: 200,
				body: { version: "2026.8.2" },
				point: {
					indexes: ["2026.9.2"],
					blobs: ["2026.9.2", "linux", "x64", "node/v24.0.0", "gateway", "", "", "", "BR", "SP", "S\u00e3o Paulo", stored],
					doubles: [0, 0, 0],
				},
			});
		}
	}, 30_000);

	it("fills the real cache, reuses it past quota, and denies a cold miss without SQL", async () => {
		await start();
		const first = await get();
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("public, max-age=600");
		expect(first.headers.get("access-control-allow-origin")).toBe("*");
		const body = await first.json();
		expect(body.versions).toEqual([{ version: "2026.8.2", pings: 4, featureReports: 4 }]);
		expect(body.architectures).toEqual([{ architecture: "arm64", pings: 4, featureReports: 4 }]);
		expect(sqlCalls).toBe(7);

		const { RATE_LIMIT } = await runtime.getBindings();
		for (let i = 0; i < 19; i++) {
			expect(await RATE_LIMIT.limit({ key: "stats:203.0.113.9" })).toEqual({ success: true });
		}
		expect(await RATE_LIMIT.limit({ key: "stats:203.0.113.9" })).toEqual({ success: false });
		const warm = await get("/api/stats?ignored=1");
		expect(warm.status).toBe(200);
		await expect(warm.json()).resolves.toEqual(body);
		expect(sqlCalls).toBe(7);

		const cache = (await runtime.getCaches()).default;
		expect(await cache.delete("https://telemetry.openclaw.ai/api/stats?cache=reports-v2")).toBe(true);
		const denied = await get();
		expect(denied.status).toBe(429);
		await expect(denied.json()).resolves.toEqual({ error: "rate_limited" });
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(sqlCalls).toBe(7);
		console.log("workerd: fill=200 hit=200 same-body=true SQL=7; cold-over-quota=429 additional-SQL=0");
	}, 30_000);

	it("does not cache failed SQL responses", async () => {
		await start();
		sqlAvailable = false;
		for (let i = 0; i < 2; i++) {
			const failed = await get();
			expect(failed.status).toBe(503);
			await expect(failed.json()).resolves.toEqual({ error: "stats_unavailable" });
		}
		expect(sqlCalls).toBe(14);
		sqlAvailable = true;
		expect((await get()).status).toBe(200);
		expect((await get()).status).toBe(200);
		expect(sqlCalls).toBe(21);
		console.log("workerd: unavailable=503,503 SQL=14; recovery=200 hit=200 total-SQL=21");
	}, 30_000);

	it("preserves old cached payloads and their age, then refreshes expired entries to the additive contract", async () => {
		await start();
		const first = await get();
		expect(first.status).toBe(200);
		const previous = await first.json();
		delete previous.architectures;
		for (const row of [...previous.versions, ...previous.platforms]) delete row.featureReports;
		const body = JSON.stringify(previous);
		const cache = (await runtime.getCaches()).default;
		const key = "https://telemetry.openclaw.ai/api/stats?cache=reports-v2";
		const putAged = (age) => cache.put(key, new RuntimeResponse(body, {
			headers: {
				"content-type": "application/json; charset=utf-8",
				"cache-control": "public, max-age=14400",
				"access-control-allow-origin": "*",
				age: String(age),
			},
		}));

		await putAged(590);
		const warm = await get();
		expect(warm.status).toBe(200);
		expect(warm.headers.get("cache-control")).toBe("public, max-age=600");
		expect(Number(warm.headers.get("age"))).toBeGreaterThanOrEqual(590);
		expect(Number(warm.headers.get("age"))).toBeLessThan(600);
		expect(warm.headers.get("access-control-allow-origin")).toBe("*");
		await expect(warm.text()).resolves.toBe(body);
		expect(sqlCalls).toBe(7);

		await putAged(600);
		const refreshed = await get();
		expect(refreshed.status).toBe(200);
		expect(refreshed.headers.get("cache-control")).toBe("public, max-age=600");
		expect(refreshed.headers.get("age")).toBeNull();
		await expect(refreshed.json()).resolves.toMatchObject({
			versions: [{ version: "2026.8.2", pings: 4, featureReports: 4 }],
			architectures: [{ architecture: "arm64", pings: 4, featureReports: 4 }],
		});
		expect(sqlCalls).toBe(14);
		console.log("workerd: old cache body/Age preserved with TTL=600; Age=600 refresh adds SQL=7 and cohort fields");
	}, 30_000);

	it("keeps recording and stats-miss quotas independent in both directions", async () => {
		await start();
		for (let i = 0; i < 20; i++) {
			expect((await get("/api/latest-version")).status).toBe(200);
		}
		expect((await get()).status).toBe(200);
		const cache = (await runtime.getCaches()).default;
		await cache.delete("https://telemetry.openclaw.ai/api/stats?cache=reports-v2");

		sqlAvailable = false;
		for (let i = 0; i < 20; i++) {
			expect((await get("/api/stats", "198.51.100.9")).status).toBe(503);
		}
		expect((await get("/api/stats", "198.51.100.9")).status).toBe(429);
		expect(sqlCalls).toBe(147);
		expect((await get("/api/latest-version", "198.51.100.9")).status).toBe(200);
		const { RATE_LIMIT } = await runtime.getBindings();
		for (let i = 0; i < 19; i++) {
			expect(await RATE_LIMIT.limit({ key: "198.51.100.9" })).toEqual({ success: true });
		}
		expect(await RATE_LIMIT.limit({ key: "198.51.100.9" })).toEqual({ success: false });
		console.log("workerd: 20 recordings then stats=200; 20 failed stats then stats=429; recording budget intact");
	}, 30_000);
});
