import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderVocabulary } from "../scripts/public-vocabulary.mjs";
import {
	assertCurrentMain, assertDeployedCommit, collectReleases, deployedVersion,
	needsDeployment, planReleases, readCandidate, validateCandidate,
} from "../scripts/vocabulary-maintenance.mjs";

const oldRevision = "1".repeat(40);
const nextRevision = "2".repeat(40);
const thirdRevision = "3".repeat(40);
const publishedAt = "2026-09-30T04:44:14Z";
const release = (tag, revision, extra = {}) => ({
	id: `release-${tag}`, tagName: tag, tagCommit: { oid: revision },
	isDraft: false, isPrerelease: false, publishedAt, ...extra,
});
const anchor = release("v1", oldRevision);
const record = (value) => ({ id: value.id, tag: value.tagName,
	revision: value.tagCommit.oid, publishedAt: value.publishedAt });
const page = (nodes, totalCount = nodes.length, hasNextPage = false, endCursor = "first") => ({
	data: { repository: { releases: { nodes, totalCount, pageInfo: { hasNextPage, endCursor } } } },
});
const snapshot = (revision, names) => ({
	repository: "openclaw/openclaw", revision, catalogHistoryStart: oldRevision,
	catalogRevisions: [...new Set([oldRevision, revision])].sort(), bundledPlugins: names, names,
});
const metadata = () => ({ schemaVersion: 1,
	legacyAliases: { repository: "openclaw/telemetry", revision: thirdRevision, names: ["cli"] },
	snapshots: [snapshot(oldRevision, ["old-public-plugin"])], releases: [record(anchor)],
});

describe("release discovery", () => {
	it("exhausts all pages before admitting releases", () => {
		const second = release("v2", nextRevision);
		expect(collectReleases([page([second], 2, true), page([anchor], 2, false, "last")]))
			.toEqual([second, anchor]);
	});

	it.each([
		[], [page([anchor], 2, true)], [page([anchor], 2)],
		[page([anchor], 2, true), page([release("v2", nextRevision)], 3, false, "last")],
		[page([anchor], 2, true), page([anchor], 2, false, "last")],
		[page([anchor], 2, true), page([release("v2", nextRevision)], 2, false, "first")],
		[{ errors: [{ message: "partial result" }], ...page([anchor]) }],
	])("rejects unavailable, incomplete, or changing pagination", (pages) => {
		expect(() => collectReleases(pages)).toThrow();
	});

	it("backfills missed stable releases, including shared publication timestamps", () => {
		const second = release("v2", nextRevision);
		const third = release("v3", thirdRevision, { publishedAt: "2026-10-01T01:00:00Z" });
		const earlier = release("v0", "4".repeat(40), { publishedAt: "2026-09-29T00:00:00Z" });
		expect(planReleases(metadata(), [third, earlier, second, anchor,
			release("v4-beta", "5".repeat(40), { isPrerelease: true }),
			release("draft", "6".repeat(40), { isDraft: true }),
		])).toEqual([anchor, second, third].map(record));
	});

	it.each([
		[], [release("v1", nextRevision)], [release("v1", oldRevision, { id: "replacement" })],
		[release("v1", oldRevision, { isPrerelease: true })],
		[release("v1", oldRevision, { tagCommit: null })],
		[release("v1", oldRevision, { publishedAt: "2026-10-01T00:00:00Z" })],
		[anchor, anchor],
	])("requires unchanged retained release and tag identities", (releases) => {
		expect(() => planReleases(metadata(), releases)).toThrow();
	});
});

