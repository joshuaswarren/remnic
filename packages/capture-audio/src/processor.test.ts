import assert from "node:assert/strict";
import test from "node:test";

import { ConversationAssembler } from "./assembly.js";
import type { ChunkEvent } from "./native.js";
import { createChunkProcessor, type ChunkProcessorDeps } from "./processor.js";
import { Spool } from "./spool.js";
import type { TranscribedSegment } from "./stt.js";

const chunk = (over: Partial<ChunkEvent> = {}): ChunkEvent => ({
  path: "/tmp/raw/a.wav",
  channel: "mic",
  startedAtUtc: "2026-07-24T00:00:00.000Z",
  endedAtUtc: "2026-07-24T00:00:30.000Z",
  device: "mic",
  ...over,
});

function deps(spool: Spool, over: Partial<ChunkProcessorDeps> = {}): ChunkProcessorDeps {
  return {
    spool,
    assembler: new ConversationAssembler({ gapMinutes: 10 }),
    resolveModel: () => "/model.bin",
    transcribe: async (): Promise<TranscribedSegment[]> => [
      { text: "hello", startUtc: "2026-07-24T00:00:01.000Z", endUtc: "2026-07-24T00:00:02.000Z" },
      { text: "  ", startUtc: "2026-07-24T00:00:02.000Z", endUtc: "2026-07-24T00:00:03.000Z" }, // dropped (blank)
      { text: "world", startUtc: "2026-07-24T00:00:03.000Z", endUtc: "2026-07-24T00:00:04.000Z" },
    ],
    cleanupRawAudio: async () => undefined,
    ...over,
  };
}

test("a chunk's non-empty segments persist as a capturing conversation", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(deps(spool));
    proc.enqueue(chunk());
    await proc.drain();
    const open = spool.latestCapturingConversation();
    assert.ok(open, "expected an open conversation");
    assert.equal(spool.stats().segments, 2); // blank segment dropped
    assert.equal((await proc.finalize()) >= 1, true);
    assert.equal(spool.latestCapturingConversation(), null); // finalized
  } finally {
    spool.close();
  }
});

test("re-processing the same chunk after a restart does not duplicate segments", async () => {
  const spool = new Spool(":memory:");
  try {
    const first = createChunkProcessor(deps(spool));
    first.enqueue(chunk());
    await first.drain();
    assert.equal(spool.stats().segments, 2);
    // Simulate a restart: a brand-new processor + assembler, same spool + chunk.
    const second = createChunkProcessor(deps(spool));
    second.enqueue(chunk());
    await second.drain();
    assert.equal(spool.stats().segments, 2); // applied_chunks dedup held
  } finally {
    spool.close();
  }
});

test("a transcription failure routes to onError and the chain keeps running", async () => {
  const spool = new Spool(":memory:");
  const errors: Error[] = [];
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        transcribe: async (input) => {
          if (input.wavPath.endsWith("bad.wav")) throw new Error("stt boom");
          return [{ text: "ok", startUtc: "2026-07-24T00:00:01.000Z", endUtc: "2026-07-24T00:00:02.000Z" }];
        },
        onError: (e) => errors.push(e),
      }),
    );
    proc.enqueue(chunk({ path: "/tmp/raw/bad.wav" }));
    proc.enqueue(chunk({ path: "/tmp/raw/good.wav", startedAtUtc: "2026-07-24T00:01:00.000Z", endedAtUtc: "2026-07-24T00:01:30.000Z" }));
    await proc.drain();
    assert.equal(errors.length, 1);
    assert.equal(spool.stats().segments, 1); // the good chunk still landed
  } finally {
    spool.close();
  }
});

test("a chunk that transcribes to nothing persists no conversation", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(deps(spool, { transcribe: async () => [] }));
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(spool.stats().segments, 0);
    assert.equal(spool.latestCapturingConversation(), null);
  } finally {
    spool.close();
  }
});

test("a gap beyond the threshold finalizes the prior conversation in the spool", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 5 }),
        transcribe: async (input) => [
          { text: input.wavPath, startUtc: input.chunkStartedAtUtc, endUtc: input.chunkStartedAtUtc },
        ],
      }),
    );
    proc.enqueue(chunk({ path: "/tmp/raw/a.wav", startedAtUtc: "2026-07-24T00:00:00.000Z", endedAtUtc: "2026-07-24T00:00:05.000Z" }));
    proc.enqueue(chunk({ path: "/tmp/raw/b.wav", startedAtUtc: "2026-07-24T00:20:00.000Z", endedAtUtc: "2026-07-24T00:20:05.000Z" }));
    await proc.drain();
    // The first conversation was gap-closed and already finalized; only the
    // second remains capturing, so finalizeOpenConversations flips exactly one.
    assert.ok(spool.latestCapturingConversation());
    assert.equal(spool.finalizeOpenConversations(), 1);
  } finally {
    spool.close();
  }
});

test("a within-chunk gap (gapMinutes 0) splits one chunk into separate conversations", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [
          { text: "a", startUtc: "2026-07-24T00:00:00.000Z", endUtc: "2026-07-24T00:00:01.000Z" },
          { text: "b", startUtc: "2026-07-24T00:00:05.000Z", endUtc: "2026-07-24T00:00:06.000Z" },
        ],
      }),
    );
    proc.enqueue(chunk());
    await proc.drain();
    // gap 0 puts each segment in its own conversation, even within one chunk.
    assert.equal(spool.stats().conversations, 2);
    assert.equal(spool.stats().segments, 2);
  } finally {
    spool.close();
  }
});

test("silent chunks after speech finalize the conversation once the gap elapses", async () => {
  const spool = new Spool(":memory:");
  try {
    let call = 0;
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 5 }),
        transcribe: async () =>
          call++ === 0
            ? [{ text: "hi", startUtc: "2026-07-24T00:00:00.000Z", endUtc: "2026-07-24T00:00:02.000Z" }]
            : [],
      }),
    );
    proc.enqueue(chunk({ startedAtUtc: "2026-07-24T00:00:00.000Z", endedAtUtc: "2026-07-24T00:00:05.000Z" }));
    await proc.drain();
    assert.ok(spool.latestCapturingConversation()); // open after speech
    // A later silent chunk, a gap past the open conversation, closes it.
    proc.enqueue(chunk({ path: "/tmp/raw/silent.wav", startedAtUtc: "2026-07-24T00:10:00.000Z", endedAtUtc: "2026-07-24T00:10:05.000Z" }));
    await proc.drain();
    assert.equal(spool.latestCapturingConversation(), null); // finalized by silence
  } finally {
    spool.close();
  }
});
