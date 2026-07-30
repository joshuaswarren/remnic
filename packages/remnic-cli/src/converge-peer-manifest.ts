import { isInternalRemnicStatePath } from "@remnic/core";
import {
  RECONCILE_MANIFEST_FORMAT,
  RECONCILE_MANIFEST_SCHEMA_VERSION,
  type ReconcileManifest,
  type ReconcileManifestFile,
  type ReconcileMemoryIdentity,
} from "@remnic/core/reconcile/manifest.js";
import type { MemoryStatus } from "@remnic/core/types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MEMORY_STATUSES = new Set<MemoryStatus>([
  "active",
  "pending_review",
  "rejected",
  "quarantined",
  "superseded",
  "archived",
  "forgotten",
]);
const BODY_FIELDS = ["body", "content", "contentBase64", "rawContent"] as const;

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertBodyFree(value: Record<string, unknown>, message: string): void {
  if (BODY_FIELDS.some((field) => field in value)) throw new Error(message);
}

function optionalNonNegativeNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`peer manifest file had invalid ${name}`);
  }
  return value;
}

function parseMemory(value: unknown): ReconcileMemoryIdentity | undefined {
  if (value === undefined) return undefined;
  const memory = record(value, "peer manifest file had malformed memory metadata");
  assertBodyFree(memory, "peer manifest memory metadata contained a raw body");
  if (typeof memory.id !== "string" || memory.id.length === 0) {
    throw new Error("peer manifest memory metadata had invalid id");
  }
  if (typeof memory.category !== "string" || memory.category.length === 0) {
    throw new Error("peer manifest memory metadata had invalid category");
  }
  if (typeof memory.contentHash !== "string" || !SHA256_PATTERN.test(memory.contentHash)) {
    throw new Error("peer manifest memory metadata had invalid contentHash");
  }
  if (typeof memory.status !== "string" || !MEMORY_STATUSES.has(memory.status as MemoryStatus)) {
    throw new Error("peer manifest memory metadata had invalid status");
  }
  return {
    id: memory.id,
    category: memory.category,
    contentHash: memory.contentHash.toLowerCase(),
    status: memory.status as MemoryStatus,
  };
}

function parseFile(value: unknown): ReconcileManifestFile | undefined {
  const file = record(value, "peer manifest row had malformed file metadata");
  assertBodyFree(file, "peer manifest file row contained a raw body");
  if (typeof file.path !== "string" || file.path.length === 0) {
    throw new Error("peer manifest file had invalid path");
  }
  if (isInternalRemnicStatePath(file.path)) return undefined;
  if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
    throw new Error("peer manifest file had invalid sha256");
  }
  const bytes = optionalNonNegativeNumber(file.bytes, "bytes");
  const mtimeMs = optionalNonNegativeNumber(file.mtimeMs, "mtimeMs");
  const memory = parseMemory(file.memory);
  return {
    path: file.path,
    sha256: file.sha256.toLowerCase(),
    ...(bytes === undefined ? {} : { bytes }),
    ...(mtimeMs === undefined ? {} : { mtimeMs }),
    ...(memory === undefined ? {} : { memory }),
  };
}

async function* responseLines(response: Response): AsyncIterable<string> {
  if (!response.body) throw new Error("peer manifest response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.trim().length > 0) yield line;
        newline = pending.indexOf("\n");
      }
      if (done) break;
    }
    if (pending.trim().length > 0) yield pending.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export async function parsePeerManifestStream(
  response: Response,
  expectedNamespace: string,
): Promise<ReconcileManifest> {
  let headerSeen = false;
  const files: ReconcileManifestFile[] = [];
  for await (const line of responseLines(response)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`invalid peer manifest for namespace ${expectedNamespace}: row was not JSON`);
    }
    const row = record(value, `invalid peer manifest for namespace ${expectedNamespace}: row was not an object`);
    assertBodyFree(row, `invalid peer manifest for namespace ${expectedNamespace}: row contained a raw body`);
    if (!headerSeen) {
      if (
        row.type !== "manifest"
        || row.namespace !== expectedNamespace
        || row.format !== RECONCILE_MANIFEST_FORMAT
        || row.schemaVersion !== RECONCILE_MANIFEST_SCHEMA_VERSION
      ) {
        throw new Error(`invalid peer manifest for namespace ${expectedNamespace}: malformed header`);
      }
      headerSeen = true;
      continue;
    }
    if (row.type !== "file") {
      throw new Error(`invalid peer manifest for namespace ${expectedNamespace}: malformed row type`);
    }
    const file = parseFile(row.file);
    if (file) files.push(file);
  }
  if (!headerSeen) throw new Error(`invalid peer manifest for namespace ${expectedNamespace}: missing header`);
  return {
    format: RECONCILE_MANIFEST_FORMAT,
    schemaVersion: RECONCILE_MANIFEST_SCHEMA_VERSION,
    files,
  };
}
