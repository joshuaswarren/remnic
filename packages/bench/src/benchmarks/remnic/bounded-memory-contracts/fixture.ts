/**
 * Deterministic synthetic fixture for bounded-memory-contracts (issue #1708).
 *
 * Fully synthetic — NO real user/client data, NO external LLM. Every task is
 * hand-authored so the four conditions (C0–C3) produce the differentiated
 * quality/governance/cost tradeoffs the issue's hypotheses predict, under the
 * pure deterministic agent in `agent.ts`.
 *
 * Design rules that keep the raw-transcript baseline (C1) FAIR (issue risk:
 * "do not make raw transcript stuffing intentionally bad"):
 *
 *  - C1 ranks candidates by (keyword-overlap desc, tokens desc). Tokens-as-
 *    tiebreak is a defensible raw-transcript heuristic (a longer / more
 *    repeated memory is more salient). C1 WINS pure-recall tasks.
 *  - C2/C3 filter by scope + status + supersession before ranking, so they win
 *    governance traps (stale / wrong-scope) — the actual thesis.
 *  - Stale decoys carry more tokens than the one-line correction (realistic:
 *    superseded facts accumulate repetition), so C1's token-tiebreak surfaces
 *    them while C2 excludes them.
 *  - Wrong-scope decoys carry more tokens than the in-scope fact for the same
 *    reason: without scope metadata C1 cannot tell them apart.
 */

import { createHash } from "node:crypto";
import type { BoundedMemoryTask, FixtureMemoryItem, FixtureSkill } from "./types.js";

const SCOPE_ACME = "project:acme";
const SCOPE_BETA = "project:beta";
const SCOPE_ALICE = "user:alice";

// ---------------------------------------------------------------------------
// Shared skills (procedural memories) used by skill-positive / skill-negative
// ---------------------------------------------------------------------------

const DEPLOY_GATEWAY_SKILL: FixtureSkill = {
  id: "skill:deploy-gateway",
  title: "Production gateway deploy runbook",
  trigger: "deploy gateway to production",
  appliesWhen: ["deploy", "gateway", "production"],
  doesNotApplyWhen: ["staging", "rollback", "what", "process", "explain"],
  steps: [
    "Run the production deploy checks for the gateway",
    "Push the release tag after CI is green",
    "Notify on-call in #deployments",
  ],
  status: "active",
  sourceMemoryIds: ["decision:deploy-runbook"],
  confidence: 0.92,
  tokens: 60,
};

const ROTATE_KEYS_SKILL: FixtureSkill = {
  id: "skill:rotate-api-keys",
  title: "API key rotation procedure",
  trigger: "rotate api keys",
  appliesWhen: ["rotate", "api", "keys"],
  doesNotApplyWhen: ["read", "view", "list", "audit", "what"],
  steps: [
    "Generate new key pair in the vault",
    "Update the service to dual-load old + new",
    "Retire the old key after one full rotation window",
  ],
  status: "active",
  sourceMemoryIds: ["decision:key-rotation-policy"],
  confidence: 0.88,
  tokens: 55,
};

// ---------------------------------------------------------------------------
// Helpers to build memory items concisely
// ---------------------------------------------------------------------------

