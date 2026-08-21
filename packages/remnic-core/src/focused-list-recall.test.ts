import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  buildFocusedListRecallSection,
  shouldRecallFocusedListEvidence,
} from "./focused-list-recall.js";

class FakeFocusedListEngine {
  readonly expandCalls: Array<{
    sessionId: string;
    fromTurn: number;
    toTurn: number;
    maxTokens: number;
  }> = [];

  constructor(
    private readonly sessionId: string,
    private readonly messages: Array<{ turn_index: number; role: string; content: string }>,
    private readonly searchTurnIndexes: number[] = [],
    private readonly losslessMessageWindowLimit = Number.POSITIVE_INFINITY,
    private readonly expandedContentLimit = Number.POSITIVE_INFINITY,
  ) {}

  async searchContextFull(
    _query: string,
    _limit: number,
    sessionId?: string,
  ): Promise<
    Array<{
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score: number;
    }>
  > {
    if (sessionId && sessionId !== this.sessionId) return [];
    return this.searchTurnIndexes
      .map((turnIndex, index) => {
        const message = this.messages.find((entry) => entry.turn_index === turnIndex);
        if (!message) return null;
        return {
          turn_index: message.turn_index,
          role: message.role,
          content: message.content,
          session_id: this.sessionId,
          score: 100 - index,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
    this.expandCalls.push({ sessionId, fromTurn, toTurn, maxTokens });
    if (sessionId !== this.sessionId) return [];
    const windowMessages = this.messages.filter(
      (message) => message.turn_index >= fromTurn && message.turn_index <= toTurn,
    );
    if (windowMessages.length <= this.losslessMessageWindowLimit) {
      return this.clipExpandedMessages(windowMessages);
    }
    const first = windowMessages[0];
    const last = windowMessages[windowMessages.length - 1];
    return this.clipExpandedMessages(first && last ? [first, last] : windowMessages);
  }

  async getStats(sessionId?: string): Promise<{
    totalMessages: number;
    maxTurnIndex?: number;
  }> {
    if (sessionId && sessionId !== this.sessionId) {
      return { totalMessages: 0 };
    }
    return {
      totalMessages: this.messages.length,
      maxTurnIndex: Math.max(...this.messages.map((message) => message.turn_index)),
    };
  }

  private clipExpandedMessages(
    messages: Array<{ turn_index: number; role: string; content: string }>,
  ): Array<{ turn_index: number; role: string; content: string }> {
    return messages.map((message) => ({
      ...message,
      content: message.content.slice(0, this.expandedContentLimit),
    }));
  }
}

test("focused list recall is query-triggered", () => {
  assert.equal(
    shouldRecallFocusedListEvidence(
      "How many different probability calculations did I try to confirm?",
    ),
    true,
  );
  assert.equal(
    shouldRecallFocusedListEvidence("What features should I pay attention to in sneakers?"),
    true,
  );
  assert.equal(
    shouldRecallFocusedListEvidence("Where did I say I met Laura?"),
    true,
  );
  assert.equal(
    shouldRecallFocusedListEvidence(
      "How many different user roles and security features am I trying to implement across my sessions?",
    ),
    true,
  );
  assert.equal(
    shouldRecallFocusedListEvidence(
      "How many different soy sauce substitutes have I mentioned using or buying across my conversations?",
    ),
    true,
  );
  assert.equal(
    shouldRecallFocusedListEvidence(
      "What two special events am I planning with David, and where will they take place?",
    ),
    true,
  );
  assert.equal(
    shouldRecallFocusedListEvidence("What is the espresso code?"),
    false,
  );
});

test("focused list recall deduplicates probability calculations for count questions", async () => {
  const sessionId = "beam-probability-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content: "I want a general lesson about probability notation and card draws.",
    },
    {
      turn_index: 2,
      role: "user",
      content: "Can you help me calculate P(both heads) = 1/2 x 1/2 = 1/4 so I can make sure I get it right?",
    },
    {
      turn_index: 3,
      role: "user",
      content: "I am trying to verify if P(rolling a number greater than 4) = 2/6 = 1/3 is correct.",
    },
    {
      turn_index: 4,
      role: "user",
      content: "Can you check if P(rolling a 3 or 4) = 1/6 + 1/6 = 1/3 is correct?",
    },
    {
      turn_index: 5,
      role: "user",
      content: "Please verify P(rolling a number greater than 4) = 2/6 = 1/3 one more time.",
    },
  ], [2]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars: 5_000,
    maxScanWindowTurns: 10,
  });

