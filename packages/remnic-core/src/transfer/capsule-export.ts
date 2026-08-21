import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CAPSULE_SCHEMA_VERSION, EXPORT_FORMAT } from "./constants.js";
import {
  listFilesRecursive,
  sha256File,
  toPosixRelPath,
  writeJsonFile,
} from "./fs-utils.js";
import {
  CAPSULE_ID_PATTERN,
  CapsuleBlockSchema,
  ExportBundleV2Schema,
  ExportManifestV2Schema,
  type CapsuleBlock,
  type ExportBundleV2,
  type ExportManifestV2,
  type ExportMemoryRecordV1,
} from "./types.js";
import { encryptCapsuleFile } from "./capsule-crypto.js";
import { computeTransferOutputRel, DEFAULT_TRANSFER_EXCLUDE_DIRS } from "./exclusions.js";

/**
 * Default subdirectory excludes applied to every capsule export. These match
 * the shared plaintext transfer exclusions plus the `transcripts`
 * directory, which is excluded by default and only included when the caller
 * explicitly passes `transcripts` in {@link ExportCapsuleOptions.includeKinds}.
 */
const DEFAULT_EXCLUDE_DIRS = DEFAULT_TRANSFER_EXCLUDE_DIRS;

const TRANSCRIPTS_DIR = "transcripts" as const;

/**
 * Top-level directory under {@link ExportCapsuleOptions.root} that holds
 * per-peer profile bundles. When {@link ExportCapsuleOptions.peerIds} is
 * provided, only files under `peers/<peerId>/...` for the listed ids are
 * included; the rest of the `peers/` tree is excluded.
 */
const PEERS_DIR = "peers" as const;

/**
 * Options accepted by {@link exportCapsule}.
 *
 * `name` — capsule id, validated against {@link CAPSULE_ID_PATTERN}. The id
 * also forms the manifest's `capsule.id` and the archive filename.
 *
 * `root` — absolute or cwd-relative path to the memory directory to export.
 *
 * `since` — optional ISO-8601 timestamp; only files with `mtime >= since`
 * are included.
 *
 * `includeKinds` — optional allow-list of top-level subdirectory names
 * (e.g. `facts`, `entities`, `corrections`, `transcripts`). When set, files
 * directly under {@link root} are excluded and only files whose first path
 * segment is in the allow-list are kept. Pass `transcripts` here explicitly
 * to opt-in transcripts (they are excluded by default).
 *
 * `peerIds` — optional allow-list restricting the `peers/` tree to files
 * under `peers/<peerId>/...`. When omitted the entire `peers/` tree is
 * included (subject to {@link includeKinds}). When set to an empty array
 * the `peers/` tree is excluded entirely.
 *
 * `outDir` — optional output directory. Defaults to `<root>/.capsules`.
 *
 * `pluginVersion` — recorded in the manifest. Defaults to `"0.0.0"` so
 * tests do not need to thread a version through; production callers SHOULD
 * pass the running plugin version.
 *
 * `capsule` — optional overrides for the manifest's `capsule` block. The
 * caller may pass any subset; remaining fields are filled with conservative
 * defaults documented inline below.
 *
 * `now` — optional clock override (ms epoch) used for `manifest.createdAt`.
 * Tests pass a fixed value for deterministic output.
 *
 * `encrypt` — when `true`, encrypt the output archive using the secure-store
 * master key for `memoryDir`. The keyring must be unlocked before calling
 * (`remnic secure-store unlock`). The plaintext `.capsule.json.gz` is written
 * first, then encrypted to `<name>.capsule.json.gz.enc`; the plaintext is
 * removed after successful encryption. Requires `memoryDir` to be provided.
 *
 * `memoryDir` — required when `encrypt` is `true`. The memory directory whose
 * secure-store keyring holds the master key.
 */
export interface ExportCapsuleOptions {
  name: string;
  root: string;
  since?: string;
  includeKinds?: readonly string[];
  peerIds?: readonly string[];
  outDir?: string;
  pluginVersion?: string;
  capsule?: Partial<Omit<CapsuleBlock, "id">>;
  now?: number;
  /**
   * When `true`, encrypt the output archive. Requires the secure-store to be
   * unlocked and `memoryDir` to be set. The plaintext `.capsule.json.gz` is
   * replaced by `<name>.capsule.json.gz.enc` on success.
   */
  encrypt?: boolean;
  /**
   * Memory directory whose secure-store keyring holds the master key. Required
   * when `encrypt` is `true`; ignored otherwise.
   */
  memoryDir?: string;
  /**
   * When `true`, include the `transcripts/` directory in the export even
   * though it is excluded by default. Using this flag avoids hard-coding an
   * explicit `includeKinds` allow-list that would inadvertently drop other
   * valid memory directories (`peers/`, `forks/`, etc.). (Cursor / #747)
   *
   * Ignored when `includeKinds` is provided and already contains
   * `"transcripts"`.
   */
  includeTranscripts?: boolean;
}

