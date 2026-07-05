// Issue #1539 PR1 — Characterization tests for the four recall pipelines.
//
// These snapshots pin the CURRENT outputs of `buildTargetedFactRecallSection`,
// `buildResponseGuidanceRecallSection`, `buildExplicitCueRecallSection`, and
// `buildEventOrderRecallSection` on a fixed fixture corpus. They MUST survive
// the spine migration byte-for-byte: each migration PR (targeted-fact →
// response-guidance → explicit-cue → event-order) re-runs this file and
// asserts the snapshots are unchanged (with the single declared exception of
// event-order's outline-budget accounting fix, which lands in its own
// migration PR and is captured by an additional snapshot there).
//
// The behaviors pinned here are exactly the divergences the spine must
// declare as config fields (issue #1539 "Solution"):
//   - dedup by id + normalized content
//   - threshold filtering (event-order's hardcoded rank >= 6)
//   - rank DESC / turnIndex secondary / score tertiary ordering
//   - event-order's ASC ordering (chronological)
//   - undefined turnIndex handling
//   - fallback-merge (strong fallback hit outranks weak primary; cross-key
//     content dedup; per-key fault isolation)
//   - event-order does NOT call `gatherAcrossReadSessions` (turn_index is
//     local to each session_id)

import assert from "node:assert/strict";
import test from "node:test";

import type { ExplicitCueRecallEngine } from "../packages/remnic-core/src/explicit-cue-recall.js";
import { buildExplicitCueRecallSection } from "../packages/remnic-core/src/explicit-cue-recall.js";
import { buildEventOrderRecallSection } from "../packages/remnic-core/src/event-order-recall.js";
import { buildResponseGuidanceRecallSection } from "../packages/remnic-core/src/response-guidance-recall.js";
import { buildTargetedFactRecallSection } from "../packages/remnic-core/src/targeted-fact-recall.js";

// ──────────────────────────────────────────────────────────────────────────
// Fixture corpus — a small, deterministic transcript that triggers all four
// pipelines. The exact contents are chosen so each pipeline produces stable,
// non-empty output AND so the divergence dimensions (dedup, threshold, sort
// direction, fallback-merge) are observable through the builder output.
// ──────────────────────────────────────────────────────────────────────────

export interface FixtureMessage {
  turn_index: number;
  role: string;
  content: string;
}

export const FIXTURE_SESSION_PRIMARY = "user:test:primary";
export const FIXTURE_SESSION_FALLBACK = "user:test:fallback";

const TARGETED_FACT_CONTENT =
  "My monthly expenses are $2,400 — rent is $1,200, groceries $400, transport $300, and the rest is savings.";

// `isGuidanceEvidence` for the "editing" intent requires BOTH an editing
// vocabulary anchor (scrivener | split-screen | side-by-side | ...) AND an
// editing root word (edit | draft | revision | ...). The content below is
// crafted to clear that filter so the guidance pipeline produces stable
// non-empty output.
const GUIDANCE_EDITING_CONTENT =
  "For editing drafts, I prefer Scrivener's split-screen mode so revisions can compare notes side-by-side.";

const CHRONOLOGY_CONTENT =
  "The order in which I introduced topics was: pronunciation, then vocabulary, then grammar, then conversation practice.";

const FIXTURE_MESSAGES: FixtureMessage[] = [
  {
    turn_index: 1,
    role: "user",
    content:
      "I started learning Turkish pronunciation with quantitative targets: 30 minutes daily, focusing on vowel harmony.",
  },
  {
    turn_index: 2,
    role: "assistant",
    content:
      "A structured practice plan with daily repetition will build vowel harmony intuition over four weeks.",
  },
  {
    turn_index: 3,
    role: "user",
    content: TARGETED_FACT_CONTENT,
  },
  {
    turn_index: 4,
    role: "assistant",
    content:
      "Tracking monthly expenses at $2,400 with that breakdown gives you roughly $500 of discretionary savings each month.",
  },
  {
    turn_index: 5,
    role: "user",
    content: GUIDANCE_EDITING_CONTENT,
  },
  {
    turn_index: 6,
    role: "assistant",
    content:
      "I will use Scrivener split-screen for revisions so each edit pass can compare notes side-by-side as you asked.",
  },
  {
    turn_index: 7,
    role: "user",
    content: CHRONOLOGY_CONTENT,
  },
  {
    turn_index: 8,
    role: "assistant",
    content:
      "That sequence — pronunciation, vocabulary, grammar, conversation — follows a solid progressive language-learning arc.",
  },
];

