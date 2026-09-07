import { describe, expect, it } from "vitest";
import { renderVocabulary } from "../scripts/public-vocabulary.mjs";

const oldRevision = "1".repeat(40);
const newRevision = "2".repeat(40);
const aliases = {
	repository: "openclaw/telemetry",
	revision: "3".repeat(40),
	names: ["claude", "cli", "gemini"],
};

describe("public vocabulary generation", () => {
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
