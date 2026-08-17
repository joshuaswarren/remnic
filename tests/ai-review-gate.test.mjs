import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  associatedPullRequestNumbers,
  canUseDependabotManifestException,
  evaluateAiReviewGate,
  isDependabotManifestOnlyPullRequest,
  parseReviewerGroups,
} from "../scripts/ai-review-gate.mjs";

const groups = parseReviewerGroups("cursor-bugbot[bot]|cursor, codex[bot]|codex");
const headSha = "abc1234567890";
const headCommittedAt = "2026-05-21T12:00:00.000Z";

test("AI review gate workflow only runs check_run events for reviewer apps", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");

  assert.match(workflow, /contains\(fromJSON\('\["cursor-bugbot","cursor","coderabbitai"\]'\)/);
  assert.doesNotMatch(workflow, /github\.event\.check_run\.app\.slug != 'github-actions'/);
});

test("AI review gate workflow requires the active current-head reviewer group", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");

  assert.match(
    workflow,
    /cursor-bugbot\[bot\]\|cursor\[bot\]\|cursor-bugbot\|cursor\|coderabbitai\[bot\]\|coderabbitai/,
  );
  assert.doesNotMatch(workflow, /kilo-code-bot\[bot\].*REQUIRED_AI_REVIEWER_GROUPS/s);
  assert.doesNotMatch(workflow, /chatgpt-codex-connector.*REQUIRED_AI_REVIEWER_GROUPS/s);
});

test("AI review gate workflow grants Checks write for the neutral supersession conclusion", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  assert.match(workflow, /^\s*checks:\s*write/m);
  assert.doesNotMatch(workflow, /^\s*checks:\s*read/m);
});

test("AI review gate self-supersession concludes the required context neutral (#2147)", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  // A bare return let the job conclude success or let concurrency mark it
  // cancelled — a cancelled suite pins the ruleset context red forever. The
  // supersession path must post an explicit neutral check-run on the SHA it was
  // triggered for so it satisfies the required `ai-reviewers` context.
  assert.match(workflow, /github\.rest\.checks\.create\(/);
  assert.match(workflow, /name:\s*'ai-reviewers'/);
  assert.match(workflow, /head_sha:\s*triggerHeadSha/);
  assert.match(workflow, /conclusion:\s*'neutral'/);
});

test("AI review gate never force-cancels a running evaluation (cancel-in-progress false)", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/);
});

