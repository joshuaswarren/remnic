import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  associatedPullRequestNumbers,
  evaluateAiReviewGate,
  parseReviewerGroups,
} from "../scripts/ai-review-gate.mjs";

const groups = parseReviewerGroups("cursor-bugbot[bot]|cursor, codex[bot]|codex");
const headSha = "abc1234567890";
const headCommittedAt = "2026-05-21T12:00:00.000Z";

test("AI review gate workflow only runs check_run events for reviewer apps", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");

  assert.match(workflow, /contains\(fromJSON\('\["cursor-bugbot","cursor"\]'\)/);
  assert.doesNotMatch(workflow, /github\.event\.check_run\.app\.slug != 'github-actions'/);
});

test("AI review gate workflow requires the active current-head reviewer group", () => {
  const workflow = readFileSync(".github/workflows/ai-review-gate.yml", "utf8");

  assert.match(workflow, /cursor-bugbot\[bot\]\|cursor\[bot\]\|cursor-bugbot\|cursor/);
  assert.doesNotMatch(workflow, /kilo-code-bot\[bot\].*REQUIRED_AI_REVIEWER_GROUPS/s);
  assert.doesNotMatch(workflow, /chatgpt-codex-connector.*REQUIRED_AI_REVIEWER_GROUPS/s);
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
