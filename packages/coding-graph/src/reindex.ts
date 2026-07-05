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
import { readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";

import type { ParseFileInput, ParseResult } from "@remnic/core";

import type { CodingGitInvoker, GitFailure, NameStatusEntry } from "./git-invoker.js";
import type { GraphStore, StoreFileIR } from "./graph-store.js";

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
export function readLastIndexedHead(store: GraphStore): string | null {
  return store.readMeta(META_KEY_LAST_HEAD);
}

/**
 * Read every file row's path → content_hash from the store. Used by
 * hash_scan to detect content drift without a reachable base commit.
 */
export function readFileHashes(store: GraphStore): Map<string, string> {
  return store.readFileHashes();
}

/**
 * SHA-256 of raw bytes. Matches the engine's contract
 * (`FileIR.contentHash` — rule 23: every consumer hashes the same form).
 */
export function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve a repo-relative forward-slash path to an absolute OS path. */
function resolveRepoPath(repoRoot: string, relPath: string): string {
  // Split on forward slashes and re-join with the platform separator so
  // Windows backslash-in-relPath is never accidentally treated as escape.
  return path.resolve(repoRoot, ...relPath.split("/"));
}

/** Default file reader: reads from disk via node:fs/promises. */
async function defaultReadFile(absPath: string): Promise<Uint8Array> {
  const buf = await fsReadFile(absPath);
  // Return a Uint8Array view over the same buffer (Buffer IS a
  // Uint8Array subclass; this copy-free view satisfies the FileIR contract).
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

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

  // ── Gather git facts ──────────────────────────────────────────────────
  const lastHead = readLastIndexedHead(store);
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
  const lastState: ReindexState = {
    lastHead,
    fileHashes: readFileHashes(store),
  };

  const plan = planReindex(lastState, facts);

  // ── Execute the plan ──────────────────────────────────────────────────
  switch (plan.mode) {
    case "noop":
      return { ok: true, mode: "noop", filesIngested: 0, head: lastHead };

    case "full": {
      const candidates = options.candidatePaths ?? [];
      if (candidates.length === 0) {
        store.writeMeta(META_KEY_LAST_HEAD, headResult.head ?? "");
        return {
          ok: true,
          mode: "full",
          filesIngested: 0,
          head: headResult.head,
        };
      }
      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        candidates,
      );
      if (!ingestResult.ok) return ingestResult;
      // Rule 25: persist head ONLY after data commits.
      store.writeMeta(META_KEY_LAST_HEAD, headResult.head ?? "");
      return {
        ok: true,
        mode: "full",
        filesIngested: ingestResult.count,
        head: headResult.head,
      };
    }

    case "incremental": {
      // Deduplicate (rule 49 — a file can appear staged AND in the commit
      // diff). Use a Set for dynamic runtime membership tracking.
      const seen = new Set<string>();
      for (const p of plan.changedPaths) seen.add(p);

      // Determine which paths still exist on disk vs are deleted.
      const knownFiles = readFileHashes(store);
      const toDelete: string[] = [];
      const toIngest: string[] = [];
      for (const p of seen) {
        let exists = true;
        try {
          await readFile(resolveRepoPath(repoRoot, p));
        } catch {
          exists = false;
        }
        if (exists) {
          toIngest.push(p);
        } else if (knownFiles.has(p)) {
          toDelete.push(p);
        }
      }

      if (toDelete.length > 0) {
        await store.dropFiles(toDelete);
      }
      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        toIngest,
      );
      if (!ingestResult.ok) return ingestResult;
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
      const candidates = options.candidatePaths ?? [
        ...lastState.fileHashes.keys(),
      ];
      const mismatched: string[] = [];
      for (const candidatePath of candidates) {
        let content: Uint8Array;
        try {
          content = await readFile(resolveRepoPath(repoRoot, candidatePath));
        } catch {
          // File no longer exists → it's a mismatch (prune it).
          if (lastState.fileHashes.has(candidatePath)) {
            mismatched.push(candidatePath);
          }
          continue;
        }
        const currentHash = hashContent(content);
        const storedHash = lastState.fileHashes.get(candidatePath);
        if (storedHash !== currentHash) {
          mismatched.push(candidatePath);
        }
      }

      // Prune deleted files, ingest the rest. A mismatched path is either:
      //   - still readable but content changed → re-ingest
      //   - no longer readable → prune from store (if it was known)
      const knownFiles = readFileHashes(store);
      const toDelete: string[] = [];
      const toIngest: string[] = [];
      for (const p of mismatched) {
        try {
          await readFile(resolveRepoPath(repoRoot, p));
          toIngest.push(p);
        } catch {
          if (knownFiles.has(p)) toDelete.push(p);
        }
      }

      if (toDelete.length > 0) {
        await store.dropFiles(toDelete);
      }

      const ingestResult = await ingestFiles(
        store,
        repoRoot,
        parseFile,
        readFile,
        toIngest,
      );
      if (!ingestResult.ok) return ingestResult;
      // Rule 25: persist head ONLY after data commits.
      store.writeMeta(META_KEY_LAST_HEAD, headResult.head ?? "");
      return {
        ok: true,
        mode: "hash_scan",
        filesIngested: ingestResult.count,
        head: headResult.head,
      };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Narrow result type for the ingest helper — avoids union overlap with
 * {@link ReindexResult}'s success branches so the caller can cleanly
 * discriminate on `ok` and read `.count` without ambiguity.
 */
type IngestResult =
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly code: "store_error"; readonly message: string };
/**
 * Parse + ingest a list of files. Returns the count ingested or a tagged
 * failure. Files that fail to parse do NOT update their stored content
 * hash (rule 44 — they must retry next run), so the caller advances head
 * anyway; the stale file will be caught on the next run via content-hash
 * mismatch.
 */
async function ingestFiles(
  store: GraphStore,
  repoRoot: string,
  parseFile: ParseFileFn,
  readFile: ReadFileFn,
  paths: readonly string[],
): Promise<IngestResult> {
  const batch: StoreFileIR[] = [];
  for (const relPath of paths) {
    let content: Uint8Array;
    try {
      content = await readFile(resolveRepoPath(repoRoot, relPath));
    } catch {
      // File unreadable (deleted between plan and execution). Skip.
      continue;
    }
    const parseResult = await parseFile({ path: relPath, content });
    if (!parseResult.ok) {
      // Rule 44: skip unparseable files, don't fail the batch.
      continue;
    }
    // FileIR is structurally assignable to StoreFileIR — the store only
    // reads the fields it needs and ignores extra FileIR fields (imports,
    // callSites). No cast needed.
    batch.push(parseResult.ir);
  }
  if (batch.length === 0) {
    return { ok: true, count: 0 };
  }
  const upsertResult = await store.upsertFileBatch(batch);
  if (!upsertResult.ok) {
    return {
      ok: false,
      code: "store_error",
      message: `upsertFileBatch failed: ${upsertResult.code}`,
    };
  }
  return { ok: true, count: batch.length };
}

