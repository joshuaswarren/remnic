import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExplicitCueRecallSection,
  buildTrajectoryAnalysisRecallSection,
  collectBenchmarkAnchorCues,
  collectContentLexicalCues,
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

class NoSearchCueEngine extends FakeCueEngine {
  async searchContextFull(): ReturnType<FakeCueEngine["searchContextFull"]> {
    return [];
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
  assert.deepEqual(
    collectContentLexicalCues(
      "How many new columns did I want to add to the transactions table across my requests?",
    ),
    [
      "transactions table",
      "transactions",
      "columns",
      "table",
      "add",
      "new",
    ],
  );
  assert.deepEqual(
    collectLexicalCues(
      "How many new columns did I want to add to the transactions table across my requests?",
      { includeContentLexicalCues: true },
    ),
    [
      "add",
      "columns",
      "new",
      "table",
      "transactions",
      "transactions table",
    ],
  );
  assert.deepEqual(
    collectContentLexicalCues(
      "How many different user roles and security features am I trying to implement across my sessions?",
    ),
    [
      "security features",
      "user roles",
      "security",
      "sessions",
      "roles",
      "user",
    ],
  );
  assert.deepEqual(
    collectLexicalCues(
      "Could you show me how to implement a login feature?",
      { includeContentLexicalCues: true },
    ),
    [
      "access control",
      "account lockout",
      "account lockout feature",
      "authentication",
      "authorization",
      "code snippets",
      "failed login attempts",
      "format all code snippets",
      "implement login",
      "implementation details",
      "login",
      "login feature",
      "password hashing",
      "rate limiting",
      "redis",
      "role-based access control",
      "syntax highlighting",
    ],
  );
  const meetingCues = collectLexicalCues(
    "When and where did I say I first met Vickie?",
    { includeContentLexicalCues: true },
  );
  assert.ok(meetingCues.includes("I met Vickie"));
  assert.ok(meetingCues.includes("met Vickie"));
  assert.ok(meetingCues.includes("Vickie at"));
  assert.deepEqual(
    collectLexicalCues(
      "How many weeks do I have between finishing the transaction management features and the final deployment deadline?",
      { includeContentLexicalCues: true },
    ),
    [
      "deadline",
      "deployment",
      "deployment deadline",
      "final",
      "final deployment",
      "finishing",
      "management",
      "management features",
      "milestones",
      "schedule",
      "timeline",
      "transaction",
      "transaction management",
      "weeks",
    ],
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

test("buildExplicitCueRecallSection can search content lexical cues", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "user",
        content:
          "I want to add category and notes columns to the transactions table.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many new columns did I want to add to the transactions table across my requests?",
    maxChars: 2000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /category and notes columns/);
});

test("buildExplicitCueRecallSection searches meeting fact cues for named first-meeting questions", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "assistant",
        content:
          "That sounds like a great connection you've made with Vickie, and a laptop could be a useful gift.",
      },
      {
        role: "user",
        content:
          "I met Vickie at the New Gary Community Library on January 15, 2023, and we bonded over science fiction books.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query: "When and where did I say I first met Vickie?",
    maxChars: 2000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /I met Vickie at the New Gary Community Library/);
  assert.match(section, /January 15, 2023/);
});

test("buildExplicitCueRecallSection expands implementation intent to durable formatting instructions", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "user",
        content:
          "Use Flask-Login for the login feature with authentication and authorization checks.",
      },
      {
        role: "user",
        content:
          "Always format all code snippets with syntax highlighting when I ask about implementation details.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query: "Could you show me how to implement a login feature?",
    maxChars: 2000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /syntax highlighting/);
  assert.ok(
    section.indexOf("syntax highlighting") < section.indexOf("Flask-Login"),
    "durable implementation-formatting instructions should precede broad auth implementation evidence",
  );
});

test("buildExplicitCueRecallSection expands security-feature intent to common auth controls", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "user",
        content: "I am implementing password hashing with Werkzeug.security.",
      },
      {
        role: "user",
        content: "I am implementing role-based access control for user roles.",
      },
      {
        role: "user",
        content:
          "I am implementing account lockout after 5 failed login attempts using Redis.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many different user roles and security features am I trying to implement across my sessions?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /password hashing/);
  assert.match(section, /role-based access control/);
  assert.match(section, /account lockout/);
});

test("buildExplicitCueRecallSection searches deeper for security feature enumeration evidence", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "assistant",
        content: "General authentication advice without account lockout.",
      },
      {
        role: "assistant",
        content: "A login form example with ordinary validation.",
      },
      {
        role: "assistant",
        content: "A security checklist with password hashing and RBAC.",
      },
      {
        role: "assistant",
        content: "Redis can also be used as an efficient session store.",
      },
      {
        role: "user",
        content:
          "I am implementing the account lockout feature after 5 failed login attempts using Redis 7.0 for rate limiting.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many different user roles and security features am I trying to implement across my sessions?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /account lockout feature/);
  assert.match(section, /failed login attempts/);
  assert.match(section, /Redis 7\.0/);
});

