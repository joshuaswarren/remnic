import type { Message } from "../../../adapters/types.js";

export interface MemBenchCase {
  id: string;
  memoryType: "factual" | "reflective";
  scenario: "participant" | "observation";
  level: string;
  turns: Message[];
  question: string;
  answer: string;
  choices?: Record<"A" | "B" | "C" | "D", string>;
  correctChoice?: "A" | "B" | "C" | "D";
  questionTime?: string;
  targetStepIds?: number[];
  targetStepCoordinates?: number[][];
}

export const MEMBENCH_SMOKE_FIXTURE: MemBenchCase[] = [
  {
    id: "factual-participant-1",
    memoryType: "factual",
    scenario: "participant",
    level: "surface",
    turns: [
      {
        role: "user",
        content: "I moved to Lisbon last spring to work from the waterfront.",
      },
      {
        role: "assistant",
        content: "Lisbon by the waterfront, noted.",
      },
    ],
    question: "Which city did I move to last spring?",
    answer: "Lisbon",
  },
  {
    id: "reflective-observation-1",
    memoryType: "reflective",
    scenario: "observation",
    level: "insight",
    turns: [
      {
        role: "user",
        content: "During the retro, Avery paused, reflected on every concern, and reframed the conflict before answering.",
      },
      {
        role: "assistant",
        content: "That pattern suggests Avery handles conflict by pausing, reflecting, and reframing concerns before responding.",
      },
    ],
    question: "How does Avery tend to handle conflict?",
    answer: "pausing, reflecting, and reframing concerns",
  },
];
