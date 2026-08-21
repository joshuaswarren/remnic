/**
 * #1495: `observe` must resolve EVERY memory-producing side effect through ONE
 * effective scope plan, so observed turns and extracted memories land in the
 * SAME namespace that same-session project-scoped recall searches.
 *
 * Before this change, `observe`:
 *  - applied the coding overlay to the objective-state snapshot target, but
 *  - keyed LCM archival (`lcmSessionKey`) and extraction replay turns off the
 *    EARLIER base namespace (`resolveWritableNamespace(undefined, …)` ==
 *    `config.defaultNamespace`), and
 *  - returned the base namespace in the response.
 *
 * The fix introduces an internal `MemoryScopePlan` resolver. `observe` consumes
 * it so the LCM key, the extraction write target, the objective-state target,
 * and the response `effectiveNamespace` all agree.
 *
 * Invariants verified here (rule 39 / 42 / 47 / 48 / 51):
 *  - Agreement: LCM key, extraction writeNamespaceOverride, objective-state
 *    target, and response.effectiveNamespace ALL == scope.writeNamespace, and
 *    that equals what a same-session project-scoped resolve produces.
 *  - Explicit namespace wins and is NOT silently overridden by project context.
 *  - No sessionKey ⇒ no overlay (observe requires a sessionKey, so this is the
 *    explicit-namespace / namespaces-disabled equivalents).
 *  - `codingMode.projectScope: false` ⇒ no overlay.
 *  - `namespacesEnabled: false` ⇒ single-store behavior preserved.
 *  - Unauthorized explicit namespace throws BEFORE any session-context mutation.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { PendingObserveExtractionTracker } from "./access-observe-helpers.js";

import { tokenCapabilityStore } from "./access-token-capabilities.js";
import { resolveAuthorizedNamespaceWritablePreflight } from "./access-namespace-preflight.js";
import { Orchestrator } from "./orchestrator.js";
import type { StorageManager } from "./storage.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import {
  combineNamespaces,
  lcmSessionKeyForNamespace,
  projectNamespaceName,
  projectTagProjectId,
} from "./coding/coding-namespace.js";
import { resolveGitContext, stableHash } from "./coding/git-context.js";
import { namespaceCollectionName } from "./namespaces/search.js";
import type { CodingContext, PluginConfig } from "./types.js";

/**
 * Encode the expected namespaced LCM `session_id` via the SAME shared helper
 * production uses, so these assertions stay shape-agnostic after the #1495 P1
 * fix made the namespaced encoding sentinel-framed and unforgeable (rule 22).
 */
function encodeNs(namespace: string, sessionKey: string): string {
  return lcmSessionKeyForNamespace(namespace, sessionKey, "default") ?? sessionKey;
}

interface ObserveProbe {
  orch: Orchestrator;
  contexts: Map<string, CodingContext>;
  lcmCalls: Array<{ sessionKey: string }>;
  extractionCalls: Array<{
    sessionKeys: string[];
    writeNamespaceOverride?: string;
    principalOverride?: string;
  }>;
  objectiveStateNamespaces: string[];
}

/**
 * Build an orchestrator stub wired to record every namespace-bearing side
 * effect `observe` produces: LCM enqueue, extraction replay, and the storage
 * router lookup that the objective-state snapshot writer goes through.
 */
function makeObserveProbe(overrides: Partial<PluginConfig> = {}): ObserveProbe {
  const contexts = new Map<string, CodingContext>();
  const lcmCalls: ObserveProbe["lcmCalls"] = [];
  const extractionCalls: ObserveProbe["extractionCalls"] = [];
  const objectiveStateNamespaces: string[] = [];

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-observe-scope",
    objectiveStateMemoryEnabled: true,
    objectiveStateSnapshotWritesEnabled: true,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    ...overrides,
  } as unknown as PluginConfig;

  const orch = {
    config,
    getCodingContextForSession: (sk: string | undefined) =>
      (sk ? contexts.get(sk) : null) ?? null,
    setCodingContextForSession: (sk: string, ctx: CodingContext | null) => {
      if (ctx === null) contexts.delete(sk);
      else contexts.set(sk, ctx);
    },
    applyCodingNamespaceOverlay: (sk: string | undefined, base: string) =>
      Orchestrator.prototype.applyCodingNamespaceOverlay.call(orch, sk, base),
    // The objective-state snapshot writer goes through getStorage(namespace).
    // Capturing the namespace it resolves lets us assert the objective-state
    // target without touching the filesystem.
    getStorage: async (ns: string) => {
      objectiveStateNamespaces.push(ns);
      return { dir: `/synthetic/storage/${ns}` };
    },
    lcmEngine: {
      enabled: true,
      enqueueObserveMessages: (sessionKey: string) => {
        lcmCalls.push({ sessionKey });
      },
    },
    ingestReplayBatch: async (
      turns: Array<{ sessionKey: string }>,
      options: { writeNamespaceOverride?: string; principalOverride?: string } = {},
    ) => {
      extractionCalls.push({
        sessionKeys: turns.map((t) => t.sessionKey),
        writeNamespaceOverride: options.writeNamespaceOverride,
        principalOverride: options.principalOverride,
      });
    },
  } as unknown as Orchestrator;

  return { orch, contexts, lcmCalls, extractionCalls, objectiveStateNamespaces };
}

