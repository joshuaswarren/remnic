import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  StorageManager,
  compareEntityTimestamps,
  isEntitySynthesisStale,
  normalizeEntityName,
  parseEntityFile,
  serializeEntityFile,
} from "../packages/remnic-core/src/storage.js";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { normalizeLegacyEntityName } from "../packages/remnic-core/src/entity-id-normalization.js";
import { normalizeEntityText } from "../packages/remnic-core/src/entity-schema.js";
import {
  parseEntityTimelineBullet,
  serializeEntityTimelineEntry,
} from "../packages/remnic-core/src/storage/entity-timeline.js";
import {
  isEncryptedFile,
  writeMaybeEncryptedFile,
} from "../packages/remnic-core/src/secure-store/secure-fs.js";
import { rebuildMemoryProjection } from "../packages/remnic-core/src/maintenance/rebuild-memory-projection.js";
import {
  rewriteProjectedMemoryEntityReference,
  rewriteProjectedEntityReferences,
} from "../packages/remnic-core/src/memory-projection-mutations.js";
import {
  getMemoryProjectionPath,
  initializeMemoryProjectionDb,
  readProjectedEntityMentions,
  readProjectedMemoryState,
} from "../packages/remnic-core/src/memory-projection-store.js";
import { openBetterSqlite3 } from "../packages/remnic-core/src/runtime/better-sqlite.js";
import { computeSupersessionKey } from "../packages/remnic-core/src/temporal-supersession.js";
import type { MemoryFile } from "../packages/remnic-core/src/types.js";

test("projection memory rewrites reject an empty memory id", async () => {
  await assert.rejects(
    () => rewriteProjectedMemoryEntityReference("/tmp/remnic-projection-test", "", "legacy", "canonical"),
    /memoryId must not be empty/,
  );
});

