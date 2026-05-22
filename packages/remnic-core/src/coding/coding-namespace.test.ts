/**
 * Tests for `resolveCodingNamespaceOverlay` (issue #569 PR 2).
 *
 * All fixtures synthetic. These tests cover the resolver-level contract —
 * project overlay vs no-overlay, escape hatch, sanitization, read+write
 * symmetry invariant.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  branchNamespaceName,
  combineNamespaces,
  projectTagProjectId,
  projectNamespaceName,
  resolveCodingNamespaceOverlay,
} from "./coding-namespace.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import type { CodingContext, CodingModeConfig } from "../types.js";

function ctx(overrides: Partial<CodingContext> = {}): CodingContext {
  return {
    projectId: "origin:abcd1234",
    branch: "main",
    rootPath: "/work/proj",
    defaultBranch: "main",
    ...overrides,
  };
}

function mode(overrides: Partial<CodingModeConfig> = {}): CodingModeConfig {
  return {
    projectScope: true,
    branchScope: false,
    globalFallback: true,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Name helpers
// ──────────────────────────────────────────────────────────────────────────

test("projectNamespaceName: stable form for origin-derived id (safe-route compatible)", () => {
  // `:` is not in the router's safe-namespace alphabet, so it collapses to
  // `-`. Resulting name must pass `isSafeRouteNamespace`.
  assert.equal(projectNamespaceName("origin:abcd1234"), "project-origin-abcd1234");
});

test("projectNamespaceName: lowercases and strips unsafe characters", () => {
  assert.equal(projectNamespaceName("ORIGIN:ABCD!!"), "project-origin-abcd");
});

test("projectNamespaceName: empty input falls back to 'unknown'", () => {
  assert.equal(projectNamespaceName(""), "project-unknown");
  assert.equal(projectNamespaceName("   "), "project-unknown");
});

test("projectTagProjectId: lossy tags get hash disambiguators", () => {
  assert.equal(projectTagProjectId("blend-supply"), "tag:blend-supply");
  assert.notEqual(projectTagProjectId("blend/supply"), projectTagProjectId("blend-supply"));
  assert.match(projectTagProjectId("blend/supply"), /^tag:blend-supply-[0-9a-f]{8}$/);
});

test("projectNamespaceName: length-capped to 64 chars, no trailing dash", () => {
  const huge = "a".repeat(200);
  const out = projectNamespaceName(huge);
  assert.ok(out.length <= 64, `expected length ≤ 64, got ${out.length}`);
  assert.ok(!out.endsWith("-"), "truncation must not leave a trailing dash");
});

test("branchNamespaceName: capped distinct long branches stay distinct (hash suffix)", () => {
  // Regression: raw truncation collapsed two branches whose sanitized forms
  // shared a long prefix but differed near the end, silently mixing recall
  // and write state. With a deterministic hash suffix applied on truncation,
  // distinct inputs must map to distinct namespaces.
  const projectId = "origin:abcd1234";
  const longA = `feature/${"a".repeat(80)}-variant-one`;
  const longB = `feature/${"a".repeat(80)}-variant-two`;
  const nsA = branchNamespaceName(projectId, longA);
  const nsB = branchNamespaceName(projectId, longB);
  assert.ok(nsA.length <= 64, `expected length ≤ 64, got ${nsA.length}`);
  assert.ok(nsB.length <= 64, `expected length ≤ 64, got ${nsB.length}`);
  assert.notEqual(
    nsA,
    nsB,
    "distinct long branches must not collapse to the same namespace",
  );
});

test("branchNamespaceName: capped output is deterministic for the same input", () => {
  const huge = "x".repeat(200);
  assert.equal(
    branchNamespaceName("origin:abcd1234", huge),
    branchNamespaceName("origin:abcd1234", huge),
  );
});

test("projectNamespaceName: output satisfies isSafeRouteNamespace for typical projectIds", () => {
  const cases = [
    "origin:abcd1234",
    "origin:deadbeef",
    "root:12345678",
    "ORIGIN:ABCD!!",
    "",
  ];
  for (const input of cases) {
    const ns = projectNamespaceName(input);
    assert.ok(
      isSafeRouteNamespace(ns),
      `projectNamespaceName(${JSON.stringify(input)}) = ${JSON.stringify(ns)} must be a safe route namespace`,
    );
  }
});

test("branchNamespaceName: output satisfies isSafeRouteNamespace for typical branches", () => {
  const cases: Array<[string, string]> = [
    ["origin:abcd", "main"],
    ["origin:abcd", "feat/x"],
    ["origin:abcd", "hotfix/JIRA-1234"],
    ["origin:abcd", "release-v2.0"],
    ["origin:abcd", "user_branch.test"],
  ];
  for (const [projectId, branch] of cases) {
    const ns = branchNamespaceName(projectId, branch);
    assert.ok(
      isSafeRouteNamespace(ns),
      `branchNamespaceName(${JSON.stringify(projectId)}, ${JSON.stringify(branch)}) = ${JSON.stringify(ns)} must be a safe route namespace`,
    );
  }
});

test("branchNamespaceName: simple all-lowercase branch needs no hash disambiguator", () => {
  // `main` is already safe and lowercase — sanitization is a no-op, so the
  // output is the plain project-id-branch form without a hash suffix.
  assert.equal(
    branchNamespaceName("origin:abcd1234", "main"),
    "project-origin-abcd1234-branch-main",
  );
});

test("branchNamespaceName: lossy branch names get a deterministic hash suffix", () => {
  // `feat/ui` sanitizes to `feat-ui` — different from the raw input — so
  // the namespace must include a disambiguating hash of the raw branch.
  // The same collision class: `feat-ui` would sanitize to `feat-ui`
  // unchanged (no hash), so the two inputs produce distinct namespaces
  // even though their sanitized forms coincide.
  const slashed = branchNamespaceName("origin:abcd1234", "feat/ui");
  const dashed = branchNamespaceName("origin:abcd1234", "feat-ui");
  assert.notEqual(
    slashed,
    dashed,
    "feat/ui and feat-ui must not collapse to the same namespace",
  );
  assert.match(slashed, /^project-origin-abcd1234-branch-feat-ui-[0-9a-f]{8}$/);
  assert.equal(dashed, "project-origin-abcd1234-branch-feat-ui");
});

test("branchNamespaceName: case-varying branches produce distinct namespaces", () => {
  // Regression: `Feature` and `feature` both sanitize to `feature` without
  // disambiguation. Including a hash of the raw input keeps them distinct.
  const titled = branchNamespaceName("origin:abcd", "Feature");
  const lowered = branchNamespaceName("origin:abcd", "feature");
  assert.notEqual(
    titled,
    lowered,
    "case-only variants must not collapse to the same namespace",
  );
});

test("branchNamespaceName: sanitizes branch name (lowercase + unsafe → dash)", () => {
  // With disambiguation, this also gains a hash suffix since the raw
  // `FEAT/UI (wip)` is not equal to the sanitized `feat-ui-wip`.
  const ns = branchNamespaceName("origin:abcd", "FEAT/UI (wip)");
  assert.match(ns, /^project-origin-abcd-branch-feat-ui-wip-[0-9a-f]{8}$/);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — escape hatches
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: no context → null (connector didn't provide one)", () => {
  assert.equal(resolveCodingNamespaceOverlay(null, mode()), null);
  assert.equal(resolveCodingNamespaceOverlay(undefined, mode()), null);
});

test("resolveCodingNamespaceOverlay: projectScope=false → null (CLAUDE.md #30 escape hatch)", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx(), mode({ projectScope: false }));
  assert.equal(overlay, null, "disabling projectScope must restore pre-#569 behaviour exactly");
});

test("resolveCodingNamespaceOverlay: projectScope=false even with branchScope=true → null", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx(),
    mode({ projectScope: false, branchScope: true }),
  );
  assert.equal(overlay, null, "branchScope without projectScope must not apply");
});

test("resolveCodingNamespaceOverlay: empty projectId → null (defensive)", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx({ projectId: "" }), mode());
  assert.equal(overlay, null);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — project scope
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: projectScope=true + globalFallback=true (default) → includes empty sentinel", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx({ projectId: "origin:deadbeef" }), mode());
  assert.deepEqual(overlay, {
    namespace: "project-origin-deadbeef",
    readFallbacks: [""],
    scope: "project",
  });
});

test("resolveCodingNamespaceOverlay: projectScope=true + globalFallback=true + defaultNamespace → root in fallbacks", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:deadbeef" }),
    mode({ globalFallback: true }),
    "default",
  );
  assert.deepEqual(overlay, {
    namespace: "project-origin-deadbeef",
    readFallbacks: [""],
    scope: "project",
  });
});

test("resolveCodingNamespaceOverlay: projectScope=true + globalFallback=true → empty-string sentinel combines to principal self", () => {
  // Verifies the fix for the P1 double-combination bug: "" as fallback
  // causes combineNamespaces(principal, "") to return the principal's own
  // namespace, not "principal-default" which would miss global memories.
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:deadbeef" }),
    mode({ globalFallback: true }),
    "default",
  );
  assert.equal(overlay!.readFallbacks.length, 1);
  assert.equal(overlay!.readFallbacks[0], "");
  assert.equal(combineNamespaces("alice", ""), "alice");
  assert.equal(combineNamespaces("default", ""), "default");
});

test("resolveCodingNamespaceOverlay: projectScope=true + globalFallback=false → no root in fallbacks", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:deadbeef" }),
    mode({ globalFallback: false }),
    "default",
  );
  assert.deepEqual(overlay, {
    namespace: "project-origin-deadbeef",
    readFallbacks: [],
    scope: "project",
  });
});

test("resolveCodingNamespaceOverlay: branchScope=true with branch=null → project scope + global fallback", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:aaaa0000", branch: null }),
    mode({ branchScope: true }),
  );
  assert.ok(overlay);
  assert.equal(overlay!.scope, "project");
  assert.equal(overlay!.namespace, "project-origin-aaaa0000");
  assert.deepEqual(overlay!.readFallbacks, [""]);
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — branch scope (PR 3 preview, but logic is here)
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: branchScope=true + branch set + globalFallback=true → project + root fallbacks", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:aaaa0000", branch: "feat/x" }),
    mode({ branchScope: true }),
  );
  assert.ok(overlay);
  assert.equal(overlay!.scope, "branch");
  assert.match(
    overlay!.namespace,
    /^project-origin-aaaa0000-branch-feat-x-[0-9a-f]{8}$/,
  );
  // globalFallback defaults to true → project + empty sentinel for global.
  assert.deepEqual(overlay!.readFallbacks, ["project-origin-aaaa0000", ""]);
});

test("resolveCodingNamespaceOverlay: branchScope=true + globalFallback=true + defaultNamespace → project and root fallbacks", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:aaaa0000", branch: "feat/x" }),
    mode({ branchScope: true, globalFallback: true }),
    "generalist",
  );
  assert.ok(overlay);
  assert.equal(overlay!.scope, "branch");
  assert.match(
    overlay!.namespace,
    /^project-origin-aaaa0000-branch-feat-x-[0-9a-f]{8}$/,
  );
  assert.deepEqual(overlay!.readFallbacks, ["project-origin-aaaa0000", ""]);
});

test("resolveCodingNamespaceOverlay: branchScope=true + globalFallback=false → only project fallback", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:aaaa0000", branch: "feat/x" }),
    mode({ branchScope: true, globalFallback: false }),
    "generalist",
  );
  assert.ok(overlay);
  assert.deepEqual(overlay!.readFallbacks, ["project-origin-aaaa0000"]);
});

test("resolveCodingNamespaceOverlay: branchScope=false → no branch layering even with branch set", () => {
  const overlay = resolveCodingNamespaceOverlay(ctx({ branch: "feat/x" }), mode({ branchScope: false }));
  assert.ok(overlay);
  assert.equal(overlay!.scope, "project");
  assert.ok(!overlay!.namespace.includes("branch:"));
});

// ──────────────────────────────────────────────────────────────────────────
// resolveCodingNamespaceOverlay — globalFallback edge cases
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: globalFallback=true + empty defaultNamespace → still includes empty sentinel", () => {
  // The sentinel "" tells combineNamespaces to return the principal base
  // unchanged, regardless of what defaultNamespace is configured.
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:deadbeef" }),
    mode({ globalFallback: true }),
    "   ",
  );
  assert.deepEqual(overlay!.readFallbacks, [""]);
});

test("resolveCodingNamespaceOverlay: globalFallback=true + custom defaultNamespace → empty sentinel (not the name)", () => {
  const overlay = resolveCodingNamespaceOverlay(
    ctx({ projectId: "origin:deadbeef" }),
    mode({ globalFallback: true }),
    "generalist",
  );
  assert.deepEqual(overlay!.readFallbacks, [""]);
});

// ──────────────────────────────────────────────────────────────────────────
// Cross-project isolation invariant (the core requirement of PR 2)
// ──────────────────────────────────────────────────────────────────────────

test("resolveCodingNamespaceOverlay: different projects resolve to different namespaces", () => {
  const a = resolveCodingNamespaceOverlay(ctx({ projectId: "origin:aaaaaaaa" }), mode());
  const b = resolveCodingNamespaceOverlay(ctx({ projectId: "origin:bbbbbbbb" }), mode());
  assert.ok(a && b);
  assert.notEqual(a!.namespace, b!.namespace, "cross-project isolation — different projectIds must map to different namespaces");
});

test("resolveCodingNamespaceOverlay: read path and write path see identical namespace (rule 42)", () => {
  // Simulate the read and write paths in orchestrator consulting the same
  // resolver with the same inputs. They must agree bit-for-bit.
  const input: [CodingContext, CodingModeConfig] = [
    ctx({ projectId: "origin:12345678", branch: "feat/y" }),
    mode({ branchScope: true }),
  ];
  const readOverlay = resolveCodingNamespaceOverlay(input[0], input[1]);
  const writeOverlay = resolveCodingNamespaceOverlay(input[0], input[1]);
  assert.deepEqual(readOverlay, writeOverlay);
});
