import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyCommitmentLedgerLifecycle,
  recordCommitmentLedgerEntry,
  type CommitmentLedgerEntry,
} from "./commitment-ledger.js";

function makeEntry(overrides: Partial<CommitmentLedgerEntry> = {}): CommitmentLedgerEntry {
  return {
    schemaVersion: 1,
    entryId: "commitment-1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    sessionKey: "session-1",
    source: "manual",
    kind: "promise",
    state: "fulfilled",
    scope: "test",
    summary: "ship the thing",
    stateChangedAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("commitment ledger lifecycle rejects invalid decayDays without deleting entries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-commitment-decay-"));
  try {
    const filePath = await recordCommitmentLedgerEntry({
      memoryDir,
      entry: makeEntry(),
    });

    for (const decayDays of [-1, 0, 1.5, Number.NaN, Infinity]) {
      await assert.rejects(
        () =>
          applyCommitmentLedgerLifecycle({
            memoryDir,
            enabled: true,
            decayDays,
            now: "2026-01-02T00:00:00.000Z",
          }),
        /decayDays must be an integer greater than or equal to 1/,
        `invalid decayDays ${String(decayDays)} should throw`,
      );
      await assert.doesNotReject(() => stat(filePath));
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("commitment ledger lifecycle still deletes resolved entries past positive decayDays", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-commitment-decay-"));
  try {
    const filePath = await recordCommitmentLedgerEntry({
      memoryDir,
      entry: makeEntry(),
    });

    const result = await applyCommitmentLedgerLifecycle({
      memoryDir,
      enabled: true,
      decayDays: 1,
      now: "2026-01-03T00:00:00.000Z",
    });

    assert.equal(result.deletedResolved.length, 1);
    assert.equal(result.deletedResolved[0]?.entryId, "commitment-1");
    await assert.rejects(() => stat(filePath), /ENOENT/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
