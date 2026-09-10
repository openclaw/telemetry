import { describe, expect, it } from "vitest";
import { keepKnownNames, loadKnownNames } from "../src/allowlist.js";
import { buildDataPoint } from "../src/analytics.js";
import { parseRequestGeography } from "../src/geography.js";
import { parseClientIdentity, parseFeatureStats } from "../src/payload.js";

describe("parseClientIdentity", () => {
	it("reads version, platform, runtime, arch and surface from the client User-Agent", () => {
		expect(parseClientIdentity("openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)")).toEqual(
			{
				version: "2026.8.2",
				platform: "darwin",
				runtime: "node/v26.0.1",
				arch: "arm64",
				surface: "gateway",
			},
		);
	});

	it("treats a missing surface as unknown rather than failing the parse", () => {
		expect(parseClientIdentity("openclaw/2026.8.2 (linux; node/v24.0.0; x64)")).toMatchObject({
			version: "2026.8.2",
			platform: "linux",
			surface: "unknown",
		});
	});

	it("degrades unparseable and absent User-Agents to unknown", () => {
		for (const value of [
			null,
			"",
			"curl/8.4.0",
			"openclaw/",
			`openclaw/2026.9.2 (linux; ${" ".repeat(256)}x)`,
		]) {
			const identity = parseClientIdentity(value);
			expect(identity.version).toBe("unknown");
			expect(identity.platform).toBe("unknown");
		}
	});

	it.each([512, 8_192, 16_384, 32_768])(
		"rejects an oversized header with a valid-looking prefix (%i padding)",
		(padding) => {
			expect(
				parseClientIdentity(
					`openclaw/2026.9.2 (linux; node/v24.0.0; x64; gateway)${" ".repeat(padding)}`,
				),
			).toEqual({
				version: "unknown",
				platform: "unknown",
				runtime: "unknown",
				arch: "unknown",
				surface: "unknown",
			});
		},
	);

	it("strips characters outside the recorded vocabulary and bounds field length", () => {
		const identity = parseClientIdentity(
			`openclaw/${"9".repeat(200)}<script> (dar win"; node/v1; a<b>rch; gateway)`,
		);
		expect(identity.version).toHaveLength(64);
		expect(identity.version).not.toContain("<");
		expect(identity.arch).toBe("abrch");
		expect(identity.platform).toBe("darwin");
	});
});

