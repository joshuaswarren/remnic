/**
 * Consolidation undo (issue #561 PR 5).
 *
 * Reverts a consolidated memory by restoring each source memory from its
 * `derived_from` snapshot and archiving the target.
 *
 * Contract:
 *   - Load the target memory markdown file via its absolute path.
 *   - For every `"<rel>:<version>"` entry in `derived_from`, fetch the
 *     snapshot content via `page-versioning.getVersion` and restore it
 *     to the original relative path.  If the restore target file
 *     already exists, we skip overwriting it (the source was never
 *     archived, or was re-created since) and record the skip.
 *   - Archive the target with reason code `"consolidation-undo"` so the
 *     lifecycle ledger records the undo.
 *   - Dry-run mode produces the same plan without touching disk.
 *
 * The helper is kept pure over `StorageManager` so the CLI can reuse it
 * without additional wiring, and tests can exercise the plan logic
 * directly.
 */

import path from "node:path";
import { mkdir, writeFile, access, realpath, lstat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { StorageManager } from "./storage.js";
import type { VersioningConfig } from "./page-versioning.js";
import { bumpMemoryCorpusVersionForDir } from "./memory-corpus-version.js";
import { requestEntityCanonicalIdReconcile } from "./storage/entity-canonical-id-references.js";
import { getVersion } from "./page-versioning.js";

/**
 * Outcome of restoring a single `derived_from` source.
 */
export interface ConsolidationUndoRestore {
  /** The raw `"<relpath>:<version>"` entry from `derived_from`. */
  entry: string;
  /** Absolute path where the source would be / was restored. */
  sourcePath: string;
  /** What actually happened. */
  outcome:
    | "restored"
    | "skipped_file_exists"
    | "skipped_non_regular_file"
    | "skipped_snapshot_missing"
    | "skipped_malformed_entry"
    | "skipped_outside_memory_dir"
    | "skipped_non_active_path"
    | "skipped_self_referential"
    | "skipped_write_failed"
    | "skipped_blocked_by_other_failures"
    | "skipped_dry_run";
  /** Human-readable detail. */
  detail?: string;
}

/**
 * Plan + result of a `remnic consolidate undo` invocation.
 */
export interface ConsolidationUndoResult {
  /** Absolute path to the target memory. */
  targetPath: string;
  /** True when the target was archived successfully. */
  targetArchived: boolean;
  /** Per-source restore outcomes. */
  restores: ConsolidationUndoRestore[];
  /** Whether the run was a dry-run plan only. */
  dryRun: boolean;
  /** Fatal error, if any — the run bails early. */
  error?: string;
}

const DERIVED_FROM_ENTRY_RE = /^(.+):(\d+)$/;

function parseEntry(entry: unknown): { pagePath: string; versionId: string } | null {
  // Non-string entries (PR #637 round-3 review, cursor Low) can arrive
  // from hostile on-disk frontmatter — guard against a .match() crash.
  if (typeof entry !== "string") return null;
  const match = entry.match(DERIVED_FROM_ENTRY_RE);
  if (!match) return null;
  return { pagePath: match[1], versionId: match[2] };
}

/**
 * Verify that `candidate` resolves inside `root` (defense against
 * path-traversal in `derived_from` entries and user-facing target
 * paths).  Path-string normalization only; for symlink-aware checks
 * use `isInsideDirectoryRealpath`.  Both paths are resolved to
 * absolute form before comparison so `..` segments, symlinks-as-
 * strings, and relative prefixes are normalized.
 */
export function isInsideDirectory(candidate: string, root: string): boolean {
  const normRoot = path.resolve(root);
  const normCandidate = path.resolve(candidate);
  const rel = path.relative(normRoot, normCandidate);
  if (rel.length === 0) return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Symlink-aware containment check (PR #637 round-2 review, codex P1).
 *
 * `isInsideDirectory` only normalizes path strings — if a `derived_from`
 * entry resolves through a symlink inside `memoryDir` that points
 * outside, the string check passes but the subsequent `writeFile` would
 * land outside the memory tree.  Use this guard for any path that is
 * about to be written.
 *
 * Walks every parent directory between `candidate` and `root`,
 * `realpath`-ing each segment that exists and rejecting when any
 * segment escapes `root`.  Non-existent parents are resolved as the
 * canonicalized deepest-existing ancestor plus the trailing segments,
 * so a not-yet-created target file still gets the symlink check on its
 * existing parent directories.
 */
export async function isInsideDirectoryRealpath(
  candidate: string,
  root: string,
): Promise<boolean> {
  if (!isInsideDirectory(candidate, root)) return false;
  // Reject raw `..` segments before canonicalization so that symlinks
  // cannot be hidden behind intermediate dot-dot components (PR #637
  // round-14 review, codex P1).
  const rawSegments = candidate.replace(/\\/g, "/").split("/");
  if (rawSegments.some((s) => s === "..")) return false;
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(path.resolve(root));
  } catch {
    return false;
  }
  const normCandidate = path.resolve(candidate);

  // Reject dangling symlinks (PR #637 round-3 review, codex P1).
  // If the candidate itself is a symlink (even if its target doesn't
  // exist), Node will follow it when we later call `writeFile`.
  // `lstat` inspects the link itself without dereferencing; if it
  // succeeds and reports a symlink, we treat the candidate as
  // unsafe.  We must check every non-root ancestor too — a symlink
  // anywhere along the path lets an attacker redirect writes.
  const normRoot = path.resolve(root);
  const relFromRoot = path.relative(normRoot, normCandidate);
  const segments = relFromRoot.length > 0 ? relFromRoot.split(path.sep) : [];
  for (let i = 0; i <= segments.length; i++) {
    const probe = i === 0 ? normRoot : path.join(normRoot, ...segments.slice(0, i));
    try {
      const st = await lstat(probe);
      if (st.isSymbolicLink() && probe !== normRoot) {
        // A symlink on the path — resolve THIS segment and bail out
        // if the resolved target escapes `resolvedRoot`.
        let target: string;
        try {
          target = await realpath(probe);
        } catch {
          // Dangling symlink inside memoryDir — always unsafe.
          return false;
        }
        const rel = path.relative(resolvedRoot, target);
        if (rel.length === 0) continue;
        if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
      }
    } catch {
      // Segment doesn't exist yet — that's fine, fall through to the
      // textual containment verification below.
    }
  }

  // Walk up from the candidate until we hit a path that exists, then
  // realpath THAT and re-apply the trailing segments textually.
  const parts = normCandidate.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const probe = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const resolved = await realpath(probe);
      // Re-join any trailing segments that didn't exist yet.
      const trailing = parts.slice(i).join(path.sep);
      const final = trailing.length > 0 ? path.join(resolved, trailing) : resolved;
      // Now apply the textual containment check against the canonical
      // `resolvedRoot`.
      const rel = path.relative(resolvedRoot, final);
      if (rel.length === 0) return true;
      if (rel.startsWith("..")) return false;
      if (path.isAbsolute(rel)) return false;
      return true;
    } catch {
      continue;
    }
  }
  // Nothing along the path resolvable — treat as outside by default.
  return false;
}

