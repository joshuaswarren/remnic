/**
 * Binary storage backend interface and implementations.
 *
 * Backends handle the actual persistence of binary files to an external
 * location. The pipeline calls upload/exists/delete through this interface
 * so swapping storage providers requires no pipeline changes.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { BinaryStorageBackendConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface BinaryStorageBackend {
  /** Discriminator for the backend type. */
  readonly type: string;
  /**
   * Upload a local file to the backend.
   * @returns The backend path or URL where the file was stored.
   */
  upload(localPath: string, remotePath: string): Promise<string>;
  /** Check whether a remote path already exists in the backend. */
  exists(remotePath: string): Promise<boolean>;
  /** Delete a file from the backend. */
  delete(remotePath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Filesystem backend
// ---------------------------------------------------------------------------

export class FilesystemBackend implements BinaryStorageBackend {
  readonly type = "filesystem";
  private readonly basePath: string;

  constructor(basePath: string) {
    if (!basePath || basePath.trim().length === 0) {
      throw new Error("FilesystemBackend requires a non-empty basePath");
    }
    this.basePath = path.resolve(basePath);
  }

  private resolveRemotePath(remotePath: string): string {
    if (path.isAbsolute(remotePath)) {
      throw new Error(`FilesystemBackend remotePath must be relative: ${JSON.stringify(remotePath)}`);
    }
    const resolved = path.resolve(this.basePath, remotePath);
    const relative = path.relative(this.basePath, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`FilesystemBackend remotePath escapes basePath: ${JSON.stringify(remotePath)}`);
    }
    return resolved;
  }

  async upload(localPath: string, remotePath: string): Promise<string> {
    const dest = this.resolveRemotePath(remotePath);
    const destDir = path.dirname(dest);
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.copyFile(localPath, dest);
    return dest;
  }

  async exists(remotePath: string): Promise<boolean> {
    const dest = this.resolveRemotePath(remotePath);
    try {
      await fsp.access(dest, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(remotePath: string): Promise<void> {
    const dest = this.resolveRemotePath(remotePath);
    try {
      await fsp.unlink(dest);
    } catch (err: unknown) {
      // Ignore ENOENT (already deleted); rethrow everything else.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// None backend (no-op, for dry-run / testing)
// ---------------------------------------------------------------------------

export class NoneBackend implements BinaryStorageBackend {
  readonly type = "none";

  async upload(_localPath: string, remotePath: string): Promise<string> {
    return remotePath;
  }

  async exists(_remotePath: string): Promise<boolean> {
    return false;
  }

  async delete(_remotePath: string): Promise<void> {
    // intentional no-op
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBackend(cfg: BinaryStorageBackendConfig): BinaryStorageBackend {
  switch (cfg.type) {
    case "filesystem": {
      if (!cfg.basePath) {
        throw new Error(
          "BinaryStorageBackendConfig.basePath is required when type is \"filesystem\"",
        );
      }
      return new FilesystemBackend(cfg.basePath);
    }
    case "s3":
      throw new Error("S3 binary storage backend is not yet implemented");
    case "none":
      return new NoneBackend();
    default:
      throw new Error(`Unknown binary storage backend type: ${String((cfg as { type: string }).type)}`);
  }
}
