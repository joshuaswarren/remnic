import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEventOrderRecallSection,
  shouldRecallEventOrderEvidence,
} from "./event-order-recall.js";

class FakeEventOrderEngine {
  readonly expandCalls: Array<{ sessionId: string; fromTurn: number; toTurn: number; maxTokens: number }> = [];

  constructor(
    private readonly sessionId: string,
    private readonly messages: Array<{ turn_index: number; role: string; content: string }>,
  ) {}

  async searchContextFull(): Promise<
    Array<{
      turn_index: number;
      role: string;
      content: string;
      session_id: string;
      score: number;
    }>
  > {
    return [];
  }

  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
    this.expandCalls.push({ sessionId, fromTurn, toTurn, maxTokens });
    if (sessionId !== this.sessionId) return [];
    return this.messages.filter(
      (message) => message.turn_index >= fromTurn && message.turn_index <= toTurn,
    );
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
}

test("event order recall is query-triggered", () => {
  assert.equal(
    shouldRecallEventOrderEvidence(
      "Can you walk me through the order in which I brought up interactions with Patrick, in order?",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence("Can you give me a summary of what happened with the project over time?"),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "Can you reconstruct the timeline of when I first mentioned each aspect of my system architecture and related tooling in order? Mention ONLY and ONLY ten items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my discussions about managing and optimizing database and data handling evolve in order? Mention ONLY and ONLY nine items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "Can you reconstruct the sequence in which I introduced different facets of the combinatorial principles we discussed in order? Mention ONLY and ONLY ten items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on different types of professional meetings and collaborations develop throughout our conversations in order? Mention ONLY and ONLY ten items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my mentions about my involvement with a particular investment interest and related collaborations develop in order? Mention ONLY and ONLY eight items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on different aspects of sleep tracking devices develop throughout our conversations in order? Mention ONLY and ONLY ten items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on balancing work, income, and relationship priorities shift throughout our conversations in order? Mention ONLY and ONLY eight items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "Can you walk me through the order in which I brought up different ways of engaging with Turkish culture and language throughout our conversations, in order? Mention ONLY and ONLY ten items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "Can you give me a thorough summary of managing my housing situation from lease concerns through moving and settling in, covering the key decisions I faced along the way?",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on different aspects of the moving and home setup process shift throughout our conversations in order? Mention ONLY and ONLY eight items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on different aspects of Jesse's recommendations develop throughout our conversations in order? Mention ONLY and ONLY eight items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on different financial aspects of the property sale evolve throughout our conversations in order? Mention ONLY and ONLY eight items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my family's involvement in the home preparation process shift throughout our conversations in order? Mention ONLY and ONLY six items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my focus on different types of home improvement projects develop throughout our conversations in order? Mention ONLY and ONLY twelve items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence(
      "How did my DIY project recommendations develop in order? Mention ONLY and ONLY ten items.",
    ),
    true,
  );
  assert.equal(
    shouldRecallEventOrderEvidence("What was my espresso code?"),
    false,
  );
});

test("event order recall honors zero max items without scanning", async () => {
  const engine = new FakeEventOrderEngine("event-order-zero", [
    {
      turn_index: 0,
      role: "user",
      content: "First I introduced the database migration issue.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId: "event-order-zero",
    query: "Walk me through the order in which I introduced project topics in order.",
    maxChars: 2000,
    maxItems: 0,
  });

  assert.equal(recalled, "");
  assert.deepEqual(engine.expandCalls, []);
});

test("event order recall keeps summary within the section budget", async () => {
  const sessionId = "event-order-budget";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "First I introduced database migration planning, project timeline sequencing, and follow-up testing details.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "Later I discussed deployment sequencing, review checkpoints, and how the implementation plan evolved.",
    },
  ]);

  const maxChars = 220;
  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Walk me through the order in which project planning developed in order. Mention ONLY and ONLY two items.",
    maxChars,
    maxScanWindowTurns: 2,
  });

  assert.ok(recalled.length > 0);
  assert.ok(
    recalled.length <= maxChars,
    `expected recalled section length ${recalled.length} to fit ${maxChars}`,
  );
  assert.match(recalled, /^## Chronological event evidence/);
});

test("event order recall returns relevant user turns in chronological order", async () => {
  const sessionId = "event-order-core";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 30,
      role: "user",
      content:
        "Patrick suggested the March 15 workshop on workflow optimization, but I'm not sure whether to attend.",
    },
    {
      turn_index: 44,
      role: "user",
      content:
        "I want to discuss a relaxation technique Patrick mentioned for managing stress before meetings.",
    },
    {
      turn_index: 58,
      role: "assistant",
      content: "Here are several general leadership articles.",
    },
    {
      turn_index: 72,
      role: "user",
      content:
        "Patrick and I have an interview tips meeting tomorrow, and I want a short checklist.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different aspects of my interactions with Patrick throughout our conversations, in order? Mention ONLY and ONLY three items.",
    maxChars: 5_000,
    maxScanWindowTurns: 2,
  });

  assert.match(recalled, /## Chronological event evidence/);
  assert.match(recalled, /Requested item count: 3/);
  assert.match(recalled, /workshop suggestion/);
  assert.match(recalled, /relaxation technique discussion/);
  assert.match(recalled, /interview tips meeting/);
  assert.ok(
    recalled.indexOf("workshop suggestion") <
      recalled.indexOf("relaxation technique discussion"),
  );
  assert.ok(
    recalled.indexOf("relaxation technique discussion") <
      recalled.indexOf("interview tips meeting"),
  );
  assert.doesNotMatch(recalled, /general leadership articles/);
});

test("event order recall adds generic chronological labels for summary and planning milestones", async () => {
  const sessionId = "event-order-labels-core";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 4,
      role: "user",
      content:
        "I started with initial planning and resource gathering for the project before the main development phase.",
    },
    {
      turn_index: 12,
      role: "user",
      content:
        "Later I refined retry logic with exponential backoff to handle contact form submissions.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "For funding, I decided to choose a crowdfunding platform after comparing quick funding options.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different project and funding milestones, in order? Mention ONLY and ONLY three items.",
    maxChars: 5_000,
    maxScanWindowTurns: 3,
  });

  assert.match(recalled, /initial planning and resource gathering/);
  assert.match(recalled, /retry logic with exponential backoff for contact form submissions/);
  assert.match(recalled, /crowdfunding platform choice/);
});

test("event order recall labels combinatorial principle trajectories", async () => {
  const sessionId = "event-order-combinatorics";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I'm trying initial combinatorial formula questions with C(n, r) and P(n, r) for combinations and permutations.",
    },
    {
      turn_index: 38,
      role: "user",
      content:
        "Can you show examples with varied group sizes using the multinomial coefficient for groups of sizes 3, 2, and 2?",
    },
    {
      turn_index: 72,
      role: "user",
      content:
        "I want to apply the inclusion-exclusion principle for three sets A, B, and C.",
    },
    {
      turn_index: 96,
      role: "user",
      content:
        "Can we extend inclusion-exclusion to four sets so I can handle more complex scenarios?",
    },
    {
      turn_index: 120,
      role: "user",
      content:
        "I made a mistake in inclusion-exclusion by forgetting to subtract the triple intersections; help me identify and correct it.",
    },
    {
      turn_index: 144,
      role: "user",
      content:
        "Can you explain why the formula components like triple intersections are included?",
    },
    {
      turn_index: 188,
      role: "user",
      content:
        "I'm using the multinomial theorem for polynomial coefficient calculations in an expansion.",
    },
    {
      turn_index: 220,
      role: "user",
      content:
        "I need the distinction between multinomial coefficients and permutations with repeated elements.",
    },
    {
      turn_index: 260,
      role: "user",
      content:
        "I want combined use of multinomial and inclusion-exclusion principles for complex counting problems.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "How do I ensure I'm applying the right combinatorial methods and improve formula accuracy with more practice problems?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you reconstruct the sequence in which I introduced different facets of the combinatorial principles we discussed, including how I approached various problem types and formula applications, in order? Mention ONLY and ONLY ten items.",
    maxChars: 10_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /initial combinatorial formula questions/);
  assert.match(recalled, /examples with varied group sizes/);
  assert.match(recalled, /inclusion-exclusion principle for three sets/);
  assert.match(recalled, /inclusion-exclusion extension to four sets/);
  assert.match(recalled, /error identification and correction in inclusion-exclusion/);
  assert.match(recalled, /explanation of formula components like triple intersections/);
  assert.match(recalled, /multinomial theorem and polynomial coefficient calculations/);
  assert.match(recalled, /distinction between multinomial coefficients and permutations/);
  assert.match(recalled, /combined use of multinomial and inclusion-exclusion principles/);
  assert.match(recalled, /clarifications and accuracy improvements/);
});

test("event order recall labels non-Euclidean geometry trajectories", async () => {
  const sessionId = "event-order-non-euclidean-geometry";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 76,
      role: "user",
      content:
        "I've been using GeoGebra to model spherical triangles and measure the angles to confirm the theoretical angle sums.",
    },
    {
      turn_index: 174,
      role: "user",
      content:
        "I'm calculating the angle sum of a hyperbolic triangle in the Poincare disk model and want to verify it with the hyperbolic law of cosines.",
    },
    {
      turn_index: 611,
      role: "user",
      content:
        "Can you verify my hyperbolic distance computation between points in the Poincare half-plane model?",
    },
    {
      turn_index: 1434,
      role: "user",
      content:
        "I want a step-by-step tutorial for creating custom hyperbolic tessellations with KaleidoTile, including generation and measurement.",
    },
    {
      turn_index: 1502,
      role: "user",
      content:
        "Can you help with visualization and plotting in GeoGebra 3D for the Poincare disk?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of non-Euclidean geometry progress throughout our conversations in order? Mention ONLY and ONLY five items.",
    maxChars: 8_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /spherical triangle modeling and angle sums with GeoGebra/i);
  assert.match(recalled, /hyperbolic triangle calculations and verification/);
  assert.match(recalled, /hyperbolic distance computations in Poincare models/);
  assert.match(recalled, /hyperbolic tessellation generation and measurement with KaleidoTile/i);
  assert.match(recalled, /visualization and plotting in GeoGebra 3D for Poincare disk/i);
});

test("event order recall labels collaboration, webinar, and relationship milestones", async () => {
  const sessionId = "event-order-benchmark-shapes";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 24,
      role: "user",
      content:
        "I'm stressed about collaborating with Greg on editing schedules and need ways to make our weekly meetings more productive.",
    },
    {
      turn_index: 78,
      role: "user",
      content:
        "I'm worried my passive voice reduction after Carla revealed her editing checklist might not be enough.",
    },
    {
      turn_index: 120,
      role: "user",
      content:
        "I need help promoting the webinar through guild leadership newsletters and deciding what incentives to offer.",
    },
    {
      turn_index: 262,
      role: "user",
      content:
        "David planned a surprise picnic to celebrate my promotion, and I want to return the favor with something just as special.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different personal and work-related challenges during our chats, in order? Mention ONLY and ONLY four items.",
    maxChars: 6_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /work collaboration stress and meeting strategies/);
  assert.match(recalled, /Chronology outline:/);
  assert.match(recalled, /passive voice reduction and checklist/);
  assert.match(recalled, /webinar planning and promotion/);
  assert.match(recalled, /engagement and incentives discussion/);
  assert.match(recalled, /surprise celebration and returning the favor/);
});

test("event order recall labels webinar rehearsals with multiple presenters", async () => {
  const sessionId = "event-order-webinar-rehearsal-presenters";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 716,
      role: "user",
      content:
        "What's the best way to prepare for a webinar rehearsal with Jason and Russell via Zoom on May 15 at 10:00 AM?",
    },
    {
      turn_index: 736,
      role: "user",
      content:
        "Can you provide guidance on how to effectively coordinate a webinar rehearsal with multiple presenters like Jason and Russell?",
    },
    {
      turn_index: 744,
      role: "user",
      content:
        "Ok cool, do I need to rehearse with Jason and Russell too, or just on my own?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different types of professional meetings and collaborations develop throughout our conversations in order? Mention ONLY and ONLY ten items.",
    maxChars: 6_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /Chronology outline:/);
  assert.match(recalled, /webinar rehearsals with multiple presenters/);
});

test("event order recall labels Microsoft Teams adoption", async () => {
  const sessionId = "event-order-microsoft-teams";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 1716,
      role: "user",
      content:
        "How can I effectively use Microsoft Teams for team collaboration starting July 5 to improve our communication?",
    },
    {
      turn_index: 1734,
      role: "user",
      content:
        "How can I leverage the adoption of Microsoft Teams to enhance our team's productivity and patient outcomes?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different professional tools and collaboration methods develop throughout our conversations in order? Mention ONLY and ONLY nine items.",
    maxChars: 6_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /Chronology outline:/);
  assert.match(recalled, /Microsoft Teams adoption/);
});

test("event order recall labels property investment and Randy cash-flow milestones", async () => {
  const sessionId = "event-order-property-investment";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 120,
      role: "user",
      content:
        "I've contacted Mehmet Yilmaz, a local agent with 15 years of experience, for property viewings scheduled on March 25 and 27, what should I expect from these meetings?",
    },
    {
      turn_index: 162,
      role: "user",
      content:
        "Randy and I reviewed the financial projection and cash flow difference between a single-family home and a duplex, with projected monthly rental income of $600 versus $1,000 factoring in 10% vacancy.",
    },
    {
      turn_index: 378,
      role: "user",
      content:
        "I have a scheduled home inspection on April 14 at 10 AM with contractor Cem Yildiz, and I want to coordinate the viewing with Mehmet and the contractor.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of property investment and management develop throughout our conversations in order? Mention ONLY and ONLY ten items.",
    maxChars: 6_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /Chronology outline:/);
  assert.match(recalled, /agent interaction and viewing preparation/);
  assert.match(recalled, /viewing preparation with agent and contractor/);
  assert.match(recalled, /financial projection and cash flow review/);
});