function observeRequest(
  overrides: Partial<EngramAccessObserveRequest>,
): EngramAccessObserveRequest {
  return {
    sessionKey: "sess-observe",
    messages: [
      { role: "user", content: "what database are we using?" },
      { role: "assistant", content: "we use postgres for the primary store" },
    ],
    ...overrides,
  } as EngramAccessObserveRequest;
}

/** A principal whose self namespace exists, so the overlay base is non-default. */
function withSelfPolicyPrefix(principal: string): Partial<PluginConfig> {
  return {
    namespacePolicies: [
      { name: principal, readPrincipals: [principal], writePrincipals: [principal] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: `${principal}:`, principal }],
  } as Partial<PluginConfig>;
}

test("#1495 projectTag: LCM, extraction, objective-state, and response all agree on the effective namespace", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );

  // Effective write namespace == principal self base overlaid with the project,
  // EXACTLY what a same-session project-scoped recall/store resolves.
  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );

  assert.equal(res.effectiveNamespace, expected, "response effectiveNamespace");
  assert.notEqual(expected, "default", "overlay must change the namespace");

  // LCM archival key carries the effective namespace prefix.
  assert.equal(probe.lcmCalls.length, 1);
  assert.equal(
    probe.lcmCalls[0].sessionKey,
    encodeNs(expected, "pi-geek:abc123"),
    "LCM key must be prefixed with the EFFECTIVE write namespace",
  );

  // #1505 thread 1 (identity-vs-routing separation): extraction replay turns
  // carry the ORIGINAL, un-prefixed session key so provenance principal
  // resolution and conversation threading see the real identity — NOT the
  // namespace-prefixed key (which `resolvePrincipal` would collapse to
  // `default`). Storage routing is pinned independently via
  // writeNamespaceOverride, and the authenticated principal via principalOverride.
  assert.equal(probe.extractionCalls.length, 1);
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
    "extraction replay turns must carry the ORIGINAL session key (identity), not the namespace-prefixed key",
  );
  assert.equal(
    probe.extractionCalls[0].writeNamespaceOverride,
    expected,
    "extraction must pin the write (routing) to the effective namespace",
  );
  assert.equal(
    probe.extractionCalls[0].principalOverride,
    "pi-geek",
    "extraction must pin provenance to the resolved principal, not a default parsed from a prefixed key",
  );

  // Objective-state snapshot target == effective namespace.
  assert.ok(
    probe.objectiveStateNamespaces.every((ns) => ns === expected),
    `objective-state target must be the effective namespace, got ${JSON.stringify(probe.objectiveStateNamespaces)}`,
  );
});

test("#2128 pending observe preparation is a force-flush barrier", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const preparation = tracker.reserve("session-z");
  let releaseExtraction!: () => void;
  const extraction = new Promise<void>((resolve) => {
    releaseExtraction = resolve;
  });
  let waited = false;
  const waitPromise = tracker.wait("session-z", "alice", "team-project").then(() => {
    waited = true;
  });

  await Promise.resolve();
  assert.equal(waited, false, "a force flush must wait while observe is still resolving scope");

  tracker.track(tracker.key("session-z", "alice", "team-project"), extraction, new AbortController());
  preparation.release();
  await Promise.resolve();
  assert.equal(waited, false, "registration must remain a barrier until extraction settles");

  releaseExtraction();
  await waitPromise;
  assert.equal(waited, true);
});

test("#2206 scoped wait ignores unresolved preparations with a different hint", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const target = tracker.reserve("opaque-session", "projectTag:project-a");
  const unrelated = tracker.reserve("opaque-session", "projectTag:project-b");
  let settled = false;
  const waitPromise = tracker
    .wait(
      "opaque-session",
      "alice",
      "alice-project-a",
      undefined,
      undefined,
      "projectTag:project-a",
    )
    .then(() => {
      settled = true;
    });

  target.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeUnrelatedRelease = settled;
  unrelated.release();
  await waitPromise;

  assert.equal(settledBeforeUnrelatedRelease, true);
});

