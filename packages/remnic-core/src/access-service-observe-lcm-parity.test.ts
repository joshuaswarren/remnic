import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngramAccessInputError, EngramAccessService } from "./access-service.js";
import { EngramAccessForbiddenError } from "./access-errors.js";
import { Orchestrator } from "./orchestrator.js";
import { ExtractionDeadlineError } from "./orchestration/extraction-run.js";
import { SessionOwnershipError } from "./orchestration/session-context.js";
import type { EngramAccessObserveRequest, MemoryScopePlan } from "./access-service.js";
import {
  combineNamespaces,
  lcmSessionKeyForNamespace,
  projectNamespaceName,
  projectTagProjectId,
} from "./coding/coding-namespace.js";
import { resolveGitContext, stableHash } from "./coding/git-context.js";
import { defaultNamespaceForPrincipal } from "./namespaces/principal.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface ParityProbe {
  orch: Orchestrator;
  contexts: Map<string, CodingContext>;
  lcmWriteKeys: string[];
  compactionFlushKeys: string[];
  compactionRecordKeys: string[];
  searchSessionIds: Array<string | undefined>;
  searchSessionPrefixes: Array<string | undefined>;
  extractionCalls: Array<{
    sessionKeys: string[];
    writeNamespaceOverride?: string;
    principalOverride?: string;
    sessionOwnerPrincipal?: string;
  }>;
  lcmEngine: {
    enabled: boolean;
    waitForSessionObserveIdle?: (sessionKey: string) => Promise<void>;
  };
  extractionForceFlushCalls: ExtractionForceFlushCall[];
}

interface ExtractionForceFlushCall {
  sessionKey: string;
  options: {
    reason: string;
    extractionDeadlineMs?: number;
    failOnExtractionFailure?: boolean;
    abortSignal?: AbortSignal;
    writeNamespaceOverride?: string;
    principalOverride?: string;
  };
}

function makeParityProbe(overrides: Partial<PluginConfig> = {}): ParityProbe {
  const contexts = new Map<string, CodingContext>();
  const lcmWriteKeys: string[] = [];
  const compactionFlushKeys: string[] = [];
  const compactionRecordKeys: string[] = [];
  const searchSessionIds: Array<string | undefined> = [];
  const searchSessionPrefixes: Array<string | undefined> = [];
  const extractionCalls: ParityProbe["extractionCalls"] = [];
  const extractionForceFlushCalls: ExtractionForceFlushCall[] = [];

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-observe-lcm-parity",
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    ...overrides,
  } as unknown as PluginConfig;

  const lcmEngine = {
    enabled: true,
    enqueueObserveMessages: (sessionKey: string) => {
      lcmWriteKeys.push(sessionKey);
    },
    waitForSessionObserveIdle: async (_sessionKey: string) => {},
    preCompactionFlush: async (sessionKey: string) => {
      compactionFlushKeys.push(sessionKey);
    },
    recordCompaction: async (
      sessionKey: string,
      _before: number,
      _after: number,
    ) => {
      compactionRecordKeys.push(sessionKey);
    },
    searchContextFull: async (
      _query: string,
      _limit: number,
      sessionId?: string,
      sessionPrefix?: string,
    ) => {
      searchSessionIds.push(sessionId);
      searchSessionPrefixes.push(sessionPrefix);
      return [];
    },
  };


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
    resolvePrincipal: (sk?: string) =>
      Orchestrator.prototype.resolvePrincipal.call(orch, sk),
    resolveSelfNamespace: (sk?: string) =>
      Orchestrator.prototype.resolveSelfNamespace.call(orch, sk),
    lcmEngine,
    ingestReplayBatch: async (
      turns: Array<{ sessionKey: string }>,
      options: {
        writeNamespaceOverride?: string;
        principalOverride?: string;
        sessionOwnerPrincipal?: string;
        abortSignal?: AbortSignal;
      } = {},
    ) => {
      extractionCalls.push({
        sessionKeys: turns.map((t) => t.sessionKey),
        writeNamespaceOverride: options.writeNamespaceOverride,
        principalOverride: options.principalOverride,
        sessionOwnerPrincipal: options.sessionOwnerPrincipal,
      });
    },
    flushSession: async (
      sessionKey: string,
      options: ExtractionForceFlushCall["options"],
    ) => {
      extractionForceFlushCalls.push({ sessionKey, options });
    },
  } as unknown as Orchestrator;

  return {
    orch,
    contexts,
    lcmWriteKeys,
    compactionFlushKeys,
    compactionRecordKeys,
    searchSessionIds,
    searchSessionPrefixes,
    extractionCalls,
    lcmEngine,
    extractionForceFlushCalls,
  };
}

function observeRequest(
  overrides: Partial<EngramAccessObserveRequest>,
): EngramAccessObserveRequest {
  return {
    sessionKey: "pi-geek:abc123",
    skipExtraction: true,
    messages: [
      { role: "user", content: "what database are we using?" },
      { role: "assistant", content: "we use postgres for the primary store" },
    ],
    ...overrides,
  } as EngramAccessObserveRequest;
}

function withSelfPolicyPrefix(principal: string): Partial<PluginConfig> {
  return {
    namespacePolicies: [
      { name: principal, readPrincipals: [principal], writePrincipals: [principal] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: `${principal}:`, principal }],
  } as Partial<PluginConfig>;
}

function readerLcmKey(probe: ParityProbe, sessionKey: string): string {
  const principal = (
    probe.orch as unknown as { resolvePrincipal: (sk?: string) => string | undefined }
  ).resolvePrincipal(sessionKey);
  const base = defaultNamespaceForPrincipal(principal, probe.orch.config);
  const overlaid = (
    probe.orch as unknown as {
      applyCodingNamespaceOverlay: (sk: string | undefined, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionKey, base);
  const effectiveNamespace =
    overlaid !== base ? overlaid : probe.orch.config.defaultNamespace;
  return (
    lcmSessionKeyForNamespace(
      effectiveNamespace,
      sessionKey,
      probe.orch.config.defaultNamespace,
    ) ?? sessionKey
  );
}

const LCM_NS_SENTINEL = "\u001f";

function encodeNs(namespace: string, sessionKey: string): string {
  return lcmSessionKeyForNamespace(namespace, sessionKey, "default") ?? sessionKey;
}

function assertOverlayWriteKey(writeKey: string, overlayPrefix: string): void {
  assert.ok(
    writeKey.startsWith(LCM_NS_SENTINEL),
    `write key must be sentinel-framed, got ${JSON.stringify(writeKey)}`,
  );
  const overlayNs = writeKey.slice(LCM_NS_SENTINEL.length).split(LCM_NS_SENTINEL)[0]!;
  assert.ok(
    overlayNs.startsWith(overlayPrefix),
    `overlay namespace must start with ${overlayPrefix}, got ${overlayNs} (key ${JSON.stringify(writeKey)})`,
  );
}

test("#1505 thread 2 helper: write/read encoding agrees and collapses to raw key on the default store", () => {
  assert.equal(
    lcmSessionKeyForNamespace("acme", "sk", "default"),
    `${LCM_NS_SENTINEL}acme${LCM_NS_SENTINEL}sk`,
  );
  assert.equal(lcmSessionKeyForNamespace("default", "sk", "default"), "sk");
  assert.equal(lcmSessionKeyForNamespace(undefined, "sk", "default"), "sk");
  assert.equal(lcmSessionKeyForNamespace("", "sk", "default"), "sk");
  assert.equal(lcmSessionKeyForNamespace("acme", undefined, "default"), undefined);

  const overlayKey = lcmSessionKeyForNamespace("acme", "sk", "default");
  const forgedDefaultKey = lcmSessionKeyForNamespace("default", "acme:sk", "default");
  assert.equal(forgedDefaultKey, "acme:sk");
  assert.notEqual(
    forgedDefaultKey,
    overlayKey,
    "a forged `${ns}:${sk}` default key must NOT equal the overlay encoded id",
  );
  const sentinelLeadingDefault = lcmSessionKeyForNamespace(
    "default",
    `${LCM_NS_SENTINEL}acme${LCM_NS_SENTINEL}sk`,
    "default",
  );
  assert.notEqual(
    sentinelLeadingDefault,
    overlayKey,
    "a sentinel-leading default key must be escaped disjoint from the overlay key-space",
  );
});

test("#1505 thread 2 (c) projectTag: observe LCM write key == recall reader key == compaction keys", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );

  const expectedNs = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );
  const expectedKey = encodeNs(expectedNs, "pi-geek:abc123");
  assert.equal(res.effectiveNamespace, expectedNs);
  assert.notEqual(expectedNs, "default", "overlay must change the namespace");

  assert.equal(probe.lcmWriteKeys.length, 1);
  assert.equal(probe.lcmWriteKeys[0], expectedKey, "LCM write key");

  assert.equal(
    readerLcmKey(probe, "pi-geek:abc123"),
    expectedKey,
    "recall reader LCM key must equal the observe write key",
  );

  await service.lcmCompactionFlush({ sessionKey: "pi-geek:abc123" });
  await service.lcmCompactionRecord({
    sessionKey: "pi-geek:abc123",
    tokensBefore: 100,
    tokensAfter: 10,
  });
  assert.equal(probe.compactionFlushKeys[0], expectedKey, "flush key");
  assert.equal(probe.compactionRecordKeys[0], expectedKey, "record key");
});

