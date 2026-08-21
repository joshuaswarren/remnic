import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AccessAuditAdapter } from "./access-audit.js";
import type { RecallAuditEntry } from "./recall-audit.js";

function makeEntry(q: string, ts = new Date().toISOString()): RecallAuditEntry {
  return {
    ts,
    sessionKey: "session-a",
    agentId: "agent-a",
    trigger: "test",
    queryText: q,
    candidateMemoryIds: [],
    summary: null,
    injectedChars: 0,
    toggleState: "enabled",
  };
}

test("adapter with audit off and detection off is a no-op", async () => {
  const adapter = new AccessAuditAdapter({
    audit: { enabled: false, rootDir: "/dev/null" },
    detection: { enabled: false },
  });
  const r = await adapter.record("p1", makeEntry("hi"));
  assert.equal(r.appendedAt, undefined);
  assert.equal(r.anomalies, undefined);
});

test("adapter runs detector in-memory when detection-only is enabled", async () => {
  const adapter = new AccessAuditAdapter({
    audit: { enabled: false, rootDir: "/dev/null" },
    detection: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 2,
      namespaceWalkLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    await adapter.record(
      "p1",
      makeEntry("ALEX", new Date(now + i).toISOString()),
      now + i,
    );
  }
  const final = await adapter.record(
    "p1",
    makeEntry("ALEX", new Date(now + 100).toISOString()),
    now + 100,
  );
  assert.ok(final.anomalies);
  const repeat = final.anomalies.flags.find((f) => f.kind === "repeat-query");
  assert.ok(repeat, "repeat-query flag should fire");
});

test("adapter buckets tail per-principal so bursts do not cross principals", async () => {
  const adapter = new AccessAuditAdapter({
    audit: { enabled: false, rootDir: "/dev/null" },
    detection: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 2,
      namespaceWalkLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  const now = Date.now();
  // Alice bursts.
  for (let i = 0; i < 5; i++) {
    await adapter.record(
      "alice",
      makeEntry("x", new Date(now + i).toISOString()),
      now + i,
    );
  }
  // Bob issues a single query. The detector must not see Alice's entries
  // in Bob's tail.
  const bob = await adapter.record(
    "bob",
    makeEntry("x", new Date(now + 10).toISOString()),
    now + 10,
  );
  assert.ok(bob.anomalies);
  assert.equal(bob.anomalies.windowEntryCount, 1);
  assert.equal(bob.anomalies.flags.length, 0);
});

test("adapter writes JSONL when audit is enabled and tolerates write failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "access-audit-"));
  try {
    const adapter = new AccessAuditAdapter({
      audit: { enabled: true, rootDir: dir },
      detection: { enabled: false },
    });
    const r = await adapter.record("p1", makeEntry("hi"));
    assert.ok(r.appendedAt, "audit file path should be returned");
    assert.ok(r.appendedAt.startsWith(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit write failure does not throw — the enclosing recall continues", async () => {
  // Point at a path we expect to be unwritable — a file path used as a
  // directory. appendRecallAuditEntry will ENOTDIR on mkdir; the adapter
  // must swallow.
  const adapter = new AccessAuditAdapter({
    audit: { enabled: true, rootDir: "/dev/null/not-a-dir" },
    detection: { enabled: false },
  });
  const r = await adapter.record("p1", makeEntry("hi"));
  assert.equal(r.appendedAt, undefined);
});

test("trail buffer respects trailBufferSize", async () => {
  const adapter = new AccessAuditAdapter({
    audit: { enabled: false, rootDir: "/dev/null" },
    detection: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 1_000,
      namespaceWalkLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
    trailBufferSize: 3,
  });
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    await adapter.record(
      "p1",
      makeEntry(`q-${i}`, new Date(now + i).toISOString()),
      now + i,
    );
  }
  const final = await adapter.record(
    "p1",
    makeEntry("final", new Date(now + 20).toISOString()),
    now + 20,
  );
  assert.ok(final.anomalies);
  assert.equal(final.anomalies.windowEntryCount, 3);
});

test("reset clears all tails", async () => {
  const adapter = new AccessAuditAdapter({
    audit: { enabled: false, rootDir: "/dev/null" },
    detection: {
      enabled: true,
      windowMs: 60_000,
      repeatQueryLimit: 1,
      namespaceWalkLimit: 1_000,
      highCardinalityReturnLimit: 1_000,
      rapidFireLimit: 1_000,
    },
  });
  const now = Date.now();
  await adapter.record("p1", makeEntry("x", new Date(now).toISOString()), now);
  await adapter.record("p1", makeEntry("x", new Date(now + 1).toISOString()), now + 1);
  adapter.reset();
  const r = await adapter.record(
    "p1",
    makeEntry("x", new Date(now + 2).toISOString()),
    now + 2,
  );
  assert.ok(r.anomalies);
  assert.equal(r.anomalies.windowEntryCount, 1);
  assert.equal(r.anomalies.flags.length, 0);
});
