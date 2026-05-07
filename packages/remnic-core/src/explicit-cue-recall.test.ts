import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExplicitCueRecallSection,
  buildTrajectoryAnalysisRecallSection,
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

  async getStats(sessionId?: string): Promise<{
    totalMessages: number;
    maxTurnIndex?: number;
  }> {
    const sessionEntries = Object.entries(this.sessions).filter(
      ([candidateSessionId]) => !sessionId || candidateSessionId === sessionId,
    );
    let maxTurn = -1;
    let totalMessages = 0;
    for (const [, messages] of sessionEntries) {
      totalMessages += messages.length;
      for (let index = 0; index < messages.length; index += 1) {
        maxTurn = Math.max(maxTurn, messages[index]?.turnIndex ?? index);
      }
    }
    return { totalMessages, maxTurnIndex: maxTurn };
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

test("buildTrajectoryAnalysisRecallSection enumerates full action ranges", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [71, "go to drawer 4", "arrived at drawer 4"],
      [72, "look", "looked around"],
      [73, "go to safe 1", "arrived at safe 1"],
      [74, "go to drawer 4", "arrived at drawer 4"],
      [75, "look", "looked at drawer 4"],
      [76, "go to shelf 2", "arrived at shelf 2"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "What actions were performed between step 71 and step 76?",
    maxChars: 4000,
  });

  assert.match(section, /^## Trajectory analysis/);
  for (const step of [71, 72, 73, 74, 75, 76]) {
    assert.match(section, new RegExp(`Action ${step}`));
  }
});

test("buildTrajectoryAnalysisRecallSection preserves before-step entity history", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [8, "open safe 1", "safe 1 is open"],
      [9, "close safe 1", "safe 1 is closed"],
      [20, "take cd 3 from desk 1", "carrying cd 3"],
      [23, "open safe 1", "safe 1 is open"],
      [24, "move cd 3 to safe 1", "cd 3 is in safe 1"],
      [80, "take cd 2 from desk 2", "carrying cd 2"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Before step 80, which actions were performed on safe 1 and at which steps?",
    maxChars: 4000,
  });

  assert.match(section, /Action 8.*open safe 1/);
  assert.match(section, /Action 9.*close safe 1/);
  assert.match(section, /Action 23.*open safe 1/);
  assert.doesNotMatch(section, /Action 80/);
  assert.doesNotMatch(section, /move cd 3 to safe 1/);
});

test("buildTrajectoryAnalysisRecallSection summarizes inventory and frequency", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [0, "look", "empty inventory"],
      [1, "go to desk 1", "at desk"],
      [2, "take cd 3 from desk 1", "carrying cd 3"],
      [3, "move cd 3 to safe 1", "cd 3 in safe"],
      [4, "take cd 2 from desk 2", "carrying cd 2"],
      [5, "look", "still carrying cd 2"],
    ]),
  });

  const inventorySection = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "What changes occurred to the inventory throughout the trajectory?",
    maxChars: 4000,
  });
  assert.match(inventorySection, /inventory added cd 3/);
  assert.match(inventorySection, /inventory removed cd 3/);
  assert.match(inventorySection, /inventory added cd 2/);

  const frequencySection = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "Until step 5, what types of actions has the agent performed and how frequently?",
    maxChars: 4000,
  });
  assert.match(frequencySection, /look=2/);
  assert.match(frequencySection, /go=1/);
  assert.match(frequencySection, /take=2/);
  assert.match(frequencySection, /move=1/);
});

