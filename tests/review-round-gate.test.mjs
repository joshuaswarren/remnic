import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ROUND_COMMENT_MARKER, parseRoundLedger, renderRoundLedger } from "../scripts/review-rounds.mjs";
import {
  AUTO_CLOSED_LABEL,
  CAP_LABEL,
  FIX_ROUND_CAP,
  DEFAULT_REQUIRED_AI_REVIEWER_GROUPS,
  FORCE_DISPATCH_LABEL,
  PUSH_WARN_THRESHOLD,
  computeRoundGateDecision,
  runRoundGate,
} from "../scripts/review-round-gate.mjs";

const botAliases = ["cursor", "cursor-bugbot", "cursor[bot]", "cursor-bugbot[bot]"];
const debounceMs = 600_000;
const maxAgeMs = 86_400_000;

const loadFixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/review-rounds/${name}`, import.meta.url)), "utf8"));

function botReview(headSha, at) {
  return { id: `review-${at}`, author: { login: "cursor" }, commit_id: headSha, submitted_at: at };
}

function openThreads(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index + 1}`,
    isResolved: false,
    comments: { nodes: [{ author: { login: "cursor" }, path: `src/file-${index + 1}.ts` }] },
  }));
}

function decide(overrides = {}) {
  return computeRoundGateDecision({
    headSha: "head-1",
    headCommittedAt: "2026-07-18T11:59:00.000Z",
    now: "2026-07-18T12:00:00.000Z",
    reviews: [botReview("head-1", "2026-07-18T12:00:00.000Z")],
    threads: openThreads(2),
    botAliases,
    debounceMs,
    maxAgeMs,
    ...overrides,
  });
}

test("first current-head bot activity opens round 1 and writes an owned ledger", () => {
  const result = decide();
  assert.equal(result.decision.action, "open");
  assert.equal(result.telemetry.round, 1);
  assert.equal(result.telemetry.dispatch, false);
  assert.equal(result.telemetry.pushes, 0);
  assert.match(result.commentBody, new RegExp(ROUND_COMMENT_MARKER));
  assert.match(result.commentBody, /Transactional review round/);
});

test("a push during an open round updates the head but never dispatches", () => {
  const opened = decide();
  const pushed = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-2",
    headCommittedAt: "2026-07-18T12:01:00.000Z",
    now: "2026-07-18T12:01:30.000Z",
    reviews: [],
    threads: openThreads(2),
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(pushed.telemetry.dispatch, false);
  assert.equal(pushed.telemetry.pushes, 1);
  assert.equal(pushed.state.headSha, "head-2");
});

test("micro-push telemetry warns once pushes exceed the batch threshold", () => {
  let body = decide().commentBody;
  let result;
  for (let push = 1; push <= PUSH_WARN_THRESHOLD + 1; push += 1) {
    result = computeRoundGateDecision({
      ledgerBody: body,
      headSha: `head-${push + 1}`,
      headCommittedAt: `2026-07-18T12:0${push}:00.000Z`,
      now: `2026-07-18T12:0${push}:30.000Z`,
      reviews: [],
      threads: openThreads(2),
      botAliases,
      debounceMs,
      maxAgeMs,
    });
    body = result.commentBody;
  }
  assert.equal(result.telemetry.pushes, PUSH_WARN_THRESHOLD + 1);
  assert.equal(result.telemetry.batchWarning, true);
  assert.match(result.summary, /exceeds the batch rule/);
  assert.equal(result.telemetry.dispatch, false, "an open round never dispatches on a push");
});

test("resolving every round thread dispatches only after the debounce elapses", () => {
  const opened = decide();
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const early = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:09:59.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(early.telemetry.dispatch, false);

  const late = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:10:00.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(late.telemetry.dispatch, true);
  assert.equal(late.telemetry.reason, "round-complete");
});

test("the force-dispatch label bypasses the debounce", () => {
  const opened = decide();
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const forced = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:00:05.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    forceDispatch: true,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(forced.telemetry.dispatch, true);
  assert.equal(forced.telemetry.reason, "force-label");
});

