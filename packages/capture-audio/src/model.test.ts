import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CaptureConfigError } from "./errors.js";
import { downloadWhisperModel, whisperModelUrl } from "./model.js";

test("whisperModelUrl maps supported model identifiers to official model files", () => {
  assert.equal(
    whisperModelUrl("large-v3-turbo-q5_0"),
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  );
  assert.throws(() => whisperModelUrl("unknown"), CaptureConfigError);
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => whisperModelUrl(key), CaptureConfigError, `prototype key ${key} must be rejected`);
  }
});

test("downloadWhisperModel streams to an atomic destination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capture-model-"));
  try {
    const result = await downloadWhisperModel({
      model: "small",
      directory,
      fetch: async () => new Response("model-bytes"),
    });

    assert.equal(result.downloaded, true);
    assert.equal(await readFile(result.path, "utf8"), "model-bytes");
    assert.deepEqual(await readdir(directory), ["ggml-small.bin"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadWhisperModel rejects failed responses without writing a model", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capture-model-"));
  try {
    await assert.rejects(
      downloadWhisperModel({
        model: "base",
        directory,
        fetch: async () => new Response("unavailable", { status: 503 }),
      }),
      CaptureConfigError,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadWhisperModel rejects an existing non-file destination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capture-model-"));
  try {
    await mkdir(path.join(directory, "ggml-small.bin"));
    await assert.rejects(downloadWhisperModel({ model: "small", directory }), /regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("downloadWhisperModel treats a symlink to an existing model file as already present", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capture-model-"));
  try {
    const realModel = path.join(directory, "real-model.bin");
    await writeFile(realModel, "model-bytes");
    await symlink(realModel, path.join(directory, "ggml-small.bin"));
    let fetched = false;
    const result = await downloadWhisperModel({
      model: "small",
      directory,
      fetch: async () => {
        fetched = true;
        return new Response("should-not-download");
      },
    });
    assert.equal(result.downloaded, false);
    assert.equal(fetched, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
