/**
 * Randomization helpers for the integrity pipeline.
 *
 * These helpers remove position-in-prompt and fixture-layout exploits:
 * - `shuffleTasks` randomizes task order per run so a memorized task position
 *   cannot be exploited.
 * - `rotateDistractors` rotates multiple-choice answer positions and the set
 *   of distractors so answer-position memorization is defeated.
 * - `selectFixtureVariant` picks a variant by seed so each run exercises a
 *   different fixture graph layout.
 *
 * All helpers are seeded. A seeded mulberry32 PRNG gives deterministic,
 * reproducible shuffles that do not rely on `Math.random`.
 */

export interface SeededRng {
  /** Returns a pseudo-random number in `[0, 1)`. */
  next(): number;
}

/**
 * Deterministic 32-bit PRNG. Mulberry32 is small, fast, and sufficient for
 * shuffling benchmark tasks. Do NOT use for cryptographic operations.
 */
export function createSeededRng(seed: number): SeededRng {
  if (!Number.isFinite(seed)) {
    throw new Error("Seed must be a finite number.");
  }
  let state = (Math.floor(seed) | 0) >>> 0;
  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
  };
}

/**
 * Fisher-Yates shuffle using a seeded PRNG. Returns a new array.
 */
export function shuffleTasks<T>(tasks: readonly T[], seed: number): T[] {
  const rng = createSeededRng(seed);
  const out = [...tasks];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface MultipleChoiceQuestion<T> {
  /** Correct answer. Must appear in `distractors` or be prepended below. */
  correct: T;
  /** Distractor pool. The correct answer may or may not be present. */
  distractors: readonly T[];
}

export interface RotatedChoices<T> {
  /** The choices in rotated order. */
  choices: T[];
  /** The index of the correct answer in `choices`. */
  correctIndex: number;
}

/**
 * Rotate the distractor set and answer position for a multiple-choice
 * question. The full choice pool is `[correct, ...distractors]` with
 * duplicates removed; the pool is shuffled and the correct-answer index is
 * reported back to the caller. Callers re-score against `correctIndex`.
 */
export function rotateDistractors<T>(
  question: MultipleChoiceQuestion<T>,
  seed: number,
): RotatedChoices<T> {
  const pool: T[] = [question.correct];
  for (const distractor of question.distractors) {
    if (!pool.includes(distractor)) {
      pool.push(distractor);
    }
  }
  const shuffled = shuffleTasks(pool, seed);
  const correctIndex = shuffled.indexOf(question.correct);
  if (correctIndex === -1) {
    throw new Error("Correct answer dropped from the distractor pool during rotation.");
  }
  return { choices: shuffled, correctIndex };
}

export interface FixtureVariant<T> {
  id: string;
  value: T;
}

/**
 * Pick one fixture variant by seed. Stable: the same seed always returns the
 * same variant index for a given variant list length.
 */
export function selectFixtureVariant<T>(
  variants: readonly FixtureVariant<T>[],
  seed: number,
): FixtureVariant<T> {
  if (variants.length === 0) {
    throw new Error("At least one fixture variant is required.");
  }
  const rng = createSeededRng(seed);
  const index = Math.floor(rng.next() * variants.length);
  const chosen = variants[index];
  if (!chosen) {
    throw new Error("Internal error: fixture variant index out of range.");
  }
  return chosen;
}
