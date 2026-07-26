/**
 * #1505 thread 2 (P1): LCM read/write/compaction key PARITY.
 *
 * `observe` archives LCM / structured history under
 * `${effectiveNamespace}:${sessionKey}` (the scope-plan write namespace). The
 * LCM archive filters strictly by `session_id`, so a same-session reader and
 * the compaction flush/record path MUST derive the EXACT same key, or a
 * project-scoped session misses its own compressed-history / structured /
 * targeted-fact evidence (and compaction flushes the wrong queue).
 *
 * This suite proves the key the WRITER (`observe`) produces equals:
 *   1. the key the orchestrator recall READERS compute
 *      (`resolveSelfNamespace(sessionKey)` → `lcmSessionKeyForNamespace`), and
 *   2. the key the compaction flush/record path computes.
 * across the scenario matrix:
 *   (a) explicit namespace
 *   (b) auto-scoped via cwd (git repo)
 *   (c) auto-scoped via projectTag
 *   (d) no overlay (projectScope:false / namespacesEnabled:false) — must stay
 *       byte-for-byte the raw sessionKey (single-user regression guard).
 *
 * It also unit-tests the shared `lcmSessionKeyForNamespace` encoder so the
 * write/read contract is pinned at the boundary.
 */
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
import type { EngramAccessObserveRequest } from "./access-service.js";
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

/**
 * Build an orchestrator stub that (a) records the LCM archival key `observe`
 * writes under, (b) records the LCM key the compaction flush/record path
 * targets, and (c) delegates `resolveSelfNamespace` / `resolvePrincipal` /
 * `applyCodingNamespaceOverlay` to the REAL Orchestrator prototype so the
 * reader-side namespace resolution is exercised exactly as production does it.
 */
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
    // Production default. The #1505 round-3 read-authorization gate consults
    // `recallNamespacesForPrincipal`, which reads `defaultRecallNamespaces`;
    // omitting it would throw. Per-test overrides can still narrow it.
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true },
    memoryDir: "/synthetic/remnic-observe-lcm-parity",
    // LCM-only test: keep objective-state off so the storage router is not hit.
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
    // skipExtraction keeps this an LCM-only round-trip.
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

/**
 * Reproduce EXACTLY what `orchestrator.recallInternal` computes for the LCM
 * reader session_id of a same-session bare recall (no explicit namespace
 * override): the coding-overlay namespace when one applies, else the default
 * store (NOT the principal self base — that would prefix a namespace an
 * unqualified observe never wrote to), then encode through the shared helper.
 * This is the same rule as the orchestrator's private
 * `lcmReadNamespaceForSession`.
 */
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

// #1495 P1: reserved structural sentinel framing the namespaced LCM key
// (`\x1f<namespace>\x1f<sessionKey>`). Kept in sync with
// `coding-namespace.ts:LCM_NS_SENTINEL`. U+001F cannot occur in a route
// namespace (`[A-Za-z0-9._-]`) nor any legitimate session key, so the
// namespaced and default key-spaces are provably disjoint and an overlay id is
// unforgeable from a caller-controlled raw default-store sessionKey.
const LCM_NS_SENTINEL = "\u001f";

/**
 * Encode the expected namespaced LCM `session_id` exactly as production does —
 * via the shared `lcmSessionKeyForNamespace` helper — so these parity
 * assertions stay shape-agnostic and never re-hardcode the `:`-join the #1495
 * P1 fix removed (CLAUDE.md rule 22: never fork the encoding).
 */
function encodeNs(namespace: string, sessionKey: string): string {
  return lcmSessionKeyForNamespace(namespace, sessionKey, "default") ?? sessionKey;
}

