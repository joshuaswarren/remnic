import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StorageManager, parseEntityFile } from "./storage.js";
import { sleep } from "./utils/sleep.js";

async function legacyStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-lazy-compat-"));
  const seed = new StorageManager(dir);
  const id = await seed.writeEntity("Legacy Person", "person", ["Keeps a synthetic task."]);
  await rename(path.join(dir, "entities", `${id}.md`), path.join(dir, "entities", "legacy-person.md"));
  const journal = path.join(dir, "state", "entity-canonical-id-migration-v1.json");
  await rm(journal, { force: true });
  const lock = path.join(dir, "state", "entity-canonical-id-migration.lock");
  await writeFile(lock, `${process.pid} test-holder ${new Date().toISOString()}\n`);
  const storage = new StorageManager(dir);
  await storage.ensureDirectories({ awaitEntityCanonicalMigration: false });
  return { dir, id, journal, lock, storage };
}

test("canonical reads find a legacy file without a journal or migration", async () => {
  const fixture = await legacyStore();
  try {
    assert.match(await fixture.storage.readEntity(fixture.id), /Keeps a synthetic task/);
    await assert.rejects(() => readFile(fixture.journal), { code: "ENOENT" });
    assert.ok(await readFile(fixture.lock));
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("ambiguous legacy canonical matches are refused rather than picking a claimant", async () => {
  const fixture = await legacyStore();
  try {
    const raw = await readFile(path.join(fixture.dir, "entities", "legacy-person.md"));
    await writeFile(path.join(fixture.dir, "entities", "other-legacy-person.md"), raw);
    await assert.rejects(() => fixture.storage.readEntity(fixture.id), /ambiguous/i);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("completed migration skips corpus reads on repeated misses in a fresh read-only store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-completed-miss-"));
  try {
    const seed = new StorageManager(dir);
    await seed.writeEntity("Existing Person", "person", ["Synthetic fact."]);
    await seed.ensureDirectories();
    const reader = new StorageManager(dir);
    await reader.ensureDirectories({ awaitEntityCanonicalMigration: false });
    const internals = reader as unknown as { readStorageSecureFile: (filePath: string) => Promise<string> };
    const originalRead = internals.readStorageSecureFile.bind(internals);
    const reads: string[] = [];
    internals.readStorageSecureFile = async (filePath) => {
      reads.push(path.basename(filePath));
      return originalRead(filePath);
    };
    assert.equal(await reader.readEntity("person-missing"), "");
    assert.equal(await reader.readEntity("person-missing"), "");
    assert.deepEqual(reads, ["person-missing.md", "person-missing.md"], "completed-store misses must not scan entity contents");
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an external entities change invalidates the amortized completion verdict on the same reader", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-completed-cache-"));
  try {
    const seed = new StorageManager(dir);
    const id = await seed.writeEntity("Café", "project", ["Synthetic legacy fact."]);
    await seed.ensureDirectories();
    const reader = new StorageManager(dir);
    await reader.ensureDirectories({ awaitEntityCanonicalMigration: false });
    const canonical = reader.normalizeEntityName("Café", "project");
    // First miss computes and caches the completion verdict.
    assert.equal(await reader.readEntity("project-missing"), "");
    // An external rename changes the entities directory; the cached verdict
    // must not keep hiding the now-legacy file from the same reader.
    await rename(path.join(dir, "entities", `${id}.md`), path.join(dir, "entities", "legacy-cafe.md"));
    assert.match(await reader.readEntity(canonical), /Synthetic legacy fact/);
  } finally {
    StorageManager.clearAllStaticCaches();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const change of ["aliases", "raw legacy write"]) {
  test(`stale completed journals do not hide canonical reads after ${change}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-stale-completion-"));
    try {
      const seed = new StorageManager(dir);
      const previousId = await seed.writeEntity("Café", "project", ["Synthetic legacy fact."]);
      await seed.ensureDirectories();
      const journalPath = path.join(dir, "state", "entity-canonical-id-migration-v1.json");
      const journal = await readFile(journalPath, "utf8");
      assert.equal(JSON.parse(journal).complete, true);
      if (change === "aliases") {
        await mkdir(path.join(dir, "config"), { recursive: true });
        await writeFile(path.join(dir, "config", "aliases.json"), JSON.stringify({ café: "coffee" }));
      } else {
        await rename(path.join(dir, "entities", `${previousId}.md`), path.join(dir, "entities", "legacy-cafe.md"));
        await writeFile(path.join(dir, "state", "entity-canonical-id-reconcile.pending"), "synthetic raw writer\n");
      }
      const lock = path.join(dir, "state", "entity-canonical-id-migration.lock");
      await writeFile(lock, `${process.pid} test-holder ${new Date().toISOString()}\n`);
      const reader = new StorageManager(dir);
      await reader.ensureDirectories({ awaitEntityCanonicalMigration: false });
      const canonical = reader.normalizeEntityName("Café", "project");
      if (change === "aliases") assert.notEqual(canonical, previousId);
      assert.match(await reader.readEntity(canonical), /Synthetic legacy fact/);
      assert.equal(await readFile(journalPath, "utf8"), journal, "read compatibility must not replay migration");
      assert.ok(await readFile(lock));
    } finally {
      StorageManager.clearAllStaticCaches();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

const mutations = [
  {
    name: "relationship",
    run: (s: StorageManager, id: string) => s.addEntityRelationship(id, { target: "person-peer", label: "knows" }),
    check: (raw: string) => assert.ok(parseEntityFile(raw).relationships.some((r) => r.label === "knows")),
  },
  {
    name: "activity",
    run: (s: StorageManager, id: string) => s.addEntityActivity(id, { date: "2026-01-01", note: "Synthetic activity" }, 10),
    check: (raw: string) => assert.ok(parseEntityFile(raw).activity.some((a) => a.note === "Synthetic activity")),
  },
  {
    name: "alias",
    run: (s: StorageManager, id: string) => s.addEntityAlias(id, "synthetic-alias"),
    check: (raw: string) => assert.ok(parseEntityFile(raw).aliases.includes("synthetic-alias")),
  },
  {
    name: "synthesis",
    run: (s: StorageManager, id: string) => s.updateEntitySynthesis(id, "Synthetic synthesis"),
    check: (raw: string) => assert.equal(parseEntityFile(raw).synthesis, "Synthetic synthesis"),
  },
  {
    name: "fragment merge",
    run: (s: StorageManager) => s.mergeFragmentedEntities(),
    check: (raw: string) => assert.match(raw, /Keeps a synthetic task/),
  },
  {
    name: "timeline migration",
    run: (s: StorageManager) => s.migrateEntityFilesToCompiledTruthTimeline(),
    check: (raw: string) => assert.match(raw, /Keeps a synthetic task/),
  },
];

for (const caller of ["canonical", "legacy"]) {
for (const mutation of mutations) {
  test(`${mutation.name} awaits migration for a ${caller} caller`, async () => {
    const fixture = await legacyStore();
    let settled = false;
    let failure: unknown;
    const operation = mutation.run(fixture.storage, caller === "legacy" ? "legacy-person" : fixture.id).then(
      () => { settled = true; },
      (error: unknown) => { failure = error; settled = true; },
    );
    let probeFailure: unknown;
    try {
      await sleep(100);
      assert.equal(settled, false, "a public entity mutation must wait behind the migration lock");
    } catch (error) {
      probeFailure = error;
    } finally {
      await rm(fixture.lock, { force: true });
    }
    try {
      await operation;
      if (probeFailure) throw probeFailure;
      assert.equal(failure, undefined);
      const raw = await readFile(path.join(fixture.dir, "entities", `${fixture.id}.md`), "utf8");
      mutation.check(raw);
      const journal = JSON.parse(await readFile(fixture.journal, "utf8"));
      assert.equal(journal.complete, true);
    } finally {
      StorageManager.clearAllStaticCaches();
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
}
}
