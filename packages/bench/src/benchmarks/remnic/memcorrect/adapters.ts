/**
 * MemCorrect adapters (issue #1584 PR 3).
 *
 * Three adapters ship in-tree:
 *
 *   1. `PromptOnlyBaselineAdapter` — the hermetic comparison anchor. Append-
 *      everything store; recall is BM25-ish term overlap over raw turns;
 *      correct() is just another turn; runMaintenance() is a no-op. The
 *      baseline exists so metric deltas mean something: a system that
 *      "remembers" by quoting the whole transcript scores well on recall
 *      but terribly on non_resurrection-under-reingest.
 *
 *   2. `RecordingAdapter` — a deterministic test adapter that returns
 *      canned recall strings per query so unit tests can hand-compute
 *      expected metric values without an LLM.
 *
 *   3. `createRemnicMemCorrectAdapter` — wraps the public
 *      `BenchMemoryAdapter` (the access-service-level abstraction other
 *      Remnic benchmarks use) into the MemCorrect contract. Per the issue,
 *      the Remnic adapter must use only public surfaces; reaching into
 *      orchestrator internals makes the benchmark meaningless. When the
 *      wrapped adapter exposes the optional `correct()` surface (the
 *      Correction Contract plan/apply path from #1580), corrections route
 *      through it; the plain turn-store path remains the fallback for
 *      adapters without an explicit correction surface and for corrections
 *      the planner could not apply.
 */

import type { BenchMemoryAdapter } from "../../../adapters/types.js";
import type { MemCorrectSystemAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt-only baseline
// ---------------------------------------------------------------------------

interface IngestedTurn {
  sessionKey: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "to",
  "of",
  "for",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "by",
  "it",
  "my",
  "your",
  "we",
  "you",
  "i",
  "me",
  "this",
  "that",
  "with",
  "from",
  "not",
  "have",
  "has",
  "do",
  "does",
  "did",
  "be",
  "been",
  "being",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "must",
  "shall",
  "if",
  "then",
  "than",
  "so",
  "as",
  "go",
  "going",
  "forward",
  "instead",
  "last",
  "month",
  "now",
  "their",
  "them",
  "they",
  "he",
  "she",
  "his",
  "her",
  "got",
  "noting",
  "noted",
  "what",
  "setting",
  "preference",
  "update",
  "actually",
  "back",
  "went",
  "consider",
  "decided",
  "might",
  "someone",
  "asked",
  "mentioned",
  "said",
  "should",
  "change",
  "wrong",
  "saying",
  "record",
  "oh",
  "by",
  "way",
  "project",
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g);
  return (matches ?? []).filter((t) => !STOP_WORDS.has(t));
}

function termFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

/**
 * Prompt-only baseline: append-everything store with BM25-style term-overlap
 * recall over raw turns. No extraction, no correction-contract, no
 * maintenance — the structural floor MemCorrect deltas are measured against.
 */
export class PromptOnlyBaselineAdapter implements MemCorrectSystemAdapter {
  readonly label = "prompt-only-baseline";
  private turns: IngestedTurn[] = [];

  async reset(): Promise<void> {
    this.turns = [];
  }

  async ingestTurn(
    sessionKey: string,
    role: "user" | "assistant",
    text: string,
    at: string,
  ): Promise<void> {
    this.turns.push({ sessionKey, role, text, at });
  }

  async recall(query: string, sessionKey: string): Promise<string[]> {
    const queryTf = termFrequencies(tokenize(query));
    if (queryTf.size === 0) return [];
    // Scope recall to the requesting session so a primary-namespace probe
    // cannot pull twin-namespace text (and vice-versa). Without this filter
    // scoped scenarios let cross-namespace turns distort the baseline's
    // scope and recall signals.
    const scored = this.turns
      .filter((turn) => turn.sessionKey === sessionKey)
      .map((turn) => {
        const turnTf = termFrequencies(tokenize(turn.text));
        let overlap = 0;
        for (const [term, qCount] of queryTf) {
          const tCount = turnTf.get(term);
          if (tCount !== undefined) overlap += qCount * tCount;
        }
        return { turn, overlap };
      })
      .filter((entry) => entry.overlap > 0)
      .sort((a, b) => {
        if (b.overlap !== a.overlap) return b.overlap - a.overlap;
        // Stable tiebreak by ingestion order (most recent first), mirroring
        // a recency-biased prompt window.
        return this.turns.indexOf(b.turn) - this.turns.indexOf(a.turn);
      })
      .slice(0, 5)
      .map((entry) => entry.turn.text);
    return scored;
  }

  async correct(text: string, sessionKey: string): Promise<void> {
    // The baseline accepts a correction as just another user turn — no
    // retire, no tombstone. This is precisely why non_resurrection collapses
    // for the baseline under re-ingest.
    await this.ingestTurn(sessionKey, "user", text, new Date().toISOString());
  }

  async runMaintenance(): Promise<void> {
    // No-op: the baseline has no consolidation/dreams path.
  }
}

// ---------------------------------------------------------------------------
// Recording adapter (test fixture)
// ---------------------------------------------------------------------------

/**
 * Deterministic test adapter. The script maps a phase → ordered list of
 * recall strings to return, so tests can drive the runner with a known
 * probe log and hand-compute expected metrics. Each call advances an
 * internal turn counter so uptake_latency is exercisable.
 */