test("buildExplicitCueRecallSection scans exact security cues when FTS misses", async () => {
  const engine = new NoSearchCueEngine({
    beam: [
      {
        role: "user",
        content: "I am implementing password hashing with Werkzeug.security.",
      },
      {
        role: "user",
        content: "I am implementing role-based access control for user roles.",
      },
      {
        role: "user",
        content:
          "I am implementing the account lockout feature after 5 failed login attempts using Redis 7.0 for rate limiting.",
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many different user roles and security features am I trying to implement across my sessions?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /password hashing/);
  assert.match(section, /role-based access control/);
  assert.match(section, /account lockout feature/);
  assert.match(section, /failed login attempts/);
});

test("buildExplicitCueRecallSection skips full transcript cue scans when content lexical cues are disabled", async () => {
  let statsCalls = 0;
  const engine: ExplicitCueRecallEngine = {
    async expandContext() {
      throw new Error("full transcript scan should be gated");
    },
    async getStats() {
      statsCalls += 1;
      return { totalMessages: 3, maxTurnIndex: 2 };
    },
    async searchContextFull() {
      return [];
    },
  };

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many different user roles and security features am I trying to implement across my sessions?",
    maxChars: 4000,
    includeContentLexicalCues: false,
  });

  assert.equal(section, "");
  assert.equal(statsCalls, 0);
});

test("buildExplicitCueRecallSection scans exact project-summary and contradiction cues when FTS misses", async () => {
  const engine = new NoSearchCueEngine({
    beam: [
      {
        role: "user",
        content:
          "I've never written any Flask routes or handled HTTP requests in this project, so I'm starting from scratch.",
      },
      {
        role: "user",
        content:
          "I'm trying to implement the basic homepage route with Flask using @app.route('/').",
      },
      {
        role: "assistant",
        content:
          "Use Werkzeug.security with generate_password_hash; the default method is pbkdf2:sha256.",
      },
      {
        role: "assistant",
        content:
          "Resolve the SQLite UNIQUE constraint by verifying UUID uniqueness for transactions.",
      },
      {
        role: "assistant",
        content:
          "Fix CSRF errors by including hidden_tag(), enabling WTF_CSRF_ENABLED, and checking browser cookies.",
      },
      {
        role: "assistant",
        content:
          "The app plan included Initial project setup, transaction CRUD, deployment configuration, integration test coverage, and deployment and test improvements.",
      },
      {
        role: "assistant",
        content: [
          "The budget tracker work covered expenses, income, analytics, and data visualization.",
          "A detailed MVP schedule targeted April 15, 2024.",
          "The phases covered authentication, transaction management, analytics, and deployment.",
          "Before launch we added stronger password hashing.",
          "Token-Based Authentication: issue a JWT access_token for stateless APIs.",
          "Role-Based Access Control: add user and admin route restrictions.",
          "Input Validation: validate and sanitize requests to prevent SQL injection.",
          "Confluence documentation uses tables and diagrams for architecture decisions.",
        ].join("\n"),
      },
    ],
  });

  const contradictionSection = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query: "Have I worked with Flask routes and handled HTTP requests in this project?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });
  assert.match(contradictionSection, /never written any Flask routes/);
  assert.match(contradictionSection, /basic homepage route/);

  const summarySection = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "Can you give me a comprehensive summary of how I handled the security and database challenges?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });
  assert.match(summarySection, /pbkdf2:sha256/);
  assert.match(summarySection, /UUID uniqueness/);
  assert.match(summarySection, /WTF_CSRF_ENABLED/);

  const progressSummarySection = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "Can you provide a comprehensive summary of how my budget tracker project has progressed, including the key features implemented, the development timeline, security enhancements, and documentation efforts?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });
  assert.match(progressSummarySection, /Token-Based Authentication/);
  assert.match(progressSummarySection, /JWT access_token/);
  assert.match(progressSummarySection, /Input Validation/);
  assert.match(progressSummarySection, /SQL injection/);

  const orderingSection = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "Can you walk me through the order in which I brought up different aspects of my app development and deployment across our conversations?",
    maxChars: 4000,
    includeContentLexicalCues: true,
  });
  assert.match(orderingSection, /transaction CRUD/);
  assert.match(orderingSection, /integration test coverage/);
});

test("buildExplicitCueRecallSection preserves query-focused lines from long evidence", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "user",
        content: [
          "BEAM turn anchors: chat_id=2; source_chat_id=2",
          "Sure, let's break it down for my budget tracker project.",
          "### Components:",
          "1. User Authentication",
          "2. Transaction Management",
          "   - Add Expense",
          "   - Edit Expense",
          "3. Basic Analytics",
          "   - Monthly Summary",
          "   - Category Breakdown",
          "4. Deployment",
          "### Milestones:",
          "- Nov 1 - Nov 15, 2023: Initial project setup",
          "- Nov 16 - Dec 15, 2023: User authentication",
          "- Dec 16, 2023 - Jan 15, 2024: Develop transaction management features",
          "- Jan 16 - Feb 15, 2024: Basic analytics",
          "- Feb 16 - Mar 15, 2024: Final adjustments, testing, and deployment",
        ].join("\n"),
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many weeks do I have between finishing the transaction management features and the final deployment deadline?",
    maxChars: 900,
    maxItemChars: 260,
    includeContentLexicalCues: true,
  });

  assert.match(section, /source_chat_id=2/);
  assert.match(section, /Dec 16, 2023 - Jan 15, 2024/);
  assert.match(section, /Feb 16 - Mar 15, 2024/);
});

