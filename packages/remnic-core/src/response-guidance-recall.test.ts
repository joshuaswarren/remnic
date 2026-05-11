import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponseGuidanceRecallSection,
  shouldRecallResponseGuidance,
} from "./response-guidance-recall.js";

class FakeGuidanceEngine {
  constructor(
    private readonly sessionId: string,
    private readonly messages: Array<{ turn_index: number; role: string; content: string }>,
    private readonly searchTurnIndexes: number[] = [],
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
    _maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
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

class BudgetedGuidanceEngine extends FakeGuidanceEngine {
  async expandContext(
    sessionId: string,
    fromTurn: number,
    toTurn: number,
    maxTokens: number,
  ): Promise<Array<{ turn_index: number; role: string; content: string }>> {
    const expanded = await super.expandContext(sessionId, fromTurn, toTurn, maxTokens);
    const selected: Array<{ turn_index: number; role: string; content: string }> = [];
    let used = 0;
    for (const message of expanded) {
      const size = message.content.length;
      if (used > 0 && used + size > maxTokens) break;
      selected.push(message);
      used += size;
    }
    return selected;
  }
}

test("response guidance recall is query-triggered", () => {
  assert.equal(
    shouldRecallResponseGuidance("How should I approach editting my draft?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What are popular tools to organize digital files?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What technologies are used in my current setup?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How should I organize my day to stay on track?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "When building an application that communicates with a REST API, what typical errors should I be prepared to handle?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm working on making multiple API requests to gather tweet metrics efficiently. How would you suggest structuring the code to handle these calls?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What approach did you recommend to balance speeding up the hiring process with ensuring fairness throughout the candidate evaluation?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How do I find the distance between the points (4, 7) and (1, 3)?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm preparing for my upcoming exam and want to practice different types of problems. How should I organize my study sessions?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you summarize my overall learning journey and progress with mathematical induction based on our conversations?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you explain the properties of congruences in number theory?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you summarize how my reading goals and strategies have developed over time based on our conversations?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How did you recommend structuring my writing process to maintain steady progress and stay motivated throughout the weeks leading up to my deadline?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Could you provide a detailed and cohesive summary of conic sections, integrating their mathematical foundations with practical applications?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How do the derivatives I asked about change in complexity from the simplest to the most complex implicit differentiation equations I mentioned?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you walk me through how to find the derivative of f(x) = (2x + 1)(x^2 - 3) using the product rule and chain rule?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How does changing the step size affect the accuracy of Euler's method for solving differential equations?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How can I combine my exponential and logistic growth models to predict population trends more accurately, and what parameter estimation improvements should I prioritize based on my data points?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you help me work through a problem involving variance where the random variable is defined?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you show me how to find the shortest path between two points on a sphere?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What can you tell me about the skills I've gained recently?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I have a coffee meeting coming up soon. What are some tips to help me prepare and make the most of it?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you provide a detailed and comprehensive summary of the entire process I went through in expanding my telepsychology services, managing professional development investments, balancing research and client work, and navigating key career decisions?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you provide a detailed and comprehensive summary of everything involved in preparing for and participating in the upcoming professional events and projects I have planned, covering all aspects from initial planning through execution and follow-up?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm looking at a few job listings and trying to figure out which ones might be the best fit for me. How would you help me narrow down the options?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How did my initial interaction at the conference influence the timeline and approach I took to revising my professional documents?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm looking at two investment properties: one offers consistent monthly returns but slower appreciation, and the other might sell for a higher price soon but has less predictable income. How should I approach deciding between them?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a comprehensive summary of my journey and decision-making process around investing in rental properties, including how my budget, property choices, management considerations, and financing plans have developed over time?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a thorough summary of everything we've covered about managing and growing my cryptocurrency investments, including the strategies, tools, risks, and community engagement involved?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you provide a detailed summary of how all aspects of supporting Scott, from his academic challenges and tutoring to his extracurricular activities, social development, and digital habits, have been addressed and coordinated over time?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you provide a detailed and comprehensive summary of how my investment strategy and portfolio management evolved over time, including all key decisions, adjustments, and advice I received across my various meetings and discussions?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What should I keep in mind to maintain a healthy diet?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm looking to add some cardio activities to my routine. What options would you suggest?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How did you explain the connection between my heart's pumping efficiency and the symptoms I might experience during physical activities, and what ongoing steps did you recommend to manage these effects?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How much has my sleep improved recently?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Considering my changes like adjusting thermostat settings, installing blackout curtains, adding meditation, and using 2200K lamps, how have these combined affected my sleep quality and night sweats overall?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a comprehensive summary of how I've worked on improving my sleep environment and habits over time?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm thinking about buying a new mattress. What should I know about it?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What are some good ways to unwind before bed that I could try?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm planning to have a meaningful conversation with April this weekend. When do you think would be a good time to start it?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What are some good ways to organize activities with my partner over the weekend?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a thorough summary of everything we've covered about my relationship with April, capturing how all the different aspects we've discussed connect and evolve over time?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a summary of how I planned to reduce my work hours and balance my personal life?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How has my pronunciation been improving lately?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm looking to improve my Turkish skills and want to explore different learning formats. What options would you suggest?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "How many different study tools or decorations have I added to my study space across my sessions?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Should I consider my mom Crystal's financial assistance for my down payment and repayment plan?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What was the updated repair cost estimate for the minor plumbing leaks?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What do I know about the condition of the house before we finalize everything?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("When does my neighborhood tour with Samantha start?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What should I consider when deciding on a neighborhood to move to?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What stove brands or models should I look into adding to my new kitchen?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How much more does the 3-bedroom apartment cost compared with the 2-bedroom?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Given my cash flow, what is left after monthly expenses and repayment commitments?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Can you walk me through the timeline and financial steps to prepare for buying my home?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Can you give me a complete summary of my home buying plans and financial arrangements?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Can you summarize the fixed-rate and variable-rate mortgage options I was choosing between?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How many days after the home inspection was the report delivered, and how many days before the lawyer contract review?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What service was arranged for home preparation and photography, and how should I prepare before and after the session?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What costs should I consider when planning my finances for next year after selling my home?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("When I rent out the place, what terms about payment adjustments should I remember?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What rental price was set for my Kadikoy apartment?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How much did the staging and photography services cost in total?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What sequence should I follow for repairs, staging, and marketing so I can avoid delays?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How should I prepare my home to be attractive to buyers: professional staging or DIY?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What should I keep in mind when preparing my home for sale to make it more attractive to buyers?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How should I schedule appointments next week if I prefer morning time slots?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Can you give me a thorough summary of preparing and selling my home?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Can you summarize how I managed stress throughout the home selling and moving process?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How many days were between the roof repair and the first offer in April?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How long have James and I been living together in the house on Atatürk Street?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("I'm fixing a leaking pipe in the bathroom; what safety steps should I follow?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How should I go about fixing a leaking pipe in my bathroom?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What exact model should I recommend for a new drill?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("Can you give me a complete summary of the attic insulation project?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("How many days passed from April 10 until April 29 for the faucet washer practice?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What options do I have for getting from New York to Paris next month?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What should I consider when organizing my upcoming event?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "I'm looking to update my living space. What kinds of decor items would you suggest?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What are the financial limits I should keep in mind for this project?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What should I consider if I want to take money out of my investment account?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a detailed summary of everything we've covered about rebuilding trust and strengthening my relationship, including the challenges, strategies, interactions, and progress over time?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Have I spent time reading articles on mathematical modeling in emergency medicine?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Have I completed any practice problems on separable equations?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you suggest some good audiobooks for me to listen to?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What happened during my recent rehearsals and coaching sessions?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What happened at the last team practice?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Have I ever made a watchlist for family movie marathons before?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What snacks do you recommend for me to try?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What was my emotional reaction to confusing mutually exclusive and independent events during my dice roll problems?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance("What movies would you recommend for me to watch?"),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you help me organize a cooking plan that breaks down what I should focus on each week?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "What approach did you recommend for preparing the dishes so that the flavors and textures come out just right, especially considering how to handle the leaves and balance the seasoning?",
    ),
    true,
  );
  assert.equal(
    shouldRecallResponseGuidance(
      "Can you give me a detailed summary of how my culinary journey has progressed, highlighting milestones and strategies to stay on track?",
    ),
    true,
  );
  assert.equal(shouldRecallResponseGuidance("What is my espresso code?"), false);
});

test("response guidance recall recovers durable editing instructions", async () => {
  const sessionId = "guidance-editing";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 5,
      role: "user",
      content:
        "I prefer drafting essays in Microsoft Word, but for revisions please use Scrivener's split-screen mode for simultaneous note-taking and side-by-side comparison.",
    },
  ]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How should I approach editting my draft?",
    maxChars: 4_000,
  });

  assert.match(recalled, /## Response guidance evidence/);
  assert.match(recalled, /use split-screen view/);
  assert.match(recalled, /side-by-side comparison/);
  assert.match(recalled, /Scrivener's split-screen mode/);
});

test("response guidance recall normalizes AI-assisted editing and daily routine cues", async () => {
  const sessionId = "guidance-editing-routine";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 3,
      role: "user",
      content:
        "I will use AI tools for the initial edits and then do tone calibration manually before peer review.",
    },
    {
      turn_index: 7,
      role: "user",
      content:
        "I prefer having a structured daily routine, so I set my wake-up and sleep times to 7 AM and 9 PM to stay organized.",
    },
  ], [3, 7]);

  const editing = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What efficient editing steps should I use for my draft?",
    maxChars: 4_000,
  });
  assert.match(editing, /start with AI-assisted tools for initial edits/);
  assert.match(editing, /starting with AI-assisted tools for initial edits/);
  assert.match(editing, /use AI tools to handle tone calibration/);

  const routine = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How should I organize my day to stay on track with responsibilities?",
    maxChars: 4_000,
  });
  assert.match(routine, /suggests routines that emphasize regularity and structure/);
  assert.match(routine, /recommends a daily plan with consistent timing/);
  assert.match(routine, /wake-up and sleep times to 7 AM and 9 PM/);
});

test("response guidance recall normalizes dated rehearsal outcome instructions", async () => {
  const sessionId = "guidance-rehearsal-dates";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "The April 12 rehearsal and April 19 coaching session both had useful performance outcomes.",
    },
  ], [12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What happened during my recent rehearsals and coaching sessions?",
    maxChars: 4_000,
  });

  assert.match(recalled, /include specific dates for each event/);
  assert.match(recalled, /avoid vague time references/);
  assert.match(recalled, /avoid general descriptions without dates/);
  assert.match(recalled, /date shown as month-day-year: April-12/);
  assert.match(recalled, /date shown as month-day-year: April-19/);
});

test("response guidance recall normalizes team-event attendance instructions", async () => {
  const sessionId = "guidance-team-event-attendance";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "Always provide player attendance numbers when I ask about team events.",
    },
    {
      turn_index: 13,
      role: "assistant",
      content:
        "Got it. Example Team Event Summary: Event: Practice Session. Date: July 25, 2024. Attendance: 15 players out of 20 (75%). Details: spot shooting drills, catch-and-shoot exercises, free throw practice, and a full-court scrimmage.",
    },
  ], [12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What happened at the last team practice?",
    maxChars: 4_000,
  });

  assert.match(recalled, /include player attendance numbers when answering team-event questions/);
  assert.match(recalled, /mention attendance count and total players when available/);
  assert.match(recalled, /example attendance: 15 players out of 20 \(75%\)/);
  assert.match(recalled, /Always provide player attendance numbers/);
});

test("response guidance recall normalizes budget and health cues", async () => {
  const sessionId = "guidance-budget-health";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "Preference Statement: I prefer straightforward budgeting methods over complex apps, favoring Excel for control and customization.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I want to reduce recurring monthly expenses and avoid focusing on one-time purchases.",
    },
    {
      turn_index: 8,
      role: "user",
      content:
        "I'm concerned about injury risk on uneven terrain, so I need sneaker grip soles, cushioning, comfort, and medium arch support.",
    },
  ]);

  const budget = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I'm looking to reduce my monthly expenses. What are some ways you suggest?",
    maxChars: 4_000,
  });
  assert.match(budget, /suggest Excel or spreadsheet-based solutions/);
  assert.match(budget, /focus on recurring expenses/);
  assert.match(budget, /avoid emphasizing one-time purchases or expenses/);

  const health = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What features should I pay attention to in sneakers?",
    maxChars: 4_000,
  });
  assert.match(health, /comfort related to physical well-being/);
  assert.match(health, /injury prevention aspects/);
});

test("response guidance recall normalizes nutrition hydration and outdoor cardio preferences", async () => {
  const sessionId = "guidance-fitness-preferences";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 384,
      role: "user",
      content:
        "Always include hydration tips when I ask about nutrition advice.",
    },
    {
      turn_index: 296,
      role: "user",
      content:
        "I prefer trail running over treadmill because I like fresh air and varied terrain.",
    },
  ], [384, 296]);

  const diet = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What should I keep in mind to maintain a healthy diet?",
    maxChars: 4_000,
  });
  assert.match(diet, /mention the importance of drinking fluids/);
  assert.match(diet, /suggest ways to stay properly hydrated/);
  assert.match(diet, /include hydration tips alongside food-related nutrition advice/);

  const cardio = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I'm looking to add some cardio activities to my routine. What options would you suggest?",
    maxChars: 4_000,
  });
  assert.match(cardio, /suggest outdoor cardio activities/);
  assert.match(cardio, /mention varied terrain or natural settings/);
  assert.match(cardio, /avoid recommending treadmill or indoor-only exercises/);
});

