/**
 * Recognition-index write-path subject for the scenario-matrix harness
 * (issue #2975).
 *
 * Every canonical row drives the real maintainRecognitionIndexAfterWrite
 * seam twice: gate off (zero index I/O, no index file) and gate on
 * (the write's id is visible to loadRecognitionIndex). Restart rows
 * reload from disk; replay rows prove an id upsert is idempotent.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";

import { loadRecognitionIndex, recognitionIndexPath } from "../../recall-recognition-tier.js";
import { maintainRecognitionIndexAfterWrite } from "../../orchestration/recall-recognition-index.js";
import { type LifecycleSubject, type MatrixRow, runLifecycleMatrix } from "../lifecycle-matrix.js";

interface IndexState {
  rowId: string;
  dir: string;
  restart: boolean;
  dedupeOrReplay: boolean;
}

const subject: LifecycleSubject<IndexState> = {
  async setup(row: MatrixRow): Promise<IndexState> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-recognition-index-subject-"));
    return {
      rowId: String(row.id),
      dir,
      restart: row.dimensions.restart,
      dedupeOrReplay: row.dimensions.dedupeOrReplay,
    };
  },

  async exercise(state): Promise<void> {
    const id = `fact-${state.rowId}`;
    await maintainRecognitionIndexAfterWrite({
      memoryDir: state.dir,
      enabled: false,
      changes: [{ action: "upsert", id, content: `off-path body for ${state.rowId}` }],
    });
    assert.equal(await loadRecognitionIndex(state.dir), null);
    try {
      await fsp.access(recognitionIndexPath(state.dir));
      assert.fail("off-path must not create the recognition index file");
    } catch (err) {
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
    }

    await maintainRecognitionIndexAfterWrite({
      memoryDir: state.dir,
      enabled: true,
      changes: [{ action: "upsert", id, content: `SSD inference chips — ${state.rowId}\nbody` }],
    });
    if (state.dedupeOrReplay) {
      await maintainRecognitionIndexAfterWrite({
        memoryDir: state.dir,
        enabled: true,
        changes: [{ action: "upsert", id, content: `SSD inference chips — ${state.rowId} replayed\nbody` }],
      });
    }
  },

  async invariants(state): Promise<void> {
    const id = `fact-${state.rowId}`;
    const index = await loadRecognitionIndex(state.dir);
    assert.ok(index, "enabled write must persist an index loadable after the row");
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0]?.id, id);
    const expected = state.dedupeOrReplay
      ? `SSD inference chips — ${state.rowId} replayed`
      : `SSD inference chips — ${state.rowId}`;
    assert.equal(index.entries[0]?.description, expected);

    if (state.restart) {
      const reloaded = await loadRecognitionIndex(state.dir);
      assert.deepEqual(reloaded, index, "restart must see the same on-disk index");
    }

    const before = { ...index };
    await maintainRecognitionIndexAfterWrite({
      memoryDir: state.dir,
      enabled: false,
      changes: [{ action: "remove", id }],
    });
    assert.deepEqual(await loadRecognitionIndex(state.dir), before, "off-path after on-path must not mutate the index");
  },

  async teardown(state): Promise<void> {
    await rm(state.dir, { recursive: true, force: true });
  },
};

runLifecycleMatrix("recall-recognition-index", subject);
