import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Contract tests for the workspace-publish step of the release workflow.
//
// Live incident (v9.24.1): the unprovisioned-package guard was keyed on
// whether the package name already existed on the registry, not on the error
// class. An operator manually first-published two new names to unblock a
// stalled release; that flipped pkg_exists to "true", so the SAME E404
// (npm returns 404 rather than 403 to avoid leaking package existence, so an
// existing-name permission failure looks identical to a missing-name one)
// stopped matching the guard and became fatal. The release then aborted at the
// first capture package and shipped NOTHING -- not even packages earlier in
// topological order. These tests pin the fix: the branch is keyed on the error
// alone, non-E404 failures stay fatal, and unprovisioned names still fail the
// run loudly (pattern 38).

// Resolve from this module, not the caller's CWD, so the test still runs when
// invoked by absolute path from another directory (IDEs, targeted runners).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/release-and-publish.yml"),
  "utf8",
);

// Scope assertions to the publish loop rather than the whole file.
function step(name) {
  const marker = `- name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `step "${name}" not found in release workflow`);
  const rest = workflow.slice(start + marker.length);
  const nextIdx = rest.indexOf("\n      - name: ");
  return nextIdx === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextIdx);
}

const publishStep = step("Publish workspace packages to npm");

const e404GuardLine = publishStep
  .split("\n")
  .find((line) => /grep -q "npm error code E404"/.test(line));

const warningLine = publishStep
  .split("\n")
  .find((line) => line.includes("::warning::") && /provision/i.test(line));

test("E404 unprovisioned branch is keyed on the error, not package existence", () => {
  assert.ok(e404GuardLine, "E404 publish-failure guard not found");
  assert.doesNotMatch(
    e404GuardLine,
    /pkg_exists/,
    "the E404 branch must not gate on whether the package name already exists",
  );
  assert.doesNotMatch(
    publishStep,
    /pkg_exists/,
    "the pkg_exists precondition must be removed entirely, not left dead in the loop",
  );
});

test("non-E404 publish failures stay fatal, and the fatal path is reachable", () => {
  assert.match(
    publishStep,
    /exit \$publish_status/,
    "a failed publish must still exit non-zero for any non-E404 error class",
  );
  // The E404 branch must `continue`, so control falls through to the fatal
  // `exit $publish_status` for every other failure class (EPUBLISHCONFLICT,
  // auth, network, build). Match the branch through its continue and out to
  // the exit to prove the fatal path is not shadowed.
  const e404BranchFallsThroughToExit =
    /grep -q "npm error code E404"[\s\S]*?continue[\s\S]*?fi\s*\n\s*rm -f "\$publish_log"\s*\n\s*exit \$publish_status/.test(
      publishStep,
    );
  assert.ok(
    e404BranchFallsThroughToExit,
    "the E404 branch must skip via continue, leaving the fatal exit reachable for other failures",
  );
});

test("collected unprovisioned packages still make the run exit non-zero (visible red run)", () => {
  assert.match(
    publishStep,
    /if \[ "\$\{#UNPROVISIONED\[@\]\}" -gt 0 \]; then/,
    "the workflow must still check whether any packages were collected as unprovisioned",
  );
  assert.match(
    publishStep,
    /UNPROVISIONED\[@\][\s\S]*?exit 1/,
    "unprovisioned packages must fail the run (pattern 38: never silently green)",
  );
});

test("the unprovisioned warning covers existing names, not just first-time publishes", () => {
  assert.ok(warningLine, "unprovisioned warning line not found");
  assert.doesNotMatch(
    warningLine,
    /first-time/i,
    "the warning must not claim a first-time-only publish (misleading for an existing name)",
  );
  assert.match(
    warningLine,
    /not provisioned to publish/i,
    "the warning must state the identity is not provisioned to publish the package",
  );
});
