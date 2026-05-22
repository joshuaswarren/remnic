import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  getUtilityTelemetryStatus,
  readUtilityTelemetryEvents,
  recordUtilityTelemetryEvent,
  resolveUtilityTelemetryDir,
  validateUtilityTelemetryEvent,
} from "../src/utility-telemetry.js";
import {
  registerCli,
  runUtilityTelemetryRecordCliCommand,
  runUtilityTelemetryStatusCliCommand,
} from "../src/cli.js";

test("utility telemetry path resolves under memoryDir by default", () => {
  assert.equal(
    resolveUtilityTelemetryDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "utility-telemetry"),
  );
});

test("validateUtilityTelemetryEvent accepts the normalized contract", () => {
  const entry = validateUtilityTelemetryEvent({
    schemaVersion: 1,
    eventId: "utility-pr29-1",
    recordedAt: "2026-03-08T03:45:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    target: "promotion",
    decision: "promote",
    outcome: "helpful",
    utilityScore: 0.8,
    summary: "Promoting the verified rule improved downstream recall utility.",
    memoryIds: ["memory-1", "memory-2"],
    entityRefs: ["repo:openclaw-engram"],
    tags: ["utility-learning", "promotion"],
    metadata: { benchmark: "ama-memory-pack" },
  });

  assert.equal(entry.target, "promotion");
  assert.equal(entry.decision, "promote");
  assert.equal(entry.outcome, "helpful");
  assert.equal(entry.utilityScore, 0.8);
});

test("recordUtilityTelemetryEvent persists entries into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-telemetry-record-"));
  const filePath = await recordUtilityTelemetryEvent({
    memoryDir,
    event: {
      schemaVersion: 1,
      eventId: "utility-pr29-2",
      recordedAt: "2026-03-08T03:46:00.000Z",
      sessionKey: "agent:main",
      source: "system",
      target: "ranking",
      decision: "boost",
      outcome: "helpful",
      utilityScore: 0.6,
      summary: "Boosting the causal trajectory result improved the recovery bundle ranking.",
      memoryIds: ["memory-3"],
      tags: ["ranking"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "utility-telemetry", "events", "2026-03-08", "utility-pr29-2.json"),
  );
});

test("recordUtilityTelemetryEvent rejects duplicate ids without overwriting the original event", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-telemetry-duplicate-"));
  const filePath = await recordUtilityTelemetryEvent({
    memoryDir,
    event: {
      schemaVersion: 1,
      eventId: "utility-duplicate",
      recordedAt: "2026-03-08T03:46:00.000Z",
      sessionKey: "agent:main",
      source: "system",
      target: "ranking",
      decision: "boost",
      outcome: "helpful",
      utilityScore: 0.6,
      summary: "Original utility event.",
    },
  });

  await assert.rejects(
    () =>
      recordUtilityTelemetryEvent({
        memoryDir,
        event: {
          schemaVersion: 1,
          eventId: "utility-duplicate",
          recordedAt: "2026-03-08T03:46:30.000Z",
          sessionKey: "agent:main",
          source: "system",
          target: "ranking",
          decision: "suppress",
          outcome: "harmful",
          utilityScore: -0.6,
          summary: "Replacement utility event.",
        },
      }),
    /EEXIST|exists/i,
  );

  const stored = JSON.parse(await readFile(filePath, "utf8")) as { summary: string };
  assert.equal(stored.summary, "Original utility event.");
});

test("utility telemetry status reports valid and invalid entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-telemetry-status-"));
  await recordUtilityTelemetryEvent({
    memoryDir,
    event: {
      schemaVersion: 1,
      eventId: "utility-pr29-3",
      recordedAt: "2026-03-08T03:47:00.000Z",
      sessionKey: "agent:main",
      source: "benchmark",
      target: "promotion",
      decision: "hold",
      outcome: "neutral",
      utilityScore: 0,
      summary: "The benchmark run found no measurable utility change for this promotion decision.",
      tags: ["benchmark"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "utility-telemetry",
    "events",
    "2026-03-08",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, eventId: "" }, null, 2), "utf8");

  const status = await getUtilityTelemetryStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.events.total, 2);
  assert.equal(status.events.valid, 1);
  assert.equal(status.events.invalid, 1);
  assert.equal(status.events.byTarget.promotion, 1);
  assert.equal(status.events.byDecision.hold, 1);
  assert.equal(status.events.byOutcome.neutral, 1);
  assert.equal(status.latestEvent?.eventId, "utility-pr29-3");
  assert.match(status.invalidEvents[0]?.path ?? "", /invalid\.json$/);
});