test("buildTrajectoryAnalysisRecallSection resolves quoted observation transitions and entity locations", async () => {
  const sourceObservation = [
    "You arrive at garbagecan 1. On the garbagecan 1, you see nothing.",
    "",
    "The current available actions are: go to drawer 4, look.",
  ].join("\n");
  const targetObservation = [
    "You arrive at drawer 4. The drawer 4 is open. In it, you see a creditcard 1.",
    "",
    "The current available actions are: examine shelf 2, go to shelf 2, look.",
  ].join("\n");
  const immediateTargetObservation = [
    "You arrive at drawer 4. The drawer 4 is open. In it, you see a creditcard 1.",
    "",
    "The current available actions are: examine garbagecan 1, look.",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [70, "look", sourceObservation],
      [71, "go to drawer 4", immediateTargetObservation],
      [72, "look", "You are facing drawer 4."],
      [73, "go to shelf 2", "You arrive at shelf 2."],
      [74, "go to drawer 4", targetObservation],
      [80, "take cd 2 from desk 2", "carrying cd 2"],
      [90, "move cd 3 to safe 1", "cd 3 is in safe 1"],
      [115, "look", "cd 2 can be moved to safe 1"],
    ]),
  });

  const transitionSection = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: `What sequence of actions would transform the state between the observation: "${sourceObservation}" and the observation: "${targetObservation}"?`,
    maxChars: 5000,
  });
  assert.match(transitionSection, /Action 71.*go to drawer 4/);
  assert.doesNotMatch(transitionSection, /Action 72/);
  assert.doesNotMatch(transitionSection, /Action 80/);

  const locationSection = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "What is the location of cd 3, cd 2 at step 115?",
    maxChars: 5000,
  });
  assert.match(locationSection, /cd 2 location at step 115: inventory/);
  assert.match(locationSection, /cd 3 location at step 115: safe 1/);
});

test("buildTrajectoryAnalysisRecallSection keeps disjoint explicit references discrete", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [2, "move-2", "state-2"],
      [20, "unrelated-noise bridge action", "state-20"],
      [40, "move-40", "state-40"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "Compare steps 2 and 40 with unrelated-noise before answering.",
    maxChars: 4000,
  });

  assert.match(section, /Action 2.*move-2/);
  assert.match(section, /Action 40.*move-40/);
  assert.doesNotMatch(section, /Action 20/);
  assert.doesNotMatch(section, /unrelated-noise bridge action/);
});

test("buildTrajectoryAnalysisRecallSection infers movement from relative object deltas", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        20,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `win` 3 step to the left",
        ].join("\n"),
      ],
      [
        21,
        "left",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `win` 2 step to the left",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between steps 20 and 21, the rule 'win' block's relative position changed from 3 step to the left to 2 step to the left. What was the actual movement?",
    maxChars: 4000,
  });

  assert.match(section, /Relative-position movement cues/);
  assert.match(section, /rule win changed from 3 step to the left to 2 step to the left/);
  assert.match(section, /agent moved left/);
});

test("buildTrajectoryAnalysisRecallSection infers same-tile alignment from object disappearance", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        41,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "ball 1 step to the right",
          "rule `win` 3 steps to the left and 1 step up",
        ].join("\n"),
      ],
      [
        42,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `win` 4 steps to the left and 1 step up",
          "rule `ball` 1 step to the right and 4 steps down",
        ].join("\n"),
      ],
      [
        43,
        "down",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "ball 1 step up",
          "rule `win` 4 steps to the left and 2 steps up",
          "rule `ball` 1 step to the right and 3 steps down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "At step 41, the ball was 1 step to the right. After moving right in step 42 it vanished, then after moving down in step 43 it reappeared 1 step up. What was the exact position and why was achieving this state the critical objective of the agent's moves from step 39 to 42?",
    maxChars: 4000,
  });

  assert.match(section, /Object alignment cues/);
  assert.match(section, /zero-offset same-tile alignment at the end of step 42/);
  assert.match(section, /ball reappears 1 step up/);
  assert.match(section, /future upward interaction or alignment/);
  assert.match(section, /possible ball manipulation or rule alignment toward a new win condition/);
  assert.doesNotMatch(section, /not as pushing, collecting, or removing ball/);
});

test("buildTrajectoryAnalysisRecallSection infers rule-text repositioning goals", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        39,
        "up",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `is` 2 step to the left and 2 step up",
          "rule `win` 1 step to the left and 2 step up",
          "ball 2 steps to the right and 1 step up",
        ].join("\n"),
      ],
      [
        42,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `is` 4 step to the left and 1 step up",
          "rule `win` 3 step to the left and 1 step up",
          "rule `ball` 1 step to the right and 4 steps down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In steps 39-42, what strategic goal did the up, up, right, right maneuver accomplish, and what implicit property of the ball made it necessary?",
    maxChars: 4000,
  });

  assert.match(section, /Rule-text positioning cues/);
  assert.match(section, /rule is moved from 2 step to the left and 2 step up to 4 step to the left and 1 step up/);
  assert.match(section, /rule win moved from 1 step to the left and 2 step up to 3 step to the left and 1 step up/);
  assert.match(section, /repositioning the agent to the right of those rule text blocks/);
});

