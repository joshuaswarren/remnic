/**
 * Release-channel workflow contracts (issue #3032).
 *
 * These assertions pin the three workflow surfaces the channel model depends
 * on: alpha publishing, the promotion entrypoint, and the CI step that runs the
 * release-discipline gate. Each one parses the YAML rather than only grepping,
 * so a malformed edit fails here instead of at dispatch time.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const readWorkflow = (name) => readFileSync(path.join(REPO_ROOT, WORKFLOW_DIR, name), "utf8");

/** Workflows this change is allowed to touch at all. */
const INTENTIONALLY_TOUCHED = Object.freeze([
  "changelog-guard.yml",
  "release-and-publish.yml",
  "release-promote.yml",
]);

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** `git show <ref>:<path>`, or null when the path does not exist at that ref. */
function showAtRef(ref, filePath) {
  try {
    return git(["show", `${ref}:${filePath}`]);
  } catch {
    return null;
  }
}

/**
 * Merge base with `main`. Tried against several remote names because clones
 * here use `github`, `origin`, or a bare local `main`. An unresolvable base is
 * a hard failure: a base that silently resolved to HEAD would make the drift
 * assertion below pass vacuously.
 */
function resolveMainMergeBase() {
  for (const candidate of ["github/main", "origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", candidate]).trim();
    } catch {
      // try the next remote name
    }
  }
  throw new Error("Unable to resolve a merge base against main for the workflow drift check");
}

/** The `needs:` of every job, keyed by job id, normalized to a sorted array. */
function jobDependencies(workflow) {
  const jobs = workflow?.jobs;
  if (!jobs || typeof jobs !== "object") return {};
  const result = {};
  for (const jobId of Object.getOwnPropertyNames(jobs)) {
    const job = jobs[jobId];
    const needs = Object.hasOwn(job ?? {}, "needs") ? job.needs : undefined;
    const list = needs === undefined ? [] : Array.isArray(needs) ? [...needs] : [needs];
    // Total comparator: -1 / 0 / 1, and 0 for equal values.
    result[jobId] = list.sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
  }
  return result;
}

test("every merge to main publishes to the alpha dist-tag", () => {
  const raw = readWorkflow("release-and-publish.yml");
  const workflow = parse(raw);

  // Trigger set is pinned: promotion must never be able to run this workflow.
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);

  const release = workflow.jobs.release;
  const workspacePublish = release.steps.find((step) => step.name === "Publish workspace packages to npm");
  const rootPublish = release.steps.find((step) => step.name === "Publish root package to npm");
  assert.ok(workspacePublish, "workspace publish step must exist");
  assert.ok(rootPublish, "root publish step must exist");

  assert.match(workspacePublish.run, /pnpm publish --access public --provenance --no-git-checks --tag alpha/);
  assert.match(rootPublish.run, /npm publish --access public --provenance --tag alpha/);
  // Provenance and the pnpm-over-npm requirement (issue #403) survive the change.
  assert.doesNotMatch(workspacePublish.run, /pnpm publish(?![^\n]*--provenance)/);
  assert.match(raw, /npm install -g npm@11\.16\.0/);
});

test("the promote workflow is dispatch-only and moves dist-tags without republishing", () => {
  const raw = readWorkflow("release-promote.yml");
  const workflow = parse(raw);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["channel", "dry_run", "hotfix", "version"]);
  assert.equal(inputs.version.type, "string");
  assert.equal(inputs.version.required, true);
  assert.deepEqual(inputs.channel.options, ["beta", "stable"]);
  assert.equal(inputs.hotfix.type, "boolean");
  assert.equal(inputs.dry_run.type, "boolean");

  const steps = workflow.jobs.promote.steps;
  const stepNames = steps.map((step) => step.name);
  for (const required of [
    "Validate inputs",
    "Verify CI is green on the release commit",
    "Verify soak age",
    "Verify no open regression issues in range",
    "Generate workspace package publish order",
    "Plan the dist-tag moves",
    "Move dist-tags",
  ]) {
    assert.ok(stepNames.includes(required), `promote workflow must have a "${required}" step`);
  }

  // Promotion is a tag move only: no step invokes a publish or pack command.
  for (const step of steps) {
    const run = typeof step.run === "string" ? step.run : "";
    assert.doesNotMatch(
      run,
      /^\s*(?:npm|pnpm|yarn) (?:publish|pack)\b/m,
      `step "${step.name}" must not publish or pack`,
    );
    assert.doesNotMatch(run, /changeset publish/, `step "${step.name}" must not run changeset publish`);
  }

  // The move step reads back what it wrote and honors dry-run.
  const move = steps.find((step) => step.name === "Move dist-tags");
  assert.equal(move.if, "inputs.dry_run == false");
  assert.match(move.run, /npm dist-tag add/);
  assert.match(move.run, /npm dist-tag ls/);
  // GitHub lookups are REST; the shared GraphQL budget is not spent here.
  assert.match(raw, /gh api "repos\/\$\{GITHUB_REPOSITORY\}/);
  assert.doesNotMatch(raw, /gh api graphql/);
  // No gate may be silenced.
  assert.doesNotMatch(raw, /\|\| true/);
  assert.doesNotMatch(raw, /continue-on-error/);
});

