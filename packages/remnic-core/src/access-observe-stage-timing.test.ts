/**
 * Noncontent stage timing for slow/failed observe requests (25s incident).
 * A failed request must record which stage blocked it (phase attribution) in
 * the `access-observe-failed` log line without leaking message content,
 * session keys, namespaces or principals, and must still throw unchanged.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessService, NamespaceNotWritableError } from "./access-service.js";
import { initLogger, resetLogger, type LoggerBackend } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { parseConfig } from "./config.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface OrchestratorInternals {
  config: PluginConfig;
  _codingContextBySession: Map<string, CodingContext>;
}

function makeService(memoryDir: string): EngramAccessService {
  // SAFETY: the probe drives only the observe scope path on this orchestrator.
  const orch = Object.create(Orchestrator.prototype) as Orchestrator;
  // SAFETY: the probe sets exactly these two internal fields.
  const internals = orch as Orchestrator & OrchestratorInternals;
  internals.config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    codingMode: { projectScope: true },
    transcriptEnabled: false,
    memoryDir,
  });
  internals._codingContextBySession = new Map();
  return new EngramAccessService(orch);
}

test("a rejected observe logs phase attribution with stage durations and still throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-observe-timing-"));
  const lines: string[] = [];
  const backend: LoggerBackend = {
    info(msg) {
      lines.push(msg);
    },
    warn(msg) {
      lines.push(msg);
    },
    error(msg) {
      lines.push(msg);
    },
  };
  initLogger(backend, false, { timestamps: false });
  try {
    const service = makeService(dir);
    // SAFETY: the literal sets the request fields the scope path reads.
    const rejectedRequest = {
      sessionKey: "sess-timing-1",
      authenticatedPrincipal: "alice",
      namespace: "victim-secret",
      messages: [
        { role: "user", content: "first secret message body" },
        { role: "assistant", content: "second secret message body" },
      ],
    } as EngramAccessObserveRequest;
    await assert.rejects(
      service.runObserve(rejectedRequest),
      NamespaceNotWritableError
    );

    const failed = lines.filter((l) => l.includes("access-observe-failed"));
    assert.equal(failed.length, 1, `expected exactly one access-observe-failed line, got: ${failed}`);
    const line = failed[0] ?? "";
    // Phase attribution: the blocked stage (scope) plus total and message count.
    assert.match(line, /totalMs=\d+/);
    assert.match(line, /messages=2/);
    assert.match(line, /scopeMs=\d+/);
    // Noncontent: no message bodies, session key, namespace or principal.
    assert.ok(!line.includes("secret"), `leaked content in: ${line}`);
    assert.ok(!line.includes("sess-timing-1"), `leaked session key in: ${line}`);
    assert.ok(!line.includes("victim-secret"), `leaked namespace in: ${line}`);
    assert.ok(!line.includes("alice"), `leaked principal in: ${line}`);
  } finally {
    resetLogger();
    await rm(dir, { recursive: true, force: true });
  }
});

// Plain-object orchestrator for full observe success/failure paths (mirrors
// the access-service-observe-lcm-parity harness).
function makeProbe(options: {
  enqueueObserveMessages: (sessionKey: string, messages: unknown[]) => Promise<void> | void;
}) {
  const config = parseConfig({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
    defaultRecallNamespaces: ["self", "shared"],
    codingMode: { projectScope: true },
    transcriptEnabled: false,
    memoryDir: "/synthetic/remnic-observe-timing",
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
  });
  const contexts = new Map<string, CodingContext>();
  const extractionCalls: string[][] = [];
  // SAFETY: the probe exercises the observe surface; the rest of Orchestrator
  // is unused on this path.
  const orch = {
    config,
    getCodingContextForSession: (sk: string | undefined) => (sk ? contexts.get(sk) : null) ?? null,
    setCodingContextForSession: (sk: string, ctx: CodingContext | null) => {
      if (ctx === null) contexts.delete(sk);
      else contexts.set(sk, ctx);
    },
    applyCodingNamespaceOverlay: (sk: string | undefined, base: string) =>
      Orchestrator.prototype.applyCodingNamespaceOverlay.call(orch, sk, base),
    resolvePrincipal: (sk?: string) => Orchestrator.prototype.resolvePrincipal.call(orch, sk),
    resolveSelfNamespace: (sk?: string) => Orchestrator.prototype.resolveSelfNamespace.call(orch, sk),
    lcmEngine: {
      enabled: true,
      enqueueObserveMessages: options.enqueueObserveMessages,
    },
    ingestReplayBatch: async (turns: Array<{ sessionKey: string }>) => {
      extractionCalls.push(turns.map((t) => t.sessionKey));
    },
  } as any;
  return { orch, extractionCalls };
}

test("a slow successful observe logs access-observe-slow with per-stage durations", async () => {
  const lines: string[] = [];
  const backend: LoggerBackend = {
    info(msg) {
      lines.push(msg);
    },
    warn(msg) {
      lines.push(msg);
    },
    error(msg) {
      lines.push(msg);
    },
  };
  initLogger(backend, false, { timestamps: false });
  // Deterministic monotonic clock: every read advances 6s, so each timed
  // stage records exactly 6000ms and the total exceeds the slow threshold.
  let now = 0;
  const realPerformanceNow = performance.now;
  performance.now = () => (now += 6000);
  try {
    const { orch } = makeProbe({
      enqueueObserveMessages: (_sessionKey) => {},
    });
    const service = new EngramAccessService(orch);
    // SAFETY: the literal sets the request fields the observe path reads.
    const slowRequest = {
      sessionKey: "alice:sess-slow",
      authenticatedPrincipal: "alice",
      messages: [
        { role: "user", content: "slow path message body" },
        { role: "assistant", content: "reply body" },
      ],
    } as EngramAccessObserveRequest;
    const res = await service.observe(slowRequest);
    assert.equal(res.accepted, 2);

    const slow = lines.filter((l) => l.includes("access-observe-slow"));
    assert.equal(slow.length, 1, `expected one access-observe-slow line, got: ${lines}`);
    const line = slow[0] ?? "";
    assert.match(line, /totalMs=(\d+)/);
    const totalMs = Number(/totalMs=(\d+)/.exec(line)?.[1]);
    assert.ok(totalMs >= 10_000, `slow line must exceed threshold, got totalMs=${totalMs}`);
    assert.match(line, /messages=2/);
    // Real stages are attributed, including the durable-buffer terminal stage.
    assert.match(line, /scopeMs=6000/);
    assert.match(line, /durable-bufferMs=6000/);
    assert.ok(!line.includes("sess-slow") && !line.includes("alice") && !line.includes("body"));
  } finally {
    performance.now = realPerformanceNow;
    resetLogger();
  }
});

test("a failed awaited LCM archival records the lcm-accept phase and still throws", async () => {
  const lines: string[] = [];
  const backend: LoggerBackend = {
    info(msg) {
      lines.push(msg);
    },
    warn(msg) {
      lines.push(msg);
    },
    error(msg) {
      lines.push(msg);
    },
  };
  initLogger(backend, false, { timestamps: false });
  try {
    const { orch } = makeProbe({
      enqueueObserveMessages: async () => {
        throw new Error("lcm archival append failed");
      },
    });
    const service = new EngramAccessService(orch);
    // SAFETY: the literal sets the request fields the observe path reads.
    const failedLcmRequest = {
      sessionKey: "alice:sess-lcmfail",
      authenticatedPrincipal: "alice",
      messages: [
        { role: "user", content: "lcm failure message body" },
        { role: "assistant", content: "reply body" },
      ],
    } as EngramAccessObserveRequest;
    await assert.rejects(
      service.observe(failedLcmRequest),
      /lcm archival append failed/
    );

    const failed = lines.filter((l) => l.includes("access-observe-failed"));
    assert.equal(failed.length, 1, `expected exactly one access-observe-failed line, got: ${failed}`);
    const line = failed[0] ?? "";
    assert.match(line, /totalMs=\d+/);
    assert.match(line, /messages=2/);
    // The rejected LCM accept is attributed with its duration, alongside earlier stages.
    assert.match(line, /scopeMs=\d+/);
    assert.match(line, /lcm-acceptMs=\d+/);
    assert.ok(!line.includes("sess-lcmfail"), `leaked session key in: ${line}`);
    assert.ok(!line.includes("alice"), `leaked principal in: ${line}`);
    assert.ok(!line.includes("body"), `leaked content in: ${line}`);
  } finally {
    resetLogger();
  }
});
