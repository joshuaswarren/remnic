/**
 * #3251 acceptance boundary at the access-service surface: the 202
 * acknowledges a DURABLE capture. A capture failure must reject the request
 * (never 202) and must NOT commit the idempotency success reservation, so a
 * client retry with the same key re-executes instead of replaying a success
 * that never happened. Durability itself is proven against the real buffer in
 * access-observe-replay-durability.test.ts; this file pins the HTTP-facing
 * accept/reject semantics with the house observe-probe harness.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EngramAccessService, type EngramAccessObserveRequest } from "./access-service.js";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { CodingContext, PluginConfig } from "./types.js";

interface BoundaryProbeIngestBehavior {
  failNext: Error | null;
  queued?: (onExtractionQueued: (extraction: Promise<void>) => void) => void;
  calls: Array<{ sessionKeys: Array<string | undefined>; extractionMode?: string }>;
}

interface BoundaryProbe {
  orch: Orchestrator;
  ingestBehavior: BoundaryProbeIngestBehavior;
}

function makeBoundaryProbe(memoryDir: string): BoundaryProbe {
  const contexts = new Map<string, CodingContext>();
  const ingestBehavior: BoundaryProbeIngestBehavior = {
    failNext: null,
    queued: undefined,
    calls: [],
  };
  const config = parseConfig({
    memoryDir,
    transcriptEnabled: false,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [{ name: "pi-geek", readPrincipals: ["pi-geek"], writePrincipals: ["pi-geek"] }],
    codingMode: { projectScope: true },
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "pi-geek:", principal: "pi-geek" }],
    recallCrossNamespaceBudgetEnabled: false,
  });
  // SAFETY: the probe exercises observe + force-flush with these exact members
  // (scope resolution, coding context, LCM off-switch, replay capture); the
  // rest of Orchestrator is unused on this surface.
  const orch = {
    config,
    getCodingContextForSession: (sessionKey: string | undefined) =>
      (sessionKey ? contexts.get(sessionKey) : null) ?? null,
    setCodingContextForSession: (sessionKey: string, ctx: CodingContext | null) => {
      if (ctx === null) contexts.delete(sessionKey);
      else contexts.set(sessionKey, ctx);
    },
    applyCodingNamespaceOverlay: (sessionKey: string | undefined, base: string) =>
      Orchestrator.prototype.applyCodingNamespaceOverlay.call(orch, sessionKey, base),
    getStorage: async (namespace: string) => ({ dir: join(memoryDir, "storage", namespace) }),
    lcmEngine: {
      enabled: true,
      enqueueObserveMessages: () => {},
    },
    ingestReplayBatch: async (
      turns: Array<{ sessionKey: string }>,
      options: {
        extractionMode?: string;
        onExtractionQueued?: (extraction: Promise<void>) => void;
      } = {},
    ) => {
      if (ingestBehavior.failNext) {
        const err = ingestBehavior.failNext;
        ingestBehavior.failNext = null;
        throw err;
      }
      ingestBehavior.calls.push({
        sessionKeys: turns.map((turn) => turn.sessionKey),
        extractionMode: options.extractionMode,
      });
      ingestBehavior.queued?.((extraction) => options.onExtractionQueued?.(extraction));
    },
  };
  // SAFETY: the probe exercises only the observe/force-flush surface used here.
  const probeOrch = orch as any;
  return { orch: probeOrch, ingestBehavior };
}

function observeRequest(overrides: Partial<EngramAccessObserveRequest>): EngramAccessObserveRequest {
  // SAFETY: observeRequest builds a minimal valid request; the full schema
  // is enforced by the service at runtime.
  return {
    sessionKey: "pi-geek:abc123",
    messages: [{ role: "user", content: "the release train slips to friday" }],
    ...overrides,
  } as EngramAccessObserveRequest;
}

test("#3251 a failed durable capture rejects the observe and never commits idempotency success", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-accept-"));
  try {
    const probe = makeBoundaryProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const key = "accept-boundary-pi-geek-#1";

    probe.ingestBehavior.failNext = new Error("simulated durable capture failure");
    await assert.rejects(
      service.observe(observeRequest({ idempotencyKey: key })),
      /simulated durable capture failure/,
    );
    assert.equal(probe.ingestBehavior.calls.length, 0, "failed capture ingested nothing");

    // Retry with the SAME key must re-execute: no success reservation exists.
    const second = await service.observe(observeRequest({ idempotencyKey: key }));
    assert.equal(second.idempotencyReplay, undefined, "retry after failure is a fresh write, not a replay");
    assert.equal(probe.ingestBehavior.calls.length, 1, "retry executes the capture exactly once");
    assert.equal(probe.ingestBehavior.calls[0]?.extractionMode, "buffered");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("#3251 every trigger-queued extraction is tracked: a rejected one surfaces to force-flush, none crash", async () => {
  const memoryDir = mkdtempSync(join(tmpdir(), "remnic-observe-multi-"));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: Error): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const probe = makeBoundaryProbe(memoryDir);
    const service = new EngramAccessService(probe.orch);
    const first = Promise.reject(new Error("first queued extraction failed"));
    first.catch(() => {});
    const second = Promise.withResolvers<void>();
    probe.ingestBehavior.queued = (onExtractionQueued) => {
      onExtractionQueued(first);
      onExtractionQueued(second.promise);
    };

    await service.observe(observeRequest({}));

    // BOTH promises must be tracked (never last-write-wins): a scoped
    // force-flush wait surfaces the FIRST rejection once the still-pending
    // one settles. With the last-write-wins bug only `second` was tracked
    // and the flush resolved cleanly.
    second.resolve();
    await assert.rejects(
      service.extractionForceFlush({
        sessionKey: "pi-geek:abc123",
        authenticatedPrincipal: "pi-geek",
        deadlineMs: 5000,
      }),
      /first queued extraction failed/,
    );
    assert.deepEqual(
      unhandled.filter((reason) => reason instanceof Error && /first queued extraction failed/.test(reason.message)),
      [],
      "tracked rejections must be handled, never crash the process",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