test("the changelog guard runs the release-discipline gate on base code only", () => {
  const raw = readWorkflow("changelog-guard.yml");
  const workflow = parse(raw);

  // Trigger and job identity are unchanged: the gate was added as a step.
  assert.deepEqual(Object.keys(workflow.on), ["pull_request_target"]);
  assert.deepEqual(Object.keys(workflow.jobs), ["changelog-guard"]);

  const steps = workflow.jobs["changelog-guard"].steps;
  const gate = steps.find((step) => step.name === "Release discipline (issue #3032)");
  assert.ok(gate, "changelog guard must run the release-discipline gate");
  assert.match(gate.run, /node scripts\/check-release-discipline\.mjs/);
  assert.match(gate.run, /--head refs\/remotes\/pr\/head/);

  const checkout = steps.find((step) => step.name === "Checkout base for the release-discipline gate");
  assert.ok(checkout, "the gate needs a base checkout");
  // pull_request_target: check out the BASE sha, never the head, and do not
  // leave credentials behind for head-authored code to find.
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.base.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  assert.doesNotMatch(raw, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(raw, /\|\| true/);
  assert.doesNotMatch(raw, /continue-on-error/);
});

test("no workflow outside this change has its triggers or job graph altered", () => {
  const baseRef = resolveMainMergeBase();
  assert.notEqual(baseRef, "", "merge base must resolve");

  // Union of workflow files at base and at HEAD, so a DELETED workflow is
  // caught too — not just a modified or added one.
  const headNames = readdirSync(path.join(REPO_ROOT, WORKFLOW_DIR)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  const baseNames = git(["ls-tree", "--name-only", baseRef, "--", `${WORKFLOW_DIR}/`])
    .split("\n")
    .filter(Boolean)
    .map((entry) => path.posix.basename(entry))
    .filter((name) => /\.ya?ml$/.test(name));
  const allNames = [...new Set([...baseNames, ...headNames])].sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  );
  assert.ok(allNames.length > 1, "expected to discover the workflow directory");

  const drifted = [];
  for (const name of allNames) {
    const relative = `${WORKFLOW_DIR}/${name}`;
    const baseRaw = showAtRef(baseRef, relative);
    const headRaw = headNames.includes(name) ? readWorkflow(name) : null;

    if (INTENTIONALLY_TOUCHED.includes(name)) {
      if (name === "release-promote.yml") {
        assert.equal(baseRaw, null, "release-promote.yml must be new in this change");
        continue;
      }
      // An intentionally-touched workflow may gain steps, but its trigger set
      // and job graph must be byte-identical after parsing.
      assert.ok(baseRaw !== null && headRaw !== null, `${relative} must exist at both refs`);
      const base = parse(baseRaw);
      const head = parse(headRaw);
      assert.deepEqual(head.on, base.on, `${relative}: on: must not change`);
      assert.deepEqual(
        jobDependencies(head),
        jobDependencies(base),
        `${relative}: job needs: must not change`,
      );
      continue;
    }

    // Every other workflow must be untouched outright.
    if (baseRaw !== headRaw) drifted.push(relative);
  }

  assert.deepEqual(
    drifted,
    [],
    `these workflows changed but are outside the scope of issue #3032: ${drifted.join(", ")}`,
  );
});
