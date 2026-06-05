// ---------------------------------------------------------------------------
// Tests — participant mapper
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ImportTurn } from "@remnic/core";
import { mapParticipants } from "./participant.js";
import { parseWeCloneExport } from "./parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(
  participantId: string | undefined,
  timestamp: string,
  extra?: Partial<ImportTurn>,
): ImportTurn {
  return {
    role: "user",
    content: "test",
    timestamp,
    participantId,
    participantName: participantId,
    ...extra,
  };
}

const T1 = "2025-01-10T08:00:00.000Z";
const T2 = "2025-01-10T09:00:00.000Z";
const T3 = "2025-01-10T10:00:00.000Z";
const T4 = "2025-01-10T11:00:00.000Z";

function makeMsg(sender: string, text: string, timestamp: string) {
  return { sender, text, timestamp };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapParticipants", () => {
  it("maps participants from turns", () => {
    const turns: ImportTurn[] = [
      makeTurn("Alice", T1),
      makeTurn("Bob", T2),
      makeTurn("Alice", T3),
    ];
    const participants = mapParticipants(turns);
    assert.equal(participants.length, 2);
    assert.equal(participants[0].id, "Alice");
    assert.equal(participants[0].messageCount, 2);
    assert.equal(participants[1].id, "Bob");
    assert.equal(participants[1].messageCount, 1);
  });

  it("identifies top sender as 'self'", () => {
    const turns: ImportTurn[] = [
      makeTurn("Alice", T1),
      makeTurn("Alice", T2),
      makeTurn("Alice", T3),
      makeTurn("Bob", T4),
    ];
    const participants = mapParticipants(turns);
    const alice = participants.find((p) => p.id === "Alice");
    assert.equal(alice?.relationship, "self");
  });

  it("uses explicit parser selfSender roles instead of top sender volume", () => {
    const source = parseWeCloneExport(
      {
        platform: "telegram",
        messages: [
          makeMsg("Alice", "first", T1),
          makeMsg("Alice", "second", T2),
          makeMsg("Bob", "self reply", T3),
        ],
      },
      { selfSender: "Bob" },
    );

    const participants = mapParticipants(source.turns);
    const alice = participants.find((p) => p.id === "Alice");
    const bob = participants.find((p) => p.id === "Bob");

    assert.equal(source.turns.find((t) => t.participantId === "Bob")?.role, "user");
    assert.equal(bob?.relationship, "self");
    assert.equal(alice?.relationship, "frequent");
  });

  it("uses parser-inferred user roles instead of top sender volume", () => {
    const source = parseWeCloneExport({
      platform: "telegram",
      messages: [
        makeMsg("Bob", "self first", T1),
        makeMsg("Alice", "first", T2),
        makeMsg("Alice", "second", T3),
      ],
    });

    const participants = mapParticipants(source.turns);
    const alice = participants.find((p) => p.id === "Alice");
    const bob = participants.find((p) => p.id === "Bob");

    assert.equal(source.turns.find((t) => t.participantId === "Bob")?.role, "user");
    assert.equal(bob?.relationship, "self");
    assert.equal(alice?.relationship, "frequent");
  });

  it("classifies participants with >10% messages as 'frequent'", () => {
    // 10 messages from Alice, 2 from Bob (20% = frequent), 1 from Carol (<10%)
    const turns: ImportTurn[] = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push(
        makeTurn("Alice", `2025-01-10T0${i}:00:00.000Z`),
      );
    }
    turns.push(makeTurn("Bob", "2025-01-10T10:00:00.000Z"));
    turns.push(makeTurn("Bob", "2025-01-10T11:00:00.000Z"));
    turns.push(makeTurn("Carol", "2025-01-10T12:00:00.000Z"));

    const participants = mapParticipants(turns);
    const alice = participants.find((p) => p.id === "Alice");
    const bob = participants.find((p) => p.id === "Bob");
    const carol = participants.find((p) => p.id === "Carol");

    assert.equal(alice?.relationship, "self");
    assert.equal(bob?.relationship, "frequent");
    assert.equal(carol?.relationship, "occasional");
  });

  it("tracks first and last seen timestamps", () => {
    const turns: ImportTurn[] = [
      makeTurn("Alice", T1),
      makeTurn("Alice", T3),
      makeTurn("Alice", T2),
    ];
    const participants = mapParticipants(turns);
    const alice = participants[0];
    assert.equal(alice.firstSeen, T1);
    assert.equal(alice.lastSeen, T3);
  });

  it("handles turns without participantId", () => {
    const turns: ImportTurn[] = [
      makeTurn(undefined, T1),
      makeTurn("Alice", T2),
      makeTurn(undefined, T3),
    ];
    const participants = mapParticipants(turns);
    assert.equal(participants.length, 1);
    assert.equal(participants[0].id, "Alice");
  });

  it("returns empty array for empty turns", () => {
    assert.deepEqual(mapParticipants([]), []);
  });

  it("returns empty array for turns with no participantIds", () => {
    const turns: ImportTurn[] = [
      makeTurn(undefined, T1),
      makeTurn(undefined, T2),
    ];
    assert.deepEqual(mapParticipants(turns), []);
  });

  it("uses participantName for the name field", () => {
    const turns: ImportTurn[] = [
      {
        role: "user",
        content: "hi",
        timestamp: T1,
        participantId: "user-123",
        participantName: "Alice Doe",
      },
    ];
    const participants = mapParticipants(turns);
    assert.equal(participants[0].id, "user-123");
    assert.equal(participants[0].name, "Alice Doe");
  });

  it("excludes empty-string participantIds from frequency denominator", () => {
    // Regression: earlier versions skipped empty-string ids in the stats
    // loop (`!id`) but still counted them in `totalMessages`
    // (`!= null`), which inflated the denominator and could demote
    // frequent participants to "occasional".
    //
    // Here Bob has 2 of the 3 non-empty messages (66%) and should
    // therefore be classified as "frequent".  If the denominator
    // included the five empty-string turns, Bob's share would drop to
    // 25% (2/8) but still above the 10% threshold, so use a larger
    // padding count to expose the bug: Bob 2, Alice 1, 20 empty-string
    // turns.  Correct: denominator = 3, Bob = 66% -> frequent.
    // Bug: denominator = 23, Bob = 8.6% -> occasional.
    const turns: ImportTurn[] = [makeTurn("Alice", T1), makeTurn("Bob", T2), makeTurn("Bob", T3)];
    for (let i = 0; i < 20; i += 1) {
      turns.push(makeTurn("", `2025-02-10T${String(i).padStart(2, "0")}:00:00.000Z`));
    }
    const participants = mapParticipants(turns);
    const bob = participants.find((p) => p.id === "Bob");
    const alice = participants.find((p) => p.id === "Alice");
    // Bob has most messages -> self.  Alice with 1/3 (33%) is frequent.
    assert.equal(bob?.relationship, "self");
    assert.equal(alice?.relationship, "frequent");
  });

  it("sorts results by message count descending", () => {
    const turns: ImportTurn[] = [
      makeTurn("Carol", T1),
      makeTurn("Alice", T1),
      makeTurn("Alice", T2),
      makeTurn("Alice", T3),
      makeTurn("Bob", T1),
      makeTurn("Bob", T2),
    ];
    const participants = mapParticipants(turns);
    assert.equal(participants[0].id, "Alice");
    assert.equal(participants[1].id, "Bob");
    assert.equal(participants[2].id, "Carol");
  });
});
