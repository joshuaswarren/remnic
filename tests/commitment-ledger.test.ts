import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  applyCommitmentLedgerLifecycle,
  getCommitmentLedgerStatus,
  recordCommitmentLedgerEntry,
  resolveCommitmentLedgerDir,
  transitionCommitmentLedgerEntryState,
  validateCommitmentLedgerEntry,
} from "../src/commitment-ledger.js";
import {
  runCommitmentLifecycleCliCommand,
  registerCli,
  runCommitmentRecordCliCommand,
  runCommitmentSetStateCliCommand,
  runCommitmentStatusCliCommand,
} from "../src/cli.js";

test("commitment ledger path resolves under memoryDir by default", () => {
  assert.equal(
    resolveCommitmentLedgerDir("/tmp/engram-memory"),
    path.join("/tmp/engram-memory", "state", "commitment-ledger"),
  );
});

test("validateCommitmentLedgerEntry accepts the normalized contract", () => {
  const entry = validateCommitmentLedgerEntry({
    schemaVersion: 1,
    entryId: "commitment-pr25-follow-up",
    recordedAt: "2026-03-08T02:16:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "follow_up",
    state: "open",
    scope: "openclaw-engram roadmap",
    summary: "Follow up with the next PR slice for commitment memory.",
    dueAt: "2026-03-09T12:00:00.000Z",
    entityRefs: ["repo:openclaw-engram"],
    workProductEntryRefs: ["wp-readme-guide"],
    objectiveStateSnapshotRefs: ["snap-roadmap"],
    tags: ["creation-memory", "commitments"],
    metadata: { owner: "engram" },
  });

  assert.equal(entry.kind, "follow_up");
  assert.equal(entry.state, "open");
  assert.equal(entry.dueAt, "2026-03-09T12:00:00.000Z");
});

test("validateCommitmentLedgerEntry reports dueAt field name on invalid due timestamp", () => {
  assert.throws(
    () => validateCommitmentLedgerEntry({
      schemaVersion: 1,
      entryId: "commitment-bad-due",
      recordedAt: "2026-03-08T02:16:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "deadline",
      state: "open",
      scope: "bad dueAt",
      summary: "This entry carries an invalid due timestamp.",
      dueAt: "tomorrow morning",
    }),
    /dueAt must be an ISO timestamp/,
  );
});

test("recordCommitmentLedgerEntry persists entries into dated storage", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-record-"));
  const filePath = await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr25-1",
      recordedAt: "2026-03-08T02:17:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "deadline",
      state: "open",
      scope: "PR25",
      summary: "Ship the commitment ledger slice.",
      dueAt: "2026-03-08T05:00:00.000Z",
      tags: ["deadline"],
    },
  });

  assert.equal(
    filePath,
    path.join(memoryDir, "state", "commitment-ledger", "entries", "2026-03-08", "commitment-pr25-1.json"),
  );
});

test("commitment ledger status reports valid and invalid entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-status-"));
  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr25-2",
      recordedAt: "2026-03-08T02:18:00.000Z",
      sessionKey: "agent:main",
      source: "tool_result",
      kind: "promise",
      state: "open",
      scope: "public docs",
      summary: "Document contribution workflow after the slice merges.",
      tags: ["docs"],
    },
  });
  const invalidPath = path.join(
    memoryDir,
    "state",
    "commitment-ledger",
    "entries",
    "2026-03-08",
    "invalid.json",
  );
  await writeFile(invalidPath, JSON.stringify({ schemaVersion: 1, entryId: "" }, null, 2), "utf8");

  const status = await getCommitmentLedgerStatus({
    memoryDir,
    enabled: true,
  });

  assert.equal(status.enabled, true);
  assert.equal(status.entries.total, 2);
  assert.equal(status.entries.valid, 1);
  assert.equal(status.entries.invalid, 1);
  assert.equal(status.entries.byKind.promise, 1);
  assert.equal(status.entries.byState.open, 1);
  assert.equal(status.latestEntry?.entryId, "commitment-pr25-2");
  assert.match(status.invalidEntries[0]?.path ?? "", /invalid\.json$/);
});

test("commitment-record CLI command writes entries only when commitment ledger is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-cli-record-"));

  const skipped = await runCommitmentRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: false,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-skip",
      recordedAt: "2026-03-08T02:19:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "skip",
      summary: "Would have written a commitment entry.",
    },
  });
  assert.equal(skipped, null);

  const filePath = await runCommitmentRecordCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr25-3",
      recordedAt: "2026-03-08T02:20:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "next slice",
      summary: "Start the fulfillment/lifecycle integration slice.",
      tags: ["next"],
    },
  });

  assert.match(filePath ?? "", /commitment-pr25-3\.json$/);

  const status = await runCommitmentStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "commitment-pr25-3");
});

test("commitment-record CLI wiring records entries through command registration", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-cli-wiring-"));

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
        commitmentLedgerDir: path.join(memoryDir, "state", "commitment-ledger"),
        creationMemoryEnabled: true,
        commitmentLedgerEnabled: true,
      },
    } as never,
  );

  const action = root.children.get("engram")?.children.get("commitment-record")?.actionHandler;
  assert.equal(typeof action, "function");

  await action?.({
    entryId: "commitment-pr25-4",
    recordedAt: "2026-03-08T02:21:00.000Z",
    sessionKey: "agent:main",
    source: "cli",
    kind: "promise",
    state: "open",
    scope: "promise scope",
    summary: "Keep PR slices small and feature-flagged.",
    tag: ["process"],
  });

  const status = await runCommitmentStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
  });
  assert.equal(status.entries.total, 1);
  assert.equal(status.latestEntry?.entryId, "commitment-pr25-4");
  assert.equal(status.latestEntry?.kind, "promise");
});