test("readUtilityTelemetryEvents returns valid events while surfacing invalid files", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-telemetry-read-"));
  await recordUtilityTelemetryEvent({
    memoryDir,
    event: {
      schemaVersion: 1,
      eventId: "utility-pr29-read-1",
      recordedAt: "2026-03-08T03:47:00.000Z",
      sessionKey: "agent:main",
      source: "benchmark",
      target: "promotion",
      decision: "hold",
      outcome: "neutral",
      utilityScore: 0,
      summary: "The benchmark run found no measurable utility change for this promotion decision.",
      tags: ["benchmark"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "utility-telemetry",
    "events",
    "2026-03-08",
    "invalid-read.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, eventId: "" }, null, 2), "utf8");

  const events = await readUtilityTelemetryEvents({ memoryDir });

  assert.equal(events.files.length, 2);
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0]?.eventId, "utility-pr29-read-1");
  assert.equal(events.invalidEvents.length, 1);
  assert.match(events.invalidEvents[0]?.path ?? "", /invalid-read\.json$/);
});

test("utility telemetry CLI commands write and report only when the feature is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-telemetry-cli-"));

  const skipped = await runUtilityTelemetryRecordCliCommand({
    memoryDir,
    memoryUtilityLearningEnabled: false,
    event: {
      schemaVersion: 1,
      eventId: "utility-skip",
      recordedAt: "2026-03-08T03:48:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      target: "promotion",
      decision: "promote",
      outcome: "helpful",
      utilityScore: 1,
      summary: "Would have recorded a utility event.",
    },
  });
  assert.equal(skipped, null);

  const disabledStatus = await runUtilityTelemetryStatusCliCommand({
    memoryDir,
    memoryUtilityLearningEnabled: false,
    promotionByOutcomeEnabled: false,
  });
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.events.total, 0);
  assert.equal(disabledStatus.events.valid, 0);
  assert.equal(disabledStatus.events.invalid, 0);
  assert.equal(disabledStatus.promotionByOutcomeEnabled, false);
  assert.equal(disabledStatus.latestEvent, undefined);

  const filePath = await runUtilityTelemetryRecordCliCommand({
    memoryDir,
    memoryUtilityLearningEnabled: true,
    event: {
      schemaVersion: 1,
      eventId: "utility-pr29-4",
      recordedAt: "2026-03-08T03:49:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      target: "ranking",
      decision: "suppress",
      outcome: "harmful",
      utilityScore: -0.7,
      summary: "Suppressing the stale memory harmed answer quality and should reduce future weight.",
      memoryIds: ["memory-9"],
      tags: ["ranking"],
    },
  });
  assert.match(filePath ?? "", /utility-pr29-4\.json$/);

  const status = await runUtilityTelemetryStatusCliCommand({
    memoryDir,
    memoryUtilityLearningEnabled: true,
    promotionByOutcomeEnabled: true,
  });
  assert.equal(status.enabled, true);
  assert.equal(status.promotionByOutcomeEnabled, true);
  assert.equal(status.events.total, 1);
  assert.equal(status.latestEvent?.eventId, "utility-pr29-4");
});

test("utility-telemetry CLI wiring registers the status and record commands", async () => {
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

  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-utility-telemetry-cli-wiring-"));
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
  assert.equal(typeof engram?.children.get("utility-status")?.actionHandler, "function");
  assert.equal(typeof engram?.children.get("utility-record")?.actionHandler, "function");
});
