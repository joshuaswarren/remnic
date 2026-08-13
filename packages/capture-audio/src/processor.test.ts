import assert from "node:assert/strict";
import test from "node:test";

import { ConversationAssembler } from "./assembly.js";
import type { ChunkEvent } from "./native.js";
import {
  chunkStableId,
  createChunkProcessor,
  segmentStableKey,
  transcriptManifestHash,
  transcriptManifestKey,
  type ChunkProcessorDeps,
} from "./processor.js";
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
    // Only the guest cluster is captured here, so per-append persistence stores
    // it; `self` durability is enrollment's job (it seeds the clusterer + spool).
    const clusters = spool.readSpeakerClusters();
    assert.ok(
      clusters.some((c) => !c.isSelf),
      "the assigned guest cluster is persisted",
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

test("cross-channel dedup is order-independent: a mic chunk processed BEFORE its system copy still dedups", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        transcribe: async (input) =>
          input.wavPath.includes("sys")
            ? [{ text: "hello there world", startUtc: t(1), endUtc: t(3) }]
            : [
                { text: "hello there world", startUtc: t(1), endUtc: t(3) }, // loopback dup
                { text: "unique mic line", startUtc: t(10), endUtc: t(11) },
              ],
      }),
    );
    // Mic chunk arrives FIRST (native helper stops mic before system on shutdown);
    // the streaming approach would leak the dup here, finalize-time dedup does not.
    proc.enqueue(chunk({ path: "/tmp/raw/mic.wav", channel: "mic", startedAtUtc: t(0), endedAtUtc: t(12) }));
    proc.enqueue(chunk({ path: "/tmp/raw/sys.wav", channel: "system", startedAtUtc: t(0), endedAtUtc: t(4) }));
    await proc.finalize();
    const segs = finalSegments(spool);
    assert.deepEqual(
      segs.map((s) => s.textRaw).sort(),
      ["hello there world", "unique mic line"],
      "the duplicate mic copy is dropped regardless of arrival order",
    );
    assert.equal(segs.find((s) => s.textRaw === "hello there world")?.channel, "system");
  } finally {
    spool.close();
  }
});

test("kill-9 durability: an appended segment keeps the embedding its cluster is derived from", async () => {
  // Clustering moved to finalize (issue #2145), so a kill before finalize
  // leaves no cluster — but the EMBEDDING is durable, so the next finalize
  // derives the same cluster. Nothing is lost, and a duplicate that dedup
  // later prunes never got to move a centroid.
  const spool = new Spool(":memory:");
  try {
    const guest: Embedding = [0, 1, 0, 0];
    const proc = createChunkProcessor(
      deps(spool, {
        diarizer: new SpeakerClusterer(0.7),
        embed: () => guest,
        transcribe: async () => [{ text: "guest speaking", startUtc: t(1), endUtc: t(2) }],
      }),
    );
    proc.enqueue(chunk());
    await proc.drain(); // process is killed (-9) here: no finalize() runs
    assert.deepEqual(spool.readSpeakerClusters(), [], "no cluster before finalize");
    const open = spool.latestCapturingConversation();
    assert.ok(open);
    assert.equal(
      spool.conversationSegmentsForDiarization(open.id).length,
      1,
      "the embedding survived the crash and is still pending clustering",
    );

    // Restart: a fresh processor + clusterer over the same spool.
    const restarted = createChunkProcessor(
      deps(spool, { diarizer: new SpeakerClusterer(0.7), embed: () => guest }),
    );
    await restarted.finalize();
    const clusters = spool.readSpeakerClusters();
    assert.equal(clusters.length, 1, "finalize derived the cluster from the persisted embedding");
    assert.equal(clusters[0].isSelf, false);
    assert.equal(clusters[0].embeddingCount, 1, "counted exactly once");
  } finally {
    spool.close();
  }
});

test("a pruned loopback duplicate contributes nothing to any speaker cluster (issue #2145)", async () => {
  // The same utterance heard on both channels: dedup keeps the system copy.
  // With append-time clustering the mic copy still moved the centroid and
  // bumped the count before it was pruned.
  const spool = new Spool(":memory:");
  try {
    const voice: Embedding = [1, 0, 0, 0];
    const proc = createChunkProcessor(
      deps(spool, {
        diarizer: new SpeakerClusterer(0.7),
        embed: () => voice,
        transcribe: async () => [{ text: "hello there world", startUtc: t(1), endUtc: t(3) }],
      }),
    );
    proc.enqueue(chunk({ path: "/tmp/raw/sys.wav", channel: "system", startedAtUtc: t(0), endedAtUtc: t(4) }));
    proc.enqueue(chunk({ path: "/tmp/raw/mic.wav", channel: "mic", startedAtUtc: t(0), endedAtUtc: t(4) }));
    await proc.drain();
    assert.equal(spool.stats().segments, 2, "both copies are stored before dedup");
    await proc.finalize();

    assert.equal(finalSegments(spool).length, 1, "the loopback dup was pruned");
    const clusters = spool.readSpeakerClusters();
    assert.equal(clusters.length, 1, "one speaker, not a phantom pair");
    assert.equal(clusters[0].embeddingCount, 1, "the pruned duplicate never counted");
  } finally {
    spool.close();
  }
});