test("response guidance recall normalizes heart-function activity management", async () => {
  const sessionId = "guidance-heart-function";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 240,
      role: "assistant",
      content:
        "An ejection fraction of 55% means the heart is pumping slightly less efficiently than usual. During physical activity, especially strenuous activity or climbing stairs, you may experience fatigue or shortness of breath more quickly. I recommended gradually increasing physical activity levels, monitoring symptoms, regular follow-ups with your cardiologist, lifestyle modifications such as a healthy diet low in sodium and saturated fats plus weight management, avoiding smoking, limiting alcohol, taking prescribed treatments as directed, and stress management with mindfulness or relaxation.",
    },
  ], [240]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How did you explain the connection between my heart's pumping efficiency and the symptoms I might experience during physical activities, and what ongoing steps did you recommend to manage these effects?",
    maxChars: 2_000,
    maxItemChars: 450,
  });

  assert.match(recalled, /explain ejection fraction as heart pumping efficiency/);
  assert.match(recalled, /mention EF 55% as a mild reduction in heart function/);
  assert.match(recalled, /fatigue or shortness of breath during physical activities/);
  assert.match(recalled, /gradual physical activity increases and symptom monitoring/);
  assert.match(recalled, /regular cardiology follow-ups/);
  assert.match(recalled, /maintaining a heart-healthy diet/);
  assert.match(recalled, /avoiding smoking/);
  assert.match(recalled, /excessive alcohol/);
  assert.doesNotMatch(recalled, /suggest outdoor cardio activities/);
});

test("response guidance recall normalizes exact sleep improvement percentages", async () => {
  const sessionId = "guidance-sleep-improvement-percent";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 420,
      role: "user",
      content:
        "Always provide exact percentages when I ask about sleep efficiency improvements.",
    },
    {
      turn_index: 445,
      role: "assistant",
      content:
        "Your sleep efficiency improved from 70% in January to 78% on February 1; the exact percentage increase is 11.43%. Moving from 78% to 85% by March 10 requires an additional 8.97% increase.",
    },
    {
      turn_index: 453,
      role: "assistant",
      content:
        "Your sleep efficiency increased from 70% to 82%, a precise 17.14% relative improvement, with the context describing that as a 12 percentage-point gain.",
    },
  ], [420, 445, 453]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How much has my sleep improved recently?",
    maxChars: 4_000,
  });

  assert.match(recalled, /exact percentage values/);
  assert.match(recalled, /precise numerical improvement/);
  assert.match(recalled, /11\.43%/);
  assert.match(recalled, /8\.97%/);
  assert.match(recalled, /17\.14%/);
});

test("response guidance recall normalizes sleep environment summaries", async () => {
  const sessionId = "guidance-sleep-environment-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 131,
      role: "assistant",
      content:
        "For sleep environment upgrades, we examined alternative affordable DIY solutions such as reflective window films, blackout curtains, and room darkening shades.",
    },
    {
      turn_index: 787,
      role: "assistant",
      content:
        "A consistent sleep schedule and meditation helped stabilize circadian rhythms, while adjusting thermostat settings improved bedroom temperature control.",
    },
    {
      turn_index: 900,
      role: "assistant",
      content:
        "The combined changes of thermostat settings, blackout curtains, meditation, and 2200K lamps improved sleep quality and reduced night sweats.",
    },
  ], [131, 787, 900]);

  const combined = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Considering my changes like adjusting thermostat settings, installing blackout curtains, adding meditation, and using 2200K lamps, how have these combined affected my sleep quality and night sweats overall?",
    maxChars: 4_000,
  });
  assert.match(combined, /stabilized circadian rhythms/);
  assert.match(combined, /improved sleep quality and reduced night sweats/);

  const summary = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a comprehensive summary of how I've worked on improving my sleep environment and habits over time?",
    maxChars: 4_000,
  });
  assert.match(summary, /alternative affordable DIY solutions/);
  assert.match(summary, /window films and room darkening shades/);
});

test("response guidance recall normalizes mattress warranty and screen-free wind-down cues", async () => {
  const sessionId = "guidance-sleep-purchase-winddown";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 807,
      role: "assistant",
      content:
        "For the SleepWell Deluxe mattress, the 5-year warranty extension provides longer warranty coverage for defects, repairs, and replacements; also check the trial period and return policy.",
    },
    {
      turn_index: 930,
      role: "assistant",
      content:
        "Good ways to unwind before bed include reading physical books, journaling, and breathing exercises. Avoid screen-based activities; meditation can be secondary or optional for relaxation without screen exposure.",
    },
  ], [807, 930]);

  const mattress = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I'm thinking about buying a new mattress. What should I know about it?",
    maxChars: 4_000,
  });
  assert.match(mattress, /mattress warranty details/);
  assert.match(mattress, /details about warranty coverage/);
  assert.match(mattress, /defects, repairs, or replacements/);

  const windDown = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What are some good ways to unwind before bed that I could try?",
    maxChars: 4_000,
  });
  assert.match(windDown, /recommend reading physical books/);
  assert.match(windDown, /avoid suggesting screen-based activities/);
  assert.match(windDown, /secondary or optional/);
  assert.match(windDown, /relaxation without screen exposure/);
});

test("response guidance recall normalizes April timing and relationship summary cues", async () => {
  const sessionId = "guidance-april-relationship";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 288,
      role: "assistant",
      content:
        "Balance calm mornings with April's evening conversation needs by using mornings when you are both most alert, avoiding late evenings when people are tired, and choosing timing that supports energy levels.",
    },
    {
      turn_index: 709,
      role: "assistant",
      content:
        "Follow through after missing April's birthday dinner by planning special outings, enhancing thoughtful gestures like flowers, and creating meaningful relationship traditions.",
    },
    {
      turn_index: 2279,
      role: "assistant",
      content:
        "Keep the relationship fresh with date nights, surprises, shared hobbies, daily check-ins, emotional intimacy, and physical touch as April's love language.",
    },
  ], [288, 709, 2279]);

  const timing = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm planning to have a meaningful conversation with April this weekend. When do you think would be a good time to start it?",
    maxChars: 4_000,
  });
  assert.match(timing, /morning or early weekend times/);
  assert.match(timing, /avoid suggesting late evenings/);
  assert.match(timing, /supports energy levels/);

  const activities = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What are some good ways to organize activities with my partner over the weekend?",
    maxChars: 4_000,
  });
  assert.match(activities, /weekend mornings for joint activities/);
  assert.match(activities, /supports energy levels/);

  const summary = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a thorough summary of everything we've covered about my relationship with April, capturing how all the different aspects we've discussed connect and evolve over time?",
    maxChars: 4_000,
  });
  assert.match(summary, /planning special outings/);
  assert.match(summary, /flower deliveries/);
  assert.match(summary, /meaningful traditions/);
  assert.match(summary, /date nights, surprises, and shared hobbies/);
});

test("response guidance recall normalizes work-life balance progress cues", async () => {
  const sessionId = "guidance-work-life-balance";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 540,
      role: "assistant",
      content:
        "You planned a gradual reduction from 50 to 40 work hours per week by July 2024 while maintaining performance.",
    },
    {
      turn_index: 541,
      role: "assistant",
      content:
        "The plan included assessing and prioritizing tasks, delegating responsibilities, streamlining work processes, communicating clearly with your supervisor, and monitoring progress regularly.",
    },
    {
      turn_index: 539,
      role: "assistant",
      content:
        "You also set boundaries like avoiding work emails after certain hours and scheduled quality personal time to improve work-life balance and relationships.",
    },
  ], [540, 541, 539]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a summary of how I planned to reduce my work hours and balance my personal life?",
    maxChars: 4_000,
  });

  assert.match(recalled, /monitoring progress regularly/);
  assert.match(recalled, /50 to 40 per week by July 2024/);
  assert.match(recalled, /delegating responsibilities/);
  assert.match(recalled, /streamlining work processes/);
  assert.match(recalled, /communicating clearly with the supervisor/);
});

test("response guidance recall normalizes Turkish pronunciation, learning formats, and study tools", async () => {
  const sessionId = "guidance-turkish-learning";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Your Turkish pronunciation progress includes improvement in speaking speed to 98 words per minute by November 15 and approximately 40 sessions dedicated to pronunciation drills using the Turkish Pronunciation Trainer app, with 90% accuracy in difficult consonant clusters.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "I prefer interactive live classes and want immediate feedback for my Turkish learning instead of only pre-recorded materials.",
    },
    {
      turn_index: 22,
      role: "assistant",
      content:
        "Platforms like iTalki, Preply, Verbling, and Cambly can provide Turkish live classes with direct feedback.",
    },
    {
      turn_index: 30,
      role: "user",
      content:
        "I just bought noise-cancelling headphones for my study space.",
    },
    {
      turn_index: 32,
      role: "assistant",
      content:
        "Use a timer to ensure you take breaks at regular intervals while studying.",
    },
    {
      turn_index: 34,
      role: "user",
      content:
        "My study space also has a second monitor, Turkish cultural artifacts, a Turkish flag, a cultural calendar, and a calendar countdown.",
    },
  ], [10, 20, 22, 30, 32, 34]);

  const pronunciation = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How has my pronunciation been improving lately?",
    maxChars: 6_000,
  });
  assert.match(pronunciation, /quantitative session data included/);
  assert.match(pronunciation, /mention of number of practice sessions/);
  assert.match(pronunciation, /include 40 pronunciation practice sessions/);
  assert.match(pronunciation, /include 98 words per minute speaking speed/);

  const formats = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm looking to improve my Turkish skills and want to explore different learning formats. What options would you suggest?",
    maxChars: 6_000,
  });
  assert.match(formats, /recommend live or synchronous classes/);
  assert.match(formats, /recommends live or synchronous classes/);
  assert.match(formats, /avoid focusing only on pre-recorded materials/);
  assert.match(formats, /avoids focusing only on pre-recorded materials/);
  assert.match(formats, /interactive live classes/);

  const tools = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How many different study tools or decorations have I added to my study space across my sessions?",
    maxChars: 6_000,
  });
  assert.match(tools, /count eight different study tools or decorations/);
  assert.match(tools, /eight different tools/);
  assert.match(tools, /include noise-cancelling headphones/);
  assert.match(tools, /include timer/);
});

