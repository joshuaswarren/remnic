import { createHash } from "node:crypto";
import {
  isInternalRemnicStatePath,
  OFFLINE_SYNC_CHANGESET_FORMAT,
  OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
  OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
} from "@remnic/core";
import { normalizeConvergePeerUrl } from "@remnic/core/reconcile/cursor.js";
import type { ReconcileFileState } from "@remnic/core/reconcile/plan.js";
import type { ReconcileManifest } from "@remnic/core/reconcile/manifest.js";
import { parsePeerManifestStream } from "./converge-peer-manifest.js";

export const DEFAULT_PEER_REQUEST_TIMEOUT_MS = 30_000;
// Re-exported so the CLI can resolve flag > config > env > default once.
export { envConvergePeerRequestTimeoutMs } from "@remnic/core";

function normalizePeerBaseUrl(peerUrl: string): string {
  const normalized = normalizeConvergePeerUrl(peerUrl);
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported peer URL protocol: ${url.protocol}`);
  }
  return normalized;
}

function assertTransferablePeerPath(filePath: string): void {
  if (isInternalRemnicStatePath(filePath)) {
    throw new Error(`peer transport rejects internal Remnic state path: ${filePath}`);
  }
}

async function fetchPeerRequest(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetchImpl(input, { ...init, signal });
}

export interface PeerSyncCapabilities {
  convergenceFinalization: boolean;
  manifestStream: boolean;
  /** Peer's process.platform when advertised (older peers omit it). */
  platform?: string;
  /**
   * Peer-advertised identity of the manifest implementation that builds its
   * streamed manifests (#2803 review). Older peers omit it — clients must
   * not reuse cached peer manifests from an unversioned peer.
   */
  manifestRevision?: string;
}

export async function fetchPeerSyncCapabilities(
  peerUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<PeerSyncCapabilities | null> {
  const base = normalizePeerBaseUrl(peerUrl);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const routes = ["/remnic/v1/offline-sync/capabilities", "/engram/v1/offline-sync/capabilities"];
  for (const route of routes) {
    const response = await fetchPeerRequest(fetchImpl, `${base}${route}`, { headers }, timeoutMs);
    if (response.status === 404 || response.status === 405) continue;
    if (response.status === 401 || response.status === 403) {
      throw new Error(`peer capability authentication failed: HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`peer capability request failed: HTTP ${response.status}`);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (
      !payload ||
      typeof payload !== "object" ||
      !("convergenceFinalization" in payload) ||
      typeof payload.convergenceFinalization !== "boolean" ||
      !("manifestStream" in payload) ||
      typeof payload.manifestStream !== "boolean"
    ) {
      throw new Error("peer capability response was malformed");
    }
    const platform = "platform" in payload && typeof payload.platform === "string" ? payload.platform : undefined;
    const manifestRevision =
      "manifestRevision" in payload && typeof payload.manifestRevision === "string" ? payload.manifestRevision : undefined;
    return {
      convergenceFinalization: payload.convergenceFinalization,
      manifestStream: payload.manifestStream,
      ...(platform !== undefined ? { platform } : {}),
      ...(manifestRevision !== undefined && manifestRevision.length > 0 ? { manifestRevision } : {}),
    };
  }
  return null;
}
export async function fetchPeerManifestStream(
  peerUrl: string,
  namespace: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS
): Promise<ReconcileManifest | null> {
  const base = normalizePeerBaseUrl(peerUrl);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const routes = [
    `/remnic/v1/offline-sync/manifest-stream?namespace=${encodeURIComponent(namespace)}&include_transcripts=false`,
    `/engram/v1/offline-sync/manifest-stream?namespace=${encodeURIComponent(namespace)}&include_transcripts=false`,
  ];
  for (const route of routes) {
    const response = await fetchPeerRequest(fetchImpl, `${base}${route}`, { headers }, timeoutMs);
    if (response.status === 404 || response.status === 405) continue;
    if (response.status === 401 || response.status === 403) {
      throw new Error(`peer manifest authentication failed: HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`peer manifest request failed: HTTP ${response.status}`);
    return parsePeerManifestStream(response, namespace);
  }
  return null;
}

export async function fetchPeerSnapshot(
  peerUrl: string,
  namespace: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS
): Promise<{
  files: ReconcileFileState[];
  tombstones: Set<string>;
}> {
  const base = normalizePeerBaseUrl(peerUrl);
  const routes = [
    // The snapshot validates the cached peer manifest, whose file set
    // excludes transcripts (the manifest-stream and transfer routes pin
    // include_transcripts=false). Requesting the server's default
    // transcript-inclusive set would make the watermark/fileCount cache
    // check compare different sets and never hit (#2927).
    `/remnic/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&include_transcripts=false&content=false`,
    `/engram/v1/offline-sync/snapshot?namespace=${encodeURIComponent(namespace)}&include_transcripts=false&content=false`,
  ];
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  let lastFailure = "no snapshot route responded";

  for (const route of routes) {
    let response: Response;
    try {
      response = await fetchPeerRequest(fetchImpl, `${base}${route}`, { headers }, timeoutMs);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!response.ok) {
      lastFailure = `HTTP ${response.status}`;
      continue;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: response was not JSON`);
    }
    if (!data || typeof data !== "object" || !("files" in data) || !Array.isArray(data.files)) {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: files must be an array`);
    }

    const files: ReconcileFileState[] = data.files
      .map((item, index) => {
        if (
          !item ||
          typeof item !== "object" ||
          !("path" in item) ||
          typeof item.path !== "string" ||
          !("sha256" in item) ||
          typeof item.sha256 !== "string"
        ) {
          throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed file at index ${index}`);
        }
        return {
          path: item.path,
          sha256: item.sha256,
          mtimeMs: "mtimeMs" in item && typeof item.mtimeMs === "number" ? item.mtimeMs : undefined,
          bytes: "bytes" in item && typeof item.bytes === "number" ? item.bytes : undefined,
        };
      })
      .filter((file) => !isInternalRemnicStatePath(file.path));

    const rawTombstones = "tombstones" in data ? data.tombstones : undefined;
    if (rawTombstones !== undefined && !Array.isArray(rawTombstones)) {
      throw new Error(`invalid peer snapshot for namespace ${namespace}: tombstones must be an array`);
    }
    const tombstones = new Set<string>();
    for (const tombstone of rawTombstones ?? []) {
      if (typeof tombstone !== "string" || !/^[0-9a-f]{64}$/i.test(tombstone)) {
        throw new Error(`invalid peer snapshot for namespace ${namespace}: malformed tombstone`);
      }
      tombstones.add(tombstone.toLowerCase());
    }
    return { files, tombstones };
  }

  throw new Error(`failed to fetch peer snapshot for namespace ${namespace}: ${lastFailure}`);
}

