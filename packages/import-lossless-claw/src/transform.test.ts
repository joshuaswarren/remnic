import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildMessageMetadata,
  indexSummaryDerivations,
  isMultiParent,
  LOSSLESS_CLAW_SOURCE_LABEL,
  mapMessage,
  mapSummary,
  pickCanonicalParent,
  resolveSessionId,
  resolveSummarySession,
} from "./transform.js";
import type {
  LosslessClawConversation,
  LosslessClawMessage,
  LosslessClawSummary,
  LosslessClawSummaryMessage,
  LosslessClawSummaryParent,
} from "./source.js";

const conv: LosslessClawConversation = {
  conversation_id: "conv-A",
  session_id: "sess-A",
  session_key: null,
  title: "Hello world",
};

const msg: LosslessClawMessage = {
  message_id: "msg-1",
  conversation_id: "conv-A",
  seq: 7,
  role: "user",
  content: "what is the answer?",
  token_count: 5,
  identity_hash: "abc",
  created_at: "2026-04-01T00:00:00.000Z",
};

describe("resolveSessionId", () => {
  it("returns explicit session_id when present", () => {
    assert.equal(resolveSessionId(conv), "sess-A");
  });

  it("falls back to conversation_id when session_id is null", () => {
    assert.equal(
      resolveSessionId({ ...conv, session_id: null }),
      "conv-A",
    );
  });

  it("falls back to conversation_id when session_id is empty/whitespace", () => {
    assert.equal(
      resolveSessionId({ ...conv, session_id: "   " }),
      "conv-A",
    );
  });
});

describe("buildMessageMetadata", () => {
  it("emits sorted JSON keys including source_seq (Codex P1)", () => {
    const json = buildMessageMetadata(conv, msg);
    const parsed = JSON.parse(json);
    assert.deepEqual(Object.keys(parsed), [
      "conversation_id",
      "identity_hash",
      "source",
      "source_seq",
      "title",
    ]);
    assert.equal(parsed.source, LOSSLESS_CLAW_SOURCE_LABEL);
    assert.equal(parsed.source_seq, 7);
    assert.equal(parsed.conversation_id, "conv-A");
    assert.equal(parsed.identity_hash, "abc");
    assert.equal(parsed.title, "Hello world");
  });

  it("nulls out missing identity_hash + title without dropping keys", () => {
    const json = buildMessageMetadata(
      { ...conv, title: null },
      { ...msg, identity_hash: null },
    );
    const parsed = JSON.parse(json);
    assert.equal(parsed.identity_hash, null);
    assert.equal(parsed.title, null);
  });
});

describe("mapMessage", () => {
  it("preserves role, content, token_count, created_at; turn_index from caller", () => {
    const mapped = mapMessage(conv, msg, 42);
    assert.equal(mapped.session_id, "sess-A");
    assert.equal(mapped.turn_index, 42, "caller-supplied session-global turn_index");
    assert.equal(mapped.role, "user");
    assert.equal(mapped.content, "what is the answer?");
    assert.equal(mapped.token_count, 5);
    assert.equal(mapped.created_at, "2026-04-01T00:00:00.000Z");
    assert.match(mapped.metadata, /"source":"lossless-claw"/);
    assert.match(mapped.metadata, /"source_seq":7/);
  });
});

describe("pickCanonicalParent", () => {
  it("returns null for orphan summaries", () => {
    assert.equal(pickCanonicalParent([]), null);
  });

  it("picks the lowest-ordinal parent", () => {
    const parents: LosslessClawSummaryParent[] = [
      { summary_id: "s1", parent_summary_id: "p-late", ordinal: 5 },
      { summary_id: "s1", parent_summary_id: "p-early", ordinal: 0 },
      { summary_id: "s1", parent_summary_id: "p-mid", ordinal: 2 },
    ];
    assert.equal(pickCanonicalParent(parents), "p-early");
  });

  it("breaks ties by lexicographic parent id (deterministic)", () => {
    const parents: LosslessClawSummaryParent[] = [
      { summary_id: "s1", parent_summary_id: "p-zzz", ordinal: 0 },
      { summary_id: "s1", parent_summary_id: "p-aaa", ordinal: 0 },
    ];
    assert.equal(pickCanonicalParent(parents), "p-aaa");
  });
});

describe("isMultiParent", () => {
  it("flags summaries with >1 parent edge", () => {
    assert.equal(isMultiParent([]), false);
    assert.equal(
      isMultiParent([
        { summary_id: "s", parent_summary_id: "p", ordinal: 0 },
      ]),
      false,
    );
    assert.equal(
      isMultiParent([
        { summary_id: "s", parent_summary_id: "p1", ordinal: 0 },
        { summary_id: "s", parent_summary_id: "p2", ordinal: 1 },
      ]),
      true,
    );
  });
});