test("finalize dedups a crash-left capturing conversation even when this run processes no chunk", async () => {
  const spool = new Spool(":memory:");
  try {
    // Run 1 leaves a capturing conversation holding a system segment + its mic
    // loopback duplicate, then is killed (-9) before finalize.
    const run1 = createChunkProcessor(
      deps(spool, {
        transcribe: async () => [{ text: "hello there world", startUtc: t(1), endUtc: t(3) }],
      }),
    );
    run1.enqueue(chunk({ path: "/tmp/raw/sys.wav", channel: "system", startedAtUtc: t(0), endedAtUtc: t(4) }));
    run1.enqueue(chunk({ path: "/tmp/raw/mic.wav", channel: "mic", startedAtUtc: t(0), endedAtUtc: t(4) }));
    await run1.drain(); // no finalize -> capturing, dup still present
    assert.equal(spool.stats().segments, 2);
    // Run 2 processes NO chunk (so it has no in-memory open id); finalize must
    // still prune the crash-left duplicate.
    const run2 = createChunkProcessor(deps(spool));
    assert.ok((await run2.finalize()) >= 1);
    const segs = finalSegments(spool);
    assert.equal(segs.length, 1, "the loopback dup was pruned at finalize despite no chunk this run");
    assert.equal(segs[0].channel, "system");
  } finally {
    spool.close();
  }
});

test("diarization: a label-only self keeps the mic=wearer heuristic (no voice embedding to match)", async () => {
  const spool = new Spool(":memory:");
  try {
    // Label-only enrollment: a self cluster with no embedding to match against.
    spool.upsertSpeaker({ id: "self", isSelf: true, label: "me", embeddingCount: 0, centroid: [], examples: [] });
    const diarizer = new SpeakerClusterer(0.7, spool.readSpeakerClusters());
    const guest: Embedding = [0, 1, 0, 0];
    const proc = createChunkProcessor(
      deps(spool, {
        diarizer,
        embed: () => guest,
        transcribe: async () => [{ text: "wearer on mic", startUtc: t(1), endUtc: t(2) }],
      }),
    );
    proc.enqueue(chunk()); // mic channel
    await proc.finalize();
    const segs = finalSegments(spool);
    assert.equal(segs[0].isWearer, true, "mic wearer heuristic retained until self is voice-enrolled");
  } finally {
    spool.close();
  }
});

test("a durable replay does not re-consume the embedding or corrupt the cluster", async () => {
  const spool = new Spool(":memory:");
  try {
    const guest: Embedding = [0, 1, 0, 0];
    const run1 = createChunkProcessor(
      deps(spool, {
        diarizer: new SpeakerClusterer(0.7, spool.readSpeakerClusters()),
        embed: () => guest,
        transcribe: async () => [{ text: "guest", startUtc: t(1), endUtc: t(2) }],
      }),
    );
    run1.enqueue(chunk());
    await run1.finalize();
    const before = spool.readSpeakerClusters();
    assert.equal(before.length, 1);
    const count0 = before[0].embeddingCount;
    // Restart replays the SAME chunk (same WAV path -> same stable id). The
    // ':done' marker from run 1 must make run 2 skip transcription AND embedding
    // entirely, not merely avoid mutating the cluster.
    let transcribeCalls = 0;
    let embedCalls = 0;
    const run2 = createChunkProcessor(
      deps(spool, {
        diarizer: new SpeakerClusterer(0.7, spool.readSpeakerClusters()),
        embed: () => {
          embedCalls++;
          return guest;
        },
        transcribe: async () => {
          transcribeCalls++;
          return [{ text: "guest", startUtc: t(1), endUtc: t(2) }];
        },
      }),
    );
    run2.enqueue(chunk());
    await run2.finalize();
    assert.equal(transcribeCalls, 0, "a full replay skips transcription");
    assert.equal(embedCalls, 0, "a full replay skips embedding");
    const after = spool.readSpeakerClusters();
    assert.equal(after.length, 1, "a replay creates no new cluster");
    assert.equal(after[0].embeddingCount, count0, "a replay did not inflate the embedding count");
  } finally {
    spool.close();
  }
});

test("partial-chunk replay appends the missing tail segment instead of duplicating the first", async () => {
  const spool = new Spool(":memory:");
  try {
    const ev = chunk({ path: "/tmp/raw/multi.wav" });
    const cid = chunkStableId(ev);
    // Simulate a kill-9 AFTER segment 0 appended but BEFORE segment 1 / the
    // :done marker. Keys are per-segment (`chunkId:i<index>`) so they mean the
    // same bytes on every replay, whatever batch the chunk lands in (#2145).
    const seededKey = segmentStableKey(cid, { startUtc: t(1), endUtc: t(2), text: "first group" });
    spool.appendAssembledSegments({
      idempotencyKey: seededKey,
      chunkId: seededKey,
      conversationId: "conv_grp0",
      startedAtUtc: t(1),
      state: "capturing",
      segments: [{ channel: "mic", text: "first group", startUtc: t(1), endUtc: t(2), isWearer: true }],
    });
    assert.equal(spool.stats().segments, 1);
    assert.equal(spool.isChunkApplied(`${cid}:done`), false);
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [
          { text: "first group", startUtc: t(1), endUtc: t(2) },
          { text: "second group", startUtc: t(30), endUtc: t(31) },
        ],
      }),
    );
    proc.enqueue(ev);
    await proc.finalize();
    assert.equal(spool.stats().segments, 2, "the lost tail segment was appended; segment 0 not duplicated");
    assert.equal(spool.isChunkApplied(`${cid}:done`), true, "the chunk is now marked complete");
  } finally {
    spool.close();
  }
});

