/**
 * Speaker diarization clustering (issue #1897, component 2.3).
 *
 * The daemon computes one speaker embedding per VAD speech segment (via
 * the optional sherpa-onnx speaker-id model, wired with the native
 * capture layer). This module owns the CPU-cheap, hardware-free half:
 * matching an embedding to a stable speaker cluster and maintaining the
 * cluster's running centroid + a bounded diverse example set. It is pure
 * over embedding vectors so the fragmentation regression (one synthetic
 * voice across many segments -> one cluster) runs in CI without models.
 *
 * Match score = best cosine similarity against BOTH the cluster centroid
 * and up to `maxExamples` stored examples (issue: "take the best score").
 */

import { CaptureConfigError } from "./errors.js";

export type Embedding = readonly number[];

export interface SpeakerCluster {
  id: string;
  centroid: number[];
  examples: number[][];
  count: number;
  isSelf: boolean;
  label: string | null;
}

const MAX_EXAMPLES = 10;
const SELF_ID = "self";

export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Assigns embeddings to stable speaker clusters. Ids are `spk_<n>` (or
 * `self` for the enrolled wearer). Seed with persisted clusters so ids
 * survive daemon restarts.
 */
export class SpeakerClusterer {
  #clusters: SpeakerCluster[] = [];
  #threshold: number;
  #next = 1;

  constructor(threshold: number, seed: readonly SpeakerCluster[] = []) {
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) {
      throw new CaptureConfigError("diarization.similarityThreshold must be between 0 and 1");
    }
    this.#threshold = threshold;
    for (const c of seed) {
      this.#clusters.push({
        id: c.id,
        centroid: [...c.centroid],
        examples: c.examples.map((e) => [...e]),
        count: c.count,
        isSelf: c.isSelf,
        label: c.label,
      });
      const n = /^spk_(\d+)$/.exec(c.id);
      if (n) this.#next = Math.max(this.#next, Number(n[1]) + 1);
    }
  }

  /** Register an enrolled self profile (its embedding seeds the `self` cluster). */
  enrollSelf(embedding: Embedding): void {
    const existing = this.#clusters.find((c) => c.id === SELF_ID);
    if (existing) {
      this.#update(existing, embedding);
      existing.isSelf = true;
      return;
    }
    this.#clusters.unshift({
      id: SELF_ID,
      centroid: [...embedding],
      examples: [[...embedding]],
      count: 1,
      isSelf: true,
      label: null,
    });
  }

  /** Best cosine over a cluster's centroid + examples. */
  #score(cluster: SpeakerCluster, embedding: Embedding): number {
    let best = cosineSimilarity(cluster.centroid, embedding);
    for (const ex of cluster.examples) {
      const s = cosineSimilarity(ex, embedding);
      if (s > best) best = s;
    }
    return best;
  }

  #update(cluster: SpeakerCluster, embedding: Embedding): void {
    // Running mean centroid.
    const n = cluster.count;
    for (let i = 0; i < cluster.centroid.length && i < embedding.length; i++) {
      cluster.centroid[i] = (cluster.centroid[i] * n + embedding[i]) / (n + 1);
    }
    cluster.count = n + 1;
    if (cluster.examples.length < MAX_EXAMPLES) {
      cluster.examples.push([...embedding]);
    } else {
      // Keep the set diverse: replace the example most similar to the
      // incoming one, so the cluster spans more of the speaker's range.
      let mostSimilar = 0;
      let mostSimilarScore = -Infinity;
      for (let i = 0; i < cluster.examples.length; i++) {
        const s = cosineSimilarity(cluster.examples[i], embedding);
        if (s > mostSimilarScore) {
          mostSimilarScore = s;
          mostSimilar = i;
        }
      }
      cluster.examples[mostSimilar] = [...embedding];
    }
  }

  /** Match `embedding` to an existing cluster or create a new `spk_<n>`. */
  assign(embedding: Embedding): string {
    let best: SpeakerCluster | null = null;
    let bestScore = -Infinity;
    for (const cluster of this.#clusters) {
      const s = this.#score(cluster, embedding);
      if (s > bestScore) {
        bestScore = s;
        best = cluster;
      }
    }
    if (best && bestScore >= this.#threshold) {
      this.#update(best, embedding);
      return best.id;
    }
    const cluster: SpeakerCluster = {
      id: `spk_${this.#next++}`,
      centroid: [...embedding],
      examples: [[...embedding]],
      count: 1,
      isSelf: false,
      label: null,
    };
    this.#clusters.push(cluster);
    return cluster.id;
  }

  /** Snapshot for persistence. */
  clusters(): SpeakerCluster[] {
    return this.#clusters.map((c) => ({
      id: c.id,
      centroid: [...c.centroid],
      examples: c.examples.map((e) => [...e]),
      count: c.count,
      isSelf: c.isSelf,
      label: c.label,
    }));
  }
}