export interface PeerFileContent {
  content: Buffer;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

function requiredResponseNumber(response: Response, name: string): number {
  const raw = response.headers.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`offline file content response had invalid ${name}`);
  }
  return value;
}

export interface PeerFileChunk {
  content: Buffer;
  offset: number;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

export async function streamPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  onChunk: (chunk: PeerFileChunk) => Promise<void>,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS,
  /** Apply-phase cancellation (#2803 review): aborts the in-flight request. */
  signal?: AbortSignal
): Promise<Omit<PeerFileContent, "content"> | null> {
  assertTransferablePeerPath(filePath);
  const base = normalizePeerBaseUrl(peerUrl);
  const routes = ["/remnic/v1/offline-sync/file-content", "/engram/v1/offline-sync/file-content"];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const hash = createHash("sha256");
  let offset = 0;
  let expectedBytes: number | undefined;
  let expectedSha256: string | undefined;
  let mtimeMs: number | undefined;

  for (const route of routes) {
    let routeFailed = false;
    do {
      let response: Response;
      try {
        response = await fetchPeerRequest(
          fetchImpl,
          `${base}${route}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              namespace,
              includeTranscripts: false,
              path: filePath,
              offset,
              length: OFFLINE_SYNC_FILE_CONTENT_MAX_CHUNK_BYTES,
            }),
            ...(signal ? { signal } : {}),
          },
          timeoutMs
        );
        if (!response.ok) throw new Error(`offline file content request failed: ${response.status}`);
      } catch {
        routeFailed = true;
        break;
      }

      let content: Buffer;
      let totalBytes: number;
      let responseMtimeMs: number;
      let sha256: string | null;
      try {
        content = Buffer.from(await response.arrayBuffer());
        const chunkOffset = requiredResponseNumber(response, "x-remnic-chunk-offset");
        const chunkBytes = requiredResponseNumber(response, "x-remnic-chunk-bytes");
        totalBytes = requiredResponseNumber(response, "x-remnic-file-bytes");
        responseMtimeMs = requiredResponseNumber(response, "x-remnic-file-mtime-ms");
        sha256 = response.headers.get("x-remnic-file-sha256");
        const encodedPath = response.headers.get("x-remnic-file-path");
        if (
          !sha256 ||
          chunkOffset !== offset ||
          chunkBytes !== content.length ||
          (encodedPath !== null && decodeURIComponent(encodedPath) !== filePath) ||
          (expectedBytes !== undefined && expectedBytes !== totalBytes) ||
          (expectedSha256 !== undefined && expectedSha256 !== sha256) ||
          (content.length === 0 && offset < totalBytes)
        ) {
          throw new Error(`offline file content response changed during transfer: ${filePath}`);
        }
      } catch {
        routeFailed = true;
        break;
      }

      expectedBytes = totalBytes;
      expectedSha256 = sha256;
      mtimeMs = responseMtimeMs;
      await onChunk({
        content,
        offset,
        sha256,
        bytes: totalBytes,
        mtimeMs: responseMtimeMs,
      });
      hash.update(content);
      offset += content.length;
    } while (expectedBytes === undefined || offset < expectedBytes);

    if (!routeFailed && expectedBytes !== undefined && offset === expectedBytes) break;
  }

  if (
    expectedBytes === undefined ||
    expectedSha256 === undefined ||
    mtimeMs === undefined ||
    offset !== expectedBytes ||
    hash.digest("hex") !== expectedSha256
  ) {
    return null;
  }
  return { sha256: expectedSha256, bytes: expectedBytes, mtimeMs };
}

export async function fetchPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<PeerFileContent | null> {
  const chunks: Buffer[] = [];
  const metadata = await streamPeerFileContent(
    peerUrl,
    namespace,
    filePath,
    async (chunk) => {
      chunks.push(chunk.content);
    },
    token,
    fetchImpl,
    timeoutMs,
    signal
  );
  if (!metadata) return null;
  return {
    ...metadata,
    content: Buffer.concat(chunks, metadata.bytes),
  };
}

export interface PeerFileSource {
  sha256: string;
  bytes: number;
  mtimeMs: number;
  baseSha256?: string;
  readChunk(offset: number, length: number): Promise<Buffer>;
}

export async function postPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  source: PeerFileSource,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<"applied" | "skipped" | false> {
  assertTransferablePeerPath(filePath);
  const base = normalizePeerBaseUrl(peerUrl);
  const routes = [
    `/remnic/v1/offline-sync/apply-file-content?namespace=${encodeURIComponent(namespace)}`,
    `/engram/v1/offline-sync/apply-file-content?namespace=${encodeURIComponent(namespace)}`,
  ];
  let offset = 0;
  let previousAttemptFailed = false;
  for (const route of routes) {
    let restartedRoute = false;
    while (offset < source.bytes || (source.bytes === 0 && offset === 0)) {
      const length = Math.min(OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES, source.bytes - offset);
      let chunk: Buffer;
      try {
        chunk = await source.readChunk(offset, length);
      } catch {
        return false;
      }
      if (chunk.length !== length) return false;
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "x-remnic-include-transcripts": "false",
        "x-remnic-source-id": encodeURIComponent("remnic-converge"),
        "x-remnic-file-path": encodeURIComponent(filePath),
        "x-remnic-file-sha256": source.sha256,
        "x-remnic-file-bytes": String(source.bytes),
        "x-remnic-file-mtime-ms": String(source.mtimeMs),
        "x-remnic-chunk-offset": String(offset),
        ...(source.baseSha256 ? { "x-remnic-base-sha256": source.baseSha256 } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      let response: Response;
      try {
        response = await fetchPeerRequest(
          fetchImpl,
          `${base}${route}`,
          {
            method: "POST",
            headers,
            body: new Uint8Array(chunk),
            ...(signal ? { signal } : {}),
          },
          timeoutMs
        );
        if (!response.ok) throw new Error(`offline apply-file-content request failed: ${response.status}`);
      } catch {
        if (previousAttemptFailed && offset > 0 && !restartedRoute) {
          offset = 0;
          restartedRoute = true;
          continue;
        }
        previousAttemptFailed = true;
        break;
      }
      const result: unknown = await response.json().catch(() => null);
      if (
        !result ||
        typeof result !== "object" ||
        !("done" in result) ||
        typeof result.done !== "boolean" ||
        !("applied" in result) ||
        typeof result.applied !== "boolean" ||
        !("skipped" in result) ||
        typeof result.skipped !== "boolean" ||
        ("conflict" in result && result.conflict)
      ) {
        return false;
      }
      if (result.done) {
        if (result.skipped) return previousAttemptFailed ? "applied" : "skipped";
        return result.applied && offset + chunk.length === source.bytes ? "applied" : false;
      }
      if (result.applied || result.skipped || chunk.length === 0) return false;
      offset += chunk.length;
    }
  }
  return false;
}

export async function postPeerConvergenceComplete(
  peerUrl: string,
  namespaces: readonly string[],
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<boolean> {
  const base = normalizePeerBaseUrl(peerUrl);
  const query = namespaces.map((namespace) => `namespace=${encodeURIComponent(namespace)}`).join("&");
  const routes = ["/remnic/v1/offline-sync/convergence-complete", "/engram/v1/offline-sync/convergence-complete"];
  for (const route of routes) {
    const response = await fetchPeerRequest(
      fetchImpl,
      `${base}${route}?${query}`,
      {
        method: "POST",
        headers: {
          "x-remnic-source-id": encodeURIComponent("remnic-converge"),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(signal ? { signal } : {}),
      },
      timeoutMs
    ).catch(() => null);
    if (!response?.ok) continue;
    const result: unknown = await response.json().catch(() => null);
    if (
      result &&
      typeof result === "object" &&
      "namespaces" in result &&
      Array.isArray(result.namespaces) &&
      result.namespaces.length === namespaces.length &&
      result.namespaces.every((namespace, index) => namespace === namespaces[index]) &&
      "refreshed" in result &&
      result.refreshed === true
    ) {
      return true;
    }
  }
  return false;
}

export async function postPeerFileDeletion(
  peerUrl: string,
  namespace: string,
  filePath: string,
  baseSha256: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_PEER_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<"applied" | "skipped" | false> {
  assertTransferablePeerPath(filePath);
  const base = normalizePeerBaseUrl(peerUrl);
  const routes = ["/remnic/v1/offline-sync/apply", "/engram/v1/offline-sync/apply"];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let previousAttemptFailed = false;
  for (const route of routes) {
    try {
      const response = await fetchPeerRequest(
        fetchImpl,
        `${base}${route}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            namespace,
            changeset: {
              format: OFFLINE_SYNC_CHANGESET_FORMAT,
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              sourceId: "remnic-converge",
              includeTranscripts: false,
              changes: [{ type: "delete", path: filePath, baseSha256 }],
            },
          }),
          ...(signal ? { signal } : {}),
        },
        timeoutMs
      );
      if (!response.ok) throw new Error(`offline apply request failed: ${response.status}`);
      const result: unknown = await response.json().catch(() => null);
      if (
        !result ||
        typeof result !== "object" ||
        !("appliedDeletes" in result) ||
        typeof result.appliedDeletes !== "number" ||
        !("skipped" in result) ||
        typeof result.skipped !== "number" ||
        !("conflicts" in result) ||
        !Array.isArray(result.conflicts) ||
        result.conflicts.length > 0
      ) {
        return false;
      }
      if (result.appliedDeletes === 1) return "applied";
      if (result.skipped === 1) return previousAttemptFailed ? "applied" : "skipped";
      return false;
    } catch {
      previousAttemptFailed = true;
    }
  }
  return false;
}
