import { afterEach, describe, expect, it, vi } from "vitest";
import { keepKnownNames, normalizeVersion } from "../src/allowlist.js";

afterEach(() => vi.unstubAllGlobals());

describe("normalizeVersion", () => {
	it("accepts published OpenClaw release shapes", () => {
		for (const version of ["2026.8.2", "2026.12.0", "2026.7.1-2", "2026.8.0-beta.3"]) {
			expect(normalizeVersion(version)).toBe(version);
		}
	});

	it("buckets invented version strings before recording them", () => {
		for (const version of ["unknown", "BUY-CRYPTO-NOW", "1.0.0", "99999.1.1.1", ""]) {
			expect(normalizeVersion(version)).toBe("unknown");
		}
	});
});

describe("keepKnownNames", () => {
	it("keeps names the catalog vouches for, case-insensitively", () => {
		expect(keepKnownNames(["discord", "TELEGRAM"])).toEqual(["discord", "telegram"]);
	});

	it("drops names no catalog declares, including attacker-supplied text", () => {
		expect(keepKnownNames(["discord", "acme-internal-crm", "spam-link"])).toEqual(["discord"]);
	});

	it("canonicalizes and deduplicates accepted IDs before storage", () => {
		expect(keepKnownNames(
			["OpenAI", "openai", "OPENAI", "DISCORD", "discord", "Acme-Internal"],
		)).toEqual(["discord", "openai"]);
	});
});

describe("public vocabulary", () => {
	it("works without platform caches and isolates each caller's results", () => {
		vi.stubGlobal("caches", undefined);
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No upstream service"); }));
		const first = keepKnownNames(["browser"]);
		expect(first).toEqual(["browser"]);
		first.splice(0, 1, "acme-internal-crm");
		expect(keepKnownNames(["browser", "acme-internal-crm"])).toEqual(["browser"]);
	});

	it("accepts packaged plugin and provider IDs while rejecting private names", () => {
		const publicNames = ["browser", "canvas", "lmstudio", "memory-core", "ollama", "openrouter", "vllm"];
		expect(keepKnownNames([...publicNames, "acme-internal-crm", "spam-link"])).toEqual(publicNames);
	});

	it("retains external catalog identities, removed entries, and reviewed legacy aliases offline", () => {
		const fetch = vi.fn(() => { throw new Error("No runtime catalog access"); });
		vi.stubGlobal("fetch", fetch);
		expect(keepKnownNames(
			["cli", "claude", "gemini", "daytona", "wecom-openclaw-plugin", "wecom", "google-vertex"],
		)).toEqual(["claude", "cli", "daytona", "gemini", "google-vertex", "wecom", "wecom-openclaw-plugin"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("excludes private and non-packaged IDs from the retained public vocabulary", () => {
		expect(keepKnownNames(["browser", "acme-internal-crm", "qa-channel", "qa-lab", "visitor-access"]))
			.toEqual(["browser"]);
	});
});
