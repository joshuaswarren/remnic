/**
 * Real-fixture procedural-recall scenarios (issue #567 PR 2/5).
 *
 * 20 synthetic but realistic scenarios grouped across four categories:
 *
 *   - exact-re-run          prompt matches a stored procedure near-verbatim;
 *                           should recall when procedural is on.
 *   - parameter-variation   prompt references the same intent with different
 *                           nouns (service name, environment, ticket id);
 *                           should recall on overlap + intent compatibility.
 *   - decomposition         prompt starts a multi-step task whose steps match
 *                           a stored runbook; should recall.
 *   - distractor-rejection  prompt looks task-like but the stored procedure
 *                           is unrelated — the gate should REJECT (expectMatch
 *                           = false).
 *
 * All scenarios are deterministic and use ONLY token-overlap + intent
 * classification semantics (no LLM calls). The deterministic stub LLM
 * requirement from #567 is satisfied because `buildProcedureRecallSection`
 * is a pure function of storage + prompt + config. A human runbook for
 * exercising the gpt-4o-mini path lives in docs/benchmarks/procedural-recall.md.
 *
 * Scenarios are synthetic (no personal data), per CLAUDE.md public-repo
 * privacy policy.
 */
import type { ProceduralAblationScenario } from "./ablation.js";

export type ProceduralRealScenarioCategory =
  | "exact-re-run"
  | "parameter-variation"
  | "decomposition"
  | "distractor-rejection";

export interface ProceduralRealScenario extends ProceduralAblationScenario {
  category: ProceduralRealScenarioCategory;
  notes?: string;
}

