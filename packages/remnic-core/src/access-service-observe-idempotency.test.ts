/**
 * #1649: a retried observe POST (same `idempotencyKey`) must be deduplicated
 * server-side — the batch is ingested exactly once even when the HTTP response
 * is lost and the client replays the request. Without the key the daemon
 * re-runs every side effect under `skipDedupeCheck: true` and the turn is
 * queued for extraction twice.
 *
 * Verified here against the `EngramAccessService.observe` path with a stub
 * orchestrator that records every namespace-bearing side effect (LCM enqueue +
 * extraction replay), the same probe shape used by the #1495 observe-scope
 * tests. The idempotency store is filesystem-backed, so `memoryDir` is a real
 * temp directory (not the synthetic path the scope tests use, which never touch
 * the store because they omit the key).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { EngramAccessInputError } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface ObserveProbe {
  orch: Orchestrator;
  contexts: Map<string, CodingContext>;
  lcmCalls: Array<{ sessionKey: string }>;
  extractionCalls: Array<{
    sessionKeys: string[];
    writeNamespaceOverride?: string;
    principalOverride?: string;
  }>;
}

function makeObserveProbe(memoryDir: string, projectScope = true): ObserveProbe {
  const contexts = new Map<string, CodingContext>();
  const lcmCalls: ObserveProbe["lcmCalls"] = [];
  const extractionCalls: ObserveProbe["extractionCalls"] = [];

  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      { name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] },
    ],
    codingMode: { projectScope },
    memoryDir,
    // Disable objective-state snapshots so the probe doesn't need a writable
    // storage backend — the idempotency contract under test is LCM + extraction.
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
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
    getStorage: async (ns: string) => ({ dir: join(memoryDir, "storage", ns) }),
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

  return { orch, contexts, lcmCalls, extractionCalls };
}

function observeRequest(
  overrides: Partial<EngramAccessObserveRequest>,
): EngramAccessObserveRequest {
  return {
    sessionKey: "pi-geek:abc123",
    messages: [
      { role: "user", content: "what database are we using?" },
      { role: "assistant", content: "we use postgres for the primary store" },
    ],
    ...overrides,
  } as EngramAccessObserveRequest;
}

test("#1649 a retried observe with the same idempotencyKey is deduplicated to a single ingest", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-idem-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-pi-geek-abc123-#1";

    const first = await service.observe(observeRequest({ idempotencyKey: key }));
    // First attempt is a real ingest.
    assert.equal(first.idempotencyReplay, undefined, "first attempt is not a replay");
    assert.equal(probe.extractionCalls.length, 1, "first attempt ingests once");
    assert.equal(probe.lcmCalls.length, 1, "first attempt archives LCM once");

    // Retry: same key, same payload — the daemon already processed the body, so
    // this is the response-lost-after-process case the issue describes.
    const second = await service.observe(observeRequest({ idempotencyKey: key }));
    assert.equal(second.idempotencyReplay, true, "retry is served from the cache");
    assert.equal(second.accepted, first.accepted, "retry reports the same accepted count");
    assert.equal(
      second.effectiveNamespace,
      first.effectiveNamespace,
      "retry reports the same effective namespace",
    );

    // The defining contract: NO second ingest, NO second LCM archive.
    assert.equal(probe.extractionCalls.length, 1, "retry must not queue extraction a second time");
    assert.equal(probe.lcmCalls.length, 1, "retry must not archive LCM a second time");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#1649 observe without an idempotencyKey is never deduplicated (backward compatible)", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-nokey-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);

    await service.observe(observeRequest({}));
    await service.observe(observeRequest({}));

    assert.equal(probe.extractionCalls.length, 2, "no key ⇒ both calls ingest");
    assert.equal(probe.lcmCalls.length, 2, "no key ⇒ both calls archive LCM");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#1649 reusing an idempotencyKey with a divergent payload is rejected as a conflict", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-conflict-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-pi-geek-abc123-#2";

    await service.observe(observeRequest({ idempotencyKey: key }));

    // Same key, DIFFERENT messages — a stale key must never silently mask a
    // unrelated batch. Same contract as memory_store/suggestion_submit.
    await assert.rejects(
      service.observe(
        observeRequest({
          idempotencyKey: key,
          messages: [
            { role: "user", content: "completely different question" },
            { role: "assistant", content: "completely different answer" },
          ],
        }),
      ),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /idempotencyKey reuse conflict/.test(err.message),
      "divergent payload under a reused key must throw a conflict",
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#1649 review fix: enforceWriteQuota runs only on a cache miss, never on a replay", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-quota-hook-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-pi-geek-abc123-#3";
    let quotaChecks = 0;
    const enforceWriteQuota = () => {
      quotaChecks += 1;
    };

    await service.observe(observeRequest({ idempotencyKey: key }), { enforceWriteQuota });
    assert.equal(quotaChecks, 1, "quota is enforced exactly once on the real ingest");

    const replay = await service.observe(observeRequest({ idempotencyKey: key }), { enforceWriteQuota });
    assert.equal(replay.idempotencyReplay, true, "second call is a replay");
    assert.equal(quotaChecks, 1, "quota is NOT re-checked on a replay (response-lost retry must not 429)");
    assert.equal(probe.extractionCalls.length, 1, "replay did not re-ingest");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#1649 review fix: the same idempotencyKey under a different principal is a conflict, not a silent replay", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-principal-conflict-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-shared-key-#4";

    // Principal alice ingests under the key.
    await service.observe(
      observeRequest({ idempotencyKey: key, authenticatedPrincipal: "alice" }),
    );

    // A different principal reusing the same key + same body must NOT replay
    // alice's cached response — the fingerprint folds in authenticatedPrincipal,
    // so this is a conflict (defends against cross-identity replay when the
    // principal is supplied out-of-band via HTTP/MCP auth).
    await assert.rejects(
      service.observe(
        observeRequest({ idempotencyKey: key, authenticatedPrincipal: "bob" }),
      ),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /idempotencyKey reuse conflict/.test(err.message),
      "cross-principal key reuse must throw a conflict",
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#1649 review fix: rebinding the session's ambient coding context makes the same key a conflict", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-ambient-scope-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-ambient-scope-#5";
    const req = observeRequest({ idempotencyKey: key });

    // No explicit namespace/cwd/projectTag and no ambient context yet — the
    // scope resolves to the default store. This caches the response.
    await service.observe(req);
    assert.equal(probe.extractionCalls.length, 1, "first observe ingests once");

    // The session is now rebound to a coding project by an external caller
    // (e.g. a memory_store with cwd, or a direct setCodingContextForSession).
    // The resolved writeNamespace changed, so reusing the same key + same body
    // must NOT silently replay — it is a conflict.
    probe.contexts.set(req.sessionKey, {
      projectId: "tag:remnic",
      branch: null,
      rootPath: "/projects/remnic",
      defaultBranch: null,
    });

    await assert.rejects(
      service.observe(req),
      (err: unknown) =>
        err instanceof EngramAccessInputError &&
        /idempotencyKey reuse conflict/.test(err.message),
      "key reuse after ambient scope rebind must throw a conflict, not silently replay",
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#2206 project-scope-off ignores ambient coding context in observe idempotency", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-unscoped-replay-"));
  try {
    const probe = makeObserveProbe(memoryDir, false);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-unscoped-replay-#6";
    const req = observeRequest({
      idempotencyKey: key,
      projectTag: "Acme/Webshop",
    });

    const first = await service.observe(req);
    assert.equal(first.effectiveNamespace, "default");
    assert.equal(first.scopeDebug?.codingOverlayApplied, false);
    assert.equal(probe.contexts.size, 0, "disabled project scoping must not attach projectTag context");
    probe.contexts.set(req.sessionKey, {
      projectId: "tag:ignored-while-unscoped",
      branch: "changed-branch",
      rootPath: "/projects/ignored",
      defaultBranch: "main",
    });
    assert.ok(probe.contexts.has(req.sessionKey), "the ambient context change must be injected");

    const replay = await service.observe(req);
    assert.equal(replay.idempotencyReplay, true);
    assert.equal(probe.extractionCalls.length, 1);
    assert.equal(probe.lcmCalls.length, 1);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#1649 review fix: projectTag observe replays correctly despite scope resolution side effects", async () => {
  // The fingerprint folds in the RESOLVED writeNamespace (not the raw ambient
  // context). resolveMemoryScopePlan seeds the session context from projectTag
  // on the first call; the replay reads the SAME seeded context and resolves the
  // SAME writeNamespace. This proves the fingerprint is stable across replays
  // even though the scope resolution mutates session state on the first call.
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-tag-replay-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "observe-batch-tag-replay-#6";
    const req = observeRequest({ idempotencyKey: key, projectTag: "remnic" });

    const first = await service.observe(req);
    assert.equal(first.idempotencyReplay, undefined, "first attempt is a real ingest");

    // The first observe's resolveMemoryScopePlan seeded a coding context for
    // this session. Verify it was actually set (the side effect we depend on).
    assert.ok(
      probe.contexts.get(req.sessionKey),
      "first observe seeded a coding context via resolveMemoryScopePlan",
    );

    // Retry with the same key + same body + same projectTag — the pre-resolved
    // writeNamespace matches because the seeded context produces the same scope.
    const replay = await service.observe(req);
    assert.equal(replay.idempotencyReplay, true, "projectTag observe replays despite scope-resolution side effects");
    assert.equal(probe.extractionCalls.length, 1, "replay did not re-ingest");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