test("#2206 scoped wait fences a reservation that later resolves into the flushed scope", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const reservation = tracker.reserve("opaque-session", "cwd:/workspace/project/nested");
  const unrelated = tracker.reserve("opaque-session", "cwd:/workspace/other/nested");

  await tracker.wait(
    "opaque-session",
    "alice",
    "alice-project",
    undefined,
    undefined,
    "projectTag:Acme/Webshop",
  );
  assert.equal(reservation.isCancelled(), false, "the raw hint mismatch initially excludes the reservation");

  reservation.setScope("alice", "alice-project");
  unrelated.setScope("alice", "alice-other-project");

  assert.equal(
    reservation.isCancelled(),
    true,
    "a reservation existing at the wait boundary cannot enter the flushed scope later",
  );
  assert.equal(unrelated.isCancelled(), false, "the fence must not cancel a different resolved scope");
  unrelated.release();
  reservation.release();
});

test("#2206 resolved scope overrides a mismatched preparation hint", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const preparation = tracker.reserve("opaque-session", "cwd:/workspace/project/src");
  preparation.setScope("alice", "alice-project");
  let settled = false;
  const waitPromise = tracker
    .wait(
      "opaque-session",
      "alice",
      "alice-project",
      undefined,
      undefined,
      "projectTag:Acme/Webshop",
    )
    .then(() => {
      settled = true;
    });

  await Promise.resolve();
  assert.equal(settled, false);
  preparation.release();
  await waitPromise;
  assert.equal(settled, true);
});

test("#2206 resolved scope mismatch overrides an identical preparation hint", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const unrelated = tracker.reserve("opaque-session", "projectTag:project-a");
  unrelated.setScope("alice", "alice-project-b");
  let settled = false;
  const waitPromise = tracker
    .wait(
      "opaque-session",
      "alice",
      "alice-project-a",
      undefined,
      undefined,
      "projectTag:project-a",
    )
    .then(() => {
      settled = true;
    });

  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeUnrelatedRelease = settled;
  unrelated.release();
  await waitPromise;

  assert.equal(settledBeforeUnrelatedRelease, true);
});

test("#2206 unresolved preparation without a hint remains a conservative barrier", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const preparation = tracker.reserve("opaque-session");
  let settled = false;
  const waitPromise = tracker
    .wait(
      "opaque-session",
      "alice",
      "alice-project",
      undefined,
      undefined,
      "projectTag:project-a",
    )
    .then(() => {
      settled = true;
    });

  await Promise.resolve();
  assert.equal(settled, false);
  preparation.release();
  await waitPromise;
  assert.equal(settled, true);
});

test("#2206 raw-hint cancellation only cancels matching preparations", async () => {
  const tracker = new PendingObserveExtractionTracker();
  const unresolved = tracker.reserve("opaque-session", "projectTag:project-a");
  const resolved = tracker.reserve("opaque-session", "projectTag:project-a");
  const unrelated = tracker.reserve("opaque-session", "projectTag:project-b");
  resolved.setScope("alice", "alice-project-a");
  let releaseExtraction!: () => void;
  const extraction = new Promise<void>((resolve) => {
    releaseExtraction = resolve;
  });
  const unrelatedController = new AbortController();
  tracker.track(
    tracker.key("opaque-session", "alice", "alice-project-b"),
    extraction,
    unrelatedController,
  );

  tracker.cancelPreparations("opaque-session", "projectTag:project-a");

  assert.equal(unresolved.isCancelled(), true);
  assert.equal(resolved.isCancelled(), true);
  assert.equal(unrelated.isCancelled(), false);
  assert.equal(unrelatedController.signal.aborted, false);
  unresolved.release();
  resolved.release();
  unrelated.release();
  releaseExtraction();
  await extraction;
});

test("#2128 scoped observe preparation cancellation preserves another project", () => {
  const tracker = new PendingObserveExtractionTracker();
  const projectA = tracker.reserve("opaque-session", "projectTag:project-a");
  const projectB = tracker.reserve("opaque-session", "projectTag:project-b");

  tracker.cancel("opaque-session", undefined, "alice-project-a", "projectTag:project-a");

  assert.equal(projectA.isCancelled(), true);
  assert.equal(projectB.isCancelled(), false);
  projectA.release();
  projectB.release();
});

test("#2128 cancellation matches resolved scope despite a different request hint", () => {
  const tracker = new PendingObserveExtractionTracker();
  const preparation = tracker.reserve("session-z", "cwd:/workspace/project/src");
  preparation.setScope("alice", "alice-project");

  tracker.cancel("session-z", "alice", "alice-project", "projectTag:Acme/Webshop");

  assert.equal(preparation.isCancelled(), true);
  preparation.release();
});
test("#2128 concurrent scope plans do not share temporary coding context", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const internals = service as unknown as {
    resolveMemoryScopePlan: (request: EngramAccessObserveRequest) => Promise<{
      writeNamespace: string;
    }>;
  };

  const firstProject = projectTagProjectId("Acme/Webshop");
  const secondProject = projectTagProjectId("Contoso/Portal");
  const [firstPlan, secondPlan] = await Promise.all([
    internals.resolveMemoryScopePlan.call(
      service,
      observeRequest({ sessionKey: "pi-geek:concurrent", projectTag: "Acme/Webshop" }),
    ),
    internals.resolveMemoryScopePlan.call(
      service,
      observeRequest({ sessionKey: "pi-geek:concurrent", projectTag: "Contoso/Portal" }),
    ),
  ]);

  assert.equal(
    firstPlan.writeNamespace,
    combineNamespaces("pi-geek", projectNamespaceName(firstProject)),
  );
  assert.equal(
    secondPlan.writeNamespace,
    combineNamespaces("pi-geek", projectNamespaceName(secondProject)),
  );
  assert.equal(
    probe.contexts.get("pi-geek:concurrent"),
    undefined,
    "scope planning must not bind temporary coding context visible to concurrent calls",
  );
});