// ──────────────────────────────────────────────────────────────────────────
// FakeLcmEngine — supports multiple session IDs and records every call so the
// fallback-merge and event-order-no-merge properties can be asserted.
// ──────────────────────────────────────────────────────────────────────────

export interface FakeEngineCall {
  op: "searchContextFull" | "expandContext" | "getStats";
  sessionId?: string;
  query?: string;
  limit?: number;
  fromTurn?: number;
  toTurn?: number;
}

export class FakeLcmEngine implements ExplicitCueRecallEngine {
  readonly calls: FakeEngineCall[] = [];
  readonly enabled = true;

  constructor(
    private readonly sessions: Map<string, FixtureMessage[]>,
    private readonly searchHitsBySession: Map<string, number[]> = new Map(),
    private readonly faultingSessions: ReadonlySet<string> = new Set(),
  ) {}

  reset(): void {
    this.calls.length = 0;
  }

  async searchContextFull(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<
    Array<{
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score?: number;
    }>
  > {
    this.calls.push({ op: "searchContextFull", query, limit, sessionId });
    if (sessionId && this.faultingSessions.has(sessionId)) {
      throw new Error(`FakeLcmEngine: simulated read fault on session ${sessionId}`);
    }
    const messages = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!messages) return [];
    const hits = this.searchHitsBySession.get(sessionId) ?? [];
    return hits
      .map((turnIndex, index) => {
        const message = messages.find((entry) => entry.turn_index === turnIndex);
        if (!message) return null;
        return {
          turn_index: message.turn_index,
          role: message.role,
          content: message.content,
          session_id: sessionId,
          score: 100 - index,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    _maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
    this.calls.push({ op: "expandContext", sessionId, fromTurn, toTurn });
    if (this.faultingSessions.has(sessionId)) {
      throw new Error(`FakeLcmEngine: simulated read fault on session ${sessionId}`);
    }
    const messages = this.sessions.get(sessionId);
    if (!messages) return [];
    return messages.filter(
      (message) => message.turn_index >= fromTurn && message.turn_index <= toTurn,
    );
  }

  async getStats(sessionId?: string): Promise<{
    totalMessages: number;
    maxTurnIndex?: number;
  }> {
    this.calls.push({ op: "getStats", sessionId });
    if (sessionId && this.faultingSessions.has(sessionId)) {
      throw new Error(`FakeLcmEngine: simulated read fault on session ${sessionId}`);
    }
    const messages = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!messages) return { totalMessages: 0 };
    return {
      totalMessages: messages.length,
      maxTurnIndex: Math.max(...messages.map((message) => message.turn_index)),
    };
  }
}

function makeFixtureEngine(opts?: {
  fallbackMessages?: FixtureMessage[];
  searchHitsPrimary?: number[];
  searchHitsFallback?: number[];
  faultingSessions?: ReadonlySet<string>;
}): FakeLcmEngine {
  const sessions = new Map<string, FixtureMessage[]>([
    [FIXTURE_SESSION_PRIMARY, FIXTURE_MESSAGES],
  ]);
  if (opts?.fallbackMessages) {
    sessions.set(FIXTURE_SESSION_FALLBACK, opts.fallbackMessages);
  }
  const searchHits = new Map<string, number[]>();
  if (opts?.searchHitsPrimary) {
    searchHits.set(FIXTURE_SESSION_PRIMARY, opts.searchHitsPrimary);
  }
  if (opts?.searchHitsFallback && opts.fallbackMessages) {
    searchHits.set(FIXTURE_SESSION_FALLBACK, opts.searchHitsFallback);
  }
  return new FakeLcmEngine(
    sessions,
    searchHits,
    opts?.faultingSessions ?? new Set<string>(),
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Snapshot tests — pin the EXACT current output of each pipeline on the
// fixture corpus. These strings are the migration target: every spine PR
// must reproduce them byte-for-byte. The label format `[sessionId, turn N,
// role(, score NNN.NNN)]` is owned by evidence-pack.ts (shared by all four
// pipelines), so it is already stable across the migration; the snapshot
// pins the per-pipeline content selection, ordering, cue-appending, and
// summary insertion.
// ──────────────────────────────────────────────────────────────────────────

test("snapshot: targeted-fact pipeline on fixture corpus (single session)", async () => {
  const engine = makeFixtureEngine({ searchHitsPrimary: [3] });
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What are my monthly expenses?",
    maxChars: 1_200,
    maxSearchResults: 8,
    maxScanWindowTurns: 8,
    maxScanWindowTokens: 4_000,
  });
  // Snapshot pinned at #1539 PR1. Targeted-fact:
  //   - appends `Normalized numeric cues: …` to each item (per-tier hook)
  //   - ranks DESC (turn 3 score=100 above turn 4 unscored)
  //   - budget-adjusts: the summary insertion is subtracted from the
  //     evidence budget BEFORE buildEvidencePack runs
  // The spine migration MUST reproduce this byte-for-byte.
  assert.equal(output, TARGETED_FACT_SNAPSHOT);
});

const TARGETED_FACT_SNAPSHOT = [
  "## Targeted fact evidence",
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 3, user, score 100.000]: ${TARGETED_FACT_CONTENT}`,
  "",
  "Normalized numeric cues: 2400 dollars; 1200 dollars; 400 dollars; 300 dollars.",
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 4, assistant]: Tracking monthly expenses at $2,400 with that breakdown gives you roughly $500 of discretionary savings each month.`,
  "",
  "Normalized numeric cues: 2400 dollars; 500 dollars.",
].join("\n");

test("snapshot: response-guidance pipeline on fixture corpus (single session)", async () => {
  const engine = makeFixtureEngine({ searchHitsPrimary: [5] });
  const output = await buildResponseGuidanceRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "How should I approach editting my draft?",
    maxChars: 1_600,
    maxSearchResults: 8,
    maxScanWindowTurns: 8,
    maxScanWindowTokens: 4_000,
  });
  // Snapshot pinned at #1539 PR1. Response-guidance:
  //   - appends `Normalized response guidance: …` cue to each item's content
  //     (per-tier hook: `appendGuidanceCues`)
  //   - inserts a single cue preamble right after the title (budget-adjusted:
  //     `maxChars - cueInsertion.length` is passed to buildEvidencePack)
  //   - ranks DESC (turn 5, score=100, above turn 6, unscored)
  assert.equal(output, RESPONSE_GUIDANCE_SNAPSHOT);
});