test("buildExplicitCueRecallSection searches deeper for temporal schedule evidence", async () => {
  const engine = new FakeCueEngine({
    beam: [
      {
        role: "assistant",
        content:
          "Transaction management validation details for a transactions API endpoint.",
      },
      {
        role: "assistant",
        content:
          "Transaction management SQLAlchemy model fields for ordinary CRUD work.",
      },
      {
        role: "assistant",
        content:
          "Transaction management pagination and filtering implementation notes.",
      },
      {
        role: "assistant",
        content:
          "Transaction management form handling without any project schedule.",
      },
      {
        role: "user",
        content: [
          "BEAM turn anchors: chat_id=2; source_chat_id=2",
          "### Components:",
          "2. Transaction Management",
          "4. Deployment",
          "### Milestones:",
          "- Dec 16, 2023 - Jan 15, 2024: Develop transaction management features",
          "- Feb 16 - Mar 15, 2024: Final adjustments, testing, and deployment",
        ].join("\n"),
      },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query:
      "How many weeks do I have between finishing the transaction management features and the final deployment deadline?",
    maxChars: 1200,
    maxItemChars: 360,
    includeContentLexicalCues: true,
  });

  assert.match(section, /source_chat_id=2/);
  assert.match(section, /Dec 16, 2023 - Jan 15, 2024/);
  assert.match(section, /Feb 16 - Mar 15, 2024/);
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

test("buildTrajectoryAnalysisRecallSection summarizes container object transfers for state questions", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [8, "open safe 1", "safe 1 is open"],
      [9, "close safe 1", "safe 1 is closed"],
      [23, "open safe 1", "safe 1 is open"],
      [24, "move cd 3 to safe 1", "cd 3 is in safe 1"],
      [83, "close safe 1", "safe 1 is closed"],
      [84, "examine safe 1", "safe 1 is closed"],
      [85, "open safe 1", "safe 1 is open"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "How did the state of safe 1 change throughout the trajectory, including what objects were placed in or removed from it?",
    maxChars: 4000,
  });

  assert.match(section, /Action 8.*open safe 1/);
  assert.match(section, /Object transfers involving safe 1/);
  assert.match(section, /Action 24.*move cd 3 to safe 1.*cd 3 placed in safe 1/);
  assert.match(section, /Latest safe 1 state at step 85: open/);
});

test("buildTrajectoryAnalysisRecallSection keeps broad container history focused on state changes", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [8, "open safe 1", "safe 1 is open"],
      [9, "close safe 1", "safe 1 is closed"],
      [12, "open drawer 1", "drawer 1 is open"],
      [13, "close drawer 1", "drawer 1 is closed"],
      [20, "take cd 3 from drawer 4", "carrying cd 3"],
      [23, "open safe 1", "safe 1 is open"],
      [24, "move cd 3 to safe 1", "cd 3 is in safe 1"],
      [80, "take cd 2 from desk 2", "carrying cd 2"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Until step 80, which containers has the agent interacted with and what state changes occurred?",
    maxChars: 4000,
  });

  assert.match(section, /Container open\/close state changes/);
  assert.match(section, /Action 8.*open safe 1/);
  assert.match(section, /Action 12.*open drawer 1/);
  assert.doesNotMatch(section, /Object transfers/);
  assert.doesNotMatch(section, /move cd 3 to safe 1/);
  assert.doesNotMatch(section, /take cd 2 from desk 2/);
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

  const longInventorySection = await buildTrajectoryAnalysisRecallSection({
    engine: new FakeCueEngine({
      ama: makeTrajectoryMessages([
        [1, "take apple 1 from desk 1", "carrying apple"],
        [2, "move apple 1 to safe 1", "apple in safe"],
        [3, "take mug 1 from desk 1", "carrying mug"],
        [4, "move mug 1 to shelf 1", "mug on shelf"],
        [5, "take pen 1 from drawer 1", "carrying pen"],
        [6, "move pen 1 to drawer 2", "pen in drawer"],
      ]),
    }),
    sessionId: "ama",
    query: "What changes occurred to the inventory throughout the trajectory?",
    maxChars: 4000,
  });
  assert.match(longInventorySection, /First five inventory changes: step 1: apple 1 added/);
  assert.match(longInventorySection, /Complete inventory changes: .*step 6: pen 1 removed/);

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
  assert.match(transitionSection, /Matched quoted observations: Observation 70 -> Observation 71/);
  assert.match(
    transitionSection,
    /Action sequence that transforms the quoted observations:.*step 71: go to drawer 4/,
  );
  assert.match(transitionSection, /Action 71.*go to drawer 4/);
  assert.doesNotMatch(transitionSection, /Action 72.*look/);
  assert.doesNotMatch(transitionSection, /Action 73.*go to shelf 2/);
  assert.doesNotMatch(transitionSection, /Action 74.*go to drawer 4/);
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

test("buildTrajectoryAnalysisRecallSection handles repeated quoted target observations", async () => {
  const sourceObservation = [
    "You pick up the toiletpaper 1 from the countertop 1.",
    "",
    "The current available actions are: go to cabinet 1, look.",
  ].join("\n");
  const targetObservation = [
    "You are facing the cabinet 1. Next to it, you see nothing.",
    "",
    "The current available actions are: close cabinet 1, examine cabinet 1, examine toiletpaper 1, go to handtowelholder 1, look, move toiletpaper 1 to cabinet 1.",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [72, "take toiletpaper 1 from countertop 1", sourceObservation],
      [73, "go to cabinet 1", "You arrive at cabinet 1."],
      [74, "look", targetObservation],
      [75, "go to handtowelholder 1", "You arrive at handtowelholder 1."],
      [76, "go to cabinet 1", "You arrive at cabinet 1."],
      [77, "look", targetObservation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: `What sequence of actions would transform the state between the observation: "${sourceObservation}" and the observation: "${targetObservation}"?`,
    maxChars: 5000,
  });

  assert.match(section, /Matched quoted observations: Observation 72 -> Observation 77/);
  assert.match(section, /step 75: go to handtowelholder 1/);
  assert.match(section, /step 76: go to cabinet 1/);
  assert.match(section, /step 77: look/);
});

test("buildTrajectoryAnalysisRecallSection keeps immediate non-look target transitions narrow", async () => {
  const sourceObservation = [
    "You arrive at garbagecan 1. On the garbagecan 1, you see nothing.",
    "",
    "The current available actions are: go to drawer 4, look.",
  ].join("\n");
  const targetObservation = [
    "You arrive at drawer 4. The drawer 4 is open. In it, you see a creditcard 1.",
    "",
    "The current available actions are: go to safe 1, look.",
  ].join("\n");
  const repeatedTargetObservation = [
    "You arrive at drawer 4. The drawer 4 is open. In it, you see a creditcard 1.",
    "",
    "The current available actions are: examine shelf 2, take pencil 2 from shelf 2.",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [70, "go to garbagecan 1", sourceObservation],
      [71, "go to drawer 4", targetObservation],
      [72, "look", "You are facing drawer 4."],
      [73, "go to safe 1", "You arrive at safe 1."],
      [74, "go to drawer 4", repeatedTargetObservation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: `What sequence of actions would transform the state between the observation: "${sourceObservation}" and the observation: "${targetObservation}"?`,
    maxChars: 5000,
  });

  assert.match(section, /Matched quoted observations: Observation 70 -> Observation 71/);
  assert.match(section, /step 71: go to drawer 4/);
  assert.doesNotMatch(section, /step 72: look/);
  assert.doesNotMatch(section, /step 74: go to drawer 4/);
});

test("buildTrajectoryAnalysisRecallSection prefers nearest core observation transition", async () => {
  const sourceObservation = [
    "You arrive at garbagecan 1. On the garbagecan 1, you see nothing.",
    "",
    "The current available actions are: go to drawer 4, look.",
  ].join("\n");
  const immediateTargetObservation = [
    "You arrive at drawer 4. The drawer 4 is open. In it, you see a creditcard 1.",
    "",
    "The current available actions are: examine garbagecan 1, look.",
  ].join("\n");
  const laterTargetObservation = [
    "You arrive at drawer 4. The drawer 4 is open. In it, you see a creditcard 1.",
    "",
    "The current available actions are: examine shelf 2, take pencil 2 from shelf 2.",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [70, "go to garbagecan 1", sourceObservation],
      [71, "go to drawer 4", immediateTargetObservation],
      [72, "look", "You are facing drawer 4."],
      [73, "go to safe 1", "You arrive at safe 1."],
      [74, "go to drawer 4", "You arrive at drawer 4."],
      [75, "look", "You are facing drawer 4."],
      [76, "go to shelf 2", "You arrive at shelf 2."],
      [77, "go to drawer 4", laterTargetObservation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: `What sequence of actions would transform the state between the observation: "${sourceObservation}" and the observation: "${laterTargetObservation}"?`,
    maxChars: 5000,
  });

  assert.match(section, /Matched quoted observations: Observation 70 -> Observation 71/);
  assert.match(section, /step 71: go to drawer 4/);
  assert.doesNotMatch(section, /step 77: go to drawer 4/);
});

test("buildTrajectoryAnalysisRecallSection includes resulting observations for explicit action sequences", async () => {
  const startObservation = [
    "You are facing the toilet 1. Next to it, you see nothing.",
    "",
    "The current available actions are: go to countertop 1, look, inventory.",
  ].join("\n");
  const finalObservation = [
    "You arrive at cabinet 1. The cabinet 1 is open. In it, you see a candle 2, a cloth 1, and a toiletpaper 3.",
    "",
    "The current available actions are: examine handtowelholder 1, examine toiletpaper 1, go to countertop 1, look.",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [70, "look", startObservation],
      [71, "go to countertop 1", "You arrive at countertop 1."],
      [72, "take toiletpaper 1 from countertop 1", "You pick up the toiletpaper 1 from the countertop 1."],
      [73, "go to cabinet 1", "You arrive at cabinet 1."],
      [74, "look", "You are facing the cabinet 1."],
      [75, "go to handtowelholder 1", "You arrive at handtowelholder 1."],
      [76, "go to cabinet 1", finalObservation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query: `When the agent is at the state with observation: "${startObservation}", performs the following sequence of actions: step 70: look; step 71: go to countertop 1; step 72: take toiletpaper 1 from countertop 1; step 73: go to cabinet 1; step 74: look; step 75: go to handtowelholder 1; step 76: go to cabinet 1, what will be the resulting state? Please provide the full observation.`,
    maxChars: 5000,
  });

  assert.match(section, /Referenced action sequence and observations/);
  assert.match(section, /Resulting observation after Action 76: You arrive at cabinet 1/);
  assert.match(section, /examine handtowelholder 1, examine toiletpaper 1/);
});

test("buildTrajectoryAnalysisRecallSection includes movable object state timelines", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [2, "go to toilet 1", "You arrive at toilet 1. On it, you see a toiletpaper 3."],
      [3, "take toiletpaper 3 from toilet 1", "You pick up the toiletpaper 3 from the toilet 1."],
      [4, "go to cabinet 1", "You arrive at cabinet 1. The cabinet 1 is closed."],
      [5, "open cabinet 1", "You open the cabinet 1."],
      [6, "move toiletpaper 3 to cabinet 1", "You move the toiletpaper 3 to the cabinet 1."],
      [77, "look", "You are facing the cabinet 1."],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "What is the state of toiletpaper 3 at step 77? When did this change occur and what were the prior whole changes history?",
    maxChars: 5000,
  });

  assert.match(section, /Timeline for toiletpaper 3/);
  assert.match(section, /Action 3.*take toiletpaper 3 from toilet 1/);
  assert.match(section, /Action 6.*move toiletpaper 3 to cabinet 1/);
  assert.match(section, /Inferred toiletpaper 3 location at step 77: cabinet 1/);
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

