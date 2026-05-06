import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExplicitCueRecallSection,
  collectBenchmarkAnchorCues,
  collectExplicitTurnReferences,
  collectLexicalCues,
  collectQuestionSlotCues,
  collectStructuredPlanCues,
  collectTemporalLexicalCues,
  type ExplicitCueRecallEngine,
} from "./explicit-cue-recall.js";

type Message = { role: string; content: string; turnIndex?: number };

class FakeCueEngine implements ExplicitCueRecallEngine {
  constructor(private readonly sessions: Record<string, Message[]>) {}

  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    _maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
    const messages = this.sessions[sessionId] ?? [];
    const from = Math.max(0, Math.floor(fromTurn));
    const to = Math.floor(toTurn);
    if (from > to) return [];
    return messages
      .map((message, offset) => ({
        turn_index: message.turnIndex ?? offset,
        role: message.role,
        content: message.content,
      }))
      .filter((message) => message.turn_index >= from && message.turn_index <= to);
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
    const needle = normalizeForSearch(query);
    const sessionEntries = Object.entries(this.sessions).filter(
      ([candidateSessionId]) => !sessionId || candidateSessionId === sessionId,
    );
    const results: Array<{
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score?: number;
    }> = [];
    for (const [candidateSessionId, messages] of sessionEntries) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (!normalizeForSearch(message.content).includes(needle)) continue;
        results.push({
          turn_index: message.turnIndex ?? index,
          role: message.role,
          content: message.content,
          session_id: candidateSessionId,
          score: 1,
        });
      }
    }
    return results.slice(0, Math.max(0, Math.floor(limit)));
  }
}

test("collectExplicitTurnReferences parses turns, steps, ranges, and plural labels", () => {
  assert.deepEqual(collectExplicitTurnReferences("Review turns 4-5 and step 8"), [
    { number: 4, includeDirectTurn: true },
    { number: 5, includeDirectTurn: true },
    { number: 8, includeDirectTurn: false },
  ]);
  assert.deepEqual(
    collectExplicitTurnReferences("Compare actions #2 through 4 and observations 7"),
    [
      { number: 2, includeDirectTurn: false },
      { number: 3, includeDirectTurn: false },
      { number: 4, includeDirectTurn: false },
      { number: 7, includeDirectTurn: false },
    ],
  );
});

test("collectLexicalCues extracts visible ids, dates, and bracket labels", () => {
  assert.deepEqual(
    collectLexicalCues("Use D1:1 from session_alpha on 2026-04-30 [profile decision]."),
    ["2026-04-30", "D1:1", "profile decision", "session_alpha"],
  );
  assert.deepEqual(
    collectLexicalCues("What did Maya Chen tell Jordan about session_2?"),
    ["Jordan", "Maya Chen", "session_2"],
  );
  assert.deepEqual(
    collectLexicalCues("Can Maya Chen remember what Jordan said?"),
    ["Jordan", "Maya Chen"],
  );
  assert.deepEqual(
    collectLexicalCues("Were Maya Chen and Jordan aligned?"),
    ["Jordan", "Maya Chen"],
  );
  assert.deepEqual(
    collectTemporalLexicalCues("As of 2025-02-01, what changed yesterday?"),
    ["as of", "changed", "yesterday"],
  );
  assert.deepEqual(
    collectLexicalCues("As of 2025-02-01, what changed yesterday?"),
    ["2025-02-01", "as of", "changed", "yesterday"],
  );
  assert.deepEqual(
    collectQuestionSlotCues("What city does the user live in now?"),
    ["city"],
  );
  assert.deepEqual(
    collectBenchmarkAnchorCues("Use plan 1, chat ids 7, and source chat ids 8 for information extraction."),
    [
      "ability=information_extraction",
      "chat-7",
      "chat_id=7",
      "plan-1",
      "plan_id=1",
      "source_chat-8",
      "source_chat_id=8",
      "chat_id=8",
    ].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    collectBenchmarkAnchorCues("Use chat id 7."),
    ["chat_id=7", "chat-7"].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    collectBenchmarkAnchorCues("Use chat ids 7 and 8 for the answer."),
    ["chat_id=7", "chat-7", "chat_id=8", "chat-8"].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  assert.deepEqual(
    collectBenchmarkAnchorCues("Using chat id 27, who owns the late evidence?"),
    ["chat_id=27", "chat-27"].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    collectBenchmarkAnchorCues("Using chat id 27 late-arriving evidence, who owns it?"),
    ["chat_id=27", "chat-27"].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    collectLexicalCues("What city does the user live in now?"),
    ["city", "now"],
  );
  assert.deepEqual(
    collectStructuredPlanCues("Join Jennifer for the same dinner and accommodation."),
    ["accommodation", "dinner", "join", "same"],
  );
  assert.deepEqual(
    collectStructuredPlanCues("Join the same team meeting."),
    [],
  );
  assert.deepEqual(
    collectLexicalCues("Join Jennifer for the same dinner and accommodation."),
    ["Jennifer"],
  );
  assert.deepEqual(
    collectLexicalCues("Join Jennifer for the same dinner and accommodation.", {
      includeStructuredPlanCues: true,
    }),
    ["accommodation", "dinner", "Jennifer", "join", "same"],
  );
});

test("buildExplicitCueRecallSection searches benchmark anchor cues", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "system",
        content:
          "BEAM evidence anchors: session_id=beam-100K-demo-plan-plan-1-1; plan_id=plan-1; chat_id=7; ability=information_extraction",
      },
      {
        role: "user",
        content: "The plan-specific deployment owner is Nia.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query: "For information extraction, use plan plan-1 and chat id 7.",
    maxChars: 2000,
    includeBenchmarkAnchorCues: true,
  });

  assert.match(section, /plan-specific deployment owner is Nia/);
});

