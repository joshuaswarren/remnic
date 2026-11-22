import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeMemorySearchDefaultFallback,
  resolveMemorySearchDefaultFallback,
} from "./access-memory-search-fanout.js";
import type { ResolvedScopeProfilePlan } from "./namespaces/scope-profiles.js";
import type { PluginConfig } from "./types.js";

function pluginConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    memoryDir: "/synthetic/mem",
    ...overrides,
  } as unknown as PluginConfig;
}

function profilePlan(overrides: Partial<ResolvedScopeProfilePlan> = {}): ResolvedScopeProfilePlan {
  const base = overrides.baseNamespace ?? "operator-x";
  const readOrder = overrides.profile?.readOrder ?? ["userProject", "userGlobal", "serverShared"];
  // Build a layer per readOrder entry so the resolved-userGlobal-readable gate
  // mirrors what resolveScopeProfilePlan produces (the unit under test reads
  // profilePlan.layers, not the raw readOrder).
  const layerKind: Record<string, "user-project" | "user-global" | "server-shared"> = {
    userProject: "user-project",
    userGlobal: "user-global",
    serverShared: "server-shared",
  };
  const layerNamespace: Record<string, string> = {
    userProject: `${base}-project`,
    userGlobal: base,
    serverShared: "shared",
  };
  const layers = readOrder.map((id) => ({
    id,
    kind: layerKind[id],
    namespace: layerNamespace[id],
    readable: true,
    writable: id === "userProject",
    promotable: id === "userGlobal",
    reason: "test fixture",
  }));
  return {
    profileId: "standard",
    profile: {
      readOrder,
      writeDefault: "userProject",
      promotionTargets: ["userGlobal", "serverShared"],
      autoPromote: {
        enabled: false,
        targets: ["userGlobal"],
        categories: ["fact"],
        minConfidenceTier: "inferred",
      },
    },
    baseNamespace: base,
    writeLayer: "userProject",
    writeNamespace: "",
    readNamespaces: [base, "shared"],
    promotionTargets: [],
    warnings: [],
    ...overrides,
    layers: overrides.layers ?? layers,
  } as unknown as ResolvedScopeProfilePlan;
}

// Wrapper that defaults defaultAtFlatRoot=true so each gate condition is
// exercised independently (a `null` result means a NON-flat-root gate blocked,
// not the flat-root gate). The dedicated flat-root-false test covers that gate.
// `probed` records whether the provider was invoked, so the lazy-probe tests
// can assert ineligible profiles never touch the default store.
async function applyFallback(
  plan: ResolvedScopeProfilePlan,
  config: PluginConfig,
  principal: string | undefined,
  defaultAtFlatRoot = true,
  probed: { value: boolean } = { value: false },
): Promise<{ fallback: string | null; probed: boolean }> {
  const result = await resolveMemorySearchDefaultFallback({
    profilePlan: plan,
    config,
    principal,
    defaultAtFlatRootProvider: () => {
      probed.value = true;
      return Promise.resolve(defaultAtFlatRoot);
    },
  });
  return { fallback: result, probed: probed.value };
}

test("resolveMemorySearchDefaultFallback returns the default namespace on a flat-root legacy deployment (#2018)", async () => {
  const { fallback, probed } = await applyFallback(profilePlan(), pluginConfig(), "operator-x");
  assert.equal(fallback, "default");
  assert.equal(probed, true, "the flat-root provider must be probed when cheap gates pass");
});

test("resolveMemorySearchDefaultFallback returns null when the default namespace is not at the flat root (#2056 r4)", async () => {
  const { fallback } = await applyFallback(profilePlan(), pluginConfig(), "operator-x", false);
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null for a project-only lockdown and never probes storage (#1501, #2056 r6)", async () => {
  const plan = profilePlan({
    profile: {
      readOrder: ["userProject"],
      writeDefault: "userProject",
      promotionTargets: [],
      autoPromote: {
        enabled: false,
        targets: [],
        categories: ["fact"],
        minConfidenceTier: "explicit",
      },
    },
  });
  const { fallback, probed } = await applyFallback(plan, pluginConfig(), "operator-x");
  assert.equal(fallback, null);
  assert.equal(probed, false, "ineligible profiles must not probe the default store");
});

test("resolveMemorySearchDefaultFallback returns null when the profile self is already the default", async () => {
  const { fallback } = await applyFallback(profilePlan({ baseNamespace: "default" }), pluginConfig(), "default");
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null when only serverShared (no userGlobal) is in readOrder", async () => {
  const plan = profilePlan({
    profile: {
      readOrder: ["userProject", "serverShared"],
      writeDefault: "userProject",
      promotionTargets: ["serverShared"],
      autoPromote: {
        enabled: false,
        targets: ["serverShared"],
        categories: ["fact"],
        minConfidenceTier: "inferred",
      },
    },
  });
  const { fallback } = await applyFallback(plan, pluginConfig(), "operator-x");
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null when readOrder omits userGlobal even if a readable userGlobal layer is materialized (#2056 r3)", async () => {
  const plan = profilePlan({
    profile: {
      readOrder: ["userProject"],
      writeDefault: "userProject",
      promotionTargets: [],
      autoPromote: {
        enabled: false,
        targets: [],
        categories: ["fact"],
        minConfidenceTier: "explicit",
      },
    },
    layers: [
      { id: "userProject", kind: "user-project", namespace: "operator-x-project", readable: false, writable: false, promotable: false, reason: "no coding context" },
      { id: "userGlobal", kind: "user-global", namespace: "operator-x", readable: true, writable: true, promotable: true, reason: "materialized but not in readOrder" },
    ],
  });
  const { fallback } = await applyFallback(plan, pluginConfig(), "operator-x");
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback ACL-gates the default namespace", async () => {
  const config = pluginConfig({
    defaultNamespace: "root",
    namespacePolicies: [
      { name: "root", readPrincipals: ["owner"], writePrincipals: ["owner"] },
    ],
  } as Partial<PluginConfig>);
  const { fallback } = await applyFallback(profilePlan(), config, "operator-x");
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null when the resolved userGlobal layer is unreadable (#2056 r2)", async () => {
  const plan = profilePlan({
    layers: [
      { id: "userGlobal", kind: "user-global", namespace: "operator-x", readable: false, writable: false, promotable: false, reason: "policy withholds principal" },
    ],
  });
  const { fallback } = await applyFallback(plan, pluginConfig(), "operator-x");
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null when the principal owns a dedicated namespace (#2056 r2 / #1501 privateOnly)", async () => {
  const config = pluginConfig({
    namespacePolicies: [
      { name: "operator-x", readPrincipals: ["operator-x"], writePrincipals: ["operator-x"] },
    ],
  } as Partial<PluginConfig>);
  const { fallback } = await applyFallback(profilePlan(), config, "operator-x");
  assert.equal(fallback, null);
});

test("mergeMemorySearchDefaultFallback dedupes and passes through", () => {
  assert.deepEqual(mergeMemorySearchDefaultFallback(["a", "b"], "default"), ["a", "b", "default"]);
  assert.deepEqual(mergeMemorySearchDefaultFallback(["default", "b"], "default"), ["default", "b"]);
  assert.deepEqual(mergeMemorySearchDefaultFallback(["a", "b"], null), ["a", "b"]);
});