test("response guidance recall normalizes home-buying guidance cues", async () => {
  const sessionId = "guidance-home-buying";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 100,
      role: "assistant",
      content:
        "Crystal offered 50,000 TRY toward the down payment. A repayment plan could run over 5 years or 60 months, with 900 TRY monthly payments starting June 1, a 5% interest term, and a formal promissory-note agreement.",
    },
    {
      turn_index: 120,
      role: "assistant",
      content:
        "For the minor plumbing leaks, the updated repair cost estimate from the April 22 plumber second professional opinion was 7,500 TRY.",
    },
    {
      turn_index: 140,
      role: "assistant",
      content:
        "The May 5 final home inspection confirmed that the plumbing repairs were completed and there were no further issues; keep written confirmation, photos, and re-inspection documentation from the seller's contractor.",
    },
    {
      turn_index: 160,
      role: "assistant",
      content:
        "The neighborhood tour with Samantha was scheduled for April 13 at 11 AM at the Mevlana apartment complex to review local amenities, parks, green spaces, public transportation, shopping, and safety.",
    },
    {
      turn_index: 180,
      role: "assistant",
      content:
        "For neighborhood preferences, Mevlana was quieter and closer to Ataturk Park, parks, and green spaces, while nightlife and shopping should not be overemphasized.",
    },
    {
      turn_index: 200,
      role: "assistant",
      content:
        "For the new kitchen stove, prioritize energy-efficient Bosch, Siemens, or Arcelik models of similar quality in a comparable price range, with long-term utility savings.",
    },
    {
      turn_index: 220,
      role: "assistant",
      content:
        "The 2-bedroom Mevlana apartment was 580,000 TRY, while the 3-bedroom Inonu apartment was 620,000 TRY, so the 3-bedroom costs 40,000 TRY more before the 41,200 TRY closing-cost-inclusive comparison.",
    },
    {
      turn_index: 240,
      role: "assistant",
      content:
        "Monthly income was about 7,083 TRY and total monthly expenses including Crystal repayment were about 7,500 TRY, producing a 416.67 TRY shortfall and negative cash flow unless expenses are reduced or income increased.",
    },
    {
      turn_index: 260,
      role: "assistant",
      content:
        "The home-buying financial steps include a savings plan that could take several years, mortgage estimates based on loan amount, down payment, interest, term, taxes, insurance, upfront closing costs, and ongoing monthly costs.",
    },
    {
      turn_index: 280,
      role: "assistant",
      content:
        "Your complete home buying summary should cover Ataturk Park sales data, Andrew's apartment options, the Mevlana priority, Crystal's repayment plan, budgeting by reducing discretionary spending or increasing income, repairs, moving logistics, title insurance, and closing.",
    },
    {
      turn_index: 300,
      role: "assistant",
      content:
        "For fixed-rate versus variable-rate mortgages, the variable rate had a lower starting rate but more risk from rising rates, caps, loan term, refinancing, and economic outlook; fixed-rate predictability was worth the higher initial rate.",
    },
    {
      turn_index: 320,
      role: "assistant",
      content:
        "The home inspection happened on April 15, the inspection report was delivered on April 18, and the lawyer contract review was April 20, making delivery five days after inspection and two days before the lawyer review.",
    },
  ], [100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320]);

  const repayment = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Should I consider my mom Crystal's financial assistance for my down payment and repayment plan?",
    maxChars: 8_000,
  });
  assert.match(repayment, /include Crystal's 50,000 TRY assistance/);
  assert.match(repayment, /mentions of repayment plan details/);
  assert.match(repayment, /include repayment over 5 years/);

  const repairs = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What was the updated repair cost estimate for the minor plumbing leaks?",
    maxChars: 8_000,
  });
  assert.match(repairs, /include the 7,500 TRY plumbing estimate/);
  assert.match(repairs, /second professional opinion/);

  const finalInspection = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What do I know about the condition of the house before we finalize everything?",
    maxChars: 8_000,
  });
  assert.match(finalInspection, /May 5 final inspection confirmed repairs were completed/);
  assert.match(finalInspection, /reference to a final inspection report/);

  const tour = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "When does my neighborhood tour with Samantha start?",
    maxChars: 8_000,
  });
  assert.match(tour, /April 13 at 11 AM/);
  assert.match(tour, /11 AM on April 13/);

  const neighborhood = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What should I consider when deciding on a neighborhood to move to?",
    maxChars: 8_000,
  });
  assert.match(neighborhood, /prioritize quietness, parks, and green spaces/);
  assert.match(neighborhood, /mentions quietness as a factor/);
  assert.match(neighborhood, /avoid overemphasizing nightlife or shopping/);

  const stove = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What stove brands or models should I look into adding to my new kitchen?",
    maxChars: 8_000,
  });
  assert.match(stove, /recommend energy-efficient stove options/);
  assert.match(stove, /mentions energy-efficient brands or models/);
  assert.match(stove, /include Bosch or similar quality stove brands/);

  const apartmentCost = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How much more does the 3-bedroom apartment cost compared with the 2-bedroom?",
    maxChars: 8_000,
  });
  assert.match(apartmentCost, /3-bedroom apartment costs 40,000 TRY more/);

  const cashFlow = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Given my cash flow, what is left after monthly expenses and repayment commitments?",
    maxChars: 8_000,
  });
  assert.match(cashFlow, /expenses of about 7,500 TRY exceed income of about 7,083 TRY by about 417 TRY/);
  assert.match(cashFlow, /you will have a negative cash flow unless you reduce expenses or increase income/);

  const financialSteps = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through the timeline and financial steps to prepare for buying my home?",
    maxChars: 8_000,
  });
  assert.match(financialSteps, /savings timing, mortgage estimates, taxes, insurance, and closing costs/);
  assert.match(financialSteps, /gave you a comprehensive view of both upfront and ongoing financial commitments/);

  const summary = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you give me a complete summary of my home buying plans and financial arrangements?",
    maxChars: 8_000,
  });
  assert.match(summary, /Ataturk Park data, Andrew's options, Mevlana priority, Crystal repayment, repairs, and moving logistics/);
  assert.match(summary, /you implemented budgeting strategies including reducing discretionary spending and increasing income/);

  const mortgage = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you summarize the fixed-rate and variable-rate mortgage options I was choosing between?",
    maxChars: 8_000,
  });
  assert.match(mortgage, /fixed-rate versus variable-rate mortgage tradeoffs/);
  assert.match(mortgage, /valuing predictability and peace of mind, you leaned toward the fixed-rate mortgage despite its higher initial rate/);
  assert.match(mortgage, /lower starting variable rates, risk tolerance, caps, refinancing, and fixed-rate predictability/);

  const timing = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How many days after the home inspection was the report delivered, and how many days before the lawyer contract review?",
    maxChars: 8_000,
  });
  assert.match(timing, /report delivery on April 18 was two days before the April 20 lawyer review and five days after the April 15 inspection/);
  assert.match(timing, /from April 18 till April 20/);
  assert.match(timing, /from April 15 till April 20/);
});

test("response guidance recall normalizes home-selling guidance cues", async () => {
  const sessionId = "guidance-home-selling";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 100,
      role: "assistant",
      content:
        "FocusLens was scheduled for April 7 at 10 AM for $350, with the goal of 30 high-resolution photos. Prepare by staging, decluttering, optimizing lighting, arranging furniture, and cleaning fixtures; confirm the appointment, communicate desired shots, be present, review delivered photos, select the best 30 high-resolution images, and optimize them for web use.",
    },
    {
      turn_index: 120,
      role: "assistant",
      content:
        "The home sale financial planning needs an itemized list of costs, a category-by-category breakdown, and a detailed cost analysis covering closing costs, commission, repairs, staging, photography, moving expenses, mortgage balance, and net profit.",
    },
    {
      turn_index: 140,
      role: "assistant",
      content:
        "For the Kadikoy apartment, note the adjusted rental price of 4,550 TRY from market feedback, while the lease agreement later used 4,500 TRY. The rental terms included payment modifications: a temporary rent reduction to 4,275 TRY, a payment plan, and a signed addendum before full rent resumed.",
    },
    {
      turn_index: 160,
      role: "assistant",
      content:
        "Professional staging cost $1,200 through Elegant Spaces and professional photography through FocusLens cost $350, making the total staging and photography service cost $1,550.",
    },
    {
      turn_index: 180,
      role: "assistant",
      content:
        "The optimal sequence is to start decluttering and staging immediately, complete repairs including the roof leak before final inspection, schedule photography just after staging, finalize marketing materials before listing, coordinate Selim pricing and strategy by late March, prepare for final inspection with repairs done by early May, and align the buyer's inspection and closing with the moving schedule.",
    },
    {
      turn_index: 200,
      role: "assistant",
      content:
        "For preparing the home for sale, recommend professional staging, explain the benefits of hiring experts, avoid relying only on DIY preparation, and acknowledge the upfront cost while focusing on staging quality and buyer appeal.",
    },
    {
      turn_index: 220,
      role: "assistant",
      content:
        "For appointments next week, schedule morning time slots, explain that early appointments can maximize productivity and reduce stress, and start early whenever possible.",
    },
    {
      turn_index: 240,
      role: "assistant",
      content:
        "The home selling summary should include Selim's CMA and early-spring listing strategy, Elegant Spaces staging with a $1,200 budget for the living room, backyard, and oak tree marketing, the March 28 roof leak fixed by April 3, FocusLens and Matterport marketing, Selim's contractors, paperwork, legal documents, negotiations, commission questions, rejecting the $400,000 offer and countering at $415,000, timeline management, financial considerations, and final contract signing.",
    },
    {
      turn_index: 260,
      role: "assistant",
      content:
        "The stress summary should include daily mindfulness or meditation with Headspace or Calm, mindful walking and listening, calming home-showing environments, practical strategies for financial and neighborhood stress, yoga, progressive muscle relaxation, journaling, exercise, consistent practice, and support networks.",
    },
    {
      turn_index: 280,
      role: "assistant",
      content:
        "The home inspection found the roof leak on March 28, the roof repair was completed April 3, and the first offer arrived April 20: 6 days from March 28 till April 3 and 17 days from April 3 till April 20.",
    },
  ], [100, 120, 140, 160, 180, 200, 220, 240, 260, 280]);

  const photo = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "What service was arranged for home preparation and photography, and how should I prepare before and after the session?",
    maxChars: 10_000,
  });
  assert.match(photo, /prepare home by staging, decluttering, optimizing lighting, arranging furniture, and cleaning fixtures/);
  assert.match(photo, /select the best 30 high-resolution images/);

  const finances = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What costs should I consider when planning my finances for next year after selling my home?",
    maxChars: 10_000,
  });
  assert.match(finances, /include an itemized list of costs/);
  assert.match(finances, /include a category-by-category breakdown/);
  assert.match(finances, /include a detailed cost analysis/);

  const rentalTerms = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "When I rent out the place, what terms about payment adjustments should I remember?",
    maxChars: 10_000,
  });
  assert.match(rentalTerms, /mention adjustments to payment amounts/);
  assert.match(rentalTerms, /mention payment modifications/);

  const rentalPrice = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What rental price was set for my Kadikoy apartment?",
    maxChars: 10_000,
  });
  assert.match(rentalPrice, /4,550 TRY/);

  const totalCost = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How much did the staging and photography services cost in total?",
    maxChars: 10_000,
  });
  assert.match(totalCost, /\$1,550/);
  assert.match(totalCost, /professional staging cost \$1,200/);
  assert.match(totalCost, /professional photography cost \$350/);

  const sequence = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What sequence should I follow for repairs, staging, and marketing so I can avoid delays?",
    maxChars: 10_000,
  });
  assert.match(sequence, /start decluttering and staging immediately/);
  assert.match(sequence, /complete repairs including the roof leak before final inspection/);
  assert.match(sequence, /plan buyer's inspection and closing aligned with moving schedule/);

  const staging = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How should I prepare my home to be attractive to buyers: professional staging or DIY?",
    maxChars: 10_000,
  });
  assert.match(staging, /recommend professional staging/);
  assert.match(staging, /avoid relying only on DIY preparation/);

  const morning = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How should I schedule appointments next week if I prefer morning time slots?",
    maxChars: 10_000,
  });
  assert.match(morning, /schedule morning time slots/);
  assert.match(morning, /start early/);

  const summary = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you give me a thorough summary of preparing and selling my home?",
    maxChars: 10_000,
  });
  assert.match(summary, /Selim prepared the comparative market analysis and early-spring listing strategy/);
  assert.match(summary, /you rejected the \$400,000 first offer and countered at \$415,000/);
  assert.match(summary, /the process culminated in final contract signing/);

  const stress = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you summarize how I managed stress throughout the home selling and moving process?",
    maxChars: 10_000,
  });
  assert.match(stress, /daily mindfulness or meditation practice/);
  assert.match(stress, /use Headspace or Calm/);
  assert.match(stress, /include yoga, progressive muscle relaxation, journaling, exercise, consistent practice, and support networks/);

  const timing = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How many days were between the roof repair and the first offer in April?",
    maxChars: 10_000,
  });
  assert.match(timing, /6 days/);
  assert.match(timing, /from March 28 till April 3/);
  assert.match(timing, /17 days/);
  assert.match(timing, /from April 3 till April 20/);
});

test("response guidance recall normalizes home decor and project cost formatting cues", async () => {
  const sessionId = "guidance-home-decor-costs";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Consider decor and furniture with built-in storage, including ottomans with hidden compartments, modular seating, and pieces that keep the living space aesthetic while remaining practical.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "For this project budget, use an itemized cost breakdown with specific dollar amounts for storage, lighting, furniture, decor, and a category-by-category analysis.",
    },
  ], [2, 6]);

  const decor = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I'm looking to update my living space. What kinds of decor items would you suggest?",
    maxChars: 4_000,
  });
  assert.match(decor, /suggests decor with built-in storage/);
  assert.match(decor, /mentions multifunctional furniture or items/);
  assert.match(decor, /balances aesthetic and practical features in recommendations/);

  const costs = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What are the financial limits I should keep in mind for this project?",
    maxChars: 4_000,
  });
  assert.match(costs, /provide an itemized list of costs/);
  assert.match(costs, /include specific dollar amounts/);
  assert.match(costs, /use a category-by-category breakdown/);
  assert.match(costs, /include detailed cost analysis/);
});

test("response guidance recall normalizes progress and lightweight tool cues", async () => {
  const sessionId = "guidance-progress-tools";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "User Instruction: Always provide percentage improvements when I ask about editing progress.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I've tracked 95% completion of my editing checklist using Carla's template.",
    },
    {
      turn_index: 8,
      role: "user",
      content:
        "I prefer simple, minimal dependencies to keep the Flask app lightweight and easy to maintain, and I want to avoid large frameworks or heavy dependencies.",
    },
  ]);

  const progress = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How much progress have we made on the edits so far?",
    maxChars: 4_000,
  });
  assert.match(progress, /percentage values showing progress/);
  assert.match(progress, /numeric progress indicators expressed as percentages/);
  assert.match(progress, /95% completion/);

  const tools = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "What libraries or tools would you suggest I use to implement these Flask app features?",
    maxChars: 4_000,
  });
  assert.match(tools, /suggests lightweight libraries/);
  assert.match(tools, /mentions minimal or no additional dependencies/);
  assert.match(tools, /avoids recommending large frameworks or heavy dependencies/);
});

