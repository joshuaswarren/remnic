import type { ServerResponse } from "node:http";
import type { OfflineSyncManifestStreamResponse } from "./access-offline-manifest.js";
import type { EngramAccessOfflineSyncSnapshotStreamResponse } from "./access-service.js";

async function respondOfflineNdjsonStream(
  response: ServerResponse,
  header: unknown,
  files: AsyncIterable<unknown>,
  requestId?: string,
): Promise<void> {
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (requestId) response.setHeader("x-request-id", requestId);
  const waitForDrainOrClose = async (): Promise<boolean> => {
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = () => {
      cleanup();
      resolve(true);
    };
    const onClose = () => {
      cleanup();
      resolve(false);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    return promise;
  };
  const writeLine = async (payload: unknown): Promise<boolean> => {
    if (response.destroyed || response.writableEnded) return false;
    if (response.write(`${JSON.stringify(payload)}\n`)) return true;
    if (response.destroyed || response.writableEnded) return false;
    return waitForDrainOrClose();
  };
  if (!await writeLine(header)) return;
  for await (const file of files) {
    if (!await writeLine({ type: "file", file })) return;
  }
  if (!response.destroyed && !response.writableEnded) response.end();
}

export async function respondOfflineSnapshotStream(
  response: ServerResponse,
  snapshot: EngramAccessOfflineSyncSnapshotStreamResponse,
  requestId?: string,
): Promise<void> {
  await respondOfflineNdjsonStream(response, {
    type: "snapshot",
    namespace: snapshot.namespace,
    format: snapshot.format,
    schemaVersion: snapshot.schemaVersion,
    createdAt: snapshot.createdAt,
    sourceId: snapshot.sourceId,
    includeTranscripts: snapshot.includeTranscripts,
    deletions: snapshot.deletions,
  }, snapshot.files, requestId);
}

export async function respondOfflineManifestStream(
  response: ServerResponse,
  manifest: OfflineSyncManifestStreamResponse,
  requestId?: string,
): Promise<void> {
  await respondOfflineNdjsonStream(response, {
    type: "manifest",
    namespace: manifest.namespace,
    format: manifest.format,
    schemaVersion: manifest.schemaVersion,
  }, manifest.files, requestId);
}
