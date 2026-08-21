import type { ContextTransformTelemetryRecord } from "../active-context-transform.js";
import { readContextTransformRecordRowsFromLines, readMaybeEncryptedLines } from "./secure-line-reader.js";

export interface ContextTransformLedgerHost {
  memoryActionsPath: string;
  ensureDirectories(): Promise<void>;
  appendStorageSecureFile(path: string, payload: string): Promise<void>;
  readStorageSecureFile(path: string): Promise<string>;
}

export async function appendContextTransformRecords(
  host: ContextTransformLedgerHost,
  records: ContextTransformTelemetryRecord[],
): Promise<number> {
  if (records.length === 0) return 0;
  await host.ensureDirectories();
  await host.appendStorageSecureFile(
    host.memoryActionsPath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  return records.length;
}

export async function readContextTransformRecords(
  host: ContextTransformLedgerHost,
  limit = 200,
): Promise<ContextTransformTelemetryRecord[]> {
  const cappedLimit = Math.max(0, Math.floor(limit));
  if (cappedLimit === 0 || Number.isNaN(cappedLimit)) return [];
  try {
    const rows = await readContextTransformRecordRowsFromLines(
      readMaybeEncryptedLines(host.memoryActionsPath, () => host.readStorageSecureFile(host.memoryActionsPath)),
      cappedLimit,
    );
    return rows.map((row) => row.record);
  } catch {
    return [];
  }
}