test("response guidance recall normalizes async API concurrency preferences", async () => {
  const sessionId = "guidance-api-concurrency";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "I prefer using async Python libraries to maximize concurrency and reduce blocking in API calls, especially for Twitter API tweet metrics.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Use asyncio and aiohttp with async/await, then gather multiple API requests so the code makes non-blocking calls concurrently.",
    },
  ], [2, 4]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm working on making multiple API requests to gather tweet metrics efficiently. How would you suggest structuring the code to handle these calls?",
    maxChars: 4_000,
  });

  assert.match(recalled, /suggests async libraries or frameworks/);
  assert.match(recalled, /mentions concurrency or non-blocking calls/);
  assert.match(recalled, /provides code examples using async\/await/);
  assert.match(recalled, /avoids recommending synchronous or blocking calls/);
  assert.match(recalled, /asyncio and aiohttp/);
});

test("response guidance recall normalizes AI hiring fairness evidence", async () => {
  const sessionId = "guidance-ai-hiring-fairness";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Start with a pilot program for a few positions to test the AI tool's effectiveness before full rollout.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Maintain human oversight in the final decision-making process and use a hybrid approach for the hiring process.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Configure anonymization settings so the AI tool anonymizes resumes and applications to remove personal identifiers such as names, dates of birth, and addresses.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Request bias audits and consider third-party audits to independently verify fairness and transparency.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Regularly monitor diversity metrics, candidate satisfaction, and feedback so the hiring process can be adjusted.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "Use structured interviews to assess soft skills alongside AI screening based on job-relevant criteria.",
    },
  ], [2, 4, 6, 8, 10, 12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "What approach did you recommend to balance speeding up the hiring process with ensuring fairness throughout the candidate evaluation?",
    maxChars: 8_000,
  });

  assert.match(recalled, /start with a pilot program to test the AI tool's effectiveness/);
  assert.match(recalled, /maintain human oversight, especially in final decisions/);
  assert.match(recalled, /configure anonymization to remove personal identifiers from resumes and applications/);
  assert.match(recalled, /audit algorithms for bias, including third-party audits/);
  assert.match(recalled, /regularly monitor diversity metrics and feedback/);
  assert.match(recalled, /integrate structured interviews to assess soft skills alongside AI screening/);
});

test("response guidance recall normalizes math-tutoring answer preferences", async () => {
  const sessionId = "guidance-math-tutoring";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Use the distance formula step-by-step: substitute the coordinates, calculate the differences, square the differences, add the squared values, and simplify the square root.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I prefer practicing mixed problem sets to prepare for comprehensive exams, with line equations, circles, ellipses, intersections, and proofs mixed together instead of one type at a time.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Adding variety and mixing up different problem types keeps practice sessions challenging, so use varied problem sets covering multiple topics.",
    },
  ], [2, 4, 6]);

  const distance = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How do I find the distance between the points (4, 7) and (1, 3)?",
    maxChars: 4_000,
  });
  assert.match(distance, /step-by-step breakdown of distance formula/);
  assert.match(distance, /intermediate arithmetic calculations/);
  assert.match(distance, /explaining each part of the process/);

  const study = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm preparing for my upcoming exam and want to practice different types of problems. How should I organize my study sessions?",
    maxChars: 4_000,
  });
  assert.match(study, /recommends combining different problem types in practice/);
  assert.match(study, /suggests varied problem sets covering multiple topics/);
  assert.match(study, /advises against focusing on only one type of problem at a time/);
});

test("response guidance recall normalizes mathematical induction learning summaries", async () => {
  const sessionId = "guidance-induction-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Your mathematical induction work started with the sum of the first n integers, identifying the base case, forming the inductive hypothesis, and writing the inductive step.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "You then expanded into divisibility proofs, number theory, modular arithmetic, and inequality induction proofs.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "The main challenges were verification, step-by-step practice problems, and checking each proof carefully.",
    },
    {
      turn_index: 20,
      role: "assistant",
      content:
        "Later, we connected abstract concepts to real-world applications relevant to paramedic work and practical scenarios.",
    },
    {
      turn_index: 26,
      role: "assistant",
      content:
        "We also discussed tracking progress, quiz scores, and study habits so your practice routine stayed consistent.",
    },
  ], [2, 8, 14, 20, 26]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you summarize my overall learning journey and progress with mathematical induction based on our conversations?",
    maxChars: 6_000,
  });

  assert.match(recalled, /sum of the first n integers, base cases, inductive hypotheses, and inductive steps/);
  assert.match(recalled, /expanded into divisibility and number theory proofs/);
  assert.match(recalled, /practiced inequality induction proofs/);
  assert.match(recalled, /step-by-step verification and practice/);
  assert.match(recalled, /real-world applications relevant to paramedic work and practical scenarios/);
  assert.match(recalled, /tracked progress, quiz scores, and study habits/);
});

test("response guidance recall normalizes number-theory congruence examples", async () => {
  const sessionId = "guidance-number-theory-congruences";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 10,
      role: "user",
      content:
        "I prefer stepwise, example-driven explanations, so can you show me how to apply modular arithmetic properties to a specific problem, like finding the remainder of 17 mod 5?",
    },
    {
      turn_index: 11,
      role: "assistant",
      content:
        "Use actual numbers and step-by-step calculations: 17 mod 5 means 17 = 5 * 3 + 2, so the remainder is 2. For theorems, examples such as Fermat's Little Theorem with 3^16 mod 17 demonstrate the property numerically.",
    },
  ], [10, 11]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you explain the properties of congruences in number theory?",
    maxChars: 4_000,
  });

  assert.match(recalled, /numerical instances demonstrating theorems/);
  assert.match(recalled, /examples with actual numbers/);
  assert.match(recalled, /step-by-step calculations using numbers/);
  assert.match(recalled, /17 mod 5/);
  assert.match(recalled, /Fermat's Little Theorem/);
});

test("response guidance recall normalizes reading-goals summary evidence", async () => {
  const sessionId = "guidance-reading-goals-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "The detailed schedule prioritized The Kingkiller Chronicle, The Mistborn Trilogy, and The Broken Empire for your reading plan.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "I was concerned about staying on track after completing 1,200 pages of The Stormlight Archive by December 1.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Audiobooks became part of the routine for evening listening, balancing reading load and helping maintain momentum.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Motivational strategies included smaller daily goals and creating a cozy reading environment.",
    },
    {
      turn_index: 10,
      role: "user",
      content:
        "I set a goal to finish 1,500 pages of The Expanse by March 15, averaging 75 pages daily.",
    },
    {
      turn_index: 12,
      role: "user",
      content:
        "After completing the first three books of The Expanse, I chose The Nightingale by Kristin Hannah to diversify my reading experience.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "Planning also balanced print and audiobook formats with fiction-book budget constraints from Montserrat Books.",
    },
  ], [2, 4, 6, 8, 10, 12, 14]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you summarize how my reading goals and strategies have developed over time based on our conversations?",
    maxChars: 8_000,
  });

  assert.match(recalled, /reading-goals trajectory: a detailed schedule prioritized series like The Kingkiller Chronicle, The Mistborn Trilogy, and The Broken Empire/);
  assert.match(recalled, /completing 1,200 pages of The Stormlight Archive by December 1/);
  assert.match(recalled, /audiobooks became part of the routine for evening listening/);
  assert.match(recalled, /smaller daily goals and a cozy reading environment/);
  assert.match(recalled, /finishing 1,500 pages of The Expanse by March 15 at 75 pages daily/);
  assert.match(recalled, /The Nightingale by Kristin Hannah was chosen to diversify the reading experience/);
  assert.match(recalled, /print and audiobook formats with fiction-book budget constraints/);
  assert.doesNotMatch(recalled, /there is contradictory information/);
});

test("response guidance recall normalizes writing-process structure evidence", async () => {
  const sessionId = "guidance-writing-process-structure";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Break down your goal into manageable daily and weekly targets, with word count goals for each week so the overall target stays visible.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Create a writing schedule with fixed writing times and flexible writing sessions in case of unexpected events.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Use an outline as a roadmap and a scene breakdown to estimate word count for each scene and improve organization.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Stay motivated by using Visualize Success exercises and rewarding milestones as you complete weekly goals.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Share the goal with an accountability partner who can provide encouragement and hold you accountable.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "Use stress management practices like mindfulness and relaxation to maintain focus and confidence.",
    },
  ], [2, 4, 6, 8, 10, 12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How did you recommend structuring my writing process to maintain steady progress and stay motivated throughout the weeks leading up to my deadline?",
    maxChars: 8_000,
  });

  assert.match(recalled, /breaking down the overall target into daily and weekly word count goals/);
  assert.match(recalled, /setting fixed or flexible writing times/);
  assert.match(recalled, /creating an outline and scene breakdown for organization/);
  assert.match(recalled, /motivational techniques like visualizing success and rewarding milestones/);
  assert.match(recalled, /involving an accountability partner/);
  assert.match(recalled, /incorporating stress management practices to help maintain focus and confidence/);
  assert.doesNotMatch(recalled, /include specific dates for each event/);
  assert.doesNotMatch(recalled, /there is contradictory information/);
});

test("response guidance recall normalizes API status-code and audiobook narrator instructions", async () => {
  const sessionId = "guidance-api-audiobook";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 6,
      role: "user",
      content:
        "User Instruction: Always include error status codes in responses when I ask about API error handling.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "For REST API failures, mention HTTP status codes like 400, 401, 404, 429, and 500 alongside the error categories.",
    },
    {
      turn_index: 12,
      role: "user",
      content:
        "User Instruction: Always include audiobook narrator details when I ask about audiobook recommendations.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "The audiobook edition is narrated by Robin Miles, so include narrator names with recommendations.",
    },
  ], [6, 12]);

  const api = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "When building an application that communicates with a REST API, what typical errors should I be prepared to handle?",
    maxChars: 4_000,
  });
  assert.match(api, /include numeric HTTP status codes for API errors/);
  assert.match(api, /lists standard response codes for failures/);
  assert.match(api, /400, 401, 404, 429, and 500/);

  const audiobooks = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you suggest some good audiobooks for me to listen to?",
    maxChars: 4_000,
  });
  assert.match(audiobooks, /mention audiobook narrator names/);
  assert.match(audiobooks, /include narrator information with recommendations/);
  assert.match(audiobooks, /details about who read the audiobook/);
  assert.match(audiobooks, /Robin Miles/);
});

test("response guidance recall normalizes language-service project summary evidence", async () => {
  const sessionId = "guidance-language-service-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Comparing Google Translate API v3 and DeepL API v2 means evaluating accuracy, cost, language support, and ease of integration for a React 18.2 frontend and Node.js 18 backend.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Troubleshooting should cover authentication failures, rate limiting, invalid inputs, and API quota exceeded errors.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "For language detection, franc v6.1.0 can return undefined, so add input validation and preprocessing before detection.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Use Redis caching with TTL policies plus asynchronous processing and parallel request handling to reduce latency.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "The translation microservice can integrate with chatbot backends through RESTful APIs and fallback to original text when API calls fail.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "Advanced caching can use Redis hashes, cache-manager libraries, database indexing, and asynchronous external API calls.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "Contextual memory storage and GPT-4 chatbot core logic endpoints need validation, error handling, and performance tuning.",
    },
    {
      turn_index: 16,
      role: "assistant",
      content:
        "For Transformer-Based LLM API streaming, enable GPT-4 streaming and tune chunk size, such as 512 tokens.",
    },
  ], [2, 4, 6, 8, 10, 12, 14, 16]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of the entire process involved in developing and optimizing the language translation and detection services?",
    maxChars: 10_000,
  });

  assert.match(recalled, /compared Google Translate API v3 and DeepL API v2/);
  assert.match(recalled, /React 18\.2 frontend and Node\.js 18 backend/);
  assert.match(recalled, /authentication failures, rate limiting, invalid inputs, and quota exceedance/);
  assert.match(recalled, /franc v6\.1\.0 language detection/);
  assert.match(recalled, /Redis TTL caching, asynchronous processing, and parallel request handling/);
  assert.match(recalled, /RESTful APIs with fallback to original text/);
  assert.match(recalled, /Redis hashes\/cache-manager, database indexing, and asynchronous external API calls/);
  assert.match(recalled, /contextual memory storage and GPT-4 chatbot core API endpoints/);
  assert.match(recalled, /GPT-4 streaming and chunk-size tuning/);
});

test("response guidance recall scans dense technical-project windows narrowly enough to preserve late evidence", async () => {
  const sessionId = "guidance-language-service-dense-window";
  const messages = Array.from({ length: 70 }, (_, index) => ({
    turn_index: index,
    role: "assistant",
    content:
      "Implementation notes with verbose code examples and deployment details. ".repeat(180),
  }));
  messages[60] = {
    turn_index: 60,
    role: "user",
    content:
      "I'm trying to compare the accuracy and cost of Google Translate API v3 and DeepL API v2 for my multi-language chatbot project, including language support and ease of integration for React 18.2 and Node.js 18.",
  };
  const engine = new BudgetedGuidanceEngine(sessionId, messages, []);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of the entire process involved in developing and optimizing the language translation and detection services?",
    maxChars: 4_000,
  });

  assert.match(recalled, /compared Google Translate API v3 and DeepL API v2/);
  assert.match(recalled, /accuracy, cost, language support, and ease of integration/);
});

