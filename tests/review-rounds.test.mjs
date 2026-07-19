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
  hasCurrentBotActivity,
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
  botActivity: { id: "review-1", at: "2026-07-18T12:00:00.000Z" },
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
  const commits = fixture.commits.map(([headSha, now]) => ({ headSha, now, botActivity: null }));
  const reviewEvents = fixture.botActivityAt.map((now, index) => {
    const headSha = commits.findLast((commit) => Date.parse(commit.now) <= Date.parse(now))?.headSha;
    if (!headSha) throw new Error(`fixture bot activity precedes commits: ${now}`);
    return { headSha, now, botActivity: { id: `fixture-review-${index}`, at: now } };
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

test("force dispatch overrides an open thread set (escape hatch for a stuck round)", () => {
  const state = openRound();
  const result = decideRound({
    ...base,
    state,
    threads: base.threads,
    forceDispatch: true,
    now: "2026-07-18T12:00:01.000Z",
    botActivity: false,
  });
  assert.equal(result.action, "dispatch");
  assert.equal(result.reason, "force-label");
  assert.equal(result.state.status, "closed");
});

test("force dispatch overrides a thread-less round (not blocked by no-round-work)", () => {
  const state = openRound({ threads: [] });
  const result = decideRound({
    ...base,
    state,
    threads: [],
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
test("a clean round does not dispatch at max age", () => {
  const state = openRound({ threads: [] });
  const result = decideRound({
    ...base,
    state,
    threads: [],
    now: "2026-07-19T12:00:00.000Z",
    botActivity: false,
  });
  assert.equal(result.action, "wait");
  assert.equal(result.reason, "no-round-work");
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
    botActivity: { id: "review-2", at: "2026-07-18T12:11:00.000Z" },
  });

  assert.equal(next.action, "open");
  assert.equal(next.state.round, 2);
  assert.deepEqual(next.state.threadIds, ["thread-3"]);
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

test("repeated activity snapshot after dispatch does not reopen a round", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const dispatched = decideRound({
    ...base,
    state,
    threads: addressed,
    now: "2026-07-18T12:10:00.000Z",
    botActivity: null,
  }).state;

  const result = decideRound({
    ...base,
    state: dispatched,
    now: "2026-07-18T12:11:00.000Z",
    threads: addressed,
    botActivity: base.botActivity,
  });
  assert.equal(result.action, "wait");
  assert.equal(result.reason, "round-dispatched");
});

test("force-dispatch reopens and dispatches a closed round (absolute override)", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const dispatched = decideRound({
    ...base, state, threads: addressed, now: "2026-07-18T12:10:00.000Z", botActivity: null,
  }).state;
  assert.equal(dispatched.status, "closed");
  const result = decideRound({
    ...base, state: dispatched, threads: addressed, forceDispatch: true,
    now: "2026-07-18T12:12:00.000Z", botActivity: false,
  });
  assert.equal(result.action, "dispatch");
  assert.equal(result.reason, "force-label");
  assert.equal(result.state.round, dispatched.round + 1);
});

test("a new push after dispatch updates the ledger head instead of pinning it", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const dispatched = decideRound({
    ...base, state, threads: addressed, now: "2026-07-18T12:10:00.000Z", botActivity: null,
  }).state;
  const result = decideRound({
    ...base, state: dispatched, headSha: "head-2", threads: addressed,
    now: "2026-07-18T12:12:00.000Z", botActivity: false,
  });
  assert.equal(result.action, "wait");
  assert.equal(result.reason, "round-dispatched");
  assert.equal(result.state.headSha, "head-2");
  assert.equal(result.state.pushes, dispatched.pushes + 1);
});

test("new bot activity after dispatch opens the next round", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const dispatched = decideRound({
    ...base,
    state,
    threads: addressed,
    now: "2026-07-18T12:10:00.000Z",
    botActivity: null,
  }).state;

  const result = decideRound({
    ...base,
    state: dispatched,
    now: "2026-07-18T12:11:00.000Z",
    threads: addressed,
    botActivity: { id: "review-2", at: "2026-07-18T12:11:00.000Z" },
  });
  assert.equal(result.action, "open");
  assert.equal(result.state.round, 2);
});

test("threads added during an open round join the same round", () => {
  const state = openRound();
  const threads = [...base.threads, {
    id: "thread-3",
    isResolved: false,
    comments: [{ author: { login: "cursor" } }],
  }];
  const result = decideRound({
    ...base,
    state,
    threads,
    now: "2026-07-18T12:01:00.000Z",
    botActivity: null,
  });
  assert.equal(result.action, "wait");
  assert.deepEqual(result.state.threadIds, ["thread-1", "thread-2", "thread-3"]);
});

test("missing head time does not make dated activity current", () => {
  assert.equal(hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "head-2",
    headCommittedAt: undefined,
    reviews: [{
      id: "review-old",
      author: { login: "cursor" },
      submitted_at: "2026-07-18T12:00:00.000Z",
    }],
  }), null);
});
test("stale explicit commit ids do not pass the timestamp fallback", () => {
  assert.equal(hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "head-2",
    headCommittedAt: "2026-07-18T12:00:00.000Z",
    reviews: [{
      id: "review-old-head",
      author: { login: "cursor" },
      commit_id: "head-1",
      submitted_at: "2026-07-18T12:01:00.000Z",
    }],
  }), null);
});


