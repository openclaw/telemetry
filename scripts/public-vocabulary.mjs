import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const METADATA = join(ROOT, "data/public-vocabulary.json");
const OUTPUT = join(ROOT, "src/public-vocabulary.ts");
const CATALOG_PATHS = ["plugin", "channel", "provider"].map(
	(kind) => `scripts/lib/official-external-${kind}-catalog.json`,
);
const SHA = /^[a-f0-9]{40}$/u;
const NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const sorted = (values) => [...new Set(values)].sort();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function git(source, ...args) {
	return execFileSync("git", ["-C", source, ...args], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function addName(names, value) {
	if (typeof value !== "string" || !NAME.test(value.toLowerCase())) {
		throw new Error("Public metadata contains an unsupported name");
	}
	names.add(value.toLowerCase());
}

function collectCatalog(body, names) {
	const entries = Array.isArray(body) ? body : body.entries;
	if (!Array.isArray(entries)) throw new Error("Public catalog entries are missing");
	for (const entry of entries) {
		const metadata = entry.openclaw;
		if (!metadata) throw new Error("Public catalog entry metadata is missing");
		for (const section of [metadata.plugin, metadata.channel, ...(metadata.providers ?? [])]) {
			if (section?.id) addName(names, section.id);
		}
	}
}

function readProviderOverlays(source) {
	// This upstream contract is a literal Set, not an executable metadata API.
	// Reject changed syntax instead of evaluating source or guessing new IDs.
	const literal = source.match(
		/\bconst BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set\(\s*(\[(?:\s*"[^"\\]*"\s*,?)*\s*\])\s*\)/u,
	)?.[1];
	if (!literal) throw new Error("Upstream provider overlay declaration changed; review its contract");
	return JSON.parse(literal.replace(/,\s*\]$/u, "]"));
}

/** Read immutable Git objects, never the source checkout's working files. */
export async function buildSnapshot(source, revision, catalogHistoryStart) {
	if (!SHA.test(revision) || !SHA.test(catalogHistoryStart)) {
		throw new Error("Use full immutable commit SHAs for revision and history start");
	}
	git(source, "merge-base", "--is-ancestor", catalogHistoryStart, revision);
	const changedCatalogs = git(
		source, "log", "--first-parent", "--format=%H",
		`${catalogHistoryStart}..${revision}`, "--", ...CATALOG_PATHS,
	).trim().split("\n").filter(Boolean);
	const catalogRevisions = sorted([catalogHistoryStart, revision, ...changedCatalogs]);
	const names = new Set();
	for (const catalogRevision of catalogRevisions) {
		for (const path of CATALOG_PATHS) {
			collectCatalog(JSON.parse(git(source, "show", `${catalogRevision}:${path}`)), names);
		}
	}
	for (const name of readProviderOverlays(
		git(source, "show", `${revision}:src/config/model-provider-config.ts`),
	)) addName(names, name);

	const directory = await mkdtemp(join(tmpdir(), "openclaw-public-vocabulary-"));
	try {
		// The packaging helper reads metadata and top-level source filenames.
		// Export those exact public files, without a checkout, dependencies, or index.
		const paths = git(source, "ls-tree", "-r", "--name-only", revision, "--",
			"package.json", "scripts/lib", "extensions").trim().split("\n").filter(
			(path) => path === "package.json" || path.startsWith("scripts/lib/") ||
				/^extensions\/[^/]+\/[^/]+$/u.test(path),
		);
		const archive = execFileSync("git", ["-C", source, "archive", revision, "--", ...paths], {
			maxBuffer: 32 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		execFileSync("tar", ["-x", "-C", directory], { input: archive });
		const { listBundledPluginPackArtifacts } = await import(pathToFileURL(
			join(directory, "scripts/lib/bundled-plugin-build-entries.mjs"),
		).href);
		const manifests = listBundledPluginPackArtifacts({ cwd: directory, env: {} })
			.filter((path) => path.endsWith("/openclaw.plugin.json"));
		if (!manifests.length) throw new Error("Canonical packaging helper returned no plugin manifests");
		const bundledPlugins = [];
		for (const manifestPath of manifests) {
			if (!manifestPath.startsWith("dist/extensions/")) {
				throw new Error("Upstream packaged manifest path contract changed");
			}
			const manifest = JSON.parse(await readFile(join(directory, manifestPath.slice(5)), "utf8"));
			addName(names, manifest.id);
			bundledPlugins.push(manifest.id);
			for (const name of [...(manifest.channels ?? []), ...(manifest.providers ?? [])]) {
				addName(names, name);
			}
		}
		return {
			repository: "openclaw/openclaw",
			revision,
			catalogHistoryStart,
			catalogRevisions,
			bundledPlugins: sorted(bundledPlugins),
			names: sorted(names),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** All admitted names remain available to ingestion and future seven-day stats. */
export function renderVocabulary(metadata) {
	if (metadata.schemaVersion !== 1 || !metadata.snapshots.length) {
		throw new Error("Public vocabulary requires at least one immutable snapshot");
	}
	const names = new Set();
	for (const entry of [metadata.legacyAliases, ...metadata.snapshots]) {
		if (!SHA.test(entry.revision)) throw new Error("Vocabulary source is not immutable");
		if (JSON.stringify(entry.names) !== JSON.stringify(sorted(entry.names))) {
			throw new Error("Vocabulary names must be sorted and unique");
		}
		for (const name of entry.names) addName(names, name);
	}
	const vocabulary = sorted(names);
	return [
		"// Generated by npm run vocabulary:update. Do not edit by hand.",
		"// Sources and retained history: data/public-vocabulary.json.",
		"export const PUBLIC_NAMES = [",
		...vocabulary.map((name) => `\t${JSON.stringify(name)},`),
		"] as const;",
		"",
	].join("\n");
}

async function main() {
	const { values } = parseArgs({
		options: {
			check: { type: "boolean", default: false },
			source: { type: "string" },
			revision: { type: "string" },
			"history-start": { type: "string" },
		},
	});
	const metadata = JSON.parse(await readFile(METADATA, "utf8"));
	if (values.source) {
		if (values.revision) {
			const historyStart = values["history-start"] ?? metadata.snapshots[0]?.catalogHistoryStart;
			const snapshot = await buildSnapshot(resolve(values.source), values.revision, historyStart ?? "");
			const previous = metadata.snapshots.find((entry) => entry.revision === snapshot.revision);
			if (previous && json(previous) !== json(snapshot)) {
				throw new Error("An immutable snapshot changed; investigate instead of replacing history");
			}
			if (!previous) metadata.snapshots.push(snapshot);
			metadata.snapshots.sort((left, right) => left.revision.localeCompare(right.revision));
		} else {
			for (const snapshot of metadata.snapshots) {
				const regenerated = await buildSnapshot(
					resolve(values.source), snapshot.revision, snapshot.catalogHistoryStart,
				);
				if (json(regenerated) !== json(snapshot)) throw new Error("Public source snapshot does not match");
			}
		}
	} else if (values.revision || values["history-start"]) {
		throw new Error("--revision and --history-start require --source");
	}
	const output = renderVocabulary(metadata);
	if (values.check) {
		if (await readFile(OUTPUT, "utf8") !== output ||
			await readFile(METADATA, "utf8") !== json(metadata)) {
			throw new Error("Public vocabulary is stale; regenerate and review the retained history");
		}
		console.log("Public vocabulary is deterministic and up to date for its recorded sources.");
	} else {
		await writeFile(METADATA, json(metadata));
		await writeFile(OUTPUT, output);
		console.log(`Retained ${metadata.snapshots.length} public vocabulary snapshot(s).`);
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
