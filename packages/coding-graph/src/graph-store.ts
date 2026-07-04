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

export interface SymbolIR extends ByteSpan {
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
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

export interface CallSiteIR extends ByteSpan {
  /** Best-effort callee-name candidates from the parser. */
  calleeCandidates: string[];
}

/**
 * Hand-written fixture IR. Structurally compatible with issue #1551's
 * `FileIR` contract: `{path, lang, contentHash, symbols[], imports[],
 * exports[], callSites[]}`. Spans are half-open `[startByte, endByte)`.
 *
 * The parser from #1551 will produce richer entries (routes, more
 * metadata); the store ingests whichever subset is present and ignores
 * missing arrays as empty.
 */
export interface FileIR {
  path: string;
  lang: string;
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
    if (this.closed) {
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ────────────── private ──────────────

  private async runUpsert(files: FileIR[]): Promise<UpsertBatchResult> {
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
      upsertFile.get(ir.path, ir.lang, ir.contentHash),
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
    let nodeCount = 0;
    for (const [id, sym] of symbolByNodeId) {
      const prior = existingById.get(id);
      if (
        prior &&
        prior.label === sym.kind &&
        prior.name === sym.name &&
        prior.qualified_name === sym.qualifiedName &&
        prior.span_start === sym.startByte &&
        prior.span_end === sym.endByte &&
        prior.lang === ir.lang
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
      insertNode.run(
        id,
        sym.kind,
        sym.name,
        sym.qualifiedName,
        fileId,
        sym.startByte,
        sym.endByte,
        ir.lang,
      );
      insertFts.run(ftsRowid, sym.name, sym.qualifiedName);
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
    // Build the set of edges the IR is asserting for this file. We
    // resolve qualified_name → deterministic id using the FULL nodes
    // table (pass 1 has already populated every batch file's nodes,
    // so cross-file edges resolve regardless of input order). Edges
    // whose src/dst cannot resolve are dropped — the caller is
    // responsible for the batch's canonical file set (rule 40).
    const qualifiedNameToId = new Map<string, string>();
    const ownSymbols = expectRows<{ id: string; qualified_name: string }>(
      this.db
        .prepare("SELECT id, qualified_name FROM nodes WHERE file_id = ?")
        .all(result.fileId),
      ["id", "qualified_name"],
    );
    for (const row of ownSymbols) {
      qualifiedNameToId.set(row.qualified_name, row.id);
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
      const srcId = resolveNodeId(
        edge.srcQualifiedName,
        qualifiedNameToId,
        this.db,
      );
      const dstId = resolveNodeId(
        edge.dstQualifiedName,
        qualifiedNameToId,
        this.db,
      );
      if (!srcId || !dstId) continue;
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
    for (const key of seenKeys) {
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
 * FTS5 rowid derived from a deterministic node id. FTS5 rowids are
 * signed 64-bit integers; we slice the leading 16 hex chars (= 64 bits)
 * of the sha256 id and mask to the int64 positive range so SQLite
 * accepts it. The full 64-bit space is large enough that collisions
 * across distinct node ids are negligible. Contentless FTS5
 * (`content=''`) does NOT store UNINDEXED column values, so the only
 * reliable key into the virtual table is the rowid — the `id UNINDEXED`
 * column exists only for human inspection via sqlite_master inspection,
 * not for queries (chatgpt-codex-connector P2).
 */
function ftsRowidForNodeId(nodeId: string): bigint {
  return BigInt(`0x${nodeId.slice(0, 16)}`) & BigInt("0x7fffffffffffffff");
}

 function resolveNodeId(
  qualifiedName: string,
  inBatch: Map<string, string>,
  db: BetterSqlite3Database,
): string | undefined {
  const local = inBatch.get(qualifiedName);
  if (local) return local;
  // Fall back to a DB lookup keyed by qualified_name. This is best-effort
  // for cross-file edges — the destination must already be ingested in a
  // prior batch.
  const row = expectRow<{ id: string }>(
    db.prepare("SELECT id FROM nodes WHERE qualified_name = ? LIMIT 1").get(qualifiedName),
    ["id"],
  );
  return row?.id;
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
  // Anything else is an unexpected programming error — still tagged
  // so the caller can distinguish from a thrown rejection. The
  // message is intentionally NOT propagated; better-sqlite3 errors
  // frequently include absolute filesystem paths and stack snippets
  // that should never reach agents or HTTP surfaces (rule 11).
  return { ok: false, code: "db_corrupt" };
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
