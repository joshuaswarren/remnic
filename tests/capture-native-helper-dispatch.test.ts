import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

// Use the workspace's pinned `yaml` package so we parse workflows with the
// same parser the rest of the test suite trusts. Without an absolute path
// here the test relies on node_modules being installed at the repo root;
// the workspace's `test:file` runner makes that a precondition.
const require = createRequire(import.meta.url);
const YAML_PATH = require.resolve("yaml/package.json").replace(/\/package\.json$/, "");
const { parse } = require(YAML_PATH) as { parse: (text: string) => unknown };

// These tests pin the contract that makes capture-native-helper.yml publish
// reachable from a normal release. The motivating bug: release-and-publish.yml
// creates the GitHub release with the default GITHUB_TOKEN, so the `release`
// event in capture-native-helper.yml never triggers (GitHub does not start
// workflow runs from events caused by GITHUB_TOKEN). As a result the two
// darwin platform packages (@remnic/capture-native-darwin-arm64 and
// @remnic/capture-native-darwin-x64) have never been published to npm and
// macOS users get the helper from GitHub source only.
//
// The fix is a tag-guarded `workflow_dispatch` from release-and-publish.yml
// after the release is created, and a matching dispatch trigger on the
// helper's publish job that is only satisfied when github.ref_type is
// 'tag' AND the ref matches a vX.Y.Z tag. Branch and PR dispatches must
// not be able to reach `pnpm publish`.

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  // The yaml parser preserves kebab-case keys as-is. The dispatch step
  // uses `continue-on-error`; we type the snake-case alias too because
  // both forms are accepted in workflow files.
  "continue-on-error"?: boolean;
  continue_on_error?: boolean;
};
type HelperJob = {
  if?: string;
  needs?: unknown;
  strategy?: { matrix?: { include?: Array<{ platformPackage?: string }> } };
  steps?: WorkflowStep[];
};

const helperDoc = parse(readFileSync(".github/workflows/capture-native-helper.yml", "utf8")) as {
  on: Record<string, unknown>;
  jobs: Record<string, HelperJob>;
};
const releaseDoc = parse(readFileSync(".github/workflows/release-and-publish.yml", "utf8")) as {
  permissions: Record<string, string>;
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};

// The publish job's `if` accepts the historic `release` event OR a
// workflow_dispatch from a tag whose ref starts with `refs/tags/v`. The
// stricter vX.Y.Z anchor is enforced by a separate `Validate ref is a
// vX.Y.Z tag` step inside the job (GitHub Actions expressions do not
// support `=~` and the API rejects workflow files that try to use it).
// Together: a `release` event OR a dispatch from a vX.Y.Z tag, where the
// `if` only lets a dispatch through when the ref is a v-prefixed tag and
// the ref-validation step explicitly refuses any ref that does not match
// `^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$` exactly.
const EXPECTED_PUBLISH_IF = `github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v'))`;
const REF_VALIDATION_REGEX = '\^refs/tags/v\[0-9\]+\\\\.\[0-9\]+\\\\.\[0-9\]+\$';

const helperPublish = helperDoc.jobs.publish;
const helperSwift = helperDoc.jobs.swift;

test("capture-native-helper publish job is reachable from a v* tag dispatch", () => {
  assert.ok(helperPublish, "capture-native-helper must have a publish job");
  assert.equal(
    helperPublish.if,
    EXPECTED_PUBLISH_IF,
    "publish job must run on release events OR workflow_dispatch from a vX.Y.Z tag",
  );
  assert.deepEqual(
    (helperPublish.needs as string[] | string) ?? undefined,
    "swift",
    "publish job must depend on swift so the helper binary is built first",
  );
  // Matrix: only the two darwin platform packages.
  const matrix = helperPublish.strategy?.matrix?.include ?? [];
  const platformPackages = matrix.map((entry) => entry.platformPackage).filter(Boolean);
  assert.deepEqual(platformPackages, [
    "packages/capture-native-darwin-arm64",
    "packages/capture-native-darwin-x64",
  ]);
  // Publish step must keep OIDC trusted publishing and the same publish
  // invocation the existing test pins.
  const publishRun = helperPublish.steps?.find((s) => s.run?.includes("pnpm publish"))?.run ?? "";
  assert.match(publishRun, /pnpm publish --access public --provenance --no-git-checks/);
  // E404 carve-out must still be present, with the actionable error text
  // Joshua sees on first publish.
  assert.match(
    publishRun,
    /Provision npm trusted publishing for \$\{pkg_name\}, then rerun this workflow\./,
  );
});