test("#2128: disabled LCM flush does not bind per-call project context", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "pi-geek:disabled-lcm-flush";
  probe.lcmEngine.enabled = false;

  const response = await service.lcmCompactionFlush({
    sessionKey,
    projectTag: "Acme/Webshop",
    authenticatedPrincipal: "pi-geek",
  });

  assert.equal(response.enabled, false);
  assert.equal(probe.orch.getCodingContextForSession(sessionKey), null);
  assert.equal(probe.compactionFlushKeys.length, 0);
});

test("#2128: failed LCM flush rolls back a seeded project context", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "pi-geek:failed-lcm-flush";
  probe.lcmEngine.waitForSessionObserveIdle = async () => {
    throw new Error("idle wait failed");
  };

  await assert.rejects(
    () =>
      service.lcmCompactionFlush({
        sessionKey,
        projectTag: "Acme/Webshop",
        authenticatedPrincipal: "pi-geek",
      }),
    /idle wait failed/,
  );
  assert.equal(probe.orch.getCodingContextForSession(sessionKey), null);
});

test("#2128: successful LCM flush does not bind per-call project context", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "pi-geek:successful-lcm-flush";

  const response = await service.lcmCompactionFlush({
    sessionKey,
    projectTag: "Acme/Webshop",
    authenticatedPrincipal: "pi-geek",
  });

  assert.equal(response.enabled, true);
  assert.equal(response.flushed, true);
  assert.equal(probe.orch.getCodingContextForSession(sessionKey), null);
  assert.equal(probe.compactionFlushKeys.length, 1);
});

test("#2128: extraction force-flush uses observe's scoped target even when LCM is disabled", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const abortController = new AbortController();
  probe.lcmEngine.enabled = false;

  const response = await service.extractionForceFlush({
    sessionKey: "pi-geek:force-flush",
    projectTag: "Acme/Webshop",
    deadlineMs: 10_000,
    abortSignal: abortController.signal,
    authenticatedPrincipal: "pi-geek",
  });

  const expectedNamespace = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );
  assert.equal(response.flushed, true);
  assert.equal(response.effectiveNamespace, expectedNamespace);
  assert.equal(probe.extractionForceFlushCalls.length, 1);
  const [call] = probe.extractionForceFlushCalls;
  assert.equal(call.sessionKey, "pi-geek:force-flush");
  assert.equal(call.options.reason, "access_force_flush");
  assert.equal(
    Object.hasOwn(call.options, "bufferKey"),
    false,
    "force-flush must let the orchestrator discover all session buffer keys",
  );
  assert.ok(
    (call.options.extractionDeadlineMs ?? 0) >= Date.now() + 9_000,
    "the orchestrator deadline is the duration converted at force-flush entry",
  );
  assert.equal(call.options.failOnExtractionFailure, true);
  const signal = call.options.abortSignal;
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  abortController.abort();
  assert.equal(signal.aborted, true);
  assert.equal(call.options.writeNamespaceOverride, expectedNamespace);
  assert.equal(
    probe.orch.getCodingContextForSession("pi-geek:force-flush"),
    null,
    "successful extraction force-flush must clear per-call coding context",
  );
  assert.equal(call.options.principalOverride, "pi-geek");
  assert.equal(
    Object.hasOwn(call.options, "sessionOwnerPrincipal"),
    false,
    "force-flush must not claim ownership for opaque buffered turns",
  );
});

test("#2128: single-store force-flush clears retained turns without an owner filter", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  const cleanupOwners: Array<string | undefined> = [];
  (probe.orch as unknown as {
    buffer: {
      clearRetainedTurnsForSession(
        sessionKey: string,
        ownerPrincipal?: string,
        options?: { abortSignal?: AbortSignal; deadlineMs?: number },
      ): Promise<void>;
    };
  }).buffer = {
    clearRetainedTurnsForSession: async (_sessionKey, ownerPrincipal) => {
      cleanupOwners.push(ownerPrincipal);
    },
  };
  const service = new EngramAccessService(probe.orch);

  await service.extractionForceFlush({
    sessionKey: "single-store-session",
    authenticatedPrincipal: "pi-geek",
  });

  assert.deepEqual(cleanupOwners, [undefined]);
});

test("#2128: force-flush waits for a pending observe extraction", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  let resolveExtraction!: () => void;
  const pendingExtraction = new Promise<void>((resolve) => {
    resolveExtraction = resolve;
  });
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    options.onExtractionQueued?.(pendingExtraction);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "pending-observe-extraction";

  await service.observe(
    observeRequest({
      sessionKey,
      skipExtraction: false,
    }),
  );

  let settled = false;
  const flushPromise = service.extractionForceFlush({ sessionKey });
  void flushPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  resolveExtraction();
  const response = await flushPromise;
  assert.equal(response.flushed, true);
});
test("#2128: pending extraction barriers stay isolated by authenticated principal", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "team", readPrincipals: ["alice", "bob"], writePrincipals: ["alice", "bob"] },
    ],
  } as Partial<PluginConfig>);
  const pending = new Map<string, () => void>();
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    pending.set(options.principalOverride ?? "", resolve);
    options.onExtractionQueued?.(promise);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "shared-session";

  await service.observe(
    observeRequest({
      sessionKey,
      namespace: "team",
      authenticatedPrincipal: "alice",
      skipExtraction: false,
    }),
  );
  await service.observe(
    observeRequest({
      sessionKey,
      namespace: "team",
      authenticatedPrincipal: "bob",
      skipExtraction: false,
    }),
  );
  assert.deepEqual([...pending.keys()].sort(), ["alice", "bob"]);

  const aliceFlush = service.extractionForceFlush({
    sessionKey,
    namespace: "team",
    authenticatedPrincipal: "alice",
    deadlineMs: 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending.get("alice")?.();
  assert.equal((await aliceFlush).flushed, true);

  const bobFlush = service.extractionForceFlush({
    sessionKey,
    namespace: "team",
    authenticatedPrincipal: "bob",
    deadlineMs: 500,
  });
  pending.get("bob")?.();
  assert.equal((await bobFlush).flushed, true);
});

