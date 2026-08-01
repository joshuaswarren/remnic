/**
 * Read scope for the OpenClaw memory-slot capability.
 *
 * The capability runtime hands agents a `readFile` primitive over the memory
 * corpus. The allowed roots contain more than memories (attachments, index
 * files, snapshots, logs), so every read is canonicalized and contained before
 * it opens a descriptor, and narrowed to markdown.
 *
 * Both bridge modes share this module: the embedded runtime resolves reads
 * against the orchestrator's memoryDir, and the delegate runtime resolves them
 * against the same on-disk corpus the daemon serves. Forking the containment
 * logic per mode would let one path drift into a traversal hole the other
 * already closed.
 */

import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

export type MemoryReadScopeOptions = {
  /** Remnic memory root — the primary allowed read root. */
  memoryDir: string;
  /** Agent workspace root. `<workspaceDir>/memory` becomes a second root. */
  workspaceDir: string;
  /** Canonicalizer seam. Defaults to `fs.promises.realpath`; tests inject. */
  realpath?: (filePath: string) => Promise<string>;
}

export type MemoryReadScope = {
  /** Canonical containment targets, in resolution order. */
  readonly allowedRoots: readonly string[];
  /**
   * Absolute form of a search-result path. Relative hits resolve against the
   * first allowed root that lexically contains them, else the workspace root.
   */
  absolutize(rawPath: string): string;
  /** Workspace-relative display form, or the input when it escapes the workspace. */
  normalizeWorkspacePath(rawPath: string | undefined): string;
  /**
   * Display form relative to whichever allowed root contains the path.
   *
   * Search results must NOT be relativized against the workspace root: a hit
   * at `<workspace>/memory/local/facts/a.md` would render as
   * `memory/local/facts/a.md`, which `resolveReadablePath` then re-joins to
   * every allowed root, producing a doubled `memory/` segment and a failed read.
   */
  relativizeToMemoryRoot(rawPath: string | undefined): string;
  /**
   * Canonicalize and contain a requested path, returning the real path safe to
   * open. Throws when the path is unresolvable, escapes the allowed roots, or
   * is not markdown.
   */
  resolveReadablePath(requestedPath: string): Promise<string>;
}

/**
 * Whether a memory-root-relative path lives under a session transcript
 * directory, which the host runtime reports as a distinct search `source`.
 *
 * `relativizeToMemoryRoot` emits platform separators, so a literal
 * `includes("sessions/")` silently classifies every Windows hit as `memory`.
 */
export function isSessionsMemoryPath(relativePath: string): boolean {
  return /(?:^|[\\/])sessions[\\/]/i.test(relativePath);
}

/**
 * Artifact-backed files are served only through the dedicated verbatim
 * artifact path, so every generic memory reader must exclude them. Both bridge
 * modes filter search results with this predicate; a mode that skipped it
 * would bypass the isolation every other reader honors.
 */
export function isMemoryArtifactPath(candidate: string): boolean {
  return /(?:^|[\\/])artifacts(?:[\\/]|$)/i.test(candidate);
}

/**
 * Containment predicate shared by every check below: `path.relative` yields
 * `""` for the root itself, a `..`-prefixed path for an escape, and an
 * absolute path when the two live on different Windows volumes.
 */
function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createMemoryReadScope(options: MemoryReadScopeOptions): MemoryReadScope {
  const { memoryDir, workspaceDir } = options;
  const realpath = options.realpath ?? fsRealpath;

  // Reads are allowlisted to memory files only. The agent workspace root would
  // be far too broad (logs, configs, secrets), so only the memory root and the
  // workspace's memory subdirectory qualify.
  const allowedRoots = [
    memoryDir,
    workspaceDir ? path.join(workspaceDir, "memory") : undefined,
  ].filter((root): root is string => typeof root === "string" && root.length > 0);

  // Init-time canonicalization tolerates realpath failure: the roots may not
  // exist yet at plugin start. The lexical fallback is safe because these
  // values are only ever containment targets, never paths we open.
  const canonicalRootsPromise = Promise.all(
    allowedRoots.map(async (root) => {
      const resolved = path.resolve(root);
      try {
        return path.normalize(await realpath(resolved));
      } catch {
        return path.normalize(resolved);
      }
    }),
  );

  // Check-time canonicalization is strict: realpath failure means the file does
  // not exist or its symlink chain is broken. A lexical fallback here would
  // reopen the TOCTOU window by letting a non-existent path pass containment,
  // after which a symlink could be created before the read.
  const canonicalizeForRead = async (rawPath: string): Promise<string> =>
    path.normalize(await realpath(path.resolve(rawPath)));

  const normalizeWorkspacePath = (rawPath: string | undefined): string => {
    if (!rawPath || typeof rawPath !== "string") return "memory";
    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(workspaceDir, rawPath);
    const relative = path.relative(workspaceDir, resolved);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : rawPath;
  };

  const absolutize = (rawPath: string): string => {
    if (path.isAbsolute(rawPath)) return path.resolve(rawPath);
    for (const root of allowedRoots) {
      const candidate = path.resolve(root, rawPath);
      if (isContained(root, candidate)) return candidate;
    }
    return path.resolve(workspaceDir, rawPath);
  };

  return {
    allowedRoots,
    absolutize,
    normalizeWorkspacePath,
    relativizeToMemoryRoot(rawPath: string | undefined): string {
      if (!rawPath || typeof rawPath !== "string") return "memory";
      const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(workspaceDir, rawPath);
      for (const root of allowedRoots) {
        const relative = path.relative(root, resolved);
        if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          return relative;
        }
      }
      // Not inside any allowed root: fall back to the workspace-relative form
      // for display. Search may surface such a hit informationally even though
      // resolveReadablePath would reject a read of it.
      return normalizeWorkspacePath(rawPath);
    },
    async resolveReadablePath(requestedPath: string): Promise<string> {
      // The host SDK calls this across an untyped boundary, so a missing or
      // non-string path can arrive despite the signature. Reject it as a
      // domain error rather than letting node:path raise a raw TypeError.
      if (typeof requestedPath !== "string" || requestedPath.length === 0) {
        throw new Error("memory read rejected (missing path)");
      }
      // Search results return paths relative to memoryDir (e.g.
      // "facts/alice.md"), not the workspace root. Try each allowed root and
      // take the first whose realpath lands inside the allowlist, so a hit can
      // feed straight into readFile without the caller knowing which root owns it.
      const candidates = path.isAbsolute(requestedPath)
        ? [path.resolve(requestedPath)]
        : allowedRoots.map((root) => path.resolve(root, requestedPath));
      let canonicalPath: string | undefined;
      for (const candidate of candidates) {
        try {
          canonicalPath = await canonicalizeForRead(candidate);
          break;
        } catch {
          // Try the next root; all-failed is reported below.
        }
      }
      if (canonicalPath === undefined) {
        throw new Error(`memory read rejected (path unresolvable): ${requestedPath}`);
      }
      const canonicalRoots = await canonicalRootsPromise;
      if (!canonicalRoots.some((root) => isContained(root, canonicalPath))) {
        throw new Error(`memory read outside allowed roots: ${requestedPath}`);
      }
      if (!canonicalPath.toLowerCase().endsWith(".md")) {
        throw new Error(`memory read restricted to .md files: ${requestedPath}`);
      }
      return canonicalPath;
    },
  };
}
