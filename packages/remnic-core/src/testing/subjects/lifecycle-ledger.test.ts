/**
 * Lifecycle-ledger maintenance subject for the scenario-matrix harness.
 *
 * Each canonical row runs the real append, rebuild, and read paths. The
 * scenario dimensions are intentionally orthogonal to this append-only
 * subsystem, so the same durable ledger invariant applies to every row.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { rebuildMemoryLifecycleLedger } from "../../maintenance/rebuild-memory-lifecycle-ledger.js";
import { runRebuildMemoryLifecycleLedgerCliCommand } from "../../maintenance/rebuild-memory-lifecycle-ledger-cli.js";
import {
  appendLifecycleEventsSerialized,
  readAllLifecycleEventsFromLedger,
} from "../../storage/memory-lifecycle-ledger-access.js";
import type { MemoryLifecycleEvent } from "../../types.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

interface LifecycleLedgerState {
  memoryDir: string;
  ledgerPath: string;
  event: MemoryLifecycleEvent;
}

function eventFor(row: MatrixRow): MemoryLifecycleEvent {
  return {
    eventId: `matrix-${row.id}`,
    memoryId: "matrix-memory",
    eventType: "explicit_capture_accepted",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "lifecycle-matrix",
    ruleVersion: "test-v1",
  };
}

const subject: LifecycleSubject<LifecycleLedgerState> = {
  async setup(row): Promise<LifecycleLedgerState> {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-lifecycle-subject-"));
    const ledgerPath = path.join(memoryDir, "state", "memory-lifecycle-ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    return { memoryDir, ledgerPath, event: eventFor(row) };
  },

  async exercise(state): Promise<void> {
    const payload = `${JSON.stringify(state.event)}\n`;
    await appendLifecycleEventsSerialized(
      state.ledgerPath,
      async (appendPayload) => {
        await writeFile(state.ledgerPath, appendPayload, "utf8");
      },
      payload,
    );

    const rebuild = await rebuildMemoryLifecycleLedger({
      memoryDir: state.memoryDir,
      dryRun: true,
      preserveExistingEvents: true,
    });
    assert.equal(rebuild.dryRun, true);
    const cliRebuild = await runRebuildMemoryLifecycleLedgerCliCommand({
      memoryDir: state.memoryDir,
      write: false,
    });
    assert.equal(cliRebuild.dryRun, true);

    const rows = await readAllLifecycleEventsFromLedger(
      state.ledgerPath,
      async (filePath) => readFile(filePath, "utf8"),
    );
    assert.deepEqual(rows, [state.event]);
  },

  async invariants(state): Promise<void> {
    const rows = await readAllLifecycleEventsFromLedger(
      state.ledgerPath,
      async (filePath) => readFile(filePath, "utf8"),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.eventId, state.event.eventId);
  },

  async teardown(state): Promise<void> {
    await rm(state.memoryDir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("lifecycle-ledger", subject);
