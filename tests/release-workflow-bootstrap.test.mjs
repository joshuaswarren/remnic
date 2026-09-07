/**
 * One-time npm bootstrap path in release-and-publish.yml.
 *
 * Pins the safety properties of `bootstrap_tag` dispatches: strict input
 * validation before checkout, the trusted workflow source checked out
 * separately from the immutable tagged source, a hardcoded three-package
 * publish allowlist, registry E404-vs-error classification with
 * no-overwrite guarantees, and NPM_BOOTSTRAP_TOKEN confined to the single
 * publish step with pack scripts disabled. The normal push-triggered
 * release path must stay untouched by bootstrap dispatches.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(path.join(REPO_ROOT, ".github/workflows/release-and-publish.yml"), "utf8");
const workflow = parse(raw);

const BOOTSTRAP_JOB = "bootstrap-publish";
const PUBLISH_STEP = "Bootstrap absent packages to npm";
const CLASSIFIER = "scripts/npm-bootstrap-check.mjs";
const ALLOWLIST = Object.freeze([
  { name: "@remnic/connector-reitti", dir: "packages/connector-reitti" },
  { name: "@remnic/connector-x", dir: "packages/connector-x" },
  { name: "@remnic/import-okf", dir: "packages/import-okf" },
]);

const check = await import(pathToFileURL(path.join(REPO_ROOT, CLASSIFIER)));

test("bootstrap is dispatch-only via one optional tag input", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["bootstrap_tag", "version_override"]);
  assert.equal(inputs.bootstrap_tag.required, false);
  assert.equal(inputs.bootstrap_tag.type, "string");
});

test("normal release jobs never run in bootstrap mode", () => {
  for (const jobId of ["release-tests", "release"]) {
    assert.match(workflow.jobs[jobId].if, /inputs\.bootstrap_tag == ''/, `${jobId} must skip on bootstrap dispatches`);
  }
  const condition = workflow.jobs[BOOTSTRAP_JOB].if;
  assert.match(condition, /github\.event_name == 'workflow_dispatch'/);
  assert.match(condition, /inputs\.bootstrap_tag != ''/);
  assert.match(condition, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(condition, /github\.ref == 'refs\/heads\/main'/, "token-bearing job must only run from main");
});

test("bootstrap validates the tag before checkout and never interpolates the raw input", () => {
  const steps = workflow.jobs[BOOTSTRAP_JOB].steps;
  const validateIndex = steps.findIndex((step) => step.name === "Validate bootstrap tag");
  const checkoutIndex = steps.findIndex((step) => step.name === "Checkout bootstrap tag");
  assert.ok(validateIndex !== -1, "validation step must exist");
  assert.ok(checkoutIndex !== -1, "tag checkout step must exist");
  assert.ok(validateIndex < checkoutIndex, "tag format must be validated before checkout");
  const validate = steps[validateIndex];
  assert.match(validate.run, /\[\[ "\$\{BOOTSTRAP_TAG\}" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/, "tag must match vX.Y.Z on the whole string");
  assert.doesNotMatch(validate.run, /grep -Eq/, "line-oriented grep must not validate a potentially multiline value");
  assert.equal(validate.env.BOOTSTRAP_TAG, "${{ inputs.bootstrap_tag }}", "input must reach bash via env");
  assert.match(validate.run, /v9\.69\.64\) EXPECTED_SHA="70e8607d63f86d4a2410610e97753575aecf075b"/, "only the approved tag→commit pair may bootstrap");
  assert.match(validate.run, /not an approved bootstrap source/, "any other tag value must be rejected");
  const checkout = steps[checkoutIndex];
  assert.equal(checkout.with.ref, "${{ steps.bootstrap_tag.outputs.tag }}");
  assert.equal(checkout.with.path, "release-src");
  assert.equal(checkout.with["persist-credentials"], false, "checkout must not persist credentials");
  for (const step of steps) {
    assert.doesNotMatch(step.run ?? "", /\$\{\{ ?inputs\.bootstrap_tag/, "raw input must never be interpolated into run scripts");
  }
});

test("bootstrap source is a separate immutable checkout, built and published from it", () => {
  const steps = workflow.jobs[BOOTSTRAP_JOB].steps;
  const workflowCheckout = steps.find((step) => step.name === "Checkout workflow source");
  assert.ok(workflowCheckout, "trusted workflow source must be checked out for the classifier");
  assert.equal(workflowCheckout.with.ref, "${{ github.sha }}");
  assert.equal(workflowCheckout.with["persist-credentials"], false, "checkout must not persist credentials");
  const stage = steps.find((step) => /Stage bootstrap classifier/.test(step.name));
  assert.ok(stage, "classifier must be staged before the tag replaces the workspace tree");
  assert.match(stage.run, /cp scripts\/npm-bootstrap-check\.mjs "\$\{RUNNER_TEMP\}/);

  const runs = steps
    .filter((step) => step.run)
    .map((step) => step.run)
    .join("\n");
  assert.match(runs, /git -C release-src describe --exact-match --tags HEAD/);
  assert.match(runs, /require\('\.\/release-src\/package\.json'\)\.version/);
  const verify = steps.find((step) => step.name === "Verify tagged source");
  assert.ok(verify, "tagged source verification step must exist");
  assert.equal(verify.env.EXPECTED_SHA, "${{ steps.bootstrap_tag.outputs.expected_sha }}");
  assert.match(verify.run, /"\$\{ACTUAL_SHA\}" != "\$\{EXPECTED_SHA\}"/, "checkout SHA must equal the approved commit");
  assert.match(runs, /npm-bootstrap-check\.mjs"? --root release-src/);
  for (const step of steps) {
    if (/Stage bootstrap classifier/.test(step.name)) continue;
    assert.doesNotMatch(step.run ?? "", /(?<!\$\{RUNNER_TEMP\}\/)npm-bootstrap-check\.mjs/, `${step.name} must use the staged RUNNER_TEMP classifier`);
  }
  const classifyIndex = steps.findIndex((step) => step.name === "Classify bootstrap targets against npm");
  const installIndex = steps.findIndex((step) => step.name === "Install dependencies");
  assert.ok(classifyIndex !== -1, "fail-fast classification step must exist");
  assert.ok(classifyIndex < installIndex, "registry state must be classified before the long install/build");
});

test("NPM_BOOTSTRAP_TOKEN appears once, in the publish step, with scripts disabled", () => {
  const secretRef = /\$\{\{ ?secrets\.NPM_BOOTSTRAP_TOKEN \}\}/;
  assert.equal((raw.match(new RegExp(secretRef.source, "g")) ?? []).length, 1, "the token secret must be resolved exactly once");
  const steps = workflow.jobs[BOOTSTRAP_JOB].steps;
  const publish = steps.find((step) => step.name === PUBLISH_STEP);
  assert.ok(publish, "publish step must exist");
  assert.equal(publish.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
  assert.match(publish.run, /pnpm publish --access public --provenance --no-git-checks --tag alpha --ignore-scripts --registry=https:\/\/registry\.npmjs\.org/);
  assert.match(publish.run, /env -u NODE_AUTH_TOKEN npm view/, "pre-publish re-checks must run without the token");
  for (const step of steps) {
    if (step.name === PUBLISH_STEP) continue;
    assert.doesNotMatch(JSON.stringify(step.env ?? {}), /NODE_AUTH_TOKEN/, `${step.name} must not see publish credentials`);
  }
});

test("bootstrap never mutates git state, versions, or dist-tags", () => {
  const runs = workflow.jobs[BOOTSTRAP_JOB].steps
    .filter((step) => step.run)
    .map((step) => step.run)
    .join("\n");
  for (const forbidden of [/git commit/, /git push/, /dist-tag (add|delete|ls|rm)/, /set-release-version/, /CHANGELOG/]) {
    assert.doesNotMatch(runs, forbidden);
  }
});

test("publish targets are the hardcoded three-package allowlist", () => {
  assert.deepEqual(check.BOOTSTRAP_TARGETS, ALLOWLIST);
});

test("registry classification distinguishes absence, existence, and errors", () => {
  const e404 = "npm error code E404\nnpm error 404 Not Found - GET";
  const netfail = "npm error code ENOTFOUND";
  const t = (overrides) =>
    check.classify({
      version: { ok: false, stderr: e404 },
      name: { ok: false, stderr: e404 },
      ...overrides,
    });
  assert.equal(t({ version: { ok: true, stderr: "" } }).action, "skip");
  assert.equal(t().action, "publish");
  assert.equal(t({ name: { ok: true, stderr: "" } }).action, "refuse");
  assert.equal(t({ version: { ok: false, stderr: netfail } }).action, "error");
  assert.equal(t({ name: { ok: false, stderr: netfail } }).action, "error");
});

test("classifier rejects unknown targets without touching the network", () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, CLASSIFIER), "--package", "@remnic/unknown"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown bootstrap target/);
});

test("classifier refuses manifest drift via explicit --root without touching the network", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "npm-bootstrap-check-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "remnic", version: "9.69.64" }));
  const dir = path.join(root, "packages/connector-x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@remnic/impostor", version: "0.0.0" }));
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, CLASSIFIER), "--root", root, "--package", "@remnic/connector-x"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest drift/);
});

test("classifier refuses version drift against the tagged root without touching the network", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "npm-bootstrap-check-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "remnic", version: "9.69.64" }));
  const dir = path.join(root, "packages/import-okf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@remnic/import-okf", version: "9.0.0" }));
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, CLASSIFIER), "--root", root, "--package", "@remnic/import-okf"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version drift/);
});

test("classifier refuses a publishConfig registry override without touching the network", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "npm-bootstrap-check-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "remnic", version: "9.69.64" }));
  const dir = path.join(root, "packages/connector-reitti");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@remnic/connector-reitti", version: "9.69.64", publishConfig: { registry: "https://registry.example.test" } }),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, CLASSIFIER), "--root", root, "--package", "@remnic/connector-reitti"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /registry override/);
});
