import { afterEach, describe, expect, it, vi } from "vitest";
import { keepKnownNames, loadKnownNames, normalizeVersion } from "../src/allowlist.js";

afterEach(() => vi.unstubAllGlobals());

describe("normalizeVersion", () => {
	it("accepts published OpenClaw release shapes", () => {
		for (const version of ["2026.8.2", "2026.12.0", "2026.7.1-2", "2026.8.0-beta.3"]) {
			expect(normalizeVersion(version)).toBe(version);
		}
	});

	it("buckets invented version strings so they cannot reach the public page", () => {
		for (const version of ["unknown", "BUY-CRYPTO-NOW", "1.0.0", "99999.1.1.1", ""]) {
			expect(normalizeVersion(version)).toBe("unknown");
		}
	});
});

describe("keepKnownNames", () => {
	const known = new Set(["discord", "telegram", "codex"]);

	it("keeps names the catalog vouches for, case-insensitively", () => {
		expect(keepKnownNames(["discord", "TELEGRAM"], known)).toEqual(["discord", "telegram"]);
	});

	it("drops names no catalog declares, including attacker-supplied text", () => {
		expect(keepKnownNames(["discord", "acme-internal-crm", "spam-link"], known)).toEqual(["discord"]);
	});

	it("fails closed when the catalog is unavailable rather than publishing unverified names", () => {
		expect(keepKnownNames(["discord", "telegram"], undefined)).toEqual([]);
	});

	it("canonicalizes and deduplicates accepted IDs before storage", () => {
		const publicNames = new Set(["discord", "openai"]);
		expect(keepKnownNames(
			["OpenAI", "openai", "OPENAI", "DISCORD", "discord", "Acme-Internal"],
			publicNames,
		)).toEqual(["discord", "openai"]);
	});
});

describe("public vocabulary", () => {
	it("works without platform caches and isolates each caller's vocabulary", async () => {
		vi.stubGlobal("caches", undefined);
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No upstream service"); }));
		const first = await loadKnownNames();
		expect(first.has("browser")).toBe(true);
		first.delete("browser");
		first.add("acme-internal-crm");
		const second = await loadKnownNames();
		expect(keepKnownNames(["browser", "acme-internal-crm"], second)).toEqual(["browser"]);
	});

	it("accepts packaged plugin and provider IDs while rejecting private names", async () => {
		const known = await loadKnownNames();
		const publicNames = ["browser", "canvas", "lmstudio", "memory-core", "ollama", "openrouter", "vllm"];
		expect(keepKnownNames([...publicNames, "acme-internal-crm", "spam-link"], known)).toEqual(publicNames);
	});

	it("retains external catalog identities, removed entries, and reviewed legacy aliases offline", async () => {
		const fetch = vi.fn(() => { throw new Error("No runtime catalog access"); });
		vi.stubGlobal("fetch", fetch);
		const known = await loadKnownNames();
		expect(keepKnownNames(
			["cli", "claude", "gemini", "daytona", "wecom-openclaw-plugin", "wecom", "google-vertex"],
			known,
		)).toEqual(["claude", "cli", "daytona", "gemini", "google-vertex", "wecom", "wecom-openclaw-plugin"]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("excludes private and non-packaged IDs from the retained public vocabulary", async () => {
		const known = await loadKnownNames();
		expect(keepKnownNames(["browser", "acme-internal-crm", "qa-channel", "qa-lab", "visitor-access"], known))
			.toEqual(["browser"]);
	});
});