test("projection memory rewrites reject symlinked databases outside the memory root", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-symlink-memory-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-symlink-outside-"));
  try {
    const projectionPath = getMemoryProjectionPath(memoryDir);
    const outsidePath = path.join(outsideDir, "memory-projection.sqlite");
    await mkdir(path.dirname(projectionPath), { recursive: true });
    await writeFile(outsidePath, "external projection", "utf-8");
    await symlink(outsidePath, projectionPath);

    await assert.rejects(
      () => rewriteProjectedEntityReferences(memoryDir, { "legacy-entity": "canonical-entity" }),
      /unsafe database path/,
    );
    assert.equal(await readFile(outsidePath, "utf-8"), "external projection");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("projection memory rewrites initialize legacy projection tables", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-projection-legacy-schema-"));
  try {
    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    const db = openBetterSqlite3(projectionPath);
    try {
      initializeMemoryProjectionDb(db);
      db.prepare(`
        INSERT INTO memory_current (
          memory_id, category, status, path_rel, path_valid, created_at, updated_at,
          entity_ref, source, confidence, confidence_tier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "memory-1",
        "fact",
        "active",
        "facts/memory-1.md",
        1,
        "2026-07-25T00:00:00.000Z",
        "2026-07-25T00:00:00.000Z",
        "legacy-entity",
        "test",
        1,
        "explicit",
      );
      db.exec("DROP TABLE memory_entity_mentions");
    } finally {
      db.close();
    }

    await rewriteProjectedMemoryEntityReference(memoryDir, "memory-1", "legacy-entity", "canonical-entity");

    const verified = openBetterSqlite3(projectionPath);
    try {
      const currentRow = verified
        .prepare("SELECT entity_ref FROM memory_current WHERE memory_id = ?")
        .get("memory-1") as { entity_ref?: string } | undefined;
      assert.equal(currentRow?.entity_ref, "canonical-entity");
      assert.equal(
        verified
          .prepare("SELECT entity_ref FROM memory_entity_mentions WHERE memory_id = ?")
          .get("memory-1"),
        undefined,
      );
    } finally {
      verified.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("writeEntity appends timeline evidence and marks older synthesis as stale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Leads the roadmap."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads the roadmap.", {
      updatedAt: "2026-04-13T10:05:00.000Z",
    });

    await storage.writeEntity(entityName, entityType, ["Owns release approvals now."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /^---\n[\s\S]*synthesis_updated_at:/);
    assert.match(raw, /## Synthesis/);
    assert.match(raw, /## Timeline/);
    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.timeline[0]?.text, "Leads the roadmap.");
    assert.equal(parsed.timeline[1]?.text, "Owns release approvals now.");
    assert.equal(parsed.timeline[1]?.sessionKey, "session-2");
    assert.equal(parsed.synthesis, "Jane Doe leads the roadmap.");
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readEntity rejects names that escape the entities directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-read-path-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await writeFile(path.join(dir, "profile.md"), "outside entities", "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane-doe.md"), "inside entities", "utf-8");

    assert.equal(await storage.readEntity("../profile"), "");
    assert.equal(await storage.readEntity("person-jane-doe"), "inside entities");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories migrates legacy Unicode entity ids and memory references", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-legacy-unicode-id-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    const relatedCanonical = await seed.writeEntity("Aurora", "project", ["Aurora is synthetic."]);
    await seed.addEntityRelationship(relatedCanonical, {
      target: legacyCanonical,
      label: "depends on",
    });
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    const day = new Date().toISOString().slice(0, 10);
    const legacyMemoryDocument = (id: string) => [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-07-25T00:00:00.000Z",
      `entityRef: ${legacyCanonical}`,
      `adapterMetadata: {"provider":"test","version":1}`,
      "---",
      "",
      "Legacy entity reference.",
      "",
    ].join("\n");
    const coldDir = path.join(dir, "cold", "facts", day);
    const archiveDir = path.join(dir, "archive", day);
    await Promise.all([
      mkdir(path.join(dir, "facts", day), { recursive: true }),
      mkdir(coldDir, { recursive: true }),
      mkdir(archiveDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(dir, "facts", day, "legacy-unicode-entity.md"),
        legacyMemoryDocument("legacy-unicode-entity"),
        "utf-8",
      ),
      writeFile(
        path.join(coldDir, "legacy-unicode-entity-cold.md"),
        legacyMemoryDocument("legacy-unicode-entity-cold"),
        "utf-8",
      ),
      writeFile(
        path.join(archiveDir, "legacy-unicode-entity-archive.md"),
        legacyMemoryDocument("legacy-unicode-entity-archive"),
        "utf-8",
      ),
    ]);
    const legacySupersessionKey = computeSupersessionKey(legacyCanonical, "status");
    assert.ok(legacySupersessionKey);
    seed.setTombstonesConfig({
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      namespace: "test",
    });
    await seed.appendTombstone({
      reason: "supersession",
      createdBy: "supersession",
      sourceMemoryId: "legacy-unicode-entity",
      rawContent: "Moonlight has an obsolete status.",
      entityRef: legacyCanonical,
      supersessionKey: legacySupersessionKey,
    });

    seed.invalidateMemoryCachesForTiers(["cold"]);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });
    await rebuildMemoryProjection({
      memoryDir: dir,
      dryRun: false,
      now: new Date("2026-07-25T00:00:00.000Z"),
    });
    assert.equal(readProjectedMemoryState(dir, "legacy-unicode-entity")?.entityRef, legacyCanonical);
    assert.deepEqual(
      readProjectedEntityMentions(dir)?.map((mention) => mention.entityRef),
      [legacyCanonical, legacyCanonical, legacyCanonical],
    );


    const upgraded = new StorageManager(dir);
    const projectionLock = openBetterSqlite3(getMemoryProjectionPath(dir), { fileMustExist: true });
    projectionLock.pragma("busy_timeout = 0");
    projectionLock.exec("BEGIN IMMEDIATE");
    const tombstoneLockPath = path.join(dir, "state", "tombstones.lock");
    const tombstoneLock = await open(tombstoneLockPath, "wx");
    let tombstoneLockReleased = false;
    const releaseTombstoneLock = async () => {
      if (tombstoneLockReleased) return;
      tombstoneLockReleased = true;
      await tombstoneLock.close();
      await rm(tombstoneLockPath, { force: true });
    };
    let projectionLockReleased = false;
    const releaseProjectionLock = () => {
      if (projectionLockReleased) return;
      projectionLockReleased = true;
      projectionLock.exec("ROLLBACK");
      projectionLock.close();
    };
    const releaseImmediate = setImmediate(releaseProjectionLock);
    const releaseTombstoneImmediate = setImmediate(() => {
      void releaseTombstoneLock();
    });
    try {
      await upgraded.ensureDirectories();
    } finally {
      clearImmediate(releaseImmediate);
      releaseProjectionLock();
      clearImmediate(releaseTombstoneImmediate);
      await releaseTombstoneLock();
    }

    assert.match(await upgraded.readEntity(canonical), /# 月光/);
    assert.equal(await upgraded.readEntity(legacyCanonical), "");
    assert.deepEqual(
      (await upgraded.readAllMemories()).map((memory) => memory.frontmatter.entityRef),
      [canonical],
    );
    assert.match(
      await readFile(path.join(dir, "facts", day, "legacy-unicode-entity.md"), "utf-8"),
      /adapterMetadata: {"provider":"test","version":1}/,
    );
    assert.deepEqual(
      (await upgraded.readAllColdMemories()).map((memory) => memory.frontmatter.entityRef),
      [canonical],
    );
    assert.deepEqual(
      (await upgraded.readArchivedMemories()).map((memory) => memory.frontmatter.entityRef),
      [canonical],
    );
    assert.deepEqual(
      [
        readProjectedMemoryState(dir, "legacy-unicode-entity"),
        readProjectedMemoryState(dir, "legacy-unicode-entity-cold"),
        readProjectedMemoryState(dir, "legacy-unicode-entity-archive"),
      ].map((memory) => memory?.entityRef),
      [canonical, canonical, canonical],
    );
    assert.deepEqual(
      readProjectedEntityMentions(dir)?.map((mention) => mention.entityRef),
      [canonical, canonical, canonical],
    );
    const migratedTombstone = JSON.parse(
      (await readFile(path.join(dir, "state", "tombstones.jsonl"), "utf-8")).trim(),
    ) as { entityRef?: string; supersessionKey?: string };
    assert.equal(migratedTombstone.entityRef, canonical);
    assert.equal(migratedTombstone.supersessionKey, computeSupersessionKey(canonical, "status"));
    upgraded.setTombstonesConfig({
      enabled: true,
      semanticMatch: false,
      semanticThreshold: 0.9,
      namespace: "test",
    });
    const { id: blockedId, tombstoneBlocked } = await upgraded.writeMemory(
      "fact",
      "Moonlight has a new status.",
      {
        source: "extraction",
        entityRef: canonical,
        structuredAttributes: { status: "new" },
      },
    );
    assert.equal(tombstoneBlocked, true);
    const blocked = (await upgraded.readAllMemories()).find((memory) => memory.frontmatter.id === blockedId);
    assert.equal(blocked?.frontmatter.status, "pending_review");
    assert.equal(blocked?.frontmatter.tombstoneBlockTier, "keyed");
    assert.equal(await upgraded.writeEntity(name, type, ["New entity fact."]), canonical);
    assert.deepEqual(
      parseEntityFile(await upgraded.readEntity(relatedCanonical)).relationships,
      [{ target: canonical, label: "depends on" }],
    );
    assert.deepEqual((await upgraded.readEntities()).sort(), [relatedCanonical, canonical].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity reference migration preserves the raw memory body byte-for-byte", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-raw-body-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Synthetic entity fact."]);
    await rename(path.join(dir, "entities", `${canonical}.md`), path.join(dir, "entities", `${legacy}.md`));
    const day = new Date().toISOString().slice(0, 10);
    const memoryPath = path.join(dir, "facts", day, "raw-body.md");
    const rawBody = "\n    indented code block\n\nTrailing spaces stay.  \n\n";
    const original =
      [
        "---",
        "id: raw-body",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        `entityRef: ${legacy}`,
        "---",
      ].join("\n") + rawBody;
    await writeFile(memoryPath, original, "utf-8");
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    await new StorageManager(dir).ensureDirectories();

    const migrated = await readFile(memoryPath, "utf-8");
    assert.equal(migrated, original.replace(`entityRef: ${legacy}`, `entityRef: ${canonical}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity reference migration preserves CRLF memory documents byte-for-byte", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-crlf-body-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Synthetic entity fact."]);
    await rename(path.join(dir, "entities", `${canonical}.md`), path.join(dir, "entities", `${legacy}.md`));
    const day = new Date().toISOString().slice(0, 10);
    const memoryPath = path.join(dir, "facts", day, "raw-body-crlf.md");
    const original = [
      "---",
      "id: raw-body-crlf",
      "category: fact",
      "created: 2026-07-25T00:00:00.000Z",
      `entityRef: ${legacy}`,
      "---",
      "",
      "    indented code block",
      "",
      "Trailing spaces stay.  ",
      "",
    ].join("\r\n");
    await writeFile(memoryPath, original, "utf-8");
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    await new StorageManager(dir).ensureDirectories();

    const migrated = await readFile(memoryPath, "utf-8");
    assert.equal(migrated, original.replace(`entityRef: ${legacy}`, `entityRef: ${canonical}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity reference migration leaves non-standalone frontmatter delimiters untouched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-malformed-delimiter-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Synthetic entity fact."]);
    await rename(path.join(dir, "entities", `${canonical}.md`), path.join(dir, "entities", `${legacy}.md`));
    const day = new Date().toISOString().slice(0, 10);
    const memoryPath = path.join(dir, "facts", day, "malformed-delimiter.md");
    const original = [
      "---",
      "id: malformed-delimiter",
      "category: fact",
      "created: 2026-07-25T00:00:00.000Z",
      `entityRef: ${legacy}`,
      "---body starts on the delimiter line",
    ].join("\n");
    await writeFile(memoryPath, original, "utf-8");
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    await new StorageManager(dir).ensureDirectories();

    assert.equal(await readFile(memoryPath, "utf-8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories rejects a symlinked tombstone ledger before rewriting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-tombstone-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-tombstone-outside-"));
  try {
    const name = "月光";
    const type = "project";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Entity fact."]);
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    await rename(canonicalPath, legacyPath);
    const outsidePath = path.join(outsideDir, "tombstones.jsonl");
    const outsideContent = `{"entityRef":"${legacy}"}\n`;
    await writeFile(outsidePath, outsideContent, "utf-8");
    const tombstonePath = path.join(dir, "state", "tombstones.jsonl");
    await symlink(outsidePath, tombstonePath);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    await assert.rejects(
      () => new StorageManager(dir).ensureDirectories(),
      /unsafe tombstone ledger/,
    );
    assert.equal(await readFile(outsidePath, "utf-8"), outsideContent);
    assert.equal((await lstat(tombstonePath)).isSymbolicLink(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("writeMemory canonicalizes a legacy entityRef after migration completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-completed-reapply-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await storage.writeEntity(name, type, ["Historical entity fact."]);
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    await storage.ensureDirectories();

    // Issue #2213: the migration no longer re-runs its full-corpus reference
    // rewrite after every corpus write (that was a hot loop on write-active
    // daemons). Instead the WRITE boundary resolves legacy ids through the
    // completed journal, so a later write naming the legacy id — extraction
    // output, explicit capture — lands canonical with no reconciliation pass.
    const written = await storage.writeMemory("fact", "Created after the migration completed.", {
      entityRef: legacyCanonical,
    });
    const memory = (await storage.readAllMemories()).find((m) => m.frontmatter.id === written.id);
    assert.ok(memory, "fixture must persist the fact");
    assert.equal(memory.frontmatter.entityRef, canonical);
    assert.match(await readFile(memory.path, "utf-8"), new RegExp(`entityRef: ${canonical}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories preserves memory updates made after migration discovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-memory-race-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    const day = new Date().toISOString().slice(0, 10);
    const memoryPath = path.join(dir, "facts", day, "migration-race.md");
    await mkdir(path.dirname(memoryPath), { recursive: true });
    await writeFile(
      memoryPath,
      [
        "---",
        "id: migration-race",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        `entityRef: ${legacyCanonical}`,
        "---",
        "",
        "Original content.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const upgraded = new StorageManager(dir);
    const staleSnapshot = await upgraded.readAllMemories();
    assert.equal(staleSnapshot.length, 1);
    const currentContent = await readFile(memoryPath, "utf-8");
    await writeFile(memoryPath, `${currentContent}Concurrent content update.\n`, "utf-8");
    const originalReadAll = upgraded.readAllMemories.bind(upgraded);
    (upgraded as unknown as { readAllMemories: () => Promise<unknown> }).readAllMemories = async () => staleSnapshot;
    try {
      await upgraded.ensureDirectories();
    } finally {
      (upgraded as unknown as { readAllMemories: typeof originalReadAll }).readAllMemories = originalReadAll;
    }

    const migratedContent = await readFile(memoryPath, "utf-8");
    assert.match(migratedContent, new RegExp(`entityRef: ${canonical}`));
    assert.match(migratedContent, /Concurrent content update/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories preserves memory updates during the final rewrite check", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-final-race-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    const day = new Date().toISOString().slice(0, 10);
    const memoryPath = path.join(dir, "facts", day, "migration-final-race.md");
    await mkdir(path.dirname(memoryPath), { recursive: true });
    await writeFile(
      memoryPath,
      [
        "---",
        "id: migration-final-race",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        `entityRef: ${legacyCanonical}`,
        "---",
        "",
        "Original content.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const upgraded = new StorageManager(dir);
    const originalReadMemoryByPath = upgraded.readMemoryByPath.bind(upgraded);
    let injected = false;
    const testStorage = upgraded as unknown as {
      readMemoryByPath: typeof originalReadMemoryByPath;
      bumpMemoryCorpusVersion(): void;
    };
    testStorage.readMemoryByPath = async (filePath) => {
      const current = await originalReadMemoryByPath(filePath);
      if (current && !injected) {
        injected = true;
        const currentContent = await readFile(filePath, "utf-8");
        await writeFile(filePath, `${currentContent}Concurrent content update.\n`, "utf-8");
        testStorage.bumpMemoryCorpusVersion();
      }
      return current;
    };
    try {
      await upgraded.ensureDirectories();
    } finally {
      testStorage.readMemoryByPath = originalReadMemoryByPath;
    }

    const racedContent = await readFile(memoryPath, "utf-8");
    assert.match(racedContent, new RegExp(`entityRef: ${legacyCanonical}`));
    assert.match(racedContent, /Concurrent content update/);

    await upgraded.ensureDirectories();

    const migratedContent = await readFile(memoryPath, "utf-8");
    assert.match(migratedContent, new RegExp(`entityRef: ${canonical}`));
    assert.match(migratedContent, /Concurrent content update/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories rescans memories created during migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-memory-rescan-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    const day = new Date().toISOString().slice(0, 10);
    const writeLegacyMemory = async (id: string) => {
      const memoryPath = path.join(dir, "facts", day, `${id}.md`);
      await mkdir(path.dirname(memoryPath), { recursive: true });
      await writeFile(
        memoryPath,
        [
          "---",
          `id: ${id}`,
          "category: fact",
          "created: 2026-07-25T00:00:00.000Z",
          `entityRef: ${legacyCanonical}`,
          "---",
          "",
          `${id} content.`,
          "",
        ].join("\n"),
        "utf-8",
      );
      return memoryPath;
    };
    await writeLegacyMemory("migration-rescan-first");
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const upgraded = new StorageManager(dir);
    const originalReadAll = upgraded.readAllMemories.bind(upgraded);
    const initialSnapshot = await originalReadAll();
    let readAllCalls = 0;
    let injected = false;
    (upgraded as unknown as { readAllMemories: () => Promise<unknown> }).readAllMemories = async () => {
      readAllCalls += 1;
      const result = readAllCalls === 1 ? initialSnapshot : await originalReadAll();
      if (!injected) {
        injected = true;
        await writeLegacyMemory("migration-rescan-second");
      }
      return result;
    };
    try {
      await upgraded.ensureDirectories();
    } finally {
      (upgraded as unknown as { readAllMemories: typeof originalReadAll }).readAllMemories = originalReadAll;
    }

    assert.ok(readAllCalls >= 2);
    const memories = await upgraded.readAllMemories();
    assert.deepEqual(memories.map((memory) => memory.frontmatter.entityRef).sort(), [canonical, canonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories preserves relationships added after migration discovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-relationship-race-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    const relatedCanonical = await seed.writeEntity("Aurora", type, ["Aurora is synthetic."]);
    await seed.addEntityRelationship(relatedCanonical, {
      target: legacyCanonical,
      label: "depends on",
    });
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    const staleRelatedContent = await seed.readEntity(relatedCanonical);
    await seed.addEntityRelationship(relatedCanonical, {
      target: "project-sun",
      label: "concurrent",
    });
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const upgraded = new StorageManager(dir);
    const relatedPath = path.join(dir, "entities", `${relatedCanonical}.md`);
    type StorageReadInternals = {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    const readInternals = upgraded as unknown as StorageReadInternals;
    const originalRead = readInternals.readStorageSecureFile.bind(upgraded);
    let relatedReads = 0;
    readInternals.readStorageSecureFile = async (filePath) => {
      const content = await originalRead(filePath);
      if (filePath === relatedPath) {
        relatedReads += 1;
        if (relatedReads === 1) return staleRelatedContent;
      }
      return content;
    };
    try {
      await upgraded.ensureDirectories();
    } finally {
      readInternals.readStorageSecureFile = originalRead;
    }

    assert.ok(relatedReads >= 2);
    assert.deepEqual(parseEntityFile(await upgraded.readEntity(relatedCanonical)).relationships, [
      { target: canonical, label: "depends on" },
      { target: "project-sun", label: "concurrent" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories resumes a journaled legacy entity migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-legacy-unicode-recovery-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${legacyCanonical}.md`),
    );
    const day = new Date().toISOString().slice(0, 10);
    await mkdir(path.join(dir, "facts", day), { recursive: true });
    await writeFile(
      path.join(dir, "facts", day, "legacy-unicode-recovery.md"),
      [
        "---",
        "id: legacy-unicode-recovery",
        "category: fact",
        "created: 2026-07-25T00:00:00.000Z",
        `entityRef: ${legacyCanonical}`,
        "---",
        "",
        "Legacy entity reference.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({
        version: 1,
        complete: false,
        mappings: { [legacyCanonical]: canonical },
      }),
      "utf-8",
    );
    await rename(
      path.join(dir, "entities", `${legacyCanonical}.md`),
      path.join(dir, "entities", `${canonical}.md`),
    );

    const recovered = new StorageManager(dir);
    await recovered.ensureDirectories();

    assert.match(await recovered.readEntity(canonical), /# 月光/);
    assert.equal((await recovered.readAllMemories())[0]?.frontmatter.entityRef, canonical);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories re-encrypts legacy Entity ids at their canonical path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-legacy-unicode-secure-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const key = Buffer.alloc(32, 0x6d);
    const seed = new StorageManager(dir);
    seed.setSecureStoreKey(key, true);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    const entityContent = await seed.readEntity(canonical);
    const legacyPath = path.join(dir, "entities", `${legacyCanonical}.md`);
    await writeMaybeEncryptedFile(legacyPath, entityContent, key, {}, dir);
    await rm(path.join(dir, "entities", `${canonical}.md`));
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"));

    const upgraded = new StorageManager(dir);
    upgraded.setSecureStoreRequired(true);
    await upgraded.ensureDirectories();
    upgraded.setSecureStoreKey(key, false);
    await upgraded.ensureDirectories();
    assert.equal(isEncryptedFile(await readFile(path.join(dir, "entities", `${canonical}.md`))), true);

    assert.match(await upgraded.readEntity(canonical), /# 月光/);
    assert.equal(await upgraded.readEntity(legacyCanonical), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories resumes a secure Entity migration after its canonical write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-legacy-unicode-secure-resume-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const key = Buffer.alloc(32, 0x6e);
    const seed = new StorageManager(dir);
    seed.setSecureStoreKey(key, true);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    const entityContent = await seed.readEntity(canonical);
    await writeFile(path.join(dir, "entities", `${canonical}.md`), entityContent, "utf-8");
    await writeMaybeEncryptedFile(
      path.join(dir, "entities", `${legacyCanonical}.md`),
      entityContent,
      key,
      {},
      dir,
    );
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({
        version: 1,
        complete: false,
        mappings: { [legacyCanonical]: canonical },
      }),
      "utf-8",
    );

    const upgraded = new StorageManager(dir);
    upgraded.setSecureStoreKey(key, false);
    await upgraded.ensureDirectories();
    assert.equal(isEncryptedFile(await readFile(path.join(dir, "entities", `${canonical}.md`))), true);

    assert.match(await upgraded.readEntity(canonical), /# 月光/);
    assert.equal(await upgraded.readEntity(legacyCanonical), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setSecureStoreKey resumes entity migration after a locked startup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-unlock-migration-"));
  try {
    const name = "月光";
    const type = "project";
    const canonical = normalizeEntityName(name, type);
    const legacyCanonical = "project-";
    const key = Buffer.alloc(32, 0x70);
    const seed = new StorageManager(dir);
    seed.setSecureStoreKey(key, true);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight has a synthetic legacy fact."]);
    const entityContent = await seed.readEntity(canonical);
    const legacyPath = path.join(dir, "entities", `${legacyCanonical}.md`);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    await seed.writeMemory("fact", "Legacy entity reference.", { entityRef: legacyCanonical });
    await writeMaybeEncryptedFile(legacyPath, entityContent, key, {}, dir);
    await rm(canonicalPath);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const upgraded = new StorageManager(dir);
    upgraded.setSecureStoreRequired(true);
    await upgraded.ensureDirectories();
    await assert.rejects(readFile(canonicalPath), { code: "ENOENT" });

    await upgraded.setSecureStoreKeyAndWait(key, false);
    assert.equal(isEncryptedFile(await readFile(canonicalPath)), true);
    const migratedMemories = await upgraded.readAllMemories();
    assert.deepEqual(migratedMemories.map((memory) => memory.frontmatter.entityRef), [canonical]);
    await assert.rejects(readFile(legacyPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories migrates legacy filenames after display-name normalization changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-mutable-display-name-"));
  try {
    const type = "project";
    const originalName = "Café";
    const currentName = "Cafe\u0301";
    const canonical = normalizeEntityName(currentName, type);
    const legacy = normalizeLegacyEntityName(originalName, type);
    const seed = new StorageManager(dir);
    assert.notEqual(canonical, legacy);
    await seed.writeEntity(originalName, type, ["Original display name."]);
    const originalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    await rename(originalPath, legacyPath);
    const changedContent = (await readFile(legacyPath, "utf-8")).replace(`# ${originalName}`, `# ${currentName}`);
    await writeFile(legacyPath, changedContent, "utf-8");
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const upgraded = new StorageManager(dir);
    await upgraded.ensureDirectories();

    assert.match(await upgraded.readEntity(canonical), new RegExp(`# ${currentName}`));
    await assert.rejects(readFile(legacyPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories skips duplicate canonical targets instead of aborting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-duplicate-canonical-target-"));
  try {
    const composedName = "Café";
    const decomposedName = "Cafe\u0301";
    const type = "project";
    const canonical = normalizeEntityName(composedName, type);
    const firstLegacy = normalizeLegacyEntityName(composedName, type);
    const secondLegacy = normalizeLegacyEntityName(decomposedName, type);
    assert.equal(canonical, normalizeEntityName(decomposedName, type));
    assert.notEqual(firstLegacy, secondLegacy);

    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(composedName, type, ["Composed entity fact."]);
    const entityContent = await seed.readEntity(canonical);
    await rename(
      path.join(dir, "entities", `${canonical}.md`),
      path.join(dir, "entities", `${firstLegacy}.md`),
    );
    await writeFile(
      path.join(dir, "entities", `${secondLegacy}.md`),
      entityContent.replace(`# ${composedName}`, `# ${decomposedName}`),
      "utf-8",
    );
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"));
    // Two legacy files normalizing onto one canonical id is an ordinary data
    // state the migration cannot disambiguate. It must refuse to PICK — never
    // refuse to BOOT: this ran during directory initialization, so throwing
    // took the daemon down on every restart with no way out.
    const migrating = new StorageManager(dir);
    await migrating.ensureDirectories();
    assert.match(await readFile(path.join(dir, "entities", `${firstLegacy}.md`), "utf-8"), /# Café/);
    assert.match(
      await readFile(path.join(dir, "entities", `${secondLegacy}.md`), "utf-8"),
      /# Cafe\u0301/,
    );
    await assert.rejects(() => readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories rejects malformed legacy entity files before migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-malformed-legacy-"));
  try {
    const legacyPath = path.join(dir, "entities", "project-.md");
    const canonicalPath = path.join(dir, "entities", "project-月光.md");
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await writeFile(legacyPath, "# \n**Type:** project\n", "utf-8");
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"));

    const migrating = new StorageManager(dir);
    await assert.rejects(
      () => migrating.ensureDirectories(),
      /malformed entity file project-\.md/,
    );
    assert.match(await readFile(legacyPath, "utf-8"), /^# /);
    await assert.rejects(() => readFile(canonicalPath, "utf-8"), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories rescans legacy entities created during migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-rescan-"));
  try {
    const name = "月光";
    const type = "project";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Moonlight is synthetic."]);
    const canonical = normalizeEntityName(name, type);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacy = normalizeLegacyEntityName(name, type);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"));

    const migrating = new StorageManager(dir);
    const internals = migrating as unknown as {
      readStorageSecureFile(filePath: string): Promise<string>;
    };
    const originalRead = internals.readStorageSecureFile.bind(migrating);
    let injected = false;
    internals.readStorageSecureFile = async (filePath) => {
      const content = await originalRead(filePath);
      if (!injected && filePath === canonicalPath) {
        injected = true;
        await writeFile(legacyPath, content, "utf-8");
      }
      return content;
    };

    await migrating.ensureDirectories();

    assert.equal(injected, true);
    assert.match(await readFile(canonicalPath, "utf-8"), /# 月光/);
    await assert.rejects(() => readFile(legacyPath, "utf-8"), { code: "ENOENT" });
    const migrationState = JSON.parse(
      await readFile(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), "utf-8"),
    ) as { complete?: unknown };
    assert.equal(migrationState.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories removes an uncommitted canonical destination after a legacy source race", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-destination-race-"));
  try {
    const name = "月光";
    const type = "project";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Original entity fact."]);
    const canonical = normalizeEntityName(name, type);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacy = normalizeLegacyEntityName(name, type);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    await rename(canonicalPath, legacyPath);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), { force: true });

    const migrating = new StorageManager(dir);
    const internals = migrating as unknown as {
      writeStorageSecureFile(
        filePath: string,
        content: string | Buffer,
        forceEncrypt?: boolean,
      ): Promise<void>;
    };
    const originalWrite = internals.writeStorageSecureFile.bind(migrating);
    let injected = false;
    internals.writeStorageSecureFile = async (filePath, content, forceEncrypt) => {
      await originalWrite(filePath, content, forceEncrypt);
      if (!injected && filePath === canonicalPath) {
        injected = true;
        await writeFile(
          legacyPath,
          String(content).replace("Original entity fact.", "Concurrent entity fact."),
          "utf-8",
        );
      }
    };

    await assert.rejects(
      () => migrating.ensureDirectories(),
      /changed while migration was running|retry migration/,
    );
    assert.equal(injected, true);
    await assert.rejects(() => readFile(canonicalPath), { code: "ENOENT" });
    assert.match(await readFile(legacyPath, "utf-8"), /Concurrent entity fact/);

    await migrating.ensureDirectories();
    assert.match(await readFile(canonicalPath, "utf-8"), /Concurrent entity fact/);
    await assert.rejects(() => readFile(legacyPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories preserves entities whose legacy and canonical paths share an inode", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-same-inode-"));
  try {
    const name = "Café";
    const type = "project";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Canonical entity fact."]);
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    const memory = await seed.writeMemory("fact", "Legacy entity memory.", { entityRef: legacy });
    const persistedMemory = (await seed.readAllMemories()).find(
      (candidate) => candidate.frontmatter.id === memory.id,
    );
    assert.ok(persistedMemory);
    const memoryPath = persistedMemory.path;
    assert.match(await readFile(memoryPath, "utf-8"), new RegExp(`entityRef: ${legacy}\n`));
    await link(canonicalPath, legacyPath);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"));

    await new StorageManager(dir).ensureDirectories();

    assert.match(await readFile(canonicalPath, "utf-8"), /# Café/);
    assert.match(await readFile(legacyPath, "utf-8"), /# Café/);
    assert.match(await readFile(memoryPath, "utf-8"), new RegExp(`entityRef: ${canonical}\n`));
    const migrationState = JSON.parse(
      await readFile(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), "utf-8"),
    ) as { complete?: unknown; mappings?: Record<string, string> };
    assert.equal(migrationState.complete, true);
    assert.equal(migrationState.mappings?.[legacy], canonical);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories removes identical legacy content when canonical entity already exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-identical-canonical-target-"));
  try {
    const name = "Café";
    const type = "project";
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    await seed.writeEntity(name, type, ["Canonical entity fact."]);
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    const originalContent = await readFile(canonicalPath, "utf-8");
    await writeFile(legacyPath, originalContent);
    await rm(path.join(dir, "state", "entity-canonical-id-migration-v1.json"));

    const migrating = new StorageManager(dir);
    await migrating.ensureDirectories();

    assert.equal(await readFile(canonicalPath, "utf-8"), originalContent);
    await assert.rejects(() => readFile(legacyPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories processes intermediate canonical-id mappings before collapsed ancestors", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-chain-"));
  try {
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    const previousCanonical = normalizeEntityName("Café", "project");
    const nextCanonical = "project-coffee";
    await seed.writeEntity("Café", "project", ["Canonical chain source."]);
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({
        version: 1,
        complete: true,
        mappings: {
          "project-cafe": previousCanonical,
        },
      }),
      "utf-8",
    );
    await writeFile(path.join(dir, "config", "aliases.json"), JSON.stringify({ "café": "coffee" }), "utf-8");

    await new StorageManager(dir).ensureDirectories();
    await new StorageManager(dir).ensureDirectories();

    const migratedContent = await readFile(path.join(dir, "entities", `${nextCanonical}.md`), "utf-8");
    assert.match(migratedContent, /# Café/);
    await assert.rejects(() => readFile(path.join(dir, "entities", `${previousCanonical}.md`)), { code: "ENOENT" });
    const state = JSON.parse(
      await readFile(path.join(dir, "state", "entity-canonical-id-migration-v1.json"), "utf-8"),
    ) as { complete?: unknown; mappings?: Record<string, string> };
    assert.equal(state.complete, true);
    assert.equal(state.mappings?.["project-cafe"], nextCanonical);
    assert.equal(state.mappings?.[previousCanonical], nextCanonical);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories reruns migration when aliases change and ignores reversals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-alias-fingerprint-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const previousCanonical = storage.normalizeEntityName("Café", "project");
    await storage.writeEntity("Café", "project", ["Alias fingerprint source."]);
    await storage.ensureDirectories();

    await writeFile(path.join(dir, "config", "aliases.json"), JSON.stringify({ "café": "coffee" }), "utf-8");
    await storage.loadAliases();
    const nextCanonical = storage.normalizeEntityName("Café", "project");
    assert.notEqual(previousCanonical, nextCanonical);

    await storage.ensureDirectories();

    assert.match(await readFile(path.join(dir, "entities", `${nextCanonical}.md`), "utf-8"), /# Café/);
    await assert.rejects(() => readFile(path.join(dir, "entities", `${previousCanonical}.md`)), { code: "ENOENT" });
    await rm(path.join(dir, "config", "aliases.json"));
    await storage.loadAliases();
    await storage.ensureDirectories();
    assert.equal(storage.normalizeEntityName("Café", "project"), nextCanonical);
    assert.match(await readFile(path.join(dir, "entities", `${nextCanonical}.md`), "utf-8"), /# Café/);
    await assert.rejects(() => readFile(path.join(dir, "entities", `${previousCanonical}.md`)), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("StorageManager rejects symlinked entity alias roots and files before loading them", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-alias-root-symlink-"));
  const fileDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-alias-file-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-alias-outside-"));
  try {
    await new StorageManager(rootDir).ensureDirectories();
    await new StorageManager(fileDir).ensureDirectories();
    await rm(path.join(rootDir, "config"), { recursive: true, force: true });
    await symlink(outsideDir, path.join(rootDir, "config"));
    assert.throws(() => new StorageManager(rootDir), /unsafe entity alias config|symlink/i);

    const outsideAliases = path.join(outsideDir, "aliases.json");
    await writeFile(outsideAliases, JSON.stringify({ café: "coffee" }), "utf-8");
    await symlink(outsideAliases, path.join(fileDir, "config", "aliases.json"));
    assert.throws(() => new StorageManager(fileDir), /unsafe entity alias config|symlink/i);
  } finally {
    await Promise.all([
      rm(rootDir, { recursive: true, force: true }),
      rm(fileDir, { recursive: true, force: true }),
      rm(outsideDir, { recursive: true, force: true }),
    ]);
  }
});

test(
  "StorageManager rejects a non-regular alias entry without opening it",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-alias-fifo-"));
    try {
      await new StorageManager(dir).ensureDirectories();
      const aliasPath = path.join(dir, "config", "aliases.json");
      execFileSync("mkfifo", [aliasPath]);

      assert.throws(() => new StorageManager(dir), /unsafe entity alias config|regular file/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test("ensureDirectories rejects a symlinked migration journal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-journal-symlink-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-journal-outside-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const journalPath = path.join(dir, "state", "entity-canonical-id-migration-v1.json");
    const outsideJournal = path.join(outsideDir, "migration.json");
    await writeFile(
      outsideJournal,
      JSON.stringify({ version: 1, complete: true, mappings: {} }),
      "utf-8",
    );
    await rm(journalPath, { force: true });
    await symlink(outsideJournal, journalPath);

    await assert.rejects(
      () => new StorageManager(dir).ensureDirectories(),
      /unsafe migration state file|symlink/i,
    );
    assert.deepEqual(
      JSON.parse(await readFile(outsideJournal, "utf-8")),
      { version: 1, complete: true, mappings: {} },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("ensureDirectories rejects unsafe ids retained in a completed migration journal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-unsafe-journal-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    await writeFile(
      path.join(dir, "state", "entity-canonical-id-migration-v1.json"),
      JSON.stringify({
        version: 1,
        complete: true,
        mappings: { "project-cafe": "project-foo\nbar" },
      }),
      "utf-8"
    );

    await assert.rejects(
      () => new StorageManager(dir).ensureDirectories(),
      /unsafe entity id|invalid entity canonical-id migration state/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAliases rejects path separators before they can affect entity writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-alias-path-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const name = "Café";
    const type = "project";
    const canonical = storage.normalizeEntityName(name, type);
    await storage.writeEntity(name, type, ["Canonical entity fact."]);
    const legacy = normalizeLegacyEntityName(name, type);
    await rename(path.join(dir, "entities", `${canonical}.md`), path.join(dir, "entities", `${legacy}.md`));
    await writeFile(path.join(dir, "config", "aliases.json"), JSON.stringify({ café: "foo/bar" }), "utf-8");
    await assert.rejects(() => storage.loadAliases(), /unsafe entity id|path separator/i);
    assert.equal(storage.normalizeEntityName(name, type), canonical);
    assert.match(await readFile(path.join(dir, "entities", `${legacy}.md`), "utf-8"), /# Café/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadAliases rejects control characters before they can affect entity writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-alias-control-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();
    const name = "Café";
    const type = "project";
    const canonical = storage.normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    await storage.writeEntity(name, type, ["Canonical entity fact."]);
    await rename(path.join(dir, "entities", `${canonical}.md`), path.join(dir, "entities", `${legacy}.md`));
    await writeFile(path.join(dir, "config", "aliases.json"), JSON.stringify({ café: "foo\nbar" }), "utf-8");
    await assert.rejects(() => storage.loadAliases(), /unsafe entity id|control character/i);
    assert.equal(storage.normalizeEntityName(name, type), canonical);
    assert.match(await readFile(path.join(dir, "entities", `${legacy}.md`), "utf-8"), /# Café/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories rejects symlinked entity roots and entries", async () => {
  const entryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-symlink-entry-"));
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-symlink-root-"));
  try {
    const entrySeed = new StorageManager(entryDir);
    await entrySeed.ensureDirectories();
    const outsideEntity = path.join(entryDir, "outside-entity.md");
    await writeFile(outsideEntity, "# Café\n**Type:** project\n", "utf-8");
    await symlink(outsideEntity, path.join(entryDir, "entities", "project-caf.md"));
    await rm(path.join(entryDir, "state", "entity-canonical-id-migration-v1.json"), { force: true });
    await assert.rejects(
      () => new StorageManager(entryDir).ensureDirectories(),
      /symlink/i,
    );

    const rootSeed = new StorageManager(rootDir);
    await rootSeed.ensureDirectories();
    const realEntitiesDir = path.join(rootDir, "entities-real");
    await rename(path.join(rootDir, "entities"), realEntitiesDir);
    await symlink(realEntitiesDir, path.join(rootDir, "entities"));
    await rm(path.join(rootDir, "state", "entity-canonical-id-migration-v1.json"), { force: true });
    await assert.rejects(
      () => new StorageManager(rootDir).ensureDirectories(),
      /symlink/i,
    );
  } finally {
    await Promise.all([
      rm(entryDir, { recursive: true, force: true }),
      rm(rootDir, { recursive: true, force: true }),
    ]);
  }
});

test("ensureDirectories rejects a symlinked memory root", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-root-target-"));
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-root-parent-"));
  const linkedRoot = path.join(parent, "linked-root");
  try {
    await symlink(target, linkedRoot);
    assert.throws(() => new StorageManager(linkedRoot), /unsafe .*memory root|symlink/i);
  } finally {
    await rm(linkedRoot, { force: true });
    await Promise.all([
      rm(target, { recursive: true, force: true }),
      rm(parent, { recursive: true, force: true }),
    ]);
  }
});

test("ensureDirectories rejects symlinked memory scan roots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-root-symlink-"));
  try {
    await new StorageManager(dir).ensureDirectories();
    for (const rootName of ["facts", "cold", "archive"]) {
      const root = path.join(dir, rootName);
      const realRoot = `${root}-real`;
      let existed = true;
      try {
        await lstat(root);
      } catch {
        existed = false;
      }
      if (existed) await rename(root, realRoot);
      const outside = await mkdtemp(path.join(os.tmpdir(), `remnic-outside-${rootName}-`));
      try {
        await symlink(outside, root);
        await assert.rejects(
          () => new StorageManager(dir).ensureDirectories(),
          /unsafe memory root|outside memoryDir|symlink/i,
        );
      } finally {
        await rm(root, { force: true });
        await rm(outside, { recursive: true, force: true });
        if (existed) await rename(realRoot, root);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureDirectories rejects symlinked cold memories before entity-ref migration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-memory-symlink-migration-"));
  try {
    const seed = new StorageManager(dir);
    await seed.ensureDirectories();
    const name = "Café";
    const type = "project";
    await seed.writeEntity(name, type, ["Canonical entity fact."]);
    const canonical = normalizeEntityName(name, type);
    const legacy = normalizeLegacyEntityName(name, type);
    const canonicalPath = path.join(dir, "entities", `${canonical}.md`);
    const legacyPath = path.join(dir, "entities", `${legacy}.md`);
    const memory = await seed.writeMemory("fact", "Legacy entity memory.", { entityRef: legacy });
    const persistedMemory = (await seed.readAllMemories()).find(
      (candidate) => candidate.frontmatter.id === memory.id,
    );
    assert.ok(persistedMemory);
    const originalMemory = await readFile(persistedMemory.path, "utf-8");
    const outsideMemory = path.join(dir, "outside-memory.md");
    await writeFile(outsideMemory, originalMemory, "utf-8");
    await writeFile(legacyPath, await readFile(canonicalPath, "utf-8"), "utf-8");
    const coldLink = path.join(dir, "cold", "facts", "linked.md");
    await mkdir(path.dirname(coldLink), { recursive: true });
    await symlink(outsideMemory, coldLink);

    await assert.rejects(
      () => new StorageManager(dir).ensureDirectories(),
      /symlinked memory/i,
    );
    assert.equal((await lstat(coldLink)).isSymbolicLink(), true);
    assert.equal(await readFile(outsideMemory, "utf-8"), originalMemory);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normalizeEntityName canonicalizes Unicode composition", () => {
  assert.equal(
    normalizeEntityName("Café", "project"),
    normalizeEntityName("Cafe\u0301", "project"),
  );
});

test("normalizeEntityName falls back to legacy alias keys", () => {
  assert.equal(normalizeEntityName("Café", "project", { caf: "coffee" }), "project-coffee");
  assert.equal(
    normalizeEntityName("Café", "project", { "café": "espresso", caf: "coffee" }),
    "project-espresso",
  );
});

test("normalizeEntityName preserves combining marks in canonical ids and text", () => {
  const base = normalizeEntityName("क", "project");
  const shortVowel = normalizeEntityName("कि", "project");
  const longVowel = normalizeEntityName("की", "project");
  assert.equal(shortVowel, "project-कि");
  assert.equal(longVowel, "project-की");
  assert.notEqual(base, shortVowel);
  assert.notEqual(shortVowel, longVowel);
  assert.equal(normalizeEntityText("कि"), "कि");
  assert.equal(normalizeEntityText("की"), "की");
});

test("writeEntity preserves structured sections alongside timeline evidence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Leads the roadmap."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });

    await storage.writeEntity(entityName, entityType, ["Owns release approvals now."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    ) as any;

    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
    ]);
    assert.deepEqual(parsed.facts, [
      "Leads the roadmap.",
      "Owns release approvals now.",
      "Small teams move faster than committees.",
      "Roadmaps should stay legible to the team.",
    ]);
    assert.equal(parsed.timeline.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity merges schema-backed sections even when incoming keys use raw casing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-schema-key-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, [], {
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });

    await storage.writeEntity(entityName, entityType, [], {
      structuredSections: [
        {
          key: "Beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );
    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");

    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
    ]);
    assert.deepEqual(parsed.facts, [
      "Small teams move faster than committees.",
      "Roadmaps should stay legible to the team.",
    ]);
    assert.doesNotMatch(raw, /## Facts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity marks section-only evidence updates as stale after synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-stale-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
    });

    const afterSynthesis = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );
    assert.equal(afterSynthesis.timeline.length, 1);
    assert.equal(afterSynthesis.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    await storage.writeEntity(entityName, entityType, [], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );
    assert.equal(parsed.timeline.length, 1);
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
      },
    ]);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis honors an explicit structured fact snapshot count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-snapshot-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    await storage.writeEntity(entityName, entityType, [], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe synthesis from the earlier structured snapshot.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );

    assert.equal(parsed.synthesisStructuredFactCount, 1);
    assert.equal(parsed.structuredSections?.[0]?.facts.length, 2);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity synthesis becomes stale when structured fact content changes without changing the count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-digest-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";
    const entityPath = path.join(dir, "entities", `${canonical}.md`);

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    const afterSynthesis = parseEntityFile(await readFile(entityPath, "utf-8"));
    assert.equal(afterSynthesis.synthesisStructuredFactCount, 1);
    assert.ok(afterSynthesis.synthesisStructuredFactDigest);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    const rewritten = {
      ...afterSynthesis,
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Roadmaps should stay legible to the team."],
        },
      ],
      facts: [
        "Initial fact before synthesis.",
        "Roadmaps should stay legible to the team.",
      ],
    };
    await writeFile(entityPath, serializeEntityFile(rewritten), "utf-8");

    const reparsed = parseEntityFile(await readFile(entityPath, "utf-8"));
    assert.equal(reparsed.structuredSections?.[0]?.facts.length, 1);
    assert.equal(reparsed.synthesisStructuredFactCount, 1);
    assert.ok(reparsed.synthesisStructuredFactDigest);
    assert.equal(isEntitySynthesisStale(reparsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isEntitySynthesisStale trims stored structured fact digests before comparing snapshots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-trimmed-digest-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";
    const entityPath = path.join(dir, "entities", `${canonical}.md`);

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
      structuredSections: [
        {
          key: "beliefs",
          title: "Beliefs",
          facts: ["Small teams move faster than committees."],
        },
      ],
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 1,
    });

    const afterSynthesis = parseEntityFile(await readFile(entityPath, "utf-8"));
    const rewritten = {
      ...afterSynthesis,
      synthesisStructuredFactDigest: `${afterSynthesis.synthesisStructuredFactDigest ?? ""}  `,
    };
    await writeFile(entityPath, serializeEntityFile(rewritten), "utf-8");

    const reparsed = parseEntityFile(await readFile(entityPath, "utf-8"));
    assert.equal(isEntitySynthesisStale(reparsed), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis preserves an explicit zero structured fact snapshot count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-structured-sections-zero-snapshot-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact before synthesis."], {
      timestamp,
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe keeps teams small and decisive.", {
      updatedAt: timestamp,
      entityUpdatedAt: timestamp,
      synthesisTimelineCount: 1,
      synthesisStructuredFactCount: 0,
    });

    const parsed = parseEntityFile(
      await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"),
    );

    assert.equal(parsed.synthesisStructuredFactCount, 0);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity marks same-timestamp appended evidence as stale after synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-same-ts-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);
    const timestamp = "2026-04-13T10:00:00.000Z";

    await storage.writeEntity(entityName, entityType, ["Initial fact at shared timestamp."], {
      timestamp,
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe initial synthesis.", {
      updatedAt: timestamp,
      synthesisTimelineCount: 1,
    });

    const afterSynthesisRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const afterSynthesis = parseEntityFile(afterSynthesisRaw);
    assert.equal(afterSynthesis.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    await storage.writeEntity(entityName, entityType, ["Second fact at the same shared timestamp."], {
      timestamp,
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.synthesisUpdatedAt, timestamp);
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity marks backfilled older evidence as stale after synthesis", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-backfill-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const entityName = "Jane Doe";
    const entityType = "person";
    const canonical = normalizeEntityName(entityName, entityType);

    await storage.writeEntity(entityName, entityType, ["Newest fact before synthesis."], {
      timestamp: "2026-04-13T11:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe current synthesis.", {
      updatedAt: "2026-04-13T11:00:00.000Z",
      synthesisTimelineCount: 1,
    });

    const afterSynthesisRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const afterSynthesis = parseEntityFile(afterSynthesisRaw);
    assert.equal(afterSynthesis.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(afterSynthesis), false);

    await storage.writeEntity(entityName, entityType, ["Backfilled older fact arrives later."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-2",
      principal: "agent:main",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T11:00:00.000Z");
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis preserves the provided evidence snapshot count", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-count-"));
  try {
    StorageManager.clearAllStaticCaches();
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = await storage.writeEntity("Jane Doe", "person", ["Initial synthesis evidence."], {
      timestamp: "2026-04-13T09:00:00.000Z",
      source: "extraction",
    });
    const beforeConcurrentAppend = parseEntityFile(await readFile(
      path.join(dir, "entities", `${canonical}.md`),
      "utf-8",
    ));
    assert.equal(beforeConcurrentAppend.timeline.length, 1);

    await storage.writeEntity("Jane Doe", "person", ["Backfilled older evidence."], {
      timestamp: "2026-04-13T08:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe synthesis from the original evidence snapshot.", {
      synthesisTimelineCount: beforeConcurrentAppend.timeline.length,
      updatedAt: "2026-04-13T09:00:00.000Z",
    });

    const parsed = parseEntityFile(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(parsed.timeline.length, 2);
    assert.equal(parsed.synthesisTimelineCount, 1);
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T09:00:00.000Z");
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis preserves unknown freshness when updatedAt is omitted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-unknown-updated-at-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = await storage.writeEntity("Jane Doe", "person", ["Legacy evidence without a timestamp."]);
    await storage.updateEntitySynthesis(canonical, "Jane Doe synthesis rebuilt from timestampless evidence.");

    const parsed = parseEntityFile(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(parsed.synthesis, "Jane Doe synthesis rebuilt from timestampless evidence.");
    assert.equal(parsed.synthesisUpdatedAt, undefined);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySummary preserves legacy fresh-summary semantics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-summary-storage-legacy-freshness-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = await storage.writeEntity("Jane Doe", "person", ["Legacy evidence without a timestamp."]);
    await storage.updateEntitySummary(canonical, "Jane Doe legacy summary.");

    const parsed = parseEntityFile(await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8"));

    assert.equal(parsed.synthesis, "Jane Doe legacy summary.");
    assert.equal(parsed.summary, "Jane Doe legacy summary.");
    assert.ok(parsed.synthesisUpdatedAt);
    assert.equal(parsed.updated, parsed.synthesisUpdatedAt);
    assert.equal(isEntitySynthesisStale(parsed), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeEntity skips duplicate timeline entries on repeated extraction writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-storage-dedupe-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const options = {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
      sessionKey: "session-1",
      principal: "agent:main",
    } as const;

    await storage.writeEntity("Jane Doe", "person", ["Leads the roadmap."], options);
    await storage.writeEntity("Jane Doe", "person", ["Leads the roadmap."], options);

    const canonical = normalizeEntityName("Jane Doe", "person");
    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 1);
    assert.equal(parsed.timeline[0]?.text, "Leads the roadmap.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration rewrites legacy summary plus facts files into synthesis plus timeline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "- Prefers short updates.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    const result = await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.equal(result.total, 1);
    assert.equal(result.migrated, 1);
    assert.match(migratedRaw, /## Synthesis/);
    assert.match(migratedRaw, /## Timeline/);
    assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.");
    assert.equal(parsed.synthesisUpdatedAt, undefined);
    assert.equal(isEntitySynthesisStale(parsed), true);
    assert.equal(parsed.timeline.length, 2);
    assert.deepEqual(
      parsed.timeline.map((entry) => entry.text),
      ["Leads roadmap work.", "Prefers short updates."],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration preserves unmodeled user-authored sections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-extra-sections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "",
      "## Notes",
      "",
      "Freeform notes that are not part of the compiled timeline yet.",
      "- Keep this checklist item too.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    const result = await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.equal(result.total, 1);
    assert.equal(result.migrated, 1);
    assert.match(migratedRaw, /## Notes/);
    assert.match(migratedRaw, /Freeform notes that are not part of the compiled timeline yet\./);
    assert.match(migratedRaw, /- Keep this checklist item too\./);
    assert.deepEqual(parsed.extraSections, [
      {
        title: "Notes",
        lines: [
          "",
          "Freeform notes that are not part of the compiled timeline yet.",
          "- Keep this checklist item too.",
          "",
        ],
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration preserves unknown frontmatter keys and pre-section prose", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-frontmatter-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "---",
      "created: 2026-04-12T09:00:00.000Z",
      "updated: 2026-04-12T10:00:00.000Z",
      "tags: [roadmap, vip]",
      "provenance: imported",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "Legacy prose before sections must survive migration.",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.match(migratedRaw, /tags: \[roadmap, vip\]/);
    assert.match(migratedRaw, /provenance: imported/);
    assert.match(migratedRaw, /Legacy prose before sections must survive migration\./);
    assert.deepEqual(parsed.extraFrontmatterLines, [
      "tags: [roadmap, vip]",
      "provenance: imported",
    ]);
    assert.deepEqual(parsed.preSectionLines, [
      "Legacy prose before sections must survive migration.",
      "",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entity migration preserves nested frontmatter without treating child keys as managed fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-migration-nested-frontmatter-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = "person-jane-doe";
    const legacy = [
      "---",
      "created: 2026-04-12T09:00:00.000Z",
      "updated: 2026-04-12T10:00:00.000Z",
      "meta:",
      "  created: nested-created-should-stay-verbatim",
      "  updated: nested-updated-should-stay-verbatim",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-12T10:00:00.000Z",
      "",
      "## Summary",
      "",
      "Jane Doe leads roadmap work.",
      "",
      "## Facts",
      "",
      "- Leads roadmap work.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", `${canonical}.md`), legacy, "utf-8");

    await storage.migrateEntityFilesToCompiledTruthTimeline();
    const migratedRaw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(migratedRaw);

    assert.match(migratedRaw, /^---\ncreated: 2026-04-12T09:00:00.000Z\nupdated: 2026-04-12T10:00:00.000Z/m);
    assert.match(migratedRaw, /meta:\n  created: nested-created-should-stay-verbatim\n  updated: nested-updated-should-stay-verbatim/);
    assert.deepEqual(parsed.extraFrontmatterLines, [
      "meta:",
      "  created: nested-created-should-stay-verbatim",
      "  updated: nested-updated-should-stay-verbatim",
    ]);
    assert.equal(parsed.created, "2026-04-12T09:00:00.000Z");
    assert.equal(parsed.updated, "2026-04-12T10:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeEntityFile persists stable created and updated frontmatter for entity reads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-frontmatter-stability-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:05:00.000Z",
    });

    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /^---\ncreated: 2026-04-13T10:00:00.000Z\nupdated: 2026-04-13T10:05:00.000Z/m);
    assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
    assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseEntityFile preserves bulleted synthesis text across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- Leads roadmap work.",
    "- Owns release approvals.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(parsed.synthesis, "- Leads roadmap work.\n- Owns release approvals.");
  assert.match(serialized, /## Synthesis\n\n- Leads roadmap work\.\n- Owns release approvals\./);
});

test("parseEntityFile migrates timeline-style synthesis bullets into the timeline", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] Approved production rollout.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.");
  assert.deepEqual(parsed.timeline, [{
    timestamp: "2026-04-13T10:00:00.000Z",
    text: "Approved production rollout.",
    source: "extraction",
  }]);
  assert.match(serialized, /## Synthesis\n\nJane Doe leads roadmap work\.\n\n## Timeline\n\n- \[2026-04-13T10:00:00.000Z\] \[source=extraction\] Approved production rollout\./);
  assert.equal(reparsed.synthesis, "Jane Doe leads roadmap work.");
  assert.equal(reparsed.timeline[0]?.text, "Approved production rollout.");
});

test("parseEntityFile keeps bracket-led synthesis bullets out of the timeline", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- [Q2] launched rollout.",
    "- [phase-2] release checklist is ready.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.equal(
    parsed.synthesis,
    "- [Q2] launched rollout.\n- [phase-2] release checklist is ready.",
  );
  assert.deepEqual(parsed.timeline, []);
  assert.match(serialized, /## Synthesis\n\n- \[Q2\] launched rollout\.\n- \[phase-2\] release checklist is ready\./);
  assert.deepEqual(reparsed.timeline, []);
  assert.equal(
    reparsed.synthesis,
    "- [Q2] launched rollout.\n- [phase-2] release checklist is ready.",
  );
});

test("parseEntityFile keeps metadata-shaped synthesis bullets out of the timeline", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- [source=qa] launch complete.",
    "- [session=retro] follow-up drafted.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.equal(
    parsed.synthesis,
    "- [source=qa] launch complete.\n- [session=retro] follow-up drafted.",
  );
  assert.deepEqual(parsed.timeline, []);
  assert.match(
    serialized,
    /## Synthesis\n\n- \[source=qa\] launch complete\.\n- \[session=retro\] follow-up drafted\./,
  );
  assert.deepEqual(reparsed.timeline, []);
  assert.equal(
    reparsed.synthesis,
    "- [source=qa] launch complete.\n- [session=retro] follow-up drafted.",
  );
});

test("parseEntityFile preserves structured person sections across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Beliefs",
    "",
    "- Small teams move faster than committees.",
    "",
    "## Building / Working On",
    "",
    "- A retrieval-first memory system.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw) as any;
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized) as any;

  assert.deepEqual(parsed.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Small teams move faster than committees."],
    },
    {
      key: "building",
      title: "Building / Working On",
      facts: ["A retrieval-first memory system."],
    },
  ]);
  assert.match(serialized, /## Beliefs\n\n- Small teams move faster than committees\./);
  assert.match(serialized, /## Building \/ Working On\n\n- A retrieval-first memory system\./);
  assert.deepEqual(reparsed.structuredSections, parsed.structuredSections);
});

test("parseEntityFile honors configured custom entity schemas", () => {
  const config = parseConfig({
    entitySchemas: {
      person: {
        sections: [
          { key: "operating_principles", title: "Operating Principles" },
        ],
      },
    },
  });

  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Operating Principles",
    "",
    "- Prefer boring infrastructure over clever infra.",
    "",
  ].join("\n"), config.entitySchemas) as any;

  assert.deepEqual(parsed.structuredSections, [
    {
      key: "operating_principles",
      title: "Operating Principles",
      facts: ["Prefer boring infrastructure over clever infra."],
    },
  ]);
});

test("parseEntityFile keeps caller-provided entity schemas isolated per parse", () => {
  const principlesConfig = parseConfig({
    entitySchemas: {
      person: {
        sections: [{ key: "operating_principles", title: "Operating Principles" }],
      },
    },
  });
  const beliefsConfig = parseConfig({
    entitySchemas: {
      person: {
        sections: [{ key: "beliefs", title: "Beliefs" }],
      },
    },
  });

  const parsedPrinciples = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Operating Principles",
    "",
    "- Prefer boring infrastructure over clever infra.",
    "",
  ].join("\n"), principlesConfig.entitySchemas) as any;
  const parsedBeliefs = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Beliefs",
    "",
    "- Small teams move faster than committees.",
    "",
  ].join("\n"), beliefsConfig.entitySchemas) as any;
  const parsedDefault = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Beliefs",
    "",
    "- Default schemas still apply without caller overrides.",
    "",
  ].join("\n")) as any;

  assert.deepEqual(parsedPrinciples.structuredSections, [
    {
      key: "operating_principles",
      title: "Operating Principles",
      facts: ["Prefer boring infrastructure over clever infra."],
    },
  ]);
  assert.deepEqual(parsedBeliefs.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Small teams move faster than committees."],
    },
  ]);
  assert.deepEqual(parsedDefault.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Default schemas still apply without caller overrides."],
    },
  ]);
});

test("entity timeline origin metadata does not consume literal origin-like text", () => {
  const entry = {
    timestamp: "2026-04-13T10:00:00.000Z",
    origin: "user",
    text: "[remnic-origin=tool_output] literal text",
  };
  const serialized = serializeEntityTimelineEntry(entry);
  assert.match(serialized, /\\\[remnic-origin=tool_output\]/);
  assert.deepEqual(
    parseEntityTimelineBullet(serialized.slice(2), "2026-04-13T00:00:00.000Z"),
    entry,
  );
  const uppercase = { ...entry, text: "[REMNIC-ORIGIN=tool_output] literal text" };
  const uppercaseSerialized = serializeEntityTimelineEntry(uppercase);
  assert.deepEqual(
    parseEntityTimelineBullet(uppercaseSerialized.slice(2), "2026-04-13T00:00:00.000Z"),
    uppercase,
  );
});

test("parseEntityFile preserves non-schema structured sections as structured facts", () => {
  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "---",
    "",
    "# Acme Corp",
    "",
    "**Type:** company",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Operating Principles",
    "",
    "- Prefer small, durable teams.",
    "",
  ].join("\n")) as any;

  assert.deepEqual(parsed.structuredSections, [
    {
      key: "operating_principles",
      title: "Operating Principles",
      facts: ["Prefer small, durable teams."],
    },
  ]);
  assert.deepEqual(parsed.facts, ["Prefer small, durable teams."]);
});

test("readAllEntityFiles keeps schema-aware cache entries isolated per storage manager", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-schema-cache-"));
  try {
    const bootstrapStorage = new StorageManager(dir);
    await bootstrapStorage.ensureDirectories();
    const raw = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Operating Principles",
      "",
      "- Prefer boring infrastructure over clever infra.",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "entities", "person-jane-doe.md"), raw, "utf-8");

    const principlesConfig = parseConfig({
      entitySchemas: {
        person: {
          sections: [{ key: "operating_principles", title: "Operating Principles" }],
        },
      },
    });
    const aliasConfig = parseConfig({
      entitySchemas: {
        person: {
          sections: [{ key: "principles", title: "Principles", aliases: ["Operating Principles"] }],
        },
      },
    });

    const firstStorage = new StorageManager(dir, principlesConfig.entitySchemas);
    const secondStorage = new StorageManager(dir, aliasConfig.entitySchemas);
    await firstStorage.ensureDirectories();
    await secondStorage.ensureDirectories();

    const firstEntity = (await firstStorage.readAllEntityFiles())[0] as any;
    const secondEntity = (await secondStorage.readAllEntityFiles())[0] as any;

    assert.equal(firstEntity.structuredSections?.[0]?.key, "operating_principles");
    assert.equal(secondEntity.structuredSections?.[0]?.key, "principles");
    assert.equal(secondEntity.structuredSections?.[0]?.title, "Principles");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseEntityFile preserves blank lines in multi-paragraph synthesis", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "She also owns release approvals.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(parsed.synthesis, "Jane Doe leads roadmap work.\n\nShe also owns release approvals.");
  assert.match(serialized, /Jane Doe leads roadmap work\.\n\nShe also owns release approvals\./);
});

test("parseEntityFile preserves indentation in synthesis content", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "- Parent point",
    "  - Nested point",
    "    code-ish detail",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.equal(
    parsed.synthesis,
    "- Parent point\n  - Nested point\n    code-ish detail",
  );
  assert.match(
    serialized,
    /## Synthesis\n\n- Parent point\n  - Nested point\n    code-ish detail/,
  );
});

test("parseEntityFile preserves unmodeled sections across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
    "## Notes",
    "",
    "Keep this freeform context.",
    "- Keep this checklist item too.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.extraSections, [
    {
      title: "Notes",
      lines: [
        "",
        "Keep this freeform context.",
        "- Keep this checklist item too.",
        "",
      ],
    },
  ]);
  assert.match(serialized, /## Notes\n\nKeep this freeform context\.\n- Keep this checklist item too\./);
});

test("parseEntityFile preserves unknown frontmatter keys and pre-section prose across round trips", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    "tags: [roadmap, vip]",
    "provenance: imported",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "Keep this pre-section context.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.extraFrontmatterLines, [
    "tags: [roadmap, vip]",
    "provenance: imported",
  ]);
  assert.deepEqual(parsed.preSectionLines, [
    "Keep this pre-section context.",
    "",
  ]);
  assert.match(serialized, /tags: \[roadmap, vip\]/);
  assert.match(serialized, /provenance: imported/);
  assert.match(serialized, /\*\*Updated:\*\* 2026-04-13T10:05:00.000Z\n\nKeep this pre-section context\./);
});

test("parseEntityFile preserves prose between type and updated headers", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "",
    "Legacy prose between type and updated must survive round trips.",
    "",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.preSectionLines, [
    "Legacy prose between type and updated must survive round trips.",
    "",
    "",
  ]);
  assert.match(serialized, /Legacy prose between type and updated must survive round trips\./);
});

test("parseEntityFile preserves bracket-prefixed timeline facts", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] [Q2] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.text, "[Q2] launched rollout");
  assert.equal(parsed.timeline[0]?.source, "extraction");
});

test("parseEntityFile preserves unknown bracket tokens after known timeline metadata", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=extraction] [custom=val] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.source, "extraction");
  assert.equal(parsed.timeline[0]?.text, "[custom=val] launched rollout");
});

test("parseEntityFile treats a single metadata-like token followed by text as literal timeline text", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] [source=qa] launch complete",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.timeline[0]?.source, undefined);
  assert.equal(parsed.timeline[0]?.text, "[source=qa] launch complete");
});

test("serializeEntityFile escapes bracket characters in timeline metadata values", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  parsed.timeline = [{
    timestamp: "2026-04-13T10:00:00.000Z",
    text: "launched rollout",
    source: "qa]team",
    sessionKey: "session\\]42",
    principal: "agent\\main]ops",
  }];

  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.match(serialized, /\[source_meta=qa\\\]team\]/);
  assert.match(serialized, /\[session=session\\\\\\]42\]/);
  assert.match(serialized, /\[principal=agent\\\\main\\\]ops\]/);
  assert.equal(reparsed.timeline[0]?.source, "qa]team");
  assert.equal(reparsed.timeline[0]?.sessionKey, "session\\]42");
  assert.equal(reparsed.timeline[0]?.principal, "agent\\main]ops");
  assert.equal(reparsed.timeline[0]?.text, "launched rollout");
});

test("writeEntity preserves custom timeline source metadata without injecting it into text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-custom-source-roundtrip-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    await storage.writeEntity("Jane Doe", "person", ["launch complete"], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "qa",
    });

    const canonical = normalizeEntityName("Jane Doe", "person");
    const raw = await readFile(path.join(dir, "entities", `${canonical}.md`), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.match(raw, /\[source_meta=qa\] launch complete/);
    assert.equal(parsed.timeline[0]?.source, "qa");
    assert.equal(parsed.timeline[0]?.text, "launch complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serializeEntityFile escapes newline characters in timeline metadata values", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] launched rollout",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  parsed.timeline = [{
    timestamp: "2026-04-13T10:00:00.000Z",
    text: "launched rollout",
    source: "qa-team",
    sessionKey: "session-42\nchild",
    principal: "agent\r\nops",
  }];

  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.doesNotMatch(serialized, /\[session=[^\]]*\n/);
  assert.doesNotMatch(serialized, /\[principal=[^\]]*\n/);
  assert.match(serialized, /\[session=session-42\\nchild\]/);
  assert.match(serialized, /\[principal=agent\\r\\nops\]/);
  assert.equal(reparsed.timeline[0]?.sessionKey, "session-42\nchild");
  assert.equal(reparsed.timeline[0]?.principal, "agent\r\nops");
  assert.equal(reparsed.timeline[0]?.text, "launched rollout");
});

