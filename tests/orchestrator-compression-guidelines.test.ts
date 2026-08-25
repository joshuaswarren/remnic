import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { buildCompressionGuidelinesMarkdown, Orchestrator } from "@remnic/core/orchestrator";
import { CompressionGuidelineCoordinator } from "@remnic/core/orchestration/compression-guideline-coordinator";
import type { MemoryActionEvent } from "@remnic/core/types";
/** Build a CompressionGuidelineCoordinator from a fake ctx (config + storage),
 *  mirroring the old Orchestrator.prototype-based unit tests. The logic now
 *  lives on the coordinator (#1526 seam 4). */
function makeCoordinator(ctx: any): CompressionGuidelineCoordinator {
  return new CompressionGuidelineCoordinator({
    config: ctx.config,
    getStorage: () => ctx.storage,
    fastChatCompletion: async () => null,
  });
}

test("buildCompressionGuidelinesMarkdown emits conservative guidance with no telemetry", () => {
  const doc = buildCompressionGuidelinesMarkdown([], "2026-02-23T00:00:00.000Z");
  assert.match(doc, /Source events analyzed: 0/);
  assert.match(doc, /No telemetry events available yet/i);
});

test("buildCompressionGuidelinesMarkdown summarizes action\/outcome counts", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-23T00:00:00.000Z", action: "summarize_node", outcome: "applied" },
    { timestamp: "2026-02-23T00:01:00.000Z", action: "summarize_node", outcome: "failed" },
    { timestamp: "2026-02-23T00:02:00.000Z", action: "store_note", outcome: "skipped" },
  ];

  const doc = buildCompressionGuidelinesMarkdown(events, "2026-02-23T00:03:00.000Z");
  assert.match(doc, /summarize_node: 2/);
  assert.match(doc, /applied: 1/);
  assert.match(doc, /failed: 1/);
  assert.match(doc, /skipped: 1/);
});

test("buildCompressionGuidelinesMarkdown includes stable guidance when outcomes are healthy", () => {
  const events: MemoryActionEvent[] = [
    { timestamp: "2026-02-23T00:00:00.000Z", action: "summarize_node", outcome: "applied" },
    { timestamp: "2026-02-23T00:01:00.000Z", action: "summarize_node", outcome: "applied" },
    { timestamp: "2026-02-23T00:02:00.000Z", action: "store_note", outcome: "skipped" },
    { timestamp: "2026-02-23T00:03:00.000Z", action: "store_note", outcome: "applied" },
    { timestamp: "2026-02-23T00:04:00.000Z", action: "store_note", outcome: "applied" },
  ];

  const doc = buildCompressionGuidelinesMarkdown(events, "2026-02-23T00:05:00.000Z");
  assert.match(doc, /Sparse sample size; holding baseline policy/i);
});

test("runCompressionGuidelineLearningPass delegates to optimizeCompressionGuidelines when enabled", async () => {
  let called = 0;
  let received: { dryRun?: boolean; eventLimit?: number } | null = null;
  const coordinator = new CompressionGuidelineCoordinator({
    config: { compressionGuidelineLearningEnabled: true } as any,
    getStorage: () => ({}) as any,
    fastChatCompletion: async () => null,
  });
  coordinator.optimizeCompressionGuidelines = async (options: { dryRun?: boolean; eventLimit?: number }) => {
    called += 1;
    received = options;
    return {
      enabled: true,
      dryRun: false,
      eventCount: 1,
      previousGuidelineVersion: null,
      nextGuidelineVersion: 1,
      changedRules: 0,
      semanticRefinementApplied: false,
      persisted: true,
      draftContentHash: null,
    };
  };

  await coordinator.runCompressionGuidelineLearningPass();
  assert.equal(called, 1);
  assert.deepEqual(received, { dryRun: false, eventLimit: 500 });
});

test("runCompressionGuidelineLearningPass is a no-op when disabled", async () => {
  let readCalled = 0;
  let writeCalled = 0;
  const ctx: any = {
    config: { compressionGuidelineLearningEnabled: false },
    storage: {
      readMemoryActionEvents: async () => {
        readCalled += 1;
        return [];
      },
      writeCompressionGuidelines: async () => {
        writeCalled += 1;
      },
    },
  };

  await makeCoordinator(ctx).runCompressionGuidelineLearningPass();
  assert.equal(readCalled, 0);
  assert.equal(writeCalled, 0);
});