test("buildTrajectoryAnalysisRecallSection computes counterfactual relative positions from the prior observation", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        46,
        "down",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `door` 3 step to the left",
          "rule `is` 4 step to the left and 3 step up",
          "rule `win` 3 step to the left and 3 step up",
        ].join("\n"),
      ],
      [
        47,
        "left",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `door` 2 step to the left",
          "rule `is` 3 step to the left and 3 step up",
          "rule `win` 2 step to the left and 3 step up",
        ].join("\n"),
      ],
      [
        48,
        "up",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `door` 2 step to the left and 1 step down",
          "rule `is` 3 step to the left and 2 step up",
          "rule `win` 2 step to the left and 2 step up",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In steps 47 and 48, the agent executes `left` then `up`. If at step 47, the agent had moved `right` instead of `left`, what would the new relative position of the `DOOR` text block be, and why would this be counterproductive to the goal of forming a new rule?",
    maxChars: 4000,
  });

  assert.match(section, /Counterfactual action cues/);
  assert.match(section, /Question target cue: because the query asks for a text\/word block/);
  assert.match(section, /use Observation 46/);
  assert.match(section, /static rule door would shift from 3 step to the left to 4 steps to the left/);
  assert.doesNotMatch(section, /static door would shift/);
});

test("buildTrajectoryAnalysisRecallSection calls out the first non-canceling move after a loop", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        19,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `baba` 3 step to the left and 4 steps down",
        ].join("\n"),
      ],
      [20, "right", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `baba` 4 step to the left and 4 steps down"],
      [21, "left", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `baba` 3 step to the left and 4 steps down"],
      [22, "right", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `baba` 4 step to the left and 4 steps down"],
      [23, "left", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `baba` 3 step to the left and 4 steps down"],
      [24, "down", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `baba` 3 step to the left and 3 steps down"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "What was the strategic importance of the down action at step 24 compared to the four preceding right/left actions (steps 20-23)?",
    maxChars: 4000,
  });

  assert.match(section, /Action movement summary cues/);
  assert.match(section, /right, left, right, left, down/);
  assert.match(section, /hidden absolute position by 1 down/);
  assert.match(section, /first non-canceling movement after the prior loop/);
});

test("buildTrajectoryAnalysisRecallSection identifies stop-rule blockers and open alternatives", async () => {
  const observation = [
    "Active rules:",
    "wall is stop",
    "baba is you",
    "",
    "Objects on the map:",
    "wall 1 step to the right",
    "rule `wall` 3 step to the left",
    "rule `is` 2 step to the left",
    "rule `stop` 1 step to the left",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [3, "right", observation],
      [4, "right", observation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "If the agent had instead chosen the action up at step 4, would it have successfully moved, given wall is stop and repeated right failures?",
    maxChars: 4000,
  });

  assert.match(section, /Blocked-move cues/);
  assert.match(section, /Action 3 right is blocked/);
  assert.match(section, /wall is 1 step to the right/);
  assert.match(section, /up has no adjacent STOP object/);
});

test("buildTrajectoryAnalysisRecallSection detects direct alignment above the IS word in an active stop rule", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        15,
        "left",
        [
          "Active rules:",
          "wall is stop",
          "key is win",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `wall` 1 step to the left and 1 step down",
          "rule `is` 1 step down",
          "rule `stop` 1 step to the right and 1 step down",
          "rule `baba` 1 step to the left and 6 steps down",
          "rule `is` 6 steps down",
          "rule `you` 1 step to the right and 6 steps down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Considering the sequence of movements from step 12 to step 15, what positional relationship does the agent establish with the words of the wall is stop rule, and why is this strategically critical?",
    maxChars: 4000,
  });

  assert.match(section, /Rule-phrase alignment cues/);
  assert.match(section, /active rule wall is stop is positioned/);
  assert.match(section, /agent is directly above the rule is block/);
  assert.match(section, /future down action can push IS out of the phrase/);
  assert.match(section, /removes the STOP property from wall objects/);
});

