import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real Git fixtures keep checkout detection independent of the developer's repository. */
export function privateExportCheckouts() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "telemetry-export-checkouts-")));
	const source = join(root, "source");
	const linked = join(root, "linked");
	const unrelated = join(root, "private-repository");
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	function git(directory, ...args) {
		execFileSync(
			"git",
			[
				"-C", directory,
				"-c", "user.name=Telemetry Test",
				"-c", "user.email=test@example.invalid",
				"-c", "commit.gpgsign=false",
				"-c", "core.hooksPath=/dev/null",
				...args,
			],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
	}
	function repository(directory) {
		mkdirSync(directory);
		git(directory, "init", "--initial-branch=main");
	}
	try {
		repository(source);
		mkdirSync(join(source, "scripts", "lib"), { recursive: true });
		for (const file of ["private-export-path.mjs", "npm-quality.mjs", "telemetry-history.mjs"]) {
			copyFileSync(
				new URL(`../../scripts/lib/${file}`, import.meta.url),
				join(source, "scripts", "lib", file),
			);
		}
		git(source, "add", "scripts");
		git(source, "commit", "-m", "test fixture");
		git(source, "worktree", "add", "--detach", linked, "HEAD");
		repository(unrelated);
		for (const checkout of [source, linked]) repository(join(checkout, "nested-repository"));
		return { root, source, linked, unrelated };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
