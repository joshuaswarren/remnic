/**
 * Release-channel workflow contracts (issue #3032).
 *
 * These assertions pin the three workflow surfaces the channel model depends
 * on: alpha publishing, the promotion entrypoint, and the CI step that runs the
 * release-discipline gate. Each one parses the YAML rather than only grepping,
 * so a malformed edit fails here instead of at dispatch time.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = ".github/workflows";
const readWorkflow = (name) => readFileSync(path.join(REPO_ROOT, WORKFLOW_DIR, name), "utf8");

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

/**
 * The job graph of every workflow this change touches, pinned to a literal.
 *
 * Deliberately NOT a diff against a git baseline: a merge-base comparison
 * inverts the moment it lands (the "new" workflow exists at the base, and the
 * base becomes HEAD, so the check both fails and goes vacuous). A pinned shape
 * keeps asserting the same property on main forever — this change may add
 * steps, but it must not re-wire which jobs wait on which.
 *
 * Update these literals only in a PR that deliberately changes CI ordering.
 */
const EXPECTED_JOB_GRAPHS = Object.freeze({
  "release-and-publish.yml": { "release-tests": [], release: ["release-tests"] },
  "changelog-guard.yml": { "changelog-guard": [] },
  "release-promote.yml": { promote: [] },
});

test("the touched workflows keep their pinned job graph", () => {
  for (const name of Object.getOwnPropertyNames(EXPECTED_JOB_GRAPHS)) {
    const workflow = parse(readWorkflow(name));
    assert.deepEqual(
      jobDependencies(workflow),
      EXPECTED_JOB_GRAPHS[name],
      `${WORKFLOW_DIR}/${name}: job needs: graph changed`,
    );
  }
});