test("#1501 scope profile exposes layered read/write/promotion diagnostics without changing user-project write default", async () => {
  const probe = makeObserveProbe({
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "shared", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "teamProject", "userGlobal", "serverShared"],
        writeDefault: "userProject",
        promotionTargets: ["teamProject", "serverShared"],
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
        autoPromote: {
          enabled: false,
          targets: [],
          categories: ["fact", "correction", "decision", "preference"],
          minConfidenceTier: "explicit",
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
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Remnic" }),
  );
  const expectedUserProject = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Remnic")),
  );
  const expectedTeamProject = `team-pi-project-${stableHash(projectTagProjectId("Remnic"))}`;

  assert.equal(res.effectiveNamespace, expectedUserProject);
  assert.equal(res.scopeDebug?.scopeProfile, "teamCoding");
  assert.equal(res.scopeDebug?.writeLayer, "userProject");
  assert.deepEqual(res.scopeDebug?.readNamespaces, [
    expectedUserProject,
    expectedTeamProject,
    "pi-geek",
    "shared",
  ]);
  assert.deepEqual(
    res.scopeDebug?.promotionTargets?.map((target) => [
      target.target,
      target.namespace,
      target.authorized,
    ]),
    [
      ["teamProject", expectedTeamProject, true],
      ["serverShared", "shared", true],
    ],
  );
  assert.equal(probe.extractionCalls[0]?.writeNamespaceOverride, expectedUserProject);
});

test("#1495 cwd (git repo): every observe side effect agrees on the effective namespace", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "remnic-observe-git-"));
  // A real (synthetic) git repo so resolveGitContext can read rev-parse output.
  // No remote/commit needed — projectId derives from the resolved root path.
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  try {
    const gitCtx = await resolveGitContext(repoDir);
    assert.ok(gitCtx, "synthetic repo must resolve a git context");

    const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
    const service = new EngramAccessService(probe.orch);

    const res = await service.observe(
      observeRequest({ sessionKey: "pi-geek:cwd1", cwd: repoDir }),
    );

    const expected = combineNamespaces(
      "pi-geek",
      projectNamespaceName(gitCtx!.projectId),
    );

    assert.equal(res.effectiveNamespace, expected);
    assert.equal(probe.lcmCalls[0].sessionKey, encodeNs(expected, "pi-geek:cwd1"));
    // #1505 thread 1: extraction turns carry the ORIGINAL session key (identity);
    // routing + provenance are pinned via the override options.
    assert.deepEqual(
      new Set(probe.extractionCalls[0].sessionKeys),
      new Set(["pi-geek:cwd1"]),
    );
    assert.equal(probe.extractionCalls[0].writeNamespaceOverride, expected);
    assert.equal(probe.extractionCalls[0].principalOverride, "pi-geek");
    assert.ok(probe.objectiveStateNamespaces.every((ns) => ns === expected));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("#1495 explicit namespace wins and project context does NOT silently override it", async () => {
  const probe = makeObserveProbe({
    namespacePolicies: [
      { name: "team", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({
      sessionKey: "pi-geek:abc123",
      namespace: "team",
      projectTag: "Acme/Webshop",
    }),
  );

  assert.equal(res.effectiveNamespace, "team", "explicit namespace must win");
  assert.equal(probe.lcmCalls[0].sessionKey, encodeNs("team", "pi-geek:abc123"));
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, "team");
  // #1505 thread 1: extraction turns carry the ORIGINAL session key (identity),
  // even with an explicit namespace; routing is pinned via writeNamespaceOverride.
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
  );
  assert.equal(probe.extractionCalls[0].principalOverride, "pi-geek");
  assert.ok(probe.objectiveStateNamespaces.every((ns) => ns === "team"));
});

test("#1495 projectScope:false ⇒ no overlay (unqualified write stays on config.defaultNamespace)", async () => {
  // With projectScope off there is NO coding overlay, so an unqualified observe
  // stays on config.defaultNamespace — exactly the pre-#1434 / memory_store
  // behavior for an unqualified write (rule 39: identical across paths). It must
  // NOT be silently moved to the principal self namespace. lcmSessionKey carries
  // no prefix (effective == default).
  const probe = makeObserveProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );

  assert.equal(res.effectiveNamespace, "default");
  assert.equal(res.scopeDebug!.codingOverlayApplied, false);
  assert.equal(probe.lcmCalls[0].sessionKey, "pi-geek:abc123");
  // #1505 round 3 (codex "Pin default-store extraction writes too"): with
  // namespaces ENABLED, extraction must be pinned to the resolved writeNamespace
  // (config.defaultNamespace here) even though it equals the default store —
  // otherwise an unpinned runExtraction would fall back to
  // defaultNamespaceForPrincipal("pi-geek") == "pi-geek" (the SELF namespace),
  // diverging from where LCM/objective-state/response wrote ("default"). Pinning
  // forces every side effect onto the one scope-plan namespace.
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, "default");
});

