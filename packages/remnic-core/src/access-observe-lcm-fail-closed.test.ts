/**
 * LCM archival acceptance is durable and fail-closed.
 *
 * The observe surface used to enqueue archival without waiting: an archive
 * failure was invisible, the response reported the turn as archived, and the
 * client never retried — the lossless copy of the turn was simply gone.
 *
 * These tests pin the contract: a successful observe means the archive
 * accepted the turn, and a failed archive rejects the observe BEFORE
 * extraction starts, so the caller can retry the same turns.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngramAccessService } from "./access-service.js";
import { Orchestrator } from "./orchestrator.js";
import type { EngramAccessObserveRequest } from "./access-service.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface ObserveProbe {
  orch: Orchestrator;
  lcmCalls: Array<{ sessionKey: string }>;
  extractionCalls: Array<{ sessionKeys: string[] }>;
  lcmFailure: Error | null;
}

function makeObserveProbe(memoryDir: string): ObserveProbe {
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
    codingMode: { projectScope: true },
    memoryDir,
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
  } as unknown as PluginConfig;

  const probe: ObserveProbe = {
    orch: null as unknown as Orchestrator,
    lcmCalls,
    extractionCalls,
    lcmFailure: null,
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
    getStorage: async (ns: string) => ({ dir: join(memoryDir, "storage", ns) }),
    lcmEngine: {
      enabled: true,
      enqueueObserveMessages: async (sessionKey: string) => {
        lcmCalls.push({ sessionKey });
        if (probe.lcmFailure) throw probe.lcmFailure;
      },
    },
    ingestReplayBatch: async (turns: Array<{ sessionKey: string }>) => {
      extractionCalls.push({ sessionKeys: turns.map((t) => t.sessionKey) });
    },
  } as unknown as Orchestrator;

  probe.orch = orch;
  return probe;
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

test("observe reports the turn as archived only after the archive accepted it", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-lcm-ok-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);

    const response = await service.observe(observeRequest({}));

    assert.equal(response.lcmArchived, true);
    assert.equal(probe.lcmCalls.length, 1);
    assert.equal(probe.extractionCalls.length, 1);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("observe rejects and starts no extraction when the LCM archive fails", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-lcm-fail-"));
  try {
    const probe = makeObserveProbe(memoryDir);
    probe.lcmFailure = new Error("lcm archive unavailable");
    const service = new EngramAccessService(probe.orch);

    await assert.rejects(
      () => service.observe(observeRequest({})),
      /lcm archive unavailable/,
    );

    assert.equal(probe.lcmCalls.length, 1, "the archive was attempted");
    assert.equal(
      probe.extractionCalls.length,
      0,
      "extraction must not start when the lossless archive rejected the turn",
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