export interface ExportCapsuleResult {
  archivePath: string;
  manifestPath: string;
  manifest: ExportManifestV2;
  /** When the export was encrypted, the `.enc` path. `null` when unencrypted. */
  encryptedArchivePath: string | null;
}

/**
 * Pure function that exports a memory directory as a portable, capsule-aware
 * V2 bundle.
 *
 * The output is a single `.capsule.json.gz` archive containing the entire
 * `ExportBundleV2` (manifest + records) plus a sidecar `manifest.json` for
 * cheap inspection. The bundle format is intentionally identical to the
 * existing `export-json` shape so PR 3/6's importer can reuse the V1 code
 * path with only a manifest version-dispatch.
 *
 * Determinism guarantees:
 *  - `manifest.files` and `bundle.records` are sorted by posix path.
 *  - `manifest.createdAt` is taken from {@link ExportCapsuleOptions.now}
 *    when provided.
 *  - The archive is gzip-compressed with default settings; no timestamp is
 *    embedded (Node's `gzipSync` does not write a header timestamp when
 *    using the synchronous helper, so byte-identical outputs are possible
 *    given identical inputs).
 *
 * Empty result handling: a capsule with zero matching files is still a
 * valid capsule and produces a well-formed manifest with an empty `files`
 * array and an archive containing the empty bundle.
 */
