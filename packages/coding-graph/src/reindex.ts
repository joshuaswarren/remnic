/**
 * Incremental git-based reindex for the coding-graph (issue #1553).
 *
 * Architecture: a PURE planner + a thin executor.
 *
 *   planReindex(lastState, gitFacts) → ReindexPlan
 *
 * The planner is a pure function over plain data — unit-testable without
 * git or a real SQLite handle. It classifies the current situation into
 * one of four modes and returns the file set to (re)ingest:
 *
 *   - "full"          — no prior state (fresh DB); parse every candidate.
 *   - "noop"          — HEAD unchanged AND no working-tree dirt; zero writes.
 *   - "incremental"   — HEAD advanced; re-parse only the changed files.
 *   - "hash_scan"     — last_head is unreachable (rebase/force-push);
 *                       hash every candidate and re-parse only mismatches.
 *
 * The executor parses the plan's files (via an injected `ParseFile` fn),
 * runs the store's `upsertFileBatch`, and persists `last_indexed_head` ONLY
 * after the data transaction commits (rule 25 — a crash between must leave
 * the old head, tested with an injected mid-transaction failure).
 *
 * Post-write reindex invariant (AGENTS.md rule 31): direct-write paths that
 * bypass this pipeline — e.g. a caller using `store.upsertFileBatch`
 * directly — MUST trigger reindex afterward so the graph stays consistent
 * with the persisted content hashes. This module is the canonical way to
 * satisfy that invariant.
 *
 * Distinct from Track A's `session-delta.ts` last-seen-head: that tracks
 * the session's view of the repo for recall diffing; `last_indexed_head`
 * here tracks the GRAPH's persisted index state. They are separate concerns
 * that may legitimately disagree (e.g. a session attached before the first
 * reindex run).
 */