test("unresolved round threads are surfaced in the summary, not hidden", () => {
  const result = decide();
  assert.equal(result.telemetry.unresolvedCount, 2);
  assert.match(result.summary, /Unresolved round threads/);
  assert.match(result.summary, /src\/file-1\.ts/);
});

test("a corrupt ledger body is treated as no prior round (recovery)", () => {
  const corrupt = `noise\n<!-- ${ROUND_COMMENT_MARKER}\n{"version":1,"status":"broken"}\n-->\ntail`;
  const result = computeRoundGateDecision({
    ledgerBody: corrupt,
    headSha: "head-1",
    headCommittedAt: "2026-07-18T11:59:00.000Z",
    now: "2026-07-18T12:00:00.000Z",
    reviews: [botReview("head-1", "2026-07-18T12:00:00.000Z")],
    threads: openThreads(1),
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(result.priorState, null);
  assert.equal(result.decision.action, "open");
  assert.equal(result.telemetry.round, 1);
});

test("a valid ledger body resumes the prior round (persistence round-trip)", () => {
  const opened = decide();
  const resumed = computeRoundGateDecision({
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:02:00.000Z",
    reviews: [],
    threads: openThreads(2),
    botAliases,
    debounceMs,
    maxAgeMs,
  });
  assert.equal(resumed.priorState.round, 1);
  assert.equal(resumed.telemetry.round, 1);
});

function replayThroughDriver(fixture) {
  const threads = openThreads(fixture.initialThreadCount);
  const resolved = threads.map((thread) => ({ ...thread, isResolved: true }));
  const commitTimeByHead = new Map(fixture.commits.map(([sha, at]) => [sha, at]));
  const commits = fixture.commits.map(([headSha, now]) => ({ headSha, now, review: null }));
  const reviews = fixture.botActivityAt.map((now) => {
    const headSha = commits.findLast((commit) => Date.parse(commit.now) <= Date.parse(now))?.headSha;
    if (!headSha) throw new Error(`fixture bot activity precedes commits: ${now}`);
    return { headSha, now, review: botReview(headSha, now) };
  });
  const events = [...commits, ...reviews].sort((a, b) => Date.parse(a.now) - Date.parse(b.now));

  let body = "";
  let dispatches = 0;
  for (const { headSha, now, review } of events) {
    const result = computeRoundGateDecision({
      ledgerBody: body,
      headSha,
      headCommittedAt: commitTimeByHead.get(headSha) ?? null,
      now,
      reviews: review ? [review] : [],
      threads,
      botAliases,
      // The replay validates ENFORCED behavior (#1852's churn collapses to <=3
      // dispatched rounds), so rounds must close on dispatch — enforce mode.
      enforce: true,
      debounceMs,
      maxAgeMs,
    });
    body = result.commentBody;
    if (result.telemetry.dispatch) dispatches += 1;
  }

  const settled = computeRoundGateDecision({
    ledgerBody: body,
    headSha: fixture.commits.at(-1)[0],
    headCommittedAt: fixture.commits.at(-1)[1],
    now: fixture.settledAt,
    reviews: [],
    threads: resolved,
    botAliases,
    enforce: true,
    debounceMs,
    maxAgeMs,
  });
  if (settled.telemetry.dispatch) dispatches += 1;
  return { dispatches, settled };
}

for (const name of ["pr-1852.json", "pr-1923.json"]) {
  test(`driver replay of ${name} collapses churn to <=3 dispatched rounds with no thread left unreviewed`, () => {
    const fixture = loadFixture(name);
    const { dispatches, settled } = replayThroughDriver(fixture);
    assert.ok(dispatches >= 1, "expected at least one dispatch");
    assert.ok(dispatches <= 3, `expected <=3 dispatches, got ${dispatches}`);
    assert.equal(settled.telemetry.unresolvedCount, 0, "no thread left unreviewed at settle");
  });
}

function fakeGithub({
  existingComments = [], threads = [], labels = [], draft = false,
  failDispatch = false, failLedgerWrite = false, failCapIssue = false,
} = {}) {
  const calls = { created: [], updated: [], graphql: 0, labelsAdded: [], labelsRemoved: [], issuesCreated: [] };
  const listComments = () => {};
  const listReviews = () => {};
  const listReviewComments = () => {};
  const listForRef = () => {};
  // Seeded ledger comments default to the workflow bot author so the owned-ledger
  // finder recognizes them; a test may pass an explicit user to exercise the
  // "ignore a non-bot marker comment" path (issue #1992).
  listComments.__data = existingComments.map((comment) =>
    comment.user ? comment : { ...comment, user: { login: "github-actions[bot]" } },
  );
  listReviews.__data = [];
  listReviewComments.__data = [];
  listForRef.__data = [];
  const github = {
    paginate: async (fn) => fn.__data ?? [],
    graphql: async () => {
      calls.graphql += 1;
      return { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } } };
    },
    rest: {
      pulls: {
        get: async () => ({ data: { draft, head: { sha: "head-1" }, labels } }),
        listReviews,
        listReviewComments,
      },
      issues: {
        listComments,
        createComment: async (args) => {
          // The dispatch trigger uses createComment; failDispatch simulates a
          // transient trigger failure so tests can assert the ledger is not
          // advanced to the dispatched state (issue #1992).
          if (failDispatch && /@coderabbitai|@codex/.test(args.body ?? "")) {
            throw new Error("simulated dispatch comment failure");
          }
          return calls.created.push(args);
        },
        updateComment: async (args) => {
          // failLedgerWrite simulates a transient ledger-write failure so tests can
          // assert the force-dispatch label is NOT consumed before a durable write.
          if (failLedgerWrite) throw new Error("simulated ledger write failure");
          return calls.updated.push(args);
        },
        addLabels: async (args) => calls.labelsAdded.push(args),
        removeLabel: async (args) => calls.labelsRemoved.push(args),
        // issues.create files the round-4 cap backlog issue (issue #2442);
        // failCapIssue simulates a transient failure so tests can assert the
        // gate degrades to a log line and retries on the next event.
        create: async (args) => {
          if (failCapIssue) throw new Error("simulated cap issue failure");
          calls.issuesCreated.push(args);
          return { data: { html_url: "https://github.com/o/r/issues/555" } };
        },
      },
      repos: {
        getCommit: async () => ({ data: { commit: { committer: { date: "2026-07-18T11:59:00.000Z" } } } }),
      },
      checks: { listForRef },
    },
  };
  return { github, calls };
}

