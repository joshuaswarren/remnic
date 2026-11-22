/**
 * Identity-anchor → peer-registry migration — issue #679 PR 5/5.
 *
 * Reads the legacy `identity/identity-anchor.md` file (written by
 * `StorageManager.writeIdentityAnchor`) and the `IDENTITY.md`
 * reflections file, then seeds the peer registry with a `self` peer
 * whose `peers/self/identity.md` kernel captures the relevant
 * source material.
 *
 * Design principles:
 *
 * 1. **Idempotent** — if `peers/self/identity.md` already exists this
 *    function returns `{ skipped: true }` without overwriting it. The
 *    second-run guarantee prevents accidental double-migration and
 *    makes `remnic peer migrate` safe to run in CI / post-install hooks.
 *
 * 2. **Non-destructive** — the legacy files are never deleted. The
 *    operator is responsible for archive / clean-up after verifying the
 *    migration result. Legacy `engram.identity_anchor_*` MCP tools
 *    continue to work against the on-disk anchor file.
 *
 * 3. **Dry-run** — when `options.dryRun` is `true` the function
 *    computes the proposed `Peer` record and returns it alongside a
 *    `{ dryRun: true }` marker, without writing anything to disk.
 *
 * 4. **Transparent** — the return value always includes the full
 *    proposed `Peer` so callers can print what was (or would be) written.
 *
 * ## Source data
 *
 * The migrator reads two optional legacy sources:
 *
 * - `{memoryDir}/identity/identity-anchor.md` — structured sections
 *   (`## Identity Traits`, `## Communication Preferences`, etc.) written
 *   by `identityAnchorUpdate`. When present, the full content is
 *   embedded in `peer.notes` under a clearly labelled subsection.
 *
 * - `{memoryDir}/IDENTITY.md` — free-form reflection entries appended
 *   by the extraction engine. When present it is summarised as
 *   a second subsection of `peer.notes`.
 *
 * If neither file exists the `self` peer is still created with sensible
 * defaults so that the peer registry is bootstrapped for fresh installs.
 *
 * ## Path safety
 *
 * All file reads use `path.join` relative to the caller-supplied
 * `memoryDir`. The migration never follows symlinks for the source files
 * (uses `lstat` to detect + skip them). Writes go through the standard
 * peer storage helpers which enforce path-traversal and symlink guards.
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";

import { readPeer, writePeerIfAbsent } from "./storage.js";
import type { Peer } from "./types.js";


export interface MigrateFromIdentityAnchorOptions {
  /**
   * Memory directory (same value as `config.memoryDir`). All source and
   * destination paths are resolved relative to this root.
   */
  memoryDir: string;

  /**
   * When `true`, compute and return the proposed peer record without
   * writing anything to disk. The `written` and `skipped` flags in the
   * result will both be `false`; the `peer` field carries the proposed
   * record.
   */
  dryRun?: boolean;

  /**
   * Optional override for the `self` peer's display name. Defaults to
   * `"Self"`.
   */
  displayName?: string;

  /**
   * Optional ISO-8601 timestamp to use as `createdAt`. When omitted the
   * current time is used.
   */
  createdAt?: string;
}

export interface MigrateFromIdentityAnchorResult {
  /**
   * The peer record that was (or would be) written for `peers/self/`.
   * Always present regardless of `skipped` or `dryRun`.
   */
  peer: Peer;

  /**
   * `true` when the migration wrote `peers/self/identity.md` to disk.
   * `false` when `dryRun` is set or the file already existed (`skipped`).
   */
  written: boolean;

  /**
   * `true` when an existing `peers/self/identity.md` was detected and
   * the migration was a no-op. When `skipped` is `true`, `written` is
   * always `false`.
   */
  skipped: boolean;

  /**
   * `true` when `options.dryRun` was set. No files were written; the
   * `peer` field holds the proposed record.
   */
  dryRun: boolean;

  /**
   * The identity-anchor source file path that was read (if found).
   * `null` when the file did not exist or was a symlink (skipped).
   */
  identityAnchorSource: string | null;

