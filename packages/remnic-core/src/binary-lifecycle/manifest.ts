/**
 * Binary lifecycle manifest — read/write operations.
 *
 * The manifest lives at `${memoryDir}/.binary-lifecycle/manifest.json`.
 * Writes use the atomic temp-then-rename pattern (CLAUDE.md #54).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { BinaryLifecycleManifest } from "./types.js";

const MANIFEST_DIR = ".binary-lifecycle";
const MANIFEST_FILE = "manifest.json";

export function manifestDir(memoryDir: string): string {
  return path.join(memoryDir, MANIFEST_DIR);
}

export function manifestPath(memoryDir: string): string {
  return path.join(memoryDir, MANIFEST_DIR, MANIFEST_FILE);
}

/**
 * Read the manifest from disk. Returns a fresh empty manifest if the file
 * does not exist. Existing invalid manifests fail closed so the pipeline does
 * not overwrite state needed for safe cleanup.
 */
export async function readManifest(memoryDir: string): Promise<BinaryLifecycleManifest> {
  const filePath = manifestPath(memoryDir);
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyManifest();
    }
    throw new Error(`Failed to read binary lifecycle manifest at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid binary lifecycle manifest JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid binary lifecycle manifest shape at ${filePath}: expected object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.assets)) {
    throw new Error(`Invalid binary lifecycle manifest shape at ${filePath}: expected version 1 with assets array`);
  }
  return parsed as BinaryLifecycleManifest;
}

export async function writeManifest(
  memoryDir: string,
  manifest: BinaryLifecycleManifest,
): Promise<void> {
  const dir = manifestDir(memoryDir);
  await fsp.mkdir(dir, { recursive: true });
  const dest = manifestPath(memoryDir);
  const tmpSuffix = crypto.randomBytes(8).toString("hex");
  const tmpPath = `${dest}.${tmpSuffix}.tmp`;
  const content = JSON.stringify(manifest, null, 2) + "\n";
  await fsp.writeFile(tmpPath, content, "utf-8");
  try {
    await fsp.rename(tmpPath, dest);
  } catch (renameErr) {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw renameErr;
  }
}

export function emptyManifest(): BinaryLifecycleManifest {
  return { version: 1, assets: [] };
}