test("#1495 namespacesEnabled:false ⇒ single-store behavior preserved", async () => {
  const probe = makeObserveProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );

  assert.equal(res.effectiveNamespace, "default");
  assert.equal(res.namespace, "default");
  // No namespace prefix on the LCM key when the effective ns is the default.
  assert.equal(probe.lcmCalls[0].sessionKey, "pi-geek:abc123");
  // No override needed when there is only one store.
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, undefined);
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
  );
});

test("#1495 unauthorized explicit namespace throws BEFORE session context is attached", async () => {
  const probe = makeObserveProbe();
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    service.observe(
      observeRequest({
        sessionKey: "pi-geek:abc123",
        namespace: "victim-secret",
        projectTag: "Acme/Webshop",
      }),
    ),
    /not writable/,
  );

  // No orphaned coding context, no side effects after the auth failure.
  assert.equal(probe.contexts.get("pi-geek:abc123"), undefined);
  assert.equal(probe.lcmCalls.length, 0);
  assert.equal(probe.extractionCalls.length, 0);
  assert.equal(probe.objectiveStateNamespaces.length, 0);
});

test("#1505 thread 1/3: unauthorized OVERLAY self-base throws BEFORE coding context is attached (no orphan context)", async () => {
  // Threads 1 & 3 (cursor / codex): a project-scoped observe with NO explicit
  // namespace. Step 1 (resolveWritableNamespace(undefined)) authorizes the
  // DEFAULT namespace and PASSES. The overlay self-base auth only runs inside
  // the scope plan. If the principal has a self namespace policy that EXISTS but
  // is NOT writable, the scope plan throws — and before this fix that happened
  // AFTER maybeAttachCodingContext mutated the session, leaving a project
  // binding from a rejected op. The invariant: an observe that throws leaves NO
  // coding context on the session, matching memory_store's resolve-before-mutate
  // ordering.
  const probe = makeObserveProbe({
    namespacePolicies: [
      // Self namespace exists (so defaultNamespaceForPrincipal → "pi-geek")
      // but pi-geek may NOT write it — only some other principal can.
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["other"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    service.observe(
      observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
    ),
    /not writable/,
  );

  // No orphaned coding context, no side effects after the overlay auth failure.
  assert.equal(
    probe.contexts.get("pi-geek:abc123"),
    undefined,
    "a rejected observe must NOT leave a project binding on the session",
  );
  assert.equal(probe.lcmCalls.length, 0);
  assert.equal(probe.extractionCalls.length, 0);
  assert.equal(probe.objectiveStateNamespaces.length, 0);
});

test("#1505 thread jvO: restrictive default-namespace write policy does NOT reject a valid project-scoped observe via the legacy-response path (no orphan binding)", async () => {
  // The legacy `namespace` response field was previously a SECOND
  // `resolveWritableNamespace(request.namespace, …)` call. For an implicit
  // (no explicit namespace) project-scoped observe that re-authorized
  // `undefined ⇒ config.defaultNamespace`. Under a deployment that restricts
  // WRITE to the default namespace while still allowing the principal to write
  // its own self/project namespace, that second auth REJECTED an observe whose
  // effective self/project write target the scope plan had ALREADY authorized
  // (the same target memory_store/suggestion_submit accept). Worse, the scope
  // plan had already SEEDED the coding context to compute the overlay, so the
  // post-plan rejection left an orphaned project binding on the session.
  //
  // After the fix the legacy field is DERIVED from the resolved scope plan, so
  // there is no second authorization: the observe succeeds, and the legacy
  // `namespace` stays byte-for-byte `config.defaultNamespace` (overlay-agnostic
  // pre-#1495 semantics) while every side effect uses the overlay write target.
  const probe = makeObserveProbe({
    namespacePolicies: [
      // Restrictive DEFAULT namespace: only `admin` may write it, NOT pi-geek.
      { name: "default", readPrincipals: ["admin"], writePrincipals: ["admin"] },
      // pi-geek may write its own self (and thus its `pi-geek-project-*`) base.
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const expectedOverlay = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );

  // FAIL-BEFORE: this threw `namespace is not writable: default`. PASS-AFTER:
  // the observe is accepted exactly like memory_store/suggestion_submit would.
  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );

  // Every side effect uses the authorized overlay write target.
  assert.equal(res.effectiveNamespace, expectedOverlay);
  assert.equal(res.scopeDebug!.codingOverlayApplied, true);
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, expectedOverlay);
  // The legacy `namespace` field stays byte-for-byte pre-#1495: overlay-agnostic,
  // so config.defaultNamespace for an unqualified write — NOT a re-auth result.
  assert.equal(res.namespace, "default");
  // The seeded coding context IS retained on success (the happy path re-binds
  // the identical context after auth passes) — that is correct, not an orphan.
  assert.ok(
    probe.contexts.get("pi-geek:abc123"),
    "a SUCCESSFUL scoped observe binds the project context for later recall",
  );
});

test("#1505 thread jvO: a genuine reject (unwritable self base) under a restrictive default policy still leaves NO orphan binding", async () => {
  // Companion to the jvO fix: when the observe SHOULD reject (the principal
  // cannot write its own self base), the rejection must still come from the
  // scope plan (resolve-before-mutate) and leave NO session binding — never
  // from a post-plan legacy-response re-auth that fires after seeding.
  const probe = makeObserveProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: ["admin"], writePrincipals: ["admin"] },
      // pi-geek's self base EXISTS but is NOT writable by pi-geek.
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["other"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    service.observe(
      observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
    ),
    /not writable/,
  );

  assert.equal(
    probe.contexts.get("pi-geek:abc123"),
    undefined,
    "a rejected observe must NOT leave a project binding (resolve-before-mutate)",
  );
  assert.equal(probe.lcmCalls.length, 0);
  assert.equal(probe.extractionCalls.length, 0);
  assert.equal(probe.objectiveStateNamespaces.length, 0);
});

test("#1495 scopeDebug exposes the resolved plan for callers/tests", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );

  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );
  assert.ok(res.scopeDebug, "scopeDebug must be present");
  assert.equal(res.scopeDebug!.principal, "pi-geek");
  assert.equal(res.scopeDebug!.baseNamespace, "pi-geek");
  assert.equal(res.scopeDebug!.writeNamespace, expected);
  assert.equal(res.scopeDebug!.codingOverlayApplied, true);
});

