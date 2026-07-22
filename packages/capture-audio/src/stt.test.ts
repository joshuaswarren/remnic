import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureConfigError } from "./errors.js";
import { parseWhisperJson, resolveModelPath } from "./stt.js";

test("parseWhisperJson converts segment offsets into chunk timestamps", () => {
  const result = parseWhisperJson(
    JSON.stringify({ transcription: [{ text: "Hello", offsets: { from: 500, to: 1500 } }] }),
    "2026-07-22T12:00:00.000Z",
  );

  assert.deepEqual(result, [{ text: "Hello", startUtc: "2026-07-22T12:00:00.500Z", endUtc: "2026-07-22T12:00:01.500Z" }]);
});

test("parseWhisperJson rejects malformed output", () => {
  assert.throws(() => parseWhisperJson("not JSON", "2026-07-22T12:00:00.000Z"), CaptureConfigError);
  assert.throws(() => parseWhisperJson(JSON.stringify({ transcription: [{}] }), "2026-07-22T12:00:00.000Z"), CaptureConfigError);
});

test("resolveModelPath prefers a configured readable model", () => {
  const exists = (file: string) => file === "/configured.bin";
  assert.equal(resolveModelPath("/configured.bin", "/default.bin", exists), "/configured.bin");
  assert.throws(() => resolveModelPath("/missing.bin", "/default.bin", exists), /not found/);
});

test("resolveModelPath uses the default model only when no explicit model is configured", () => {
  const exists = (file: string) => file === "/default.bin";
  assert.equal(resolveModelPath(undefined, "/default.bin", exists), "/default.bin");
});