export const PROCEDURAL_REAL_SCENARIOS: ProceduralRealScenario[] = [
  // --- exact-re-run (5) ---------------------------------------------------
  {
    id: "rerun-deploy-gateway",
    category: "exact-re-run",
    prompt: "Let's deploy the gateway service to production now.",
    procedurePreamble: "Gateway production deploy runbook",
    procedureSteps: [
      { order: 1, intent: "Run deploy checks for the production gateway" },
      { order: 2, intent: "Push the release tag to origin" },
      { order: 3, intent: "Announce the deploy in the release channel" },
    ],
    procedureTags: ["deploy", "gateway", "production"],
    expectMatch: true,
  },
  {
    id: "rerun-open-pr",
    category: "exact-re-run",
    prompt: "Open a pull request for the regression fix against main.",
    procedurePreamble: "Opening a pull request for a regression fix",
    procedureSteps: [
      { order: 1, intent: "Open a pull request against main" },
      { order: 2, intent: "Link the originating regression issue" },
      { order: 3, intent: "Request two reviewers" },
    ],
    procedureTags: ["pr", "regression", "review"],
    expectMatch: true,
  },
  {
    id: "rerun-run-tests",
    category: "exact-re-run",
    prompt: "Run the test suite before we merge the release branch.",
    procedurePreamble: "Pre-merge test suite procedure",
    procedureSteps: [
      { order: 1, intent: "Run the full test suite on the release branch" },
      { order: 2, intent: "Check the CI status for blocking failures" },
      { order: 3, intent: "Summarize results for the merge reviewer" },
    ],
    procedureTags: ["tests", "release", "merge"],
    expectMatch: true,
  },
  {
    id: "rerun-rotate-credentials",
    category: "exact-re-run",
    prompt: "Rotate the staging database credentials right now.",
    procedurePreamble: "Staging database credential rotation",
    procedureSteps: [
      { order: 1, intent: "Generate new staging database credentials" },
      { order: 2, intent: "Update the staging secret store" },
      { order: 3, intent: "Verify the staging app picks up new credentials" },
    ],
    procedureTags: ["rotate", "credentials", "staging", "database"],
    expectMatch: true,
  },
  {
    id: "rerun-ship-release",
    category: "exact-re-run",
    prompt: "We need to ship the v9 release tonight.",
    procedurePreamble: "Shipping a versioned release",
    procedureSteps: [
      { order: 1, intent: "Tag the release branch with the new version" },
      { order: 2, intent: "Publish the release artifact" },
      { order: 3, intent: "Post release notes to the changelog" },
    ],
    procedureTags: ["ship", "release", "version"],
    expectMatch: true,
  },

  // --- parameter-variation (5) --------------------------------------------
  {
    id: "paramvar-deploy-api",
    category: "parameter-variation",
    // Stored procedure is about gateway; prompt is about the API — same verb
    // + shared goal (deploy), different service noun.
    prompt: "Let's deploy the API service to production today.",
    procedurePreamble: "Service deploy runbook for production",
    procedureSteps: [
      { order: 1, intent: "Run deploy checks for the target service" },
      { order: 2, intent: "Push the release tag for the service" },
      { order: 3, intent: "Notify the on-call in the production channel" },
    ],
    procedureTags: ["deploy", "service", "production"],
    expectMatch: true,
  },
  {
    id: "paramvar-rollback-ticket",
    category: "parameter-variation",
    prompt: "Roll back ticket PROJ-912 before the standup tomorrow.",
    procedurePreamble: "Rollback runbook for an incident ticket",
    procedureSteps: [
      { order: 1, intent: "Identify the offending commit for the rollback ticket" },
      { order: 2, intent: "Revert the commit and open a rollback pull request" },
      { order: 3, intent: "Post a rollback note on the ticket" },
    ],
    procedureTags: ["rollback", "ticket", "incident"],
    expectMatch: true,
  },
  {
    id: "paramvar-rotate-prod",
    category: "parameter-variation",
    // Stored procedure is staging rotation; prompt targets production
    // credentials. Same verb + tag overlap.
    prompt: "Rotate the production database credentials this morning.",
    procedurePreamble: "Database credential rotation",
    procedureSteps: [
      { order: 1, intent: "Generate new database credentials for the target environment" },
      { order: 2, intent: "Update the environment secret store" },
      { order: 3, intent: "Verify the application picks up new credentials" },
    ],
    procedureTags: ["rotate", "credentials", "database"],
    expectMatch: true,
  },
  {
    id: "paramvar-start-branch",
    category: "parameter-variation",
    prompt: "Starting work on the billing branch feature.",
    procedurePreamble: "Feature branch kickoff procedure",
    procedureSteps: [
      { order: 1, intent: "Cut a feature branch from main" },
      { order: 2, intent: "Create a tracking issue for the feature" },
      { order: 3, intent: "Open a draft pull request" },
    ],
    procedureTags: ["branch", "feature", "start"],
    expectMatch: true,
  },
  {
    id: "paramvar-merge-pr-after-ci",
    category: "parameter-variation",
    prompt: "Merge the pull request after CI turns green.",
    procedurePreamble: "Merging a reviewed pull request",
    procedureSteps: [
      { order: 1, intent: "Confirm both reviewers approved the pull request" },
      { order: 2, intent: "Merge the pull request once CI is green" },
      { order: 3, intent: "Close the originating issue" },
    ],
    procedureTags: ["merge", "pr", "review"],
    expectMatch: true,
  },

  // --- decomposition (5) --------------------------------------------------
  {
    id: "decomp-incident-response",
    category: "decomposition",
    prompt: "Run the incident response playbook for the gateway outage.",
    procedurePreamble: "Incident response playbook",
    procedureSteps: [
      { order: 1, intent: "Acknowledge the alert in the incident channel" },
      { order: 2, intent: "Assign an incident commander and scribe" },
      { order: 3, intent: "Open a shared timeline document" },
      { order: 4, intent: "Mitigate the immediate user impact" },
      { order: 5, intent: "Schedule a postmortem within forty-eight hours" },
    ],
    procedureTags: ["incident", "playbook", "response"],
    expectMatch: true,
  },
  {
    id: "decomp-release-cut",
    category: "decomposition",
    prompt: "Cut the weekly release branch and start the release checklist.",
    procedurePreamble: "Weekly release cut procedure",
    procedureSteps: [
      { order: 1, intent: "Cut the weekly release branch from main" },
      { order: 2, intent: "Run the release smoke suite" },
      { order: 3, intent: "Generate release notes from the changelog" },
      { order: 4, intent: "Tag the release candidate" },
      { order: 5, intent: "Notify the release channel with the candidate link" },
    ],
    procedureTags: ["release", "weekly", "cut", "checklist"],
    expectMatch: true,
  },
  {
    id: "decomp-onboarding",
    category: "decomposition",
    prompt: "Start the onboarding workflow for a new engineer joining the team.",
    procedurePreamble: "Engineer onboarding workflow",
    procedureSteps: [
      { order: 1, intent: "Provision the new engineer's accounts" },
      { order: 2, intent: "Invite the engineer to the team repositories" },
      { order: 3, intent: "Share the getting-started checklist" },
      { order: 4, intent: "Pair the engineer with an onboarding buddy" },
    ],
    procedureTags: ["onboarding", "engineer", "workflow"],
    expectMatch: true,
  },
  {
    id: "decomp-data-migration",
    category: "decomposition",
    prompt: "Begin the schema migration plan for the billing table.",
    procedurePreamble: "Schema migration plan",
    procedureSteps: [
      { order: 1, intent: "Snapshot the billing table for rollback" },
      { order: 2, intent: "Apply the forward schema migration" },
      { order: 3, intent: "Backfill dependent billing data" },
      { order: 4, intent: "Run the migration verification suite" },
    ],
    procedureTags: ["migration", "schema", "billing"],
    expectMatch: true,
  },
  {
    id: "decomp-runbook-certificate",
    category: "decomposition",
    prompt: "Start the certificate renewal runbook for the public edge.",
    procedurePreamble: "Certificate renewal runbook",
    procedureSteps: [
      { order: 1, intent: "Request a new certificate for the public edge" },
      { order: 2, intent: "Install the renewed certificate in the edge load balancer" },
      { order: 3, intent: "Reload the edge proxy to pick up the new certificate" },
      { order: 4, intent: "Verify the certificate expiry in monitoring" },
    ],
    procedureTags: ["certificate", "renewal", "edge", "runbook"],
    expectMatch: true,
  },

  // --- distractor-rejection (5) -------------------------------------------
  // The prompt looks task-like AND shares some vocabulary, but the stored
  // procedure is intentionally off-topic. Either the intent classifier gates
  // it out, or the composite score stays under the 0.04 threshold.
  {
    id: "distract-explain-question",
    category: "distractor-rejection",
    prompt: "How does hybrid retrieval combine BM25 and vector search?",
    procedurePreamble: "Gateway production deploy runbook",
    procedureSteps: [
      { order: 1, intent: "Run deploy checks for the production gateway" },
      { order: 2, intent: "Push the release tag to origin" },
    ],
    procedureTags: ["deploy", "gateway"],
    expectMatch: false,
    notes: "Non-task-initiation prompt; intent gate should reject.",
  },
  {
    id: "distract-past-tense-recap",
    category: "distractor-rejection",
    prompt: "What did we decide about the database rotation last week?",
    procedurePreamble: "Database credential rotation",
    procedureSteps: [
      { order: 1, intent: "Generate new database credentials" },
      { order: 2, intent: "Update the environment secret store" },
    ],
    procedureTags: ["rotate", "credentials", "database"],
    expectMatch: false,
    notes: "Past-tense recap; not task initiation.",
  },
  {
    id: "distract-summary-request",
    category: "distractor-rejection",
    prompt: "Summarize the timeline of the gateway outage for the report.",
    procedurePreamble: "Gateway incident response playbook",
    procedureSteps: [
      { order: 1, intent: "Acknowledge the incident alert" },
      { order: 2, intent: "Assign an incident commander" },
    ],
    procedureTags: ["incident", "playbook"],
    expectMatch: false,
    notes: "Summary-of-past request; not task initiation.",
  },
  {
    id: "distract-thanks",
    category: "distractor-rejection",
    prompt: "Thanks, that summary helps a lot.",
    procedurePreamble: "Shipping a versioned release",
    procedureSteps: [
      { order: 1, intent: "Tag the release branch" },
      { order: 2, intent: "Publish the release artifact" },
    ],
    procedureTags: ["ship", "release"],
    expectMatch: false,
    notes: "Closing courtesy; intent gate should reject outright.",
  },
  {
    id: "distract-off-topic-task",
    category: "distractor-rejection",
    // Starts with "Let's" but about a completely unrelated domain; the stored
    // procedure tags don't overlap, so even if the intent gate admits it the
    // token-overlap score stays under threshold.
    prompt: "Let's grab coffee before the standup tomorrow.",
    procedurePreamble: "Pre-merge test suite procedure",
    procedureSteps: [
      { order: 1, intent: "Run the full test suite on the release branch" },
      { order: 2, intent: "Check CI status for failures" },
    ],
    procedureTags: ["tests", "release", "merge"],
    expectMatch: false,
    notes: "Task-like verb but unrelated procedure; overlap score stays below threshold.",
  },
];

/** Built-in smoke slice (first scenario from each category). */
export const PROCEDURAL_REAL_SCENARIOS_SMOKE: ProceduralRealScenario[] = [
  PROCEDURAL_REAL_SCENARIOS[0]!,
  PROCEDURAL_REAL_SCENARIOS[5]!,
  PROCEDURAL_REAL_SCENARIOS[10]!,
  PROCEDURAL_REAL_SCENARIOS[15]!,
];