  /**
   * The `IDENTITY.md` source file path that was read (if found).
   * `null` when the file did not exist or was a symlink (skipped).
   */
  identityMdSource: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read a legacy source file with the same security posture as the peer storage
 * module:
 *
 * 1. **Parent-directory symlink rejection** — lstat the parent directory and
 *    return null if it is a symlink. This closes the case where e.g.
 *    `memoryDir/identity/` is itself a symlink pointing outside `memoryDir`.
 *
 * 2. **Kernel-level O_NOFOLLOW** — open the file with `O_NOFOLLOW` so the
 *    kernel atomically rejects a symlink at the final path component. This
 *    eliminates the TOCTOU race between a separate lstat check and the
 *    subsequent read that `safeReadLegacyFile` previously had.
 *
 * Returns `{ content, filePath }` on success, or `{ content: null, filePath: null }`
 * when the file is missing, is a symlink, the parent is a symlink, or the
 * path is not a regular file. Re-throws unexpected I/O errors (EACCES, EIO,
 * etc.) so the caller can surface real filesystem problems.
 */
async function safeReadLegacyFile(
  filePath: string,
): Promise<{ content: string; filePath: string } | { content: null; filePath: null }> {
  const parent = path.dirname(filePath);
  try {
    const parentStat = await fs.lstat(parent);
    if (parentStat.isSymbolicLink()) {
      return { content: null, filePath: null };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: null, filePath: null };
    }
    throw err;
  }

  let fh: import("node:fs/promises").FileHandle;
  try {
    fh = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT — file does not exist; ELOOP — O_NOFOLLOW detected a symlink.
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") {
      return { content: null, filePath: null };
    }
    throw err;
  }

  try {
    const stat = await fh.stat();
    if (!stat.isFile()) {
      return { content: null, filePath: null };
    }
    const content = await fh.readFile("utf8");
    return { content, filePath };
  } finally {
    await fh.close();
  }
}

function buildSelfNotes(
  anchorContent: string | null,
  identityMdContent: string | null,
): string | undefined {
  const parts: string[] = [];

  if (anchorContent !== null && anchorContent.trim().length > 0) {
    parts.push(
      "## Migrated from identity-anchor.md\n\n" + anchorContent.trim(),
    );
  }

  if (identityMdContent !== null && identityMdContent.trim().length > 0) {
    parts.push(
      "## Migrated from IDENTITY.md\n\n" + identityMdContent.trim(),
    );
  }

  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Migrate legacy identity-anchor data into `peers/self/identity.md`.
 *
 * @see {@link MigrateFromIdentityAnchorOptions} for full option documentation.
 * @see {@link MigrateFromIdentityAnchorResult} for return value semantics.
 */
export async function migrateFromIdentityAnchor(
  options: MigrateFromIdentityAnchorOptions,
): Promise<MigrateFromIdentityAnchorResult> {
  const { memoryDir, dryRun = false } = options;
  const now = new Date().toISOString();
  const createdAt = options.createdAt ?? now;
  const displayName = options.displayName ?? "Self";

  const existing = await readPeer(memoryDir, "self");
  if (existing !== null) {
    return {
      peer: existing,
      written: false,
      skipped: true,
      dryRun,
      identityAnchorSource: null,
      identityMdSource: null,
    };
  }

  const anchorPath = path.join(memoryDir, "identity", "identity-anchor.md");
  const identityMdPath = path.join(memoryDir, "IDENTITY.md");

  const [anchorResult, identityMdResult] = await Promise.all([
    safeReadLegacyFile(anchorPath),
    safeReadLegacyFile(identityMdPath),
  ]);

  const notes = buildSelfNotes(
    anchorResult.content,
    identityMdResult.content,
  );

  const peer: Peer = {
    id: "self",
    kind: "self",
    displayName,
    createdAt,
    updatedAt: now,
    ...(notes !== undefined ? { notes } : {}),
  };

  if (!dryRun) {
    const created = await writePeerIfAbsent(memoryDir, peer);
    if (!created) {
      const raceWinner = await readPeer(memoryDir, "self");
      return {
        peer: raceWinner ?? peer,
        written: false,
        skipped: true,
        dryRun,
        identityAnchorSource: null,
        identityMdSource: null,
      };
    }
  }

  return {
    peer,
    written: !dryRun,
    skipped: false,
    dryRun,
    identityAnchorSource: anchorResult.filePath,
    identityMdSource: identityMdResult.filePath,
  };
}