/**
 * Assert a namespaced LCM write key (new #1495 P1 encoding
 * `\x1f<overlayNs>\x1f<sessionKey>`) was archived under an overlay namespace
 * whose name begins with `overlayPrefix` (e.g. `alice-`, `pi-geek-`). Replaces
 * the pre-#1495 `writeKey.startsWith("<principal>-")`, which no longer holds now
 * that the key is sentinel-framed.
 */
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
  // Non-default namespace ⇒ sentinel-framed, NOT `${ns}:${sessionKey}` (#1495 P1
  // unforgeable encoding).
  assert.equal(
    lcmSessionKeyForNamespace("acme", "sk", "default"),
    `${LCM_NS_SENTINEL}acme${LCM_NS_SENTINEL}sk`,
  );
  // Default namespace ⇒ raw key (single-store byte-for-byte).
  assert.equal(lcmSessionKeyForNamespace("default", "sk", "default"), "sk");
  // Undefined namespace ⇒ raw key.
  assert.equal(lcmSessionKeyForNamespace(undefined, "sk", "default"), "sk");
  // Empty namespace ⇒ raw key.
  assert.equal(lcmSessionKeyForNamespace("", "sk", "default"), "sk");
  // Missing sessionKey is passed through unchanged (recall's `?? "default"`
  // fallback handles the undefined case downstream).
  assert.equal(lcmSessionKeyForNamespace("acme", undefined, "default"), undefined);

  // #1495 P1 UNFORGEABILITY: a default-store raw sessionKey can NEVER reproduce
  // another namespace's encoded id, so a forged default read cannot collide with
  // an overlay write key.
  const overlayKey = lcmSessionKeyForNamespace("acme", "sk", "default");
  // The classic forgery: a default-store caller passing the OLD `${ns}:${sk}`
  // string. Under the new encoding the default path returns it verbatim (it does
  // not start with the sentinel), which is disjoint from the overlay key-space.
  const forgedDefaultKey = lcmSessionKeyForNamespace("default", "acme:sk", "default");
  assert.equal(forgedDefaultKey, "acme:sk");
  assert.notEqual(
    forgedDefaultKey,
    overlayKey,
    "a forged `${ns}:${sk}` default key must NOT equal the overlay encoded id",
  );
  // Even a default sessionKey that itself begins with the sentinel is escaped so
  // it can never equal an overlay key (whose 2nd char is a namespace char).
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

  // WRITE key.
  assert.equal(probe.lcmWriteKeys.length, 1);
  assert.equal(probe.lcmWriteKeys[0], expectedKey, "LCM write key");

  // READ key (observe attached the coding context, so the reader resolves the
  // SAME overlay namespace as the writer).
  assert.equal(
    readerLcmKey(probe, "pi-geek:abc123"),
    expectedKey,
    "recall reader LCM key must equal the observe write key",
  );

  // COMPACTION keys (no explicit namespace ⇒ overlay applied from session ctx).
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
  const deadlineMs = Date.now() + 10_000;
  const abortController = new AbortController();
  probe.lcmEngine.enabled = false;

  const response = await service.extractionForceFlush({
    sessionKey: "pi-geek:force-flush",
    projectTag: "Acme/Webshop",
    deadlineMs,
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
  assert.equal(call.options.extractionDeadlineMs, deadlineMs);
  assert.equal(call.options.failOnExtractionFailure, true);
  assert.equal(call.options.abortSignal, abortController.signal);
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
  probe.orch.ingestReplayBatch = async () => pendingExtraction;
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
  probe.orch.ingestReplayBatch = async (_turns, options = {}) =>
    new Promise<void>((resolve) => {
      pending.set(options.principalOverride ?? "", resolve);
    });
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
    deadlineMs: Date.now() + 500,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  pending.get("alice")?.();
  assert.equal((await aliceFlush).flushed, true);

  const bobFlush = service.extractionForceFlush({
    sessionKey,
    namespace: "team",
    authenticatedPrincipal: "bob",
    deadlineMs: Date.now() + 500,
  });
  pending.get("bob")?.();
  assert.equal((await bobFlush).flushed, true);
});