test("serializeEntityFile avoids double spaces for tokenless timeline entries", () => {
  const serialized = serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: 1,
    synthesisVersion: 1,
    timeline: [
      { timestamp: "", text: "Owns rollout coordination." },
    ],
    relationships: [],
    activity: [],
    aliases: [],
  });
  const reparsed = parseEntityFile(serialized);

  assert.match(serialized, /## Timeline\n\n- Owns rollout coordination\./);
  assert.doesNotMatch(serialized, /-  Owns rollout coordination\./);
  assert.equal(reparsed.timeline[0]?.text, "Owns rollout coordination.");
});

test("serializeEntityFile does not append a blank line for empty extra sections", () => {
  const serialized = serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: 1,
    synthesisVersion: 1,
    timeline: [{ timestamp: "", text: "Owns rollout coordination." }],
    relationships: [],
    activity: [],
    aliases: [],
    extraSections: [{ title: "Empty Notes", lines: [] }],
  });

  assert.match(serialized, /## Empty Notes$/);
  assert.doesNotMatch(serialized, /## Empty Notes\n$/);
});

test("parseEntityFile merges legacy facts into mixed timeline entities", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);

  assert.deepEqual(parsed.facts, ["Leads roadmap work.", "Prefers short updates."]);
  assert.match(serialized, /## Timeline/);
  assert.match(serialized, /Leads roadmap work\./);
  assert.match(serialized, /Prefers short updates\./);
});