test("#1505 (cursor hAp) scopeDebug.baseNamespace reports the principal self base on the implicit no-overlay path", async () => {
  // Regression for the round-4 cursor "Wrong scopeDebug base namespace" thread.
  // Implicit (no explicit namespace) + projectScope OFF ⇒ the no-overlay branch
  // of resolveMemoryScopePlan runs: the general write namespace collapses to
  // config.defaultNamespace ("default") for memory_store parity (rule 39), but
  // the plan's diagnostic baseNamespace must report the principal SELF base
  // ("pi-geek" via defaultNamespaceForPrincipal) — the same base
  // objectiveStateNamespace already targets — NOT the write namespace. Before the
  // fix, scopeDebug.baseNamespace misstated the self base as "default".
  const probe = makeObserveProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123" }),
  );

  assert.ok(res.scopeDebug, "scopeDebug must be present");
  assert.equal(
    res.scopeDebug!.codingOverlayApplied,
    false,
    "no overlay on this path",
  );
  // Write/effective namespace collapses to the default store (memory_store parity)…
  assert.equal(res.scopeDebug!.writeNamespace, "default");
  assert.equal(res.effectiveNamespace, "default");
  // …but the diagnostic base must be the principal SELF base, not the write ns.
  assert.equal(
    res.scopeDebug!.baseNamespace,
    "pi-geek",
    "scopeDebug.baseNamespace must be the principal self base on the implicit no-overlay path",
  );
});

test("#2080 preflight resolves an implicit project scope through the observe write resolver", async () => {
  const probe = makeObserveProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    namespacePolicies: [
      { name: "default", readPrincipals: ["admin"], writePrincipals: ["admin"] },
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
  });
  const service = new EngramAccessService(probe.orch);
  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );

  const result = await (
    service as unknown as {
      namespaceWritablePreflight: (request: {
        sessionKey: string;
        authenticatedPrincipal: string;
        projectTag: string;
      }) => Promise<{ ok: boolean; namespace: string }>;
    }
  ).namespaceWritablePreflight({
    sessionKey: "pi-geek:abc123",
    authenticatedPrincipal: "pi-geek",
    projectTag: "Acme/Webshop",
  });

  assert.deepEqual(result, { ok: true, namespace: expected });
  await assert.rejects(
    () =>
      tokenCapabilityStore.run({ version: 1, namespaces: ["default"] }, () =>
        (
          service as unknown as {
            resolveCodingScopedWriteNamespace: (request: {
              sessionKey: string;
              authenticatedPrincipal: string;
              projectTag: string;
            }) => Promise<string>;
          }
        ).resolveCodingScopedWriteNamespace({
          sessionKey: "pi-geek:abc123",
          authenticatedPrincipal: "pi-geek",
          projectTag: "Acme/Webshop",
        }),
      ),
    /not permitted/,
  );
  const deniedPreflight = await tokenCapabilityStore.run(
    { version: 1, ops: ["observe"], namespaces: ["default"] },
    () =>
      resolveAuthorizedNamespaceWritablePreflight(
        tokenCapabilityStore.getStore(),
        {
          sessionKey: "pi-geek:abc123",
          authenticatedPrincipal: "pi-geek",
          projectTag: "Acme/Webshop",
        },
        "default",
        "observe",
        (request) => service.namespaceWritablePreflight(request),
      ),
  );
  assert.deepEqual(deniedPreflight, { ok: false, reason: "not_writable", namespace: expected });
  await assert.rejects(
    () =>
      tokenCapabilityStore.run({ version: 1, namespaces: ["default"] }, () =>
        service.observe(
          observeRequest({
            sessionKey: "pi-geek:abc123",
            authenticatedPrincipal: "pi-geek",
            projectTag: "Acme/Webshop",
          }),
        ),
      ),
    /not permitted/,
  );
});