test("buildExplicitCueRecallSection expands paired action and observation references", async () => {
  const messages = Array.from({ length: 22 }, (_, index) => ({
    role: index % 2 === 0 ? "assistant" : "user",
    content: `filler turn ${index}`,
  }));
  messages[16] = { role: "assistant", content: "[Action 8] opened the billing settings" };
  messages[17] = { role: "user", content: "[Observation 8] plan limit was visible" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened in Step 8?",
    maxChars: 2000,
  });

  assert.match(section, /^## Explicit Cue Evidence/);
  assert.match(section, /Action 8/);
  assert.match(section, /Observation 8/);
});

test("buildExplicitCueRecallSection does not leak the next action into step windows", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[39] = { role: "assistant", content: "[Observation 19] before the range" };
  messages[40] = { role: "user", content: "[Action 20] right" };
  messages[41] = { role: "assistant", content: "[Observation 20] after right" };
  messages[46] = { role: "user", content: "[Action 23] down" };
  messages[47] = { role: "assistant", content: "[Observation 23] after down" };
  messages[48] = { role: "user", content: "[Action 24] future action should not appear" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "Between steps 20 and 23, which single action mattered?",
    maxChars: 4000,
  });

  assert.match(section, /Observation 19/);
  assert.match(section, /Action 20/);
  assert.match(section, /Action 23/);
  assert.match(section, /Observation 23/);
  assert.doesNotMatch(section, /Action 24/);
});

test("buildExplicitCueRecallSection keeps loop-break action questions inside bounded ranges", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[40] = { role: "user", content: "[Action 20] right" };
  messages[41] = { role: "assistant", content: "[Observation 20] loop started" };
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] successor state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "Between steps 20 and 23, which action broke the loop?",
    maxChars: 4000,
  });

  assert.match(section, /Action 20/);
  assert.match(section, /Action 23/);
  assert.match(section, /Observation 23/);
  assert.doesNotMatch(section, /Action 24/);
  assert.doesNotMatch(section, /Observation 24/);
});

test("buildExplicitCueRecallSection treats hash-prefixed loop-break ranges as bounded", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[40] = { role: "user", content: "[Action 20] right" };
  messages[41] = { role: "assistant", content: "[Observation 20] loop started" };
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] successor state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "Between actions #20-#23, which action broke the loop?",
    maxChars: 4000,
  });

  assert.match(section, /Action 20/);
  assert.match(section, /Action 23/);
  assert.match(section, /Observation 23/);
  assert.doesNotMatch(section, /Action 24/);
  assert.doesNotMatch(section, /Observation 24/);
});

test("buildExplicitCueRecallSection keeps loop-break action questions inside single steps", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] successor state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "In step 23, which action broke the loop?",
    maxChars: 4000,
  });

  assert.match(section, /Action 23/);
  assert.match(section, /Observation 23/);
  assert.doesNotMatch(section, /Action 24/);
  assert.doesNotMatch(section, /Observation 24/);
});

