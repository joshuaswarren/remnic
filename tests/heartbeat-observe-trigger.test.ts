import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Orchestrator } from "@remnic/core/orchestrator";
import { TurnIngestionCoordinator } from "../packages/remnic-core/src/orchestration/turn-ingestion.js";
import { ExtractionRunCoordinator } from "../packages/remnic-core/src/orchestration/extraction-run.ts";
import type { BufferTurn } from "@remnic/core/types";

test("observeSessionHeartbeat queues buffered extraction when observer threshold triggers", async () => {
  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "Need a continuity check on this thread state.",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
    },
  ];

  let queued = false;
  let queuedReason: string | null = null;

  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => ({
        triggered: true,
        deltaBytes: 6_500,
        deltaTokens: 1_500,
        band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      }),
    },
    buffer: {
      getTurns: () => turns,
    },
    shouldQueueExtraction: () => true,
    queueBufferedExtraction: async (_turns: BufferTurn[], reason: string) => {
      queued = true;
      queuedReason = reason;
    },
  };

  await new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
  );

  assert.equal(queued, true);
  assert.equal(queuedReason, "heartbeat_observer");
});

test("observeSessionHeartbeat uses an explicit logical buffer key when provided", async () => {
  const rawTurns: BufferTurn[] = [];
  const logicalTurns: BufferTurn[] = [
    {
      role: "user",
      content: "Codex logical buffer turn.",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
    },
  ];

  let queuedBufferKey: string | null = null;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => ({
        triggered: true,
        deltaBytes: 6_500,
        deltaTokens: 1_500,
        band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      }),
    },
    buffer: {
      getTurns: (bufferKey: string) =>
        bufferKey === "codex-thread:thread-123"
          ? logicalTurns
          : rawTurns,
    },
    shouldQueueExtraction: (_turns: BufferTurn[], options?: { bufferKey?: string }) =>
      options?.bufferKey === "codex-thread:thread-123",
    queueBufferedExtraction: async (
      _turns: BufferTurn[],
      _reason: string,
      options?: { bufferKey?: string },
    ) => {
      queuedBufferKey = options?.bufferKey ?? null;
    },
  };

  await new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
    { bufferKey: "codex-thread:thread-123" },
  );

  assert.equal(queuedBufferKey, "codex-thread:thread-123");
});

test("observeSessionHeartbeat no-ops when observer is disabled", async () => {
  let invoked = false;
  const fake = {
    config: { sessionObserverEnabled: false },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => {
        invoked = true;
        return { bytes: 0, tokens: 0 };
      },
    },
    sessionObserver: {
      observe: async () => {
        invoked = true;
        return { triggered: false, deltaBytes: 0, deltaTokens: 0, band: { maxBytes: 1, triggerDeltaBytes: 1, triggerDeltaTokens: 1 } };
      },
    },
    buffer: { getTurns: () => [] },
    queueBufferedExtraction: async () => {
      invoked = true;
    },
  };

  await new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
  );

  assert.equal(invoked, false);
});

test("observeSessionHeartbeat skips when buffer contains mixed session turns", async () => {
  let queued = false;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => ({
        triggered: true,
        deltaBytes: 6_500,
        deltaTokens: 1_500,
        band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      }),
    },
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "session A",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
        },
        {
          role: "assistant",
          content: "session B",
          timestamp: "2026-02-25T00:00:01.000Z",
          sessionKey: "agent:research:main",
        },
      ],
    },
    queueBufferedExtraction: async () => {
      queued = true;
    },
  };

  await new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
  );

  assert.equal(queued, false);
});

test("observeSessionHeartbeat allows shared Codex logical buffers with mixed session turns", async () => {
  let queued = false;
  let queuedBufferKey: string | null = null;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => ({
        triggered: true,
        deltaBytes: 6_500,
        deltaTokens: 1_500,
        band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
      }),
    },
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "session A",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
        },
        {
          role: "assistant",
          content: "session B",
          timestamp: "2026-02-25T00:00:01.000Z",
          sessionKey: "agent:research:main",
        },
      ],
    },
    shouldQueueExtraction: () => true,
    queueBufferedExtraction: async (
      _turns: BufferTurn[],
      _reason: string,
      options?: { bufferKey?: string },
    ) => {
      queued = true;
      queuedBufferKey = options?.bufferKey ?? null;
    },
  };

  await new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
    { bufferKey: "codex-thread:thread-shared-1" },
  );

  assert.equal(queued, true);
  assert.equal(queuedBufferKey, "codex-thread:thread-shared-1");
});

test("queueBufferedExtraction preserves buffered turns when dedupe skips enqueue", async () => {
  let cleared = false;
  let queued = false;
  const fake = {
    shouldQueueExtraction: () => false,
    buffer: {
      clearAfterExtraction: async () => {
        cleared = true;
      },
    },
    extractionQueue: {
      push: () => {
        queued = true;
      },
    },
  };

  await new TurnIngestionCoordinator(fake as any).queueBufferedExtraction([{ role: "user", content: "dup", timestamp: "2026-02-25T00:00:00.000Z" }],
    "heartbeat_observer",
  );

  assert.equal(queued, false);
  assert.equal(cleared, false);
});