test("#2128: chained observes remain behind one force-flush barrier", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  const resolvers: Array<() => void> = [];
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    resolvers.push(resolve);
    options.onExtractionQueued?.(promise);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "chained-observes";

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  const flushPromise = service.extractionForceFlush({ sessionKey, deadlineMs: 500 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  assert.equal(resolvers.length, 2);

  resolvers[0]?.();
  assert.equal((await flushPromise).flushed, true);
  assert.equal(resolvers.length, 2);
});

test("#2128: a failed observe extraction is consumed after force-flush reports it", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  let rejectExtraction!: (error: Error) => void;
  let extractionAttempt = 0;
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    extractionAttempt += 1;
    if (extractionAttempt > 1) return;
    const { promise, reject } = Promise.withResolvers<void>();
    rejectExtraction = reject;
    options.onExtractionQueued?.(promise);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "failed-observe-extraction";
  const failure = new Error("provider failed");

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  const reported = assert.rejects(
    service.extractionForceFlush({ sessionKey }),
    (error: unknown) => error === failure,
  );
  const parked = Promise.withResolvers<void>();
  setImmediate(parked.resolve);
  await parked.promise;
  rejectExtraction(failure);
  await reported;

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  await assert.doesNotReject(() => service.extractionForceFlush({ sessionKey }));
});

test("#2128: force-flush deadline cancels the pending observe extraction", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  let extractionSignal: AbortSignal | undefined;
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    extractionSignal = options.abortSignal;
    const { promise, reject } = Promise.withResolvers<void>();
    options.abortSignal?.addEventListener(
      "abort",
      () => reject(new Error("extraction cancelled")),
      { once: true },
    );
    options.onExtractionQueued?.(promise);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "deadline-cancelled-extraction";

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(
      service.extractionForceFlush({
        sessionKey,
        deadlineMs: 25,
      }),
      (error: unknown) =>
        error instanceof EngramAccessInputError &&
        error.message.includes("pending_observe_extraction"),
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(extractionSignal?.aborted, true);
});

test("#2128: force-flush abort signal cancels the pending observe extraction", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  let extractionSignal: AbortSignal | undefined;
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    extractionSignal = options.abortSignal;
    const { promise, reject } = Promise.withResolvers<void>();
    options.abortSignal?.addEventListener(
      "abort",
      () => reject(new Error("extraction cancelled")),
      { once: true },
    );
    options.onExtractionQueued?.(promise);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "abort-cancelled-extraction";
  const abortController = new AbortController();

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  const flushPromise = service.extractionForceFlush({
    sessionKey,
    abortSignal: abortController.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abortController.abort();
  await assert.rejects(
    flushPromise,
    (error: unknown) => error instanceof Error && error.message === "extraction force-flush aborted",
  );
  assert.equal(extractionSignal?.aborted, true);
});

test("#2128: force-flush abort only cancels the resolved namespace barrier", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "project-a", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "project-b", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
  } as Partial<PluginConfig>);
  const extractionSignals = new Map<string, AbortSignal | undefined>();
  const extractionResolvers = new Map<string, () => void>();
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    const namespace = options.writeNamespaceOverride ?? "";
    extractionSignals.set(namespace, options.abortSignal);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    extractionResolvers.set(namespace, resolve);
    options.abortSignal?.addEventListener(
      "abort",
      () => reject(options.abortSignal?.reason ?? new Error("extraction cancelled")),
      { once: true },
    );
    options.onExtractionQueued?.(promise);
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "opaque-shared-session";
  const namespaceA = "project-a";
  const namespaceB = "project-b";

  await service.observe(
    observeRequest({
      sessionKey,
      authenticatedPrincipal: "pi-geek",
      namespace: namespaceA,
      skipExtraction: false,
    }),
  );
  await service.observe(
    observeRequest({
      sessionKey,
      authenticatedPrincipal: "pi-geek",
      namespace: namespaceB,
      skipExtraction: false,
    }),
  );
  assert.ok(extractionSignals.has(namespaceA));
  assert.ok(extractionSignals.has(namespaceB));

  const abortController = new AbortController();
  const flushA = service.extractionForceFlush({
    sessionKey,
    authenticatedPrincipal: "pi-geek",
    namespace: namespaceA,
    abortSignal: abortController.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  abortController.abort();
  await assert.rejects(
    flushA,
    (error: unknown) => error instanceof Error && error.message === "extraction force-flush aborted",
  );
  assert.equal(extractionSignals.get(namespaceA)?.aborted, true);
  assert.equal(extractionSignals.get(namespaceB)?.aborted, false);

  extractionResolvers.get(namespaceB)?.();
  await assert.doesNotReject(() =>
    service.extractionForceFlush({
      sessionKey,
      authenticatedPrincipal: "pi-geek",
      namespace: namespaceB,
    }),
  );
});

test("#2128: authenticated opaque sessions persist their trusted owner for force-flush", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "opaque-session-42";

  await service.observe(
    observeRequest({
      sessionKey,
      authenticatedPrincipal: "pi-geek",
      skipExtraction: false,
    }),
  );

  assert.equal(probe.extractionCalls[0]?.sessionOwnerPrincipal, "pi-geek");
  const response = await service.extractionForceFlush({
    sessionKey,
    authenticatedPrincipal: "pi-geek",
    projectTag: "Acme/Webshop",
  });
  assert.equal(response.flushed, true);
  assert.equal(probe.extractionForceFlushCalls[0]?.options.principalOverride, "pi-geek");
  assert.equal(
    probe.orch.getCodingContextForSession(sessionKey),
    null,
    "opaque force-flush must not persist caller project context",
  );
});


test("#2128: extraction force-flush rejects a session owned by another principal", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
      { name: "victim", readPrincipals: ["victim"], writePrincipals: ["victim"] },
    ],
    principalFromSessionKeyRules: [
      { match: "pi-geek:", principal: "pi-geek" },
      { match: "victim:", principal: "victim" },
    ],
  });
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "victim:private-session",
        authenticatedPrincipal: "pi-geek",
      }),
    /sessionKey is not owned by authenticated principal/,
  );
  assert.equal(probe.extractionForceFlushCalls.length, 0);
});

test("#2128: opaque ownership denial is surfaced as a forbidden access error", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  probe.orch.flushSession = async () => {
    throw new SessionOwnershipError("session opaque-session has buffered turns without trusted ownership");
  };
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "opaque-session",
        authenticatedPrincipal: "pi-geek",
      }),
    (error: unknown) =>
      error instanceof EngramAccessForbiddenError &&
      error.message === "session opaque-session has buffered turns without trusted ownership",
  );
});

