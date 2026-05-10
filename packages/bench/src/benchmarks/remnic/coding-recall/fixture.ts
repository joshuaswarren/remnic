/**
 * Fixtures for the coding-agent recall benchmark (issue #569 PR 8).
 *
 * Covers the three invariants PRs 2–4 introduced, plus developer
 * workflow memory for user-aware coding agents:
 *
 *   1. Cross-project isolation — a memory written under project A is not
 *      retrievable under project B.
 *   2. Branch isolation — with branchScope enabled, a branch-local memory
 *      on branch A is not retrievable on branch B, but project-level
 *      memories remain visible from any branch.
 *   3. Review-context ranking — on a review-intent prompt, a memory whose
 *      `entityRefs` mention a touched file outranks an unrelated memory of
 *      equal score.
 *   4. Developer workflow recall — repo conventions, architecture patterns,
 *      test expectations, release process, common failure modes, past bugs,
 *      review preferences, ask-before rules, and always-run checks surface
 *      in the same project-scoped recall path.
 *
 * All fixtures synthetic — no real repositories, no real user data.
 */

export interface CodingRecallCaseMemory {
  id: string;
  /** Namespace the memory was persisted under. */
  namespace: string;
  /** Optional file-path refs that `review-context` ranking consults. */
  entityRefs?: string[];
  /** Developer-workflow facets covered by this memory, when applicable. */
  workflowFacets?: DeveloperWorkflowFacet[];
  /** Baseline relevance score from the upstream recall pipeline. */
  score: number;
}

export type DeveloperWorkflowFacet =
  | "repo_conventions"
  | "preferred_architecture_patterns"
  | "test_expectations"
  | "release_process"
  | "common_failure_modes"
  | "past_bugs"
  | "review_preferences"
  | "ask_before_public_api"
  | "always_run_checks";