describe("constrained publication", () => {
	const update = () => {
		const next = metadata();
		next.snapshots.push(snapshot(nextRevision, ["new-public-plugin"]));
		next.releases.push(record(release("v2", nextRevision)));
		return next;
	};

	it("admits only complete released snapshots while retaining disappeared names", () => {
		const next = update();
		const generated = validateCandidate(metadata(), next, renderVocabulary(next), next.releases);
		expect(generated).toContain('"old-public-plugin"');
		expect(generated).toContain('"new-public-plugin"');
	});

	it.each([
		(next) => { next.snapshots.shift(); },
		(next) => { next.snapshots[0].names = ["changed-history"]; },
		(next) => { next.legacyAliases.names = ["private-alias"]; },
		(next) => { next.snapshots[1].revision = thirdRevision; },
		(next) => { next.snapshots[1].repository = "untrusted/source"; },
		(next) => { next.snapshots[1].names = ["not a complete id"]; },
		(next) => { next.snapshots[1].catalogHistoryStart = thirdRevision; },
		(next) => { next.snapshots[1].catalogRevisions = [nextRevision]; },
		(next) => { next.snapshots.push(next.snapshots[1]); },
		(next) => { next.extra = "unexpected"; },
	])("rejects altered history, unproven releases, and malformed data", (mutate) => {
		const next = update();
		const releases = structuredClone(next.releases);
		mutate(next);
		expect(() => validateCandidate(metadata(), next, renderVocabulary(next), releases)).toThrow();
	});

	it("never accepts executable producer changes or incomplete release coverage", () => {
		const next = update();
		expect(() => validateCandidate(metadata(), next,
			`${renderVocabulary(next)}\nprocess.exit(0);`, next.releases)).toThrow("deterministic vocabulary");
		expect(() => validateCandidate(metadata(), metadata(), renderVocabulary(metadata()), next.releases))
			.toThrow("release provenance");
		next.snapshots.pop();
		expect(() => validateCandidate(metadata(), next, renderVocabulary(next), next.releases))
			.toThrow("snapshot is missing");
	});

	it("rejects an older source commit after main advances", () => {
		expect(() => assertCurrentMain(oldRevision, nextRevision)).toThrow("Main advanced");
		expect(() => assertCurrentMain(oldRevision, oldRevision)).not.toThrow();
	});

	it("rejects a native push when main advances after the publication guard", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vocabulary-publish-race-"));
		const remote = join(directory, "remote.git");
		const checkout = join(directory, "publisher");
		const git = (...args) => execFileSync("git", ["-C", checkout, ...args], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		});
		const commit = async (value) => {
			await writeFile(join(checkout, "data.json"), value);
			git("add", "data.json");
			git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
				"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
			return git("rev-parse", "HEAD").trim();
		};
		try {
			await mkdir(checkout);
			execFileSync("git", ["init", "--bare", "--quiet", remote]);
			git("init", "--quiet");
			git("remote", "add", "origin", remote);
			const base = await commit("base");
			git("push", "origin", "HEAD:refs/heads/main");
			assertCurrentMain(base, git("ls-remote", "origin", "refs/heads/main").split("\t")[0]);
			const concurrent = await commit("concurrent maintainer change");
			git("push", "origin", "HEAD:refs/heads/main");
			git("checkout", "--detach", base);
			await commit("generated vocabulary");
			const push = spawnSync("git", ["-C", checkout, "push", "origin", "HEAD:refs/heads/main"], { encoding: "utf8" });
			expect(push.status).not.toBe(0);
			expect(git("ls-remote", "origin", "refs/heads/main").split("\t")[0]).toBe(concurrent);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("reads only bounded regular artifact files and never executes generated source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "vocabulary-artifact-"));
		const next = update();
		try {
			await mkdir(join(directory, "data"));
			await mkdir(join(directory, "src"));
			await writeFile(join(directory, "data/public-vocabulary.json"), `${JSON.stringify(next, null, 2)}\n`);
			const source = join(directory, "src/public-vocabulary.ts");
			await writeFile(source, renderVocabulary(next));
			expect((await readCandidate(directory, metadata(), next.releases)).source).toBe(renderVocabulary(next));
			await writeFile(source, `${renderVocabulary(next)}\nthrow new Error('must not execute');`);
			await expect(readCandidate(directory, metadata(), next.releases)).rejects.toThrow("deterministic vocabulary");
			await rm(source);
			await symlink(join(directory, "data/public-vocabulary.json"), source);
			await expect(readCandidate(directory, metadata(), next.releases)).rejects.toThrow("artifact file");
			await writeFile(join(directory, "package.json"), "{}");
			await expect(readCandidate(directory, metadata(), next.releases)).rejects.toThrow("artifact paths");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("deployment recovery", () => {
	it.each(["failure", "error", "pending", undefined])("retries a published commit without successful rollout: %s", (state) => {
		const statuses = state ? [{ context: "telemetry/deploy", state }] : [];
		expect(needsDeployment("schedule", false, statuses)).toBe(true);
	});

	it("skips the expensive path only for an unchanged, successfully deployed poll", () => {
		const success = [{ context: "telemetry/deploy", state: "success" }];
		expect(needsDeployment("schedule", false, success)).toBe(false);
		expect(needsDeployment("schedule", true, success)).toBe(true);
		expect(needsDeployment("workflow_dispatch", false, success)).toBe(true);
		expect(needsDeployment("push", false, success)).toBe(true);
		expect(needsDeployment("schedule", false, [{ context: "check", state: "success" }])).toBe(true);
	});

	it("requires the newest deployment to route 100% to the exact tagged commit", () => {
		const id = "11111111-2222-3333-4444-555555555555";
		const current = { created_on: "2026-10-01T00:00:00Z", versions: [{ version_id: id, percentage: 100 }] };
		expect(deployedVersion([current, { created_on: "2026-09-30T00:00:00Z", versions: [] }])).toBe(id);
		expect(() => deployedVersion([{ ...current, versions: [{ version_id: id, percentage: 50 }] }])).toThrow("100%");
		expect(() => assertDeployedCommit({ id, annotations: { "workers/tag": oldRevision } }, id, nextRevision))
			.toThrow("target commit");
		expect(() => assertDeployedCommit({ id, annotations: { "workers/tag": nextRevision } }, id, nextRevision))
			.not.toThrow();
	});
});