test("a zero-segment replay of a partially-applied chunk does NOT mark it done (tail stays recoverable)", async () => {
  const spool = new Spool(":memory:");
  try {
    const ev = chunk({ path: "/tmp/raw/multi.wav" });
    const cid = chunkStableId(ev);
    const seededKey = segmentStableKey(cid, { startUtc: t(1), endUtc: t(2), text: "first group" });
    spool.appendAssembledSegments({
      idempotencyKey: seededKey,
      chunkId: seededKey,
      conversationId: "conv_grp0",
      startedAtUtc: t(1),
      state: "capturing",
      segments: [{ channel: "mic", text: "first group", startUtc: t(1), endUtc: t(2), isWearer: true }],
    });
    // A replay that yields ZERO segments (VAD off / empty STT / WAV already gone).
    const empty = createChunkProcessor(
      deps(spool, { assembler: new ConversationAssembler({ gapMinutes: 0 }), transcribe: async () => [] }),
    );
    empty.enqueue(ev);
    await empty.finalize();
    assert.equal(spool.isChunkApplied(`${cid}:done`), false, "not marked done while the tail is still missing");
    // A later correct replay still recovers the missing tail segment.
    const fixed = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [
          { text: "first group", startUtc: t(1), endUtc: t(2) },
          { text: "second group", startUtc: t(30), endUtc: t(31) },
        ],
      }),
    );
    fixed.enqueue(ev);
    await fixed.finalize();
    assert.equal(spool.stats().segments, 2, "the tail segment was recovered on a correct replay");
    assert.equal(spool.isChunkApplied(`${cid}:done`), true);
  } finally {
    spool.close();
  }
});

test("a chunk applied under the pre-#2145 group keys is left strictly alone", async () => {
  // Legacy `chunkId` / `chunkId:<n>` keys prove only that SOME group persisted,
  // so the chunk is neither re-appended (duplicating stored groups) nor closed
  // out (discarding an unpersisted tail). Its raw audio stays for replay.
  const spool = new Spool(":memory:");
  try {
    const ev = chunk({ path: "/tmp/raw/legacy.wav" });
    const cid = chunkStableId(ev);
    spool.appendAssembledSegments({
      idempotencyKey: `${cid}:0`,
      chunkId: `${cid}:0`,
      conversationId: "conv_legacy",
      startedAtUtc: t(1),
      state: "capturing",
      segments: [{ channel: "mic", text: "legacy group", startUtc: t(1), endUtc: t(2), isWearer: true }],
    });
    const cleaned: string[] = [];
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
        transcribe: async () => [
          { text: "legacy group", startUtc: t(1), endUtc: t(2) },
          { text: "tail", startUtc: t(30), endUtc: t(31) },
        ],
      }),
    );
    proc.enqueue(ev);
    await proc.finalize();
    assert.deepEqual(cleaned, [], "the raw audio is retained for replay");
    assert.equal(spool.stats().segments, 1, "no duplicate of the legacy-applied segment");
    assert.equal(
      spool.isChunkApplied(`${cid}:done`),
      false,
      "and it is NOT closed out, so the unpersisted tail stays recoverable",
    );
  } finally {
    spool.close();
  }
});

test("a done-marked replay retries raw-WAV cleanup", async () => {
  const spool = new Spool(":memory:");
  try {
    let cleanupCalls = 0;
    const mk = () => createChunkProcessor(deps(spool, { cleanupRawAudio: async () => { cleanupCalls++; } }));
    const run1 = mk();
    run1.enqueue(chunk());
    await run1.finalize();
    assert.equal(cleanupCalls, 1);
    // Replay: the :done marker short-circuits transcription, but WAV cleanup is retried.
    const run2 = mk();
    run2.enqueue(chunk());
    await run2.drain();
    assert.equal(cleanupCalls, 2, "the done-replay retried WAV cleanup");
  } finally {
    spool.close();
  }
});

test("pruning the earliest duplicate recomputes the conversation's time bounds", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        transcribe: async (input) =>
          input.wavPath.includes("sys")
            ? [{ text: "shared line", startUtc: t(5), endUtc: t(6) }]
            : [{ text: "shared line", startUtc: t(1), endUtc: t(2) }], // earlier mic dup -> pruned
      }),
    );
    proc.enqueue(chunk({ path: "/tmp/raw/mic.wav", channel: "mic", startedAtUtc: t(0), endedAtUtc: t(3) }));
    proc.enqueue(chunk({ path: "/tmp/raw/sys.wav", channel: "system", startedAtUtc: t(4), endedAtUtc: t(7) }));
    await proc.finalize();
    const page = spool.queryFinalConversations({ date: "2026-07-24", timezone: "UTC", limit: 100 });
    assert.equal(page.conversations.length, 1);
    const conv = page.conversations[0];
    assert.equal(conv.segments.length, 1, "only the system copy survives");
    assert.equal(conv.startedAtUtc, t(5), "started_at_utc recomputed to the surviving earliest segment");
    assert.equal(conv.endedAtUtc, t(6), "ended_at_utc recomputed to the surviving latest segment");
  } finally {
    spool.close();
  }
});