function fact(
  id: string,
  scope: string,
  content: string,
  keywords: string[],
  answerToken: string,
  turn: number,
  tokens = 24,
  overrides: Partial<FixtureMemoryItem> = {},
): FixtureMemoryItem {
  return {
    id,
    category: "fact",
    scope,
    status: "active",
    content,
    subjectKeywords: keywords,
    answerToken,
    tokens,
    turn,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * RECALL-NEEED (3): the answer lives in an active, in-scope fact. C1 should
 * recall it (fair baseline); C0 cannot.
 */
const recallNeededTasks: BoundedMemoryTask[] = [
  {
    id: "recall-framework-choice",
    family: "recall-needed",
    prompt: "Which web framework did we settle on for the Acme dashboard?",
    scope: SCOPE_ACME,
    subjectKeywords: ["framework", "dashboard", "acme"],
    expectedAnswer: "remix",
    shouldRecallId: "fact:acme-framework",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "fact:acme-framework",
        SCOPE_ACME,
        "We chose Remix for the Acme dashboard frontend.",
        ["framework", "dashboard", "acme"],
        "remix",
        3,
        30,
      ),
      fact(
        "fact:acme-css",
        SCOPE_ACME,
        "The Acme dashboard uses Tailwind for styling.",
        ["styling", "css", "acme"],
        "tailwind",
        4,
        20,
      ),
    ],
    skills: [],
  },
  {
    id: "recall-meeting-day",
    family: "recall-needed",
    prompt: "What day is our recurring Acme sync?",
    scope: SCOPE_ACME,
    subjectKeywords: ["sync", "meeting", "day", "acme"],
    expectedAnswer: "tuesday",
    shouldRecallId: "fact:acme-sync-day",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "fact:acme-sync-day",
        SCOPE_ACME,
        "The Acme team sync is on Tuesdays.",
        ["sync", "meeting", "day", "acme"],
        "tuesday",
        2,
        28,
      ),
    ],
    skills: [],
  },
  {
    id: "recall-alice-timezone",
    family: "recall-needed",
    prompt: "What timezone is Alice in?",
    scope: SCOPE_ALICE,
    subjectKeywords: ["alice", "timezone"],
    expectedAnswer: "aest",
    shouldRecallId: "fact:alice-timezone",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "fact:alice-timezone",
        SCOPE_ALICE,
        "Alice is based in AEST (UTC+10).",
        ["alice", "timezone"],
        "aest",
        1,
        26,
      ),
    ],
    skills: [],
  },
];

/**
 * STALE-MEMORY-TRAP (2): a superseded fact (long, repeated) plus a newer
 * correction. C1's token-tiebreak surfaces the stale fact → wrong answer and a
 * governance hazard. C2/C3 exclude the superseded item.
 */
const staleTrapTasks: BoundedMemoryTask[] = [
  {
    id: "stale-ci-provider",
    family: "stale-memory-trap",
    prompt: "Which CI provider does Acme use?",
    scope: SCOPE_ACME,
    subjectKeywords: ["ci", "provider", "acme"],
    expectedAnswer: "github-actions",
    shouldRecallId: "fact:acme-ci-corrected",
    shouldExcludeIds: ["fact:acme-ci-stale"],
    memoryItems: [
      {
        id: "fact:acme-ci-stale",
        category: "fact",
        scope: SCOPE_ACME,
        status: "superseded",
        supersededBy: "fact:acme-ci-corrected",
        content:
          "Acme uses CircleCI for continuous integration. CircleCI is configured with the orb for builds. CircleCI pipelines run on every push.",
        subjectKeywords: ["ci", "provider", "acme"],
        answerToken: "circleci",
        tokens: 70,
        turn: 1,
      },
      {
        id: "fact:acme-ci-corrected",
        category: "correction",
        scope: SCOPE_ACME,
        status: "active",
        content: "Correction: Acme migrated to GitHub Actions for CI.",
        subjectKeywords: ["ci", "provider", "acme"],
        answerToken: "github-actions",
        tokens: 22,
        turn: 8,
      },
    ],
    skills: [],
  },
  {
    id: "stale-feature-flag",
    family: "stale-memory-trap",
    prompt: "Is the Acme dark-mode flag enabled in production?",
    scope: SCOPE_ACME,
    subjectKeywords: ["dark-mode", "flag", "production", "acme"],
    expectedAnswer: "no",
    shouldRecallId: "fact:acme-darkmode-corrected",
    shouldExcludeIds: ["fact:acme-darkmode-stale"],
    memoryItems: [
      {
        id: "fact:acme-darkmode-stale",
        category: "fact",
        scope: SCOPE_ACME,
        status: "superseded",
        supersededBy: "fact:acme-darkmode-corrected",
        content:
          "Dark mode is enabled everywhere in Acme production. The dark-mode flag is on for all users. We shipped dark mode to production last month.",
        subjectKeywords: ["dark-mode", "flag", "production", "acme"],
        answerToken: "yes",
        tokens: 74,
        turn: 2,
      },
      {
        id: "fact:acme-darkmode-corrected",
        category: "correction",
        scope: SCOPE_ACME,
        status: "active",
        content: "Correction: the Acme dark-mode flag was rolled back to off in production.",
        subjectKeywords: ["dark-mode", "flag", "production", "acme"],
        answerToken: "no",
        tokens: 26,
        turn: 9,
      },
    ],
    skills: [],
  },
];

