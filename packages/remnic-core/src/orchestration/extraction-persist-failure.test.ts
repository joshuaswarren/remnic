import assert from "node:assert/strict";
import test from "node:test";

import { CommittedWriteFinalization } from "./extraction-persist-failure.js";

function recordingFinalizer() {
  const calls: boolean[] = [];
  return {
    calls,
    finalize: async (scheduleQmd: boolean) => {
      calls.push(scheduleQmd);
    },
  };
}

test("#3288: the bound finalizer runs once across the success tail and catch sites", async () => {
  const finalization = new CommittedWriteFinalization();
  const { calls, finalize } = recordingFinalizer();
  const once = finalization.bind(finalize);

  const value = await finalization.run(async () => {
    await once(true);
    await once(false);
    return "persisted";
  });

  assert.equal(value, "persisted");
  assert.deepEqual(calls, [true], "a second caller reuses the first run instead of finalizing again");
});

test("#3288: the pass boundary finalizes with QMD scheduling, then rethrows the original error", async () => {
  const finalization = new CommittedWriteFinalization();
  const { calls, finalize } = recordingFinalizer();
  const cause = new Error("branch without its own catch site");

  await assert.rejects(
    finalization.run(async () => {
      finalization.bind(finalize);
      throw cause;
    }),
    (error: Error) => error === cause,
  );
  assert.deepEqual(calls, [true]);
});

test("#3288: the pass boundary does not finalize again after a catch site already did", async () => {
  const finalization = new CommittedWriteFinalization();
  const { calls, finalize } = recordingFinalizer();
  const cause = new Error("catch site rethrow");

  await assert.rejects(
    finalization.run(async () => {
      const once = finalization.bind(finalize);
      await once(true);
      throw cause;
    }),
    (error: Error) => error === cause,
  );
  assert.deepEqual(calls, [true]);
});

test("#3288: a throw before the finalizer is bound propagates without finalizing", async () => {
  const finalization = new CommittedWriteFinalization();
  const cause = new Error("failed before any write");

  await assert.rejects(
    finalization.run(async () => {
      throw cause;
    }),
    (error: Error) => error === cause,
  );
});

test("#3288: a failing finalizer does not mask the original error", async () => {
  const finalization = new CommittedWriteFinalization();
  const cause = new Error("branch failure");
  let attempts = 0;

  await assert.rejects(
    finalization.run(async () => {
      finalization.bind(async () => {
        attempts += 1;
        throw new Error("finalization failure");
      });
      throw cause;
    }),
    (error: Error) => error === cause,
  );
  assert.equal(attempts, 1);
});
