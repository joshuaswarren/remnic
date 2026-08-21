import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";

test("StorageManager appends and reads memory action events from state store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-actions-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const wrote = await storage.appendMemoryActionEvents([
      {
        timestamp: "2026-02-23T00:00:00.000Z",
        action: "store_note",
        outcome: "applied",
        reason: "seed",
      },
      {
        timestamp: "2026-02-23T00:00:01.000Z",
        action: "summarize_node",
        outcome: "skipped",
      },
      {
        timestamp: "2026-02-23T00:00:02.000Z",
        action: "discard",
        outcome: "failed",
      },
    ]);

    assert.equal(wrote, 3);

    const events = await storage.readMemoryActionEvents(2);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.action, "summarize_node");
    assert.equal(events[1]?.action, "discard");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager readMemoryActionEvents ignores malformed rows (fail-open)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.appendMemoryActionEvents([
      {
        timestamp: "2026-02-23T00:00:00.000Z",
        action: "store_episode",
        outcome: "applied",
      },
    ]);

    const malformedPath = path.join(dir, "state", "memory-actions.jsonl");
    await appendFile(malformedPath, "{not-json}\n", "utf-8");

    const events = await storage.readMemoryActionEvents(10);
    assert.equal(events.length, 1);
    assert.equal(events.every((e) => typeof e.timestamp === "string" && e.timestamp.length > 0), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager writes and reads compression guidelines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-guidelines-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    assert.equal(await storage.readCompressionGuidelines(), null);

    const content = "# Compression Guidelines\n\n- Prefer concise summary bullets.\n";
    await storage.writeCompressionGuidelines(content);

    const loaded = await storage.readCompressionGuidelines();
    assert.equal(loaded, content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager writes and reads compression guideline optimizer state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-opt-state-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const state = {
      version: 1,
      updatedAt: "2026-02-27T00:00:00.000Z",
      sourceWindow: {
        from: "2026-02-26T00:00:00.000Z",
        to: "2026-02-27T00:00:00.000Z",
      },
      eventCounts: {
        total: 9,
        applied: 5,
        skipped: 3,
        failed: 1,
      },
      guidelineVersion: 2,
    };

    await storage.writeCompressionGuidelineOptimizerState(state);
    const loaded = await storage.readCompressionGuidelineOptimizerState();
    assert.deepEqual(loaded, state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager readCompressionGuidelineOptimizerState fail-opens malformed state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-opt-malformed-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await appendFile(
      path.join(dir, "state", "compression-guideline-state.json"),
      JSON.stringify({
        version: "bad",
        updatedAt: "",
        sourceWindow: { from: "", to: "" },
        eventCounts: { total: -1, applied: -1, skipped: -1, failed: -1 },
        guidelineVersion: "x",
      }),
      "utf-8",
    );

    const loaded = await storage.readCompressionGuidelineOptimizerState();
    assert.equal(loaded, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager readCompressionGuidelineOptimizerState returns null when state is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-opt-empty-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const loaded = await storage.readCompressionGuidelineOptimizerState();
    assert.equal(loaded, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager stages and activates compression guideline drafts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-opt-draft-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const draftContent = "# Compression Guidelines\n\n## Suggested Guidelines\n- summarize_node: increase (+0.020, confidence=medium)\n";
    const draftState = {
      version: 2,
      updatedAt: "2026-03-11T00:00:00.000Z",
      sourceWindow: {
        from: "2026-03-10T00:00:00.000Z",
        to: "2026-03-11T00:00:00.000Z",
      },
      eventCounts: {
        total: 4,
        applied: 2,
        skipped: 1,
        failed: 1,
      },
      guidelineVersion: 3,
      contentHash: createHash("sha256").update(draftContent).digest("hex"),
      activationState: "draft" as const,
      ruleUpdates: [
        {
          action: "summarize_node" as const,
          delta: 0.02,
          direction: "increase" as const,
          confidence: "medium" as const,
          notes: ["Good recall quality markers support this action."],
        },
      ],
    };

    await storage.writeCompressionGuidelineDraft(draftContent);
    await storage.writeCompressionGuidelineDraftState(draftState);

    assert.equal(await storage.readCompressionGuidelines(), null);
    assert.equal(await storage.readCompressionGuidelineOptimizerState(), null);
    assert.equal(await storage.readCompressionGuidelineDraft(), draftContent);
    assert.deepEqual(await storage.readCompressionGuidelineDraftState(), draftState);

    const activated = await storage.activateCompressionGuidelineDraft();
    assert.equal(activated, true);
    assert.equal(await storage.readCompressionGuidelineDraft(), null);
    assert.equal(await storage.readCompressionGuidelineDraftState(), null);
    assert.equal(await storage.readCompressionGuidelines(), draftContent);
    assert.deepEqual(await storage.readCompressionGuidelineOptimizerState(), {
      ...draftState,
      activationState: "active",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager refuses to activate mismatched compression guideline drafts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-opt-draft-mismatch-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const draftContent = "# Compression Guidelines\n\n## Suggested Guidelines\n- store_note: hold\n";
    const draftState = {
      version: 2,
      updatedAt: "2026-03-11T00:00:00.000Z",
      sourceWindow: {
        from: "2026-03-10T00:00:00.000Z",
        to: "2026-03-11T00:00:00.000Z",
      },
      eventCounts: {
        total: 4,
        applied: 2,
        skipped: 1,
        failed: 1,
      },
      guidelineVersion: 3,
      contentHash: createHash("sha256").update("different content").digest("hex"),
      activationState: "draft" as const,
    };

    await storage.writeCompressionGuidelineDraft(draftContent);
    await storage.writeCompressionGuidelineDraftState(draftState);

    const activated = await storage.activateCompressionGuidelineDraft();
    assert.equal(activated, false);
    assert.equal(await storage.readCompressionGuidelines(), null);
    assert.equal(await storage.readCompressionGuidelineOptimizerState(), null);
    assert.equal(await storage.readCompressionGuidelineDraft(), draftContent);
    assert.deepEqual(await storage.readCompressionGuidelineDraftState(), draftState);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager appends and reads behavior signals from state store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-behavior-signals-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const wrote = await storage.appendBehaviorSignals([
      {
        timestamp: "2026-02-28T00:00:00.000Z",
        namespace: "default",
        memoryId: "correction-1",
        category: "correction",
        signalType: "correction_override",
        direction: "negative",
        confidence: 0.95,
        signalHash: "abc123",
        source: "extraction",
      },
      {
        timestamp: "2026-02-28T00:01:00.000Z",
        namespace: "default",
        memoryId: "preference-1",
        category: "preference",
        signalType: "preference_affinity",
        direction: "positive",
        confidence: 0.88,
        signalHash: "def456",
        source: "extraction",
      },
    ]);

    assert.equal(wrote, 2);
    const loaded = await storage.readBehaviorSignals(10);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.memoryId, "correction-1");
    assert.equal(loaded[1]?.memoryId, "preference-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager dedupes behavior signals by memory id + signal hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-behavior-dedupe-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const first = await storage.appendBehaviorSignals([
      {
        timestamp: "2026-02-28T00:00:00.000Z",
        namespace: "default",
        memoryId: "correction-1",
        category: "correction",
        signalType: "correction_override",
        direction: "negative",
        confidence: 0.95,
        signalHash: "same",
        source: "extraction",
      },
    ]);
    const second = await storage.appendBehaviorSignals([
      {
        timestamp: "2026-02-28T00:05:00.000Z",
        namespace: "default",
        memoryId: "correction-1",
        category: "correction",
        signalType: "correction_override",
        direction: "negative",
        confidence: 0.95,
        signalHash: "same",
        source: "extraction",
      },
    ]);

    assert.equal(first, 1);
    assert.equal(second, 0);
    const loaded = await storage.readBehaviorSignals(10);
    assert.equal(loaded.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