test("capture-native-helper swift job still runs on workflow_dispatch from a tag", () => {
  // Dispatched runs must rebuild the helper binary on real macOS runners;
  // otherwise the artifact the publish job downloads is whatever the runner
  // happens to have. Confirm the swift job does not gate itself to release-only.
  assert.ok(helperSwift, "capture-native-helper must have a swift job");
  assert.equal(
    helperSwift.if,
    "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
    "swift job must keep its draft-PR guard; it must NOT also require a release event",
  );
});

test("capture-native-helper publish is unreachable from a branch dispatch", () => {
  // The job's `if` already gates this because github.ref_type != 'tag' for
  // branches. We assert the gate's exact form (startsWith('refs/tags/v'))
  // so a future refactor cannot loosen it. The strict vX.Y.Z anchor is
  // enforced separately by the ref-validation step.
  assert.ok(helperPublish, "capture-native-helper must have a publish job");
  assert.equal(helperPublish.if, EXPECTED_PUBLISH_IF);
  // Branch refs (`refs/heads/main`) and non-v tag refs (e.g. `refs/tags/alpha`)
  // do not start with `refs/tags/v`, so the dispatch path is unreachable.
  assert.match(
    helperPublish.if ?? "",
    /startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    "dispatch guard must use startsWith('refs/tags/v')",
  );
});

test("capture-native-helper publish has a ref-validation step that anchors vX.Y.Z", () => {
  // The job-level `if` cannot use `=~` (the GitHub Actions expression
  // language does not support it and the REST API rejects workflow files
  // that try to use it). Instead, a dedicated step validates the ref is
  // an exact vX.Y.Z tag with bash `[[ =~ ]]`, sets `is_release_tag`, and
  // the downstream steps gate on that output. Refs like
  // `refs/tags/v9.69.90-rc.1` or `refs/tags/feature-x` reach the step
  // (they all start with `refs/tags/v`) and are rejected there.
  const steps = helperDoc.jobs.publish.steps ?? [];
  const validationStep = steps.find((s) => s.name === "Validate ref is a vX.Y.Z tag");
  assert.ok(validationStep, "publish job must have a 'Validate ref is a vX.Y.Z tag' step");
  assert.equal(validationStep.id, "ref_check", "validation step must set the ref_check output id");
  const run = validationStep.run ?? "";
  // The regex anchor is bash's `[[ =~ ]]`; both endpoints must be present.
  assert.match(
    run,
    /\[\[ "\$\{\{ github\.ref \}\}" =~ \^refs\/tags\/v\[0-9\]\+\\.\[0-9\]\+\\.\[0-9\]\+\$ \]\]/,
    "validation step must check the ref against ^refs/tags/vX.Y.Z$ exactly",
  );
  assert.match(
    run,
    /is_release_tag=(true|false)/,
    "validation step must set is_release_tag for downstream gating",
  );
  assert.match(
    run,
    /github\.event_name/,
    "validation step must short-circuit to true on a real release event",
  );
  // Every step that does work after the validation must gate on the output.
  const gatedSteps = steps.filter(
    (s) => s.name && s.name !== "Checkout" && s.name !== "Validate ref is a vX.Y.Z tag",
  );
  for (const s of gatedSteps) {
    assert.equal(
      s.if,
      "steps.ref_check.outputs.is_release_tag == 'true'",
      `step "${s.name}" must be gated on is_release_tag`,
    );
  }
});

