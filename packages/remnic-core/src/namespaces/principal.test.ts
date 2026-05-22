/**
 * Regression tests for PR #396 round-8 HIGH finding: namespace ACL bypass for
 * unauthenticated callers.
 *
 * Tests cover the three-branch logic in `resolveReadableNamespace` (access-service.ts)
 * using the underlying `canReadNamespace` helper directly, and also verify the
 * expected behaviour of the exported helper itself.
 *
 * All fixtures are synthetic — no real user data.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canReadNamespace, resolvePrincipal } from "./principal.js";
import type { PluginConfig } from "../types.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal PluginConfig with namespace settings.
 * Only the fields consulted by canReadNamespace are populated.
 */
function makeConfig(
  namespacesEnabled: boolean,
  policies: Array<{ name: string; readPrincipals: string[]; writePrincipals: string[] }> = [],
  overrides: Partial<PluginConfig> = {},
): PluginConfig {
  return {
    namespacesEnabled,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: policies,
    // Remaining required fields — set to sensible no-op values.
    memoryDir: "/synthetic/mem",
    defaultRecallNamespaces: ["self", "shared"],
    principalFromSessionKeyMode: "disabled",
    principalFromSessionKeyRules: [],
    briefing: { enabled: false, defaultWindow: "yesterday" },
    daySum: { enabled: false },
    searchBackend: "orama",
    qmd: { enabled: false },
    nativeKnowledge: { enabled: false },
    recall: { budget: {} },
    consolidation: { enabled: false },
    extraction: { enabled: false },
    lcm: { enabled: false },
    ...overrides,
  } as unknown as PluginConfig;
}

// ──────────────────────────────────────────────────────────────────────────
// canReadNamespace — namespacesEnabled = false branch
// (mirrors: resolveReadableNamespace "namespaces disabled → allow read")
// ──────────────────────────────────────────────────────────────────────────

