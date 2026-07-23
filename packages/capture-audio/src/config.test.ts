import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";

import { defaultDaemonConfig, parseDaemonConfig, serializeDaemonConfig } from "./config.js";
import { CaptureConfigError } from "./errors.js";
import { captureBaseDir } from "./paths.js";

test("defaults are returned for an empty config object", () => {
  const cfg = parseDaemonConfig({});
  assert.deepEqual(cfg, defaultDaemonConfig());
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 4340);
});

test("valid overrides parse and boolean-like coercion applies to numbers", () => {
  const cfg = parseDaemonConfig({
    host: "0.0.0.0",
    port: "8080",
    conversationGapMinutes: 5,
    stt: { engine: "whisper-cpp", modelPath: "/models/x.bin", threads: 4 },
    denyApps: ["Zoom", "Slack"],
  });
  assert.equal(cfg.host, "0.0.0.0");
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.stt.modelPath, "/models/x.bin");
  assert.equal(cfg.stt.threads, 4);
  assert.deepEqual(cfg.denyApps, ["Zoom", "Slack"]);
});

test("an empty STT model path uses the default model", () => {
  assert.equal(parseDaemonConfig({ stt: { modelPath: "" } }).stt.modelPath, null);
});

test("VAD options use the same valid ranges as the runtime adapter", () => {
  const cfg = parseDaemonConfig({
    vad: {
      modelPath: "/models/silero_vad.onnx",
      minSpeechMs: 500,
      minSilenceMs: 400,
      maxSpeechMs: 20_000,
      threshold: 0.7,
      threads: 2,
    },
  });
  assert.deepEqual(cfg.vad, {
    modelPath: "/models/silero_vad.onnx",
    minSpeechMs: 500,
    minSilenceMs: 400,
    maxSpeechMs: 20_000,
    threshold: 0.7,
    threads: 2,
  });
  assert.throws(() => parseDaemonConfig({ vad: { minSpeechMs: 0 } }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ vad: { threshold: 1 } }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ vad: { threshold: 0 } }), CaptureConfigError);
  assert.equal(parseDaemonConfig({ vad: { modelPath: null } }).vad.modelPath, null);
  assert.throws(() => parseDaemonConfig({ vad: { minSpeechMs: 40_000, maxSpeechMs: 30_000 } }), CaptureConfigError);
});

test("non-integer / out-of-range port is rejected loudly", () => {
  assert.throws(() => parseDaemonConfig({ port: 70000 }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ port: 4340.5 }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ port: 0 }), CaptureConfigError);
});

test("the string \"false\" is not a valid number and is rejected (no silent default)", () => {
  assert.throws(() => parseDaemonConfig({ port: "false" }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ chunkSeconds: "false" }), CaptureConfigError);
});

test("unknown stt engine is rejected", () => {
  assert.throws(
    () => parseDaemonConfig({ stt: { engine: "deepgram" } }),
    /only 'whisper-cpp' is supported/,
  );
});

test("similarityThreshold out of [0,1] is rejected", () => {
  assert.throws(() => parseDaemonConfig({ diarization: { similarityThreshold: 1.5 } }), CaptureConfigError);
});

test("wrong types for structured fields are rejected", () => {
  assert.throws(() => parseDaemonConfig({ denyApps: "Zoom" }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ vad: [] }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig(null), CaptureConfigError);
  assert.throws(() => parseDaemonConfig("nope"), CaptureConfigError);
});

test("absent optional field keeps its default; only present-invalid throws", () => {
  const cfg = parseDaemonConfig({ port: 4341 });
  assert.equal(cfg.spoolRetentionDays, 30);
  assert.equal(cfg.rawRetentionHours, 0);
});

test("captureBaseDir expands a tilde override", () => {
  assert.equal(captureBaseDir({ REMNIC_CAPTURE_DIR: "~" }), process.env.HOME);
  assert.equal(captureBaseDir({ REMNIC_CAPTURE_DIR: "~/capture-test" }), path.join(process.env.HOME!, "capture-test"));
});

test("the config init writes round-trips through the parser (regression)", () => {
  const written = serializeDaemonConfig(defaultDaemonConfig());
  const reparsed = parseDaemonConfig(JSON.parse(written));
  assert.deepEqual(reparsed, defaultDaemonConfig());
});

test("null is accepted as absent for optional nullable fields", () => {
  const cfg = parseDaemonConfig({
    stt: { engine: "whisper-cpp", modelPath: null, threads: null },
    devices: { mic: null, system: null },
  });
  assert.equal(cfg.stt.modelPath, null);
  assert.equal(cfg.stt.threads, null);
  assert.equal(cfg.devices.mic, null);
  assert.equal(cfg.devices.system, null);
});