  assert.match(recalled, /## Focused count evidence/);
  assert.match(recalled, /Deduplicated candidate count: 3/);
  assert.match(recalled, /P\(both heads\) = 1\/2 x 1\/2 = 1\/4/);
  assert.match(recalled, /P\(rolling a number greater than 4\) = 2\/6 = 1\/3/);
  assert.match(recalled, /P\(rolling a 3 or 4\) = 1\/6 \+ 1\/6 = 1\/3/);
  assert.doesNotMatch(recalled, /general lesson about probability notation/);
});

test("focused list summary insertion treats dollar-sign headings literally", async () => {
  const sessionId = "beam-focused-dollar-heading";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 4,
      role: "user",
      content:
        "For authentication, I want password hashing using generate_password_hash and check_password_hash.",
    },
    {
      turn_index: 10,
      role: "user",
      content:
        "I am also trying to implement role-based access control with admin and user roles.",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "For security, I want account lockout after repeated failed login attempts.",
    },
  ], [4]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "How many different user roles and security features am I trying to implement across my sessions?",
    maxChars: 5_000,
    title: "Focused $& title",
  });

  assert.match(recalled, /^## Focused \$& title\n\nDeduplicated candidate count:/);
  assert.equal(recalled.match(/## Focused \$& title/g)?.length, 1);
});

test("focused list recall counts all cover-letter revisions for how-many-times questions", async () => {
  const sessionId = "beam-cover-letter-count";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content: "I submitted a cover letter for the Eastbank analyst role.",
    },
    {
      turn_index: 4,
      role: "user",
      content: "I revised the cover letter after feedback from Taylor.",
    },
    {
      turn_index: 6,
      role: "user",
      content: "I submitted another cover letter draft for the Northwind coordinator role.",
    },
    {
      turn_index: 8,
      role: "user",
      content: "I revised the cover letter again after the recruiter suggested a clearer opening.",
    },
  ], [2]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query: "How many times did I submit or revise my cover letter before the interview?",
    maxChars: 5_000,
    maxScanWindowTurns: 12,
  });

  assert.match(recalled, /Deduplicated candidate count: 4 \(four\)/);
  assert.match(recalled, /1\. I submitted a cover letter for the Eastbank analyst role/);
  assert.match(recalled, /4\. I revised the cover letter again after the recruiter suggested a clearer opening/);
});

test("focused list recall preserves exact search hits omitted by expansion truncation", async () => {
  const sessionId = "beam-probability-truncated-hit";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content: "I want a general lesson about probability notation and card draws.",
    },
    {
      turn_index: 2,
      role: "user",
      content: "Can you help me calculate P(both heads) = 1/2 x 1/2 = 1/4 so I can make sure I get it right?",
    },
    {
      turn_index: 3,
      role: "user",
      content: "Let's switch to a different unrelated topic for now.",
    },
  ], [2], 2);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars: 2_000,
    maxScanWindowTurns: 3,
  });

  assert.match(recalled, /P\(both heads\) = 1\/2 x 1\/2 = 1\/4/);
  assert.doesNotMatch(recalled, /general lesson about probability notation/);
});

