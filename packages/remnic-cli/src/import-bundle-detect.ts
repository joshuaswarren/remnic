// ---------------------------------------------------------------------------
// `remnic import --all-from-bundle <dir>` auto-detect (issue #568 slice 7)
// ---------------------------------------------------------------------------
//
// Given a directory, scan for known export-file names and match each one to
// the correct importer adapter. This lets users drop an unzipped ChatGPT /
// Claude / Takeout bundle into a single folder and run one command to
// import everything.
//
// Detection is intentionally simple and file-name-based:
//   - `memory.json`              → chatgpt (saved memories)
//   - `conversations.json`       → chatgpt OR claude; we pick by sibling
//                                  shape (prefer chatgpt mapping, else claude)
//   - `projects.json`            → claude
//   - `My Activity.json`         → gemini (also handles legacy `MyActivity.json`)
//   - `mem0.json`                → mem0 (offline replay dump)
//
// The scan walks one level deep (plus a single nested directory like
// `Takeout/Gemini/`) so users don't have to flatten their unzipped bundles.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SupportedImporterName } from "./optional-importer.js";

export const BUNDLE_SUPPORTED_IMPORTERS = [
  "chatgpt",
  "claude",
  "gemini",
  "mem0",
] as const satisfies readonly SupportedImporterName[];
export type BundleSupportedImporterName = (typeof BUNDLE_SUPPORTED_IMPORTERS)[number];

export interface DetectedBundleEntry {
  adapter: BundleSupportedImporterName;
  filePath: string;
  /**
   * Optional transform hint — e.g. a ChatGPT `conversations.json` should
   * typically be imported with `--include-conversations`, otherwise the
   * user paid the disk cost of a scan that produced zero memories.
   */
  includeConversations?: boolean;
}

export interface BundleDetectOptions {
  /** Override the default file walker for tests. */
  readdirImpl?: (dir: string) => string[];
  readFileImpl?: (p: string) => string;
  isDirectoryImpl?: (p: string) => boolean;
  /**
   * Report whether `p` is a regular file (not a symlink, device, etc.).
   * Defaults to `lstatSync(p).isFile()`. Injected for tests.
   */
  isRegularFileImpl?: (p: string) => boolean;
}

/**
 * Walk `bundleDir` (one level deep, plus one nested directory layer) and
 * return the list of importer entries to run. The order is stable across
 * BUNDLE_SUPPORTED_IMPORTERS so re-scans produce identical output.
 *
 * Returns an empty array when no known files are found. Callers are
 * responsible for surfacing "bundle was empty" to the user.
 */