test("#2128: explicit namespace force-flush does not bind unrelated project context", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "pi-geek:explicit-scope";

  await service.extractionForceFlush({
    sessionKey,
    namespace: "pi-geek",
    projectTag: "Acme/Webshop",
    authenticatedPrincipal: "pi-geek",
  });

  assert.equal(probe.orch.getCodingContextForSession(sessionKey), null);
});
test("#2128: post-flush retained cleanup is best effort and receives lifecycle guards", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const abortController = new AbortController();
  const cleanupCalls: Array<{
    sessionKey: string;
    ownerPrincipal?: string;
    options?: { abortSignal?: AbortSignal; deadlineMs?: number };
  }> = [];
  (probe.orch as unknown as {
    buffer: {
      clearRetainedTurnsForSession(
        sessionKey: string,
        ownerPrincipal?: string,
        options?: { abortSignal?: AbortSignal; deadlineMs?: number },
      ): Promise<void>;
    };
  }).buffer = {
    clearRetainedTurnsForSession: async (sessionKey, ownerPrincipal, options) => {
      cleanupCalls.push({ sessionKey, ownerPrincipal, options });
      throw new Error("retained cleanup unavailable");
    },
  };
  const service = new EngramAccessService(probe.orch);
  const deadlineMs = 10_000;

  const response = await service.extractionForceFlush({
    sessionKey: "pi-geek:cleanup-best-effort",
    authenticatedPrincipal: "pi-geek",
    abortSignal: abortController.signal,
    deadlineMs,
  });

  assert.equal(response.flushed, true);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0]?.sessionKey, "pi-geek:cleanup-best-effort");
  assert.equal(cleanupCalls[0]?.ownerPrincipal, "pi-geek");
  assert.equal(cleanupCalls[0]?.options?.abortSignal, abortController.signal);
  assert.ok(
    (cleanupCalls[0]?.options?.deadlineMs ?? 0) >= Date.now() + 9_000,
    "cleanup deadline is the duration converted at force-flush entry",
  );
});

test("#2128: post-flush retained cleanup stops on abort or deadline", async (t) => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  let cleanupStarted: (() => void) | undefined;
  const cleanupCalls: Array<{
    sessionKey: string;
    ownerPrincipal: string | undefined;
    options: { abortSignal?: AbortSignal; deadlineMs?: number } | undefined;
  }> = [];
  Object.defineProperty(probe.orch, "buffer", {
    configurable: true,
    value: {
      clearRetainedTurnsForSession: async (
        sessionKey: string,
        ownerPrincipal?: string,
        options?: { abortSignal?: AbortSignal; deadlineMs?: number },
      ) => {
        cleanupCalls.push({ sessionKey, ownerPrincipal, options });
        cleanupStarted?.();
        return new Promise<void>(() => {});
      },
    },
  });
  const service = new EngramAccessService(probe.orch);
  const abortController = new AbortController();
  setTimeout(() => abortController.abort(), 5).unref();

  await assert.rejects(
    () =>
      Promise.race([
        service.extractionForceFlush({
          sessionKey: "pi-geek:cleanup-abort",
          authenticatedPrincipal: "pi-geek",
          abortSignal: abortController.signal,
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("abort cleanup test timed out")), 100),
        ),
      ]),
    /extraction force-flush aborted/,
  );
  assert.deepEqual(cleanupCalls[0], {
    sessionKey: "pi-geek:cleanup-abort",
    ownerPrincipal: "pi-geek",
    options: {
      abortSignal: abortController.signal,
      deadlineMs: undefined,
      writeNamespaceOverride: "default",
      codingContext: undefined,
      scopeProfileWritePlan: undefined,
    },
  });

  const cleanupStartedPromise = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const deadlineFlush = service.extractionForceFlush({
    sessionKey: "pi-geek:cleanup-deadline",
    authenticatedPrincipal: "pi-geek",
    deadlineMs: 5,
  });
  await Promise.race([
    cleanupStartedPromise,
    new Promise<never>((_resolve, reject) =>
      setImmediate(() => reject(new Error("deadline cleanup did not start"))),
    ),
  ]);
  assert.deepEqual(cleanupCalls[1], {
    sessionKey: "pi-geek:cleanup-deadline",
    ownerPrincipal: "pi-geek",
    options: {
      abortSignal: undefined,
      deadlineMs: 5,
      // #3252: cleanup targets the pinned accepted-capture storage target.
      writeNamespaceOverride: "default",
      codingContext: undefined,
      scopeProfileWritePlan: undefined,
    },
  });
  t.mock.timers.tick(5);
  await assert.rejects(
    deadlineFlush,
    /replay extraction deadline exceeded \(retained_turn_cleanup\)/,
  );
});
test("#3140: a duration deadline reaches scope resolution and aborts it when it elapses", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);
  let scopeResolutionStarted = false;
  const internals = service as unknown as {
    resolveMemoryScopePlan: (request: unknown) => Promise<never>;
  };
  internals.resolveMemoryScopePlan = async () => {
    scopeResolutionStarted = true;
    return new Promise<never>(() => {});
  };

  const flush = service.extractionForceFlush({
    sessionKey: "duration-deadline-scope-resolution",
    deadlineMs: 30,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scopeResolutionStarted, true, "the budget lets scope resolution start");
  const stillPending = Promise.race([
    flush.then(() => "rejected", () => "rejected"),
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(await stillPending, "pending");
  t.mock.timers.tick(30);
  await assert.rejects(flush, /scope_resolution/);
  assert.equal(probe.extractionForceFlushCalls.length, 0);
});

test("#2206: abort during scope resolution cancels pre-resolution observe preparations", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const abortController = new AbortController();
  let releaseObserveScope!: () => void;
  let signalObserveScopeStarted!: () => void;
  let signalFlushScopeStarted!: () => void;
  const observeScopeGate = new Promise<void>((resolve) => {
    releaseObserveScope = resolve;
  });
  const observeScopeStarted = new Promise<void>((resolve) => {
    signalObserveScopeStarted = resolve;
  });
  const flushScopeStarted = new Promise<void>((resolve) => {
    signalFlushScopeStarted = resolve;
  });
  const internals = service as unknown as {
    resolveMemoryScopePlan: (
      request: EngramAccessObserveRequest & { messages?: unknown },
    ) => Promise<MemoryScopePlan>;
  };
  const resolveMemoryScopePlan = internals.resolveMemoryScopePlan.bind(service);
  internals.resolveMemoryScopePlan = async (request) => {
    if (request.messages !== undefined) {
      signalObserveScopeStarted();
      await observeScopeGate;
      return resolveMemoryScopePlan(request);
    }
    signalFlushScopeStarted();
    return new Promise<never>(() => {});
  };

  const observe = service.observe(observeRequest({
    sessionKey: "pi-geek:abort-scope-resolution",
    namespace: "pi-geek",
    authenticatedPrincipal: "pi-geek",
    skipExtraction: false,
  }));
  await observeScopeStarted;
  const flush = service.extractionForceFlush({
    sessionKey: "pi-geek:abort-scope-resolution",
    namespace: "pi-geek",
    authenticatedPrincipal: "pi-geek",
    abortSignal: abortController.signal,
  });
  await flushScopeStarted;
  abortController.abort();

  await assert.rejects(flush, /extraction force-flush aborted/);
  releaseObserveScope();
  const response = await observe;
  assert.equal(response.extractionQueued, false);
  assert.equal(probe.extractionCalls.length, 1);
});