test("buildExplicitCueRecallSection includes successor trajectory evidence when requested", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] the loop was broken" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "After step 23, what did the next action accomplish?",
    maxChars: 4000,
  });

  assert.match(section, /Action 23/);
  assert.match(section, /Observation 23/);
  assert.match(section, /Action 24/);
  assert.match(section, /Observation 24/);
});

test("buildExplicitCueRecallSection includes successor evidence for explicit loop breaks", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[40] = { role: "user", content: "[Action 20] right" };
  messages[41] = { role: "assistant", content: "[Observation 20] start of loop" };
  messages[42] = { role: "user", content: "[Action 21] left" };
  messages[43] = { role: "assistant", content: "[Observation 21] loop returned" };
  messages[44] = { role: "user", content: "[Action 22] right" };
  messages[45] = { role: "assistant", content: "[Observation 22] loop repeated" };
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] the loop was broken" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query:
      "Steps 20-23 formed a right-left loop; what did the down action do to break this loop?",
    maxChars: 4000,
  });

  assert.match(section, /Action 20/);
  assert.match(section, /Action 23/);
  assert.match(section, /Action 24/);
  assert.match(section, /Observation 24/);
});

test("buildExplicitCueRecallSection includes successor evidence for break-out loop wording", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[40] = { role: "user", content: "[Action 20] right" };
  messages[41] = { role: "assistant", content: "[Observation 20] start of loop" };
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] the loop was broken" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query:
      "Steps 20-23 formed a right-left loop; what did the down action do to break out of the loop?",
    maxChars: 4000,
  });

  assert.match(section, /Action 23/);
  assert.match(section, /Action 24/);
  assert.match(section, /Observation 24/);
});

test("buildExplicitCueRecallSection includes successor evidence for end and stop loop wording", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[40] = { role: "user", content: "[Action 20] right" };
  messages[41] = { role: "assistant", content: "[Observation 20] start of loop" };
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] loop still continued" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] the loop was stopped" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const endSection = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query:
      "Steps 20-23 formed a loop; what did the down action do to end the loop?",
    maxChars: 4000,
  });
  const stopSection = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query:
      "Steps 20-23 formed a loop; what did the down action do to stop this loop?",
    maxChars: 4000,
  });

  for (const section of [endSection, stopSection]) {
    assert.match(section, /Action 23/);
    assert.match(section, /Action 24/);
    assert.match(section, /Observation 24/);
  }
});

test("buildExplicitCueRecallSection does not treat broad break wording as successor intent", async () => {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[46] = { role: "user", content: "[Action 23] left" };
  messages[47] = { role: "assistant", content: "[Observation 23] the rule broke" };
  messages[48] = { role: "user", content: "[Action 24] down" };
  messages[49] = { role: "assistant", content: "[Observation 24] successor state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What broke in step 23?",
    maxChars: 4000,
  });

  assert.match(section, /Action 23/);
  assert.match(section, /Observation 23/);
  assert.doesNotMatch(section, /Action 24/);
  assert.doesNotMatch(section, /Observation 24/);
});

test("buildExplicitCueRecallSection resolves action and observation labels when transcript turns are offset", async () => {
  const messages = Array.from({ length: 130 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[101] = {
    role: "assistant",
    content: "[Observation 46]: rule `door` 3 steps to the left",
  };
  messages[102] = { role: "user", content: "[Action 47]: left" };
  messages[103] = {
    role: "assistant",
    content: "[Observation 47]: rule `door` 2 steps to the left",
  };
  messages[104] = { role: "user", content: "[Action 48]: up" };
  messages[105] = {
    role: "assistant",
    content: "[Observation 48]: rule `door` 2 steps to the left and 1 step down",
  };
  messages[106] = {
    role: "user",
    content: "[Action 49]: future action should not appear",
  };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "In steps 47 and 48, what did the left then up maneuver do?",
    maxChars: 4000,
  });

  assert.match(section, /Observation 46/);
  assert.match(section, /Action 47/);
  assert.match(section, /Observation 47/);
  assert.match(section, /Action 48/);
  assert.match(section, /Observation 48/);
  assert.doesNotMatch(section, /Action 49/);
});

