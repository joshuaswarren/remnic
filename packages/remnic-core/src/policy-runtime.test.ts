import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";

import {
  PolicyRuntimeManager,
  readRuntimePolicySnapshot,
} from "./policy-runtime.js";
import type { BehaviorLoopPolicyState, PluginConfig } from "./types.js";

function config(): PluginConfig {
  return {
    recencyWeight: 0.5,
    lifecyclePromoteHeatThreshold: 0.7,
    lifecycleStaleDecayThreshold: 0.2,
    lifecycleArchiveDecayThreshold: 0.1,
    cronRecallInstructionHeavyTokenCap: 4_000,
    behaviorLoopProtectedParams: [],
  } as unknown as PluginConfig;
}

function state(nextValue: number): BehaviorLoopPolicyState {
  return {
    version: 1,
    windowDays: 7,
    minSignalCount: 1,
    maxDeltaPerCycle: 0.5,
    protectedParams: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    adjustments: [
      {
        parameter: "recencyWeight",
        previousValue: 0.5,
        nextValue,
        delta: nextValue - 0.5,
        evidenceCount: 3,
        confidence: 0.9,
        reason: "test",
        appliedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

test("PolicyRuntimeManager serializes concurrent mutations without temp path races", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-policy-runtime-"));
  try {
    const manager = new PolicyRuntimeManager(dir, config());

    const results = await Promise.all([
      manager.applyFromBehaviorState(state(0.2)),
      manager.applyFromBehaviorState(state(0.8)),
      manager.applyFromBehaviorState(state(0.4)),
    ]);

    assert.deepEqual(results.map((result) => result.applied), [true, true, true]);

    const snapshot = await readRuntimePolicySnapshot(
      path.join(dir, "state", "policy-runtime.json"),
    );
    assert.ok(snapshot);
    assert.ok([0.2, 0.8, 0.4].includes(snapshot.values.recencyWeight ?? -1));

    const stateFiles = await readdir(path.join(dir, "state"));
    assert.equal(
      stateFiles.some((file) => file.includes(".tmp")),
      false,
      "successful concurrent mutations must not leave shared temp files behind",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
