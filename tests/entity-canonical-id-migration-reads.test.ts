import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { StorageManager, normalizeEntityName } from "../packages/remnic-core/src/storage.js";

const STAMP = "2026-03-01T00:00:00.000Z";
const LEGACY_ID = normalizeEntityName("Weekly Report", "automation");
const CANONICAL_ID = normalizeEntityName("Weekly Report", "automation-cron-job");

assert.notEqual(LEGACY_ID, CANONICAL_ID, "fixture ids must actually straddle the rename");

function entityFileBody(id: string, type: string, note: string): string {
  return `---\nid: ${id}\ncreated: ${STAMP}\nupdated: ${STAMP}\n---\n\n`
    + `# Weekly Report\n\n**Type:** ${type}\n\n${note}\n`;
}

async function makeStoreDir(prefix: string) {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const entitiesDir = path.join(baseDir, "entities");
  const stateDir = path.join(baseDir, "state");
  await mkdir(entitiesDir, { recursive: true });
  await mkdir(stateDir);
  return { baseDir, entitiesDir, stateDir };
}

function writeJournal(
  stateDir: string,
  journal: { version: number; complete: boolean; mappings: Record<string, string>; blocked?: Record<string, string> },
): Promise<void> {
  return writeFile(
    path.join(stateDir, "entity-canonical-id-migration-v1.json"),
    JSON.stringify(journal),
    "utf8",
  );
}

function interceptReads(store: StorageManager, before: (filePath: string) => Promise<void>): void {
  const read = store["readStorageSecureFile"].bind(store);
  store["readStorageSecureFile"] = async (filePath: string) => {
    await before(filePath);
    return read(filePath);
  };
}