/**
 * Directories under memoryDir that are NOT active memory locations.
 * A `derived_from` entry pointing into one of these should not be
 * counted as "recovered_existing" (PR #637 round-7 review, codex P2).
 * The versioning sidecar directory is included dynamically via the
 * `sidecarDir` parameter (PR #637 round-8 review, codex P2).
 */
const NON_ACTIVE_PREFIXES = ["archive/", "state/"];

/**
 * Normalize a relative path by collapsing `.` and `..` segments so
 * that crafted entries like `"facts/../archive/x.md"` are reduced to
 * `"archive/x.md"` before the non-active-prefix check.
 */
function normalizeRelativePath(p: string): string {
  // Normalize separators, split into segments, then resolve.
  const parts = p.replace(/\\/g, "/").split("/");
  const resolved: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (resolved.length > 0) resolved.pop();
      // If ".." pops past the root, we let the caller's containment
      // check catch it — don't silently drop.
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join("/");
}

/**
 * Check that a relative path (relative to memoryDir) points to an
 * active memory location rather than an internal/archive directory.
 * Returns `true` when the normalised `pagePath` does NOT start with
 * a known non-active prefix.
 *
 * @param pagePath   Relative path from `derived_from` entry.
 * @param sidecarDir Optional versioning sidecar directory name
 *                   (e.g. `".versions"`).  When provided, paths
 *                   under this directory are also rejected as
 *                   non-active.
 */
