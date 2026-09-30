import { createRequire } from "node:module";
import { Agent, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
const outcomeFixture = JSON.parse(readFileSync(new URL("./fixtures/update-result.json", import.meta.url), "utf8"));
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
	let guardScript;
	let outboundCalls;
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
							let outcomePoint;
							// Inject Unicode here: Miniflare's cf override header corrupts it in transit.
							const incoming = new Request(request, {
								cf: { ...request.cf, city: " Sa\\u0303o Paulo " },
							});
							const response = await worker.fetch(incoming, {
								...env,
								UPDATE_RESULTS: { writeDataPoint(value) {
									env.UPDATE_RESULTS.writeDataPoint(value);
									outcomePoint = value;
								} },
								TELEMETRY: { writeDataPoint(value) {
									env.TELEMETRY.writeDataPoint(value);
									point = value;
								} },
							});
							return Response.json({ status: response.status, body: await response.json(), point, outcomePoint });
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
		const guardBundle = await build({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
					import worker from "./src/index.ts";
					export default {
						async fetch(request, env) {
							const counts = { daily: 0, outcomes: 0, quota: 0, geography: 0 };
							Object.defineProperty(request, "cf", { get() { counts.geography++; throw new Error("unexpected geography"); } });
							const response = await worker.fetch(request, {
								TELEMETRY: { writeDataPoint() { counts.daily++; } },
								...(env.UPDATE_RESULTS ? { UPDATE_RESULTS: { writeDataPoint() { counts.outcomes++; } } } : {}),
								RATE_LIMIT: { async limit() { counts.quota++; return { success: false }; } },
							});
							const headers = new Headers(response.headers);
							headers.set("X-Test-Counts", JSON.stringify(counts));
							return new Response(response.body, { status: response.status, headers });
						}
					};
				`,
			},
			bundle: true, format: "esm", platform: "browser", write: false,
		});
		guardScript = guardBundle.outputFiles[0].text;
	});

	afterEach(async () => {
		await runtime?.dispose();
	});

	async function start(workerScript = script, outcomes = true) {
		outboundCalls = 0;
		runtime = new Miniflare(convertV4MiniflareOptions({
			modules: true,
			script: workerScript,
			compatibilityDate: rawConfig.compatibility_date,
			compatibilityFlags: rawConfig.compatibility_flags,
			port: 0,
			cf: false,
			ratelimits: Object.fromEntries(rawConfig.ratelimits.map(({ name, ...limit }) => [name, limit])),
			analyticsEngineDatasets: { TELEMETRY: { dataset: "test_telemetry" }, ...(outcomes ? { UPDATE_RESULTS: { dataset: "test_update_results" } } : {}) },
			outboundService: async (request) => {
				outboundCalls++;
				const url = new URL(request.url);
				if (url.href === "https://registry.npmjs.org/openclaw/latest") {
					return Response.json({ version: "2026.8.2" });
				}
				throw new Error("unexpected outbound request");
			},
		}));
		await runtime.ready;
	}

	it.each([false, true])("HEAD capability over real HTTP, binding present: %s", async (present) => {
		await start(guardScript, present);
		const response = await fetch(new URL("/api/latest-version?configured=1", await runtime.ready), {
			method: "HEAD", headers: { "user-agent": "openclaw-update-result/1" }, redirect: "error",
		});
		expect(response.status).toBe(present ? 204 : 503);
		expect(response.headers.get("OpenClaw-Update-Results")).toBe(present ? "2" : null);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("");
		expect(JSON.parse(response.headers.get("X-Test-Counts"))).toEqual({ daily: 0, outcomes: 0, quota: 0, geography: 0 });
		expect(outboundCalls).toBe(0);
	}, 30_000);

	it("default production bindings fail closed on HEAD and outcome POST over HTTP", async () => {
		await start(script, false);
		const url = new URL("/api/latest-version", await runtime.ready);
		const head = await fetch(url, { method: "HEAD" });
		expect(head.status).toBe(503);
		expect(head.headers.get("openclaw-update-results")).toBeNull();
		const response = await fetch(url, { method: "POST", body: JSON.stringify(outcomeFixture), headers: { "user-agent": "openclaw-update-result/1" } });
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({ error: "update_results_unavailable" });
		expect(outboundCalls).toBe(0);
	}, 30_000);

	it.each(["openclaw-update-result/1", "legacy-feature-agent"])("answers an unfinished quota-exhausted upload over real HTTP: %s", async (agent) => {
		await start(guardScript);
		const url = new URL("/api/latest-version", await runtime.ready);
		// Loopback proof must not use the host's environment-proxy global agent.
		const localAgent = new Agent();
		const response = await new Promise((resolve, reject) => {
			const request = httpRequest(url, { agent: localAgent, method: "POST", headers: { "user-agent": agent, "content-type": "application/json", "transfer-encoding": "chunked" } });
			const timer = setTimeout(() => { request.destroy(); reject(new Error("receiver waited for unfinished upload")); }, 1000);
			request.on("error", (error) => { clearTimeout(timer); reject(error); });
			request.on("response", (response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => { body += chunk; });
				response.on("end", () => {
					clearTimeout(timer);
					try { resolve({ status: response.statusCode, body: JSON.parse(body), counts: JSON.parse(response.headers["x-test-counts"]) }); }
					catch (error) { reject(error); }
					finally { request.destroy(); }
				});
			});
			request.flushHeaders();
			request.write("{"); // Deliberately never end the chunked request.
		}).finally(() => localAgent.destroy());
		expect(response).toEqual({ status: 200, body: { version: "2026.8.2" }, counts: { daily: 0, outcomes: 0, quota: 1, geography: 0 } });
		expect(outboundCalls).toBe(1);
	}, 30_000);

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

	it("isolates schema-2 outcomes and rejects invalid uploads over local HTTP", async () => {
		await start(recordingScript);
		const origin = await runtime.ready;
		const raw = JSON.stringify(outcomeFixture);
		for (const [body, status] of [
			[raw, 200],
			[JSON.stringify({ ...outcomeFixture, installId: "synthetic-private-id" }), 400],
			[JSON.stringify({ ...outcomeFixture, targetVersion: "private-build-sha" }), 400],
			[raw.padEnd(4097), 400],
			[Buffer.from([0xff]), 400],
		]) {
			const response = await fetch(new URL("/api/latest-version", origin), {
				method: "POST", body,
				headers: { "content-type": "application/json", "user-agent": "openclaw-update-result/1" },
			});
			const result = await response.json();
			expect(result.status).toBe(status);
			expect(result.point).toBeUndefined();
			if (status === 200) {
				expect(result.outcomePoint).toEqual({
					indexes: ["2026.9.19"],
					blobs: ["update_result", "succeeded", "2026.9.4", "2026.9.19", "2026.9.19", "2026.9.19", "linux", "x64", "npm-global", "stable", "under-1m", "passed", "none", "none", "none", "not-needed", "unknown"],
					doubles: [2],
				});
			} else {
				expect(result.outcomePoint).toBeUndefined();
				expect(result.body).toEqual({ error: "invalid_update_result" });
			}
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

	it("drops malformed UTF-8 feature bodies while serving updates over HTTP", async () => {
		await start(recordingScript);
		const origin = await runtime.ready;
		const response = await fetch(new URL("/api/latest-version", origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: Buffer.concat([
				Buffer.from('{"schema":1,"features":{"plugins":["codex"],"pluginsEnabled":7},"ignored":"'),
				Buffer.from([0xff]),
				Buffer.from('"}'),
			]),
		});
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result.status).toBe(200);
		expect(result.body).toEqual({ version: "2026.8.2" });
		expect(result.point.doubles).toEqual([0, 0, 0]);
		expect(result.point.blobs.slice(5, 8)).toEqual(["", "", ""]);
	}, 30_000);
});
