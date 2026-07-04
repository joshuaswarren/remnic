/**
 * Coding-graph write pipeline — two-pass single-batch single-transaction
 * delete + reinsert per file. PR1 scope (issue #1552):
 *
 *   - Node ids are sha256 over SORTED key material (qualified name, file
 *     path, label) — rule 23/38; the same hash MUST be computed identically
 *     at ingest and lookup time.
 *   - File contents are NEVER stored — only spans + content hashes
 *     (privacy + DB size; rule 11). `get_code_snippet` is a read-side
 *     concern that lands in PR2.
 *   - DB handles live on the GraphStore instance, keyed per instance —
 *     never module scope (rule 11).
 *   - Writes are serialized per DB with a rejection-recovering queue
 *     (rule 40). A second concurrent `upsertFileBatch` call waits on a
 *     FIFO tail then runs; if it rejects (timeout / abort), the queue
 *     drains so the next call can proceed.
 *   - One DB per namespace path passed in by the caller — this PR does
 *     NOT add namespace resolution; rule 42 keeps it that way until PR2
 *     wires the namespace layer.
 *
 * Two-pass ingestion (per `upsertFileBatch`):
 *   1. Every file in the batch is upserted (file row + node row per
 *      symbol). FTS5 is kept in lockstep via explicit DELETE/INSERT on
 *      the contentless `nodes_fts` table (the write pipeline is the
 *      single source of FTS truth — no auto-triggers).
 *   2. Edges are resolved against the FULL batch's node map (already in
 *      the DB after pass 1) so cross-file edges are order-independent.
 *      Stale edges for files in this batch are deleted first so changed
 *      confidence/provenance values overwrite prior rows.
 *
 * Tagged failure shapes (rule 34): the open + write paths return a
 * discriminated union. Success: `{ok:true, results: UpsertResult[]}`. Failure:
 * `{ok:false, code:"db_locked"|"db_corrupt"}` — no message is exposed
 * to callers because `error.message` from better-sqlite3 frequently
 * contains absolute filesystem paths and stack snippets that should
 * never reach agents or HTTP surfaces (rule 11). The store logs the
 * underlying error internally and returns the code only.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  openBetterSqlite3,
  type BetterSqlite3Database,
} from "@remnic/core/runtime/better-sqlite";

import {
  applyCodingGraphSchema,
  ftsRowidForNodeId,
  isEdgeProvenance,
  readSchemaVersion,
  type EdgeProvenance,
} from "./graph-schema.js";

import { expectRow, expectRows } from "./row-types.js";
// ──────────────────────────────────────────────────────────────────────────
// IR — minimal local type compatible with #1551's FileIR contract.
// ──────────────────────────────────────────────────────────────────────────

/**
 * The half-open span `[startByte, endByte)` — issue #1551 / rule 35. PR1
 * does NOT interpret these; we persist them as-is for PR2's snippet reads.
 */
export interface ByteSpan {
  startByte: number;
  endByte: number;
}

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "enum"
  | "type"
  | "module"
  | "variable"
  | "constant"
  | "unknown";

export interface SymbolIR {
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  /** Half-open span — matches @remnic/core's CodingGraphEngine contract. */
  span: ByteSpan;
  parentQualifiedName?: string;
}

export interface ImportIR {
  source: string;
  importedNames: string[];
  span: ByteSpan;
}

export interface ExportIR {
  name: string;
  span: ByteSpan;
}

export interface CallSiteIR {
  /** Best-effort callee-name candidates from the parser. */
  calleeCandidates: string[];
  span: ByteSpan;
}

/**
 * Hand-written fixture IR. Field names align with issue #1551's
 * `FileIR` contract from @remnic/core (`language`, nested `span`):
 * `{path, language, contentHash, symbols[], imports[], exports[],
 * callSites[]}`. The parser from #1551 will produce richer entries
 * (routes, more metadata); the store ingests whichever subset is
 * present and ignores missing arrays as empty.
 *
 * `edges` is a store-specific extension: the graph-edge model derived
 * from callSites by the caller (PR1 carries pre-derived edges; PR2
 * adds an adapter if the parser emits raw callSites only).
 */
