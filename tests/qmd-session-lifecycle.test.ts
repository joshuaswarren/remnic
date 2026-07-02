import test from "node:test";
import assert from "node:assert/strict";
import {
  releaseSharedDaemonSessionForTest,
  retainSharedDaemonSessionForTest,
  sharedDaemonSessionCountForTest,
} from "../packages/remnic-core/src/qmd.js";

// Shared daemon session lifecycle (#1537). Sessions are constructed lazily —
// no child process spawns until a probe — so these tests exercise the
// refcount/pool semantics without touching a real qmd binary. Unique paths
// per test keep the process-global pool isolated between tests.

test("same-key retains share one session; release closes on zero (#1537)", async () => {
  const path = `qmd-lifecycle-test-${process.pid}-a`;
  const before = sharedDaemonSessionCountForTest();

  const first = retainSharedDaemonSessionForTest(path, {}, "idx");
  const second = retainSharedDaemonSessionForTest(path, {}, "idx");
  assert.equal(first, second, "identical keys share one session instance");
  assert.equal(sharedDaemonSessionCountForTest(), before + 1);

  await releaseSharedDaemonSessionForTest(first);
  assert.equal(
    sharedDaemonSessionCountForTest(),
    before + 1,
    "one live holder keeps the entry",
  );

  await releaseSharedDaemonSessionForTest(second);
  assert.equal(
    sharedDaemonSessionCountForTest(),
    before,
    "last release removes the entry — the property stop()-teardown restores across reload cycles",
  );
});

test("different keys get distinct sessions and independent lifecycles", async () => {
  const before = sharedDaemonSessionCountForTest();
  const a = retainSharedDaemonSessionForTest(`qmd-lifecycle-test-${process.pid}-b1`, {}, "idx");
  const b = retainSharedDaemonSessionForTest(`qmd-lifecycle-test-${process.pid}-b2`, {}, "idx");
  assert.notEqual(a, b);
  assert.equal(sharedDaemonSessionCountForTest(), before + 2);
  await releaseSharedDaemonSessionForTest(a);
  assert.equal(sharedDaemonSessionCountForTest(), before + 1);
  await releaseSharedDaemonSessionForTest(b);
  assert.equal(sharedDaemonSessionCountForTest(), before);
});

test("release is idempotent and tolerates null", async () => {
  const path = `qmd-lifecycle-test-${process.pid}-c`;
  const before = sharedDaemonSessionCountForTest();
  const session = retainSharedDaemonSessionForTest(path, {}, "idx");
  await releaseSharedDaemonSessionForTest(session);
  assert.equal(sharedDaemonSessionCountForTest(), before);
  // Double-release of an already-removed session is a no-op, not a crash —
  // overlapping shutdown paths make this interleaving realistic.
  await releaseSharedDaemonSessionForTest(session);
  assert.equal(sharedDaemonSessionCountForTest(), before);
  await releaseSharedDaemonSessionForTest(null);
});

test("an invalidated shared session self-heals by design (pinned semantics)", async () => {
  // The wedge-inheritance concern from the audit: a crashed holder's session
  // is REUSED by the next retain. That is safe by design — invalidate/cleanup
  // resets the child so the next daemon probe respawns it. Pin the state
  // machine so a refactor breaking the self-heal fails here.
  const path = `qmd-lifecycle-test-${process.pid}-d`;
  const session = retainSharedDaemonSessionForTest(path, {}, "idx") as unknown as {
    invalidate(): void;
    isActive(): boolean;
    isLoading(): boolean;
  };
  session.invalidate();
  assert.equal(session.isActive(), false, "invalidated session is not active");
  assert.equal(session.isLoading(), false, "invalidated session is not stuck loading");
  const reused = retainSharedDaemonSessionForTest(path, {}, "idx");
  assert.equal(reused, session as unknown, "reuse returns the pooled session");
  assert.equal(
    (reused as unknown as { isLoading(): boolean }).isLoading(),
    false,
    "reused session is probe-ready, not wedged",
  );
  await releaseSharedDaemonSessionForTest(reused);
  await releaseSharedDaemonSessionForTest(reused);
});