export async function exportCapsule(
  opts: ExportCapsuleOptions,
): Promise<ExportCapsuleResult> {
  validateName(opts.name);
  if (opts.encrypt === true && !opts.memoryDir) {
    throw new Error(
      "exportCapsule: 'memoryDir' is required when 'encrypt' is true so the " +
        "secure-store key can be retrieved.",
    );
  }
  const encryptionMemoryDir = opts.encrypt === true ? opts.memoryDir : undefined;
  const sinceMs = parseSince(opts.since);
  const includeKinds = normalizeIncludeKinds(opts.includeKinds);
  const peerFilter = normalizePeerIds(opts.peerIds);
  // `includeTranscripts: true` overrides the default transcripts exclusion
  // without requiring an explicit `includeKinds` list — so callers that want
  // all memory dirs + transcripts don't need to hard-code a list that would
  // inadvertently drop new dirs like `peers/` or `forks/`. (Cursor / #747)
  const transcriptsOverride = opts.includeTranscripts === true;

  const rootAbs = path.resolve(opts.root);
  await assertIsDirectory(rootAbs);

  const outDirAbs = path.resolve(opts.outDir ?? path.join(rootAbs, ".capsules"));
  // Reject outDir === root: the input scan would otherwise be entirely
  // skipped by `shouldInclude` (outDirRelPosix === ".") and the export would
  // silently succeed with an empty manifest/archive — a Rule 51 violation
  // and a data-loss footgun for callers that point outDir at the root.
  if (outDirAbs === rootAbs) {
    throw new Error(
      "exportCapsule: 'outDir' must not equal 'root'. " +
        "Choose a separate directory (default: <root>/.capsules) so the " +
        "export does not overwrite or shadow the source tree.",
    );
  }
  await mkdir(outDirAbs, { recursive: true });

  // If the output directory lives inside the export root, scan results would
  // re-import previous capsule archives on subsequent runs. Compute the
  // posix-relative path of the outDir under rootAbs (or `null` when it sits
  // outside) so {@link shouldInclude} can skip the entire subtree.
  const outDirRelPosix = computeTransferOutputRel(rootAbs, outDirAbs);

  const filesAbs = await listFilesRecursive(rootAbs);

  const records: ExportMemoryRecordV1[] = [];
  const manifestFiles: ExportManifestV2["files"] = [];

  for (const abs of filesAbs) {
    const relPosix = toPosixRelPath(abs, rootAbs);
    if (!shouldInclude(relPosix, includeKinds, peerFilter, outDirRelPosix, transcriptsOverride)) continue;

    if (sinceMs !== null) {
      const st = await stat(abs);
      if (st.mtimeMs < sinceMs) continue;
    }

    const content = await readFile(abs, "utf-8");
    records.push({ path: relPosix, content });
    const { sha256, bytes } = await sha256File(abs);
    manifestFiles.push({ path: relPosix, sha256, bytes });
  }

  records.sort((a, b) => a.path.localeCompare(b.path));
  manifestFiles.sort((a, b) => a.path.localeCompare(b.path));

  const capsule = buildCapsuleBlock(opts.name, opts.capsule);
  const includesTranscripts =
    transcriptsOverride || (includeKinds ?? new Set<string>()).has(TRANSCRIPTS_DIR);

  const createdAtMs = opts.now ?? Date.now();
  const manifest = ExportManifestV2Schema.parse({
    format: EXPORT_FORMAT,
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    createdAt: new Date(createdAtMs).toISOString(),
    pluginVersion: opts.pluginVersion ?? "0.0.0",
    includesTranscripts,
    files: manifestFiles,
    capsule,
  } satisfies ExportManifestV2);

  const bundle: ExportBundleV2 = ExportBundleV2Schema.parse({
    manifest,
    records,
  });

  const archivePath = path.join(outDirAbs, `${opts.name}.capsule.json.gz`);
  const manifestPath = path.join(outDirAbs, `${opts.name}.manifest.json`);

  // Sidecar manifest for cheap inspection without decompressing the archive.
  await writeJsonFile(manifestPath, manifest);

  // Single-artifact gzip archive containing the whole bundle. JSON encoded
  // before gzip so the archive is opaque to file-tree filtering. Using the
  // sync helper keeps the function pure async (no filesystem callback chain)
  // and matches the existing transfer modules' style.
  const json = JSON.stringify(bundle);
  const gz = gzipSync(Buffer.from(json, "utf-8"));
  await writeFile(archivePath, gz);

  // Optional encryption (PR 4/4). When opts.encrypt is true, wrap the
  // plaintext gzip in a REMNIC-ENC sealed envelope and remove the plaintext.
  // Per gotcha #54: write the encrypted file before removing the plaintext so
  // a crash mid-encrypt does not destroy the only copy.
  if (opts.encrypt === true) {
    try {
      const { encPath } = await encryptCapsuleFile({
        sourceGzPath: archivePath,
        memoryDir: encryptionMemoryDir!,
      });
      // Remove the plaintext only after the encrypted file was written successfully.
      await unlink(archivePath);
      return { archivePath: encPath, manifestPath, manifest, encryptedArchivePath: encPath };
    } catch (error) {
      try {
        await unlink(archivePath);
      } catch {
        // Best-effort cleanup: do not leave a plaintext capsule after a failed encrypted export.
      }
      throw error;
    }
  }

  return { archivePath, manifestPath, manifest, encryptedArchivePath: null };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateName(name: unknown): void {
  if (typeof name !== "string" || !CAPSULE_ID_PATTERN.test(name)) {
    throw new Error(
      `exportCapsule: invalid capsule name. Expected /${CAPSULE_ID_PATTERN.source}/`,
    );
  }
  if (name.length > 64) {
    throw new Error(
      "exportCapsule: invalid capsule name. Must be 64 characters or fewer.",
    );
  }
}

/**
 * Strict ISO-8601 form accepted by {@link parseSince}. We accept exactly two
 * shapes:
 *
 *   1. Date-only:  `YYYY-MM-DD` — interpreted as UTC midnight per ECMAScript.
 *   2. Date+time with an explicit timezone designator:
 *      `YYYY-MM-DDTHH:MM(:SS(.fff)?)?(Z|±HH:MM)`.
 *
 * Notably **rejected**: date+time **without** a timezone (e.g.
 * `2026-02-28T00:00:00`). ECMAScript treats this as local time, which makes
 * acceptance and the resulting cutoff depend on the host's `TZ` and silently
 * shifts incremental-export windows for users outside UTC. Rule 51: reject
 * inputs that silently coerce to a host-dependent meaning.
 */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2}))?$/;