describe("parseFeatureStats", () => {
	const body = {
		schema: 1,
		version: "2026.8.2",
		features: {
			channels: ["telegram", "discord"],
			providerFamilies: ["openai", "anthropic"],
			plugins: ["codex", "acpx"],
			pluginsEnabled: 7,
			sessionsLast24h: 14,
		},
	};
	const expectedFeatures = {
		channels: ["discord", "telegram"],
		providerFamilies: ["anthropic", "openai"],
		plugins: ["acpx", "codex"],
		pluginsEnabled: 7,
		sessionsLast24h: 14,
	};

	it("accepts a documented payload and sorts lists for stable rows", () => {
		expect(parseFeatureStats(body)).toEqual(expectedFeatures);
	});

	it("rejects bodies without the current schema marker", () => {
		expect(parseFeatureStats({ ...body, schema: 2 })).toBeUndefined();
		expect(parseFeatureStats({ features: body.features })).toBeUndefined();
		expect(parseFeatureStats("nope")).toBeUndefined();
		expect(parseFeatureStats(null)).toBeUndefined();
		expect(parseFeatureStats([body])).toBeUndefined();
	});

	it("drops undocumented keys instead of storing them", () => {
		const parsed = parseFeatureStats({
			...body,
			features: {
				...body.features,
				hostname: "gateway.example",
				installId: "example-install",
				runtimeUtcOffsetBucket: "utc_0",
			},
		});
		expect(parsed && Object.keys(parsed).sort()).toEqual([
			"channels",
			"plugins",
			"pluginsEnabled",
			"providerFamilies",
			"sessionsLast24h",
		]);
		expect(parsed).toEqual(expectedFeatures);
	});

	it("bounds list length and coerces hostile counts", () => {
		const parsed = parseFeatureStats({
			schema: 1,
			features: {
				channels: Array.from({ length: 100 }, (_, index) => `channel${index}`),
				providerFamilies: [1, null, "openai"],
				pluginsEnabled: -5,
				sessionsLast24h: Number.POSITIVE_INFINITY,
			},
		});
		expect(parsed?.channels).toHaveLength(32);
		expect(parsed?.providerFamilies).toEqual(["openai"]);
		expect(parsed?.pluginsEnabled).toBe(0);
		expect(parsed?.sessionsLast24h).toBe(0);
	});

	it.each([" tele gram", "dis!cord", "open ai", "cod ex", "codex\n"])(
		"drops malformed identifiers instead of repairing %j",
		(identifier) => {
			const parsed = parseFeatureStats({
				schema: 1,
				features: {
					channels: [identifier],
					providerFamilies: [identifier],
					plugins: [identifier],
				},
			});
			expect(parsed?.channels).toEqual([]);
			expect(parsed?.providerFamilies).toEqual([]);
			expect(parsed?.plugins).toEqual([]);
		},
	);

	it("rejects overlength tokens without truncating them to another identifier", () => {
		const valid = "a".repeat(64);
		expect(
			parseFeatureStats({
				schema: 1,
				features: { plugins: [`${valid}b`, valid] },
			})?.plugins,
		).toEqual([valid]);
		expect(
			parseFeatureStats({
				schema: 1,
				features: { plugins: [`${valid}b`] },
			})?.plugins,
		).toEqual([]);
	});

	it("preserves case-insensitive public names while excluding private and malformed tokens", async () => {
		const parsed = parseFeatureStats({
			schema: 1,
			features: {
				plugins: ["CODEX", "codex", "Browser", "acme-internal-crm", "cod ex"],
			},
		});
		expect(keepKnownNames(parsed?.plugins ?? [], await loadKnownNames())).toEqual([
			"browser",
			"codex",
		]);
	});

	it("accepts schema-1 feature reports that predate the optional plugins list", () => {
		const { plugins, ...features } = body.features;
		const parsed = parseFeatureStats({ schema: 1, features });
		expect(parsed).toEqual({
			...features,
			channels: ["discord", "telegram"],
			providerFamilies: ["anthropic", "openai"],
			plugins: [],
		});
		expect(buildDataPoint(parseClientIdentity(null), parsed, parseRequestGeography(undefined)).doubles).toEqual([1, 7, 14]);
	});
});

describe("buildDataPoint", () => {
	const identity = parseClientIdentity("openclaw/2026.8.2 (darwin; node/v26.0.1; arm64; gateway)");

	it("marks rows without feature stats and still records the identity columns", () => {
		expect(buildDataPoint(identity, undefined, parseRequestGeography(undefined))).toEqual({
			indexes: ["2026.8.2"],
			blobs: ["2026.8.2", "darwin", "arm64", "node/v26.0.1", "gateway", "", "", "", "", "", "", ""],
			doubles: [0, 0, 0],
		});
	});

	it("appends geography without changing the existing sampling key and feature columns", () => {
		const features = parseFeatureStats({
			schema: 1,
			features: {
				channels: ["telegram", "discord"],
				providerFamilies: ["anthropic"],
				plugins: ["codex"],
				pluginsEnabled: 7,
				sessionsLast24h: 14,
			},
		});
		const geography = { country: "JP", regionCode: "13", city: "\u6771\u4eac", timezone: "Asia/Tokyo" };
		expect(buildDataPoint(identity, features, geography)).toEqual({
			indexes: ["2026.8.2"],
			blobs: [
				"2026.8.2", "darwin", "arm64", "node/v26.0.1", "gateway",
				"discord,telegram", "anthropic", "codex", "JP", "13", "\u6771\u4eac", "Asia/Tokyo",
			],
			doubles: [1, 7, 14],
		});
	});
});
