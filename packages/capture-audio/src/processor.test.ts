import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationAssembler } from "./assembly.js";
import { CaptureConfigError } from "./errors.js";
import { chunkStableId, createChunkProcessor } from "./processor.js";
import { Spool } from "./spool.js";
import type { ChunkEvent } from "./native.js";
import type { ChunkTranscribeInput } from "./processor.js";
import type { TranscribedSegment } from "./stt.js";

const MODEL_PATH = "/models/ggml-base.bin";

function chunk(overrides: Partial<ChunkEvent> = {}): ChunkEvent {
  return {
    path: "/spool/raw/mic-100.wav",
    channel: "mic",
    startedAtUtc: "2026-07-22T10:00:00.000Z",
    endedAtUtc: "2026-07-22T10:00:30.000Z",
    device: "builtin-mic",
    ...overrides,
  };
}

function seg(text: string, startUtc: string, endUtc: string): TranscribedSegment {
  return { text, startUtc, endUtc };
}

/** Fixed-id assembler so conversation ids are deterministic in assertions. */
function assemblerWith(ids: string[]): ConversationAssembler {
  let n = 0;
  return new ConversationAssembler({ makeId: () => ids[n++] ?? `conv_overflow_${n}` });
}

test("a successful native chunk transcribes, assembles, persists, and cleans the WAV", async () => {
  const spool = new Spool(":memory:");
  const calls: ChunkTranscribeInput[] = [];
  const cleaned: string[] = [];
  const errors: Error[] = [];
  const processor = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_1"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async (input) => {
      calls.push(input);
      return [
        seg("Hello there", "2026-07-22T10:00:01.000Z", "2026-07-22T10:00:03.000Z"),
        seg("   ", "2026-07-22T10:00:03.000Z", "2026-07-22T10:00:04.000Z"),
        seg("general kenobi", "2026-07-22T10:00:05.000Z", "2026-07-22T10:00:08.000Z"),
      ];
    },
    cleanupRawAudio: async (event) => {
      cleaned.push(event.path);
    },
    onError: (error) => errors.push(error),
  });

  const event = chunk();
  processor.enqueue(event);
  await processor.drain();

  assert.equal(errors.length, 0, "a healthy chunk must not report errors");
  assert.deepEqual(calls, [
    { wavPath: event.path, modelPath: MODEL_PATH, chunkStartedAtUtc: event.startedAtUtc },
  ]);

  const conv = spool.getConversation("conv_1");
  assert.ok(conv, "the assembled conversation must be persisted");
  assert.equal(conv.state, "capturing", "an open conversation stays capturing until stop");
  assert.equal(conv.segmentCount, 2, "empty segments are normalized away");
  assert.deepEqual(
    conv.segments.map((s) => s.textRaw),
    ["Hello there", "general kenobi"],
  );
  assert.ok(conv.segments.every((s) => s.channel === "mic" && s.isWearer));

  const record = spool.getChunk(chunkStableId(event));
  assert.ok(record, "the backing chunk row must be retained");
  assert.equal(record.wavPath, event.path, "the chunk's precise WAV path is retained");
  assert.equal(record.status, "transcribed");
  assert.equal(record.device, "builtin-mic");

  assert.deepEqual(cleaned, [event.path], "the raw WAV is deleted once persisted");
  spool.close();
});

test("a failed transcription is reported but the next chunk still processes", async () => {
  const spool = new Spool(":memory:");
  const cleaned: string[] = [];
  const errors: Error[] = [];
  let call = 0;
  const processor = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_good"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async () => {
      call += 1;
      if (call === 1) throw new CaptureConfigError("whisper-cli failed with exit code 1");
      return [seg("recovered", "2026-07-22T11:00:01.000Z", "2026-07-22T11:00:04.000Z")];
    },
    cleanupRawAudio: async (event) => {
      cleaned.push(event.path);
    },
    onError: (error) => errors.push(error),
  });

  const bad = chunk({ path: "/spool/raw/mic-bad.wav" });
  const good = chunk({
    path: "/spool/raw/mic-good.wav",
    startedAtUtc: "2026-07-22T11:00:00.000Z",
    endedAtUtc: "2026-07-22T11:00:30.000Z",
  });
  processor.enqueue(bad);
  processor.enqueue(good);
  await processor.drain();

  assert.equal(errors.length, 1, "the failed chunk reports exactly one error");
  assert.match(errors[0].message, /whisper-cli failed/);

  assert.equal(spool.getConversation("conv_good")?.segmentCount, 1, "the later chunk still persists");
  assert.deepEqual(cleaned, [good.path], "a failed chunk keeps its WAV; only the healthy one is cleaned");
  assert.equal(spool.getChunk(chunkStableId(bad)), null, "a failed chunk leaves no chunk row");
  spool.close();
});

