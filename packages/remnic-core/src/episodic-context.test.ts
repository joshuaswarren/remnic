import assert from "node:assert/strict";
import test from "node:test";

import {
  compareEpisodeWindows,
  factsNeedingQuoteFallback,
  planEpisodeWindows,
  planEpisodeWindowsWithFallback,
  resolveProvenanceTurnIndex,
  type EpisodicFactInput,
} from "./episodic-context.js";
import { cleanArchivedUserMessage } from "./user-message-cleaning.js";
import { RecallResultFormatter } from "./orchestration/recall-result-formatter.js";
import { parseConfig } from "./config.js";
import type { ProvenanceSource } from "./types.js";

const SEP = String.fromCharCode(1);

function source(overrides: Partial<ProvenanceSource> = {}): ProvenanceSource {
  return {
    sessionKey: "session-a",
    observedAt: "2026-08-16T00:00:00.000Z",
    quote: "the atlas cluster stores edges",
    ...overrides,
  };
}

function fact(
  memoryId: string,
  rank: number,
  sources: ProvenanceSource[] | undefined,
): EpisodicFactInput {
  return { memoryId, rank, sources };
}

test("resolveProvenanceTurnIndex parses the fingerprint's trailing turn index", () => {
  const fingerprint = `user${SEP}hello world${SEP}thread-1${SEP}42`;
  assert.equal(resolveProvenanceTurnIndex(fingerprint), 42);
  assert.equal(resolveProvenanceTurnIndex("7"), 7);
  assert.equal(resolveProvenanceTurnIndex("not-a-number"), null);
  assert.equal(resolveProvenanceTurnIndex(`user${SEP}x${SEP}t${SEP}12x`), null);
  assert.equal(resolveProvenanceTurnIndex(undefined), null);
  assert.equal(resolveProvenanceTurnIndex("-3"), null);
});

test("planEpisodeWindows returns [] before any work when limits are zero", () => {
  const facts = [
    fact("m1", 0, [source({ turnId: "5" })]),
  ];
  assert.deepEqual(planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 0, maxTurnsPerEpisode: 8 }), []);
  assert.deepEqual(planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 2, maxTurnsPerEpisode: 0 }), []);
});

test("planEpisodeWindows skips facts without structured sources and unparseable turnIds", () => {
  const facts = [
    fact("m1", 0, undefined),
    fact("m2", 1, []),
    fact("m3", 2, [source({ turnId: "abc" })]),
    fact("m4", 3, [source({ turnId: "10" })]),
  ];
  const windows = planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 2, maxTurnsPerEpisode: 8 });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0], {
    sessionKey: "session-a",
    fromTurn: 9,
    toTurn: 12,
    factRank: 3,
    memoryIds: ["m4"],
  });
});

test("planEpisodeWindows merges overlapping and adjacent windows without double-counting turns", () => {
  // turn 5 -> [4,7); turn 6 -> [5,8): overlap -> one merged window [4,8).
  const facts = [
    fact("m1", 0, [source({ turnId: "5" })]),
    fact("m2", 1, [source({ turnId: "6" })]),
  ];
  const windows = planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 2, maxTurnsPerEpisode: 8 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.fromTurn, 4);
  assert.equal(windows[0]!.toTurn, 8);
  assert.deepEqual(windows[0]!.memoryIds, ["m1", "m2"]);
  assert.equal(windows[0]!.factRank, 0);

  // Boundary adjacency: turn 5 -> [4,7) and turn 7 -> [6,9) share no source
  // turn but read as one episode; they must still merge into [4,9).
  const adjacent = [
    fact("m1", 0, [source({ turnId: "5" })]),
    fact("m2", 1, [source({ turnId: "7" })]),
  ];
  const mergedAdjacent = planEpisodeWindows({
    recalledFacts: adjacent,
    maxEpisodes: 2,
    maxTurnsPerEpisode: 8,
  });
  assert.equal(mergedAdjacent.length, 1);
  assert.equal(mergedAdjacent[0]!.toTurn - mergedAdjacent[0]!.fromTurn, 5);

  // One gap: turn 5 -> [4,7) and turn 8 -> [7,10) are adjacent and merge;
  // turn 9+ creates a second window only when disjoint.
  const disjoint = [
    fact("m1", 0, [source({ turnId: "2" })]),
    fact("m2", 1, [source({ turnId: "50" })]),
  ];
  const two = planEpisodeWindows({ recalledFacts: disjoint, maxEpisodes: 2, maxTurnsPerEpisode: 8 });
  assert.equal(two.length, 2);
});

test("planEpisodeWindows caps merged span and keeps the best-ranked fact's turn inside", () => {
  // Overlapping sources at turns 2/4/6/8 merge into [1,10) — span 9 with a
  // cap of 4. The trim must keep the rank-0 fact's turn 2 inside.
  const facts = [
    fact("m-best", 0, [source({ turnId: "2" })]),
    fact("m-mid", 3, [source({ turnId: "4" })]),
    fact("m-late", 5, [source({ turnId: "6" })]),
    fact("m-last", 6, [source({ turnId: "8" })]),
  ];
  const windows = planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 2, maxTurnsPerEpisode: 4 });
  assert.equal(windows.length, 1);
  const window = windows[0]!;
  assert.equal(window.toTurn - window.fromTurn, 4);
  assert.ok(
    window.fromTurn <= 2 && 2 < window.toTurn,
    `best turn 2 must be inside [${window.fromTurn},${window.toTurn})`,
  );
  assert.equal(window.factRank, 0);
});