test("ledger parser rejects malformed persisted state", () => {
  const state = openRound();
  assert.equal(parseRoundLedger(renderRoundLedger({ ...state, status: "unknown" })), null);
  assert.equal(parseRoundLedger(renderRoundLedger({ ...state, threadIds: ["thread-1", "thread-1"] })), null);
  assert.equal(parseRoundLedger(renderRoundLedger({ ...state, lastHeadChangedAt: "not-a-date" })), null);
});

test("an activity id from before dispatch does not reopen a round", () => {
  const state = openRound();
  const addressed = base.threads.map((thread) => ({ ...thread, isResolved: true }));
  const dispatched = decideRound({
    ...base,
    state,
    threads: addressed,
    now: "2026-07-18T12:10:00.000Z",
    botActivity: null,
  }).state;

  const result = decideRound({
    ...base,
    state: dispatched,
    now: "2026-07-18T12:11:00.000Z",
    threads: addressed,
    botActivity: { id: "review-2", at: "2026-07-18T12:09:00.000Z" },
  });
  assert.equal(result.action, "wait");
  assert.equal(result.reason, "round-dispatched");
});

test("a human-created unresolved thread remains open until a bot finding gets a reply", () => {
  const state = openRound({
    threads: [{
      id: "human-thread",
      isResolved: false,
      comments: [{ author: { login: "maintainer" } }],
    }],
  });
  assert.deepEqual(getGuardUnresolvedThreads(state, [{
    id: "human-thread",
    isResolved: false,
    comments: [{ author: { login: "maintainer" } }],
  }], botAliases).map((thread) => thread.id), ["human-thread"]);

  const addressed = [{
    id: "human-thread",
    isResolved: false,
    comments: [
      { author: { login: "cursor" } },
      { author: { login: "maintainer" } },
    ],
  }];
  assert.deepEqual(getGuardUnresolvedThreads(state, addressed, botAliases), []);
});

test("empty bot aliases fail closed for unresolved bot-only threads", () => {
  const state = openRound();
  assert.deepEqual(getGuardUnresolvedThreads(state, base.threads, []), base.threads);
});

test("numeric activity ids produce distinct markers", () => {
  const marker = hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "head-1",
    headCommittedAt: "2026-07-18T11:00:00.000Z",
    reviews: [{
      id: 12345,
      author: { login: "cursor" },
      submitted_at: "2026-07-18T12:00:00.000Z",
    }],
  });
  assert.deepEqual(marker, { id: "review:12345", at: "2026-07-18T12:00:00.000Z" });
});

test("a clean bot round waits instead of redispatching", () => {
  const state = openRound({ threads: [] });
  const result = decideRound({
    ...base,
    state,
    threads: [],
    now: "2026-07-18T12:10:00.000Z",
    botActivity: null,
  });
  assert.equal(result.action, "wait");
  assert.equal(result.reason, "no-round-work");
});

test("a bot response that names an older SHA is not current", () => {
  assert.equal(hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "abcdef1234567890",
    headCommittedAt: "2026-07-18T12:00:00.000Z",
    reviews: [{
      id: "review-old-sha",
      author: { login: "cursor" },
      body: "Reviewed commit 1234567. Looks good.",
      submitted_at: "2026-07-18T12:10:00.000Z",
    }],
  }), null);
});

test("a markdown-wrapped older SHA pin is not current-head activity", () => {
  assert.equal(hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "abcdef1234567890",
    headCommittedAt: "2026-07-18T12:00:00.000Z",
    reviews: [{
      id: "review-md-sha",
      author: { login: "cursor" },
      body: "### Codex Review\n\n**Reviewed commit:** `1234567`\n",
      submitted_at: "2026-07-18T12:10:00.000Z",
    }],
  }), null);
});

test("an edited bot comment is current via updated_at even when created_at is stale", () => {
  const marker = hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "head-9",
    headCommittedAt: "2026-07-18T12:00:00.000Z",
    issueComments: [{
      id: "comment-edited",
      user: { login: "cursor" },
      created_at: "2026-07-18T09:00:00.000Z",
      updated_at: "2026-07-18T12:30:00.000Z",
    }],
  });
  assert.deepEqual(marker, { id: "issue-comment:comment-edited", at: "2026-07-18T12:30:00.000Z" });
});

test("a completed success check run counts as current bot activity", () => {
  const marker = hasCurrentBotActivity({
    aliases: ["cursor"],
    headSha: "head-1",
    checkRuns: [{
      id: 77,
      app: { slug: "cursor" },
      head_sha: "head-1",
      status: "completed",
      conclusion: "success",
      completed_at: "2026-07-18T12:00:00.000Z",
    }],
  });
  assert.deepEqual(marker, { id: "check-run:77", at: "2026-07-18T12:00:00.000Z" });
});

test("queued or non-positive check runs are not treated as bot activity", () => {
  for (const partial of [
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "startup_failure" },
    { status: "queued", conclusion: null },
  ]) {
    assert.equal(
      hasCurrentBotActivity({
        aliases: ["cursor"],
        headSha: "head-1",
        checkRuns: [{ id: 5, app: { slug: "cursor" }, head_sha: "head-1", ...partial }],
      }),
      null,
      `expected ${partial.status}/${partial.conclusion} to be ignored`,
    );
  }
});
