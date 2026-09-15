import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

// Reuse Wrangler's pinned bundler and workerd harness without another toolchain.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });

describe("update checks over workerd HTTP", () => {
	let script;
	let recordingScript;
	let runtime;

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
		runtime = new Miniflare(convertV4MiniflareOptions({
			modules: true,
			script: workerScript,
			compatibilityDate: rawConfig.compatibility_date,
			compatibilityFlags: rawConfig.compatibility_flags,
			port: 0,
			cf: false,
			ratelimits: Object.fromEntries(rawConfig.ratelimits.map(({ name, ...limit }) => [name, limit])),
			analyticsEngineDatasets: { TELEMETRY: { dataset: "test_telemetry" } },
			outboundService: async (request) => {
				const url = new URL(request.url);
				if (url.href === "https://registry.npmjs.org/openclaw/latest") {
					return Response.json({ version: "2026.8.2" });
				}
				throw new Error("unexpected outbound request");
			},
		}));
		await runtime.ready;
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

	it("retires public stats over HTTP while update checks remain available", async () => {
		await start();
		const origin = await runtime.ready;
		const stats = await fetch(new URL("/api/stats", origin));
		expect(stats.status).toBe(404);
		expect(stats.headers.get("cache-control")).toBe("no-store");
		await expect(stats.json()).resolves.toEqual({ error: "not_found" });
		const update = await fetch(new URL("/api/latest-version", origin));
		expect(update.status).toBe(200);
		await expect(update.json()).resolves.toEqual({ version: "2026.8.2" });
	}, 30_000);
});