test("buildTrajectoryAnalysisRecallSection treats stable repeated stop moves as blocked attempts", async () => {
  const observation = [
    "Active rules:",
    "wall is stop",
    "ball is win",
    "baba is you",
    "",
    "Objects on the map:",
    "wall 1 step to the right",
    "door 3 steps to the right",
    "rule `wall` 4 step to the left and 1 step up",
    "rule `is` 3 step to the left and 1 step up",
    "rule `stop` 2 step to the left and 1 step up",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [17, "right", observation],
      [18, "right", observation],
      [19, "right", observation],
      [20, "right", observation],
      [21, "right", observation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between steps 17 and 21, the agent repeatedly attempts to move right but its position remains unchanged. Given wall is stop, why was this action guaranteed to fail, and what other actions would have been more strategic for making progress?",
    maxChars: 5000,
  });

  assert.match(section, /blocked\/no-progress attempts/);
  assert.match(section, /Action 17 right is blocked/);
  assert.match(section, /wall is 1 step to the right/);
  assert.doesNotMatch(section, /hidden absolute position by 5 right/);
});

test("buildTrajectoryAnalysisRecallSection treats no-change stop attempts as blocked, not hidden movement", async () => {
  const observation = [
    "Active rules:",
    "ball is win",
    "wall is stop",
    "baba is you",
    "",
    "Objects on the map:",
    "wall 1 step to the right",
    "rule `wall` 4 step to the left and 1 step up",
    "rule `is` 3 step to the left and 1 step up",
    "rule `stop` 2 step to the left and 1 step up",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [84, "right", observation],
      [85, "right", observation],
      [86, "right", observation],
      [87, "right", observation],
      [88, "right", observation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between steps 84 and 88, the agent consistently performed the `right` action, but the game state did not change at all. Were any of these actions relevant to making progress toward the goal? Explain why or why not, using the active rules and object positions from the observation.",
    maxChars: 6000,
  });

  assert.match(section, /blocked\/no-progress attempts/);
  assert.match(section, /wall is 1 step to the right/);
  assert.match(section, /wall is stop/);
  assert.doesNotMatch(section, /hidden absolute position by 5 right/);
});

test("buildTrajectoryAnalysisRecallSection names nearby IS as the missing push target", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        19,
        "right",
        [
          "Active rules:",
          "baba is you",
          "ball is win",
          "",
          "Objects on the map:",
          "key 1 step to the right",
          "rule `is` 2 step to the left",
          "rule `ball` 3 step to the left",
          "rule `win` 4 step to the left",
        ].join("\n"),
      ],
      [20, "left", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nkey 1 step to the right\nrule `is` 2 step to the left"],
      [21, "right", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nkey 1 step to the right\nrule `is` 2 step to the left"],
      [22, "down", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nkey 1 step to the right\nrule `is` 2 step to the left"],
      [23, "up", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nkey 1 step to the right\nrule `is` 2 step to the left"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between steps 19 and 23, the agent executes opposing moves that result in no net change. What crucial, progress-enabling action is conspicuously absent from this sequence, and which nearby object is the most logical target for such an action?",
    maxChars: 5000,
  });

  assert.match(section, /Missing-interaction cues/);
  assert.match(section, /absent progress-enabling action is push/);
  assert.match(section, /nearby rule IS text block at 2 step to the left/);
});

