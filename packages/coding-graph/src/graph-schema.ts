/**
 * Coding-graph SQLite schema — versioned meta + tables + FTS5 virtual table.
 *
 * Issue #1552 PR1 (Track B, Phase 1). The schema + write pipeline only;
 * traversal, search, dead-code and the openCypher subset land in PR2/PR3.
 *
 * Design anchors:
 *   - `packages/remnic-core/src/lcm/schema.ts` (versioning + pragmas) —
 *     copied VERBATIM for the WAL / busy_timeout / synchronous pragmas and
 *     the meta-table version row. Do not invent a new pattern (rule 23/38).
 *   - `packages/remnic-core/src/runtime/better-sqlite.ts` (`openBetterSqlite3`)
 *     — the shared opener; native-binding lifecycle is paid for once there.
 *   - issue://1552 "Design" — node ids hash sorted key material; file
 *     contents are NEVER stored (only spans + content hashes); FTS5 covers
 *     node names; provenance CHECK enforces the four-value enum.
 *
 * Schema versioning:
 *   The schema_version row lives in `meta` (a generic key/value table, not
 *   lcm_meta — independent store, separate version namespace). Fresh DB →
 *   schema_version=1. Upgrade stub: meta v0 → v1 (rule 23, characterize
 *   before moving).
 *
 * Dangling-edge policy (PR1 decision):
 *   When `upsertFileBatch` deletes a file's prior nodes + edges, cross-file
 *   edges whose `dst` was a node owned by the deleted file become dangling.
 *   We DROP them. They are counted in `UpsertResult.droppedDanglingEdges`
 *   so callers can surface the loss. Keeping them with a `dst_unresolved`
 *   marker would leak orphans and bias `traverse()` results — drop is the
 *   conservative choice for a write pipeline whose caller knows the
 *   canonical file set on each batch (rule 11, 40).
 */
import type { BetterSqlite3Database } from "@remnic/core/runtime/better-sqlite";

import { expectRow, expectRows } from "./row-types.js";

export const CODING_GRAPH_SCHEMA_VERSION = 1;

/**
 * FTS5 rowid derived from a deterministic node id. FTS5 rowids are
 * signed 64-bit integers; we slice the leading 16 hex chars (= 64 bits)
 * of the sha256 id and mask to the int64 positive range so SQLite
 * accepts it. The full 64-bit space is large enough that collisions
 * across distinct node ids are negligible. Contentless FTS5
 * (`content=''`) does NOT store UNINDEXED column values, so the only
 * reliable key into the virtual table is the rowid.
 *
 * Lives in graph-schema (not graph-store) so the schema migration path
 * can rebuild FTS rows from existing `nodes` without importing the
 * store module (which would create a circular dependency — graph-store
 * imports graph-schema).
 */
export function ftsRowidForNodeId(nodeId: string): bigint {
  return BigInt(`0x${nodeId.slice(0, 16)}`) & BigInt("0x7fffffffffffffff");
}

/**
 * Provenance enum for edges — mirrors #1552's `heuristic|lsp|trace|semantic`
 * whitelist. The CHECK constraint rejects writes outside this set so a
 * buggy resolver can't sneak in unknown values (rule 23).
 */
export const EDGE_PROVENANCE_VALUES = [
  "heuristic",
  "lsp",
  "trace",
  "semantic",
] as const;

export type EdgeProvenance = (typeof EDGE_PROVENANCE_VALUES)[number];