function parseSince(since: string | undefined): number | null {
  if (since === undefined) return null;
  if (typeof since !== "string" || since.trim() === "") {
    throw new Error("exportCapsule: 'since' must be a non-empty ISO-8601 string");
  }
  if (!ISO_8601_RE.test(since)) {
    throw new Error(
      `exportCapsule: 'since' is not a valid ISO-8601 timestamp: ${since}`,
    );
  }
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `exportCapsule: 'since' is not a valid ISO-8601 timestamp: ${since}`,
    );
  }
  // Reject calendar overflow: `Date.parse("2026-02-31")` returns a finite ms
  // for March 3 because the JS Date constructor silently normalizes invalid
  // calendar values. Round-trip through `Date` and compare the year/month/day
  // components against the input prefix to catch this. Rule 51: silent
  // coercion of an exact time boundary is a Rule 51 violation that breaks
  // incremental exports.
  assertCalendarRoundTrip(since, ms);
  return ms;
}

export function isValidCapsuleSince(since: string): boolean {
  try {
    parseSince(since);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that parsing {@link since} did not silently normalize an invalid
 * calendar date (e.g. `2026-02-31` → `2026-03-03`). We extract the
 * year/month/day from the input string (regex-validated above) and compare
 * against the parsed Date's UTC components. Both date-only forms and forms
 * with an explicit Z/offset are normalized to UTC by `Date.parse`; for the
 * non-Z case where the offset shifts the calendar day across midnight, we
 * re-derive the input's intended UTC instant by accounting for the offset
 * before the comparison.
 */
function assertCalendarRoundTrip(since: string, ms: number): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(since);
  if (!m) return;
  const wantY = Number(m[1]);
  const wantMo = Number(m[2]);
  const wantD = Number(m[3]);

  // For inputs with an explicit non-zero offset, compare against the
  // wall-clock components of that offset instead of UTC. Date.parse maps to
  // UTC, so 2026-02-31T00:00:00-05:00 and 2026-02-31T00:00:00Z both fail the
  // calendar check; the wall-clock comparison via `m[1..3]` is still the
  // right reference because the input's stated calendar day must exist.
  const offsetMatch = /([+-])(\d{2}):?(\d{2})$/.exec(since);
  let displayMs = ms;
  if (offsetMatch) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const offsetMin = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
    displayMs = ms + offsetMin * 60_000;
  }
  const dd = new Date(displayMs);
  const gotY = dd.getUTCFullYear();
  const gotMo = dd.getUTCMonth() + 1;
  const gotD = dd.getUTCDate();
  if (gotY !== wantY || gotMo !== wantMo || gotD !== wantD) {
    throw new Error(
      `exportCapsule: 'since' is not a valid ISO-8601 timestamp: ${since}`,
    );
  }
}

function normalizeIncludeKinds(
  kinds: readonly string[] | undefined,
): ReadonlySet<string> | null {
  if (kinds === undefined) return null;
  // Empty array is treated as "include nothing" rather than "include all"
  // so callers cannot accidentally widen the filter by passing []. This
  // mirrors PR-1/6 Rule 51: reject ambiguous input — but here we model it
  // as "explicit empty allow-list" rather than throwing, because empty
  // capsules ARE valid (see acceptance criteria).
  const set = new Set<string>();
  for (const raw of kinds) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error("exportCapsule: 'includeKinds' entries must be non-empty strings");
    }
    if (raw.includes("/") || raw.includes("\\")) {
      throw new Error(
        `exportCapsule: 'includeKinds' entries must be top-level segment names, got: ${raw}`,
      );
    }
    set.add(raw);
  }
  return set;
}

function normalizePeerIds(
  peerIds: readonly string[] | undefined,
): ReadonlySet<string> | null {
  if (peerIds === undefined) return null;
  const set = new Set<string>();
  for (const raw of peerIds) {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error("exportCapsule: 'peerIds' entries must be non-empty strings");
    }
    if (raw.includes("/") || raw.includes("\\") || raw === "." || raw === "..") {
      throw new Error(
        `exportCapsule: 'peerIds' entries must be plain segment names, got: ${raw}`,
      );
    }
    set.add(raw);
  }
  return set;
}

async function assertIsDirectory(absPath: string): Promise<void> {
  // Mirror gotcha #24: existsSync returns true for files. The export root
  // MUST be a directory or the walk silently succeeds with zero entries.
  const st = await stat(absPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(
      `exportCapsule: 'root' must be an existing directory: ${absPath}`,
    );
  }
}

