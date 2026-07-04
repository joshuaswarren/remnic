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


import { expectRow } from "./row-types.js";
export const CODING_GRAPH_SCHEMA_VERSION = 1;

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
      confidence REAL NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN (${provenanceList})),
      UNIQUE (src, dst, type)
    );
  `);

  // FTS5 virtual table over node names + qualified_names for PR2's
  // name search. `content=nodes` keeps the index lean — the source-of-truth
  // row lives in `nodes` and FTS rebuilds via the auto-managed triggers.
  // We do NOT wire triggers here; Phase A writes go through the structured
  // `upsertFileBatch` which repopulates FTS in the same transaction.
  const hasNodeFts = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'",
    )
    .get();
  if (!hasNodeFts) {
    db.exec(`
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        name,
        qualified_name,
        content=nodes,
        content_rowid=rowid,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
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
