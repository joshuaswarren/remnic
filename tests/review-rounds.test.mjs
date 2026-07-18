import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fixturePath = (name) => fileURLToPath(new URL(`./fixtures/review-rounds/${name}`, import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(fixturePath(name), "utf8"));
import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUND_COMMENT_MARKER,
  decideRound,
  getGuardUnresolvedThreads,
  parseRoundLedger,
  renderRoundLedger,
  upsertRoundLedgerComment,
} from "../scripts/review-rounds.mjs";

const botAliases = ["cursor", "cursor-bugbot", "cursor[bot]", "cursor-bugbot[bot]"];
const base = {
  headSha: "head-1",
  now: "2026-07-18T12:00:00.000Z",
  threads: [
    { id: "thread-1", isResolved: false, comments: [{ author: { login: "cursor" } }] },
    { id: "thread-2", isResolved: false, comments: [{ author: { login: "cursor" } }] },
  ],
  botAliases,
  botActivity: true,
  debounceMs: 600_000,
  maxAgeMs: 86_400_000,
};

function openRound(overrides = {}) {
  return decideRound({ ...base, ...overrides }).state;
}

function replayFixture(fixture) {
  const openThreads = Array.from({ length: fixture.initialThreadCount }, (_, index) => ({
    id: `thread-${index + 1}`,
    isResolved: false,
    comments: [{ author: { login: "cursor[bot]" } }],
  }));
  const resolvedThreads = openThreads.map((thread) => ({ ...thread, isResolved: true }));
  const commits = fixture.commits.map(([headSha, now]) => ({ headSha, now, botActivity: false }));
  const reviewEvents = fixture.botActivityAt.map((now) => {
    const headSha = commits.findLast((commit) => Date.parse(commit.now) <= Date.parse(now))?.headSha;
    if (!headSha) throw new Error(`fixture bot activity precedes commits: ${now}`);
    return { headSha, now, botActivity: true };
  });
  const events = [...commits, ...reviewEvents].sort((left, right) => Date.parse(left.now) - Date.parse(right.now));
  let state = null;
  let dispatches = 0;

  for (const { headSha, now, botActivity } of events) {
    const result = decideRound({
      state,
      headSha,
      now,
      threads: openThreads,
      botAliases,
      botActivity,
      debounceMs: 600_000,
      maxAgeMs: 86_400_000,
    });
    state = result.state;
    if (result.action === "dispatch") dispatches += 1;
  }

  const settled = decideRound({
    state,
    headSha: fixture.commits.at(-1)[0],
    now: fixture.settledAt,
    threads: resolvedThreads,
    botAliases,
    debounceMs: 600_000,
    maxAgeMs: 86_400_000,
  });
  if (settled.action === "dispatch") dispatches += 1;
  return { dispatches, action: settled.action, state: settled.state };
}

test("opens a round from the first current-head bot activity and snapshots open threads", () => {
  const result = decideRound(base);

  assert.equal(result.action, "open");
  assert.deepEqual(result.state.threadIds, ["thread-1", "thread-2"]);
  assert.equal(result.state.round, 1);
  assert.equal(result.state.headSha, "head-1");
  assert.equal(result.state.pushes, 0);
});

test("a push during an open round increments telemetry but cannot dispatch", () => {
  const state = openRound();
  const result = decideRound({
    ...base,
    state,
    headSha: "head-2",
    now: "2026-07-18T12:01:00.000Z",
    botActivity: false,
  });

  assert.equal(result.action, "wait");
  assert.equal(result.state.pushes, 1);
  assert.equal(result.state.headSha, "head-2");
  assert.equal(result.state.lastHeadChangedAt, "2026-07-18T12:01:00.000Z");
});