test("buildExplicitCueRecallSection ignores quoted labels when resolving trajectory turns", async () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  messages[94] = { role: "user", content: "[Action 47]: fallback move" };
  messages[95] = { role: "assistant", content: "[Observation 47]: fallback state" };
  messages[101] = {
    role: "assistant",
    content: "The user later quoted [Action 47] while explaining an unrelated review.",
  };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened in step 47?",
    maxChars: 4000,
  });

  assert.match(section, /fallback move/);
  assert.match(section, /fallback state/);
  assert.doesNotMatch(section, /unrelated review/);
});

test("buildExplicitCueRecallSection keeps searching past short quoted-label clusters", async () => {
  const messages = Array.from({ length: 150 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  for (let index = 0; index < 10; index += 1) {
    const turnIndex = 70 + index * 2;
    messages[turnIndex] = {
      role: "assistant",
      content: `[Action 47]: quoted by assistant ${index}`,
    };
    messages[turnIndex + 1] = {
      role: "user",
      content: `[Observation 47]: quoted by user ${index}`,
    };
  }
  messages[110] = { role: "user", content: "[Action 47]: true move" };
  messages[111] = { role: "assistant", content: "[Observation 47]: true state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened in step 47?",
    maxChars: 4000,
  });

  assert.match(section, /true move/);
  assert.match(section, /true state/);
  assert.doesNotMatch(section, /quoted by assistant/);
  assert.doesNotMatch(section, /quoted by user/);
});

test("buildExplicitCueRecallSection keeps numeric fallback when label search is saturated", async () => {
  const messages = Array.from({ length: 180 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  for (let index = 0; index < 70; index += 1) {
    messages[index] = {
      role: index % 2 === 0 ? "user" : "assistant",
      content:
        index % 2 === 0
          ? `[Action 47]: earlier duplicate ${index}`
          : `[Observation 47]: earlier duplicate ${index}`,
    };
  }
  messages[93] = { role: "assistant", content: "[Observation 46]: true prior" };
  messages[94] = { role: "user", content: "[Action 47]: true move" };
  messages[95] = { role: "assistant", content: "[Observation 47]: true state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened in step 47?",
    maxChars: 8000,
  });

  assert.match(section, /true prior/);
  assert.match(section, /true move/);
  assert.match(section, /true state/);
});

test("buildExplicitCueRecallSection skips unpaired label clusters before fallback evidence", async () => {
  const messages = Array.from({ length: 140 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  for (let index = 0; index < 35; index += 1) {
    messages[index] = {
      role: "user",
      content: `[Action 47]: same-role quote ${index}`,
    };
  }
  messages[93] = { role: "assistant", content: "[Observation 46] true prior" };
  messages[94] = { role: "user", content: "[Action 47] true legacy move" };
  messages[95] = { role: "assistant", content: "[Observation 47] true legacy state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened in step 47?",
    maxChars: 3000,
  });

  assert.match(section, /true prior/);
  assert.match(section, /true legacy move/);
  assert.match(section, /true legacy state/);
  assert.doesNotMatch(section, /same-role quote/);
});

test("buildExplicitCueRecallSection prefers nearby legacy labels over early long quote pairs", async () => {
  const messages = Array.from({ length: 140 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `filler turn ${index}`,
  }));
  for (let index = 0; index < 3; index += 1) {
    const turnIndex = index * 2;
    const longQuote = "quoted detail ".repeat(250);
    messages[turnIndex] = {
      role: "user",
      content: `[Action 47]: early quote pair ${index} ${longQuote}`,
    };
    messages[turnIndex + 1] = {
      role: "assistant",
      content: `[Observation 47]: early quote pair ${index} ${longQuote}`,
    };
  }
  messages[93] = { role: "assistant", content: "[Observation 46] true prior" };
  messages[94] = { role: "user", content: "[Action 47] true legacy move" };
  messages[95] = { role: "assistant", content: "[Observation 47] true legacy state" };
  const engine = new FakeCueEngine({ "bench-session": messages });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened in step 47?",
    maxChars: 3000,
  });

  assert.match(section, /true legacy move/);
  assert.match(section, /true legacy state/);
  assert.doesNotMatch(section, /early quote pair/);
});

