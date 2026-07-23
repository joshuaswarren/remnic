import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";

import { CaptureInputError } from "./errors.js";
import { decodeCursor, encodeCursor, parseTranscriptDate } from "./validate.js";

test("parseTranscriptDate accepts early years (0000-0099) and rejects impossible dates", () => {
  assert.equal(parseTranscriptDate("0001-02-28"), "0001-02-28");
  assert.equal(parseTranscriptDate("0099-12-31"), "0099-12-31");
  assert.throws(() => parseTranscriptDate("2026-02-30"), CaptureInputError);
  assert.throws(() => parseTranscriptDate("2026-13-01"), CaptureInputError);
  assert.throws(() => parseTranscriptDate("nope"), CaptureInputError);
});

test("decodeCursor round-trips valid tokens and rejects malformed values", () => {
  const good = encodeCursor("2026-07-20T10:00:00.000Z", "conv_1");
  assert.deepEqual(decodeCursor(good), { startedAtUtc: "2026-07-20T10:00:00.000Z", id: "conv_1" });
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor(""), null);

  const nonIso = Buffer.from(JSON.stringify(["not-a-timestamp", "id"]), "utf8").toString("base64url");
  const emptyId = Buffer.from(JSON.stringify(["2026-07-20T10:00:00.000Z", ""]), "utf8").toString("base64url");
  const wrongShape = Buffer.from(JSON.stringify({ a: 1 }), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(nonIso), CaptureInputError);
  assert.throws(() => decodeCursor(emptyId), CaptureInputError);
  assert.throws(() => decodeCursor(wrongShape), CaptureInputError);
  assert.throws(() => decodeCursor("!!!not-a-token"), CaptureInputError);
});