test("AI review gate self-supersession neutralization is best-effort for fork PRs (#2154)", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  // Fork PRs get a read-only GITHUB_TOKEN, so checks.create returns 403. The
  // supersession must catch that and fall through to the bare return — never
  // turn a supersession into a job failure (cursor, round 2). The guarded shape
  // is try { ... checks.create ... } catch that only core.notice()s.
  assert.match(
    workflow,
    /try\s*\{[\s\S]*?await github\.rest\.checks\.create\([\s\S]*?\}\s*catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?core\.notice\([\s\S]*?\}/,
  );
  // Scope to the supersession block: its catch handler must never fail the job.
  const supersession = workflow.slice(
    workflow.indexOf("if (triggerHeadSha)"),
    workflow.indexOf("const { failures, evaluatedCount, hasBlockers }"),
  );
  assert.match(supersession, /catch\s*\(\s*\w+\s*\)\s*\{[\s\S]*?core\.notice\(/);
  assert.doesNotMatch(supersession, /core\.setFailed\(/);
});

test("AI review gate neutralizer clears cancelled suites on a positive verdict only (#2154)", () => {
  const neutralizer = readFileSync(
    ".github/workflows/ai-review-gate-neutralizer.yml",
    "utf8",
  );
  // A pending gate run cancelled by concurrency never reaches the in-job neutral
  // path. This workflow_run(completed) handler clears such dead suites from the
  // base-repo context (writable token, incl. fork PRs), but ONLY when a gate run
  // completes with a positive verdict - never off a cancelled/failed completion
  // (codex #2154, rounds 2-6).
  assert.match(neutralizer, /^\s*workflow_run:/m);
  assert.match(neutralizer, /workflows:\s*\[\s*["']AI Review Gate["']\s*\]/);
  assert.match(neutralizer, /types:\s*\[\s*completed\s*\]/);
  // Trigger gates on a POSITIVE completion, never on a cancelled or failed one.
  assert.match(neutralizer, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.doesNotMatch(neutralizer, /workflow_run\.conclusion == 'cancelled'/);
  assert.doesNotMatch(neutralizer, /conclusion == 'failure'/);
  // Posts a neutral ai-reviewers check-run on the verdict's head SHA.
  assert.match(neutralizer, /github\.rest\.checks\.create\(/);
  assert.match(neutralizer, /name:\s*'ai-reviewers'/);
  assert.match(neutralizer, /conclusion:\s*'neutral'/);
  assert.match(neutralizer, /head_sha:\s*headSha/);
  // Anti-recursion is structural: the trigger lists only the gate, never itself.
  assert.doesNotMatch(neutralizer, /workflows:\s*\[[^\]]*Neutralizer/);
  // Least privilege: actions:read + pull-requests:read + checks:write; no writes
  // beyond checks.
  assert.match(neutralizer, /^\s*actions:\s*read/m);
  assert.match(neutralizer, /^\s*pull-requests:\s*read/m);
  assert.match(neutralizer, /^\s*checks:\s*write/m);
  assert.doesNotMatch(neutralizer, /^\s*actions:\s*write/m);
  assert.doesNotMatch(neutralizer, /^\s*contents:\s*write/m);
  assert.doesNotMatch(neutralizer, /^\s*pull-requests:\s*write/m);
  assert.doesNotMatch(neutralizer, /^\s*issues:\s*write/m);
});

test("AI review gate neutralizer clears only OLDER same-PR cancellations, never masks a verdict (#2154)", () => {
  const neutralizer = readFileSync(
    ".github/workflows/ai-review-gate-neutralizer.yml",
    "utf8",
  );
  // The neutral is posted only when a completed positive verdict supersedes the
  // cancelled suites. Because the verdict is FINAL, the neutral can never mask a
  // failure that concludes moments later (the race codex flagged, rounds 4-6).
  // Only cancelled runs that are same-PR and created no later than the verdict
  // are cleared; a newer cancellation (a fresh, un-evaluated event) is left
  // blocking, and a lone cancel with no positive verdict is never cleared.
  assert.match(neutralizer, /listWorkflowRuns/);
  assert.match(neutralizer, /workflow_id:\s*'ai-review-gate\.yml'/);
  assert.match(neutralizer, /supersededCancellations/);
  assert.ok(
    neutralizer.indexOf("listWorkflowRuns") <
      neutralizer.indexOf("github.rest.checks.create("),
    "sibling lookup must precede the neutral checks.create",
  );
  const guard = neutralizer.slice(
    neutralizer.indexOf("listWorkflowRuns"),
    neutralizer.indexOf("github.rest.checks.create("),
  );
  // Only completed `cancelled` siblings are cleared.
  assert.match(guard, /candidate\.status === 'completed'/);
  assert.match(guard, /candidate\.conclusion === 'cancelled'/);
  // Same-PR is proven by resolving the head to exactly one PR (fork-safe); an
  // ambiguous SHA (shared or unattributed) declines rather than cross-neutralize.
  assert.match(neutralizer, /listPullRequestsAssociatedWithCommit/);
  assert.match(neutralizer, /associatedPrNumbers\.length !== 1/);
  // The verdict must be the NEWEST gate run: if any sibling ran later (by the
  // current attempt's run_started_at, not the rerun-stale created_at), decline
  // so a newer run's failure can never be masked (rounds 6, 9).
  assert.match(neutralizer, /run\.run_started_at \|\| run\.created_at/);
  assert.match(guard, /candidate\.run_started_at \|\| candidate\.created_at/);
  assert.match(guard, /newerRunExists/);
  assert.match(guard, /candidateRanAt > verdictRanAt/);
  // Nothing to clear -> return before posting.
  assert.match(guard, /supersededCancellations\.length === 0/);
  assert.match(guard, /return;/);
});

test("AI review gate workflow limits the Dependabot exception to manifest-only missing Cursor activity", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");

  assert.match(workflow, /pullRequest\.data\.user\?\.login/);
  assert.match(workflow, /github\.paginate\(github\.rest\.pulls\.listFiles/);
  assert.match(workflow, /dependabot\[bot\]/);
  assert.match(workflow, /result\.blockers\.length === 0/);
  assert.match(workflow, /result\.missing\.every/);
  assert.match(workflow, /DEPENDABOT_UNAVAILABLE_REVIEWER_ALIASES\.has\(normalizeLogin\(alias\)\)/);
  assert.match(workflow, /DEPENDENCY_MANIFEST_BASENAMES/);
});

test("Dependabot manifest-only classification accepts the repository dependency surfaces", () => {
  for (const files of [
    ["packages/bench-ui/package.json", "pnpm-lock.yaml"],
    ["model-lab/requirements.txt"],
    ["packages/hermes-provider/package-lock.json"],
  ]) {
    assert.equal(
      isDependabotManifestOnlyPullRequest({ authorLogin: "dependabot[bot]", files }),
      true,
    );
  }
});

test("Dependabot manifest-only classification rejects human, mixed, empty, and traversal diffs", () => {
  for (const candidate of [
    { authorLogin: "human", files: ["package.json"] },
    { authorLogin: "dependabot[bot]", files: ["package.json", "src/index.ts"] },
    { authorLogin: "dependabot[bot]", files: ["model-lab/requirements.txt", "docs/model-lab.md"] },
    { authorLogin: "dependabot[bot]", files: [] },
    { authorLogin: "dependabot[bot]", files: ["../package.json"] },
  ]) {
    assert.equal(isDependabotManifestOnlyPullRequest(candidate), false);
  }
});

test("Dependabot exception applies only to missing Cursor activity without blockers", () => {
  const manifestPullRequest = {
    authorLogin: "dependabot[bot]",
    files: ["packages/bench-ui/package.json", "pnpm-lock.yaml"],
  };

  assert.equal(
    canUseDependabotManifestException({
      ...manifestPullRequest,
      result: { ok: false, missing: [["cursor-bugbot[bot]", "cursor"]], blockers: [] },
    }),
    true,
  );
  assert.equal(
    canUseDependabotManifestException({
      ...manifestPullRequest,
      result: {
        ok: false,
        missing: [["cursor"]],
        blockers: [{ alias: "cursor", kind: "check_run", state: "failure" }],
      },
    }),
    false,
  );
  assert.equal(
    canUseDependabotManifestException({
      ...manifestPullRequest,
      result: { ok: false, missing: [["codex"]], blockers: [] },
    }),
    false,
  );
  assert.equal(
    canUseDependabotManifestException({
      ...manifestPullRequest,
      result: { ok: false, missing: [["cursor-imposter"]], blockers: [] },
    }),
    false,
  );
});

test("AI review gate resolves every pull request associated with a check_run event", () => {
  assert.deepEqual(
    associatedPullRequestNumbers({
      check_run: {
        pull_requests: [
          { number: 17 },
          { number: "18" },
          { number: 17 },
          { number: 0 },
          { number: "not-a-number" },
        ],
      },
    }),
    [17, 18],
  );

  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");
  assert.doesNotMatch(workflow, /linked to multiple pull requests/);
  assert.match(workflow, /AI review gate did not evaluate any non-draft pull requests/);
  assert.doesNotMatch(workflow, /Skipping because all associated pull requests are draft/);
});

test("AI review gate prefers the direct pull_request event number", () => {
  assert.deepEqual(
    associatedPullRequestNumbers({
      pull_request: { number: 42 },
      check_run: { pull_requests: [{ number: 99 }] },
    }),
    [42],
  );
});

test("AI review gate passes only when every required group has positive current-head activity", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "success", head_sha: headSha },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.blockers, []);
});

test("CodeRabbit current-head success satisfies the Cursor OR group", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups(
      "cursor-bugbot[bot]|cursor[bot]|cursor-bugbot|cursor|coderabbitai[bot]|coderabbitai",
    ),
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "coderabbitai" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.blockers, []);
});


test("AI review gate fails on failed review-bot check runs", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "failure", head_sha: headSha },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /failed or was not positive/);
  assert.equal(result.blockers[0]?.alias, "cursor");
});