test("a delayed cross-channel chunk groups by time, not arrival (issue #2145)", async () => {
  // conversationGapMinutes: 0 splits on ANY gap, so arrival order decides the
  // grouping outright. The mic chunk covering 00:01 arrives first; the system
  // chunk covering 00:00 arrives after it. Without the reorder buffer the
  // earlier system segment is appended to the LATER conversation.
  const spool = new Spool(":memory:");
  try {
    let minted = 0;
    const byPath: Record<string, TranscribedSegment[]> = {
      "/tmp/raw/mic-late.wav": [
        { text: "second", startUtc: "2026-07-24T00:01:00.000Z", endUtc: "2026-07-24T00:01:05.000Z" },
      ],
      "/tmp/raw/sys-early.wav": [
        { text: "first", startUtc: "2026-07-24T00:00:00.000Z", endUtc: "2026-07-24T00:00:05.000Z" },
      ],
    };
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0, makeId: () => `conv_${++minted}` }),
        reorderWindowMs: 120_000,
        transcribe: async ({ wavPath }) => byPath[wavPath] ?? [],
      }),
    );
    // Arrival order is deliberately reversed relative to capture time.
    proc.enqueue(
      chunk({
        path: "/tmp/raw/mic-late.wav",
        channel: "mic",
        startedAtUtc: "2026-07-24T00:01:00.000Z",
        endedAtUtc: "2026-07-24T00:01:30.000Z",
      }),
    );
    proc.enqueue(
      chunk({
        path: "/tmp/raw/sys-early.wav",
        channel: "system",
        startedAtUtc: "2026-07-24T00:00:00.000Z",
        endedAtUtc: "2026-07-24T00:00:30.000Z",
      }),
    );
    await proc.drain();
    // Still inside the reorder window: nothing has been released yet, so the
    // WAVs are retained and no conversation exists.
    assert.equal(spool.stats().segments, 0, "held until the watermark passes");
    await proc.finalize();
    // Ids are minted in RELEASE order, so conv_1 must hold the earlier
    // (system) segment even though its chunk arrived second.
    assert.equal(minted, 2, "each segment opened its own conversation at gap 0");
    assert.deepEqual(
      spool.conversationSegmentsForDedup("conv_1").map((seg) => seg.text),
      ["first"],
    );
    assert.deepEqual(
      spool.conversationSegmentsForDedup("conv_2").map((seg) => seg.text),
      ["second"],
    );
  } finally {
    spool.close();
  }
});

test("the reorder buffer releases once the watermark passes a held chunk", async () => {
  const spool = new Spool(":memory:");
  try {
    const byPath: Record<string, TranscribedSegment[]> = {
      "/tmp/raw/a.wav": [
        { text: "early", startUtc: "2026-07-24T00:00:00.000Z", endUtc: "2026-07-24T00:00:05.000Z" },
      ],
      "/tmp/raw/b.wav": [
        { text: "later", startUtc: "2026-07-24T00:02:00.000Z", endUtc: "2026-07-24T00:02:05.000Z" },
      ],
    };
    const cleaned: string[] = [];
    const proc = createChunkProcessor(
      deps(spool, {
        reorderWindowMs: 30_000,
        transcribe: async ({ wavPath }) => byPath[wavPath] ?? [],
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    proc.enqueue(chunk({ path: "/tmp/raw/a.wav", endedAtUtc: "2026-07-24T00:00:30.000Z" }));
    await proc.drain();
    assert.equal(spool.stats().segments, 0, "the newest chunk is never its own watermark");
    assert.deepEqual(cleaned, [], "a held chunk keeps its WAV for replay");

    proc.enqueue(
      chunk({
        path: "/tmp/raw/b.wav",
        startedAtUtc: "2026-07-24T00:02:00.000Z",
        endedAtUtc: "2026-07-24T00:02:30.000Z",
      }),
    );
    await proc.drain();
    assert.equal(spool.stats().segments, 1, "the older chunk released once the watermark passed it");
    assert.deepEqual(cleaned, ["/tmp/raw/a.wav"], "and only then is its WAV reclaimed");
  } finally {
    spool.close();
  }
});

test("reorderWindowMs 0 keeps the pre-#2145 release-on-arrival behavior", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(deps(spool, { reorderWindowMs: 0 }));
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(spool.stats().segments, 2, "released without waiting for a later chunk");
  } finally {
    spool.close();
  }
});


test("overlapping cross-channel windows interleave by timestamp (issue #2145)", async () => {
  // The mic chunk covers 00:00 and 00:20; the system chunk covers 00:10. With
  // whole-chunk release the 00:10 segment landed AFTER 00:20 and could join the
  // later conversation, splitting a cross-channel duplicate across two
  // conversations where finalize-time dedup can no longer see it.
  const spool = new Spool(":memory:");
  try {
    let minted = 0;
    const byPath: Record<string, TranscribedSegment[]> = {
      "/tmp/raw/mic-span.wav": [
        { text: "mic first", startUtc: t(0), endUtc: t(1) },
        { text: "mic third", startUtc: t(20), endUtc: t(21) },
      ],
      "/tmp/raw/sys-mid.wav": [{ text: "system second", startUtc: t(10), endUtc: t(11) }],
    };
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0, makeId: () => `conv_${++minted}` }),
        reorderWindowMs: 120_000,
        transcribe: async ({ wavPath }) => byPath[wavPath] ?? [],
      }),
    );
    proc.enqueue(
      chunk({ path: "/tmp/raw/mic-span.wav", channel: "mic", startedAtUtc: t(0), endedAtUtc: t(30) }),
    );
    proc.enqueue(
      chunk({ path: "/tmp/raw/sys-mid.wav", channel: "system", startedAtUtc: t(10), endedAtUtc: t(12) }),
    );
    await proc.drain();
    await proc.finalize();

    assert.equal(minted, 3, "gap 0 gives each segment its own conversation");
    assert.deepEqual(
      [1, 2, 3].map((n) => spool.conversationSegmentsForDedup(`conv_${n}`).map((s) => s.text)),
      [["mic first"], ["system second"], ["mic third"]],
      "conversations were minted in capture order, not chunk order",
    );
  } finally {
    spool.close();
  }
});

