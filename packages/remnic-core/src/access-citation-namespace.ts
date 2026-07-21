import * as nodePath from "node:path";
import { isPathInsideStorageRoot } from "./storage-paths.js";
import { ALL_CATEGORY_DIRS } from "./utils/category-dir.js";

/** Minimal storage surface the citation namespace decoder probes. */
interface CitationProbeStorage {
  dir: string;
  readMemoryByPath(filePath: string): Promise<unknown | null>;
}

type CitationStorageResolver = (namespace: string) => Promise<CitationProbeStorage>;

/**
 * Probe whether `namespace` actually stores a memory at the cited relative
 * path (#2077). Used to disambiguate a namespace whose name equals a memory
 * category dir (e.g. `facts`) from a bare default category lead: a namespaced
 * citation `facts/facts/a.md` (namespace `facts`, remaining `facts/a.md`) is
 * owned, while a default `facts/a.md` (remaining `a.md`, no category dir) is
 * not. Returns false on any resolution/read failure or path escape.
 */
async function namespaceOwnsRelativePath(
  getStorage: CitationStorageResolver,
  namespace: string,
  relativePath: string,
): Promise<boolean> {
  const remainder = relativePath === namespace ? "" : relativePath.slice(namespace.length + 1);
  if (!remainder) return false;
  let storage: CitationProbeStorage;
  try {
    storage = await getStorage(namespace);
  } catch {
    return false;
  }
  const storageRoot = nodePath.resolve(storage.dir);
  const candidate = nodePath.resolve(storageRoot, remainder);
  if (!isPathInsideStorageRoot(storageRoot, candidate)) return false;
  const memory = await storage.readMemoryByPath(candidate).catch(() => null);
  return memory !== null;
}

/**
 * Resolve which authorized namespace owns a *relative* cited path.
 *
 * Attributes to the longest authorized namespace that prefixes the cited path
 * (namespace names may contain "/"). A bare category lead like a default
 * `facts/a.md` is not a namespace. A namespace whose name equals a category dir
 * (e.g. `facts`, rendered `facts/facts/a.md`) is ambiguous with that bare lead,
 * so it counts only when its storage actually owns the remaining relative path
 * (#2077). Falls back to `fallbackNamespace` when nothing matches.
 */
export async function decodeCitationNamespace(
  getStorage: CitationStorageResolver,
  authorizedNamespaces: readonly string[],
  memoryPath: string,
  fallbackNamespace: string,
): Promise<string> {
  let nsMatch = "";
  for (const ns of authorizedNamespaces) {
    if (!ns) continue;
    const isPrefix = memoryPath === ns || memoryPath.startsWith(`${ns}/`);
    if (!isPrefix || ns.length <= nsMatch.length) continue;
    if (ALL_CATEGORY_DIRS.includes(ns) && !(await namespaceOwnsRelativePath(getStorage, ns, memoryPath))) {
      continue;
    }
    nsMatch = ns;
  }
  return nsMatch || fallbackNamespace;
}