test("resolving every round thread dispatches only after the head debounce", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const beforeDebounce = decideRound({
    ...base,
    state,
    threads: addressed,
    now: "2026-07-18T12:09:59.000Z",
    botActivity: false,
  });
  assert.equal(beforeDebounce.action, "wait");

  const afterDebounce = decideRound({
    ...base,
    state: beforeDebounce.state,
    threads: addressed,
    now: "2026-07-18T12:10:00.000Z",
    botActivity: false,
  });
  assert.equal(afterDebounce.action, "dispatch");
  assert.equal(afterDebounce.reason, "round-complete");
  assert.equal(afterDebounce.state.dispatchIssuedAt, "2026-07-18T12:10:00.000Z");
});

test("force dispatch bypasses debounce and records the explicit reason", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const result = decideRound({
    ...base,
    state,
    threads: addressed,
    forceDispatch: true,
    now: "2026-07-18T12:00:01.000Z",
    botActivity: false,
  });


  assert.equal(result.action, "dispatch");
  assert.equal(result.reason, "force-label");
});

test("replays the recorded high-churn PR 1852 timeline without dispatch churn", () => {
  const fixture = loadFixture("pr-1852.json");
  const replay = replayFixture(fixture);

  assert.equal(fixture.commits.length, fixture.reportedCommits);
  assert.ok(Array.isArray(fixture.botActivityHeads) && fixture.botActivityHeads.length > 0);
  assert.ok(replay.dispatches >= 1, "expected the round to converge");
  assert.ok(replay.dispatches <= 3, `expected at most 3 dispatches, got ${replay.dispatches}`);
});

test("replays the recorded high-churn PR 1923 timeline without dispatch churn", () => {
  const fixture = loadFixture("pr-1923.json");
  const replay = replayFixture(fixture);

  assert.equal(fixture.commits.length, fixture.reportedCommits);
  assert.ok(Array.isArray(fixture.botActivityHeads) && fixture.botActivityHeads.length > 0);
  assert.ok(replay.dispatches >= 1, "expected the round to converge");
  assert.ok(replay.dispatches <= 3, `expected at most 3 dispatches, got ${replay.dispatches}`);
});

test("max-age closes and dispatches an abandoned round with an auditable marker", () => {
  const state = openRound();
  const result = decideRound({
    ...base,
    state,
    now: "2026-07-19T12:00:00.000Z",
    botActivity: false,
  });
  assert.equal(result.action, "dispatch");
  assert.equal(result.reason, "max-age");
  assert.equal(result.state.closeReason, "max-age");
  assert.equal(result.state.autoClosed, true);
  assert.equal(result.state.dispatchIssuedAt, "2026-07-19T12:00:00.000Z");
});

test("a bot response after dispatch opens the next round", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const dispatched = decideRound({
    ...base,
    state,
    threads: addressed,
    now: "2026-07-18T12:10:00.000Z",
    botActivity: false,
  }).state;

  const next = decideRound({
    ...base,
    state: dispatched,
    now: "2026-07-18T12:11:00.000Z",
    threads: [{ id: "thread-3", isResolved: false, comments: [{ author: { login: "cursor" } }] }],
    botActivity: true,
  });

  assert.equal(next.action, "open");
  assert.equal(next.state.round, 2);
  assert.deepEqual(next.state.threadIds, ["thread-3"]);
});

test("a non-bot reply addresses a round thread without changing resolution semantics", () => {
  const state = openRound();
  const threads = [
    { id: "thread-1", isResolved: false, comments: [{ author: { login: "maintainer" } }] },
    { id: "thread-2", isResolved: false, comments: [{ author: { login: "cursor" } }] },
  ];

  assert.deepEqual(getGuardUnresolvedThreads(state, threads, botAliases), [threads[1]]);
});

test("ledger comments round-trip and replace only the owned marker", () => {
  const state = openRound();
  const body = `Before
${renderRoundLedger(state)}
After`;
  const parsed = parseRoundLedger(body);
  assert.deepEqual(parsed, state);

  const updated = { ...state, pushes: 3 };
  const replaced = upsertRoundLedgerComment(body, updated);
  assert.match(replaced, /Before/);
  assert.match(replaced, /After/);
  assert.equal(parseRoundLedger(replaced).pushes, 3);
  assert.equal(replaced.matchAll(new RegExp(ROUND_COMMENT_MARKER, "g")).toArray().length, 1);
});
