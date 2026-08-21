/**
 * Coding-graph SQLite schema — versioned meta + tables + FTS5 virtual table.
 *
 * Issue #1552 PR1 (Track B, Phase 1). The schema + write pipeline only;
 * traversal, search, dead-code and the openCypher subset land in PR2/PR3.
 *
 * PR2 additive table (`node_attributes`): tracks per-node exclusion flags
 * consumed by `deadCode()` — `is_exported`, `is_route_handler`. Added in
 * PR2 (issue #1552 step 5) as a SEPARATE table rather than ALTER TABLE on
 * `nodes`, so existing v1 databases gain the table via the same
 * `CREATE TABLE IF NOT EXISTS` pass without a schema-version bump or a
 * migration (rule 23 — additive, characterized before moving).
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
    // Fresh DB — create every table and stamp the current version.
    createTables(db);
    writeSchemaVersion(db, CODING_GRAPH_SCHEMA_VERSION);
    return;
  }

  const meta = expectRow<{ value: string }>(
    db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get(),
    ["value"],
  );
  const currentVersion = meta ? parseInt(meta.value, 10) : 0;

  // Only run createTables when the on-disk version is at or below this
  // code's version. For an AT-OR-BELOW DB (fresh-ish v0/v1) the pass is
  // additive: every core statement is CREATE TABLE IF NOT EXISTS, so the
  // PR2 `node_attributes` table appears on existing v1 databases without
  // a version bump (chatgpt-codex-connector P1: 'Create node_attributes
  // for existing v1 stores'), and a v0 DB is upgraded.
  //
  // A NEWER DB (currentVersion > CODING_GRAPH_SCHEMA_VERSION — older
  // code opening a future-version DB after a downgrade, or a parallel
  // install) must be left UNTOUCHED: createTables is NOT purely
  // additive because its FTS migration drops + recreates `nodes_fts`
  // when the stored CREATE SQL lacks `contentless_delete=1`. Running
  // that against a future schema that legitimately changed or removed
  // that table would mutate the newer schema while preserving its
  // version marker — silent corruption. Skip createTables AND the
  // version write for newer DBs (chatgpt-codex-connector P2: 'Skip
  // destructive DDL for future schema versions').
  if (currentVersion > CODING_GRAPH_SCHEMA_VERSION) {
    return;
  }
  createTables(db);
  writeSchemaVersion(db, CODING_GRAPH_SCHEMA_VERSION);
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
  // PR2 (issue #1552 step 5): per-node exclusion flags consumed by
  // `GraphStore.deadCode()`. Kept in a SEPARATE table rather than an
  // ALTER TABLE on `nodes` so existing v1 databases gain the table via
  // the same `CREATE TABLE IF NOT EXISTS` pass without a schema-version
  // bump or a data migration (rule 23 — additive, characterized before
  // moving). ON DELETE CASCADE on `nodes(id)` keeps the table in lockstep
  // with node lifetimes; the foreign_keys=ON pragma set in
  // `GraphStore.open()` enforces it.
  //
  // `is_exported`: 1 when the symbol's `name` matches an entry in the
  //   FileIR's `exports` list (matched per-file at write time). The
  //   dead-code query treats exported symbols as not-dead even with
  //   zero inbound CALLS/USES_TYPE edges — they form the package's
  //   public surface and may be called by external consumers the graph
  //   cannot see.
  // `is_route_handler`: 1 when the symbol's `qualified_name` matches a
  //   route's `handlerQualifiedName` in the FileIR's `routes` list.
  //   Route handlers are reachable from HTTP requests regardless of
  //   whether any other node CALLS them inside the indexed codebase.
  //
  // Both columns are NOT NULL with CHECK IN (0,1): a missing row means
  // "neither flag set" (the LEFT JOIN in deadCode() COALESCEs to 0).
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_attributes (
      node_id           TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      is_exported       INTEGER NOT NULL CHECK (is_exported IN (0, 1)),
      is_route_handler  INTEGER NOT NULL CHECK (is_route_handler IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_node_attributes_exported
      ON node_attributes(is_exported) WHERE is_exported = 1;
    CREATE INDEX IF NOT EXISTS idx_node_attributes_route
      ON node_attributes(is_route_handler) WHERE is_route_handler = 1;
  `);
  // PR3 (issue #1553): co-change edges — file-level relationships mined
  // from git history. Stored separately from the symbol-level `edges`
  // table because co-change is a file-to-file concern, not symbol-to-
  // symbol. Additive to v1 (CREATE TABLE IF NOT EXISTS — same pattern
  // as `node_attributes` in PR2, rule 23).
  //
  // UNIQUE(file_a, file_b) ensures idempotent upserts; the mining
  // pipeline clears + repopulates each run so stale edges from history
  // changes are pruned automatically.
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_changes (
      file_a     TEXT NOT NULL,
      file_b     TEXT NOT NULL,
      support    INTEGER NOT NULL CHECK (support >= 0),
      confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
      UNIQUE (file_a, file_b)
    );
    CREATE INDEX IF NOT EXISTS idx_co_changes_a ON co_changes(file_a);
    CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_b);
  `);
  // Semantic layer (issue #1556): symbol embedding vectors. Additive to v1
  // (CREATE TABLE IF NOT EXISTS — same rule-23 pattern as node_attributes).
  // One row per (node_id, model_id): a node re-embedded under a different
  // provider/model gets a distinct row so a provider swap does not
  // overwrite the prior vectors (the cache invalidation test covers this).
  // content_hash is the canonical-text hash (rule 37) — a re-index compares
  // it to decide whether to re-embed. CASCADE on nodes(id) keeps the table
  // in lockstep with node lifetimes (foreign_keys=ON is set in GraphStore.open).
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_vectors (
      node_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      model_id     TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dims         INTEGER NOT NULL CHECK (dims > 0),
      vector       BLOB NOT NULL,
      PRIMARY KEY (node_id, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_vectors_model
      ON symbol_vectors(model_id);
  `);
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
  // NOTE: the schema_version marker is written by the caller
  // (applyCodingGraphSchema / writeSchemaVersion), NOT here. createTables
  // only owns additive DDL; the version-write concern (never downgrade a
  // newer DB) lives at the apply layer where currentVersion is known.
}

/**
 * Stamp the schema_version meta row. INSERT OR REPLACE so the upgrade
 * path can rewrite the row in place (rule 23 — one canonical form).
 * Callers MUST gate this on `currentVersion <= CODING_GRAPH_SCHEMA_VERSION`
 * to avoid downgrading a newer DB.
 */
function writeSchemaVersion(
  db: BetterSqlite3Database,
  version: number,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(version));
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
