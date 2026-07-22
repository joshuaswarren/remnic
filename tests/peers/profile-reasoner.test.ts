/**
 * Async peer profile reasoner — issue #679 PR 2/5.
 *
 * Covers:
 *   - reasoner reads log + writes profile with provenance
 *   - disabled flag is a true no-op
 *   - min-interactions guard skips peers below threshold
 *   - max-fields cap respected across peers
 *   - parser tolerates fenced code block / malformed payloads
 *   - existing peer storage tests still pass (separate file —
 *     `packages/remnic-core/src/peers/peers.test.ts` continues to run
 *     under the same `tsx --test` glob).
 *
 * All fixtures are synthetic. The repository is public; no real names,
 * sessions, or interactions appear here.
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir as managedTempDir } from "../helpers/tmp-dir.mjs";

import {
  appendInteractionLog,
  buildPeerProfileReasonerPrompt,
  parsePeerProfileReasonerResponse,
  readPeerProfile,
  runPeerProfileReasoner,
  writePeer,
  writePeerProfile,
  type Peer,
  type PeerProfile,
  type PeerProfileReasonerLlm,
} from "../../packages/remnic-core/src/peers/index.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures + helpers
// ──────────────────────────────────────────────────────────────────────

const makeTempDir = (): Promise<string> => managedTempDir("peer-reasoner-test-");

function syntheticPeer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: "synthetic.alpha",
    kind: "agent",
    displayName: "Synthetic Alpha",
    createdAt: "2026-04-25T00:00:00.000Z",
    updatedAt: "2026-04-25T00:00:00.000Z",
    ...overrides,
  };
}

/** Mock LLM that returns a fixed JSON payload.
 *
 * Cursor M review on PR #736: the previous shape returned a wrapper
 * with a `calls` getter, but tests destructured `{ llm } = fakeLlm()`
 * and later read `llm.calls` — which was `undefined`, not zero. The
 * `?? 0` in the assertion made the check vacuous (it would have
 * passed even if the LLM had been called). Return both `llm` and a
 * `state` object that the caller can read directly (no getter, no
 * destructuring loss); each test checks `state.calls` against the
 * expected value.
 */
function fakeLlm(payload: string): {
  llm: PeerProfileReasonerLlm;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const llm: PeerProfileReasonerLlm = {
    async chatCompletion() {
      state.calls += 1;
      return { content: payload };
    },
  };
  return { llm, state };
}

/** Append N synthetic interaction-log entries spanning T+0..T+N-1 minutes. */
async function seedLog(
  memoryDir: string,
  peerId: string,
  count: number,
  prefix = "synthetic-interaction",
): Promise<void> {
  const base = Date.UTC(2026, 3, 25, 12, 0, 0);
  for (let i = 0; i < count; i += 1) {
    await appendInteractionLog(memoryDir, peerId, {
      timestamp: new Date(base + i * 60_000).toISOString(),
      kind: "message",
      sessionId: `synthetic-session-${i}`,
      summary: `${prefix} ${i}`,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// 1. Happy path — log → LLM → profile with provenance
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner reads log and writes profile with provenance", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.writer", kind: "agent" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 6);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        {
          field: "communication_style",
          value: "concise, prefers structured replies",
          signal: "explicit_preference",
          note: "derived from synthetic recurrence",
          sourceSessionId: "synthetic-session-2",
        },
      ],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 3,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  assert.equal(result.peersConsidered, 1);
  assert.equal(result.peersProcessed, 1);
  assert.equal(result.fieldsApplied, 1);
  assert.equal(result.perPeer[0].status, "processed");
  assert.deepEqual(result.perPeer[0].fields, ["communication_style"]);

  const profile = await readPeerProfile(dir, peer.id);
  assert.ok(profile, "profile should be written");
  assert.equal(profile.peerId, peer.id);
  assert.equal(profile.fields.communication_style, "concise, prefers structured replies");
  assert.equal(profile.updatedAt, "2026-04-26T00:00:00.000Z");
  const prov = profile.provenance.communication_style;
  assert.ok(prov && prov.length === 1);
  assert.equal(prov[0].observedAt, "2026-04-26T00:00:00.000Z");
  assert.equal(prov[0].signal, "explicit_preference");
  assert.equal(prov[0].sourceSessionId, "synthetic-session-2");
  assert.equal(prov[0].note, "derived from synthetic recurrence");
});