test("#2206: scope-resolution deadline cancels preparations by raw projectTag and cwd hints", async (t) => {
  const rawHintCases = [
    { projectTag: "Acme/Webshop" },
    { cwd: "/workspace/acme/webshop" },
  ];

  for (const rawHintCase of rawHintCases) {
    const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
    const service = new EngramAccessService(probe.orch);
    let releaseObserveScope!: () => void;
    let signalObserveScopeStarted!: () => void;
    let flushScopeStarted = false;
    const observeScopeGate = new Promise<void>((resolve) => {
      releaseObserveScope = resolve;
    });
    const observeScopeStarted = new Promise<void>((resolve) => {
      signalObserveScopeStarted = resolve;
    });
    const internals = service as unknown as {
      resolveMemoryScopePlan: (
        request: EngramAccessObserveRequest & { messages?: unknown },
      ) => Promise<MemoryScopePlan>;
    };
    const resolveMemoryScopePlan = internals.resolveMemoryScopePlan.bind(service);
    internals.resolveMemoryScopePlan = async (request) => {
      if (request.messages !== undefined) {
        signalObserveScopeStarted();
        await observeScopeGate;
        return resolveMemoryScopePlan(request);
      }
      flushScopeStarted = true;
      return new Promise<never>(() => {});
    };

    const observe = service.observe(observeRequest({
      sessionKey: "pi-geek:raw-hint-deadline",
      authenticatedPrincipal: "pi-geek",
      skipExtraction: false,
      ...rawHintCase,
    }));
    await observeScopeStarted;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      const flush = service.extractionForceFlush({
        sessionKey: "pi-geek:raw-hint-deadline",
        authenticatedPrincipal: "pi-geek",
        deadlineMs: 1,
        ...rawHintCase,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(flushScopeStarted, true);
      t.mock.timers.tick(1);
      await assert.rejects(flush, /scope_resolution/);
    } finally {
      t.mock.timers.reset();
      releaseObserveScope();
    }
    const response = await observe;
    // Cancelled preparation aborts only the extraction; the durable capture
    assert.equal(response.extractionQueued, false);
    assert.equal(probe.extractionCalls.length, 1);
  }
});

test("#2128: aborted or expired extraction force-flush never touches a buffer", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const abortController = new AbortController();
  abortController.abort();

  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "pi-geek:aborted-flush",
        authenticatedPrincipal: "pi-geek",
        abortSignal: abortController.signal,
      }),
    /extraction force-flush aborted/,
  );
  const internals = service as unknown as {
    resolveMemoryScopePlan: (request: unknown) => Promise<never>;
  };
  internals.resolveMemoryScopePlan = async () => new Promise<never>(() => {});
  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "pi-geek:expired-flush",
        authenticatedPrincipal: "pi-geek",
        deadlineMs: 1,
      }),
    (error: unknown) =>
      error instanceof EngramAccessInputError &&
      error.message === "replay extraction deadline exceeded (scope_resolution)",
  );
  assert.equal(probe.extractionForceFlushCalls.length, 0);
});

test("#2128: self-deps wires force-flush cancellation into the observe tracker", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const cancellations: Array<{
    sessionKey: string;
    principal?: string;
    namespace?: string;
  }> = [];
  const surface = (service as unknown as {
    accessObserveWriteSurface: {
      cancelPendingObserveExtractions(
        sessionKey: string,
        principal?: string,
        namespace?: string,
      ): void;
    };
  }).accessObserveWriteSurface;
  surface.cancelPendingObserveExtractions = (sessionKey, principal, namespace) => {
    cancellations.push({ sessionKey, principal, namespace });
  };

  const internals = service as unknown as {
    resolveMemoryScopePlan: (request: unknown) => Promise<never>;
  };
  internals.resolveMemoryScopePlan = async () => new Promise<never>(() => {});
  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "pi-geek:cancel-hook",
        namespace: "pi-geek",
        authenticatedPrincipal: "pi-geek",
        deadlineMs: 1,
      }),
    (error: unknown) =>
      error instanceof EngramAccessInputError &&
      error.message === "replay extraction deadline exceeded (scope_resolution)",
  );
  assert.deepEqual(cancellations, [{
    sessionKey: "pi-geek:cancel-hook",
    principal: "pi-geek",
    namespace: "pi-geek",
  }]);
});

test("#2128: late extraction deadline is surfaced as an access input error", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  probe.orch.flushSession = async () => {
    throw new ExtractionDeadlineError("during_extract");
  };
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "pi-geek:late-deadline",
        authenticatedPrincipal: "pi-geek",
        deadlineMs: 10_000,
      }),
    (error: unknown) =>
      error instanceof EngramAccessInputError &&
      error.message === "replay extraction deadline exceeded (during_extract)",
  );
});

test("#2128: force-flush scope resolution does not overwrite a concurrent observe context", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "pi-geek:concurrent-scope";
  let releaseFlush!: () => void;
  const flushBlocked = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  probe.orch.flushSession = async () => flushBlocked;

  const flushPromise = service.extractionForceFlush({
    sessionKey,
    projectTag: "Acme/FlushProject",
    authenticatedPrincipal: "pi-geek",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    probe.orch.getCodingContextForSession(sessionKey),
    null,
    "force-flush scope resolution must stay local while its drain is pending",
  );

  await service.observe(
    observeRequest({
      sessionKey,
      projectTag: "Acme/ObserveProject",
      authenticatedPrincipal: "pi-geek",
      skipExtraction: true,
    }),
  );
  const observedContext = probe.orch.getCodingContextForSession(sessionKey);
  assert.ok(observedContext);
  assert.equal(observedContext.projectId, projectTagProjectId("Acme/ObserveProject"));

  releaseFlush();
  await flushPromise;
  assert.equal(
    probe.orch.getCodingContextForSession(sessionKey)?.projectId,
    projectTagProjectId("Acme/ObserveProject"),
    "force-flush cleanup must not clear a context attached by the concurrent observe",
  );
});

test("#1505 thread 2 (b) cwd git repo: observe LCM write key == recall reader key == compaction keys", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "remnic-lcm-parity-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  try {
    const gitCtx = await resolveGitContext(repoDir);
    assert.ok(gitCtx, "synthetic repo must resolve a git context");

    const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
    const service = new EngramAccessService(probe.orch);

    const res = await service.observe(
      observeRequest({ sessionKey: "pi-geek:cwd1", cwd: repoDir }),
    );
    const expectedNs = combineNamespaces(
      "pi-geek",
      projectNamespaceName(gitCtx!.projectId),
    );
    const expectedKey = encodeNs(expectedNs, "pi-geek:cwd1");

    assert.equal(res.effectiveNamespace, expectedNs);
    assert.equal(probe.lcmWriteKeys[0], expectedKey, "LCM write key");
    assert.equal(
      readerLcmKey(probe, "pi-geek:cwd1"),
      expectedKey,
      "recall reader LCM key must equal the observe write key",
    );

    await service.lcmCompactionFlush({ sessionKey: "pi-geek:cwd1" });
    await service.lcmCompactionRecord({
      sessionKey: "pi-geek:cwd1",
      tokensBefore: 100,
      tokensAfter: 10,
    });
    assert.equal(probe.compactionFlushKeys[0], expectedKey, "flush key");
    assert.equal(probe.compactionRecordKeys[0], expectedKey, "record key");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("#1505 thread 2 (a) explicit namespace: write key prefixed; compaction agrees", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "team", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", namespace: "team" }),
  );
  assert.equal(res.effectiveNamespace, "team");
  assert.equal(
    probe.lcmWriteKeys[0],
    encodeNs("team", "pi-geek:abc123"),
    "LCM write key",
  );

  assert.equal(
    lcmSessionKeyForNamespace("team", "pi-geek:abc123", "default"),
    encodeNs("team", "pi-geek:abc123"),
    "explicit-namespace recall reader key matches the write key",
  );

  await service.lcmCompactionFlush({
    sessionKey: "pi-geek:abc123",
    namespace: "team",
  });
  await service.lcmCompactionRecord({
    sessionKey: "pi-geek:abc123",
    namespace: "team",
    tokensBefore: 100,
    tokensAfter: 10,
  });
  assert.equal(
    probe.compactionFlushKeys[0],
    encodeNs("team", "pi-geek:abc123"),
    "flush key",
  );
  assert.equal(
    probe.compactionRecordKeys[0],
    encodeNs("team", "pi-geek:abc123"),
    "record key",
  );
});