test("#1495 the scope plan's writeNamespace matches resolveCodingScopedWriteNamespace (memory_store / suggestion_submit parity, rule 39)", async () => {
  // Regression guard: observe's effective scope MUST be identical to what the
  // explicit-write tools (memory_store / suggestion_submit) resolve via
  // resolveCodingScopedWriteNamespace. If these ever diverge, observed turns and
  // explicit writes on the same session/project would land in different stores.
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  // Bind a session coding context so both resolvers see the same project.
  probe.contexts.set("pi-geek:abc123", {
    projectId: projectTagProjectId("Acme/Webshop"),
    branch: null,
    rootPath: projectTagProjectId("Acme/Webshop"),
    defaultBranch: null,
  });
  const service = new EngramAccessService(probe.orch);

  const internals = service as unknown as {
    resolveMemoryScopePlan: (r: unknown) => Promise<{ writeNamespace: string }>;
    resolveCodingScopedWriteNamespace: (r: unknown) => Promise<string>;
  };

  for (const req of [
    { sessionKey: "pi-geek:abc123", authenticatedPrincipal: "pi-geek" },
    {
      sessionKey: "pi-geek:abc123",
      authenticatedPrincipal: "pi-geek",
      namespace: "pi-geek",
    },
  ]) {
    const plan = await internals.resolveMemoryScopePlan.call(service, req);
    const explicit = await internals.resolveCodingScopedWriteNamespace.call(
      service,
      req,
    );
    assert.equal(
      plan.writeNamespace,
      explicit,
      `observe and explicit-write resolvers must agree for ${JSON.stringify(req)}`,
    );
  }
});