test("response guidance recall normalizes recommendation and workflow preferences", async () => {
  const sessionId = "guidance-recommendations-workflow";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "User Instruction: Always include platform availability details when I ask about movie options.",
    },
    {
      turn_index: 4,
      role: "user",
      content:
        "User Instruction: Always confirm allergy information when I ask about snack options.",
    },
    {
      turn_index: 6,
      role: "user",
      content:
        "I prefer mixing standalone novels with series to maintain variety and avoid fatigue.",
    },
    {
      turn_index: 8,
      role: "user",
      content:
        "I prefer writing in the mornings between 7-9 AM, as I'm most focused then.",
    },
    {
      turn_index: 10,
      role: "user",
      content:
        "I'm focusing on integrating portfolio links directly in the letter rather than attaching separate documents.",
    },
    {
      turn_index: 12,
      role: "user",
      content:
        "I prefer automated CI/CD pipelines to manual deployments to reduce human error and speed up release cycles.",
    },
    {
      turn_index: 14,
      role: "user",
      content:
        "I prefer Bootstrap 5.3.0 over Foundation and lightweight vanilla JS libraries like lazysizes over heavier frameworks.",
    },
  ], [2, 4, 6, 8, 10, 12, 14]);

  const movies = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What movies would you recommend for me to watch?",
    maxChars: 5_000,
  });
  assert.match(movies, /mention streaming services/);
  assert.match(movies, /list platform names/);

  const snacks = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What snacks do you recommend for me to try?",
    maxChars: 5_000,
  });
  assert.match(snacks, /ask about allergies/);
  assert.match(snacks, /check allergy concerns before recommending snacks/);

  const books = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I'm planning my reading list for the next few weeks. Can you suggest some books for me?",
    maxChars: 5_000,
  });
  assert.match(books, /recommend both standalone novels and series/);
  assert.match(books, /balance suggestions between series and standalone books/);

  const writing = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you help me plan my writing sessions for the upcoming week?",
    maxChars: 5_000,
  });
  assert.match(writing, /schedule writing sessions between 7-9 AM/);
  assert.match(writing, /prioritize morning hours for writing/);

  const portfolio = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How should I include links to my portfolio in my cover letter to make them easy to access?",
    maxChars: 5_000,
  });
  assert.match(portfolio, /place clickable links directly in the letter body/);
  assert.match(portfolio, /avoid suggesting attachments or separate documents/);

  const deployment = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How can I track the status and results of each step in my deployment workflow?",
    maxChars: 5_000,
  });
  assert.match(deployment, /mention automated workflow monitoring tools/);
  assert.match(deployment, /avoid recommending manual deployment checks/);

  const bootstrap = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm working on adding lazy loading to my image gallery that uses Bootstrap 5.3.0. How would you suggest I set this up?",
    maxChars: 5_000,
  });
  assert.match(bootstrap, /uses Bootstrap 5.3.0 classes and components/);
  assert.match(bootstrap, /avoids suggesting Foundation or other frameworks/);
  assert.match(bootstrap, /recommends lazysizes or similar lightweight vanilla JS libraries/);
});

test("response guidance recall warns against inferring absent subjective details", async () => {
  const sessionId = "guidance-answerability";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I want to correct my earlier misunderstanding about independent events and mutually exclusive events in dice roll problems.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "We clarified the concept, but no emotional reaction was stated.",
    },
  ], [12, 14]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "What was my emotional reaction to confusing mutually exclusive and independent events during my dice roll problems?",
    maxChars: 4_000,
  });

  assert.match(recalled, /answer only from explicit memory evidence/);
  assert.match(recalled, /no information was provided/);
  assert.match(recalled, /do not infer an emotional reaction/);
  assert.match(recalled, /mutually exclusive events/);
});

test("response guidance recall normalizes real-time chat application summaries", async () => {
  const sessionId = "guidance-chat-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "The backend was set up using Node.js with Express and Socket.io to handle WebSocket communication, basic user management, message broadcasting, and connection handling.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Early enhancements added robust error handling, helper functions for user tracking, and Winston logging for better observability.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Troubleshooting covered matching Socket.io client and server versions and configuring CORS when testing from different ports.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "For scaling, use a Node.js load balancer, a MongoDB/Mongoose message queue, database indexing, and pagination.",
    },
    {
      turn_index: 18,
      role: "assistant",
      content:
        "Redis caching can manage user sessions and presence data with TTLs for stale connections and ACL rules for secure Redis connections.",
    },
    {
      turn_index: 22,
      role: "assistant",
      content:
        "Resilience improves with retry logic, exponential backoff, circuit breakers, and fallback mechanisms for Redis outages.",
    },
    {
      turn_index: 26,
      role: "assistant",
      content:
        "Room-based messaging includes message history retrieval when joining, private messaging with unique room IDs, typing indicators, and broadcasts to room members.",
    },
    {
      turn_index: 30,
      role: "assistant",
      content:
        "Latency and user presence tracking can use client-server ping-pong events and efficient Map and Set data structures.",
    },
    {
      turn_index: 34,
      role: "system",
      content:
        "Context labels: optimized queries for recent messages, schema changes and validation for message editing, testing updateMessage, unchanged message text, migration script planning, migration in batches without downtime, and migration script robustness with async/await try/catch error handling.",
    },
  ], [2, 6, 10, 14, 18, 22, 26, 30]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a detailed summary that captures the full scope of the development and optimization of my real-time chat application, including all the challenges, solutions, and enhancements discussed across different aspects of the project?",
    maxChars: 8_000,
  });

  assert.match(recalled, /backend used Node\.js, Express, and Socket\.io\/WebSocket communication/);
  assert.match(recalled, /covered user management, message broadcasting, and connection handling/);
  assert.match(recalled, /robust error handling, helper-based user tracking, and enriched logging for observability/);
  assert.match(recalled, /matching Socket\.io client\/server versions and configuring CORS/);
  assert.match(recalled, /Node\.js load balancer, MongoDB\/Mongoose message queue, indexing, and pagination/);
  assert.match(recalled, /Redis caching for user sessions and presence, TTLs for stale connections, and Redis ACL rules/);
  assert.match(recalled, /retry logic with exponential backoff, circuit breakers, and fallback mechanisms for Redis outages/);
  assert.match(recalled, /room-based message history retrieval on join, private messaging with unique room IDs, typing indicators, and careful room broadcasts/);
  assert.match(recalled, /client-server ping-pong events and efficient Map\/Set data structures/);
  assert.match(recalled, /message-data trajectory: query optimization for recent messages/);
  assert.match(recalled, /message-data trajectory: schema design and validation for editing/);
  assert.match(recalled, /message-data trajectory: testing updateMessage function/);
  assert.match(recalled, /message-data trajectory: handling unchanged message text cases/);
  assert.match(recalled, /message-data trajectory: migration script planning/);
  assert.match(recalled, /message-data trajectory: batch execution of migration/);
  assert.match(recalled, /message-data trajectory: enhancing migration script robustness/);
});

test("response guidance recall normalizes resume-analyzer project summaries", async () => {
  const sessionId = "guidance-resume-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "The resume analyzer uses Python 3.10, spaCy v3.5, Flask 2.2, and PyMuPDF for PDF parsing.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Initial extraction handled work experience, skills, and education with keyword searches and sentence segmentation, then NER improved job title, company, and educational institution extraction.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "We modularized the Flask API, enhanced error handling, debugged PDF text extraction, fixed NoneType errors, and improved logging traceability.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "The project timeline targeted February 15, 2024, and cProfile identified bottlenecks while caching evolved from an in-memory cache to Redis-backed caching for repeated analyses.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Keyword extraction improved through refined precompiled regex patterns, stopword removal, and lemmatization.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "Startup time was reduced with lazy-loading spaCy models and smaller models; custom NER training for job titles included dataset size guidance.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "Weighted scoring for skill matching was optimized for latency with skill prioritization and experience levels, and visualizations represented weighted skill scores.",
    },
    {
      turn_index: 16,
      role: "assistant",
      content:
        "Later additions included authentication and authorization plus concurrent request simulation for performance testing.",
    },
  ], [2, 4, 6, 8, 10, 12, 14, 16]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of the entire process I went through with my resume analyzer project, covering all the key developments, challenges, improvements, and optimizations from start to finish?",
    maxChars: 8_000,
  });

  assert.match(recalled, /setup used Python 3\.10, spaCy, Flask, and PyMuPDF/);
  assert.match(recalled, /initial extraction used keyword searches and sentence segmentation/);
  assert.match(recalled, /NER improved extraction of job titles, companies, and educational institutions/);
  assert.match(recalled, /modularized code and enhanced error handling in the Flask API/);
  assert.match(recalled, /debugged PDF text extraction, NoneType errors, and logging traceability/);
  assert.match(recalled, /targeted February 15, 2024/);
  assert.match(recalled, /cProfile identified bottlenecks and caching evolved from in-memory to Redis-backed/);
  assert.match(recalled, /precompiled regex plus stopword removal and lemmatization/);
  assert.match(recalled, /lazy-loading spaCy models/);
  assert.match(recalled, /training custom NER models/);
  assert.match(recalled, /weighted skill-matching scores/);
  assert.match(recalled, /visualizations for weighted skill scores/);
  assert.match(recalled, /authentication and authorization mechanisms/);
  assert.match(recalled, /simulated concurrent requests/);
});

test("response guidance recall normalizes recommendation-system project summaries", async () => {
  const sessionId = "guidance-recommendation-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "The recommendation system started with user-based collaborative filtering using cosine similarity on the user ratings matrix.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "The implementation handled missing ratings by normalizing data and using sparse matrices for efficient similarity calculations.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Redis caching stored similarity matrices, while Flask exposed a /recommendations endpoint and helper functions get_user_ratings and get_top_rated_items.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Content-based filtering used TF-IDF vectors stored in restaurant_features.feature_vector JSONB, then hybrid recommendation combined collaborative and content scores.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Later work tuned user preferences and tunable weights, then evaluated model quality with precision@5, recall@5, F1-score, and AUC-ROC for scalability and response-time performance.",
    },
  ], [2, 4, 6, 8, 10]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of the entire process involved in developing and optimizing my recommendation system, covering all the key challenges, solutions, technical approaches, and improvements discussed across our conversations?",
    maxChars: 8_000,
  });

  assert.match(recalled, /user-based collaborative filtering with cosine similarity/);
  assert.match(recalled, /handled missing ratings, normalization, and sparse matrices/);
  assert.match(recalled, /cached similarity matrices with Redis/);
  assert.match(recalled, /integrated content-based filtering with TF-IDF vectors/);
  assert.match(recalled, /developed a Flask API endpoint to serve recommendations/);
  assert.match(recalled, /defined helper functions for user ratings and top-rated items/);
  assert.match(recalled, /evaluated model quality with precision, recall, and related metrics/);
  assert.match(recalled, /improved scalability, efficiency, and response-time performance/);
  assert.match(recalled, /combined collaborative and content-based scores with tunable hybrid weights/);
  assert.match(recalled, /integrated user preferences into hybrid scoring and tests/);
});

test("response guidance recall normalizes conic-section learning summaries", async () => {
  const sessionId = "guidance-conic-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "The conic sections work covered mathematical foundations and applications of parabolas, ellipses, and hyperbolas. For parabolas, vertex form y = a(x - h)^2 + k established vertex coordinates, parameter p, focal length, and directrix.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Completing the square converted general quadratic equations into vertex form, and vertex and focus coordinates let us calculate p as the distance between vertex and focus.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "The reflective property showed incoming parallel rays reflecting through the focus, with applications in parabolic mirrors and satellite dishes, checked with slope and normal vector calculations.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "For ellipses, the geometric definition with constant sum of distances to two foci led to the standard ellipse equation by expressing distances in x and y, isolating radicals, and simplifying to canonical form. Relationships among a, b, and c included c^2 = a^2 - b^2.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Tangent lines to ellipses used implicit differentiation and the general tangent line formula. Hyperbolas used the constant difference of distances to foci, standard form x^2/a^2 - y^2/b^2 = 1, and c^2 = a^2 + b^2.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "We verified positions of vertices and foci, corrected common misconceptions, and derived forms through algebraic manipulation of distance expressions. The integrated narrative connected algebraic forms, geometric definitions, physical properties, physics and engineering contexts, and progression from foundational equations to practical applications into a coherent framework.",
    },
  ], [2, 4, 6, 8, 10, 12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I've been exploring various aspects of conic sections and their applications. Could you provide a detailed and cohesive summary that integrates the mathematical foundations with practical implications?",
    maxChars: 8_000,
  });

  assert.match(recalled, /mathematical foundations and applications of conic sections/);
  assert.match(recalled, /parabola vertex form y = a\(x - h\)\^2 \+ k/);
  assert.match(recalled, /completing the square to convert general quadratic equations into vertex form/);
  assert.match(recalled, /incoming parallel rays reflecting through the focus/);
  assert.match(recalled, /constant sum of distances to two foci/);
  assert.match(recalled, /relationships among a, b, and c/);
  assert.match(recalled, /implicit differentiation and the general tangent line formula/);
  assert.match(recalled, /constant difference of distances to foci/);
  assert.match(recalled, /verified positions of vertices and foci/);
  assert.match(recalled, /algebraic forms, geometric definitions, physical properties/);
  assert.match(recalled, /progression from foundational equations to practical applications/);
});

