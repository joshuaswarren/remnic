import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CaptureConfigError } from "./errors.js";
import { ingestReplayDir } from "./replay.js";
import { Spool } from "./spool.js";

function fixtureDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cap-replay-"));
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
  const noSegs = fixtureDir({ "bad.json": { startedAtUtc: "2026-07-20T15:00:00.000Z" } });
  assert.throws(() => ingestReplayDir(spool, noSegs), CaptureConfigError);

  const noStart = fixtureDir({ "bad.json": { segments: [] } });
  assert.throws(() => ingestReplayDir(spool, noStart), CaptureConfigError);

  const empty = mkdtempSync(path.join(tmpdir(), "cap-empty-"));
  assert.throws(() => ingestReplayDir(spool, empty), /no \*\.json fixtures/);

  assert.throws(() => ingestReplayDir(spool, path.join(tmpdir(), "definitely-missing-xyz")), CaptureConfigError);
  spool.close();
});
