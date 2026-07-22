import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { CaptureConfigError } from "./errors.js";
import {
  buildWhisperArgs,
  parseWhisperJson,
  resolveModelPath,
  runWhisperCli,
  transcribeWithWhisper,
} from "./stt.js";

test("parseWhisperJson converts segment offsets into chunk timestamps", () => {
  const result = parseWhisperJson(
    JSON.stringify({ transcription: [{ text: "Hello", offsets: { from: 500, to: 1500 } }] }),
    "2026-07-22T12:00:00.000Z",
  );

  assert.deepEqual(
    parseWhisperJson(
      JSON.stringify({ transcription: [{ text: "Hello", offsets: { from: 0, to: 1 } }] }),
      "2026-07-22T1:00:00Z",
    ),
    [{ text: "Hello", startUtc: "2026-07-22T01:00:00.000Z", endUtc: "2026-07-22T01:00:00.001Z" }],
  );
  assert.deepEqual(result, [{ text: "Hello", startUtc: "2026-07-22T12:00:00.500Z", endUtc: "2026-07-22T12:00:01.500Z" }]);
});

test("parseWhisperJson rejects malformed output", () => {
  assert.throws(() => parseWhisperJson("not JSON", "2026-07-22T12:00:00.000Z"), CaptureConfigError);
  assert.throws(
    () => parseWhisperJson(JSON.stringify({ transcription: [null] }), "2026-07-22T12:00:00.000Z"),
    CaptureConfigError,
  );
  assert.throws(
    () =>
      parseWhisperJson(
        JSON.stringify({ transcription: [{ text: "Hello", offsets: { from: 0, to: 1 } }] }),
        "2026-02-31T00:00:00.000Z",
      ),
    CaptureConfigError,
  );
  assert.throws(() => parseWhisperJson(JSON.stringify({ transcription: [{}] }), "2026-07-22T12:00:00.000Z"), CaptureConfigError);
});

test("resolveModelPath prefers a configured readable model", () => {
  const exists = (file: string) => file === "/configured.bin";
  assert.equal(resolveModelPath("/configured.bin", "/default.bin", exists), "/configured.bin");
  assert.throws(() => resolveModelPath("/missing.bin", "/default.bin", exists), /not found/);
  assert.equal(
    resolveModelPath("~/configured.bin", "/default.bin", (file) => file === path.join(process.env.HOME!, "configured.bin")),
    path.join(process.env.HOME!, "configured.bin"),
  );
  assert.throws(() => resolveModelPath("/directory", "/default.bin", () => false), /not found/);
  assert.throws(() => resolveModelPath(process.cwd(), "/default.bin"), /not found/);
});

test("resolveModelPath uses the default model only when no explicit model is configured", () => {
  const exists = (file: string) => file === "/default.bin";
  assert.equal(resolveModelPath(undefined, "/default.bin", exists), "/default.bin");
});

test("buildWhisperArgs requests JSON output without shell interpolation", () => {
  assert.deepEqual(buildWhisperArgs("/audio/chunk.wav", "/models/model.bin"), [
    "-m",
    "/models/model.bin",
    "-f",
    "/audio/chunk.wav",
    "--output-json",
    "--output-file",
    "-",
  ]);
});

test("transcribeWithWhisper parses successful subprocess output", async () => {
  const segments = await transcribeWithWhisper({
    wavPath: "/audio/chunk.wav",
    modelPath: "/models/model.bin",
    chunkStartedAtUtc: "2026-07-22T12:00:00.000Z",
    run: async (command, args) => {
      assert.equal(command, "whisper-cli");
      assert.deepEqual(args, buildWhisperArgs("/audio/chunk.wav", "/models/model.bin"));
      return {
        code: 0,
        stdout: JSON.stringify({ transcription: [{ text: "Ready", offsets: { from: 0, to: 250 } }] }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(segments, [{ text: "Ready", startUtc: "2026-07-22T12:00:00.000Z", endUtc: "2026-07-22T12:00:00.250Z" }]);
});

test("transcribeWithWhisper makes a failed subprocess actionable", async () => {
  await assert.rejects(
    () =>
      transcribeWithWhisper({
        wavPath: "/audio/chunk.wav",
        modelPath: "/models/model.bin",
        chunkStartedAtUtc: "2026-07-22T12:00:00.000Z",
        run: async () => ({ code: 1, stdout: "", stderr: "model unavailable" }),
      }),
    /whisper-cli failed with exit code 1/,
  );
});

test("runWhisperCli returns stdout and stderr from an argv-only subprocess", async () => {
  const result = await runWhisperCli(process.execPath, [
    "-e",
    'process.stdout.write("out"); process.stderr.write("err")',
  ]);

  assert.deepEqual(result, { code: 0, stdout: "out", stderr: "err" });
});