test("focused list recall preserves exact search hits included with truncated content", async () => {
  const sessionId = "beam-probability-included-truncated-hit";
  const fullContent =
    "Can you help me calculate P(both heads) so I can make sure I get it right with a coin toss? Later I wrote P(both heads) = 1/2 x 1/2 = 1/4.";
  const truncatedContent =
    "Can you help me calculate P(both heads) so I can make sure I get it right with a coin toss?";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content: fullContent,
    },
  ], [2], Number.POSITIVE_INFINITY, truncatedContent.length);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars: 2_000,
    maxScanWindowTurns: 1,
  });

  assert.match(recalled, /P\(both heads\) = 1\/2 x 1\/2 = 1\/4/);
});

test("focused list recall respects zero maxSearchResults after scan collection", async () => {
  const sessionId = "beam-probability-max-results";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content:
        "Can you help me calculate P(both heads) = 1/2 x 1/2 = 1/4 so I can confirm it?",
    },
  ]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars: 1_000,
    maxSearchResults: 0,
    maxScanWindowTurns: 10,
  });

  assert.equal(recalled, "");
  assert.deepEqual(engine.expandCalls, []);
});

test("focused list recall reserves budget for count guidance", async () => {
  const sessionId = "beam-probability-budget";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content:
        "Can you help me calculate P(both heads) = 1/2 x 1/2 = 1/4 so I can make sure I get it right?",
    },
    {
      turn_index: 2,
      role: "user",
      content:
        "I am trying to verify if P(rolling a number greater than 4) = 2/6 = 1/3 is correct.",
    },
    {
      turn_index: 3,
      role: "user",
      content:
        "Can you check if P(rolling a 3 or 4) = 1/6 + 1/6 = 1/3 is correct?",
    },
  ]);
  const maxChars = 260;

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars,
    maxScanWindowTurns: 10,
  });

  assert.ok(recalled.length <= maxChars);
  assert.match(recalled, /## Focused count evidence/);
  assert.match(recalled, /Deduplicated candidate count:/);
});

test("focused list recall prefers direct simple coin and die confirmations over broader probability study examples", async () => {
  const sessionId = "beam-probability-strict-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content:
        "I'm trying to solve probability problems, like what's the probability of getting heads when flipping a coin, and can you check if my daily practice schedule is right?",
    },
    {
      turn_index: 2,
      role: "user",
      content:
        "Can you help me calculate P(both heads) using the formula 1/2 x 1/2 = 1/4, I want to make sure I get it right?",
    },
    {
      turn_index: 3,
      role: "user",
      content:
        "I'm trying to understand if rolling a 2 and rolling a 5 are mutually exclusive, which means P(A and B) = 0, and I want to confirm this concept.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I'm trying to verify the solution for P(rolling a number greater than 4) = 2/6 = 1/3, can you help me check if this is correct?",
    },
    {
      turn_index: 5,
      role: "user",
      content:
        "Can you check if my calculation P(rolling a 3 or 4) = 1/6 + 1/6 = 1/3 is correct?",
    },
    {
      turn_index: 6,
      role: "user",
      content:
        "I want to confirm if the probability of rolling a 6 on the first die and an even number on the second die is indeed 1/6 x 1/2 = 1/12.",
    },
  ], [2]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "In my questions about tossing coins and rolling dice, how many different probability calculations did I try to confirm?",
    maxChars: 5_000,
  });

  assert.match(recalled, /Deduplicated candidate count: 3 \(three\)/);
  assert.match(recalled, /P\(both heads\) = 1\/2 x 1\/2 = 1\/4/);
  assert.match(recalled, /P\(rolling a number greater than 4\) = 2\/6 = 1\/3/);
  assert.match(recalled, /P\(rolling a 3 or 4\) = 1\/6 \+ 1\/6 = 1\/3/);
  assert.doesNotMatch(recalled, /P\(A and B\) = 0/);
  assert.doesNotMatch(recalled, /1\/6 x 1\/2 = 1\/12/);
});

