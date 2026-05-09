export interface LoCoMoTurn {
  speaker: string;
  dia_id: string;
  text: string;
  query?: string;
  blip_caption?: string;
}

export interface LoCoMoQA {
  question: string;
  answer: string;
  evidence: string[];
  category: number;
}

export interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: LoCoMoQA[];
  event_summary?: unknown;
  observation?: unknown;
  session_summary?: unknown;
}

export const LOCOMO_SMOKE_FIXTURE: LoCoMoConversation[] = [
  {
    sample_id: "locomo-smoke-1",
    conversation: {
      speaker_a: "Maya",
      speaker_b: "Assistant",
      session_1: [
        {
          speaker: "Maya",
          dia_id: "D1:1",
          text: "I moved to Seattle last spring after accepting the new role.",
        },
        {
          speaker: "Assistant",
          dia_id: "D1:2",
          text: "Seattle sounds exciting. I'll remember that move.",
        },
      ],
      session_2: [
        {
          speaker: "Maya",
          dia_id: "D2:1",
          text: "My favorite tea is jasmine, especially during rainy mornings.",
        },
        {
          speaker: "Assistant",
          dia_id: "D2:2",
          text: "Jasmine tea on rainy mornings. Got it.",
        },
      ],
    },
    qa: [
      {
        question: "Which city did Maya move to?",
        answer: "Seattle",
        evidence: ["D1:1"],
        category: 1,
      },
      {
        question: "What tea does Maya prefer on rainy mornings?",
        answer: "jasmine",
        evidence: ["D2:1"],
        category: 2,
      },
    ],
  },
];
