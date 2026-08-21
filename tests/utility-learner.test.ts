import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  getUtilityLearningStatus,
  learnUtilityPromotionWeights,
  readUtilityLearningSnapshot,
  resolveUtilityLearningStatePath,
} from "../src/utility-learner.js";
import { recordUtilityTelemetryEvent } from "../src/utility-telemetry.js";
import {
  registerCli,
  runUtilityLearningCliCommand,
  runUtilityLearningStatusCliCommand,
} from "../src/cli.js";

async function recordEvent(
  memoryDir: string,
  overrides: Partial<Parameters<typeof recordUtilityTelemetryEvent>[0]["event"]> = {},
): Promise<void> {
  const eventId = overrides.eventId ?? `event-${Math.random().toString(36).slice(2, 10)}`;
  await recordUtilityTelemetryEvent({
    memoryDir,
    event: {
      schemaVersion: 1,
      eventId,
      recordedAt: overrides.recordedAt ?? "2026-03-08T05:00:00.000Z",
      sessionKey: overrides.sessionKey ?? "agent:main",
      source: overrides.source ?? "benchmark",
      target: overrides.target ?? "promotion",
      decision: overrides.decision ?? "promote",
      outcome: overrides.outcome ?? "helpful",
      utilityScore: overrides.utilityScore ?? 0.9,
      summary: overrides.summary ?? "Utility benchmark outcome.",
      tags: overrides.tags,
      memoryIds: overrides.memoryIds,
      entityRefs: overrides.entityRefs,
      metadata: overrides.metadata,
    },
  });
}

