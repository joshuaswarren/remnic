import assert from "node:assert/strict";
import test from "node:test";

import { createLiveCapture } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import type { HelperChild } from "./native.js";
import { Spool } from "./spool.js";
import type { TranscribedSegment } from "./stt.js";

class FakeChild implements HelperChild {
  #stdout: Array<(chunk: Buffer | string) => void> = [];
  #stderr: Array<(chunk: Buffer | string) => void> = [];
  #exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  killed = false;
  readonly stdout = { on: (_e: "data", cb: (c: Buffer | string) => void) => this.#stdout.push(cb) };
  readonly stderr = { on: (_e: "data", cb: (c: Buffer | string) => void) => this.#stderr.push(cb) };
  once(event: "error" | "exit", listener: (...a: never[]) => void): unknown {
    if (event === "exit") this.#exit = listener as (c: number | null, s: NodeJS.Signals | null) => void;
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  push(text: string): void {
    for (const cb of this.#stdout) cb(text);
  }
}

const chunkLine = (path: string, startedAtUtc: string, endedAtUtc: string): string =>
  JSON.stringify({ path, channel: "mic", startedAtUtc, endedAtUtc, device: "mic" }) + "\n";

test("live capture turns helper chunk events into persisted conversations", async () => {
  const spool = new Spool(":memory:");
  const child = new FakeChild();
  try {
    const live = createLiveCapture({
      spool,
      config: defaultDaemonConfig(),
      outDir: "/tmp/raw",
      defaultModelPath: "/model.bin",
      resolution: { specifier: "test", binaryPath: "/helper" },
      resolveModel: () => "/model.bin",
      spawn: () => child,
      // Deterministic transcript per chunk, keyed off the WAV path.
      transcribe: async (input): Promise<TranscribedSegment[]> => [
        {
          text: input.wavPath.includes("b.wav") ? "second" : "first",
          startUtc: input.chunkStartedAtUtc,
          endUtc: input.chunkStartedAtUtc,
        },
      ],
      cleanupRawAudio: async () => undefined,
    });

    live.start();
    assert.equal(live.running, true);
    child.push(chunkLine("/tmp/raw/a.wav", "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:30.000Z"));
    child.push(chunkLine("/tmp/raw/b.wav", "2026-07-24T00:00:31.000Z", "2026-07-24T00:01:00.000Z"));

    const closed = await live.stop();
    assert.equal(closed >= 1, true); // at least one conversation finalized
    // Both chunks are within the 10-minute gap -> one conversation, two segments.
    assert.equal(spool.stats().segments, 2);
    assert.equal(spool.latestCapturingConversation(), null); // finalized on stop
    assert.equal(child.killed, true);
  } finally {
    spool.close();
  }
});
