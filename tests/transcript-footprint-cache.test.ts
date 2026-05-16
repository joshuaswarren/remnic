import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { TranscriptManager } from "../src/transcript.ts";

function makeLine(sessionKey: string, content: string): string {
  return `${JSON.stringify({ sessionKey, role: "user", content })}\n`;
}

test("estimateSessionFootprint updates cached totals from newest shard growth", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-footprint-"));
  try {
    const transcript = new TranscriptManager({
      memoryDir: dir,
      transcriptSkipChannelTypes: [],
    } as any);

    const sessionKey = "agent:generalist:main";
    const { dir: relDir } = transcript.getTranscriptPath(sessionKey);
    const channelDir = path.join(dir, "transcripts", relDir);
    await mkdir(channelDir, { recursive: true });

    const oldShard = path.join(channelDir, "2026-02-24.jsonl");
    const newShard = path.join(channelDir, "2026-02-25.jsonl");
    const oldOwn = makeLine(sessionKey, "old-own");
    const oldOther = makeLine("agent:other:main", "old-other");
    const newOwn = makeLine(sessionKey, "new-own");
    const newOther = makeLine("agent:other:main", "new-other");
    await writeFile(oldShard, `${oldOwn}${oldOther}`, "utf-8");
    await writeFile(newShard, `${newOwn}${newOther}`, "utf-8");

    const first = await transcript.estimateSessionFootprint(sessionKey);
    assert.equal(first.bytes, Buffer.byteLength(oldOwn) + Buffer.byteLength(newOwn));

    const newOwnGrowth = makeLine(sessionKey, "new-own-growth");
    await writeFile(newShard, `${newOwn}${newOwnGrowth}${newOther}`, "utf-8");
    const second = await transcript.estimateSessionFootprint(sessionKey);
    assert.equal(
      second.bytes,
      Buffer.byteLength(oldOwn) + Buffer.byteLength(newOwn) + Buffer.byteLength(newOwnGrowth),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("estimateSessionFootprint cache handles shard removal and new shard addition", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-footprint-rotate-"));
  try {
    const transcript = new TranscriptManager({
      memoryDir: dir,
      transcriptSkipChannelTypes: [],
    } as any);

    const sessionKey = "agent:generalist:main";
    const { dir: relDir } = transcript.getTranscriptPath(sessionKey);
    const channelDir = path.join(dir, "transcripts", relDir);
    await mkdir(channelDir, { recursive: true });

    const shardA = path.join(channelDir, "2026-02-23.jsonl");
    const shardB = path.join(channelDir, "2026-02-24.jsonl");
    const aOwn = makeLine(sessionKey, "a-own");
    const bOwn = makeLine(sessionKey, "b-own");
    await writeFile(shardA, aOwn, "utf-8");
    await writeFile(shardB, bOwn, "utf-8");

    const first = await transcript.estimateSessionFootprint(sessionKey);
    assert.equal(first.bytes, Buffer.byteLength(aOwn) + Buffer.byteLength(bOwn));

    await unlink(shardA);
    const shardC = path.join(channelDir, "2026-02-25.jsonl");
    const cOwn = makeLine(sessionKey, "c-own");
    await writeFile(shardC, cOwn, "utf-8");

    const second = await transcript.estimateSessionFootprint(sessionKey);
    assert.equal(second.bytes, Buffer.byteLength(bOwn) + Buffer.byteLength(cOwn));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("estimateSessionFootprint refreshes encoded shard growth when legacy directory also exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-transcript-footprint-mixed-"));
  try {
    const transcript = new TranscriptManager({
      memoryDir: dir,
      transcriptSkipChannelTypes: [],
    } as any);

    const sessionKey = "agent:bot:custom:nightly.summary";
    const { dir: encodedDir, legacyDir } = transcript.getTranscriptPath(sessionKey);
    assert.equal(encodedDir, "custom/nightly%2Esummary");
    assert.equal(legacyDir, "custom/nightly.summary");

    const encodedChannelDir = path.join(dir, "transcripts", encodedDir);
    const legacyChannelDir = path.join(dir, "transcripts", legacyDir!);
    await mkdir(encodedChannelDir, { recursive: true });
    await mkdir(legacyChannelDir, { recursive: true });

    const encodedShard = path.join(encodedChannelDir, "2026-02-25.jsonl");
    const legacyShard = path.join(legacyChannelDir, "2026-02-25.jsonl");
    const encodedOwn = makeLine(sessionKey, "encoded-own");
    const legacyOwn = makeLine(sessionKey, "legacy-own");
    await writeFile(encodedShard, encodedOwn, "utf-8");
    await writeFile(legacyShard, legacyOwn, "utf-8");

    const first = await transcript.estimateSessionFootprint(sessionKey);
    assert.equal(first.bytes, Buffer.byteLength(encodedOwn) + Buffer.byteLength(legacyOwn));

    const encodedGrowth = makeLine(sessionKey, "encoded-growth");
    await writeFile(encodedShard, `${encodedOwn}${encodedGrowth}`, "utf-8");

    const second = await transcript.estimateSessionFootprint(sessionKey);
    assert.equal(
      second.bytes,
      Buffer.byteLength(encodedOwn) + Buffer.byteLength(encodedGrowth) + Buffer.byteLength(legacyOwn),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