test("runPeerProfileReasoner appends to existing provenance instead of replacing", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.beta" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const existing: PeerProfile = {
    peerId: peer.id,
    updatedAt: "2026-04-25T12:00:00.000Z",
    fields: { communication_style: "old value" },
    provenance: {
      communication_style: [
        {
          observedAt: "2026-04-25T12:00:00.000Z",
          signal: "manual_seed",
        },
      ],
    },
  };
  await writePeerProfile(dir, existing);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        {
          field: "communication_style",
          value: "new value",
          signal: "explicit_preference",
        },
      ],
    }),
  );

  await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  const profile = await readPeerProfile(dir, peer.id);
  assert.ok(profile);
  assert.equal(profile.fields.communication_style, "new value");
  // Existing provenance preserved + new entry appended.
  assert.equal(profile.provenance.communication_style.length, 2);
  assert.equal(profile.provenance.communication_style[0].signal, "manual_seed");
  assert.equal(profile.provenance.communication_style[1].signal, "explicit_preference");
});

// ──────────────────────────────────────────────────────────────────────
// 2. Disabled flag — true no-op
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner is a no-op when enabled=false", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.disabled" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 10);

  const { llm, state } = fakeLlm("{}");

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: false,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.peersConsidered, 0);
  assert.equal(result.peersProcessed, 0);
  assert.equal(result.fieldsApplied, 0);
  // Cursor M #736: read `state.calls` directly so the assertion
  // actually exercises the LLM invocation count (the previous
  // `(llm as { calls }).calls ?? 0` was vacuous because destructuring
  // dropped the getter). The reasoner must NOT have called the LLM
  // when `enabled: false`.
  assert.equal(state.calls, 0);

  // No profile written.
  const profile = await readPeerProfile(dir, peer.id);
  assert.equal(profile, null);
});

test("runPeerProfileReasoner stays a no-op when enabled is a truthy non-boolean string", async () => {
  // Defensive — Gotcha #36: `"false"` is truthy in JS. The reasoner
  // requires strict `=== true`. Pass any non-boolean value and verify
  // it's still treated as disabled.
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.gamma" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const { llm, state } = fakeLlm(
    JSON.stringify({
      proposals: [
        { field: "should_not_apply", value: "x", signal: "x" },
      ],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    // @ts-expect-error — intentionally invalid to exercise the strict check
    enabled: "true",
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.peersConsidered, 0);
  assert.equal(result.fieldsApplied, 0);
  // The strict-true gate must NOT have invoked the LLM.
  assert.equal(state.calls, 0);
  const profile = await readPeerProfile(dir, peer.id);
  assert.equal(profile, null);
});

// ──────────────────────────────────────────────────────────────────────
// 3. Min-interactions guard
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner skips peers below the min-interactions threshold", async () => {
  const dir = await makeTempDir();
  const lowVolume = syntheticPeer({ id: "synthetic.low" });
  const highVolume = syntheticPeer({ id: "synthetic.high" });
  await writePeer(dir, lowVolume);
  await writePeer(dir, highVolume);
  await seedLog(dir, lowVolume.id, 2);
  await seedLog(dir, highVolume.id, 8);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [
        {
          field: "tool_patterns",
          value: "frequent search usage",
          signal: "tool_recurrence",
        },
      ],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 5,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  // Both peers considered; only the high-volume one was processed.
  assert.equal(result.peersConsidered, 2);
  assert.equal(result.peersProcessed, 1);
  const lowResult = result.perPeer.find((r) => r.peerId === lowVolume.id);
  const highResult = result.perPeer.find((r) => r.peerId === highVolume.id);
  assert.equal(lowResult?.status, "skipped_below_min_interactions");
  assert.equal(highResult?.status, "processed");
  assert.equal(highResult?.fieldsApplied, 1);

  // Low-volume peer's profile was NOT written.
  assert.equal(await readPeerProfile(dir, lowVolume.id), null);
  // High-volume peer's profile WAS written.
  assert.notEqual(await readPeerProfile(dir, highVolume.id), null);
});