test("buildExplicitCueRecallSection expands direct turn references", async () => {
  const engine = new FakeCueEngine({
    "bench-session": [
      { role: "user", content: "turn zero" },
      { role: "assistant", content: "turn one" },
      { role: "user", content: "turn two" },
      { role: "assistant", content: "turn three target answer" },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What was said at Turn 3?",
    maxChars: 2000,
  });

  assert.match(section, /turn three target answer/);
});

test("buildExplicitCueRecallSection does not bound sparse turn indexes by message count", async () => {
  const engine = new FakeCueEngine({
    "bench-session": [
      {
        turnIndex: 450,
        role: "assistant",
        content: "sparse retained turn target answer",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "bench-session",
    query: "What happened at Turn 450?",
    maxChars: 2000,
  });

  assert.match(section, /sparse retained turn target answer/);
});

test("buildExplicitCueRecallSection searches lexical cues across sessions when no session is bound", async () => {
  const engine = new FakeCueEngine({
    first: [{ role: "user", content: "ordinary context" }],
    second: [{ role: "assistant", content: "[D1:1] Maya moved to Seattle" }],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    query: "What did D1:1 establish?",
    maxChars: 2000,
  });

  assert.match(section, /Maya moved to Seattle/);
});

test("buildExplicitCueRecallSection searches query-visible speaker names", async () => {
  const engine = new FakeCueEngine({
    locomo: [
      { role: "user", content: "[D1:1] Maya Chen: I moved to Austin in 2022." },
      { role: "assistant", content: "[D1:2] Jordan: The jacket was blue." },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    query: "When did Maya Chen move?",
    maxChars: 2000,
  });

  assert.match(section, /Maya Chen/);
  assert.match(section, /2022/);
});

test("buildExplicitCueRecallSection searches explicit temporal cues", async () => {
  const engine = new FakeCueEngine({
    old: [{ role: "user", content: "[date: 2025-01-01] allergy: pollen" }],
    latest: [
      {
        role: "user",
        content: "[date: 2025-02-01] latest allergy update: shellfish",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    query: "As of 2025-02-01, what was the latest allergy update?",
    maxChars: 2000,
  });

  assert.match(section, /2025-02-01/);
  assert.match(section, /shellfish/);
});

test("buildExplicitCueRecallSection prioritizes latest state updates for current questions", async () => {
  const engine = new FakeCueEngine({
    amemgym: [
      { role: "user", content: "[User state update]: city: Austin" },
      { role: "user", content: "I am packing boxes this week." },
      { role: "user", content: "[User state update]: city: Denver" },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "amemgym",
    query: "What city does the user live in now?",
    maxChars: 2000,
  });

  assert.match(section, /city: Denver/);
  assert.match(section, /city: Austin/);
  assert.ok(
    section.indexOf("city: Denver") < section.indexOf("city: Austin"),
    "latest matching state should appear before superseded history",
  );
});

test("buildExplicitCueRecallSection searches structured plan field cues", async () => {
  const engine = new FakeCueEngine({
    arena: [
      {
        role: "assistant",
        content: [
          "MemoryArena structured plan field anchors:",
          "Day 1 dinner: Coco Bambu, Dallas",
          "Day 1 accommodation: Central Stay, Dallas",
        ].join("\n"),
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "arena",
    query: "Join Jennifer for the same dinner and accommodation.",
    maxChars: 2000,
    includeStructuredPlanCues: true,
  });

  assert.match(section, /Coco Bambu, Dallas/);
  assert.match(section, /Central Stay, Dallas/);
});

test("buildExplicitCueRecallSection stays silent when disabled by budget or no cues", async () => {
  const engine = new FakeCueEngine({
    s1: [{ role: "user", content: "[D1:1] visible" }],
  });

  assert.equal(
    await buildExplicitCueRecallSection({
      engine,
      sessionId: "s1",
      query: "What should I do next?",
      maxChars: 2000,
    }),
    "",
  );
  assert.equal(
    await buildExplicitCueRecallSection({
      engine,
      sessionId: "s1",
      query: "What does D1:1 say?",
      maxChars: 0,
    }),
    "",
  );
  assert.equal(
    await buildExplicitCueRecallSection({
      engine,
      sessionId: "s1",
      query: "What does D1:1 say?",
      maxChars: 2000,
      maxReferences: 0,
    }),
    "",
  );
});

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:_-]+/g, " ").trim();
}