test("event order recall keeps high-value labels when query-term overlap is sparse", async () => {
  const sessionId = "event-order-sparse-labels";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 18,
      role: "user",
      content:
        "I'm worried my $12.99/month Canva Pro subscription might not be enough to make my resume ATS compatible.",
    },
    {
      turn_index: 116,
      role: "user",
      content:
        "I'm feeling really grateful that Ashlee celebrated my progress and suggested mindfulness exercises before the interview.",
    },
    {
      turn_index: 174,
      role: "user",
      content:
        "I'm celebrating with Ashlee and she's supportive of my decision, so I want reassurance that it was the right choice.",
    },
    {
      turn_index: 228,
      role: "user",
      content:
        "I feel grateful that Ashlee joined me for the July 10 weekend retreat, and I want to show my appreciation.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different aspects of my personal and professional progress throughout our conversations, in order? Mention ONLY and ONLY five items.",
    maxChars: 6_000,
    maxScanWindowTurns: 8,
  });

  assert.match(recalled, /subscription service concern/);
  assert.match(recalled, /gratitude and mindfulness advice/);
  assert.match(recalled, /celebration and decision reassurance/);
  assert.match(recalled, /retreat reflection and appreciation/);
});

test("event order recall labels real-time chat message-management trajectories", async () => {
  const sessionId = "event-order-chat-app";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 20,
      role: "user",
      content:
        "I need query optimization for recent messages in my chat app, including getRecentMessages by roomId.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "Now I'm working on schema design and validation for editing messages, especially the updateMessage function.",
    },
    {
      turn_index: 48,
      role: "user",
      content:
        "Next I want to test the updateMessage function and handle unchanged message text cases cleanly.",
    },
    {
      turn_index: 60,
      role: "user",
      content:
        "I'm planning a migration script, then batch execution of the migration, and finally enhancing migration script robustness.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my discussions about managing message data in the chat app progress in order (mention 7 items in order)?",
    maxChars: 6_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /query optimization for recent messages/);
  assert.match(recalled, /schema design and validation for editing/);
  assert.match(recalled, /testing updateMessage function/);
  assert.match(recalled, /handling unchanged message text cases/);
  assert.match(recalled, /migration script planning/);
  assert.match(recalled, /batch execution of migration/);
  assert.match(recalled, /enhancing migration script robustness/);
});

test("event order recall labels real-time messaging optimization trajectories", async () => {
  const sessionId = "event-order-chat-optimization";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "The basic setup uses Node.js, Express, and Socket.io, but I need better error handling.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "I'm troubleshooting connection problems from CORS and matching Socket.io client/server versions.",
    },
    {
      turn_index: 36,
      role: "user",
      content:
        "I need multi-user broadcast optimizations because the app slows down near 1000 users.",
    },
    {
      turn_index: 50,
      role: "user",
      content:
        "For scaling I want a load balancer and message queue, then Redis caching for sessions.",
    },
    {
      turn_index: 64,
      role: "user",
      content:
        "When users joinRoom I need room message history retrieval, plus Redis pub/sub error handling and retry.",
    },
    {
      turn_index: 78,
      role: "user",
      content:
        "Finally I want to refactor broadcast logic and use Map and Set data structures for user and room management.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different aspects of optimizing and handling real-time messaging in my chat app throughout our conversations, in order (mention 9 items in order)?",
    maxChars: 6_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /basic setup and error handling/);
  assert.match(recalled, /connection troubleshooting/);
  assert.match(recalled, /multi-user and broadcast optimizations/);
  assert.match(recalled, /scaling with load balancer and message queue/);
  assert.match(recalled, /Redis caching for sessions/);
  assert.match(recalled, /room-based messaging and retrieval/);
  assert.match(recalled, /Redis pub\/sub error handling and retry/);
  assert.match(recalled, /broadcast logic refactoring and further optimization/);
  assert.match(recalled, /performance bottlenecks and data structures/);
});

test("event order recall labels resume-analyzer optimization trajectories", async () => {
  const sessionId = "event-order-resume-analyzer";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 4,
      role: "user",
      content:
        "I'm setting up a resume analyzer with Python, spaCy, Flask, and PyMuPDF for feature extraction.",
    },
    {
      turn_index: 16,
      role: "user",
      content:
        "I'm debugging PDF text extraction and NoneType errors before the February 15 project timeline deadline.",
    },
    {
      turn_index: 28,
      role: "user",
      content:
        "I used cProfile for API response time optimization and found bottlenecks.",
    },
    {
      turn_index: 42,
      role: "user",
      content:
        "Now I'm improving memory usage and keyword extraction with precompiled regex, stopword removal, and lemmatization.",
    },
    {
      turn_index: 56,
      role: "user",
      content:
        "Next I want job description parsing enhancements, startup time and caching strategies with lazy-loading spaCy and Redis-backed caching.",
    },
    {
      turn_index: 70,
      role: "user",
      content:
        "I'm optimizing the weighted scoring function and similarity calculations, then adding authentication and authorization.",
    },
    {
      turn_index: 84,
      role: "user",
      content:
        "Finally I need to simulate concurrent requests for performance testing.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different aspects of optimizing and enhancing my resume analyzer project throughout our conversations, in order (mention 10 items in order)?",
    maxChars: 7_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial setup and feature extraction/);
  assert.match(recalled, /debugging PDF text extraction/);
  assert.match(recalled, /project timeline and deadlines/);
  assert.match(recalled, /API response time optimization/);
  assert.match(recalled, /memory usage and keyword extraction improvements/);
  assert.match(recalled, /job description parsing enhancements/);
  assert.match(recalled, /startup time and caching strategies/);
  assert.match(recalled, /scoring function and similarity optimization/);
  assert.match(recalled, /authentication and authorization/);
  assert.match(recalled, /concurrent request simulation/);
});

test("event order recall labels recommendation-system development trajectories", async () => {
  const sessionId = "event-order-recommendation-system";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 20,
      role: "user",
      content:
        "I'm implementing user-based collaborative filtering using cosine similarity on the user ratings matrix.",
    },
    {
      turn_index: 82,
      role: "user",
      content:
        "I'm creating the Flask /recommendations endpoint to serve top 5 recommendations per user_id query parameter.",
    },
    {
      turn_index: 84,
      role: "user",
      content:
        "How do I define the get_user_ratings and get_top_rated_items helper functions based on my dataset?",
    },
    {
      turn_index: 176,
      role: "user",
      content:
        "I'm implementing a hybrid recommendation system with Redis caching for similarity matrices and TF-IDF content-based filtering.",
    },
    {
      turn_index: 330,
      role: "user",
      content:
        "I'm integrating user preferences into hybrid recommendation scoring and writing tests for preference filtering.",
    },
    {
      turn_index: 432,
      role: "user",
      content:
        "Here's my hybrid scoring formula using weighted hybrid scoring with 0.6 collaborative and 0.4 content-based scores.",
    },
    {
      turn_index: 434,
      role: "user",
      content:
        "I want to test different weight combinations and measure their impact on recommendation accuracy.",
    },
    {
      turn_index: 678,
      role: "user",
      content:
        "I'm exploring evaluation metrics for performance optimization, including precision, recall, F1-score, and AUC-ROC.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my discussions about recommendation system development progress in order (mention 8 items in order)?",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /user-based collaborative filtering implementation/);
  assert.match(recalled, /Flask recommendations endpoint/);
  assert.match(recalled, /helper function definitions/);
  assert.match(recalled, /hybrid recommendation system with caching/);
  assert.match(recalled, /user preferences integration and testing/);
  assert.match(recalled, /hybrid scoring formula refinement/);
  assert.match(recalled, /testing weight combinations and accuracy impact/);
  assert.match(recalled, /evaluation metrics for performance optimization/);
});

test("event order recall labels system architecture and benchmark recommendation trajectories", async () => {
  const architectureSessionId = "event-order-system-architecture";
  const architectureEngine = new FakeEventOrderEngine(architectureSessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I'm planning a microservices architecture with scraping, NLP, and API boundaries for the news aggregator.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "I reviewed the OpenAPI documentation before upgrading the FastAPI service for async handlers and WebSocket support.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "The WebSocket integration still needs stability work, and the database query/schema optimization is next.",
    },
    {
      turn_index: 46,
      role: "user",
      content:
        "Now I need Scrapy configuration for robots.txt compliance and user-agent rotation.",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "I added centralized error logging with Sentry, paywall detection in the scraper, Twilio Verify API integration with rate limiting, and Istio service mesh routing with mutual TLS.",
    },
  ]);

  const architecture = await buildEventOrderRecallSection({
    engine: architectureEngine,
    sessionId: architectureSessionId,
    query:
      "Can you reconstruct the timeline of when I first mentioned each aspect of my system architecture and related tooling in order? Mention ONLY and ONLY ten items.",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(architecture, /Microservices architecture planning with scraping, NLP, API/);
  assert.match(architecture, /OpenAPI documentation review/);
  assert.match(architecture, /FastAPI upgrade for async and WebSocket/);
  assert.match(architecture, /WebSocket integration and stability/);
  assert.match(architecture, /Database query and schema optimization/);
  assert.match(architecture, /Scrapy configuration for robots\.txt and user-agent rotation/);
  assert.match(architecture, /Centralized error logging with Sentry/);
  assert.match(architecture, /Paywall detection in scraper/);
  assert.match(architecture, /Twilio Verify API integration with rate limiting/);
  assert.match(architecture, /Istio service mesh setup with mutual TLS and routing/);

  const recommendationSessionId = "event-order-recommendation-benchmark-labels";
  const recommendationEngine = new FakeEventOrderEngine(recommendationSessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I'm debugging the collaborative filtering implementation and handling missing user interactions.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "I need help debugging error messages while incorporating user ratings and matrix factorization.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "Next I'm applying diversity filters and improving caching strategies for performance.",
    },
    {
      turn_index: 46,
      role: "user",
      content:
        "I'm doing parallel processing optimization for recommendation generation.",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "I added user feedback collection with error handling, efficient feedback data querying, and advanced caching plus parallelization integration.",
    },
  ]);

  const recommendation = await buildEventOrderRecallSection({
    engine: recommendationEngine,
    sessionId: recommendationSessionId,
    query:
      "Can you reconstruct the sequence in which I brought up different aspects of my recommendation engine development and optimization in order? Mention ONLY and ONLY ten items.",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recommendation, /Collaborative filtering implementation and debugging/);
  assert.match(recommendation, /Handling missing user interactions/);
  assert.match(recommendation, /Debugging error messages/);
  assert.match(recommendation, /Incorporating user ratings and matrix factorization/);
  assert.match(recommendation, /Applying diversity filters/);
  assert.match(recommendation, /Caching strategies for performance/);
  assert.match(recommendation, /Parallel processing optimization/);
  assert.match(recommendation, /User feedback collection and error handling/);
  assert.match(recommendation, /Efficient feedback data querying/);
  assert.match(recommendation, /Advanced caching and parallelization integration/);
});

test("event order recall labels mathematical induction proof trajectories", async () => {
  const sessionId = "event-order-induction-proofs";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 8,
      role: "user",
      content:
        "I'm struggling with the inductive step in inequality proofs and need help seeing why the proof works.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "Can I get more inequality induction examples and practice problems?",
    },
    {
      turn_index: 48,
      role: "user",
      content:
        "I need to carefully handle the >= signs because changing directions affects the conclusion.",
    },
    {
      turn_index: 74,
      role: "user",
      content:
        "I'm exploring algebraic steps that connect the inductive hypothesis to the conclusion.",
    },
    {
      turn_index: 96,
      role: "user",
      content:
        "I'm starting modular arithmetic and modular reasoning for divisibility proofs.",
    },
    {
      turn_index: 122,
      role: "user",
      content:
        "Can we work through divisibility problems involving powers and modular reasoning?",
    },
    {
      turn_index: 140,
      role: "user",
      content:
        "I'm confused about notation and terminology in divisibility induction proofs.",
    },
    {
      turn_index: 166,
      role: "user",
      content:
        "Let's revisit base case verification and inductive step articulation for inequalities.",
    },
    {
      turn_index: 190,
      role: "user",
      content:
        "I have deeper questions about preserving the direction of the inequality during algebraic manipulations.",
    },
    {
      turn_index: 220,
      role: "user",
      content:
        "I'm reflecting on the logical flow and careful handling of inequalities in induction.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of mathematical induction proofs develop throughout our conversations in order (mention 10 items)?",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial struggles with inductive step in inequality proofs/);
  assert.match(recalled, /requests for additional inequality examples/);
  assert.match(recalled, /handling inequality signs carefully/);
  assert.match(recalled, /algebraic steps connecting inductive hypotheses to conclusions/);
  assert.match(recalled, /modular arithmetic introduction/);
  assert.match(recalled, /divisibility problems involving powers and modular reasoning/);
  assert.match(recalled, /notation and terminology clarifications/);
  assert.match(recalled, /base case verification and inductive step articulation for inequalities/);
  assert.match(recalled, /preserving inequality directions and algebraic concerns/);
  assert.match(recalled, /logical flow and careful inequality handling/);
});

test("event order recall labels cryptographic theorem and function trajectories", async () => {
  const sessionId = "event-order-crypto-concepts";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 20,
      role: "user",
      content:
        "I'm trying to understand the concept of one-way functions and trapdoor functions in cryptography, but I'm having trouble seeing how they apply to real-world problems.",
    },
    {
      turn_index: 48,
      role: "user",
      content:
        "Can you explain the concept of necessary and sufficient conditions in theorem statements, specifically in the context of Euler's theorem and RSA decryption? I'm having trouble understanding how these conditions apply to cryptographic security arguments.",
    },
    {
      turn_index: 64,
      role: "user",
      content:
        "Can you explain necessary and sufficient conditions in theorem statements like Euler's theorem or the Chinese Remainder Theorem, using RSA or Diffie-Hellman key exchange to illustrate cryptographic applications?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you reconstruct the timeline of when I first mentioned each aspect of the mathematical and cryptographic concepts we discussed in order? Mention ONLY and ONLY eight items.",
    maxChars: 6_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /one-way and trapdoor functions/);
  assert.match(recalled, /combined cryptographic conditions and applications/);
  assert.ok(
    recalled.indexOf("one-way and trapdoor functions") <
      recalled.indexOf("combined cryptographic conditions and applications"),
  );
});

