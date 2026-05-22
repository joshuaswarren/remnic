/**
 * Sealed qrels loader.
 *
 * The threat model (see `docs/bench/integrity.md`) is that the runner-side
 * adapter never sees ground-truth answers: they live only inside the judge /
 * scorer process. This module enforces that boundary by:
 *
 * 1. Loading a sealed qrels artifact from disk.
 * 2. Verifying its declared SHA-256 hash against the expected value pinned
 *    in the benchmark's metadata (the "seal hash").
 * 3. Decrypting the payload only when a caller provides the correct seal
 *    key. Callers that only need the seal hash (e.g. the runner emitting
 *    `BenchmarkResult.meta.qrelsSealedHash`) never receive plaintext.
 *
 * The artifact format is JSON:
 *
 * ```json
 * {
 *   "benchmark": "<benchmark-id>",
 *   "version": 1,
 *   "sealHash": "<sha256-of-envelope-without-sealHash>",
 *   "envelope": { SealedArtifact }
 * }
 * ```
 *
 * `sealHash` is computed over the canonical JSON of `envelope`, including the
 * random IV and ciphertext. It identifies the sealed envelope artifact, not
 * the plaintext qrels content. Use `envelope.plaintextHash` when stable
 * plaintext identity is required across independently sealed artifacts.
 */

import { readFile } from "node:fs/promises";
import {
  canonicalJsonStringify,
  hashCanonicalJson,
  isSha256Hex,
  openSeal,
  safeHexEqual,
  type SealedArtifact,
} from "./hash-verification.js";

export interface SealedQrelsArtifact {
  benchmark: string;
  version: 1;
  sealHash: string;
  envelope: SealedArtifact;
}

export interface SealedQrelsHandle {
  benchmark: string;
  sealHash: string;
  /**
   * Returns the decrypted qrels JSON as a string. Callers must pass the
   * seal key explicitly; the handle never caches plaintext.
   */
  unseal(key: Buffer): unknown;
}

export interface LoadSealedQrelsOptions {
  /**
   * Expected seal hash pinned at benchmark registration. If provided the
   * loader rejects the artifact when the computed hash does not match.
   */
  expectedSealHash?: string;
  /**
   * Benchmark ID the artifact must declare. When omitted, any benchmark ID
   * is accepted so tooling can inspect unknown artifacts.
   */
  expectedBenchmarkId?: string;
}

export function isSealedQrelsArtifact(value: unknown): value is SealedQrelsArtifact {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SealedQrelsArtifact>;
  if (typeof candidate.benchmark !== "string" || candidate.benchmark.length === 0) {
    return false;
  }
  if (candidate.version !== 1) {
    return false;
  }
  if (!isSha256Hex(candidate.sealHash)) {
    return false;
  }
  const envelope = candidate.envelope;
  if (!envelope || typeof envelope !== "object") {
    return false;
  }
  const candidateEnvelope = envelope as Partial<SealedArtifact>;
  return (
    candidateEnvelope.version === 1 &&
    typeof candidateEnvelope.algorithm === "string" &&
    typeof candidateEnvelope.iv === "string" &&
    typeof candidateEnvelope.tag === "string" &&
    typeof candidateEnvelope.ciphertext === "string" &&
    isSha256Hex(candidateEnvelope.plaintextHash)
  );
}

export function computeSealHash(envelope: SealedArtifact): string {
  return hashCanonicalJson(envelope);
}

export function parseSealedQrels(
  raw: string,
  options: LoadSealedQrelsOptions = {},
): SealedQrelsHandle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `Sealed qrels payload is not valid JSON: ${(cause as Error).message}`,
    );
  }

  if (!isSealedQrelsArtifact(parsed)) {
    throw new Error("Sealed qrels payload failed schema validation.");
  }

  const { benchmark, envelope, sealHash } = parsed;

  if (
    options.expectedBenchmarkId !== undefined &&
    options.expectedBenchmarkId !== benchmark
  ) {
    throw new Error(
      `Sealed qrels benchmark mismatch: expected "${options.expectedBenchmarkId}", got "${benchmark}".`,
    );
  }

  const computed = computeSealHash(envelope);
  if (!safeHexEqual(computed, sealHash)) {
    throw new Error(
      "Declared sealHash does not match computed hash over envelope (possible tampering).",
    );
  }

  if (
    options.expectedSealHash !== undefined &&
    !safeHexEqual(options.expectedSealHash, sealHash)
  ) {
    throw new Error(
      "Sealed qrels hash does not match the expected value pinned in benchmark metadata.",
    );
  }

  return {
    benchmark,
    sealHash,
    unseal(key: Buffer): unknown {
      const plaintext = openSeal(envelope, key);
      try {
        return JSON.parse(plaintext);
      } catch (cause) {
        throw new Error(
          `Decrypted qrels payload is not valid JSON: ${(cause as Error).message}`,
        );
      }
    },
  };
}

export async function loadSealedQrels(
  filePath: string,
  options: LoadSealedQrelsOptions = {},
): Promise<SealedQrelsHandle> {
  const raw = await readFile(filePath, "utf8");
  return parseSealedQrels(raw, options);
}

/**
 * Serialize a sealed qrels artifact to the canonical on-disk shape. Useful
 * for tooling that authors new qrels files.
 */
export function serializeSealedQrels(artifact: SealedQrelsArtifact): string {
  const normalized: SealedQrelsArtifact = {
    benchmark: artifact.benchmark,
    version: 1,
    sealHash: computeSealHash(artifact.envelope),
    envelope: artifact.envelope,
  };
  return canonicalJsonStringify(normalized);
}
