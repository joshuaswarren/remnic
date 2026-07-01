import assert from "node:assert/strict";
import test from "node:test";

import { combineNamespaces, resolveCodingNamespaceOverlay } from "../coding/coding-namespace.js";
import { stableHash } from "../coding/git-context.js";
import { parseConfig } from "../config.js";
import type { CodingContext } from "../types.js";
import {
  expandScopeProfileReadNamespaces,
  resolveScopeProfilePlan,
} from "./scope-profiles.js";

function teamCodingConfig() {
  return parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "pi-geek",
        readPrincipals: ["pi-geek"],
        writePrincipals: ["pi-geek"],
      },
      {
        name: "pi-friend",
        readPrincipals: ["pi-friend"],
        writePrincipals: ["pi-friend"],
      },
      {
        name: "shared",
        readPrincipals: ["pi-geek", "pi-friend"],
        writePrincipals: ["pi-geek", "pi-friend"],
      },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "teamProject", "userGlobal", "serverShared"],
        writeDefault: "userProject",
        promotionTargets: ["teamProject", "serverShared"],
        teamProject: {
          namespaceTemplate: "team-{teamId}-project-{projectHash}",
        },
      },
    },
    defaultScopeProfile: "teamCoding",
    teams: {
      pi: {
        principals: ["pi-geek", "pi-friend"],
        read: ["pi-geek", "pi-friend"],
        write: ["pi-geek", "pi-friend"],
        promote: ["pi-geek", "pi-friend"],
      },
    },
  });
}

const codingContext: CodingContext = {
  projectId: "tag:remnic",
  branch: null,
  rootPath: "tag:remnic",
  defaultBranch: null,
};

test("scope profile absent preserves legacy caller behavior by resolving to null", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
  });
  assert.equal(
    resolveScopeProfilePlan({
      config,
      principal: "pi-geek",
      codingContext,
      codingOverlay: resolveCodingNamespaceOverlay(
        codingContext,
        config.codingMode,
        config.defaultNamespace,
      ),
    }),
    null,
  );
});

test("teamCoding profile resolves user-project, team-project, user-global, and shared layers in order", () => {
  const config = teamCodingConfig();
  const overlay = resolveCodingNamespaceOverlay(
    codingContext,
    config.codingMode,
    config.defaultNamespace,
  );
  assert.ok(overlay);

  const geek = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext,
    codingOverlay: overlay,
  });
  const friend = resolveScopeProfilePlan({
    config,
    principal: "pi-friend",
    codingContext,
    codingOverlay: overlay,
  });

  assert.ok(geek);
  assert.ok(friend);
  const geekProject = combineNamespaces("pi-geek", overlay.namespace);
  const friendProject = combineNamespaces("pi-friend", overlay.namespace);
  assert.equal(geek.writeNamespace, geekProject);
  assert.equal(friend.writeNamespace, friendProject);
  assert.notEqual(geekProject, friendProject);
  assert.deepEqual(geek.readNamespaces, [
    geekProject,
    "team-pi-project-2d7ea3c1",
    "pi-geek",
    "shared",
  ]);
  assert.deepEqual(friend.readNamespaces, [
    friendProject,
    "team-pi-project-2d7ea3c1",
    "pi-friend",
    "shared",
  ]);
  assert.ok(!geek.readNamespaces.includes(friendProject));
  assert.ok(!friend.readNamespaces.includes(geekProject));
  assert.deepEqual(
    geek.promotionTargets.map((target) => [target.target, target.namespace, target.authorized]),
    [
      ["teamProject", "team-pi-project-2d7ea3c1", true],
      ["serverShared", "shared", true],
    ],
  );
});

test("explicit user-project namespace policies override base self access", () => {
  const baseConfig = teamCodingConfig();
  const overlay = resolveCodingNamespaceOverlay(
    codingContext,
    baseConfig.codingMode,
    baseConfig.defaultNamespace,
  );
  assert.ok(overlay);
  const deniedProject = combineNamespaces("pi-geek", overlay.namespace);
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: deniedProject, readPrincipals: [], writePrincipals: [] },
    ],
    scopeProfiles: {
      projectOnly: {
        readOrder: ["userProject", "userGlobal"],
        writeDefault: "userProject",
      },
    },
    defaultScopeProfile: "projectOnly",
  });

  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext,
    codingOverlay: overlay,
  });

  assert.ok(plan);
  assert.equal(plan.writeLayer, "userGlobal");
  assert.equal(plan.writeNamespace, "pi-geek");
  assert.deepEqual(plan.readNamespaces, ["pi-geek"]);
  const projectLayer = plan.layers.find((layer) => layer.id === "userProject");
  assert.equal(projectLayer?.namespace, deniedProject);
  assert.equal(projectLayer?.readable, false);
  assert.equal(projectLayer?.writable, false);
});

