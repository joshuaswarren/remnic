import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import test from "node:test";

import { createSileroVad, loadSherpaOnnx, resolveSherpaExport } from "./vad.js";

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

test("createSileroVad expands a tilde model path", async () => {
  let received: { config: { sileroVad: { model: string } } } | undefined;
  class FakeVad {
    constructor(config: unknown, _bufferSeconds: number) {
      received = { config: config as { sileroVad: { model: string } } };
    }
  }

  await createSileroVad({ modelPath: "~/models/silero_vad.onnx", minSpeechMs: 500 }, async () => ({ Vad: FakeVad }));

  assert.equal(received?.config.sileroVad.model, path.join(os.homedir(), "models/silero_vad.onnx"));
});

test("createSileroVad requires a positive speech threshold", async () => {
  await assert.rejects(createSileroVad({ modelPath: "/models/vad.onnx", minSpeechMs: 0 }), /positive/);
});

test("resolveSherpaExport unwraps a CommonJS default export", () => {
  class FakeVad {}
  const cjs = { default: { Vad: FakeVad } };
  assert.equal(resolveSherpaExport(cjs), cjs.default);
});

test("resolveSherpaExport accepts an ES namespace that exposes Vad directly", () => {
  class FakeVad {}
  const esm = { Vad: FakeVad };
  assert.equal(resolveSherpaExport(esm), esm);
});

test("resolveSherpaExport returns null when no Vad constructor is present", () => {
  assert.equal(resolveSherpaExport({ default: { notVad: 1 } }), null);
  assert.equal(resolveSherpaExport(null), null);
});

test("loadSherpaOnnx reports the install hint only when the package itself is missing", async () => {
  const notFound = Object.assign(new Error("Cannot find package 'sherpa-onnx-node' imported from vad.js"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  await assert.rejects(
    loadSherpaOnnx(async () => {
      throw notFound;
    }),
    /install it before enabling VAD/,
  );
});

test("loadSherpaOnnx surfaces a broken installed native addon without leaking paths or an install hint", async () => {
  const dlopenFailure = Object.assign(new Error("dlopen failed: /home/user/node_modules/sherpa-onnx-node/build/Release/x.node"), {
    code: "ERR_DLOPEN_FAILED",
  });
  await assert.rejects(loadSherpaOnnx(async () => {
    throw dlopenFailure;
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /could not load the installed sherpa-onnx-node native runtime/);
    assert.doesNotMatch(error.message, /install it before enabling VAD/);
    assert.doesNotMatch(error.message, /dlopen|\.node|node_modules/);
    return true;
  });
});

test("loadSherpaOnnx treats an installed package with a missing native module (require stack) as broken, not absent", async () => {
  const nativeMissing = Object.assign(
    new Error("Cannot find module '/app/node_modules/sherpa-onnx-node/build/Release/sherpa-onnx-node.node'"),
    { code: "MODULE_NOT_FOUND", requireStack: ["/app/node_modules/sherpa-onnx-node/index.js"] },
  );
  await assert.rejects(loadSherpaOnnx(async () => {
    throw nativeMissing;
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /could not load the installed sherpa-onnx-node native runtime/);
    assert.doesNotMatch(error.message, /install it before enabling VAD/);
    return true;
  });
});

test("loadSherpaOnnx unwraps a CommonJS module returned by the importer", async () => {
  class FakeVad {}
  const resolved = await loadSherpaOnnx(async () => ({ default: { Vad: FakeVad } }));
  assert.equal(resolved.Vad, FakeVad);
});
