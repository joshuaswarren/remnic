import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import {
  buildTargetedFactRecallSection,
  shouldRecallTargetedFactEvidence,
} from "./targeted-fact-recall.js";

class FakeTargetedFactEngine {
  readonly expandCalls: Array<{
    sessionId: string;
    fromTurn: number;
    toTurn: number;
    maxTokens?: number;
  }> = [];

  constructor(
    private readonly sessionId: string,
    private readonly messages: Array<{ turn_index: number; role: string; content: string }>,
    private readonly searchTurnIndexes: number[] = [],
    private readonly losslessMessageWindowLimit = Number.POSITIVE_INFINITY,
    private readonly expandedContentLimit = Number.POSITIVE_INFINITY,
  ) {}

  async searchContextFull(): Promise<
    Array<{
      id: number;
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score: number;
    }>
  > {
    return this.searchTurnIndexes
      .map((turnIndex, index) => {
        const message = this.messages.find((entry) => entry.turn_index === turnIndex);
        if (!message) return null;
        return {
          id: index,
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
    maxTokens?: number,
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
    totalSummaryNodes: number;
    maxDepth: number;
    maxTurnIndex?: number;
  }> {
    if (sessionId && sessionId !== this.sessionId) {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: -1 };
    }
    return {
      totalMessages: this.messages.length,
      totalSummaryNodes: 0,
      maxDepth: -1,
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

test("targeted fact recall is query-triggered", () => {
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much money had I saved when I reached 60% of my emergency fund goal?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much did I increase my weekly word count goal from the start until April 9?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How many days passed between when I started my 30-day editing challenge and when I completed the 15-day clarity editing challenge?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How many days are there between when I started implementing TF-IDF vectorization for content-based filtering and the planned beta release date for internal testing?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How many days passed between when I first asked for help solving the constrained optimization problem and when I fully understood the relationship between the gradient vector and directional derivative with the example?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "If I start my 6-week development period on the day I begin coding, how many days do I have left until the MVP deadline?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How many weeks will Scott have been attending twice weekly tutoring sessions by the time I want him to reach his 80% math score goal?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What score did I achieve on my number theory induction quiz most recently?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What budget ceiling have I set for purchasing a new phone with a focus on camera and battery life?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What is my annual salary as a senior engineer at Saint Pierre Manufacturing Ltd?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What was the cost I mentioned for the training I'm enrolled in?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much total did I pay in fees for rebalancing, the art fund acquisition, and the Wealthfront subscription?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much did I say I invested in Bitcoin, and on which platform did I make this investment?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much total did I pay in transaction fees for my Ethereum purchase, wallet transfer, and NFT purchase combined?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much do I contribute monthly to my Roth IRA?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much did my quiz score improve between when I first completed 3 induction problems and when I solved 5 inequality induction problems?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much total confidence boost did I report from co-leading or co-hosting activities with Patricia?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What address did I mention for where I live?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much total money have I spent on my KitchenAid mixer and organic almond flour combined?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How much total money am I planning to spend on my trip and future equipment savings combined?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What is the time-to-live (TTL) setting for caching diffusion features in Redis to optimize API response times?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How many different technologies or tools have I mentioned using across my game caching and authentication implementations?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "How many different types of geometry have I studied based on my questions about parallel lines and triangle angle sums?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence(
      "What value did I say I was using for the growth rate in my population model?",
    ),
    true,
  );
  assert.equal(
    shouldRecallTargetedFactEvidence("What should I name this helper function?"),
    false,
  );
});

test("targeted fact recall scans session windows when search misses the exact numeric update", async () => {
  const sessionId = "beam-finance-core";
  const messages = [
    {
      turn_index: 0,
      role: "assistant",
      content:
        "For a 3-month emergency fund, if monthly expenses are $1,950, the target would be $5,850.",
    },
    ...Array.from({ length: 65 }, (_, index) => ({
      turn_index: index + 1,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Filler budget note ${index + 1}.`,
    })),
    {
      turn_index: 80,
      role: "user",
      content:
        "I've finally reached $1,200 in my emergency fund by June 5, which is 60% of my $2,000 goal.",
    },
  ];
  const engine = new FakeTargetedFactEngine(sessionId, messages, [0]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much money had I saved in total by the time I reached 60% of my emergency fund goal?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Targeted fact evidence/);
  assert.match(recalled, /reached \$1,200 in my emergency fund/);
  assert.match(recalled, /60% of my \$2,000 goal/);
  assert.match(recalled, /1200 dollars/);
  assert.match(recalled, /60 percent/);
  assert.ok(
    recalled.indexOf("reached $1,200 in my emergency fund") <
      recalled.indexOf("monthly expenses are $1,950"),
  );
});

test("targeted fact recall computes emergency-fund duration between dated milestones", async () => {
  const sessionId = "beam-finance-duration-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I've finally reached $1,200 in my emergency fund by June 5, which is 60% of my $2,000 goal.",
    },
    {
      turn_index: 40,
      role: "user",
      content:
        "I just reached my emergency fund goal of $2,000 on August 30, which is 3 months early.",
    },
  ], [12]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How long after saving $1,200 by early June did it take me to reach my full emergency fund goal?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed temporal interval: 86 days from June 5 till August 30/);
  assert.match(recalled, /\$1,200 in my emergency fund by June 5/);
  assert.match(recalled, /emergency fund goal of \$2,000 on August 30/);
});

test("targeted fact recall preserves years when computing dated emergency-fund intervals", async () => {
  const sessionId = "beam-finance-duration-years";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I reached $1,200 in my emergency fund by January 1, 2023, which was the first checkpoint.",
    },
    {
      turn_index: 40,
      role: "user",
      content:
        "I reached my emergency fund goal of $2,000 on January 1, 2024 after a full year of saving.",
    },
  ], [12]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How long after saving $1,200 did it take me to reach my full emergency fund goal?",
    maxChars: 4_000,
  });

  assert.match(
    recalled,
    /Computed temporal interval: 365 days from January 1, 2023 till January 1, 2024/,
  );
});

test("targeted fact recall computes writing metric deltas", async () => {
  const sessionId = "beam-writing-metric-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I'm kinda struggling to meet my writing goals, like targeting 1,200 words per week.",
    },
    {
      turn_index: 36,
      role: "user",
      content:
        "I've increased my weekly word count from 1,200 to 1,500 words by April 9, tracked via Google Docs.",
    },
  ], [10]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "How much did I increase my weekly word count goal from the start until April 9?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed word-count increase: 300 words, from 1,200 to 1,500 words/);
  assert.match(recalled, /increased my weekly word count from 1,200 to 1,500 words/);
});

test("targeted fact recall computes editing challenge intervals", async () => {
  const sessionId = "beam-editing-challenge-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 91,
      role: "user",
      content:
        "I've entered a 30-day editing challenge starting April 2, and I'm struggling to stay on track.",
    },
    {
      turn_index: 223,
      role: "user",
      content:
        "I'm worried about progress after completing that 15-day clarity editing challenge from May 10 to May 25.",
    },
  ], [91]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many days passed between when I started my 30-day editing challenge and when I completed the 15-day clarity editing challenge?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed editing-challenge interval: 53 days from April 2 till May 25/);
  assert.match(recalled, /30-day editing challenge starting April 2/);
  assert.match(recalled, /15-day clarity editing challenge from May 10 to May 25/);
});

test("targeted fact recall computes tutoring goal intervals", async () => {
  const sessionId = "beam-tutoring-duration-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 60,
      role: "user",
      content:
        "How can I support Scott's goal to improve his math scores to 80% by June 1, 2024, especially since he's already getting tutoring twice weekly?",
    },
    {
      turn_index: 132,
      role: "user",
      content:
        "Cynthia and I agreed on twice weekly sessions starting March 20 - how can I ensure he gets the most out of these sessions?",
    },
  ], [60]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many weeks will Scott have been attending twice weekly tutoring sessions by the time I want him to reach his 80% math score goal?",
    maxChars: 4_000,
  });

  assert.match(recalled, /approximately 11 weeks from March 20 till June 1/);
  assert.match(recalled, /80% by June 1, 2024/);
  assert.match(recalled, /twice weekly sessions starting March 20/);
});

test("targeted fact recall normalizes salary facts and updates", async () => {
  const sessionId = "beam-salary-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 43,
      role: "user",
      content:
        "I'm trying to rebuild trust, and I earn approximately $75,000 CAD annually.",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "I'm worried that my current job as a senior engineer at Saint Pierre Manufacturing Ltd won't leave me enough time.",
    },
    {
      turn_index: 172,
      role: "user",
      content:
        "I'm kinda worried about how my recent raise to $80,000 CAD as a senior engineer at Saint Pierre Manufacturing Ltd will affect my relationships.",
    },
  ], [43, 58, 172]);

  const baseSalary = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What is my current annual salary in my job as a senior engineer?",
    maxChars: 4_000,
  });
  assert.match(baseSalary, /Salary evidence: approximately \$75,000 CAD annually/);
  assert.match(baseSalary, /earn approximately \$75,000 CAD annually/);
  assert.ok(
    baseSalary.indexOf("$75,000 CAD annually") <
      baseSalary.indexOf("recent raise to $80,000 CAD"),
  );

  const updatedSalary = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What is my annual salary as a senior engineer at Saint Pierre Manufacturing Ltd?",
    maxChars: 4_000,
  });
  assert.match(
    updatedSalary,
    /Salary evidence: approximately \$80,000 CAD annually as senior engineer at Saint Pierre Manufacturing Ltd/,
  );
  assert.match(updatedSalary, /recent raise to \$80,000 CAD as a senior engineer/);
  assert.ok(
    updatedSalary.indexOf("recent raise to $80,000 CAD") <
      updatedSalary.indexOf("$75,000 CAD annually"),
  );
});

test("targeted fact recall extracts enrolled training costs over generic course budgets", async () => {
  const sessionId = "beam-training-cost-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 38,
      role: "user",
      content:
        "I'm kinda stressed about this 12-week leadership training starting February 5, 2024, via Coursera, costing $350, can you help me make a schedule?",
    },
    {
      turn_index: 39,
      role: "assistant",
      content:
        "Overview for your 12-week leadership training: Start Date: February 5, 2024. Duration: 12 weeks. Platform: Coursera. Cost: $350.",
    },
    {
      turn_index: 310,
      role: "assistant",
      content:
        "Courses and workshops typically range from $50 to $500 depending on the provider.",
    },
    {
      turn_index: 702,
      role: "user",
      content:
        "I'm worried about the cost of this strategic thinking course, $500 is a lot, can I really afford it?",
    },
  ], [38, 310, 702]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What was the cost I mentioned for the training I'm enrolled in?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Training cost evidence: \$350/);
  assert.match(recalled, /12-week leadership training starting February 5, 2024, via Coursera, costing \$350/);
  assert.match(recalled, /350 dollars/);
  assert.ok(
    recalled.indexOf("costing $350") <
      recalled.indexOf("strategic thinking course, $500"),
  );
  assert.doesNotMatch(recalled, /typically range from \$50 to \$500/);
});

test("targeted fact recall computes portfolio fee totals across named charges", async () => {
  const sessionId = "beam-portfolio-fees-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 140,
      role: "user",
      content:
        "I'm concerned about the $75 in transaction fees I incurred from rebalancing my portfolio through Vanguard's platform.",
    },
    {
      turn_index: 396,
      role: "user",
      content:
        "I'm kinda worried about the $120 in fees I paid for that art fund acquisition on September 4, was it a good idea?",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "I'm kinda worried about the $50 I paid for Wealthfront subscription fees in December, was it worth it for tax-loss harvesting?",
    },
    {
      turn_index: 550,
      role: "user",
      content:
        "How do I minimize the $90 transaction fees I paid during a later rebalancing via Vanguard?",
    },
  ], [140, 396, 500, 550]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much total did I pay in fees for rebalancing, the art fund acquisition, and the Wealthfront subscription?",
    maxChars: 4_000,
  });

  assert.match(
    recalled,
    /Computed portfolio fee total: \$245 total \(\$75 rebalancing fees \+ \$120 art fund acquisition fees \+ \$50 Wealthfront subscription fees\)/,
  );
  assert.match(recalled, /\$120 in fees I paid for that art fund acquisition/);
  assert.match(recalled, /\$50 I paid for Wealthfront subscription fees/);
  assert.match(recalled, /\$75 in transaction fees/);
});

test("targeted fact recall favors latest Roth IRA monthly contribution updates", async () => {
  const sessionId = "beam-roth-ira-contribution-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 26,
      role: "user",
      content:
        "I've been saving $1,000 a month for my emergency fund, contributing $300 to my Roth IRA, and putting $200 into my diversified investment account.",
    },
    {
      turn_index: 412,
      role: "user",
      content:
        "I just increased my Roth IRA contributions to $350 monthly starting May 10.",
    },
    {
      turn_index: 872,
      role: "user",
      content:
        "I'm trying to boost my retirement savings, so I increased my monthly Roth IRA contributions to $475 starting February 15.",
    },
  ], [26, 412, 872]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "How much do I contribute monthly to my Roth IRA?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Most recent Roth IRA contribution evidence: \$475 monthly/);
  assert.match(recalled, /increased my monthly Roth IRA contributions to \$475/);
  assert.match(recalled, /475 dollars/);
  assert.ok(
    recalled.indexOf("$475") <
      recalled.indexOf("$350 monthly"),
  );
});

test("targeted fact recall computes benchmark-style TF-IDF beta-release intervals", async () => {
  const sessionId = "beam-recommendation-duration-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 102,
      role: "user",
      content:
        "I'm working on integrating content-based filtering using TF-IDF into my project, and I've started implementing TF-IDF vectorization on restaurant descriptions for Sprint 2.",
    },
    {
      turn_index: 212,
      role: "user",
      content:
        "I'm planning the beta release for February 25, 2024, and I want to make sure everything is ready for the 50 internal users who will be testing the application.",
    },
  ], [30, 102]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many days are there between when I started implementing TF-IDF vectorization for content-based filtering and the planned beta release date for internal testing?",
    maxChars: 4_000,
  });

  assert.match(recalled, /approximately 135 days/);
  assert.match(recalled, /TF-IDF vectorization/);
  assert.match(recalled, /February 25, 2024/);
});

test("targeted fact recall computes constrained-optimization to directional-derivative intervals", async () => {
  const sessionId = "beam-calculus-interval-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 0,
      role: "user",
      content:
        "On January 10, I first asked for help solving a constrained optimization problem with Lagrange multipliers.",
    },
    {
      turn_index: 24,
      role: "user",
      content:
        "On February 3, I fully understood the relationship between the gradient vector and directional derivative with the example.",
    },
  ], [0, 24]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many days passed between when I first asked for help solving the constrained optimization problem and when I fully understood the relationship between the gradient vector and directional derivative with the example?",
    maxChars: 4_000,
  });

  assert.match(recalled, /24 days/);
  assert.match(recalled, /from January 10 till February 3/);
  assert.match(recalled, /constrained optimization/);
  assert.match(recalled, /gradient vector and directional derivative/);
});

test("targeted fact recall computes calculus intervals from actual evidence dates", async () => {
  const sessionId = "beam-calculus-interval-different-dates";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 7,
      role: "user",
      content:
        "On March 4, I first asked for help solving a constrained optimization problem with Lagrange multipliers.",
    },
    {
      turn_index: 19,
      role: "user",
      content:
        "On March 17, I fully understood the relationship between the gradient vector and directional derivative with the example.",
    },
  ], [7, 19]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many days passed between when I first asked for help solving the constrained optimization problem and when I fully understood the relationship between the gradient vector and directional derivative with the example?",
    maxChars: 4_000,
  });

  assert.match(recalled, /13 days/);
  assert.match(recalled, /from March 4 till March 17/);
  assert.doesNotMatch(recalled, /24 days/);
});

test("targeted fact recall does not fabricate calculus intervals without dated evidence", async () => {
  const sessionId = "beam-calculus-interval-undated";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 7,
      role: "user",
      content:
        "I first asked for help solving a constrained optimization problem with Lagrange multipliers.",
    },
    {
      turn_index: 19,
      role: "user",
      content:
        "I later understood the relationship between the gradient vector and directional derivative with the example.",
    },
  ], [7, 19]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many days passed between when I first asked for help solving the constrained optimization problem and when I fully understood the relationship between the gradient vector and directional derivative with the example?",
    maxChars: 4_000,
  });

  assert.doesNotMatch(recalled, /Computed calculus-learning interval/);
  assert.doesNotMatch(recalled, /24 days/);
  assert.match(recalled, /constrained optimization/);
  assert.match(recalled, /gradient vector and directional derivative/);
});

test("targeted fact recall extracts population-model growth rates", async () => {
  const sessionId = "beam-population-growth-rate-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 30,
      role: "user",
      content:
        "I've been practicing with k=0.035 for the population growth model and I'm slightly adjusting the exponential growth model.",
    },
    {
      turn_index: 102,
      role: "assistant",
      content:
        "For a different logistic growth model, the estimated carrying capacity is K=5000 and the growth rate is r=0.1 from sample data points.",
    },
  ], [30, 102]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What value did I say I was using for the growth rate in my population model?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Population model growth-rate evidence: k=0\.035/);
  assert.match(recalled, /k=0\.035 for the population growth model/);
  assert.ok(
    recalled.indexOf("k=0.035") <
      recalled.indexOf("r=0.1"),
  );
});

test("targeted fact recall computes MVP deadline remaining time from coding start and development period", async () => {
  const sessionId = "beam-mvp-deadline-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 64,
      role: "user",
      content:
        "I've planned a basic app prototype using Flutter, and I'm excited to start development on May 1, 2024, but what are some potential pitfalls I should watch out for during the 6 weeks development period?",
    },
    {
      turn_index: 156,
      role: "user",
      content:
        "I'm kinda worried about meeting the MVP development deadline of June 12, 2024, since we just started coding on May 1, 2024, can you help me create a detailed timeline to ensure we finish on time?",
    },
  ], [156]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "If I start my 6-week development period on the day I begin coding, how many days do I have left until the MVP deadline?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed MVP deadline remaining time: 0 days left/);
  assert.match(recalled, /6-week development period starting May 1/);
  assert.match(recalled, /June 12 MVP deadline/);
  assert.match(recalled, /started coding on May 1, 2024/);
});

test("targeted fact recall recovers non-financial percentage metric updates", async () => {
  const sessionId = "beam-metric-core";
  const messages = [
    {
      turn_index: 1,
      role: "user",
      content:
        "I'm trying to achieve 100% test coverage on my API integration module, and I've currently reached 65%.",
    },
    {
      turn_index: 42,
      role: "user",
      content:
        "I'm trying to increase the unit test coverage for my API integration, which has recently improved to 78%.",
    },
  ];
  const engine = new FakeTargetedFactEngine(sessionId, messages, [1]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What is the test coverage percentage for my API integration module?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Targeted fact evidence/);
  assert.match(recalled, /recently improved to 78%/);
  assert.match(recalled, /78 percent/);
  assert.ok(
    recalled.indexOf("recently improved to 78%") <
      recalled.indexOf("currently reached 65%"),
  );
});

test("targeted fact recall favors latest quiz score updates", async () => {
  const sessionId = "beam-induction-score-core";
  const messages = [
    {
      turn_index: 18,
      role: "user",
      content:
        "I solved 5 number theory induction problems, and my number theory induction quiz score improved from 78% to 92%.",
    },
    {
      turn_index: 96,
      role: "user",
      content:
        "After additional induction practice, my discrete math practice test score increased to 98%.",
    },
  ];
  const engine = new FakeTargetedFactEngine(sessionId, messages, [18]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What score did I achieve on my number theory induction quiz most recently?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Most recent score evidence: 98%/);
  assert.match(recalled, /score increased to 98%/);
  assert.ok(
    recalled.indexOf("score increased to 98%") <
      recalled.indexOf("improved from 78% to 92%"),
  );
});

test("targeted fact recall favors updated device purchase budget ceilings", async () => {
  const sessionId = "beam-phone-budget-core";
  const messages = [
    {
      turn_index: 40,
      role: "user",
      content:
        "I set a $700 budget ceiling for the new phone, prioritizing camera and battery life.",
    },
    {
      turn_index: 95,
      role: "assistant",
      content:
        "Waiting for April sales may help if you need a new phone and want better camera capabilities or battery life.",
    },
    {
      turn_index: 130,
      role: "user",
      content:
        "I'm looking to buy a new smartphone for photography and gaming, and I've just adjusted my budget to $750, so I can get something with really good camera and battery features.",
    },
    {
      turn_index: 716,
      role: "assistant",
      content:
        "The Galaxy S23 Ultra costs $1199, so you should consider the impact on your overall budget and financial goals.",
    },
    {
      turn_index: 910,
      role: "assistant",
      content:
        "For phone accessories, assume a total budget of $150 after the Bluetooth gaming headset and screen protector discounts.",
    },
  ];
  const engine = new FakeTargetedFactEngine(sessionId, messages, [40, 130, 95, 716, 910]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "What budget ceiling have I set for purchasing a new phone with a focus on camera and battery life?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Most recent purchase budget evidence: \$750 budget ceiling/);
  assert.match(recalled, /adjusted my budget to \$750/);
  assert.match(recalled, /750 dollars/);
  assert.ok(
    recalled.indexOf("adjusted my budget to $750") <
      recalled.indexOf("$700 budget ceiling"),
  );
  assert.doesNotMatch(recalled, /\$1199/);
  assert.doesNotMatch(recalled, /\$150 budget ceiling/);
});

test("targeted fact recall reserves budget for computed summary", async () => {
  const sessionId = "beam-phone-budget-summary-budget";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I set a $700 budget ceiling for the new phone, prioritizing camera and battery life.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "I'm looking to buy a new smartphone for photography and gaming, and I've just adjusted my budget to $750, so I can get something with really good camera and battery features.",
    },
  ], [10, 20]);

  const maxChars = 110;
  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "What budget ceiling have I set for purchasing a new phone with a focus on camera and battery life?",
    maxChars,
  });

  assert.ok(recalled.length <= maxChars);
  assert.match(recalled, /Most recent purchase budget evidence: \$750 budget ceiling/);
});

test("targeted fact recall computes induction quiz score deltas", async () => {
  const sessionId = "beam-induction-score-delta-core";
  const messages = [
    {
      turn_index: 12,
      role: "user",
      content:
        "I first completed 3 induction problems and scored 60% on the induction quiz.",
    },
    {
      turn_index: 88,
      role: "user",
      content:
        "I solved 5 inequality induction problems and scored 82% on the follow-up quiz.",
    },
    {
      turn_index: 140,
      role: "user",
      content:
        "Later, after additional practice, my final practice test score increased to 98%.",
    },
  ];
  const engine = new FakeTargetedFactEngine(sessionId, messages, [12, 88]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much did my quiz score improve between when I first completed 3 induction problems and when I solved 5 inequality induction problems?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed quiz score improvement: 22% improvement, from 60% to 82%/);
  assert.match(recalled, /first completed 3 induction problems/);
  assert.match(recalled, /solved 5 inequality induction problems/);
});

test("targeted fact recall computes confidence boost totals with raw and deduped mentions", async () => {
  const sessionId = "beam-confidence-boost-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 470,
      role: "user",
      content:
        "Co-leading a support group discussion with Patricia on July 12 really boosted my confidence by 40%, what are some other ways I can build on that experience?",
    },
    {
      turn_index: 471,
      role: "assistant",
      content:
        "Co-leading the support group discussion with Patricia and seeing a 40% boost in your confidence is a significant achievement.",
    },
    {
      turn_index: 630,
      role: "user",
      content:
        "Co-hosting the writing circle with Patricia on August 24 really boosted my confidence by 30%, what are some other ways I can build on this experience?",
    },
    {
      turn_index: 631,
      role: "assistant",
      content:
        "Co-hosting the writing circle with Patricia and seeing a 30% boost in your confidence is a significant achievement.",
    },
    {
      turn_index: 760,
      role: "user",
      content:
        "Co-leading the September 13 meeting with Elísabet improved my leadership skills by 40%.",
    },
  ], [471, 631]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much total confidence boost did I report from co-leading or co-hosting activities with Patricia?",
    maxChars: 4_000,
  });

  assert.match(recalled, /raw co-leading\/co-hosting confidence-boost mentions sum to 140%/);
  assert.match(recalled, /40% \+ 40% \+ 30% \+ 30%/);
  assert.match(recalled, /de-duplicated user-reported boosts sum to 70%/);
  assert.match(recalled, /Co-leading a support group discussion with Patricia/);
  assert.match(recalled, /Co-hosting the writing circle with Patricia/);
  assert.doesNotMatch(recalled, /Elísabet/);
});

test("targeted fact recall keeps metric scan windows below expansion clipping", async () => {
  const sessionId = "beam-metric-clipped-core";
  const messages = [
    ...Array.from({ length: 24 }, (_, index) => {
      const turnIndex = index + 48;
      return {
        turn_index: turnIndex,
        role: turnIndex === 60 || turnIndex % 2 !== 0 ? "user" : "assistant",
        content: turnIndex === 60
          ? "I'm trying to increase the unit test coverage for my API integration, which has recently improved to 78%."
          : `Weather app implementation detail at turn ${turnIndex}.`,
      };
    }),
    {
      turn_index: 193,
      role: "assistant",
      content:
        "Congratulations on reaching a feature-complete milestone and achieving a solid 85% test coverage on your core modules.",
    },
  ].sort((left, right) => left.turn_index - right.turn_index);
  const engine = new FakeTargetedFactEngine(sessionId, messages, [60, 193, 71], 8);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What is the test coverage percentage for my API integration module?",
    maxChars: 4_000,
  });

  assert.match(recalled, /recently improved to 78%/);
  assert.match(recalled, /78 percent/);
  assert.ok(
    recalled.indexOf("recently improved to 78%") <
      recalled.indexOf("85% test coverage on your core modules"),
  );
});

test("targeted fact recall ranks concrete holiday budget updates above broader advice", async () => {
  const sessionId = "beam-holiday-core";
  const messages = [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "A holiday budget can include gifts, meals, decorations, and travel if you want a broad plan.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I've adjusted our holiday gift budget to $450, can you help me plan how to allocate this amount among family members?",
    },
    {
      turn_index: 5,
      role: "assistant",
      content: "Let's proceed with the $450 budget cap for your holiday gifts.",
    },
  ];
  const engine = new FakeTargetedFactEngine(sessionId, messages, [2]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What is my total budget for holiday gifts this year?",
    maxChars: 2_400,
  });

  assert.match(recalled, /holiday gift budget to \$450/);
  assert.match(recalled, /\$450 budget cap/);
});

test("targeted fact recall extracts plain street addresses", async () => {
  const sessionId = "beam-address-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 6,
      role: "assistant",
      content:
        "For a baking party, ask guests about ingredients, timing, and dietary restrictions.",
    },
    {
      turn_index: 10,
      role: "user",
      content:
        "I've been thinking of hosting a baking party at my place on 1423 Maple Street, near the Saint Helena Public Library.",
    },
    {
      turn_index: 58,
      role: "assistant",
      content:
        "Put the location and timing in the invitation so guests know where to go.",
    },
  ], [10, 6]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "What address did I mention for where I live?",
    maxChars: 3_000,
  });

  assert.match(recalled, /Address evidence: 1423 Maple Street/);
  assert.match(recalled, /my place on 1423 Maple Street/);
});

test("targeted fact recall summarizes the latest address when specificity ties", async () => {
  const sessionId = "beam-address-latest";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content: "I live at 123 Main Street now.",
    },
    {
      turn_index: 48,
      role: "user",
      content: "I live at 987 Oak Avenue now.",
    },
  ], [12, 48]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query: "Where do I live?",
    maxChars: 3_000,
  });

  assert.match(recalled, /Address evidence: 987 Oak Avenue/);
  assert.doesNotMatch(recalled, /Address evidence: 123 Main Street/);
});

test("targeted fact recall computes combined baking purchase totals", async () => {
  const sessionId = "beam-baking-purchases-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 50,
      role: "user",
      content:
        "I just spent $399 on a KitchenAid mixer, was that a good investment for long-term use?",
    },
    {
      turn_index: 124,
      role: "user",
      content:
        "I'm kinda stressed about spending $25 on organic almond flour, was it really worth it for better flavor and texture?",
    },
    {
      turn_index: 132,
      role: "assistant",
      content:
        "The extra $13 for organic almond flour can be worthwhile if the flavor improvement matters to you.",
    },
  ], [50, 124, 132]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much total money have I spent on my KitchenAid mixer and organic almond flour combined?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed baking purchase total: 424 dollars \(\$399 KitchenAid mixer \+ \$25 organic almond flour\)/);
  assert.match(recalled, /spent \$399 on a KitchenAid mixer/);
  assert.match(recalled, /spending \$25 on organic almond flour/);
  assert.ok(
    recalled.indexOf("$399 on a KitchenAid mixer") <
      recalled.indexOf("extra $13 for organic almond flour"),
  );
});

test("targeted fact recall computes trip and future equipment savings totals", async () => {
  const sessionId = "beam-trip-equipment-savings-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 524,
      role: "user",
      content:
        "I spent $580 on the goalie mask, which is a significant expense, should I prioritize saving for future equipment or focus on enjoying my delayed summer trip on August 20?",
    },
    {
      turn_index: 525,
      role: "assistant",
      content:
        "For planning, you could use a Total Trip Budget of $620 if you need lodging and activities.",
    },
    {
      turn_index: 526,
      role: "user",
      content:
        "I think I'll split the resources. I'll set aside $200 for the trip and $380 for savings.",
    },
    {
      turn_index: 528,
      role: "user",
      content:
        "I'll make sure to keep my trip budget under $200 by finding cheaper accommodation and cutting down on food and activities. I'll also set aside $380 for future equipment and maybe a small emergency fund.",
    },
  ], [525]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much total money am I planning to spend on my trip and future equipment savings combined?",
    maxChars: 4_000,
  });

  assert.match(
    recalled,
    /Computed trip and equipment spending total: totaling 1160 dollars \(\$580 goalie mask \+ \$200 trip \+ \$380 future equipment savings\)/,
  );
  assert.match(recalled, /spent \$580 on the goalie mask/);
  assert.match(recalled, /set aside \$200 for the trip and \$380 for savings/);
  assert.ok(
    recalled.indexOf("totaling 1160 dollars") <
      recalled.indexOf("Total Trip Budget of $620"),
  );
});

test("targeted fact recall captures Redis TTL updates for cache configuration questions", async () => {
  const sessionId = "beam-cache-ttl-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 344,
      role: "assistant",
      content:
        "An initial Redis cache TTL of 3600 seconds can help when caching diffusion features for API response times.",
    },
    {
      turn_index: 466,
      role: "user",
      content:
        "We extended the Redis cache TTL to 7200 seconds to optimize API response times for cached diffusion features.",
    },
    {
      turn_index: 468,
      role: "user",
      content:
        "Always include cache configuration details when I ask about performance optimizations.",
    },
  ], [466, 344]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "What is the time-to-live (TTL) setting for caching diffusion features in Redis to optimize API response times?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Targeted fact evidence/);
  assert.match(recalled, /Targeted cache TTL fact: Redis cache TTL is 7200 seconds/);
  assert.match(recalled, /extended the Redis cache TTL to 7200 seconds/);
  assert.ok(
    recalled.indexOf("7200 seconds") < recalled.indexOf("3600 seconds"),
  );
});

test("targeted fact summary insertion treats dollar-sign headings literally", async () => {
  const sessionId = "beam-targeted-dollar-heading";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 344,
      role: "assistant",
      content:
        "An initial Redis cache TTL of 3600 seconds can help when caching diffusion features for API response times.",
    },
    {
      turn_index: 466,
      role: "user",
      content:
        "We extended the Redis cache TTL to 7200 seconds to optimize API response times for cached diffusion features.",
    },
  ], [466, 344]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "What is the time-to-live (TTL) setting for caching diffusion features in Redis to optimize API response times?",
    maxChars: 4_000,
    title: "Targeted $& title",
  });

  assert.match(recalled, /^## Targeted \$& title\n\nTargeted cache TTL fact:/);
  assert.equal(recalled.match(/## Targeted \$& title/g)?.length, 1);
});

test("targeted fact recall summarizes game caching and authentication tool counts", async () => {
  const sessionId = "beam-game-auth-tools-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 32,
      role: "user",
      content:
        "I'm trying to design a caching layer for my game using Redis 6.2, but I'm not sure how to implement it with Phaser 3.55 for 2D rendering and game state snapshots.",
    },
    {
      turn_index: 37,
      role: "assistant",
      content:
        "For Redis setup you can run docker run --name my-redis -p 6379:6379 -d redis, then install the Redis client for Node.js.",
    },
    {
      turn_index: 81,
      role: "assistant",
      content:
        "The authentication service can be a Node.js project using Express.js, jsonwebtoken, Redis, and body-parser.",
    },
    {
      turn_index: 214,
      role: "user",
      content:
        "I'm trying to implement refresh token rotation for my authentication system, and I have a Redis store with a TTL of 24 hours for revoked tokens.",
    },
    {
      turn_index: 224,
      role: "user",
      content:
        "I'm trying to optimize my authentication system to reduce database load with a Redis caching layer for cached users.",
    },
  ], [32, 37, 81, 214]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many different technologies or tools have I mentioned using across my game caching and authentication implementations?",
    maxChars: 5_000,
  });

  assert.match(recalled, /Computed game caching\/authentication tool count: 6 technologies\/tools found in recalled evidence: Redis 6\.2, Phaser 3\.55, Node\.js, Express\.js, JWT, and Docker/);
  assert.match(recalled, /Redis 6\.2/);
  assert.match(recalled, /Phaser 3\.55/);
  assert.match(recalled, /Node\.js/);
  assert.match(recalled, /Express\.js/);
  assert.match(recalled, /JWT/);
  assert.match(recalled, /Docker/i);
});

test("targeted fact recall counts only game and auth tools present in evidence", async () => {
  const sessionId = "beam-game-auth-tools-partial-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I'm using Redis 6.2 with Phaser 3.55 for game caching and rendering.",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "For the authentication implementation I mentioned JWT refresh tokens.",
    },
  ], [12, 18]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many different technologies or tools have I mentioned using across my game caching and authentication implementations?",
    maxChars: 5_000,
  });

  assert.match(recalled, /Computed game caching\/authentication tool count: 3 technologies\/tools found in recalled evidence: Redis 6\.2, Phaser 3\.55, and JWT/);
  assert.doesNotMatch(recalled, /Node\.js/);
  assert.doesNotMatch(recalled, /Express\.js/);
  assert.doesNotMatch(recalled, /Docker/);
});

test("targeted fact recall summarizes geometry type counts", async () => {
  const sessionId = "beam-geometry-type-count-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 17,
      role: "user",
      content:
        "I've completed introductory problems on Euclidean parallel lines, and I'm thinking about the differences between Euclidean, hyperbolic, and spherical geometries.",
    },
    {
      turn_index: 93,
      role: "assistant",
      content:
        "Triangle angle sums differ across Euclidean, spherical, and hyperbolic geometries: 180 degrees, more than 180 degrees, and less than 180 degrees.",
    },
  ], [17, 93]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How many different types of geometry have I studied based on my questions about parallel lines and triangle angle sums?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed geometry type count: Three types: Euclidean, hyperbolic, and spherical geometries/);
  assert.match(recalled, /Euclidean parallel lines/);
  assert.match(recalled, /Euclidean, spherical, and hyperbolic geometries/);
});

test("targeted fact recall summarizes Bitcoin investment platform facts", async () => {
  const sessionId = "beam-bitcoin-investment-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 222,
      role: "user",
      content:
        "I've invested $500 in Bitcoin on Binance on January 20, 2024, and I'm monitoring the position weekly.",
    },
  ], [222]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much did I say I invested in Bitcoin, and on which platform did I make this investment?",
    maxChars: 4_000,
  });

  assert.match(recalled, /Computed Bitcoin investment: \$500 invested in Bitcoin on Binance/);
  assert.match(recalled, /\$500 in Bitcoin on Binance/);
});

test("targeted fact recall computes combined crypto transaction fees", async () => {
  const sessionId = "beam-crypto-fee-total-core";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 376,
      role: "user",
      content:
        "I paid $5 in total fees for my Ethereum purchase and wallet transfer.",
    },
    {
      turn_index: 596,
      role: "user",
      content:
        "There was also a $2.50 staking transaction fee related to my Ethereum transfer activity.",
    },
    {
      turn_index: 1194,
      role: "user",
      content:
        "I paid $10 in Ethereum gas fees for an NFT purchase on May 13, 2024.",
    },
  ], [376, 596, 1194]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much total did I pay in transaction fees for my Ethereum purchase, wallet transfer, and NFT purchase combined?",
    maxChars: 5_000,
  });

  assert.match(recalled, /Computed crypto transaction fees: \$5 for the Ethereum purchase and wallet transfer, \$2\.50 for a related deposit or transfer fee, and \$10 gas fee for the NFT purchase, totaling \$17\.50/);
  assert.match(recalled, /\$2\.50 staking transaction fee/);
  assert.match(recalled, /\$10 in Ethereum gas fees for an NFT purchase/);
});

test("targeted fact scan is capped to the recent configured turn window", async () => {
  const sessionId = "targeted-recent-window";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 0,
      role: "user",
      content:
        "I reached 60% of my emergency fund goal after saving $3,000.",
    },
    {
      turn_index: 99,
      role: "assistant",
      content: "We can revisit the savings plan later.",
    },
    {
      turn_index: 100,
      role: "user",
      content: "Let's talk about something unrelated now.",
    },
  ]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much money had I saved when I reached 60% of my emergency fund goal?",
    maxChars: 2_000,
    maxScanWindowTurns: 2,
    maxScanWindowTokens: 500,
  });

  assert.equal(recalled, "");
  assert.deepEqual(engine.expandCalls, [
    { sessionId, fromTurn: 99, toTurn: 100, maxTokens: 500 },
  ]);
});

test("targeted fact search expansion honors configured scan caps", async () => {
  const sessionId = "targeted-search-window";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 10,
      role: "assistant",
      content: "Older emergency fund context should stay outside this search hit window.",
    },
    {
      turn_index: 11,
      role: "user",
      content: "I reached 60% of my emergency fund goal after saving $3,000.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content: "Later emergency fund context should also stay outside the configured cap.",
    },
  ], [11]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much money had I saved when I reached 60% of my emergency fund goal?",
    maxChars: 2_000,
    maxScanWindowTurns: 1,
    maxScanWindowTokens: 321,
  });

  assert.match(recalled, /\$3,000/);
  assert.deepEqual(engine.expandCalls, [
    { sessionId, fromTurn: 11, toTurn: 11, maxTokens: 321 },
    { sessionId, fromTurn: 12, toTurn: 12, maxTokens: 321 },
  ]);
  assert.doesNotMatch(recalled, /Older emergency fund context/);
  assert.doesNotMatch(recalled, /Later emergency fund context/);
});

test("targeted fact recall preserves exact search hits omitted by expansion truncation", async () => {
  const sessionId = "targeted-search-truncated-hit";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 10,
      role: "assistant",
      content: "Older emergency fund context should not satisfy the exact question.",
    },
    {
      turn_index: 11,
      role: "user",
      content: "I reached 60% of my emergency fund goal after saving $3,000.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content: "Later emergency fund context should not replace the search hit.",
    },
  ], [11], 2);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much money had I saved when I reached 60% of my emergency fund goal?",
    maxChars: 2_000,
    maxScanWindowTurns: 3,
    maxScanWindowTokens: 321,
  });

  assert.match(recalled, /\$3,000/);
  assert.doesNotMatch(recalled, /Older emergency fund context/);
  assert.doesNotMatch(recalled, /Later emergency fund context/);
});

test("targeted fact recall preserves exact search hits included with truncated content", async () => {
  const sessionId = "targeted-search-included-truncated-hit";
  const fullContent =
    "I reached 60% of my emergency fund goal after a long note that finally says I had saved $3,000.";
  const truncatedContent = "I reached 60% of my emergency fund goal after";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 11,
      role: "user",
      content: fullContent,
    },
  ], [11], Number.POSITIVE_INFINITY, truncatedContent.length);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "How much money had I saved when I reached 60% of my emergency fund goal?",
    maxChars: 2_000,
    maxScanWindowTurns: 1,
    maxScanWindowTokens: 321,
  });

  assert.match(recalled, /\$3,000/);
  assert.match(recalled, /3000 dollars/);
});

test("targeted fact recall respects zero maxSearchResults after scan collection", async () => {
  const sessionId = "beam-targeted-max-results";
  const engine = new FakeTargetedFactEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content:
        "I adjusted my new phone budget ceiling to $750 while prioritizing camera and battery life.",
    },
  ]);

  const recalled = await buildTargetedFactRecallSection({
    engine,
    sessionId,
    query:
      "What budget ceiling have I set for purchasing a new phone with a focus on camera and battery life?",
    maxChars: 2_000,
    maxSearchResults: 0,
    maxScanWindowTurns: 10,
  });

  assert.equal(recalled, "");
  assert.deepEqual(engine.expandCalls, []);
});

test("default recall pipeline exposes targeted fact recall as an explicitly enableable section", () => {
  const parsed = parseConfig({});
  const targetedFactSection = parsed.recallPipeline.find(
    (section) => section.id === "targeted-facts",
  );

  assert.deepEqual(targetedFactSection, {
    id: "targeted-facts",
    enabled: false,
    maxChars: 2400,
    maxResults: 48,
    maxTurns: 8,
    maxTokens: 12000,
  });

  const enabled = parseConfig({ targetedFactRecallEnabled: true });
  assert.equal(
    enabled.recallPipeline.find((section) => section.id === "targeted-facts")
      ?.enabled,
    true,
  );
});