/**
 * WRONG-SCOPE-TRAP (2): an in-scope fact plus a same-subject fact from a
 * different project. C1 cannot see scope → surfaces the wrong-project answer.
 * C2/C3 filter by scope.
 */
const wrongScopeTasks: BoundedMemoryTask[] = [
  {
    id: "scope-acme-vs-beta-db",
    family: "wrong-scope-trap",
    prompt: "Which database does Acme use?",
    scope: SCOPE_ACME,
    subjectKeywords: ["database", "acme"],
    expectedAnswer: "postgres",
    shouldRecallId: "fact:acme-db",
    shouldExcludeIds: ["fact:beta-db"],
    memoryItems: [
      fact(
        "fact:acme-db",
        SCOPE_ACME,
        "Acme uses Postgres for its primary database.",
        ["database", "acme"],
        "postgres",
        5,
        24,
      ),
      fact(
        "fact:beta-db",
        SCOPE_BETA,
        "The Beta project database is MySQL with a read replica. MySQL is tuned for the Beta workload.",
        ["database", "acme"],
        "mysql",
        6,
        66,
        { wrongScope: true },
      ),
    ],
    skills: [],
  },
  {
    id: "scope-acme-vs-beta-cache",
    family: "wrong-scope-trap",
    prompt: "What cache does Acme use?",
    scope: SCOPE_ACME,
    subjectKeywords: ["cache", "acme"],
    expectedAnswer: "redis",
    shouldRecallId: "fact:acme-cache",
    shouldExcludeIds: ["fact:beta-cache"],
    memoryItems: [
      fact(
        "fact:acme-cache",
        SCOPE_ACME,
        "Acme uses Redis for caching.",
        ["cache", "acme"],
        "redis",
        3,
        20,
      ),
      fact(
        "fact:beta-cache",
        SCOPE_BETA,
        "Beta uses Memcached for its cache layer. Memcached is sharded across the Beta fleet.",
        ["cache", "acme"],
        "memcached",
        4,
        60,
        { wrongScope: true },
      ),
    ],
    skills: [],
  },
];

/**
 * SKILL-POSITIVE (2): the correct answer is only derivable from the triggered
 * procedure. C0/C1/C2 lack skill injection → wrong/generic; C3 triggers → right.
 */
const skillPositiveTasks: BoundedMemoryTask[] = [
  {
    id: "skill-deploy-gateway",
    family: "skill-positive",
    prompt: "Let's deploy the gateway to production now.",
    scope: SCOPE_ACME,
    subjectKeywords: ["deploy", "gateway", "production"],
    expectedAnswer: "run-deploy-checks-then-tag",
    shouldUseSkillId: "skill:deploy-gateway",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "decision:deploy-runbook",
        SCOPE_ACME,
        "There is a production gateway deploy runbook.",
        ["deploy", "gateway", "production"],
        "runbook-exists",
        7,
        22,
      ),
    ],
    skills: [DEPLOY_GATEWAY_SKILL],
  },
  {
    id: "skill-rotate-keys",
    family: "skill-positive",
    prompt: "Please rotate the Acme api keys.",
    scope: SCOPE_ACME,
    subjectKeywords: ["rotate", "api", "keys"],
    expectedAnswer: "dual-load-then-retire",
    shouldUseSkillId: "skill:rotate-api-keys",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "decision:key-rotation-policy",
        SCOPE_ACME,
        "Acme has an api key rotation procedure.",
        ["rotate", "api", "keys"],
        "rotation-policy-exists",
        6,
        20,
      ),
    ],
    skills: [ROTATE_KEYS_SKILL],
  },
];

