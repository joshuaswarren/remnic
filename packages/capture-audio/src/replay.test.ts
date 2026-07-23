import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { CaptureConfigError } from "./errors.js";
import { ingestReplayDir } from "./replay.js";
import { Spool } from "./spool.js";

const createdDirs: string[] = [];
after(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-replay-"));
  createdDirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
  }
  return dir;
}

test("ingests synthetic fixtures into the spool and serves them final-only", () => {
  const dir = fixtureDir({
    "01.json": {
      id: "conv_meeting",
      startedAtUtc: "2026-07-20T15:00:00.000Z",
      endedAtUtc: "2026-07-20T15:05:00.000Z",
      device: "MacBook mic",
      speakers: [{ id: "spk_1", label: "Alice", isSelf: false }, { id: "self", label: "Me", isSelf: true }],
      segments: [
        { speakerCluster: "self", isWearer: true, channel: "mic", text: "kickoff", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:04.000Z" },
        { speakerCluster: "spk_1", isWearer: false, channel: "system", text: "sounds good", startUtc: "2026-07-20T15:00:05.000Z", endUtc: "2026-07-20T15:00:08.000Z" },
      ],
    },
    "02.json": [
      {
        id: "conv_hallway",
        startedAtUtc: "2026-07-20T16:00:00.000Z",
        segments: [{ channel: "mic", text: "quick chat", startUtc: "2026-07-20T16:00:00.000Z", endUtc: "2026-07-20T16:00:02.000Z" }],
      },
      {
        id: "conv_live",
        startedAtUtc: "2026-07-20T17:00:00.000Z",
        state: "capturing",
        segments: [{ channel: "mic", text: "in progress", startUtc: "2026-07-20T17:00:00.000Z", endUtc: "2026-07-20T17:00:02.000Z" }],
      },
    ],
  });

  const spool = new Spool(":memory:");
  const result = ingestReplayDir(spool, dir);
  assert.equal(result.files, 2);
  assert.equal(result.conversationsIngested, 3);
  assert.equal(result.segmentsIngested, 4);

  const page = spool.queryFinalConversations({ date: "2026-07-20", timezone: "UTC", limit: 10 });
  assert.deepEqual(page.conversations.map((c) => c.id), ["conv_meeting", "conv_hallway"]);
  assert.deepEqual(spool.listSpeakers().map((s) => s.id), ["self", "spk_1"]);
  spool.close();
});

test("replay is idempotent: re-ingesting the same fixtures changes nothing", () => {
  const dir = fixtureDir({
    "a.json": {
      id: "conv_a",
      startedAtUtc: "2026-07-20T15:00:00.000Z",
      segments: [{ channel: "mic", text: "hi", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }],
    },
  });
  const spool = new Spool(":memory:");
  ingestReplayDir(spool, dir);
  const before = spool.stats();
  ingestReplayDir(spool, dir);
  assert.deepEqual(spool.stats(), before);
  spool.close();
});

test("malformed fixtures are rejected loudly", () => {
  const spool = new Spool(":memory:");
  assert.throws(() => ingestReplayDir(spool, fixtureDir({ "bad.json": { startedAtUtc: "2026-07-20T15:00:00.000Z" } })), CaptureConfigError);
  assert.throws(() => ingestReplayDir(spool, fixtureDir({ "bad.json": { segments: [] } })), CaptureConfigError);

  const empty = mkdtempSync(path.join(tmpdir(), "cap-empty-"));
  createdDirs.push(empty);
  assert.throws(() => ingestReplayDir(spool, empty), /no \*\.json fixtures/);
  assert.throws(() => ingestReplayDir(spool, path.join(tmpdir(), "definitely-missing-xyz")), CaptureConfigError);
  spool.close();
});

test("replay rejects unknown states, bad timestamps, and present-but-invalid fields", () => {
  const spool = new Spool(":memory:");
  for (const fixture of [
    { startedAtUtc: "2026-07-20T10:00:00.000Z", state: "finished", segments: [] },
    { startedAtUtc: "not-a-timestamp", segments: [] },
    { startedAtUtc: "2026-07-20T10:00:00.000Z", endedAtUtc: "2026-07-20T09:00:00.000Z", segments: [] },
    { startedAtUtc: "2026-07-20T10:00:00.000Z", id: 7, segments: [] },
    { startedAtUtc: "2026-07-20T10:00:00.000Z", device: 7, segments: [] },
    {
      startedAtUtc: "2026-07-20T10:00:00.000Z",
      segments: [{ channel: "mic", text: "bad", startUtc: "2026-07-20T10:00:01.000Z", endUtc: "not-a-timestamp" }],
    },
    {
      startedAtUtc: "2026-07-20T10:00:00.000Z",
      segments: [{ channel: 7, text: "bad", startUtc: "2026-07-20T10:00:00.000Z", endUtc: "2026-07-20T10:00:01.000Z" }],
    },
    {
      startedAtUtc: "2026-07-20T10:00:00.000Z",
      segments: [{ speakerCluster: 7, channel: "mic", text: "bad", startUtc: "2026-07-20T10:00:00.000Z", endUtc: "2026-07-20T10:00:01.000Z" }],
    },
  ]) {
    assert.throws(() => ingestReplayDir(spool, fixtureDir({ "bad.json": fixture })), CaptureConfigError);
  }
  assert.deepEqual(spool.stats(), { conversations: 0, segments: 0, chunks: 0 });
  spool.close();
});

test("a malformed conversation does not persist its speakers", () => {
  const spool = new Spool(":memory:");
  const dir = fixtureDir({
    "bad.json": {
      startedAtUtc: "2026-07-20T10:00:00.000Z",
      state: "finished", // invalid → conversation rejected before speakers upsert
      speakers: [{ id: "spk_ghost", label: "Ghost" }],
      segments: [],
    },
  });
  assert.throws(() => ingestReplayDir(spool, dir), CaptureConfigError);
  assert.deepEqual(spool.listSpeakers(), []);
  spool.close();
});

test("id-less fixtures get a deterministic id and stay idempotent across replays", () => {
  const dir = fixtureDir({
    "noid.json": {
      startedAtUtc: "2026-07-20T15:00:00.000Z",
      segments: [{ channel: "mic", text: "hi", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }],
    },
  });
  const spool = new Spool(":memory:");
  const first = ingestReplayDir(spool, dir);
  const before = spool.stats();
  const second = ingestReplayDir(spool, dir);
  assert.deepEqual(first.ids, second.ids);
  assert.deepEqual(spool.stats(), before);
  assert.equal(before.conversations, 1);
  spool.close();
});

test("id-less fixtures derive ids from content: same content collapses, distinct content does not collide", () => {
  const spool = new Spool(":memory:");
  // Same start time + same filename/index across two dirs, but DIFFERENT segment content.
  const mk = (text: string) => ({
    "01.json": {
      startedAtUtc: "2026-07-20T15:00:00.000Z",
      segments: [{ channel: "mic", text, startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }],
    },
  });
  const a = ingestReplayDir(spool, fixtureDir(mk("first meeting")));
  const b = ingestReplayDir(spool, fixtureDir(mk("second meeting")));
  assert.notEqual(a.ids[0], b.ids[0]); // distinct content -> no collision
  assert.equal(spool.stats().conversations, 2);
  // identical content re-ingested collapses to the same id
  const c = ingestReplayDir(spool, fixtureDir(mk("first meeting")));
  assert.equal(c.ids[0], a.ids[0]);
  assert.equal(spool.stats().conversations, 2);
  spool.close();
});

test("a late-failing fixture batch leaves zero writes (validate-all-then-commit)", () => {
  const spool = new Spool(":memory:");
  const dir = fixtureDir({
    // 01 is fully valid, with speakers and a conversation.
    "01.json": {
      id: "conv_ok",
      startedAtUtc: "2026-07-20T15:00:00.000Z",
      speakers: [{ id: "spk_1", label: "Alice" }],
      segments: [{ channel: "mic", text: "hi", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }],
    },
    // 02 sorts after 01 and is invalid (bad state) -> must abort before ANY write.
    "02.json": {
      startedAtUtc: "2026-07-20T16:00:00.000Z",
      state: "finished",
      speakers: [{ id: "spk_2" }],
      segments: [],
    },
  });
  assert.throws(() => ingestReplayDir(spool, dir), CaptureConfigError);
  assert.deepEqual(spool.stats(), { conversations: 0, segments: 0, chunks: 0 });
  assert.deepEqual(spool.listSpeakers(), []); // earlier file's valid speakers were not persisted
  spool.close();
});

test("an invalid speaker later in the list persists no speakers", () => {
  const spool = new Spool(":memory:");
  const dir = fixtureDir({
    "x.json": {
      startedAtUtc: "2026-07-20T15:00:00.000Z",
      speakers: [{ id: "spk_1", label: "Alice" }, { id: "" }], // second is invalid
      segments: [{ channel: "mic", text: "hi", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }],
    },
  });
  assert.throws(() => ingestReplayDir(spool, dir), CaptureConfigError);
  assert.deepEqual(spool.listSpeakers(), []);
  assert.deepEqual(spool.stats(), { conversations: 0, segments: 0, chunks: 0 });
  spool.close();
});
