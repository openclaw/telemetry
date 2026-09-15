import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isTelemetryCheckoutPath, isWithinDirectory } from "../scripts/lib/private-export-path.mjs";
import { privateExportCheckouts } from "./helpers/private-export-checkouts.mjs";

describe("private export destinations", () => {
	let temporary;
	let source;
	let linked;
	let unrelated;

	beforeAll(() => {
		({ root: temporary, source, linked, unrelated } = privateExportCheckouts());
	});
	afterAll(() => rmSync(temporary, { recursive: true, force: true }));
	afterEach(() => vi.unstubAllEnvs());

	it.each(["root", "child", "nested foreign repository"])(
		"rejects the source checkout's %s destination",
		(kind) => {
			const output = kind === "root"
				? source
				: join(source, kind === "child" ? "results" : "nested-repository/results");
			expect(isTelemetryCheckoutPath(output, source)).toBe(true);
		},
	);

	it.each(["root", "child", "nested foreign repository"])(
		"rejects a linked worktree's %s destination from either source checkout",
		(kind) => {
			const output = kind === "root"
				? linked
				: join(linked, kind === "child" ? "results" : "nested-repository/results");
			expect(isTelemetryCheckoutPath(output, source)).toBe(true);
			expect(isTelemetryCheckoutPath(join(source, "results"), linked)).toBe(true);
		},
	);

	it("permits private output and unrelated private repositories", () => {
		for (const output of [join(temporary, "private-output"), unrelated, join(unrelated, "results")]) {
			expect(isTelemetryCheckoutPath(output, source)).toBe(false);
			expect(isTelemetryCheckoutPath(output, linked)).toBe(false);
		}
	});

	it.each(["source", "linked"])("respects filesystem case semantics for %s", (name) => {
		const alias = join(temporary, name.toUpperCase());
		const shared = existsSync(alias);
		if (!shared) mkdirSync(alias);
		for (const root of [source, linked]) {
			expect(isTelemetryCheckoutPath(join(alias, "results"), root)).toBe(shared);
		}
	});

	it("protects unpacked source without Git metadata, including physical aliases", () => {
		const unpacked = join(temporary, "unpacked");
		const alias = join(temporary, "UNPACKED");
		mkdirSync(unpacked);
		const shared = existsSync(alias);
		if (!shared) mkdirSync(alias);
		expect(isTelemetryCheckoutPath(join(unpacked, "results"), unpacked)).toBe(true);
		expect(isTelemetryCheckoutPath(join(alias, "results"), unpacked)).toBe(shared);
		expect(isWithinDirectory(join(alias, "results"), unpacked)).toBe(shared);
	});

	it("works without Git on PATH and ignores inherited Git overrides", () => {
		vi.stubEnv("PATH", "");
		vi.stubEnv("GIT_DIR", join(unrelated, ".git"));
		vi.stubEnv("GIT_COMMON_DIR", join(unrelated, ".git"));
		expect(isTelemetryCheckoutPath(join(linked, "results"), source)).toBe(true);
		expect(isTelemetryCheckoutPath(join(unrelated, "results"), linked)).toBe(false);
	});
});
