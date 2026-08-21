import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationAssembler } from "./assembly.js";
import { scanOrphanedChunks } from "./orphan-scan.js";
import type { ChunkEvent } from "./native.js";
import {
  chunkStableId,
  createChunkProcessor,
  MAX_BUFFERED_CHUNKS,
  QUARANTINE_AFTER_FAILURES,
  type ChunkProcessorDeps,
} from "./processor.js";
import { Spool } from "./spool.js";
import type { TranscribedSegment } from "./stt.js";

const t = (s: number): string => `2026-07-24T00:00:${String(s).padStart(2, "0")}.000Z`;

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
      { text: "hello", startUtc: t(1), endUtc: t(2) },
    ],
    cleanupRawAudio: async () => undefined,
    ...over,
  };
}

test("overlap eligibility holds an earlier-ending chunk while a later overlapping peer is still held", async () => {
  const spool = new Spool(":memory:");
  try {
    const byPath: Record<string, TranscribedSegment[]> = {
      "/tmp/raw/early-end.wav": [{ text: "early", startUtc: t(0), endUtc: t(1) }],
      "/tmp/raw/late-end.wav": [{ text: "overlap", startUtc: t(20), endUtc: t(21) }],
      "/tmp/raw/watermark.wav": [{ text: "later", startUtc: "2026-07-24T00:04:00.000Z", endUtc: "2026-07-24T00:04:01.000Z" }],
    };
    const proc = createChunkProcessor(
      deps(spool, {
        reorderWindowMs: 60_000,
        transcribe: async ({ wavPath }) => byPath[wavPath] ?? [],
      }),
    );
    proc.enqueue(
      chunk({
        path: "/tmp/raw/early-end.wav",
        startedAtUtc: "2026-07-24T00:00:00.000Z",
        endedAtUtc: "2026-07-24T00:00:30.000Z",
      }),
    );
    proc.enqueue(
      chunk({
        path: "/tmp/raw/late-end.wav",
        channel: "system",
        startedAtUtc: "2026-07-24T00:00:20.000Z",
        endedAtUtc: "2026-07-24T00:01:30.000Z",
      }),
    );
    await proc.drain();
    assert.equal(spool.stats().segments, 0, "the overlapping earlier-ending chunk stays held");

    proc.enqueue(
      chunk({
        path: "/tmp/raw/watermark.wav",
        startedAtUtc: "2026-07-24T00:04:00.000Z",
        endedAtUtc: "2026-07-24T00:04:40.000Z",
      }),
    );
    await proc.drain();
    assert.equal(spool.stats().segments, 2, "both overlapping chunks release together once the peer is eligible");
    const texts = spool
      .capturingConversationIds()
      .flatMap((id) => spool.conversationSegmentsForDedup(id).map((seg) => seg.text));
    assert.deepEqual(texts, ["early", "overlap"]);
  } finally {
    spool.close();
  }
});

test("a persistently failing chunk is quarantined so later audio can release", async () => {
  const spool = new Spool(":memory:");
  const errors: Error[] = [];
  try {
    const poison = chunk({ path: "/tmp/raw/poison.wav" });
    const proc = createChunkProcessor(
      deps(spool, {
        onError: (error) => errors.push(error),
        embed: async (event) => {
          if (event.path.endsWith("poison.wav")) throw new Error("embed boom");
          return [1, 0, 0, 0];
        },
        transcribe: async (input) => [
          {
            text: input.wavPath.endsWith("poison.wav") ? "poison" : input.wavPath,
            startUtc: input.chunkStartedAtUtc,
            endUtc: input.chunkStartedAtUtc,
          },
        ],
      }),
    );
    proc.enqueue(poison);
    for (let i = 0; i < QUARANTINE_AFTER_FAILURES; i++) {
      proc.enqueue(
        chunk({
          path: `/tmp/raw/later-${i}.wav`,
          startedAtUtc: `2026-07-24T00:0${i + 2}:00.000Z`,
          endedAtUtc: `2026-07-24T00:0${i + 2}:30.000Z`,
        }),
      );
    }
    await proc.drain();

    const quarantined = spool.listPendingChunks("quarantined");
    assert.equal(quarantined.length, 1, "the poisoned chunk is parked");
    assert.equal(quarantined[0]?.id, chunkStableId(poison));
    assert.equal(quarantined[0]?.wavPath, poison.path, "its WAV path is retained for replay");
    const texts = spool
      .capturingConversationIds()
      .flatMap((id) => spool.conversationSegmentsForDedup(id).map((seg) => seg.text));
    assert.ok(
      texts.some((text) => text.includes("later-")),
      "later audio released after quarantine",
    );
    assert.equal(
      texts.includes("poison"),
      false,
      "the poisoned transcript is not appended",
    );
    assert.ok(errors.length >= QUARANTINE_AFTER_FAILURES);
  } finally {
    spool.close();
  }
});