describe("resolveSummarySession", () => {
  it("returns the session when all messages share one", () => {
    const sessionByMessageId = new Map([
      ["m1", "sess-A"],
      ["m2", "sess-A"],
    ]);
    assert.equal(
      resolveSummarySession(["m1", "m2"], sessionByMessageId),
      "sess-A",
    );
  });

  it("returns null on multi-session summaries (caller should skip)", () => {
    const sessionByMessageId = new Map([
      ["m1", "sess-A"],
      ["m2", "sess-B"],
    ]);
    assert.equal(
      resolveSummarySession(["m1", "m2"], sessionByMessageId),
      null,
    );
  });

  it("returns null when no message ids resolve", () => {
    assert.equal(
      resolveSummarySession(["m1"], new Map()),
      null,
    );
  });

  it("returns null when ANY referenced message id is dangling (Codex P2)", () => {
    // One valid + one missing → reject the whole summary so msg_start/end
    // can't be silently computed from only the resolved subset.
    const sessionByMessageId = new Map([
      ["m1", "sess-A"],
      // m2 deliberately not in the map
    ]);
    assert.equal(
      resolveSummarySession(["m1", "m2"], sessionByMessageId),
      null,
    );
  });

  it("returns null on empty messageIds (defensive)", () => {
    assert.equal(resolveSummarySession([], new Map()), null);
  });
});

describe("mapSummary", () => {
  const summary: LosslessClawSummary = {
    summary_id: "sum-1",
    kind: "leaf",
    depth: 0,
    content: "summary text",
    token_count: 42,
    earliest_at: "2026-04-01T00:00:00.000Z",
    latest_at: "2026-04-01T01:00:00.000Z",
  };

  it("maps msg_start/msg_end from min/max of provided seqs", () => {
    const out = mapSummary({
      summary,
      parents: [],
      messageSeqs: [10, 5, 7, 12],
      sessionId: "sess-A",
    });
    assert.equal(out.id, "sum-1");
    assert.equal(out.session_id, "sess-A");
    assert.equal(out.depth, 0);
    assert.equal(out.parent_id, null);
    assert.equal(out.summary_text, "summary text");
    assert.equal(out.token_count, 42);
    assert.equal(out.msg_start, 5);
    assert.equal(out.msg_end, 12);
    assert.equal(out.escalation, 0);
    assert.equal(out.created_at, "2026-04-01T01:00:00.000Z");
  });

  it("uses earliest_at when latest_at is null", () => {
    const out = mapSummary({
      summary: { ...summary, latest_at: null },
      parents: [],
      messageSeqs: [1],
      sessionId: "sess-A",
    });
    assert.equal(out.created_at, "2026-04-01T00:00:00.000Z");
  });

  it("falls back to current time when both at-fields are null", () => {
    const out = mapSummary({
      summary: { ...summary, earliest_at: null, latest_at: null },
      parents: [],
      messageSeqs: [1],
      sessionId: "sess-A",
    });
    // Just confirm it parses as a valid ISO string
    assert.ok(!Number.isNaN(Date.parse(out.created_at)));
  });

  it("throws when no message seqs are provided (caller must skip)", () => {
    assert.throws(() =>
      mapSummary({
        summary,
        parents: [],
        messageSeqs: [],
        sessionId: "sess-A",
      }),
    );
  });
});

describe("indexSummaryDerivations", () => {
  it("groups parents and message ids by summary_id", () => {
    const sm: LosslessClawSummaryMessage[] = [
      { summary_id: "s1", message_id: "m1" },
      { summary_id: "s1", message_id: "m2" },
      { summary_id: "s2", message_id: "m3" },
    ];
    const sp: LosslessClawSummaryParent[] = [
      { summary_id: "s1", parent_summary_id: "p", ordinal: 0 },
      { summary_id: "s2", parent_summary_id: "p", ordinal: 0 },
      { summary_id: "s2", parent_summary_id: "q", ordinal: 1 },
    ];
    const idx = indexSummaryDerivations(sm, sp);
    assert.deepEqual(idx.get("s1")?.messageIds.sort(), ["m1", "m2"]);
    assert.equal(idx.get("s1")?.parents.length, 1);
    assert.deepEqual(idx.get("s2")?.messageIds, ["m3"]);
    assert.equal(idx.get("s2")?.parents.length, 2);
  });

  it("returns empty map when both inputs are empty", () => {
    assert.equal(indexSummaryDerivations([], []).size, 0);
  });
});