test("event order recall labels calculus concept and application trajectories", async () => {
  const sessionId = "event-order-calculus-concepts";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 8,
      role: "user",
      content:
        "I'm trying to understand the basic idea and purpose of derivatives before moving deeper.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "Can we apply derivatives to real-life paramedic scenarios involving rates like heart rate changes?",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "I want step-by-step differentiation practice with polynomial functions using the power rule.",
    },
    {
      turn_index: 48,
      role: "user",
      content:
        "Now I want to explore tangent lines and slope interpretation at specific points.",
    },
    {
      turn_index: 62,
      role: "user",
      content:
        "Let's work on related rates problems involving blood flow and respiratory rates.",
    },
    {
      turn_index: 76,
      role: "user",
      content:
        "I need derivative tests for optimization and analyzing flow rates.",
    },
    {
      turn_index: 90,
      role: "user",
      content:
        "I'm analyzing critical points and solving derivative equations in paramedic contexts.",
    },
    {
      turn_index: 104,
      role: "user",
      content:
        "Finally, I want related rates with a geometric sliding ladder problem.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different calculus concepts and their applications throughout our conversations, in order (mention 8 items)?",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /basic derivative concept/);
  assert.match(recalled, /real-life paramedic rate applications/);
  assert.match(recalled, /power rule differentiation practice/);
  assert.match(recalled, /tangent line and slope meaning/);
  assert.match(recalled, /related rates with blood flow/);
  assert.match(recalled, /derivative tests for optimization/);
  assert.match(recalled, /critical points and solving derivative equations/);
  assert.match(recalled, /related rates with geometric problem/);
});

test("event order recall labels laptop topic trajectories", async () => {
  const sessionId = "event-order-laptop-topics";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content:
        "I'm looking for a laptop that's perfect for work, travel, and entertainment as a science writer, and I need recommendations.",
    },
    {
      turn_index: 154,
      role: "user",
      content:
        "Michele invited me to The Green Bean on March 16 at 6 PM to test laptop portability and see how lightweight laptops feel in person.",
    },
    {
      turn_index: 253,
      role: "user",
      content:
        "My colleague Judy recommended attending the April 10 digital storytelling workshop at Saint Helena Library for skill growth.",
    },
    {
      turn_index: 386,
      role: "user",
      content:
        "I've been looking at the MacBook Air laptop specs, including its 8-core CPU and 16GB RAM, for daily writing performance.",
    },
    {
      turn_index: 987,
      role: "user",
      content:
        "I designed custom graphics for a presentation using Adobe Illustrator, and now I need a laptop choice that can handle similar tasks efficiently.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different laptop-related topics throughout our conversations in order (mention 5 items)?",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial laptop needs and recommendations/);
  assert.match(recalled, /testing portability and meeting at The Green Bean/);
  assert.match(recalled, /workshops and skill development/);
  assert.match(recalled, /laptop specs and writing performance/);
  assert.match(recalled, /final laptop choice and presentation preparation/);
  assert.ok(
    recalled.indexOf("initial laptop needs and recommendations") <
      recalled.indexOf("testing portability and meeting at The Green Bean"),
  );
  assert.ok(
    recalled.indexOf("testing portability and meeting at The Green Bean") <
      recalled.indexOf("workshops and skill development"),
  );
  assert.ok(
    recalled.indexOf("workshops and skill development") <
      recalled.indexOf("laptop specs and writing performance"),
  );
  assert.ok(
    recalled.indexOf("laptop specs and writing performance") <
      recalled.indexOf("final laptop choice and presentation preparation"),
  );
});

test("event order recall labels screen-time strategy trajectories", async () => {
  const sessionId = "event-order-screen-time";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 66,
      role: "user",
      content:
        "I'm worried about Scott's internet use, so I want Norton Family monitoring that limits his screen time to 2 hours daily.",
    },
    {
      turn_index: 82,
      role: "user",
      content:
        "How can I make sure Scott balances his screen time with exercise and outdoor activities?",
    },
    {
      turn_index: 204,
      role: "user",
      content:
        "What digital safety monitoring updates should I use for Scott's online risks and privacy?",
    },
    {
      turn_index: 341,
      role: "user",
      content:
        "We've set up no-device zones and tech-free Sundays for Scott at home.",
    },
    {
      turn_index: 468,
      role: "user",
      content:
        "Cynthia and I agreed on stricter screen time rules, adjusting limits for weekdays and weekends.",
    },
    {
      turn_index: 620,
      role: "user",
      content:
        "I want to introduce an educational app for Scott's math learning.",
    },
    {
      turn_index: 740,
      role: "user",
      content:
        "Should we keep screen time limits stricter during exam prep and studying?",
    },
    {
      turn_index: 930,
      role: "user",
      content:
        "How flexible should we be with Scott's screen time given his social life with friends?",
    },
    {
      turn_index: 1100,
      role: "user",
      content:
        "I need communication and involvement strategies so Scott understands screen time limits.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on managing screen time and related strategies develop throughout our conversations in order (mention 9 items)?",
    maxChars: 9_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial limits and monitoring/);
  assert.match(recalled, /balancing screen time with other activities/);
  assert.match(recalled, /digital safety and monitoring updates/);
  assert.match(recalled, /tech-free zones establishment/);
  assert.match(recalled, /adjusting screen time limits/);
  assert.match(recalled, /educational app introduction/);
  assert.match(recalled, /limits during exam prep/);
  assert.match(recalled, /social life and flexibility considerations/);
  assert.match(recalled, /communication and involvement strategies/);
});

test("event order recall labels Scott support summary trajectories", async () => {
  const sessionId = "event-order-scott-support";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 60,
      role: "user",
      content:
        "Scott has twice weekly tutoring sessions with Ms. Harper, and I want goal-setting with consistent monitoring.",
    },
    {
      turn_index: 90,
      role: "user",
      content:
        "How can I create a distraction-free study environment and foster a growth mindset for Scott?",
    },
    {
      turn_index: 140,
      role: "user",
      content:
        "I want to celebrate incremental progress with achievable milestones and positive reinforcement.",
    },
    {
      turn_index: 210,
      role: "user",
      content:
        "Can role-playing social scenarios help Scott practice self-expression and foster independence?",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "How do we cultivate responsibility with clear expectations, consistent feedback, and gradual increases in responsibility?",
    },
    {
      turn_index: 360,
      role: "user",
      content:
        "I need digital safety with parental controls, online risks education, privacy management, and open communication.",
    },
    {
      turn_index: 420,
      role: "user",
      content:
        "How do we balance screen time by structuring daily routines, encouraging physical and creative pursuits, and modeling healthy habits?",
    },
    {
      turn_index: 520,
      role: "user",
      content:
        "Scott's emotional well-being needs open communication, consistent schedules, and coping mechanisms.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed summary of how all aspects of supporting Scott have been addressed and coordinated over time?",
    maxChars: 9_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /structured tutoring sessions with goal-setting and consistent monitoring/);
  assert.match(recalled, /distraction-free study environment and growth mindset/);
  assert.match(recalled, /celebrating incremental progress with positive reinforcement/);
  assert.match(recalled, /role-playing social scenarios and self-expression/);
  assert.match(recalled, /clear expectations and gradual responsibility/);
  assert.match(recalled, /digital safety with parental controls and privacy/);
  assert.match(recalled, /screen time routines and healthy habits/);
  assert.match(recalled, /emotional support with coping mechanisms/);
});

test("event order recall labels relationship progress and emotional regulation trajectories", async () => {
  const sessionId = "event-order-relationship-progress";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 23,
      role: "user",
      content:
        "I'm worried about my relationship with Rachael, we've been together for 3 years and I met her at the Donaldsonside Community Center in 2021.",
    },
    {
      turn_index: 37,
      role: "user",
      content:
        "I'm trying to rebuild trust with Rachael, who's 74, and I'm thinking about our age difference.",
    },
    {
      turn_index: 88,
      role: "user",
      content:
        "I'm worried about our couples counseling session with Dr. Marie Leclerc and how it will affect rebuilding trust.",
    },
    {
      turn_index: 158,
      role: "user",
      content:
        "I've been practicing breathing exercises during tense conversations and it's reduced conflict duration by 30%.",
    },
    {
      turn_index: 380,
      role: "user",
      content:
        "We set a goal to increase our mutual trust score from 6 to 8/10 by July 15, measured via weekly surveys.",
    },
    {
      turn_index: 714,
      role: "user",
      content:
        "Rachael and I had a disagreement over social media boundaries and compromised to share only positive updates.",
    },
    {
      turn_index: 735,
      role: "user",
      content:
        "Our daily rehearsals of music recital pieces should strengthen our bond and emotional intimacy.",
    },
    {
      turn_index: 800,
      role: "user",
      content:
        "I've been using breathing exercises during stressful packing sessions to manage emotional regulation while traveling.",
    },
    {
      turn_index: 830,
      role: "user",
      content:
        "How can I reach 95% relationship satisfaction by November 1 with monthly progress reviews and communication?",
    },
    {
      turn_index: 982,
      role: "user",
      content:
        "How do I balance songwriting sessions with intimacy-focused counseling and creative collaboration planning?",
    },
    {
      turn_index: 1200,
      role: "user",
      content:
        "We're finalizing the album by December 15, including songwriting, recording, and mixing milestones.",
    },
    {
      turn_index: 1295,
      role: "user",
      content:
        "Can I use emotional regulation techniques, like the ones I used to manage party-day nerves, in other stressful situations?",
    },
  ]);

  const relationship = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different aspects of my relationship progress and goals throughout our conversations in order (mention 10 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(relationship, /relationship concerns and origins/);
  assert.match(relationship, /trust issues and age difference/);
  assert.match(relationship, /trust improvement goals with surveys/);
  assert.match(relationship, /sustaining satisfaction and social compromises/);
  assert.match(relationship, /intimacy through music sessions/);
  assert.match(relationship, /maintaining satisfaction with communication/);
  assert.match(relationship, /creative collaboration planning/);
  assert.match(relationship, /finalizing creative projects/);

  const emotional = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different strategies and concerns related to managing my emotional well-being and relationship throughout our conversations, in order (mention 8 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(emotional, /couples counseling and trust rebuilding/);
  assert.match(emotional, /breathing exercises for conflict reduction/);
  assert.match(emotional, /intimacy through music sessions/);
  assert.match(emotional, /emotional regulation during travel/);
  assert.match(emotional, /creative collaboration planning/);
  assert.match(emotional, /finalizing creative projects/);
  assert.match(emotional, /managing party-day nerves and applying techniques elsewhere/);
});

