import assert from "node:assert/strict";
import test from "node:test";

import { createSileroVad } from "./vad.js";

test("createSileroVad configures the optional Sherpa runtime with audio-safe defaults", async () => {
  let received: unknown;
  class FakeVad {
    constructor(config: unknown, bufferSeconds: number) {
      received = { config, bufferSeconds };
    }
  }

  const vad = await createSileroVad(
    { modelPath: "/models/silero_vad.onnx", minSpeechMs: 500 },
    async () => ({ Vad: FakeVad }),
  );

  assert.ok(vad instanceof FakeVad);
  assert.deepEqual(received, {
    config: {
      sileroVad: {
        model: "/models/silero_vad.onnx",
        threshold: 0.5,
        minSpeechDuration: 0.5,
        minSilenceDuration: 0.5,
        maxSpeechDuration: 30,
        windowSize: 512,
      },
      sampleRate: 16_000,
      debug: false,
      numThreads: 1,
    },
    bufferSeconds: 60,
  });
});

test("createSileroVad requires a positive speech threshold", async () => {
  await assert.rejects(createSileroVad({ modelPath: "/models/vad.onnx", minSpeechMs: 0 }), /positive/);
});