test("userProject profile namespaces stay principal-specific without namespace policies", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codingMode: { projectScope: true },
    scopeProfiles: {
      hosted: {
        readOrder: ["userProject"],
        writeDefault: "userProject",
      },
    },
    defaultScopeProfile: "hosted",
  });
  const overlay = resolveCodingNamespaceOverlay(codingContext, config.codingMode, config.defaultNamespace);
  assert.ok(overlay);

  const geek = resolveScopeProfilePlan({ config, principal: "pi-geek", codingContext, codingOverlay: overlay });
  const friend = resolveScopeProfilePlan({ config, principal: "pi-friend", codingContext, codingOverlay: overlay });

  assert.ok(geek);
  assert.ok(friend);
  assert.equal(geek.writeNamespace, combineNamespaces("pi-geek", overlay.namespace));
  assert.equal(friend.writeNamespace, combineNamespaces("pi-friend", overlay.namespace));
  assert.notEqual(geek.writeNamespace, friend.writeNamespace);
});

test("scope profile effective reads retain coding fallbacks without omitted legacy namespaces", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true, branchScope: true },
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "shared", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      {
        name: "team-extra",
        readPrincipals: ["pi-geek"],
        writePrincipals: [],
        includeInRecallByDefault: true,
      },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "teamProject"],
        writeDefault: "userProject",
        teamProject: {
          namespaceTemplate: "team-{teamId}-project-{projectHash}",
        },
      },
    },
    defaultScopeProfile: "teamCoding",
    teams: {
      pi: {
        principals: ["pi-geek"],
        read: ["pi-geek"],
        write: ["pi-geek"],
        promote: ["pi-geek"],
      },
    },
  });
  const branchContext: CodingContext = {
    projectId: "origin:aaaa0000",
    branch: "feat/x",
    rootPath: "origin:aaaa0000",
    defaultBranch: "main",
  };
  const overlay = resolveCodingNamespaceOverlay(
    branchContext,
    config.codingMode,
    config.defaultNamespace,
  );
  assert.ok(overlay);
  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: branchContext,
    codingOverlay: overlay,
  });
  assert.ok(plan);
  const teamProjectNamespace = `team-pi-project-${stableHash(branchContext.projectId)}`;

  assert.deepEqual(plan.readNamespaces, [
    combineNamespaces("pi-geek", overlay.namespace),
    teamProjectNamespace,
  ]);
  assert.deepEqual(
    expandScopeProfileReadNamespaces({
      profilePlan: plan,
      principalSelfNamespace: "pi-geek",
      codingOverlay: overlay,
      legacyRecallNamespaces: ["pi-geek", "shared", "team-extra"],
    }),
    [
      combineNamespaces("pi-geek", overlay.namespace),
      teamProjectNamespace,
      combineNamespaces("pi-geek", overlay.readFallbacks[0]!),
    ],
  );
});

test("scope profile expansion does not add user-project fallbacks when userProject is omitted from readOrder", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true, branchScope: true },
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    scopeProfiles: {
      teamOnly: {
        readOrder: ["teamProject"],
        writeDefault: "userProject",
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
      },
    },
    defaultScopeProfile: "teamOnly",
    teams: {
      pi: {
        principals: ["pi-geek"],
        read: ["pi-geek"],
        write: ["pi-geek"],
        promote: ["pi-geek"],
      },
    },
  });
  const branchContext: CodingContext = {
    projectId: "origin:aaaa0000",
    branch: "feat/x",
    rootPath: "origin:aaaa0000",
    defaultBranch: "main",
  };
  const overlay = resolveCodingNamespaceOverlay(branchContext, config.codingMode, config.defaultNamespace);
  assert.ok(overlay);
  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: branchContext,
    codingOverlay: overlay,
  });
  assert.ok(plan);
  const teamProjectNamespace = `team-pi-project-${stableHash(branchContext.projectId)}`;

  assert.deepEqual(
    expandScopeProfileReadNamespaces({
      profilePlan: plan,
      principalSelfNamespace: "pi-geek",
      codingOverlay: overlay,
      legacyRecallNamespaces: ["pi-geek", "shared"],
    }),
    [teamProjectNamespace],
  );
});

