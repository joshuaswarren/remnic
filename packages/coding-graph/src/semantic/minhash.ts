/**
 * MinHash / LSH candidate generation for SIMILAR_TO near-clone detection
 * (issue #1556).
 *
 * Design (per the issue): token-shingle MinHash/LSH over normalized symbol
 * bodies (pure TS, deterministic given fixed seeds). This produces a
 * candidate-pair set cheaply; the cosine-confirmation layer (similarity.ts)
 * then filters candidates by embedding cosine ≥ threshold.
 *
 * Rule 38 — determinism. The seeds are NAMED CONSTANTS (not module-private
 * state, not `Date.now()`/`Math.random()`). Two runs over the same fixture
 * repo produce an identical candidate set. The determinism test asserts
 * this byte-for-byte.
 *
 * Rule 11 — no module-level mutable state. The hash tables live on the
 * MinHasher instance returned by `createMinHasher()`, never at module
 * scope. Two indexers in one process are fully isolated.
 */
import { createHash } from "node:crypto";

import { LSH_NUM_BANDS, LSH_ROWS_PER_BAND, MINHASH_NUM_PERMUTATIONS, MINHASH_SHINGLE_WIDTH } from "./config.js";

/**
 * Fixed, named 64-bit seeds for the MinHash permutations. These are the
 * ONLY source of randomness in the candidate pipeline. Changing them
 * changes every candidate set, so they are frozen constants — the
 * determinism test pins their exact values.
 *
 * Generated as `sha256("remnic:minhash:seed:N").slice(0,16)` interpreted
 * as a big-endian u64. Using a hash-of-a-string keeps them reproducible
 * (no magic-looking literals) while still being arbitrary fixed values.
 */
