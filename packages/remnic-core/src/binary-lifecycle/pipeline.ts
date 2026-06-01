/**
 * Binary lifecycle pipeline — mirror, redirect, clean.
 *
 * Three-stage pipeline:
 * 1. Mirror:   upload binary to backend, record in manifest
 * 2. Redirect: scan markdown for inline refs, replace with redirect path
 * 3. Clean:    after grace period, delete local copy
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  BinaryAssetRecord,
  BinaryLifecycleConfig,
  PipelineResult,
} from "./types.js";
import type { BinaryStorageBackend } from "./backend.js";
import { readManifest, writeManifest } from "./manifest.js";
import { scanForBinaries } from "./scanner.js";

/** Minimal logger interface so we don't depend on the full logger module. */
interface PipelineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

type ReadMarkdownFile = (filePath: string) => Promise<string>;
type WriteMarkdownFile = (filePath: string, content: string) => Promise<void>;

interface PipelineOptions {
  dryRun?: boolean;
  /** Force-clean all files past grace period, ignoring redirect status. */
  forceClean?: boolean;
  /** Test hook for deterministic markdown read failures. */
  readMarkdownFile?: ReadMarkdownFile;
  /** Test hook for deterministic markdown write failures. */
  writeMarkdownFile?: WriteMarkdownFile;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashFile(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function guessMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Escape special regex characters in a string.
 * CLAUDE.md #46: always escapeRegex on user-derived parts.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveManifestAssetPath(memoryDir: string, originalPath: string): string | null {
  if (
    originalPath.length === 0 ||
    originalPath.includes("\0") ||
    originalPath.includes("\\") ||
    path.isAbsolute(originalPath) ||
    path.win32.isAbsolute(originalPath)
  ) {
    return null;
  }

  const memoryRoot = path.resolve(memoryDir);
  const fullPath = path.resolve(memoryRoot, originalPath);
  const relative = path.relative(memoryRoot, fullPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }

  return fullPath;
}

function validateBinaryLifecycleConfig(config: BinaryLifecycleConfig): void {
  if (
    typeof config.gracePeriodDays !== "number" ||
    !Number.isFinite(config.gracePeriodDays) ||
    !Number.isInteger(config.gracePeriodDays) ||
    config.gracePeriodDays < 0
  ) {
    throw new Error("binary lifecycle gracePeriodDays must be a finite non-negative integer");
  }
}

function remotePathForAsset(backend: BinaryStorageBackend, relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (backend.type === "filesystem") {
    return `.binary-lifecycle/mirrors/${normalized}`;
  }
  return normalized;
}

function markdownTargetForAsset(asset: BinaryAssetRecord): string {
  return asset.redirectPath ?? asset.mirroredPath;
}

// ---------------------------------------------------------------------------
// Pipeline stages
// ---------------------------------------------------------------------------

async function stageMirror(
  memoryDir: string,
  newPaths: string[],
  backend: BinaryStorageBackend,
  assets: BinaryAssetRecord[],
  log: PipelineLogger,
  dryRun: boolean,
): Promise<{ mirrored: number; errors: string[] }> {
  let mirrored = 0;
  const errors: string[] = [];

  for (const relPath of newPaths) {
    const fullPath = path.join(memoryDir, relPath);
    try {
      const stat = await fsp.stat(fullPath);
      const contentHash = await hashFile(fullPath);
      const ext = path.extname(relPath);
      const mimeType = guessMimeType(ext);
      const remotePath = remotePathForAsset(backend, relPath);

      let backendLocation = remotePath;
      if (!dryRun) {
        backendLocation = await backend.upload(fullPath, remotePath);
      }
      const redirectPath = backend.getRedirectTarget?.(backendLocation);

      const record: BinaryAssetRecord = {
        originalPath: relPath,
        mirroredPath: backendLocation,
        ...(redirectPath ? { redirectPath } : {}),
        contentHash,
        sizeBytes: stat.size,
        mimeType,
        mirroredAt: new Date().toISOString(),
        status: "mirrored",
      };

      if (!dryRun) {
        const existingIndex = assets.findIndex((asset) => asset.originalPath === relPath);
        if (existingIndex >= 0) {
          assets.splice(existingIndex, 1);
        }
        assets.push(record);
      }
      mirrored++;
      log.info(`[binary-lifecycle] mirrored: ${relPath} (${stat.size} bytes)${dryRun ? " [dry-run]" : ""}`);
    } catch (err) {
      const msg = `mirror failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
    }
  }

  return { mirrored, errors };
}

async function stageRedirect(
  memoryDir: string,
  assets: BinaryAssetRecord[],
  log: PipelineLogger,
  dryRun: boolean,
  readMarkdownFile: ReadMarkdownFile,
  writeMarkdownFile: WriteMarkdownFile,
): Promise<{ redirected: number; errors: string[] }> {
  let redirected = 0;
  const errors: string[] = [];

  // Redirect mirrored assets and retry prior redirect errors. Clean-stage errors
  // remain safe because the redirect path validation below will keep rejecting
  // invalid manifest records.
  const candidates = assets.filter((a) => a.status === "mirrored" || a.status === "error");
  if (candidates.length === 0) return { redirected, errors };

  // Find all markdown files in memoryDir (recursive).
  const mdFiles = await findMarkdownFiles(memoryDir);

  for (const asset of candidates) {
    const assetAbsolute = resolveManifestAssetPath(memoryDir, asset.originalPath);
    if (assetAbsolute === null) {
      const msg = `redirect blocked for ${asset.originalPath}: manifest path is outside memoryDir`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
      if (!dryRun) {
        asset.status = "error";
      }
      continue;
    }

    const updates: Array<{ mdPath: string; content: string }> = [];
    let scanFailCount = 0;
    for (const mdPath of mdFiles) {
      try {
        const content = await readMarkdownFile(mdPath);

        const pattern = markdownReferencePattern(asset, assetAbsolute, mdPath);

        if (!pattern.test(content)) continue;

        // Reset lastIndex after test().
        pattern.lastIndex = 0;
        const updated = content.replace(pattern, (_match, open, _target, close) => {
          return `${open as string}${markdownTargetForAsset(asset)}${close as string}`;
        });
        updates.push({ mdPath, content: updated });
      } catch (err) {
        scanFailCount++;
        const msg = `redirect scan failed for ${mdPath}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
    }

    if (scanFailCount > 0) {
      if (!dryRun) {
        asset.status = "error";
      }
      log.warn(
        `[binary-lifecycle] redirect blocked for ${asset.originalPath}: ` +
          `${scanFailCount} markdown scan failure(s)` +
          `${dryRun ? "" : " — status set to error"}`,
      );
      continue;
    }

    if (updates.length === 0) {
      if (asset.status === "error") {
        const verifyResult = await countRemainingLocalReferences(
          memoryDir,
          asset,
          assetAbsolute,
          mdFiles,
          readMarkdownFile,
        );
        if (verifyResult.errors.length > 0 || verifyResult.remaining > 0) {
          if (!dryRun) {
            asset.status = "error";
          }
          for (const msg of verifyResult.errors) {
            log.error(`[binary-lifecycle] ${msg}`);
            errors.push(msg);
          }
          if (verifyResult.remaining > 0) {
            const msg = `redirect verification failed for ${asset.originalPath}: ${verifyResult.remaining} local reference(s) remain`;
            log.warn(`[binary-lifecycle] ${msg}`);
            errors.push(msg);
          }
          continue;
        }

        if (asset.redirectedAt === undefined) {
          if (!dryRun) {
            asset.status = "mirrored";
          }
          log.info(`[binary-lifecycle] preserved mirrored asset without redirected marker: ${asset.originalPath}${dryRun ? " [dry-run]" : ""}`);
          continue;
        }

        if (!Number.isFinite(new Date(asset.mirroredAt).getTime())) {
          const msg = `redirect blocked for ${asset.originalPath}: manifest mirroredAt is invalid`;
          log.error(`[binary-lifecycle] ${msg}`);
          errors.push(msg);
          if (!dryRun) {
            asset.status = "error";
          }
          continue;
        }

        if (!dryRun) {
          asset.status = "redirected";
          asset.redirectedAt = new Date().toISOString();
        }
        redirected++;
        log.info(`[binary-lifecycle] redirected: ${asset.originalPath}${dryRun ? " [dry-run]" : ""}`);
      }
      continue;
    }

    if (dryRun) {
      redirected++;
      log.info(`[binary-lifecycle] redirected: ${asset.originalPath} [dry-run]`);
      continue;
    }

    let writeFailCount = 0;
    for (const update of updates) {
      try {
        await writeMarkdownFile(update.mdPath, update.content);
      } catch (err) {
        writeFailCount++;
        const msg = `redirect write failed for ${update.mdPath}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
    }

    if (writeFailCount > 0) {
      if (!dryRun) {
        asset.status = "error";
      }
      log.warn(
        `[binary-lifecycle] redirect write failure for ${asset.originalPath}: ` +
          `${writeFailCount} write failure(s) — status set to error`,
      );
      continue;
    }

    const redirectedAt = new Date().toISOString();
    asset.redirectedAt = redirectedAt;

    const verifyResult = await countRemainingLocalReferences(
      memoryDir,
      asset,
      assetAbsolute,
      mdFiles,
      readMarkdownFile,
    );
    if (verifyResult.errors.length > 0 || verifyResult.remaining > 0) {
      asset.status = "error";
      for (const msg of verifyResult.errors) {
        log.error(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
      if (verifyResult.remaining > 0) {
        const msg = `redirect verification failed for ${asset.originalPath}: ${verifyResult.remaining} local reference(s) remain`;
        log.warn(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
      continue;
    }
    asset.status = "redirected";
    asset.redirectedAt = redirectedAt;
    redirected++;
    log.info(`[binary-lifecycle] redirected: ${asset.originalPath}`);
  }

  return { redirected, errors };
}

async function countRemainingLocalReferences(
  memoryDir: string,
  asset: BinaryAssetRecord,
  assetAbsolute: string,
  mdFiles: string[],
  readMarkdownFile: ReadMarkdownFile,
): Promise<{ remaining: number; errors: string[] }> {
  let remaining = 0;
  const errors: string[] = [];

  for (const mdPath of mdFiles) {
    try {
      const content = await readMarkdownFile(mdPath);
      const pattern = markdownReferencePattern(asset, assetAbsolute, mdPath);
      if (pattern.test(content)) {
        remaining++;
      }
    } catch (err) {
      errors.push(`redirect verification failed for ${mdPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { remaining, errors };
}

function markdownReferencePattern(
  asset: BinaryAssetRecord,
  assetAbsolute: string,
  mdPath: string,
): RegExp {
  const mdDir = path.dirname(mdPath);
  const candidates = new Set<string>();
  const addCandidate = (candidate: string): void => {
    const normalized = candidate.split(path.sep).join("/");
    if (normalized.length === 0) return;
    candidates.add(normalized);
    const isParentTraversal = normalized === ".." || normalized.startsWith("../");
    if (!normalized.startsWith("./") && !normalized.startsWith("/") && !isParentTraversal) {
      candidates.add(`./${normalized}`);
    }
  };

  // Markdown links may be file-relative to the note or memory-root-relative in
  // Remnic notes. Match both forms so verification cannot miss a live local ref.
  addCandidate(path.relative(mdDir, assetAbsolute));
  const originalPath = asset.originalPath.split(path.sep).join("/");
  const originalAsFileRelative = path.resolve(mdDir, ...originalPath.split("/"));
  if (path.resolve(originalAsFileRelative) === path.resolve(assetAbsolute)) {
    addCandidate(originalPath);
  }
  addCandidate(`/${originalPath}`);

  const alternatives = [...candidates]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");

  return new RegExp(`(!?\\[[^\\]]*\\]\\()(${alternatives})(\\))`, "g");
}

async function stageClean(
  memoryDir: string,
  assets: BinaryAssetRecord[],
  backend: BinaryStorageBackend,
  gracePeriodDays: number,
  log: PipelineLogger,
  dryRun: boolean,
  forceClean: boolean,
): Promise<{ cleaned: number; errors: string[] }> {
  let cleaned = 0;
  const errors: string[] = [];
  const now = Date.now();
  const graceMs = gracePeriodDays * 24 * 60 * 60 * 1000;

  // Clean only assets that have been redirected (markdown refs already rewritten).
  // Mirrored-only assets must NOT be cleaned — their markdown refs still point
  // to the local file, so deletion would break links.
  const candidates = assets.filter(
    (a) => a.status === "redirected",
  );

  for (const asset of candidates) {
    const mirroredMs = new Date(asset.mirroredAt).getTime();
    if (!Number.isFinite(mirroredMs)) {
      const msg = `clean blocked for ${asset.originalPath}: manifest mirroredAt is invalid`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
      if (!dryRun) {
        asset.status = "error";
      }
      continue;
    }
    const ageMs = now - mirroredMs;

    if (!forceClean && ageMs < graceMs) {
      // Not yet past grace period.
      continue;
    }

    const fullPath = resolveManifestAssetPath(memoryDir, asset.originalPath);
    if (fullPath === null) {
      const msg = `clean blocked for ${asset.originalPath}: manifest path is outside memoryDir`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
      if (!dryRun) {
        asset.status = "error";
      }
      continue;
    }

    let remoteExists: boolean;
    try {
      remoteExists = await backend.exists(asset.mirroredPath);
    } catch (err) {
      const msg = `clean blocked for ${asset.originalPath}: failed to verify mirrored copy: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
      continue;
    }

    if (!remoteExists) {
      const msg = `clean blocked for ${asset.originalPath}: mirrored copy is missing`;
      log.error(`[binary-lifecycle] ${msg}`);
      errors.push(msg);
      continue;
    }

    try {
      const currentHash = await hashFile(fullPath);
      if (currentHash !== asset.contentHash) {
        const msg = `clean blocked for ${asset.originalPath}: local content hash does not match manifest`;
        log.warn(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
        continue;
      }
      if (!dryRun) {
        await fsp.unlink(fullPath);
        asset.status = "cleaned";
        asset.cleanedAt = new Date().toISOString();
      }
      cleaned++;
      log.info(`[binary-lifecycle] cleaned: ${asset.originalPath}${dryRun ? " [dry-run]" : ""}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Already gone — mark as cleaned.
        if (!dryRun) {
          asset.status = "cleaned";
          asset.cleanedAt = new Date().toISOString();
          cleaned++;
        }
      } else {
        const msg = `clean failed for ${asset.originalPath}: ${err instanceof Error ? err.message : String(err)}`;
        log.error(`[binary-lifecycle] ${msg}`);
        errors.push(msg);
      }
    }
  }

  return { cleaned, errors };
}

// ---------------------------------------------------------------------------
// Markdown file discovery
// ---------------------------------------------------------------------------

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".binary-lifecycle") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the binary lifecycle pipeline: scan, mirror, redirect, clean.
 */
export async function runBinaryLifecyclePipeline(
  memoryDir: string,
  config: BinaryLifecycleConfig,
  backend: BinaryStorageBackend,
  log: PipelineLogger,
  opts?: PipelineOptions,
): Promise<PipelineResult> {
  validateBinaryLifecycleConfig(config);

  const dryRun = opts?.dryRun ?? false;
  const forceClean = opts?.forceClean ?? false;

  if (config.enabled === false) {
    return {
      scanned: 0,
      mirrored: 0,
      redirected: 0,
      cleaned: 0,
      errors: [],
      dryRun,
    };
  }

  const manifest = await readManifest(memoryDir);

  // Stage 0: Scan
  const newPaths = await scanForBinaries(memoryDir, config, manifest);
  const scanned = newPaths.length;

  // Stage 1: Mirror
  const mirrorResult = await stageMirror(
    memoryDir,
    newPaths,
    backend,
    manifest.assets,
    log,
    dryRun,
  );

  // Stage 2: Redirect
  const redirectResult = await stageRedirect(
    memoryDir,
    manifest.assets,
    log,
    dryRun,
    opts?.readMarkdownFile ?? ((filePath: string) => fsp.readFile(filePath, "utf-8")),
    opts?.writeMarkdownFile ?? ((filePath: string, content: string) => fsp.writeFile(filePath, content, "utf-8")),
  );

  // Stage 3: Clean
  const cleanResult = await stageClean(
    memoryDir,
    manifest.assets,
    backend,
    config.gracePeriodDays,
    log,
    dryRun,
    forceClean,
  );

  // Persist manifest (unless dry-run).
  manifest.lastScanAt = new Date().toISOString();
  if (!dryRun) {
    await writeManifest(memoryDir, manifest);
  }

  const allErrors = [
    ...mirrorResult.errors,
    ...redirectResult.errors,
    ...cleanResult.errors,
  ];

  return {
    scanned,
    mirrored: mirrorResult.mirrored,
    redirected: redirectResult.redirected,
    cleaned: cleanResult.cleaned,
    errors: allErrors,
    dryRun,
  };
}
