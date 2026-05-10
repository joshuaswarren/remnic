/**
 * Integration tests for `EngramAccessService.recallXray` (issue #570 PR 4).
 *
 * These tests use lightweight orchestrator stubs so the HTTP surface
 * and access-service logic can be exercised without spinning up a
 * full retrieval stack.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EngramAccessService } from "../src/access-service.js";
import type { RecallXraySnapshot } from "../src/recall-xray.js";

function fakeSnapshot(
  overrides: Partial<RecallXraySnapshot> = {},
): RecallXraySnapshot {
  return {
    schemaVersion: "1",
    query: "q",
    snapshotId: "snap-1",
    capturedAt: 1_700_000_000_000,
    tierExplain: null,
    results: [],
    filters: [],
    budget: { chars: 4096, used: 0 },
    ...overrides,
  };
}

function stubOrchestrator(opts: {
  recallBudgetChars?: number;
  namespacesEnabled?: boolean;
  namespacePolicies?: Array<{
    name: string;
    readPrincipals: string[];
    writePrincipals: string[];
  }>;
  snapshot?: RecallXraySnapshot | null;
  onRecall?: (
    prompt: string,
    sessionKey: string | undefined,
    options: Record<string, unknown>,
  ) => void;
}) {
  const state = {
    clearedSnapshot: 0,
    lastOptions: undefined as Record<string, unknown> | undefined,
    snapshot: opts.snapshot ?? null,
  };
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: opts.namespacesEnabled ?? false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: opts.namespacePolicies ?? [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      recallBudgetChars: opts.recallBudgetChars ?? 4096,
    },
    recall: async (
      prompt: string,
      sessionKey: string | undefined,
      options: Record<string, unknown>,
    ) => {
      state.lastOptions = options;
      opts.onRecall?.(prompt, sessionKey, options);
      return "ctx";
    },
    clearLastXraySnapshot: () => {
      state.clearedSnapshot += 1;
      state.snapshot = null;
    },
    getLastXraySnapshot: () => state.snapshot,
    setSnapshot: (snap: RecallXraySnapshot | null) => {
      state.snapshot = snap;
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
  };
  return { orchestrator, state };
}

test("recallXray rejects empty query with an explicit error", async () => {
  const { orchestrator } = stubOrchestrator({});
  const service = new EngramAccessService(orchestrator as any);
  await assert.rejects(
    () => service.recallXray({ query: "   " }),
    /query is required and must be non-empty/,
  );
});

test("recallXray returns snapshotFound=false when capture yields nothing", async () => {
  const { orchestrator } = stubOrchestrator({ snapshot: null });
  const service = new EngramAccessService(orchestrator as any);
  const response = await service.recallXray({ query: "q" });
  assert.equal(response.snapshotFound, false);
  assert.equal(response.snapshot, undefined);
});

test("recallXray returns the captured snapshot when present", async () => {
  const snap = fakeSnapshot();
  const { orchestrator, state } = stubOrchestrator({ snapshot: snap });
  // Stash the snapshot inside the stub so getLastXraySnapshot returns
  // it AFTER the recall call is invoked.  Simulates the real capture
  // path: recall() runs → orchestrator stores snapshot →
  // getLastXraySnapshot() reads it.
  const originalRecall = orchestrator.recall;
  orchestrator.recall = async (...args: any[]) => {
    const result = await originalRecall.apply(orchestrator, args as any);
    state.snapshot = snap;
    return result;
  };
  const service = new EngramAccessService(orchestrator as any);
  const response = await service.recallXray({ query: "q" });
  assert.equal(response.snapshotFound, true);
  assert.ok(response.snapshot);
  assert.equal(response.snapshot?.snapshotId, "snap-1");
});

test("recallXray forwards xrayCapture:true to orchestrator.recall", async () => {
  const { orchestrator, state } = stubOrchestrator({ snapshot: null });
  const service = new EngramAccessService(orchestrator as any);
  await service.recallXray({ query: "q" });
  assert.equal(state.lastOptions?.xrayCapture, true);
});

test("recallXray forwards current context scopes through invocation options", async () => {
  const { orchestrator, state } = stubOrchestrator({ snapshot: null });
  const service = new EngramAccessService(orchestrator as any);
  await service.recallXray({
    query: "q",
    currentContextScopes: ["work", "repo"],
  });
  assert.deepEqual(state.lastOptions?.currentContextScopes, ["work", "repo"]);
});

test("recallXray forwards recall mode through invocation options", async () => {
  const { orchestrator, state } = stubOrchestrator({ snapshot: null });
  const service = new EngramAccessService(orchestrator as any);
  await service.recallXray({ query: "q", mode: "full" });
  assert.equal(state.lastOptions?.mode, "full");
});

test("recallXray clears any prior snapshot before capturing", async () => {
  const { orchestrator, state } = stubOrchestrator({
    snapshot: fakeSnapshot({ snapshotId: "stale" }),
  });
  const service = new EngramAccessService(orchestrator as any);
  await service.recallXray({ query: "q" });
  assert.equal(state.clearedSnapshot, 1);
});

test("recallXray threads budget via RecallInvocationOptions, never mutates shared config", async () => {
  const { orchestrator, state } = stubOrchestrator({
    recallBudgetChars: 1000,
    snapshot: null,
  });
  const observedConfigDuringRecall: number[] = [];
  const observedOptions: Array<Record<string, unknown>> = [];
  orchestrator.recall = async (
    _prompt: string,
    _sessionKey: string | undefined,
    options: Record<string, unknown>,
  ) => {
    observedConfigDuringRecall.push(orchestrator.config.recallBudgetChars);
    observedOptions.push(options);
    state.lastOptions = options;
    return "ctx";
  };
  const service = new EngramAccessService(orchestrator as any);
  await service.recallXray({ query: "q", budget: 2048 });
  // Codex P1 on #601: the shared config must NOT be mutated — both
  // the observed value during the recall and the value after are the
  // original config.  The override flows through the options bag only.
  assert.deepEqual(observedConfigDuringRecall, [1000]);
  assert.equal(orchestrator.config.recallBudgetChars, 1000);
  // Budget override is forwarded via RecallInvocationOptions.
  assert.equal(observedOptions[0]?.budgetCharsOverride, 2048);
});

test("recallXray does not mutate shared config even when recall throws", async () => {
  const { orchestrator } = stubOrchestrator({ recallBudgetChars: 1000 });
  orchestrator.recall = async () => {
    throw new Error("boom");
  };
  const service = new EngramAccessService(orchestrator as any);
  await assert.rejects(
    () => service.recallXray({ query: "q", budget: 2048 }),
    /boom/,
  );
  assert.equal(orchestrator.config.recallBudgetChars, 1000);
});

test("recallXray rejects non-positive, fractional, and non-numeric budgets", async () => {
  const { orchestrator } = stubOrchestrator({});
  const service = new EngramAccessService(orchestrator as any);
  for (const bad of [0, -1, 1.5, Number.NaN, "not-a-number" as unknown as number]) {
    await assert.rejects(
      () => service.recallXray({ query: "q", budget: bad as number }),
      /budget expects a positive integer/,
    );
  }
});

test("recallXray enforces namespace read permissions", async () => {
  const { orchestrator, state } = stubOrchestrator({
    namespacesEnabled: true,
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["team-a"],
        writePrincipals: ["team-a"],
      },
    ],
    snapshot: fakeSnapshot(),
  });
  // Populate snapshot on capture for the authorized case.
  orchestrator.recall = async () => {
    state.snapshot = fakeSnapshot({ namespace: "team-a" });
    return "ctx";
  };
  const service = new EngramAccessService(orchestrator as any);

  // Unauthorized principal is rejected *before* recall fires.
  state.lastOptions = undefined;
  const deniedResp = await service.recallXray({
    query: "q",
    namespace: "team-a",
    authenticatedPrincipal: "intruder",
  });
  assert.equal(deniedResp.snapshotFound, false);
  assert.equal(state.lastOptions, undefined, "recall must NOT run for unauthorized namespace");

  // Authorized principal gets the captured snapshot.
  const allowedResp = await service.recallXray({
    query: "q",
    namespace: "team-a",
    authenticatedPrincipal: "team-a",
  });
  assert.equal(allowedResp.snapshotFound, true);
  assert.equal(allowedResp.snapshot?.namespace, "team-a");
});

test("recallXray drops the snapshot when the captured namespace differs from the requested one", async () => {
  // Even if the orchestrator ran a recall that served from a different
  // namespace, the service must not leak that snapshot when a specific
  // namespace was requested.
  const { orchestrator, state } = stubOrchestrator({
    namespacesEnabled: true,
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["team-a"],
        writePrincipals: ["team-a"],
      },
    ],
  });
  orchestrator.recall = async () => {
    state.snapshot = fakeSnapshot({ namespace: "team-b" });
    return "ctx";
  };
  const service = new EngramAccessService(orchestrator as any);
  const response = await service.recallXray({
    query: "q",
    namespace: "team-a",
    authenticatedPrincipal: "team-a",
  });
  assert.equal(response.snapshotFound, false);
});

test("recallXray requires an identity when namespaces are enabled and no namespace is requested", async () => {
  const { orchestrator, state } = stubOrchestrator({
    namespacesEnabled: true,
    namespacePolicies: [],
  });
  const service = new EngramAccessService(orchestrator as any);
  const response = await service.recallXray({ query: "q" });
  assert.equal(response.snapshotFound, false);
  assert.equal(state.lastOptions, undefined, "no recall must fire without an identity");
});

test("recallXray forwards authenticatedPrincipal via principalOverride, NOT as sessionKey", async () => {
  // Codex P1 on #601: threading `authenticatedPrincipal` through
  // `sessionKey` was wrong.  The orchestrator's
  // `resolvePrincipal(sessionKey)` only maps configured raw session
  // keys (via prefix/map/regex rules) and otherwise collapses to
  // `"default"`.  In namespace-enabled deployments that produces
  // false denials or wrong-scope serving for
  // `recallXray` calls that omit `sessionKey`.  Pass the principal
  // through `principalOverride` so the orchestrator evaluates ACLs
  // against the SAME principal the access surface authorized.
  const capturedSessionKeys: Array<string | undefined> = [];
  const capturedOptions: Array<Record<string, unknown>> = [];
  const { orchestrator } = stubOrchestrator({
    namespacesEnabled: true,
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["team-a"],
        writePrincipals: ["team-a"],
      },
    ],
  });
  orchestrator.recall = async (
    _prompt: string,
    sessionKey: string | undefined,
    options: Record<string, unknown>,
  ) => {
    capturedSessionKeys.push(sessionKey);
    capturedOptions.push(options);
    return "ctx";
  };
  const service = new EngramAccessService(orchestrator as any);
  await service.recallXray({
    query: "q",
    namespace: "team-a",
    authenticatedPrincipal: "team-a",
  });
  // sessionKey must NOT be polluted with the principal.
  assert.equal(capturedSessionKeys[0], undefined);
  // principalOverride carries the identity to the orchestrator.
  assert.equal(capturedOptions[0]?.principalOverride, "team-a");
});

test("recallXray drops a snapshot whose namespace is undefined when a namespace was requested", async () => {
  const { orchestrator, state } = stubOrchestrator({
    namespacesEnabled: true,
    namespacePolicies: [
      {
        name: "team-a",
        readPrincipals: ["team-a"],
        writePrincipals: ["team-a"],
      },
    ],
  });
  orchestrator.recall = async () => {
    state.snapshot = fakeSnapshot(); // no namespace set
    return "ctx";
  };
  const service = new EngramAccessService(orchestrator as any);
  const response = await service.recallXray({
    query: "q",
    namespace: "team-a",
    authenticatedPrincipal: "team-a",
  });
  assert.equal(response.snapshotFound, false);
});

test("concurrent recallXray calls each carry their own budget via options, never mutate shared config", async () => {
  const { orchestrator } = stubOrchestrator({ recallBudgetChars: 1000 });
  const observedBudgets: Array<number | undefined> = [];
  const observedConfigs: number[] = [];
  let resolveFirst: () => void = () => {};
  const firstRunning = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  let firstCall = true;
  orchestrator.recall = async (
    _prompt: string,
    _sessionKey: string | undefined,
    options: Record<string, unknown>,
  ) => {
    // Each invocation carries its own per-call budget override and
    // sees the untouched shared config.  This is the core property
    // the Codex P1 review required.
    observedBudgets.push(options.budgetCharsOverride as number | undefined);
    observedConfigs.push(orchestrator.config.recallBudgetChars);
    if (firstCall) {
      firstCall = false;
      await firstRunning;
    }
    return "ctx";
  };
  const service = new EngramAccessService(orchestrator as any);
  const firstCallPromise = service.recallXray({ query: "a", budget: 2048 });
  const secondCallPromise = service.recallXray({ query: "b", budget: 4096 });
  resolveFirst();
  await firstCallPromise;
  await secondCallPromise;
  // Per-call override is observed correctly for each caller.
  assert.deepEqual(observedBudgets, [2048, 4096]);
  // The shared config is never mutated — both recalls observe the
  // same untouched 1000 value in `orchestrator.config.recallBudgetChars`.
  assert.deepEqual(observedConfigs, [1000, 1000]);
  assert.equal(orchestrator.config.recallBudgetChars, 1000);
});
