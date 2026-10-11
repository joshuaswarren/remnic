import path from "node:path";

export type OfflineSyncDigestCacheEntry = {
  statBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  encrypted: boolean;
  sha256: string;
  bytes: number;
};

export function parseOfflineSyncDigestCache(raw: string): Map<string, OfflineSyncDigestCacheEntry> {
  const cache = new Map<string, OfflineSyncDigestCacheEntry>();
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return cache;
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return cache;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const cachePath = typeof record.path === "string" ? record.path : "";
    const statBytes = typeof record.statBytes === "number" ? record.statBytes : Number.NaN;
    const mtimeMs = typeof record.mtimeMs === "number" ? record.mtimeMs : Number.NaN;
    const ctimeMs = typeof record.ctimeMs === "number" ? record.ctimeMs : Number.NaN;
    const bytes = typeof record.bytes === "number" ? record.bytes : Number.NaN;
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
    const encrypted = record.encrypted === true;
    if (
      cachePath.length === 0 ||
      cachePath === ".." ||
      cachePath.startsWith("../") ||
      path.isAbsolute(cachePath) ||
      !Number.isFinite(statBytes) ||
      !Number.isFinite(mtimeMs) ||
      !Number.isFinite(ctimeMs) ||
      !Number.isFinite(bytes) ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      continue;
    }
    cache.set(cachePath, { statBytes, mtimeMs, ctimeMs, encrypted, sha256, bytes });
  }
  return cache;
}
