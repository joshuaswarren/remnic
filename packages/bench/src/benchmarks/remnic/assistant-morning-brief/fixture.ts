import type {
  AssistantMemoryGraph,
  AssistantScenario,
} from "../_assistant-common/index.js";

const ALEX_GRAPH: AssistantMemoryGraph = {
  userHandle: "Alex Rivera",
  userRole: "staff engineer and tech-lead of Project Atlas",
  facts: [
    {
      id: "fact-atlas-launch",
      summary:
        "Project Atlas migration has a soft-launch next Tuesday; rollback runbook is partially written.",
      tags: ["project-atlas", "timeline"],
    },
    {
      id: "fact-alex-no-meetings-monday",
      summary:
        "Alex blocks Mondays for deep work and declines non-urgent meetings.",
      tags: ["preference"],
    },
    {
      id: "fact-open-pr-481",
      summary:
        "Remnic PR #481 is waiting on Alex's review — touches retrieval-personalization.",
      tags: ["review-queue", "remnic"],
    },
    {
      id: "fact-onboarding-jordan",
      summary:
        "Jordan Okafor joined the team last week and has not yet been paired with Alex.",
      tags: ["team", "onboarding"],
    },
  ],
  stances: [
    {
      topic: "synchronous standups",
      position: "Alex prefers async written standups over daily video calls.",
    },
    {
      topic: "experimentation discipline",
      position:
        "Alex insists every rollout has a rollback runbook before merge.",
    },
  ],
  openThreads: [
    "Draft 1 of the Atlas rollback runbook is in progress — last updated two days ago.",
    "Decision pending: whether to co-schedule the Atlas launch with the Aurora team's release window.",
  ],
};

export const ASSISTANT_MORNING_BRIEF_SCENARIOS: AssistantScenario[] = [
  {
    id: "morning-brief.monday-priorities",
    title: "Monday priorities",
    focus: "priority_surfacing",
    scenarioPrompt:
      "It's Monday 08:15. Give me a crisp morning brief: what should I know and what should I act on first? Keep it to five items.",
    memoryGraph: ALEX_GRAPH,
  },
  {
    id: "morning-brief.stale-content-guard",
    title: "Stale content guard",
    focus: "stale_suppression",
    scenarioPrompt:
      "Morning check-in. Surface anything that changed since Friday, and skip items that are older than a week unless they're blocking today.",
    memoryGraph: {
      ...ALEX_GRAPH,
      facts: [
        ...ALEX_GRAPH.facts,
        {
          id: "fact-atlas-rollback-saturday-update",
          summary:
            "Updated Saturday 10:30 after Friday: Atlas rollback runbook added database restore owner and rollback validation checklist.",
          tags: ["project-atlas", "changed-since-friday", "runbook"],
        },
        {
          id: "fact-stale-q1-retro",
          summary:
            "Q1 retrospective document was last edited three months ago; no open actions remain.",
          tags: ["stale"],
        },
      ],
      openThreads: [
        "Saturday 10:30 update: Atlas rollback runbook now has database restore ownership assigned; validation checklist still needs Alex's review.",
        ...ALEX_GRAPH.openThreads,
      ],
    },
  },
  {
    id: "morning-brief.noise-filter",
    title: "Signal vs noise",
    focus: "signal_to_noise",
    scenarioPrompt:
      "Give me a brief, but aggressively filter out anything that isn't a decision or a blocker for this week.",
    memoryGraph: {
      ...ALEX_GRAPH,
      facts: [
        ...ALEX_GRAPH.facts,
        {
          id: "fact-newsletter-subscribed",
          summary:
            "Alex subscribed to a new newsletter on distributed systems reading.",
          tags: ["noise"],
        },
      ],
    },
  },
];

export const ASSISTANT_MORNING_BRIEF_SMOKE_SCENARIOS: AssistantScenario[] =
  ASSISTANT_MORNING_BRIEF_SCENARIOS.slice(0, 2);
