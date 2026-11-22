/**
 * Capsule fork semantics — issue #676 PR 4/6.
 *
 * A fork takes an existing capsule archive, imports it into a target memory
 * root under the `fork` conflict-resolution mode (which rebases all records
 * under `forks/<capsule-id>/`), and then writes a lineage breadcrumb at
 * `<targetRoot>/forks/<forkId>/lineage.json` recording the parent capsule's
 * identity.  Subsequent forks of the same parent or of a fork produce a
 * queryable chain.
 *
 * The lineage breadcrumb is a pure JSON file — no gzip, no bundle format —
 * so downstream tooling can read it with a single `readFile` + `JSON.parse`
 * without pulling in the transfer pipeline.
 */

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { importCapsule, type ImportCapsuleResult } from "./capsule-import.js";
import { assertIsDirectoryNotSymlink, assertRealpathInsideRoot } from "./fs-utils.js";
import type { CapsuleParent, ExportManifestV2 } from "./types.js";
import { CAPSULE_ID_PATTERN } from "./types.js";

// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link forkCapsule}.
 *
 * `sourceArchive` — absolute or cwd-relative path to a `.capsule.json.gz`
 * archive produced by `exportCapsule`.
 *
 * `targetRoot` — absolute or cwd-relative path to the memory directory that
 * will receive the forked records. Must be an existing directory.
 *
 * `forkId` — user-chosen id for the fork.  Validated against
 * {@link CAPSULE_ID_PATTERN}; must be unique under `<targetRoot>/forks/` (a
 * pre-existing `forks/<forkId>/` directory is rejected before any write).
 *
 * `versioning` — optional page-versioning config forwarded to
 * {@link importCapsule}. Only relevant when the target root already has files
 * that would be overwritten (fork mode is skip-on-exist by design, so this is
 * a no-op unless mode is changed in a future subclass).
 *
 * `now` — optional clock override (ms epoch) forwarded to `importCapsule` for
 * deterministic fork-id rewriting in tests.
 */
export interface ForkCapsuleOptions {
  sourceArchive: string;
  targetRoot: string;
  forkId: string;
  now?: number;
}

/**
 * The lineage breadcrumb written to `forks/<forkId>/lineage.json`.
 *
 * Fields are intentionally flat so the file is human-readable at a glance
 * and trivially diffable by `git diff`.
 *
 * `forkId`          — the id supplied to `forkCapsule`.
 * `forkedAt`        — ISO-8601 creation timestamp (UTC).
 * `parent`          — structured linkage to the source capsule.
 * `importedRecords` — number of records written by the fork import.
 * `skippedRecords`  — number of records skipped (target already existed).
 */
export interface ForkLineage {
  forkId: string;
  forkedAt: string;
  parent: CapsuleParent;
  importedRecords: number;
  skippedRecords: number;
}