const context = { repo: { owner: "o", repo: "r" }, payload: { pull_request: { number: 7 } } };
const core = { notice() {}, info() {}, warning() {}, setFailed() {} };

test("runRoundGate creates an owned ledger comment and does not dispatch in shadow mode", async () => {
  const { github, calls } = fakeGithub({ threads: openThreads(2) });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "false" } });
  assert.ok(result, "expected a decision");
  assert.equal(calls.created.length, 1, "one ledger comment created");
  assert.match(calls.created[0].body, new RegExp(ROUND_COMMENT_MARKER));
  // Shadow mode: the ONLY comment is the ledger — no @coderabbitai/@codex trigger.
  assert.ok(!calls.created.some((c) => /@coderabbitai|@codex/.test(c.body)), "no dispatch trigger in shadow mode");
});

test("runRoundGate updates the existing ledger comment instead of creating a new one", async () => {
  const seed = decide().commentBody;
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 99, body: seed }],
    threads: openThreads(2),
  });
  await runRoundGate({ github, context, core, env: {} });
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].comment_id, 99);
});

test("runRoundGate skips draft pull requests", async () => {
  const { github, calls } = fakeGithub({ draft: true, threads: openThreads(1) });
  const result = await runRoundGate({ github, context, core, env: {} });
  assert.equal(result, null);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated.length, 0);
});

test("runRoundGate honors the force-dispatch label but stays shadow without enforcement", async () => {
  const seed = decide({ threads: openThreads(2) }).commentBody;
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 5, body: seed }],
    threads: addressed,
    labels: [{ name: FORCE_DISPATCH_LABEL }],
  });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "false" } });
  assert.equal(result.telemetry.dispatch, true);
  assert.equal(result.telemetry.reason, "force-label");
  assert.ok(!calls.created.some((c) => /@coderabbitai|@codex/.test(c.body)), "shadow mode suppresses trigger even when forced");
});

