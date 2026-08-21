import type { ExportManifestV1, ExportMemoryRecordV1 } from "./types.js";
import { sha256Bytes, sha256String } from "./fs-utils.js";

export interface TransferIntegrityRecord {
  path: string;
  content: string | Uint8Array;
}

export function validateManifestRecords(
  manifest: Pick<ExportManifestV1, "files">,
  records: readonly TransferIntegrityRecord[],
  errorPrefix: string,
): void {
  const manifestByPath = new Map<string, ExportManifestV1["files"][number]>();
  for (const file of manifest.files) {
    if (manifestByPath.has(file.path)) {
      throw new Error(`${errorPrefix}: duplicate manifest path: ${file.path}`);
    }
    manifestByPath.set(file.path, file);
  }

  const recordByPath = new Map<string, TransferIntegrityRecord>();
  for (const record of records) {
    if (recordByPath.has(record.path)) {
      throw new Error(`${errorPrefix}: duplicate record path: ${record.path}`);
    }
    recordByPath.set(record.path, record);
  }

  for (const record of records) {
    const expected = manifestByPath.get(record.path);
    if (!expected) {
      throw new Error(`${errorPrefix}: record missing from manifest: ${record.path}`);
    }
    assertContentIntegrity(record, expected, errorPrefix);
  }

  for (const file of manifest.files) {
    if (!recordByPath.has(file.path)) {
      throw new Error(`${errorPrefix}: manifest file missing from records: ${file.path}`);
    }
  }
}

export function validateExportBundleRecords(
  manifest: Pick<ExportManifestV1, "files">,
  records: readonly ExportMemoryRecordV1[],
  errorPrefix: string,
): void {
  validateManifestRecords(manifest, records, errorPrefix);
}

function assertContentIntegrity(
  record: TransferIntegrityRecord,
  expected: ExportManifestV1["files"][number],
  errorPrefix: string,
): void {
  const actual = typeof record.content === "string"
    ? sha256String(record.content)
    : sha256Bytes(record.content);
  if (actual.bytes !== expected.bytes) {
    throw new Error(
      `${errorPrefix}: byte count mismatch for ${record.path}`,
    );
  }
  if (actual.sha256 !== expected.sha256) {
    throw new Error(
      `${errorPrefix}: checksum mismatch for ${record.path}`,
    );
  }
}
