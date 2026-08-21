import type {
  AssistantMemoryGraph,
  AssistantScenario,
} from "../_assistant-common/index.js";

const CORE_GRAPH: AssistantMemoryGraph = {
  userHandle: "Alex Rivera",
  userRole: "staff engineer, tech-lead of Project Atlas",
  facts: [
    {
      id: "fact-priya-lead",
      summary:
        "Priya Shah leads the Aurora team; Aurora depends on Atlas's storage API.",
      tags: ["attendee", "aurora"],
    },
    {
      id: "fact-priya-prior-topic",
      summary:
        "Priya's last 1:1 with Alex flagged concerns about Atlas write-latency SLOs.",
      tags: ["attendee", "open-concern"],
    },
    {
      id: "fact-atlas-sla",
      summary:
        "Atlas p99 write latency is 180ms; Aurora's target is 120ms.",
      tags: ["metrics"],
    },
    {
      id: "fact-hiroki-new",
      summary:
        "Hiroki Tanaka is joining the meeting; new skip-level, has not met Alex before.",
      tags: ["attendee", "new"],
    },
    {
      id: "fact-decision-sharded-cache",
      summary:
        "Alex decided last week to move Atlas to a sharded read cache rather than expanding the write-through cluster.",
      tags: ["decision"],
    },
  ],
  stances: [
    {
      topic: "meeting length",
      position: "Alex prefers 25-minute meetings and leaves hard if overrun.",
    },
    {
      topic: "cache strategy",
      position:
        "Alex has committed to sharded read cache over write-through expansion.",
    },
  ],
  openThreads: [
    "Aurora needs a written commitment on Atlas write-latency targets by end of quarter.",
    "Hiroki's onboarding ask: a short narrative of Atlas's current architecture.",
  ],
};

export const ASSISTANT_MEETING_PREP_SCENARIOS: AssistantScenario[] = [
  {
    id: "meeting-prep.aurora-sync",
    title: "Aurora dependency sync",
    focus: "attendee_context",
    scenarioPrompt:
      "I have a 25-minute sync with Priya Shah and Hiroki Tanaka in 30 minutes. Give me a prep brief: attendee context, open threads to raise, and what I've already decided so we don't relitigate.",
    memoryGraph: CORE_GRAPH,
  },
  {
    id: "meeting-prep.skip-level-intro",
    title: "Skip-level intro",
    focus: "new_attendee_grounding",
    scenarioPrompt:
      "Prep for my first meeting with Hiroki Tanaka. What should I cover, and what from my history does Hiroki probably not yet know?",
    memoryGraph: CORE_GRAPH,
  },
  {
    id: "meeting-prep.topic-recall",
    title: "Open thread recall",
    focus: "open_thread_surfacing",
    scenarioPrompt:
      "I'm meeting Priya in 10 minutes. What open questions from our last conversation does she expect me to have an answer for?",
    memoryGraph: CORE_GRAPH,
  },
];

export const ASSISTANT_MEETING_PREP_SMOKE_SCENARIOS: AssistantScenario[] =
  ASSISTANT_MEETING_PREP_SCENARIOS.slice(0, 2);