test("buildTrajectoryAnalysisRecallSection explains wall-stop rule intervention strategy", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        8,
        "up",
        [
          "Active rules:",
          "key is win",
          "wall is stop",
          "baba is you",
          "",
          "Objects on the map:",
          "wall 1 step to the right",
          "door 4 steps to the right and 2 step up",
          "rule `wall` 4 step to the left and 3 step up",
          "rule `is` 3 step to the left and 3 step up",
          "rule `stop` 2 step to the left and 3 step up",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "At Step 8, after moving right three times, the agent is positioned below the WALL IS STOP rule text and chooses to move up. Given that a physical wall blocks access to the door on the right, why was moving up the optimal action for making progress, as opposed to continuing to move right?",
    maxChars: 5000,
  });

  assert.match(section, /Rule-intervention strategy cues/);
  assert.match(section, /wall objects immediately to the right block the right-side\/door path/);
  assert.match(section, /manipulating the WALL IS STOP rule text/);
  assert.match(section, /removing STOP from wall objects/);
});

test("buildTrajectoryAnalysisRecallSection explains no-key win-condition repositioning", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        25,
        "down",
        [
          "Active rules:",
          "key is win",
          "baba is you",
          "",
          "Objects on the map:",
          "door 3 steps to the right and 1 step down",
          "rule `door` 5 steps to the right and 1 step down",
          "rule `key` 3 steps to the right and 5 step up",
          "rule `is` 4 steps to the right and 5 step up",
          "rule `win` 5 steps to the right and 5 step up",
          "key 2 steps to the right and 5 steps down",
        ].join("\n"),
      ],
      [
        29,
        "down",
        [
          "Active rules:",
          "key is win",
          "baba is you",
          "",
          "Objects on the map:",
          "door 3 steps to the right and 3 step up",
          "rule `door` 5 steps to the right and 3 step up",
          "rule `key` 3 steps to the right and 5 step up",
          "rule `is` 4 steps to the right and 5 step up",
          "rule `win` 5 steps to the right and 5 step up",
          "key 2 steps to the right and 1 step down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "From step 25 to 29, the agent moves down five consecutive times, seemingly increasing its distance from all the rule blocks. Given the win condition is key is win but no key objects exist, what critical hidden state is the agent changing, and why is this repositioning maneuver essential for eventually solving the puzzle?",
    maxChars: 5000,
  });

  assert.match(section, /Rule-intervention strategy cues/);
  assert.match(section, /Given the question premise that no ordinary key object should be used/);
  assert.match(section, /changing hidden board position/);
  assert.match(section, /make an existing object such as door participate in the win condition/);
});

test("buildTrajectoryAnalysisRecallSection explains counterfactual contact pushes", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        43,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "key 1 step to the right and 1 step down",
          "rule `is` 1 step to the left and 1 step down",
          "rule `wall` 2 step to the left and 1 step up",
          "rule `stop` 1 step to the left and 1 step up",
        ].join("\n"),
      ],
      [
        44,
        "left",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "key 1 step down",
          "rule `is` 3 step to the left and 1 step down",
          "rule `wall` 3 step to the left and 1 step up",
          "rule `stop` 2 step to the left and 1 step up",
        ].join("\n"),
      ],
      [
        45,
        "left",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "key 1 step to the right and 1 step down",
          "rule `is` 1 step to the left and 1 step down",
          "rule `wall` 2 step to the left and 1 step up",
          "rule `stop` 1 step to the left and 1 step up",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In the transition from step 44 to 45, the agent chose the action left, moving away from the key. Based on the object layout in step 44, what would have happened if the agent had moved down instead, and why would this alternative action have been more strategic for forming the rule WALL IS STOP?",
    maxChars: 6000,
  });

  assert.match(section, /Counterfactual contact cues/);
  assert.match(section, /key is 1 step down/);
  assert.match(section, /push it one cell down/);
  assert.match(section, /Do not describe this as merely stepping onto or overlapping the block/);
  assert.match(section, /same horizontal row/);
  assert.match(section, /3 steps to the left/);
  assert.match(section, /alignment with WALL and STOP/);
  assert.doesNotMatch(section, /treat key as not currently pushable/);
});

test("buildTrajectoryAnalysisRecallSection explains adjacent rule-block setup", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [7, "up", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step to the right and 1 step up\nrule `is` 1 step up"],
      [8, "right", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step up\nrule `is` 1 step to the left and 1 step up"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "The actions from step 4 to step 8 consist of a multi-step maneuver. By analyzing the agent's final position relative to the rule blocks in the step 8 observation, what crucial strategic advantage does the final right action secure?",
    maxChars: 6000,
  });

  assert.match(section, /Adjacent rule-block setup cues/);
  assert.match(section, /rule win is 1 step up/);
  assert.match(section, /directly underneath the WIN text block/);
  assert.match(section, /future up action can push WIN up/);
});

test("buildTrajectoryAnalysisRecallSection does not treat loose push/block proximity as rule setup", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [7, "up", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step to the right and 1 step up\nrule `is` 1 step up"],
      [8, "right", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step up\nrule `is` 1 step to the left and 1 step up"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "At step 8, after I pushed past wall to reach far block, what changed in relative position?",
    maxChars: 6000,
  });

  assert.match(section, /Relative-position movement cues/);
  assert.doesNotMatch(section, /Adjacent rule-block setup cues/);
  assert.doesNotMatch(section, /future up action can push WIN up/);
});

