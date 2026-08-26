/**
 * Synthetic fixture cases for the say-once (extraction -> recall) benchmark.
 *
 * Each case seeds a preference phrase at a vagueness tier, then defines probe
 * prompts that should surface it. All text is synthetic and obviously invented
 * for public-repo safety.
 *
 * Vagueness tiers:
 * - explicit: "I prefer dark mode" — direct statement
 * - casual: "dark mode is easier on my eyes" — implied preference
 * - buried-mid-task: "can you switch this to dark mode? much better" — preference
 *   stated as a side remark during a task
 */

export type VaguenessTier = "explicit" | "casual" | "buried-mid-task";

export interface SayOnceProbe {
  /** Prompt a user would send in a later session. */
  prompt: string;
  /** Substring expected in the recall context if the preference was extracted. */
  expectInRecall: string;
}

export interface SayOnceCase {
  id: string;
  tier: VaguenessTier;
  /** The seed conversation: user message containing the preference. */
  seedUserMessage: string;
  /** The assistant response — realistic but synthetic. */
  seedAssistantMessage: string;
  /** The preference as a fact statement (what extraction should produce). */
  preference: string;
  /** Probe prompts that should trigger recall of this preference. */
  probes: SayOnceProbe[];
}

export const SAY_ONCE_CASES: SayOnceCase[] = [
  // ─── Explicit ───────────────────────────────────────────────────────────
  {
    id: "explicit-dark-mode",
    tier: "explicit",
    seedUserMessage: "I prefer dark mode for all my editors. Please set it as default.",
    seedAssistantMessage:
      "I've noted your preference for dark mode. I'll apply it as the default theme going forward.",
    preference: "user prefers dark mode",
    probes: [
      {
        prompt: "What theme should I use for the new project?",
        expectInRecall: "dark mode",
      },
    ],
  },
  {
    id: "explicit-meeting-format",
    tier: "explicit",
    seedUserMessage: "I want all meeting summaries in bullet points, not paragraphs.",
    seedAssistantMessage:
      "Understood. I'll format meeting summaries as bullet points rather than paragraphs from now on.",
    preference: "user prefers bullet-point meeting summaries",
    probes: [
      {
        prompt: "Can you summarize yesterday's standup?",
        expectInRecall: "bullet",
      },
    ],
  },
  // ─── Casual ─────────────────────────────────────────────────────────────
  {
    id: "casual-concise",
    tier: "casual",
    seedUserMessage: "Short answers are fine, I don't need a lot of explanation.",
    seedAssistantMessage: "Got it — I'll keep responses concise unless you ask for more detail.",
    preference: "user prefers concise responses",
    probes: [
      {
        prompt: "What's the capital of Finland?",
        expectInRecall: "concise",
      },
    ],
  },
  {
    id: "casual-code-examples",
    tier: "casual",
    seedUserMessage: "I learn best from code examples, just show me the code.",
    seedAssistantMessage: "I'll include more code examples in my explanations going forward.",
    preference: "user prefers code examples in explanations",
    probes: [
      {
        prompt: "How do I use async/await in Python?",
        expectInRecall: "code examples",
      },
    ],
  },
  // ─── Buried mid-task ────────────────────────────────────────────────────
  {
    id: "buried-timezone",
    tier: "buried-mid-task",
    seedUserMessage:
      "Let's deploy the release. By the way, I'm in UTC so schedule everything in my timezone. The build passed, right?",
    seedAssistantMessage:
      "The build passed. I'll use UTC for scheduling going forward. Ready to deploy.",
    preference: "user is in UTC timezone",
    probes: [
      {
        prompt: "What time should I schedule the maintenance window?",
        expectInRecall: "UTC",
      },
    ],
  },
  {
    id: "buried-email-style",
    tier: "buried-mid-task",
    seedUserMessage:
      "Can you review the PR? Also I don't like formal email greetings, just get to the point. Oh and the tests pass locally.",
    seedAssistantMessage:
      "PR review started. Noted on the informal style — I'll skip greetings in drafts. Tests passing locally confirmed.",
    preference: "user prefers informal communication, no greetings",
    probes: [
      {
        prompt: "Draft a response to the client about the delay.",
        expectInRecall: "greeting",
      },
    ],
  },
];

/** Smoke subset — one from each tier. */
export const SAY_ONCE_SMOKE_FIXTURE: SayOnceCase[] = [
  SAY_ONCE_CASES.find((c) => c.id === "explicit-dark-mode")!,
  SAY_ONCE_CASES.find((c) => c.id === "casual-concise")!,
  SAY_ONCE_CASES.find((c) => c.id === "buried-timezone")!,
];