test("#1505 thread 2 (d) projectScope:false ⇒ raw sessionKey everywhere (single-user regression guard)", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  assert.equal(res.effectiveNamespace, "default");
  assert.equal(probe.lcmWriteKeys[0], "pi-geek:abc123", "raw LCM write key");
  assert.equal(
    readerLcmKey(probe, "pi-geek:abc123"),
    "pi-geek:abc123",
    "reader key must be the raw sessionKey",
  );

  await service.lcmCompactionFlush({ sessionKey: "pi-geek:abc123" });
  await service.lcmCompactionRecord({
    sessionKey: "pi-geek:abc123",
    tokensBefore: 100,
    tokensAfter: 10,
  });
  assert.equal(probe.compactionFlushKeys[0], "pi-geek:abc123", "raw flush key");
  assert.equal(probe.compactionRecordKeys[0], "pi-geek:abc123", "raw record key");
});

test("#1505 thread 2 (d) namespacesEnabled:false ⇒ raw sessionKey everywhere", async () => {
  const probe = makeParityProbe({
    namespacesEnabled: false,
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  assert.equal(res.effectiveNamespace, "default");
  assert.equal(probe.lcmWriteKeys[0], "pi-geek:abc123", "raw LCM write key");
  assert.equal(readerLcmKey(probe, "pi-geek:abc123"), "pi-geek:abc123");

  await service.lcmCompactionFlush({ sessionKey: "pi-geek:abc123" });
  assert.equal(probe.compactionFlushKeys[0], "pi-geek:abc123", "raw flush key");

  assert.equal(
    defaultNamespaceForPrincipal("pi-geek", probe.orch.config),
    "default",
  );
});

test("#1505 thread 1: extraction provenance principal is the resolved principal (NOT default) for a project-scoped observe with an encoded-principal key", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({
      sessionKey: "pi-geek:abc123",
      projectTag: "Acme/Webshop",
      skipExtraction: false, // exercise the extraction path
    }),
  );

  const expectedNs = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Acme/Webshop")),
  );
  assert.equal(probe.extractionCalls.length, 1);
  assert.equal(
    probe.extractionCalls[0].principalOverride,
    "pi-geek",
    "provenance principal must be the resolved principal, not default",
  );
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
    "extraction turns must carry the ORIGINAL un-prefixed session key",
  );
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, expectedNs);
});

test("#1505 thread 1: provenance principal honors authenticatedPrincipal not encoded in the session key", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({
      sessionKey: "sess-1",
      authenticatedPrincipal: "alice",
      skipExtraction: false,
    }),
  );

  assert.equal(probe.extractionCalls.length, 1);
  assert.equal(
    probe.extractionCalls[0].principalOverride,
    "alice",
    "provenance principal must honor the authenticated principal",
  );
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["sess-1"]),
    "extraction turns carry the original session key",
  );
});

test("#1505 thread 2: LCM read namespace honors authenticatedPrincipal (write-under-alice ⇒ read-under-alice)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({
      sessionKey: "sess-1",
      authenticatedPrincipal: "alice",
      projectTag: "Acme/Webshop",
    }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "alice-"); // observe must archive under alice's overlay namespace, got ${writeKey}

  const lcmReadNamespaceForSession = Orchestrator.prototype[
    "lcmReadNamespaceForSession" as keyof Orchestrator
  ] as unknown as (
    this: Orchestrator,
    sk?: string,
    principalOverride?: string,
  ) => string;

  const withoutOverride = lcmReadNamespaceForSession.call(probe.orch, "sess-1");
  assert.ok(
    !withoutOverride.startsWith("alice-"),
    `without override the read base must NOT be alice (demonstrates the bug), got ${withoutOverride}`,
  );

  const withOverride = lcmReadNamespaceForSession.call(
    probe.orch,
    "sess-1",
    "alice",
  );
  assert.equal(
    encodeNs(withOverride, "sess-1"),
    writeKey,
    "authenticated principal override ⇒ read key matches the alice-prefixed write key",
  );
});

test("#1505 thread 2 compaction regression: flush/record overlay-derived key matches observe (pre-fix used base only)", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  await service.lcmCompactionFlush({ sessionKey: "pi-geek:abc123" });

  const observedWriteKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(observedWriteKey, "pi-geek-"); // observe must archive under the overlay namespace, got ${observedWriteKey}
  assert.equal(
    probe.compactionFlushKeys[0],
    observedWriteKey,
    "compaction flush must target the overlay key, not the base",
  );
});

test("#1501 scope profile lcmSearch fans out prefix-only reads across profile namespaces", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-observer"),
    namespacePolicies: [
      { name: "pi-observer", readPrincipals: ["pi-observer"], writePrincipals: ["pi-observer"] },
      { name: "shared", readPrincipals: ["pi-observer"], writePrincipals: [] },
    ],
    defaultScopeProfile: "profilePrefix",
    scopeProfiles: {
      profilePrefix: {
        readOrder: ["userGlobal", "serverShared"],
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
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.lcmSearch({
    query: "database",
    sessionPrefix: "pi-observer:",
    authenticatedPrincipal: "pi-observer",
  });

  assert.deepEqual(probe.searchSessionIds, [undefined, undefined]);
  assert.deepEqual(probe.searchSessionPrefixes, [
    encodeNs("pi-observer", "pi-observer:"),
    encodeNs("shared", "pi-observer:"),
  ]);
});

test("#1501 scope profile lcmSearch reads the team-project profile key", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-observer"),
    defaultScopeProfile: "teamCoding",
    scopeProfiles: {
      teamCoding: {
        readOrder: ["teamProject"],
        writeDefault: "teamProject",
        promotionTargets: ["teamProject"],
        autoPromote: {
          enabled: false,
          targets: [],
          categories: ["fact", "correction", "decision", "preference"],
          minConfidenceTier: "explicit",
        },
        teamProject: { namespaceTemplate: "team-{teamId}-project-{projectHash}" },
      },
    },
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

  await service.observe(
    observeRequest({ sessionKey: "pi-observer:abc123", projectTag: "Remnic" }),
  );
  const expectedTeamProject = `team-pi-project-${stableHash(projectTagProjectId("Remnic"))}`;
  const expectedKey = encodeNs(expectedTeamProject, "pi-observer:abc123");
  assert.equal(probe.lcmWriteKeys[0], expectedKey);

  await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "pi-observer:abc123",
  });

  assert.equal(
    probe.searchSessionIds[0],
    expectedKey,
    "lcmSearch must read the same team-project key the scope-profile observe wrote",
  );
});

