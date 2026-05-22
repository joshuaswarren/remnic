// ---------------------------------------------------------------------------
// Tests — WeClone export parser
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWeCloneExport } from "./parser.js";

// ---------------------------------------------------------------------------
// Helpers — synthetic test data (no real conversations)
// ---------------------------------------------------------------------------

function makeMsg(
  sender: string,
  text: string,
  timestamp: string,
  extra?: { reply_to_id?: string; message_id?: string },
) {
  return { sender, text, timestamp, ...extra };
}

const T1 = "2025-01-10T08:00:00.000Z";
const T2 = "2025-01-10T08:05:00.000Z";
const T3 = "2025-01-10T08:10:00.000Z";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseWeCloneExport", () => {
  it("parses a valid Telegram export with messages array", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hello", T1),
        makeMsg("Bob", "hey there", T2),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns.length, 2);
    assert.equal(result.metadata.source, "weclone-telegram");
    assert.equal(result.metadata.messageCount, 2);
  });

  it("parses export with platform field from options", () => {
    const input = {
      messages: [
        makeMsg("Alice", "hi", T1),
      ],
    };
    const result = parseWeCloneExport(input, { platform: "whatsapp" });
    assert.equal(result.metadata.source, "weclone-whatsapp");
  });

  it("parses a raw array of messages (no wrapper object)", () => {
    const input = [
      makeMsg("Alice", "one", T1),
      makeMsg("Bob", "two", T2),
    ];
    const result = parseWeCloneExport(input);
    assert.equal(result.turns.length, 2);
    // Default platform is telegram when not specified
    assert.equal(result.metadata.source, "weclone-telegram");
  });

  it("maps first sender as 'user' role by default", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "question", T1),
        makeMsg("Bob", "answer", T2),
        makeMsg("Alice", "thanks", T3),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[1].role, "other");
    assert.equal(result.turns[2].role, "user");
  });

  it("maps bot-like sender names to 'assistant' role", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hello", T1),
        makeMsg("ChatGPT Bot", "how can I help?", T2),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[1].role, "assistant");
  });

  it("respects selfSender option for role assignment", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "first", T1),
        makeMsg("Bob", "second", T2),
      ],
    };
    const result = parseWeCloneExport(input, { selfSender: "Bob" });
    assert.equal(result.turns[0].role, "other");
    assert.equal(result.turns[1].role, "user");
  });

  it("respects assistantSenders option", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hello", T1),
        makeMsg("MyCustomBot", "hi there", T2),
      ],
    };
    const result = parseWeCloneExport(input, {
      assistantSenders: ["MyCustomBot"],
    });
    assert.equal(result.turns[1].role, "assistant");
  });

  it("rejects malformed assistantSenders option before role inference", () => {
    const input = {
      platform: "telegram",
      messages: [makeMsg("Alice", "hi", T1)],
    };

    assert.throws(
      () => parseWeCloneExport(input, { assistantSenders: 1 as never }),
      /invalid option assistantSenders: expected an array of non-empty strings/,
    );
    assert.throws(
      () => parseWeCloneExport(input, { assistantSenders: ["Bot", 3 as never] }),
      /invalid option assistantSenders\[1\]: expected a non-empty string/,
    );
  });

  it("rejects malformed selfSender option before role inference", () => {
    const input = {
      platform: "telegram",
      messages: [makeMsg("Alice", "hi", T1)],
    };

    assert.throws(
      () => parseWeCloneExport(input, { selfSender: 42 as never }),
      /invalid option selfSender: expected a non-empty string/,
    );
    assert.throws(
      () => parseWeCloneExport(input, { selfSender: "" }),
      /invalid option selfSender: expected a non-empty string/,
    );
  });

  it("maps reply_to_id to replyToId", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "question", T1, { message_id: "m1" }),
        makeMsg("Bob", "reply", T2, { reply_to_id: "m1" }),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[0].replyToId, undefined);
    assert.equal(result.turns[1].replyToId, "m1");
  });

  it("builds metadata with correct date range", () => {
    const input = {
      platform: "discord",
      messages: [
        makeMsg("Alice", "early", T1),
        makeMsg("Bob", "mid", T2),
        makeMsg("Alice", "late", T3),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.metadata.dateRange.from, T1);
    assert.equal(result.metadata.dateRange.to, T3);
    assert.equal(result.metadata.messageCount, 3);
  });

  it("uses export_date from the export object", () => {
    const exportDate = "2025-02-01T00:00:00.000Z";
    const input = {
      platform: "telegram",
      export_date: exportDate,
      messages: [makeMsg("Alice", "hi", T1)],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.metadata.exportDate, exportDate);
  });

  it("rejects empty messages array", () => {
    assert.throws(
      () => parseWeCloneExport({ messages: [] }),
      /messages array must not be empty/,
    );
  });

  it("rejects non-object input", () => {
    assert.throws(
      () => parseWeCloneExport(null),
      /input must be a non-null object/,
    );
    assert.throws(
      () => parseWeCloneExport("string"),
      /input must be a non-null object/,
    );
    assert.throws(
      () => parseWeCloneExport(42),
      /input must be a non-null object/,
    );
  });

  it("rejects input without messages property", () => {
    assert.throws(
      () => parseWeCloneExport({ foo: "bar" }),
      /must have a 'messages' array/,
    );
  });

  it("skips invalid messages in non-strict mode", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "valid", T1),
        { sender: "", text: "missing sender", timestamp: T2 },
        makeMsg("Alice", "also valid", T3),
      ],
    };
    const result = parseWeCloneExport(input, { strict: false });
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].content, "valid");
    assert.equal(result.turns[1].content, "also valid");
  });

  it("throws on invalid messages in strict mode", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "valid", T1),
        { sender: "", text: "missing sender", timestamp: T2 },
      ],
    };
    assert.throws(
      () => parseWeCloneExport(input, { strict: true }),
      /invalid/,
    );
  });

  it("throws on invalid timestamp in strict mode", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hello", "not-a-date"),
      ],
    };
    assert.throws(
      () => parseWeCloneExport(input, { strict: true }),
      /failed validation/,
    );
  });

  it("rejects invalid platform in options", () => {
    const input = { messages: [makeMsg("Alice", "hi", T1)] };
    assert.throws(
      () =>
        parseWeCloneExport(input, {
          platform: "invalid" as "telegram",
        }),
      /invalid platform/,
    );
  });

  it("rejects invalid platform in export data", () => {
    const input = {
      platform: "signal",
      messages: [makeMsg("Alice", "hi", T1)],
    };
    assert.throws(
      () => parseWeCloneExport(input),
      /invalid platform 'signal' in export data/,
    );
  });

  it("defaults to telegram when neither options nor export specify platform", () => {
    const input = {
      messages: [makeMsg("Alice", "hi", T1)],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.metadata.source, "weclone-telegram");
  });

  it("sets participantId and participantName from sender", () => {
    const input = {
      platform: "telegram",
      messages: [makeMsg("Alice", "hello", T1)],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[0].participantId, "Alice");
    assert.equal(result.turns[0].participantName, "Alice");
  });

  it("preserves message_id as messageId on WeCloneImportTurn", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hello", T1, { message_id: "msg-001" }),
        makeMsg("Bob", "reply", T2, { message_id: "msg-002", reply_to_id: "msg-001" }),
      ],
    };
    const result = parseWeCloneExport(input);
    // WeCloneImportTurn extends ImportTurn with messageId
    const turns = result.turns as Array<{ messageId?: string; replyToId?: string }>;
    assert.equal(turns[0].messageId, "msg-001");
    assert.equal(turns[1].messageId, "msg-002");
    assert.equal(turns[1].replyToId, "msg-001");
  });

  it("does NOT classify human names containing 'ai' substring as bots", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hi", T1),
        makeMsg("Aidan", "hey", T2),
        makeMsg("Craig", "hello", T3),
      ],
    };
    const result = parseWeCloneExport(input);
    // "Alice" is the self-sender (first message); Aidan and Craig are other humans
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[1].role, "other");
    assert.equal(result.turns[2].role, "other");
  });

  it("classifies standalone 'ai' word in sender as bot", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hi", T1),
        makeMsg("My AI", "hello", T2),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[1].role, "assistant");
  });

  it("classifies 'Caitlin' as human, not bot", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Alice", "hi", T1),
        makeMsg("Caitlin", "hey", T2),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[1].role, "other");
  });

  it("skips bot-like senders when inferring default selfSender", () => {
    // The first message is from a bot.  Inferring `selfSender` from the
    // first sender would mislabel the bot as `user` and demote the human
    // to `other`.  The parser should pick the first non-bot sender.
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("ChatGPT Bot", "hi! how can I help?", T1),
        makeMsg("Alice", "tell me a joke", T2),
        makeMsg("ChatGPT Bot", "why did the chicken...", T3),
      ],
    };
    const result = parseWeCloneExport(input);
    // Alice is the human -> user; the bot turns -> assistant
    const bot = result.turns.filter((t) => t.participantId === "ChatGPT Bot");
    const human = result.turns.find((t) => t.participantId === "Alice");
    assert.equal(human?.role, "user");
    for (const b of bot) {
      assert.equal(b.role, "assistant");
    }
  });

  it("skips senders listed in assistantSenders when inferring default self", () => {
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("MyCustomBot", "greetings", T1),
        makeMsg("Alice", "hi", T2),
      ],
    };
    const result = parseWeCloneExport(input, {
      assistantSenders: ["MyCustomBot"],
    });
    const alice = result.turns.find((t) => t.participantId === "Alice");
    const bot = result.turns.find((t) => t.participantId === "MyCustomBot");
    assert.equal(alice?.role, "user");
    assert.equal(bot?.role, "assistant");
  });

  it("falls back to first valid sender when every sender looks bot-like", () => {
    // Pathological case: every sender matches bot heuristics.  We still
    // need SOMEONE to be `user` so downstream extraction has a
    // first-person perspective; picking the first valid sender is the
    // least-bad default.
    const input = {
      platform: "telegram",
      messages: [
        makeMsg("Bot Alpha", "one", T1),
        makeMsg("Assistant Beta", "two", T2),
      ],
    };
    const result = parseWeCloneExport(input);
    assert.equal(result.turns[0].role, "user");
    assert.equal(result.turns[1].role, "assistant");
  });
});
