/**
 * Public artifacts provider for memory-wiki bridge mode.
 *
 * Enumerates Remnic artifacts that are safe for wiki ingestion:
 *   - facts/   (extracted knowledge)
 *   - entities/ (entity knowledge graph)
 *   - corrections/ (fact corrections)
 *   - artifacts/ (structured artifacts)
 *   - profile.md (agent personality/identity — public summary only)
 *
 * Private/runtime state (state/, questions/, transcripts, buffers, etc.)
 * is explicitly excluded.
 */

import { readdir, access, stat, lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Content type for a public artifact.
 * Mirrors MemoryPluginPublicArtifactContentType from OpenClaw SDK.
 */
export type PublicArtifactContentType = "markdown" | "json" | "text";

/**
 * A single public artifact entry.
 * Mirrors MemoryPluginPublicArtifact from OpenClaw SDK.
 */
export interface RemnicPublicArtifact {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: PublicArtifactContentType;
}

/**
 * Directories and file patterns that are safe to expose as public artifacts.
 * Each entry maps a directory name (relative to memoryDir) to the artifact
 * kind and content type. All directories are scanned recursively.
 */
const PUBLIC_DIRS: ReadonlyArray<{
  dir: string;
  kind: string;
  contentType: PublicArtifactContentType;
}> = [
  { dir: "facts", kind: "fact", contentType: "markdown" },
  { dir: "entities", kind: "entity", contentType: "markdown" },
  { dir: "corrections", kind: "correction", contentType: "markdown" },
  { dir: "artifacts", kind: "artifact", contentType: "markdown" },
];

/**
 * Standalone files (relative to memoryDir) that are safe to expose.
 */
const PUBLIC_FILES: ReadonlyArray<{
  relativePath: string;
  kind: string;
  contentType: PublicArtifactContentType;
}> = [
  { relativePath: "profile.md", kind: "memory-root", contentType: "markdown" },
];

/**
 * Check whether a path is contained within a boundary directory.
 * Resolves symlinks via realpath and verifies the resolved path
 * starts with the boundary prefix, preventing symlink traversal.
 */
async function isContainedWithin(target: string, boundary: string): Promise<boolean> {
  try {
    const resolvedTarget = await realpath(target);
    const resolvedBoundary = await realpath(boundary);
    // Ensure the resolved path is within the boundary (with trailing sep)
    return resolvedTarget === resolvedBoundary || resolvedTarget.startsWith(resolvedBoundary + path.sep);
  } catch {
    return false;
  }
}

/**
 * Recursively list all markdown files under a directory.
 * Skips symlinked directories/files that resolve outside the boundary
 * to prevent symlink traversal attacks.
 */
async function listMarkdownFilesRecursive(
  rootDir: string,
  boundary?: string,
  ancestorRealPaths?: ReadonlySet<string>,
): Promise<string[]> {
  const boundaryDir = boundary ?? rootDir;
  // Cycle detection uses only the current recursion path — the set of real
  // paths of ancestors we've descended through. This prevents infinite
  // recursion on symlink cycles while still allowing sibling aliases that
  // point at the same real directory to each be traversed independently.
  // Globally tracking visited real paths (as the earlier implementation
  // did) suppressed all-but-one of the aliases, leaving the surviving one
  // dependent on readdir() order — a source of unstable relativePath
  // output across environments/runs.
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(rootDir);
  } catch {
    return [];
  }
  if (ancestorRealPaths?.has(resolvedRoot)) return []; // Cycle — stop
  const nextAncestors = new Set<string>(ancestorRealPaths ?? []);
  nextAncestors.add(resolvedRoot);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true }) as import("node:fs").Dirent[];
  } catch {
    return [];
  }

  // Sort entries deterministically before traversal so readdir() order
  // cannot influence which aliases survive cycle pruning, and so the
  // overall output order is stable across filesystems.
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, String(entry.name));

    // For symlinks, Dirent.isDirectory()/isFile() return false, so we
    // must use stat() (which follows symlinks) to determine the target type.
    // Before following any symlink, verify the resolved path stays within
    // the boundary to prevent traversal attacks.
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();

    try {
      const linkStat = await lstat(fullPath);
      if (linkStat.isSymbolicLink()) {
        if (!(await isContainedWithin(fullPath, boundaryDir))) {
          continue; // Symlink escapes boundary — skip
        }
        // Follow the symlink to determine target type
        const targetStat = await stat(fullPath);
        isDir = targetStat.isDirectory();
        isFile = targetStat.isFile();
      }
    } catch {
      continue; // Cannot stat — skip
    }

    if (isDir) {
      files.push(...(await listMarkdownFilesRecursive(fullPath, boundaryDir, nextAncestors)));
      continue;
    }
    if (isFile && String(entry.name).endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Check if a file or directory exists.
 */
async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await access(inputPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all public artifacts from a Remnic memory directory.
 *
 * This is the core implementation that enumerates safe/public memory files
 * for wiki ingestion. It intentionally excludes:
 *   - state/        (runtime indexes, caches, internal state)
 *   - questions/    (pending review queue — private)
 *   - transcripts/  (raw conversation logs — private)
 *   - archive/      (archived/demoted memories — stale)
 *   - buffers       (in-flight extraction state)
 *   - tokens/       (auth credentials)
 *
 * @param memoryDir - Absolute path to the Remnic memory directory
 * @param workspaceDir - The workspace directory for this agent
 * @param agentIds - Agent IDs that own this memory
 */
export async function listRemnicPublicArtifacts(params: {
  memoryDir: string;
  workspaceDir: string;
  agentIds: string[];
}): Promise<RemnicPublicArtifact[]> {
  const { memoryDir, workspaceDir, agentIds } = params;
  const artifacts: RemnicPublicArtifact[] = [];

  // Scan public directories
  for (const spec of PUBLIC_DIRS) {
    const dirPath = path.join(memoryDir, spec.dir);
    if (!(await pathExists(dirPath))) continue;

    // Block symlink traversal: verify the directory resolves within memoryDir.
    // Also reject top-level symlinks that redirect an allowlisted directory
    // name to a different directory (e.g., facts -> state), which would
    // expose private files as public artifacts under the wrong kind.
    if (!(await isContainedWithin(dirPath, memoryDir))) continue;
    try {
      const resolvedDir = await realpath(dirPath);
      const expectedParent = await realpath(memoryDir);
      const resolvedName = path.basename(resolvedDir);
      // If the resolved directory name doesn't match the expected name,
      // this is a symlink redirect (e.g., facts -> state). Reject it.
      if (resolvedName !== spec.dir) continue;
      // Also verify the resolved dir's parent is memoryDir (not a nested path)
      if (path.dirname(resolvedDir) !== expectedParent) continue;
    } catch {
      continue;
    }

    // Use the specific public directory as the containment boundary (not
    // memoryDir), so symlinks within e.g. facts/ cannot escape into private
    // directories like state/ or questions/ that live under memoryDir.
    const files = await listMarkdownFilesRecursive(dirPath, dirPath);

    for (const absolutePath of files) {
      const relativePath = path.relative(memoryDir, absolutePath).replace(/\\/g, "/");
      artifacts.push({
        kind: spec.kind,
        workspaceDir,
        relativePath,
        absolutePath,
        agentIds: [...agentIds],
        contentType: spec.contentType,
      });
    }
  }

  // Scan standalone public files
  for (const spec of PUBLIC_FILES) {
    const absolutePath = path.join(memoryDir, spec.relativePath);
    if (!(await pathExists(absolutePath))) continue;
    // Block symlink traversal for standalone files
    if (!(await isContainedWithin(absolutePath, memoryDir))) continue;
    // Reject symlinks that redirect to a different file (e.g., profile.md -> state/index.md)
    try {
      const linkStat = await lstat(absolutePath);
      if (linkStat.isSymbolicLink()) {
        const resolvedPath = await realpath(absolutePath);
        const expectedParent = await realpath(memoryDir);
        // Resolved path must be directly in memoryDir with the expected basename
        if (path.dirname(resolvedPath) !== expectedParent) continue;
        if (path.basename(resolvedPath) !== path.basename(spec.relativePath)) continue;
      }
    } catch {
      continue;
    }
    // Verify it's a file (not a directory)
    try {
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) continue;
    } catch {
      continue;
    }
    artifacts.push({
      kind: spec.kind,
      workspaceDir,
      relativePath: spec.relativePath,
      absolutePath,
      agentIds: [...agentIds],
      contentType: spec.contentType,
    });
  }

  // Deduplicate by (workspaceDir, relativePath, kind) — defensive against
  // overlapping scans or symlinks.
  const deduped = new Map<string, RemnicPublicArtifact>();
  for (const artifact of artifacts) {
    const key = [artifact.workspaceDir, artifact.relativePath, artifact.kind].join(
      String.fromCharCode(0),
    );
    deduped.set(key, artifact);
  }

  return [...deduped.values()];
}