test("runPeerProfileReasoner skips peers with no interaction log", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.empty" });
  await writePeer(dir, peer);

  const { llm } = fakeLlm("{}");

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 0,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.peersConsidered, 1);
  assert.equal(result.peersProcessed, 0);
  assert.equal(result.perPeer[0].status, "skipped_no_log");
});

// ──────────────────────────────────────────────────────────────────────
// 4. Max-fields cap
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner respects maxFieldsPerRun across peers", async () => {
  const dir = await makeTempDir();
  const a = syntheticPeer({ id: "synthetic.aaa" });
  const b = syntheticPeer({ id: "synthetic.bbb" });
  await writePeer(dir, a);
  await writePeer(dir, b);
  await seedLog(dir, a.id, 5);
  await seedLog(dir, b.id, 5);

  // Each peer gets a fake LLM proposing TWO fields. With cap=2 total,
  // peer A should consume the budget and peer B should be skipped or
  // have its proposals dropped.
  const proposalsPayload = JSON.stringify({
    proposals: [
      { field: "field_one", value: "v1", signal: "signal_one" },
      { field: "field_two", value: "v2", signal: "signal_two" },
    ],
  });
  const { llm } = fakeLlm(proposalsPayload);

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 2,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  assert.equal(result.peersConsidered, 2);
  assert.equal(result.fieldsApplied, 2);
  // Listing order for peers is alphabetical (listPeers sorts), so 'a'
  // is processed first.
  const aResult = result.perPeer.find((r) => r.peerId === a.id);
  const bResult = result.perPeer.find((r) => r.peerId === b.id);
  assert.equal(aResult?.fieldsApplied, 2);
  assert.equal(bResult?.fieldsApplied, 0);
  assert.equal(bResult?.status, "skipped_cap_reached");
});

test("runPeerProfileReasoner with maxFieldsPerRun=0 is a no-op", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.cap0" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [{ field: "any_field", value: "v", signal: "s" }],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 0,
  });

  assert.equal(result.fieldsApplied, 0);
  assert.equal(await readPeerProfile(dir, peer.id), null);
});

// ──────────────────────────────────────────────────────────────────────
// 5. Parser robustness
// ──────────────────────────────────────────────────────────────────────

test("parsePeerProfileReasonerResponse handles fenced code blocks", () => {
  const parsed = parsePeerProfileReasonerResponse(
    '```json\n{"proposals":[{"field":"k","value":"v","signal":"s"}]}\n```',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].field, "k");
});

test("parsePeerProfileReasonerResponse rejects malformed JSON", () => {
  assert.deepEqual(parsePeerProfileReasonerResponse(""), []);
  assert.deepEqual(parsePeerProfileReasonerResponse("not-json"), []);
  assert.deepEqual(parsePeerProfileReasonerResponse("null"), []);
  assert.deepEqual(parsePeerProfileReasonerResponse("[1,2,3]"), []);
});

test("parsePeerProfileReasonerResponse drops proposals missing required fields", () => {
  const raw = JSON.stringify({
    proposals: [
      { field: "", value: "v", signal: "s" }, // empty field
      { field: "k", value: "", signal: "s" }, // empty value
      { field: "k", value: "v", signal: "" }, // empty signal
      { field: "__proto__", value: "v", signal: "s" }, // prototype-pollution
      { field: "k", value: "v", signal: "s" }, // valid
    ],
  });
  const parsed = parsePeerProfileReasonerResponse(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].field, "k");
});

