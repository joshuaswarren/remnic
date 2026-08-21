import assert from "node:assert/strict";
import test from "node:test";

import { AccessLcmSurface, type AccessLcmSurfaceDeps } from "./access-lcm-surface.js";
import {
  AccessRecallSurface,
  type AccessRecallSurfaceDeps,
} from "./access-recall-surface.js";
import { buildEventOrderRecallSection } from "./event-order-recall.js";
import { buildExplicitCueRecallSection, type ExplicitCueRecallEngine } from "./explicit-cue-recall.js";
import { buildFocusedListRecallSection } from "./focused-list-recall.js";
import {
  isSameLcmRow,
  lcmEvidenceIdentity,
} from "./lcm/evidence-identity.js";
import { buildResponseGuidanceRecallSection } from "./response-guidance-recall.js";
import { buildTargetedFactRecallSection } from "./targeted-fact-recall.js";

interface TestRow {
  id?: number;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
}

class LineageEngine implements ExplicitCueRecallEngine {
  constructor(
    private readonly rows: TestRow[],
    private readonly searchRowId?: number,
    private readonly searchContent?: string,
  ) {}

  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    _maxTokens: number,
  ): Promise<TestRow[]> {
    return this.rows.filter((row) =>
      row.session_id === sessionId &&
      row.turn_index >= fromTurn &&
      row.turn_index <= toTurn
    );
  }

  async searchContextFull(): Promise<
    Array<TestRow & { score: number }>
  > {
    const row = this.rows.find((candidate) => candidate.id === this.searchRowId);
    return row
      ? [{
          ...row,
          content: this.searchContent ?? row.content,
          score: 99,
        }]
      : [];
  }

  async getStats(sessionId?: string): Promise<{
    totalMessages: number;
    maxTurnIndex?: number;
  }> {
    const rows = sessionId
      ? this.rows.filter((row) => row.session_id === sessionId)
      : this.rows;
    return {
      totalMessages: rows.length,
      maxTurnIndex: rows.length > 0
        ? Math.max(...rows.map((row) => row.turn_index))
        : undefined,
    };
  }
}

test("LCM evidence identity distinguishes sibling rows and preserves the legacy fallback", () => {
  const first = { id: 41, session_id: "session", turn_index: 7 };
  const second = { id: 42, session_id: "session", turn_index: 7 };
  assert.notEqual(
    lcmEvidenceIdentity(first, "session").id,
    lcmEvidenceIdentity(second, "session").id,
  );
  assert.equal(isSameLcmRow(first, "session", second, "session"), false);
  assert.equal(
    lcmEvidenceIdentity({ turn_index: 7 }, "session").id,
    "session:7",
  );
  assert.equal(
    isSameLcmRow(
      { turn_index: 7 },
      "session",
      { turn_index: 7 },
      "session",
    ),
    true,
  );
});

test("explicit-cue recall keeps distinct archive rows that share a turn", async () => {
  const engine = new LineageEngine([
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "First row at the referenced turn." },
    { id: 102, session_id: "s", turn_index: 7, role: "assistant", content: "Second row at the referenced turn." },
  ]);
  const recalled = await buildExplicitCueRecallSection({
    engine,
    sessionId: "s",
    query: "Review turn 7",
    maxChars: 4_000,
  });
  assert.match(recalled, /First row at the referenced turn/);
  assert.match(recalled, /Second row at the referenced turn/);
});

test("targeted recall replaces and scores only the matching same-turn row", async () => {
  const engine = new LineageEngine([
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "I earn approximately $100,000 CAD annually as a senior engineer." },
    { id: 102, session_id: "s", turn_index: 7, role: "user", content: "My recent raise to $110,000 CAD as a senior engineer at Saint Pierre Manufacturing Ltd is now effective." },
  ], 102, "The matching row records my recent raise to $110,000 CAD as a senior engineer at Saint Pierre Manufacturing Ltd.");
  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId: "s",
    query: "What is my annual salary as a senior engineer at Saint Pierre Manufacturing Ltd?",
    maxChars: 6_000,
  });
  assert.match(recalled, /earn approximately \$100,000 CAD annually/);
  assert.match(recalled, /matching row records my recent raise to \$110,000 CAD/);
});

