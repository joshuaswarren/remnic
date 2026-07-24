import assert from "node:assert/strict";
import test from "node:test";

import { ConversationAssembler } from "./assembly.js";
import type { ChunkEvent } from "./native.js";
import { createChunkProcessor, type ChunkProcessorDeps } from "./processor.js";
import { Spool } from "./spool.js";
import type { TranscribedSegment } from "./stt.js";
import { SpeakerClusterer, type Embedding } from "./diarization.js";

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

// Seconds-granularity UTC timestamp on the fixtures' capture day.
const t = (s: number): string => `2026-07-24T00:00:${String(s).padStart(2, "0")}.000Z`;

const finalSegments = (spool: Spool) =>
  spool
    .queryFinalConversations({ date: "2026-07-24", timezone: "UTC", limit: 100 })
    .conversations.flatMap((c) => c.segments);

test("VAD gate: a non-speech chunk skips STT (and model resolution) yet still reclaims its WAV", async () => {
  const spool = new Spool(":memory:");
  try {
    let transcribeCalls = 0;
    let modelResolves = 0;
    let cleaned = 0;
    const proc = createChunkProcessor(
      deps(spool, {
        detectSpeech: () => false,
        resolveModel: () => {
          modelResolves++;
          return "/model.bin";
        },
        transcribe: async () => {
          transcribeCalls++;
          return [{ text: "unheard", startUtc: t(1), endUtc: t(2) }];
        },
        cleanupRawAudio: async () => {
          cleaned++;
        },
      }),
    );
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(transcribeCalls, 0, "STT skipped for a non-speech chunk");
    assert.equal(modelResolves, 0, "model resolution skipped for a non-speech chunk");
    assert.equal(spool.stats().segments, 0, "no segments persist for silence");
    assert.equal(cleaned, 1, "raw WAV is still reclaimed");
  } finally {
    spool.close();
  }
});

test("VAD gate: a speech chunk transcribes and persists as normal", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(deps(spool, { detectSpeech: () => true }));
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(spool.stats().segments, 2, "speech still flows through STT + assembly");
  } finally {
    spool.close();
  }
});

test("diarization: same-voice segments share one non-self cluster and are not the wearer", async () => {
  const spool = new Spool(":memory:");
  try {
    const guest: Embedding = [0, 1, 0, 0];
    const diarizer = new SpeakerClusterer(0.7);
    diarizer.enrollSelf([1, 0, 0, 0]);
    const proc = createChunkProcessor(
      deps(spool, {
        diarizer,
        embed: () => guest,
        transcribe: async () => [
          { text: "guest one", startUtc: t(1), endUtc: t(2) },
          { text: "guest two", startUtc: t(3), endUtc: t(4) },
        ],
      }),
    );
    proc.enqueue(chunk());
    await proc.finalize();
    const segs = finalSegments(spool);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].speakerKey, segs[1].speakerKey, "one synthetic voice -> one cluster (no fragmentation)");
    assert.notEqual(segs[0].speakerKey, "self");
    assert.equal(segs[0].isWearer, false, "a guest voice on the mic is NOT the wearer");
    const clusters = spool.readSpeakerClusters();
    assert.ok(
      clusters.some((c) => c.isSelf) && clusters.some((c) => !c.isSelf),
      "self + guest clusters both persisted on finalize",
    );
  } finally {
    spool.close();
  }
});

test("diarization: the enrolled self voice on the mic is attributed to the wearer", async () => {
  const spool = new Spool(":memory:");
  try {
    const self: Embedding = [1, 0, 0, 0];
    const diarizer = new SpeakerClusterer(0.7);
    diarizer.enrollSelf(self);
    const proc = createChunkProcessor(
      deps(spool, {
        diarizer,
        embed: () => self,
        transcribe: async () => [{ text: "my own words", startUtc: t(1), endUtc: t(2) }],
      }),
    );
    proc.enqueue(chunk());
    await proc.finalize();
    const segs = finalSegments(spool);
    assert.equal(segs[0].speakerKey, "self");
    assert.equal(segs[0].isWearer, true);
  } finally {
    spool.close();
  }
});