test("buildTrajectoryAnalysisRecallSection explains temporary rule transformations", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [19, "right", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `ball` 5 steps to the right"],
      [20, "left", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nkey 1 step to the right\nrule `ball` 5 steps to the right"],
      [21, "down", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `ball` 5 steps to the right"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "The agent's right action at step 19 causes a key to appear in the observation at step 20. The subsequent left action at step 20 causes the key to disappear. What hidden state change most likely occurred?",
    maxChars: 6000,
  });

  assert.match(section, /Temporary transformation cues/);
  assert.match(section, /key appears in Observation 20 but is absent before and after/);
  assert.match(section, /temporary hidden rule\/text alignment/);
  assert.match(section, /BALL IS KEY/);
});

test("buildTrajectoryAnalysisRecallSection explains pushed phrase groups as diagonal movement", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        9,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "wall 3 steps to the right and 4 steps down",
          "rule `is` 1 step down",
          "key 1 step to the right and 1 step down",
        ].join("\n"),
      ],
      [
        10,
        "right",
        [
          "Active rules:",
          "baba is you",
          "",
          "Objects on the map:",
          "wall 2 steps to the right and 4 steps down",
          "rule `is` 1 step to the left and 1 step down",
          "key 1 step down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In the transition from Step 9 to Step 10, the agent executes the action 'down', pushing the 'is' block. A standard push would only change the block's vertical position. However, the 'is' and 'key' blocks both shift their relative horizontal and vertical positions. Based on this outcome, what hidden movement mechanic affecting pushed objects can be inferred?",
    maxChars: 6000,
  });

  assert.match(section, /Pushed phrase-group shift cues/);
  assert.match(section, /contacts rule IS at 1 step down/);
  assert.match(section, /adjacent KEY at 1 step to the right and 1 step down/);
  assert.match(section, /one cell down and one cell to the left/);
  assert.doesNotMatch(section, /this implies the agent moved right relative to a static object/);
});

test("buildTrajectoryAnalysisRecallSection calls out self-reversing progress noise", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [19, "right", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 7 steps to the right"],
      [20, "left", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 8 steps to the right"],
      [21, "down", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 8 steps to the right and 1 step up"],
      [22, "up", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 8 steps to the right"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between step 19 and step 23, the agent performs a sequence of four movements: `right`, `left`, `down`, and `up`. Which of these actions were relevant for making progress towards the goal of touching a `win` object, and why?",
    maxChars: 6000,
  });

  assert.match(section, /Self-reversing sequence cues/);
  assert.match(section, /net displacement 0/);
  assert.match(section, /self-reversing exploratory noise/);
  assert.match(section, /none of the named actions made lasting progress/);
  assert.doesNotMatch(section, /Relative-position movement cues/);
});

test("buildTrajectoryAnalysisRecallSection skips filler before named movement sequences", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [19, "right", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 7 steps to the right"],
      [20, "left", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 8 steps to the right"],
      [21, "down", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 8 steps to the right and 1 step up"],
      [22, "up", "Active rules:\nbaba is you\nball is win\n\nObjects on the map:\nrule `win` 8 steps to the right"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between step 19 and step 23, the agent performs a sequence of four movements: the following movements are right, left, down, and up. Which of these actions were relevant for making progress toward the goal of touching a win object, and why?",
    maxChars: 6000,
  });

  assert.match(section, /Self-reversing sequence cues/);
  assert.match(section, /net displacement 0/);
  assert.match(section, /self-reversing exploratory noise/);
  assert.doesNotMatch(section, /Relative-position movement cues/);
});

test("buildTrajectoryAnalysisRecallSection infers failed text pushes reveal boundaries", async () => {
  const observation = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `is` 1 step up",
    "rule `win` 1 step to the right and 1 step up",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [23, "left", observation],
      [24, "up", observation],
      [25, "up", observation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "At Step 24 and 25, the agent's up action repeatedly fails, causing no change in the game state. Based on the object configuration shown in Step 23, what specific object is blocking the agent, and what critical information about the level's layout can be inferred from the agent's inability to push it?",
    maxChars: 6000,
  });

  assert.match(section, /Failed-push boundary cues/);
  assert.match(section, /rule is is 1 step up/);
  assert.match(section, /No active STOP rule is involved/);
  assert.match(section, /pressed against the top\/northern edge of the playable area/);
});

test("buildTrajectoryAnalysisRecallSection treats same-relative text pushes as hidden movement", async () => {
  const beforeContact = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `door` 2 steps to the left",
  ].join("\n");
  const adjacentDoor = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `door` 1 step to the left",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [10, "left", beforeContact],
      [11, "left", adjacentDoor],
      [12, "left", adjacentDoor],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "At step 12, the observation still showed the `door` text block in the same relative position after a left move. What hidden state change occurred, and why is this not a failed push?",
    maxChars: 6000,
  });

  assert.match(section, /Same-relative text-push cues/);
  assert.match(section, /cumulative displacement across the named repeated actions/);
  assert.match(section, /rule door moved one cell left per left action/);
  assert.match(section, /Action 12 left kept it at the same relative offset/);
  assert.match(section, /pushed rule door left and moved with it in hidden absolute coordinates/);
  assert.doesNotMatch(section, /Failed-push boundary cues/);
});

test("buildTrajectoryAnalysisRecallSection recognizes instead-moved alternatives around stop blockers", async () => {
  const observation = [
    "Active rules:",
    "wall is stop",
    "baba is you",
    "",
    "Objects on the map:",
    "wall 1 step to the right",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [6, "right", observation],
      [7, "right", observation],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In steps 6 through 10, the agent repeatedly moves right but is blocked. If the agent at step 6 had instead moved left, would it have successfully changed its position?",
    maxChars: 6000,
  });

  assert.match(section, /Blocked-move cues/);
  assert.match(section, /Action 6 right is blocked/);
  assert.match(section, /left has no adjacent STOP object/);
});

