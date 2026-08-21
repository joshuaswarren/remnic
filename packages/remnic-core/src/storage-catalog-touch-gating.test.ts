/**
 * Issue #1903 — state-file writes must not touch the namespace catalog.
 *
 * The post-write catalog hook (`onCatalogWrite`) fires on every successful
 * secure-file write. Pure state files (`state/buffer.json`, ledgers, indexes)
 * are NOT namespace memory data, so by default their writes must be excluded
 * from the catalog touch path (they were the dominant source of catalog churn
 * that grew `state/namespaces.jsonl` unbounded). Namespace data writes
 * (`facts/`, ...) still touch. The `touchStateWrites` opt-in restores the
 * pre-#1903 behavior where every write touched.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager } from "./storage.js";
import type { BufferState } from "./types.js";

async function mkDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "remnic-touch-gate-"));
}

function emptyBuffer(): BufferState {
  return { turns: [], lastExtractionAt: null, extractionCount: 0 };
}

test("#1903 state-file writes do not touch the catalog by default; data writes do", async () => {
  const dir = await mkDir();
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    let touches = 0;
    storage.onCatalogWrite = () => {
      touches += 1;
    };

    // A pure state-file write (state/buffer.json) must NOT touch the catalog.
    await storage.saveBuffer(emptyBuffer());
    assert.equal(touches, 0, "saving buffer.json (a state file) records no catalog touch");

    // A namespace-data write (facts/) MUST touch exactly once. The lifecycle
    // ledger append it also performs is a state write and stays excluded.
    touches = 0;
    await storage.writeMemory("fact", "The database is PostgreSQL.", { confidence: 0.9 });
    assert.equal(touches, 1, "writing a fact records exactly one catalog touch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1903 touchStateWrites=true restores the state-file catalog touch", async () => {
  const dir = await mkDir();
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    storage.touchStateWrites = true;
    let touches = 0;
    storage.onCatalogWrite = () => {
      touches += 1;
    };

    await storage.saveBuffer(emptyBuffer());
    assert.ok(touches >= 1, "with touchStateWrites enabled, saving buffer.json touches the catalog");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