test("diarization: persisted clusters seed a restart so speaker ids stay stable", async () => {
  const spool = new Spool(":memory:");
  try {
    const guest: Embedding = [0, 1, 0, 0];
    const run1 = createChunkProcessor(
      deps(spool, {
        diarizer: new SpeakerClusterer(0.7, spool.readSpeakerClusters()),
        embed: () => guest,
        transcribe: async () => [{ text: "first", startUtc: t(1), endUtc: t(2) }],
      }),
    );
    run1.enqueue(chunk({ path: "/tmp/raw/a.wav", startedAtUtc: t(1), endedAtUtc: t(3) }));
    await run1.finalize();
    const firstId = spool.readSpeakerClusters()[0]?.id;
    assert.ok(firstId, "a cluster was persisted");
    // Restart: a fresh clusterer seeded from the spool must reuse the same id
    // for the same voice rather than mint a new one.
    const run2 = createChunkProcessor(
      deps(spool, {
        diarizer: new SpeakerClusterer(0.7, spool.readSpeakerClusters()),
        embed: () => guest,
        transcribe: async () => [{ text: "second", startUtc: t(5), endUtc: t(6) }],
      }),
    );
    run2.enqueue(chunk({ path: "/tmp/raw/b.wav", startedAtUtc: t(5), endedAtUtc: t(7) }));
    await run2.finalize();
    const segs = finalSegments(spool);
    assert.equal(segs.length, 2);
    assert.ok(
      segs.every((s) => s.speakerKey === firstId),
      "the same voice keeps its cluster id across a restart",
    );
    assert.equal(spool.readSpeakerClusters().length, 1, "no duplicate cluster was created");
  } finally {
    spool.close();
  }
});

test("cross-channel dedup: a mic segment duplicating a recent system segment is dropped", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        transcribe: async (input) =>
          input.wavPath.includes("sys")
            ? [{ text: "hello there world", startUtc: t(1), endUtc: t(3) }]
            : [
                { text: "hello there world", startUtc: t(1), endUtc: t(3) }, // loopback dup -> dropped
                { text: "unique mic line", startUtc: t(10), endUtc: t(11) }, // kept
              ],
      }),
    );
    // System (loopback) chunk arrives first, then the mic chunk that re-hears it.
    proc.enqueue(chunk({ path: "/tmp/raw/sys.wav", channel: "system", startedAtUtc: t(0), endedAtUtc: t(4) }));
    proc.enqueue(chunk({ path: "/tmp/raw/mic.wav", channel: "mic", startedAtUtc: t(0), endedAtUtc: t(12) }));
    await proc.finalize();
    const segs = finalSegments(spool);
    assert.deepEqual(
      segs.map((s) => s.textRaw).sort(),
      ["hello there world", "unique mic line"],
      "the duplicate mic copy is dropped; the unique mic line survives",
    );
    const kept = segs.find((s) => s.textRaw === "hello there world");
    assert.equal(kept?.channel, "system", "the retained copy is the cleaner system channel");
  } finally {
    spool.close();
  }
});

test("kill-9 recovery: a restart resumes the open conversation and stays idempotent on replay", async () => {
  const spool = new Spool(":memory:");
  try {
    // Run 1 processes chunk A, then the process is killed (-9) BEFORE finalize,
    // so the conversation is left `capturing` in the durable spool.
    const run1 = createChunkProcessor(deps(spool));
    run1.enqueue(chunk({ path: "/tmp/raw/a.wav", startedAtUtc: t(1), endedAtUtc: t(5) }));
    await run1.drain();
    const open = spool.latestCapturingConversation();
    assert.ok(open, "conversation left capturing after a kill-9 (no finalize)");
    const openId = open.id;
    assert.equal(spool.stats().segments, 2);
    // Run 2 (restart) with a brand-new processor + assembler over the SAME spool:
    // a replay of A must not duplicate, and a follow-on chunk B within the gap
    // must resume the SAME conversation rather than start a new one.
    const run2 = createChunkProcessor(deps(spool));
    run2.enqueue(chunk({ path: "/tmp/raw/a.wav", startedAtUtc: t(1), endedAtUtc: t(5) })); // replay
    run2.enqueue(chunk({ path: "/tmp/raw/b.wav", startedAtUtc: t(6), endedAtUtc: t(9) }));
    await run2.drain();
    assert.equal(spool.stats().segments, 4, "replay added nothing; chunk B appended its 2 segments");
    assert.equal(spool.stats().conversations, 1, "the open conversation was resumed, not split");
    assert.equal(spool.latestCapturingConversation()?.id, openId, "same conversation id resumed across restart");
  } finally {
    spool.close();
  }
});