test("parsePeerProfileReasonerResponse rejects non-object root", () => {
  assert.deepEqual(parsePeerProfileReasonerResponse("42"), []);
  assert.deepEqual(parsePeerProfileReasonerResponse('"a string"'), []);
});

test("buildPeerProfileReasonerPrompt produces a deterministic, schema-prescriptive prompt", () => {
  const prompt = buildPeerProfileReasonerPrompt({
    peer: syntheticPeer({ id: "synthetic.prompt" }),
    existingProfile: null,
    log: [
      {
        timestamp: "2026-04-25T12:00:00.000Z",
        kind: "message",
        sessionId: "synthetic-session-7",
        summary: "synthetic interaction body",
      },
    ],
    maxFields: 3,
  });
  assert.match(prompt, /synthetic\.prompt/);
  assert.match(prompt, /Output a single JSON object/);
  assert.match(prompt, /synthetic-session-7/);
  assert.match(prompt, /maxFields|0\.\.3|0..3/);
});

// ──────────────────────────────────────────────────────────────────────
// 6. LLM unavailable / abort
// ──────────────────────────────────────────────────────────────────────

test("runPeerProfileReasoner records skipped_llm_unavailable on null response", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.nullresp" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const llm: PeerProfileReasonerLlm = {
    async chatCompletion() {
      return null;
    },
  };

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
  });

  assert.equal(result.fieldsApplied, 0);
  assert.equal(result.perPeer[0].status, "skipped_llm_unavailable");
});

test("runPeerProfileReasoner records skipped_aborted when signal is aborted", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.aborted" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const controller = new AbortController();
  controller.abort();

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [{ field: "k", value: "v", signal: "s" }],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    signal: controller.signal,
  });

  assert.equal(result.fieldsApplied, 0);
  assert.equal(result.perPeer[0].status, "skipped_aborted");
});

// ──────────────────────────────────────────────────────────────────────
// 7. Run-marker effect on subsequent runs
// ──────────────────────────────────────────────────────────────────────

test("min-interactions threshold uses the FULL log, not the truncated slice (codex P2 #736)", async () => {
  // Reproduces the bug codex flagged: when
  // `peerProfileReasonerMinInteractions` exceeds `maxLogEntriesPerPeer`,
  // a peer with plenty of new activity could be permanently skipped
  // because the threshold check ran against the capped slice.
  //
  // Fix: read the full log for the gate, then truncate only for the
  // prompt window.
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.bigfeed" });
  await writePeer(dir, peer);
  // Seed 30 interactions; configure the prompt window to 5 and the
  // threshold to 10. Pre-fix this would skip; post-fix it processes.
  await seedLog(dir, peer.id, 30);

  const { llm } = fakeLlm(
    JSON.stringify({
      proposals: [{ field: "k", value: "v", signal: "s" }],
    }),
  );

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 10,
    maxFieldsPerRun: 4,
    maxLogEntriesPerPeer: 5,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  assert.equal(result.peersProcessed, 1);
  assert.equal(result.fieldsApplied, 1);
  assert.equal(result.perPeer[0].status, "processed");
});

