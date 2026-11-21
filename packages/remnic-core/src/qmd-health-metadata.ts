import { createHash } from "node:crypto";
import path from "node:path";
import type { OperationalSearchHealth } from "./search/port.js";

// QMD health schema v1's native-owned input contract; no config parsing here.
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

function identity(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (const c of value) {
    if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
  }
  return true;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function environmentIdentity(env: NodeJS.ProcessEnv, cwd: string): string {
  return identity([cwd, ENVIRONMENT_NAMES.map(name => [name, env[name] ?? null])]);
}

/** Capability absence is negotiated by the session, never inferred from a broken snapshot. */
export function parseOperationalHealth(
  result: unknown,
  collection: string,
  memoryDir: string,
  beforeEnv: NodeJS.ProcessEnv,
  afterEnv: NodeJS.ProcessEnv,
  beforeCwd: string,
  afterCwd: string,
): OperationalSearchHealth {
  if (!record(result) || ("isError" in result && result.isError !== false)) return UNKNOWN_OPERATIONAL_HEALTH;
  const content = result.structuredContent;
  if (!record(content) || !Object.prototype.hasOwnProperty.call(content, "health")) return UNKNOWN_OPERATIONAL_HEALTH;
  const health = content.health;
  if (!record(health) || health.schemaVersion !== 1 ||
    ("unavailable" in health && health.unavailable !== false)) {
    return UNKNOWN_OPERATIONAL_HEALTH;
  }
  const environment = health.environment;
  const active = health.active;
  const current = health.current;
  const catalog = health.catalog;
  if (
    !record(environment) || !Array.isArray(environment.names) ||
    environment.names.length !== ENVIRONMENT_NAMES.length ||
    !environment.names.every((name, i) => name === ENVIRONMENT_NAMES[i]) ||
    !digest(environment.digest) ||
    environment.digest !== environmentIdentity(beforeEnv, beforeCwd) ||
    environment.digest !== environmentIdentity(afterEnv, afterCwd) ||
    !record(active) || !record(current) ||
    !digest(active.index) || !digest(current.index) || active.index !== current.index ||
    !digest(active.configuration) || !digest(current.configuration) ||
    !digest(active.embeddingModel) || !digest(current.embeddingModel) ||
    health.countModel !== active.embeddingModel || !count(health.pendingEmbeddings) ||
    !record(catalog) || catalog.complete !== true || !Array.isArray(catalog.entries)
  ) return UNKNOWN_OPERATIONAL_HEALTH;

  const targetName = identity(collection);
  const names = new Set<string>();
  let target: Record<string, unknown> | undefined;
  for (const entry of catalog.entries) {
    if (!record(entry) || !digest(entry.name) || !digest(entry.path) ||
      !count(entry.documents) || names.has(entry.name)) return UNKNOWN_OPERATIONAL_HEALTH;
    names.add(entry.name);
    if (entry.name === targetName) target = entry;
  }
  // A freshly removed collection cannot be resurrected by the old active catalog.
  if (!target) return { ...UNKNOWN_OPERATIONAL_HEALTH, collectionState: "missing" };
  if (
    target.path !== identity(path.resolve(memoryDir)) ||
    active.configuration !== current.configuration ||
    active.embeddingModel !== current.embeddingModel
  ) return UNKNOWN_OPERATIONAL_HEALTH;

  return {
    collectionState: "present",
    pendingEmbeddings: health.pendingEmbeddings,
    oldestPendingAgeMs: null,
    totalFiles: target.documents as number,
    embeddedFiles: null,
  };
}
