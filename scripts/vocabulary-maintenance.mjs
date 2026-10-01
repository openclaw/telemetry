import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildSnapshot, renderVocabulary } from "./public-vocabulary.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILES = ["data/public-vocabulary.json", "src/public-vocabulary.ts"];
const SHA = /^[a-f0-9]{40}$/u;
const NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const CONTEXT = "telemetry/deploy";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const sorted = (values) => [...new Set(values)].sort();
const QUERY = `query($endCursor: String) {
  repository(owner: "openclaw", name: "openclaw") {
    releases(first: 100, after: $endCursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { id tagName tagCommit { oid } isDraft isPrerelease publishedAt }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
}`;

function command(program, args) {
	return execFileSync(program, args, {
		encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function gh(...args) {
	return JSON.parse(command("gh", ["api", ...args]));
}

function immutable(value) {
	assert.equal(typeof value, "string");
	assert.match(value, SHA, "Expected an immutable commit SHA");
	return value;
}

function keys(value, expected) {
	equal(Object.keys(value).sort(), [...expected].sort(), "Unexpected metadata fields");
}

function releaseRecord(release) {
	assert.equal(release.isDraft, false, "Tracked release became a draft");
	assert.equal(release.isPrerelease, false, "Tracked release became a prerelease");
	for (const value of [release.id, release.tagName]) {
		assert.equal(typeof value, "string");
		assert(value.length > 0 && value.length <= 256 && !/[\p{Cc}]/u.test(value));
	}
	assert.equal(new Date(release.publishedAt).toISOString(), release.publishedAt.replace("Z", ".000Z"));
	return { id: release.id, tag: release.tagName,
		revision: immutable(release.tagCommit?.oid), publishedAt: release.publishedAt };
}

/** Exhausted pagination is required; concurrent release changes must retry, not lose a snapshot. */
export function collectReleases(pages) {
	assert(Array.isArray(pages) && pages.length > 0, "Release provenance unavailable");
	const releases = [];
	const cursors = new Set();
	const ids = new Set();
	let total;
	for (const [index, page] of pages.entries()) {
		assert(!page.errors, "GitHub returned incomplete release provenance");
		const connection = page.data?.repository?.releases;
		assert(connection && Array.isArray(connection.nodes));
		assert(Number.isSafeInteger(connection.totalCount) && connection.totalCount >= 0);
		total ??= connection.totalCount;
		equal(connection.totalCount, total, "Release count changed during pagination; retry");
		equal(connection.pageInfo?.hasNextPage, index < pages.length - 1, "Incomplete release pagination");
		if (connection.nodes.length) {
			const cursor = connection.pageInfo.endCursor;
			assert(typeof cursor === "string" && cursor && !cursors.has(cursor), "Repeated release cursor");
			cursors.add(cursor);
		}
		for (const release of connection.nodes) {
			assert(release?.id && !ids.has(release.id), "Duplicate release identity");
			assert.equal(typeof release.isDraft, "boolean");
			assert.equal(typeof release.isPrerelease, "boolean");
			ids.add(release.id);
			releases.push(release);
		}
	}
	equal(releases.length, total, "Release pagination count mismatch");
	return releases;
}

/** Keep released tag identities and the inclusive backfill anchor in checked-in public metadata. */
export function planReleases(metadata, releases) {
	assert(metadata.releases?.length, "Automatic release backfill needs a reviewed anchor");
	const anchor = metadata.releases[0];
	const byTag = new Map(releases.map((release) => [release.tagName, release]));
	equal(byTag.size, releases.length, "Duplicate release tag");
	for (const previous of metadata.releases) {
		const release = byTag.get(previous.tag);
		assert(release, "A retained release disappeared; review required");
		equal(releaseRecord(release), previous, "A retained release or tag changed; review required");
	}
	const current = releases.filter((release) => !release.isDraft && !release.isPrerelease)
		.map(releaseRecord).filter((release) => release.publishedAt >= anchor.publishedAt).sort((a, b) =>
		a.publishedAt.localeCompare(b.publishedAt) || a.tag.localeCompare(b.tag),
	);
	assert(current.some((release) => release.id === anchor.id), "Release anchor is missing");
	return current;
}

export function needsDeployment(event, refresh, statuses) {
	// The combined-status API returns the latest status for each context. Missing,
	// pending, and failed receipts retry even after the data commit was published.
	const receipt = statuses.find((status) => status.context === CONTEXT);
	return event !== "schedule" || refresh || receipt?.state !== "success";
}

export function assertCurrentMain(target, current) {
	equal(immutable(target), immutable(current), "Main advanced; retry from current main instead of rolling back");
}

/** Runs from trusted base code in check/publish jobs; candidate TypeScript is never imported. */
export function validateCandidate(previous, candidate, generated, releases) {
	keys(candidate, ["schemaVersion", "legacyAliases", "snapshots", "releases"]);
	equal(candidate.schemaVersion, previous.schemaVersion);
	equal(candidate.legacyAliases, previous.legacyAliases, "Legacy aliases must not change automatically");
	equal(candidate.releases, releases, "Candidate release provenance differs from discovery");
	const before = new Map(previous.snapshots.map((snapshot) => [snapshot.revision, snapshot]));
	const after = new Map(candidate.snapshots.map((snapshot) => [snapshot.revision, snapshot]));
	equal(after.size, candidate.snapshots.length, "Duplicate snapshots");
	equal([...after.keys()], sorted([...after.keys()]), "Snapshots must remain canonical");
	for (const [revision, snapshot] of before) {
		equal(after.get(revision), snapshot, "Retained immutable snapshot changed");
	}
	for (const snapshot of candidate.snapshots) {
		if (before.has(snapshot.revision)) continue;
		keys(snapshot, ["repository", "revision", "catalogHistoryStart", "catalogRevisions", "bundledPlugins", "names"]);
		equal(snapshot.repository, "openclaw/openclaw");
		assert(releases.some((release) => release.revision === snapshot.revision), "Unreleased snapshot");
		equal(snapshot.catalogHistoryStart, previous.snapshots[0].catalogHistoryStart);
		for (const revision of snapshot.catalogRevisions) immutable(revision);
		equal(snapshot.catalogRevisions, sorted(snapshot.catalogRevisions));
		assert(snapshot.catalogRevisions.includes(snapshot.revision) &&
			snapshot.catalogRevisions.includes(snapshot.catalogHistoryStart));
		equal(snapshot.bundledPlugins, sorted(snapshot.bundledPlugins));
		assert(snapshot.bundledPlugins.every((name) => snapshot.names.includes(name)));
		assert(snapshot.names.every((name) => typeof name === "string" && NAME.test(name)));
	}
	for (const release of releases) assert(after.has(release.revision), "Released snapshot is missing");
	const output = renderVocabulary(candidate);
	equal(generated, output, "Generated source contains changes outside the deterministic vocabulary");
	return output;
}

export function deployedVersion(deployments) {
	assert(Array.isArray(deployments) && deployments.length, "No deployed Worker version");
	const latest = [...deployments].sort((a, b) => a.created_on.localeCompare(b.created_on)).at(-1);
	assert(latest.versions?.length === 1 && latest.versions[0].percentage === 100,
		"Expected one Worker version receiving 100% of traffic");
	const id = latest.versions[0].version_id;
	assert.match(id, /^[a-f0-9-]{36}$/u);
	return id;
}

export function assertDeployedCommit(version, versionId, target) {
	equal(version.id, versionId, "Worker version response mismatch");
	equal(version.annotations?.["workers/tag"], immutable(target), "Deployed Worker does not match the target commit");
}

async function readBounded(path, limit = 2 * 1024 * 1024) {
	const info = await lstat(path);
	assert(info.isFile() && info.size <= limit, "Unexpected artifact file or size");
	return readFile(path, "utf8");
}

export async function readCandidate(directory, metadata, releases) {
	equal((await readdir(directory)).sort(), ["data", "src"], "Unexpected artifact paths");
	for (const name of ["data", "src"]) {
		assert((await lstat(join(directory, name))).isDirectory(), "Artifact directory is a symlink");
		equal(await readdir(join(directory, name)), [name === "data" ? "public-vocabulary.json" : "public-vocabulary.ts"]);
	}
	const bytes = await readBounded(join(directory, FILES[0]));
	const candidate = JSON.parse(bytes);
	equal(bytes, json(candidate), "Noncanonical metadata");
	const generated = await readBounded(join(directory, FILES[1]), 64 * 1024);
	const output = validateCandidate(metadata, candidate, generated, releases);
	return { metadata: bytes, source: output };
}

async function main() {
	const { values, positionals } = parseArgs({ allowPositionals: true, options: {
		base: { type: "string" }, event: { type: "string" }, source: { type: "string" },
		artifact: { type: "string" }, target: { type: "string" },
	} });
	const [mode] = positionals;
	if (mode === "guard-main") {
		assertCurrentMain(values.target, gh("repos/openclaw/telemetry/git/ref/heads/main").object.sha);
		return;
	}
	if (mode === "verify-deployment") {
		const target = immutable(values.target);
		const versionId = deployedVersion(JSON.parse(command("npx", ["--no-install", "wrangler", "deployments", "list", "--json"])));
		const version = JSON.parse(command("npx", ["--no-install", "wrangler", "versions", "view", versionId, "--json"]));
		assertDeployedCommit(version, versionId, target);
		console.log(`Verified ${target} on Worker version ${versionId} at 100%.`);
		return;
	}
	const metadata = JSON.parse(await readBounded(join(ROOT, FILES[0])));
	if (mode === "plan") {
		const base = immutable(values.base);
		assertCurrentMain(base, gh("repos/openclaw/telemetry/git/ref/heads/main").object.sha);
		const releases = planReleases(metadata, collectReleases(gh("graphql", "--paginate", "--slurp", "-f", `query=${QUERY}`)));
		const refresh = JSON.stringify(releases) !== JSON.stringify(metadata.releases);
		const statuses = gh(`repos/openclaw/telemetry/commits/${base}/status`, "--paginate", "--slurp")
			.flatMap((page) => page.statuses);
		const plan = { base, releases };
		const outputs = { refresh, deploy: needsDeployment(values.event, refresh, statuses), plan: JSON.stringify(plan) };
		if (process.env.GITHUB_OUTPUT) {
			await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
		}
		console.log(JSON.stringify(outputs));
		return;
	}
	const plan = JSON.parse(process.env.VOCABULARY_PLAN ?? "null");
	assert(plan, "Missing release plan from discovery");
	assertCurrentMain(plan.base, command("git", ["-C", ROOT, "rev-parse", "HEAD"]).trim());
	if (mode === "generate") {
		assert(values.source, "Missing immutable source repository");
		const candidate = structuredClone(metadata);
		for (const release of plan.releases) {
			if (candidate.snapshots.some((snapshot) => snapshot.revision === release.revision)) continue;
			candidate.snapshots.push(await buildSnapshot(resolve(values.source), release.revision, metadata.snapshots[0].catalogHistoryStart));
		}
		candidate.snapshots.sort((a, b) => a.revision.localeCompare(b.revision));
		candidate.releases = plan.releases;
		const output = renderVocabulary(candidate);
		validateCandidate(metadata, candidate, output, plan.releases);
		await writeFile(join(ROOT, FILES[0]), json(candidate));
		await writeFile(join(ROOT, FILES[1]), output);
	} else if (mode === "apply") {
		assert(values.artifact, "Missing generated artifact");
		const candidate = await readCandidate(resolve(values.artifact), metadata, plan.releases);
		await writeFile(join(ROOT, FILES[0]), candidate.metadata);
		await writeFile(join(ROOT, FILES[1]), candidate.source);
	} else {
		throw new Error("Use plan, generate, apply, guard-main, or verify-deployment");
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try { await main(); } catch (error) {
		// Child process stderr can include account details; expose the operation,
		// never its captured output or credentials in public workflow logs.
		console.error(error?.status !== undefined ? "External command failed; provenance or deployment is unverified." : error.message);
		console.error("[vocabulary-maintenance] FAILED (exit 1)");
		process.exitCode = 1;
	}
}
