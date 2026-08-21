import type { JudgeCandidate } from "@remnic/core";

export interface ExtractionJudgeCalibrationCase extends JudgeCandidate {
  id: string;
  expectedDurable: boolean;
}

export const EXTRACTION_JUDGE_CALIBRATION_FIXTURE: ExtractionJudgeCalibrationCase[] = [
  {
    id: "stable-preference",
    text: "I prefer concise status updates with command evidence.",
    category: "preference",
    confidence: 0.96,
    importanceLevel: "high",
    expectedDurable: true,
  },
  {
    id: "ephemeral-task",
    text: "Currently debugging line 42 in the CLI parser.",
    category: "fact",
    confidence: 0.74,
    importanceLevel: "normal",
    expectedDurable: false,
  },
  {
    id: "personal-identity",
    text: "My name is Josh and I work out of Chicago.",
    category: "fact",
    confidence: 0.92,
    importanceLevel: "critical",
    expectedDurable: true,
  },
  {
    id: "correction-bypass",
    text: "Actually the benchmark issue is #445, not #454.",
    category: "correction",
    confidence: 0.99,
    importanceLevel: "normal",
    expectedDurable: true,
  },
  {
    id: "deadline",
    text: "The compliance audit deadline is May 30.",
    category: "commitment",
    confidence: 0.9,
    importanceLevel: "high",
    expectedDurable: true,
  },
  {
    id: "filler",
    text: "Thanks, that looks good for now.",
    category: "fact",
    confidence: 0.51,
    importanceLevel: "low",
    expectedDurable: false,
  },
  {
    id: "workflow-rule",
    text: "Always run preflight before claiming a PR is ready.",
    category: "principle",
    confidence: 0.97,
    importanceLevel: "normal",
    expectedDurable: true,
  },
  {
    id: "transient-build",
    text: "The build is running right now on my laptop.",
    category: "fact",
    confidence: 0.69,
    importanceLevel: "normal",
    expectedDurable: false,
  },
  {
    id: "project-decision",
    text: "The team decided to ship the custom benchmark framework before the UI.",
    category: "decision",
    confidence: 0.93,
    importanceLevel: "high",
    expectedDurable: true,
  },
  {
    id: "one-off-navigation",
    text: "Open the left sidebar and click the third tab for this task.",
    category: "fact",
    confidence: 0.55,
    importanceLevel: "normal",
    expectedDurable: false,
  },
];

export const EXTRACTION_JUDGE_CALIBRATION_SMOKE_FIXTURE =
  EXTRACTION_JUDGE_CALIBRATION_FIXTURE.slice(0, 5);