test("#1505 round 3: access lcmSearch routes the session_id through the SCOPED (overlay) key", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assert.ok(
    writeKey.startsWith(LCM_NS_SENTINEL),
    `observe must archive under the sentinel-framed overlay key, got ${JSON.stringify(writeKey)}`,
  );
  const overlayNs = writeKey.slice(LCM_NS_SENTINEL.length).split(LCM_NS_SENTINEL)[0]!;
  assert.ok(
    overlayNs.startsWith("pi-geek-"),
    `overlay namespace must be pi-geek's project overlay, got ${overlayNs}`,
  );

  await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "pi-geek:abc123",
    sessionPrefix: "pi-geek:",
  });

  assert.equal(
    probe.searchSessionIds[0],
    writeKey,
    "lcmSearch session_id must be the overlay-scoped key, matching the write key",
  );
  assert.ok(
    !probe.searchSessionIds.includes("pi-geek:abc123"),
    `lcmSearch must NOT query the raw sessionKey; queried: ${JSON.stringify(probe.searchSessionIds)}`,
  );
  assert.equal(
    probe.searchSessionPrefixes[0],
    encodeNs(overlayNs, "pi-geek:"),
    "lcmSearch sessionPrefix must carry the overlay namespace too",
  );
});

test("#1505 round 3: lcmSearch on a single-store / no-overlay session keeps the raw key (regression guard)", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.lcmSearch({
    query: "anything",
    sessionKey: "pi-geek:abc123",
  });
  assert.equal(
    probe.searchSessionIds[0],
    "pi-geek:abc123",
    "no overlay ⇒ lcmSearch searches the raw sessionKey (byte-for-byte preserved)",
  );
});

test("#1505 round 3: extraction is pinned to the resolved writeNamespace even when it equals the default store", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({
      sessionKey: "pi-geek:abc123",
      skipExtraction: false, // exercise extraction
    }),
  );

  assert.equal(probe.extractionCalls.length, 1);
  assert.equal(
    probe.extractionCalls[0].writeNamespaceOverride,
    "default",
    "extraction must be pinned to the default store, not left to fall back to the principal self namespace",
  );
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
  );
  assert.equal(probe.extractionCalls[0].principalOverride, "pi-geek");
});

// ──────────────────────────────────────────────────────────────────────────

test("#1505 round 3 thread 1: orchestrator LCM read key falls back to default when the principal can WRITE but not READ its self namespace", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);

  probe.contexts.set("sess-1", {
    projectId: "acme-webshop",
    projectName: "Acme/Webshop",
  } as unknown as CodingContext);

  const lcmReadNamespaceForSession = Orchestrator.prototype[
    "lcmReadNamespaceForSession" as keyof Orchestrator
  ] as unknown as (
    this: Orchestrator,
    sk?: string,
    principalOverride?: string,
  ) => string;

  const readNs = lcmReadNamespaceForSession.call(probe.orch, "sess-1", "alice");
  assert.equal(
    readNs,
    "default",
    `unreadable self base ⇒ LCM read key must fall back to the default store, got ${readNs}`,
  );
  assert.ok(
    !readNs.startsWith("alice-"),
    `LCM read key must NOT inject alice's overlay rows when alice cannot read her self namespace, got ${readNs}`,
  );
});

test("#1505 round 3 thread 1: orchestrator LCM read key falls back to default when defaultRecallNamespaces omits self", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["shared"],
  } as Partial<PluginConfig>);

  probe.contexts.set("sess-1", {
    projectId: "acme-webshop",
    projectName: "Acme/Webshop",
  } as unknown as CodingContext);

  const lcmReadNamespaceForSession = Orchestrator.prototype[
    "lcmReadNamespaceForSession" as keyof Orchestrator
  ] as unknown as (
    this: Orchestrator,
    sk?: string,
    principalOverride?: string,
  ) => string;

  const readNs = lcmReadNamespaceForSession.call(probe.orch, "sess-1", "alice");
  assert.equal(
    readNs,
    "default",
    `self omitted from defaultRecallNamespaces ⇒ overlay LCM read key must fall back to default, got ${readNs}`,
  );
});

test("#1505 round 3 thread 1: orchestrator LCM read key still uses the overlay when self IS readable (round-2 positive case preserved)", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);

  probe.contexts.set("pi-geek:abc123", {
    projectId: "acme-webshop",
    projectName: "Acme/Webshop",
  } as unknown as CodingContext);

  const lcmReadNamespaceForSession = Orchestrator.prototype[
    "lcmReadNamespaceForSession" as keyof Orchestrator
  ] as unknown as (this: Orchestrator, sk?: string) => string;

  const readNs = lcmReadNamespaceForSession.call(probe.orch, "pi-geek:abc123");
  assert.ok(
    readNs.startsWith("pi-geek-"),
    `readable self ⇒ overlay LCM read key must be the project overlay, got ${readNs}`,
  );
  assert.notEqual(readNs, "default");
});

test("#1505 round 3 thread 2: lcmSearch returns NO overlay rows when the principal cannot read its self base (authorized fallback)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  probe.contexts.set("sess-1", {
    projectId: "acme-webshop",
    projectName: "Acme/Webshop",
  } as unknown as CodingContext);

  await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "sess-1",
    sessionPrefix: "alice:",
    authenticatedPrincipal: "alice",
  });

  assert.equal(
    probe.searchSessionIds[0],
    "sess-1",
    `unauthorized overlay base ⇒ lcmSearch must query the raw sessionKey, got ${String(
      probe.searchSessionIds[0],
    )}`,
  );
  assert.ok(
    !String(probe.searchSessionIds[0] ?? "").includes("alice-"),
    `lcmSearch must NOT return alice-project-* rows to a caller who cannot read the alice namespace; queried: ${JSON.stringify(
      probe.searchSessionIds,
    )}`,
  );
  assert.ok(
    !String(probe.searchSessionPrefixes[0] ?? "").includes("alice-"),
    `lcmSearch sessionPrefix must NOT carry the alice overlay namespace; got ${String(
      probe.searchSessionPrefixes[0],
    )}`,
  );
});

test("#1505 round 4 thread (codex P2): compaction flush/record target the OVERLAY key even when the principal can WRITE but not READ its self base", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      // Write-only self policy: alice can write `alice` but cannot read it.
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // WRITE: alice observes sess-1 with a project tag → overlay applies on alice's
  await service.observe(
    observeRequest({
      sessionKey: "sess-1",
      authenticatedPrincipal: "alice",
      projectTag: "Acme/Webshop",
    }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "alice-"); // observe must archive under alice's overlay key, got ${writeKey}

  await service.lcmCompactionFlush({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });
  await service.lcmCompactionRecord({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
    tokensBefore: 100,
    tokensAfter: 10,
  });

  assert.equal(
    probe.compactionFlushKeys[0],
    writeKey,
    "compaction flush must target the overlay key (write-authorized), not the default/raw key",
  );
  assert.equal(
    probe.compactionRecordKeys[0],
    writeKey,
    "compaction record must target the overlay key (write-authorized), not the default/raw key",
  );
});