const RESPONSE_GUIDANCE_SNAPSHOT = [
  "## Response guidance evidence",
  "",
  "Normalized response guidance: use split-screen view; side-by-side comparison.",
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 5, user, score 100.000]: Normalized response guidance: use split-screen view; side-by-side comparison.`,
  "",
  GUIDANCE_EDITING_CONTENT,
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 6, assistant]: Normalized response guidance: use split-screen view; side-by-side comparison.`,
  "",
  "I will use Scrivener split-screen for revisions so each edit pass can compare notes side-by-side as you asked.",
].join("\n");

test("snapshot: explicit-cue pipeline on fixture corpus (single session)", async () => {
  const engine = makeFixtureEngine({ searchHitsPrimary: [1] });
  const output = await buildExplicitCueRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What did I say at turn 1?",
    maxChars: 1_600,
    maxReferences: 4,
  });
  // Snapshot pinned at #1539 PR1. Explicit-cue:
  //   - intentionally UNSCORED (issue #1539: "keep its intentional no-scoring
  //     behavior — the config makes that explicit"); insertion order is the
  //     contract, NOT score order
  //   - turn-1 query triggers turn-reference collection → expand around
  //     turn 1, picking up turns 1, 2, 3 within the budget
  assert.equal(output, EXPLICIT_CUE_SNAPSHOT);
});

