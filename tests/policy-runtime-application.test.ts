import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { parseConfig } from "../src/config.ts";
import { planRecallMode } from "../src/intent.ts";
import { PolicyRuntimeManager } from "../src/policy-runtime.ts";

test("policy runtime applies and loads bounded values", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-runtime-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      qmdEnabled: false,
    });
    const runtime = new PolicyRuntimeManager(memoryDir, cfg);

    const result = await runtime.applyFromBehaviorState({
      version: 1,
      windowDays: 14,
      minSignalCount: 10,
      maxDeltaPerCycle: 0.1,
      protectedParams: [],
      updatedAt: "2026-02-28T00:00:00.000Z",
      adjustments: [
        {
          parameter: "recencyWeight",
          previousValue: 0.2,
          nextValue: 0.35,
          delta: 0.15,
          evidenceCount: 20,
          confidence: 0.7,
          reason: "test",
          appliedAt: "2026-02-28T00:00:00.000Z",
        },
        {
          parameter: "lifecycleStaleDecayThreshold",
          previousValue: 0.65,
          nextValue: 0.99,
          delta: 0.34,
          evidenceCount: 20,
          confidence: 0.7,
          reason: "test",
          appliedAt: "2026-02-28T00:00:00.000Z",
        },
      ],
    });

    assert.equal(result.applied, true);
    const loaded = await runtime.loadRuntimeValues();
    assert.equal(loaded?.recencyWeight, 0.35);
    assert.equal(loaded?.lifecycleStaleDecayThreshold, cfg.lifecycleArchiveDecayThreshold);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runtime policy updates do not break recall mode contracts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-runtime-modes-"));
  const before = [
    planRecallMode("ok"),
    planRecallMode("Check gateway status"),
    planRecallMode("What happened in the timeline last week?"),
    planRecallMode("Tell me about the architecture decision."),
  ];
  assert.deepEqual(before, ["no_recall", "minimal", "graph_mode", "full"]);

  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      qmdEnabled: false,
    });
    const runtime = new PolicyRuntimeManager(memoryDir, cfg);
    const applied = await runtime.applyFromBehaviorState({
      version: 1,
      windowDays: 14,
      minSignalCount: 10,
      maxDeltaPerCycle: 0.1,
      protectedParams: [],
      updatedAt: "2026-02-28T00:00:00.000Z",
      adjustments: [
        {
          parameter: "recencyWeight",
          previousValue: 0.2,
          nextValue: 0.45,
          delta: 0.25,
          evidenceCount: 20,
          confidence: 0.8,
          reason: "contract test",
          appliedAt: "2026-02-28T00:00:00.000Z",
        },
      ],
    });
    assert.equal(applied.applied, true);
    const loaded = await runtime.loadRuntimeValues();
    assert.equal(loaded?.recencyWeight, 0.45);

    const after = [
      planRecallMode("ok"),
      planRecallMode("Check gateway status"),
      planRecallMode("What happened in the timeline last week?"),
      planRecallMode("Tell me about the architecture decision."),
    ];
    assert.deepEqual(after, ["no_recall", "minimal", "graph_mode", "full"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("policy runtime rolls back to previous snapshot on invalid update", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-policy-runtime-rollback-"));
  try {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      qmdEnabled: false,
    });
    const runtime = new PolicyRuntimeManager(memoryDir, cfg);

    const first = await runtime.applyFromBehaviorState({
      version: 1,
      windowDays: 14,
      minSignalCount: 10,
      maxDeltaPerCycle: 0.1,
      protectedParams: [],
      updatedAt: "2026-02-28T00:00:00.000Z",
      adjustments: [
        {
          parameter: "recencyWeight",
          previousValue: 0.2,
          nextValue: 0.4,
          delta: 0.2,
          evidenceCount: 20,
          confidence: 0.8,
          reason: "seed",
          appliedAt: "2026-02-28T00:00:00.000Z",
        },
      ],
    });
    assert.equal(first.applied, true);

    const invalid = await runtime.applyFromBehaviorState({
      version: 1,
      windowDays: 14,
      minSignalCount: 10,
      maxDeltaPerCycle: 0.1,
      protectedParams: [],
      updatedAt: "2026-02-28T00:00:00.000Z",
      adjustments: [
        {
          parameter: "unsupported_policy_key",
          previousValue: 0,
          nextValue: 1,
          delta: 1,
          evidenceCount: 20,
          confidence: 0.8,
          reason: "bad",
          appliedAt: "2026-02-28T00:00:00.000Z",
        },
      ],
    } as any);

    assert.equal(invalid.applied, false);
    assert.equal(invalid.rolledBack, true);
    const loaded = await runtime.loadRuntimeValues();
    assert.equal(loaded?.recencyWeight, 0.4);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