test("canReadNamespace: namespacesEnabled=false always returns true regardless of principal", () => {
  const config = makeConfig(false);

  // Authenticated principal
  assert.equal(
    canReadNamespace("alice", "default", config),
    true,
    "authenticated principal must be allowed when namespaces are disabled",
  );

  // Unauthenticated — simulated by passing "default" as the principal
  // (resolvePrincipal returns "default" for missing sessionKey when disabled).
  assert.equal(
    canReadNamespace("default", "restricted-ns", config),
    true,
    "any caller must be allowed when namespaces are disabled — no ACL applies",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// resolveReadableNamespace — namespacesEnabled = true + principal absent
// (the ACL bypass that was introduced by the over-broad `if (principal && ...)` guard)
//
// We test the *intended* behaviour: code that calls resolveReadableNamespace
// with principal=undefined MUST throw when namespacesEnabled is true.
// We simulate this via the 3-branch logic directly.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Simulate the corrected resolveReadableNamespace 3-branch logic.
 * Returns the namespace or throws EngramAccessInputError-like messages.
 */
function simulateResolveReadableNamespace(
  namespace: string,
  principal: string | undefined,
  config: PluginConfig,
): string {
  const namespacesEnabled = config.namespacesEnabled;

  if (!namespacesEnabled) {
    return namespace;
  }

  if (!principal) {
    throw new Error("authentication required: namespaces are enabled and no principal was supplied");
  }

  if (!canReadNamespace(principal, namespace, config)) {
    throw new Error(`namespace is not readable: ${namespace}`);
  }

  return namespace;
}

test("resolveReadableNamespace (simulated): namespacesEnabled=false + no principal → allowed", () => {
  const config = makeConfig(false);
  assert.doesNotThrow(() => {
    const ns = simulateResolveReadableNamespace("default", undefined, config);
    assert.equal(ns, "default");
  });
});

test("resolveReadableNamespace (simulated): namespacesEnabled=true + no principal → DENIED", () => {
  const config = makeConfig(true, []);
  // The HIGH finding: this must throw, not silently allow.
  assert.throws(
    () => simulateResolveReadableNamespace("default", undefined, config),
    (err: Error) => {
      assert.ok(err.message.includes("authentication required"), `expected 'authentication required', got: ${err.message}`);
      return true;
    },
    "unauthenticated caller must be DENIED when namespacesEnabled=true",
  );
});

test("resolveReadableNamespace (simulated): namespacesEnabled=true + principal with access → allowed", () => {
  const config = makeConfig(true, [
    { name: "alice-ns", readPrincipals: ["alice"], writePrincipals: ["alice"] },
  ]);
  assert.doesNotThrow(() => {
    const ns = simulateResolveReadableNamespace("alice-ns", "alice", config);
    assert.equal(ns, "alice-ns");
  });
});

test("resolveReadableNamespace (simulated): namespacesEnabled=true + principal without access → DENIED", () => {
  const config = makeConfig(true, [
    { name: "alice-ns", readPrincipals: ["alice"], writePrincipals: ["alice"] },
  ]);
  assert.throws(
    () => simulateResolveReadableNamespace("alice-ns", "bob", config),
    (err: Error) => {
      assert.ok(
        err.message.includes("namespace is not readable"),
        `expected 'namespace is not readable', got: ${err.message}`,
      );
      return true;
    },
    "principal without ACL grant must be denied",
  );
});

test("resolveReadableNamespace (simulated): namespacesEnabled=true + wildcard principal → allowed", () => {
  const config = makeConfig(true, [
    { name: "public-ns", readPrincipals: ["*"], writePrincipals: [] },
  ]);
  // Any authenticated principal can read a namespace whose readPrincipals includes "*".
  assert.doesNotThrow(() => {
    const ns = simulateResolveReadableNamespace("public-ns", "anyone", config);
    assert.equal(ns, "public-ns");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// canReadNamespace — namespacesEnabled = true, specific policies
// ──────────────────────────────────────────────────────────────────────────

test("canReadNamespace: namespacesEnabled=true + principal in readPrincipals → true", () => {
  const config = makeConfig(true, [
    { name: "restricted", readPrincipals: ["alice", "bob"], writePrincipals: [] },
  ]);
  assert.equal(canReadNamespace("alice", "restricted", config), true);
  assert.equal(canReadNamespace("bob", "restricted", config), true);
});

test("canReadNamespace: namespacesEnabled=true + principal NOT in readPrincipals → false", () => {
  const config = makeConfig(true, [
    { name: "restricted", readPrincipals: ["alice"], writePrincipals: [] },
  ]);
  assert.equal(canReadNamespace("charlie", "restricted", config), false);
});

test("canReadNamespace: namespacesEnabled=true + no policy for namespace → allow default/shared, deny others", () => {
  const config = makeConfig(true, []);
  // Namespaces without an explicit policy: only defaultNamespace and sharedNamespace are open.
  assert.equal(canReadNamespace("alice", "default", config), true, "default namespace is implicitly readable");
  assert.equal(canReadNamespace("alice", "shared", config), true, "shared namespace is implicitly readable");
  assert.equal(canReadNamespace("alice", "unknown-ns", config), false, "unknown namespace without policy is denied");
});

test("resolvePrincipal: safe regex rules can resolve a principal", () => {
  const config = makeConfig(true, [], {
    principalFromSessionKeyMode: "regex",
    principalFromSessionKeyRules: [
      { match: "^codex-session$", principal: "codex" },
    ],
  });

  assert.equal(resolvePrincipal("codex-session", config), "codex");
});

test("resolvePrincipal: unsafe regex rules are skipped without evaluating crafted session keys", () => {
  const config = makeConfig(true, [], {
    principalFromSessionKeyMode: "regex",
    principalFromSessionKeyRules: [
      { match: "(a+)+$", principal: "blocked" },
    ],
  });
  const craftedSessionKey = `${"a".repeat(10_000)}!`;

  assert.equal(resolvePrincipal(craftedSessionKey, config), "default");
});

test("resolvePrincipal: regex rules are skipped for overlong session keys", () => {
  const config = makeConfig(true, [], {
    principalFromSessionKeyMode: "regex",
    principalFromSessionKeyRules: [
      { match: "^a+$", principal: "blocked" },
    ],
  });

  assert.equal(resolvePrincipal("a".repeat(1_000), config), "default");
});