test("buildTrajectoryAnalysisRecallSection recommends alternative moves toward win-rule text", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        7,
        "down",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `is` 2 step to the left and 1 step up",
          "rule `win` 1 step to the left and 1 step up",
          "rule `door` 2 steps down",
        ].join("\n"),
      ],
      [
        8,
        "up",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `is` 2 step to the left",
          "rule `win` 1 step to the left",
          "rule `door` 3 steps down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In steps 7-10, the agent gets stuck in a down-up loop. At the start of Step 8, instead of moving up, what alternative move would have represented a clear step towards creating a new win condition?",
    maxChars: 4000,
  });

  assert.match(section, /Counterfactual action cues/);
  assert.match(section, /At the start of step 8, use Observation 7 as the decision state/);
  assert.match(section, /rule win at 1 step to the left and 1 step up/);
  assert.match(section, /left is the alternative/);
  assert.match(section, /IS\/WIN rule text/);
});

test("buildTrajectoryAnalysisRecallSection surfaces inactive object rules", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        39,
        "up",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "ball 2 steps to the right and 1 step up",
          "rule `ball` 3 steps to the right and 3 steps down",
        ].join("\n"),
      ],
      [
        42,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `ball` 1 step to the right and 4 steps down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In steps 39-42, what strategic goal did the up, up, right, right maneuver accomplish, and what implicit property of the ball made it necessary?",
    maxChars: 4000,
  });

  assert.match(section, /Rule-state cues/);
  assert.match(section, /Active rules in this window: baba is you/);
  assert.match(section, /No active rule for ball appears/);
  assert.match(section, /no "ball is push" rule is active/);
  assert.match(section, /treat ball as not currently pushable/);
  assert.match(section, /bypassing or repositioning around a not-pushable obstacle/);
});

test("buildTrajectoryAnalysisRecallSection expands sparse turn-index archives", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([[50, "sparse target action", "sparse target state"]])
      .map((message, index) => ({
        ...message,
        turnIndex: 100 + index,
      })),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "What happened in step 50?",
    maxChars: 4000,
  });

  assert.match(section, /Action 50.*sparse target action/);
  assert.match(section, /Observation 50.*sparse target state/);
});

test("buildTrajectoryAnalysisRecallSection rejects reverse-only quoted observation transitions", async () => {
  const laterObservation = "later state with the source details";
  const earlierObservation = "earlier state with the target details";
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [5, "first action", earlierObservation],
      [10, "later action", laterObservation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: `What sequence of actions would transform the state between the observation: "${laterObservation}" and the observation: "${earlierObservation}"?`,
    maxChars: 4000,
  });

  assert.equal(section, "");
});

test("buildTrajectoryAnalysisRecallSection truncates within tiny budgets", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([[1, "look", "state-1"]]),
  });
  const header = "## Trajectory analysis";
  const newline = "\n";
  const maxChars = header.length + newline.length + 2;

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: "What actions were performed between step 1 and step 1?",
    maxChars,
  });

  assert.ok(section.length <= maxChars);
  assert.match(section, /^## Trajectory analysis\n/);
  assert.equal(
    await buildTrajectoryAnalysisRecallSection({
      engine,
      sessionId: "ama",
      query: "What actions were performed between step 1 and step 1?",
      maxChars: header.length,
    }),
    "",
  );
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

function makeTrajectoryMessages(
  steps: Array<[number, string, string]>,
): Message[] {
  const messages: Message[] = [];
  for (const [step, action, observation] of steps) {
    messages.push({
      role: "user",
      content: `[Action ${step}]: ${action}`,
    });
    messages.push({
      role: "assistant",
      content: `[Observation ${step}]: ${observation}`,
    });
  }
  return messages;
}
