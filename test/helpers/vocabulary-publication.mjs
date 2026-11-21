import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const publicationCases = [
	"success", "pending-same", "pending-different", "orphan-same", "orphan-different", "merged-branch", "stale-before", "stale-after",
	"changed-candidate", "mergeable-pending", "mergeable-timeout", "mergeable-conflict", "changed-pr-head", "blocked-merge", "ambiguous-merge",
	"concurrent-base", "wrong-head", "wrong-tree", "unpublished-merge",
];

// The fixture executes the workflow bodies; only GitHub responses are simulated.
export async function checkPublication(mode) {
	const workflow = await readFile(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
	const step = (id) => {
		const match = workflow.match(new RegExp(`      - id: ${id}\\n[\\s\\S]*?        run: \\|\\n((?:          .*\\n|\\n)+)`));
		assert(match, `Missing ${id} workflow step`);
		return match[1].replace(/^          /gm, "");
	};
	const root = await mkdtemp(join(tmpdir(), "vocabulary-publication-"));
	try {
		const checkout = join(root, "checkout");
		const remote = join(root, "remote.git");
		const bin = join(root, "bin");
		for (const path of [checkout, bin, join(checkout, "data"), join(checkout, "src"), join(checkout, "scripts")]) {
			await mkdir(path, { recursive: true });
		}
		const env = {
			...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, MODE: mode,
			GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
			GITHUB_REPOSITORY: "openclaw/telemetry", GITHUB_OUTPUT: join(root, "output"),
			CALL_LOG: join(root, "calls"), GUARD_COUNT: join(root, "guards"),
			MERGE_COUNT: join(root, "merge-count"), MERGED_MARKER: join(root, "merged"),
		};
		const git = (...args) => execFileSync("git", args, {
			cwd: checkout, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const payload = async (value) => {
			await writeFile(join(checkout, "data/public-vocabulary.json"), `${value}\n`);
			await writeFile(join(checkout, "src/public-vocabulary.ts"), `${value}\n`);
		};
		const commit = (message) => {
			git("add", "data", "src");
			git("commit", "-qm", message);
			return git("rev-parse", "HEAD");
		};
		git("init", "--bare", "--quiet", remote);
		git("init", "--quiet", "--initial-branch=main");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@example.invalid");
		git("config", "commit.gpgsign", "false");
		git("config", "core.hooksPath", "/dev/null");
		await payload("base");
		env.GITHUB_SHA = commit("base");
		git("remote", "add", "origin", remote);
		git("push", "origin", "main");
		for (const name of ["vocabulary-maintenance.mjs", "public-vocabulary.mjs"]) {
			await writeFile(join(checkout, "scripts", name), await readFile(new URL(`../../scripts/${name}`, import.meta.url)));
		}
		if (mode.startsWith("pending-") || mode.startsWith("orphan-") || mode === "merged-branch") {
			git("checkout", "-b", "automation/public-vocabulary");
			await payload(mode.endsWith("-same") ? "candidate" : "earlier-candidate");
			env.PENDING_HEAD = commit("retained candidate");
			git("push", "origin", "automation/public-vocabulary");
			git("checkout", "main");
			if (mode === "merged-branch") env.MERGED_HEAD = env.PENDING_HEAD;
		}
		await payload("candidate");
		await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await writeFile(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  'pr list')
    [[ "$*" == *'--state merged'* ]]
    printf '%s' "\u0024{MERGED_HEAD:-}"
    ;;
  'api repos/openclaw/telemetry/git/ref/heads/main')
    count=0
    [[ ! -f "$GUARD_COUNT" ]] || count=$(cat "$GUARD_COUNT")
    echo $((count+1)) > "$GUARD_COUNT"
    sha=$(git ls-remote origin refs/heads/main | cut -f1)
    if [[ $MODE == stale-before || ( $MODE == stale-after && $count -gt 0 ) ]]; then sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; fi
    printf '{"object":{"sha":"%s"}}' "$sha"
    ;;
  'pr merge')
    [[ $MODE != blocked-merge ]]
    [[ "$*" == *"--squash --match-head-commit $PR_HEAD" ]]
    [[ $MODE != concurrent-base ]] || git commit --allow-empty -m 'concurrent base' >&2
    git merge --squash "$PR_HEAD" >&2
    [[ $MODE != wrong-tree ]] || echo wrong > data/public-vocabulary.json
    git add data src
    git commit -m 'squash publication' >&2
    [[ $MODE == unpublished-merge ]] || git push origin main >&2
    touch "$MERGED_MARKER"
    [[ $MODE != ambiguous-merge ]]
    ;;
  'api repos/openclaw/telemetry/pulls/7')
    if [[ "$*" == *mergeable* ]]; then
      count=0
      [[ ! -f "$MERGE_COUNT" ]] || count=$(cat "$MERGE_COUNT")
      echo $((count+1)) > "$MERGE_COUNT"
      mergeable=true
      if [[ $MODE == mergeable-timeout || ( $MODE == mergeable-pending && $count -lt 2 ) ]]; then mergeable=null; fi
      [[ $MODE != mergeable-conflict ]] || mergeable=false
      head=$PR_HEAD
      [[ $MODE != changed-pr-head ]] || head=changed
      printf '%s\\t%s\\n' "$head" "$mergeable"
      exit 0
    fi
    head=$PR_HEAD
    [[ $MODE != wrong-head ]] || head=wrong
    merged=false
    [[ ! -f "$MERGED_MARKER" ]] || merged=true
    printf '%s\\t%s\\t%s\\n' "$merged" "$head" "$(git rev-parse HEAD)"
    ;;
  'auth setup-git') ;;
  *) echo "Unexpected gh request: $*" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
		const run = (id) => spawnSync("/bin/bash", ["-e", "-c", step(id)], {
			cwd: checkout, env, encoding: "utf8", timeout: 30_000,
		});
		const admitted = run("candidate");
		if (mode === "pending-different" || mode === "orphan-different" || mode === "stale-before") {
			assert.notEqual(admitted.status, 0, admitted.stdout + admitted.stderr);
			assert.equal(git("ls-remote", "origin", "refs/heads/main").split("\t")[0], env.GITHUB_SHA);
			if (env.PENDING_HEAD) assert.equal(git("ls-remote", "origin", "refs/heads/automation/public-vocabulary").split("\t")[0], env.PENDING_HEAD);
			return;
		}
		assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
		const values = Object.fromEntries((await readFile(env.GITHUB_OUTPUT, "utf8")).trim().split("\n").map((line) => line.split("=")));
		env.DATA_BLOB = values.data_blob;
		env.SOURCE_BLOB = values.source_blob;
		git("checkout", "-B", "automation/candidate");
		if (mode === "changed-candidate") await payload("unvalidated");
		env.PR_HEAD = commit("candidate");
		env.PR_NUMBER = "7";
		git("checkout", "main");
		const published = run("commit");
		const success = mode === "success" || mode.endsWith("-same") || mode === "merged-branch" || mode === "mergeable-pending" || mode === "ambiguous-merge";
		assert.equal(published.status === 0, success, published.stdout + published.stderr);
		if (success) {
			const output = await readFile(env.GITHUB_OUTPUT, "utf8");
			const main = git("ls-remote", "origin", "refs/heads/main").split("\t")[0];
			assert(output.includes(`sha=${main}\n`));
			assert.notEqual(main, env.PR_HEAD, "Fixture must exercise a squash commit");
		} else {
			assert(!(await readFile(env.GITHUB_OUTPUT, "utf8")).includes("sha="));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
