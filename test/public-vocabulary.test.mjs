import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderVocabulary } from "../scripts/public-vocabulary.mjs";
import { readProviderOverlays } from "../scripts/lib/public-provider-overlays.mjs";

const oldRevision = "1".repeat(40);
const newRevision = "2".repeat(40);
const aliases = {
	repository: "openclaw/telemetry",
	revision: "3".repeat(40),
	names: ["claude", "cli", "gemini"],
};

describe("public provider metadata", () => {
	it("reads the named const through comments, quote styles, and formatting without executing source", () => {
		expect(readProviderOverlays(`
			// const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set(["not-metadata"]);
			throw new Error("must not execute");
			const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS:
				Set<string> = new Set<string>([
					'openai',
					/* public provider */ "anthropic",
				]);
		`)).toEqual(["openai", "anthropic"]);
	});

	it.each([
		'const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = makeNames();',
		'let BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set(["openai"]);',
		'const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([...other]);',
		'const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set(["open" + "ai"]);',
		'const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([42]);',
		'const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([`openai`]);',
		'const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set(["openai"]); const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set(["anthropic"]);',
		'/* const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set(["openai"]); */',
	])("rejects changed non-literal or ambiguous contracts: %s", (source) => {
		expect(() => readProviderOverlays(source)).toThrow();
	});
});

describe("public vocabulary generation", () => {
	it("rejects malformed upstream provider declarations without unbounded parsing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vocabulary-source-test-"));
		try {
			await mkdir(join(directory, "scripts/lib"), { recursive: true });
			await mkdir(join(directory, "src/config"), { recursive: true });
			for (const kind of ["plugin", "channel", "provider"]) {
				await writeFile(join(directory, `scripts/lib/official-external-${kind}-catalog.json`),
					JSON.stringify({ entries: [] }));
			}
			await writeFile(join(directory, "src/config/model-provider-config.ts"),
				`const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([${' ""'.repeat(128)}!]);`);
			const git = (...args) => execFileSync("git", ["-C", directory, ...args], {
				encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			});
			git("init", "--quiet");
			git("add", ".");
			git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
				"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
			const revision = git("rev-parse", "HEAD").trim();
			const module = new URL("../scripts/public-vocabulary.mjs", import.meta.url).href;
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
				import { buildSnapshot } from ${JSON.stringify(module)};
				try {
					await buildSnapshot(process.argv[1], process.argv[2], process.argv[2]);
					process.exitCode = 1;
				} catch {
					console.log("rejected");
				}
			`, directory, revision], { encoding: "utf8", timeout: 5_000 });
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("rejected");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 10_000);

	it("retains a removed public name across refreshes with deterministic output", () => {
		const old = { revision: oldRevision, names: ["daytona", "openai"] };
		const current = { revision: newRevision, names: ["browser", "openai"] };
		const metadata = { schemaVersion: 1, legacyAliases: aliases, snapshots: [old, current] };
		const generated = renderVocabulary(metadata);
		expect(generated).toContain('"daytona"');
		expect(generated).toContain('"browser"');
		expect(generated).toContain('"gemini"');
		expect(generated.match(/"openai"/gu)).toHaveLength(1);
		expect(renderVocabulary({ ...metadata, snapshots: [current, old] })).toBe(generated);
	});

	it.each([
		{ revision: "main", names: ["openai"] },
		{ revision: oldRevision, names: ["openai", "openai"] },
		{ revision: oldRevision, names: ["openai", "browser"] },
		{ revision: oldRevision, names: ["openai,private"] },
		{ revision: oldRevision, names: ["<script>"] },
	])("rejects mutable or invalid vocabulary metadata: %j", (snapshot) => {
		expect(() => renderVocabulary({
			schemaVersion: 1, legacyAliases: aliases, snapshots: [snapshot],
		})).toThrow();
	});
});