test("#1505 round 4 thread (codex P2): a read-only lcmSearch by the SAME write-only principal still does NOT leak the overlay rows (read vs write gate divergence)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  probe.contexts.set("sess-1", {
    projectId: "acme-webshop",
    projectName: "Acme/Webshop",
  } as unknown as CodingContext);

  await service.lcmSearch({
    query: "anything",
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });

  assert.equal(
    probe.searchSessionIds[0],
    "sess-1",
    "read gate: write-only/read-denied principal must NOT receive alice-project-* rows on lcmSearch",
  );
});

test("#1505 round 3 thread 2: lcmSearch still routes through the overlay key when the principal CAN read its self base (round-2 positive case preserved)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const writeRes = await service.observe(
    observeRequest({
      sessionKey: "sess-1",
      authenticatedPrincipal: "alice",
      projectTag: "Acme/Webshop",
    }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "alice-"); // observe must archive under alice's overlay key, got ${writeKey}

  await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });

  assert.equal(
    probe.searchSessionIds[0],
    writeKey,
    "readable self ⇒ lcmSearch session_id must be the overlay-scoped key matching the write key",
  );
  assert.equal(
    writeRes.effectiveNamespace?.startsWith("alice-"),
    true,
    "observe effectiveNamespace must be the alice overlay (sanity)",
  );
});

test("#1505 thread NBHWs (codex P2): restrictive `default` WRITE policy + writable self ⇒ compaction flush/record the OVERLAY queue (no `not writable: default` throw)", async () => {
  //
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const observeRes = await service.observe(
    observeRequest({
      sessionKey: "sess-1",
      authenticatedPrincipal: "alice",
      projectTag: "Acme/Webshop",
    }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "alice-"); // observe must archive under alice's writable overlay key, got ${writeKey}
  assert.ok(
    observeRes.effectiveNamespace?.startsWith("alice-"),
    "observe effectiveNamespace must be the alice overlay (sanity)",
  );

  const flushRes = await service.lcmCompactionFlush({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });
  const recordRes = await service.lcmCompactionRecord({
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
    tokensBefore: 100,
    tokensAfter: 10,
  });

  assert.equal(flushRes.flushed, true, "flush must succeed");
  assert.equal(recordRes.recorded, true, "record must succeed");
  assert.equal(
    probe.compactionFlushKeys[0],
    writeKey,
    "compaction flush must target the overlay key observe wrote, not the (unwritable) default key",
  );
  assert.equal(
    probe.compactionRecordKeys[0],
    writeKey,
    "compaction record must target the overlay key observe wrote, not the (unwritable) default key",
  );
});

test("#1505 thread NBHWz (sweep): restrictive `default` READ policy + readable self ⇒ lcmSearch reads the self/recall-authorized overlay (no `not readable: default` throw)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "pi-geek-"); // observe must archive under pi-geek's overlay key, got ${writeKey}

  const res = await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "pi-geek:abc123",
  });
  assert.equal(res.lcmEnabled, true);
  assert.equal(
    probe.searchSessionIds[0],
    writeKey,
    "lcmSearch must route through the readable self overlay key, not pre-authorize the denied default",
  );
});

test("#1505 codex P1 'Don't treat any readable namespace as default LCM access': self EXCLUDED from recall + `shared` readable + `default` denied ⇒ lcmSearch SUPPRESSES (never the denied default store, never `shared:`)", async () => {
  //
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  probe.contexts.set("sess-1", {
    projectId: "acme-webshop",
    projectName: "Acme/Webshop",
  } as unknown as CodingContext);

  const res = await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });

  assert.equal(res.lcmEnabled, true);
  assert.equal(res.count, 0, "no authorized LCM target ⇒ empty results");
  assert.equal(
    probe.searchSessionIds.length,
    0,
    "lcmSearch must SUPPRESS (no searchContextFull) — never read the denied default store via a `shared`-only authorization",
  );
});

test("#1505 cursor 'LCM read gate wrong fallback' (positive): self READABLE-in-recall but overlay-self gate denies ⇒ lcmSearch uses the raw sessionKey (default store), never `shared:`", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      // Restrictive default: alice may NOT read `default`.
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.lcmSearch({
    query: "what database are we using?",
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });

  assert.equal(res.lcmEnabled, true);
  assert.equal(
    probe.searchSessionIds[0],
    "sess-1",
    "self-readable PROCEED + no overlay ⇒ lcmSearch queries the raw sessionKey (default store), matching the orchestrator",
  );
  for (const id of probe.searchSessionIds) {
    assert.ok(
      !String(id ?? "").startsWith("shared"),
      `lcmSearch must NOT prefix with the shared recall namespace; got ${String(id)}`,
    );
  }
});

test("#1505 thread NBHWz (sweep): no readable LCM namespace ⇒ lcmSearch returns EMPTY (no `not readable: default` throw)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: [],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.lcmSearch({
    query: "anything",
    sessionKey: "sess-1",
    authenticatedPrincipal: "alice",
  });
  assert.equal(res.lcmEnabled, true);
  assert.equal(res.count, 0, "no readable LCM namespace ⇒ empty results");
  assert.equal(
    probe.searchSessionIds.length,
    0,
    "searchContextFull must NOT be called when no readable LCM namespace exists",
  );
});

test("#1505 codex P1 (sessionless archive-scan guard): restrictive `default` READ + readable self but NO sessionKey/sessionPrefix ⇒ lcmSearch SUPPRESSES (no unbounded archive scan)", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.lcmSearch({
    query: "what database are we using?",
    authenticatedPrincipal: "alice",
  });

  assert.equal(res.lcmEnabled, true);
  assert.equal(res.count, 0, "sessionless + denied default ⇒ empty results");
  assert.equal(
    probe.searchSessionIds.length,
    0,
    "searchContextFull must NOT run an unbounded archive scan against the denied default store",
  );
});

test("#1505 codex P1 (sessionless regression): namespaces DISABLED (single-store) + no sessionKey ⇒ lcmSearch still scans the archive (byte-for-byte prior behavior)", async () => {
  const probe = makeParityProbe({
    namespacesEnabled: false,
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await service.lcmSearch({ query: "anything" });

  assert.equal(
    probe.searchSessionIds.length,
    1,
    "namespaces disabled + sessionless ⇒ the archive search still runs (byte-for-byte prior behavior)",
  );
  assert.equal(
    probe.searchSessionIds[0],
    undefined,
    "sessionless search passes no session_id filter (archive-wide), unchanged",
  );
});

test("#1505 thread NBHWs regression: restrictive `default` WRITE policy + no overlay (writable self) ⇒ compaction still authorizes the self base, no `not writable: default`", async () => {
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "default", readPrincipals: [], writePrincipals: [] },
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: false, branchScope: false, globalFallback: true },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  await assert.rejects(
    () =>
      service.observe(
        observeRequest({
          sessionKey: "sess-1",
          authenticatedPrincipal: "alice",
        }),
      ),
    /not writable: default/,
    "no-overlay implicit observe must reject on the unwritable default store",
  );
  await assert.rejects(
    () =>
      service.lcmCompactionFlush({
        sessionKey: "sess-1",
        authenticatedPrincipal: "alice",
      }),
    /not writable: default/,
    "compaction must reject identically to observe when the effective write target is the unwritable default store (parity)",
  );
});
