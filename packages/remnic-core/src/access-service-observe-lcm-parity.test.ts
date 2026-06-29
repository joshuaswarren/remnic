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
    },
    // No extraction side effects needed for LCM parity — skipExtraction below.
    ingestReplayBatch: async () => {},
  } as unknown as Orchestrator;

  return {
    orch,
    contexts,
    lcmWriteKeys,
    compactionFlushKeys,
    compactionRecordKeys,
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