export function isEdgeProvenance(value: unknown): value is EdgeProvenance {
  return (
    typeof value === "string" &&
    (EDGE_PROVENANCE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Apply (or upgrade) the coding-graph schema on an already-open SQLite
 * handle. Public so test seams and migration tools can bootstrap an
 * in-memory database without going through {@link openCodingGraphDatabase}.
 *
 * Mirrors `applyLcmSchema` in `packages/remnic-core/src/lcm/schema.ts` —
 * distinct function, same shape, separate version namespace.
 */
export function applyCodingGraphSchema(db: BetterSqlite3Database): void {
  const versionRow = expectRow<{ name: string }>(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'",
      )
      .get(),
    ["name"],
  );

  if (!versionRow) {
    createTables(db);
    return;
  }

  const meta = expectRow<{ value: string }>(
    db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get(),
    ["value"],
  );
  const currentVersion = meta ? parseInt(meta.value, 10) : 0;

  if (currentVersion < CODING_GRAPH_SCHEMA_VERSION) {
    createTables(db);
  }
}

function createTables(db: BetterSqlite3Database): void {
  // Provenance whitelist must match EDGE_PROVENANCE_VALUES. SQLite CHECK
  // constraints are re-checked against every INSERT/UPDATE; bypassing this
  // gate would require raw exec, which we never do (rule 51).
  const provenanceList = EDGE_PROVENANCE_VALUES.map((v) => `'${v}'`).join(", ");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT NOT NULL UNIQUE,
      lang         TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);

    CREATE TABLE IF NOT EXISTS nodes (
      id             TEXT PRIMARY KEY,
      label          TEXT NOT NULL,
      name           TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      span_start     INTEGER NOT NULL,
      span_end       INTEGER NOT NULL,
      lang           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_qname ON nodes(qualified_name);
    CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);

    CREATE TABLE IF NOT EXISTS edges (
      src        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      dst        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
      provenance TEXT NOT NULL CHECK (provenance IN (${provenanceList})),
      UNIQUE (src, dst, type)
    );
    -- Destination-leading index. The UNIQUE(src,dst,type) key is
    -- src-leading, so pruneFileNodes()'s 'WHERE dst IN (...)' count and
    -- the ON DELETE CASCADE that follows a node delete (SQLite must
    -- locate child edges by 'dst') would otherwise scan the whole edges
    -- table. A dst-leading index turns ordinary symbol deletion into an
    -- index lookup instead of a full scan
    -- (chatgpt-codex-connector P2: 'Add an index for edge destination
    -- lookups').
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
  `);
  // FTS5 hit → node id reverse map. Contentless FTS5 does NOT store
  // column values, so a rowid returned by `MATCH` cannot be joined
  // back to `nodes` via the `id UNINDEXED` column (it reads NULL).
  // This table is the only place the mapping lives: a single
  // integer key (the FTS rowid, derived deterministically from the
  // node id) plus the node id, kept in lockstep with `nodes_fts`
  // by the write pipeline (chatgpt-codex-connector P2: 'Preserve a
  // node key for FTS hits'). UNIQUE on node_id so re-ingesting the
  // same node updates the row in place rather than producing a
  // second mapping row.
  //
  // Created BEFORE the nodes_fts rebuild so the migration path can
  // repopulate both tables in lockstep without ordering concerns.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fts_index (
      fts_rowid INTEGER PRIMARY KEY,
      node_id   TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_fts_index_node ON fts_index(node_id);
  `);
  // FTS5 virtual table over node names + qualified_names for PR2's
  // name search. Contentless-delete mode (`content=''` plus
  // `contentless_delete=1`, SQLite 3.43+) lets us run standard
  // `DELETE` and `INSERT OR REPLACE` statements against the virtual
  // table — the write pipeline's only requirement. The `id UNINDEXED`
  // column mirrors the deterministic node id for human-readable
  // inspection; the write pipeline's actual key is the rowid derived
  // from the node-id hash (see `ftsRowidForNodeId` below).
  //
  // Migration: databases created before the contentless-FTS5 fix have
  // an OLD `nodes_fts` table whose CREATE SQL used `content=nodes`
  // (external-content) and lacks `contentless_delete=1`. The write
  // pipeline's `DELETE FROM nodes_fts WHERE rowid = ?` fails on such
  // a table while the source `nodes` row still exists, throwing and
  // aborting the whole batch (kilo WARNING: 'Contentless FTS5 assumes
  // fresh schema — old databases are not migrated'). We detect this
  // by inspecting sqlite_master for the `contentless_delete=1` token;
  // if absent, we DROP + RECREATE the virtual table and rebuild its
  // rows from the surviving `nodes` table so the index is immediately
  // usable after migration (rule 23: characterize before moving).
  const ftsCreateSql = expectRow<{ sql: string }>(
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes_fts'",
      )
      .get(),
    ["sql"],
  );
  const needsFtsRecreate =
    !ftsCreateSql || !ftsCreateSql.sql.includes("contentless_delete=1");
  if (needsFtsRecreate) {
    db.exec("DROP TABLE IF EXISTS nodes_fts;");
    db.exec(`
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        name,
        qualified_name,
        id UNINDEXED,
        content='',
        contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    // Rebuild FTS + fts_index from surviving nodes so both are populated
    // after migration. Fresh databases have zero rows so this is a no-op.
    const survivingNodes = expectRows<{
      id: string;
      name: string;
      qualified_name: string;
    }>(
      db.prepare("SELECT id, name, qualified_name FROM nodes").all(),
      ["id", "name", "qualified_name"],
    );
    if (survivingNodes.length > 0) {
      const insertFts = db.prepare(
        "INSERT INTO nodes_fts (rowid, name, qualified_name) VALUES (?, ?, ?)",
      );
      const upsertFtsIndex = db.prepare(
        "INSERT OR REPLACE INTO fts_index (fts_rowid, node_id) VALUES (?, ?)",
      );
      for (const n of survivingNodes) {
        const rowid = ftsRowidForNodeId(n.id);
        insertFts.run(rowid, n.name, n.qualified_name);
        upsertFtsIndex.run(rowid, n.id);
      }
    }
  }
  // Upsert meta version. INSERT OR REPLACE so the upgrade path can rewrite
  // the row in place (rule 23 — one canonical form for the version value).
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(CODING_GRAPH_SCHEMA_VERSION));
}

/**
 * Read the schema_version row. Returns 0 when the table is missing or the
 * row has not been written yet — used by the upgrade stub test.
 *
 * Mirrors the LCM helper's tolerance: a missing `meta` table is not an
 * error condition here, it just means the schema has never been applied.
 */
export function readSchemaVersion(db: BetterSqlite3Database): number {
  const metaTable = expectRow<{ name: string }>(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='meta'",
      )
      .get(),
    ["name"],
  );
  if (!metaTable) return 0;
  const meta = expectRow<{ value: string }>(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
    ["value"],
  );
  return meta ? parseInt(meta.value, 10) : 0;
}