test("AI review gate preserves failed aliases when another alias in the OR group passed", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor-bugbot|cursor, codex"),
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "failure", head_sha: headSha },
      { app: { slug: "cursor-bugbot" }, conclusion: "success", head_sha: headSha },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.equal(result.blockers[0]?.alias, "cursor");
  assert.equal(result.present[0]?.alias, "cursor-bugbot");
});

test("AI review gate blocks startup_failure review-bot check runs", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: `PASS for ${headSha}`,
        created_at: "2026-05-21T12:00:01.000Z",
      },
    ],
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "startup_failure", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0]?.alias, "cursor");
  assert.equal(result.blockers[0]?.state, "startup_failure");
});

test("AI review gate uses the latest current-head review state per alias", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("codex"),
    headSha,
    headCommittedAt,
    reviews: [
      {
        user: { login: "codex" },
        state: "APPROVED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:01.000Z",
      },
      {
        user: { login: "codex" },
        state: "CHANGES_REQUESTED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:02.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0]?.alias, "codex");
  assert.equal(result.blockers[0]?.state, "CHANGES_REQUESTED");
});

test("AI review gate blocks dismissed current-head review changes", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("codex"),
    headSha,
    headCommittedAt,
    reviews: [
      {
        user: { login: "codex" },
        state: "CHANGES_REQUESTED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:01.000Z",
      },
      {
        user: { login: "codex" },
        state: "DISMISSED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:02.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0]?.alias, "codex");
  assert.equal(result.blockers[0]?.state, "DISMISSED");
});

test("AI review gate accepts a later current-head approval after changes requested", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("codex"),
    headSha,
    headCommittedAt,
    reviews: [
      {
        user: { login: "codex" },
        state: "CHANGES_REQUESTED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:01.000Z",
      },
      {
        user: { login: "codex" },
        state: "APPROVED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:02.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.present[0]?.kind, "review");
});

test("AI review gate lets current-head positive check runs clear review blockers", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    reviews: [
      {
        user: { login: "cursor" },
        state: "CHANGES_REQUESTED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:01.000Z",
      },
    ],
    checkRuns: [
      {
        app: { slug: "cursor" },
        conclusion: "success",
        head_sha: headSha,
        completed_at: "2026-05-21T12:00:02.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.present[0]?.kind, "check_run");
});

test("AI review gate does not clear dismissed review blockers with check runs", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    reviews: [
      {
        user: { login: "cursor" },
        state: "DISMISSED",
        commit_id: headSha,
        submitted_at: "2026-05-21T12:00:03.000Z",
      },
    ],
    checkRuns: [
      {
        app: { slug: "cursor" },
        conclusion: "success",
        head_sha: headSha,
        completed_at: "2026-05-21T12:00:04.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0]?.alias, "cursor");
  assert.equal(result.blockers[0]?.state, "DISMISSED");
});

test("AI review gate ignores failed check runs from non-reviewer apps", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "success", head_sha: headSha },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
      { app: { slug: "github-actions", name: "GitHub Actions" }, conclusion: "failure", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("AI review gate accepts neutral review-bot check runs as current-head review activity", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "neutral", head_sha: headSha },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.present[0]?.state, "neutral");
});

test("AI review gate uses the latest current-head check run per reviewer alias and check name", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      {
        name: "Cursor Bugbot",
        app: { slug: "cursor" },
        conclusion: "failure",
        head_sha: headSha,
        completed_at: "2026-05-21T12:00:01.000Z",
      },
      {
        name: "Cursor Bugbot",
        app: { slug: "cursor" },
        conclusion: "success",
        head_sha: headSha,
        completed_at: "2026-05-21T12:00:02.000Z",
      },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test("AI review gate rejects negative comments that contain positive tokens", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("codex"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "codex" },
        body: `not approved for ${headSha}`,
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate accepts explicit PASS comments that mention failures are absent", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: `PASS for ${headSha}; no failures found.`,
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.present[0]?.kind, "comment");
});

test("AI review gate rejects fresh positive comments that target an older SHA", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: "PASS for deadbee",
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate accepts fresh positive comments without an embedded SHA", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: "PASS",
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.present[0]?.kind, "comment");
});

