import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const publicationCases = [
	"success", "pending-same", "pending-different", "orphan-same", "orphan-different", "merged-branch", "stale-before", "stale-after",
	"changed-candidate", "mergeable-pending", "mergeable-timeout", "mergeable-conflict", "changed-pr-head", "blocked-merge", "ambiguous-merge",
	"concurrent-base", "wrong-head", "wrong-tree", "unpublished-merge", "retargeted-receipt", "foreign-base-receipt", "foreign-head-receipt",
	"multi-parent", "unowned-path", "missing-rule", "wrong-app", "non-strict", "missing-nonff",
	"inactive-rule", "exposed-bypass", "malformed-bypass", "current-bypass", "redacted-bypass",
	"gate-success", "gate-moved", "gate-closed", "gate-retargeted", "gate-wrong-repo", "gate-default",
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
    if [[ $MODE == concurrent-base ]]; then
      git commit --allow-empty -m 'concurrent base' >&2
      git push origin main >&2
      echo 'Required status check "Publication merge admission" is expected.' >&2
      exit 1
    fi
    git merge --squash "$PR_HEAD" >&2
    [[ $MODE != wrong-tree ]] || echo wrong > data/public-vocabulary.json
    git add data src
    git commit -m 'squash publication' >&2
    [[ $MODE == unpublished-merge ]] || git push origin main >&2
    touch "$MERGED_MARKER"
    [[ $MODE != ambiguous-merge ]]
    ;;
  'api repos/openclaw/telemetry/pulls/7')
    if [[ "$*" != *'--jq'* ]]; then
      state=open; base=main; repository=openclaw/telemetry; head=$PR_HEAD
      [[ $MODE != gate-closed ]] || state=closed
      [[ $MODE != gate-retargeted ]] || base=other
      [[ $MODE != gate-wrong-repo ]] || repository=other/repo
      [[ $MODE != gate-moved && $MODE != changed-pr-head ]] || head=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      printf '{"state":"%s","base":{"ref":"%s","repo":{"full_name":"%s"}},"head":{"sha":"%s","repo":{"full_name":"openclaw/telemetry"}}}' "$state" "$base" "$repository" "$head"
      exit 0
    fi
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
    base=main; base_repo=openclaw/telemetry; head_repo=openclaw/telemetry
    [[ $MODE != retargeted-receipt ]] || base=other
    [[ $MODE != foreign-base-receipt ]] || base_repo=other/repo
    [[ $MODE != foreign-head-receipt ]] || head_repo=other/repo
    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$merged" "$head" "$(git rev-parse HEAD)" "$base" "$base_repo" "$head_repo"
    ;;
  'api repos/openclaw/telemetry/rules/branches/main')
    if [[ $MODE == missing-rule ]]; then echo '[]'; exit 0; fi
    strict=true; app=15368
    [[ $MODE != non-strict ]] || strict=false
    [[ $MODE != wrong-app ]] || app=1
    printf '[{"type":"required_status_checks","ruleset_id":2,"parameters":{"strict_required_status_checks_policy":%s,"required_status_checks":[{"context":"Publication merge admission","integration_id":%s}]}}' "$strict" "$app"
    [[ $MODE == missing-nonff ]] || printf ',{"type":"non_fast_forward","ruleset_id":1}'
    echo ']'
    ;;
  'api repos/openclaw/telemetry/rulesets/1'|'api repos/openclaw/telemetry/rulesets/2')
    enforcement=active; bypass='[]'; current=never
    [[ $MODE != inactive-rule ]] || enforcement=disabled
    [[ $MODE != exposed-bypass ]] || bypass='[{"actor_type":"Integration","actor_id":15368}]'
    [[ $MODE != malformed-bypass ]] || bypass=null
    [[ $MODE != current-bypass ]] || current=always
    if [[ $MODE == redacted-bypass ]]; then echo '{"enforcement":"active"}'
    else printf '{"enforcement":"%s","bypass_actors":%s,"current_user_can_bypass":"%s"}' "$enforcement" "$bypass" "$current"; fi
    ;;
  "api repos/openclaw/telemetry/statuses/$PR_HEAD")
    [[ "$*" == *'state=success'* && "$*" == *'context=Publication merge admission'* ]]
    echo '{}'
    ;;
  'auth setup-git') ;;
  *) echo "Unexpected gh request: $*" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
		const run = (id) => spawnSync("/bin/bash", ["-e", "-c", step(id)], {
			cwd: checkout, env, encoding: "utf8", timeout: 30_000,
		});
		if (mode.startsWith("gate-")) {
			env.PR_HEAD = env.GITHUB_SHA;
			env.GITHUB_EVENT_PATH = join(root, "event.json");
			await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify({ repository: {
				default_branch: mode === "gate-default" ? "other" : "main",
			}, pull_request: { number: 7, head: { sha: env.PR_HEAD } } }));
			const result = spawnSync(process.execPath, ["scripts/vocabulary-maintenance.mjs", "gate"], {
				cwd: checkout, env, encoding: "utf8", timeout: 30_000,
			});
			assert.equal(result.status, 0, result.stdout + result.stderr);
			const calls = await readFile(env.CALL_LOG, "utf8").catch(() => "");
			assert.equal(calls.includes(`/statuses/${env.PR_HEAD}`), mode === "gate-success");
			return;
		}
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
		if (mode === "unowned-path") {
			await writeFile(join(checkout, "other.txt"), "unowned\n");
			git("add", "other.txt");
		}
		env.PR_HEAD = commit("candidate");
		if (mode === "multi-parent") {
			env.PR_HEAD = git("commit-tree", "HEAD^{tree}", "-p", env.GITHUB_SHA, "-p", env.PR_HEAD, "-m", "merge candidate");
		}
		env.PR_NUMBER = "7";
		git("checkout", "main");
		const published = run("commit");
		const success = mode === "success" || mode.endsWith("-same") || mode === "merged-branch" || mode === "mergeable-pending" || mode === "ambiguous-merge" || mode === "redacted-bypass";
		assert.equal(published.status === 0, success, published.stdout + published.stderr);
		if (success) {
			const output = await readFile(env.GITHUB_OUTPUT, "utf8");
			const main = git("ls-remote", "origin", "refs/heads/main").split("\t")[0];
			assert(output.includes(`sha=${main}\n`));
			assert.notEqual(main, env.PR_HEAD, "Fixture must exercise a squash commit");
		} else {
			assert(!(await readFile(env.GITHUB_OUTPUT, "utf8")).includes("sha="));
		}
		const calls = await readFile(env.CALL_LOG, "utf8");
		if (success || mode === "concurrent-base") {
			const statusIndex = calls.indexOf(`/statuses/${env.PR_HEAD}`);
			const mergeIndex = calls.indexOf("pr merge");
			assert(statusIndex >= 0 && mergeIndex >= 0 && statusIndex < mergeIndex, "Admission must precede merge");
		}
		if (mode === "concurrent-base") {
			const main = git("ls-remote", "origin", "refs/heads/main").split("\t")[0];
			assert.equal(git("rev-parse", `${main}^`), env.GITHUB_SHA);
			assert.equal(git("rev-parse", `${main}^{tree}`), git("rev-parse", `${env.GITHUB_SHA}^{tree}`));
			assert(!calls.includes("auth setup-git"), "Refused publication must never produce a deployment receipt");
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