test("event order recall labels work collaboration advice trajectories", async () => {
  const sessionId = "event-order-work-collaboration";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 116,
      role: "user",
      content:
        "I've collaborated with Kelli on a March 28 article that increased readership by 18%, should I ask her to help with my next project?",
    },
    {
      turn_index: 318,
      role: "user",
      content:
        "I met Mary at the September 3 editorial meeting, and she seems knowledgeable, so I'm thinking of asking her for guidance.",
    },
    {
      turn_index: 430,
      role: "user",
      content:
        "I've been thinking about what James said on November 5 about aligning projects with company goals.",
    },
    {
      turn_index: 536,
      role: "user",
      content:
        "What strategies can I use to build on the January 10 strategy meeting where Mary and I co-presented?",
    },
    {
      turn_index: 652,
      role: "user",
      content:
        "I've been working closely with Kelli, and we co-led a workshop on cross-department collaboration on March 5.",
    },
    {
      turn_index: 768,
      role: "user",
      content:
        "James offered strategic advice on April 25 for the sustainability project, and I want to build on this advice.",
    },
    {
      turn_index: 838,
      role: "user",
      content:
        "I co-authored an article with Mary on project impact and it was published on July 12.",
    },
    {
      turn_index: 944,
      role: "user",
      content:
        "How will James's letter of recommendation from October 5 impact my Editorial Manager application?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different collaborations and advice related to my work projects in our conversations, in order (mention 8 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /collaboration with Kelli on article/);
  assert.match(recalled, /meeting Mary at editorial meeting/);
  assert.match(recalled, /advice from James on project alignment/);
  assert.match(recalled, /strategy meeting co-presented with Mary/);
  assert.match(recalled, /workshop co-led with Kelli/);
  assert.match(recalled, /strategic advice from James on sustainability project/);
  assert.match(recalled, /co-authoring article with Mary/);
  assert.match(recalled, /James's letter of recommendation/);
});

test("event order recall labels investment strategy trajectories", async () => {
  const sessionId = "event-order-investment-strategy";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I'm starting with a broad-market ETF strategy using VOO, VEU, and AGG with automatic contributions.",
    },
    {
      turn_index: 32,
      role: "user",
      content:
        "Raymond helped me compare financial advisor options and set up a managed portfolio focused on ETFs.",
    },
    {
      turn_index: 306,
      role: "user",
      content:
        "I'm considering robo-advisors so my portfolio can keep automatic contributions on schedule.",
    },
    {
      turn_index: 320,
      role: "user",
      content:
        "I added VXUS and other international ETFs for global diversification.",
    },
    {
      turn_index: 430,
      role: "user",
      content:
        "Raymond suggested REIT ETFs like VNQ for real estate exposure.",
    },
    {
      turn_index: 562,
      role: "user",
      content:
        "I added VWO for emerging markets exposure.",
    },
    {
      turn_index: 673,
      role: "user",
      content:
        "I'm allocating to municipal bond funds like VTEB.",
    },
    {
      turn_index: 804,
      role: "user",
      content:
        "I added the SCZ international small-cap ETF.",
    },
    {
      turn_index: 913,
      role: "user",
      content:
        "I'm exploring sector-specific ETFs like XLV for healthcare.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my investment strategy develop throughout our conversations in order (mention 9 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial ETF strategy discussion/);
  assert.match(recalled, /advisor comparison and managed portfolio setup/);
  assert.match(recalled, /robo-advisor automatic contributions/);
  assert.match(recalled, /international ETF diversification/);
  assert.match(recalled, /REIT and real-estate ETF exploration/);
  assert.match(recalled, /emerging markets ETF addition/);
  assert.match(recalled, /municipal bond fund allocation/);
  assert.match(recalled, /international small-cap ETF addition/);
  assert.match(recalled, /sector ETF focus/);
});

test("event order recall labels Brittney financial-boundary trajectories", async () => {
  const sessionId = "event-order-brittney-finance";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 204,
      role: "user",
      content:
        "Brittney asked for stock tips, so I shared only educational resources instead of direct investment advice.",
    },
    {
      turn_index: 340,
      role: "user",
      content:
        "I declined Brittney's $500 loan request and emphasized financial independence.",
    },
    {
      turn_index: 460,
      role: "user",
      content:
        "I agreed to help manage Brittney's $500 custodial account with monthly check-ins.",
    },
    {
      turn_index: 580,
      role: "user",
      content:
        "Brittney and I decided to co-invest $1,000 and hold quarterly review meetings.",
    },
    {
      turn_index: 916,
      role: "user",
      content:
        "Brittney and I raised the co-investment to $2,500 with quarterly reviews covering pros and cons.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my financial boundaries and arrangements with Brittney develop throughout our conversations in order (mention 5 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Brittney financial boundaries and education/);
  assert.match(recalled, /declining Brittney loan and emphasizing independence/);
  assert.match(recalled, /Brittney custodial account with monthly check-ins/);
  assert.match(recalled, /later co-investments with quarterly reviews and pros and cons/);
  assert.ok(
    recalled.indexOf("declining Brittney loan and emphasizing independence") <
      recalled.indexOf("Brittney custodial account with monthly check-ins"),
  );
});

test("event order recall labels portfolio concern trajectories", async () => {
  const sessionId = "event-order-portfolio-concerns";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 172,
      role: "user",
      content:
        "I verified that my ESG funds comply with Saint Helena's 2024 updated financial regulations.",
    },
    {
      turn_index: 178,
      role: "user",
      content:
        "What specific ESG funds do you recommend for lower volatility and good returns, and which option has the lowest expense ratio?",
    },
    {
      turn_index: 360,
      role: "user",
      content:
        "I'm worried about my friend John's portfolio because he shared that it had an 8% loss in August but expects recovery by 2025.",
    },
    {
      turn_index: 488,
      role: "user",
      content:
        "Stephen's recommendation of Wealthfront's tax tools has been helpful since I adopted them on December 1.",
    },
    {
      turn_index: 1250,
      role: "user",
      content:
        "I'm weighing regional market risks and inflation hedging with Stephen, including TIPS and emerging market currency risk.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different concerns and discussions about my investment portfolio throughout our conversations in order (mention 5 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /compliance with financial regulations/);
  assert.match(recalled, /ESG fund options and decisions/);
  assert.match(recalled, /friend John's portfolio losses and recovery/);
  assert.match(recalled, /adoption and use of tax tools/);
  assert.match(recalled, /regional market risks and inflation hedging/);
});

test("event order recall labels Stephanie shared-meal and social-plan trajectories", async () => {
  const sessionId = "event-order-stephanie-social-meals";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 24,
      role: "user",
      content:
        "My partner Stephanie and I have a regular dinner date at The Blue Heron, but I'm not sure what the healthiest options are there.",
    },
    {
      turn_index: 156,
      role: "user",
      content:
        "I agreed to let Stephanie add desserts to our meal plan once weekly, but I'm wondering if that's gonna affect my calorie goals.",
    },
    {
      turn_index: 246,
      role: "user",
      content:
        "I compromised with Stephanie on reducing salt by 25% in our shared recipes, but how can I further reduce sodium?",
    },
    {
      turn_index: 384,
      role: "user",
      content:
        "Stephanie has been requesting more social dinners, and I've agreed to host friends monthly starting May.",
    },
    {
      turn_index: 512,
      role: "user",
      content:
        "Stephanie wants to increase our dining out to 3 times weekly, and I declined because I need better budget boundaries.",
    },
    {
      turn_index: 516,
      role: "user",
      content:
        "I'm feeling a bit overwhelmed with all these changes and Stephanie's requests.",
    },
    {
      turn_index: 708,
      role: "user",
      content:
        "I'm thinking of hosting a dinner party on August 24 for Stephanie with healthy meal options.",
    },
    {
      turn_index: 716,
      role: "user",
      content:
        "I'm trying to prioritize my relationships and health by balancing time with Stephanie and my wellness goals.",
    },
    {
      turn_index: 844,
      role: "user",
      content:
        "I'm thinking of attending the monthly book club with Stephanie starting in October, but I'm not sure I can commit every month.",
    },
    {
      turn_index: 942,
      role: "user",
      content:
        "Stephanie and I agreed on 4 parties per year starting December, and I want to stick to that party hosting limit.",
    },
    {
      turn_index: 1036,
      role: "user",
      content:
        "Stephanie requested no alcohol at our parties, and we agreed to serve only wine and sparkling water.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different aspects of managing my shared meals and social plans with Stephanie throughout our conversations, in order (mention 11 items)?",
    maxChars: 16_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /healthy dinner options/);
  assert.match(recalled, /dessert frequency and calories/);
  assert.match(recalled, /salt reduction in recipes/);
  assert.match(recalled, /monthly social dinners/);
  assert.match(recalled, /dining out frequency and budget boundaries/);
  assert.match(recalled, /emotional overwhelm/);
  assert.match(recalled, /dinner party planning/);
  assert.match(recalled, /balancing relationships and wellness/);
  assert.match(recalled, /book club attendance commitment/);
  assert.match(recalled, /party hosting limits/);
  assert.match(recalled, /party drink restrictions/);
});

test("event order recall labels nutrition and activity plan trajectories", async () => {
  const sessionId = "event-order-nutrition-activity";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 32,
      role: "user",
      content:
        "My close friends John and Patricia meet with me every other Thursday at 10 AM at Cafe Verona, what healthy breakfast options can I suggest?",
    },
    {
      turn_index: 186,
      role: "user",
      content:
        "I'm worried about what to bring to Patricia's potluck on February 3 and need help deciding on a healthy dish to share.",
    },
    {
      turn_index: 190,
      role: "user",
      content:
        "I've allocated 30 minutes daily for light stretching and walking after lunch, but I'm struggling to stick to the walking routine and stay motivated.",
    },
    {
      turn_index: 422,
      role: "user",
      content:
        "I'm trying to plan a nutrition lecture follow-up with my friend John after attending a lecture at Saint Helena Community Center.",
    },
    {
      turn_index: 974,
      role: "user",
      content:
        "I'm worried about my LDL cholesterol levels, so I was thinking of asking John during my visit at Saint Helena Botanical Gardens if he knows ways to reduce it.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different aspects of my nutrition and activity plans throughout our conversations in order (mention 5 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /regular meetings and breakfast options/);
  assert.match(recalled, /potluck planning and healthy dishes/);
  assert.match(recalled, /walking routine and motivation/);
  assert.match(recalled, /nutrition lecture follow-up and related discussions/);
  assert.match(recalled, /cholesterol concerns and visit planning/);
});

test("event order recall labels dietary adjustment trajectories", async () => {
  const sessionId = "event-order-dietary-adjustments";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 32,
      role: "user",
      content:
        "My close friends John and Patricia meet with me every other Thursday at Cafe Verona, what healthy breakfast options can I suggest?",
    },
    {
      turn_index: 186,
      role: "user",
      content:
        "I'm worried about what to bring to Patricia's potluck and need help deciding on a healthy dish to share.",
    },
    {
      turn_index: 190,
      role: "user",
      content:
        "I've allocated 30 minutes daily for light stretching and walking after lunch, but I'm struggling to stick to the walking routine and stay motivated.",
    },
    {
      turn_index: 346,
      role: "user",
      content:
        "I feel like I need to learn more about micronutrient deficiencies, especially after Jessica sent that infographic on May 6.",
    },
    {
      turn_index: 442,
      role: "user",
      content:
        "I attended a webinar on June 14 about balancing macronutrients in keto and plant-based diets.",
    },
    {
      turn_index: 536,
      role: "user",
      content:
        "Jessica provided an update on micronutrient supplementation for restricted diets on July 20.",
    },
    {
      turn_index: 624,
      role: "user",
      content:
        "I've been meaning to learn more about balancing calcium intake in dairy-free diets after Jessica's August 18 note.",
    },
    {
      turn_index: 716,
      role: "user",
      content:
        "Jessica provided an update on plant-based protein combinations for complete amino acids on September 25.",
    },
    {
      turn_index: 974,
      role: "user",
      content:
        "I'm worried about my LDL cholesterol levels, so I was thinking of asking John about ways to reduce it.",
    },
    {
      turn_index: 1020,
      role: "user",
      content:
        "I'd love to get some guidance on micronutrient needs for growing children on restricted diets from Jessica's January 20 update.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on various aspects of dietary adjustments develop throughout our conversations in order (10 items)?",
    maxChars: 14_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Requested item count: 10/);
  const deficiencies = recalled.indexOf("micronutrient deficiencies");
  const macronutrients = recalled.indexOf("macronutrient balancing");
  const supplementation = recalled.indexOf("micronutrient supplementation updates");
  const calcium = recalled.indexOf("calcium intake balancing");
  const proteins = recalled.indexOf("plant-based protein combinations");
  const children = recalled.indexOf("micronutrient needs for growing children");

  assert.ok(deficiencies >= 0);
  assert.ok(macronutrients > deficiencies);
  assert.ok(supplementation > macronutrients);
  assert.ok(calcium > supplementation);
  assert.ok(proteins > calcium);
  assert.ok(children > proteins);
});

test("event order recall labels flavor-enhancement cooking trajectories", async () => {
  const sessionId = "event-order-flavor-enhancements";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 24,
      role: "user",
      content:
        "I'm trying healthy cooking methods for roasted vegetables and want flavor without making dinner complicated.",
    },
    {
      turn_index: 154,
      role: "user",
      content:
        "I added turmeric and ginger to roasted carrots and want other spice combinations for roasted vegetables.",
    },
    {
      turn_index: 246,
      role: "user",
      content:
        "I added smoked paprika and chipotle powder to roasted sweet potatoes on April 4, what other spices can I experiment with to enhance flavor depth?",
    },
    {
      turn_index: 334,
      role: "user",
      content:
        "I added za'atar spice blend to roasted vegetables and want other Middle Eastern flavors I can experiment with.",
    },
    {
      turn_index: 819,
      role: "user",
      content:
        "I've been experimenting with za'atar again and want further Middle Eastern spice exploration for vegetables.",
    },
    {
      turn_index: 882,
      role: "user",
      content:
        "I added turmeric and ginger to roasted carrots on July 13 and it enhanced the flavor and color, what other spices can I experiment with?",
    },
    {
      turn_index: 884,
      role: "user",
      content:
        "I'm looking for ways to enhance the flavor of my roasted carrots, can you suggest some other spice combinations I can try, like the turmeric and ginger I used on July 13?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my discussions about experimenting with different flavor enhancements progress throughout our conversations in order (mention 8 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /healthy cooking methods/);
  assert.match(recalled, /initial spice combinations for roasted vegetables/);
  assert.match(recalled, /additional spices to enhance flavor depth/);
  assert.match(recalled, /Middle Eastern flavor experimentation/);
  assert.match(recalled, /further Middle Eastern spice exploration/);
  assert.match(recalled, /enhancing flavor and color with spices/);
  assert.match(recalled, /revisiting smoky and spicy seasonings/);
  assert.match(recalled, /seeking new seasoning ideas for roasted vegetables/);
  assert.ok(
    recalled.indexOf("additional spices to enhance flavor depth") <
      recalled.indexOf("Middle Eastern flavor experimentation"),
  );
  assert.ok(
    recalled.indexOf("enhancing flavor and color with spices") <
      recalled.indexOf("revisiting smoky and spicy seasonings"),
  );
});

test("event order recall labels health-management trajectories", async () => {
  const sessionId = "event-order-health-management";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 16,
      role: "user",
      content:
        "I was diagnosed with type 2 diabetes six months ago by Dr. Linda Chen; how often should I follow up with her?",
    },
    {
      turn_index: 108,
      role: "user",
      content:
        "Dr. Chen recommended insulin options, including starting low-dose basal insulin, and I chose to delay it while deciding.",
    },
    {
      turn_index: 216,
      role: "user",
      content:
        "I'm managing arthritis pain and joint mobility with ibuprofen, but I need better symptom management.",
    },
    {
      turn_index: 244,
      role: "user",
      content:
        "My physical therapist Mark Lewis at Saint Helena Rehab Center says my joint progress is improving after physical therapy.",
    },
    {
      turn_index: 312,
      role: "user",
      content:
        "I'm worried about my insulin dosage and whether 10 units of Lantus nightly is the right dose to review.",
    },
    {
      turn_index: 530,
      role: "user",
      content:
        "I scheduled an eye exam at VisionCare Optometry to check retinopathy and eye health.",
    },
    {
      turn_index: 650,
      role: "user",
      content:
        "I have a cardiology follow-up appointment to review my blood pressure and heart health.",
    },
    {
      turn_index: 1000,
      role: "user",
      content:
        "My latest lab results and CGM data changed the treatment plan Sarah Kim gave me for my health goals.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different aspects of managing my health throughout our conversations in order (mention 8 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial diagnosis and follow-up/);
  assert.match(recalled, /insulin options and decisions/);
  assert.match(recalled, /arthritis pain management/);
  assert.match(recalled, /physical therapy progress/);
  assert.match(recalled, /insulin dosage concerns/);
  assert.match(recalled, /eye health exams/);
  assert.match(recalled, /cardiology visits/);
  assert.match(recalled, /lab results and treatment plan/);
  assert.ok(
    recalled.indexOf("initial diagnosis and follow-up") <
      recalled.indexOf("insulin options and decisions"),
  );
  assert.ok(
    recalled.indexOf("eye health exams") <
      recalled.indexOf("cardiology visits"),
  );
  assert.doesNotMatch(recalled, /interaction with health/);
  assert.doesNotMatch(recalled, /interaction with managing/);
});