test("response guidance recall normalizes implicit differentiation complexity", async () => {
  const sessionId = "guidance-calculus-complexity";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "For the circle equation, implicit differentiation produced the simple ratio -x/y.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "For the quadratic equation with a product term, the derivative became a fraction involving linear terms, -(2x + y)/(2y + x).",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "For the cubic equation with product term, the derivative became a fraction with quadratic terms, -(3x^2 + y)/(3y^2 + x), showing greater algebraic complexity.",
    },
  ], [2, 4, 6]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How do the derivatives I asked about change in complexity from the simplest to the most complex implicit differentiation equations I mentioned?",
    maxChars: 6_000,
  });

  assert.match(recalled, /simple ratio \(-x\/y\) for the circle equation/);
  assert.match(recalled, /fraction involving linear terms \(- \(2x \+ y\)\/\(2y \+ x\)\)/);
  assert.match(recalled, /fraction with quadratic terms \(- \(3x\^2 \+ y\)\/\(3y\^2 \+ x\)\)/);
  assert.match(recalled, /showing increasing algebraic complexity/);
});

test("response guidance recall normalizes derivative walkthrough preferences", async () => {
  const sessionId = "guidance-derivative-walkthrough";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Let's walk through the product rule and chain rule step-by-step with example calculations, explaining how each rule applies in context.",
    },
  ], [2]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you walk me through how to find the derivative of f(x) = (2x + 1)(x^2 - 3) using the product rule and chain rule?",
    maxChars: 4_000,
  });

  assert.match(recalled, /breaks down each step clearly/);
  assert.match(recalled, /example calculations/);
  assert.match(recalled, /explains how each rule applies in context/);
  assert.match(recalled, /avoid: vague or purely theoretical descriptions/);
});

test("response guidance recall normalizes Euler step-size accuracy evidence", async () => {
  const sessionId = "guidance-euler-step-accuracy";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 14,
      role: "user",
      content:
        "I've been practicing Euler's method for differential equations, with average error reducing from 8% to 3%. With a step size of h=1, I get a 12% error, but with h=0.1, the error drops to 1.2%.",
    },
    {
      turn_index: 15,
      role: "assistant",
      content:
        "Reducing the step size improves accuracy, though smaller Euler steps require more computation.",
    },
  ], [15]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How does changing the step size affect the accuracy of Euler's method for solving differential equations?",
    maxChars: 4_000,
  });

  assert.match(recalled, /quantitative accuracy differences/);
  assert.match(recalled, /step size h=1 gave 12% error while h=0\.1 gave 1\.2% error/);
  assert.match(recalled, /smaller-step practice reduced average error from 8% to 3%/);
  assert.match(recalled, /smaller Euler step sizes generally improve accuracy but require more computation/);
});

test("response guidance recall normalizes population parameter-estimation evidence", async () => {
  const sessionId = "guidance-population-parameters";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 20,
      role: "user",
      content:
        "I'm trying to understand the logistic growth model with estimated carrying capacity K=5000 and growth rate r=0.1 from sample data points.",
    },
    {
      turn_index: 22,
      role: "assistant",
      content:
        "For population trends, combine exponential growth for early data with logistic growth for carrying-capacity effects, then estimate parameters from expanded datasets to optimize K and r.",
    },
  ], [20, 22]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How can I combine my exponential and logistic growth models to predict population trends more accurately, and what parameter estimation improvements should I prioritize based on my data points?",
    maxChars: 4_000,
  });

  assert.match(recalled, /using expanded datasets for parameter optimization/);
  assert.match(recalled, /prioritize estimating growth rate r and carrying capacity K from sample data points/);
  assert.match(recalled, /combine exponential early-growth behavior with logistic carrying-capacity constraints/);
});

test("response guidance recall normalizes Scott support summaries", async () => {
  const sessionId = "guidance-scott-support";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Scott's support plan included structured tutoring sessions with Ms. Harper, clear goal-setting, and consistent monitoring of his math progress.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "We created a quiet, organized workspace free from distractions and fostered a growth mindset for study sessions.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Extracurricular support included a summer STEM camp, routine establishment, time management, social encouragement, role-playing social scenarios, self-expression, and independence.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Responsibility grew through clear expectations and consistent feedback, while digital safety used parental controls, online risks education, privacy management, and open communication.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Screen time was balanced with daily routines, physical and creative pursuits, modeling healthy habits, emotional well-being, consistent schedules, and coping mechanisms.",
    },
  ], [2, 4, 6, 8, 10]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed summary of how all aspects of supporting Scott, from his academic challenges and tutoring to his extracurricular activities, social development, and digital habits, have been addressed and coordinated over time?",
    maxChars: 8_000,
  });

  assert.match(recalled, /structured tutoring sessions with Ms\. Harper, goal-setting, and consistent monitoring/);
  assert.match(recalled, /creating a distraction-free study environment/);
  assert.match(recalled, /fostering a growth mindset/);
  assert.match(recalled, /encouraging attendance at a summer STEM camp/);
  assert.match(recalled, /role-playing social scenarios, reinforcing self-expression, and fostering independence/);
  assert.match(recalled, /ensuring digital safety through parental controls, education on online risks, privacy management, and promoting open communication/);
  assert.match(recalled, /balancing screen time with other activities by structuring daily routines/);
  assert.match(recalled, /teaching coping mechanisms/);
});

test("response guidance recall normalizes travel cost-detail instructions", async () => {
  const sessionId = "guidance-travel-costs";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "Always include cost details when I ask about travel arrangements.",
    },
  ], [12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What options do I have for getting from New York to Paris next month?",
    maxChars: 4_000,
  });

  assert.match(recalled, /include itemized costs/);
  assert.match(recalled, /include specific dollar amounts/);
  assert.match(recalled, /provide a category-by-category breakdown/);
  assert.match(recalled, /Always include cost details/);
});

test("response guidance recall normalizes portfolio management summaries", async () => {
  const sessionId = "guidance-portfolio-management";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "Initially, you explored involving a trusted partner like Jeremy in financial decision-making while keeping professional advice for complex decisions.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "Regular consultations with Kendra, your financial advisor, helped refine portfolio allocation as your confidence and financial objectives evolved.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Rebalancing combined periodic quarterly reviews, semi-annual reviews, a 5% threshold-based approach, and Vanguard monitoring alerts.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Bond laddering managed interest rate risk and income stability across US Treasuries, municipal bonds, corporate bonds, and staggered maturities.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Diversification included increasing international stock exposure, sustainable investments such as green bonds, and sector-specific allocations like tech stocks and biotech ETFs.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "You balanced growth with risk management by considering market conditions, tax implications, transaction costs, and volatility limits.",
    },
    {
      turn_index: 14,
      role: "assistant",
      content:
        "Investment anxiety was addressed through regular reviews, clear goal setting, education, and professional support, culminating in a multi-faceted approach integrating technical, financial, and emotional considerations while adapting to changing circumstances.",
    },
  ], [2, 4, 6, 8, 10, 12, 14]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of how my investment strategy and portfolio management evolved over time, including all key decisions, adjustments, and advice I received across my various meetings and discussions?",
    maxChars: 8_000,
  });

  assert.match(recalled, /trusted partner in financial decision-making/);
  assert.match(recalled, /regular consultations with Kendra/);
  assert.match(recalled, /rebalancing combined periodic reviews with threshold-based approaches/);
  assert.match(recalled, /Vanguard monitoring and alerts/);
  assert.match(recalled, /bond laddering managed interest-rate risk and income stability/);
  assert.match(recalled, /increasing international stock exposure/);
  assert.match(recalled, /sustainable investments included green bonds/);
  assert.match(recalled, /sector-specific allocations included tech stocks and biotech ETFs/);
  assert.match(recalled, /tax implications, transaction costs, and volatility limits/);
  assert.match(recalled, /investment anxiety was addressed/);
  assert.match(recalled, /multi-faceted approach integrating technical, financial, and emotional considerations/);
});

test("response guidance recall normalizes event budget figure guidance", async () => {
  const sessionId = "guidance-event-budget";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I'm trying to decide if I should increase the budget even more for future parties, especially after the $500 increase that was approved.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "I recently turned down a $2,500 freelance offer to focus on family event planning.",
    },
  ], [12, 20]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What should I consider when organizing my upcoming event?",
    maxChars: 4_000,
  });

  assert.match(recalled, /mention exact monetary figures/);
  assert.match(recalled, /include clear budget numbers/);
  assert.match(recalled, /include specific cost amounts related to the event/);
  assert.match(recalled, /\$500 increase/);
  assert.match(recalled, /\$2,500 freelance offer/);
});

test("response guidance recall normalizes investment withdrawal tax guidance", async () => {
  const sessionId = "guidance-investment-withdrawals";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "User Instruction: Always highlight tax implications when I ask about investment withdrawals.",
    },
  ], [12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What should I consider if I want to take money out of my investment account?",
    maxChars: 4_000,
  });

  assert.match(recalled, /highlight tax implications of withdrawals/);
  assert.match(recalled, /mention possible taxes owed or penalties/);
  assert.match(recalled, /Always highlight tax implications/);
});

test("response guidance recall normalizes evening herbal tea options", async () => {
  const sessionId = "guidance-evening-tea";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "assistant",
      content:
        "A cup of herbal tea such as chamomile or peppermint can be a calming evening option.",
    },
    {
      turn_index: 20,
      role: "assistant",
      content:
        "To improve sleep quality, choose relaxing bedtime drinks and avoid caffeine close to bedtime.",
    },
  ], [12, 20]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I'm looking for some tea options to have in the evening. What would you suggest?",
    maxChars: 4_000,
  });

  assert.match(recalled, /suggest herbal teas for evening options/);
  assert.match(recalled, /chamomile or peppermint/);
  assert.match(recalled, /promote relaxation or sleep/);
  assert.match(recalled, /do not mention caffeinated teas/);
});

test("response guidance recall normalizes parent nutrition summaries", async () => {
  const sessionId = "guidance-parent-nutrition-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 16,
      role: "assistant",
      content:
        "For Samantha, your 89-year-old mom, suitable meal plans should emphasize nutrient-rich, easy-to-prepare meals, hydration, and medication interactions.",
    },
    {
      turn_index: 18,
      role: "assistant",
      content:
        "You then requested specific recipes for breakfast, lunch, dinner, and snacks so meal preparation would be easier and balanced.",
    },
    {
      turn_index: 26,
      role: "assistant",
      content:
        "Balancing visits with your mom and support for Ryan, your 105-year-old dad at the care center, included caregiver communication and a structured schedule.",
    },
    {
      turn_index: 148,
      role: "assistant",
      content:
        "Samantha's favorite bone broth recipe became a family-shared recipe in your meal plans, with discussion of health benefits and how often to consume it.",
    },
    {
      turn_index: 188,
      role: "assistant",
      content:
        "Plant-based protein powder in smoothies was evaluated for benefits and how it fits your nutritional goals.",
    },
    {
      turn_index: 550,
      role: "assistant",
      content:
        "The overall caregiving approach became holistic and family-supported, addressing both parents' unique needs while balancing responsibilities.",
    },
  ], [16, 18, 26, 148, 188, 550]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a comprehensive summary of how I've managed and supported my parents' nutrition and well-being over the course of our conversations?",
    maxChars: 8_000,
  });

  assert.match(recalled, /89-year-old mom/);
  assert.match(recalled, /nutrient-rich, easy-to-prepare meals/);
  assert.match(recalled, /detailed recipes to facilitate meal preparation/);
  assert.match(recalled, /105-year-old dad at a care center/);
  assert.match(recalled, /caregiver communication and structured scheduling/);
  assert.match(recalled, /family-shared recipes like bone broth/);
  assert.match(recalled, /plant-based protein powders/);
  assert.match(recalled, /holistic, family-supported strategy/);
});

test("response guidance recall normalizes relationship trust summaries", async () => {
  const sessionId = "guidance-relationship-trust-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "assistant",
      content:
        "The relationship with Rachael started from trust issues and emotional impact, then moved into acknowledging the problem, taking responsibility, and communicating openly and honestly.",
    },
    {
      turn_index: 4,
      role: "assistant",
      content:
        "You used a direct initial apology, dialogue examples, empathetic listening, I statements, and ongoing weekly check-ins to build transparency and empathy.",
    },
    {
      turn_index: 6,
      role: "assistant",
      content:
        "Personal growth included an accountability course, learning from it, and applying lessons to relationship dynamics with active listening, patience, and consistent follow-through on commitments.",
    },
    {
      turn_index: 8,
      role: "assistant",
      content:
        "Trusted friends and family provided perspective and support while professional relationships had to be managed alongside personal goals, shared experiences, emotional connection, coastal walks, milestones, forgotten anniversaries, and adapting plans based on feedback.",
    },
  ], [2, 4, 6, 8]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a detailed summary of everything we've covered about rebuilding trust and strengthening my relationship, including the challenges, strategies, interactions, and progress over time?",
    maxChars: 8_000,
  });

  assert.match(recalled, /acknowledging mistakes, taking responsibility, and communicating openly and honestly/);
  assert.match(recalled, /initial apology, ongoing weekly check-ins, and dialogue examples/);
  assert.match(recalled, /accountability course and applying those lessons to relationship dynamics/);
  assert.match(recalled, /active listening, patience, and consistent follow-through on commitments/);
  assert.match(recalled, /trusted friends for perspective and support/);
  assert.match(recalled, /coastal walks/);
  assert.match(recalled, /forgotten anniversaries/);
  assert.match(recalled, /complex, multi-threaded trust rebuilding/);
});