test("commitment-set-state CLI command updates an existing entry when lifecycle is enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-state-"));

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-1",
      recordedAt: "2026-03-08T03:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "fulfillment",
      summary: "Close the loop on commitment lifecycle.",
    },
  });

  const skipped = await runCommitmentSetStateCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    commitmentLifecycleEnabled: false,
    entryId: "commitment-pr26-1",
    nextState: "fulfilled",
    changedAt: "2026-03-08T04:00:00.000Z",
  });
  assert.equal(skipped, null);

  const updated = await runCommitmentSetStateCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    commitmentLifecycleEnabled: true,
    entryId: "commitment-pr26-1",
    nextState: "fulfilled",
    changedAt: "2026-03-08T04:00:00.000Z",
  });

  assert.equal(updated?.state, "fulfilled");
  assert.equal(updated?.resolvedAt, "2026-03-08T04:00:00.000Z");
  assert.equal(updated?.stateChangedAt, "2026-03-08T04:00:00.000Z");
});

test("commitment ledger status reports overdue stale and decay-eligible lifecycle counts", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-lifecycle-status-"));

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-overdue",
      recordedAt: "2026-03-01T00:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "deadline",
      state: "open",
      scope: "overdue",
      summary: "Past due commitment",
      dueAt: "2026-03-02T00:00:00.000Z",
    },
  });

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-stale",
      recordedAt: "2026-03-01T00:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "follow_up",
      state: "open",
      scope: "stale",
      summary: "Open commitment with no due date",
    },
  });

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-resolved",
      recordedAt: "2026-03-01T00:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "promise",
      state: "fulfilled",
      scope: "resolved",
      summary: "Resolved commitment past decay threshold",
      resolvedAt: "2026-03-03T00:00:00.000Z",
      stateChangedAt: "2026-03-03T00:00:00.000Z",
    },
  });

  const status = await runCommitmentStatusCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    commitmentLifecycleEnabled: true,
    commitmentStaleDays: 5,
    commitmentDecayDays: 2,
    now: "2026-03-08T00:00:00.000Z",
  });

  assert.equal(status.lifecycle?.overdueOpen, 1);
  assert.equal(status.lifecycle?.staleOpen, 1);
  assert.equal(status.lifecycle?.decayEligibleResolved, 1);
});

test("applyCommitmentLedgerLifecycle expires overdue commitments and removes aged resolved entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-lifecycle-run-"));

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-expire",
      recordedAt: "2026-03-01T00:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "deadline",
      state: "open",
      scope: "expire",
      summary: "Automatically expire overdue commitment.",
      dueAt: "2026-03-02T00:00:00.000Z",
    },
  });

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-clean",
      recordedAt: "2026-03-01T00:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "promise",
      state: "fulfilled",
      scope: "cleanup",
      summary: "Remove aged resolved entry.",
      resolvedAt: "2026-03-02T00:00:00.000Z",
      stateChangedAt: "2026-03-02T00:00:00.000Z",
    },
  });

  const lifecycle = await applyCommitmentLedgerLifecycle({
    memoryDir,
    enabled: true,
    decayDays: 3,
    now: "2026-03-08T00:00:00.000Z",
  });

  assert.equal(lifecycle.transitionedToExpired.length, 1);
  assert.equal(lifecycle.transitionedToExpired[0]?.entryId, "commitment-pr26-expire");
  assert.equal(lifecycle.deletedResolved.length, 1);
  assert.equal(lifecycle.deletedResolved[0]?.entryId, "commitment-pr26-clean");

  const status = await getCommitmentLedgerStatus({
    memoryDir,
    enabled: true,
    lifecycleEnabled: true,
    staleDays: 5,
    decayDays: 3,
    now: "2026-03-08T00:00:00.000Z",
  });

  assert.equal(status.entries.byState.expired, 1);
  assert.equal(status.entries.total, 1);
});

test("commitment lifecycle CLI command runs lifecycle pass only when enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-commitment-lifecycle-cli-"));

  await recordCommitmentLedgerEntry({
    memoryDir,
    entry: {
      schemaVersion: 1,
      entryId: "commitment-pr26-cli",
      recordedAt: "2026-03-01T00:00:00.000Z",
      sessionKey: "agent:main",
      source: "cli",
      kind: "deadline",
      state: "open",
      scope: "cli",
      summary: "Lifecycle runner should expire this when enabled.",
      dueAt: "2026-03-02T00:00:00.000Z",
    },
  });

  const skipped = await runCommitmentLifecycleCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    commitmentLifecycleEnabled: false,
    commitmentDecayDays: 3,
    now: "2026-03-08T00:00:00.000Z",
  });
  assert.equal(skipped, null);

  const applied = await runCommitmentLifecycleCliCommand({
    memoryDir,
    creationMemoryEnabled: true,
    commitmentLedgerEnabled: true,
    commitmentLifecycleEnabled: true,
    commitmentDecayDays: 3,
    now: "2026-03-08T00:00:00.000Z",
  });
  assert.equal(applied?.transitionedToExpired[0]?.entryId, "commitment-pr26-cli");
});
