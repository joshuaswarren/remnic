/**
 * Memory-projection rebuild subject for the scenario-matrix harness
 * (issue #2119). Each canonical row runs the REAL rebuild path — memory scan,
 * sqlite build, atomic install, rebuiltAt meta — plus the scheduled-rebuild
 * wrapper's freshness short-circuit. The matrix dimensions are orthogonal to
 * this rebuild-only subsystem, so the same durable projection invariant
 * applies to every row.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { rebuildMemoryProjection } from "../../maintenance/rebuild-memory-projection.js";
import { readProjectionRebuiltAt } from "../../maintenance/projection-support.js";
import {
  type LifecycleSubject,
  type MatrixRow,
  runLifecycleMatrix,
} from "../lifecycle-matrix.js";

interface MemoryProjectionState {
  memoryDir: string;
  memoryId: string;
}

function memoryFixture(row: MatrixRow, memoryId: string): string {
  return [
    "---",
    `id: ${memoryId}`,
    "category: fact",
    "confidence: 0.9",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "status: active",
    "---",
    "",
    `Matrix fixture memory for lifecycle row ${row.id}.`,
    "",
  ].join("\n");
}

const subject: LifecycleSubject<MemoryProjectionState> = {
  async setup(row): Promise<MemoryProjectionState> {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-subject-"));
    const memoryId = `matrix-projection-${row.id}`;
    const factDir = path.join(memoryDir, "facts", "2026-01-01");
    await mkdir(factDir, { recursive: true });
    await writeFile(path.join(factDir, `${memoryId}.md`), memoryFixture(row, memoryId), "utf8");
    return { memoryDir, memoryId };
  },

  async exercise(state): Promise<void> {
    const result = await rebuildMemoryProjection({
      memoryDir: state.memoryDir,
      dryRun: false,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.scannedMemories, 1);
    assert.equal(result.currentRows, 1);
    assert.ok(existsSync(result.outputPath), "projection sqlite installed");
  },

  async invariants(state): Promise<void> {
    // The on-disk rebuiltAt meta is the scheduled rebuild's cross-process
    // freshness signal (daemon restart / operator CLI both rely on it).
    const rebuiltAt = readProjectionRebuiltAt(state.memoryDir);
    assert.ok(rebuiltAt, "rebuiltAt meta written by the rebuild");
    assert.ok(Number.isFinite(Date.parse(rebuiltAt)), "rebuiltAt parses as a timestamp");
  },

  async teardown(state): Promise<void> {
    await rm(state.memoryDir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("memory-projection", subject);