test("utility learner state path resolves under the utility telemetry root", () => {
  assert.equal(
    resolveUtilityLearningStatePath("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "utility-telemetry", "learning-state.json"),
  );
});

test("offline utility learner persists bounded promotion weights from telemetry outcomes", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-learner-"));
  try {
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-promote-1",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 1,
    });
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-promote-2",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 0.6,
    });
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-suppress-1",
      target: "ranking",
      decision: "suppress",
      outcome: "harmful",
      utilityScore: -0.8,
    });
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-suppress-2",
      target: "ranking",
      decision: "suppress",
      outcome: "harmful",
      utilityScore: -0.4,
    });

    const result = await learnUtilityPromotionWeights({
      memoryDir,
      enabled: true,
      now: new Date("2026-03-08T06:00:00.000Z"),
      learningWindowDays: 7,
      minEventCount: 2,
      maxWeightMagnitude: 0.35,
    });

    assert.equal(result.applied, true);
    assert.equal(result.snapshot?.weights.length, 2);

    const promoteWeight = result.snapshot?.weights.find((entry) =>
      entry.target === "promotion" && entry.decision === "promote"
    );
    assert.ok(promoteWeight);
    assert.equal(promoteWeight.eventCount, 2);
    assert.ok(promoteWeight.learnedWeight > 0);
    assert.ok(promoteWeight.learnedWeight <= 0.35);
    assert.equal(promoteWeight.outcomeCounts.helpful, 2);

    const suppressWeight = result.snapshot?.weights.find((entry) =>
      entry.target === "ranking" && entry.decision === "suppress"
    );
    assert.ok(suppressWeight);
    assert.equal(suppressWeight.eventCount, 2);
    assert.ok(suppressWeight.learnedWeight < 0);
    assert.ok(suppressWeight.learnedWeight >= -0.35);
    assert.equal(suppressWeight.outcomeCounts.harmful, 2);

    const persisted = await readUtilityLearningSnapshot(memoryDir);
    assert.equal(persisted?.weights.length, 2);
    assert.equal(
      persisted?.weights.some((entry) => entry.target === "promotion" && entry.decision === "promote"),
      true,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("offline utility learner ignores stale events and no-ops below minimum sample count", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-learner-window-"));
  try {
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-old-1",
      recordedAt: "2026-02-01T00:00:00.000Z",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 1,
    });
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-fresh-1",
      recordedAt: "2026-03-08T05:00:00.000Z",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 1,
    });

    const result = await learnUtilityPromotionWeights({
      memoryDir,
      enabled: true,
      now: new Date("2026-03-08T06:00:00.000Z"),
      learningWindowDays: 7,
      minEventCount: 2,
      maxWeightMagnitude: 0.35,
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, "insufficient_events");
    assert.equal(result.snapshot?.weights.length, 0);

    const persisted = await readUtilityLearningSnapshot(memoryDir);
    assert.equal(persisted?.weights.length, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("offline utility learner clears stale persisted weights when samples become insufficient", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-learner-clear-"));
  try {
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-clear-1",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 1,
    });
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-clear-2",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 0.8,
    });

    const learned = await learnUtilityPromotionWeights({
      memoryDir,
      enabled: true,
      now: new Date("2026-03-08T06:00:00.000Z"),
      learningWindowDays: 7,
      minEventCount: 2,
      maxWeightMagnitude: 0.35,
    });
    assert.equal(learned.applied, true);
    assert.equal(learned.snapshot?.weights.length, 1);

    const insufficient = await learnUtilityPromotionWeights({
      memoryDir,
      enabled: true,
      now: new Date("2026-03-08T07:00:00.000Z"),
      learningWindowDays: 7,
      minEventCount: 3,
      maxWeightMagnitude: 0.35,
    });
    assert.equal(insufficient.applied, false);
    assert.equal(insufficient.reason, "insufficient_events");
    assert.equal(insufficient.snapshot?.weights.length, 0);

    const persisted = await readUtilityLearningSnapshot(memoryDir);
    assert.equal(persisted?.weights.length, 0);
    assert.equal(persisted?.updatedAt, "2026-03-08T07:00:00.000Z");

    const status = await getUtilityLearningStatus({
      memoryDir,
      enabled: true,
      promotionByOutcomeEnabled: true,
    });
    assert.equal(status.weights.total, 0);
    assert.equal(status.weights.positive, 0);
    assert.equal(status.weights.negative, 0);
    assert.equal(status.weights.latestUpdatedAt, "2026-03-08T07:00:00.000Z");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("utility learner CLI commands short-circuit cleanly when utility learning is disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-learner-cli-"));
  try {
    const learnResult = await runUtilityLearningCliCommand({
      memoryDir,
      memoryUtilityLearningEnabled: false,
      learningWindowDays: 7,
      minEventCount: 2,
      maxWeightMagnitude: 0.35,
    });
    assert.equal(learnResult.applied, false);
    assert.equal(learnResult.reason, "disabled");

    const status = await runUtilityLearningStatusCliCommand({
      memoryDir,
      memoryUtilityLearningEnabled: false,
      promotionByOutcomeEnabled: false,
    });
    assert.equal(status.enabled, false);
    assert.equal(status.snapshot, null);
    assert.equal(status.weights.total, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("utility learner sanitizes NaN numeric inputs before persisting a snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-learner-nan-"));
  try {
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-nan-1",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 0.8,
    });
    await recordEvent(memoryDir, {
      eventId: "utility-pr30-nan-2",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 0.6,
    });

    const result = await runUtilityLearningCliCommand({
      memoryDir,
      memoryUtilityLearningEnabled: true,
      learningWindowDays: Number.NaN,
      minEventCount: Number.NaN,
      maxWeightMagnitude: Number.NaN,
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, "insufficient_events");
    assert.equal(result.snapshot?.windowDays, 14);
    assert.equal(result.snapshot?.minEventCount, 3);
    assert.equal(result.snapshot?.maxWeightMagnitude, 0.35);
    assert.equal(result.snapshot?.weights.length, 0);

    const persisted = await readUtilityLearningSnapshot(memoryDir);
    assert.equal(persisted?.weights.length, 0);
    assert.equal(persisted?.windowDays, 14);
    assert.equal(persisted?.minEventCount, 3);
    assert.equal(persisted?.maxWeightMagnitude, 0.35);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("utility learner CLI wiring registers learn and learning-status commands", async () => {
  class MockCommand {
    children = new Map<string, MockCommand>();
    actionHandler?: (...args: unknown[]) => Promise<void> | void;

    constructor(readonly name: string) {}

    command(name: string): MockCommand {
      const child = new MockCommand(name);
      this.children.set(name, child);
      return child;
    }

    description(): MockCommand {
      return this;
    }

    option(): MockCommand {
      return this;
    }

    requiredOption(): MockCommand {
      return this;
    }

    argument(): MockCommand {
      return this;
    }

    action(handler: (...args: unknown[]) => Promise<void> | void): MockCommand {
      this.actionHandler = handler;
      return this;
    }
  }

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-learner-cli-wiring-"));
  try {
    const root = new MockCommand("root");
    registerCli(
      {
        registerCli(handler: (opts: { program: MockCommand }) => void): void {
          handler({ program: root });
        },
      },
      {
        config: {
          memoryDir,
          memoryUtilityLearningEnabled: true,
          promotionByOutcomeEnabled: true,
        },
      } as never,
    );

    const engram = root.children.get("engram");
    assert.ok(engram);
    assert.equal(typeof engram?.children.get("utility-learn")?.actionHandler, "function");
    assert.equal(typeof engram?.children.get("utility-learning-status")?.actionHandler, "function");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
