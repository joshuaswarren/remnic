import assert from "node:assert/strict";
import test from "node:test";
import { scopedCaptureWriteLockLimits, withCaptureWriteLockBackoff } from "./capture-write-lock-scope.js";

const limits = { initialDelayMs: 20, maxDelayMs: 50, deadlineMs: 8_000 };
const expected = {
  captureWriteLockInitialDelayMs: 20,
  captureWriteLockMaxDelayMs: 50,
  captureWriteLockDeadlineMs: 8_000,
};

test("capture backoff scope belongs only to its storage and restores nested state after rejection", async () => {
  const storage = { dir: "synthetic-shared-root" };
  const other = { dir: storage.dir };
  const result = await withCaptureWriteLockBackoff(storage, limits, async () => {
    await Promise.resolve();
    assert.deepEqual(scopedCaptureWriteLockLimits(storage), expected);
    assert.equal(scopedCaptureWriteLockLimits(other), undefined);
    await assert.rejects(
      withCaptureWriteLockBackoff(other, { ...limits, deadlineMs: 4_000 }, async () => {
        assert.equal(scopedCaptureWriteLockLimits(other)?.captureWriteLockDeadlineMs, 4_000);
        assert.equal(scopedCaptureWriteLockLimits(storage), undefined);
        throw new Error("peer apply failed");
      }),
      /peer apply failed/
    );
    return scopedCaptureWriteLockLimits(storage);
  });
  assert.deepEqual(result, expected);
  assert.equal(scopedCaptureWriteLockLimits(storage), undefined);
  assert.equal(scopedCaptureWriteLockLimits(other), undefined);
});
