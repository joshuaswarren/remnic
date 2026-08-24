import test from "node:test";
import assert from "node:assert/strict";
import { formatCompressionGuidelinesForRecall } from "@remnic/core/orchestrator";
import { CompressionGuidelineCoordinator } from "@remnic/core/orchestration/compression-guideline-coordinator";
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

test("formatCompressionGuidelinesForRecall extracts suggested guideline bullets", () => {
  const raw = [
    "# Compression Guidelines",
    "",
    "Generated: 2026-02-27T20:00:00.000Z",
    "## Suggested Guidelines",
    "- summarize_node: increase (+0.020, confidence=medium) — prefer concise summarization when recall quality remains stable.",
    "- store_note: hold (0.000, confidence=low) — sparse signal; keep baseline.",
    "",
    "## Action Distribution",
    "- summarize_node: 4",
  ].join("\n");

  const result = formatCompressionGuidelinesForRecall(raw, 3);
  assert.ok(result);
  assert.match(result ?? "", /summarize_node: increase/);
  assert.match(result ?? "", /store_note: hold/);
});

test("formatCompressionGuidelinesForRecall returns null for malformed guideline content", () => {
  const raw = "# Compression Guidelines\n\nGenerated: 2026-02-27T20:00:00.000Z\n";
  assert.equal(formatCompressionGuidelinesForRecall(raw), null);
});

test("buildCompressionGuidelineRecallSection keeps zero-change path when optimizer is disabled", async () => {
  let stateReads = 0;
  let guidelineReads = 0;

  const ctx: any = {
    config: {
      contextCompressionActionsEnabled: true,
      compressionGuidelineLearningEnabled: false,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => {
        stateReads += 1;
        return null;
      },
      readCompressionGuidelines: async () => {
        guidelineReads += 1;
        return null;
      },
    },
  };

  const section = await makeCoordinator(ctx).buildCompressionGuidelineRecallSection();
  assert.equal(section, null);
  assert.equal(stateReads, 0);
  assert.equal(guidelineReads, 0);
});

test("buildCompressionGuidelineRecallSection emits active guideline section when enabled", async () => {
  const ctx: any = {
    config: {
      contextCompressionActionsEnabled: true,
      compressionGuidelineLearningEnabled: true,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => ({
        version: 2,
        updatedAt: "2026-02-27T20:10:00.000Z",
        sourceWindow: {
          from: "2026-02-27T19:00:00.000Z",
          to: "2026-02-27T20:00:00.000Z",
        },
        eventCounts: { total: 2, applied: 2, skipped: 0, failed: 0 },
        guidelineVersion: 3,
      }),
      readCompressionGuidelines: async () =>
        [
          "# Compression Guidelines",
          "",
          "Generated: 2026-02-27T20:10:00.000Z",
          "## Suggested Guidelines",
          "- summarize_node: increase (+0.020, confidence=medium) — keep recaps concise.",
          "",
        ].join("\n"),
    },
  };

  const section = await makeCoordinator(ctx).buildCompressionGuidelineRecallSection();
  assert.ok(section);
  assert.match(section ?? "", /## Active Compression Guidelines/);
  assert.match(section ?? "", /Guideline version: 3/);
  assert.match(section ?? "", /summarize_node: increase/);
});

test("buildCompressionGuidelineRecallSection keeps the active guideline visible while a draft is pending", async () => {
  const ctx: any = {
    config: {
      contextCompressionActionsEnabled: true,
      compressionGuidelineLearningEnabled: true,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => ({
        version: 2,
        updatedAt: "2026-02-27T20:10:00.000Z",
        sourceWindow: {
          from: "2026-02-27T19:00:00.000Z",
          to: "2026-02-27T20:00:00.000Z",
        },
        eventCounts: { total: 2, applied: 2, skipped: 0, failed: 0 },
        guidelineVersion: 3,
        activationState: "active",
      }),
      readCompressionGuidelines: async () =>
        [
          "# Compression Guidelines",
          "",
          "Generated: 2026-02-27T20:10:00.000Z",
          "## Suggested Guidelines",
          "- summarize_node: increase (+0.020, confidence=medium) — keep recaps concise.",
          "",
        ].join("\n"),
      readCompressionGuidelineDraftState: async () => ({
        version: 3,
        updatedAt: "2026-02-27T20:15:00.000Z",
        sourceWindow: {
          from: "2026-02-27T19:30:00.000Z",
          to: "2026-02-27T20:15:00.000Z",
        },
        eventCounts: { total: 3, applied: 2, skipped: 0, failed: 1 },
        guidelineVersion: 4,
        activationState: "draft",
      }),
    },
  };

  const section = await makeCoordinator(ctx).buildCompressionGuidelineRecallSection();
  assert.ok(section);
  assert.match(section ?? "", /Guideline version: 3/);
  assert.doesNotMatch(section ?? "", /Guideline version: 4/);
});

test("buildCompressionGuidelineRecallSection fail-opens on malformed guideline state/guidelines", async () => {
  const ctx: any = {
    config: {
      contextCompressionActionsEnabled: true,
      compressionGuidelineLearningEnabled: true,
    },
    storage: {
      readCompressionGuidelineOptimizerState: async () => null,
      readCompressionGuidelines: async () => "# Compression Guidelines\n\nGenerated: now",
    },
  };

  const section = await makeCoordinator(ctx).buildCompressionGuidelineRecallSection();
  assert.equal(section, null);
});
