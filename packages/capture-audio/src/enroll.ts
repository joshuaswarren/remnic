/**
 * `enroll-self` (issue #1897) — register the wearer as the `self` speaker so
 * the diarizer and downstream attribution can distinguish the wearer's own
 * voice from everyone else's.
 *
 * Enrollment stores a durable `self` speaker row. When a voice embedding is
 * supplied (extracted from a recorded sample by a speaker-embedding model —
 * à-la-carte, like whisper STT and the Silero VAD), it is stored as the self
 * centroid so live diarization can match against it. Without an embedder the
 * wearer's identity is still registered (embedding refinement lands with the
 * diarization slice), so the pipeline can already tag `desktop:self`.
 *
 * Pure over its injected `spool`: the caller owns recording the sample and
 * extracting the embedding, so no optional native/model runtime is imported.
 */

import { SpeakerClusterer, type Embedding } from "./diarization.js";
import { CaptureConfigError } from "./errors.js";
import type { Spool } from "./spool.js";

/** The stable speaker id for the enrolled wearer. */
export const SELF_SPEAKER_ID = "self";

export interface EnrollSelfInput {
  spool: Spool;
  /** Human label for the wearer; defaults to "You". */
  label?: string | null;
  /** Optional wearer voice embedding; when present it is stored as the self centroid. */
  embedding?: Embedding;
}

export interface EnrollSelfResult {
  speakerId: string;
  label: string | null;
  hasEmbedding: boolean;
  dimensions: number;
}

/**
 * Register (or refresh) the `self` speaker. With an embedding, the canonical
 * self cluster (centroid + example) is persisted; without one, only the
 * identity is upserted, preserving any embedding a prior enroll stored.
 */
export function enrollSelf(input: EnrollSelfInput): EnrollSelfResult {
  const label = input.label ?? "You";

  if (input.embedding !== undefined) {
    if (!Array.isArray(input.embedding) || input.embedding.length === 0) {
      throw new CaptureConfigError("enroll-self embedding must be a non-empty number array");
    }
    for (const value of input.embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new CaptureConfigError("enroll-self embedding must contain only finite numbers");
      }
    }
    // Build the canonical self cluster through the diarizer so the stored shape
    // (id/centroid/examples/count) matches what live diarization seeds from.
    const clusterer = new SpeakerClusterer(0.5);
    clusterer.enrollSelf(input.embedding);
    const self = clusterer.clusters().find((c) => c.isSelf);
    if (!self) {
      throw new CaptureConfigError("enroll-self failed to build the self speaker cluster");
    }
    input.spool.upsertSpeaker({
      id: self.id,
      isSelf: true,
      label,
      embeddingCount: self.embeddingCount,
      centroid: self.centroid,
      examples: self.examples,
    });
    return { speakerId: self.id, label, hasEmbedding: true, dimensions: input.embedding.length };
  }

  input.spool.upsertSpeaker({ id: SELF_SPEAKER_ID, isSelf: true, label });
  // upsertSpeaker preserves any prior centroid; report what is actually stored
  // so a relabel doesn't falsely claim no embedding exists.
  const stored = input.spool.readSpeakerClusters().find((c) => c.id === SELF_SPEAKER_ID);
  const dimensions = stored?.centroid.length ?? 0;
  return { speakerId: SELF_SPEAKER_ID, label, hasEmbedding: dimensions > 0, dimensions };
}