test("focused list recall clusters recurring weather app feature concerns", async () => {
  const sessionId = "beam-weather-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content: "I am trying to implement city autocomplete with a 5-item dropdown and 300ms debounce in my weather app.",
    },
    {
      turn_index: 4,
      role: "user",
      content: "I want to handle API error messages for invalid city names in my weather app.",
    },
    {
      turn_index: 6,
      role: "user",
      content: "I want API response caching with localStorage to respect the OpenWeather quota.",
    },
    {
      turn_index: 8,
      role: "user",
      content: "I am trying to deploy my weather app to GitHub Pages with HTTPS and a custom domain.",
    },
  ], [2]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "How many different features or concerns did I mention wanting to handle across my weather app conversations?",
    maxChars: 5_000,
  });

  assert.match(recalled, /Deduplicated candidate count: 4/);
  assert.match(recalled, /city autocomplete and API-call cost/);
  assert.match(recalled, /API error handling and user-friendly error messages/);
  assert.match(recalled, /API response caching, quota, and load-time performance/);
  assert.match(recalled, /GitHub Pages deployment, custom domain, and HTTPS setup/);
});

test("focused list recall derives distinct security features for count questions", async () => {
  const sessionId = "beam-security-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 4,
      role: "user",
      content:
        "For authentication, I want password hashing using generate_password_hash and check_password_hash.",
    },
    {
      turn_index: 10,
      role: "user",
      content:
        "I am also trying to implement role-based access control with admin and user roles.",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "For security, I want account lockout after repeated failed login attempts.",
    },
  ], [4]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "How many different user roles and security features am I trying to implement across my sessions?",
    maxChars: 5_000,
  });

  assert.match(recalled, /Deduplicated candidate count: 3 \(three\)/);
  assert.match(recalled, /password hashing/);
  assert.match(recalled, /role-based access control/);
  assert.match(recalled, /account lockout after failed login attempts/);
});

test("focused list recall counts soy sauce substitutes from user replacement evidence", async () => {
  const sessionId = "beam-soy-substitutes-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 42,
      role: "user",
      content:
        "My partner Jeffrey wanted to keep soy sauce in the pantry, but I insisted on removing it due to Brandon's allergy, and we ended up buying coconut aminos. Is coconut aminos a good substitute?",
    },
    {
      turn_index: 43,
      role: "assistant",
      content:
        "Tamari can be another soy sauce substitute, but it is not allergy-safe for everyone.",
    },
    {
      turn_index: 154,
      role: "user",
      content:
        "I just replaced soy sauce with Bragg Liquid Aminos in our stir-fry recipes starting April 3; is $5.99 per 8 oz a good price for it?",
    },
  ], [42]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "How many different soy sauce substitutes have I mentioned using or buying across my conversations?",
    maxChars: 5_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /Two substitutes: coconut aminos; liquid aminos/);
  assert.match(recalled, /Deduplicated candidate count: 2 \(two\)/);
  assert.match(recalled, /coconut aminos/);
  assert.match(recalled, /Bragg Liquid Aminos/);
  assert.doesNotMatch(recalled, /Tamari can be another soy sauce substitute/);
});

test("focused list recall collects recommendation evidence for writing-place questions", async () => {
  const sessionId = "beam-writing-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content: "I prefer writing in the mornings between 7-9 AM because I am most focused then.",
    },
    {
      turn_index: 2,
      role: "assistant",
      content: "The Montserrat Public Library is good for focused writing, but a quiet cafe can help if you need a change of environment.",
    },
  ], [2]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query: "I'm planning where to spend my next few hours writing. What places would you suggest?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Focused recommendation evidence/);
  assert.match(recalled, /prefer writing in the mornings between 7-9 AM/);
  assert.match(recalled, /Montserrat Public Library/);
  assert.match(recalled, /quiet cafe/);
});