const staleOpenLedger = renderRoundLedger({
  version: 1,
  status: "open",
  round: 1,
  openedAt: "2026-07-17T00:00:00.000Z",
  openedHeadSha: "head-1",
  headSha: "head-1",
  lastHeadChangedAt: "2026-07-17T00:00:00.000Z",
  pushes: 0,
  threadIds: ["thread-1"],
  dispatchIssuedAt: null,
  closeReason: null,
  autoClosed: false,
  lastBotActivity: { id: "review-1", at: "2026-07-17T00:00:00.000Z" },
});

test("runRoundGate never fails the check when the read path throws (non-blocking invariant)", async () => {
  let failed = false;
  const spyCore = { notice() {}, info() {}, warning() {}, setFailed() { failed = true; } };
  const throwingGithub = {
    paginate: async () => {
      throw new Error("simulated GitHub API outage");
    },
    graphql: async () => {
      throw new Error("simulated GraphQL outage");
    },
    rest: {
      pulls: {
        get: async () => {
          throw new Error("simulated pulls.get outage");
        },
      },
      issues: {},
      repos: {},
      checks: {},
    },
  };
  const result = await runRoundGate({ github: throwingGithub, context, core: spyCore, env: {} });
  assert.equal(result, null, "gate degrades to a no-op instead of throwing");
  assert.equal(failed, false, "gate never calls setFailed");
});

test("runRoundGate ignores a marker comment authored by a non-bot user", async () => {
  const spoofed = `${renderRoundLedger({
    version: 1,
    status: "open",
    round: 9,
    openedAt: "2026-07-18T00:00:00.000Z",
    openedHeadSha: "head-1",
    headSha: "head-1",
    lastHeadChangedAt: "2026-07-18T00:00:00.000Z",
    pushes: 0,
    threadIds: ["thread-1"],
    dispatchIssuedAt: null,
    closeReason: null,
    autoClosed: false,
    lastBotActivity: null,
  })}`;
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 42, body: spoofed, user: { login: "random-contributor" } }],
    threads: openThreads(2),
  });
  const result = await runRoundGate({ github, context, core, env: {} });
  assert.equal(calls.updated.length, 0, "the spoofed comment is never adopted as the ledger");
  assert.equal(calls.created.length, 1, "a fresh owned ledger is created instead");
  assert.notEqual(result.telemetry.round, 9, "spoofed round number is ignored");
});

test("runRoundGate applies the auto-closed label only under enforcement", async () => {
  const shadow = fakeGithub({ existingComments: [{ id: 7, body: staleOpenLedger }], threads: openThreads(1) });
  const shadowResult = await runRoundGate({
    github: shadow.github,
    context,
    core,
    env: { REVIEW_ROUND_ENFORCE: "false" },
  });
  // Shadow "changes nothing": the max-age dispatch is surfaced as a dry-run
  // decision, but the ledger is NOT recorded as closed/auto-closed and no label
  // is mutated.
  assert.equal(shadowResult.telemetry.dispatch, true, "max-age dispatch is surfaced");
  assert.equal(shadowResult.telemetry.reason, "max-age");
  assert.equal(shadowResult.telemetry.dryRun, true);
  assert.equal(shadowResult.telemetry.status, "open", "shadow persists an OPEN round, not a real dispatch");
  assert.equal(shadowResult.telemetry.autoClosed, false, "shadow does not record a real auto-close");
  assert.equal(shadow.calls.labelsAdded.length, 0, "shadow mode must not mutate PR labels");

  const enforced = fakeGithub({ existingComments: [{ id: 7, body: staleOpenLedger }], threads: openThreads(1) });
  await runRoundGate({ github: enforced.github, context, core, env: { REVIEW_ROUND_ENFORCE: "true" } });
  assert.equal(enforced.calls.labelsAdded.length, 1, "enforcement applies the auto-closed label");
  assert.deepEqual(enforced.calls.labelsAdded[0].labels, [AUTO_CLOSED_LABEL]);
});