import { createHash } from "node:crypto";
import { readFile as fsReadFile, lstat as fsLstat, realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

import type { ParseFileInput, ParseResult } from "@remnic/core";

import type { CodingGitInvoker, GitFailure, NameStatusEntry } from "./git-invoker.js";
import type {
  GraphStore,
  StoreFileIR,
  ReadMetaResult,
  ReadFileHashesResult,
} from "./graph-store.js";
import type { GraphStoreFailure } from "./graph-store.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types — the planner's input and output
// ──────────────────────────────────────────────────────────────────────────

/**
 * The persisted index state the planner reasons about.
 * `lastHead: null` means "never indexed" → full reindex.
 */
export interface ReindexState {
  /** The HEAD SHA at the time of the last successful reindex, or `null`. */
  readonly lastHead: string | null;
  /**
   * Per-file content hashes as of the last index. Used by hash_scan mode
   * to detect content drift without a reachable base commit.
   * Keyed by repo-relative forward-slash path.
   */
  readonly fileHashes: ReadonlyMap<string, string>;
}

/** Git facts the planner needs — gathered BEFORE the plan is computed. */
export interface ReindexGitFacts {
  /** Current `git rev-parse HEAD`. `null` when the repo has no commits. */
  readonly currentHead: string | null;
  /**
   * Whether `lastHead` (when non-null) is still reachable in the repo.
   * `false` after a rebase/force-push that rewrote history past the old
   * head. `true` when `lastHead` is null (no prior state to reach).
   */
  readonly lastHeadReachable: boolean;
  /**
   * Files changed between `lastHead` and `currentHead` (when both are
   * non-null and reachable). One entry per file from
   * `git diff --name-status`. Empty array for a noop or fresh repo.
   */
  readonly changedFiles: readonly NameStatusEntry[];
}

/** What the planner decided to do. */
export type ReindexPlan =
  | { readonly mode: "full"; readonly reason: string }
  | { readonly mode: "noop"; readonly reason: string }
  | { readonly mode: "incremental"; readonly changedPaths: readonly string[] }
  | {
      readonly mode: "hash_scan";
      readonly reason: string;
      /** Paths whose on-disk hash differs from the stored hash. */
      readonly mismatchedPaths: readonly string[];
    };

/** Result of executing a reindex plan. */
export type ReindexResult =
  | {
      readonly ok: true;
      readonly mode: "full" | "noop" | "incremental" | "hash_scan";
      /** Number of files actually parsed + ingested. */
      readonly filesIngested: number;
      /** The new `last_indexed_head` persisted to meta (null on noop). */
      readonly head: string | null;
    }
  | ({ readonly ok: false } & GitFailure)
  | {
      readonly ok: false;
      readonly code: "parse_failed";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "store_error";
      readonly message: string;
    };

// ──────────────────────────────────────────────────────────────────────────
// Meta-table keys — the store's `meta` table is a simple key/value store.
// ──────────────────────────────────────────────────────────────────────────

export const META_KEY_LAST_HEAD = "last_indexed_head" as const;

/**
 * Meta key holding a JSON array of repo-relative paths that failed to
 * parse on the last run (rule 44: files that fail to parse do not update
 * their stored content hash and MUST retry on the next run). Because a
 * HEAD-unchanged run would otherwise plan `noop` and skip them, the
 * executor consults this set at the top of every run and re-ingests any
 * pending paths even when the plan is noop (cursor Bugbot: 'Parse skips
 * block future reindex').
 */
export const META_KEY_PENDING_PARSE_FAILURES =
  "pending_parse_failures" as const;

// ──────────────────────────────────────────────────────────────────────────
// Pure planner — unit-testable without git or SQLite
// ──────────────────────────────────────────────────────────────────────────

/**
 * Decide what to do given the last state and current git facts.
 *
 * Decision tree:
 *   1. `currentHead === null` → noop (nothing to index; empty repo).
 *   2. `lastHead === null` → full (first index).
 *   3. `lastHead === currentHead` → noop (HEAD unchanged).
 *   4. `!lastHeadReachable` → hash_scan (rebase/force-push lost the base).
 *   5. Otherwise → incremental (re-parse changedFiles paths).
 *
 * Deleted files (status `D`) are included in `changedPaths` so the executor
 * can prune them from the store. Renames include both old and new paths.
 */
export function planReindex(
  lastState: ReindexState,
  facts: ReindexGitFacts,
): ReindexPlan {
  // Case 1: no HEAD at all — nothing to do.
  if (facts.currentHead === null) {
    return { mode: "noop", reason: "repo has no commits (HEAD is null)" };
  }

  // Case 2: never indexed → full.
  if (lastState.lastHead === null) {
    return { mode: "full", reason: "no prior last_indexed_head — first index" };
  }

  // Case 3: HEAD unchanged → noop. No writes, no parse.
  if (lastState.lastHead === facts.currentHead) {
    return { mode: "noop", reason: "HEAD unchanged since last index" };
  }

  // Case 4: last_head is unreachable (rebase/force-push). Fall back to
  // hash_scan — the executor hashes every candidate and re-parses only
  // mismatches. Never crash, never silently full-reindex without saying so.
  if (!facts.lastHeadReachable) {
    return {
      mode: "hash_scan",
      reason: `last_indexed_head ${lastState.lastHead.slice(0, 12)} is unreachable (rebase/force-push)`,
      // mismatchedPaths is filled by the executor (needs to read files).
      mismatchedPaths: [],
    };
  }

  // Case 5: incremental. The diff is trustworthy; re-parse changed files.
  const changedPaths: string[] = [];
  for (const entry of facts.changedFiles) {
    // `D` = deleted → include so executor prunes the file.
    // `A` = added, `M` = modified → include to (re)parse.
    // `R*`/`C*` = renamed/copied → include both old and new paths.
    changedPaths.push(entry.path);
    if (entry.oldPath !== undefined && entry.oldPath !== entry.path) {
      changedPaths.push(entry.oldPath);
    }
  }
  return { mode: "incremental", changedPaths };
}

// ──────────────────────────────────────────────────────────────────────────
// Executor — parses files, drives the store, updates meta
// ──────────────────────────────────────────────────────────────────────────

/**
 * A parse function — the engine seam. The executor calls this for each
 * file the plan says to (re)ingest. In production the orchestrator injects
 * the real `CodingGraphEngine.parseFile`; in tests a synthetic parser is
 * injected. This keeps the package decoupled from the engine implementation
 * (which is still a placeholder in #1551 PR1).
 */
export type ParseFileFn = (input: ParseFileInput) => Promise<ParseResult>;

/** Injectable file reader — defaults to `node:fs/promises`.readFile. */
export type ReadFileFn = (absPath: string) => Promise<Uint8Array>;

/**
 * Read the persisted `last_indexed_head` from the store's meta table.
 * Returns `null` when the key is absent (fresh DB).
 */
export function readLastIndexedHead(store: GraphStore): ReadMetaResult {
  return store.readMeta(META_KEY_LAST_HEAD);
}

/**
 * Read every file row's path → content_hash from the store. Used by
 * hash_scan to detect content drift without a reachable base commit.
 */
export function readFileHashes(store: GraphStore): ReadFileHashesResult {
  return store.readFileHashes();
}

/**
 * SHA-256 of raw bytes. Matches the engine's contract
 * (`FileIR.contentHash` — rule 23: every consumer hashes the same form).
 */
export function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Reject non-canonical repo-relative paths before they reach the disk.
 * Git diff output is always canonical, but defense-in-depth prevents a
 * crafted `..` path from reading outside repoRoot (cursor Bugbot:
 * 'Reindex reads non-canonical paths'). Mirrors the store's
 * `assertCanonicalFilePath` boundary.
 */
function isCanonicalRelativePath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\\")) return false; // backslash → Windows separator
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return false; // absolute
  if (p.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return true;
}

/**
 * Probe a repo-relative path: canonical check + existence/content read that
 * distinguishes a CONFIRMED deletion (ENOENT) from a transient I/O error
 * (EACCES / EBUSY / timeout). A transient error must NOT be treated as a
 * deletion — otherwise a momentary lock/permission error would drop the
 * file's nodes from the graph while the file still exists on disk
 * (cursor Bugbot: 'Read errors trigger graph deletes'). Also enforces the
 * canonical-path guard BEFORE any read so a crafted `../` path cannot
 * escape repoRoot (cursor Bugbot: 'Non-canonical paths read early').
 */
type ProbeRead =
  | { readonly kind: "exists"; readonly content: Uint8Array }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" }
  | { readonly kind: "skip" };
async function probeRead(
  repoRoot: string,
  relPath: string,
  readFile: ReadFileFn,
): Promise<ProbeRead> {
  if (!isCanonicalRelativePath(relPath)) return { kind: "skip" };
  const probeAbs = resolveRepoPath(repoRoot, relPath);
  // Reject symlinks that escape repoRoot before reading (rule 3).
  if (await symlinkEscapesRoot(repoRoot, probeAbs)) return { kind: "skip" };
  try {
    const content = await readFile(probeAbs);
    return { kind: "exists", content };
  } catch (e) {
    const code =
      e && typeof e === "object"
        ? (e as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return { kind: "missing" };
    // Transient error — the file may still exist. Do not prune.
    return { kind: "unknown" };
  }
}

/** Resolve a repo-relative forward-slash path to an absolute OS path. */
function resolveRepoPath(repoRoot: string, relPath: string): string {
  // Split on forward slashes and re-join with the platform separator so
  // Windows backslash-in-relPath is never accidentally treated as escape.
  return path.resolve(repoRoot, ...relPath.split("/"));
}

/**
 * Symlink-escape guard (AGENTS.md rule 3): a canonical repo-relative path can
 * still resolve to a SYMLINK whose target lives outside repoRoot; following it
 * would let a crafted/tracked symlink read arbitrary files into the graph.
 * Returns true only for real symlinks whose resolved target escapes repoRoot.
 * Non-symlinks and unresolvable paths return false (the normal read path then
 * classifies ENOENT/transient errors) so injected readers and regular files are
 * unaffected.
 */
async function symlinkEscapesRoot(repoRoot: string, absPath: string): Promise<boolean> {
  try {
    const st = await fsLstat(absPath);
    if (!st.isSymbolicLink()) return false;
    const [realRoot, realAbs] = await Promise.all([
      fsRealpath(repoRoot),
      fsRealpath(absPath),
    ]);
    const rel = path.relative(realRoot, realAbs);
    return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Default file reader: reads from disk via node:fs/promises. */
async function defaultReadFile(absPath: string): Promise<Uint8Array> {
  const buf = await fsReadFile(absPath);
  // Return a Uint8Array view over the same buffer (Buffer IS a
  // Uint8Array subclass; this copy-free view satisfies the FileIR contract).
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Per-store reindex serialization. Concurrent `executeReindex` calls
 * against the same store are serialized end-to-end so a slower run that
 * indexed an older HEAD cannot finish later and overwrite
 * `last_indexed_head` with a stale SHA (cursor Bugbot: 'Stale head
 * after concurrent reindex'). The store's write queue already serializes
 * individual upserts, but the head/meta writes around them are not
 * ordered across runs without this gate.
 */
const reindexLocks = new WeakMap<GraphStore, Promise<unknown>>();

/**
 * Execute a reindex against a store + git repo.
 *
 * Steps:
 *   1. Gather git facts (currentHead, reachable, changedFiles).
 *   2. Plan via {@link planReindex}.
 *   3. For full/incremental/hash_scan: parse each file, build a batch,
 *      call `store.upsertFileBatch`.
 *   4. Persist `last_indexed_head` ONLY after the batch commits (rule 25).
 *
 * The reindex is serialized per-store via the store's own write queue.
 * A session-start trigger racing a manual CLI trigger coalesces (rule 40).
 *
 * `candidatePaths` is needed for full and hash_scan modes (the set of
 * files to consider). Typically from `git ls-files` or a glob. When
 * omitted, full/hash_scan operate over the union of stored files and
 * git-tracked files.
 */
export async function executeReindex(options: {
  readonly store: GraphStore;
  readonly git: CodingGitInvoker;
  readonly repoRoot: string;
  readonly parseFile: ParseFileFn;
  readonly candidatePaths?: readonly string[];
  readonly readFile?: ReadFileFn;
}): Promise<ReindexResult> {
  const { store, git, repoRoot, parseFile } = options;
  const readFile = options.readFile ?? defaultReadFile;

  // Serialize concurrent runs against the same store end-to-end.
  const prev = reindexLocks.get(store) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  reindexLocks.set(store, prev.then(() => next));
  await prev;
  try {
    return await runReindex(store, git, repoRoot, parseFile, readFile, options);
  } finally {
    release();
  }
}

/** Inner reindex body — runs under the per-store serialization lock. */
async function runReindex(
  store: GraphStore,
  git: CodingGitInvoker,
  repoRoot: string,
  parseFile: ParseFileFn,
  readFile: ReadFileFn,
  options: {
    readonly candidatePaths?: readonly string[];
  },
): Promise<ReindexResult> {

  // ── Gather git facts ──────────────────────────────────────────────────
  // readMeta now returns a tagged result (rule 22): a backend failure must
  // NOT be conflated with "never indexed" (null), which would send the
  // planner down a full-reindex path against a store it cannot read. Bail
  // before any mutation (cursor Bugbot: 'readMeta conflates absent key
  // with db failure').
  const lastHeadRead = readLastIndexedHead(store);
  if (!lastHeadRead.ok) {
    return {
      ok: false,
      code: "store_error",
      message: `read last_indexed_head: ${lastHeadRead.code}`,
    };
  }
  const lastHead = lastHeadRead.value;
  const headResult = git.revParseHead(repoRoot);
  if (!headResult.ok) return headResult;

  let reachable = true;
  if (lastHead !== null && headResult.head !== null) {
    const reachResult = git.isReachable(repoRoot, lastHead);
    if (!reachResult.ok) return reachResult;
    reachable = reachResult.reachable;
  }

  let changedFiles: NameStatusEntry[] = [];
  if (
    lastHead !== null &&
    headResult.head !== null &&
    reachable &&
    lastHead !== headResult.head
  ) {
    const diffResult = git.diffNameStatus(
      repoRoot,
      `${lastHead}..${headResult.head}`,
    );
    if (!diffResult.ok) {
      // Diff failed but heads were "reachable" — degrade to hash_scan.
      reachable = false;
    } else {
      changedFiles = [...diffResult.entries];
    }
  }

  const facts: ReindexGitFacts = {
    currentHead: headResult.head,
    lastHeadReachable: reachable,
    changedFiles,
  };
  // Read the file-hash snapshot ONCE. A backend failure here must NOT be
  // treated as an empty index — that would either skip pruning while head
  // advances, or prune against a falsely-empty set. Bail before any mutation
  // (rule 22; cursor Bugbot HIGH: 'readFileHashes conflates error with
  // empty'). The same snapshot is reused for every prune decision below:
  // nothing mutates the store between here and the ingest, so a fresh read
  // at each site would only re-introduce the error/empty conflation.
  const fileHashesRead = readFileHashes(store);
  if (!fileHashesRead.ok) {
    return {
      ok: false,
      code: "store_error",
      message: `readFileHashes: ${fileHashesRead.code}`,
    };
  }
  const fileHashes = fileHashesRead.hashes;

  const lastState: ReindexState = {
    lastHead,
    fileHashes,
  };

  const plan = planReindex(lastState, facts);

  // ── Pending parse-failure retry (rule 44) ─────────────────────────────
  // Paths that failed to parse on a prior run must be retried even when
  // HEAD is unchanged (a noop plan would otherwise skip them). Read once;
  // we rewrite this set after every run with the CURRENT run's failures.
  const pendingRetryRead = readPendingParseFailures(store);
  if (!pendingRetryRead.ok) {
    return {
      ok: false,
      code: "store_error",
      message: `read pending_parse_failures: ${pendingRetryRead.code}`,
    };
  }
  const pendingRetry = pendingRetryRead.paths;

  // ── Execute the plan ──────────────────────────────────────────────────
  switch (plan.mode) {
    case "noop": {
      if (pendingRetry.length === 0) {
        return { ok: true, mode: "noop", filesIngested: 0, head: lastHead };
      }
      // HEAD unchanged but some files still need a parse retry. Re-ingest
      // ONLY the pending set (no diff, no deletes). Clears paths that now
      // parse; keeps failures for the next run.
      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        pendingRetry,
      );
      if (!ingestResult.ok) return ingestResult;
      // Persist the updated pending set BEFORE any head write (rule 25:
      // meta updates after the data transaction commits).
      store.writeMeta(
        META_KEY_PENDING_PARSE_FAILURES,
        JSON.stringify(ingestResult.parseFailedPaths),
      );
      return {
        ok: true,
        mode: "noop",
        filesIngested: ingestResult.count,
        head: lastHead,
      };
    }

    case "full": {
      const candidatesProvided = options.candidatePaths !== undefined;
      const candidates = options.candidatePaths ?? [];
      if (candidates.length === 0 && pendingRetry.length === 0) {
        // Nothing to index and nothing to retry. Do NOT advance
        // last_indexed_head — without candidates we did not build an
        // index, so claiming freshness would be dishonest (an empty
        // repo reports mode:"empty" via index_status, which is correct).
        // (cursor Bugbot: 'Empty full run marks indexed'.)
        return { ok: true, mode: "noop", filesIngested: 0, head: lastHead };
      }
      // Dedup: a path can appear in both candidates and pendingRetry;
      // upsertFileBatch rejects duplicate paths in one batch (cursor
      // Bugbot: 'Full reindex duplicate ingest paths').
      const toIngest = [...new Set([...candidates, ...pendingRetry])];
      // Prune stored files that are absent from the candidate set so a
      // full reindex against a pre-existing store (v1 store, or a crash
      // before the first meta write) does not leave deleted-file symbols
      // behind while marking the index current (chatgpt-codex-connector:
      // 'Prune absent files during full reindex').
      // Only prune when the caller supplied an AUTHORITATIVE candidate list.
      // Without candidatePaths (e.g. a retry-only resume) we cannot know which
      // stored files are truly absent; pruning against a retry-only set would
      // destructively delete every successfully-indexed file. Likewise we must
      // not advance last_indexed_head in that case, since a partial (retry-only)
      // pass has not re-verified the whole tree (chatgpt-codex-connector: 'Do
      // not prune full indexes when candidates are absent').
      let fullDelete: string[] = [];
      if (candidatesProvided) {
        const fullCandidateSet = new Set(toIngest);
        fullDelete = [...fileHashes.keys()].filter(
          (p) => !fullCandidateSet.has(p),
        );
      }
      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        toIngest,
        fullDelete,
      );
      if (!ingestResult.ok) return ingestResult;
      store.writeMeta(
        META_KEY_PENDING_PARSE_FAILURES,
        JSON.stringify(
          computeNextPending({
            priorPending: pendingRetry,
            parseFailedPaths: ingestResult.parseFailedPaths,
            ingestedCandidates: toIngest,
            deleted: fullDelete,
          }),
        ),
      );
      // Rule 25: persist head ONLY after data + pending-set commit — and ONLY
      // when candidates were authoritative (see above).
      if (candidatesProvided) {
        store.writeMeta(META_KEY_LAST_HEAD, headResult.head ?? "");
      }
      return {
        ok: true,
        mode: "full",
        filesIngested: ingestResult.count,
        head: candidatesProvided ? headResult.head : lastHead,
      };
    }

    case "incremental": {
      // Deduplicate (rule 49 — a file can appear staged AND in the commit
      // diff). Use a Set for dynamic runtime membership tracking.
      const seen = new Set<string>();
      for (const p2 of plan.changedPaths) seen.add(p2);
      // Pending parse-failures from a prior run are also candidates.
      for (const p2 of pendingRetry) seen.add(p2);

      // Determine which paths still exist on disk vs are deleted. Use a
      // probe that distinguishes a confirmed deletion (ENOENT) from a
      // transient I/O error (which must NOT prune the file).
      const knownFiles = fileHashes;
      const toDelete: string[] = [];
      const toIngest: string[] = [];
      for (const p2 of seen) {
        const probe = await probeRead(repoRoot, p2, readFile);
        if (probe.kind === "skip") continue;
        if (probe.kind === "exists" || probe.kind === "unknown") {
          // exists → re-ingest; unknown (transient error) → route to
          // ingest so ingestFiles records it as a pending retry if the
          // read still fails, WITHOUT deleting the existing nodes.
          toIngest.push(p2);
        } else if (probe.kind === "missing" && knownFiles.has(p2)) {
          toDelete.push(p2);
        }
      }

      // Pass toDelete into upsertFileBatch so the prune + re-ingest land
      // in ONE transaction (rule 22/25 — a mid-batch failure rolls both
      // back; cursor Bugbot: 'Deletes commit before ingest fails').
      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        toIngest,
        toDelete,
      );
      if (!ingestResult.ok) return ingestResult;
      store.writeMeta(
        META_KEY_PENDING_PARSE_FAILURES,
        JSON.stringify(
          computeNextPending({
            priorPending: pendingRetry,
            parseFailedPaths: ingestResult.parseFailedPaths,
            ingestedCandidates: toIngest,
            deleted: toDelete,
          }),
        ),
      );
      // Rule 25: persist head ONLY after data commits.
      store.writeMeta(META_KEY_LAST_HEAD, headResult.head ?? "");
      return {
        ok: true,
        mode: "incremental",
        filesIngested: ingestResult.count,
        head: headResult.head,
      };
    }

    case "hash_scan": {
      // Hash every candidate, re-parse only mismatches. This path is
      // taken when last_head is unreachable (rebase/force-push) or when
      // the incremental diff itself failed.
      // Union caller-supplied candidates WITH the previously-indexed
      // files AND pending retries. Omitting stored files would miss
      // newly-deleted files (their symbols would linger while head
      // advances); omitting candidates would miss newly-added files not
      // yet in the index (chatgpt-codex-connector: 'Require candidates
      // before completing hash-scan' / 'Include indexed files in
      // hash-scan candidates').
      const hashScanCandidatesProvided = options.candidatePaths !== undefined;
      const candidateSet = new Set<string>([
        ...(options.candidatePaths ?? []),
        ...lastState.fileHashes.keys(),
        ...pendingRetry,
      ]);
      // Hash every candidate via the canonical+ENOENT-aware probe. A
      // transient read error must NOT be treated as a deletion.
      const knownFiles = fileHashes;
      const toDelete: string[] = [];
      const toIngest: string[] = [];
      const hashScanRetry: string[] = [];
      for (const candidatePath of candidateSet) {
        const probe = await probeRead(repoRoot, candidatePath, readFile);
        if (probe.kind === "skip") continue;
        if (probe.kind === "missing") {
          if (knownFiles.has(candidatePath)) toDelete.push(candidatePath);
          continue;
        }
        if (probe.kind === "unknown") {
          // Transient read error — keep the stored entry, do not prune,
          // and record the path for a pending retry so it is re-tried on
          // the next run even when HEAD is unchanged (chatgpt-codex-
          // connector: 'Retain hash-scan read failures for retry').
          hashScanRetry.push(candidatePath);
          continue;
        }
        // exists — compare content hash.
        const currentHash = hashContent(probe.content);
        const storedHash = lastState.fileHashes.get(candidatePath);
        if (storedHash !== currentHash) {
          toIngest.push(candidatePath);
        }
      }

      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        toIngest,
        toDelete,
      );
      if (!ingestResult.ok) return ingestResult;
      store.writeMeta(
        META_KEY_PENDING_PARSE_FAILURES,
        JSON.stringify(
          computeNextPending({
            priorPending: pendingRetry,
            parseFailedPaths: ingestResult.parseFailedPaths,
            extraRetry: hashScanRetry,
            ingestedCandidates: toIngest,
            deleted: toDelete,
          }),
        ),
      );
      // Rule 25: persist head ONLY after data commits — and ONLY when the
      // caller supplied candidates. Without candidatePaths the scan covers only
      // stored + pending paths, so a file newly added in the current HEAD would
      // be missed; advancing head would falsely report freshness (chatgpt-codex-
      // connector: 'Require current candidates before advancing hash-scan').
      if (hashScanCandidatesProvided) {
        store.writeMeta(META_KEY_LAST_HEAD, headResult.head ?? "");
      }
      return {
        ok: true,
        mode: "hash_scan",
        filesIngested: ingestResult.count,
        head: hashScanCandidatesProvided ? headResult.head : lastHead,
      };
    }
  }
}

/**
 * Read the persisted set of paths that failed to parse on the last run
 * (rule 44). Returns an empty array when the key is absent or malformed.
 */
function readPendingParseFailures(
  store: GraphStore,
): { ok: true; paths: string[] } | ({ ok: false } & GraphStoreFailure) {
  const rawRead = store.readMeta(META_KEY_PENDING_PARSE_FAILURES);
  if (!rawRead.ok) return rawRead;
  const raw = rawRead.value;
  if (raw === null) return { ok: true, paths: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: true, paths: [] };
    return {
      ok: true,
      paths: parsed.filter((p): p is string => typeof p === "string"),
    };
  } catch {
    return { ok: true, paths: [] };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute the next `pending_parse_failures` set. A path must remain pending
 * until it is actually INGESTED (parsed + stored) or confirmed DELETED —
 * otherwise a pending path that was skipped (non-canonical), hash-matched in
 * hash_scan, or otherwise not re-ingested silently drops off the retry list
 * while `last_indexed_head` advances, so its symbols are never (re)built yet the
 * index reports fresh (cursor Bugbot HIGH: 'Pending retries cleared
 * incorrectly'). The next set is therefore the union of the prior pending set,
 * this run's parse failures, and any transient retries, MINUS the paths that
 * were successfully ingested or deleted this run.
 */
function computeNextPending(args: {
  readonly priorPending: readonly string[];
  readonly parseFailedPaths: readonly string[];
  readonly extraRetry?: readonly string[];
  readonly ingestedCandidates: readonly string[];
  readonly deleted: readonly string[];
}): string[] {
  const failed = new Set(args.parseFailedPaths);
  const successfullyIngested = new Set(
    args.ingestedCandidates.filter((p) => !failed.has(p)),
  );
  const deleted = new Set(args.deleted);
  const next = new Set<string>();
  for (const path of [
    ...args.priorPending,
    ...args.parseFailedPaths,
    ...(args.extraRetry ?? []),
  ]) {
    if (successfullyIngested.has(path) || deleted.has(path)) continue;
    next.add(path);
  }
  return [...next];
}

/**
 * Narrow result type for the ingest helper — avoids union overlap with
 * {@link ReindexResult}'s success branches so the caller can cleanly
 * discriminate on `ok` and read `.count` without ambiguity.
 */
type IngestResult =
  | {
      readonly ok: true;
      readonly count: number;
      /** Paths that failed to parse (rule 44 — must retry next run). */
      readonly parseFailedPaths: string[];
    }
  | { readonly ok: false; readonly code: "store_error"; readonly message: string };
/**
 * Parse + ingest a list of files. Returns the count ingested or a tagged
 * failure. Files that fail to parse do NOT update their stored content
 * hash (rule 44 — they must retry next run). The caller records them in
 * the `pending_parse_failures` meta key so the NEXT run re-ingests them
 * even when HEAD is unchanged (a noop plan would otherwise skip them —
 * cursor Bugbot: 'Parse skips block future reindex').
 */
async function ingestFiles(
  store: GraphStore,
  repoRoot: string,
  parseFile: ParseFileFn,
  readFile: ReadFileFn,
  paths: readonly string[],
  deletePaths: readonly string[] = [],
): Promise<IngestResult> {
  const batch: StoreFileIR[] = [];
  const parseFailedPaths: string[] = [];
  for (const relPath of paths) {
    if (!isCanonicalRelativePath(relPath)) {
      // Non-canonical path would read outside repoRoot / be rejected by
      // the store anyway. Record + skip (rule 44 — retry-safe).
      parseFailedPaths.push(relPath);
      continue;
    }
    const ingestAbs = resolveRepoPath(repoRoot, relPath);
    // Reject symlinks that escape repoRoot before reading (rule 3). A skipped
    // escape is not a parse failure — do not retain it as a pending retry.
    if (await symlinkEscapesRoot(repoRoot, ingestAbs)) continue;
    let content: Uint8Array;
    try {
      content = await readFile(ingestAbs);
    } catch {
      // File unreadable (deleted between plan and execution, or a
      // transient I/O error). Record it for retry so a transient read
      // failure does not silently drop a path that was never ingested
      // (cursor Bugbot: 'Read errors drop pending retries'). A truly
      // deleted file is pruned via deletePaths when the caller detected
      // the deletion; here we only keep it retrying.
      parseFailedPaths.push(relPath);
      continue;
    }
    const parseResult = await parseFile({ path: relPath, content });
    if (!parseResult.ok) {
      // Rule 44: record unparseable files so they retry next run; do
      // not fail the batch.
      parseFailedPaths.push(relPath);
      continue;
    }
    // FileIR is structurally assignable to StoreFileIR — the store only
    // reads the fields it needs and ignores extra FileIR fields (imports,
    // callSites). No cast needed.
    batch.push(parseResult.ir);
  }
  // Even when batch is empty we must run the upsert so deletePaths are
  // pruned atomically (the store's transaction wraps both). A zero-file,
  // zero-delete call is a cheap no-op.
  const upsertResult = await store.upsertFileBatch(batch, deletePaths);
  if (!upsertResult.ok) {
    return {
      ok: false,
      code: "store_error",
      message: `upsertFileBatch failed: ${upsertResult.code}`,
    };
  }
  return { ok: true, count: batch.length, parseFailedPaths };
}

