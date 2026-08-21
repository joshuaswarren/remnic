/**
 * Dreams-ledger maintenance subject for the scenario-matrix harness.
 *
 * Manual dry-runs are side-effect free by contract; every canonical lifecycle
 * row verifies that contract and that phase telemetry remains well formed.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDreamsPhase, type DreamsPhase, type DreamsRunResultInternal } from "../../maintenance/dreams-ledger.js";
import {
  type LifecycleSubject,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

interface DreamsLedgerState {
  memoryDir: string;
  phase: DreamsPhase;
  before: string | null;
  result: DreamsRunResultInternal | null;
}

const PHASES: readonly DreamsPhase[] = ["lightSleep", "rem", "deepSleep"];

const subject: LifecycleSubject<DreamsLedgerState> = {
  async setup(row): Promise<DreamsLedgerState> {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-dreams-subject-"));
    const phase = PHASES[row.dimensions.flush === "compaction" ? 2 : 0] ?? "lightSleep";
    return { memoryDir, phase, before: null, result: null };
  },

  async exercise(state): Promise<void> {
    const ledgerPath = path.join(state.memoryDir, "state", "dreams-ledger.jsonl");
    try {
      state.before = await readFile(ledgerPath, "utf8");
    } catch {
      state.before = null;
    }
    state.result = await runDreamsPhase({
      memoryDir: state.memoryDir,
      phase: state.phase,
      dryRun: true,
    });
  },

  async invariants(state): Promise<void> {
    assert.ok(state.result);
    assert.equal(state.result.phase, state.phase);
    assert.equal(typeof state.result.durationMs, "number");
    assert.equal(state.result.dryRun, true);
    const ledgerPath = path.join(state.memoryDir, "state", "dreams-ledger.jsonl");
    let after: string | null = null;
    try {
      after = await readFile(ledgerPath, "utf8");
    } catch {
      after = null;
    }
    assert.equal(after, state.before, "dry-run must not append a ledger entry");
  },

  async teardown(state): Promise<void> {
    await rm(state.memoryDir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("dreams-ledger", subject);