test("scope profile expansion does not add global fallback when userGlobal is omitted from readOrder", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    codingMode: { projectScope: true, branchScope: true, globalFallback: true },
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    scopeProfiles: {
      projectOnly: {
        readOrder: ["userProject"],
        writeDefault: "userProject",
      },
    },
    defaultScopeProfile: "projectOnly",
  });
  const branchContext: CodingContext = {
    projectId: "origin:aaaa0000",
    branch: "feat/x",
    rootPath: "origin:aaaa0000",
    defaultBranch: "main",
  };
  const overlay = resolveCodingNamespaceOverlay(branchContext, config.codingMode, config.defaultNamespace);
  assert.ok(overlay);
  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: branchContext,
    codingOverlay: overlay,
  });
  assert.ok(plan);

  const expanded = expandScopeProfileReadNamespaces({
    profilePlan: plan,
    principalSelfNamespace: "pi-geek",
    codingOverlay: overlay,
    legacyRecallNamespaces: ["pi-geek", "shared"],
  });

  assert.deepEqual(expanded, [
    combineNamespaces("pi-geek", overlay.namespace),
    combineNamespaces("pi-geek", overlay.readFallbacks[0]!),
  ]);
  assert.ok(!expanded.includes("pi-geek"));
});

test("scope profile prefers writable implicit team mapping when teamProject is the write layer", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    scopeProfiles: {
      hosted: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
      },
    },
    defaultScopeProfile: "hosted",
    teams: {
      ops: {
        principals: ["alice"],
        read: ["alice"],
        write: [],
        promote: [],
      },
      core: {
        principals: ["alice"],
        read: ["alice"],
        write: ["alice"],
        promote: ["alice"],
      },
    },
  });
  const overlay = resolveCodingNamespaceOverlay(codingContext, config.codingMode, config.defaultNamespace);
  assert.ok(overlay);

  const plan = resolveScopeProfilePlan({
    config,
    principal: "alice",
    codingContext,
    codingOverlay: overlay,
  });

  assert.ok(plan);
  assert.equal(plan.writeNamespace, "team-core-project-2d7ea3c1");
  assert.deepEqual(plan.readNamespaces, ["team-core-project-2d7ea3c1"]);
});

test("scope profile chooses a readable implicit team mapping before promote-only memberships", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    scopeProfiles: {
      hosted: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
      },
    },
    defaultScopeProfile: "hosted",
    teams: {
      ops: {
        principals: [],
        read: [],
        write: [],
        promote: ["alice"],
      },
      core: {
        principals: ["alice"],
        read: ["alice"],
        write: ["alice"],
        promote: ["alice"],
      },
    },
  });
  const overlay = resolveCodingNamespaceOverlay(codingContext, config.codingMode, config.defaultNamespace);
  assert.ok(overlay);

  const plan = resolveScopeProfilePlan({
    config,
    principal: "alice",
    codingContext,
    codingOverlay: overlay,
  });

  assert.ok(plan);
  assert.equal(plan.writeNamespace, "team-core-project-2d7ea3c1");
  assert.deepEqual(plan.readNamespaces, ["team-core-project-2d7ea3c1"]);
});

test("scope profile denies unauthorized team-project promotion while preserving readable layers", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: "pi-observer",
        readPrincipals: ["pi-observer"],
        writePrincipals: ["pi-observer"],
      },
      {
        name: "shared",
        readPrincipals: ["pi-observer"],
        writePrincipals: ["pi-maintainer"],
      },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject", "userGlobal", "serverShared"],
        writeDefault: "userGlobal",
        promotionTargets: ["teamProject", "serverShared"],
        teamProject: {
          namespaceTemplate: "team-{teamId}-project-{projectHash}",
        },
      },
    },
    defaultScopeProfile: "teamCoding",
    teams: {
      pi: {
        principals: ["pi-observer"],
        read: ["pi-observer"],
        write: [],
        promote: [],
      },
    },
  });
  const overlay = resolveCodingNamespaceOverlay(
    codingContext,
    config.codingMode,
    config.defaultNamespace,
  );
  assert.ok(overlay);

  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-observer",
    codingContext,
    codingOverlay: overlay,
  });

  assert.ok(plan);
  assert.deepEqual(plan.readNamespaces, ["team-pi-project-2d7ea3c1", "pi-observer", "shared"]);
  assert.deepEqual(
    plan.promotionTargets.map((target) => [target.target, target.namespace, target.authorized]),
    [
      ["teamProject", "team-pi-project-2d7ea3c1", false],
      ["serverShared", "shared", false],
    ],
  );
});

