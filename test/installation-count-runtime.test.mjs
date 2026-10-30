import { createRequire } from "node:module";
import { Agent, request as httpRequest } from "node:http";
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const { rawConfig: local } = experimental_readRawConfig({ config: "wrangler.local.jsonc" });
const migration = readFileSync("migrations/0001_installation_counts.sql", "utf8");
const outcome = readFileSync("test/fixtures/update-result.json", "utf8");
const day = Math.floor(Date.now() / 86_400_000);
const header = (gap = 31, d = day) => "1;" + d + ";" + gap;

const COUNT_HEADER = "OpenClaw-Installation-Count";
const COUNT_UA = "openclaw-installation-count/1";
describe("capability-gated count-only HTTP and persisted D1", () => {
	let script, guardScript, runtime, db, persist, outboundCalls;
	beforeAll(async () => {
		const options = { bundle: true, format: "esm", platform: "browser", write: false };
		script = (await build({ ...options, entryPoints: ["src/index.ts"] })).outputFiles[0].text;
		guardScript = (await build({ ...options, stdin: { resolveDir: process.cwd(), contents: `
			import worker from "./src/index.ts";
			export default { async fetch(request, env) {
				const calls = { daily: 0, outcomes: 0, geography: 0, bodyReads: 0 };
				Object.defineProperty(request, "cf", { get() { calls.geography++; throw new Error("unexpected geography"); } });
				const body = request.body;
				if (body) Object.defineProperty(body, "getReader", { value() { calls.bodyReads++; throw new Error("unexpected body read"); } });
				const response = await worker.fetch(request, { ...env,
					TELEMETRY: { writeDataPoint() { calls.daily++; } },
					UPDATE_RESULTS: { writeDataPoint() { calls.outcomes++; } },
				});
				// Test-only lost acknowledgement after the real D1 write completed.
				if (request.headers.get("X-Test-Lose-Ack") === "1" && response.status === 204) return new Response(null, { status: 503 });
				const headers = new Headers(response.headers);
				headers.set("X-Test-Calls", JSON.stringify(calls));
				headers.set("X-Test-Body-Shape", JSON.stringify({ nullBody: body === null, length: request.headers.get("content-length") }));
				return new Response(response.body, { status: response.status, headers });
			}, scheduled: worker.scheduled };
		` } })).outputFiles[0].text;
	});
	afterEach(async () => { await runtime?.dispose(); if (persist) rmSync(persist, { recursive: true, force: true }); persist = undefined; });
	async function start({ binding = true, migrate = true, rateLimit = false, versionAvailable = true, guard = false } = {}) {
		mkdirSync(".wrangler", { recursive: true });
		persist ??= mkdtempSync(resolve(".wrangler/installation-count-test-"));
		outboundCalls = 0;
		runtime = new Miniflare(convertV4MiniflareOptions({
			modules: true, script: guard ? guardScript : script, port: 0, cf: false,
			compatibilityDate: local.compatibility_date, compatibilityFlags: local.compatibility_flags,
			d1Databases: binding ? { INSTALLATION_COUNTS: local.d1_databases[0].database_id } : {},
			resourcePersistencePath: persist, logRequests: false,
			analyticsEngineDatasets: { TELEMETRY: { dataset: "synthetic_daily" }, UPDATE_RESULTS: { dataset: "synthetic_outcomes" } },
			...(rateLimit ? { ratelimits: { RATE_LIMIT: { namespace_id: "1001", simple: { limit: 1, period: 60 } } } } : {}),
			outboundService: async (request) => {
				outboundCalls++;
				if (request.url !== "https://registry.npmjs.org/openclaw/latest") throw new Error("unexpected outbound request");
				return versionAvailable ? Response.json({ version: "2026.10.28" }) : new Response(null, { status: 503 });
			},
		}));
		await runtime.ready;
		if (binding) { db = await runtime.getD1Database("INSTALLATION_COUNTS"); if (migrate) await db.prepare(migration).run(); }
	}
	async function send(value = header(), init = {}) {
		const headers = new Headers({ "user-agent": COUNT_UA, ...init.headers });
		if (value !== null) headers.set(COUNT_HEADER, value);
		const response = await fetch(new URL("/api/latest-version", await runtime.ready), { method: "POST", ...init, headers, redirect: "error" });
		expect(await response.text()).toBe("");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get(COUNT_HEADER)).toBeNull();
		if (response.headers.has("X-Test-Calls")) expect(JSON.parse(response.headers.get("X-Test-Calls"))).toEqual({ daily: 0, outcomes: 0, geography: 0, bodyReads: 0 });
		return response;
	}
	async function rows() { return (await db.prepare("SELECT day, gap, reports FROM installation_counts ORDER BY day, gap").all()).results; }
	async function update(init = {}) {
		const response = await fetch(new URL("/api/latest-version", await runtime.ready), init);
		expect(await response.json()).toEqual({ version: "2026.10.28" });
		return response;
	}
	it.each([false, true])("ordinary GET/schema1 capability is fresh and storage-gated: %s", async (binding) => {
		await start({ binding });
		for (const init of [{}, { method: "POST", body: JSON.stringify({ schema: 1, features: {} }) }]) {
			const response = await update(init);
			expect(response.status).toBe(200);
			expect(response.headers.get(COUNT_HEADER)).toBe(binding ? "1;" + day : null);
			expect(response.headers.get("cache-control")).toBe(binding ? "no-store" : "public, max-age=300");
		}
		expect(outboundCalls).toBe(1); // Existing npm cache still works.
		if (binding) expect(await rows()).toEqual([]); // A capability is not a count.
	}, 30_000);
	it("never advertises capability on HEAD, outcomes, invalid feature uploads or errors", async () => {
		await start();
		for (const init of [{ method: "HEAD" }, { method: "POST", body: outcome },
			{ method: "POST", body: "{", headers: { "user-agent": "openclaw-update-result/1" } },
			{ method: "POST", body: "{" }, { headers: { "user-agent": "openclaw-update-result/1" } }]) {
			const response = await fetch(new URL("/api/latest-version", await runtime.ready), init);
			expect(response.headers.get(COUNT_HEADER)).toBeNull();
			await response.arrayBuffer();
		}
		expect(await rows()).toEqual([]);
	}, 30_000);
	it("version errors cannot advertise or increment counts", async () => {
		await start({ versionAvailable: false });
		const response = await fetch(new URL("/api/latest-version", await runtime.ready));
		expect(response.status).toBe(503);
		expect(response.headers.get(COUNT_HEADER)).toBeNull();
		expect(await response.json()).toEqual({ error: "version_unavailable" });
		expect(await rows()).toEqual([]);
	}, 30_000);
	it("atomically increments count-only posts and persists only three histogram columns across restart", async () => {
		await start({ guard: true });
		const responses = await Promise.all(Array.from({ length: 40 }, () => send(header(7))));
		expect(responses.every((response) => response.status === 204)).toBe(true);
		await send(header(31)); await send(header(1, day - 1), { body: "" });
		const expected = [{ day: day - 1, gap: 1, reports: 1 }, { day, gap: 7, reports: 40 }, { day, gap: 31, reports: 1 }];
		expect(await rows()).toEqual(expected);
		expect((await db.prepare("PRAGMA table_info(installation_counts)").all()).results.map((column) => column.name)).toEqual(["day", "gap", "reports"]);
		expect(outboundCalls).toBe(0);
		await runtime.dispose(); await start({ migrate: false }); expect(await rows()).toEqual(expected);
	}, 30_000);
	it("real Node fetch no-body POST passes zero-length framing without reading the workerd stream", async () => {
		await start({ guard: true });
		const response = await send();
		expect(response.status).toBe(204);
		expect(JSON.parse(response.headers.get("X-Test-Body-Shape"))).toEqual({ nullBody: false, length: "0" });
		expect(await rows()).toEqual([{ day, gap: 31, reports: 1 }]);
		expect(outboundCalls).toBe(0);
	}, 30_000);
	it("header-selected stalled chunked upload is rejected before any body read", async () => {
		await start({ guard: true });
		const url = new URL("/api/latest-version", await runtime.ready);
		const agent = new Agent();
		const response = await new Promise((resolve, reject) => {
			const request = httpRequest(url, { agent, method: "POST", headers: {
				"user-agent": COUNT_UA, [COUNT_HEADER]: header(), "transfer-encoding": "chunked",
			} });
			const timer = setTimeout(() => { request.destroy(); reject(new Error("count receiver waited for stalled body")); }, 1000);
			request.on("error", (error) => { clearTimeout(timer); reject(error); });
			request.on("response", (incoming) => {
				let body = "";
				incoming.setEncoding("utf8"); incoming.on("data", (chunk) => { body += chunk; });
				incoming.on("end", () => {
					clearTimeout(timer);
					resolve({ status: incoming.statusCode, body, calls: JSON.parse(incoming.headers["x-test-calls"]) });
					request.destroy();
				});
			});
			request.flushHeaders(); // Send no body bytes and never end the request.
		}).finally(() => agent.destroy());
		expect(response).toEqual({ status: 400, body: "", calls: { daily: 0, outcomes: 0, geography: 0, bodyReads: 0 } });
		expect(await rows()).toEqual([]); expect(outboundCalls).toBe(0);
	}, 30_000);
	it("a lost HTTP acknowledgement after committed D1 storage does not trigger a receiver retry", async () => {
		await start({ guard: true });
		const response = await fetch(new URL("/api/latest-version", await runtime.ready), { method: "POST", headers: { "user-agent": COUNT_UA, [COUNT_HEADER]: header(), "X-Test-Lose-Ack": "1" } });
		expect(response.status).toBe(503); await response.arrayBuffer();
		expect(await rows()).toEqual([{ day, gap: 31, reports: 1 }]);
		expect(outboundCalls).toBe(0);
	}, 30_000);
	it("any header presence fails closed before raw analytics, geography, outcomes or npm", async () => {
		await start({ guard: true });
		for (const value of [null, "", header(0), header(32), header(1, day + 1), header(1, day - 2), header() + ", " + header(), "2;" + day + ";1", "1;" + day + ";01", "1;" + day + ";1;id"]) expect((await send(value)).status).toBe(400);
		for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) expect((await send(header(), { method })).status).toBe(400);
		for (const agent of ["legacy-feature-agent", "openclaw-update-result/1", ""]) expect((await send(header(), { headers: { "user-agent": agent } })).status).toBe(400);
		for (const body of [" ", "{", JSON.stringify({ schema: 1, features: {}, installId: "synthetic-private-id" }), outcome, "x".repeat(16_385)]) expect((await send(header(), { body })).status).toBe(400);
		// No Content-Length: reject framed/present body without reading any chunk.
		expect((await send(header(), { body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); controller.close(); } }), duplex: "half" })).status).toBe(400);
		expect(outboundCalls).toBe(0); expect(await rows()).toEqual([]);
	}, 30_000);
	it("DNT and exhausted existing limiter ignore counts without update lookups", async () => {
		await start({ guard: true, rateLimit: true });
		expect((await send(header(), { headers: { DNT: "1" } })).status).toBe(204);
		for (let i = 0; i < 3; i++) expect((await send()).status).toBe(204);
		expect(await rows()).toEqual([]); expect(outboundCalls).toBe(0);
	}, 30_000);
	it("existing limiter admits one count, silently drops the rest, and leaves ordinary updates available", async () => {
		await start({ rateLimit: true });
		for (let i = 0; i < 3; i++) expect((await send()).status).toBe(204);
		expect(await rows()).toEqual([{ day, gap: 31, reports: 1 }]);
		expect((await update()).status).toBe(200);
	}, 30_000);
	it.each([{ binding: false, status: 204 }, { migrate: false, status: 503 }])("optional D1 unavailable stays isolated: %j", async ({ status, ...options }) => {
		await start(options); expect((await send()).status).toBe(status); expect(outboundCalls).toBe(0);
		expect((await update()).status).toBe(200);
	}, 30_000);
	it("prunes old days during ingestion and scheduled cleanup, including idle histograms", async () => {
		await start();
		await db.prepare("INSERT INTO installation_counts VALUES (?, 31, 9), (?, 31, 8)").bind(day - 90, day - 89).run();
		await send(); const expected = [{ day: day - 89, gap: 31, reports: 8 }, { day, gap: 31, reports: 1 }]; expect(await rows()).toEqual(expected);
		await db.prepare("INSERT INTO installation_counts VALUES (?, 31, 9)").bind(day - 90).run();
		const worker = await runtime.getWorker(); await worker.scheduled({ cron: "0 0 * * *" }); expect(await rows()).toEqual(expected);
	}, 30_000);
});