test("event order recall labels David support trajectories", async () => {
  const sessionId = "event-order-david-support";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 22,
      role: "user",
      content:
        "I met David at a wine tasting event on January 5, 2023, and he's been supportive, but I'm not sure how to explain my diabetes to him.",
    },
    {
      turn_index: 118,
      role: "user",
      content:
        "David helped me with Mediterranean meals on April 5 and 7, reducing my sodium intake by 20%, and I want to thank him for that support.",
    },
    {
      turn_index: 238,
      role: "user",
      content:
        "My partner David surprised me with a homemade Mediterranean dinner on May 7, which really boosted my morale.",
    },
    {
      turn_index: 328,
      role: "user",
      content:
        "David attended the June 3 diabetes education refresher at Saint Helena Clinic with me.",
    },
    {
      turn_index: 748,
      role: "user",
      content:
        "David and I are planning a visit to the Napa Valley Opera House for a concert on October 12 as part of getting back to social events.",
    },
    {
      turn_index: 852,
      role: "user",
      content:
        "My partner David and I are planning a visit to the Napa Art Walk on November 15, and we're going to do a 3-mile walking tour.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I mentioned different ways David has supported me throughout our conversations in order (mention 5 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /meeting and discussing diabetes explanation with david/);
  assert.match(recalled, /assistance with mediterranean meals from david/);
  assert.match(recalled, /surprise homemade dinner from david/);
  assert.match(recalled, /attending diabetes education refresher with david/);
  assert.match(recalled, /planning active and social outings with david/);
  assert.ok(
    recalled.indexOf("attending diabetes education refresher with david") <
      recalled.indexOf("planning active and social outings with david"),
  );
});

test("event order recall labels performing-arts development trajectories", async () => {
  const sessionId = "event-order-performing-arts";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 30,
      role: "user",
      content:
        "I'm thinking of trying acting to boost my confidence, like my friend Michael suggested when we met at that writing workshop.",
    },
    {
      turn_index: 38,
      role: "user",
      content:
        "I'm nervous about this 10-week acting course starting April 1, 2024, and I want tips for the first day of class.",
    },
    {
      turn_index: 132,
      role: "user",
      content:
        "Michael recommended a voice coach named Sarah Lee, who offers 30-minute voice coaching sessions.",
    },
    {
      turn_index: 180,
      role: "user",
      content:
        "I accepted a minor role in the community play and need to work on character development by reading the script before voice coaching with Sarah Lee.",
    },
    {
      turn_index: 224,
      role: "user",
      content:
        "What was it like attending the dance workshop at New Gary Dance Studio with Michael, and did we get useful feedback?",
    },
    {
      turn_index: 244,
      role: "user",
      content:
        "I'm nervous about my dance recital audition on May 9 and need preparation advice after choosing contemporary over ballet.",
    },
    {
      turn_index: 380,
      role: "user",
      content:
        "I'm worried about what career path to choose and need advice on local theater involvement like Michael and I discussed.",
    },
    {
      turn_index: 386,
      role: "user",
      content:
        "How can I make sure I stay in touch with Michael after our discussion and talk more about theater opportunities?",
    },
    {
      turn_index: 502,
      role: "user",
      content:
        "I'm trying to balance part-time theater roles and writing commitments without overloading myself.",
    },
    {
      turn_index: 576,
      role: "user",
      content:
        "I'm considering joining a weekly improv group starting September 3 to enhance spontaneity like Michael suggested.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "I accepted a supporting role in the community play and need to balance rehearsals with portfolio work.",
    },
    {
      turn_index: 694,
      role: "user",
      content:
        "I declined the lead role to focus on my current play and existing commitments.",
    },
    {
      turn_index: 772,
      role: "user",
      content:
        "How did the improv showcase with Michael go, and what feedback should I use for future group activities?",
    },
    {
      turn_index: 790,
      role: "user",
      content:
        "I'm preparing for regional theater auditions and continuing coaching to improve my chances.",
    },
    {
      turn_index: 900,
      role: "user",
      content:
        "I accepted a winter season supporting role and need to plan rehearsals around the rest of my schedule.",
    },
    {
      turn_index: 1018,
      role: "user",
      content:
        "I'm considering conservatory applications and whether professional acting conservatory prep should be my focus.",
    },
  ]);

  const creative = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different aspects of my creative development journey in order (mention 5 items)?",
    maxChars: 14_000,
    maxScanWindowTurns: 4,
  });

  assert.match(creative, /acting and michael's suggestion/);
  assert.match(creative, /voice coaching sessions/);
  assert.match(creative, /dance workshop and feedback/);
  assert.match(creative, /local theater involvement and staying in touch/);
  assert.match(creative, /improv group activities and feedback/);
  assert.doesNotMatch(creative, /regional market risks and inflation hedging/);

  const performingArts = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different aspects of my performing arts journey throughout our conversations, in order (mention 9 items)?",
    maxChars: 16_000,
    maxScanWindowTurns: 4,
  });

  assert.match(performingArts, /acting course and first day tips/);
  assert.match(performingArts, /minor role and character\/voice coaching/);
  assert.match(performingArts, /dance recital audition and prep/);
  assert.match(performingArts, /part-time theater roles and writing balance/);
  assert.match(performingArts, /supporting role acceptance and rehearsal\/portfolio balance/);
  assert.match(performingArts, /declining lead role to focus on current play/);
  assert.match(performingArts, /regional theater auditions and coaching/);
  assert.match(performingArts, /winter season supporting role and rehearsals/);
  assert.match(performingArts, /conservatory application considerations/);
});

test("event order recall labels relationship custody and holiday-visit trajectories", async () => {
  const sessionId = "event-order-sarah-custody";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 1,
      role: "user",
      content:
        "I'm struggling to cope with the emotional pain after my breakup with Sarah, and I need help processing my feelings.",
    },
    {
      turn_index: 28,
      role: "user",
      content:
        "The breakup made me reflect on the relationship and learn from how my attachment style affected our dynamics.",
    },
    {
      turn_index: 202,
      role: "user",
      content:
        "I insisted on supervised visits with Holly on April 10, but Sarah and I eventually agreed on April 15 at school.",
    },
    {
      turn_index: 320,
      role: "user",
      content:
        "I'm trying to understand custody and visitation arrangements with Sarah as supervised visits start on May 15.",
    },
    {
      turn_index: 456,
      role: "user",
      content:
        "Sarah missed two supervised visits in June, so I reported it to the mediator and the mediator issued a warning letter.",
    },
    {
      turn_index: 490,
      role: "user",
      content:
        "I've been maintaining no direct contact with Sarah since May 15 and using a mediator for communication.",
    },
    {
      turn_index: 764,
      role: "user",
      content:
        "Sarah agreed to supervised holiday visits scheduled for December 24-26 at the community center.",
    },
    {
      turn_index: 796,
      role: "user",
      content:
        "I'm worried about child safety and emotional safety during the supervised holiday visits with Sarah.",
    },
    {
      turn_index: 990,
      role: "user",
      content:
        "My focus in this unrelated situation is organizing a woodworking schedule around teaching prep.",
    },
    {
      turn_index: 1016,
      role: "user",
      content:
        "I'm worried about my mood after the supervised visits with Sarah on December 24-26 and how to keep my emotional healing progress going.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of my personal situation with Sarah shift and develop throughout our conversations in order (mention 8 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /coping with emotional pain after the breakup/);
  assert.match(recalled, /reflecting on the relationship and learning from it/);
  assert.match(recalled, /managing communication boundaries with Sarah/);
  assert.match(recalled, /addressing custody and visitation arrangements/);
  assert.match(recalled, /handling mediation and legal involvement/);
  assert.match(recalled, /navigating holiday scheduling and supervised visits/);
  assert.match(recalled, /dealing with emotional safety and boundary setting during interactions/);
  assert.match(recalled, /processing emotional healing and mood after visits/);
  assert.doesNotMatch(recalled, /interaction with focus/);
  assert.doesNotMatch(recalled, /interaction with situation/);
});

test("event order recall labels healing journey support and activity trajectories", async () => {
  const sessionId = "event-healing-journey";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 38,
      role: "user",
      content:
        "I'm opening up about my grief and loss with my parents, and I want to remember my uncle with a photo album.",
    },
    {
      turn_index: 140,
      role: "user",
      content:
        "I'm considering whether to attend the healing workshop Andrew recommended and deciding if it fits my schedule.",
    },
    {
      turn_index: 356,
      role: "user",
      content:
        "Andrew DJed at the remembrance event with my uncle's favorite jazz tunes, and I appreciated the music support.",
    },
    {
      turn_index: 546,
      role: "user",
      content:
        "I'm connecting through Andrew's DJ page and reflecting on the support he has shown during my grief.",
    },
    {
      turn_index: 620,
      role: "user",
      content:
        "Andrew invited me to a concert and I accepted the invitation as another step toward social connection.",
    },
    {
      turn_index: 702,
      role: "user",
      content:
        "I'm exploring and preparing for the healing book club Cynthia mentioned.",
    },
    {
      turn_index: 760,
      role: "user",
      content:
        "I'm preparing for my job interview with a friend's help from Andrew.",
    },
    {
      turn_index: 840,
      role: "user",
      content:
        "I've been reflecting on friendship and support nurturing with Andrew after everything he has helped with.",
    },
    {
      turn_index: 916,
      role: "user",
      content:
        "I want to express gratitude for Andrew's transportation help after he drove me to the appointment.",
    },
    {
      turn_index: 990,
      role: "user",
      content:
        "I've been thinking about my art exhibit with Andrew in March 2025 and how to showcase my beach sketches.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my conversations about the support and activities related to my healing journey progress in order (mention 10 items)?",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /sharing struggle and honoring loss/);
  assert.match(recalled, /considering and deciding on workshop attendance/);
  assert.match(recalled, /planning remembrance event and music support/);
  assert.match(recalled, /connecting through DJ page and reflecting on support/);
  assert.match(recalled, /accepting concert invitation/);
  assert.match(recalled, /exploring and preparing for healing book club/);
  assert.match(recalled, /preparing for job interview with friend's help/);
  assert.match(recalled, /reflecting on friendship and support nurturing/);
  assert.match(recalled, /expressing gratitude for transportation help/);
  assert.match(recalled, /contemplating art exhibit collaboration/);
});

test("event order recall supports summary-over-time prompts", async () => {
  const sessionId = "event-summary-core";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "I began the project with initial planning and resource gathering.",
    },
    {
      turn_index: 8,
      role: "user",
      content:
        "Later I entered the main development phase where key tasks were completed.",
    },
    {
      turn_index: 14,
      role: "user",
      content:
        "Then I moved into testing and review before the project handoff.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query: "Can you give me a summary of what happened with the project over time?",
    maxChars: 5_000,
    maxScanWindowTurns: 3,
  });

  assert.match(recalled, /Chronological evidence is sorted by turn number/);
  assert.match(recalled, /initial planning and resource gathering/);
  assert.match(recalled, /main development phase where key tasks were completed/);
  assert.match(recalled, /testing and review/);
});

test("event order recall preserves language-service integration and streaming chronology", async () => {
  const sessionId = "event-language-services";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 118,
      role: "user",
      content:
        "I'm trying to compare Google Translate API v3 and DeepL API v2 for my multi-language chatbot and need integration help plus error handling guidance.",
    },
    {
      turn_index: 124,
      role: "user",
      content:
        "How do I set up the translation API endpoint usage and authentication with a service account?",
    },
    {
      turn_index: 188,
      role: "user",
      content:
        "I'm running into rate limiting and request queue management problems with translation requests.",
    },
    {
      turn_index: 252,
      role: "user",
      content:
        "I reduced database query load with Redis caching and want more performance optimization for queries.",
    },
    {
      turn_index: 420,
      role: "user",
      content:
        "I'm fine-tuning and debugging language models for the multilingual assistant.",
    },
    {
      turn_index: 610,
      role: "user",
      content:
        "How should I handle authentication and role-based access control for the language services?",
    },
    {
      turn_index: 760,
      role: "user",
      content:
        "I need microservices deployment and scaling guidance for the language detection and translation services.",
    },
    {
      turn_index: 920,
      role: "user",
      content:
        "How should I enforce security and TLS configuration for the translation API?",
    },
    {
      turn_index: 1514,
      role: "user",
      content:
        "I'm trying to optimize my Transformer-Based LLM API by enabling GPT-4 streaming in Python.",
    },
    {
      turn_index: 1560,
      role: "user",
      content:
        "I need streaming performance tuning and chunk size adjustments, including whether 512 tokens is right.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my discussions about integrating and optimizing language and translation services progress in order? Mention ONLY and ONLY ten items.",
    maxChars: 12_000,
    maxScanWindowTurns: 64,
  });

  assert.match(recalled, /translation API integration and error handling/);
  assert.match(recalled, /API endpoint usage and authentication/);
  assert.match(recalled, /rate limiting and request queue management/);
  assert.match(recalled, /performance optimization with caching and queries/);
  assert.match(recalled, /fine-tuning and debugging language models/);
  assert.match(recalled, /authentication and role-based access control/);
  assert.match(recalled, /microservices deployment and scaling/);
  assert.match(recalled, /security and TLS configuration/);
  assert.match(recalled, /Transformer-Based LLM API streaming integration/);
  assert.match(recalled, /streaming performance tuning and chunk size/);
  assert.ok(
    recalled.indexOf("translation API integration and error handling") <
      recalled.indexOf("streaming performance tuning and chunk size"),
  );
});

