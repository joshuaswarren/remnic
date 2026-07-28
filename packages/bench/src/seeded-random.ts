/**
 * Shared deterministic PRNG for bench generators and ablations.
 *
 * Mulberry32: small, fast, and reproducible across platforms. Generators MUST
 * use this instead of `Math.random()` so corpora regenerate byte-identically
 * from a seed (issue #1954 dataset conventions).
 */

export type SeededRandom = () => number;

export function createSeededRandom(seed: number): SeededRandom {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error("seed must be an integer in [0, 2^32 - 1]");
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] inclusive. */
export function randomInt(rng: SeededRandom, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
    throw new Error("randomInt bounds must be safe integers with max >= min");
  }
  return min + Math.floor(rng() * (max - min + 1));
}

export function pickOne<T>(rng: SeededRandom, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error("pickOne requires a non-empty array");
  }
  return items[randomInt(rng, 0, items.length - 1)];
}

/** Deterministic Fisher-Yates shuffle returning a new array. */
export function shuffled<T>(rng: SeededRandom, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(rng, 0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