test("parseEntityFile preserves entity frontmatter from CRLF files", () => {
  const raw = [
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z"',
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\r\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
  assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisVersion, 2);
});

test("parseEntityFile normalizes single-quoted managed frontmatter timestamps", () => {
  const raw = [
    "---",
    "created: '2026-04-13T10:00:00.000Z'",
    "updated: '2026-04-13T10:05:00.000Z'",
    "synthesis_updated_at: '2026-04-13T10:05:00.000Z'",
    "synthesis_version: 2",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T10:00:00.000Z] Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
  assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:05:00.000Z");
});

test("parseEntityFile strips inline YAML comments from managed frontmatter values", () => {
  const raw = [
    "---",
    'created: "2026-04-13T10:00:00.000Z" # imported',
    "updated: 2026-04-13T10:05:00.000Z # regenerated",
    'synthesis_updated_at: "2026-04-13T10:05:00.000Z" # generated',
    "synthesis_timeline_count: 2 # evidence snapshot",
    "synthesis_version: 3 # schema version",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.created, "2026-04-13T10:00:00.000Z");
  assert.equal(parsed.updated, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:05:00.000Z");
  assert.equal(parsed.synthesisTimelineCount, 2);
  assert.equal(parsed.synthesisVersion, 3);
});

test("parseEntityFile leaves legacy summary synthesis timestamp unset without explicit frontmatter", () => {
  const raw = [
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Summary",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Leads roadmap work.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.equal(parsed.synthesisUpdatedAt, undefined);
  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("parseEntityFile preserves unknown timestamps for legacy facts without metadata", () => {
  const raw = [
    "# Jane Doe",
    "",
    "**Type:** person",
    "",
    "## Facts",
    "",
    "- Leads roadmap work.",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);

  assert.deepEqual(parsed.timeline.map((entry) => entry.timestamp), ["", ""]);
  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("serializeEntityFile does not invent synthesis timeline count for unsynthesized legacy entities", () => {
  const raw = [
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Summary",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Facts",
    "",
    "- Leads roadmap work.",
    "- Prefers short updates.",
    "",
  ].join("\n");

  const parsed = parseEntityFile(raw);
  const serialized = serializeEntityFile(parsed);
  const reparsed = parseEntityFile(serialized);

  assert.doesNotMatch(serialized, /synthesis_timeline_count:/);
  assert.doesNotMatch(serialized, /\[\]/);
  assert.match(serialized, /\[source=migration\] Leads roadmap work\./);
  assert.deepEqual(reparsed.timeline.map((entry) => entry.source), ["migration", "migration"]);
  assert.equal(reparsed.synthesisTimelineCount, undefined);
  assert.equal(isEntitySynthesisStale(reparsed), true);
});

test("timestamp-less synthesized legacy entities stay fresh when the evidence snapshot count matches", () => {
  const reparsed = parseEntityFile(serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination.", "Keeps release notes current."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: 2,
    synthesisVersion: 1,
    timeline: [
      { timestamp: "", text: "Owns rollout coordination.", source: "migration" },
      { timestamp: "", text: "Keeps release notes current.", source: "migration" },
    ],
    relationships: [],
    activity: [],
    aliases: [],
  }));

  assert.deepEqual(reparsed.timeline.map((entry) => entry.timestamp), ["", ""]);
  assert.equal(reparsed.synthesisTimelineCount, 2);
  assert.equal(isEntitySynthesisStale(reparsed), false);
});

test("timestamp-less synthesized legacy entities stay fresh without synthesisUpdatedAt when the evidence snapshot count matches", () => {
  const reparsed = parseEntityFile(serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination.", "Keeps release notes current."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: undefined,
    synthesisTimelineCount: 2,
    synthesisVersion: 1,
    timeline: [
      { timestamp: "", text: "Owns rollout coordination.", source: "migration" },
      { timestamp: "", text: "Keeps release notes current.", source: "migration" },
    ],
    relationships: [],
    activity: [],
    aliases: [],
  }));

  assert.deepEqual(reparsed.timeline.map((entry) => entry.timestamp), ["", ""]);
  assert.equal(reparsed.synthesisUpdatedAt, undefined);
  assert.equal(reparsed.synthesisTimelineCount, 2);
  assert.equal(isEntitySynthesisStale(reparsed), false);
});

test("serializeEntityFile preserves facts-only entities as legacy facts instead of synthetic timeline entries", () => {
  const serialized = serializeEntityFile({
    name: "Casey Example",
    type: "person",
    created: "2026-04-13T10:00:00.000Z",
    updated: "2026-04-13T10:05:00.000Z",
    facts: ["Owns rollout coordination.", "Owns rollout coordination.", "Keeps release notes current."],
    summary: "Casey Example keeps rollout coordination on track.",
    synthesis: "Casey Example keeps rollout coordination on track.",
    synthesisUpdatedAt: "2026-04-13T10:05:00.000Z",
    synthesisTimelineCount: undefined,
    synthesisVersion: 1,
    timeline: [],
    relationships: [],
    activity: [],
    aliases: [],
  });

  const reparsed = parseEntityFile(serialized);

  assert.match(serialized, /## Facts\n\n- Owns rollout coordination\.\n- Keeps release notes current\./);
  assert.doesNotMatch(serialized, /## Timeline/);
  assert.doesNotMatch(serialized, /\[source=migration\]/);
  assert.deepEqual(reparsed.facts, ["Owns rollout coordination.", "Keeps release notes current."]);
  assert.equal(reparsed.timeline.length, 2);
  assert.equal(reparsed.timeline[0]?.source, "migration");
  assert.equal(isEntitySynthesisStale(reparsed), true);
});

test("compareEntityTimestamps treats equivalent parsed instants as equal", () => {
  assert.equal(compareEntityTimestamps("2026-04-13T15:00:00Z", "2026-04-13T10:00:00-05:00"), 0);
  assert.equal(compareEntityTimestamps("2026-04-13T10:00:00-05:00", "2026-04-13T15:00:00Z"), 0);
});

test("entity synthesis staleness uses parsed timestamps instead of raw string ordering", () => {
  const parsed = parseEntityFile([
    "---",
    "created: 2026-04-13T10:00:00.000Z",
    "updated: 2026-04-13T10:05:00.000Z",
    'synthesis_updated_at: "2026-04-13T14:30:00Z"',
    "synthesis_version: 1",
    "---",
    "",
    "# Jane Doe",
    "",
    "**Type:** person",
    "**Updated:** 2026-04-13T10:05:00.000Z",
    "",
    "## Synthesis",
    "",
    "Jane Doe leads roadmap work.",
    "",
    "## Timeline",
    "",
    "- [2026-04-13T14:45:00Z] Reviewed rollout metrics",
    "- [2026-04-13T10:00:00-05:00] Approved production rollout",
    "",
  ].join("\n"));

  assert.equal(isEntitySynthesisStale(parsed), true);
});

test("mergeFragmentedEntities prefers the freshest synthesis using parsed timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-synthesis-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T14:45:00Z",
      'synthesis_updated_at: "2026-04-13T14:45:00Z"',
      "synthesis_version: 1",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T14:45:00Z",
      "",
      "## Synthesis",
      "",
      "Older synthesis should lose.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T14:45:00Z] Older evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:00:00-05:00",
      'synthesis_updated_at: "2026-04-13T10:00:00-05:00"',
      "synthesis_version: 2",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:00:00-05:00",
      "",
      "## Synthesis",
      "",
      "Newest offset synthesis should win.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:00:00-05:00] Newer evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    const merged = await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(merged, 2);
    assert.equal(parsed.synthesis, "Newest offset synthesis should win.");
    assert.equal(parsed.synthesisUpdatedAt, "2026-04-13T10:00:00-05:00");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities keeps legacy synthesis timestamps unset when freshness is unknown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-legacy-synthesis-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const legacySummaryFragment = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Summary",
      "",
      "Legacy summary should remain stale until refreshed.",
      "",
      "## Facts",
      "",
      "- [2026-04-13T10:05:00.000Z] Older fact",
      "",
    ].join("\n");
    const newerTimelineFragment = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Newer evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), legacySummaryFragment, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), newerTimelineFragment, "utf-8");

    const merged = await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(merged, 2);
    assert.equal(parsed.synthesis, "Legacy summary should remain stale until refreshed.");
    assert.equal(parsed.synthesisUpdatedAt, undefined);
    assert.equal(isEntitySynthesisStale(parsed), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities preserves custom metadata and freeform sections from fragments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-metadata-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "tags: [alpha]",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "Fragment A prose.",
      "",
      "## Synthesis",
      "",
      "Fragment A synthesis.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] Fragment A evidence",
      "",
      "## Notes",
      "",
      "Fragment A notes.",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "owner: ops",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "Fragment B prose.",
      "",
      "## Synthesis",
      "",
      "Fragment B synthesis.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Fragment B evidence",
      "",
      "## Runbook",
      "",
      "Fragment B runbook notes.",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.deepEqual(parsed.extraFrontmatterLines, ["tags: [alpha]", "owner: ops"]);
    assert.deepEqual(parsed.preSectionLines, ["Fragment A prose.", "", "Fragment B prose.", ""]);
    assert.deepEqual(parsed.extraSections?.map((section) => section.title), ["Notes", "Runbook"]);
    assert.match(raw, /## Notes/);
    assert.match(raw, /## Runbook/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities preserves structured sections from fragments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-structured-sections-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Beliefs",
      "",
      "- [remnic-meta-v1] [remnic-origin=user] Small teams move faster than committees.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] Fragment A evidence",
      "- [remnic-meta-v1] [remnic-origin=tool_output] Roadmaps should stay legible to the team.",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "## Beliefs",
      "",
      "- [remnic-meta-v1] [remnic-origin=tool_output] Roadmaps should stay legible to the team.",
      "",
      "## Communication Style",
      "",
      "- Prefers direct feedback without ceremony.",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Fragment B evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw) as any;

    assert.deepEqual(parsed.structuredSections, [
      {
        key: "beliefs",
        title: "Beliefs",
        facts: [
          "Small teams move faster than committees.",
          "Roadmaps should stay legible to the team.",
        ],
        factOrigins: ["user", "tool_output"],
      },
      {
        key: "communication_style",
        title: "Communication Style",
        facts: ["Prefers direct feedback without ceremony."],
      },
    ]);
    assert.match(raw, /## Beliefs/);
    assert.match(raw, /## Communication Style/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities uses a collision-safe timeline dedupe key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-timeline-key-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] [source=extraction] [session=foo::bar] preserved rollout evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:06:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:06:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] [source=extraction] [session=foo] [principal=bar::] preserved rollout evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.timeline.length, 2);
    assert.deepEqual(
      parsed.timeline.map((entry) => ({
        sessionKey: entry.sessionKey,
        principal: entry.principal,
        text: entry.text,
      })),
      [
        {
          sessionKey: "foo::bar",
          principal: undefined,
          text: "preserved rollout evidence",
        },
        {
          sessionKey: "foo",
          principal: "bar::",
          text: "preserved rollout evidence",
        },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities preserves duplicate lines in preserved metadata blocks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-duplicate-lines-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:05:00.000Z",
      "labels:",
      "- foo",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "Repeated line",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T10:00:00.000Z",
      "updated: 2026-04-13T10:06:00.000Z",
      "owners:",
      "- foo",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:06:00.000Z",
      "",
      "Repeated line",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.deepEqual(parsed.extraFrontmatterLines, ["labels:", "- foo", "owners:", "- foo"]);
    assert.deepEqual(parsed.preSectionLines, ["Repeated line", "", "Repeated line", ""]);
    assert.match(raw, /labels:\n- foo\nowners:\n- foo/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeFragmentedEntities prefers parseable created timestamps over malformed values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-merge-created-validity-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const fragmentA = [
      "---",
      "created: not-a-date",
      "updated: 2026-04-13T10:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T10:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T10:05:00.000Z] Fragment A evidence",
      "",
    ].join("\n");
    const fragmentB = [
      "---",
      "created: 2026-04-13T09:00:00.000Z",
      "updated: 2026-04-13T11:05:00.000Z",
      "---",
      "",
      "# Jane Doe",
      "",
      "**Type:** person",
      "**Updated:** 2026-04-13T11:05:00.000Z",
      "",
      "## Timeline",
      "",
      "- [2026-04-13T11:05:00.000Z] Fragment B evidence",
      "",
    ].join("\n");

    await writeFile(path.join(dir, "entities", "person-jane doe.md"), fragmentA, "utf-8");
    await writeFile(path.join(dir, "entities", "person-jane_doe.md"), fragmentB, "utf-8");

    await storage.mergeFragmentedEntities();
    const raw = await readFile(path.join(dir, "entities", "person-jane-doe.md"), "utf-8");
    const parsed = parseEntityFile(raw);

    assert.equal(parsed.created, "2026-04-13T09:00:00.000Z");
    assert.match(raw, /^---\ncreated: 2026-04-13T09:00:00.000Z/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshEntitySynthesisQueue orders stale entities by parsed latest timeline timestamps", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-order-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const newerCanonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Newest offset entity should lead the queue."], {
      timestamp: "2026-04-13T10:00:00-05:00",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(newerCanonical, "Jane Doe had an older synthesis.", {
      updatedAt: "2026-04-13T14:30:00Z",
      synthesisTimelineCount: 1,
    });

    const olderCanonical = normalizeEntityName("Project Beta", "project");
    await storage.writeEntity("Project Beta", "project", ["Older UTC entity should come second."], {
      timestamp: "2026-04-13T14:45:00Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(olderCanonical, "Project Beta had an older synthesis.", {
      updatedAt: "2026-04-13T14:40:00Z",
      synthesisTimelineCount: 1,
    });

    const queue = await storage.refreshEntitySynthesisQueue();

    assert.deepEqual(queue, [newerCanonical, olderCanonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refreshEntitySynthesisQueue keeps canonical filenames when headings drift", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-filename-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonical = normalizeEntityName("Jane Doe", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });
    await storage.updateEntitySynthesis(canonical, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:01:00.000Z",
      synthesisTimelineCount: 1,
    });
    await storage.writeEntity("Jane Do", "person", ["Newest stale fact."], {
      timestamp: "2026-04-13T10:02:00.000Z",
      source: "extraction",
    });

    const queue = await storage.refreshEntitySynthesisQueue();

    assert.deepEqual(queue, [canonical]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateEntitySynthesis removes queue entries that match the parsed canonical heading", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-entity-synthesis-queue-remove-"));
  try {
    const storage = new StorageManager(dir);
    await storage.ensureDirectories();

    const canonicalFilename = normalizeEntityName("Jane Doe", "person");
    const parsedCanonical = normalizeEntityName("Jane Do", "person");
    await storage.writeEntity("Jane Doe", "person", ["Leads roadmap work."], {
      timestamp: "2026-04-13T10:00:00.000Z",
      source: "extraction",
    });

    const entityPath = path.join(dir, "entities", `${canonicalFilename}.md`);
    const raw = await readFile(entityPath, "utf-8");
    await writeFile(entityPath, raw.replace("# Jane Doe", "# Jane Do"), "utf-8");
    await writeFile(
      path.join(dir, "state", "entity-synthesis-queue.json"),
      JSON.stringify({
        updatedAt: "2026-04-13T10:05:00.000Z",
        entityNames: [parsedCanonical],
      }, null, 2) + "\n",
      "utf-8",
    );

    await storage.updateEntitySynthesis(canonicalFilename, "Jane Doe leads roadmap work.", {
      updatedAt: "2026-04-13T10:06:00.000Z",
      synthesisTimelineCount: 1,
    });

    const queue = await storage.readEntitySynthesisQueue();

    assert.deepEqual(queue, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