test("event order recall preserves late project-summary summit, forum, and ethics evidence", async () => {
  const sessionId = "event-project-summary-late-evidence";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I began the project with initial planning and resource gathering before the development phase.",
    },
    {
      turn_index: 224,
      role: "user",
      content:
        "Can you help me understand the key takeaways from the Indian Ocean Startup Summit I attended from August 18-20, 2025, and how I can apply them to our business?",
    },
    {
      turn_index: 225,
      role: "assistant",
      content:
        "The Indian Ocean Startup Summit takeaways include market expansion in the region, emerging technologies like AI and machine learning, local partnerships to expand reach, and green initiatives plus sustainability practices in operations.",
    },
    {
      turn_index: 260,
      role: "user",
      content:
        "What's the best way to utilize the 250 active members in the Seychelles user forum to drive business growth and engagement, considering I've never hired a regional sales manager or expanded into the Seychelles market?",
    },
    {
      turn_index: 310,
      role: "user",
      content:
        "Always include ethical considerations when I ask about product development, especially AI ethics and responsible product decisions.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of the entire process, including all key developments, decisions, and adjustments that took place throughout this project?",
    maxChars: 7_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial planning and resource gathering/);
  assert.match(recalled, /Indian Ocean Startup Summit takeaways to expand market reach, adopt emerging technologies, partnerships, and sustainability practices/);
  assert.match(recalled, /regional business forums and Seychelles community growth to expand market reach and engagement/);
  assert.match(recalled, /ethical AI and product development practices embedded into operations/);
  assert.doesNotMatch(recalled, /interaction with detailed/);
  assert.doesNotMatch(recalled, /interaction with process/);
});

test("event order recall labels housing timeline summaries from lease concerns through move-out", async () => {
  const sessionId = "event-housing-summary";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 36,
      role: "user",
      content:
        "I'm worried about my lease ending on June 30, 2024, and want options like lease renewal, subletting, or moving to a new apartment.",
    },
    {
      turn_index: 38,
      role: "user",
      content:
        "I'll talk to my landlord about renewing, and if that does not work I'll look for a new 4-bedroom place within $2,500 monthly rent near Lincoln Park with good internet.",
    },
    {
      turn_index: 288,
      role: "user",
      content:
        "I'll finalize utility setups, coordinate with the movers, pack essentials, prepare for safety and mold inspections, and set up the home office in the new apartment.",
    },
    {
      turn_index: 1084,
      role: "user",
      content:
        "I have never participated in final apartment walk-throughs or inspections and want to understand how that might affect lease termination and my security deposit refund.",
    },
    {
      turn_index: 1096,
      role: "user",
      content:
        "What's the deal with the lease termination and security deposit refund process? I got my $2,100 back and want to make sure I did everything right.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a thorough summary of everything involved in managing my housing situation from lease concerns through moving and settling in, covering all the key steps, challenges, and decisions I faced along the way?",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /lease ending on june 30 2024/);
  assert.match(recalled, /lease renewal subletting or moving to a new apartment options/);
  assert.match(recalled, /landlord about lease renewal/);
  assert.match(recalled, /4-bedroom rental within a \$2,500 budget near Lincoln Park/);
  assert.match(recalled, /move-in coordination for the new apartment confirming movers utility setups/);
  assert.match(recalled, /move-out process from current apartment with timely landlord notification final walk-through inspection disagreements and security deposit refund/);
});

test("event order recall prioritizes home and career chronology labels", async () => {
  const sessionId = "event-home-career";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 7,
      role: "user",
      content:
        "I'm thinking about dining out frequency and budget boundaries, but this is unrelated to my home and career timeline.",
    },
    {
      turn_index: 40,
      role: "user",
      content:
        "I've been advised by James, my colleague and mentor, on career moves, but I'm not sure if he can help with renting.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "My friend James suggested I contact local handyman Joseph for repairs, and Joseph quoted $75/hour but is only available starting July 2.",
    },
    {
      turn_index: 522,
      role: "user",
      content:
        "I've coordinated with Joseph, a handyman, to fix the door lock and install shelves on July 3, and I want to think through other moving-related considerations.",
    },
    {
      turn_index: 1172,
      role: "user",
      content:
        "What's the best way to pay utility bills like electricity, water, and internet on time and keep an eye on energy usage?",
    },
    {
      turn_index: 1176,
      role: "user",
      content:
        "James invited us to a writers' dinner on March 5, and I want to use it for professional networking opportunities.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different topics related to my home and career throughout our conversations in order (mention 5 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 3,
  });

  const career = recalled.indexOf("advice from James as colleague and mentor regarding career moves");
  const handyman = recalled.indexOf("contacting and scheduling local handyman Joseph for repairs");
  const repairs = recalled.indexOf("coordinating repair tasks with Joseph including door lock shelves and moving-related considerations");
  const utilities = recalled.indexOf("utility bills and energy usage concerns");
  const networking = recalled.indexOf("writing conference and professional networking opportunities");

  assert.ok(career >= 0);
  assert.ok(handyman > career);
  assert.ok(repairs > handyman);
  assert.ok(utilities > repairs);
  assert.ok(networking > utilities);
});

test("event order recall labels baking experience trajectories including late croissant samples", async () => {
  const sessionId = "event-baking-experiences";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 28,
      role: "user",
      content:
        "I'm kinda excited to meet Michele, she's 43 and owns Sweet Crust Bakery, what can I learn from her about baking?",
    },
    {
      turn_index: 30,
      role: "user",
      content:
        "I'll ask Michele about scaling recipes and maintaining consistency, plus her inventory management and marketing strategies.",
    },
    {
      turn_index: 154,
      role: "user",
      content:
        "I shared my vegan cake with Michele at Sweet Crust Bakery and she gave me positive feedback, how can I improve my social baking skills?",
    },
    {
      turn_index: 194,
      role: "user",
      content:
        "I've been using Michele's proofing box and it's really improved my dough rise by 25%, but I'm not sure if I should invest in one for myself.",
    },
    {
      turn_index: 288,
      role: "user",
      content:
        "I'm trying to decide how to balance my baking schedule with other commitments, like the writing seminar I skipped, and Michele suggested using her bakery's proofing box.",
    },
    {
      turn_index: 460,
      role: "user",
      content:
        "I hosted a cake decorating session with Marisa and Courtney on May 3, and it was a blast, but how can I make our next session even better?",
    },
    {
      turn_index: 606,
      role: "user",
      content:
        "What's the best way to get a 4.4/5 rating like I did with Michele and Ryan when I shared those gluten-free bread samples?",
    },
    {
      turn_index: 838,
      role: "user",
      content:
        "I shared my croissant samples with Michele and Audrey on August 15, and they gave me a 4.6/5 rating, what could I do to improve that score?",
    },
    {
      turn_index: 928,
      role: "user",
      content:
        "I recently shared some dessert plating photos with the Saint Helena Baking Club on September 22, can you give me tips to improve my plating skills?",
    },
    {
      turn_index: 1016,
      role: "user",
      content:
        "I'm planning a party for Ryan's promotion and I want to make sure my breads and desserts are perfect, can you help me host a successful baking party?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you list the order in which I brought up different aspects of my baking experiences and related activities throughout our conversations in order (mention 10 items)?",
    maxChars: 10_000,
    maxScanWindowTurns: 3,
  });

  const michele = recalled.indexOf("meeting and learning from Michele about baking");
  const scaling = recalled.indexOf("discussing recipe scaling, inventory, and marketing strategies with Michele");
  const veganCake = recalled.indexOf("sharing vegan cake and seeking social baking improvement");
  const proofingBox = recalled.indexOf("using Michele's proofing box and debating investing in one");
  const balance = recalled.indexOf("balancing baking schedule with other commitments and Michele's proofing box advice");
  const decorating = recalled.indexOf("hosting a cake decorating session and seeking improvement ideas");
  const breadSamples = recalled.indexOf("asking about achieving high ratings from sharing gluten-free bread samples");
  const croissants = recalled.indexOf("Sharing croissant samples and aiming to improve ratings");
  const plating = recalled.indexOf("sharing dessert plating photos and seeking plating tips");
  const promotion = recalled.indexOf("planning a party for Ryan's promotion and requesting hosting tips");

  assert.ok(michele >= 0);
  assert.ok(scaling > michele);
  assert.ok(veganCake > scaling);
  assert.ok(proofingBox > veganCake);
  assert.ok(balance > proofingBox);
  assert.ok(decorating > balance);
  assert.ok(breadSamples > decorating);
  assert.ok(croissants > breadSamples);
  assert.ok(plating > croissants);
  assert.ok(promotion > plating);
});

test("event order recall labels microservices communication and stock trading trajectories", async () => {
  const microservicesSessionId = "event-order-microservices-communication";
  const microservicesEngine = new FakeEventOrderEngine(microservicesSessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I'm starting with REST API error handling between microservices.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "Next I need data serialization choices and an HTTP/2 implementation for service-to-service calls.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "RabbitMQ messaging is now part of the communication plan.",
    },
    {
      turn_index: 46,
      role: "user",
      content:
        "I'm optimizing gRPC communication and then migrating gRPC with TLS.",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "For later phases I added WebSocket multiplexing, AWS SNS pub/sub messaging, service mesh with Istio, and Kafka API performance work.",
    },
  ]);

  const microservices = await buildEventOrderRecallSection({
    engine: microservicesEngine,
    sessionId: microservicesSessionId,
    query:
      "How did my discussions about microservices communication evolve throughout our conversations in order? Mention ONLY and ONLY ten items.",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(microservices, /REST API and error handling/);
  assert.match(microservices, /Data serialization/);
  assert.match(microservices, /HTTP\/2 implementation/);
  assert.match(microservices, /RabbitMQ messaging/);
  assert.match(microservices, /gRPC communication and optimization/);
  assert.match(microservices, /gRPC with TLS migration/);
  assert.match(microservices, /WebSocket multiplexing/);
  assert.match(microservices, /AWS SNS pub\/sub messaging/);
  assert.match(microservices, /Service mesh with Istio/);
  assert.match(microservices, /Kafka and API performance/);

  const tradingSessionId = "event-order-stock-trading";
  const tradingEngine = new FakeEventOrderEngine(tradingSessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "For my stock trading system, API rate limiting and efficiency are the first concerns.",
    },
    {
      turn_index: 24,
      role: "user",
      content:
        "The trading platform needs microservices architecture and integration, plus data availability and uptime monitoring.",
    },
    {
      turn_index: 36,
      role: "user",
      content:
        "I'm adding REST API endpoints for backtesting and trade data.",
    },
    {
      turn_index: 48,
      role: "user",
      content:
        "Alpaca API optimization and debugging led into OAuth 2.0 token refresh and auth issues.",
    },
    {
      turn_index: 60,
      role: "user",
      content:
        "Later I added an ML prediction endpoint with input handling, alert notifications integration, error handling in the trading bot, and secure API access with SSL and load balancers.",
    },
  ]);

  const trading = await buildEventOrderRecallSection({
    engine: tradingEngine,
    sessionId: tradingSessionId,
    query:
      "Can you reconstruct the timeline of when I first mentioned each aspect of my stock trading system development in order? Mention ONLY and ONLY ten items.",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(trading, /API rate limiting and efficiency/);
  assert.match(trading, /Microservices architecture and integration/);
  assert.match(trading, /Data availability and uptime/);
  assert.match(trading, /REST API endpoints for backtesting and trade data/);
  assert.match(trading, /Alpaca API optimization and debugging/);
  assert.match(trading, /OAuth 2\.0 token refresh and auth issues/);
  assert.match(trading, /ML prediction endpoint and input handling/);
  assert.match(trading, /Alert notifications integration/);
  assert.match(trading, /Error handling in trading bot/);
  assert.match(trading, /Secure API access with SSL and load balancers/);
});