test("#1501 profile write auth rejects memory_store when no profile layer is writable", async () => {
  const probe = makeObserveProbe({
    namespacePolicies: [
      { name: "pi-observer", readPrincipals: ["pi-observer"], writePrincipals: [] },
      { name: "shared", readPrincipals: ["pi-observer"], writePrincipals: [] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-observer:", principal: "pi-observer" }],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["userProject", "teamProject", "serverShared"],
        writeDefault: "userProject",
        promotionTargets: ["teamProject", "serverShared"],
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
        autoPromote: {
          enabled: false,
          targets: [],
          categories: ["fact", "correction", "decision", "preference"],
          minConfidenceTier: "explicit",
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
  } as Partial<PluginConfig>);
  probe.contexts.set("pi-observer:abc123", {
    projectId: projectTagProjectId("Remnic"),
    branch: null,
    rootPath: projectTagProjectId("Remnic"),
    defaultBranch: null,
  });
  const service = new EngramAccessService(probe.orch);
  const internals = service as unknown as {
    resolveMemoryScopePlan: (r: unknown) => Promise<{ writeNamespace: string }>;
    resolveCodingScopedWriteNamespace: (r: unknown) => Promise<string>;
  };
  const req = {
    sessionKey: "pi-observer:abc123",
    authenticatedPrincipal: "pi-observer",
  };

  await assert.rejects(
    () => internals.resolveMemoryScopePlan.call(service, req),
    /scope profile teamCoding has no writable layer/,
  );
  await assert.rejects(
    () => internals.resolveCodingScopedWriteNamespace.call(service, req),
    /scope profile teamCoding has no writable layer/,
  );
});

test("#1501 team-project profile observe reports the profile write namespace as legacy namespace", async () => {
  const projectId = projectTagProjectId("Remnic");
  const expectedTeamProject = `team-pi-project-${stableHash(projectId)}`;
  const probe = makeObserveProbe({
    namespacePolicies: [
      {
        name: expectedTeamProject,
        readPrincipals: ["pi-observer"],
        writePrincipals: ["pi-observer"],
      },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-observer:", principal: "pi-observer" }],
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject", "serverShared"],
        writeDefault: "teamProject",
        promotionTargets: ["teamProject"],
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
        autoPromote: {
          enabled: false,
          targets: [],
          categories: ["fact", "correction", "decision", "preference"],
          minConfidenceTier: "explicit",
        },
      },
    },
    defaultScopeProfile: "teamCoding",
    teams: {
      pi: {
        principals: ["pi-observer"],
        read: ["pi-observer"],
        write: ["pi-observer"],
        promote: ["pi-observer"],
      },
    },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({
      sessionKey: "pi-observer:abc123",
      authenticatedPrincipal: "pi-observer",
      projectTag: "Remnic",
    }),
  );

  assert.equal(res.scopeDebug?.baseNamespace, "pi-observer");
  assert.equal(res.scopeDebug?.writeLayer, "teamProject");
  assert.equal(res.scopeDebug?.codingOverlayApplied, true);
  assert.equal(res.namespace, expectedTeamProject);
  assert.equal(res.effectiveNamespace, expectedTeamProject);
  assert.equal(probe.lcmCalls[0]?.sessionKey, encodeNs(expectedTeamProject, "pi-observer:abc123"));
  assert.equal(probe.extractionCalls[0]?.writeNamespaceOverride, expectedTeamProject);
});

test("#1495 skipExtraction does not enqueue extraction but still archives LCM under the effective namespace", async () => {
  const probe = makeObserveProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({
      sessionKey: "pi-geek:abc123",
      projectTag: "Acme/Webshop",
      skipExtraction: true,
    }),
  );

  const expected = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );
  assert.equal(res.extractionQueued, false);
  assert.equal(probe.extractionCalls.length, 0);
  assert.equal(probe.lcmCalls[0].sessionKey, encodeNs(expected, "pi-geek:abc123"));
});

test("#1501 implicit memorySearch honors active scope profile readOrder", async () => {
  let searchedNamespaces: string[] | null = null;
  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    memoryDir: "/synthetic/remnic-memory-search",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "shared", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    defaultRecallNamespaces: ["self", "shared"],
    defaultScopeProfile: "projectOnly",
    scopeProfiles: {
      projectOnly: {
        readOrder: ["userProject"],
        writeDefault: "userProject",
        promotionTargets: [],
        autoPromote: {
          enabled: false,
          targets: [],
          categories: ["fact", "correction", "decision", "preference"],
          minConfidenceTier: "explicit",
        },
      },
    },
    codingMode: { projectScope: true },
  } as unknown as PluginConfig;
  const orch = {
    config,
    qmd: { isAvailable: () => true },
    getStorage: async () => ({ dir: config.memoryDir } as StorageManager),
    filterPrivateSearchResults: async (results: unknown[]) => results,
    searchAcrossNamespaces: async (options: { namespaces: string[] }) => {
      searchedNamespaces = options.namespaces;
      return [];
    },
  } as unknown as Orchestrator;
  const service = new EngramAccessService(orch);

  const result = await service.memorySearch({
    query: "deployment",
    principal: "pi-geek",
  });

  assert.equal(result.count, 0);
  assert.equal(
    searchedNamespaces,
    null,
    "userProject-only profiles without project context must not fall back to shared/global search",
  );
});

test("#1501 memorySearch collection names stay constrained to active scope profile namespaces", async () => {
  let searchedNamespaces: string[] | null = null;
  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    memoryDir: "/synthetic/remnic-memory-search-collection",
    qmdCollection: "memories",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "shared", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    defaultRecallNamespaces: ["self", "shared"],
    defaultScopeProfile: "privateOnly",
    scopeProfiles: {
      privateOnly: {
        readOrder: ["userGlobal"],
        writeDefault: "userGlobal",
        promotionTargets: [],
        autoPromote: {
          enabled: false,
          targets: [],
          categories: ["fact", "correction", "decision", "preference"],
          minConfidenceTier: "explicit",
        },
      },
    },
    codingMode: { projectScope: true },
  } as unknown as PluginConfig;
  const orch = {
    config,
    qmd: { isAvailable: () => true },
    getStorage: async () => ({ dir: config.memoryDir } as StorageManager),
    filterPrivateSearchResults: async (results: unknown[]) => results,
    searchAcrossNamespaces: async (options: { namespaces: string[] }) => {
      searchedNamespaces = options.namespaces;
      return [];
    },
  } as unknown as Orchestrator;

  const service = new EngramAccessService(orch);
  const sharedCollection = namespaceCollectionName(config.qmdCollection, "shared", {
    defaultNamespace: config.defaultNamespace,
    useLegacyDefaultCollection: false,
  });

  await assert.rejects(
    () => service.memorySearch({ query: "deployment", principal: "pi-geek", collection: sharedCollection }),
    /collection is not namespace-scoped/,
  );
  assert.equal(searchedNamespaces, null);
});