test("shadow mode consumes the one-shot force-dispatch label so it cannot re-fire", async () => {
  const seed = decide({ threads: openThreads(2) }).commentBody;
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 5, body: seed }],
    threads: addressed,
    labels: [{ name: FORCE_DISPATCH_LABEL }],
  });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "false" } });
  assert.equal(result.telemetry.reason, "force-label");
  assert.equal(calls.labelsRemoved.length, 1, "the force label is removed even in shadow mode");
  assert.equal(calls.labelsRemoved[0].name, FORCE_DISPATCH_LABEL);
  assert.ok(!calls.created.some((c) => /@coderabbitai|@codex/.test(c.body)), "shadow still suppresses the trigger");
});

test("an enforced dispatch whose trigger fails leaves the round open to retry", async () => {
  const seed = decide({ threads: openThreads(2) }).commentBody;
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 8, body: seed }],
    threads: addressed,
    labels: [{ name: FORCE_DISPATCH_LABEL }],
    failDispatch: true,
  });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "true" } });
  assert.equal(result.telemetry.dispatch, true, "the decision still says dispatch");
  assert.equal(calls.updated.length, 0, "the dispatched ledger state is NOT persisted on trigger failure");
  assert.equal(calls.labelsRemoved.length, 0, "the force label is kept so the retry re-dispatches");
});

test("every dispatched reviewer bot is covered by the default detection aliases", () => {
  // dispatchReviewers pings @coderabbitai + @codex; the default alias list must
  // recognize their (and Cursor's) activity as round activity, or their
  // responses would never open the next round (issue #1992).
  for (const login of ["coderabbitai[bot]", "chatgpt-codex-connector[bot]", "cursor[bot]"]) {
    assert.ok(
      DEFAULT_REQUIRED_AI_REVIEWER_GROUPS.includes(login),
      `${login} missing from default detection aliases`,
    );
  }
});

test("an enforced dispatch pings exactly the reviewers the aliases recognize", async () => {
  const seed = decide({ threads: openThreads(2) }).commentBody;
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 3, body: seed }],
    threads: addressed,
    labels: [{ name: FORCE_DISPATCH_LABEL }],
  });
  await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "true" } });
  const trigger = calls.created.find((c) => /@coderabbitai|@codex/.test(c.body));
  assert.ok(trigger, "a reviewer trigger comment is posted under enforcement");
  assert.match(trigger.body, /@coderabbitai/);
  assert.match(trigger.body, /@codex/);
});

test("a check_run event processes only the concurrency-serialized PR", async () => {
  // A GitHub Actions run is in exactly one concurrency group; processing
  // secondary shared-head PRs here would write their ledgers outside their own
  // serialized group (codex). Only pull_requests[0] (the group key) is handled;
  // the rest advance via their own events.
  const { github, calls } = fakeGithub({ threads: openThreads(1) });
  const checkRunContext = {
    repo: { owner: "o", repo: "r" },
    payload: { check_run: { pull_requests: [{ number: 7 }, { number: 8 }] } },
  };
  const result = await runRoundGate({ github, context: checkRunContext, core, env: {} });
  assert.ok(result && !Array.isArray(result), "returns a single result for the serialized PR");
  assert.equal(calls.created.length, 1, "only the primary PR's ledger is written");
});

test("a transient ledger-write failure does not consume the force-dispatch label", async () => {
  // Regression: the force label must be removed only AFTER the dispatched state
  // is durably persisted; otherwise a transient write failure drops the
  // maintainer's force intent and its manual retry (Main).
  const seed = decide({ threads: openThreads(2) }).commentBody;
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 11, body: seed }],
    threads: addressed,
    labels: [{ name: FORCE_DISPATCH_LABEL }],
    failLedgerWrite: true,
  });
  const result = await runRoundGate({ github, context, core, env: { REVIEW_ROUND_ENFORCE: "false" } });
  assert.equal(result.telemetry.reason, "force-label", "force-dispatch was decided");
  assert.equal(calls.labelsRemoved.length, 0, "force label kept so the maintainer's retry survives");
});