export function isActiveMemoryRelativePath(
  pagePath: string,
  sidecarDir?: string,
): boolean {
  const normalized = normalizeRelativePath(pagePath);
  const prefixes = [...NON_ACTIVE_PREFIXES];
  if (sidecarDir) {
    const normSidecar = normalizeRelativePath(sidecarDir);
    prefixes.push(normSidecar + "/");
  }
  for (const prefix of prefixes) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return false;
    }
  }
  return true;
}

async function isRegularFile(p: string): Promise<boolean> {
  try {
    const st = await lstat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Perform a consolidation-undo operation.
 *
 * @param options.storage        Storage manager for the memory directory.
 * @param options.memoryDir      Absolute memory directory root.
 * @param options.targetPath     Absolute path to the consolidated memory.
 * @param options.versioning     Page-versioning config (sidecarDir must
 *                               match the sidecar layout used when the
 *                               snapshots were created).
 * @param options.dryRun         When true, compute the plan but do not
 *                               write or archive.
 */
export async function runConsolidationUndo(options: {
  storage: StorageManager;
  memoryDir: string;
  targetPath: string;
  versioning: VersioningConfig;
  dryRun?: boolean;
}): Promise<ConsolidationUndoResult> {
  const { storage, memoryDir, targetPath, versioning } = options;
  const dryRun = options.dryRun === true;

  const result: ConsolidationUndoResult = {
    targetPath,
    targetArchived: false,
    restores: [],
    dryRun,
  };

  // Defense against path-traversal (PR #637 review, codex P1): refuse
  // to operate on a target outside the configured memory directory.
  // Archive moves and eventual unlink would otherwise let an operator
  // accidentally destroy an unrelated file with memory-like
  // frontmatter.  Uses the realpath-aware check so a symlinked
  // directory inside `memoryDir` can't tunnel a target past the guard.
  if (!(await isInsideDirectoryRealpath(targetPath, memoryDir))) {
    result.error = `target path ${targetPath} is outside memory directory ${memoryDir}`;
    return result;
  }

  // Reject targets in non-active directories (archive/, state/,
  // versioning sidecar).  A target inside `.versions/...` would be
  // a sidecar snapshot, not a real consolidated memory; archiving
  // it would silently delete version history (PR #637 round-8
  // review, codex P2).
  const targetRel = path.relative(memoryDir, targetPath);
  if (!isActiveMemoryRelativePath(targetRel, versioning.sidecarDir)) {
    result.error = `target path "${targetRel}" is inside a non-active directory — refusing to operate`;
    return result;
  }

  // Load the target memory.  readMemoryByPath returns null when the file
  // is absent or unparseable — surface that as a fatal error because the
  // caller cannot continue without a derived_from list.
  const target = await storage.readMemoryByPath(targetPath);
  if (!target) {
    result.error = `could not load target memory at ${targetPath}`;
    return result;
  }

  const derivedFrom = target.frontmatter.derived_from;
  if (!Array.isArray(derivedFrom) || derivedFrom.length === 0) {
    result.error = "target memory has no derived_from entries — nothing to undo";
    return result;
  }

  // Two-pass plan + execute (PR #637 round-4 review, cursor Medium):
  // the undo is "all-or-nothing" both for the archive decision AND
  // for the per-source writes.  First pass validates + loads every
  // snapshot into memory; second pass writes only if every source
  // would succeed.  This prevents the previous eager-write behaviour
  // where a later-failing source would leave earlier sources already
  // written to disk alongside an unarchived consolidated target.
  type RestorePlan =
    | { kind: "skip"; restore: ConsolidationUndoRestore }
    | { kind: "write"; entry: string; sourcePath: string; content: string }
    | { kind: "recovered_existing"; entry: string; sourcePath: string };

  const plans: RestorePlan[] = [];
  for (const rawEntry of derivedFrom) {
    const entry = typeof rawEntry === "string" ? rawEntry : String(rawEntry);
    const parsed = parseEntry(rawEntry);
    if (!parsed) {
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath: "",
          outcome: "skipped_malformed_entry",
          detail: `expected "<path>:<version>" shape`,
        },
      });
      continue;
    }

    // Reject absolute paths in derived_from entries (PR #637 round-10
    // review, codex P1).  An absolute pagePath would cause path.join to
    // ignore memoryDir, bypassing the active-directory guard downstream.
    if (path.isAbsolute(parsed.pagePath)) {
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath: parsed.pagePath,
          outcome: "skipped_malformed_entry",
          detail: `derived_from path must be relative, got absolute: "${parsed.pagePath}"`,
        },
      });
      continue;
    }

    const sourcePath = path.join(memoryDir, parsed.pagePath);

    if (!(await isInsideDirectoryRealpath(sourcePath, memoryDir))) {
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath,
          outcome: "skipped_outside_memory_dir",
          detail: `resolved path escapes memory directory ${memoryDir}`,
        },
      });
      continue;
    }

    // Reject source paths inside non-active directories (archive/,
    // state/, versioning sidecar).  A crafted or corrupted derived_from
    // entry like "archive/2024-01-01/x.md:1" would otherwise be counted
    // as "recovered_existing" even though no active memory was restored.
    // Also resolve symlinks before checking — a derived_from entry like
    // "facts/link/stale.md:1" where `facts/link` points to `archive/…`
    // must be caught (PR #637 round-8 review, cursor+codex).
    let resolvedRelative = parsed.pagePath;
    try {
      const realBase = await realpath(memoryDir);
      try {
        const realSource = await realpath(sourcePath);
        const rel = path.relative(realBase, realSource);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
          resolvedRelative = rel.replace(/\\/g, "/");
        }
      } catch {
        // realpath on the leaf failed (file doesn't exist yet).  Try
        // resolving the parent directory instead — if the parent is a
        // symlink into archive/state, the leaf would be written there
        // too (PR #637 round-12 review, codex P1).
        const parentDir = path.dirname(sourcePath);
        try {
          const realParent = await realpath(parentDir);
          const parentRel = path.relative(realBase, realParent);
          if (!parentRel.startsWith("..") && !path.isAbsolute(parentRel)) {
            const leafName = path.basename(sourcePath);
            resolvedRelative = path.join(parentRel, leafName).replace(/\\/g, "/");
          }
        } catch {
          // Parent also doesn't exist — fall through to text path check
        }
      }
    } catch {
      // memoryDir realpath failed — use the text path
    }
    if (!isActiveMemoryRelativePath(parsed.pagePath, versioning.sidecarDir) ||
        !isActiveMemoryRelativePath(resolvedRelative, versioning.sidecarDir)) {
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath,
          outcome: "skipped_non_active_path",
          detail: `source path "${parsed.pagePath}" is inside a non-active directory (archive/state/versions)`,
        },
      });
      continue;
    }

    // Reject self-referential derived_from entries (PR #637 round-9 review,
    // codex P1).  If the source resolves to the same file as the target,
    // counting it as "recovered" would let undo archive the target without
    // restoring any independent source — leaving no active copy.  This
    // guards against corrupted or manually-edited derived_from lists.
    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath,
          outcome: "skipped_self_referential",
          detail: `derived_from entry "${entry}" resolves to the same file as the target — refusing to count as recovered`,
        },
      });
      continue;
    }

    if (await isRegularFile(sourcePath)) {
      // Source is still active (regular file present) — nothing to
      // restore but this counts as "recovered" for the archive
      // decision.  We require a regular file specifically (PR #637
      // round-5 review, codex P2): a directory, device node, or
      // symlink at the source path should not count as "recovered"
      // because a later read won't find the expected memory content.
      plans.push({ kind: "recovered_existing", entry, sourcePath });
      continue;
    }
    if (await fileExists(sourcePath)) {
      // Something other than a regular file is at the source path
      // (directory, device node, symlink).  Refuse to overwrite AND
      // refuse to count as recovered (PR #637 round-5 review, codex
      // P2) — the operator needs to clean up manually.  This is a
      // blocking skip: no source writes happen, target stays active.
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath,
          outcome: "skipped_non_regular_file",
          detail: "source path is occupied by a non-regular-file; refusing to proceed",
        },
      });
      continue;
    }

    let snapshotContent: string;
    try {
      snapshotContent = await getVersion(
        sourcePath,
        parsed.versionId,
        versioning,
        memoryDir,
      );
    } catch {
      plans.push({
        kind: "skip",
        restore: {
          entry,
          sourcePath,
          outcome: "skipped_snapshot_missing",
          detail: `no snapshot for version ${parsed.versionId}`,
        },
      });
      continue;
    }

    plans.push({ kind: "write", entry, sourcePath, content: snapshotContent });
  }

  // If any plan is a skip (anything other than "write" or
  // "recovered_existing"), the undo is over before it starts — no
  // writes happen.  Reveal every per-source skip reason in the
  // result so operators can diagnose what went wrong.
  const skipped = plans.filter((p) => p.kind === "skip");
  if (skipped.length > 0) {
    for (const p of plans) {
      if (p.kind === "skip") {
        result.restores.push(p.restore);
      } else if (p.kind === "write") {
        // Announced-but-not-executed write — still record it so the
        // operator sees what would have been restored if the failed
        // sources had been recoverable.
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: dryRun ? "skipped_dry_run" : "skipped_blocked_by_other_failures",
          detail: dryRun
            ? "would restore from snapshot (blocked by other failures)"
            : "snapshot available but undo aborted due to other failures",
        });
      } else {
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: "skipped_file_exists",
          detail: "source file already exists; no restore needed",
        });
      }
    }
    const recovered = result.restores.filter(
      (r) => r.outcome === "restored" || r.outcome === "skipped_file_exists",
    ).length;
    if (recovered === 0) {
      result.error =
        "no sources could be recovered (all snapshots missing or paths unsafe); target not archived to preserve data";
    } else {
      result.error = `${skipped.length} of ${plans.length} sources could not be recovered; target not archived (undo is all-or-nothing)`;
    }
    return result;
  }

  // Deduplicate plans by sourcePath: duplicate derived_from entries for
  // the same source would cause the second wx-flagged write to fail with
  // EEXIST after the first succeeds.  The first plan for each source wins;
  // subsequent duplicates are recorded as skipped.  Applied before dry-run
  // so the preview accurately reflects what execution would do.
  const seenSourcePaths = new Set<string>();
  const dedupedPlans: RestorePlan[] = [];
  for (const p of plans) {
    if (p.kind === "write" || p.kind === "recovered_existing") {
      if (seenSourcePaths.has(p.sourcePath)) {
        dedupedPlans.push({
          kind: "skip",
          restore: {
            entry: p.kind === "write" ? p.entry : p.entry,
            sourcePath: p.sourcePath,
            outcome: "skipped_file_exists",
            detail: "duplicate derived_from entry — source already processed",
          },
        });
        continue;
      }
      seenSourcePaths.add(p.sourcePath);
    }
    dedupedPlans.push(p);
  }

  // Dry-run: report what each plan would do.
  if (dryRun) {
    for (const p of dedupedPlans) {
      if (p.kind === "write") {
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: "skipped_dry_run",
          detail: "would restore from snapshot",
        });
      } else if (p.kind === "recovered_existing") {
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: "skipped_file_exists",
          detail: "source file already exists; no restore needed",
        });
      } else if (p.kind === "skip" && p.restore) {
        result.restores.push(p.restore);
      }
    }
    return result;
  }

  // All validations passed — execute writes.  A write failure here
  // is a filesystem problem rather than a provenance problem, but
  // any failure still aborts the archive.

  let writeFailed = false;
  for (const p of dedupedPlans) {
    if (p.kind === "skip") {
      // Dedup-generated skip entries and other pre-write skips.
      if (p.restore) result.restores.push(p.restore);
      continue;
    }
    if (p.kind === "recovered_existing") {
      result.restores.push({
        entry: p.entry,
        sourcePath: p.sourcePath,
        outcome: "skipped_file_exists",
        detail: "source file already exists; no restore needed",
      });
      continue;
    }
    if (p.kind === "write") {
      if (writeFailed) {
        // All-or-nothing: once a write fails, skip all remaining writes
        // so the target is not archived with partial source coverage.
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: "skipped_blocked_by_other_failures",
          detail: "a prior source write failed; skipping remaining writes to honor all-or-nothing contract",
        });
        continue;
      }
      try {
        await mkdir(path.dirname(p.sourcePath), { recursive: true });
        // Use exclusive create (wx / O_EXCL) so that if another process
        // recreates the source file between planning and execution, this
        // write fails with EEXIST instead of silently overwriting the new
        // file (PR #637 round-11 review, codex P1).
        await writeFile(p.sourcePath, p.content, { encoding: "utf-8", flag: "wx" });
        // Restore writes an active memory file back out-of-band (direct wx write,
        // not a StorageManager mutation). Bump the corpus sentinel per successful
        // restore so a warm hot-memories cache rescans — a later restore failure
        // returns before archiveMemory() runs, so without this the already-written
        // restores would stay invisible to recall until an unrelated mutation or
        // restart (esp. with hotMemoriesCacheTtlMs: 0). Issue #1902, Codex Medium.
        bumpMemoryCorpusVersionForDir(memoryDir);
        // Restored bytes predate the current migration journal and can carry
        // legacy entity references (issue #2213) — request one reconcile pass.
        await requestEntityCanonicalIdReconcile(path.join(memoryDir, "state"));
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: "restored",
        });
      } catch (err) {
        writeFailed = true;
        result.restores.push({
          entry: p.entry,
          sourcePath: p.sourcePath,
          outcome: "skipped_write_failed",
          detail: `write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  if (writeFailed) {
    result.error =
      "one or more source writes failed mid-restore; target not archived to preserve data";
    return result;
  }

  // Archive the target memory.  archiveMemory returns null on
  // failure — surface that as a fatal error (PR #637 round-5 review,
  // codex P2) so automation doesn't mistake a half-undo for a clean
  // run.  The already-completed restores still roll forward; the
  // result.restores list records what was written.
  const archivedAt = await storage.archiveMemory(target, {
    actor: "consolidate-undo",
    reasonCode: "consolidation-undo",
  });
  result.targetArchived = archivedAt !== null;
  if (!result.targetArchived) {
    result.error =
      "sources restored successfully but archiving the consolidated target failed; inspect storage for manual cleanup";
  }
  return result;
}

/**
 * Render a consolidation-undo result as a human-readable multi-line
 * string for the CLI.  Extracted so tests can snapshot the formatting
 * without parsing stdout.
 */
export function formatConsolidationUndoResult(result: ConsolidationUndoResult): string {
  const lines: string[] = [];
  lines.push(`consolidate undo ${result.dryRun ? "(dry run) " : ""}→ ${result.targetPath}`);
  // Emit per-restore details BEFORE the error (PR #637 review, cursor
  // Medium): the "no sources could be recovered" error is set after
  // the restore loop ran, so operators need the per-source skip
  // reasons to diagnose which snapshots were missing / outside
  // memoryDir / malformed.  Early-bail errors (unloadable target,
  // target outside memoryDir, no derived_from) run before the loop,
  // so `result.restores` is empty in those cases and this block is a
  // no-op.
  for (const r of result.restores) {
    lines.push(`  - ${r.entry} → ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`);
  }
  if (result.error) {
    lines.push(`  ERROR: ${result.error}`);
    return lines.join("\n");
  }
  lines.push(
    result.dryRun
      ? "  (dry run — no files were modified, target not archived)"
      : `  target archived: ${result.targetArchived ? "yes" : "no"}`,
  );
  return lines.join("\n");
}