test("planEpisodeWindows is deterministic under input shuffle", () => {
  const facts: EpisodicFactInput[] = [
    fact("m1", 2, [source({ sessionKey: "s-b", turnId: "30" })]),
    fact("m2", 0, [source({ sessionKey: "s-b", turnId: "5" })]),
    fact("m3", 0, [source({ sessionKey: "s-a", turnId: "5" })]),
    fact("m4", 1, [source({ sessionKey: "s-a", turnId: "40" })]),
  ];
  const baseline = planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 3, maxTurnsPerEpisode: 8 });
  for (let shuffle = 0; shuffle < 8; shuffle += 1) {
    const copy = [...facts];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    assert.deepEqual(
      planEpisodeWindows({ recalledFacts: copy, maxEpisodes: 3, maxTurnsPerEpisode: 8 }),
      baseline,
    );
  }
  // Ordering contract: rank asc, then sessionKey asc, then fromTurn asc.
  assert.deepEqual(
    baseline.map((w) => w.sessionKey),
    ["s-a", "s-b", "s-a"],
  );
  assert.ok(compareEpisodeWindows(baseline[0]!, baseline[1]!) < 0);
});

test("planEpisodeWindows honors maxEpisodes by best fact rank", () => {
  const facts = [
    fact("m-late", 9, [source({ sessionKey: "s-late", turnId: "5" })]),
    fact("m-early", 0, [source({ sessionKey: "s-early", turnId: "5" })]),
  ];
  const windows = planEpisodeWindows({ recalledFacts: facts, maxEpisodes: 1, maxTurnsPerEpisode: 8 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.sessionKey, "s-early");
});

test("quote fallback: facts whose turnIds all fail resolve through the locator", async () => {
  const facts = [
    fact("m-fallback", 0, [source({ sessionKey: "session-a", turnId: "not-numeric" })]),
    fact("m-direct", 1, [source({ sessionKey: "session-a", turnId: "20" })]),
  ];
  assert.deepEqual(
    factsNeedingQuoteFallback(facts).map((f) => f.memoryId),
    ["m-fallback"],
  );
  const located = await planEpisodeWindowsWithFallback({
    recalledFacts: facts,
    maxEpisodes: 2,
    maxTurnsPerEpisode: 8,
    locateQuote: async (quote, sessionKey) => {
      assert.equal(quote, "the atlas cluster stores edges");
      assert.equal(sessionKey, "session-a");
      return 3;
    },
  });
  // The located quote (turn 3) and the direct turn-20 source are disjoint
  // sessions of turns: two windows, fallback first (better rank).
  assert.equal(located.length, 2);
  assert.deepEqual(located[0], {
    sessionKey: "session-a",
    fromTurn: 2,
    toTurn: 5,
    factRank: 0,
    memoryIds: ["m-fallback"],
  });
  assert.deepEqual(located[1]!.memoryIds, ["m-direct"]);
});

test("quote fallback: a locator miss means no episode; locator errors are swallowed", async () => {
  const facts = [fact("m1", 0, [source({ turnId: "???" })])];
  const missed = await planEpisodeWindowsWithFallback({
    recalledFacts: facts,
    maxEpisodes: 2,
    maxTurnsPerEpisode: 8,
    locateQuote: async () => null,
  });
  assert.deepEqual(missed, []);
  const threw = await planEpisodeWindowsWithFallback({
    recalledFacts: facts,
    maxEpisodes: 2,
    maxTurnsPerEpisode: 8,
    locateQuote: async () => {
      throw new Error("archive unavailable");
    },
  });
  assert.deepEqual(threw, []);
});

test("formatEpisodicContext renders episodes and returns null when empty", () => {
  const formatter = new RecallResultFormatter(parseConfig({ memoryDir: "/tmp/remnic-episodic-test" }));
  assert.equal(formatter.formatEpisodicContext([]), null);
  const rendered = formatter.formatEpisodicContext([
    {
      sessionKey: "session-alpha-long",
      fromTurn: 4,
      toTurn: 7,
      memoryIds: ["m1", "m2"],
      turns: [
        { role: "user", content: "we chose postgres" },
        { role: "assistant", content: "noted" },
      ],
    },
  ]);
  assert.ok(rendered!.startsWith("## Source Episodes\n\n### Episode: session-… turns 4-6 (supports [m1, m2])"));
  assert.ok(rendered!.includes("user: we chose postgres"));
});

test("cleanArchivedUserMessage strips an injected memory-context preamble (shipped cleaner contract)", () => {
  // The shared cleaner (moved verbatim from the host wiring) strips a LEADING
  // `## Memory Context` preamble up to the next `## ` header or end of string.
  const leadingWithHeader =
    "## Memory Context (Remnic)\n\n- old fact\n\n## Actual Question\nWhere do we stand?";
  assert.equal(
    cleanArchivedUserMessage(leadingWithHeader),
    "## Actual Question\nWhere do we stand?",
  );
  const wrapped =
    "<supermemory-context>injected</supermemory-context>Real question about the atlas cluster";
  assert.equal(
    cleanArchivedUserMessage(wrapped),
    "Real question about the atlas cluster",
  );
  // A block that is not leading stays: a user writing this title mid-message
  // keeps it (documented behavior — anchored strip, no free-form deletion).
  const userAuthored =
    "Reminder:\n## Memory Context (Remnic)\nthis is my own note";
  assert.equal(cleanArchivedUserMessage(userAuthored), userAuthored);
});

test("cleanArchivedUserMessage preserves text before and between wrappers (round 4 regression)", () => {
  const mixed =
    "keep this <supermemory-context>first</supermemory-context> and this <supermemory-context k=\"v\">second</supermemory-context> end";
  assert.equal(
    cleanArchivedUserMessage(mixed),
    "keep this and this end",
  );
});
