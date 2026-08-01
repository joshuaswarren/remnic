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

import { lstatSync, realpathSync } from "node:fs";
import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

import { expandTildePath } from "@remnic/core";

/**
 * Strip trailing separators from an already-normalized path.
 *
 * A character loop rather than a `/[\\/]+$/` regex: the inputs are
 * externally supplied (daemon health payloads, config files), and a
 * quantified trailing-separator class is the polynomial-backtracking shape
 * CodeQL flags on uncontrolled data.
 */
function trimTrailingSeparators(value: string): string {
  // Never strip past the root. On Windows a corpus at `C:\\` would otherwise
  // become `C:`, which node:path treats as DRIVE-RELATIVE — `path.relative`
  // would then measure against the gateway's cwd and reject a daemon serving
  // `C:\\namespaces\\<ns>`.
  const floor = Math.max(1, path.parse(value).root.length);
  let end = value.length;
  while (end > floor && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
  return value.slice(0, end);
}

function defaultIsSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    // A missing path is rejected by the canonicalization below; report it as
    // "not a symlink" so the failure surfaces there with the right reason.
    return false;
  }
}

/** The only descendant layout that still names the configured corpus. */
const NAMESPACE_STORAGE_SEGMENT = "namespaces";

/**
 * Whether a daemon's reported memory directory names the corpus this plugin
 * is configured for.
 *
 * Accepts exactly two shapes: the root itself, or one namespace storage
 * directory beneath it (`<corpusRoot>/namespaces/<namespace>`).
 * `GET /engram/v1/health` reports the NAMESPACE-RESOLVED storage directory, so
 * a deployment whose default namespace has migrated out of the flat root
 * answers the second shape and requiring equality would mark a healthy
 * co-located daemon foreign. Any OTHER descendant — say a daemon independently
 * configured for `<corpusRoot>/archive` — is a different corpus, and accepting
 * it would silently redirect every recall and write into it.
 *
 * Both sides must be ABSOLUTE. A relative `memoryDir` names a different
 * directory in each process's working directory, so resolving both against the
 * gateway's cwd would manufacture a match between two distinct corpora.
 *
 * Both sides are canonicalized BEFORE the shape is judged, so two symlink
 * spellings of one directory match — otherwise a co-located gateway and daemon
 * on the same files would be judged different and both run, exactly the
 * duplicate-orchestrator deployment this check exists to prevent — and a
 * component symlinking out of the corpus cannot masquerade as contained.
 *
 * Fails CLOSED: relative, blank, or unresolvable paths are never a match.
 */
export function daemonServesCorpus(
  corpusRoot: string,
  daemonMemoryDir: string,
  realpath: (target: string) => string = realpathSync,
  isSymlink: (target: string) => boolean = defaultIsSymlink,
): boolean {
  if (!corpusRoot?.trim() || !daemonMemoryDir?.trim()) return false;
  const expandedRoot = expandTildePath(corpusRoot.trim());
  const expandedDaemon = expandTildePath(daemonMemoryDir.trim());
  if (!path.isAbsolute(expandedRoot) || !path.isAbsolute(expandedDaemon)) return false;
  // A root that is ITSELF a symlink is a mutable trust anchor: realpath would
  // erase that fact, and retargeting the link after validation would silently
  // move the directory treated as the corpus. Reject it outright.
  if (isSymlink(path.resolve(expandedRoot)) || isSymlink(path.resolve(expandedDaemon))) {
    return false;
  }
  let canonicalRoot: string;
  let canonicalDaemon: string;
  try {
    canonicalRoot = trimTrailingSeparators(path.normalize(realpath(path.resolve(expandedRoot))));
    canonicalDaemon = trimTrailingSeparators(path.normalize(realpath(path.resolve(expandedDaemon))));
  } catch {
    return false;
  }
  if (canonicalRoot === canonicalDaemon) return true;
  const relative = path.relative(canonicalRoot, canonicalDaemon);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  return segments.length === 2 && segments[0] === NAMESPACE_STORAGE_SEGMENT;
}

export type MemoryReadScopeOptions = {
  /** Remnic memory root — the primary allowed read root. */
  memoryDir: string;
  /** Agent workspace root. `<workspaceDir>/memory` becomes a second root. */
  workspaceDir: string;
  /**
   * Extra allowed roots, appended after the two above and searched in order.
   * Delegate mode uses this to keep the corpus ROOT readable while resolving
   * relative hits against the namespace directory the daemon reports first.
   */
  additionalRoots?: readonly string[];
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
    ...(options.additionalRoots ?? []),
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