test("optimizeCompressionGuidelines does not publish new state for dry-run-only evidence", async () => {
  let wroteGuidelines = 0;
  let wroteState = 0;
  const ctx: any = {
    config: {
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
      compressionGuidelineSemanticTimeoutMs: 1000,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => ({
        version: 5,
        updatedAt: "2026-02-26T00:00:00.000Z",
        sourceWindow: { from: "2026-02-25T00:00:00.000Z", to: "2026-02-25T23:59:59.000Z" },
        eventCounts: { total: 12, applied: 8, skipped: 2, failed: 2 },
        guidelineVersion: 9,
      }),
      readCompressionGuidelineDraftState: async () => null,
      readMemoryActionEvents: async () => [
        { timestamp: "2026-02-27T00:00:00.000Z", action: "store_note", outcome: "applied", dryRun: true },
        { timestamp: "2026-02-27T00:01:00.000Z", action: "discard", outcome: "skipped", dryRun: true },
      ],
      writeCompressionGuidelines: async () => {
        wroteGuidelines += 1;
      },
      writeCompressionGuidelineOptimizerState: async () => {
        wroteState += 1;
      },
    },
  };

  const result = await makeCoordinator(ctx).optimizeCompressionGuidelines({
    dryRun: false,
    eventLimit: 500,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.eventCount, 0);
  assert.equal(result.previousGuidelineVersion, 9);
  assert.equal(result.nextGuidelineVersion, 9);
  assert.equal(result.changedRules, 0);
  assert.equal(result.semanticRefinementApplied, false);
  assert.equal(result.persisted, false);
  assert.equal(result.draftContentHash, null);
  assert.equal(wroteGuidelines, 0);
  assert.equal(wroteState, 0);
});

test("optimizeCompressionGuidelines over-fetches until it collects enough non-dry-run events", async () => {
  const readLimits: number[] = [];
  const ledger: MemoryActionEvent[] = [
    { timestamp: "2026-02-27T00:00:00.000Z", action: "store_note", outcome: "applied" },
    { timestamp: "2026-02-27T00:01:00.000Z", action: "store_note", outcome: "failed" },
    { timestamp: "2026-02-27T00:02:00.000Z", action: "store_note", outcome: "applied", dryRun: true },
    { timestamp: "2026-02-27T00:03:00.000Z", action: "store_note", outcome: "skipped", dryRun: true },
    { timestamp: "2026-02-27T00:04:00.000Z", action: "store_note", outcome: "applied", dryRun: true },
  ];
  let wroteDraftGuidelines = 0;
  let wroteDraftState = 0;
  const ctx: any = {
    config: {
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
      compressionGuidelineSemanticTimeoutMs: 1000,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => null,
      readCompressionGuidelineDraftState: async () => null,
      readMemoryActionEvents: async (limit: number) => {
        readLimits.push(limit);
        return ledger.slice(-limit);
      },
      writeCompressionGuidelineDraft: async () => {
        wroteDraftGuidelines += 1;
      },
      writeCompressionGuidelineDraftState: async () => {
        wroteDraftState += 1;
      },
    },
  };

  const result = await makeCoordinator(ctx).optimizeCompressionGuidelines({
    dryRun: false,
    eventLimit: 2,
  });

  assert.deepEqual(readLimits, [2, 4, 8]);
  assert.equal(result.enabled, true);
  assert.equal(result.eventCount, 2);
  assert.equal(result.nextGuidelineVersion, 1);
  assert.equal(typeof result.draftContentHash, "string");
  assert.equal(wroteDraftGuidelines, 1);
  assert.equal(wroteDraftState, 1);
});

test("optimizeCompressionGuidelines stages a draft revision without overwriting the active guideline", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-guideline-stage-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
    });
    const orchestrator = new Orchestrator(cfg);

    await orchestrator.storage.writeCompressionGuidelines("# Compression Guidelines\n\n## Suggested Guidelines\n- store_note: hold\n");
    await orchestrator.storage.writeCompressionGuidelineOptimizerState({
      version: 1,
      updatedAt: "2026-03-10T00:00:00.000Z",
      sourceWindow: {
        from: "2026-03-09T00:00:00.000Z",
        to: "2026-03-10T00:00:00.000Z",
      },
      eventCounts: {
        total: 3,
        applied: 2,
        skipped: 1,
        failed: 0,
      },
      guidelineVersion: 2,
      activationState: "active",
    });
    await orchestrator.storage.appendMemoryActionEvents([
      {
        timestamp: "2026-03-11T00:00:00.000Z",
        action: "summarize_node",
        outcome: "failed",
        reason: "quality=poor",
      },
      {
        timestamp: "2026-03-11T00:05:00.000Z",
        action: "summarize_node",
        outcome: "applied",
        reason: "quality=good",
      },
    ]);

    const result = await orchestrator.compressionGuidelineCoordinator.optimizeCompressionGuidelines({ dryRun: false, eventLimit: 50 });
    assert.equal(result.persisted, true);
    assert.equal(typeof result.draftContentHash, "string");

    const activeGuidelines = await orchestrator.storage.readCompressionGuidelines();
    const draftGuidelines = await orchestrator.storage.readCompressionGuidelineDraft();
    const activeState = await orchestrator.storage.readCompressionGuidelineOptimizerState();
    const draftState = await orchestrator.storage.readCompressionGuidelineDraftState();

    assert.match(activeGuidelines ?? "", /store_note: hold/);
    assert.ok(draftGuidelines);
    assert.equal(activeState?.activationState, "active");
    assert.equal(draftState?.activationState, "draft");
    assert.equal((draftState?.guidelineVersion ?? 0) > (activeState?.guidelineVersion ?? 0), true);
    assert.equal(Array.isArray(draftState?.ruleUpdates), true);
    assert.equal(result.draftContentHash, draftState?.contentHash ?? null);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("optimizeCompressionGuidelines increments staged guideline versions from the latest draft", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-guideline-restage-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
    });
    const orchestrator = new Orchestrator(cfg);

    await orchestrator.storage.writeCompressionGuidelines("# Compression Guidelines\n\n## Suggested Guidelines\n- store_note: hold\n");
    await orchestrator.storage.writeCompressionGuidelineOptimizerState({
      version: 2,
      updatedAt: "2026-03-10T00:00:00.000Z",
      sourceWindow: {
        from: "2026-03-09T00:00:00.000Z",
        to: "2026-03-10T00:00:00.000Z",
      },
      eventCounts: {
        total: 3,
        applied: 2,
        skipped: 1,
        failed: 0,
      },
      guidelineVersion: 4,
      activationState: "active",
    });
    await orchestrator.storage.appendMemoryActionEvents([
      {
        timestamp: "2026-03-11T00:00:00.000Z",
        action: "summarize_node",
        outcome: "failed",
        reason: "quality=poor",
      },
      {
        timestamp: "2026-03-11T00:05:00.000Z",
        action: "summarize_node",
        outcome: "applied",
        reason: "quality=good",
      },
    ]);

    const first = await orchestrator.compressionGuidelineCoordinator.optimizeCompressionGuidelines({ dryRun: false, eventLimit: 50 });
    const firstDraftState = await orchestrator.storage.readCompressionGuidelineDraftState();
    assert.equal(first.nextGuidelineVersion, 5);
    assert.equal(firstDraftState?.guidelineVersion, 5);

    const second = await orchestrator.compressionGuidelineCoordinator.optimizeCompressionGuidelines({ dryRun: false, eventLimit: 50 });
    const secondDraftState = await orchestrator.storage.readCompressionGuidelineDraftState();
    assert.equal(second.nextGuidelineVersion, 6);
    assert.equal(secondDraftState?.guidelineVersion, 6);
    assert.equal((secondDraftState?.version ?? 0) > (firstDraftState?.version ?? 0), true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("optimizeCompressionGuidelines tags semantic refinement calls as background work", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-guideline-priority-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: true,
      compressionGuidelineSemanticTimeoutMs: 1000,
    });
    const orchestrator = new Orchestrator(cfg);
    let seenPriority: string | undefined;
    (orchestrator as { fastLlm: unknown }).fastLlm = {
      chatCompletion: async (
        _messages: Array<{ role: string; content: string }>,
        options?: { priority?: string },
      ) => {
        seenPriority = options?.priority;
        return {
          content: '{"updates":[]}',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    await orchestrator.storage.appendMemoryActionEvents([
      {
        timestamp: "2026-03-11T00:00:00.000Z",
        action: "summarize_node",
        outcome: "failed",
        reason: "quality=poor",
      },
    ]);

    const result = await orchestrator.compressionGuidelineCoordinator.optimizeCompressionGuidelines({
      dryRun: false,
      eventLimit: 10,
    });

    assert.equal(result.enabled, true);
    assert.equal(seenPriority, "background");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("activateCompressionGuidelineDraft requires reviewed draft identity and rejects stale hashes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-guideline-activate-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: memoryDir,
      compressionGuidelineLearningEnabled: true,
      compressionGuidelineSemanticRefinementEnabled: false,
    });
    const orchestrator = new Orchestrator(cfg);

    await orchestrator.storage.appendMemoryActionEvents([
      {
        timestamp: "2026-03-11T00:00:00.000Z",
        action: "summarize_node",
        outcome: "failed",
        reason: "quality=poor",
      },
      {
        timestamp: "2026-03-11T00:05:00.000Z",
        action: "summarize_node",
        outcome: "applied",
        reason: "quality=good",
      },
    ]);

    const optimizeResult = await orchestrator.compressionGuidelineCoordinator.optimizeCompressionGuidelines({ dryRun: false, eventLimit: 10 });
    assert.equal(typeof optimizeResult.draftContentHash, "string");

    const missingIdentity = await orchestrator.compressionGuidelineCoordinator.activateCompressionGuidelineDraft();
    assert.equal(missingIdentity.activated, false);
    assert.equal(missingIdentity.reason, "expected_revision_required");

    const staleIdentity = await orchestrator.compressionGuidelineCoordinator.activateCompressionGuidelineDraft({
      expectedContentHash: "stale-hash",
    });
    assert.equal(staleIdentity.activated, false);
    assert.equal(staleIdentity.reason, "content_hash_mismatch");

    const activated = await orchestrator.compressionGuidelineCoordinator.activateCompressionGuidelineDraft({
      expectedContentHash: optimizeResult.draftContentHash ?? undefined,
    });
    assert.equal(activated.activated, true);
    assert.equal(activated.guidelineVersion, optimizeResult.nextGuidelineVersion);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
