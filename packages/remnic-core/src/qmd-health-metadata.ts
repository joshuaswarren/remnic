import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { JsonValue } from "./extraction-reply-diagnostic.js";
import type { OperationalSearchHealth } from "./search/port.js";

const ENVIRONMENT_NAMES = [
  "HOME", "USERPROFILE", "PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "QMD_CONFIG_DIR", "INDEX_PATH", "QMD_EMBED_MODEL", "QMD_GENERATE_MODEL",
  "QMD_RERANK_MODEL", "QMD_FORCE_CPU", "QMD_LLAMA_GPU", "QMD_EMBED_PARALLELISM",
  "QMD_EMBED_CONTEXT_SIZE", "QMD_EXPAND_CONTEXT_SIZE", "QMD_RERANK_CONTEXT_SIZE", "QMD_SOURCE_MODE",
  "PWD", "WSL_DISTRO_NAME", "WSL_INTEROP",
];

export const UNKNOWN_OPERATIONAL_HEALTH: OperationalSearchHealth = Object.freeze({
  collectionState: "unknown",
  pendingEmbeddings: null,
  oldestPendingAgeMs: null,
  totalFiles: null,
  embeddedFiles: null,
});

function identity(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const binding = z.object({ index: digest, configuration: digest, embeddingModel: digest });
const catalogEntry = z.object({ name: digest, path: digest, documents: count });
export const qmdHealthResponseSchema = z.object({
  isError: z.literal(false).optional(),
  structuredContent: z.object({
    health: z.object({
      schemaVersion: z.literal(1),
      unavailable: z.literal(false).optional(),
      environment: z.object({ names: z.array(z.string()), digest }),
      active: binding,
      current: binding,
      countModel: digest,
      pendingEmbeddings: count,
      catalog: z.object({ complete: z.literal(true), entries: z.array(catalogEntry) }),
    }),
  }),
});

function environmentIdentity(env: NodeJS.ProcessEnv, cwd: string): string {
  return identity([cwd, ENVIRONMENT_NAMES.map(name => [name, env[name] ?? null])]);
}

export function parseOperationalHealth(
  result: z.infer<typeof qmdHealthResponseSchema> | undefined,
  collection: string,
  memoryDir: string,
  beforeEnv: NodeJS.ProcessEnv,
  afterEnv: NodeJS.ProcessEnv,
  beforeCwd: string,
  afterCwd: string,
): OperationalSearchHealth {
  if (!result) return UNKNOWN_OPERATIONAL_HEALTH;
  const { active, current, catalog, countModel, pendingEmbeddings, environment } = result.structuredContent.health;
  if (
    environment.names.length !== ENVIRONMENT_NAMES.length ||
    !environment.names.every((name, i) => name === ENVIRONMENT_NAMES[i]) ||
    environment.digest !== environmentIdentity(beforeEnv, beforeCwd) ||
    environment.digest !== environmentIdentity(afterEnv, afterCwd) ||
    active.index !== current.index || countModel !== active.embeddingModel
  ) return UNKNOWN_OPERATIONAL_HEALTH;

  const targetName = identity(collection);
  const names = new Set<string>();
  let target: z.infer<typeof catalogEntry> | undefined;
  for (const entry of catalog.entries) {
    if (names.has(entry.name)) return UNKNOWN_OPERATIONAL_HEALTH;
    names.add(entry.name);
    if (entry.name === targetName) target = entry;
  }
  if (!target) return { ...UNKNOWN_OPERATIONAL_HEALTH, collectionState: "missing" };
  if (
    target.path !== identity(path.resolve(memoryDir)) ||
    active.configuration !== current.configuration ||
    active.embeddingModel !== current.embeddingModel
  ) return UNKNOWN_OPERATIONAL_HEALTH;

  return {
    collectionState: "present",
    pendingEmbeddings,
    oldestPendingAgeMs: null,
    totalFiles: target.documents,
    embeddedFiles: null,
  };
}