function shouldInclude(
  relPosix: string,
  includeKinds: ReadonlySet<string> | null,
  peerFilter: ReadonlySet<string> | null,
  outDirRelPosix: string | null,
  transcriptsOverride = false,
): boolean {
  const parts = relPosix.split("/");
  if (parts.some((p) => DEFAULT_EXCLUDE_DIRS.has(p))) return false;

  // Exclude the output directory subtree. Without this, re-running against
  // the same root packages prior `.capsule.json.gz` archives and sidecar
  // manifests as records, causing bundle bloat and leaking stale exports.
  // `outDir === root` is rejected at the entrypoint (`exportCapsule`), so
  // {@link computeOutDirRel} never returns `"."` for the in-tree case here.
  if (outDirRelPosix !== null) {
    if (relPosix === outDirRelPosix) return false;
    if (relPosix.startsWith(`${outDirRelPosix}/`)) return false;
  }

  const top = parts[0];

  // Transcripts are opt-in: excluded unless caller explicitly listed them
  // in includeKinds OR passed `includeTranscripts: true`. The override flag
  // avoids the footgun of having the CLI build a hard-coded kinds list that
  // inadvertently drops valid memory dirs like `peers/` or `forks/`. (Cursor / #747)
  if (
    top === TRANSCRIPTS_DIR &&
    !transcriptsOverride &&
    (includeKinds === null || !includeKinds.has(TRANSCRIPTS_DIR))
  ) {
    return false;
  }

  if (includeKinds !== null) {
    // includeKinds restricts to whitelisted top-level segments. Files at
    // the repo root (no top-level dir) are excluded under an explicit
    // allow-list because they are not categorized.
    if (parts.length < 2) return false;
    if (!includeKinds.has(top)) return false;
  }

  if (top === PEERS_DIR && peerFilter !== null) {
    if (peerFilter.size === 0) return false;
    if (parts.length < 2) return false;
    if (!peerFilter.has(parts[1])) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Capsule-block defaults
// ---------------------------------------------------------------------------

/**
 * Build a {@link CapsuleBlock} for the manifest. PR 2/6 ships a minimal
 * snapshot: tier-weights and `directAnswerEnabled` default to zod-passing
 * placeholders so the bundle parses cleanly. PRs 3/6+ will wire real
 * retrieval-policy and identity-anchor snapshots into the override path.
 *
 * Defaults (chosen to be safe + least-surprising):
 *  - `version`           — `0.1.0` (capsule authors override per release).
 *  - `schemaVersion`     — `taxonomy-v1` until the taxonomy registry stabilizes.
 *  - `parentCapsule`     — `null` (explicit "no parent" sentinel).
 *  - `description`       — empty string. Capsule authors override.
 *  - `retrievalPolicy`   — empty `tierWeights` map + `directAnswerEnabled: false`.
 *    Empty weights mean "no overrides"; importers fall back to their local
 *    policy. `false` is the least-privileged default per Rule 48.
 *  - `includes`          — all flags `false` until later PRs wire the
 *    sub-bundles in.
 */
function buildCapsuleBlock(
  name: string,
  override: Partial<Omit<CapsuleBlock, "id">> | undefined,
): CapsuleBlock {
  // `parent` (structured, PR 4/6) and `parentCapsule` (legacy string) carry
  // overlapping information. The schema documents the invariant: when
  // `parent` is non-null, `parentCapsule` SHOULD equal `parent.capsuleId`.
  // We derive the legacy field from the structured field whenever the
  // caller supplies `parent` but omits `parentCapsule`, so a single-source
  // override path produces a manifest that satisfies the documented
  // invariant for legacy V2 readers (Cursor medium #751 round 3).
  // An explicit `parentCapsule` override still wins — including an explicit
  // `null` — so callers can intentionally diverge from the structured field
  // for migration scenarios.
  const parent = override?.parent ?? null;
  const parentCapsule =
    override && Object.prototype.hasOwnProperty.call(override, "parentCapsule")
      ? (override.parentCapsule ?? null)
      : (parent?.capsuleId ?? null);

  const merged: CapsuleBlock = {
    id: name,
    version: override?.version ?? "0.1.0",
    schemaVersion: override?.schemaVersion ?? "taxonomy-v1",
    parentCapsule,
    parent,
    description: override?.description ?? "",
    retrievalPolicy: override?.retrievalPolicy ?? {
      tierWeights: {},
      directAnswerEnabled: false,
    },
    includes: override?.includes ?? {
      taxonomy: false,
      identityAnchors: false,
      peerProfiles: false,
      procedural: false,
    },
  };
  // Re-parse to surface invalid overrides with the same zod errors a caller
  // would get when constructing a CapsuleBlock by hand.
  return CapsuleBlockSchema.parse(merged);
}