export interface FileIR {
  path: string;
  language: string;
  contentHash: string;
  symbols?: SymbolIR[];
  imports?: ImportIR[];
  exports?: ExportIR[];
  callSites?: CallSiteIR[];
  /**
   * Edges derived from the IR. PR1 only carries CALLS-style edges; PR2
   * adds the rest of #1552's edge types. Each edge references nodes by
   * `qualifiedName` so the store can resolve them against the same
   * batch's symbol set plus the on-disk node table.
   */
  edges?: EdgeIR[];
}

export interface EdgeIR {
  /** Qualified name of the source node (caller / definition site). */
  srcQualifiedName: string;
  /** Qualified name of the destination node (callee / type used). */
  dstQualifiedName: string;
  type: string;
  confidence: number;
  provenance: EdgeProvenance;
}

// ──────────────────────────────────────────────────────────────────────────
// Result shapes — tagged failures (rule 34).
// ──────────────────────────────────────────────────────────────────────────

export type GraphStoreFailureCode = "db_locked" | "db_corrupt";

export interface GraphStoreFailure {
  ok: false;
  code: GraphStoreFailureCode;
}

export interface UpsertResult {
  path: string;
  fileId: number;
  nodeCount: number;
  edgeCount: number;
  /**
   * Dangling edges observed while deleting the file's prior subgraph
   * (cross-file edges whose `dst` belonged to a node owned by this file).
   * Per the PR1 dangling-edge policy in {@link graph-schema}, they are
   * DROPPED, not kept with a marker. Surfaced here so callers can log
   * the loss (rule 11, 40).
   */
  droppedDanglingEdges: number;
}

export interface UpsertSuccess {
  ok: true;
  results: UpsertResult[];
}

export type UpsertBatchResult = UpsertSuccess | GraphStoreFailure;

// ──────────────────────────────────────────────────────────────────────────
// Internal: write-queue (rule 40).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-instance FIFO. A second call to `upsertFileBatch` enqueues and the
 * previous call's promise is awaited before the new one runs. `schedule()`
 * returns immediately with a promise — callers can `await` it or fire-and-
 * forget. A throwing handler propagates the rejection AND drains the queue
 * so the next enqueued call doesn't deadlock (rejection-recovering).
 */
class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  schedule<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    // Swallow the tail's settlement for callers waiting on `next` only.
    // The actual rejection still surfaces from `next` itself.
    this.tail = next.catch(() => undefined);
    return next as Promise<T>;
  }

  /** Test seam: wait until the queue has drained. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Store.
// ──────────────────────────────────────────────────────────────────────────

export interface GraphStoreOptions {
  /** Absolute path to the SQLite file. The caller resolves the namespace. */
  dbPath: string;
}

/**
 * One DB per instance. The store does NOT mutate its path or close the
 * handle until {@link close} is called explicitly (rule 11).
 */
export class GraphStore {
  private readonly db: BetterSqlite3Database;
  private readonly queue = new WriteQueue();
  private closed = false;
  private closing = false;

  private constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  /**
   * Open a store at the given dbPath. Creates parent directories and
   * applies the schema (idempotent — also handles upgrade). The dbPath
   * is the canonical namespace path passed in by the caller — this PR
   * does no namespace resolution.
   */
  static async open(options: GraphStoreOptions): Promise<GraphStore> {
    const { dbPath } = options;
    if (!path.isAbsolute(dbPath)) {
      throw new Error(
        `graph-store: dbPath must be absolute; received ${JSON.stringify(dbPath)}`,
      );
    }
    await mkdir(path.dirname(dbPath), { recursive: true });
    const db = openBetterSqlite3(dbPath);
    // Pragmas verbatim from packages/remnic-core/src/lcm/schema.ts — the
    // shared in-repo pattern. Do not tune per-store (rule 23).
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    // SQLite defaults to foreign_keys=OFF per-connection. The graph's
    // `edges` table relies on `ON DELETE CASCADE` from `nodes(id)` to
    // drop owned edges when a file's prior nodes are pruned; without
    // this pragma the cascade silently no-ops and edges accumulate as
    // orphans (cursor + codex review).
    db.pragma("foreign_keys = ON");
    applyCodingGraphSchema(db);
    return new GraphStore(db);
  }

