import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionNamespaceBindingStore {
  namespacesFor(sessionKey: string): Promise<string[]>;
  remember(sessionKey: string, namespace: string): Promise<void>;
}

export const SESSION_NAMESPACE_BINDING_MAX_ENTRIES = 1_000;
export const SESSION_NAMESPACE_BINDING_MAX_NAMESPACES = 64;
export const SESSION_NAMESPACE_BINDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

interface NamespaceBindingEntry {
  namespaces: string[];
  updatedAt: string;
}

interface NamespaceBindingFile {
  version: 1;
  entries: Record<string, NamespaceBindingEntry>;
}
type BindingFileWriter = (filePath: string, bindings: NamespaceBindingFile) => Promise<void>;

const fileWriteChains = new Map<string, Promise<void>>();

function emptyBindingFile(): NamespaceBindingFile {
  return { version: 1, entries: Object.create(null) as Record<string, NamespaceBindingEntry> };
}

function capNamespaceHistory(namespaces: string[]): string[] {
  return namespaces.length > SESSION_NAMESPACE_BINDING_MAX_NAMESPACES
    ? namespaces.slice(-SESSION_NAMESPACE_BINDING_MAX_NAMESPACES)
    : namespaces;
}

function normalizeNamespaces(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const namespaces: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const namespace = entry.trim();
    const existing = namespaces.indexOf(namespace);
    if (existing >= 0) namespaces.splice(existing, 1);
    namespaces.push(namespace);
  }
  return capNamespaceHistory(namespaces);
}

function addNamespace(namespaces: string[], namespace: string): string[] {
  const normalized = namespace.trim();
  return capNamespaceHistory([
    ...namespaces.filter((candidate) => candidate !== normalized),
    normalized,
  ]);
}

function pruneBindingEntries(
  entries: Record<string, NamespaceBindingEntry>,
  protectedKey?: string
): Record<string, NamespaceBindingEntry> {
  const cutoff = Date.now() - SESSION_NAMESPACE_BINDING_MAX_AGE_MS;
  const retained = Object.entries(entries)
    .filter(([_key, entry]) => {
      const updatedAt = Date.parse(entry.updatedAt);
      return Number.isFinite(updatedAt) && updatedAt >= cutoff;
    })
    .sort(([leftKey, left], [rightKey, right]) => {
      if (leftKey === protectedKey) return -1;
      if (rightKey === protectedKey) return 1;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    })
    .slice(0, SESSION_NAMESPACE_BINDING_MAX_ENTRIES);
  const pruned = Object.create(null) as Record<string, NamespaceBindingEntry>;
  for (const [key, entry] of retained) pruned[key] = entry;
  return pruned;
}

function encodeSessionKey(sessionKey: string): string {
  return encodeURIComponent(sessionKey);
}

async function readBindingFile(filePath: string): Promise<NamespaceBindingFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<NamespaceBindingFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.entries || typeof parsed.entries !== "object") {
      return emptyBindingFile();
    }
    const entries = Object.create(null) as Record<string, NamespaceBindingEntry>;
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<NamespaceBindingEntry>;
      if (typeof entry.updatedAt !== "string") continue;
      const namespaces = normalizeNamespaces(entry.namespaces);
      if (namespaces.length === 0) continue;
      entries[key] = { namespaces, updatedAt: entry.updatedAt };
    }
    return { version: 1, entries: pruneBindingEntries(entries) };
  } catch {
    return emptyBindingFile();
  }
}

async function writeBindingFile(filePath: string, bindings: NamespaceBindingFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(bindings, null, 2), "utf8");
  await rename(temporaryPath, filePath);
}

async function queueFileWrite<TResult>(
  filePath: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const prior = fileWriteChains.get(filePath) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(operation);
  fileWriteChains.set(
    filePath,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function createInMemorySessionNamespaceBindingStore(): SessionNamespaceBindingStore {
  const entries = new Map<string, string[]>();
  return {
    async namespacesFor(sessionKey: string): Promise<string[]> {
      const namespaces = entries.get(sessionKey);
      if (namespaces === undefined) return [];
      entries.delete(sessionKey);
      entries.set(sessionKey, namespaces);
      return [...namespaces];
    },
    async remember(sessionKey: string, namespace: string): Promise<void> {
      const existing = entries.get(sessionKey) ?? [];
      entries.delete(sessionKey);
      entries.set(sessionKey, addNamespace(existing, namespace));
      while (entries.size > SESSION_NAMESPACE_BINDING_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (typeof oldest !== "string") break;
        entries.delete(oldest);
      }
    },
  };
}

export function createFileSessionNamespaceBindingStore(
  filePath: string,
  options: { writeBindingFile?: BindingFileWriter } = {},
): SessionNamespaceBindingStore {
  const write = options.writeBindingFile ?? writeBindingFile;
  return {
    async namespacesFor(sessionKey: string): Promise<string[]> {
      const key = encodeSessionKey(sessionKey);
      return queueFileWrite(filePath, async () => {
        const bindings = await readBindingFile(filePath);
        const entry = bindings.entries[key];
        if (entry === undefined) return [];
        const namespaces = [...entry.namespaces];
        entry.updatedAt = new Date().toISOString();
        bindings.entries = pruneBindingEntries(bindings.entries, key);
        try {
          await write(filePath, bindings);
        } catch {
          return namespaces;
        }
        return namespaces;
      });
    },
    async remember(sessionKey: string, namespace: string): Promise<void> {
      const key = encodeSessionKey(sessionKey);
      await queueFileWrite(filePath, async () => {
        const bindings = await readBindingFile(filePath);
        const existing = bindings.entries[key]?.namespaces ?? [];
        bindings.entries[key] = {
          namespaces: addNamespace(existing, namespace),
          updatedAt: new Date().toISOString(),
        };
        bindings.entries = pruneBindingEntries(bindings.entries, key);
        await write(filePath, bindings);
      });
    },
  };
}
