import { OFFLINE_SYNC_CHANGESET_FORMAT, OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES } from "@remnic/core";

export type ReceiverFinalizationCapability = "not_required" | "supported" | "unsupported";

export interface ReceiverFinalizationResult {
  capability: ReceiverFinalizationCapability;
  refreshedNamespaces: string[];
  pendingNamespaces: string[];
}

export type ReceiverFinalizationNegotiation =
  | { capability: "supported"; route: string }
  | { capability: "unsupported" };

export type PeerMutationResult = "applied" | "skipped" | "failed" | "ambiguous";

export function receiverFinalizationResult(
  capability: ReceiverFinalizationCapability,
  refreshedNamespaces: Iterable<string> = [],
  pendingNamespaces: Iterable<string> = []
): ReceiverFinalizationResult {
  return {
    capability,
    refreshedNamespaces: [...refreshedNamespaces].sort(),
    pendingNamespaces: [...pendingNamespaces].sort(),
  };
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export async function negotiateReceiverFinalization(
  peerUrl: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<ReceiverFinalizationNegotiation> {
  const route = "/engram/v1/capabilities";
  let response: Response;
  try {
    response = await fetchImpl(`${withoutTrailingSlashes(peerUrl)}${route}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch (error) {
    throw new Error(`receiver capability request failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(`receiver capability request failed: ${response.status}`);
  const result: unknown = await response.json().catch((error) => {
    throw new Error("receiver capability response was not valid JSON", { cause: error });
  });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("receiver capability response must be an object");
  }
  const capability = (result as Record<string, unknown>).offlineSyncConvergenceComplete;
  if (capability === true) {
    return { capability: "supported", route: "/remnic/v1/offline-sync/convergence-complete" };
  }
  if (capability === undefined || capability === false) return { capability: "unsupported" };
  throw new Error("receiver capability response has invalid offlineSyncConvergenceComplete");
}

export async function postPeerFileContent(
  peerUrl: string,
  namespace: string,
  filePath: string,
  content: Buffer,
  metadata: { sha256: string; mtimeMs: number; baseSha256?: string },
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PeerMutationResult> {
  const base = withoutTrailingSlashes(peerUrl);
  const routes = [
    `/remnic/v1/offline-sync/apply-file-content?namespace=${encodeURIComponent(namespace)}`,
    `/engram/v1/offline-sync/apply-file-content?namespace=${encodeURIComponent(namespace)}`,
  ];
  let previousAttemptFailed = false;
  for (const route of routes) {
    try {
      let offset = 0;
      do {
        const chunk = content.subarray(
          offset,
          Math.min(content.length, offset + OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES)
        );
        const headers: Record<string, string> = {
          "content-type": "application/octet-stream",
          "x-remnic-include-transcripts": "false",
          "x-remnic-source-id": encodeURIComponent("remnic-converge"),
          "x-remnic-file-path": encodeURIComponent(filePath),
          "x-remnic-file-sha256": metadata.sha256,
          "x-remnic-file-bytes": String(content.length),
          "x-remnic-file-mtime-ms": String(metadata.mtimeMs),
          "x-remnic-chunk-offset": String(offset),
          ...(metadata.baseSha256 ? { "x-remnic-base-sha256": metadata.baseSha256 } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        };
        const response = await fetchImpl(`${base}${route}`, {
          method: "POST",
          headers,
          body: new Uint8Array(chunk),
        });
        if (!response.ok) throw new Error(`offline apply-file-content request failed: ${response.status}`);
        const result: unknown = await response.json().catch(() => null);
        if (
          !result ||
          typeof result !== "object" ||
          !("done" in result) ||
          typeof result.done !== "boolean" ||
          !("applied" in result) ||
          typeof result.applied !== "boolean" ||
          !("skipped" in result) ||
          typeof result.skipped !== "boolean"
        ) {
          return "ambiguous";
        }
        if ("conflict" in result && result.conflict) return "failed";
        if (result.applied && result.skipped) return "ambiguous";
        if (result.done) {
          if (result.skipped) return previousAttemptFailed ? "applied" : "skipped";
          if (result.applied && offset + chunk.length === content.length) return "applied";
          return "ambiguous";
        }
        if (result.applied || result.skipped || chunk.length === 0) {
          return "ambiguous";
        }
        offset += chunk.length;
      } while (offset < content.length);
      return "ambiguous";
    } catch {
      previousAttemptFailed = true;
    }
  }
  return previousAttemptFailed ? "ambiguous" : "failed";
}

export async function postPeerConvergenceComplete(
  peerUrl: string,
  route: string,
  namespaces: readonly string[],
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<void> {
  const query = namespaces.map((namespace) => `namespace=${encodeURIComponent(namespace)}`).join("&");
  let response: Response;
  try {
    response = await fetchImpl(`${withoutTrailingSlashes(peerUrl)}${route}?${query}`, {
      method: "POST",
      headers: {
        "x-remnic-source-id": encodeURIComponent("remnic-converge"),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (error) {
    throw new Error(`receiver finalization request failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) throw new Error(`receiver finalization request failed: ${response.status}`);
  const result: unknown = await response.json().catch((error) => {
    throw new Error("receiver finalization response was not valid JSON", { cause: error });
  });
  if (
    !result ||
    typeof result !== "object" ||
    !("namespaces" in result) ||
    !Array.isArray(result.namespaces) ||
    result.namespaces.length !== namespaces.length ||
    !result.namespaces.every((namespace, index) => namespace === namespaces[index]) ||
    !("refreshed" in result) ||
    result.refreshed !== true
  ) {
    throw new Error("receiver finalization response did not acknowledge every namespace");
  }
}

export async function postPeerFileDeletion(
  peerUrl: string,
  namespace: string,
  filePath: string,
  baseSha256: string,
  token?: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PeerMutationResult> {
  const base = withoutTrailingSlashes(peerUrl);
  const routes = ["/remnic/v1/offline-sync/apply", "/engram/v1/offline-sync/apply"];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let previousAttemptFailed = false;
  for (const route of routes) {
    try {
      const response = await fetchImpl(`${base}${route}`, {
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
      });
      if (!response.ok) throw new Error(`offline apply request failed: ${response.status}`);
      const result: unknown = await response.json().catch(() => null);
      if (
        !result ||
        typeof result !== "object" ||
        !("appliedDeletes" in result) ||
        typeof result.appliedDeletes !== "number" ||
        !Number.isInteger(result.appliedDeletes) ||
        result.appliedDeletes < 0 ||
        result.appliedDeletes > 1 ||
        !("skipped" in result) ||
        typeof result.skipped !== "number" ||
        !Number.isInteger(result.skipped) ||
        result.skipped < 0 ||
        result.skipped > 1 ||
        !("conflicts" in result) ||
        !Array.isArray(result.conflicts)
      ) {
        return "ambiguous";
      }
      if (result.appliedDeletes + result.skipped > 1) return "ambiguous";
      if (result.conflicts.length > 0) {
        return result.appliedDeletes + result.skipped > 0 ? "ambiguous" : "failed";
      }
      if (result.appliedDeletes === 1) return "applied";
      if (result.skipped === 1) return previousAttemptFailed ? "applied" : "skipped";
      return "ambiguous";
    } catch {
      previousAttemptFailed = true;
    }
  }
  return previousAttemptFailed ? "ambiguous" : "failed";
}
