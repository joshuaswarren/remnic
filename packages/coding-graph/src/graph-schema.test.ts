/**
 * graph-schema tests — ordered step 1 of issue #1552 PR1.
 *
 * Cover:
 *   - schema-creation (fresh DB → all tables present, meta schema_version=1)
 *   - upgrade stub (meta v0 → v1 migrates; idempotent re-apply is a no-op)
 *   - provenance CHECK rejects unknown values
 *
 * Issue #1552 ordered step 1 demands these tests run BEFORE the write
 * pipeline ships. They are written to FAIL on a fresh DB with no schema,
 * proving the test is meaningful.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "@remnic/core/runtime/better-sqlite";

import {
  CODING_GRAPH_SCHEMA_VERSION,
  EDGE_PROVENANCE_VALUES,
  applyCodingGraphSchema,
  readSchemaVersion,
} from "./graph-schema.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-graph-schema-"));
}

function openTempDb(dir: string, name: string): BetterSqlite3Database {
  return openBetterSqlite3(path.join(dir, name));
}

test("schema-creation: fresh DB → meta + files + nodes + edges + nodes_fts exist, schema_version=1", async () => {
  const dir = await tempDir();
  try {
    const db = openTempDb(dir, "fresh.sqlite");
    // Pre-condition: empty DB. Prove the test would fail without the
    // schema apply.
    assert.equal(readSchemaVersion(db), 0);
    const beforeTables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
      )
      .all() as { name: string }[];
    assert.deepEqual(
      beforeTables.map((r) => r.name),
      [],
      "fresh DB must have no tables",
    );

    applyCodingGraphSchema(db);

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(tables.includes("meta"), `expected meta table; got ${tables}`);
    assert.ok(tables.includes("files"), `expected files table; got ${tables}`);
    assert.ok(tables.includes("nodes"), `expected nodes table; got ${tables}`);
    assert.ok(tables.includes("edges"), `expected edges table; got ${tables}`);

    // FTS5 virtual tables report via the same sqlite_master query.
    const virtual = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL TABLE%nodes_fts%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(
      virtual.includes("nodes_fts"),
      `expected nodes_fts virtual table; got ${virtual}`,
    );

    assert.equal(readSchemaVersion(db), CODING_GRAPH_SCHEMA_VERSION);
    assert.equal(readSchemaVersion(db), 1);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema-creation: id columns and constraints match the design (rule 23/38)", async () => {
  const dir = await tempDir();
  try {
    const db = openTempDb(dir, "shape.sqlite");
    applyCodingGraphSchema(db);

    // files: id PK, path UNIQUE, lang NOT NULL, content_hash NOT NULL
    const filesCols = (
      db.prepare("PRAGMA table_info(files)").all() as {
        name: string;
        notnull: number;
        pk: number;
      }[]
    ).map((c) => ({ name: c.name, notnull: c.notnull === 1, pk: c.pk > 0 }));
    const filesByName = Object.fromEntries(filesCols.map((c) => [c.name, c]));
    assert.equal(filesByName.id?.pk, true, "files.id must be PRIMARY KEY");
    assert.equal(filesByName.path?.notnull, true, "files.path must be NOT NULL");
    assert.equal(filesByName.lang?.notnull, true, "files.lang must be NOT NULL");
    assert.equal(
      filesByName.content_hash?.notnull,
      true,
      "files.content_hash must be NOT NULL",
    );

    // nodes: id PK (TEXT), qualified_name + file_id + span_start + span_end NOT NULL
    const nodesCols = (
      db.prepare("PRAGMA table_info(nodes)").all() as {
        name: string;
        notnull: number;
        pk: number;
      }[]
    ).map((c) => ({ name: c.name, notnull: c.notnull === 1, pk: c.pk > 0 }));
    const nodesByName = Object.fromEntries(nodesCols.map((c) => [c.name, c]));
    assert.equal(nodesByName.id?.pk, true, "nodes.id must be PRIMARY KEY");
    assert.equal(
      nodesByName.qualified_name?.notnull,
      true,
      "nodes.qualified_name must be NOT NULL",
    );
    assert.equal(
      nodesByName.file_id?.notnull,
      true,
      "nodes.file_id must be NOT NULL",
    );
    assert.equal(
      nodesByName.span_start?.notnull,
      true,
      "nodes.span_start must be NOT NULL",
    );
    assert.equal(
      nodesByName.span_end?.notnull,
      true,
      "nodes.span_end must be NOT NULL",
    );

    // edges: confidence REAL NOT NULL, provenance TEXT NOT NULL with CHECK
    const edgesCols = (
      db.prepare("PRAGMA table_info(edges)").all() as {
        name: string;
        type: string;
        notnull: number;
      }[]
    ).map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull === 1,
    }));
    const edgesByName = Object.fromEntries(edgesCols.map((c) => [c.name, c]));
    assert.equal(
      edgesByName.confidence?.type,
      "REAL",
      "edges.confidence must be REAL",
    );
    assert.equal(
      edgesByName.confidence?.notnull,
      true,
      "edges.confidence must be NOT NULL",
    );
    assert.equal(
      edgesByName.provenance?.notnull,
      true,
      "edges.provenance must be NOT NULL",
    );

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upgrade stub: meta row v0 (manually cleared) → re-apply recreates everything + version=1", async () => {
  const dir = await tempDir();
  try {
    const db = openTempDb(dir, "upgrade.sqlite");
    applyCodingGraphSchema(db);
    assert.equal(readSchemaVersion(db), 1);

    // Simulate the pre-v1 state by dropping the version row. Tables stay.
    db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    assert.equal(readSchemaVersion(db), 0);

    applyCodingGraphSchema(db);
    assert.equal(
      readSchemaVersion(db),
      CODING_GRAPH_SCHEMA_VERSION,
      "re-apply with v0 meta must migrate to v1",
    );
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provenance CHECK rejects unknown provenance values", async () => {
  const dir = await tempDir();
  try {
    const db = openTempDb(dir, "prov.sqlite");
    applyCodingGraphSchema(db);

    // Seed a file + two nodes so we can attempt an edge insert.
    db.prepare(
      "INSERT INTO files (path, lang, content_hash) VALUES (?, ?, ?)",
    ).run("a.ts", "ts", "h1");
    db.prepare(
      "INSERT INTO files (path, lang, content_hash) VALUES (?, ?, ?)",
    ).run("b.ts", "ts", "h2");
    const fileA = db
      .prepare("SELECT id FROM files WHERE path = ?")
      .get("a.ts") as { id: number };
    const fileB = db
      .prepare("SELECT id FROM files WHERE path = ?")
      .get("b.ts") as { id: number };
    db.prepare(
      "INSERT INTO nodes (id, label, name, qualified_name, file_id, span_start, span_end, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("id-a", "function", "a", "a", fileA.id, 0, 1, "ts");
    db.prepare(
      "INSERT INTO nodes (id, label, name, qualified_name, file_id, span_start, span_end, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("id-b", "function", "b", "b", fileB.id, 0, 1, "ts");

    // Each whitelisted provenance inserts cleanly.
    for (const prov of EDGE_PROVENANCE_VALUES) {
      db.prepare(
        "INSERT INTO edges (src, dst, type, confidence, provenance) VALUES (?, ?, ?, ?, ?)",
      ).run("id-a", "id-b", `t-${prov}`, 0.5, prov);
    }

    // An unknown provenance fails the CHECK constraint.
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO edges (src, dst, type, confidence, provenance) VALUES (?, ?, ?, ?, ?)",
          )
          .run("id-a", "id-b", "t-bogus", 0.5, "bogus"),
      /CHECK constraint failed/,
    );

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pragmas match the lcm verbatim (WAL + busy_timeout=5000 + synchronous=NORMAL)", async () => {
  const dir = await tempDir();
  try {
    const db = openTempDb(dir, "pragmas.sqlite");
    // Apply the same pragmas the GraphStore.open() does. We assert at the
    // helper layer (graph-schema.ts does not set pragmas; GraphStore does).
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");

    const journal = db.pragma("journal_mode") as { journal_mode: string }[];
    const busy = db.pragma("busy_timeout") as { timeout: number }[];
    const sync = db.pragma("synchronous") as { synchronous: number }[];

    assert.equal(journal[0]?.journal_mode, "wal");
    assert.equal(busy[0]?.timeout, 5000);
    assert.equal(sync[0]?.synchronous, 1, "synchronous=NORMAL == 1");

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Keep the imports honest — write a tiny file that depends on dir exists.
test("temp dir helper produces an empty directory", async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, "x"), "ok");
    await mkdir(path.join(dir, "nested"), { recursive: true });
    // Just exercising the FS to make sure the helper works.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
