/**
 * Synthetic cases for procedural recall: task-initiation gating + optional
 * storage-backed recall (issue #519).
 */

export interface ProceduralRecallIntentCase {
  id: string;
  prompt: string;
  /** Whether `isTaskInitiationIntent(inferIntentFromText(prompt))` should be true. */
  expectTaskInit: boolean;
}

export interface ProceduralRecallE2eCase {
  id: string;
  prompt: string;
  procedurePreamble: string;
  procedureSteps: Array<{ order: number; intent: string }>;
  procedureTags: string[];
  /** When true, `buildProcedureRecallSection` should return non-null markdown. */
  expectNonNullSection: boolean;
  proceduralEnabled?: boolean;
}

export const PROCEDURAL_RECALL_INTENT_FIXTURE: ProceduralRecallIntentCase[] = [
  { id: "deploy-gateway", prompt: "Let's deploy the gateway to production today", expectTaskInit: true },
  { id: "open-pr", prompt: "Open a PR for the regression fix", expectTaskInit: true },
  { id: "run-tests", prompt: "Run the tests before we merge the release branch", expectTaskInit: true },
  { id: "ship-release", prompt: "We need to ship this release tonight", expectTaskInit: true },
  { id: "merge-pr", prompt: "Merge the pull request after CI is green", expectTaskInit: true },
  { id: "start-work", prompt: "Starting work on the production hotfix", expectTaskInit: true },
  { id: "fix-build", prompt: "Fixing the broken build on main", expectTaskInit: true },
  { id: "memory-question", prompt: "What did we decide about the gateway deploy last week?", expectTaskInit: false },
  { id: "summarize", prompt: "Summarize the timeline of the outage", expectTaskInit: false },
  { id: "thanks", prompt: "Thanks, that helps", expectTaskInit: false },
  { id: "how-retrieval", prompt: "How does hybrid retrieval work in this stack?", expectTaskInit: false },
  { id: "explain", prompt: "Explain the difference between a fact and a principle memory", expectTaskInit: false },
];

export const PROCEDURAL_RECALL_INTENT_SMOKE_FIXTURE = [
  PROCEDURAL_RECALL_INTENT_FIXTURE.find((sample) => sample.id === "deploy-gateway")!,
  PROCEDURAL_RECALL_INTENT_FIXTURE.find((sample) => sample.id === "memory-question")!,
];

export const PROCEDURAL_RECALL_E2E_FIXTURE: ProceduralRecallE2eCase[] = [
  {
    id: "ranked-deploy",
    prompt: "Let's deploy the gateway to production today",
    procedurePreamble: "When you deploy the gateway",
    procedureSteps: [
      { order: 1, intent: "Run deploy checks for production gateway" },
      { order: 2, intent: "Push the release tag" },
    ],
    procedureTags: ["deploy", "gateway"],
    expectNonNullSection: true,
    proceduralEnabled: true,
  },
  {
    id: "disabled-gate",
    prompt: "Let's deploy everything now",
    procedurePreamble: "Ship checklist",
    procedureSteps: [
      { order: 1, intent: "Verify CI" },
      { order: 2, intent: "Tag release" },
    ],
    procedureTags: ["ship"],
    expectNonNullSection: false,
    proceduralEnabled: false,
  },
  {
    id: "no-task-init",
    prompt: "What is our usual process for production deploys?",
    procedurePreamble: "Production deploy runbook",
    procedureSteps: [
      { order: 1, intent: "Notify on-call" },
      { order: 2, intent: "Apply change window" },
    ],
    procedureTags: ["deploy", "runbook"],
    expectNonNullSection: false,
    proceduralEnabled: true,
  },
];

export const PROCEDURAL_RECALL_E2E_SMOKE_FIXTURE = [
  PROCEDURAL_RECALL_E2E_FIXTURE.find((sample) => sample.id === "ranked-deploy")!,
  PROCEDURAL_RECALL_E2E_FIXTURE.find((sample) => sample.id === "no-task-init")!,
  PROCEDURAL_RECALL_E2E_FIXTURE.find((sample) => sample.id === "disabled-gate")!,
];
