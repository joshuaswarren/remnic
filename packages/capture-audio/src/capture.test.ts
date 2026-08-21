import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLiveCapture } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import type { HelperChild } from "./native.js";
import { Spool } from "./spool.js";
import type { TranscribedSegment } from "./stt.js";

class FakeChild implements HelperChild {
  #stdout: Array<(chunk: Buffer | string) => void> = [];
  #stderr: Array<(chunk: Buffer | string) => void> = [];
  #close: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  killed = false;
  readonly stdout = { on: (_e: "data", cb: (c: Buffer | string) => void) => this.#stdout.push(cb) };
  readonly stderr = { on: (_e: "data", cb: (c: Buffer | string) => void) => this.#stderr.push(cb) };
  once(event: "error" | "close", listener: (...a: never[]) => void): unknown {
    if (event === "close") this.#close = listener as (c: number | null, s: NodeJS.Signals | null) => void;
    return this;
  }
  kill(): boolean {
    this.killed = true;
    this.#close?.(0, "SIGTERM"); // real helper exits on SIGTERM
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

test("live capture rejects a symlinked chunk path that escapes the raw dir", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "cap-sym-"));
  const rawDir = path.join(base, "raw");
  mkdirSync(rawDir);
  const outside = path.join(base, "secret.wav");
  writeFileSync(outside, "x");
  const link = path.join(rawDir, "evil.wav");
  symlinkSync(outside, link);
  const spool = new Spool(":memory:");
  const child = new FakeChild();
  const errors: string[] = [];
  try {
    const live = createLiveCapture({
      spool,
      config: defaultDaemonConfig(),
      outDir: rawDir,
      defaultModelPath: "/m",
      resolution: { specifier: "t", binaryPath: "/h" },
      resolveModel: () => "/m",
      spawn: () => child,
      transcribe: async (): Promise<TranscribedSegment[]> => [
        { text: "leak", startUtc: "2026-07-24T00:00:00.000Z", endUtc: "2026-07-24T00:00:01.000Z" },
      ],
      cleanupRawAudio: async () => undefined,
      onError: (e) => errors.push(e.message),
    });
    live.start();
    child.push(chunkLine(link, "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:30.000Z"));
    await live.stop();
    assert.equal(spool.stats().segments, 0); // escaping symlink is never transcribed/persisted
    assert.ok(errors.some((m) => m.includes("escapes the capture directory")));
  } finally {
    spool.close();
    rmSync(base, { recursive: true, force: true });
  }
});