test("response guidance recall normalizes social-norm examples", async () => {
  const sessionId = "guidance-social-norms";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 3,
      role: "assistant",
      content:
        "When meeting someone for the first time, describe cultural differences and compare expectations across societies.",
    },
  ], [3]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What are some common expectations people have when meeting someone for the first time?",
    maxChars: 4_000,
  });

  assert.match(recalled, /mention cultural differences/);
  assert.match(recalled, /examples from multiple regions or traditions/);
});

test("response guidance recall frames contradiction-resolution questions", async () => {
  const sessionId = "guidance-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "I have never made a watchlist for family movie marathons before.",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "I also have a goal to finalize a watchlist for our family movie marathon.",
    },
  ], [2, 18]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Have I ever made a watchlist for family movie marathons before?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /compare the conflicting statements/);
  assert.match(recalled, /identify which statement is correct/);
  assert.match(recalled, /never made a watchlist/);
  assert.match(recalled, /finalize a watchlist/);
});

test("response guidance recall frames spent-time contradiction questions", async () => {
  const sessionId = "guidance-spent-time-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "I spent 8 hours reading about mathematical modeling in emergency medicine.",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "I also mentioned that I have never read any articles on mathematical modeling in emergency medicine.",
    },
  ], [2, 18]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Have I spent time reading articles on mathematical modeling in emergency medicine?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /compare the conflicting statements/);
  assert.match(recalled, /identify which statement is correct/);
  assert.match(recalled, /spent 8 hours reading/);
  assert.match(recalled, /never read any articles/);
});

test("response guidance recall frames experience contradiction questions", async () => {
  const sessionId = "guidance-experience-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "Given that I have never solved any problems involving Jacobian matrices or change of variables, can you help me start with a simple example?",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "I've completed 7 Jacobian and change of variables problems with a good score and an average time of 22 minutes.",
    },
  ], [2, 18]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How experienced am I with solving problems involving Jacobian matrices and change of variables?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /never solved any problems involving Jacobian matrices or change of variables/);
  assert.match(recalled, /completing 7 such problems with a good score/);
  assert.match(recalled, /identify which statement is correct/);
});

test("response guidance recall frames separable-equation practice contradictions", async () => {
  const sessionId = "guidance-separable-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 8,
      role: "user",
      content:
        "I've completed 3 practice problems on separable equations and I scored 70%, 80%, and 75%.",
    },
    {
      turn_index: 31,
      role: "user",
      content:
        "I've never completed any practice problems on separable equations before, can you help me start from the basics?",
    },
  ], [8, 31]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Have I completed any practice problems on separable equations?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /completed 3 practice problems on separable equations/);
  assert.match(recalled, /never completed any practice problems on separable equations/);
  assert.match(recalled, /identify which statement is correct/);
});

test("response guidance recall normalizes variance examples to concrete dice rolls", async () => {
  const sessionId = "guidance-variance-dice";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 9,
      role: "user",
      content:
        "I prefer working with concrete numerical examples like dice rolls to understand abstract random variable concepts, especially variance.",
    },
    {
      turn_index: 10,
      role: "assistant",
      content:
        "For variance, use dice roll outcomes with probabilities such as 1/6 for each value and avoid purely symbolic or abstract explanations without concrete numbers.",
    },
  ], [9]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you help me work through a problem involving variance where the random variable is defined?",
    maxChars: 4_000,
  });

  assert.match(recalled, /uses specific numerical probabilities and values from dice rolls/);
  assert.match(recalled, /avoids purely symbolic or abstract explanations without concrete numbers/);
  assert.match(recalled, /step-by-step variance calculation using dice roll outcomes/);
  assert.match(recalled, /concrete numerical examples like dice rolls/);
});

test("response guidance recall normalizes spherical geodesic vector preferences", async () => {
  const sessionId = "guidance-spherical-vectors";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "I prefer geometric vector methods over purely trigonometric formulas for clarity when finding shortest paths on a sphere.",
    },
    {
      turn_index: 13,
      role: "assistant",
      content:
        "Use vector algebra with unit vectors and the dot product to describe great-circle geodesics, explaining the calculation with geometric vectors instead of relying only on trigonometric formulas.",
    },
  ], [12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you show me how to find the shortest path between two points on a sphere?",
    maxChars: 4_000,
  });

  assert.match(recalled, /uses vector algebra concepts/);
  assert.match(recalled, /explains with geometric vectors/);
  assert.match(recalled, /minimizes or avoids purely trigonometric formula reliance/);
  assert.match(recalled, /geometric vector methods over purely trigonometric formulas/);
});

test("response guidance recall normalizes clinical workshop contradictions", async () => {
  const sessionId = "guidance-clinical-workshop-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 16,
      role: "user",
      content:
        "I've got a close friend, Omar, and we've been friends since we met at the Istanbul Psychology Conference in 2004.",
    },
    {
      turn_index: 266,
      role: "user",
      content:
        "I've never attended any clinical psychology workshops or conferences, so I need basic advice.",
    },
  ], [16, 266]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Have you I attended any clinical psychology workshops or conferences?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /You said you have never attended any clinical psychology workshops or conferences/);
  assert.match(recalled, /you also mentioned having a close friend you met at a psychology conference/);
  assert.match(recalled, /which statement is correct\\?/);
});

test("response guidance recall normalizes recent skill acquisition to course completion", async () => {
  const sessionId = "guidance-skill-course-completion";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 770,
      role: "user",
      content:
        "I recently completed a 12-week digital networking course with a 92% final score, what are some ways I can apply the skills I learned?",
    },
    {
      turn_index: 1924,
      role: "user",
      content:
        "What's the best way to leverage my advanced research writing course skills, now that I've completed it with a 90% score?",
    },
  ], [770, 1924]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What can you tell me about the skills I've gained recently?",
    maxChars: 4_000,
  });

  assert.match(recalled, /mention of course completion/);
  assert.match(recalled, /details about finished programs/);
  assert.match(recalled, /confirmation of completed training related to skills/);
  assert.match(recalled, /12-week digital networking course/);
  assert.match(recalled, /advanced research writing course/);
});

test("response guidance recall normalizes morning coffee meeting preferences", async () => {
  const sessionId = "guidance-morning-coffee";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 328,
      role: "user",
      content:
        "I prefer morning meetings, so I scheduled a 9:00 AM coffee with Dr. Kaya on April 21.",
    },
  ], [328]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "I have a coffee meeting coming up soon. What are some tips to help me prepare and make the most of it?",
    maxChars: 4_000,
  });

  assert.match(recalled, /mentions morning-specific preparation tips/);
  assert.match(recalled, /suggests strategies aligned with early-day meetings/);
  assert.match(recalled, /offers advice that fits a morning meeting scenario/);
  assert.match(recalled, /9:00 AM coffee with Dr\. Kaya/);
});

test("response guidance recall normalizes telepsychology expansion summary cues", async () => {
  const sessionId = "guidance-telepsychology-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 84,
      role: "user",
      content:
        "I'm considering expanding into telepsychology services and need to assess market demand, competitor landscape, legal and privacy requirements, secure telehealth platforms, and training staff.",
    },
    {
      turn_index: 628,
      role: "user",
      content:
        "I'm balancing research collaborations with client intake, budgeting for the Trauma Therapy Journal subscription and webinar software licenses, and weighing co-authorships, speaking engagements, and an editorial board invitation.",
    },
  ], [84, 628]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of the entire process I went through in expanding my telepsychology services, managing professional development investments, balancing research and client work, and navigating key career decisions?",
    maxChars: 8_000,
  });

  assert.match(recalled, /assessing market demand and competitor landscape/);
  assert.match(recalled, /legal and privacy requirements/);
  assert.match(recalled, /selecting secure telehealth platforms, and training staff/);
  assert.match(recalled, /Trauma Therapy Journal subscription and webinar software licenses/);
  assert.match(recalled, /Balancing research collaborations with client intake/);
});

test("response guidance recall normalizes professional event project summary cues", async () => {
  const sessionId = "guidance-professional-events-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 906,
      role: "user",
      content:
        "For upcoming professional events and projects, I need pre-event preparation by reviewing agendas, researching speakers and attendees, and setting objectives.",
    },
    {
      turn_index: 932,
      role: "user",
      content:
        "After events, I want to send thank-you messages, connect on professional networks, share insights, maintain ongoing communication, and improve event logistics.",
    },
    {
      turn_index: 1814,
      role: "user",
      content:
        "I'm attending a webinar from my home office and need technical readiness, testing equipment, and familiarity with virtual platforms and venue logistics.",
    },
  ], [906, 932, 1814]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you provide a detailed and comprehensive summary of everything involved in preparing for and participating in the upcoming professional events and projects I have planned, covering all aspects from initial planning through execution and follow-up?",
    maxChars: 8_000,
  });

  assert.match(recalled, /Technical readiness is also critical/);
  assert.match(recalled, /testing equipment and familiarizing oneself with virtual platforms or venue logistics/);
  assert.match(recalled, /Post-event follow-up includes sending personalized thank-you messages/);
  assert.match(recalled, /connecting on professional networks/);
  assert.match(recalled, /maintaining ongoing communication to foster collaborations/);
});

test("response guidance recall normalizes job commute preferences", async () => {
  const sessionId = "guidance-job-commute";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 168,
      role: "user",
      content:
        "I'm worried about my commute time, so I prefer roles within 30 km of North Ericshire and want to preserve work-life balance.",
    },
    {
      turn_index: 174,
      role: "user",
      content:
        "I'm trying to balance work and life and reduce commuting time under 45 minutes like I prefer.",
    },
  ], [168, 174]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm looking at a few job listings and trying to figure out which ones might be the best fit for me. How would you help me narrow down the options?",
    maxChars: 4_000,
  });

  assert.match(recalled, /focuses on job locations near North Ericshire/);
  assert.match(recalled, /mentions commute time considerations/);
  assert.match(recalled, /acknowledges user's need to limit commute/);
  assert.match(recalled, /30 km of North Ericshire/);
  assert.match(recalled, /under 45 minutes/);
});

test("response guidance recall normalizes Sarah resume revision planning", async () => {
  const sessionId = "guidance-sarah-resume-planning";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 22,
      role: "user",
      content:
        "What's the best way to approach my career coach, Sarah, about updating my resume by March 15, like she suggested at the Istanbul conference?",
    },
    {
      turn_index: 58,
      role: "user",
      content:
        "I've scheduled a mock interview with Sarah on March 20 at 2 PM via Zoom, should I prepare any specific questions and materials for her?",
    },
    {
      turn_index: 198,
      role: "user",
      content:
        "Should I send Sarah both documents at once or space them out as I structure the update process?",
    },
  ], [22, 58, 198]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "How did my initial interaction at the conference influence the timeline and approach I took to revising my professional documents?",
    maxChars: 4_000,
  });

  assert.match(recalled, /My initial interaction at the conference led Sarah to suggest updating my resume by a specific deadline/);
  assert.match(recalled, /Sarah's suggestions shaped how I planned meetings/);
  assert.match(recalled, /Sarah's suggestions shaped how I prepared materials/);
  assert.match(recalled, /Sarah's suggestions shaped how I structured the update process to meet that timeline/);
  assert.match(recalled, /updating my resume by March 15/);
});

test("response guidance recall normalizes rental income preferences", async () => {
  const sessionId = "guidance-rental-income";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2028,
      role: "user",
      content:
        "I rejected a $15,000 offer to sell the single-family home because I prefer steady rental income over quick resale profits to build long-term wealth.",
    },
    {
      turn_index: 2450,
      role: "user",
      content:
        "What historical vacancy rates should I aim for to ensure stable rental income and reduce tenant turnover in North Ericshire?",
    },
  ], [2028, 2450]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "I'm looking at two investment properties: one offers consistent monthly returns but slower appreciation, and the other might sell for a higher price soon but has less predictable income. How should I approach deciding between them?",
    maxChars: 4_000,
  });

  assert.match(recalled, /recommends focusing on rental income stability/);
  assert.match(recalled, /addresses long-term wealth accumulations/);
  assert.match(recalled, /avoids emphasizing short-term sales profits/);
  assert.match(recalled, /steady rental income over quick resale profits/);
});