export interface ForkCapsuleResult {
  /** Absolute path to the source archive (unchanged, for chaining). */
  archivePath: string;
  /** The V2 manifest decoded from the source archive. */
  manifest: ExportManifestV2;
  /** Result of the underlying `importCapsule` call. */
  importResult: ImportCapsuleResult;
  /** The lineage breadcrumb that was written. */
  lineage: ForkLineage;
  /** Absolute path to the lineage breadcrumb file. */
  lineagePath: string;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Fork a capsule archive into a target memory root.
 *
 * Sequence:
 *   1. Validate `forkId` against {@link CAPSULE_ID_PATTERN}.
 *   2. Resolve `targetRoot` and verify it is an existing directory (not a
 *      symlink — mirrors {@link importCapsule}'s root validation).
 *   3. Reject if `forks/<forkId>/` already exists in the target root
 *      (gotcha #49: deduplicate batch inputs; gotcha #25: don't destroy
 *      old state).
 *   4. Import the archive in `"fork"` mode via {@link importCapsule}.
 *   5. Write the lineage breadcrumb at `forks/<forkId>/lineage.json`.
 *      The breadcrumb dir is created by step 4 (importCapsule writes records
 *      under `forks/<sourceId>/`); if `forkId !== sourceId` we may need to
 *      create the fork dir ourselves. We always `mkdir -p` defensively.
 *
 * Error semantics:
 *   - All validation errors throw before any filesystem write (fail-closed,
 *     gotcha #25).
 *   - If `importCapsule` throws after writing some records, the lineage
 *     breadcrumb is NOT written (partial state is better than a false
 *     "fork complete" marker — gotcha #12: write rollback data before
 *     success markers).
 */
export async function forkCapsule(opts: ForkCapsuleOptions): Promise<ForkCapsuleResult> {
  validateForkId(opts.forkId);

  const rootAbs = path.resolve(opts.targetRoot);
  await assertIsDirectoryNotSymlink(rootAbs, "forkCapsule", "targetRoot");

  const forkDirAbs = path.join(rootAbs, "forks", opts.forkId);
  const forkEntryExists = await pathEntryExists(forkDirAbs);
  if (forkEntryExists) {
    throw new Error(
      `forkCapsule: fork path already exists — forkId "${opts.forkId}" is already in use at: ${forkDirAbs}`,
    );
  }

  const archiveAbs = path.resolve(opts.sourceArchive);
  const importResult = await importCapsule({
    archivePath: archiveAbs,
    root: rootAbs,
    mode: "fork",
    now: opts.now,
  });

  const manifest = importResult.manifest;
  const sourceCapsule = manifest.capsule;

  const forkedAt = new Date(opts.now ?? Date.now()).toISOString();

  const parent: CapsuleParent = {
    capsuleId: sourceCapsule.id,
    version: sourceCapsule.version,
    forkRoot: `forks/${sourceCapsule.id}`,
  };

  const lineage: ForkLineage = {
    forkId: opts.forkId,
    forkedAt,
    parent,
    importedRecords: importResult.imported.length,
    skippedRecords: importResult.skipped.length,
  };

  const lineagePath = path.join(forkDirAbs, "lineage.json");

  //
  const rootReal = await realpath(rootAbs);
  await assertRealpathInsideRoot(rootReal, lineagePath, `forks/${opts.forkId}/lineage.json`, "forkCapsule");

  await mkdir(path.dirname(lineagePath), { recursive: true });

  await writeFile(lineagePath, JSON.stringify(lineage, null, 2) + "\n", "utf-8");

  return {
    archivePath: archiveAbs,
    manifest,
    importResult,
    lineage,
    lineagePath,
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/**
 * Read the lineage breadcrumb for a given fork in a memory root.
 *
 * Returns `null` when no breadcrumb exists (the directory is not a fork, or
 * was created before PR 4/6). Never throws for a missing file — callers
 * that need to distinguish "not a fork" from "corrupt breadcrumb" should
 * handle the JSON parse error themselves.
 *
 * `forkId` is validated against {@link CAPSULE_ID_PATTERN} before being
 * joined into the breadcrumb path so a malicious value like
 * `../../../../tmp` cannot escape the `forks/` namespace and resolve to
 * unrelated files outside the configured memory root (Codex P2 #751).
 * Invalid ids return `null` (same shape as "no breadcrumb"); callers that
 * need to distinguish "invalid id" from "absent breadcrumb" should validate
 * upstream.
 */
export async function readForkLineage(
  targetRoot: string,
  forkId: string,
): Promise<ForkLineage | null> {
  if (
    typeof forkId !== "string" ||
    forkId.length === 0 ||
    forkId.length > 64 ||
    !CAPSULE_ID_PATTERN.test(forkId)
  ) {
    return null;
  }
  const rootAbs = path.resolve(targetRoot);
  const rootReal = await realpath(rootAbs).catch(() => rootAbs);

  const lineagePath = path.join(rootReal, "forks", forkId, "lineage.json");
  const rel = path.relative(rootReal, lineagePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }

  if (!(await isLineagePathContained(rootReal, lineagePath))) {
    return null;
  }
  const raw = await readFile(lineagePath, "utf-8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || typeof parsed.forkId !== "string") {
      return null;
    }
    return parsed as ForkLineage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function validateForkId(forkId: unknown): void {
  if (typeof forkId !== "string") {
    throw new Error("forkCapsule: forkId must be a string");
  }
  if (forkId.length === 0) {
    throw new Error("forkCapsule: forkId must not be empty");
  }
  if (forkId.length > 64) {
    throw new Error("forkCapsule: forkId must be 64 characters or fewer");
  }
  if (!CAPSULE_ID_PATTERN.test(forkId)) {
    throw new Error(
      `forkCapsule: invalid forkId "${forkId}". Expected alphanumeric with single dashes (no leading/trailing dashes, no consecutive dashes).`,
    );
  }
}

/**
 * Return true when ANY filesystem entry exists at {@link absPath} —
 * directory, regular file, symlink (even broken), or other special file.
 * Uses `lstat` so a symlink at the path is detected regardless of whether
 * its target resolves. Used by the duplicate-forkId check so a stray file
 * cannot bypass the "reject before any write" guarantee (Codex P2 #751).
 */
async function pathEntryExists(absPath: string): Promise<boolean> {
  const st = await lstat(absPath).catch(() => null);
  return st !== null;
}

/**
 * Symlink-safe containment check for {@link readForkLineage}.
 *
 * Walks from {@link lineagePath} toward {@link rootReal} until it finds a
 * path component that exists on disk, resolves that prefix via `realpath`
 * (which follows symlinks), then re-appends the non-existent suffix and
 * verifies the resulting canonical path is still inside {@link rootReal}.
 *
 * This catches the case where any subdirectory in the path is a symlink
 * pointing outside the intended root. Returns `true` when the path is
 * safely contained, `false` otherwise.
 *
 * Mirrors the `assertRealpathInsideRoot` helper in `capsule-import.ts`.
 * Returning a boolean (rather than throwing) keeps the contract aligned
 * with `readForkLineage`'s "return null on any safety failure" pattern.
 */
async function isLineagePathContained(
  rootReal: string,
  lineagePath: string,
): Promise<boolean> {
  let existing = lineagePath;
  const suffix: string[] = [];
  while (existing !== path.dirname(existing)) {
    const st = await lstat(existing).catch(() => null);
    if (st !== null) break;
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }

  const existingReal = await realpath(existing).catch(() => existing);
  const targetReal = suffix.length > 0 ? path.join(existingReal, ...suffix) : existingReal;

  const rel = path.relative(rootReal, targetReal);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${path.sep}`)) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}
