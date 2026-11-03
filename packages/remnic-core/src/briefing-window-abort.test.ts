import assert from "node:assert/strict";
import test from "node:test";
import { safeReadMemories } from "./briefing-window.js";
import type { CorpusReadOptions } from "./corpus-read-cancellation.js";
import type { MemoryFile } from "./types.js";

test("caller cancellation reaches the signal-aware legacy briefing scan", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const reader = {
    supportsAbortSignal: true,
    async readAllMemories(options?: CorpusReadOptions): Promise<MemoryFile[]> {
      assert.ok(options?.abortSignal);
      started.resolve(options.abortSignal);
      await release.promise;
      options.abortSignal.throwIfAborted();
      return [];
    },
  };
  const result = safeReadMemories(
    reader,
    {
      from: new Date("2026-04-10T00:00:00.000Z"),
      to: new Date("2026-04-11T00:00:00.000Z"),
      label: "yesterday",
    },
    { signal: controller.signal }
  ).then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error })
  );
  try {
    const scanSignal = await started.promise;
    assert.equal(scanSignal.aborted, false);
    controller.abort();
    release.resolve();
    const outcome = await result;
    assert.equal(outcome.ok, false, "a cancelled scan must reject, not return an empty corpus");
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.error.name, "AbortError");
    assert.equal(scanSignal.aborted, true, "the underlying scan must stop too");
  } finally {
    release.resolve();
    await result;
  }
});
