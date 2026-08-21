import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionToggleStore {
  isDisabled(sessionKey: string, agentId: string): Promise<boolean>;
  resolve(sessionKey: string, agentId: string): Promise<{
    disabled: boolean;
    source: "primary" | "secondary" | "none";
    updatedAt?: string;
  }>;
  setDisabled(sessionKey: string, agentId: string, disabled: boolean): Promise<void>;
  clear(sessionKey: string, agentId: string): Promise<void>;
  list(): Promise<Array<{ sessionKey: string; agentId: string; disabled: boolean; updatedAt: string }>>;
}

interface ToggleEntry {
  disabled: boolean;
  updatedAt: string;
}

interface ToggleFile {
  version: 1;
  entries: Record<string, ToggleEntry>;
}

interface FileToggleStoreOptions {
  secondaryReadOnlyPath?: string;
}

const TOGGLE_KEY_SEPARATOR = "::";

function encodeToggleComponent(value: string): string {
  return encodeURIComponent(value).replaceAll(":", "%3A");
}

function encodeToggleKey(sessionKey: string, agentId: string): string {
  return `${encodeToggleComponent(sessionKey)}${TOGGLE_KEY_SEPARATOR}${encodeToggleComponent(agentId)}`;
}

function encodeLegacyToggleKey(sessionKey: string, agentId: string): string {
  return `${encodeURIComponent(sessionKey)}${TOGGLE_KEY_SEPARATOR}${encodeURIComponent(agentId)}`;
}

function toggleKeyCandidates(sessionKey: string, agentId: string): string[] {
  const key = encodeToggleKey(sessionKey, agentId);
  const legacyKey = encodeLegacyToggleKey(sessionKey, agentId);
  return key === legacyKey ? [key] : [key, legacyKey];
}

function decodeToggleKey(key: string): { sessionKey: string; agentId: string } | null {
  const parts = key.split(TOGGLE_KEY_SEPARATOR);
  if (parts.length !== 2) return null;
  const [encodedSessionKey, encodedAgentId] = parts;
  if (!encodedSessionKey || !encodedAgentId) return null;
  try {
    return {
      sessionKey: decodeURIComponent(encodedSessionKey),
      agentId: decodeURIComponent(encodedAgentId),
    };
  } catch {
    return null;
  }
}

async function safeReadToggleFile(filePath: string): Promise<ToggleFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ToggleFile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(parsed.entries).filter(
          ([, value]) =>
            value &&
            typeof value === "object" &&
            typeof value.disabled === "boolean" &&
            typeof value.updatedAt === "string",
        ),
      ) as Record<string, ToggleEntry>,
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

export function createFileToggleStore(
  filePath: string,
  options: FileToggleStoreOptions = {},
): SessionToggleStore {
  let writeChain = Promise.resolve();

  async function queueWrite(operation: () => Promise<void>): Promise<void> {
    const run = writeChain.catch(() => undefined).then(operation);
    writeChain = run.catch(() => undefined);
    await run;
  }

  async function writeToggleFile(next: ToggleFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
  }

  async function readPrimary(): Promise<ToggleFile> {
    return safeReadToggleFile(filePath);
  }

  async function readSecondary(): Promise<ToggleFile> {
    if (!options.secondaryReadOnlyPath) return { version: 1, entries: {} };
    return safeReadToggleFile(options.secondaryReadOnlyPath);
  }

  return {
    async isDisabled(sessionKey: string, agentId: string): Promise<boolean> {
      const resolved = await this.resolve(sessionKey, agentId);
      return resolved.disabled;
    },

    async resolve(sessionKey: string, agentId: string) {
      const keys = toggleKeyCandidates(sessionKey, agentId);
      const primary = await readPrimary();
      const primaryKey = keys.find((key) => primary.entries[key]);
      if (primaryKey) {
        return {
          disabled: primary.entries[primaryKey].disabled,
          source: "primary" as const,
          updatedAt: primary.entries[primaryKey].updatedAt,
        };
      }
      const secondary = await readSecondary();
      const secondaryKey = keys.find((key) => secondary.entries[key]);
      if (secondaryKey) {
        return {
          disabled: secondary.entries[secondaryKey].disabled,
          source: "secondary" as const,
          updatedAt: secondary.entries[secondaryKey].updatedAt,
        };
      }
      return { disabled: false, source: "none" as const };
    },

    async setDisabled(sessionKey: string, agentId: string, disabled: boolean): Promise<void> {
      const key = encodeToggleKey(sessionKey, agentId);
      await queueWrite(async () => {
        const current = await readPrimary();
        current.entries[key] = {
          disabled,
          updatedAt: new Date().toISOString(),
        };
        await writeToggleFile(current);
      });
    },

    async clear(sessionKey: string, agentId: string): Promise<void> {
      const keys = toggleKeyCandidates(sessionKey, agentId);
      await queueWrite(async () => {
        const current = await readPrimary();
        for (const key of keys) {
          delete current.entries[key];
        }
        await writeToggleFile(current);
      });
    },

    async list() {
      const current = await readPrimary();
      return Object.entries(current.entries)
        .map(([key, value]) => {
          const decoded = decodeToggleKey(key);
          if (!decoded) return null;
          return {
            sessionKey: decoded.sessionKey,
            agentId: decoded.agentId,
            disabled: value.disabled,
            updatedAt: value.updatedAt,
          };
        })
        .filter((value): value is { sessionKey: string; agentId: string; disabled: boolean; updatedAt: string } =>
          value !== null
        );
    },
  };
}