test("replaying the same chunk after a restart does not duplicate stored segments", async () => {
  const spool = new Spool(":memory:");
  const transcript = (): TranscribedSegment[] => [
    seg("only once", "2026-07-22T12:00:01.000Z", "2026-07-22T12:00:04.000Z"),
  ];
  const event = chunk({
    path: "/spool/raw/mic-replay.wav",
    startedAtUtc: "2026-07-22T12:00:00.000Z",
    endedAtUtc: "2026-07-22T12:00:30.000Z",
  });

  // First run: fresh processor + assembler persists the chunk.
  const runA = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_first"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async () => transcript(),
    cleanupRawAudio: async () => {},
  });
  runA.enqueue(event);
  await runA.drain();

  const afterFirst = spool.stats();
  assert.equal(afterFirst.conversations, 1);
  assert.equal(afterFirst.segments, 1);

  // Simulated restart: a brand-new processor with an empty in-memory assembler
  // (fresh random conversation id) re-receives the identical chunk. The durable
  // applied_chunks guard must make this a content no-op.
  const runB = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_second"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async () => transcript(),
    cleanupRawAudio: async () => {},
  });
  runB.enqueue(event);
  await runB.drain();

  const afterReplay = spool.stats();
  assert.equal(afterReplay.conversations, 1, "replay must not create a second conversation");
  assert.equal(afterReplay.segments, 1, "replay must not duplicate stored segments");
  assert.equal(spool.getConversation("conv_second"), null, "the replayed run's fresh id never reaches the DB");
  spool.close();
});

test("finalize drains pending work then flips open conversations to final", async () => {
  const spool = new Spool(":memory:");
  const processor = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_final"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async () => [seg("wrap up", "2026-07-22T13:00:01.000Z", "2026-07-22T13:00:04.000Z")],
    cleanupRawAudio: async () => {},
  });

  const event = chunk({
    path: "/spool/raw/mic-final.wav",
    startedAtUtc: "2026-07-22T13:00:00.000Z",
    endedAtUtc: "2026-07-22T13:00:30.000Z",
  });
  processor.enqueue(event);

  const before = spool.queryFinalConversations({ date: "2026-07-22", timezone: "UTC", cursor: null, limit: 10 });
  assert.equal(before.conversations.length, 0, "a capturing conversation is not served as final");

  const flipped = await processor.finalize();
  assert.equal(flipped, 1, "finalize reports the conversation it closed");

  const after = spool.queryFinalConversations({ date: "2026-07-22", timezone: "UTC", cursor: null, limit: 10 });
  assert.deepEqual(after.conversations.map((c) => c.id), ["conv_final"]);
  assert.equal(spool.getConversation("conv_final")?.state, "final");
  spool.close();
});

test("an adjacent chunk after a restart continues the open conversation instead of splitting", async () => {
  const spool = new Spool(":memory:");

  // Run A persists the first half of a conversation, then a hard restart is
  // simulated by dropping the processor WITHOUT finalizing (row stays capturing).
  const runA = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_live"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async () => [seg("first half", "2026-07-22T14:00:01.000Z", "2026-07-22T14:00:05.000Z")],
    cleanupRawAudio: async () => {},
  });
  runA.enqueue(
    chunk({ path: "/spool/raw/mic-a.wav", startedAtUtc: "2026-07-22T14:00:00.000Z", endedAtUtc: "2026-07-22T14:00:30.000Z" }),
  );
  await runA.drain();

  // Run B is a fresh processor + empty assembler over the same spool; its
  // conversation-id generator must never fire because the adjacent chunk
  // continues the recovered conversation.
  const runB = createChunkProcessor({
    spool,
    assembler: assemblerWith(["conv_should_not_appear"]),
    resolveModel: () => MODEL_PATH,
    transcribe: async () => [seg("second half", "2026-07-22T14:00:35.000Z", "2026-07-22T14:00:38.000Z")],
    cleanupRawAudio: async () => {},
  });
  runB.enqueue(
    chunk({ path: "/spool/raw/mic-b.wav", startedAtUtc: "2026-07-22T14:00:30.000Z", endedAtUtc: "2026-07-22T14:01:00.000Z" }),
  );
  const flipped = await runB.finalize();

  assert.equal(spool.stats().conversations, 1, "the adjacent chunk must not split off a new conversation");
  assert.equal(flipped, 1, "finalize closes the single recovered conversation");
  const conv = spool.getConversation("conv_live");
  assert.ok(conv);
  assert.equal(conv.state, "final");
  assert.deepEqual(
    conv.segments.map((s) => s.textRaw),
    ["first half", "second half"],
    "both halves land in one ordered conversation",
  );
  assert.equal(spool.getConversation("conv_should_not_appear"), null);
  spool.close();
});
