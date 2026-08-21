import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  runPolicyDiffCliCommand,
  runPolicyRollbackCliCommand,
  runPolicyStatusCliCommand,
} from "../src/cli.js";
import type { BehaviorSignalEvent } from "../src/types.js";

async function writeRuntimeSnapshots(memoryDir: string): Promise<void> {
  const stateDir = path.join(memoryDir, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "policy-runtime.prev.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-02-28T00:00:00.000Z",
      values: {
        recencyWeight: 0.2,
        lifecyclePromoteHeatThreshold: 0.7,
        lifecycleStaleDecayThreshold: 0.85,
        cronRecallInstructionHeavyTokenCap: 350,
      },
      sourceAdjustmentCount: 12,
    }),
    "utf-8",
  );
  await writeFile(
    path.join(stateDir, "policy-runtime.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-02-28T01:00:00.000Z",
      values: {
        recencyWeight: 0.35,
        lifecyclePromoteHeatThreshold: 0.75,
        lifecycleStaleDecayThreshold: 0.9,
        cronRecallInstructionHeavyTokenCap: 380,
      },
      sourceAdjustmentCount: 21,
    }),
    "utf-8",
  );
}

function expectedPolicyVersionWithArchiveCap(values: {
  recencyWeight: number;
  lifecyclePromoteHeatThreshold: number;
  lifecycleStaleDecayThreshold: number;
  cronRecallInstructionHeavyTokenCap: number;
}, archiveThreshold: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recencyWeight: values.recencyWeight,
        lifecyclePromoteHeatThreshold: values.lifecyclePromoteHeatThreshold,
        lifecycleStaleDecayThreshold: Math.min(values.lifecycleStaleDecayThreshold, archiveThreshold),
        cronRecallInstructionHeavyTokenCap: values.cronRecallInstructionHeavyTokenCap,
      }),
    )
    .digest("hex")
    .slice(0, 12);
}

function basePolicyConfig(memoryDir: string) {
  return {
    memoryDir,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacesEnabled: false,
    behaviorLoopAutoTuneEnabled: true,
    behaviorLoopLearningWindowDays: 14,
    lifecycleArchiveDecayThreshold: 0.8,
    recencyWeight: 0.25,
    lifecyclePromoteHeatThreshold: 0.6,
    lifecycleStaleDecayThreshold: 0.7,
    cronRecallInstructionHeavyTokenCap: 320,
    namespacePolicies: [],
  };
}

function buildSignal(
  timestamp: string,
  overrides: Partial<BehaviorSignalEvent> = {},
): BehaviorSignalEvent {
  return {
    timestamp,
    namespace: "default",
    memoryId: "fact-1",
    category: "preference",
    signalType: "preference_affinity",
    direction: "positive",
    confidence: 0.8,
    signalHash: `hash-${timestamp}`,
    source: "extraction",
    ...overrides,
  };
}

test("runPolicyStatusCliCommand returns policy snapshots and contributing signals", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-policy-status-"));
  try {
    await writeRuntimeSnapshots(memoryDir);
    const signalsByNamespace = new Map<string, BehaviorSignalEvent[]>([
      ["default", [buildSignal(new Date().toISOString()), buildSignal(new Date().toISOString())]],
      ["shared", [buildSignal(new Date().toISOString(), { direction: "negative", signalType: "correction_override" })]],
    ]);

    const orchestrator = {
      config: {
        ...basePolicyConfig(memoryDir),
        namespacesEnabled: true,
      },
      async getStorage(namespace?: string) {
        return {
          async readBehaviorSignals() {
            return signalsByNamespace.get(namespace ?? "default") ?? [];
          },
        };
      },
      async rollbackBehaviorRuntimePolicy() {
        return true;
      },
    };

    const status = await runPolicyStatusCliCommand(orchestrator);
    assert.equal(status.autoTuneEnabled, true);
    assert.ok(status.current);
    assert.ok(status.previous);
    assert.equal((status.current?.policyVersion ?? "").length, 12);
    assert.equal((status.previous?.policyVersion ?? "").length, 12);
    assert.equal(
      status.current?.policyVersion,
      expectedPolicyVersionWithArchiveCap(
        {
          recencyWeight: 0.35,
          lifecyclePromoteHeatThreshold: 0.75,
          lifecycleStaleDecayThreshold: 0.9,
          cronRecallInstructionHeavyTokenCap: 380,
        },
        0.8,
      ),
    );
    assert.equal(status.topContributingSignals[0]?.count, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runPolicyDiffCliCommand reports deltas and applies --since window to signals", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-policy-diff-"));
  try {
    await writeRuntimeSnapshots(memoryDir);
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    const signals = [
      buildSignal(oldIso),
      buildSignal(nowIso, { signalType: "correction_override", direction: "negative" }),
    ];

    const orchestrator = {
      config: basePolicyConfig(memoryDir),
      async getStorage() {
        return {
          async readBehaviorSignals() {
            return signals;
          },
        };
      },
      async rollbackBehaviorRuntimePolicy() {
        return true;
      },
    };

    const diff = await runPolicyDiffCliCommand(orchestrator, { since: "7d" });
    assert.equal(diff.deltas.length > 0, true);
    assert.equal(diff.deltas.some((entry) => entry.parameter === "recencyWeight"), true);
    assert.equal(diff.deltas[0]?.evidenceCount, 21);
    assert.equal(diff.topContributingSignals.length, 1);
    assert.equal(diff.topContributingSignals[0]?.signalType, "correction_override");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runPolicyRollbackCliCommand executes rollback and returns current snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-policy-rollback-"));
  try {
    await writeRuntimeSnapshots(memoryDir);
    let rollbackCalls = 0;
    const orchestrator = {
      config: basePolicyConfig(memoryDir),
      async getStorage() {
        return {
          async readBehaviorSignals() {
            return [];
          },
        };
      },
      async rollbackBehaviorRuntimePolicy() {
        rollbackCalls += 1;
        return true;
      },
    };

    const result = await runPolicyRollbackCliCommand(orchestrator);
    assert.equal(result.rolledBack, true);
    assert.equal(rollbackCalls, 1);
    assert.ok(result.current);
    assert.equal((result.current?.policyVersion ?? "").length, 12);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("runPolicyStatusCliCommand hashes complete effective policy when snapshot omits fields", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-policy-partial-"));
  try {
    const stateDir = path.join(memoryDir, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "policy-runtime.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-02-28T01:00:00.000Z",
        values: {
          recencyWeight: 0.4,
          lifecycleStaleDecayThreshold: 0.95,
        },
        sourceAdjustmentCount: 3,
      }),
      "utf-8",
    );

    const config = basePolicyConfig(memoryDir);
    const orchestrator = {
      config,
      async getStorage() {
        return {
          async readBehaviorSignals() {
            return [];
          },
        };
      },
      async rollbackBehaviorRuntimePolicy() {
        return true;
      },
    };

    const status = await runPolicyStatusCliCommand(orchestrator);
    assert.ok(status.current);
    assert.equal(
      status.current?.policyVersion,
      expectedPolicyVersionWithArchiveCap(
        {
          recencyWeight: 0.4,
          lifecyclePromoteHeatThreshold: config.lifecyclePromoteHeatThreshold,
          lifecycleStaleDecayThreshold: 0.95,
          cronRecallInstructionHeavyTokenCap: config.cronRecallInstructionHeavyTokenCap,
        },
        config.lifecycleArchiveDecayThreshold,
      ),
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