test("buildTrajectoryAnalysisRecallSection explains whole-configuration shifts", async () => {
  const before = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `is` 1 step up",
    "rule `win` 1 step to the right and 1 step up",
    "rule `key` 3 steps to the right and 1 step up",
    "rule `door` 1 step to the left",
    "door 1 step to the left and 1 step down",
    "rule `you` 1 step to the right and 4 steps down",
  ].join("\n");
  const after = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `is` 1 step to the left and 1 step up",
    "rule `win` 1 step up",
    "rule `key` 2 steps to the right and 1 step up",
    "rule `door` 2 step to the left",
    "door 2 step to the left and 1 step down",
    "rule `you` 4 steps down",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [7, "up", before],
      [8, "right", after],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In steps 4-7, the agent makes four consecutive moves without altering the positions of any objects. Then, at step 8, its right action causes the entire level configuration to shift. Why was moving right optimal, and what would moving left or down do instead?",
    maxChars: 6000,
  });

  assert.match(section, /Whole-configuration shift cues/);
  assert.match(section, /coordinated whole-level push\/shift/);
  assert.match(section, /6 tracked objects or rule words all moved 1 step to the left/);
  assert.match(section, /moving left or down would move back into empty space or undo the setup/);
});

test("buildTrajectoryAnalysisRecallSection infers blocked-corner escape directions", async () => {
  const observation = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `is` 1 step up",
    "rule `win` 1 step to the right and 1 step up",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [11, "left", observation],
      [12, "left", observation],
      [13, "up", observation],
      [14, "up", observation],
      [15, "right", "Active rules:\nbaba is you\n\nObjects on the map:\nrule `win` 1 step up"],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Question: What can be inferred from the agent's failed moves (left in steps 11-12, up in steps 13-14) before the successful move at step 15?",
    maxChars: 6000,
  });

  assert.match(section, /Failed-move escape cues/);
  assert.match(section, /blocked to the left and above/);
  assert.match(section, /useful escape direction\(s\) are right and down/);
  assert.match(section, /successful right move at step 15/);
  assert.doesNotMatch(section, /Failed-push boundary cues/);
});

test("buildTrajectoryAnalysisRecallSection identifies the only effective action inside a span", async () => {
  const baseline = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `win` 1 step to the right and 1 step up",
    "rule `door` 1 step to the left",
  ].join("\n");
  const changed = [
    "Active rules:",
    "baba is you",
    "",
    "Objects on the map:",
    "rule `win` 1 step up",
    "rule `door` 2 step to the left",
  ].join("\n");
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [11, "left", baseline],
      [12, "left", baseline],
      [13, "up", baseline],
      [14, "up", baseline],
      [15, "right", changed],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "In the sequence from step 11 to step 15, only one action caused a change in the game state. Which specific action was relevant, and what evidence proves the other four were ineffective?",
    maxChars: 6000,
  });

  assert.match(section, /Only-effective action cues/);
  assert.match(section, /Observations 11-14 have the same object-relative signature/);
  assert.match(section, /Action 15 right is the only progress-making action/);
  assert.match(section, /rule win changed from 1 step to the right and 1 step up to 1 step up/);
  assert.doesNotMatch(section, /Action movement summary cues/);
});

test("buildTrajectoryAnalysisRecallSection explains active control-rule interaction setup", async () => {
  const engine = new FakeCueEngine({
    ama: makeTrajectoryMessages([
      [
        29,
        "down",
        [
          "Active rules:",
          "key is win",
          "baba is you",
          "",
          "Objects on the map:",
          "rule `baba` 5 step to the left and 1 step down",
          "rule `is` 4 step to the left and 1 step down",
          "rule `you` 3 step to the left and 1 step down",
        ].join("\n"),
      ],
    ]),
  });

  const section = await buildTrajectoryAnalysisRecallSection({
    engine,
    sessionId: "ama",
    query:
      "Between steps 25 and 29, the agent repeatedly moves down. What specific text block is the agent moving to position itself next to, and why is this multi-step approach a necessary prerequisite for interacting with the `baba is you` rule?",
    maxChars: 6000,
  });

  assert.match(section, /Control-rule interaction cues/);
  assert.match(section, /specific target text block is rule baba/);
  assert.match(section, /BABA IS YOU makes Baba the controlled agent/);
  assert.match(section, /push a different object or text block into the rule's syntax line/);
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

test("buildExplicitCueRecallSection prioritizes latest count updates for how-many questions", async () => {
  const engine = new FakeCueEngine({
    beam: [
      { role: "user", content: "The main branch has 150 commits merged." },
      { role: "assistant", content: "Review the old repository workflow." },
      { role: "user", content: "The main branch has now reached 165 commits." },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query: "How many commits have been merged into the main branch?",
    maxChars: 2000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /165 commits/);
  assert.match(section, /150 commits/);
  assert.ok(
    section.indexOf("165 commits") < section.indexOf("150 commits"),
    "later count updates should appear before stale matching counts",
  );
});

test("buildExplicitCueRecallSection keeps enumeration queries in historical order", async () => {
  const engine = new FakeCueEngine({
    beam: [
      { role: "user", content: "I need admin user roles and baseline authentication." },
      { role: "user", content: "I also need editor user roles and security audit features." },
    ],
  });

  const section = await buildExplicitCueRecallSection({
    engine,
    sessionId: "beam",
    query: "How many different user roles and security features am I trying to implement?",
    maxChars: 2000,
    includeContentLexicalCues: true,
  });

  assert.match(section, /admin user roles/);
  assert.match(section, /editor user roles/);
  assert.ok(
    section.indexOf("admin user roles") < section.indexOf("editor user roles"),
    "enumeration queries should keep historical evidence order instead of latest-only ordering",
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