test("a crash between cluster and assignment cannot double-count embeddings", async () => {
  // The two writes are one transaction: a failure rolls both back, so the next
  // finalize sees pending segments and unchanged counts (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const voice: Embedding = [1, 0, 0, 0];
    const clusterer = new SpeakerClusterer(0.7);
    const failing = createChunkProcessor(
      deps(spool, {
        diarizer: clusterer,
        embed: () => voice,
        transcribe: async () => [{ text: "one utterance", startUtc: t(1), endUtc: t(2) }],
      }),
    );
    failing.enqueue(chunk());
    await failing.drain();

    // Force the assignment half to throw, mid-transaction.
    const original = spool.commitDiarization.bind(spool);
    let failed = false;
    (spool as unknown as { commitDiarization: unknown }).commitDiarization = (input: never) => {
      if (!failed) {
        failed = true;
        throw new Error("sqlite exploded mid-commit");
      }
      return original(input);
    };
    await assert.rejects(() => failing.finalize(), /sqlite exploded mid-commit/);
    assert.deepEqual(spool.readSpeakerClusters(), [], "the cluster write rolled back with the assignment");
    assert.deepEqual(clusterer.clusters(), [], "and the in-memory clusterer rolled back with it");

    // Reuse the SAME clusterer: a daemon that keeps running after the failure
    // must not count the embedding twice on the retry.
    const recovered = createChunkProcessor(
      deps(spool, {
        diarizer: clusterer,
        embed: () => voice,
      }),
    );
    await recovered.finalize();
    const clusters = spool.readSpeakerClusters();
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].embeddingCount, 1, "counted exactly once across the failure");
  } finally {
    spool.close();
  }
});

test("a pre-commit failure rewinds the assembler; a partial commit does not", async () => {
  // Two halves of one invariant (issue #2145): the in-memory assembler and the
  // durable ids must never diverge. Nothing persisted -> rewind, so the retry
  // re-splits. Something persisted -> keep, so the durable id is reused.
  const spool = new Spool(":memory:");
  try {
    let minted = 0;
    const assembler = new ConversationAssembler({ gapMinutes: 0, makeId: () => `conv_${++minted}` });
    let failAppends = true;
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "appendAssembledSegments" && failAppends) {
          return () => {
            throw new Error("sqlite busy");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;

    const proc = createChunkProcessor(
      deps(guarded, {
        assembler,
        transcribe: async () => [
          { text: "one", startUtc: t(1), endUtc: t(2) },
          { text: "two", startUtc: t(40), endUtc: t(41) },
        ],
      }),
    );
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(spool.stats().segments, 0, "nothing persisted");
    assert.deepEqual(assembler.conversations(), [], "the assembler rewound to its pre-batch state");

    // The retry now succeeds and must still split the two segments at gap 0.
    failAppends = false;
    const retry = createChunkProcessor(
      deps(guarded, {
        assembler,
        transcribe: async () => [
          { text: "one", startUtc: t(1), endUtc: t(2) },
          { text: "two", startUtc: t(40), endUtc: t(41) },
        ],
      }),
    );
    retry.enqueue(chunk());
    await retry.finalize();
    assert.equal(spool.stats().segments, 2);
    // Ids are never reused, so `minted` also counts the discarded attempt; what
    // matters is that the retry produced TWO conversations, not one collapsed.
    // The assembler prunes closed conversations, so the spool is the record.
    assert.equal(spool.stats().conversations, 2, "the retry re-split instead of collapsing into one");
    assert.deepEqual(
      [`conv_${minted - 1}`, `conv_${minted}`].map((id) =>
        spool.conversationSegmentsForDedup(id).map((seg) => seg.text),
      ),
      [["one"], ["two"]],
    );
  } finally {
    spool.close();
  }
});

test("a pre-commit failure also rewinds restart-recovery state", async () => {
  // `resume()` and `openConversationId` are set INSIDE applyBatch, so a
  // rollback that restored only the assembler would leave the recovery flags
  // claiming a conversation the assembler no longer holds; the retry would
  // then mint a new id for a conversation that is durably open (issue #2145).
  const spool = new Spool(":memory:");
  try {
    // A prior run left a capturing conversation.
    const priorId = spool.insertConversation({
      startedAtUtc: t(1),
      endedAtUtc: t(2),
      state: "capturing",
      segments: [{ channel: "mic", text: "before restart", startUtc: t(1), endUtc: t(2), isWearer: true }],
    });
    let failAppends = true;
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "appendAssembledSegments" && failAppends) {
          return () => {
            throw new Error("sqlite busy");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;
    let minted = 0;
    const assembler = new ConversationAssembler({ gapMinutes: 10, makeId: () => `conv_new_${++minted}` });
    const withinGap = { ...deps(guarded, { assembler }), transcribe: async () => [
      { text: "after restart", startUtc: t(3), endUtc: t(4) },
    ] };

    // ONE processor for both attempts: a fresh instance would resume from its
    // own untouched flags, which would let the test pass even if the rollback
    // never restored them.
    const proc = createChunkProcessor(withinGap);
    proc.enqueue(chunk({ startedAtUtc: t(3), endedAtUtc: t(5) }));
    await proc.drain();
    assert.equal(spool.stats().segments, 1, "nothing new persisted");

    // The failed chunk was requeued, so finalize retries THAT chunk on THIS
    // processor — the flags the rollback restored are the ones in play.
    failAppends = false;
    await proc.finalize();

    assert.equal(minted, 0, "the retry resumed the durable conversation instead of minting a new id");
    assert.deepEqual(
      spool.conversationSegmentsForDedup(priorId).map((seg) => seg.text),
      ["before restart", "after restart"],
      "and the within-gap segment joined it",
    );
  } finally {
    spool.close();
  }
});

test("a retranscription that inserts a segment does not rebind an existing key", async () => {
  // Keys are content-derived, not positional: replaying [A, B] as [X, A, B]
  // must append X and skip A, not treat A as new because its index moved
  // (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const ev = chunk({ path: "/tmp/raw/reseg.wav" });
    const cid = chunkStableId(ev);
    const keyA = segmentStableKey(cid, { startUtc: t(10), endUtc: t(11), text: "A" });
    spool.appendAssembledSegments({
      idempotencyKey: keyA,
      chunkId: keyA,
      conversationId: "conv_seeded",
      startedAtUtc: t(10),
      state: "capturing",
      segments: [{ channel: "mic", text: "A", startUtc: t(10), endUtc: t(11), isWearer: true }],
    });
    const proc = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 10 }),
        transcribe: async () => [
          { text: "X", startUtc: t(1), endUtc: t(2) },
          { text: "A", startUtc: t(10), endUtc: t(11) },
          { text: "B", startUtc: t(20), endUtc: t(21) },
        ],
      }),
    );
    proc.enqueue(ev);
    await proc.finalize();

    const stored = spool
      .capturingConversationIds()
      .concat(["conv_seeded"])
      .flatMap((id) => spool.conversationSegmentsForDedup(id).map((seg) => seg.text));
    assert.equal(spool.stats().segments, 3, "X and B were added; A was not duplicated");
    assert.deepEqual([...new Set(stored)].sort(), ["A", "B", "X"]);
  } finally {
    spool.close();
  }
});