test("scope profile missing project context falls back without inventing project namespaces", () => {
  const config = teamCodingConfig();
  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: null,
    codingOverlay: null,
  });

  assert.ok(plan);
  assert.equal(plan.writeNamespace, "pi-geek");
  assert.equal(plan.writeLayer, "userGlobal");
  assert.deepEqual(plan.readNamespaces, ["pi-geek", "shared"]);
  assert.ok(plan.warnings.some((warning) => warning.includes("writeDefault userProject unavailable")));
});

test("scope profile unavailable write default uses next readable writable layer", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: [] },
      { name: "shared", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "serverShared"],
        writeDefault: "userProject",
      },
    },
    defaultScopeProfile: "teamCoding",
  });

  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: null,
    codingOverlay: null,
  });

  assert.ok(plan);
  assert.equal(plan.writeLayer, "serverShared");
  assert.equal(plan.writeNamespace, "shared");
  assert.ok(plan.warnings.some((warning) => warning.includes("writeDefault userProject unavailable")));
  assert.deepEqual(plan.readNamespaces, ["shared"]);
});

test("scope profile missing project context does not write outside readable layers", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "shared", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "serverShared"],
        writeDefault: "userProject",
      },
    },
    defaultScopeProfile: "teamCoding",
  });

  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: null,
    codingOverlay: null,
  });

  assert.ok(plan);
  assert.equal(plan.writeLayer, "serverShared");
  assert.equal(plan.writeNamespace, "shared");
  assert.deepEqual(plan.readNamespaces, ["shared"]);
  assert.ok(plan.warnings.some((warning) => warning.includes("writeDefault userProject unavailable")));
});

test("scope profile rejects unknown team-project namespace template placeholders", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        promotionTargets: ["teamProject"],
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projecthash}" },
      },
    },
    defaultScopeProfile: "teamCoding",
    teams: {
      pi: {
        principals: ["pi-geek"],
        read: ["pi-geek"],
        write: ["pi-geek"],
        promote: ["pi-geek"],
      },
    },
  });
  const overlay = resolveCodingNamespaceOverlay(codingContext, config.codingMode, config.defaultNamespace);
  const plan = resolveScopeProfilePlan({ config, principal: "pi-geek", codingContext, codingOverlay: overlay });
  assert.ok(plan);
  const teamProject = plan.layers.find((layer) => layer.id === "teamProject");

  assert.equal(teamProject?.readable, false);
  assert.equal(teamProject?.writable, false);
  assert.deepEqual(plan.readNamespaces, []);
  assert.equal(teamProject?.reason, "unknown team-project namespace template placeholder(s): projecthash");
});

test("scope profile requires namespace policy access when team-project templates collide with protected namespaces", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "shared", readPrincipals: ["pi-maintainer"], writePrincipals: ["pi-maintainer"] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        promotionTargets: ["teamProject"],
        teamProject: { namespaceTemplate: "shared" },
      },
    },
    defaultScopeProfile: "teamCoding",
    teams: {
      pi: {
        principals: ["pi-geek"],
        read: ["pi-geek"],
        write: ["pi-geek"],
        promote: ["pi-geek"],
      },
    },
  });
  const overlay = resolveCodingNamespaceOverlay(codingContext, config.codingMode, config.defaultNamespace);
  const plan = resolveScopeProfilePlan({ config, principal: "pi-geek", codingContext, codingOverlay: overlay });
  assert.ok(plan);
  const teamProject = plan.layers.find((layer) => layer.id === "teamProject");

  assert.equal(teamProject?.namespace, "shared");
  assert.equal(teamProject?.readable, false);
  assert.equal(teamProject?.writable, false);
  assert.deepEqual(plan.readNamespaces, []);
  assert.match(teamProject?.reason ?? "", /team-project namespace collides with a protected namespace policy/);
});





test("scope profile derives isolated safe namespace for unsafe principal ids", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    scopeProfiles: {
      hosted: {
        readOrder: ["userGlobal"],
        writeDefault: "userGlobal",
      },
    },
    defaultScopeProfile: "hosted",
  });

  const plan = resolveScopeProfilePlan({
    config,
    principal: "alice@example.com",
    codingContext: null,
    codingOverlay: null,
  });

  assert.ok(plan);
  assert.match(plan.baseNamespace, /^principal-[a-f0-9]{54}$/);
  assert.equal(plan.baseNamespace.length, 64);
  assert.notEqual(plan.baseNamespace, "principal-" + stableHash("alice@example.com"));
  const expected = plan.baseNamespace;
  assert.deepEqual(plan.readNamespaces, [expected]);
  assert.equal(plan.writeNamespace, expected);
});