test("focused-list recall keeps distinct same-turn calculations while matching the search row", async () => {
  const engine = new LineageEngine([
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "Can you help me calculate P(both heads) = 1/2 x 1/2 = 1/4 so I can make sure I get it right?" },
    { id: 102, session_id: "s", turn_index: 7, role: "user", content: "I am trying to verify if P(rolling a number greater than 4) = 2/6 = 1/3 is correct." },
  ], 102, "I confirmed P(rolling a number greater than 4) = 2/6 = 1/3.");
  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId: "s",
    query: "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars: 6_000,
  });
  assert.match(recalled, /P\(both heads\)/);
  assert.match(recalled, /P\(rolling a number greater than 4\)/);
});

test("response guidance keeps distinct same-turn rows while preserving its existing filters", async () => {
  const engine = new LineageEngine([
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "I prefer a structured daily routine with a written priority list each morning." },
    { id: 102, session_id: "s", turn_index: 7, role: "user", content: "My structured daily routine schedules focused work blocks and buffer time between meetings." },
  ], 102, "My structured daily routine schedules focused work blocks and buffer time between meetings.");
  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId: "s",
    query: "How should I organize my day to stay on track?",
    maxChars: 6_000,
  });
  assert.match(recalled, /written priority list each morning/);
  assert.match(recalled, /focused work blocks/);
});

test("event-order recall keeps distinct same-turn chronological rows", async () => {
  const engine = new LineageEngine([
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "Patrick suggested a March workshop on workflow optimization." },
    { id: 102, session_id: "s", turn_index: 7, role: "user", content: "Patrick and I planned an interview tips meeting for tomorrow." },
  ]);
  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId: "s",
    query: "Walk me through my interactions with Patrick in order.",
    maxChars: 6_000,
  });
  assert.match(recalled, /workshop suggestion/);
  assert.match(recalled, /interview tips meeting/);
});

function accessSearchDeps(rows: TestRow[]): AccessLcmSurfaceDeps {
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      namespaces: false,
    },
    lcmEngine: {
      enabled: true,
      searchContextFull: async () => rows,
    },
  };
  return {
    orchestrator,
    lcmSessionIdsForNamespaces: () => ["primary", "fallback"],
    resolveImplicitLcmReadFallbackNamespace: () => "default",
    resolveLcmReadNamespace: () => "default",
    resolveLcmReadSessionIds: () => ["primary", "fallback"],
    resolveLcmReadSessionKey: () => "primary",
    resolveReadableNamespace: () => "default",
    resolveRequestPrincipal: () => "default",
    resolveScopeProfileLcmReadNamespaces: () => null,
  } as unknown as AccessLcmSurfaceDeps;
}

test("access LCM search dedupes repeated rows but retains same-turn siblings", async () => {
  const rows: TestRow[] = [
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "first sibling" },
    { id: 102, session_id: "s", turn_index: 7, role: "assistant", content: "second sibling" },
  ];
  const response = await new AccessLcmSurface(accessSearchDeps(rows)).lcmSearch({
    query: "sibling",
    sessionKey: "s",
  });
  assert.deepEqual(response.results.map((row) => row.content), [
    "first sibling",
    "second sibling",
  ]);
});

test("raw excerpts dedupe repeated rows but retain same-turn siblings", async () => {
  const rows: TestRow[] = [
    { id: 101, session_id: "s", turn_index: 7, role: "user", content: "first sibling" },
    { id: 102, session_id: "s", turn_index: 7, role: "assistant", content: "second sibling" },
  ];
  const deps = {
    orchestrator: {
      config: { defaultNamespace: "default" },
      lcmEngine: {
        enabled: true,
        searchContextFull: async () => rows,
      },
    },
  } as unknown as AccessRecallSurfaceDeps;
  const excerpts = await new AccessRecallSurface(deps).fetchRawExcerpts("raw", {
    query: "sibling",
    sessionKey: "s",
    lcmSessionIds: ["primary", "fallback"],
  });
  assert.deepEqual(excerpts?.map((row) => row.content), [
    "first sibling",
    "second sibling",
  ]);
});