test("a partial persist reseeds the assembler from durable spool rows", async () => {
  const spool = new Spool(":memory:");
  try {
    let appends = 0;
    let failSecond = true;
    const guarded = new Proxy(spool, {
      get(target, prop, receiver) {
        if (prop === "appendAssembledSegments") {
          return (input: Parameters<Spool["appendAssembledSegments"]>[0]) => {
            appends += 1;
            if (appends === 2 && failSecond) {
              failSecond = false;
              throw new Error("sqlite busy");
            }
            return target.appendAssembledSegments(input);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Spool;

    let minted = 0;
    const assembler = new ConversationAssembler({ gapMinutes: 0, makeId: () => `conv_${++minted}` });
    const proc = createChunkProcessor(
      deps(guarded, {
        assembler,
        transcribe: async () => [
          { text: "A", startUtc: t(1), endUtc: t(2) },
          { text: "B", startUtc: t(20), endUtc: t(21) },
          { text: "C", startUtc: t(40), endUtc: t(41) },
        ],
      }),
    );
    proc.enqueue(chunk());
    await proc.drain();
    assert.equal(spool.stats().segments, 1, "only the durable prefix landed");

    await proc.finalize();
    assert.equal(spool.stats().segments, 3, "the unpersisted suffix landed on retry");
    const page = spool.queryFinalConversations({ date: "2026-07-24", timezone: "UTC", limit: 10 });
    assert.deepEqual(
      page.conversations.map((conversation) => conversation.segments.map((seg) => seg.textRaw)),
      [["A"], ["B"], ["C"]],
      "each gap-separated segment kept its own conversation",
    );
  } finally {
    spool.close();
  }
});

test("startup scanner replays a pending record and an orphaned WAV", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "capture-orphan-"));
  const pendingPath = path.join(root, "pending.wav");
  const orphanPath = path.join(root, "orphan.wav");
  await writeFile(pendingPath, "pending");
  await writeFile(orphanPath, "orphan");

  const spool = new Spool(":memory:");
  try {
    const pendingEvent = chunk({
      path: pendingPath,
      channel: "system",
      startedAtUtc: "2026-07-24T00:00:00.000Z",
      endedAtUtc: "2026-07-24T00:00:30.000Z",
      device: "loopback",
    });
    spool.recordPendingChunk({
      id: chunkStableId(pendingEvent),
      wavPath: pendingEvent.path,
      startedAtUtc: pendingEvent.startedAtUtc,
      endedAtUtc: pendingEvent.endedAtUtc,
      channel: pendingEvent.channel,
      device: pendingEvent.device,
      reason: "evicted",
    });

    const recovered = scanOrphanedChunks({ rawDirectory: root, spool });
    assert.equal(recovered.length, 2, "pending row and leftover WAV both recover");
    const pending = recovered.find((event) => event.path === pendingPath);
    assert.ok(pending, "the pending record is present");
    assert.equal(pending.channel, "system");
    assert.equal(pending.startedAtUtc, pendingEvent.startedAtUtc);
    assert.ok(
      recovered.some((event) => event.path === orphanPath),
      "the orphaned WAV is present",
    );

    const proc = createChunkProcessor(
      deps(spool, {
        transcribe: async (input) => [
          {
            text: path.basename(input.wavPath, ".wav"),
            startUtc: input.chunkStartedAtUtc,
            endUtc: input.chunkStartedAtUtc,
          },
        ],
      }),
    );
    for (const event of recovered) proc.enqueue(event);
    await proc.finalize();
    assert.equal(spool.stats().segments, 2, "both recovered files produced segments");
    const days = ["2026-07-24", new Date().toISOString().slice(0, 10)];
    const texts = days.flatMap((date) =>
      spool
        .queryFinalConversations({ date, timezone: "UTC", limit: 10 })
        .conversations.flatMap((conversation) => conversation.segments.map((seg) => seg.textRaw)),
    );
    assert.ok(texts.includes("pending"));
    assert.ok(texts.includes("orphan"));
  } finally {
    spool.close();
  }
});

test("reorder-buffer eviction writes a durable pending-chunk record", async () => {
  const spool = new Spool(":memory:");
  try {
    const proc = createChunkProcessor(
      deps(spool, {
        reorderWindowMs: 24 * 60 * 60 * 1000,
        transcribe: async () => [],
      }),
    );
    const first = chunk({ path: "/tmp/raw/evict-0.wav" });
    proc.enqueue(first);
    for (let i = 1; i <= MAX_BUFFERED_CHUNKS; i++) {
      proc.enqueue(
        chunk({
          path: `/tmp/raw/evict-${i}.wav`,
          startedAtUtc: `2026-07-24T01:00:${String(i % 60).padStart(2, "0")}.000Z`,
          endedAtUtc: `2026-07-24T01:01:${String(i % 60).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await proc.drain();
    const pending = spool.listPendingChunks("evicted");
    assert.ok(pending.length >= 1, "eviction persisted a pending row");
    assert.equal(pending[0]?.id, chunkStableId(first));
    assert.equal(pending[0]?.wavPath, first.path);
    assert.equal(pending[0]?.channel, first.channel);
  } finally {
    spool.close();
  }
});