test("shadow persists a dry-run dispatch as an OPEN round; enforce persists it closed", () => {
  const opened = decide();
  const addressed = openThreads(2).map((thread) => ({ ...thread, isResolved: true }));
  const args = {
    ledgerBody: opened.commentBody,
    headSha: "head-1",
    now: "2026-07-18T12:10:00.000Z",
    reviews: [],
    threads: addressed,
    botAliases,
    debounceMs,
    maxAgeMs,
  };
  const shadow = computeRoundGateDecision({ ...args, enforce: false });
  assert.equal(shadow.telemetry.dispatch, true, "the dispatch decision is still surfaced");
  assert.equal(shadow.telemetry.dryRun, true);
  assert.equal(shadow.state.status, "open", "shadow keeps the round open (changes nothing)");
  assert.equal(shadow.state.dispatchIssuedAt, null, "no real dispatch recorded in shadow");
  assert.equal(parseRoundLedger(shadow.commentBody).status, "open", "persisted ledger stays open");

  const enforced = computeRoundGateDecision({ ...args, enforce: true });
  assert.equal(enforced.state.status, "closed", "enforcement records the real dispatch");
  assert.equal(typeof enforced.state.dispatchIssuedAt, "string");
  assert.equal(parseRoundLedger(enforced.commentBody).status, "closed");
});

// ===========================================================================
// Round-budget ledger enforcement (issue #2442): warn at fix round 3, file the
// ONE cap backlog issue at fix round 4 — never blocking, never re-firing.
// ===========================================================================

function budgetThread(id, { critical = false, resolved = false, body } = {}) {
  return {
    id,
    isResolved: resolved,
    comments: {
      nodes: [
        {
          author: { login: "cursor" },
          path: `src/file-${id}.ts`,
          url: `https://github.com/o/r/pull/7/files#discussion_r_${id}`,
          body: body ?? (critical ? "Security: this leaks a bearer token." : "Consider a more descriptive name here."),
        },
      ],
    },
  };
}

const budgetThreads = (count) => Array.from({ length: count }, (_, index) => budgetThread(`t${index + 1}`));

function openBudgetState({ round, fixRounds, fixRoundWarnedAt = null, capIssueUrl = null }) {
  return {
    version: 1,
    status: "open",
    round,
    openedAt: "2026-07-18T11:00:00.000Z",
    openedHeadSha: "head-1",
    headSha: "head-1",
    lastHeadChangedAt: "2026-07-18T11:00:00.000Z",
    pushes: 0,
    fixRounds,
    fixRoundWarnedAt,
    capIssueUrl,
    threadIds: ["thread-1", "thread-2"],
    dispatchIssuedAt: null,
    closeReason: null,
    autoClosed: false,
    lastBotActivity: { id: "review-1", at: "2026-07-18T12:00:00.000Z" },
  };
}

test("budget telemetry and summary surface the fix-round count", () => {
  const seeded = renderRoundLedger(openBudgetState({ round: 3, fixRounds: 3 }));
  const result = decide({ ledgerBody: seeded });
  assert.equal(result.telemetry.fixRounds, 3);
  assert.match(result.commentBody, /Fix rounds: \*\*3\*\*/);
  assert.match(result.commentBody, /Fix-round budget at 3/);
});

test("the budget ledger posts a one-time warning reply at fix round 3", async () => {
  const seed = renderRoundLedger(openBudgetState({ round: 3, fixRounds: 3 }));
  const first = fakeGithub({ existingComments: [{ id: 7, body: seed }], threads: budgetThreads(2) });
  await runRoundGate({ github: first.github, context, core, env: {} });
  const warning = first.calls.created.find((comment) => /fix round 3 of 4/.test(comment.body));
  assert.ok(warning, "warning reply posted on the PR");
  assert.match(warning.body, /declined in-thread/);
  const persisted = parseRoundLedger(first.calls.updated[0].body);
  assert.ok(persisted.fixRoundWarnedAt, "warn stamp persisted in the ledger");
  assert.equal(persisted.capIssueUrl, null, "no cap issue at round 3");

  const second = fakeGithub({
    existingComments: [{ id: 7, body: first.calls.updated[0].body }],
    threads: budgetThreads(2),
  });
  await runRoundGate({ github: second.github, context, core, env: {} });
  assert.ok(
    !second.calls.created.some((comment) => /fix round 3 of 4/.test(comment.body)),
    "the warning is one-shot across events",
  );
});

