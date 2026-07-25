import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionNamespaceBindingStore {
  namespacesFor(sessionKey: string): Promise<string[]>;
  remember(sessionKey: string, namespace: string): Promise<void>;
}

interface NamespaceBindingEntry {
  namespaces: string[];
  updatedAt: string;
}

interface NamespaceBindingFile {
  version: 1;
  entries: Record<string, NamespaceBindingEntry>;
}

const fileWriteChains = new Map<string, Promise<void>>();

function emptyBindingFile(): NamespaceBindingFile {
  return { version: 1, entries: Object.create(null) as Record<string, NamespaceBindingEntry> };
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
  return namespaces;
}

function addNamespace(namespaces: string[], namespace: string): string[] {
  const normalized = namespace.trim();
  return [...namespaces.filter((candidate) => candidate !== normalized), normalized];
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
    return { version: 1, entries };
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

async function queueFileWrite(filePath: string, operation: () => Promise<void>): Promise<void> {
  const prior = fileWriteChains.get(filePath) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(operation);
  fileWriteChains.set(
    filePath,
    run.catch(() => undefined)
  );
  await run;
}

export function createInMemorySessionNamespaceBindingStore(): SessionNamespaceBindingStore {
  const entries = new Map<string, string[]>();
  return {
    async namespacesFor(sessionKey: string): Promise<string[]> {
      return [...(entries.get(sessionKey) ?? [])];
    },
    async remember(sessionKey: string, namespace: string): Promise<void> {
      entries.set(sessionKey, addNamespace(entries.get(sessionKey) ?? [], namespace));
    },
  };
}

export function createFileSessionNamespaceBindingStore(filePath: string): SessionNamespaceBindingStore {
  return {
    async namespacesFor(sessionKey: string): Promise<string[]> {
      await (fileWriteChains.get(filePath) ?? Promise.resolve()).catch(() => undefined);
      const bindings = await readBindingFile(filePath);
      return [...(bindings.entries[encodeSessionKey(sessionKey)]?.namespaces ?? [])];
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
        await writeBindingFile(filePath, bindings);
      });
    },
  };
}