test("focused list recall collects relation place evidence for where-did-I-meet questions", async () => {
  const sessionId = "beam-relation-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "Laura recommended the mixer because she met me on set at Blue Horizon Studios in 2019.",
    },
    {
      turn_index: 28,
      role: "assistant",
      content: "The later invitation from Laura can be useful context for planning.",
    },
  ], [28]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query: "Where did I say I met Laura?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Focused relation evidence/);
  assert.match(recalled, /Blue Horizon Studios in 2019/);
  assert.match(recalled, /Laura recommended/);
});

test("focused list recall collects planned event locations for people", async () => {
  const sessionId = "beam-special-events-core";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 150,
      role: "user",
      content:
        "I'm planning a weekend getaway to Blue Bay Resort with David on April 20-21.",
    },
    {
      turn_index: 208,
      role: "user",
      content:
        "I'm nervous about my upcoming anniversary dinner with David at The Coral Reef, East Janethaven on May 18.",
    },
  ], [150]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query: "What two special events am I planning with David, and where will they take place?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Focused relation evidence/);
  assert.match(recalled, /weekend getaway to Blue Bay Resort with David/);
  assert.match(recalled, /anniversary dinner with David at The Coral Reef, East Janethaven/);
});

test("focused list scan is capped to the recent configured turn window", async () => {
  const sessionId = "focused-recent-window";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 3,
      role: "user",
      content:
        "I've used coconut aminos as a soy sauce substitute and also bought liquid aminos.",
    },
    {
      turn_index: 50,
      role: "assistant",
      content: "We can keep the grocery notes organized.",
    },
    {
      turn_index: 55,
      role: "user",
      content: "Let's discuss dinner timing instead.",
    },
  ]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "How many different soy sauce substitutes have I mentioned using or buying across my conversations?",
    maxChars: 2_000,
    maxScanWindowTurns: 4,
    maxScanWindowTokens: 700,
  });

  assert.equal(recalled, "");
  assert.deepEqual(engine.expandCalls, [
    { sessionId, fromTurn: 52, toTurn: 55, maxTokens: 700 },
  ]);
});

test("focused list search expansion honors configured scan caps", async () => {
  const sessionId = "focused-search-window";
  const engine = new FakeFocusedListEngine(sessionId, [
    {
      turn_index: 20,
      role: "assistant",
      content: "Old soy sauce substitute context should stay outside the search hit window.",
    },
    {
      turn_index: 21,
      role: "user",
      content: "I've used coconut aminos as a soy sauce substitute.",
    },
    {
      turn_index: 22,
      role: "assistant",
      content: "Later soy sauce substitute context should also stay outside the configured cap.",
    },
  ], [21]);

  const recalled = await buildFocusedListRecallSection({
    engine,
    sessionId,
    query:
      "How many different soy sauce substitutes have I mentioned using or buying across my conversations?",
    maxChars: 2_000,
    maxScanWindowTurns: 1,
    maxScanWindowTokens: 222,
  });

  assert.match(recalled, /coconut aminos/);
  assert.deepEqual(engine.expandCalls, [
    { sessionId, fromTurn: 21, toTurn: 21, maxTokens: 222 },
    { sessionId, fromTurn: 22, toTurn: 22, maxTokens: 222 },
  ]);
  assert.doesNotMatch(recalled, /Old soy sauce substitute context/);
  assert.doesNotMatch(recalled, /Later soy sauce substitute context/);
});

test("default recall pipeline exposes focused list recall as an explicitly enableable section", () => {
  const parsed = parseConfig({});
  const focusedListSection = parsed.recallPipeline.find(
    (section) => section.id === "focused-list",
  );

  assert.deepEqual(focusedListSection, {
    id: "focused-list",
    enabled: false,
    maxChars: 2600,
    maxResults: 40,
    maxTurns: 64,
    maxTokens: 14000,
  });

  const enabled = parseConfig({ focusedListRecallEnabled: true });
  assert.equal(
    enabled.recallPipeline.find((section) => section.id === "focused-list")
      ?.enabled,
    true,
  );
});