it("private documented SQL counts roots once for 1/7/30/31-day and calendar windows", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(migration);
		// Root labels exist only in this synthetic oracle, never in the histogram.
		const claims = [Array.from({ length: 61 }, (_, i) => day - 60 + i),
			[day - 15], [day - 40, day - 5], [day - 31, day], [day - 29, day - 1], [day - 100, day - 60]];
		const insert = sqlite.prepare("INSERT INTO installation_counts VALUES (?, ?, 1) ON CONFLICT(day,gap) DO UPDATE SET reports=reports+1");
		for (const dates of claims) for (let i = 0; i < dates.length; i++) insert.run(dates[i], i ? Math.min(31, dates[i] - dates[i-1]) : 31);
		const doc = readFileSync("docs/installation-counts.md", "utf8");
		const sql = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map((match) => match[1]);
		for (const [start, end] of [[day, day], [day-6, day], [day-29, day], [day-30, day], [day-30, day-3]]) {
			const expected = claims.filter((dates) => dates.some((d) => d >= start && d <= end)).length;
			expect(sqlite.prepare(sql[0]).get({ S: start, E: end }).reporting_installation_state_roots).toBe(expected);
		}
		expect(sqlite.prepare(sql[1]).all()).toEqual([1, 7, 30].map((n) => ({ days: n, reporting_installation_state_roots: claims.filter((dates) => dates.some((d) => d >= day-n+1 && d <= day)).length })));
	} finally { sqlite.close(); }
});

it("migration constrains integers and at most one aggregate row per day/gap", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(migration);
		for (const values of ["-1,1,1", "100000000,1,1", "1,0,1", "1,32,1", "1,1,0", "1,1,9007199254740992", "1.5,1,1", "1,1.5,1", "1,1,1.5"]) expect(() => sqlite.exec("INSERT INTO installation_counts VALUES (" + values + ")")).toThrow();
		sqlite.exec("INSERT INTO installation_counts VALUES (1, 1, 1)");
		expect(() => sqlite.exec("INSERT INTO installation_counts VALUES (1, 1, 1)")).toThrow();
	} finally { sqlite.close(); }
});
