import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function gitPathFile(file) {
	const stat = statSync(file);
	if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid Git metadata");
	const value = readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
	if (!value || value.includes("\0")) throw new Error("invalid Git metadata");
	return value;
}

function gitCommonDirectory(directory) {
	const marker = join(directory, ".git");
	try {
		lstatSync(marker);
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw error;
	}
	// Read Git's on-disk markers so offline exports need no Git executable or env overrides.
	let gitDirectory = marker;
	if (!statSync(marker).isDirectory()) {
		const pointer = gitPathFile(marker);
		if (!pointer.startsWith("gitdir: ") || pointer.length <= 8) throw new Error("invalid Git metadata");
		gitDirectory = resolve(directory, pointer.slice(8));
	}
	gitDirectory = realpathSync(gitDirectory);
	const commonFile = join(gitDirectory, "commondir");
	try {
		lstatSync(commonFile);
	} catch (error) {
		if (error.code === "ENOENT") return gitDirectory;
		throw error;
	}
	return realpathSync(resolve(gitDirectory, gitPathFile(commonFile)));
}

function* ancestors(path) {
	for (let current = resolve(path);; current = dirname(current)) {
		yield current;
		if (current === dirname(current)) return;
	}
}

function sameDirectory(path, expected) {
	const actual = statSync(path, { bigint: true, throwIfNoEntry: false });
	// realpath can preserve case aliases; lowering case would conflate distinct Unix directories.
	return actual?.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino;
}

export function isWithinDirectory(output, root) {
	const expected = statSync(root, { bigint: true });
	for (const current of ancestors(output)) {
		if (sameDirectory(current, expected)) return true;
	}
	return false;
}

/** Private results must not enter the executing source checkout or its linked worktrees. */
export function isTelemetryCheckoutPath(output, sourceRoot = SOURCE_ROOT) {
	if (isWithinDirectory(output, sourceRoot)) return true;
	const common = gitCommonDirectory(sourceRoot);
	if (!common) return false;
	const expected = statSync(common, { bigint: true });
	for (const current of ancestors(output)) {
		const candidate = gitCommonDirectory(current);
		if (candidate && sameDirectory(candidate, expected)) return true;
		// A nested foreign repository cannot hide a containing telemetry checkout.
	}
	return false;
}
