import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { PUBLIC_NAMES } from "../src/public-vocabulary.js";
import { queryPublicStats, type PublicStats } from "../src/stats.js";
import { envelope, fixtureRows, SAMPLE_EVENTS, type StatsEvent } from "./fixtures/stats-sql.js";

const env: Env = {
	TELEMETRY: { writeDataPoint() {} },
	ACCOUNT_ID: "test-account",
	ANALYTICS_READ_TOKEN: "test-token",
};
const END = new Date("2026-09-07T00:00:00Z");

describe("public report aggregation", () => {
	let queries: string[];
	let events: StatsEvent[];
	let transform: (sql: string, body: ReturnType<typeof envelope>) => unknown;

	beforeEach(() => {
		queries = [];
		events = structuredClone(SAMPLE_EVENTS);
		transform = (_sql, body) => body;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(END);
		vi.stubGlobal("caches", { default: { async match() {}, async put() {} } });
		vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
			const sql = String(init.body);
			queries.push(sql);
			return Response.json(transform(sql, envelope(fixtureRows(sql, events))));
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.doUnmock("../src/public-vocabulary.js");
	});

	it("includes all weighted reports beyond 1000 joint combinations and retained aliases", async () => {
		const names = ["browser", "canvas", "codex", "daytona", "discord", "gemini", "ollama", "openai", "telegram", "vllm"];
		events = Array.from({ length: 1024 }, (_, mask) => ({
			...SAMPLE_EVENTS[0]!,
			weight: mask % 7 + 1,
			plugins: names.filter((_name, bit) => mask & (1 << bit)).join(","),
			channels: mask % 2 ? "discord,telegram" : "telegram",
		}));
		const stats = await queryPublicStats(env);
		expect(stats).toBeDefined();
		for (const name of names) {
			const expected = events.filter((event) => event.plugins.split(",").includes(name))
				.reduce((total, event) => total + event.weight, 0);
			expect(stats?.plugins.find((row) => row.plugin === name)?.installs, name).toBe(expected);
		}
	});

	it.each(["AS totalPings", "AS version", "AS platform", "blob6", "blob7", "blob8"])("fails closed when required query %s is unavailable", async (target) => {
		vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
			const sql = String(init.body);
			return sql.includes(target) ? new Response(null, { status: 503 }) : Response.json(envelope(fixtureRows(sql)));
		});
		await expect(queryPublicStats(env)).resolves.toBeUndefined();
	});

	it("compiles the entire current vocabulary into one bounded statement per category", async () => {
		expect(await queryPublicStats(env)).toBeDefined();
		expect(queries).toHaveLength(6);
		for (const blob of ["blob6", "blob7", "blob8"]) {
			const category = queries.filter((sql) => sql.includes(blob));
			expect(category).toHaveLength(1);
			const sql = category[0]!;
			expect(new TextEncoder().encode(sql).length).toBeLessThanOrEqual(9500);
			expect([...sql.matchAll(/position\(',([^']+),' IN b\)/gu)].map((match) => match[1])).toEqual(PUBLIC_NAMES);
			expect(sql).not.toMatch(/\bLIMIT\b/u);
		}
		for (const sql of queries) {
			expect(sql).toContain("timestamp>=toDateTime('2026-08-31 00:00:00')");
			expect(sql).toContain("timestamp<toDateTime('2026-09-07 00:00:00')");
			expect(sql).not.toContain("NOW()");
		}
	});

	it("uses independent summary totals, preserves aliases, and separates window and generation time", async () => {
		events = Array.from({ length: 30 }, (_, index) => ({
			...SAMPLE_EVENTS[0]!, version: `2026.8.${index}`, weight: index + 1, feature: index % 2 === 0,
		}));
		transform = (_sql, body) => {
			vi.setSystemTime(new Date(Date.now() + 1000));
			return body;
		};
		const stats = await queryPublicStats(env);
		expect(stats?.windowStart).toBe("2026-08-31T00:00:00.000Z");
		expect(stats?.windowEnd).toBe(END.toISOString());
		expect(stats?.generatedAt).toBe("2026-09-07T00:00:06.000Z");
		expect(stats?.summary).toEqual({
			totalPings: 465, featureReports: 225,
			latestEventAt: "2026-09-06T12:00:00.000Z", latestFeatureEventAt: "2026-09-06T12:00:00.000Z",
		});
		expect(stats?.versions).toHaveLength(25);
		expect(stats?.versions.reduce((sum, row) => sum + row.pings, 0)).toBe(450);
		for (const rows of [stats!.channels, stats!.providerFamilies, stats!.plugins]) {
			expect(rows[0]?.reports).toBe(225);
			for (const row of rows) expect(row.reports).toBe(row.installs);
		}
	});

	it("serves independent category estimates but rejects a broken local checksum", async () => {
		let breakCoverage = false;
		transform = (sql, body) => {
			if (!sql.includes("blob7") && !sql.includes("blob8")) return body;
			const weight = sql.includes("blob7") ? 7 : 9;
			const result = envelope(fixtureRows(sql, [{
				...SAMPLE_EVENTS[0]!, weight, timestamp: `2026-09-06 13:00:0${weight}`,
			}]));
			if (breakCoverage && sql.includes("blob8")) result.data[0]!.tokenUnits = "1";
			return result;
		};
		const request = () => worker.fetch(new Request("https://telemetry.example/api/stats"), env);
		const response = await request();
		expect(response.status).toBe(200);
		const stats = await response.json() as PublicStats;
		expect(stats.summary.featureReports).toBe(4);
		expect(stats.featureMetadata).toEqual({
			channels: { featureReports: 4, latestFeatureEventAt: "2026-09-06T12:00:00.000Z" },
			providerFamilies: { featureReports: 7, latestFeatureEventAt: "2026-09-06T13:00:07.000Z" },
			plugins: { featureReports: 9, latestFeatureEventAt: "2026-09-06T13:00:09.000Z" },
		});
		breakCoverage = true;
		const failed = await request();
		expect(failed.status).toBe(503);
		expect(failed.headers.get("cache-control")).toBe("no-store");
		await expect(failed.json()).resolves.toEqual({ error: "stats_unavailable" });
	});

	it("returns a truthful empty window and null watermarks only for empty aggregates", async () => {
		events = [];
		const stats = await queryPublicStats(env);
		expect(stats?.summary).toEqual({ totalPings: 0, featureReports: 0, latestEventAt: null, latestFeatureEventAt: null });
		expect(stats?.versions).toEqual([]);
		expect(stats?.platforms).toEqual([]);
		expect(stats?.plugins).toEqual([]);
		expect(stats?.featureMetadata.plugins).toEqual({ featureReports: 0, latestFeatureEventAt: null });
	});

	it.each(["unknown-public-id", "codex,codex", "codex,Codex", "Codex", "codex,", ",codex", "codex,,browser", ","])(
		"rejects incomplete or malformed token coverage: %s", async (plugins) => {
			events[0]!.plugins = plugins;
			await expect(queryPublicStats(env)).resolves.toBeUndefined();
		},
	);

	it.each([
		["missing data", {}],
		["invalid data", { data: null, rows: 0, meta: [] }],
		["missing rows", { data: [], meta: [] }],
		["wrong row count", { data: [], rows: 1, meta: [] }],
		["missing metadata", { data: [], rows: 0 }],
		["invalid row", { data: [null], rows: 1, meta: [] }],
		["absent aggregate", envelope([])],
		["multiple aggregate rows", envelope([{}, {}])],
	] as const)("rejects malformed SQL envelopes: %s", async (_name, body) => {
		transform = (sql, original) => sql.includes("blob8") ? body : original;
		await expect(queryPublicStats(env)).resolves.toBeUndefined();
	});

	it.each([
		["n0", undefined], ["n0", -1], ["n0", "1.5"], ["n0", ""], ["n0", "1e2"],
		["n0", null], ["n0", true], ["n0", Number.MAX_SAFE_INTEGER + 1],
		["featureReports", undefined], ["tokenUnits", undefined],
		["latestFeatureEventAt", undefined], ["latestFeatureEventAt", "1970-01-01 00:00:00"],
		["latestFeatureEventAt", "2026-02-30 00:00:00"], ["latestFeatureEventAt", "2026-09-07 00:00:00"],
	] as const)("rejects invalid alias %s=%s", async (key, value) => {
		transform = (sql, body) => {
			if (sql.includes("blob8")) body.data[0]![key] = value;
			return body;
		};
		await expect(queryPublicStats(env)).resolves.toBeUndefined();
	});

	it("rejects checksum arithmetic beyond safe integers", async () => {
		events[0]!.weight = Number.MAX_SAFE_INTEGER;
		await expect(queryPublicStats(env)).resolves.toBeUndefined();
	});

	it.each(["malformed JSON", "timeout"])("fails closed on %s", async (failure) => {
		vi.stubGlobal("fetch", async () => {
			if (failure === "timeout") throw new DOMException("timed out", "TimeoutError");
			return new Response("{");
		});
		await expect(queryPublicStats(env)).resolves.toBeUndefined();
	});

	it.each([
		["overflow", Array.from({ length: 400 }, (_, index) => `public-plugin-${index}`)],
		["duplicate", ["codex", "codex"]],
		["quote", ["not'a-name"]],
		["comma", ["codex,browser"]],
		["non-ASCII", ["caf\u00e9"]],
	])("rejects invalid or oversized vocabulary (%s) before querying", async (_name, names) => {
		vi.doMock("../src/public-vocabulary.js", () => ({ PUBLIC_NAMES: names }));
		vi.resetModules();
		const { queryPublicStats: query } = await import("../src/stats.js");
		await expect(query(env)).resolves.toBeUndefined();
		expect(queries).toEqual([]);
	});
});