test("run-wide cap is NOT consumed when writePeerProfile throws (codex P1 #736)", async () => {
  // Reproduces the bug codex flagged: the per-run `fieldsAppliedTotal`
  // counter was incremented BEFORE the profile write, so a transient
  // I/O failure would leave the cap inflated and starve subsequent
  // peers of their fair share of the budget.
  //
  // Fix: increment the global counter only after the write succeeds.
  // Simulate the failure by replacing peer A's profile.md path with
  // a directory so writePeerProfile's open(O_TRUNC) fails.
  const dir = await makeTempDir();
  const peerA = syntheticPeer({ id: "synthetic.afail" });
  const peerB = syntheticPeer({ id: "synthetic.bsucceed" });
  await writePeer(dir, peerA);
  await writePeer(dir, peerB);
  await seedLog(dir, peerA.id, 5);
  await seedLog(dir, peerB.id, 5);

  // Sabotage peer A's profile.md by creating a directory at the
  // file path so the open(O_TRUNC|O_WRONLY) fails.
  await fs.mkdir(path.join(dir, "peers", peerA.id, "profile.md"));

  const payload = JSON.stringify({
    proposals: [
      { field: "field_one", value: "v1", signal: "s1" },
      { field: "field_two", value: "v2", signal: "s2" },
    ],
  });
  const { llm } = fakeLlm(payload);

  const result = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 2,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: false,
  });

  // Peer A's write throws — recorded as error, NO budget consumed.
  const aResult = result.perPeer.find((r) => r.peerId === peerA.id);
  assert.equal(aResult?.status, "error");
  assert.equal(aResult?.fieldsApplied, 0);

  // Peer B should now succeed and consume the full budget — pre-fix
  // it would have been starved with skipped_cap_reached.
  const bResult = result.perPeer.find((r) => r.peerId === peerB.id);
  assert.equal(bResult?.status, "processed");
  assert.equal(bResult?.fieldsApplied, 2);

  // Run total reflects only successful writes.
  assert.equal(result.fieldsApplied, 2);
});

test("run-marker counts interactions since previous reasoner run", async () => {
  const dir = await makeTempDir();
  const peer = syntheticPeer({ id: "synthetic.marker" });
  await writePeer(dir, peer);
  await seedLog(dir, peer.id, 5);

  const payload = JSON.stringify({
    proposals: [{ field: "k", value: "v", signal: "s" }],
  });
  const { llm } = fakeLlm(payload);

  // First run — applies field, writes a run marker into the log.
  const first = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T00:00:00.000Z"),
    appendRunMarkerToLog: true,
  });
  assert.equal(first.fieldsApplied, 1);

  // Second run with NO new interactions — should skip due to threshold,
  // because the run marker now represents "0 new interactions since last run".
  const second = await runPeerProfileReasoner({
    memoryDir: dir,
    enabled: true,
    llm,
    minInteractions: 1,
    maxFieldsPerRun: 4,
    now: new Date("2026-04-26T01:00:00.000Z"),
    appendRunMarkerToLog: true,
  });
  assert.equal(second.peersProcessed, 0);
  assert.equal(
    second.perPeer[0].status,
    "skipped_below_min_interactions",
  );
});

// ──────────────────────────────────────────────────────────────────────
// 8. Cursor #736: log parser must not confuse a `session=`-prefixed
//    summary with the optional session metadata token.
// ──────────────────────────────────────────────────────────────────────

test("interaction-log parser does NOT misread summaries that start with `session=` (cursor #736)", async () => {
  // Reproduces the cursor finding: writing an entry with no
  // sessionId but a SUMMARY that literally begins `session=foo bar`
  // round-tripped to `{sessionId: "foo", summary: "bar"}` — silently
  // misclaiming a session id and mangling the summary.
  //
  // Fix: writer wraps the optional session token in square brackets
  // (`[session=<id>]`); reader prefers the bracketed form. A summary
  // that genuinely starts with `session=` is preserved verbatim.
  const dir = await makeTempDir();
  const peerId = "synthetic.parser";
  await writePeer(dir, syntheticPeer({ id: peerId }));

  // Entry 1: no sessionId, summary begins with literal `session=`.
  // Pre-fix this would have been mis-parsed.
  await appendInteractionLog(dir, peerId, {
    timestamp: "2026-04-26T00:00:00.000Z",
    kind: "note",
    summary: "session=spoofed-value bar baz",
  });
  // Entry 2: explicit sessionId, normal summary. Confirms the
  // bracketed metadata form still round-trips.
  await appendInteractionLog(dir, peerId, {
    timestamp: "2026-04-26T00:01:00.000Z",
    kind: "note",
    sessionId: "real-session-id",
    summary: "hello world",
  });

  // Read via the public surface.
  const { readPeerInteractionLog } = await import(
    "../../packages/remnic-core/src/peers/index.js"
  );
  const entries = await readPeerInteractionLog(dir, peerId);

  assert.equal(entries.length, 2);
  // Entry 1 — sessionId must be undefined; summary must be intact.
  assert.equal(entries[0].sessionId, undefined);
  assert.equal(entries[0].summary, "session=spoofed-value bar baz");
  // Entry 2 — bracketed metadata round-trips.
  assert.equal(entries[1].sessionId, "real-session-id");
  assert.equal(entries[1].summary, "hello world");
});

