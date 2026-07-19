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
  return {
    profileId: "standard",
    profile: {
      readOrder: ["userProject", "userGlobal", "serverShared"],
      writeDefault: "userProject",
      promotionTargets: ["userGlobal", "serverShared"],
      autoPromote: {
        enabled: false,
        targets: ["userGlobal"],
        categories: ["fact"],
        minConfidenceTier: "inferred",
      },
    },
    baseNamespace: "operator-x",
    writeLayer: "userProject",
    writeNamespace: "",
    readNamespaces: ["operator-x", "shared"],
    layers: [],
    promotionTargets: [],
    warnings: [],
    ...overrides,
  } as ResolvedScopeProfilePlan;
}

test("resolveMemorySearchDefaultFallback returns the default namespace when a global layer is intended and self resolved away (#2018)", () => {
  const fallback = resolveMemorySearchDefaultFallback({
    profilePlan: profilePlan(),
    config: pluginConfig(),
    principal: "operator-x",
  });
  assert.equal(fallback, "default");
});

test("resolveMemorySearchDefaultFallback returns null for a project-only lockdown (#1501)", () => {
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
  const fallback = resolveMemorySearchDefaultFallback({
    profilePlan: plan,
    config: pluginConfig(),
    principal: "operator-x",
  });
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null when the profile self is already the default", () => {
  const fallback = resolveMemorySearchDefaultFallback({
    profilePlan: profilePlan({ baseNamespace: "default" }),
    config: pluginConfig(),
    principal: "default",
  });
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback returns null when only serverShared (no userGlobal) is in readOrder", () => {
  // serverShared maps to sharedNamespace, NOT the default: a profile that
  // reads only userProject + serverShared deliberately reads the shared
  // namespace, not the default, so the fallback must not fire.
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
  const fallback = resolveMemorySearchDefaultFallback({
    profilePlan: plan,
    config: pluginConfig(),
    principal: "operator-x",
  });
  assert.equal(fallback, null);
});

test("resolveMemorySearchDefaultFallback ACL-gates the default namespace", () => {
  const config = pluginConfig({
    defaultNamespace: "root",
    namespacePolicies: [
      { name: "root", readPrincipals: ["owner"], writePrincipals: ["owner"] },
    ],
  } as Partial<PluginConfig>);
  const fallback = resolveMemorySearchDefaultFallback({
    profilePlan: profilePlan(),
    config,
    principal: "operator-x",
  });
  assert.equal(fallback, null);
});

test("mergeMemorySearchDefaultFallback dedupes and passes through", () => {
  assert.deepEqual(mergeMemorySearchDefaultFallback(["a", "b"], "default"), ["a", "b", "default"]);
  assert.deepEqual(mergeMemorySearchDefaultFallback(["default", "b"], "default"), ["default", "b"]);
  assert.deepEqual(mergeMemorySearchDefaultFallback(["a", "b"], null), ["a", "b"]);
});