const EXPLICIT_CUE_SNAPSHOT = [
  "## Explicit Cue Evidence",
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 1, user]: I started learning Turkish pronunciation with quantitative targets: 30 minutes daily, focusing on vowel harmony.`,
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 2, assistant]: A structured practice plan with daily repetition will build vowel harmony intuition over four weeks.`,
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 3, user]: ${TARGETED_FACT_CONTENT}`,
].join("\n");

test("snapshot: event-order pipeline on fixture corpus (single session)", async () => {
  const engine = makeFixtureEngine();
  const output = await buildEventOrderRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What is the order in which I introduced topics?",
    maxChars: 2_400,
    maxItems: 8,
    maxScanWindowTurns: 12,
    maxScanWindowTokens: 8_000,
  });
  // Snapshot pinned at #1539 PR1. Event-order:
  //   - ASC sort (turn_index ascending after the rank>=6 gate)
  //   - prepend `Chronological cue labels: …` to each item (per-tier hook)
  //   - summary line with chronology outline
  //   - NOTE: this snapshot is taken with a generous budget (2400 chars)
  //     so the outline-budget-accounting fix in the event-order migration
  //     PR does NOT change this output. A separate tight-budget snapshot
  //     in the event-order migration PR will pin the corrected behavior.
  assert.equal(output, EVENT_ORDER_SNAPSHOT);
});

const EVENT_ORDER_SNAPSHOT = [
  "## Chronological event evidence",
  "",
  "Chronological evidence is sorted by turn number. Chronology outline: turn 7: interaction with introduced; turn 7: interaction with topics. Use these turns to preserve the order in which the user raised the topics.",
  "",
  `[${FIXTURE_SESSION_PRIMARY}, turn 7, user]: Chronological cue labels: interaction with introduced; interaction with topics.`,
  "",
  "The order in which I introduced topics was: pronunciation, then vocabulary, then grammar, then conversation practice.",
].join("\n");

// ──────────────────────────────────────────────────────────────────────────
// Divergence-pinning tests — each test pins one declared divergence so the
// spine migration can be verified field-by-field.
// ──────────────────────────────────────────────────────────────────────────

test("divergence: dedup collapses identical ids (same turn_index hit twice)", async () => {
  // Two search hits on the same turn_index produce two raw candidates, but
  // the rank/dedupe pass collapses them to one item (id-based dedup).
  const engine = makeFixtureEngine({ searchHitsPrimary: [3, 3] });
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What are my monthly expenses?",
    maxChars: 4_000,
    maxSearchResults: 16,
  });
  const matches = output.match(/turn 3,/g) ?? [];
  assert.equal(
    matches.length,
    1,
    `expected exactly one 'turn 3' label after id-dedup, got ${matches.length} in:\n${output}`,
  );
});

test("divergence: dedup collapses whitespace-only content differences (normalized content key)", async () => {
  // Two distinct turns whose content differs ONLY in whitespace/case: the
  // normalized-content dedup key (`toLowerCase().replace(/\s+/g, " ").trim()`)
  // must collapse them to one item — the FIRST seen wins.
  const sessions = new Map<string, FixtureMessage[]>([
    [FIXTURE_SESSION_PRIMARY, [
      { turn_index: 10, role: "user", content: TARGETED_FACT_CONTENT },
      { turn_index: 11, role: "user", content: TARGETED_FACT_CONTENT.toUpperCase() },
    ]],
  ]);
  const engine = new FakeLcmEngine(sessions, new Map([[FIXTURE_SESSION_PRIMARY, [10, 11]]]));
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What are my monthly expenses?",
    maxChars: 4_000,
    maxSearchResults: 16,
  });
  const turn10Matches = output.match(/turn 10,/g) ?? [];
  const turn11Matches = output.match(/turn 11,/g) ?? [];
  assert.equal(turn10Matches.length, 1, `expected turn 10 once, got ${turn10Matches.length} in:\n${output}`);
  assert.equal(turn11Matches.length, 0, `expected turn 11 deduped away, got ${turn11Matches.length}`);
});

test("divergence: event-order threshold filter drops items scoring below rank 6", async () => {
  // The hardcoded `rank >= 6` filter (event-order-recall.ts line ~158,
  // inlined and undocumented pre-spine) must drop filler turns that don't
  // engage the chronology vocabulary. The spine makes this a declared
  // `rankThreshold: 6` config field.
  const sessions = new Map<string, FixtureMessage[]>([
    [FIXTURE_SESSION_PRIMARY, [
      { turn_index: 1, role: "user", content: "Hello, nice weather today." },
      { turn_index: 2, role: "user", content: CHRONOLOGY_CONTENT },
      { turn_index: 3, role: "user", content: "I had lunch at noon." },
    ]],
  ]);
  const engine = new FakeLcmEngine(sessions);
  const output = await buildEventOrderRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What is the order in which I introduced topics?",
    maxChars: 4_000,
    maxItems: 8,
    maxScanWindowTurns: 12,
    maxScanWindowTokens: 4_000,
  });
  assert.ok(
    output.includes(`[${FIXTURE_SESSION_PRIMARY}, turn 2,`),
    `expected turn 2 in event-order output, got:\n${output}`,
  );
  assert.ok(!output.includes("turn 1,"), "filler turn 1 must be threshold-filtered");
  assert.ok(!output.includes("turn 3,"), "filler turn 3 must be threshold-filtered");
});

test("divergence: targeted-fact ranks DESC (turnIndex DESC among score ties)", async () => {
  // Three numeric-fact turns with similar scoring: the DESC sort breaks
  // ties by turnIndex DESC (recency) — the latest update ranks first.
  // Each turn uses the `finally reached` recency cue that
  // `scoreTargetedFactEvidence` rewards, so all three clear the evidence
  // filter and the comparator is exercised on the full set.
  const sessions = new Map<string, FixtureMessage[]>([
    [FIXTURE_SESSION_PRIMARY, [
      { turn_index: 2, role: "user", content: "My monthly expenses finally reached $1,000 last year." },
      { turn_index: 5, role: "user", content: "My monthly expenses finally reached $2,400 after the raise." },
      { turn_index: 9, role: "user", content: "My monthly expenses finally reached $3,000 after the move." },
    ]],
  ]);
  const engine = new FakeLcmEngine(sessions);
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What are my monthly expenses?",
    maxChars: 6_000,
    maxSearchResults: 16,
  });
  const pos9 = output.indexOf("turn 9,");
  const pos5 = output.indexOf("turn 5,");
  const pos2 = output.indexOf("turn 2,");
  assert.ok(pos9 > -1, `expected turn 9 in output:\n${output}`);
  assert.ok(pos5 > -1, `expected turn 5 in output:\n${output}`);
  assert.ok(pos2 > -1, `expected turn 2 in output:\n${output}`);
  assert.ok(
    pos9 < pos5 && pos5 < pos2,
    `expected DESC turn ordering 9 < 5 < 2, got positions ${pos9}, ${pos5}, ${pos2}`,
  );
});

test("divergence: event-order ranks ASC (turnIndex ascending after the score gate)", async () => {
  // Three chronology turns that all clear the rank>=6 gate. Event-order
  // must emit them in turnIndex ASC order — the OPPOSITE of the relevance-
  // ranked pipelines. This is the divergence the spine declares as
  // `secondarySort` (ASC=chronological vs DESC=recency).
  const sessions = new Map<string, FixtureMessage[]>([
    [FIXTURE_SESSION_PRIMARY, [
      { turn_index: 30, role: "user", content: "The order in which I introduced topics was: pronunciation, then vocabulary, then grammar." },
      { turn_index: 10, role: "user", content: "The order in which I introduced topics was: setup, then plan, then execute." },
      { turn_index: 20, role: "user", content: "The order in which I introduced topics was: reading, then writing, then speaking." },
    ]],
  ]);
  const engine = new FakeLcmEngine(sessions);
  const output = await buildEventOrderRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What is the order in which I introduced topics?",
    maxChars: 6_000,
    maxItems: 8,
    maxScanWindowTurns: 12,
    maxScanWindowTokens: 8_000,
  });
  const pos10 = output.indexOf("turn 10,");
  const pos20 = output.indexOf("turn 20,");
  const pos30 = output.indexOf("turn 30,");
  assert.ok(pos10 > -1 && pos20 > -1 && pos30 > -1, `all three turns present in:\n${output}`);
  assert.ok(
    pos10 < pos20 && pos20 < pos30,
    `expected ASC ordering 10 < 20 < 30, got ${pos10}, ${pos20}, ${pos30}`,
  );
});

// NOTE: the DESC tertiary score tiebreaker, the ASC content.localeCompare
// tiebreaker, and the undefined-turnIndex sentinel behavior (DESC: -1,
// ASC: Number.MAX_SAFE_INTEGER) are comparator properties centralized in
// the spine module (PR2 recall-pipeline-stages.ts). They are tested
// directly in recall-pipeline-stages.test.ts (tests 3-12). They are not
// observable through the end-to-end builder surface because real engines
// always produce items with numeric turn_index, and the end-to-end
// pipelines' rank and turnIndex values are almost never simultaneously
// tied at the builder level.

test("divergence: fallback-merge — strong fallback hit outranks weak primary hit", async () => {
  // #1505 fallback merge: the primary session has NO evidence for this
  // query; the fallback session has a strong numeric-fact mention. The
  // merged pass must surface the fallback's evidence — without #1505, the
  // short-circuit on the empty primary would have returned "".
  const fallbackMessages: FixtureMessage[] = [
    { turn_index: 2, role: "user", content: "My monthly expenses are exactly $2,400.50, broken down precisely." },
  ];
  const engine = makeFixtureEngine({
    fallbackMessages,
    searchHitsPrimary: [],
    searchHitsFallback: [2],
  });
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    sessionIds: [FIXTURE_SESSION_PRIMARY, FIXTURE_SESSION_FALLBACK],
    query: "What are my monthly expenses?",
    maxChars: 4_000,
    maxSearchResults: 16,
  });
  assert.ok(
    output.includes("$2,400.50"),
    `expected fallback evidence in merged output, got:\n${output}`,
  );
});

test("divergence: fallback-merge — cross-key content dedup", async () => {
  // Both sessions carry the SAME content under different session_ids. The
  // merged dedup pass keys on normalized content (NOT session_id+turn_index),
  // so the duplicate must collapse to one emission.
  const fallbackMessages: FixtureMessage[] = [
    { turn_index: 7, role: "user", content: TARGETED_FACT_CONTENT },
  ];
  const sessions = new Map<string, FixtureMessage[]>([
    [FIXTURE_SESSION_PRIMARY, [
      { turn_index: 3, role: "user", content: TARGETED_FACT_CONTENT },
    ]],
    [FIXTURE_SESSION_FALLBACK, fallbackMessages],
  ]);
  const engine = new FakeLcmEngine(
    sessions,
    new Map([[FIXTURE_SESSION_PRIMARY, [3]], [FIXTURE_SESSION_FALLBACK, [7]]]),
  );
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    sessionIds: [FIXTURE_SESSION_PRIMARY, FIXTURE_SESSION_FALLBACK],
    query: "What are my monthly expenses?",
    maxChars: 6_000,
    maxSearchResults: 16,
  });
  const occurrences = (output.match(/turn 3,|turn 7,/g) ?? []).length;
  assert.equal(
    occurrences,
    1,
    `expected cross-key content dedup to emit exactly one of turn 3 / turn 7, got ${occurrences} in:\n${output}`,
  );
});

test("divergence: fallback-merge — per-key fault isolation (a corrupt fallback does not discard primary evidence)", async () => {
  // The fallback session FAULTS on read; the primary session's evidence
  // must still surface. `gatherAcrossReadSessions` isolates the per-key
  // failure rather than letting it abort the whole pass — this is the
  // fault-isolation contract the spine must preserve.
  const fallbackMessages: FixtureMessage[] = [
    { turn_index: 2, role: "user", content: "Fallback content that will never be read." },
  ];
  const engine = makeFixtureEngine({
    fallbackMessages,
    searchHitsPrimary: [3],
    searchHitsFallback: [2],
    faultingSessions: new Set([FIXTURE_SESSION_FALLBACK]),
  });
  const output = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    sessionIds: [FIXTURE_SESSION_PRIMARY, FIXTURE_SESSION_FALLBACK],
    query: "What are my monthly expenses?",
    maxChars: 4_000,
    maxSearchResults: 16,
  });
  assert.ok(
    output.includes("$2,400"),
    `expected primary evidence to survive fallback fault, got:\n${output}`,
  );
  assert.ok(
    !output.includes("Fallback content that will never be read."),
    "faulting fallback must NOT contribute evidence",
  );
});

test("divergence: event-order does NOT call gatherAcrossReadSessions (turn_index is local to each session_id)", async () => {
  // Event-order's `EventOrderRecallOptions` carries only a single `sessionId`
  // (no `sessionIds`). Even if the orchestrator's outer `firstNonEmptyLcmRead`
  // walks the key set, the BUILDER itself never sees more than one session.
  // This test pins that contract: pass an ordered key set in `sessionIds`
  // (via a cast), and verify the builder ignores it and reads ONLY `sessionId`.
  const fallbackMessages: FixtureMessage[] = [
    { turn_index: 1, role: "user", content: "Fallback-only chronology: the order in which I introduced topics was setup first." },
  ];
  const engine = makeFixtureEngine({ fallbackMessages });
  const output = await buildEventOrderRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    // Intentionally pass sessionIds via cast; the builder must not honor it.
    ...( { sessionIds: [FIXTURE_SESSION_PRIMARY, FIXTURE_SESSION_FALLBACK] } as unknown as Record<string, unknown> ),
    query: "What is the order in which I introduced topics?",
    maxChars: 4_000,
    maxItems: 8,
    maxScanWindowTurns: 12,
    maxScanWindowTokens: 4_000,
  } as Parameters<typeof buildEventOrderRecallSection>[0]);
  // Only the primary session was read; the fallback's chronology content
  // does NOT appear (turn_index is local — merging would misstate order).
  assert.ok(
    !output.includes("Fallback-only chronology"),
    `event-order must NOT merge across keys; fallback leaked into:\n${output}`,
  );
  const fallbackCalls = engine.calls.filter(
    (call) => call.sessionId === FIXTURE_SESSION_FALLBACK,
  );
  assert.equal(
    fallbackCalls.length,
    0,
    `event-order must not read fallback sessions, but got calls: ${JSON.stringify(fallbackCalls)}`,
  );
});

test("divergence: zero-limit contracts (0 maxResults / 0 maxItems / 0 maxChars all return empty)", async () => {
  // Per AGENTS.md §3 ("Config is runtime API"): `enabled=false` and `0`
  // limits are compatibility contracts, NEVER coerce to non-zero. Each
  // builder must respect a zero limit by returning "".
  const engine = makeFixtureEngine({ searchHitsPrimary: [3] });

  const targetedEmptyResults = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What are my monthly expenses?",
    maxChars: 4_000,
    maxSearchResults: 0,
  });
  assert.equal(targetedEmptyResults, "", "targeted-fact maxSearchResults=0 must yield empty");

  const targetedEmptyBudget = await buildTargetedFactRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What are my monthly expenses?",
    maxChars: 0,
    maxSearchResults: 8,
  });
  assert.equal(targetedEmptyBudget, "", "targeted-fact maxChars=0 must yield empty");

  const eventEmptyItems = await buildEventOrderRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What is the order in which I introduced topics?",
    maxChars: 4_000,
    maxItems: 0,
  });
  assert.equal(eventEmptyItems, "", "event-order maxItems=0 must yield empty");

  const eventEmptyBudget = await buildEventOrderRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What is the order in which I introduced topics?",
    maxChars: 0,
    maxItems: 8,
  });
  assert.equal(eventEmptyBudget, "", "event-order maxChars=0 must yield empty");

  const guidanceEmptyResults = await buildResponseGuidanceRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "How should I approach editting my draft?",
    maxChars: 4_000,
    maxSearchResults: 0,
  });
  assert.equal(guidanceEmptyResults, "", "response-guidance maxSearchResults=0 must yield empty");

  const guidanceEmptyBudget = await buildResponseGuidanceRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "How should I approach editting my draft?",
    maxChars: 0,
    maxSearchResults: 8,
  });
  assert.equal(guidanceEmptyBudget, "", "response-guidance maxChars=0 must yield empty");

  const explicitEmptyReferences = await buildExplicitCueRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What did I say at turn 1?",
    maxChars: 4_000,
    maxReferences: 0,
  });
  assert.equal(explicitEmptyReferences, "", "explicit-cue maxReferences=0 must yield empty");

  const explicitEmptyBudget = await buildExplicitCueRecallSection({
    engine,
    sessionId: FIXTURE_SESSION_PRIMARY,
    query: "What did I say at turn 1?",
    maxChars: 0,
    maxReferences: 4,
  });
  assert.equal(explicitEmptyBudget, "", "explicit-cue maxChars=0 must yield empty");
});

test("divergence: planner-mode gating contract (null/undefined engine yields empty for every pipeline)", async () => {
  // The orchestrator gates each builder with `(recallMode !== "no_recall")`
  // BEFORE invoking it (orchestrator.ts lines ~10298, 10341, 10390, 10444,
  // 10493). The builders themselves do not see the mode; they simply require
  // an enabled engine. Pin that contract: a null engine yields empty
  // regardless of query/budget, so the no_recall short-circuit composes
  // correctly with the per-builder engine guard.
  const outputs = await Promise.all([
    buildTargetedFactRecallSection({
      engine: null,
      sessionId: FIXTURE_SESSION_PRIMARY,
      query: "What are my monthly expenses?",
      maxChars: 4_000,
    }),
    buildResponseGuidanceRecallSection({
      engine: null,
      sessionId: FIXTURE_SESSION_PRIMARY,
      query: "How should I approach editting my draft?",
      maxChars: 4_000,
    }),
    buildExplicitCueRecallSection({
      engine: null,
      sessionId: FIXTURE_SESSION_PRIMARY,
      query: "What did I say at turn 1?",
      maxChars: 4_000,
    }),
    buildEventOrderRecallSection({
      engine: null,
      sessionId: FIXTURE_SESSION_PRIMARY,
      query: "What is the order in which I introduced topics?",
      maxChars: 4_000,
    }),
  ]);
  for (const [index, output] of outputs.entries()) {
    assert.equal(output, "", `builder ${index} must return empty for null engine`);
  }
});