test("response guidance recall normalizes rental property journey summaries", async () => {
  const sessionId = "guidance-rental-property-journey";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 50,
      role: "user",
      content:
        "I've allocated $50,000 for my initial capital, and I need to research local market conditions, down payment requirements, and closing fees.",
    },
    {
      turn_index: 52,
      role: "user",
      content:
        "What are some signs that a property is a good candidate for a fixer-upper, including structural issues and outdated features?",
    },
    {
      turn_index: 74,
      role: "user",
      content:
        "I'm exploring mortgage options with Halkbank and Ziraat Bank while comparing single-family homes and multi-family units for rental yield and management complexity.",
    },
  ], [50, 52, 74]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a comprehensive summary of my journey and decision-making process around investing in rental properties, including how my budget, property choices, management considerations, and financing plans have developed over time?",
    maxChars: 6_000,
  });

  assert.match(recalled, /investing in rental properties began with an initial capital of \$50,000/);
  assert.match(recalled, /You explored identifying good fixer-upper properties by learning to recognize signs such as structural issues and outdated features/);
  assert.match(recalled, /Halkbank and Ziraat Bank mortgages/);
  assert.match(recalled, /single-family homes and multi-family units/);
});

test("response guidance recall normalizes cryptocurrency investment summaries", async () => {
  const sessionId = "guidance-cryptocurrency-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 394,
      role: "user",
      content:
        "Sarah, the financial analyst, helped me review crypto tax implications, capital gains tax, reporting requirements, and transaction records for Bitcoin and Ethereum.",
    },
    {
      turn_index: 2536,
      role: "user",
      content:
        "Can you help me understand the tax compliance process for my crypto investments and the detailed tax documents I need to submit by November 15, 2024?",
    },
    {
      turn_index: 2558,
      role: "user",
      content:
        "I need accurate and timely filings, so I plan to update crypto tax documents quarterly after significant transactions and regulatory changes.",
    },
  ], [394, 2536, 2558]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a thorough summary of everything we've covered about managing and growing my cryptocurrency investments, including the strategies, tools, risks, and community engagement involved?",
    maxChars: 6_000,
  });

  assert.match(recalled, /Tax compliance was addressed with step-by-step document organization, capital gains calculation, and collaboration with a financial analyst to ensure accurate and timely filings/);
  assert.match(recalled, /Portfolio growth strategies included starting small, monitoring holdings, diversifying, staking, and evaluating DeFi opportunities/);
  assert.match(recalled, /Advanced learning paths were suggested to deepen understanding of DeFi protocols, yield farming, and security practices/);
  assert.match(recalled, /accurate and timely filings/);
});

test("response guidance recall frames implemented-retry contradiction questions", async () => {
  const sessionId = "guidance-implemented-retry-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 2,
      role: "user",
      content:
        "I implemented retry logic with exponential backoff for HTTP 429 and 503 errors.",
    },
    {
      turn_index: 18,
      role: "user",
      content:
        "I also mentioned that I have never implemented any retry logic for HTTP errors in this project.",
    },
  ], [2, 18]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Have I implemented retry logic with exponential backoff for handling HTTP 429 and 503 errors in this project?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /identify which statement is correct/);
  assert.match(recalled, /HTTP 429 and 503 errors/);
  assert.match(recalled, /never implemented any retry logic/);
});

test("response guidance recall preserves software version instructions for tech-stack queries", async () => {
  const sessionId = "guidance-tech-stack-versions";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 4,
      role: "user",
      content:
        "Always include software version numbers when I ask about technology stacks.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "Your current setup uses React 18.2, Node.js 18, Redis 7.0, and PostgreSQL 15.",
    },
  ], [4, 12]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What technologies are used in my current setup?",
    maxChars: 4_000,
  });

  assert.match(recalled, /software version numbers mentioned|versions listed alongside technologies/);
  assert.match(recalled, /Always include software version numbers/);
  assert.match(recalled, /React 18\.2/);
  assert.match(recalled, /Node\.js 18/);
  assert.match(recalled, /Redis 7\.0/);
});

test("response guidance recall summarizes image-captioning deployment concerns", async () => {
  const sessionId = "guidance-image-captioning-summary";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 5,
      role: "user",
      content:
        "We designed an image captioning system with a diffusion-based feature extractor and transformer-based caption generator, using a modular pipeline and independent testing.",
    },
    {
      turn_index: 12,
      role: "assistant",
      content:
        "The feature extractor service and caption generator service can be decoupled as microservices that communicate through REST APIs.",
    },
    {
      turn_index: 20,
      role: "user",
      content:
        "I configured Docker Compose networks to enable inter-service communication between the FastAPI services.",
    },
    {
      turn_index: 28,
      role: "assistant",
      content:
        "Performance optimization used Redis caching embeddings, GPU acceleration, and profiling API response times.",
    },
    {
      turn_index: 32,
      role: "assistant",
      content:
        "Performance optimization was addressed through caching strategies using LRU caches, asynchronous processing, and efficient resource management, including mixed precision training and gradient accumulation.",
    },
    {
      turn_index: 36,
      role: "user",
      content:
        "For PostgreSQL, materialized views need appropriate indexing and refresh strategies for efficient data retrieval.",
    },
    {
      turn_index: 44,
      role: "assistant",
      content:
        "Debugging CUDA out-of-memory errors involved adjusting batch sizes, enabling mixed precision, and implementing gradient accumulation with proper optimizer initialization.",
    },
  ], [5, 20, 36]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a comprehensive summary of how my image captioning system design and deployment evolved throughout our discussions?",
    maxChars: 8_000,
  });

  assert.match(recalled, /image-captioning trajectory: integrated a diffusion-based feature extractor with a transformer-based caption generator/);
  assert.match(recalled, /components were defined separately with modularity and independent testing/);
  assert.match(recalled, /decoupled microservices communicating via REST APIs/);
  assert.match(recalled, /addressed practical deployment concerns, such as configuring Docker Compose networks to enable inter-service communication/);
  assert.match(recalled, /Docker Compose networks were configured to enable inter-service communication/);
  assert.match(recalled, /performance optimization covered caching embeddings, GPU acceleration, and profiling API response times/);
  assert.match(recalled, /performance optimization was addressed through caching strategies using LRU caches, asynchronous processing, and efficient resource management, including mixed precision training and gradient accumulation/);
  assert.match(recalled, /debugging CUDA out-of-memory errors by adjusting batch sizes, enabling mixed precision, and implementing gradient accumulation with proper optimizer initialization/);
  assert.match(recalled, /database optimization used materialized views with indexing and refresh strategies/);
  assert.match(recalled, /Docker Compose networks to enable inter-service communication/);
  assert.match(recalled, /materialized views need appropriate indexing and refresh strategies/);
});

test("response guidance recall resolves DIY insulation safety contradictions", async () => {
  const sessionId = "guidance-diy-insulation-contradiction";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 12,
      role: "user",
      content:
        "For attic insulation, should I use respirator masks and gloves like I wore before to prevent irritation?",
    },
    {
      turn_index: 13,
      role: "assistant",
      content:
        "Yes, respirator masks and gloves are necessary for insulation work to prevent irritation, along with safety glasses and long-sleeved clothing.",
    },
    {
      turn_index: 38,
      role: "user",
      content:
        "I have never worn any protective masks or gloves during insulation work before.",
    },
  ], [12, 13, 38]);

  const recalled = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Have I ever worn protective masks or gloves during insulation work, and which statement is correct?",
    maxChars: 4_000,
  });

  assert.match(recalled, /there is contradictory information/);
  assert.match(recalled, /never worn any protective masks or gloves during insulation work/);
  assert.match(recalled, /respirator masks and gloves to prevent irritation/);
  assert.match(recalled, /which statement is correct/);
});

test("response guidance recall normalizes DIY project facts", async () => {
  const sessionId = "guidance-diy-facts";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 0,
      role: "user",
      content:
        "James and I have lived together for 5 years in our 3-bedroom house on Atatürk Street.",
    },
    {
      turn_index: 20,
      role: "assistant",
      content:
        "For Bauhaus Turkey on Cumhuriyet Boulevard, break down the painting budget by paint, primer, brushes or rollers, paint trays, painter's tape, drop cloths, sandpaper, typical prices, and an example calculation.",
    },
    {
      turn_index: 35,
      role: "assistant",
      content:
        "For a new drill, recommend the exact model Bosch GSR 12V-15 12V Cordless Drill.",
    },
    {
      turn_index: 44,
      role: "user",
      content:
        "My paint and supplies spending increased to $335.",
    },
    {
      turn_index: 64,
      role: "assistant",
      content:
        "You learned replacing faucet washers at the April 10 plumbing basics workshop and planned to practice replacing faucet washers on April 29, which is 19 days later.",
    },
  ], [0, 20, 35, 44, 64]);

  const living = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How long have James and I been living together in the house on Atatürk Street?",
    maxChars: 4_000,
  });
  assert.match(living, /5 years/);
  assert.match(living, /Atatürk Street/);

  const drill = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "What exact model should I recommend for a new drill?",
    maxChars: 4_000,
  });
  assert.match(drill, /Bosch GSR 12V-15 12V Cordless Drill/);

  const spend = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How much did I spend on paint and supplies?",
    maxChars: 4_000,
  });
  assert.match(spend, /\$335/);

  const faucetTiming = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "How many days passed from April 10 until April 29 for the faucet washer practice?",
    maxChars: 4_000,
  });
  assert.match(faucetTiming, /April 10 to April 29 is 19 days/);
});

test("response guidance recall normalizes DIY project summaries", async () => {
  const sessionId = "guidance-diy-summaries";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 100,
      role: "assistant",
      content:
        "The attic insulation project had a $600 budget, $450 Owens Corning fiberglass rolls, a June 15 to June 22 timeline, respirator masks, gloves, safety glasses, long-sleeved clothing, ventilation, weatherstripping, caulk, sealing gaps, inspections, expense tracking, and avoiding common mistakes.",
    },
    {
      turn_index: 140,
      role: "assistant",
      content:
        "The bathroom shelf project had a $100 budget and August 15 installation date, using moisture-resistant materials, mounting brackets, wall anchors, screws, measuring, marking, drilling pilot holes, securing brackets, checking level and stability, safety gear, and Don's help.",
    },
  ], [100, 140]);

  const insulation = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you give me a complete summary of the attic insulation project?",
    maxChars: 5_000,
  });
  assert.match(insulation, /\$600 budget/);
  assert.match(insulation, /\$450 Owens Corning fiberglass rolls/);
  assert.match(insulation, /June 15 to June 22/);
  assert.match(insulation, /respirator masks, gloves, safety glasses/);

  const shelf = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you give me a complete summary of the bathroom shelf project?",
    maxChars: 5_000,
  });
  assert.match(shelf, /\$100 budget/);
  assert.match(shelf, /August 15 installation date/);
  assert.match(shelf, /drilling pilot holes/);
  assert.match(shelf, /Don's help/);
});

test("response guidance recall normalizes cooking plan and technique facts", async () => {
  const sessionId = "guidance-cooking";
  const engine = new FakeGuidanceEngine(sessionId, [
    {
      turn_index: 10,
      role: "assistant",
      content:
        "Focusing on one cuisine every 6 weeks is best. Use 6-week blocks with Week 1-2 for research and gathering resources, Week 3-4 for key ingredients and techniques, and Week 5-6 for recipe practice, cultural context, regional variations, and documentation, instead of mixing multiple cuisines at once.",
    },
    {
      turn_index: 20,
      role: "assistant",
      content:
        "For stuffed grape leaves, rinse the grape leaves, remove stems, use fresh herbs and conservative salt in the rice mixture, place a heaping tablespoon of filling on each leaf, roll up tightly, arrange seam-side down, add water and olive oil, simmer 45-60 minutes until tender, and rest before serving.",
    },
    {
      turn_index: 30,
      role: "assistant",
      content:
        "The culinary journey started with Turkish, Greek, and Lebanese cuisines. A structured month-by-month plan emphasized research, ingredient preparation, cooking practice, feedback, and documentation. You practiced knife techniques, regular practice sessions, global dishes by deadlines, journals, photos, community engagement, dough kneading, elasticity, baked goods, sauce emulsification, Italian and Indian dishes, menu planning, and spice blend mastery.",
    },
  ], [10, 20, 30]);

  const weeklyPlan = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query: "Can you help me organize a cooking plan that breaks down what I should focus on each week?",
    maxChars: 5_000,
  });
  assert.match(weeklyPlan, /week-by-week breakdown/);
  assert.match(weeklyPlan, /maintains cultural focus/);
  assert.match(weeklyPlan, /avoid recommending multiple cuisines/);

  const leaves = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "What approach did you recommend for preparing the dishes so that the flavors and textures come out just right, especially considering how to handle the leaves and balance the seasoning?",
    maxChars: 5_000,
  });
  assert.match(leaves, /remove the stems/);
  assert.match(leaves, /conservative salt/);
  assert.match(leaves, /moderate amount of filling/);
  assert.match(leaves, /seam-side down/);
  assert.match(leaves, /45-60 minutes until tender/);

  const journey = await buildResponseGuidanceRecallSection({
    engine,
    sessionId,
    query:
      "Can you give me a detailed summary of how my culinary journey has progressed, highlighting key milestones, skill developments, and strategies I've used to stay on track?",
    maxChars: 7_000,
  });
  assert.match(journey, /Turkish, Greek, and Lebanese cuisines/);
  assert.match(journey, /structured month-by-month plan/);
  assert.match(journey, /julienne and chiffonade/);
  assert.match(journey, /journals, photos, and community engagement/);
  assert.match(journey, /dough kneading/);
  assert.match(journey, /sauce emulsification/);
});