export function detectBundleEntries(
  bundleDir: string,
  options: BundleDetectOptions = {},
): DetectedBundleEntry[] {
  const readdir = options.readdirImpl ?? defaultReaddir;
  const readFileImpl = options.readFileImpl ?? defaultReadFile;
  const isDirectory = options.isDirectoryImpl ?? defaultIsDirectory;
  // Codex review on PR #610 — when callers inject readdir/isDirectory
  // (the testing seam), we must NOT fall back to `lstatSync`-on-disk for
  // isRegularFile. That probes the real filesystem and filters out the
  // virtual paths produced by the injected walker, breaking the seam.
  // Derive a consistent regular-file probe from the injected traversal
  // layer: any entry that is not a directory (per `isDirectory`) and
  // appears in its parent's readdir listing is treated as a regular
  // file. Only fall back to `defaultIsRegularFile` (which probes disk)
  // when neither `readdir` nor `isDirectory` is injected.
  const isRegularFile =
    options.isRegularFileImpl ??
    (options.readdirImpl !== undefined || options.isDirectoryImpl !== undefined
      ? (p: string) => !isDirectory(p)
      : defaultIsRegularFile);

  // Codex review on PR #610 — reject a bundle root that is itself a
  // symlink. Otherwise a user-supplied `--all-from-bundle <symlink>`
  // would silently traverse into the symlink target, picking up files
  // outside the intended bundle tree. Tests inject walkers and skip
  // this check — only the default `lstatSync`-backed walker needs to
  // enforce it.
  if (options.readdirImpl === undefined && options.isDirectoryImpl === undefined) {
    try {
      const rootStat = lstatSync(bundleDir);
      if (rootStat.isSymbolicLink()) {
        throw new Error(
          `Bundle directory '${bundleDir}' is a symbolic link. Pass the resolved directory path instead.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Bundle directory")) {
        throw err;
      }
      // `lstatSync` throwing for a missing path is handled by the
      // readdir error path below.
    }
  }

  const roots = collectCandidatePaths(
    bundleDir,
    readdir,
    isDirectory,
    isRegularFile,
  );
  const entries: DetectedBundleEntry[] = [];
  const seenFiles = new Set<string>();
  for (const filePath of roots) {
    if (seenFiles.has(filePath)) continue;
    seenFiles.add(filePath);
    const name = path.basename(filePath);
    const match = classifyFile(name, filePath, readFileImpl);
    if (match) entries.push(match);
  }

  // Stable sort by (adapter preference order, file path).
  const adapterOrder = {
    chatgpt: 0,
    claude: 1,
    gemini: 2,
    mem0: 3,
  } satisfies Record<BundleSupportedImporterName, number>;
  entries.sort((a, b) => {
    const delta = adapterOrder[a.adapter] - adapterOrder[b.adapter];
    if (delta !== 0) return delta;
    if (a.filePath < b.filePath) return -1;
    if (a.filePath > b.filePath) return 1;
    return 0;
  });
  return entries;
}

const MAX_WALK_DEPTH = 4; // Takeout bundles nest ≥3 levels (Takeout/Gemini/…)

function collectCandidatePaths(
  root: string,
  readdir: (p: string) => string[],
  isDirectory: (p: string) => boolean,
  isRegularFile: (p: string) => boolean,
): string[] {
  // Validate top-level readability with a descriptive error; inner
  // directories that fail to read are skipped silently so a partial bundle
  // walk completes. Cursor's rule for CLAUDE.md rule 24: accept only real
  // directories; surfacing the failure here gives the user an immediate
  // actionable error.
  try {
    readdir(root);
  } catch {
    throw new Error(
      `Bundle directory '${root}' could not be read. Pass an existing directory.`,
    );
  }

  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: string[];
    try {
      entries = readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (isDirectory(full)) {
        walk(full, depth + 1);
      } else if (isRegularFile(full)) {
        // Codex review on PR #610 — reject symlink files as well as
        // symlink directories. A bundle containing e.g. a symlinked
        // `memory.json` could otherwise be followed to an arbitrary
        // filesystem location and imported as if it were part of the
        // bundle.
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function classifyFile(
  name: string,
  filePath: string,
  readFileImpl: (p: string) => string,
): DetectedBundleEntry | undefined {
  const lower = name.toLowerCase();
  if (lower === "memory.json") {
    return { adapter: "chatgpt", filePath };
  }
  if (lower === "projects.json") {
    return { adapter: "claude", filePath };
  }
  if (lower === "my activity.json" || lower === "myactivity.json") {
    return { adapter: "gemini", filePath };
  }
  if (lower === "mem0.json" || lower === "mem0-export.json") {
    return { adapter: "mem0", filePath };
  }
  if (lower === "conversations.json") {
    // ChatGPT vs Claude disambiguation: peek at the first element. ChatGPT
    // uses `mapping` objects; Claude uses `chat_messages` / `messages`.
    const adapter = disambiguateConversations(filePath, readFileImpl);
    return { adapter, filePath, includeConversations: true };
  }
  return undefined;
}

function disambiguateConversations(
  filePath: string,
  readFileImpl: (p: string) => string,
): BundleSupportedImporterName {
  try {
    const content = readFileImpl(filePath);
    const parsed = JSON.parse(content);
    const first = Array.isArray(parsed)
      ? parsed[0]
      : parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).conversations
        : undefined;
    const sample = Array.isArray(first) ? first[0] : first;
    if (sample && typeof sample === "object") {
      const obj = sample as Record<string, unknown>;
      if (obj.mapping && typeof obj.mapping === "object") return "chatgpt";
      if (Array.isArray(obj.chat_messages) || Array.isArray(obj.messages)) {
        return "claude";
      }
    }
  } catch {
    // If the file is unreadable or unparseable, default to chatgpt — the
    // adapter will surface its own error.
  }
  return "chatgpt";
}

function defaultReaddir(dir: string): string[] {
  return readdirSync(dir);
}

function defaultReadFile(p: string): string {
  return readFileSync(p, "utf-8");
}

function defaultIsDirectory(p: string): boolean {
  try {
    // Use lstatSync so symlinks never report as directories — we refuse
    // to recurse through them so a bundle can't contain a symlinked
    // directory that escapes to arbitrary filesystem locations. Codex
    // review on PR #610.
    const s = lstatSync(p);
    if (s.isSymbolicLink()) return false;
    return s.isDirectory();
  } catch {
    return false;
  }
}

function defaultIsRegularFile(p: string): boolean {
  try {
    // Use lstatSync so symlinks never report as regular files. Codex
    // review on PR #610: a bundle containing a symlinked `memory.json`
    // (or any other known filename) must NOT be followed — otherwise
    // the importer could be tricked into reading arbitrary filesystem
    // locations. Reject symlink files here so classifyFile() never
    // sees them.
    const s = lstatSync(p);
    if (s.isSymbolicLink()) return false;
    return s.isFile();
  } catch {
    return false;
  }
}