test("scope profile explicit self namespace policy overrides implicit self access", () => {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: [], writePrincipals: [] },
    ],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userGlobal"],
        writeDefault: "userGlobal",
      },
    },
    defaultScopeProfile: "teamCoding",
  });

  const plan = resolveScopeProfilePlan({
    config,
    principal: "pi-geek",
    codingContext: null,
    codingOverlay: null,
  });

  assert.ok(plan);
  assert.equal(plan.baseNamespace, "pi-geek");
  assert.deepEqual(plan.readNamespaces, []);
  assert.equal(plan.writeNamespace, "");
  const userGlobal = plan.layers.find((layer) => layer.id === "userGlobal");
  assert.equal(userGlobal?.readable, false);
  assert.equal(userGlobal?.writable, false);
});

test("scope profile auto-promotion is disabled by default", () => {
  const config = parseConfig({
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "teamProject", "userGlobal", "serverShared"],
        writeDefault: "userProject",
        promotionTargets: ["teamProject", "serverShared"],
      },
    },
    defaultScopeProfile: "teamCoding",
  });

  assert.equal(config.scopeProfiles.teamCoding.autoPromote.enabled, false);
  assert.deepEqual(config.scopeProfiles.teamCoding.autoPromote.targets, []);
  assert.deepEqual(config.scopeProfiles.teamCoding.autoPromote.categories, [
    "fact",
    "correction",
    "decision",
    "preference",
  ]);
});

test("parseConfig rejects unsupported scope profile layers and targets", () => {
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            readOrder: ["userProject", "otherUserProject"],
          },
        },
      }),
    /unsupported layer/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            promotionTargets: ["../../shared"],
          },
        },
      }),
    /unsupported target/,
  );
  assert.throws(
    () =>
      parseConfig({
        defaultScopeProfile: 42,
        scopeProfiles: {
          hosted: { readOrder: ["userProject"], writeDefault: "userProject" },
        },
      }),
    /defaultScopeProfile must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            autoPromote: true,
          },
        },
      }),
    /scopeProfiles.bad.autoPromote must be an object/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            autoPromote: { enabled: "treu" },
          },
        },
      }),
    /autoPromote.enabled must be a boolean or boolean-like string/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            autoPromote: { minConfidenceTier: "implide" },
          },
        },
      }),
    /minConfidenceTier must be one of/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            autoPromote: { categories: ["decison"] },
          },
        },
      }),
    /autoPromote.categories must contain only/,
  );
  assert.throws(
    () =>
      parseConfig({
        teams: {
          core: {
            read: "alice",
          },
        },
      }),
    /teams.core.read must be an array/,
  );
  assert.throws(
    () =>
      parseConfig({
        teams: {
          core: {
            read: ["alice", 42],
          },
        },
      }),
    /teams.core.read must contain only non-empty strings/,
  );
  assert.throws(
    () =>
      parseConfig({
        teams: {
          core: {
            projectNamespaceTemplate: 42,
          },
        },
      }),
    /teams.core.projectNamespaceTemplate must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            teamProject: "pi",
          },
        },
      }),
    /scopeProfiles.bad.teamProject must be an object/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            readOrder: ["teamProject", "userGlobal"],
            writeDefault: "teamProject",
            teamProject: { teamId: 42 },
          },
        },
      }),
    /scopeProfiles.bad.teamProject.teamId must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            readOrder: ["teamProject", "userGlobal"],
            writeDefault: "teamProject",
            teamProject: { namespaceTemplate: "" },
          },
        },
      }),
    /scopeProfiles.bad.teamProject.namespaceTemplate must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseConfig({
        scopeProfiles: {
          bad: {
            readOrder: ["teamProject", "userGlobal"],
            writeDefault: "teamProject",
            teamProject: { teamId: "missing" },
          },
        },
        teams: {
          core: {
            principals: ["alice"],
            read: ["alice"],
            write: ["alice"],
            promote: ["alice"],
          },
        },
      }),
    /scopeProfiles.bad.teamProject.teamId references unknown team: missing/,
  );
});