test("observeSessionHeartbeat serializes per-session observer runs", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 10_000, tokens: 2_000 }),
    },
    sessionObserver: {
      observe: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          triggered: false,
          deltaBytes: 0,
          deltaTokens: 0,
          band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
        };
      },
    },
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "serialized observer",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
        },
      ],
    },
    shouldQueueExtraction: () => true,
    queueBufferedExtraction: async () => {},
  };

  await Promise.all([
    new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
    ),
    new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
    ),
  ]);

  assert.equal(maxInFlight, 1);
});

test("observeSessionHeartbeat skips observer state update when extraction dedupe would reject", async () => {
  let observed = false;
  let queued = false;
  const fake = {
    config: { sessionObserverEnabled: true },
    heartbeatObserverChains: new Map<string, Promise<void>>(),
    transcript: {
      estimateSessionFootprint: async () => ({ bytes: 25_000, tokens: 6_250 }),
    },
    sessionObserver: {
      observe: async () => {
        observed = true;
        return {
          triggered: true,
          deltaBytes: 6_500,
          deltaTokens: 1_500,
          band: { maxBytes: 50_000, triggerDeltaBytes: 6_000, triggerDeltaTokens: 1_200 },
        };
      },
    },
    shouldQueueExtraction: () => false,
    buffer: {
      getTurns: () => [
        {
          role: "user",
          content: "dedupe candidate",
          timestamp: "2026-02-25T00:00:00.000Z",
          sessionKey: "agent:generalist:main",
        },
      ],
    },
    queueBufferedExtraction: async () => {
      queued = true;
    },
  };

  await new TurnIngestionCoordinator(fake as any).observeSessionHeartbeat("agent:generalist:main",
  );

  assert.equal(observed, false);
  assert.equal(queued, false);
});

test("shouldQueueExtraction supports non-committing dedupe prechecks", async () => {
  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "same turn body",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
    },
  ];

  const fake = {
    config: {
      sessionObserverEnabled: true,
      extractionDedupeEnabled: true,
      extractionMaxTurnChars: 10_000,
      extractionDedupeWindowMs: 60_000,
    },
    recentExtractionFingerprints: new Map<string, number>(),
    normalizeExtractionFingerprintTurns:
      (ExtractionRunCoordinator.prototype as any).normalizeExtractionFingerprintTurns,
    buildExtractionFingerprint:
      (ExtractionRunCoordinator.prototype as any).buildExtractionFingerprint,
    shouldQueueExtraction: (ExtractionRunCoordinator.prototype as any).shouldQueueExtraction,
  };

  const precheck = fake.shouldQueueExtraction.call(fake, turns, {
    commit: false,
    bufferKey: "agent:generalist:main",
  });
  assert.equal(precheck, true);
  assert.equal(fake.recentExtractionFingerprints.size, 0);

  const commit = fake.shouldQueueExtraction.call(fake, turns, {
    commit: true,
    bufferKey: "agent:generalist:main",
  });
  assert.equal(commit, true);
  assert.equal(fake.recentExtractionFingerprints.size, 1);
});

test("buildExtractionFingerprint prefixes turn fingerprints consistently with in-memory dedupe", () => {
  const fake = {
    config: {
      extractionMaxTurnChars: 10_000,
    },
    normalizeExtractionFingerprintTurns:
      (ExtractionRunCoordinator.prototype as any).normalizeExtractionFingerprintTurns,
    buildExtractionFingerprint:
      (ExtractionRunCoordinator.prototype as any).buildExtractionFingerprint,
  };

  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "ignored when turnFingerprint is present",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
      turnFingerprint: "user:hello",
    },
  ];

  const fingerprint = fake.buildExtractionFingerprint.call(
    fake,
    turns,
    "codex-thread:thread-1",
  );

  const expected = createHash("sha256")
    .update("codex-thread:thread-1\nfp:user:hello")
    .digest("hex");

  assert.equal(fingerprint, expected);
});

test("shouldQueueExtraction dedupes within a buffer key but not across sessions", async () => {
  const turns: BufferTurn[] = [
    {
      role: "user",
      content: "same turn body",
      timestamp: "2026-02-25T00:00:00.000Z",
      sessionKey: "agent:generalist:main",
    },
  ];

  const fake = {
    config: {
      sessionObserverEnabled: true,
      extractionDedupeEnabled: true,
      extractionMaxTurnChars: 10_000,
      extractionDedupeWindowMs: 60_000,
    },
    recentExtractionFingerprints: new Map<string, number>(),
    normalizeExtractionFingerprintTurns:
      (ExtractionRunCoordinator.prototype as any).normalizeExtractionFingerprintTurns,
    buildExtractionFingerprint:
      (ExtractionRunCoordinator.prototype as any).buildExtractionFingerprint,
    shouldQueueExtraction: (ExtractionRunCoordinator.prototype as any).shouldQueueExtraction,
  };

  assert.equal(
    fake.shouldQueueExtraction.call(fake, turns, {
      commit: true,
      bufferKey: "session-a",
    }),
    true,
  );
  assert.equal(
    fake.shouldQueueExtraction.call(fake, turns, {
      commit: true,
      bufferKey: "session-a",
    }),
    false,
  );
  assert.equal(
    fake.shouldQueueExtraction.call(fake, turns, {
      commit: true,
      bufferKey: "session-b",
    }),
    true,
  );
});