export interface RecordingScript {
  /** recall strings returned for a probe at a given phase (queued FIFO). */
  recallByPhase: Record<string, string[][]>;
}

export class RecordingAdapter implements MemCorrectSystemAdapter {
  readonly label: string;
  private readonly script: RecordingScript;
  private turnIndex = 0;
  private readonly queues: Map<string, string[][]>;
  public readonly ingested: IngestedTurn[] = [];
  public readonly corrections: string[] = [];
  public maintenanceCalls = 0;

  constructor(label: string, script: RecordingScript) {
    this.label = label;
    this.script = script;
    this.queues = new Map(
      Object.entries(script.recallByPhase).map(([phase, queues]) => [
        phase,
        queues.map((q) => [...q]),
      ]),
    );
  }

  async reset(): Promise<void> {
    this.turnIndex = 0;
    this.ingested.length = 0;
    this.corrections.length = 0;
    this.maintenanceCalls = 0;
    this.queues.clear();
    for (const [phase, queues] of Object.entries(this.script.recallByPhase)) {
      this.queues.set(
        phase,
        queues.map((q) => [...q]),
      );
    }
  }

  /** Current monotonic turn counter (the runner reads this for latency). */
  get currentTurnIndex(): number {
    return this.turnIndex;
  }

  /** Bump the turn counter (the runner calls this between probes). */
  bumpTurn(): void {
    this.turnIndex += 1;
  }

  async ingestTurn(
    sessionKey: string,
    role: "user" | "assistant",
    text: string,
    at: string,
  ): Promise<void> {
    this.ingested.push({ sessionKey, role, text, at });
    this.turnIndex += 1;
  }

  async recall(query: string, _sessionKey: string): Promise<string[]> {
    const phase = query;
    const queue = this.queues.get(phase);
    if (queue && queue.length > 0) {
      return queue.shift() ?? [];
    }
    return [];
  }

  async correct(text: string, _sessionKey: string): Promise<void> {
    this.corrections.push(text);
    this.turnIndex += 1;
  }

  async runMaintenance(): Promise<void> {
    this.maintenanceCalls += 1;
  }
}

// ---------------------------------------------------------------------------
// Remnic-native adapter (public-surface wrapper)
// ---------------------------------------------------------------------------

/**
 * Wrap a public `BenchMemoryAdapter` (the access-service-level abstraction)
 * into the MemCorrect contract.
 *
 * `ingestTurn` → `store(sessionKey, [Message])`. `recall` →
 * `adapter.recall(sessionKey, query)` split into ranked strings.
 * `correct` → routes through the Correction Contract (plan + confirmed
 * apply) when the wrapped adapter exposes `correct()`, with the plain
 * user-turn path as fallback. `runMaintenance` → `adapter.drain()`,
 * which forces the background consolidation/LCM/contradiction-scan pipeline
 * to settle; a forced-dreams/REM hook lands with #1579's tombstone path.
 *
 * The wrapper deliberately does NOT reach into orchestrator internals —
 * that is the issue's hard constraint ("makes the benchmark meaningless as
 * a comparison and brittle in-tree").
 */
export function createRemnicMemCorrectAdapter(
  adapter: BenchMemoryAdapter,
  options: { label?: string; sessionPrefix?: string } = {},
): MemCorrectSystemAdapter {
  const label = options.label ?? "remnic-native";
  const sessionPrefix = options.sessionPrefix ?? "memcorrect";
  return {
    label,
    async reset() {
      await adapter.reset();
    },
    async ingestTurn(sessionKey, role, text, at) {
      await adapter.store(`${sessionPrefix}:${sessionKey}`, [
        { role, content: text, timestamp: at },
      ]);
    },
    async recall(query, sessionKey) {
      const text = await adapter.recall(`${sessionPrefix}:${sessionKey}`, query);
      // Split the recalled context blob into ranked strings. Adapters return
      // a single context string; the benchmark scores token containment over
      // the joined text, so splitting on blank-line boundaries preserves
      // structure without changing the containment semantics.
      const trimmed = text.trim();
      if (trimmed.length === 0) return [];
      return trimmed
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
    async correct(text, sessionKey, at) {
      // Prefer the explicit Correction Contract surface (#1580 / plan item
      // 2a): plan + confirmed apply through the same public access layer the
      // MCP/HTTP correction tools use. When the planner produces no
      // applicable action (or the adapter has no correction surface), fall
      // back to delivering the correction as a user turn — the seeded corpus
      // timestamp is preserved so temporal reasoning is evaluated against
      // the scenario timeline, not wall-clock ingestion time.
      const scopedSession = `${sessionPrefix}:${sessionKey}`;
      if (adapter.correct) {
        const outcome = await adapter.correct(scopedSession, text, at);
        if (outcome.applied) return;
      }
      await adapter.store(scopedSession, [
        { role: "user", content: text, timestamp: at },
      ]);
    },
    async runMaintenance() {
      // Force the background write paths (#1579's tombstone chokepoint
      // hooks drain-then-contradiction-scan). drain() settles LCM +
      // consolidation; a no-op drain (adapters without background work) is
      // allowed and surfaces as a higher non_resurrection for this adapter.
      await adapter.drain?.();
    },
  };
}