test("#2128: chained observes remain behind one force-flush barrier", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  const resolvers: Array<() => void> = [];
  probe.orch.ingestReplayBatch = async () =>
    new Promise<void>((resolve) => {
      resolvers.push(resolve);
    });
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "chained-observes";

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  const flushPromise = service.extractionForceFlush({ sessionKey, deadlineMs: Date.now() + 500 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  assert.equal(resolvers.length, 2);

  let settled = false;
  void flushPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  resolvers[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolvers[1]?.();
  assert.equal((await flushPromise).flushed, true);
});

test("#2128: a failed observe extraction is consumed after force-flush reports it", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  let rejectExtraction!: (error: Error) => void;
  let extractionAttempt = 0;
  probe.orch.ingestReplayBatch = async () => {
    extractionAttempt += 1;
    if (extractionAttempt > 1) return;
    return new Promise<void>((_resolve, reject) => {
      rejectExtraction = reject;
    });
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "failed-observe-extraction";
  const failure = new Error("provider failed");

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  rejectExtraction(failure);
  await assert.rejects(
    service.extractionForceFlush({ sessionKey }),
    (error: unknown) => error === failure,
  );

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  await assert.doesNotReject(() => service.extractionForceFlush({ sessionKey }));
});

test("#2128: force-flush deadline cancels the pending observe extraction", async () => {
  const probe = makeParityProbe({ namespacesEnabled: false } as Partial<PluginConfig>);
  let extractionSignal: AbortSignal | undefined;
  probe.orch.ingestReplayBatch = async (_turns, options = {}) => {
    extractionSignal = options.abortSignal;
    return new Promise<void>((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => reject(new Error("extraction cancelled")),
        { once: true },
      );
    });
  };
  const service = new EngramAccessService(probe.orch);
  const sessionKey = "deadline-cancelled-extraction";

  await service.observe(observeRequest({ sessionKey, skipExtraction: false }));
  const keepAlive = setInterval(() => {}, 5);
  try {
    await assert.rejects(
      service.extractionForceFlush({
        sessionKey,
        deadlineMs: Date.now() + 25,
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
    return new Promise<void>((_resolve, reject) => {
      options.abortSignal?.addEventListener(
        "abort",
        () => reject(new Error("extraction cancelled")),
        { once: true },
      );
    });
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
    return new Promise<void>((resolve, reject) => {
      extractionResolvers.set(namespace, resolve);
      options.abortSignal?.addEventListener(
        "abort",
        () => reject(options.abortSignal?.reason ?? new Error("extraction cancelled")),
        { once: true },
      );
    });
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
  const deadlineMs = Date.now() + 10_000;

  const response = await service.extractionForceFlush({
    sessionKey: "pi-geek:cleanup-best-effort",
    authenticatedPrincipal: "pi-geek",
    abortSignal: abortController.signal,
    deadlineMs,
  });

  assert.equal(response.flushed, true);
  assert.deepEqual(cleanupCalls, [{
    sessionKey: "pi-geek:cleanup-best-effort",
    ownerPrincipal: "pi-geek",
    options: { abortSignal: abortController.signal, deadlineMs },
  }]);
});

test("#2128: post-flush retained cleanup stops on abort or deadline", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  (probe.orch as unknown as {
    buffer: {
      clearRetainedTurnsForSession(
        sessionKey: string,
        ownerPrincipal?: string,
        options?: { abortSignal?: AbortSignal; deadlineMs?: number },
      ): Promise<void>;
    };
  }).buffer = {
    clearRetainedTurnsForSession: async () => new Promise<void>(() => {}),
  };
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

  await assert.rejects(
    () =>
      Promise.race([
        service.extractionForceFlush({
          sessionKey: "pi-geek:cleanup-deadline",
          authenticatedPrincipal: "pi-geek",
          deadlineMs: Date.now() + 5,
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("deadline cleanup test timed out")), 100),
        ),
      ]),
    /replay extraction deadline exceeded \(retained_turn_cleanup\)/,
  );
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
  await assert.rejects(
    () =>
      service.extractionForceFlush({
        sessionKey: "pi-geek:expired-flush",
        authenticatedPrincipal: "pi-geek",
        deadlineMs: Date.now() - 1,
      }),
    (error: unknown) =>
      error instanceof EngramAccessInputError &&
      error.message === "extraction force-flush deadline exceeded before buffer drain",
  );
  assert.equal(probe.extractionForceFlushCalls.length, 0);
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
        deadlineMs: Date.now() + 10_000,
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

  // A recall that wants the `team` namespace passes namespace=team; its reader
  // key is built from that override and agrees with the write key.
  assert.equal(
    lcmSessionKeyForNamespace("team", "pi-geek:abc123", "default"),
    encodeNs("team", "pi-geek:abc123"),
    "explicit-namespace recall reader key matches the write key",
  );

  // Compaction with the same explicit namespace agrees.
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
  // No overlay ⇒ effective namespace is the default store ⇒ raw key.
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

  // Defensive: even without a defaultNamespaceForPrincipal policy, the base is
  // the default store when namespaces are disabled.
  assert.equal(
    defaultNamespaceForPrincipal("pi-geek", probe.orch.config),
    "default",
  );
});

test("#1505 thread 1: extraction provenance principal is the resolved principal (NOT default) for a project-scoped observe with an encoded-principal key", async () => {
  // Identity-vs-routing separation. A project-scoped observe prefixes the LCM
  // key with the overlay namespace (`pi-geek-project-...:pi-geek:abc123`). Before
  // this fix, that prefixed key was ALSO fed to extraction as the turn
  // sessionKey, so `resolvePrincipal` parsed `pi-geek-project-...` → no prefix
  // rule match → `default`, mis-attributing provenance. The fix passes the
  // ORIGINAL sessionKey (identity) plus principalOverride (the resolved
  // principal) and writeNamespaceOverride (routing).
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
  // Provenance identity: the resolved principal, never a default parsed from the
  // prefixed key.
  assert.equal(
    probe.extractionCalls[0].principalOverride,
    "pi-geek",
    "provenance principal must be the resolved principal, not default",
  );
  // The extraction turns carry the ORIGINAL session key (identity / threading).
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
    "extraction turns must carry the ORIGINAL un-prefixed session key",
  );
  // Storage routing is pinned to the effective overlay namespace.
  assert.equal(probe.extractionCalls[0].writeNamespaceOverride, expectedNs);
});

test("#1505 thread 1: provenance principal honors authenticatedPrincipal not encoded in the session key", async () => {
  // alice authenticates at the transport layer but the raw sessionKey ("sess-1")
  // encodes no principal. The scope plan resolves principal=alice (auth
  // precedence), so extraction provenance must be pinned to alice — independent
  // of what `resolvePrincipal("sess-1")` would parse (default).
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
  // alice authenticates at the transport layer but is NOT encoded in the raw
  // sessionKey ("sess-1"). With a PROJECT overlay, observe archives LCM under
  // `combineNamespaces("alice", project):sess-1`. A same-session recall that
  // supplies the SAME authenticated principal (principalOverride) must derive the
  // base = alice so the overlay namespace — and thus the LCM read key — matches
  // the write. Without the override, `lcmReadNamespaceForSession` derives the
  // base from `resolvePrincipal("sess-1")` → default, so the overlay would be
  // `combineNamespaces("default", project)` and the reader would MISS alice's
  // evidence (the thread-2 bug).
  // makeParityProbe defaults codingMode to { projectScope: true }; alice is NOT
  // encoded in any prefix rule, so resolvePrincipal("sess-1") → default.
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // WRITE: alice observes sess-1 with a project tag → overlay applies on alice's
  // self base. (No explicit namespace.)
  await service.observe(
    observeRequest({
      sessionKey: "sess-1",
      authenticatedPrincipal: "alice",
      projectTag: "Acme/Webshop",
    }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "alice-"); // observe must archive under alice's overlay namespace, got ${writeKey}

  // The orchestrator's real lcmReadNamespaceForSession (the stub delegates
  // resolvePrincipal/overlay to the prototype).
  const lcmReadNamespaceForSession = Orchestrator.prototype[
    "lcmReadNamespaceForSession" as keyof Orchestrator
  ] as unknown as (
    this: Orchestrator,
    sk?: string,
    principalOverride?: string,
  ) => string;

  // Without the override, the base derives from resolvePrincipal("sess-1") →
  // default, so the read namespace is the DEFAULT-based overlay (the bug).
  const withoutOverride = lcmReadNamespaceForSession.call(probe.orch, "sess-1");
  assert.ok(
    !withoutOverride.startsWith("alice-"),
    `without override the read base must NOT be alice (demonstrates the bug), got ${withoutOverride}`,
  );

  // With the authenticated principal override, the read base is alice → the read
  // namespace matches the write namespace, so the read key matches the write key.
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
  // Before the fix, compaction flush/record built `${resolveWritableNamespace(
  // request.namespace)}:${sessionKey}` which, with NO explicit namespace, is
  // the BASE (config.defaultNamespace) — never the coding overlay. So an
  // auto-scoped session flushed `pi-geek:abc123` (no overlay) while observe
  // archived under `pi-geek-project-...:pi-geek:abc123`. This pins that they
  // now agree.
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
  // cursor "LCM search misses overlay keys" / codex "Route access LCM search
  // through the scoped key". A project-scoped observe (no explicit namespace)
  // archives under `${overlayNs}:${sessionKey}` and binds the coding context to
  // the session. A subsequent lcmSearch({ sessionKey }) with NO explicit
  // namespace must search under the SAME overlay key — not the raw sessionKey —
  // or it misses the turns just archived.
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  // New #1495 P1 encoding: `\x1f<overlayNs>\x1f<sessionKey>`. Parse the overlay
  // namespace out of the sentinel frame (the namespace is `\x1f`-free).
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
  // The sessionPrefix is framed with the same overlay namespace (so it stays a
  // valid LIKE-prefix of the overlay full keys).
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
  // codex "Pin default-store extraction writes too". An unqualified observe by a
  // principal that HAS a self namespace resolves writeNamespace ==
  // config.defaultNamespace (general path) but, left unpinned, runExtraction
  // would fall back to defaultNamespaceForPrincipal(principal) == the SELF
  // namespace — diverging from LCM/objective-state/response. With namespaces
  // enabled, observe must pin writeNamespaceOverride = writeNamespace (= default)
  // so every side effect lands in ONE namespace.
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    // No overlay so writeNamespace collapses to config.defaultNamespace.
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
  // Identity is still the original key + resolved principal.
  assert.deepEqual(
    new Set(probe.extractionCalls[0].sessionKeys),
    new Set(["pi-geek:abc123"]),
  );
  assert.equal(probe.extractionCalls[0].principalOverride, "pi-geek");
});

// ──────────────────────────────────────────────────────────────────────────
// #1505 round 3 (codex P2): READ-AUTHORIZATION gating of the overlay LCM read
// key. The round-2 parity fix made LCM READS always substitute the principal
// self-overlay namespace. That bypassed the read-authorization / readable-
// recall-namespace gating the rest of recall honors, so a principal who can
// WRITE but NOT READ its self namespace (or whose `defaultRecallNamespaces`
// omits `self`) would have `<principal>-project-*` overlay rows injected into
// recall / returned by `lcmSearch` even though QMD/file recall excludes them
// (cross-tenant read leak). Both sites must gate the overlay substitution by
// the readable recall namespace set (rule 42 read/write parity; rule 48
// least-privilege).
// ──────────────────────────────────────────────────────────────────────────

test("#1505 round 3 thread 1: orchestrator LCM read key falls back to default when the principal can WRITE but not READ its self namespace", async () => {
  // alice may WRITE her self namespace but NOT read it (readPrincipals omits
  // alice). A project-scoped observe archives LCM under
  // `alice-project-*:sess-1`, but a no-namespace recall by alice may NOT inject
  // those overlay rows — QMD/file recall would exclude `alice` (unreadable), so
  // the LCM read key MUST collapse to the default store too.
  const probe = makeParityProbe({
    namespacePolicies: [
      // WRITE-only self policy: alice can write `alice` but cannot read it.
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);

  // Bind a coding context to sess-1 so the overlay would apply on alice's base.
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

  // With the authenticated principal = alice (NOT encoded in sess-1), the
  // overlay base is `alice`. alice cannot READ `alice`, so the read namespace
  // MUST fall back to the default store (NOT `alice-project-*`).
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
  // alice CAN read her self namespace, but `defaultRecallNamespaces` omits
  // `self`, so QMD/file recall never includes `alice` for a no-namespace
  // recall. The overlay LCM read key must mirror that exclusion.
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    // Self deliberately omitted from the recall set.
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
  // pi-geek can read AND write its self namespace, and `self` is in the recall
  // set, so the overlay LCM read key must STILL be the project-scoped overlay
  // (the round-2 parity behavior must stay green).
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
  // alice authenticates and passes the `default` read check, but her policy does
  // NOT permit reading her self/overlay base (readPrincipals omits alice). A
  // coding context is bound to the session, so the overlay WOULD apply — but the
  // read-authorization gate must keep the just-authorized (default) namespace,
  // so lcmSearch queries the RAW sessionKey, NOT `alice-project-*`.
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
  // The prefix must NOT carry the overlay namespace either.
  assert.ok(
    !String(probe.searchSessionPrefixes[0] ?? "").includes("alice-"),
    `lcmSearch sessionPrefix must NOT carry the alice overlay namespace; got ${String(
      probe.searchSessionPrefixes[0],
    )}`,
  );
});

test("#1505 round 4 thread (codex P2): compaction flush/record target the OVERLAY key even when the principal can WRITE but not READ its self base", async () => {
  // The round-3 read-authorization gate is SHARED by lcmCompactionFlush/Record,
  // but compaction is a WRITE/maintenance op on the queue observe just wrote.
  // alice can WRITE her self namespace but NOT read it. observe archives under
  // `alice-project-*:sess-1`; compaction must flush/record that SAME overlay key
  // (gated by WRITE authorization), NOT fall back to the default/raw key — else
  // the project-scoped LCM queue is never flushed/recorded.
  const probe = makeParityProbe({
    namespacePolicies: [
      // Write-only self policy: alice can write `alice` but cannot read it.
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    // self deliberately omitted from the recall set too — read gate would fall
    // back, but the WRITE gate must still honour the overlay.
    defaultRecallNamespaces: ["shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // WRITE: alice observes sess-1 with a project tag → overlay applies on alice's
  // write-authorized self base.
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
  // Companion to the compaction-write-gate test: the SAME write-only, read-denied
  // principal must STILL get the authorized fallback (raw key) on lcmSearch — the
  // read gate and the write gate diverge by design.
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
  // alice can read AND write her self namespace, so the authorized overlay LCM
  // read key is honored — lcmSearch routes the session_id through the overlay.
  const probe = makeParityProbe({
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // Archive under alice's overlay (binds the coding context to the session).
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
  // The root defect: `lcmCompactionFlush`/`Record` PRE-authorized
  // `undefined ⇒ config.defaultNamespace` via `resolveWritableNamespace` BEFORE
  // the scoped write key was computed. Under a deployment whose `default`
  // namespace has a RESTRICTIVE write policy (alice may NOT write `default`) but
  // where alice CAN write her self/project overlay, `observe({ projectTag })`
  // succeeds and archives LCM under `alice-project-*:sess-1` — yet compaction
  // threw `namespace is not writable: default`, so the queue observe just wrote
  // could never be flushed or recorded.
  //
  // FAIL-BEFORE: both compaction calls throw `namespace is not writable:
  // default`. PASS-AFTER: compaction derives the namespace through the SAME
  // write-scoped plan/gate observe uses (`resolveMemoryScopePlan`), authorizes
  // the writable self base, and flushes/records the overlay key.
  const probe = makeParityProbe({
    namespacePolicies: [
      // RESTRICTIVE default: NO principal may write (or read) `default`.
      { name: "default", readPrincipals: [], writePrincipals: [] },
      // alice CAN write (and read) her self namespace.
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // observe succeeds under alice's writable self/project overlay even though
  // `default` is not writable.
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

  // Compaction must NOT throw `not writable: default` and must target the
  // overlay queue observe wrote.
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
  // Convergence sweep: `lcmSearch` is the SAME defect class as the raw-excerpt
  // path — it pre-authorized `undefined ⇒ config.defaultNamespace` via
  // `resolveReadableNamespace` BEFORE deriving the scoped read namespace. Under a
  // restrictive `default` READ policy where pi-geek's self namespace IS readable,
  // normal recall succeeds via `recallNamespacesForPrincipal`, so `lcmSearch`
  // must too. FAIL-BEFORE: throws `namespace is not readable: default`.
  // PASS-AFTER: routes through the readable self overlay.
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

  // observe archives under pi-geek's readable+writable project overlay.
  await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Acme/Webshop" }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assertOverlayWriteKey(writeKey, "pi-geek-"); // observe must archive under pi-geek's overlay key, got ${writeKey}

  // lcmSearch with NO explicit namespace must NOT throw `not readable: default`
  // and must route the session_id through the readable overlay key.
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
  // codex P1 on the round-7 head: my first NBHWz fix treated ANY readable recall
  // namespace (e.g. `shared`) as license to read the DEFAULT LCM store. But the
  // implicit LCM read can ONLY target the coding overlay (when the SELF base is
  // readable-in-recall) or the default store — never `shared`. So when the self
  // base is NOT readable-in-recall AND `default` is denied, there is NO
  // authorized LCM target: lcmSearch must SUPPRESS (empty), NOT fall back to the
  // denied default store (which, sessionless, would scan the whole archive).
  //
  // alice can WRITE her self base (so observe archives under the overlay) but
  // CANNOT read it; `self` is omitted from the recall set; only `shared` is
  // readable; `default` is restrictively unreadable.
  const probe = makeParityProbe({
    namespacePolicies: [
      // Restrictive default: alice may NOT read `default`.
      { name: "default", readPrincipals: [], writePrincipals: [] },
      // alice can WRITE but NOT read her self base.
      { name: "alice", readPrincipals: [], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    // `shared` is readable + in the recall set; `self` is omitted.
    defaultRecallNamespaces: ["shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // Bind a coding context so the overlay WOULD apply on alice's base.
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
  // SUPPRESS: self unreadable-in-recall AND default denied ⇒ no authorized LCM
  // target. `searchContextFull` must NEVER run — not against the denied default
  // store (raw key), not against `shared`, not against alice's unreadable
  // overlay.
  assert.equal(
    probe.searchSessionIds.length,
    0,
    "lcmSearch must SUPPRESS (no searchContextFull) — never read the denied default store via a `shared`-only authorization",
  );
});

test("#1505 cursor 'LCM read gate wrong fallback' (positive): self READABLE-in-recall but overlay-self gate denies ⇒ lcmSearch uses the raw sessionKey (default store), never `shared:`", async () => {
  // The complementary case to the codex P1 suppress: when the principal self base
  // IS readable-in-recall (so PROCEED is authorized) but `default` is restrictively
  // unreadable, the implicit LCM read still collapses to the DEFAULT STORE raw key
  // for a session whose overlay does not apply — EXACTLY like the orchestrator's
  // `lcmReadNamespaceForSession` — and NEVER an arbitrary readable recall namespace
  // (e.g. `shared`). Here NO coding context is bound, so no overlay applies and the
  // key is the raw sessionKey.
  const probe = makeParityProbe({
    namespacePolicies: [
      // Restrictive default: alice may NOT read `default`.
      { name: "default", readPrincipals: [], writePrincipals: [] },
      // alice CAN read AND write her self base.
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    // self IS readable + in the recall set, so PROCEED is authorized.
    defaultRecallNamespaces: ["self", "shared"],
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  // No coding context bound ⇒ no overlay ⇒ the LCM key is the raw sessionKey.
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
  // Companion: when NO readable LCM namespace exists for an implicit lcmSearch
  // (restrictive default READ + unreadable self + self omitted from the recall
  // set), the search returns EMPTY rather than throwing — `searchContextFull` is
  // never called.
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
  // codex P1 defense-in-depth: a sessionless, prefixless `lcmSearch` issues
  // `searchContextFull(query, limit, undefined, undefined)`, scanning the ENTIRE
  // LCM archive across every session/namespace. Under a restrictive `default`
  // READ policy (alice cannot read `default`), that scan exposes the denied
  // default store's rows. Even though alice's SELF base is readable (so the
  // implicit fallback PROCEEDs), with NO sessionKey the overlay cannot apply and
  // the read collapses to the default store — so the sessionless scan must be
  // SUPPRESSED.
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

  // NO sessionKey, NO sessionPrefix → would otherwise scan the whole archive.
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
  // Regression guard: in a single-store deployment (namespaces disabled, default
  // always readable), a sessionless `lcmSearch` keeps its prior unbounded
  // behavior — the P1 guard only fires when the principal cannot read the default
  // store (i.e. namespaces enabled + a restrictive default policy / unauthenticated
  // caller).
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
  // Companion: even with projectScope OFF (no overlay), an implicit observe by a
  // principal that can write its self base archives under the default store ONLY
  // when objective-state writes are off; with objective-state writes enabled the
  // scope plan authorizes the self base. Here we keep objective-state off (the
  // probe default) and projectScope off, so the write namespace collapses to the
  // default store — but `default` is NOT writable. The scope plan's no-overlay
  // branch still collapses to `config.defaultNamespace` via
  // `resolveWritableNamespace(undefined)`, which DOES throw when default is
  // unwritable — matching observe EXACTLY (if observe can't write, there is no
  // queue to flush). This pins that compaction and observe agree on the throw.
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

  // No overlay ⇒ implicit write collapses to the (unwritable) default store, so
  // observe itself rejects. Compaction must reject identically (parity), NOT
  // succeed against a phantom queue.
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