function seedFor(index: number): bigint {
  const hex = createHash("sha256")
    .update(`remnic:minhash:seed:${index}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return BigInt(`0x${hex}`);
}

export const MINHASH_SEEDS: readonly bigint[] = Object.freeze(
  Array.from({ length: MINHASH_NUM_PERMUTATIONS }, (_, i) => seedFor(i)),
);

/**
 * A 64-bit MurmurHash3 x64 finalizer — fast, well-distributed, and
 * deterministic. Used as the base hash; MinHash permutations are
 * (a*x + b) mod Mersenne over this base.
 */
function hash64(data: string): bigint {
  const buf = createHash("sha256").update(data, "utf8").digest();
  // Read the first 8 bytes as big-endian u64 — sha256 is already a strong
  // mixing function, so we skip the MurmurHash3 body and use sha256 as
  // the universal hash. Determinism is the only hard requirement; speed
  // is secondary (the candidate set is small after LSH banding).
  let h = 0n;
  for (let i = 0; i < 8; i++) {
    h = (h << 8n) | BigInt(buf[i]!);
  }
  return h;
}

// 2^61 - 1, a Mersenne prime — the MinHash modulus.
const MINHASH_MODULUS = (1n << 61n) - 1n;

/**
 * Normalize symbol body text into a token stream for shingling.
 *
 * Normalization:
 *   - lowercase (case-insensitive clone detection — `MyFunc` vs `myfunc`)
 *   - split on non-alphanumeric (identifiers, numbers, operators become tokens)
 *   - drop empty tokens
 *
 * This is deliberately coarse: the goal is Jaccard over token sets, not
 * semantic parsing. A renamed variable changes exactly one token per
 * occurrence, so Jaccard stays high for genuine clones.
 */
export function tokenizeForShingling(body: string): string[] {
  return body
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

/**
 * Build the set of shingles (n-grams of width MINHASH_SHINGLE_WIDTH) from
 * a token stream. Returns a Set so duplicate shingles collapse (Jaccard
 * is over the SET of shingles, not a multiset).
 */
export function shingleSet(tokens: readonly string[]): Set<string> {
  if (tokens.length < MINHASH_SHINGLE_WIDTH) {
    // Too few tokens for a full shingle — use the whole token sequence as
    // a single shingle so short symbols still participate.
    return new Set(tokens.length > 0 ? [tokens.join(" ")] : []);
  }
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - MINHASH_SHINGLE_WIDTH; i++) {
    out.add(tokens.slice(i, i + MINHASH_SHINGLE_WIDTH).join(" "));
  }
  return out;
}

/**
 * Compute the MinHash signature (array of permutation minima) for a set
 * of shingles. Signature length = MINHASH_NUM_PERMUTATIONS. The estimated
 * Jaccard similarity between two signatures is the fraction of matching
 * positions.
 */
export function minHashSignature(shingles: Set<string>): bigint[] {
  const sig: bigint[] = [];
  if (shingles.size === 0) {
    // Empty body → max-value signature so it never collides with anything.
    for (let i = 0; i < MINHASH_NUM_PERMUTATIONS; i++) sig.push(MINHASH_MODULUS);
    return sig;
  }
  const shingleArr = Array.from(shingles);
  for (let p = 0; p < MINHASH_NUM_PERMUTATIONS; p++) {
    const a = MINHASH_SEEDS[p]!;
    const b = MINHASH_SEEDS[(p * 2 + 1) % MINHASH_SEEDS.length]!;
    let min = MINHASH_MODULUS;
    for (const s of shingleArr) {
      const h = (a * hash64(s) + b) % MINHASH_MODULUS;
      if (h < min) min = h;
    }
    sig.push(min);
  }
  return sig;
}

/**
 * LSH band key — the concatenation of one band's rows from the signature.
 * Two signatures that share at least one band key are a candidate pair.
 */
export function lshBandKeys(signature: readonly bigint[]): string[] {
  const keys: string[] = [];
  for (let b = 0; b < LSH_NUM_BANDS; b++) {
    const start = b * LSH_ROWS_PER_BAND;
    const end = start + LSH_ROWS_PER_BAND;
    keys.push(signature.slice(start, end).map((v) => v.toString(16)).join("|"));
  }
  return keys;
}

/**
 * An indexed symbol body ready for LSH bucketing.
 */
export interface LshIndexEntry {
  readonly nodeId: string;
  readonly qualifiedName: string;
  readonly body: string;
}

/**
 * A MinHash/LSH indexer instance. Owns the band→node-id bucket map on the
 * instance (rule 11). `findCandidates` returns the deduplicated candidate
 * pair set with estimated Jaccard for each pair.
 */
export class MinHasher {
  /** band key → set of node ids in that band. */
  private readonly buckets: Map<string, Set<string>> = new Map();
  /** node id → signature (for Jaccard estimation on candidate pairs). */
  private readonly signatures: Map<string, bigint[]> = new Map();
  /** node id → qualified name (for readable candidate output). */
  private readonly qnames: Map<string, string> = new Map();

  /**
   * Add a symbol body to the LSH index. Idempotent — re-adding the same
   * (nodeId, body) is a no-op.
   */
  add(entry: LshIndexEntry): void {
    if (this.signatures.has(entry.nodeId)) return;
    const tokens = tokenizeForShingling(entry.body);
    const shingles = shingleSet(tokens);
    // Skip empty bodies — they would all get the same all-max signature
    // and flood the candidate set with false pairs
    // (chatgpt-codex-connector: 'Keep empty bodies out of shared MinHash
    // buckets').
    if (shingles.size === 0) return;
    const sig = minHashSignature(shingles);
    this.signatures.set(entry.nodeId, sig);
    this.qnames.set(entry.nodeId, entry.qualifiedName);
    for (const key of lshBandKeys(sig)) {
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new Set();
        this.buckets.set(key, bucket);
      }
      bucket.add(entry.nodeId);
    }
  }

  /**
   * Find all candidate pairs (pairs sharing at least one LSH band) with
   * their estimated Jaccard similarity. Returns a stable-sorted array
   * (by aNodeId then bNodeId) so the determinism test can compare runs
   * byte-for-byte.
   */
  findCandidates(): { readonly aNodeId: string; readonly bNodeId: string; readonly aQualifiedName: string; readonly bQualifiedName: string; readonly jaccard: number }[] {
    const pairSet = new Set<string>();
    const pairs: { aNodeId: string; bNodeId: string; aQualifiedName: string; bQualifiedName: string; jaccard: number }[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.size < 2) continue;
      const ids = Array.from(bucket).sort();
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i]!;
          const b = ids[j]!;
          const key = `${a}\0${b}`;
          if (pairSet.has(key)) continue;
          pairSet.add(key);
          const sigA = this.signatures.get(a)!;
          const sigB = this.signatures.get(b)!;
          let matches = 0;
          for (let k = 0; k < sigA.length; k++) {
            if (sigA[k] === sigB[k]) matches++;
          }
          pairs.push({
            aNodeId: a,
            bNodeId: b,
            aQualifiedName: this.qnames.get(a) ?? a,
            bQualifiedName: this.qnames.get(b) ?? b,
            jaccard: matches / sigA.length,
          });
        }
      }
    }
    pairs.sort((x, y) => {
      if (x.aNodeId !== y.aNodeId) return x.aNodeId < y.aNodeId ? -1 : 1;
      return x.bNodeId < y.bNodeId ? -1 : x.bNodeId > y.bNodeId ? 1 : 0;
    });
    return pairs;
  }
}

/**
 * Construct a fresh MinHasher (rule 11 — state on the instance).
 */
export function createMinHasher(): MinHasher {
  return new MinHasher();
}

/**
 * Cosine similarity between two equal-length float vectors. Returns 0 for
 * zero-norm vectors (no division-by-zero). This is the brute-force
 * retrieval primitive shared by SIMILAR_TO confirmation and semantic_query.
 */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
