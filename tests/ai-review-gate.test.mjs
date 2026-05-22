import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAiReviewGate,
  parseReviewerGroups,
} from "../scripts/ai-review-gate.mjs";

const groups = parseReviewerGroups("cursor-bugbot[bot]|cursor, codex[bot]|codex");
const headSha = "abc1234567890";
const headCommittedAt = "2026-05-21T12:00:00.000Z";

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

test("AI review gate fails on neutral review-bot check runs", () => {
  const result = evaluateAiReviewGate({
    groups,
    headSha,
    headCommittedAt,
    checkRuns: [
      { app: { slug: "cursor" }, conclusion: "neutral", head_sha: headSha },
      { app: { slug: "codex" }, conclusion: "success", head_sha: headSha },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0]?.state, "neutral");
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

test("AI review gate accepts explicit positive comments on the current head", () => {
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

  assert.equal(result.ok, true);
  assert.equal(result.present[0]?.kind, "comment");
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
