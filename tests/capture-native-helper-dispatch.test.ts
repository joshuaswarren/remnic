import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

// SAFETY: the checked-in workflows own the native publication contract.
type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps: WorkflowStep[];
};

type ParsedWorkflow = {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

type GuardEvent = { event_name: string; ref_type: string; ref: string };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = parse(
  readFileSync(resolve(repoRoot, ".github/workflows/capture-native-helper.yml"), "utf8"),
) as ParsedWorkflow;
const releaseWorkflow = parse(
  readFileSync(resolve(repoRoot, ".github/workflows/release-and-publish.yml"), "utf8"),
) as ParsedWorkflow;

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const REF_CHECK_GUARD = "steps.ref_check.outputs.is_release_tag == 'true'";
const DARWIN_MATRIX_PACKAGES = [
  "packages/capture-native-darwin-arm64",
  "packages/capture-native-darwin-x64",
];

// Bounded evaluator for the guard expression shape GitHub Actions supports
// here: !, &&, ||, ==, !=, startsWith, parentheses, string literals, and
// github.<field> lookups. Unknown tokens throw, so a guard that outgrows
// this shape fails the test instead of silently passing.
function evaluateGuard(expression: string, event: GuardEvent): boolean {
  const tokens = expression.match(/\(|\)|,|&&|\|\||==|!=|!|'[^']*'|[^\s(),]+/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    const token = tokens[pos++];
    if (token === undefined) throw new Error(`guard expression ended early: ${expression}`);
    return token;
  };
  const value = (token: string): string => {
    if (token.startsWith("'")) return token.slice(1, -1);
    const field = token.replace(/^github\./, "");
    const resolved = (event as Record<string, string>)[field];
    if (resolved === undefined) throw new Error(`unsupported guard token: ${token}`);
    return resolved;
  };
  const primary = (): boolean => {
    const token = next();
    if (token === "(") {
      const grouped = orExpr();
      if (next() !== ")") throw new Error(`unbalanced parens: ${expression}`);
      return grouped;
    }
    if (token === "!") return !primary();
    if (token === "startsWith") {
      if (next() !== "(") throw new Error(`malformed startsWith: ${expression}`);
      const subject = value(next());
      if (next() !== ",") throw new Error(`malformed startsWith: ${expression}`);
      const prefix = value(next());
      if (next() !== ")") throw new Error(`malformed startsWith: ${expression}`);
      return subject.startsWith(prefix);
    }
    const left = value(token);
    const operator = next();
    if (operator === "==") return left === value(next());
    if (operator === "!=") return left !== value(next());
    throw new Error(`unsupported operator: ${operator}`);
  };
  const andExpr = (): boolean => {
    let result = primary();
    while (peek() === "&&") {
      next();
      const right = primary();
      result = result && right;
    }
    return result;
  };
  function orExpr(): boolean {
    let result = andExpr();
    while (peek() === "||") {
      next();
      const right = andExpr();
      result = result || right;
    }
    return result;
  }
  return orExpr();
}

const helperPublish = helper.jobs.publish;
const releaseJob = releaseWorkflow.jobs.release;
assert.ok(helperPublish, "capture-native-helper must declare a publish job");
assert.ok(releaseJob, "release-and-publish must declare a release job");

test("publish guard admits only release events and v-tag dispatches (truth table)", () => {
  const publishIf = helperPublish.if ?? "";
  assert.ok(publishIf.length > 0, "publish job must keep a guard expression");
  const truthTable: Array<[GuardEvent, boolean]> = [
    [{ event_name: "release", ref_type: "tag", ref: "refs/tags/v9.69.96" }, true],
    [{ event_name: "workflow_dispatch", ref_type: "tag", ref: "refs/tags/v9.69.96" }, true],
    [{ event_name: "workflow_dispatch", ref_type: "branch", ref: "refs/heads/main" }, false],
    [{ event_name: "pull_request", ref_type: "branch", ref: "refs/pull/42/merge" }, false],
  ];
  for (const [event, allowed] of truthTable) {
    assert.equal(evaluateGuard(publishIf, event), allowed, JSON.stringify(event));
  }
  assert.ok(helper.on, "helper workflow must declare an on: block");
  assert.ok("workflow_dispatch" in helper.on, "workflow_dispatch trigger must remain declared");
  assert.ok("release" in helper.on, "release trigger must remain declared");
});

test("helper publish depends on swift, which still runs on dispatch", () => {
  assert.ok(helper.jobs.swift, "capture-native-helper must declare a swift job");
  assert.ok(
    asList(helperPublish.needs).includes("swift"),
    "publish job must depend on the swift build job",
  );
  assert.doesNotMatch(helper.jobs.swift.if ?? "", /github\.event_name == 'release'/);
});

test("helper publish matrix stays the two darwin platform packages with trusted publishing", () => {
  const matrix = helperPublish.strategy?.matrix?.include ?? [];
  const platformPackages = matrix.map((entry) => entry.platformPackage).filter(Boolean).sort();
  assert.deepEqual(platformPackages, [...DARWIN_MATRIX_PACKAGES].sort());
  const permissions = helperPublish.permissions ?? {};
  assert.equal(permissions["contents"], "read");
  assert.equal(permissions["id-token"], "write", "publish job must keep OIDC trusted publishing");
  const publishStep = helperPublish.steps.find((step) => step.run?.includes("pnpm publish"));
  assert.ok(publishStep, "publish job must keep a pnpm publish step");
  const publishRun = publishStep.run ?? "";
  for (const flag of ["--access public", "--provenance", "--no-git-checks", "--tag alpha"]) {
    assert.ok(publishRun.includes(flag), `publish command must keep ${flag}`);
  }
});