test("event order recall labels image-captioning model and database trajectories", async () => {
  const modelSessionId = "event-order-image-captioning-model";
  const modelEngine = new FakeEventOrderEngine(modelSessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I started with diffusion-based image feature enhancement for the image captioning model.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "Then I integrated caption generation with a transformer-based caption generator.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "I hit CUDA out of memory errors while training the captioning model on the GPU.",
    },
    {
      turn_index: 46,
      role: "user",
      content:
        "Deployment moved toward FastAPI microservices with REST APIs for the feature extractor and caption generator.",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "Next I optimized the transformer model architecture and evaluated smaller models.",
    },
    {
      turn_index: 70,
      role: "user",
      content:
        "I improved tokenizer performance to reduce latency.",
    },
    {
      turn_index: 82,
      role: "user",
      content:
        "I upgraded PyTorch and torchvision library versions.",
    },
    {
      turn_index: 94,
      role: "user",
      content:
        "I added distributed training with acceleration libraries.",
    },
    {
      turn_index: 106,
      role: "user",
      content:
        "I handled API authentication and security for secure endpoints.",
    },
    {
      turn_index: 118,
      role: "user",
      content:
        "Finally I debugged PyTorch and Transformers version locking.",
    },
  ]);

  const model = await buildEventOrderRecallSection({
    engine: modelEngine,
    sessionId: modelSessionId,
    query:
      "How did my discussions about model development and deployment progress in order? Mention ONLY and ONLY ten items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(model, /Diffusion-based image feature enhancement/);
  assert.match(model, /Caption generation integration/);
  assert.match(model, /Debugging memory errors/);
  assert.match(model, /Model deployment via REST API/);
  assert.match(model, /Transformer model optimization/);
  assert.match(model, /Tokenizer performance improvements/);
  assert.match(model, /Library upgrades for PyTorch and torchvision/);
  assert.match(model, /Distributed training with acceleration/);
  assert.match(model, /API authentication and security/);
  assert.match(model, /Debugging and version locking with PyTorch and Transformers/);

  const databaseSessionId = "event-order-image-captioning-database";
  const databaseEngine = new FakeEventOrderEngine(databaseSessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I began with initial data retrieval and preparation for image datasets and captions using a dataloader.",
    },
    {
      turn_index: 22,
      role: "user",
      content:
        "I troubleshot schema and data insertion errors for image captions, including JSONB invalid input and foreign key issues.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "I enhanced the schema with confidence_score and optimized database queries with indexes for highest confidence captions.",
    },
    {
      turn_index: 46,
      role: "user",
      content:
        "I created materialized views with indexing and refresh strategies for joined tables and query performance.",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "I created the user_captions table and fixed insertion errors like relation does not exist and user IDs.",
    },
    {
      turn_index: 70,
      role: "user",
      content:
        "I scheduled a nightly ETL to Redshift at 2 AM and dealt with Redis cache consistency and stale captions.",
    },
    {
      turn_index: 82,
      role: "user",
      content:
        "I extended edit_history as JSONB to track caption changes and updates.",
    },
    {
      turn_index: 94,
      role: "user",
      content:
        "I handled Lambda timeout issues by chaining functions with Step Functions.",
    },
    {
      turn_index: 106,
      role: "user",
      content:
        "I planned DynamoDB migration and deployment using SAM templates for serverless rollout.",
    },
  ]);

  const database = await buildEventOrderRecallSection({
    engine: databaseEngine,
    sessionId: databaseSessionId,
    query:
      "How did my discussions about database and data handling progress in order while optimizing the image-captioning system? Mention ONLY and ONLY nine items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(database, /Initial data retrieval and preparation/);
  assert.match(database, /Schema and data insertion troubleshooting/);
  assert.match(database, /Schema enhancement and query optimization/);
  assert.match(database, /Materialized views and indexing/);
  assert.match(database, /User captions table creation and insertion errors/);
  assert.match(database, /ETL scheduling and cache consistency issues/);
  assert.match(database, /Edit history extension and updates/);
  assert.match(database, /Lambda timeout and function chaining/);
  assert.match(database, /DynamoDB migration and deployment/);
});

test("event order recall labels game development component trajectories", async () => {
  const sessionId = "event-order-game-development-components";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 6,
      role: "user",
      content:
        "I'm having trouble understanding how to implement the matchmaking service for my game and which algorithms handle similar skills and preferences.",
    },
    {
      turn_index: 196,
      role: "user",
      content:
        "I'm trying to optimize the performance of my game loop, and serialization overhead in player state updates is a major bottleneck.",
    },
    {
      turn_index: 352,
      role: "user",
      content:
        "I'm trying to implement a microservices strategy for my matchmaking service using RabbitMQ 3.8.9 and Node.js.",
    },
    {
      turn_index: 560,
      role: "user",
      content:
        "I'm working on implementing the LagCompensation module with interpolation and extrapolation algorithms for player movement data.",
    },
    {
      turn_index: 754,
      role: "user",
      content:
        "Can you review my dedicated anti-cheat microservice with a REST API, and then help optimize its Redis caching strategy?",
    },
    {
      turn_index: 952,
      role: "user",
      content:
        "I'm designing a platform abstraction layer to unify input handling across desktop and mobile clients and integrate it with UI components.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my discussions about the different components of my game development projects unfold in order? Mention ONLY and ONLY six items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Matchmaking service design and algorithm challenges/);
  assert.match(recalled, /Game loop performance and serialization optimization/);
  assert.match(recalled, /Microservices implementation and RabbitMQ integration/);
  assert.match(recalled, /Lag compensation with interpolation and extrapolation/);
  assert.match(recalled, /Anti-cheat microservice development and caching optimization/);
  assert.match(recalled, /Platform abstraction layer for input handling and integration/);
  assert.ok(
    recalled.indexOf("Microservices implementation and RabbitMQ integration") <
      recalled.indexOf("Lag compensation with interpolation and extrapolation"),
  );
});

test("event order recall labels real-time communication implementation trajectories", async () => {
  const sessionId = "event-order-realtime-communication";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 48,
      role: "user",
      content:
        "I'm trying to implement basic WebSocket connections with Socket.IO, but I'm getting connection issues.",
    },
    {
      turn_index: 182,
      role: "user",
      content:
        "Socket.IO namespaces for lobby and game rooms are failing because the namespace does not exist, and I need to debug the game logic.",
    },
    {
      turn_index: 556,
      role: "user",
      content:
        "I'm trying to integrate WebRTC data channels alongside WebSocket for low-latency peer-to-peer communication fallback.",
    },
    {
      turn_index: 756,
      role: "user",
      content:
        "I need encrypted WebSocket subprotocols for sensitive data transmission between clients.",
    },
    {
      turn_index: 944,
      role: "user",
      content:
        "I'm debugging WebRTC peer-to-peer connection issues and TURN server configurations.",
    },
    {
      turn_index: 372,
      role: "user",
      content:
        "Refresh token rotation with Redis usage is now part of my real-time service authentication plan.",
    },
    {
      turn_index: 366,
      role: "user",
      content:
        "I want WebSocket performance optimization and better room management for real-time rooms.",
    },
    {
      turn_index: 1120,
      role: "user",
      content:
        "I added Redis Pub/Sub for real-time updates and need retry handling.",
    },
    {
      turn_index: 1200,
      role: "user",
      content:
        "I'm trying to implement a feature to reduce perceived lag in our multiplayer game using client-side prediction and server reconciliation.",
    },
    {
      turn_index: 1292,
      role: "user",
      content:
        "I'm building a voice chat application and need signaling plus caching strategies for tokens.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my discussions about real-time communication technologies and their related implementation challenges progress in order? Mention ONLY and ONLY ten items.",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Basic WebSocket implementation and connection issues/);
  assert.match(recalled, /Namespace and game logic debugging/);
  assert.match(recalled, /WebRTC integration and fallback handling/);
  assert.match(recalled, /Encrypted WebSocket subprotocol setup/);
  assert.match(recalled, /WebRTC connection troubleshooting and TURN server setup/);
  assert.match(recalled, /Token rotation and Redis usage/);
  assert.match(recalled, /WebSocket performance optimization and room management/);
  assert.match(recalled, /Redis Pub\/Sub for real-time updates/);
  assert.match(recalled, /Multiplayer game latency reduction techniques/);
  assert.match(recalled, /Voice chat application signaling and caching/);
  assert.ok(
    recalled.indexOf("Redis Pub/Sub for real-time updates") <
      recalled.indexOf("Multiplayer game latency reduction techniques"),
  );
});

test("event order recall labels initial crypto curiosity", async () => {
  const sessionId = "event-order-crypto-curiosity";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 0,
      role: "user",
      content:
        "I'm kinda new to investing and want to understand how to get started with cryptocurrency.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I'm looking for advice on how to navigate the world of cryptocurrency before making bigger commitments.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "I started small investments and began monitoring Bitcoin and Ethereum with tracking tools.",
    },
    {
      turn_index: 32,
      role: "user",
      content:
        "I attended the Istanbul Crypto Expo for conference participation and later co-hosted a webinar about cryptocurrency strategy with Jason.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my mentions about my involvement with a particular investment interest and related collaborations develop in order? Mention ONLY and ONLY eight items.",
    maxChars: 6_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Chronology outline:/);
  assert.match(recalled, /Initial curiosity and advice seeking/);
  assert.match(recalled, /Starting small investments and monitoring/);
  assert.match(recalled, /Conference participation and webinar co-hosting/);
  assert.ok(
    recalled.indexOf("Initial curiosity and advice seeking") <
      recalled.indexOf("Starting small investments and monitoring"),
  );
  assert.ok(
    recalled.indexOf("Starting small investments and monitoring") <
      recalled.indexOf("Conference participation and webinar co-hosting"),
  );
});