test("AI review gate fails when a required group is missing", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
  assert.deepEqual(result.missing[0], ["codex[bot]", "codex"]);
});

test("AI review gate ignores stale positive comments from before the current head", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: "PASS",
        created_at: "2026-05-21T11:59:59.000Z",
        updated_at: "2026-05-21T11:59:59.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate ignores old positive comments edited after the current head", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: "PASS",
        created_at: "2026-05-21T11:59:59.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate accepts unbound positive comments posted after the current head", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt: "2026-05-20T12:00:00.000Z",
    issueComments: [
      {
        user: { login: "cursor" },
        body: "PASS",
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.present[0]?.kind, "comment");
});

test("AI review gate accepts SHA-bound positive comments on the current head", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: `PASS for ${headSha.slice(0, 7)}`,
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.present[0]?.kind, "comment");
});

test("AI review gate accepts current-head comments when head commit time is unavailable", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt: null,
    issueComments: [
      {
        user: { login: "cursor" },
        body: `PASS for ${headSha.slice(0, 7)}`,
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.present[0]?.kind, "comment");
});

test("AI review gate rejects unreferenced comments when head commit time is unavailable", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt: null,
    issueComments: [
      {
        user: { login: "cursor" },
        body: "PASS",
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate ignores positive comments from unconfigured aliases", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "random-reviewer" },
        body: "PASS",
        created_at: "2026-05-21T12:00:01.000Z",
        updated_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate ignores stale comments that mention the current head SHA", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    issueComments: [
      {
        user: { login: "cursor" },
        body: `PASS for ${headSha.slice(0, 7)}`,
        created_at: "2026-05-21T11:00:00.000Z",
        updated_at: "2026-05-21T11:00:00.000Z",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate ignores stale successful check runs from older heads", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    checkRuns: [
      {
        app: { slug: "cursor" },
        conclusion: "success",
        head_sha: "old1234567890",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Missing required positive AI review groups/);
});

test("AI review gate accepts check runs newer than head when SHA metadata is unavailable", () => {
  const result = evaluateAiReviewGate({
    groups: parseReviewerGroups("cursor"),
    headSha,
    headCommittedAt,
    checkRuns: [
      {
        app: { slug: "cursor" },
        conclusion: "success",
        completed_at: "2026-05-21T12:00:01.000Z",
      },
    ],
  });

  assert.equal(result.ok, true);
});