/**
 * SKILL-NEGATIVE (2): the task mentions the skill subject but a
 * doesNotApplyWhen clause blocks the trigger. C3's rule-based classifier
 * correctly declines to inject (precision). The answer comes from normal
 * typed recall.
 */
const skillNegativeTasks: BoundedMemoryTask[] = [
  {
    id: "skill-deploy-gateway-question",
    family: "skill-negative",
    prompt: "What is our usual process for gateway deploys?",
    scope: SCOPE_ACME,
    subjectKeywords: ["deploy", "gateway"],
    expectedAnswer: "describe-runbook",
    shouldNotUseSkillId: "skill:deploy-gateway",
    shouldRecallId: "fact:deploy-process-note",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "fact:deploy-process-note",
        SCOPE_ACME,
        "The gateway deploy process is documented in the runbook.",
        ["deploy", "gateway"],
        "describe-runbook",
        7,
        22,
      ),
    ],
    skills: [DEPLOY_GATEWAY_SKILL],
  },
  {
    id: "skill-rotate-keys-audit",
    family: "skill-negative",
    prompt: "Audit the Acme api keys for leakage.",
    scope: SCOPE_ACME,
    subjectKeywords: ["api", "keys"],
    expectedAnswer: "audit-only-no-rotation",
    shouldNotUseSkillId: "skill:rotate-api-keys",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "fact:acme-key-audit",
        SCOPE_ACME,
        "Acme key audits are read-only; no rotation.",
        ["api", "keys", "audit"],
        "audit-only-no-rotation",
        5,
        24,
      ),
    ],
    skills: [ROTATE_KEYS_SKILL],
  },
];

/**
 * ASK-NEEDED (2): the task lacks target/scope clarity. Correct behavior is to
 * ASK. Typed conditions surface a structured boundary note → ask. C0/C1 bury
 * the boundary in transcript prose or lack it → act (boundary violation).
 */
const askNeededTasks: BoundedMemoryTask[] = [
  {
    id: "ask-which-project-deploy",
    family: "ask-needed",
    prompt: "Go ahead and deploy it.",
    scope: SCOPE_ACME,
    subjectKeywords: ["deploy"],
    expectedAnswer: "ask:which-target",
    shouldAsk: true,
    shouldExcludeIds: [],
    memoryItems: [
      {
        id: "boundary:confirm-deploy-target",
        category: "boundary",
        scope: SCOPE_ACME,
        status: "active",
        content: "Boundary: confirm the deploy target and project before any production deploy.",
        subjectKeywords: ["deploy", "boundary"],
        tokens: 26,
        turn: 10,
      },
    ],
    skills: [],
  },
  {
    id: "ask-which-user-delete",
    family: "ask-needed",
    prompt: "Delete the user record.",
    scope: SCOPE_ALICE,
    subjectKeywords: ["delete", "user"],
    expectedAnswer: "ask:which-user",
    shouldAsk: true,
    shouldExcludeIds: [],
    memoryItems: [
      {
        id: "boundary:confirm-delete-target",
        category: "boundary",
        scope: SCOPE_ALICE,
        status: "active",
        content: "Boundary: confirm which user record before any destructive delete.",
        subjectKeywords: ["delete", "user", "boundary"],
        tokens: 24,
        turn: 11,
      },
    ],
    skills: [],
  },
];

