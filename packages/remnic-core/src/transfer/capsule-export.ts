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

const DEFAULT_EXCLUDE_DIRS = DEFAULT_TRANSFER_EXCLUDE_DIRS;

const TRANSCRIPTS_DIR = "transcripts" as const;

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
  const transcriptsOverride = opts.includeTranscripts === true;

  const rootAbs = path.resolve(opts.root);
  await assertIsDirectory(rootAbs);

  const outDirAbs = path.resolve(opts.outDir ?? path.join(rootAbs, ".capsules"));
  if (outDirAbs === rootAbs) {
    throw new Error(
      "exportCapsule: 'outDir' must not equal 'root'. " +
        "Choose a separate directory (default: <root>/.capsules) so the " +
        "export does not overwrite or shadow the source tree.",
    );
  }
  await mkdir(outDirAbs, { recursive: true });

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

  await writeJsonFile(manifestPath, manifest);

  const json = JSON.stringify(bundle);
  const gz = gzipSync(Buffer.from(json, "utf-8"));
  await writeFile(archivePath, gz);

  if (opts.encrypt === true) {
    try {
      const { encPath } = await encryptCapsuleFile({
        sourceGzPath: archivePath,
        memoryDir: encryptionMemoryDir!,
      });
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

function assertCalendarRoundTrip(since: string, ms: number): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(since);
  if (!m) return;
  const wantY = Number(m[1]);
  const wantMo = Number(m[2]);
  const wantD = Number(m[3]);

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

  if (outDirRelPosix !== null) {
    if (relPosix === outDirRelPosix) return false;
    if (relPosix.startsWith(`${outDirRelPosix}/`)) return false;
  }

  const top = parts[0];

  if (
    top === TRANSCRIPTS_DIR &&
    !transcriptsOverride &&
    (includeKinds === null || !includeKinds.has(TRANSCRIPTS_DIR))
  ) {
    return false;
  }

  if (includeKinds !== null) {
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
// ---------------------------------------------------------------------------

function buildCapsuleBlock(
  name: string,
  override: Partial<Omit<CapsuleBlock, "id">> | undefined,
): CapsuleBlock {
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
  return CapsuleBlockSchema.parse(merged);
}