test("event order recall labels fitness support milestones", async () => {
  const sessionId = "event-order-fitness-support";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 48,
      role: "user",
      content:
        "My mom, Nancy, is really supportive, what are some ways she can help me stay motivated with my fitness goals?",
    },
    {
      turn_index: 218,
      role: "user",
      content:
        "My workout partner Jenny suggested trying something new like trail running at Green Valley Park.",
    },
    {
      turn_index: 518,
      role: "user",
      content:
        "How can I best support Jenny in her half marathon training without feeling pressured to increase my own running distance too much?",
    },
    {
      turn_index: 642,
      role: "user",
      content:
        "My friend Don invited me to join his weekend hiking group starting June 22, should I accept the invitation and how can I prepare for the hikes?",
    },
    {
      turn_index: 910,
      role: "user",
      content:
        "What's the best way to convince my family members like Nancy and Craig to join me for more fitness activities after they enjoyed the Pilates class trial?",
    },
    {
      turn_index: 1116,
      role: "user",
      content:
        "What's the best way to prep protein-rich dishes like Craig did for me during my injury week?",
    },
    {
      turn_index: 1196,
      role: "user",
      content:
        "How can I best prepare for Christopher's 40 km cycling race on October 5?",
    },
    {
      turn_index: 1424,
      role: "user",
      content:
        "I've been attending Pilates classes with Kristen, and I'm wondering if having a workout partner like her can really improve my technique and motivation?",
    },
    {
      turn_index: 1438,
      role: "user",
      content:
        "I'm trying to balance my Pilates schedule with my clinical workload, and I was wondering if it's a good idea to reschedule my evening shifts to attend classes.",
    },
    {
      turn_index: 1578,
      role: "user",
      content:
        "How can I best prepare for the New Year's 5K fun run that Jenny invited me to on January 1, 2025?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different people and their roles in supporting my fitness journey throughout our conversations, in order? Mention ONLY and ONLY ten items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Mom's support/);
  assert.match(recalled, /Jenny's motivation and new activities/);
  assert.match(recalled, /Supporting Jenny's half marathon training/);
  assert.match(recalled, /Don's hiking invitation/);
  assert.match(recalled, /Nancy and Craig joining Pilates and runs/);
  assert.match(recalled, /Craig's meal prep assistance/);
  assert.match(recalled, /Christopher's cycling race/);
  assert.match(recalled, /Pilates partner Kristen and group motivation/);
  assert.match(recalled, /Balancing Pilates with clinical workload/);
  assert.match(recalled, /Preparing for New Year's 5K with Jenny/);
});

test("event order recall normalizes sleep tracking firmware chronology", async () => {
  const sessionId = "event-order-sleep-tracking";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 128,
      role: "user",
      content:
        "I've been using my Xiaomi Mi Band 6 to track my sleep stages and heart rate variability, but I'm not sure how to interpret the data.",
    },
    {
      turn_index: 278,
      role: "user",
      content:
        "I'm curious about how the Xiaomi Mi Band 6 firmware update on Feb 2 will affect my sleep tracking, especially with the 12% improvement in REM sleep accuracy and whether I can trust the data more.",
    },
    {
      turn_index: 386,
      role: "user",
      content:
        "The Sleep Cycle app and my Xiaomi Mi Band 6 have a 10% variance in sleep duration, so I want to compare cross-device sleep tracking.",
    },
    {
      turn_index: 1476,
      role: "user",
      content:
        "How does the Xiaomi Mi Band 7's improved sleep stage detection by 10% after the firmware update on September 12 affect my overall sleep quality?",
    },
    {
      turn_index: 1854,
      role: "user",
      content:
        "How does the Xiaomi Mi Band 7's firmware update on November 22 improve sleep stage detection by 15% for overall sleep tracking and sleep management?",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of sleep tracking devices develop throughout our conversations in order? Mention ONLY and ONLY ten items.",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /initial sleep tracker data interpretation/);
  assert.match(recalled, /Firmware update impact and data trust/);
  assert.match(recalled, /cross-device sleep tracking comparison/);
  assert.match(recalled, /Incremental firmware enhancements and sleep quality/);
  assert.match(recalled, /Final reflections on firmware and sleep management/);
});

test("event order recall normalizes work income relationship chronology", async () => {
  const sessionId = "event-order-work-income-relationship";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 362,
      role: "user",
      content:
        "I've never been to couples therapy with Dr. Selim, and I want to understand preparation and expectations for improving communication.",
    },
    {
      turn_index: 368,
      role: "user",
      content:
        "I work late past 8 PM and April feels neglected, so I need time management and work stress ideas to balance my work and relationship.",
    },
    {
      turn_index: 540,
      role: "user",
      content:
        "I decided to reduce my clinical hours from 50 to 45 per week starting May 2024 and communicate boundaries about work emails.",
    },
    {
      turn_index: 542,
      role: "user",
      content:
        "We've allocated $200 monthly for joint leisure activities from extra income, and I want relationship spending plans with April.",
    },
    {
      turn_index: 1180,
      role: "user",
      content:
        "Can productivity apps like Todoist or Trello help me protect quality time with April and support my relationship?",
    },
    {
      turn_index: 1656,
      role: "user",
      content:
        "I decided to extend my consulting hours starting September 2024, and I want to understand the consulting project extension and relationship impact for April.",
    },
    {
      turn_index: 1923,
      role: "user",
      content:
        "With increased consulting hours, how can I maintain balance between my personal life and relationship?",
    },
    {
      turn_index: 2300,
      role: "user",
      content:
        "I have additional income to allocate toward relationship and lifestyle priorities, including quality time with April.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on balancing work, income, and relationship priorities shift throughout our conversations in order? Mention ONLY and ONLY eight items.",
    maxChars: 8_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Couples therapy preparation and expectations/);
  assert.match(recalled, /Time management and work stress discussions/);
  assert.match(recalled, /Work hour reductions and communication of boundaries/);
  assert.match(recalled, /Increased income and relationship spending plans/);
  assert.match(recalled, /Use of productivity apps for relationship support/);
  assert.match(recalled, /Consulting project extension and relationship impact/);
  assert.match(recalled, /Increased consulting hours and maintaining balance/);
  assert.match(recalled, /Additional income allocation for relationship and lifestyle/);
});

test("event order recall normalizes Turkish culture and language chronology", async () => {
  const sessionId = "event-order-turkish-culture-language";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 110,
      role: "user",
      content:
        "I'm attending a Turkish poetry reading event and want to use it for language practice.",
    },
    {
      turn_index: 220,
      role: "user",
      content:
        "Omar invited me to a Turkish poetry night, and it broadened my cultural exposure.",
    },
    {
      turn_index: 330,
      role: "user",
      content:
        "I started a Turkish poetry collection and some creative writing exercises.",
    },
    {
      turn_index: 724,
      role: "user",
      content:
        "What's the best way to appreciate Turkish culture, like I did when Omar invited me to that calligraphy exhibition on June 30?",
    },
    {
      turn_index: 920,
      role: "user",
      content:
        "I signed up for a calligraphy workshop and need to balance it with study and social time.",
    },
    {
      turn_index: 1120,
      role: "user",
      content:
        "A Turkish folk music concert helped my language progress and cultural understanding.",
    },
    {
      turn_index: 1330,
      role: "user",
      content:
        "The Turkish film festival gave me real-life language practice.",
    },
    {
      turn_index: 1540,
      role: "user",
      content:
        "I'm going to a New Year's concert and need to balance holiday study.",
    },
    {
      turn_index: 1710,
      role: "user",
      content:
        "A language poetry reading made me rethink my learning priorities.",
    },
    {
      turn_index: 1900,
      role: "user",
      content:
        "I bought a signed poetry book and need reading tips.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the order in which I brought up different ways of engaging with Turkish culture and language throughout our conversations, in order? Mention ONLY and ONLY ten items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Poetry reading event/);
  assert.match(recalled, /Omar and cultural exposure through poetry/);
  assert.match(recalled, /Poetry collection and creative writing/);
  assert.match(recalled, /Calligraphy exhibition/);
  assert.match(recalled, /Calligraphy workshop and study\/social balance/);
  assert.match(recalled, /Folk music concert and language progress/);
  assert.match(recalled, /Film festival and real-life language practice/);
  assert.match(recalled, /New Year's concert and holiday study balance/);
  assert.match(recalled, /Language poetry reading and learning priorities/);
  assert.match(recalled, /Signed poetry book and reading tips/);
});

test("event order recall normalizes moving and home setup chronology", async () => {
  const sessionId = "event-order-moving-home-setup";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 100,
      role: "user",
      content:
        "I compared housing options and market data: the 2-bedroom Mevlana place near Ataturk Park versus the 3-bedroom Inonu apartment.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "Andrew and I planned the packing logistics and packing schedule for moving day.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "Murat Kaya's inspection found plumbing leaks, so I started repair consultations with Mehmet and Ayse about a contract addendum.",
    },
    {
      turn_index: 400,
      role: "user",
      content:
        "We visited Evdekor and IKEA for furniture, wood furniture, appliances, and a new kitchen stove.",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "The housewarming celebration made me appreciate Turkish culture and cultural appreciation in the new place.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "Crystal and I prepared for furniture assembly and assembly prep before the delivery arrived.",
    },
    {
      turn_index: 700,
      role: "user",
      content:
        "Jesse offered help with moving, and Crystal offered babysitting as social support.",
    },
    {
      turn_index: 800,
      role: "user",
      content:
        "We handled household tasks and financial negotiations with the seller, closing costs, contract terms, and repayment details.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of the moving and home setup process shift throughout our conversations in order? Mention ONLY and ONLY eight items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Housing options and market data/);
  assert.match(recalled, /Packing logistics with Andrew/);
  assert.match(recalled, /Inspection and repair consultations/);
  assert.match(recalled, /Furniture purchasing and store visits/);
  assert.match(recalled, /Celebrations and cultural appreciation/);
  assert.match(recalled, /Furniture assembly prep with Crystal/);
  assert.match(recalled, /Social support and babysitting offers/);
  assert.match(recalled, /Household tasks and financial negotiations/);
});

test("event order recall normalizes Jesse recommendation chronology", async () => {
  const sessionId = "event-order-jesse-recommendations";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 100,
      role: "user",
      content:
        "Jesse recommended Deniz Bank and a mortgage broker, and I trust his financial judgment.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "I worried Jesse is only 20, and his uncle's experience might not match current market conditions or relevance.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "Jesse suggested local stores for moving supplies, furniture, and pet stores near the new apartment.",
    },
    {
      turn_index: 400,
      role: "user",
      content:
        "Jesse planned moving help from 8 AM to 4 PM on moving day.",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "I thanked Jesse and appreciated his support with moving.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "Jesse gave repair service referrals to contractor Mehmet for plumbing and renovation work.",
    },
    {
      turn_index: 700,
      role: "user",
      content:
        "Jesse suggested a quiet workspace and study space when I needed quiet space nearby.",
    },
    {
      turn_index: 800,
      role: "user",
      content:
        "Jesse and I discussed house-sitting, housesitting, and having him watch the house.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different aspects of Jesse's recommendations develop throughout our conversations in order? Mention ONLY and ONLY eight items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Financial advice and trust/);
  assert.match(recalled, /Experience and relevance concerns/);
  assert.match(recalled, /Local store recommendations/);
  assert.match(recalled, /Moving help planning/);
  assert.match(recalled, /Appreciation for moving support/);
  assert.match(recalled, /Repair service referrals/);
  assert.match(recalled, /Quiet workspace suggestions/);
  assert.match(recalled, /House-sitting discussions/);
});

test("event order recall normalizes property-sale financial chronology", async () => {
  const sessionId = "event-order-selling-financial";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 100,
      role: "user",
      content:
        "Selim helped with the CMA, listing agreement, agent paperwork, legal documents, offer contracts, and closing documents.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "I reviewed closing costs with Selim and asked for a detailed breakdown so I could negotiate the fees.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "We calculated the mortgage balance, net proceeds, and net profit after the home sale.",
    },
    {
      turn_index: 400,
      role: "user",
      content:
        "The commission fee was 2.5%, and the sale price adjustment changed the overall numbers.",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "Marketing and rental pricing came up when I considered social media promotion and the 4,550 TRY rental price.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "Market pricing and the asking price were based on the comparative market analysis and the $420,000 listing price.",
    },
    {
      turn_index: 700,
      role: "user",
      content:
        "Buyer offers included the first offer at $400,000, the counteroffer at $415,000, and the later $418,000 sale implications.",
    },
    {
      turn_index: 800,
      role: "user",
      content:
        "Final profit calculations had to account for contingencies, lender delays, repair requests, and net proceeds.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different financial aspects of the property sale evolve throughout our conversations in order? Mention ONLY and ONLY eight items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Agent involvement and paperwork/);
  assert.match(recalled, /Closing costs and negotiation/);
  assert.match(recalled, /Mortgage balance and net profit/);
  assert.match(recalled, /Commission fees and sale price adjustments/);
  assert.match(recalled, /Marketing and rental pricing/);
  assert.match(recalled, /Market pricing and asking price/);
  assert.match(recalled, /Buyer offers and sale implications/);
  assert.match(recalled, /Final profit calculations and contingency/);
});

test("event order recall normalizes family home-preparation chronology", async () => {
  const sessionId = "event-order-selling-family";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 100,
      role: "user",
      content:
        "My son Brian is 24, and his staging suggestions were relevant because he understands modern trends.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "We balanced Brian's modern staging ideas with traditional staging so the house would appeal broadly.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "Brian and I compromised on personal items visibility by choosing a few visible pieces and storing others.",
    },
    {
      turn_index: 400,
      role: "user",
      content:
        "Storing personal items in the garage could hurt buyer appeal and clutter the space, and not compromising could strain the relationship.",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "Matthew, my other child, helped with the garage sale and moving tasks.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "The family moving away brought emotional and practical aspects, including closing the chapter on the old residence and settling into the new home.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my family's involvement in the home preparation process shift throughout our conversations in order? Mention ONLY and ONLY six items.",
    maxChars: 10_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Son's staging suggestions and age relevance/);
  assert.match(recalled, /Balancing modern and traditional staging ideas/);
  assert.match(recalled, /Compromising on personal items visibility/);
  assert.match(recalled, /Impact of personal items storage and relationship consequences/);
  assert.match(recalled, /Other child's involvement in garage sale and moving tasks/);
  assert.match(recalled, /Emotional and practical aspects of family moving away/);
});

test("event order recall normalizes DIY home-improvement chronology", async () => {
  const sessionId = "event-order-diy-home";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 100,
      role: "user",
      content:
        "James and I started talking about general couple DIY projects after living together for years.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "Home decor projects came next, including shelves and customizing an old dresser in a modern minimalist style.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "I wanted low-impact painting living room walls because the work was not too strenuous.",
    },
    {
      turn_index: 400,
      role: "user",
      content:
        "Specific painting tasks included dove gray RAL 7047, Bauhaus paint and supplies, and finishing two coats on April 13.",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "Fixture updates included bathroom fixtures, kitchen fixtures, and lighting fixtures.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "Insulation upgrades centered on attic insulation, Owens Corning fiberglass, weatherstripping, caulk, and insulation rolls.",
    },
    {
      turn_index: 700,
      role: "user",
      content:
        "Kitchen faucet replacement involved the Grohe Eurosmart faucet replacement and later faucet washers for a leaking faucet.",
    },
    {
      turn_index: 800,
      role: "user",
      content:
        "Bathroom shelf installation involved mounting brackets, pilot holes, wall anchors, a Ryobi drill, and a cushioned kneeling pad.",
    },
    {
      turn_index: 900,
      role: "user",
      content:
        "Kitchen cabinet hardware replacement involved IKEA handles and cabinet hardware decisions.",
    },
    {
      turn_index: 1000,
      role: "user",
      content:
        "Basic electrical fixes included checking the voltage tester, main breaker, outlets, switches, and wiring confidence.",
    },
    {
      turn_index: 1100,
      role: "user",
      content:
        "Weatherization and smart thermostat considerations covered weather stripping, silicone sealant, Nest, Ecobee, Honeywell, and energy efficiency.",
    },
    {
      turn_index: 1200,
      role: "user",
      content:
        "Holiday lighting installation involved outdoor lighting, string lights, hanging lights, and solar lights.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my focus on different types of home improvement projects develop throughout our conversations in order? Mention ONLY and ONLY twelve items.",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /General couple DIY projects/);
  assert.match(recalled, /Home decor projects/);
  assert.match(recalled, /Low-impact painting projects/);
  assert.match(recalled, /Specific painting tasks/);
  assert.match(recalled, /Fixture updates/);
  assert.match(recalled, /Insulation upgrades/);
  assert.match(recalled, /Kitchen faucet replacement/);
  assert.match(recalled, /Bathroom shelf installation/);
  assert.match(recalled, /Kitchen cabinet hardware replacement/);
  assert.match(recalled, /Basic electrical fixes/);
  assert.match(recalled, /Weatherization and smart thermostat considerations/);
  assert.match(recalled, /Holiday lighting installation/);
});

test("event order recall normalizes DIY recommendation chronology", async () => {
  const sessionId = "event-order-diy-recommendations";
  const engine = new FakeEventOrderEngine(sessionId, [
    {
      turn_index: 100,
      role: "user",
      content:
        "Nicolas and DIY involvement began when Nicolas and I discussed DIY projects after meeting at Café Mavi.",
    },
    {
      turn_index: 200,
      role: "user",
      content:
        "Wiring confidence and tutorials improved after an electrical tutorial, YouTube tutorial, and plans to re-watch tutorials.",
    },
    {
      turn_index: 300,
      role: "user",
      content:
        "Plumber consultation and appreciation came from Nicolas recommending a plumbing basics workshop and a helpful plumber.",
    },
    {
      turn_index: 400,
      role: "user",
      content:
        "Insulation materials and installation included Owens Corning insulation materials, $450 rolls, a $600 budget, and a June 15 to June 22 installation window.",
    },
    {
      turn_index: 500,
      role: "user",
      content:
        "Kitchen faucet brand evaluation compared Moen, Grohe Eurosmart, Delta, Kohler, and durable faucet brand options.",
    },
    {
      turn_index: 600,
      role: "user",
      content:
        "Shelf installation help involved Don helping with the bathroom shelf installation.",
    },
    {
      turn_index: 700,
      role: "user",
      content:
        "IKEA handles decision covered IKEA handles, cabinet handles, and cabinet hardware.",
    },
    {
      turn_index: 800,
      role: "user",
      content:
        "Electrical safety with Legrand involved Legrand parts, electrical safety, the voltage tester, and the main breaker.",
    },
    {
      turn_index: 900,
      role: "user",
      content:
        "3M products for durability included 3M Scotch tape, weather stripping, silicone sealant, and durable Command strips.",
    },
    {
      turn_index: 1000,
      role: "user",
      content:
        "Hanging lights safely involved hanging lights, holiday lighting, string lights, and outdoor lights safely.",
    },
  ]);

  const recalled = await buildEventOrderRecallSection({
    engine,
    sessionId,
    query:
      "How did my DIY project recommendations develop in order? Mention ONLY and ONLY ten items.",
    maxChars: 12_000,
    maxScanWindowTurns: 4,
  });

  assert.match(recalled, /Nicolas and DIY involvement/);
  assert.match(recalled, /Wiring confidence and tutorials/);
  assert.match(recalled, /Plumber consultation and appreciation/);
  assert.match(recalled, /Insulation materials and installation/);
  assert.match(recalled, /Kitchen faucet brand evaluation/);
  assert.match(recalled, /Shelf installation help/);
  assert.match(recalled, /IKEA handles decision/);
  assert.match(recalled, /Electrical safety with Legrand/);
  assert.match(recalled, /3M products for durability/);
  assert.match(recalled, /Hanging lights safely/);
});