test("capture-native-helper publish is unreachable from a pull_request event", () => {
  // The `on:` block must declare `release` and `workflow_dispatch` as the
  // only paths that can reach the publish job. pull_request must NOT be
  // reachable to `pnpm publish` (PRs use the same default GITHUB_TOKEN,
  // which would also block workflow runs — but a malicious actor with
  // write access could dispatch from a branch ref, so we guard the
  // condition rather than the token).
  assert.ok(helperDoc.on, "workflow must declare an on: block");
  assert.ok("release" in helperDoc.on, "release trigger must remain declared");
  assert.ok("workflow_dispatch" in helperDoc.on, "workflow_dispatch trigger must remain declared");
  // The publish job's `if` must not reference github.event.pull_request.
  assert.doesNotMatch(
    helperPublish.if ?? "",
    /github\.event\.pull_request/,
    "publish job must not be reachable from pull_request events",
  );
  // Same for any step's `if`.
  for (const step of helperPublish.steps ?? []) {
    assert.doesNotMatch(
      step.if ?? "",
      /github\.event\.pull_request/,
      `publish step "${step.name ?? step.uses ?? "?"}" must not be reachable from pull_request events`,
    );
  }
});

test("release-and-publish dispatches capture-native-helper after the GitHub release is created", () => {
  // The dispatch is a best-effort follow-up: it runs AFTER the GitHub
  // release exists so the helper's tag ref resolves on origin, and it must
  // not be allowed to fail the npm publish step.
  const releaseSteps = releaseDoc.jobs.release.steps ?? [];
  const stepNames = releaseSteps.map((s) => s.name);

  const createReleaseIdx = stepNames.indexOf("Create GitHub release");
  const clawhubIdx = stepNames.indexOf("Publish OpenClaw plugin to ClawHub");
  const publishWorkspaceIdx = stepNames.indexOf("Publish workspace packages to npm");
  const publishRootIdx = stepNames.indexOf("Publish root package to npm");
  const dispatchIdx = stepNames.indexOf("Dispatch capture-native-helper");

  assert.ok(createReleaseIdx !== -1, "release workflow must still create a GitHub release");
  assert.ok(clawhubIdx !== -1, "release workflow must still publish to ClawHub");
  assert.ok(publishWorkspaceIdx !== -1, "release workflow must still publish workspace packages");
  assert.ok(publishRootIdx !== -1, "release workflow must still publish the root package");
  assert.ok(dispatchIdx !== -1, "release workflow must dispatch capture-native-helper");

  // The dispatch must happen AFTER the GitHub release (so the tag exists)
  // and AFTER both npm publish steps (so a missing helper publish does not
  // strand the npm train). It must be BEFORE the ClawHub step so a helper
  // failure surfaces in the same run.
  assert.ok(dispatchIdx > createReleaseIdx, "dispatch must run after Create GitHub release");
  assert.ok(dispatchIdx > publishWorkspaceIdx, "dispatch must run after Publish workspace packages to npm");
  assert.ok(dispatchIdx > publishRootIdx, "dispatch must run after Publish root package to npm");
  assert.ok(dispatchIdx < clawhubIdx, "dispatch must run before Publish OpenClaw plugin to ClawHub");

  // The dispatch step itself: must use `gh workflow run`, must pin the ref
  // to the release tag, must be wrapped in `continue-on-error` so it
  // cannot fail the job, and must use the default GITHUB_TOKEN (no new
  // secret). It must also surface failure via ::warning:: + job summary.
  const dispatchStep = releaseSteps[dispatchIdx];
  // The yaml parser preserves the kebab-case key as-is; GitHub Actions
  // accepts both `continue-on-error` and `continue_on_error` syntax in
  // real workflow files. We assert on the kebab-case form because that
  // is what the workflow YAML actually contains.
  assert.match(
    dispatchStep.run ?? "",
    /gh workflow run capture-native-helper\.yml/,
    "dispatch step must call gh workflow run capture-native-helper.yml",
  );
  assert.match(
    dispatchStep.run ?? "",
    /--ref\s+"?\$\{?HELPER_TAG\}?"?/,
    "dispatch step must pin --ref to the release tag so the package version equals the release version",
  );
  assert.equal(
    dispatchStep["continue-on-error"],
    true,
    "dispatch step must use continue-on-error so a helper failure does not strand the ClawHub step or mark npm publish as failed",
  );
  assert.match(
    dispatchStep.run ?? "",
    /::warning::/,
    "dispatch step must surface failures via ::warning:: so they appear in the run summary",
  );
  // The dispatch must authenticate with the job's default GITHUB_TOKEN,
  // not a new secret. PAT/deploy-key-based dispatch would widen the
  // secret surface and is explicitly forbidden.
  assert.equal(
    dispatchStep.env?.GITHUB_TOKEN,
    "${{ secrets.GITHUB_TOKEN }}",
    "dispatch step must authenticate with the job's GITHUB_TOKEN (no new secret)",
  );
  assert.doesNotMatch(
    dispatchStep.run ?? "",
    /RELEASE_PAT|RELEASE_DEPLOY_KEY/,
    "dispatch step must not require any new secret",
  );
});