// ──────────────────────────────────────────────────────────────────────
// 9. Cursor #736: config coercion + shared default model.
// ──────────────────────────────────────────────────────────────────────

test("parseConfig coerces string CLI numerics for peer-profile reasoner (cursor L #736)", async () => {
  const { parseConfig } = await import(
    "../../packages/remnic-core/src/config.js"
  );
  // Mimic CLI input: `--config peerProfileReasonerMinInteractions=10`
  // arrives as the string "10" per Gotcha #28.
  const cfg = parseConfig({
    peerProfileReasonerMinInteractions: "10",
    peerProfileReasonerMaxFieldsPerRun: "3",
  });
  assert.equal(cfg.peerProfileReasonerMinInteractions, 10);
  assert.equal(cfg.peerProfileReasonerMaxFieldsPerRun, 3);
});

test("parseConfig accepts 0 as a valid disable value for peer-profile numerics (cursor L #736)", async () => {
  const { parseConfig } = await import(
    "../../packages/remnic-core/src/config.js"
  );
  const cfg = parseConfig({
    peerProfileReasonerMinInteractions: 0,
    peerProfileReasonerMaxFieldsPerRun: "0",
  });
  assert.equal(cfg.peerProfileReasonerMinInteractions, 0);
  assert.equal(cfg.peerProfileReasonerMaxFieldsPerRun, 0);
});

test("parseConfig throws on invalid peer-profile numeric input (cursor L #736 + gotcha #51)", async () => {
  const { parseConfig } = await import(
    "../../packages/remnic-core/src/config.js"
  );
  assert.throws(
    () =>
      parseConfig({
        peerProfileReasonerMinInteractions: "not-a-number",
      }),
    /peerProfileReasonerMinInteractions/,
  );
  assert.throws(
    () =>
      parseConfig({
        peerProfileReasonerMaxFieldsPerRun: -3,
      }),
    /peerProfileReasonerMaxFieldsPerRun/,
  );
});

test("peerProfileReasonerModel default is `auto` (cursor M #736 — shared with semantic-consolidation)", async () => {
  const { parseConfig } = await import(
    "../../packages/remnic-core/src/config.js"
  );
  const cfg = parseConfig({});
  assert.equal(cfg.peerProfileReasonerModel, "auto");
  // Sibling check — both reasoner-style models default to the same
  // routing alias rather than a hardcoded model id.
  assert.equal(cfg.semanticConsolidationModel, "auto");
});

test("DEFAULT_REASONING_MODEL is exported and used as the extraction model fallback (cursor M #736)", async () => {
  const config = await import(
    "../../packages/remnic-core/src/config.js"
  );
  // The shared constant exists and is re-exportable.
  assert.equal(typeof config.DEFAULT_REASONING_MODEL, "string");
  assert.ok(
    (config.DEFAULT_REASONING_MODEL as string).length > 0,
    "DEFAULT_REASONING_MODEL must be non-empty",
  );
  const cfg = config.parseConfig({});
  // The extraction model defaults to the shared constant.
  assert.equal(cfg.model, config.DEFAULT_REASONING_MODEL);
});
