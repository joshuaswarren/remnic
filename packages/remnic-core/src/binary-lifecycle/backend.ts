/**
 * Binary storage backend interface and implementations.
 *
 * Backends handle the actual persistence of binary files to an external
 * location. The pipeline calls upload/exists/delete through this interface
 * so swapping storage providers requires no pipeline changes.
 */

import type { Stats } from "node:fs";
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
  /** Return the user-resolvable markdown target for a stored backend path. */
  getRedirectTarget?(remotePath: string): string;
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
    const resolved = path.isAbsolute(remotePath)
      ? path.resolve(remotePath)
      : path.resolve(this.basePath, remotePath);
    const relative = path.relative(this.basePath, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`FilesystemBackend remotePath escapes basePath: ${JSON.stringify(remotePath)}`);
    }
    return resolved;
  }

  private isInsideBase(candidate: string, realBase: string): boolean {
    const relative = path.relative(realBase, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }

  private async realBasePathIfExists(): Promise<string | null> {
    try {
      const stat = await fsp.lstat(this.basePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`FilesystemBackend basePath must not be a symlink: ${this.basePath}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`FilesystemBackend basePath must be a directory: ${this.basePath}`);
      }
      return await fsp.realpath(this.basePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  private async ensureBaseDirectory(): Promise<string> {
    await fsp.mkdir(this.basePath, { recursive: true });
    const realBase = await this.realBasePathIfExists();
    if (realBase === null) {
      throw new Error(`FilesystemBackend failed to create basePath: ${this.basePath}`);
    }
    return realBase;
  }

  private async ensureSafeParentDirectory(dest: string): Promise<string> {
    const realBase = await this.ensureBaseDirectory();
    const destDir = path.dirname(dest);
    const relativeDir = path.relative(this.basePath, destDir);
    const segments = relativeDir === "" ? [] : relativeDir.split(path.sep);
    let current = this.basePath;

    for (const segment of segments) {
      if (segment === "." || segment === "") continue;
      current = path.join(current, segment);
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`FilesystemBackend remotePath traverses symlink: ${current}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`FilesystemBackend remotePath parent is not a directory: ${current}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
        await fsp.mkdir(current);
      }
    }

    const realParent = await fsp.realpath(destDir);
    if (!this.isInsideBase(realParent, realBase)) {
      throw new Error(`FilesystemBackend remotePath parent escapes basePath: ${dest}`);
    }
    return realBase;
  }

  private async resolveExistingRemotePath(remotePath: string): Promise<string | null> {
    const dest = this.resolveRemotePath(remotePath);
    const realBase = await this.realBasePathIfExists();
    if (realBase === null) {
      return null;
    }

    const destDir = path.dirname(dest);
    const relativeDir = path.relative(this.basePath, destDir);
    const segments = relativeDir === "" ? [] : relativeDir.split(path.sep);
    let current = this.basePath;
    for (const segment of segments) {
      if (segment === "." || segment === "") continue;
      current = path.join(current, segment);
      let stat: Stats;
      try {
        stat = await fsp.lstat(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw err;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`FilesystemBackend remotePath traverses symlink: ${current}`);
      }
      if (!stat.isDirectory()) {
        return null;
      }
    }

    const realParent = await fsp.realpath(destDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (realParent === null) {
      return null;
    }
    if (!this.isInsideBase(realParent, realBase)) {
      throw new Error(`FilesystemBackend remotePath parent escapes basePath: ${JSON.stringify(remotePath)}`);
    }

    try {
      const stat = await fsp.lstat(dest);
      if (stat.isSymbolicLink()) {
        throw new Error(`FilesystemBackend remotePath points to symlink: ${dest}`);
      }
      if (!stat.isFile()) {
        return null;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }

    const realDest = await fsp.realpath(dest);
    if (!this.isInsideBase(realDest, realBase)) {
      throw new Error(`FilesystemBackend remotePath escapes basePath: ${JSON.stringify(remotePath)}`);
    }
    return dest;
  }

  async upload(localPath: string, remotePath: string): Promise<string> {
    if (path.isAbsolute(remotePath)) {
      throw new Error(`FilesystemBackend upload remotePath must be relative: ${JSON.stringify(remotePath)}`);
    }
    const dest = this.resolveRemotePath(remotePath);
    const realBase = await this.ensureSafeParentDirectory(dest);
    try {
      const stat = await fsp.lstat(dest);
      if (stat.isSymbolicLink()) {
        throw new Error(`FilesystemBackend remotePath points to symlink: ${dest}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    await fsp.copyFile(localPath, dest);
    const realDest = await fsp.realpath(dest);
    if (!this.isInsideBase(realDest, realBase)) {
      throw new Error(`FilesystemBackend remotePath escapes basePath: ${JSON.stringify(remotePath)}`);
    }
    return remotePath;
  }

  async exists(remotePath: string): Promise<boolean> {
    const dest = await this.resolveExistingRemotePath(remotePath);
    return dest !== null;
  }

  async delete(remotePath: string): Promise<void> {
    const dest = await this.resolveExistingRemotePath(remotePath);
    if (dest === null) {
      return;
    }
    try {
      await fsp.unlink(dest);
    } catch (err: unknown) {
      // Ignore ENOENT (already deleted); rethrow everything else.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  getRedirectTarget(remotePath: string): string {
    return this.resolveRemotePath(remotePath);
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