test("release-and-publish grants actions: write for the dispatch step", () => {
  // gh workflow run creates a workflow_dispatch event and must be
  // authorized by the caller job's token. The minimum scope is
  // `actions: write`; we add exactly that at the workflow level and no
  // other permission.
  assert.equal(
    releaseDoc.permissions["actions"],
    "write",
    "release workflow must grant actions: write so gh workflow run can dispatch the helper",
  );
  // The release job does not override permissions; the workflow-level
  // value applies.
  assert.equal(
    releaseDoc.jobs.release.steps?.find((s) => s.name === "Dispatch capture-native-helper")?.env
      ?.GITHUB_TOKEN,
    "${{ secrets.GITHUB_TOKEN }}",
  );
});

test("capture-native-helper publish matrix matches the darwin packages release-and-publish skips", () => {
  // The two lists must move together: if a future PR adds a third
  // os-restricted platform package, both workflows must list it. The
  // os-restricted skip in release-and-publish.yml is the only place
  // besides the matrix that names the helper as the authoritative
  // publisher for those packages.
  const matrix = helperDoc.jobs.publish.strategy?.matrix?.include ?? [];
  const platformPackages = matrix.map((entry) => entry.platformPackage).filter(Boolean);
  assert.ok(
    platformPackages.includes("packages/capture-native-darwin-arm64"),
    "publish matrix must include capture-native-darwin-arm64",
  );
  assert.ok(
    platformPackages.includes("packages/capture-native-darwin-x64"),
    "publish matrix must include capture-native-darwin-x64",
  );
  // The release workflow's skip clause must name the helper as the
  // authoritative publisher; otherwise readers will think the missing
  // package is a bug.
  const publishStep = (releaseDoc.jobs.release.steps ?? []).find(
    (s) => s.name === "Publish workspace packages to npm",
  );
  assert.ok(publishStep, "release workflow must still have a Publish workspace packages step");
  assert.match(
    publishStep.run ?? "",
    /os-restricted; published by capture-native-helper\.yml/,
    "release-and-publish must keep the os-restricted skip comment that names capture-native-helper.yml",
  );
});

test("capture-native-helper pin to release tag for dispatch runs", () => {
  // The helper's `actions/checkout` step in the publish job does not pin a
  // ref, so a dispatch from a tag ref will check out the tag commit. That
  // is correct: the tag's commit has the package.json version matching
  // the tag, so `pnpm publish` will publish exactly the release's
  // version. Confirm the checkout does not override the ref to a branch
  // or PR head.
  const publishSteps = helperDoc.jobs.publish.steps ?? [];
  const checkout = publishSteps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "publish job must have an actions/checkout step");
  assert.equal(
    checkout.with?.["persist-credentials"],
    false,
    "publish job's checkout must not persist credentials (publish job does not push)",
  );
  assert.equal(
    checkout.with?.ref,
    undefined,
    "publish job's checkout must not pin `ref:` so it checks out the dispatching ref (the release tag)",
  );
});
