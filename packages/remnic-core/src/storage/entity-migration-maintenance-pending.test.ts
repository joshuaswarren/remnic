import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StorageManager, normalizeEntityName } from "../storage.js";
import { drainMaintenanceSettlements, writeMaintenancePending } from "./entity-migration-maintenance-pending.js";

// Issue #3286: a crash between the reference rewrite and the completion hook
// must not leave the QMD index stale. A "maintenance pending" marker beside the
// migration journal makes the next startup's no-op replay fire the hook once.
const MAINTENANCE_PENDING_PREFIX = "entity-canonical-id-maintenance.pending";

/** Pending-marker files currently on disk (temp files excluded). */
async function pendingMarkers(dir: string): Promise<string[]> {
  return (await readdir(path.join(dir, "state")))
    .filter((name) => name.startsWith(MAINTENANCE_PENDING_PREFIX) && !name.endsWith(".tmp"));
}

interface SeededCorpus {
  dir: string;
  legacy: string;
  canonical: string;
}

/**
 * Seed a corpus with one legacy-typed entity file and one memory referencing
 * it by the legacy id, so a later run has a real rewrite to perform. The
 * legacy file keeps its old id as the filename while its `Type:` was retyped —
 * the production legacy shape (see entity-canonical-id-collision.test.ts).
 */
async function seedLegacyCorpus(): Promise<SeededCorpus> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-3286-pending-"));
  // Create the directory skeleton (facts/ is date-partitioned on write, so
  // the raw file below lands in a directory ensureDirectories has made).
  await new StorageManager(dir).ensureDirectories();
  const name = "Nightly Ingest";
  const legacy = normalizeEntityName(name, "automation");
  const canonical = normalizeEntityName(name, "automation-cron-job");
  assert.notEqual(legacy, canonical, "fixture must actually straddle the rename");
  await writeFile(
    path.join(dir, "entities", `${legacy}.md`),
    `---\nid: ${legacy}\ncreated: 2026-03-01T00:00:00.000Z\nupdated: 2026-03-01T00:00:00.000Z\n---\n\n`
    + `# ${name}\n\n**Type:** automation-cron-job\n\nRuns at 02:00.\n`,
    "utf8",
  );
  // Seed the memory file fully raw with the legacy entityRef: writeMemoryFrontmatter
  // would canonicalize the ref through the journal this pass is about to build,
  // and a raw edit after a cached read would serve the stale parse (the corpus
  // version only moves on managed writes).
  const memoryPath = path.join(dir, "facts", new Date().toISOString().slice(0, 10), "note-3286.md");
  await writeFile(
    memoryPath,
    [
      "---",
      "id: fact-3286-note",
      "category: fact",
      "created: 2026-03-01T00:00:00.000Z",
      "updated: 2026-03-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.8",
      "confidenceTier: implied",
      "tags: []",
      `entityRef: ${legacy}`,
      "---",
      "",
      `References [[${legacy}]].`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { dir, legacy, canonical };
}

function countHook(storage: StorageManager, counter: { calls: number }, throwFirstTime = false): void {
  storage.onEntityMigrationComplete = () => {
    counter.calls += 1;
    if (throwFirstTime && counter.calls === 1) throw new Error("simulated crash before maintenance was requested");
  };
}

test("a crash after the rewrite but before the hook fires the hook once on the next no-op startup", async () => {
  const { dir } = await seedLegacyCorpus();
  const hook = { calls: 0 };
  try {
    // Pass 1: the migration rewrites; the hook throws to emulate the crash
    // between the rewrite and maintenance being requested.
    const first = new StorageManager(dir);
    countHook(first, hook, true);
    await first.ensureDirectories();
    await first.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 1, "precondition: the rewriting pass reached the hook");

    // Pass 2: a fresh manager replays a no-op journal; the pending marker
    // must fire the hook exactly once, then clear itself.
    const second = new StorageManager(dir);
    countHook(second, hook);
    await second.ensureDirectories();
    await second.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 2, "the no-op replay must fire the hook once via the pending marker");
    assert.equal((await pendingMarkers(dir)).length, 0, "the marker must clear after the hook");

    // Pass 3: ordinary no-op startup stays quiet.
    const third = new StorageManager(dir);
    countHook(third, hook);
    await third.ensureDirectories();
    await third.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 2, "a no-op startup after the marker is cleared must not fire the hook");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rewriting pass with a healthy hook leaves no pending marker", async () => {
  const { dir, legacy, canonical } = await seedLegacyCorpus();
  const hook = { calls: 0 };
  try {
    const storage = new StorageManager(dir);
    countHook(storage, hook);
    await storage.ensureDirectories();
    await storage.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 1);
    assert.equal((await pendingMarkers(dir)).length, 0);
    const journal = JSON.parse(
      await readFile(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), "utf8"),
    );
    assert.equal(journal.complete, true, "precondition: the journal completed");
    await assert.rejects(() => readFile(path.join(dir, "entities", `${legacy}.md`), "utf8"));
    await readFile(path.join(dir, "entities", `${canonical}.md`), "utf8");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
