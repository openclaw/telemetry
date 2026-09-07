import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

// Reuse Wrangler's pinned bundler and workerd harness without another toolchain.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });

describe("stats over workerd HTTP", () => {
	let script;
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
	});

	afterEach(async () => {
		await runtime?.dispose();
	});

	async function start() {
		sqlCalls = 0;
		sqlAvailable = true;
		runtime = new Miniflare(convertV4MiniflareOptions({
			modules: true,
			script,
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
					const data = sql.includes("AS version")
						? [{ version: "2026.8.2", pings: 4 }]
						: sql.includes("AS platform")
							? [{ platform: "darwin", pings: 4 }]
							: [{ channels: "telegram", providers: "anthropic", plugins: "codex", pings: 4 }];
					return Response.json({ data });
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

	it("fills the real cache, reuses it past quota, and denies a cold miss without SQL", async () => {
		await start();
		const first = await get();
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("public, max-age=600");
		expect(first.headers.get("access-control-allow-origin")).toBe("*");
		const body = await first.json();
		expect(body.versions).toEqual([{ version: "2026.8.2", pings: 4 }]);
		expect(sqlCalls).toBe(3);

		const { RATE_LIMIT } = await runtime.getBindings();
		for (let i = 0; i < 19; i++) {
			expect(await RATE_LIMIT.limit({ key: "stats:203.0.113.9" })).toEqual({ success: true });
		}
		expect(await RATE_LIMIT.limit({ key: "stats:203.0.113.9" })).toEqual({ success: false });
		const warm = await get("/api/stats?ignored=1");
		expect(warm.status).toBe(200);
		await expect(warm.json()).resolves.toEqual(body);
		expect(sqlCalls).toBe(3);

		const cache = (await runtime.getCaches()).default;
		expect(await cache.delete("https://telemetry.openclaw.ai/api/stats")).toBe(true);
		const denied = await get();
		expect(denied.status).toBe(429);
		await expect(denied.json()).resolves.toEqual({ error: "rate_limited" });
		expect(denied.headers.get("cache-control")).toBe("no-store");
		expect(sqlCalls).toBe(3);
		console.log("workerd: fill=200 hit=200 same-body=true SQL=3; cold-over-quota=429 additional-SQL=0");
	}, 30_000);

	it("does not cache failed SQL responses", async () => {
		await start();
		sqlAvailable = false;
		for (let i = 0; i < 2; i++) {
			const failed = await get();
			expect(failed.status).toBe(503);
			await expect(failed.json()).resolves.toEqual({ error: "stats_unavailable" });
		}
		expect(sqlCalls).toBe(6);
		sqlAvailable = true;
		expect((await get()).status).toBe(200);
		expect((await get()).status).toBe(200);
		expect(sqlCalls).toBe(9);
		console.log("workerd: unavailable=503,503 SQL=6; recovery=200 hit=200 total-SQL=9");
	}, 30_000);

	it("keeps recording and stats-miss quotas independent in both directions", async () => {
		await start();
		for (let i = 0; i < 20; i++) {
			expect((await get("/api/latest-version")).status).toBe(200);
		}
		expect((await get()).status).toBe(200);
		const cache = (await runtime.getCaches()).default;
		await cache.delete("https://telemetry.openclaw.ai/api/stats");

		sqlAvailable = false;
		for (let i = 0; i < 20; i++) {
			expect((await get("/api/stats", "198.51.100.9")).status).toBe(503);
		}
		expect((await get("/api/stats", "198.51.100.9")).status).toBe(429);
		expect(sqlCalls).toBe(63);
		expect((await get("/api/latest-version", "198.51.100.9")).status).toBe(200);
		const { RATE_LIMIT } = await runtime.getBindings();
		for (let i = 0; i < 19; i++) {
			expect(await RATE_LIMIT.limit({ key: "198.51.100.9" })).toEqual({ success: true });
		}
		expect(await RATE_LIMIT.limit({ key: "198.51.100.9" })).toEqual({ success: false });
		console.log("workerd: 20 recordings then stats=200; 20 failed stats then stats=429; recording budget intact");
	}, 30_000);
});