  /**
   * The current schema_version row. Test seam — never expires, never
   * cached so migrations land without a restart.
   */
  schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  /**
   * Ingest a batch of IR files atomically. One transaction wraps every
   * file's delete + insert; if any file throws, the whole batch rolls
   * back (rule 34 — never partial-write a coding graph).
   *
   * Re-ingesting the same IR is a no-op once the rows are written
   * (idempotency — node ids are deterministic so the second pass collides
   * on PRIMARY KEY).
   *
   * Two-pass ordering: pass 1 upserts every file's nodes (so FTS stays
   * in sync and cross-file edge targets exist by the time pass 2 runs),
   * pass 2 resolves edges against the full batch's node map and deletes
   * prior edges owned by these files so changed confidence/provenance
   * values overwrite (chatgpt-codex-connector P1 + cursor medium + PR1
   * design anchor in graph-schema).
   *
   * Tagging:
   *   - `{ok:true, results}` — every file's counts.
   *   - `{ok:false, code:"db_locked"}` — busy_timeout elapsed; caller may
   *     retry. NOT a thrown error so the agent can degrade gracefully.
   *   - `{ok:false, code:"db_corrupt"}` — SQLite reported
   *     `database disk image is malformed`; the caller must surface and
   *     stop trusting this DB.
   */
  async upsertFileBatch(files: FileIR[]): Promise<UpsertBatchResult> {
    if (this.closed || this.closing) {
      return {
        ok: false,
        code: "db_corrupt",
      };
    }
    return this.queue.schedule(() => this.runUpsert(files));
  }