test("a process with no hook wired keeps the marker so a later wired start fires once", async () => {
  const { dir } = await seedLegacyCorpus();
  const hook = { calls: 0 };
  try {
    // A CLI-only process runs the rewrite with nothing to request maintenance.
    const bare = new StorageManager(dir);
    await bare.ensureDirectories();
    await bare.drainEntityCanonicalIdMigration();
    assert.equal((await pendingMarkers(dir)).length, 1, "no hook: the owed re-index must persist");

    const wired = new StorageManager(dir);
    countHook(wired, hook);
    await wired.ensureDirectories();
    await wired.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 1);
    assert.equal((await pendingMarkers(dir)).length, 0);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hook that refuses the request (shutdown) keeps the marker for the next start", async () => {
  const { dir } = await seedLegacyCorpus();
  const hook = { calls: 0 };
  try {
    const stopping = new StorageManager(dir);
    stopping.onEntityMigrationComplete = () => {
      hook.calls += 1;
      return false;
    };
    await stopping.ensureDirectories();
    await stopping.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 1);
    assert.equal((await pendingMarkers(dir)).length, 1, "a refused request must stay owed");

    const next = new StorageManager(dir);
    countHook(next, hook);
    await next.ensureDirectories();
    await next.drainEntityCanonicalIdMigration();
    assert.equal(hook.calls, 2);
    assert.equal((await pendingMarkers(dir)).length, 0);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an async hook keeps the marker until its maintenance pass is served, and keeps it when that fails", async () => {
  const { dir } = await seedLegacyCorpus();
  try {
    // The real hook only ARMS a debounced timer; its promise settles when the
    // pass has run. Clearing at request time would lose the re-index to a crash
    // or destroy() inside the debounce window (review finding on #3287).
    const served = Promise.withResolvers<boolean>();
    const first = new StorageManager(dir);
    first.onEntityMigrationComplete = () => served.promise;
    await first.ensureDirectories();
    await first.drainEntityCanonicalIdMigration();
    assert.equal((await pendingMarkers(dir)).length, 1, "the marker must outlive the unserved request");

    served.resolve(false);
    await drainMaintenanceSettlements(path.join(dir, "state"));
    assert.equal((await pendingMarkers(dir)).length, 1, "a pass that did not serve the request keeps the marker");

    // A later start still owes it; this time the pass is served.
    const retry = Promise.withResolvers<boolean>();
    const second = new StorageManager(dir);
    second.onEntityMigrationComplete = () => retry.promise;
    await second.ensureDirectories();
    await second.drainEntityCanonicalIdMigration();
    assert.equal((await pendingMarkers(dir)).length, 1);
    retry.resolve(true);
    await drainMaintenanceSettlements(path.join(dir, "state"));
    assert.equal((await pendingMarkers(dir)).length, 0, "a served pass clears the marker");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearing one run's marker never deletes a marker a concurrent run armed meanwhile", async () => {
  const { dir } = await seedLegacyCorpus();
  try {
    const stateDir = path.join(dir, "state");
    const first = new StorageManager(dir);
    // Another process takes the migration lock after this run released it and
    // arms its own marker before this run's hook returns and its clear starts.
    let concurrentArm: Promise<string> | undefined;
    first.onEntityMigrationComplete = () => {
      concurrentArm = writeMaintenancePending(stateDir);
    };
    await first.ensureDirectories();
    await first.drainEntityCanonicalIdMigration();
    await drainMaintenanceSettlements(stateDir);
    await concurrentArm;
    assert.equal(
      (await pendingMarkers(dir)).length,
      1,
      "the concurrent run's marker must survive this run's clear (it is the only owed re-index if that run crashes)",
    );
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});