test("readEntity returns an entity the replay renamed between the name snapshot and the read", async () => {
  const { baseDir, entitiesDir, stateDir } = await makeStoreDir("remnic-canonical-direct-read-");
  try {
    const body = entityFileBody(CANONICAL_ID, "automation-cron-job", "Runs Mondays.");
    await writeFile(path.join(entitiesDir, `${LEGACY_ID}.md`), body, "utf8");

    const store = new StorageManager(baseDir);
    const legacyPath = path.join(entitiesDir, `${LEGACY_ID}.md`);
    interceptReads(store, async (filePath) => {
      if (filePath !== legacyPath) return;
      await writeJournal(stateDir, { version: 1, complete: false, mappings: { [LEGACY_ID]: CANONICAL_ID } });
      await rename(legacyPath, path.join(entitiesDir, `${CANONICAL_ID}.md`));
    });

    const raw = await store.readEntity(LEGACY_ID);
    assert.ok(raw.includes("Runs Mondays."), "a legacy id renamed mid-read must resolve through the journal");
    assert.equal(
      await readFile(path.join(entitiesDir, `${CANONICAL_ID}.md`), "utf8"),
      body,
      "the read must not rewrite the migrated corpus",
    );
    await rename(path.join(entitiesDir, `${CANONICAL_ID}.md`), legacyPath);
    await rm(path.join(stateDir, "entity-canonical-id-migration-v1.json"));
    assert.deepEqual((await store.readAllEntityFiles()).map((entity) => entity.name), ["Weekly Report"]);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readEntity keeps its existing missing and path-escape verdicts", async () => {
  const { baseDir, entitiesDir } = await makeStoreDir("remnic-canonical-read-verdicts-");
  try {
    await writeFile(
      path.join(entitiesDir, `${CANONICAL_ID}.md`),
      entityFileBody(CANONICAL_ID, "automation-cron-job", "Runs Mondays."),
      "utf8",
    );
    const store = new StorageManager(baseDir);
    assert.ok((await store.readEntity(CANONICAL_ID)).includes("Runs Mondays."));
    assert.equal(await store.readEntity(LEGACY_ID), "", "an id with no file on either side stays missing");
    assert.equal(await store.readEntity("../outside"), "", "path escape is still rejected");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readAllEntityFiles returns an entity copied beside its legacy file once, not twice", async () => {
  const { baseDir, entitiesDir, stateDir } = await makeStoreDir("remnic-canonical-batch-copy-");
  try {
    const body = entityFileBody(CANONICAL_ID, "automation-cron-job", "Runs Mondays.");
    await writeFile(path.join(entitiesDir, `${LEGACY_ID}.md`), body, "utf8");
    await writeFile(path.join(entitiesDir, `${CANONICAL_ID}.md`), body, "utf8");
    await writeJournal(stateDir, { version: 1, complete: false, mappings: { [LEGACY_ID]: CANONICAL_ID } });

    const store = new StorageManager(baseDir);
    const entities = await store.readAllEntityFiles();
    assert.deepEqual(
      entities.map((entity) => [entity.name, entity.type]),
      [["Weekly Report", "automation-cron-job"]],
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readAllEntityFiles deduplicates a legacy read that falls back to its in-snapshot canonical file", async () => {
  const { baseDir, entitiesDir, stateDir } = await makeStoreDir("remnic-canonical-batch-unlink-");
  try {
    const body = entityFileBody(CANONICAL_ID, "automation-cron-job", "Runs Mondays.");
    await writeFile(path.join(entitiesDir, `${LEGACY_ID}.md`), body, "utf8");
    await writeFile(path.join(entitiesDir, `${CANONICAL_ID}.md`), body, "utf8");
    await writeJournal(stateDir, { version: 1, complete: false, mappings: { [LEGACY_ID]: CANONICAL_ID } });

    const store = new StorageManager(baseDir);
    const legacyPath = path.join(entitiesDir, `${LEGACY_ID}.md`);
    interceptReads(store, async (filePath) => {
      if (filePath === legacyPath) await unlink(legacyPath);
    });

    const entities = await store.readAllEntityFiles();
    assert.deepEqual(
      entities.map((entity) => [entity.name, entity.type]),
      [["Weekly Report", "automation-cron-job"]],
      "the ENOENT fallback and the canonical entry must not both land",
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("readAllEntityFiles keeps parked collision claimants as distinct entities", async () => {
  const { baseDir, entitiesDir, stateDir } = await makeStoreDir("remnic-canonical-batch-collision-");
  try {
    await writeFile(
      path.join(entitiesDir, `${LEGACY_ID}.md`),
      entityFileBody(LEGACY_ID, "automation", "Legacy variant."),
      "utf8",
    );
    await writeFile(
      path.join(entitiesDir, `${CANONICAL_ID}.md`),
      entityFileBody(CANONICAL_ID, "automation-cron-job", "Canonical variant."),
      "utf8",
    );
    await writeJournal(stateDir, {
      version: 1,
      complete: false,
      mappings: {},
      blocked: { [LEGACY_ID]: CANONICAL_ID },
    });

    const store = new StorageManager(baseDir);
    const entities = await store.readAllEntityFiles();
    assert.deepEqual(
      entities.map((entity) => [entity.name, entity.type]).sort(),
      [["Weekly Report", "automation"], ["Weekly Report", "automation-cron-job"]],
      "a parked collision keeps both claimants",
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("listing reports the canonical id for an indexable legacy-named file", async () => {
  const { baseDir, entitiesDir, stateDir } = await makeStoreDir("remnic-canonical-listing-id-");
  try {
    // The legacy file is STILL present and readable (migration has not
    // renamed it yet), but the journal already records the mapping.
    await writeFile(path.join(entitiesDir, `${LEGACY_ID}.md`), entityFileBody(LEGACY_ID, "automation", "Runs Mondays."), "utf8");
    await writeJournal(stateDir, { version: 1, complete: false, mappings: { [LEGACY_ID]: CANONICAL_ID } });
    const store = new StorageManager(baseDir);
    const names = await store.listEntityNames();
    assert.deepEqual(names, [CANONICAL_ID], "an indexable legacy-named file must surface as its canonical id");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("one unreadable entity does not fail the corpus read", async () => {
  const { baseDir, entitiesDir, stateDir } = await makeStoreDir("remnic-canonical-isolated-read-");
  try {
    const lockedPath = path.join(entitiesDir, "project-locked.md");
    await writeFile(path.join(entitiesDir, "project-fine.md"), entityFileBody("project-fine", "project", "Fine."), "utf8");
    await writeFile(lockedPath, entityFileBody("project-locked", "project", "Locked."), "utf8");
    await writeJournal(stateDir, { version: 1, complete: true, mappings: {} });
    await chmod(lockedPath, 0o000);
    const store = new StorageManager(baseDir);
    const entities = await store.readAllEntityFiles();
    assert.equal(entities.length, 1, "the healthy entity must still be read; the unreadable one is isolated");
    assert.match(entities[0]?.name ?? "", /Weekly Report/);
  } finally {
    await chmod(path.join(entitiesDir, "project-locked.md"), 0o644).catch(() => undefined);
    await rm(baseDir, { recursive: true, force: true });
  }
});