export interface CodingRecallCase {
  id: string;
  title: string;
  /** Invariant being exercised — reported in details. */
  kind: "cross-project" | "branch-isolation" | "review-context" | "developer-workflow";
  /** Session's effective read namespaces. The benchmark scorer filters
   *  candidates to these before ranking. */
  sessionNamespaces: string[];
  /** For review-context cases only: touched files parsed from a diff. */
  touchedFiles?: string[];
  /** For review-context cases only: the prompt that triggers the tier. */
  prompt?: string;
  /** All candidate memories in the corpus (multiple projects / branches). */
  candidates: CodingRecallCaseMemory[];
  /** Memories we expect to appear (ordered, highest score first). */
  expectedIds: string[];
  /** Memories that MUST NOT appear — cross-project / cross-branch leaks. */
  forbiddenIds: string[];
  /** Developer-workflow facets that must be represented in retrieved memory. */
  requiredWorkflowFacets?: DeveloperWorkflowFacet[];
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-project isolation
// ──────────────────────────────────────────────────────────────────────────

const CROSS_PROJECT_CASE: CodingRecallCase = {
  id: "cross-project-basic",
  title: "Cross-project isolation — project B's memories are invisible to project A",
  kind: "cross-project",
  sessionNamespaces: ["project-origin-aaaaaaaa"],
  candidates: [
    { id: "a1", namespace: "project-origin-aaaaaaaa", score: 0.8, entityRefs: ["src/auth.ts"] },
    { id: "a2", namespace: "project-origin-aaaaaaaa", score: 0.6, entityRefs: ["docs/readme.md"] },
    { id: "b1", namespace: "project-origin-bbbbbbbb", score: 0.9, entityRefs: ["src/auth.ts"] },
    { id: "b2", namespace: "project-origin-bbbbbbbb", score: 0.7, entityRefs: ["docs/readme.md"] },
  ],
  expectedIds: ["a1", "a2"],
  forbiddenIds: ["b1", "b2"],
};

// ──────────────────────────────────────────────────────────────────────────
// Branch isolation with project-level fallback
// ──────────────────────────────────────────────────────────────────────────

const BRANCH_ISOLATION_CASE: CodingRecallCase = {
  id: "branch-isolation-with-project-fallback",
  title:
    "Branch isolation — branch A cannot see branch B, but project-level memories remain visible from branch A",
  kind: "branch-isolation",
  sessionNamespaces: [
    "project-origin-cccccccc-branch-feat-a",
    "project-origin-cccccccc",
  ],
  candidates: [
    // Branch A — should appear
    { id: "brA-local", namespace: "project-origin-cccccccc-branch-feat-a", score: 0.9 },
    // Branch B — must not appear
    { id: "brB-local", namespace: "project-origin-cccccccc-branch-feat-b", score: 0.95 },
    // Project-level — should appear via readFallback
    { id: "proj-level", namespace: "project-origin-cccccccc", score: 0.7 },
    // Other project — must not appear
    { id: "other-proj", namespace: "project-origin-dddddddd", score: 0.85 },
  ],
  expectedIds: ["brA-local", "proj-level"],
  forbiddenIds: ["brB-local", "other-proj"],
};

// ──────────────────────────────────────────────────────────────────────────
// Review-context ranking
// ──────────────────────────────────────────────────────────────────────────

const REVIEW_CONTEXT_CASE: CodingRecallCase = {
  id: "review-context-boosts-touched-files",
  title:
    "Review-context — 'review this diff' boosts memories that reference touched files above equal-score unrelated memories",
  kind: "review-context",
  sessionNamespaces: ["project-origin-eeeeeeee"],
  touchedFiles: ["src/auth.ts"],
  prompt: "review this diff",
  candidates: [
    { id: "touched", namespace: "project-origin-eeeeeeee", score: 0.3, entityRefs: ["src/auth.ts"] },
    { id: "untouched", namespace: "project-origin-eeeeeeee", score: 0.3, entityRefs: ["lib/other.ts"] },
    // A strong unmatched memory — should still appear but not outrank
    // touched (touched has 0.3 + 0.5 = 0.8 ≥ 0.8; stable tie-break wins
    // by id: "strong" < "touched", so "strong" comes first).
    { id: "strong", namespace: "project-origin-eeeeeeee", score: 0.8, entityRefs: ["db.sql"] },
  ],
  // Expected ordering: "strong" (0.8) and "touched" (0.8) tie on adjusted
  // score; stable tie-break by id puts "strong" first. Then "untouched"
  // (0.3) last.
  expectedIds: ["strong", "touched", "untouched"],
  forbiddenIds: [],
};

// ──────────────────────────────────────────────────────────────────────────
// Developer workflow memory
// ──────────────────────────────────────────────────────────────────────────

const REMNIC_PROJECT_NAMESPACE = "project-origin-1234abcd";
const USER_GLOBAL_NAMESPACE = "user-global";

const DEVELOPER_WORKFLOW_PLANNING_CASE: CodingRecallCase = {
  id: "developer-workflow-change-plan",
  title:
    "Developer workflow — public API planning recalls architecture boundaries, release process, tests, and ask-before rules",
  kind: "developer-workflow",
  sessionNamespaces: [REMNIC_PROJECT_NAMESPACE, USER_GLOBAL_NAMESPACE],
  candidates: [
    {
      id: "dev-architecture-core-host-agnostic",
      namespace: REMNIC_PROJECT_NAMESPACE,
      score: 0.97,
      entityRefs: [
        "packages/remnic-core/src/types.ts",
        "docs/architecture/monorepo-structure.md",
      ],
      workflowFacets: [
        "repo_conventions",
        "preferred_architecture_patterns",
      ],
    },
    {
      id: "dev-test-gate-preflight",
      namespace: REMNIC_PROJECT_NAMESPACE,
      score: 0.95,
      entityRefs: ["package.json", "docs/ops/pr-review-hardening-playbook.md"],
      workflowFacets: ["test_expectations", "always_run_checks"],
    },
    {
      id: "dev-release-process-changeset",
      namespace: REMNIC_PROJECT_NAMESPACE,
      score: 0.86,
      entityRefs: ["docs/development/release-process.md"],
      workflowFacets: ["release_process"],
    },
    {
      id: "dev-ask-before-public-api",
      namespace: USER_GLOBAL_NAMESPACE,
      score: 0.84,
      entityRefs: ["packages/remnic-core/src/index.ts"],
      workflowFacets: ["ask_before_public_api"],
    },
    {
      id: "dev-review-batch-subsystem",
      namespace: USER_GLOBAL_NAMESPACE,
      score: 0.8,
      entityRefs: ["docs/ops/pr-review-hardening-playbook.md"],
      workflowFacets: ["review_preferences"],
    },
    {
      id: "dev-other-repo-fast-path",
      namespace: "project-origin-ffffffff",
      score: 0.99,
      entityRefs: ["src/api.ts"],
      workflowFacets: ["repo_conventions"],
    },
  ],
  expectedIds: [
    "dev-architecture-core-host-agnostic",
    "dev-test-gate-preflight",
    "dev-release-process-changeset",
    "dev-ask-before-public-api",
    "dev-review-batch-subsystem",
  ],
  forbiddenIds: ["dev-other-repo-fast-path"],
  requiredWorkflowFacets: [
    "repo_conventions",
    "preferred_architecture_patterns",
    "test_expectations",
    "release_process",
    "review_preferences",
    "ask_before_public_api",
    "always_run_checks",
  ],
};

const DEVELOPER_WORKFLOW_REVIEW_CASE: CodingRecallCase = {
  id: "developer-workflow-review-risk",
  title:
    "Developer workflow — review recall boosts past bugs and common failure modes for touched files",
  kind: "developer-workflow",
  sessionNamespaces: [REMNIC_PROJECT_NAMESPACE, USER_GLOBAL_NAMESPACE],
  touchedFiles: [
    "packages/remnic-core/src/storage.ts",
    "packages/remnic-core/src/coding/review-context.ts",
  ],
  prompt: "review this PR before merge",
  candidates: [
    {
      id: "dev-past-bug-hash-dedup",
      namespace: REMNIC_PROJECT_NAMESPACE,
      score: 0.42,
      entityRefs: ["packages/remnic-core/src/storage.ts"],
      workflowFacets: ["past_bugs", "common_failure_modes"],
    },
    {
      id: "dev-storage-cache-invalidation",
      namespace: REMNIC_PROJECT_NAMESPACE,
      score: 0.41,
      entityRefs: ["packages/remnic-core/src/storage.ts"],
      workflowFacets: ["common_failure_modes"],
    },
    {
      id: "dev-untouched-style-preference",
      namespace: USER_GLOBAL_NAMESPACE,
      score: 0.75,
      entityRefs: ["docs/development/plugin-development.md"],
      workflowFacets: ["review_preferences"],
    },
    {
      id: "dev-review-hardening-gate",
      namespace: REMNIC_PROJECT_NAMESPACE,
      score: 0.39,
      entityRefs: ["docs/ops/pr-review-hardening-playbook.md"],
      workflowFacets: ["review_preferences", "always_run_checks"],
    },
    {
      id: "dev-client-app-storage-bug",
      namespace: "project-origin-99999999",
      score: 0.99,
      entityRefs: ["packages/remnic-core/src/storage.ts"],
      workflowFacets: ["past_bugs"],
    },
  ],
  expectedIds: [
    "dev-past-bug-hash-dedup",
    "dev-storage-cache-invalidation",
    "dev-untouched-style-preference",
    "dev-review-hardening-gate",
  ],
  forbiddenIds: ["dev-client-app-storage-bug"],
  requiredWorkflowFacets: [
    "common_failure_modes",
    "past_bugs",
    "review_preferences",
    "always_run_checks",
  ],
};

// ──────────────────────────────────────────────────────────────────────────
// Exported fixtures
// ──────────────────────────────────────────────────────────────────────────

export const CODING_RECALL_FIXTURE: CodingRecallCase[] = [
  CROSS_PROJECT_CASE,
  BRANCH_ISOLATION_CASE,
  REVIEW_CONTEXT_CASE,
  DEVELOPER_WORKFLOW_PLANNING_CASE,
  DEVELOPER_WORKFLOW_REVIEW_CASE,
];

// Smoke fixture keeps developer-workflow cases first so CLI quick runs that
// apply a task cap still exercise the workflow coverage metric instead of
// reporting only the older namespace-isolation cases.
export const CODING_RECALL_SMOKE_FIXTURE: CodingRecallCase[] = [
  DEVELOPER_WORKFLOW_PLANNING_CASE,
  DEVELOPER_WORKFLOW_REVIEW_CASE,
  CROSS_PROJECT_CASE,
  BRANCH_ISOLATION_CASE,
  REVIEW_CONTEXT_CASE,
];