test("a shortened retranscription keeps the chunk open instead of losing its tail", async () => {
  // A REAL partial apply: the first run persists A and then fails on B, so the
  // chunk is never completed. A later STT change makes the replay produce only
  // A. The recorded segment COUNT is what tells that apart from a chunk whose
  // transcript legitimately has one segment (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const ev = chunk({ path: "/tmp/raw/shrink.wav" });
    const cid = chunkStableId(ev);
    const cleaned: string[] = [];
    // Named, not indexed: `noUncheckedIndexedAccess` makes `two[0]` optional,
    // which breaks contextual typing of the deps object it is passed through.
    const segmentA: TranscribedSegment = { text: "A", startUtc: t(1), endUtc: t(2) };
    const segmentB: TranscribedSegment = { text: "B", startUtc: t(40), endUtc: t(41) };
    const two = [segmentA, segmentB];
    // Fail the SECOND append so segment A lands durably and B never does.
    let appends = 0;
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "appendAssembledSegments") {
          return (input: Parameters<Spool["appendAssembledSegments"]>[0]) => {
            appends += 1;
            if (appends === 2) throw new Error("sqlite busy");
            return target.appendAssembledSegments(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;

    const partial = createChunkProcessor(
      deps(guarded, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => two,
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    partial.enqueue(ev);
    await partial.drain();
    assert.equal(spool.stats().segments, 1, "only A persisted");
    assert.ok(spool.appliedChunkValue(transcriptManifestKey(cid)) !== undefined, "the transcript manifest was recorded");
    assert.equal(spool.isChunkApplied(`${cid}:done`), false, "and the chunk is not complete");

    // The replay now produces only A.
    const shortened = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [segmentA],
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    shortened.enqueue(chunk({ path: "/tmp/raw/shrink.wav" }));
    await shortened.finalize();

    assert.equal(
      spool.isChunkApplied(`${cid}:done`),
      false,
      "a shorter transcript never completes the chunk",
    );
    // `assert.deepEqual` is an assertion signature, so comparing against `[]`
    // would narrow `cleaned` to `never[]` for the rest of the test.
    assert.equal(cleaned.length, 0, "and its raw audio is retained for another replay");

    // A chunk whose transcript legitimately matches DOES complete.
    const stable = chunk({ path: "/tmp/raw/stable.wav" });
    const stableId = chunkStableId(stable);
    const ok = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [segmentA],
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    ok.enqueue(stable);
    await ok.finalize();
    assert.equal(spool.isChunkApplied(`${stableId}:done`), true);
    assert.deepEqual(cleaned, ["/tmp/raw/stable.wav"]);
  } finally {
    spool.close();
  }
});

test("a replay with the same segment count but different content stays open", async () => {
  // A count is too weak a manifest: [A, B] recording n2 and committing only A,
  // then replaying as [X, B], would match on count and be marked complete with
  // mixed content (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const ev = chunk({ path: "/tmp/raw/swap.wav" });
    const cid = chunkStableId(ev);
    const a: TranscribedSegment = { text: "A", startUtc: t(1), endUtc: t(2) };
    const b: TranscribedSegment = { text: "B", startUtc: t(40), endUtc: t(41) };
    const x: TranscribedSegment = { text: "X", startUtc: t(1), endUtc: t(2) };
    const cleaned: string[] = [];

    let appends = 0;
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "appendAssembledSegments") {
          return (input: Parameters<Spool["appendAssembledSegments"]>[0]) => {
            appends += 1;
            if (appends === 2) throw new Error("sqlite busy");
            return target.appendAssembledSegments(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;

    const partial = createChunkProcessor(
      deps(guarded, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [a, b],
      }),
    );
    partial.enqueue(ev);
    await partial.drain();
    assert.equal(spool.stats().segments, 1, "only A persisted");

    // Same COUNT, different content.
    const swapped = createChunkProcessor(
      deps(spool, {
        assembler: new ConversationAssembler({ gapMinutes: 0 }),
        transcribe: async () => [x, b],
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    swapped.enqueue(chunk({ path: "/tmp/raw/swap.wav" }));
    await swapped.finalize();
    assert.equal(spool.isChunkApplied(`${cid}:done`), false, "a changed transcript never completes the chunk");
    assert.equal(cleaned.length, 0, "and its raw audio is retained");
  } finally {
    spool.close();
  }
});

test("a chunk is never released without its transcript manifest", async () => {
  // Swallowing a failed manifest write and releasing anyway would let a later,
  // changed retranscription record the FIRST manifest and complete a partially
  // applied chunk (issue #2145).
  const spool = new Spool(":memory:");
  try {
    let failMarker = true;
    const cleaned: string[] = [];
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "markApplied" && failMarker) {
          return () => {
            throw new Error("sqlite busy");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;
    const errors: Error[] = [];
    const proc = createChunkProcessor(
      deps(guarded, {
        reorderWindowMs: 0,
        onError: (error) => errors.push(error),
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(spool.stats().segments, 0, "nothing was appended without a manifest");
    assert.equal(cleaned.length, 0, "and the raw audio is retained");
    assert.ok(
      errors.some((error) => /sqlite busy/.test(error.message)),
      "the failure was reported",
    );

    // The next pass retries the write and releases the chunk.
    failMarker = false;
    await proc.finalize();
    assert.equal(spool.stats().segments, 2, "the chunk released once its manifest was durable");
  } finally {
    spool.close();
  }
});

test("a manifest failure holds the whole ready window, not just one chunk", async () => {
  // applyBatch interleaves the ready set chronologically, so releasing peers
  // without a held chunk would apply its segments out of order later (#2145).
  const spool = new Spool(":memory:");
  try {
    let blocked: string | undefined = chunkStableId(chunk({ path: "/tmp/raw/a.wav" }));
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "markApplied") {
          return (key: string, value: string) => {
            if (blocked !== undefined && key === `${blocked}:manifest`) throw new Error("sqlite busy");
            target.markApplied(key, value);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;
    const proc = createChunkProcessor(
      deps(guarded, {
        reorderWindowMs: 0,
        onError: () => undefined,
        // Distinct, non-overlapping spans: cross-channel dedup must not be
        // what makes this assertion pass.
        transcribe: async (input) =>
          input.wavPath.endsWith("a.wav")
            ? [{ text: "first", startUtc: t(1), endUtc: t(2) }]
            : [{ text: "second", startUtc: t(30), endUtc: t(31) }],
      }),
    );
    proc.enqueue(chunk({ path: "/tmp/raw/a.wav" }));
    proc.enqueue(chunk({ path: "/tmp/raw/b.wav", channel: "system" }));
    await proc.drain();
    assert.equal(spool.stats().segments, 0, "the peer was held with the blocked chunk");

    blocked = undefined;
    await proc.finalize();
    assert.equal(spool.stats().segments, 2, "both released together once the manifest was durable");
  } finally {
    spool.close();
  }
});

test("finalize fails loudly when a chunk cannot be released", async () => {
  // Reporting success would let the daemon close the spool while a one-shot
  // event was never appended, and retention would then reclaim its WAV.
  const spool = new Spool(":memory:");
  try {
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "markApplied") {
          return () => {
            throw new Error("sqlite busy");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;
    const proc = createChunkProcessor(deps(guarded, { onError: () => undefined }));
    proc.enqueue(chunk());
    await assert.rejects(() => proc.finalize(), /retained for replay/);
  } finally {
    spool.close();
  }
});

test("the assembler does not retain closed conversations", async () => {
  // Otherwise every rollback checkpoint clones the whole capture history and
  // the daemon's per-chunk work grows without bound (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const assembler = new ConversationAssembler({ gapMinutes: 0 });
    const proc = createChunkProcessor(deps(spool, { assembler }));
    proc.enqueue(chunk());
    await proc.finalize();
    assert.equal(spool.stats().conversations, 2, "the gap split two conversations");
    assert.ok(assembler.conversations().length <= 1, "but at most the open one is retained");
  } finally {
    spool.close();
  }
});

test("a silent chunk completes and reclaims its audio", async () => {
  // A silent transcript records no manifest, so it must not be judged against
  // one: doing so would hold every silent chunk open forever (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const cleaned: string[] = [];
    const speech = chunk({ path: "/tmp/raw/speech.wav" });
    const ev = chunk();
    const proc = createChunkProcessor(
      deps(spool, {
        // Speech first, then silence, on ONE processor: the silent chunk must
        // not hold the conversation the speech chunk opened.
        transcribe: async (input) =>
          input.wavPath.endsWith("speech.wav") ? [{ text: "hello", startUtc: t(1), endUtc: t(2) }] : [],
        cleanupRawAudio: async (event) => {
          cleaned.push(event.path);
        },
      }),
    );
    proc.enqueue(speech);
    proc.enqueue(ev);
    await proc.finalize();
    assert.equal(spool.isChunkApplied(`${chunkStableId(ev)}:done`), true, "the silent chunk completed");
    assert.ok(cleaned.includes(ev.path), "and its raw audio was reclaimed");
    assert.deepEqual(
      [...spool.capturingConversationIds()],
      [],
      "and it did not hold an earlier conversation open",
    );
  } finally {
    spool.close();
  }
});

test("a conflicting retranscription appends nothing", async () => {
  // Appending it would interleave content the first transcript never had, and
  // a later correct replay would then skip the segments it already stored.
  const spool = new Spool(":memory:");
  try {
    const ev = chunk();
    const cid = chunkStableId(ev);
    // A first run recorded its manifest and then died before completing.
    spool.markApplied(
      transcriptManifestKey(cid),
      transcriptManifestHash(cid, [
        { text: "A", startUtc: t(1), endUtc: t(2) },
        { text: "B", startUtc: t(40), endUtc: t(41) },
      ]),
    );

    const errors: Error[] = [];
    const divergent = createChunkProcessor(
      deps(spool, {
        onError: (error) => errors.push(error),
        transcribe: async () => [
          { text: "X", startUtc: t(1), endUtc: t(2) },
          { text: "B", startUtc: t(40), endUtc: t(41) },
        ],
      }),
    );
    divergent.enqueue(ev);
    await divergent.finalize();
    assert.equal(spool.stats().segments, 0, "the divergent transcript persisted nothing");
    assert.equal(spool.isChunkApplied(`${cid}:done`), false, "and the chunk stays open");
    assert.ok(
      errors.some((error) => /does not match the recorded manifest/.test(error.message)),
      "and the conflict was reported",
    );
  } finally {
    spool.close();
  }
});

test("a chunk retained for replay keeps its conversation resumable", async () => {
  // Both retain paths — a silent replay over a durable prefix, and a manifest
  // conflict — must hold the conversation open. Once `finalize()` flips it to
  // `final`, a matching replay cannot `resume` it and the missing tail lands
  // in a new conversation, out of reach of cross-channel dedup (issue #2145).
  for (const mode of ["silent", "conflict"] as const) {
    const spool = new Spool(":memory:");
    try {
      const ev = chunk();
      const cid = chunkStableId(ev);
      const segs = [
        { text: "A", startUtc: t(1), endUtc: t(2) },
        { text: "B", startUtc: t(40), endUtc: t(41) },
      ];
      // A first run persisted a prefix under a capturing conversation and
      // recorded its manifest, then died.
      spool.markApplied(transcriptManifestKey(cid), transcriptManifestHash(cid, segs));
      spool.appendAssembledSegments({
        idempotencyKey: segmentStableKey(cid, segs[0]),
        chunkId: cid,
        conversationId: "conv_prefix",
        startedAtUtc: t(1),
        state: "capturing",
        segments: [{ channel: "mic", text: "A", startUtc: t(1), endUtc: t(2), isWearer: true }],
      });

      const proc = createChunkProcessor(
        deps(spool, {
          onError: () => undefined,
          transcribe: async () => (mode === "silent" ? [] : [{ text: "X", startUtc: t(1), endUtc: t(2) }]),
        }),
      );
      proc.enqueue(ev);
      await proc.finalize();
      assert.deepEqual(
        [...spool.capturingConversationIds()],
        ["conv_prefix"],
        `the ${mode} replay left the durable prefix resumable`,
      );
    } finally {
      spool.close();
    }
  }
});

test("a gap-crossing chunk cannot close a conversation held for replay", async () => {
  // The retain decision must be made BEFORE the idle close: otherwise a later
  // healthy chunk past the gap flips the durable prefix to final mid-batch,
  // before the completion loop ever consults the flag (issue #2145).
  const spool = new Spool(":memory:");
  try {
    const stale = chunk();
    const cid = chunkStableId(stale);
    const segs = [
      { text: "A", startUtc: t(1), endUtc: t(2) },
      { text: "B", startUtc: t(40), endUtc: t(41) },
    ];
    spool.markApplied(transcriptManifestKey(cid), transcriptManifestHash(cid, segs));
    spool.appendAssembledSegments({
      idempotencyKey: segmentStableKey(cid, segs[0]),
      chunkId: cid,
      conversationId: "conv_prefix",
      startedAtUtc: t(1),
      state: "capturing",
      segments: [{ channel: "mic", text: "A", startUtc: t(1), endUtc: t(2), isWearer: true }],
    });

    // The silent replay and a much later healthy chunk release in ONE batch.
    const later = chunk({
      path: "/tmp/raw/later.wav",
      startedAtUtc: t(9000),
      endedAtUtc: t(9001),
    });
    const proc = createChunkProcessor(
      deps(spool, {
        onError: () => undefined,
        transcribe: async (input) =>
          input.wavPath.endsWith("later.wav") ? [{ text: "later", startUtc: t(9000), endUtc: t(9001) }] : [],
      }),
    );
    proc.enqueue(stale);
    proc.enqueue(later);
    await proc.finalize();
    assert.ok(
      [...spool.capturingConversationIds()].includes("conv_prefix"),
      "the held prefix was not flipped to final",
    );
  } finally {
    spool.close();
  }
});
