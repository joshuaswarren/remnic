import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { StorageManager } from "../src/storage.ts";
import {
  backupExistingProjection,
  rebuildMemoryProjection,
  repairMemoryProjection,
  verifyMemoryProjection,
} from "../src/maintenance/rebuild-memory-projection.ts";
import { runMemoryGovernance } from "../src/maintenance/memory-governance.ts";
import {
  getMemoryProjectionPath,
  initializeMemoryProjectionDb,
  readProjectedEntityMentions,
  readProjectedLatestReviewQueue,
  readProjectedMemoryBrowse,
  readProjectedMemoryState,
  readProjectedMemoryTimeline,
  readProjectedNativeKnowledgeChunks,
} from "../src/memory-projection-store.ts";

async function writeText(baseDir: string, relPath: string, content: string): Promise<void> {
  const full = path.join(baseDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function memoryDoc(options: {
  id: string;
  content: string;
  category?: string;
  created?: string;
  updated?: string;
  confidence?: number;
  confidenceTier?: string;
  entityRef?: string;
  tags?: string[];
}): string {
  return [
    "---",
    `id: ${options.id}`,
    `category: ${options.category ?? "fact"}`,
    `created: ${options.created ?? "2026-03-01T00:00:00.000Z"}`,
    `updated: ${options.updated ?? options.created ?? "2026-03-01T00:00:00.000Z"}`,
    "source: test",
    `confidence: ${options.confidence ?? 0.8}`,
    `confidenceTier: ${options.confidenceTier ?? "implied"}`,
    `tags: [${(options.tags ?? ["projection"]).map((tag) => `"${tag}"`).join(", ")}]`,
    ...(options.entityRef ? [`entityRef: ${options.entityRef}`] : []),
    "---",
    "",
    options.content,
    "",
  ].join("\n");
}

test("projection-store queries fail open when projection database is absent", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-missing-"));
  try {
    const current = readProjectedMemoryState(memoryDir, "missing-memory");
    const timeline = readProjectedMemoryTimeline(memoryDir, "missing-memory", 50);

    assert.equal(current, null);
    assert.equal(timeline, null);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("projection-store skips current rows whose paths escape the memory directory", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-escape-base-"));
  const memoryDir = path.join(baseDir, "memory");
  const outsidePath = path.join(baseDir, "outside.md");
  try {
    await mkdir(memoryDir, { recursive: true });
    await writeFile(outsidePath, "escaped projection needle", "utf-8");
    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    const db = new Database(projectionPath);
    try {
      initializeMemoryProjectionDb(db);
      db.prepare(`
        INSERT INTO memory_current (
          memory_id,
          category,
          status,
          lifecycle_state,
          path_rel,
          created_at,
          updated_at,
          archived_at,
          superseded_at,
          entity_ref,
          source,
          confidence,
          confidence_tier,
          memory_kind,
          access_count,
          last_accessed,
          tags_json,
          preview_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "escaped-row",
        "fact",
        "active",
        null,
        "../outside.md",
        "2026-03-08T00:00:00.000Z",
        "2026-03-08T01:00:00.000Z",
        null,
        null,
        null,
        "test",
        0.8,
        "implied",
        null,
        null,
        null,
        "[]",
        "",
      );
    } finally {
      db.close();
    }

    assert.equal(readProjectedMemoryState(memoryDir, "escaped-row"), null);
    const browse = readProjectedMemoryBrowse(memoryDir, {
      query: "escaped projection needle",
      limit: 10,
      offset: 0,
    });
    assert.equal(browse?.total, 0);
    assert.deepEqual(browse?.memories, []);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection dry-run computes current rows and timeline rows without writing output", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-dry-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    );

    const result = await rebuildMemoryProjection({ memoryDir });
    assert.equal(result.dryRun, true);
    assert.equal(result.currentRows, 1);
    assert.equal(result.timelineRows, 2);
    assert.equal(result.usedLifecycleLedger, false);
    await assert.rejects(() => stat(result.outputPath));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection includes hot cold and archived memories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-cold-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-hot.md",
      memoryDoc({
        id: "fact-hot",
        content: "hot memory",
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T01:00:00.000Z",
        tags: ["hot"],
      }),
    );
    await writeText(
      memoryDir,
      "cold/facts/2026-03-08/fact-cold.md",
      memoryDoc({
        id: "fact-cold",
        content: "cold memory",
        created: "2026-03-08T02:00:00.000Z",
        updated: "2026-03-08T03:00:00.000Z",
        tags: ["cold"],
      }),
    );
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      [
        "---",
        "id: fact-archived",
        "category: fact",
        "created: 2026-03-08T04:00:00.000Z",
        "updated: 2026-03-08T05:00:00.000Z",
        "source: test",
        "confidence: 0.8",
        "confidenceTier: implied",
        'tags: ["archived"]',
        "status: archived",
        "archivedAt: 2026-03-08T06:00:00.000Z",
        "---",
        "",
        "archived memory",
        "",
      ].join("\n"),
    );

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    assert.equal(result.scannedMemories, 3);
    assert.equal(result.currentRows, 3);
    assert.equal(result.timelineRows, 7);
    assert.ok(readProjectedMemoryState(memoryDir, "fact-hot"));
    assert.ok(readProjectedMemoryState(memoryDir, "fact-cold"));
    assert.ok(readProjectedMemoryState(memoryDir, "fact-archived"));
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection writes current-state and timeline rows and backs up existing projection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-live-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
entityRef: person-josh
---

alpha
`,
    );
    await writeText(
      memoryDir,
      "state/memory-lifecycle-ledger.jsonl",
      [
        JSON.stringify({
          eventId: "evt-1",
          memoryId: "fact-1",
          eventType: "created",
          timestamp: "2026-03-08T00:00:00.000Z",
          actor: "storage.writeMemory",
          ruleVersion: "memory-lifecycle-ledger.v1",
        }),
        JSON.stringify({
          eventId: "evt-2",
          memoryId: "fact-1",
          eventType: "updated",
          timestamp: "2026-03-08T01:00:00.000Z",
          actor: "storage.updateMemory",
          ruleVersion: "memory-lifecycle-ledger.v1",
        }),
      ].join("\n") + "\n",
    );
    await writeText(memoryDir, "state/memory-projection.sqlite", "legacy-db");

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });
    assert.equal(result.currentRows, 1);
    assert.equal(result.timelineRows, 2);
    assert.equal(result.usedLifecycleLedger, true);
    assert.equal(result.backupPath != null, true);
    await stat(result.outputPath);

    const backupRaw = await readFile(result.backupPath as string, "utf-8");
    assert.equal(backupRaw, "legacy-db");

    const current = readProjectedMemoryState(memoryDir, "fact-1");
    assert.ok(current);
    assert.equal(current?.entityRef, "person-josh");
    assert.equal(current?.status, "active");

    const timeline = readProjectedMemoryTimeline(memoryDir, "fact-1", 20);
    assert.ok(timeline);
    assert.deepEqual(
      timeline?.map((entry) => [entry.eventType, entry.timestamp]),
      [
        ["created", "2026-03-08T00:00:00.000Z"],
        ["updated", "2026-03-08T01:00:00.000Z"],
      ],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("projection reads lazily migrate legacy schema columns for existing projection stores", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-legacy-browse-"));
  try {
    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-legacy.md",
      memoryDoc({
        id: "fact-legacy",
        content: `${"alpha ".repeat(60)}needle beyond preview depth`,
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T01:00:00.000Z",
      }),
    );

    const db = new Database(projectionPath);
    try {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE memory_current (
          memory_id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          lifecycle_state TEXT,
          path_rel TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          superseded_at TEXT,
          entity_ref TEXT,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          confidence_tier TEXT NOT NULL,
          memory_kind TEXT,
          access_count INTEGER,
          last_accessed TEXT
        );
      `);
      db.prepare(`
        INSERT INTO memory_current (
          memory_id,
          category,
          status,
          lifecycle_state,
          path_rel,
          created_at,
          updated_at,
          archived_at,
          superseded_at,
          entity_ref,
          source,
          confidence,
          confidence_tier,
          memory_kind,
          access_count,
          last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "fact-legacy",
        "fact",
        "active",
        null,
        "facts/2026-03-08/fact-legacy.md",
        "2026-03-08T00:00:00.000Z",
        "2026-03-08T01:00:00.000Z",
        null,
        null,
        null,
        "test",
        0.8,
        "implied",
        null,
        null,
        null,
      );

    } finally {
      db.close();
    }

    const projected = readProjectedMemoryState(memoryDir, "fact-legacy");
    assert.ok(projected);
    assert.equal(projected?.memoryId, "fact-legacy");

    const browse = readProjectedMemoryBrowse(memoryDir, {
      limit: 20,
      offset: 0,
    });
    assert.ok(browse);
    assert.equal(browse?.total, 1);
    assert.equal(browse?.memories[0]?.id, "fact-legacy");

    const migrated = new Database(projectionPath, { readonly: true });
    try {
      const columns = migrated
        .prepare(`PRAGMA table_info(memory_current)`)
        .all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => column.name === "tags_json"), true);
      assert.equal(columns.some((column) => column.name === "preview_text"), true);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("verifyMemoryProjection treats legacy projection schemas as existing rows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-legacy-verify-"));
  try {
    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-legacy.md",
      memoryDoc({
        id: "fact-legacy",
        content: "legacy verify row",
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T01:00:00.000Z",
      }),
    );

    const db = new Database(projectionPath);
    try {
      db.exec(`
        CREATE TABLE memory_current (
          memory_id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          lifecycle_state TEXT,
          path_rel TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          superseded_at TEXT,
          entity_ref TEXT,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          confidence_tier TEXT NOT NULL,
          memory_kind TEXT,
          access_count INTEGER,
          last_accessed TEXT
        );
      `);
      db.prepare(`
        INSERT INTO memory_current (
          memory_id,
          category,
          status,
          lifecycle_state,
          path_rel,
          created_at,
          updated_at,
          archived_at,
          superseded_at,
          entity_ref,
          source,
          confidence,
          confidence_tier,
          memory_kind,
          access_count,
          last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "fact-legacy",
        "fact",
        "active",
        null,
        "facts/2026-03-08/fact-legacy.md",
        "2026-03-08T00:00:00.000Z",
        "2026-03-08T01:00:00.000Z",
        null,
        null,
        null,
        "test",
        0.8,
        "implied",
        null,
        null,
        null,
      );
    } finally {
      db.close();
    }

    const verify = await verifyMemoryProjection({ memoryDir });
    assert.equal(verify.projectionExists, true);
    assert.equal(verify.actualCurrentRows, 1);
    assert.deepEqual(verify.missingCurrentMemoryIds, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scoped rebuild preserves out-of-scope legacy projection rows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-legacy-scope-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-older.md",
      `---
id: fact-older
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-original
tags: ["older"]
---

older
`,
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-after
tags: ["recent"]
---

recent updated
`,
    );

    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    const db = new Database(projectionPath);
    try {
      db.exec(`
        CREATE TABLE memory_current (
          memory_id TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          lifecycle_state TEXT,
          path_rel TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          superseded_at TEXT,
          entity_ref TEXT,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          confidence_tier TEXT NOT NULL,
          memory_kind TEXT,
          access_count INTEGER,
          last_accessed TEXT
        );

        CREATE TABLE memory_timeline (
          event_id TEXT PRIMARY KEY,
          memory_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          event_order INTEGER NOT NULL,
          actor TEXT NOT NULL,
          reason_code TEXT,
          rule_version TEXT NOT NULL,
          related_memory_ids_json TEXT,
          before_json TEXT,
          after_json TEXT,
          correlation_id TEXT
        );
      `);
      const insert = db.prepare(`
        INSERT INTO memory_current (
          memory_id,
          category,
          status,
          lifecycle_state,
          path_rel,
          created_at,
          updated_at,
          archived_at,
          superseded_at,
          entity_ref,
          source,
          confidence,
          confidence_tier,
          memory_kind,
          access_count,
          last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        "fact-older",
        "fact",
        "active",
        null,
        "facts/2026-03-08/fact-older.md",
        "2026-03-08T00:00:00.000Z",
        "2026-03-08T01:00:00.000Z",
        null,
        null,
        "project-corrupt",
        "test",
        0.8,
        "implied",
        null,
        null,
        null,
      );
      insert.run(
        "fact-recent",
        "fact",
        "active",
        null,
        "facts/2026-03-08/fact-recent.md",
        "2026-03-08T00:00:00.000Z",
        "2026-03-08T05:00:00.000Z",
        null,
        null,
        "project-before",
        "test",
        0.8,
        "implied",
        null,
        null,
        null,
      );
      const insertTimeline = db.prepare(`
        INSERT INTO memory_timeline (
          event_id,
          memory_id,
          event_type,
          timestamp,
          event_order,
          actor,
          reason_code,
          rule_version,
          related_memory_ids_json,
          before_json,
          after_json,
          correlation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertTimeline.run(
        "fact-older-created",
        "fact-older",
        "created",
        "2026-03-08T00:00:00.000Z",
        0,
        "system",
        null,
        "legacy",
        null,
        null,
        null,
        null,
      );
      insertTimeline.run(
        "fact-recent-created",
        "fact-recent",
        "created",
        "2026-03-08T00:00:00.000Z",
        0,
        "system",
        null,
        "legacy",
        null,
        null,
        null,
        null,
      );
    } finally {
      db.close();
    }

    const scoped = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedAfter: "2026-03-08T02:00:00.000Z",
      now: new Date("2026-03-08T06:00:00.000Z"),
    });

    assert.equal(scoped.currentRows, 1);
    const older = readProjectedMemoryState(memoryDir, "fact-older");
    const recent = readProjectedMemoryState(memoryDir, "fact-recent");
    assert.equal(older?.entityRef, "project-corrupt");
    assert.equal(recent?.entityRef, "project-after");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scoped rebuild treats updatedBefore as an exclusive upper bound", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-before-boundary-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-inside.md",
      memoryDoc({
        id: "fact-inside",
        content: "Inside the projection window.",
        updated: "2026-03-08T04:59:59.999Z",
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-boundary.md",
      memoryDoc({
        id: "fact-boundary",
        content: "Exactly on the exclusive projection boundary.",
        updated: "2026-03-08T05:00:00.000Z",
      }),
    );

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedBefore: "2026-03-08T05:00:00.000Z",
      now: new Date("2026-03-08T06:00:00.000Z"),
    });

    assert.equal(result.currentRows, 1);
    const db = new Database(getMemoryProjectionPath(memoryDir));
    try {
      const rows = db.prepare("SELECT memory_id FROM memory_current ORDER BY memory_id").all() as Array<{ memory_id: string }>;
      assert.deepEqual(rows.map((row) => row.memory_id), ["fact-inside"]);
    } finally {
      db.close();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("backupExistingProjection rethrows non-missing stat failures", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-stat-failure-"));
  try {
    await writeFile(path.join(memoryDir, "state"), "not-a-directory", "utf-8");

    await assert.rejects(
      () => backupExistingProjection(
        memoryDir,
        path.join(memoryDir, "state", "memory-projection.sqlite"),
        new Date("2026-03-08T06:00:00.000Z"),
      ),
      /ENOTDIR|not a directory/i,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("projection browse matches full content beyond preview text for text queries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-query-fallback-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-query.md",
      memoryDoc({
        id: "fact-query",
        content: `${"alpha ".repeat(60)}needle beyond preview depth`,
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T01:00:00.000Z",
      }),
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const browse = readProjectedMemoryBrowse(memoryDir, {
      query: "needle beyond preview depth",
      status: "active",
      category: "fact",
      limit: 20,
      offset: 0,
    });
    assert.ok(browse !== null);
    assert.equal(browse!.total, 1);
    assert.equal(browse!.memories[0]?.id, "fact-query");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection preserves archived status parity for archived files without explicit status", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-archived-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      `---
id: fact-archived
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archived without explicit status
`,
    );

    const result = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });
    assert.equal(result.currentRows, 1);

    const current = readProjectedMemoryState(memoryDir, "fact-archived");
    assert.ok(current);
    assert.equal(current?.status, "archived");
    assert.equal(current?.archivedAt, "2026-03-08T02:00:00.000Z");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection treats active-plus-archivedAt memories as archived", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-archived-override-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-archived-override.md",
      `---
id: fact-archived-override
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
status: active
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archivedAt should override active
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const current = readProjectedMemoryState(memoryDir, "fact-archived-override");
    assert.ok(current);
    assert.equal(current?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection can refresh only memories inside an updated-at window", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-older.md",
      `---
id: fact-older
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-older
tags: ["older"]
---

older
`,
    );
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-before
tags: ["recent"]
---

recent
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T04:00:00.000Z"),
    });
    {
      const db = new Database(getMemoryProjectionPath(memoryDir));
      try {
        db.prepare("UPDATE memory_current SET entity_ref = ? WHERE memory_id = ?")
          .run("project-corrupt", "fact-older");
      } finally {
        db.close();
      }
    }

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
entityRef: project-after
tags: ["recent"]
---

recent updated
`,
    );

    const scoped = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedAfter: "2026-03-08T02:00:00.000Z",
      now: new Date("2026-03-08T06:00:00.000Z"),
    });

    assert.equal(scoped.currentRows, 1);
    const scopedVerify = await verifyMemoryProjection({
      memoryDir,
      updatedAfter: "2026-03-08T02:00:00.000Z",
    });
    assert.equal(scopedVerify.ok, true);
    const older = readProjectedMemoryState(memoryDir, "fact-older");
    const recent = readProjectedMemoryState(memoryDir, "fact-recent");
    assert.equal(older?.entityRef, "project-corrupt");
    assert.equal(recent?.entityRef, "project-after");

    const fullVerify = await verifyMemoryProjection({ memoryDir });
    assert.equal(fullVerify.ok, false);
    assert.deepEqual(fullVerify.mismatchedCurrentMemoryIds, ["fact-older"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scoped rebuild removes deleted memories that still exist in the projection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-delete-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["recent"]
---

recent
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T06:00:00.000Z"),
    });

    await rm(path.join(memoryDir, "facts/2026-03-08/fact-recent.md"));

    const scoped = await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      updatedAfter: "2026-03-08T02:00:00.000Z",
      now: new Date("2026-03-08T07:00:00.000Z"),
    });

    assert.equal(scoped.currentRows, 0);
    assert.equal(readProjectedMemoryState(memoryDir, "fact-recent"), null);
    assert.equal(readProjectedMemoryTimeline(memoryDir, "fact-recent", 20), null);

    const verify = await verifyMemoryProjection({ memoryDir });
    assert.equal(verify.ok, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("scoped rebuild refreshes native knowledge rows from the latest sync snapshot", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-native-window-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T05:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["recent"]
---

recent
`,
    );
    await writeText(
      memoryDir,
      "state/native-knowledge/curated-include-sync.json",
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-03-08T06:00:00.000Z",
          files: {
            "docs/identity.md": {
              sourcePath: "docs/identity.md",
              sourceKind: "identity",
              title: "Identity",
              privacyClass: "internal",
              derivedDate: "2026-03-08",
              sourceHash: "hash-initial",
              syncConfigHash: "sync-identity",
              mtimeMs: 1,
              deleted: false,
              chunks: [
                {
                  chunkId: "nk-identity-1",
                  sourcePath: "docs/identity.md",
                  title: "Identity",
                  sourceKind: "identity",
                  startLine: 1,
                  endLine: 2,
                  content: "Initial identity note.",
                  privacyClass: "internal",
                  sourceHash: "hash-initial",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );
    const initialGovernance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-08T06:10:00.000Z"),
    });

    await rebuildMemoryProjection({
      memoryDir,
      defaultNamespace: "global",
      dryRun: false,
      now: new Date("2026-03-08T06:30:00.000Z"),
    });

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-recent.md",
      `---
id: fact-recent
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T07:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["recent"]
---

recent updated
`,
    );
    await writeText(
      memoryDir,
      "state/native-knowledge/curated-include-sync.json",
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-03-08T07:00:00.000Z",
          files: {
            "docs/identity.md": {
              sourcePath: "docs/identity.md",
              sourceKind: "identity",
              title: "Identity",
              privacyClass: "internal",
              derivedDate: "2026-03-08",
              sourceHash: "hash-updated",
              syncConfigHash: "sync-identity",
              mtimeMs: 2,
              deleted: false,
              chunks: [
                {
                  chunkId: "nk-identity-2",
                  sourcePath: "docs/identity.md",
                  title: "Identity",
                  sourceKind: "identity",
                  startLine: 1,
                  endLine: 2,
                  content: "Updated identity note.",
                  privacyClass: "internal",
                  sourceHash: "hash-updated",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );
    const updatedGovernance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-08T07:10:00.000Z"),
    });

    const scoped = await rebuildMemoryProjection({
      memoryDir,
      defaultNamespace: "global",
      dryRun: false,
      updatedAfter: "2026-03-08T06:45:00.000Z",
      now: new Date("2026-03-08T07:30:00.000Z"),
    });

    assert.equal(scoped.currentRows, 1);
    assert.equal(scoped.nativeKnowledgeRows, 1);
    assert.equal(scoped.reviewQueueRows, updatedGovernance.reviewQueue.length);
    assert.deepEqual(readProjectedNativeKnowledgeChunks(memoryDir), [
      {
        chunkId: "nk-identity-2",
        sourcePath: "docs/identity.md",
        title: "Identity",
        sourceKind: "identity",
        startLine: 1,
        endLine: 2,
        derivedDate: "2026-03-08",
        sessionKey: undefined,
        workflowKey: undefined,
        author: undefined,
        agent: undefined,
        namespace: "global",
        privacyClass: "internal",
        sourceHash: "hash-updated",
        preview: "Updated identity note.",
      },
    ]);
    const projectedReviewQueue = readProjectedLatestReviewQueue(memoryDir);
    assert.ok(projectedReviewQueue?.found);
    assert.equal(projectedReviewQueue?.runId, updatedGovernance.runId);
    assert.notEqual(projectedReviewQueue?.runId, initialGovernance.runId);

    const verify = await verifyMemoryProjection({ memoryDir, defaultNamespace: "global" });
    assert.equal(verify.ok, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("verifyMemoryProjection reports drift when projection is missing current rows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-verify-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T02:00:00.000Z"),
    });

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-2.md",
      `---
id: fact-2
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
---

beta
`,
    );

    const verify = await verifyMemoryProjection({ memoryDir });
    assert.equal(verify.ok, false);
    assert.deepEqual(verify.missingCurrentMemoryIds, ["fact-2"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("repairMemoryProjection dry-run reports drift and write mode repairs it", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-repair-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-1.md",
      `---
id: fact-1
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["alpha"]
---

alpha
`,
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T02:00:00.000Z"),
    });

    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-2.md",
      `---
id: fact-2
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T03:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["beta"]
---

beta
`,
    );

    const dryRun = await repairMemoryProjection({ memoryDir });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.repaired, false);
    assert.equal(dryRun.verify.ok, false);

    const writeResult = await repairMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T04:00:00.000Z"),
    });
    assert.equal(writeResult.dryRun, false);
    assert.equal(writeResult.repaired, true);
    assert.equal(writeResult.verify.ok, true);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager reads archive-path files as archived even without explicit status", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-archived-read-"));
  try {
    await writeText(
      memoryDir,
      "archive/2026-03-08/fact-archived.md",
      `---
id: fact-archived
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archived without explicit status
`,
    );

    const storage = new StorageManager(memoryDir);
    const current = await storage.getProjectedMemoryState("fact-archived");
    assert.ok(current);
    assert.equal(current?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager treats memories with archivedAt as archived in projected-state fallback", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-archivedat-read-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-archivedat.md",
      `---
id: fact-archivedat
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
archivedAt: 2026-03-08T02:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["archived"]
---

archivedAt without explicit status
`,
    );

    const storage = new StorageManager(memoryDir);
    const current = await storage.getProjectedMemoryState("fact-archivedat");
    assert.ok(current);
    assert.equal(current?.status, "archived");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager does not infer archived status from archive in ancestor directories", async () => {
  const archiveParent = path.join(os.tmpdir(), "archive");
  await mkdir(archiveParent, { recursive: true });
  const memoryDir = await mkdtemp(path.join(archiveParent, "engram-storage-live-under-archive-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-08/fact-active.md",
      `---
id: fact-active
category: fact
created: 2026-03-08T00:00:00.000Z
updated: 2026-03-08T01:00:00.000Z
source: test
confidence: 0.8
confidenceTier: implied
tags: ["active"]
---

active memory under archive-named parent
`,
    );

    const storage = new StorageManager(memoryDir);
    const current = await storage.getProjectedMemoryState("fact-active");
    assert.ok(current);
    assert.equal(current?.status, "active");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager projection helpers fail open to markdown and lifecycle ledger", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-projection-fallback-"));
  try {
    const storage = new StorageManager(memoryDir);
    const memoryId = await storage.writeMemory("fact", "fallback memory", {
      source: "test",
      tags: ["fallback"],
    });
    await storage.updateMemory(memoryId, "fallback memory updated");

    const current = await storage.getProjectedMemoryState(memoryId);
    assert.ok(current);
    assert.equal(current?.status, "active");

    const timeline = await storage.getMemoryTimeline(memoryId);
    assert.deepEqual(
      timeline.map((entry) => entry.eventType),
      ["created", "updated"],
    );

    await rebuildMemoryProjection({
      memoryDir,
      dryRun: false,
      now: new Date("2026-03-08T12:00:00.000Z"),
    });

    const projectedTimeline = await storage.getMemoryTimeline(memoryId);
    assert.deepEqual(
      projectedTimeline.map((entry) => entry.eventType),
      ["created", "updated"],
    );

    const secondId = await storage.writeMemory("fact", "written after projection rebuild", {
      source: "test",
    });
    await storage.updateMemory(secondId, "written after projection rebuild updated");

    const fallbackAfterProjection = await storage.getMemoryTimeline(secondId);
    assert.deepEqual(
      fallbackAfterProjection.map((entry) => entry.eventType),
      ["created", "updated"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("StorageManager falls back when projection database exists but has no timeline row for a memory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-storage-projection-empty-row-"));
  try {
    const storage = new StorageManager(memoryDir);
    const memoryId = await storage.writeMemory("fact", "fallback memory", {
      source: "test",
      tags: ["fallback"],
    });
    await storage.updateMemory(memoryId, "fallback memory updated");

    const projectionPath = getMemoryProjectionPath(memoryDir);
    await mkdir(path.dirname(projectionPath), { recursive: true });
    const db = new Database(projectionPath);
    try {
      initializeMemoryProjectionDb(db);
    } finally {
      db.close();
    }

    const timeline = await storage.getMemoryTimeline(memoryId);
    assert.deepEqual(
      timeline.map((entry) => entry.eventType),
      ["created", "updated"],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("rebuildMemoryProjection projects entity mentions, native knowledge chunks, and governance review queue", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-derived-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc({
        id: "fact-duplicate-a",
        content: "Projection parity requires complete lifecycle coverage.",
        created: "2026-03-01T00:00:00.000Z",
        updated: "2026-03-01T01:00:00.000Z",
        confidence: 0.95,
        confidenceTier: "explicit",
        entityRef: "person-alex",
        tags: [" projection ", "team:ops", "team:ops"],
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc({
        id: "fact-duplicate-b",
        content: "Projection parity requires complete lifecycle coverage.",
        created: "2026-03-02T00:00:00.000Z",
        updated: "2026-03-02T01:00:00.000Z",
        confidence: 0.45,
        confidenceTier: "inferred",
        tags: ["projection"],
      }),
    );
    await writeText(
      memoryDir,
      "state/native-knowledge/curated-include-sync.json",
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-03-09T12:00:00.000Z",
          files: {
            "docs/identity.md": {
              sourcePath: "docs/identity.md",
              sourceKind: "identity",
              title: "Identity",
              privacyClass: "internal",
              derivedDate: "2026-03-09",
              sourceHash: "hash-identity",
              syncConfigHash: "sync-identity",
              mtimeMs: 1,
              deleted: false,
              chunks: [
                {
                  chunkId: "nk-identity-1",
                  sourcePath: "docs/identity.md",
                  title: "Identity",
                  sourceKind: "identity",
                  startLine: 1,
                  endLine: 3,
                  content: "Alex maintains the Engram memory system.",
                  privacyClass: "internal",
                  sourceHash: "hash-identity",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    const result = await rebuildMemoryProjection({
      memoryDir,
      defaultNamespace: "global",
      dryRun: false,
      now: new Date("2026-03-09T12:05:00.000Z"),
    });

    assert.equal(result.entityMentionRows, 2);
    assert.equal(result.nativeKnowledgeRows, 1);
    assert.equal(result.reviewQueueRows >= 1, true);

    const projectedCurrent = readProjectedMemoryState(memoryDir, "fact-duplicate-a");
    assert.ok(projectedCurrent);
    assert.deepEqual(projectedCurrent?.tags, ["projection", "team:ops"]);

    const entityMentions = readProjectedEntityMentions(memoryDir);
    assert.ok(entityMentions);
    assert.deepEqual(
      entityMentions?.map((row) => `${row.memoryId}::${row.entityRef}::${row.mentionSource}`),
      [
        "fact-duplicate-a::person-alex::frontmatter.entityRef",
        "fact-duplicate-a::team:ops::tag",
      ],
    );

    const nativeKnowledge = readProjectedNativeKnowledgeChunks(memoryDir);
    assert.ok(nativeKnowledge);
    assert.equal(nativeKnowledge?.length, 1);
    assert.deepEqual(nativeKnowledge?.[0], {
      chunkId: "nk-identity-1",
      sourcePath: "docs/identity.md",
      title: "Identity",
      sourceKind: "identity",
      startLine: 1,
      endLine: 3,
      derivedDate: "2026-03-09",
      sessionKey: undefined,
      workflowKey: undefined,
      author: undefined,
      agent: undefined,
      namespace: "global",
      privacyClass: "internal",
      sourceHash: "hash-identity",
      preview: "Alex maintains the Engram memory system.",
    });

    const projectedReviewQueue = readProjectedLatestReviewQueue(memoryDir);
    assert.ok(projectedReviewQueue?.found);
    assert.equal(projectedReviewQueue?.runId, governance.runId);
    assert.equal(projectedReviewQueue?.reviewQueue.some((entry) => entry.reasonCode === "exact_duplicate"), true);

    const verify = await verifyMemoryProjection({ memoryDir, defaultNamespace: "global" });
    assert.equal(verify.ok, true);
    assert.equal(verify.expectedEntityMentionRows, 2);
    assert.equal(verify.actualEntityMentionRows, 2);
    assert.equal(verify.expectedNativeKnowledgeRows, 1);
    assert.equal(verify.actualNativeKnowledgeRows, 1);
    assert.equal(verify.expectedReviewQueueRows >= 1, true);
    assert.equal(verify.expectedReviewQueueRows, verify.actualReviewQueueRows);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("verifyMemoryProjection reports drift in projected entity mentions, native knowledge, and review queue rows", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-memory-projection-derived-drift-"));
  try {
    await writeText(
      memoryDir,
      "facts/2026-03-01/fact-duplicate-a.md",
      memoryDoc({
        id: "fact-duplicate-a",
        content: "Projection parity requires complete lifecycle coverage.",
        created: "2026-03-01T00:00:00.000Z",
        updated: "2026-03-01T01:00:00.000Z",
        confidence: 0.95,
        confidenceTier: "explicit",
        entityRef: "person-alex",
        tags: ["projection", "team:ops"],
      }),
    );
    await writeText(
      memoryDir,
      "facts/2026-03-02/fact-duplicate-b.md",
      memoryDoc({
        id: "fact-duplicate-b",
        content: "Projection parity requires complete lifecycle coverage.",
        created: "2026-03-02T00:00:00.000Z",
        updated: "2026-03-02T01:00:00.000Z",
        confidence: 0.45,
        confidenceTier: "inferred",
        tags: ["projection"],
      }),
    );
    await writeText(
      memoryDir,
      "state/native-knowledge/curated-include-sync.json",
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-03-09T12:00:00.000Z",
          files: {
            "docs/identity.md": {
              sourcePath: "docs/identity.md",
              sourceKind: "identity",
              title: "Identity",
              privacyClass: "internal",
              derivedDate: "2026-03-09",
              sourceHash: "hash-identity",
              syncConfigHash: "sync-identity",
              mtimeMs: 1,
              deleted: false,
              chunks: [
                {
                  chunkId: "nk-identity-1",
                  sourcePath: "docs/identity.md",
                  title: "Identity",
                  sourceKind: "identity",
                  startLine: 1,
                  endLine: 3,
                  content: "Alex maintains the Engram memory system.",
                  privacyClass: "internal",
                  sourceHash: "hash-identity",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    const governance = await runMemoryGovernance({
      memoryDir,
      mode: "shadow",
      now: new Date("2026-03-09T12:00:00.000Z"),
    });
    await rebuildMemoryProjection({
      memoryDir,
      defaultNamespace: "global",
      dryRun: false,
      now: new Date("2026-03-09T12:05:00.000Z"),
    });

    const db = new Database(getMemoryProjectionPath(memoryDir));
    try {
      db.prepare(`
        DELETE FROM memory_entity_mentions
        WHERE memory_id = ? AND entity_ref = ? AND mention_source = ?
      `).run("fact-duplicate-a", "person-alex", "frontmatter.entityRef");
      db.prepare("DELETE FROM native_knowledge_chunks WHERE chunk_id = ?").run("nk-identity-1");
      db.prepare("DELETE FROM memory_review_queue WHERE run_id = ? AND entry_id = ?").run(
        governance.runId,
        "review:fact-duplicate-b:exact_duplicate",
      );
    } finally {
      db.close();
    }

    const verify = await verifyMemoryProjection({ memoryDir, defaultNamespace: "global" });
    assert.equal(verify.ok, false);
    assert.deepEqual(
      verify.missingEntityMentionKeys,
      ["fact-duplicate-a::person-alex::frontmatter.entityRef"],
    );
    assert.deepEqual(verify.missingNativeKnowledgeChunkIds, ["nk-identity-1"]);
    assert.deepEqual(
      verify.missingReviewQueueEntryIds,
      [`${governance.runId}::review:fact-duplicate-b:exact_duplicate`],
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