test("at the cap the ledger files ONE backlog issue of still-open non-critical threads", async () => {
  const threads = [
    budgetThread("t1"),
    budgetThread("t2", { critical: true }),
    budgetThread("t5", { critical: true, body: "Performance regression: latency doubles under load." }),
    budgetThread("t3", { resolved: true }),
    budgetThread("t4"),
  ];
  const seed = renderRoundLedger(
    openBudgetState({ round: 4, fixRounds: 4, fixRoundWarnedAt: "2026-07-18T12:10:00.000Z" }),
  );
  const first = fakeGithub({ existingComments: [{ id: 7, body: seed }], threads });
  await runRoundGate({ github: first.github, context, core, env: {} });

  assert.equal(first.calls.issuesCreated.length, 1, "exactly one backlog issue is filed");
  const issue = first.calls.issuesCreated[0];
  assert.match(issue.title, /review-round cap reached on PR #7/);
  assert.match(issue.body, /discussion_r_t1\b/);
  assert.match(issue.body, /discussion_r_t4\b/);
  assert.doesNotMatch(issue.body, /discussion_r_t5/, "perf-regression threads stay actionable, not backlogged");
  assert.doesNotMatch(issue.body, /discussion_r_t3/, "resolved threads are not listed");
  assert.ok(
    first.calls.labelsAdded.some((added) => added.labels.includes(CAP_LABEL)),
    "the PR is labeled review-round:cap",
  );
  const persisted = parseRoundLedger(first.calls.updated[0].body);
  assert.equal(persisted.capIssueUrl, "https://github.com/o/r/issues/555", "issue link persisted in the ledger");
  assert.match(first.calls.updated[0].body, /Cap backlog issue: https:\/\/github\.com\/o\/r\/issues\/555/);

  const second = fakeGithub({
    existingComments: [{ id: 7, body: first.calls.updated[0].body }],
    threads,
  });
  await runRoundGate({ github: second.github, context, core, env: {} });
  assert.equal(second.calls.issuesCreated.length, 0, "the cap issue is one-shot across events");
});

test("a cap with no still-open non-critical threads files nothing", async () => {
  const threads = [budgetThread("t1", { critical: true }), budgetThread("t2", { resolved: true })];
  const seed = renderRoundLedger(openBudgetState({ round: 4, fixRounds: 4 }));
  const { github, calls } = fakeGithub({ existingComments: [{ id: 7, body: seed }], threads });
  await runRoundGate({ github, context, core, env: {} });
  assert.equal(calls.issuesCreated.length, 0, "an empty decline backlog is not filed as an issue");
  // Regression (cursor, round 1): the empty-backlog path must still persist the
  // warn stamp written in the same run, or the one-shot warning re-posts forever.
  const persisted = parseRoundLedger(calls.updated[0].body);
  assert.equal(persisted.capIssueUrl, null);
  assert.ok(persisted.fixRoundWarnedAt, "the warn stamp survives the empty-backlog skip");
  const second = fakeGithub({ existingComments: [{ id: 7, body: calls.updated[0].body }], threads });
  await runRoundGate({ github: second.github, context, core, env: {} });
  assert.ok(
    !second.calls.created.some((comment) => /fix round 4 of 4/.test(comment.body)),
    "the warning does not re-post after the empty-backlog run",
  );
});

test("cap filing failures degrade to a log line and never fail the check", async () => {
  let failed = false;
  const spyCore = { notice() {}, info() {}, warning() {}, setFailed() { failed = true; } };
  const seed = renderRoundLedger(openBudgetState({ round: 4, fixRounds: 4 }));
  const { github, calls } = fakeGithub({
    existingComments: [{ id: 7, body: seed }],
    threads: budgetThreads(1),
    failCapIssue: true,
  });
  const result = await runRoundGate({ github, context, core: spyCore, env: {} });
  assert.ok(result, "the gate completes");
  assert.equal(failed, false, "a cap failure never fails the check");
  const persisted = parseRoundLedger(calls.updated[0].body);
  assert.equal(persisted.capIssueUrl, null, "no stamp without a filed issue (retries next event)");
  assert.ok(persisted.fixRoundWarnedAt, "the round-3 warning still fired on the way to the cap");
});