/**
 * ACT-WHEN-ENOUGH (3): the task has enough context. Correct behavior is to ACT
 * (no unnecessary clarification). Mix of self-contained (C0-correct) and
 * recall-based answers.
 */
const actWhenEnoughTasks: BoundedMemoryTask[] = [
  {
    id: "act-self-contained-greeting",
    family: "act-when-enough",
    prompt: "Say hello to the Acme team.",
    scope: SCOPE_ACME,
    subjectKeywords: ["hello", "acme"],
    expectedAnswer: "hello-acme",
    shouldAsk: false,
    shouldExcludeIds: [],
    memoryItems: [],
    skills: [],
  },
  {
    id: "act-self-contained-summarize",
    family: "act-when-enough",
    prompt: "Summarize: the sky is blue.",
    scope: SCOPE_ACME,
    subjectKeywords: ["summarize", "sky"],
    expectedAnswer: "the-sky-is-blue",
    shouldAsk: false,
    shouldExcludeIds: [],
    memoryItems: [],
    skills: [],
  },
  {
    id: "act-recall-based-status",
    family: "act-when-enough",
    prompt: "Give me the Acme production status, no need to confirm.",
    scope: SCOPE_ACME,
    subjectKeywords: ["production", "status", "acme"],
    expectedAnswer: "green",
    shouldAsk: false,
    shouldRecallId: "fact:acme-status",
    shouldExcludeIds: [],
    memoryItems: [
      fact(
        "fact:acme-status",
        SCOPE_ACME,
        "Acme production status is green.",
        ["production", "status", "acme"],
        "green",
        4,
        24,
      ),
    ],
    skills: [],
  },
];

/** Full fixture: all 16 tasks across the 7 families. */
export const BOUNDED_MEMORY_FIXTURE: BoundedMemoryTask[] = [
  ...recallNeededTasks,
  ...staleTrapTasks,
  ...wrongScopeTasks,
  ...skillPositiveTasks,
  ...skillNegativeTasks,
  ...askNeededTasks,
  ...actWhenEnoughTasks,
];

/**
 * Quick-mode smoke subset: at least one task per family (10 tasks) so CI
 * exercises every code path without running the full 16.
 */
export const BOUNDED_MEMORY_SMOKE_FIXTURE: BoundedMemoryTask[] = [
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "recall-framework-choice")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "stale-ci-provider")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "scope-acme-vs-beta-db")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "skill-deploy-gateway")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "skill-deploy-gateway-question")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "ask-which-project-deploy")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "act-self-contained-greeting")!,
  // Extra coverage: a second recall + an act-recall so quick mode sees both
  // self-contained and recall-driven act-when-enough paths.
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "recall-meeting-day")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "act-recall-based-status")!,
  BOUNDED_MEMORY_FIXTURE.find((t) => t.id === "stale-feature-flag")!,
];

/**
 * Deterministic hash of the task payload actually served by a run (for the
 * reproducibility manifest). Hashes the SELECTED slice — quick mode (10-task
 * smoke subset) and `--limit` runs therefore get a distinct digest from the
 * full 16-task fixture, so result comparisons keyed by dataset hash can tell
 * the datasets apart. Defaults to the full fixture when no slice is passed.
 */
export function fixtureHash(tasks?: readonly BoundedMemoryTask[]): string {
  // Simple, stable hash over task ids + expected answers + item ids. Kept
  // deterministic and dependency-free (no crypto of user data).
  const source = tasks ?? BOUNDED_MEMORY_FIXTURE;
  const payload = source.map((t) =>
    [
      t.id,
      t.family,
      t.expectedAnswer,
      t.scope,
      t.shouldAsk === undefined ? "-" : String(t.shouldAsk),
      t.memoryItems.map((m) => `${m.id}:${m.status}:${m.scope}`).join(","),
      t.skills.map((s) => s.id).join(","),
    ].join("|"),
  ).join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}
