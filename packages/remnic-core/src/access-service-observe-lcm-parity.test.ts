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

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import {
  combineNamespaces,
  lcmSessionKeyForNamespace,
  projectNamespaceName,
  projectTagProjectId,
} from "./coding/coding-namespace.js";
import { resolveGitContext } from "./coding/git-context.js";
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
  }>;
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

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
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
    lcmEngine: {
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
    },
    // Capture extraction routing/identity so the provenance-principal tests can
    // assert what `observe` threads into `ingestReplayBatch`.
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

  return {
    orch,
    contexts,
    lcmWriteKeys,
    compactionFlushKeys,
    compactionRecordKeys,
    searchSessionIds,
    searchSessionPrefixes,
    extractionCalls,
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

test("#1505 thread 2 helper: write/read encoding agrees and collapses to raw key on the default store", () => {
  // Non-default namespace ⇒ prefixed.
  assert.equal(lcmSessionKeyForNamespace("acme", "sk", "default"), "acme:sk");
  // Default namespace ⇒ raw key (single-store byte-for-byte).
  assert.equal(lcmSessionKeyForNamespace("default", "sk", "default"), "sk");
  // Undefined namespace ⇒ raw key.
  assert.equal(lcmSessionKeyForNamespace(undefined, "sk", "default"), "sk");
  // Empty namespace ⇒ raw key.
  assert.equal(lcmSessionKeyForNamespace("", "sk", "default"), "sk");
  // Missing sessionKey is passed through unchanged (recall's `?? "default"`
  // fallback handles the undefined case downstream).
  assert.equal(lcmSessionKeyForNamespace("acme", undefined, "default"), undefined);
});

test("#1505 thread 2 (c) projectTag: observe LCM write key == recall reader key == compaction keys", async () => {
  const probe = makeParityProbe(withSelfPolicyPrefix("pi-geek"));
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );

  const expectedNs = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Blend/Supply")),
  );
  const expectedKey = `${expectedNs}:pi-geek:abc123`;
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
    const expectedKey = `${expectedNs}:pi-geek:cwd1`;

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
  assert.equal(probe.lcmWriteKeys[0], "team:pi-geek:abc123", "LCM write key");

  // A recall that wants the `team` namespace passes namespace=team; its reader
  // key is built from that override and agrees with the write key.
  assert.equal(
    lcmSessionKeyForNamespace("team", "pi-geek:abc123", "default"),
    "team:pi-geek:abc123",
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
  assert.equal(probe.compactionFlushKeys[0], "team:pi-geek:abc123", "flush key");
  assert.equal(probe.compactionRecordKeys[0], "team:pi-geek:abc123", "record key");
});

test("#1505 thread 2 (d) projectScope:false ⇒ raw sessionKey everywhere (single-user regression guard)", async () => {
  const probe = makeParityProbe({
    ...withSelfPolicyPrefix("pi-geek"),
    codingMode: { projectScope: false },
  } as Partial<PluginConfig>);
  const service = new EngramAccessService(probe.orch);

  const res = await service.observe(
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
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
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
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
      projectTag: "Blend/Supply",
      skipExtraction: false, // exercise the extraction path
    }),
  );

  const expectedNs = combineNamespaces(
    "pi-geek",
    projectNamespaceName(projectTagProjectId("Blend/Supply")),
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
      projectTag: "Blend/Supply",
    }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assert.ok(
    writeKey.startsWith("alice-"),
    `observe must archive under alice's overlay namespace, got ${writeKey}`,
  );

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
    `${withOverride}:sess-1`,
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
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );
  await service.lcmCompactionFlush({ sessionKey: "pi-geek:abc123" });

  const observedWriteKey = probe.lcmWriteKeys[0];
  assert.ok(
    observedWriteKey.startsWith("pi-geek-"),
    `observe must archive under the overlay namespace, got ${observedWriteKey}`,
  );
  assert.equal(
    probe.compactionFlushKeys[0],
    observedWriteKey,
    "compaction flush must target the overlay key, not the base",
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
    observeRequest({ sessionKey: "pi-geek:abc123", projectTag: "Blend/Supply" }),
  );
  const writeKey = probe.lcmWriteKeys[0];
  assert.ok(
    writeKey.startsWith("pi-geek-"),
    `observe must archive under the overlay key, got ${writeKey}`,
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
  // The sessionPrefix is prefixed with the same overlay namespace.
  const overlayNs = writeKey.slice(0, writeKey.length - ":pi-geek:abc123".length);
  assert.equal(
    probe.searchSessionPrefixes[0],
    `${overlayNs}:pi-geek:`,
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
