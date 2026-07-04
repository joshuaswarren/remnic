/**
 * Coding-graph write pipeline — single-batch, single-transaction delete +
 * reinsert per file. PR1 scope (issue #1552):
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
 * Tagged failure shapes (rule 34): the open + write paths return a
 * discriminated union. Success: `{ok:true, results: UpsertResult[]}`. Failure:
 * `{ok:false, code:"db_locked"|"db_corrupt", message?: string}`. The shape
 * mirrors `SearchDegradation` in `@remnic/core/search/port` (issue #1536).
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
  message?: string;
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

interface QueueEntry {
  run: () => Promise<UpsertBatchResult>;
  resolve: (value: UpsertBatchResult) => void;
}

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
        message: "graph-store: store is closed",
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
      // Snapshot every pre-existing node id so upsertOne can extend the
      // set as it inserts new nodes for this batch — qualified_name
      const knownNodeIds = new Set<string>(
        expectRows<{ id: string }>(
          this.db.prepare("SELECT id FROM nodes").all(),
          ["id"],
        ).map((row) => row.id),
      );

      const results: UpsertResult[] = [];

      // Single transaction for the whole batch — atomic, faster than
      // per-file BEGIN/COMMIT, and rule 34 mandates "never partial-write
      // a coding graph".
      const tx = this.db.transaction((irs: FileIR[]) => {
        for (const ir of irs) {
          results.push(this.upsertOne(ir, knownNodeIds));
        }
      });
      tx(files);
      return { ok: true, results };
    } catch (error) {
      return classifyError(error);
    }
  }

  private upsertOne(ir: FileIR, knownNodeIds: Set<string>): UpsertResult {
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
    // Snapshot the qualified_names in THIS batch BEFORE we read the
    // prior node set — we use it to determine which owned nodes will
    // actually be pruned. With the UPSERT-then-prune pipeline, an
    // unchanged re-ingest leaves every prior node in place, so the
    // dangling-edge count must be zero (no node is deleted → no edge
    // is dropped).
    const seenQualifiedNames = new Set<string>(
      (ir.symbols ?? []).map((s) => s.qualifiedName),
    );
    // Map every seen qualified_name → its deterministic node id so we
    // can compute the surviving set below.
    const seenNodeIds = new Set<string>(
      (ir.symbols ?? []).map((s) =>
        nodeIdFor({
          qualifiedName: s.qualifiedName,
          filePath: ir.path,
          label: s.kind,
        }),
      ),
    );
    const ownedNodeIds = expectRows<{ id: string }>(
      this.db.prepare("SELECT id FROM nodes WHERE file_id = ?").all(fileId),
      ["id"],
    ).map((row) => row.id);
    const prunedNodeIds = ownedNodeIds.filter((id) => !seenNodeIds.has(id));
    let droppedDanglingEdges = 0;
    if (prunedNodeIds.length > 0) {
      const placeholders = prunedNodeIds.map(() => "?").join(", ");
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
    }

    // SELECT existing nodes for this file once, then UPSERT per symbol.
    // The exact equality check (id + label + name + qualified_name + file_id
    // + spans + lang) lets us count `changes` honestly: a re-ingest of
    // unchanged symbols is a true no-op (changes=0), matching the
    // idempotency contract test. A new symbol gets a clean INSERT
    // (changes=1). A changed symbol hits ON CONFLICT DO UPDATE and
    // also reports changes=1.
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
    let nodeCount = 0;
    for (const sym of ir.symbols ?? []) {
      const id = nodeIdFor({
        qualifiedName: sym.qualifiedName,
        filePath: ir.path,
        label: sym.kind,
      });
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
        knownNodeIds.add(id);
        continue;
      }
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
      knownNodeIds.add(id);
      nodeCount += 1;
    }
    // Prune nodes that disappeared from this file's IR. The dangling
    // edge counter already ran against the pre-prune state so cross-file
    // edge drops are accounted for.
    if (seenQualifiedNames.size > 0) {
      const placeholders = Array.from(seenQualifiedNames, () => "?").join(", ");
      this.db
        .prepare(
          `DELETE FROM nodes
             WHERE file_id = ?
               AND qualified_name NOT IN (${placeholders})`,
        )
        .run(fileId, ...seenQualifiedNames);
    } else {
      this.db.prepare("DELETE FROM nodes WHERE file_id = ?").run(fileId);
    }
    // Re-insert edges. dst may not exist yet in the DB (cross-file edges
    // where the destination belongs to ANOTHER file in the same batch).
    // We insert optimistically and let FK enforcement fail loudly — the
    // dangling-edge POLICY is "drop at delete time", not "drop at insert
    // time". For unresolved cross-file references, callers SHOULD either
    // include the target file in the same batch, or filter the IR. We
    // skip edges whose `src`/`dst` we cannot resolve in the known-node
    // set so we don't trigger FK violations.
    const insertEdge = this.db.prepare(
      `INSERT INTO edges (src, dst, type, confidence, provenance)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO NOTHING`,
    );
    let edgeCount = 0;
    const qualifiedNameToId = new Map<string, string>();
    for (const sym of ir.symbols ?? []) {
      qualifiedNameToId.set(
        sym.qualifiedName,
        nodeIdFor({
          qualifiedName: sym.qualifiedName,
          filePath: ir.path,
          label: sym.kind,
        }),
      );
    }
    // Snapshot qualified_name → id for every node already on disk so
    // cross-file edges whose destination was ingested in a prior batch
    // resolve without an extra SELECT per edge. The index on
    // qualified_name keeps each lookup O(log n).
    const existing = expectRows<{ id: string; qualified_name: string }>(
      this.db.prepare("SELECT id, qualified_name FROM nodes").all(),
      ["id", "qualified_name"],
    );
    for (const row of existing) {
      if (!qualifiedNameToId.has(row.qualified_name)) {
        qualifiedNameToId.set(row.qualified_name, row.id);
      }
    }

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
      const result = insertEdge.run(srcId, dstId, edge.type, edge.confidence, edge.provenance);
      edgeCount += result.changes;
    }

    return {
      path: ir.path,
      fileId,
      nodeCount,
      edgeCount,
      droppedDanglingEdges,
    };
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
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  const code = hasErrorCode(error) ? error.code : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return { ok: false, code: "db_locked", message };
  }
  if (
    code === "SQLITE_CORRUPT" ||
    code === "SQLITE_NOTADB" ||
    message.includes("database disk image is malformed")
  ) {
    return { ok: false, code: "db_corrupt", message };
  }
  // Anything else is an unexpected programming error — surface the message
  // but still tag it so the caller can distinguish from a thrown rejection.
  return { ok: false, code: "db_corrupt", message };
}

function hasErrorCode(value: unknown): value is { code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string"
  );
}