  /** Wait for pending writes to drain — test seam. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }

  /**
   * Close the SQLite handle after draining the write queue. A batch
   * that has already been scheduled on the queue would otherwise run
   * against a closed DB and surface as `db_corrupt` — the caller
   * would stop trusting the store for unrelated reasons. Drain first,
   * then close (cursor Bugbot #09be5784).
   */
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    // Block NEW writes before draining so a concurrent upsertFileBatch
    // cannot schedule a write that runs after this drain's await captured
    // the old tail. Without this flag, close() drains the queue snapshot,
    // closes the handle, and the late-scheduled write hits a closed DB
    // (chatgpt-codex-connector P2: 'Block new writes before draining').
    this.closing = true;
    await this.queue.drain();
    this.closed = true;
    this.db.close();
  }

  // ────────────── private ──────────────

  private async runUpsert(files: FileIR[]): Promise<UpsertBatchResult> {
    // Guard: duplicate paths in one batch silently corrupt the edge
    // pass — pass 2 deletes the first entry's edges when the second
    // entry's edge pass runs against the same file row. Fail loud so
    // the caller fixes the input (cursor Bugbot: 'Duplicate paths
    // corrupt edge pass').
    const seenPaths = new Set<string>();
    for (const ir of files) {
      if (seenPaths.has(ir.path)) {
        throw new Error(
          `graph-store: duplicate path '${ir.path}' in batch — each FileIR must have a unique path`,
        );
      }
      seenPaths.add(ir.path);
    }
    try {
      const results: UpsertResult[] = [];

      // Single transaction for the whole batch — atomic, faster than
      // per-file BEGIN/COMMIT, and rule 34 mandates "never partial-write
      // a coding graph". Two passes: pass 1 upserts every file's nodes
      // (so FTS stays in sync and cross-file edge targets exist by the
      // time pass 2 runs), pass 2 resolves edges against the full
      // batch's node map and deletes prior edges owned by these files
      // so changed confidence/provenance values overwrite. The two
      // passes together make the write pipeline order-independent for
      // cross-file edges (chatgpt-codex-connector P1/P2).
      const tx = this.db.transaction((irs: FileIR[]) => {
        // Pass 1: every file's nodes. Returns the upsert result so we
        // can populate `results` and so pass 2 can read back
        // droppedDanglingEdges for logging.
        for (const ir of irs) {
          results.push(this.upsertFileNodes(ir));
        }
        // Pass 2: every file's edges. Resolves against the full DB
        // (which already contains every node from this batch plus
        // every node from prior batches).
        for (let i = 0; i < irs.length; i += 1) {
          const ir = irs[i]!;
          const result = results[i]!;
          this.upsertFileEdges(ir, result);
        }
      });
      tx(files);
      return { ok: true, results };
    } catch (error) {
      logWriteFailure(error);
      return classifyError(error);
    }
  }

  /**
   * Pass 1: upsert the file row and every symbol node, refreshing the
   * contentless `nodes_fts` index in lockstep. Prune by deterministic
   * id (NOT qualified_name) so a symbol whose kind changes gets a new
   * id and the OLD row — which still has the same qualified_name but a
   * stale id — is correctly deleted. Counts the dangling edges that
   * fall out of the cascade so the caller can log the loss.
   */
  private upsertFileNodes(ir: FileIR): UpsertResult {
    // Upsert the file row first; the nodes table references files(id).
    const upsertFile = this.db.prepare(
      `INSERT INTO files (path, lang, content_hash)
         VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         lang = excluded.lang,
         content_hash = excluded.content_hash
       RETURNING id`,
    );
    const fileRow = expectRow<{ id: number }>(
      upsertFile.get(ir.path, ir.language, ir.contentHash),
      ["id"],
    );
    if (!fileRow) {
      throw new Error(
        `graph-store: INSERT INTO files RETURNING id returned no row for path=${ir.path}`,
      );
    }
    const fileId = fileRow.id;

    // Build the seen id set FIRST (every symbol → its deterministic id)
    // so the prune step is order-stable and never deletes an id we
    // are about to (re)insert. Determinism is non-negotiable — see
    // nodeIdFor for the canonical form.
    const seenNodeIds = new Set<string>();
    const symbolByNodeId = new Map<string, SymbolIR>();
    for (const sym of ir.symbols ?? []) {
      const id = nodeIdFor({
        qualifiedName: sym.qualifiedName,
        filePath: ir.path,
        label: sym.kind,
      });
      seenNodeIds.add(id);
      symbolByNodeId.set(id, sym);
    }

    // Snapshot the prior nodes owned by this file so we can (a) skip
    // true no-op UPSERTs to keep `changes` honest, and (b) count
    // dangling edges the prune step will cascade.
    const existingNodes = expectRows<{
      id: string;
      label: string;
      name: string;
      qualified_name: string;
      file_id: number;
      span_start: number;
      span_end: number;
      lang: string;
    }>(
      this.db
        .prepare(
          `SELECT id, label, name, qualified_name, file_id,
                  span_start, span_end, lang
             FROM nodes WHERE file_id = ?`,
        )
        .all(fileId),
      ["id", "label", "name", "qualified_name", "file_id", "span_start", "span_end", "lang"],
    );
    const existingById = new Map(existingNodes.map((n) => [n.id, n]));

    const insertNode = this.db.prepare(
      `INSERT INTO nodes (
          id, label, name, qualified_name,
          file_id, span_start, span_end, lang
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          label = excluded.label,
          name = excluded.name,
          qualified_name = excluded.qualified_name,
          file_id = excluded.file_id,
          span_start = excluded.span_start,
          span_end = excluded.span_end,
          lang = excluded.lang`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO nodes_fts (rowid, name, qualified_name) VALUES (?, ?, ?)`,
    );
    const deleteFtsByRowid = this.db.prepare(
      `DELETE FROM nodes_fts WHERE rowid = ?`,
    );
    // fts_index: maps FTS rowid → node id so PR2's search can JOIN
    // hits back to `nodes`. Contentless FTS5 does NOT store column
    // values, so the `id UNINDEXED` column reads NULL on every
    // MATCH — this table is the only reverse-mapping the read path
    // has (chatgpt-codex-connector P2: 'Preserve a node key for
    // FTS hits'). UNIQUE(node_id) lets the upsert use INSERT OR
    // REPLACE so a same-node re-upsert (the common no-op path)
    // keeps a single mapping row.
    const upsertFtsIndex = this.db.prepare(
      `INSERT INTO fts_index (fts_rowid, node_id) VALUES (?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           fts_rowid = excluded.fts_rowid`,
    );
    const deleteFtsIndexByRowid = this.db.prepare(
      `DELETE FROM fts_index WHERE fts_rowid = ?`,
    );
    let nodeCount = 0;
    for (const [id, sym] of symbolByNodeId) {
      const prior = existingById.get(id);
      if (
        prior &&
        prior.label === sym.kind &&
        prior.name === sym.name &&
        prior.qualified_name === sym.qualifiedName &&
        prior.span_start === sym.span.startByte &&
        prior.span_end === sym.span.endByte &&
        prior.lang === ir.language
      ) {
        // Truly a no-op — the row already matches the IR. Skip the
        // INSERT/UPDATE entirely so `changes` stays 0.
        continue;
      }
      // Drop any prior FTS row for this id before the new INSERT.
      // Contentless FTS5 (`content=''`) does NOT store UNINDEXED
      // column values, so the only reliable key is the deterministic
      // rowid we derive from the node id hash (chatgpt-codex-connector
      // P2: `WHERE id = ?` matches zero rows in contentless mode).
      const ftsRowid = ftsRowidForNodeId(id);
      deleteFtsByRowid.run(ftsRowid);
      // Mirror the delete into the FTS → node id reverse map so a
      // re-upsert does not collide on the UNIQUE(fts_rowid) PK when
      // the same rowid previously pointed at a different node id
      // (chatgpt-codex-connector P2: 'Preserve a node key for
      // FTS hits').
      deleteFtsIndexByRowid.run(ftsRowid);
      insertNode.run(
        id,
        sym.kind,
        sym.name,
        sym.qualifiedName,
        fileId,
        sym.span.startByte,
        sym.span.endByte,
        ir.language,
      );
      insertFts.run(ftsRowid, sym.name, sym.qualifiedName);
      upsertFtsIndex.run(ftsRowid, id);
      nodeCount += 1;
    }

    // Prune by id (NOT qualified_name). A symbol whose kind changed
    // keeps the same qualifiedName but has a new node id; the old
    // id's row must be deleted to keep the file's symbol set honest.
    // We do this AFTER the upserts so any same-id re-upsert above is
    // preserved.
    const prunedNodeIds = existingNodes
      .map((n) => n.id)
      .filter((id) => !seenNodeIds.has(id));
    let droppedDanglingEdges = 0;
    if (prunedNodeIds.length > 0) {
      const placeholders = prunedNodeIds.map(() => "?").join(", ");
      // Count dangling edges BEFORE deleting the nodes — the cascade
      // will drop owned edges, so we need the pre-prune count.
      const dangling = expectRow<{ c: number }>(
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges
               WHERE dst IN (${placeholders})
                 AND src NOT IN (${placeholders})`,
          )
          .get(...prunedNodeIds, ...prunedNodeIds),
        ["c"],
      );
      droppedDanglingEdges = dangling?.c ?? 0;
      // DELETE the stale nodes. `ON DELETE CASCADE` on `edges` then
      // drops every edge whose src or dst is one of the pruned ids
      // (the FK pragma is set in `open()`).
      this.db
        .prepare(
          `DELETE FROM nodes WHERE id IN (${prunedNodeIds
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...prunedNodeIds);
      // Clear FTS rows explicitly because the nodes_fts table is not
      // linked by FK. Contentless FTS5 does not store UNINDEXED
      // columns, so the only reliable key is the deterministic rowid
      // derived from the node id (chatgpt-codex-connector P2).
      const ftsRowids = prunedNodeIds.map(ftsRowidForNodeId);
      const ftsPrune = this.db.prepare(
        `DELETE FROM nodes_fts WHERE rowid IN (${ftsRowids
          .map(() => "?")
          .join(", ")})`,
      );
      ftsPrune.run(...ftsRowids);
      // Mirror the prune into the FTS → node id reverse map so a
      // search hit for a pruned node returns no rows. fts_index is
      // keyed by rowid (the same FTS rowid), so the same WHERE
      // clause clears both tables in lockstep (chatgpt-codex-connector
      // P2: 'Preserve a node key for FTS hits').
      const ftsIndexPrune = this.db.prepare(
        `DELETE FROM fts_index WHERE fts_rowid IN (${ftsRowids
          .map(() => "?")
          .join(", ")})`,
      );
      ftsIndexPrune.run(...ftsRowids);
    }

    return {
      path: ir.path,
      fileId,
      nodeCount,
      edgeCount: 0,
      droppedDanglingEdges,
    };
  }

  /**
   * Pass 2: re-insert edges for one file. Runs AFTER every file's
   * nodes are in place (the full batch is committed to nodes) so
   * cross-file edges resolve regardless of input order. Stale edges
   * for nodes owned by this file are deleted first so a changed
   * `confidence` or `provenance` actually overwrites the prior row
   * (chatgpt-codex-connector P1: ON CONFLICT DO NOTHING silently
   * kept stale edges across re-ingests).
   */
  private upsertFileEdges(ir: FileIR, result: UpsertResult): void {
    // Build the set of edges the IR is asserting for this file. The
    // SRC of each edge MUST belong to this file (it is resolved from
    // the per-file `qualifiedNameToId` map only — no DB fallback);
    // a FileIR that asserts an edge whose src is absent from this
    // file but present elsewhere is malformed and the edge is dropped
    // so it cannot be silently cross-owned. The DST may be cross-file
    // and uses the full-DB fallback (chatgpt-codex-connector P2:
    // 'Require edge sources to belong to the ingested file'). Edges
    // whose dst cannot resolve are also dropped — the caller is
    // responsible for the batch's canonical file set (rule 40).
    const qualifiedNameToId = new Map<string, string>();
    const ownSymbols = expectRows<{ id: string; qualified_name: string }>(
      this.db
        .prepare("SELECT id, qualified_name FROM nodes WHERE file_id = ?")
        .all(result.fileId),
      ["id", "qualified_name"],
    );
    // Count qualified_name occurrences so ambiguous names are excluded.
    // Node identity is (qualifiedName, filePath, label) — two symbols in
    // the same file CAN share a qualified_name (e.g. a TS type + value
    // both named Foo, with different labels → different node ids). A
    // qualified_name-only map would silently keep just one; instead,
    // ambiguous names are left out so edges to them resolve to undefined
    // and are dropped — matching the DST conservative-drop policy
    // (chatgpt-codex-connector P2: 'Reject ambiguous local qualified names').
    const qnameCounts = new Map<string, number>();
    for (const row of ownSymbols) {
      qnameCounts.set(row.qualified_name, (qnameCounts.get(row.qualified_name) ?? 0) + 1);
    }
    for (const row of ownSymbols) {
      if ((qnameCounts.get(row.qualified_name) ?? 0) === 1) {
        qualifiedNameToId.set(row.qualified_name, row.id);
      }
    }

    const assertedKeys = new Set<string>();
    // Re-resolve each edge in the IR to its deterministic key so the
    // delete below only drops edges that are NOT being re-asserted.
    // Doing this BEFORE the delete is critical: deleting first then
    // checking the no-op skip leaves cross-file edges (whose src is
    // owned here but whose dst lives elsewhere) orphaned when the
    // IR re-asserts them — the prior-edge snapshot matches, the
    // insert is skipped, and the row is gone (cursor Bugbot #6a78cd0a).
    const seenKeys: string[] = [];
    for (const edge of ir.edges ?? []) {
      // Reject malformed edges up-front (rule 51: surface what is wrong).
      if (!isEdgeProvenance(edge.provenance)) {
        throw new Error(
          `graph-store: edge has invalid provenance ${JSON.stringify(edge.provenance)}`,
        );
      }
      // SRC must be a symbol in THIS file — resolve from the per-file
      // map only. A FileIR whose edge src lives in another file is
      // malformed; dropping it prevents cross-owned edges that survive
      // re-ingest (chatgpt-codex-connector P2).
      const srcId = qualifiedNameToId.get(edge.srcQualifiedName);
      if (!srcId) continue;
      // DST may be cross-file — use the full-DB fallback.
      const dstId = resolveNodeId(
        edge.dstQualifiedName,
        qualifiedNameToId,
        this.db,
      );
      if (!dstId) continue;
      const key = `${srcId}\u0000${dstId}\u0000${edge.type}`;
      assertedKeys.add(key);
      seenKeys.push(key);
    }

    // Pre-fetch the prior edges owned by this file (src in this file's
    // nodes) so we can (a) skip the no-op re-upsert when confidence +
    // provenance match exactly, and (b) compute the stale-edge delete
    // set: prior src-owned edges that are NOT in the current IR's
    // asserted keys.
    const priorEdges = expectRows<{
      src: string;
      dst: string;
      type: string;
      confidence: number;
      provenance: string;
    }>(
      this.db
        .prepare(
          "SELECT src, dst, type, confidence, provenance FROM edges WHERE src IN (SELECT id FROM nodes WHERE file_id = ?)",
        )
        .all(result.fileId),
      ["src", "dst", "type", "confidence", "provenance"],
    );
    const priorByKey = new Map<string, { confidence: number; provenance: string }>();
    const staleSrcDstTypes: Array<{ src: string; dst: string; type: string }> = [];
    for (const p of priorEdges) {
      const key = `${p.src}\u0000${p.dst}\u0000${p.type}`;
      priorByKey.set(key, { confidence: p.confidence, provenance: p.provenance });
      if (!assertedKeys.has(key)) {
        staleSrcDstTypes.push({ src: p.src, dst: p.dst, type: p.type });
      }
    }

    // Delete only the stale src-owned edges (prior-but-not-asserted).
    // This preserves any cross-file edge that the current IR
    // re-asserts, even when its dst lives in a file NOT in this
    // batch — the row survives the delete and the no-op skip below
    // keeps `changes` honest.
    if (staleSrcDstTypes.length > 0) {
      const placeholders = staleSrcDstTypes.map(() => "(?, ?, ?)").join(", ");
      this.db
        .prepare(
          `DELETE FROM edges WHERE (src, dst, type) IN (${placeholders})`,
        )
        .run(
          ...staleSrcDstTypes.flatMap((e) => [e.src, e.dst, e.type]),
        );
    }

    const insertEdge = this.db.prepare(
      `INSERT INTO edges (src, dst, type, confidence, provenance)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO UPDATE SET
           confidence = excluded.confidence,
           provenance = excluded.provenance`,
    );
    let edgeCount = 0;
    // Dedupe keys: a FileIR with two edges sharing `(src, dst, type)`
    // (but differing confidence/provenance) is malformed input. First-edge
    // metadata wins; later duplicates are skipped so they cannot inflate
    // edgeCount via redundant re-upserts (cursor Bugbot #28876d4c).
    const processedKeys = new Set<string>();
    for (const key of seenKeys) {
      if (processedKeys.has(key)) continue;
      processedKeys.add(key);
      const parts = key.split("\u0000");
      const srcId = parts[0]!;
      const dstId = parts[1]!;
      const edgeType = parts[2]!;
      const edge = ir.edges!.find(
        (e) =>
          resolveNodeId(e.srcQualifiedName, qualifiedNameToId, this.db) === srcId &&
          resolveNodeId(e.dstQualifiedName, qualifiedNameToId, this.db) === dstId &&
          e.type === edgeType,
      );
      if (!edge) continue;
      const prior = priorByKey.get(key);
      if (
        prior &&
        prior.confidence === edge.confidence &&
        prior.provenance === edge.provenance
      ) {
        // Identical to the prior row — no INSERT/UPDATE needed, so
        // `changes` stays 0 and the idempotency contract holds. The
        // row still exists because the delete above only removed
        // stale keys.
        continue;
      }
      const r = insertEdge.run(srcId, dstId, edge.type, edge.confidence, edge.provenance);
      edgeCount += r.changes;
    }
    result.edgeCount = edgeCount;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Node id hashing — sorted key material (rule 23/38).
// ──────────────────────────────────────────────────────────────────────────

export interface NodeIdInput {
  qualifiedName: string;
  filePath: string;
  label: string;
}

/**
 * sha256 over the sorted key material. The exact form MUST match between
 * ingest and lookup; tests assert this. Sort is stable (string compare),
 * no separators needed — the three fields are concatenated with a length
 * prefix so collision space is unambiguous.
 */
export function nodeIdFor(input: NodeIdInput): string {
  const fields = [
    ["qualifiedName", input.qualifiedName],
    ["filePath", input.filePath],
    ["label", input.label],
  ]
    .map(([k, v]) => [k as string, String(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const [k, v] of fields) {
    hash.update(`${k.length}:${k}:`);
    hash.update(`${v.length}:${v}:`);
  }
  return hash.digest("hex");
}

/**
 * Resolve a qualified_name to its deterministic node id.
 *
 * `inBatch` is the per-file map built from `nodes` rows owned by the
 * edge's source file (the FileIR.path the edge came in on). The
 * DB fallback is for cross-file edges whose src/dst lives in a
 * DIFFERENT file (in the same batch or a prior batch). Node
 * identity is the full `(qualifiedName, filePath, label)` triple
 * (see `nodeIdFor`), so a qualified_name match alone is ambiguous
 * when two files declare the same symbol. The fallback uses
 * `ORDER BY file_id, id` to pick deterministically, but only when
 * exactly one row matches — multiple matches return `undefined`
 * and the edge is dropped at insert time (per the dangling-edge
 * policy; the caller is responsible for the batch's canonical
 * file set). This is the conservative call for a write pipeline
 * whose caller knows the canonical file set on each batch
 * (rule 11, 40 — chatgpt-codex-connector P2 + cursor Bugbot
 * #1380bc89).
 */
function resolveNodeId(
  qualifiedName: string,
  inBatch: Map<string, string>,
  db: BetterSqlite3Database,
): string | undefined {
  const local = inBatch.get(qualifiedName);
  if (local) return local;
  const rows = expectRows<{ id: string; file_id: number }>(
    db
      .prepare(
        "SELECT id, file_id FROM nodes WHERE qualified_name = ? ORDER BY file_id, id",
      )
      .all(qualifiedName),
    ["id", "file_id"],
  );
  if (rows.length === 0) return undefined;
  if (rows.length > 1) {
    // Ambiguous — drop the edge rather than attach it to the wrong
    // node. Callers needing disambiguation should include the target
    // file in the same batch (the per-file map then wins) or extend
    // EdgeIR with file identity material.
    return undefined;
  }
  return rows[0]?.id;
}
// ──────────────────────────────────────────────────────────────────────────
// Error classification — tag SQLITE_BUSY / SQLITE_CORRUPT into the failure
// shape (rule 34). better-sqlite3 surfaces them as `SqliteError` with `.code`.
// ──────────────────────────────────────────────────────────────────────────

function classifyError(error: unknown): GraphStoreFailure {
  const code = hasErrorCode(error) ? error.code : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return { ok: false, code: "db_locked" };
  }
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    msg.includes("database disk image is malformed")
  ) {
    return { ok: false, code: "db_corrupt" };
  }
  // Non-SQLite errors are NOT disk corruption — they are validation
  // failures (e.g. invalid edge provenance) or programming errors.
  // Conflating them with `db_corrupt` would tell the caller to stop
  // trusting the store for the wrong reason; re-throw so the caller
  // sees the real error (chatgpt-codex-connector P2).
  throw error instanceof Error ? error : new Error(String(error ?? ""));
}

function hasErrorCode(value: unknown): value is { code: string } {
  if (typeof value !== "object" || value === null) return false;
  if (!("code" in value)) return false;
  const codeValue: unknown = (value as Record<string, unknown>)["code"];
  return typeof codeValue === "string";
}

/**
 * Internal log for write failures. Never exposed to callers — the
 * public failure union only carries the code, so absolute paths
 * from `error.message` cannot leak into agents, HTTP responses, or
 * MCP tool results (rule 11).
 */
function logWriteFailure(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error(
    "[coding-graph] write failure:",
    error instanceof Error ? error.message : String(error ?? ""),
  );
}