test("helper publish checkout ships the dispatch tag and gates every publish step on ref_check", () => {
  const checkout = helperPublish.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.ok(checkout, "publish job must have an actions/checkout step");
  assert.equal(checkout.with?.ref, undefined, "checkout must not override the dispatch tag ref");
  assert.equal(checkout.with?.["persist-credentials"], false);
  const refCheck = helperPublish.steps.find((step) => step.id === "ref_check");
  assert.ok(refCheck?.run, "publish job must keep the ref_check validation step");
  const envJson = JSON.stringify(refCheck.env ?? {});
  assert.match(envJson, /DISPATCH_REF/);
  assert.match(envJson, /EVENT_NAME/);
  assert.doesNotMatch(refCheck.run, /\$\{\{ github\.ref \}\}/);
  assert.doesNotMatch(refCheck.run, /\$\{\{ github\.event_name \}\}/);
  for (const step of helperPublish.steps) {
    if (step === checkout || step === refCheck) continue;
    assert.equal(
      step.if,
      REF_CHECK_GUARD,
      `step "${step.name ?? step.id}" must be gated on the ref_check verdict`,
    );
  }
});

test("release workflow dispatches the helper after release creation with scoped authority", () => {
  const steps = releaseJob.steps;
  const indexOf = (predicate: (step: WorkflowStep) => boolean, what: string): number => {
    const index = steps.findIndex(predicate);
    assert.ok(index !== -1, `release workflow must keep the ${what} step`);
    return index;
  };
  const createRelease = indexOf((s) => s.uses?.startsWith("softprops/action-gh-release") ?? false, "Create GitHub release");
  const publishWorkspace = indexOf((s) => s.run?.includes("pnpm publish --access public --provenance --no-git-checks") ?? false, "workspace npm publish");
  const publishRoot = indexOf((s) => s.run?.includes("npm publish --access public --provenance --tag alpha") ?? false, "root npm publish");
  const dispatch = indexOf((s) => s.run?.includes("gh workflow run capture-native-helper.yml") ?? false, "helper dispatch");
  const clawhub = indexOf((s) => s.run?.includes("clawhub-publish.sh") ?? false, "ClawHub publish");
  assert.ok(dispatch > createRelease, "dispatch must run after the GitHub release exists");
  assert.ok(dispatch > publishWorkspace, "dispatch must run after workspace packages publish");
  assert.ok(dispatch > publishRoot, "dispatch must run after the root package publishes");
  assert.ok(dispatch < clawhub, "dispatch must run before the ClawHub step");
  assert.equal(releaseJob.permissions?.["actions"], "write", "release job must grant actions: write");
  const dispatchStep = steps[dispatch];
  assert.equal(dispatchStep["continue-on-error"], true, "helper dispatch is best-effort");
  assert.equal(
    dispatchStep.env?.GITHUB_TOKEN,
    "${{ secrets.GITHUB_TOKEN }}",
    "dispatch must authenticate with the default GITHUB_TOKEN",
  );
  assert.doesNotMatch(dispatchStep.run ?? "", /RELEASE_PAT|DEPLOY_KEY/, "dispatch must not need a new secret");
  assert.match(dispatchStep.env?.HELPER_TAG ?? "", /release_metadata.*tag_name/);
  assert.match(dispatchStep.run ?? "", /--ref "\$\{HELPER_TAG\}"/);
  assert.match(dispatchStep.run ?? "", /::warning::/);
});

test("release workflow leaves the darwin packages to the helper matrix", () => {
  const publishWorkspace = releaseJob.steps.find(
    (s) => s.run?.includes("pnpm publish --access public --provenance --no-git-checks") ?? false,
  );
  assert.ok(publishWorkspace, "release workflow must keep the workspace npm publish step");
  assert.match(
    publishWorkspace.run ?? "",
    /os-restricted; published by capture-native-helper\.yml/,
    "workspace publish must keep skipping the darwin packages in favor of the helper",
  );
});

test("ref anchor admits only exact stable vX.Y.Z and release events (real bash execution)", (t) => {
  const refCheck = helperPublish.steps.find((step) => step.id === "ref_check");
  assert.ok(refCheck?.run, "publish job must keep the ref_check validation step");
  const refCheckScript = refCheck.run ?? "";
  assert.ok(refCheckScript.length > 0, "ref_check step must have a run script");
  const directory = mkdtempSync(resolve(tmpdir(), "native-ref-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = resolve(directory, "output");
  const cases: Array<[string, string, boolean]> = [
    ["refs/tags/v9.69.96", "workflow_dispatch", true],
    ["refs/tags/v9.69.96-rc.1", "workflow_dispatch", false],
    ["refs/tags/v9.69.96+build.5", "workflow_dispatch", false],
    ["refs/tags/v9.69.96-rc.1+build.5", "workflow_dispatch", false],
    ["refs/tags/v9.69", "workflow_dispatch", false],
    ["refs/tags/v9", "workflow_dispatch", false],
    ["refs/tags/9.69.96", "workflow_dispatch", false],
    ["refs/heads/main", "workflow_dispatch", false],
    ["refs/tags/v9.69.96", "release", true],
  ];
  for (const [ref, eventName, admitted] of cases) {
    const result = spawnSync("bash", ["-c", refCheckScript], {
      env: { ...process.env, EVENT_NAME: eventName, DISPATCH_REF: ref, GITHUB_OUTPUT: output },
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, admitted ? 0 : 1, `${eventName}: ${ref}`);
    assert.equal(readFileSync(output, "utf8"), `is_release_tag=${admitted}\n`, `${eventName}: ${ref}`);
    rmSync(output, { force: true });
  }
});
