import assert from "node:assert/strict";
import test from "node:test";

import { cmdCapture, INSTALL_HINT, translateCaptureLoadError, type CaptureAudioModule } from "./capture-dispatch.js";

function io(): { stdout: (l: string) => void; stderr: (l: string) => void; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

test("cmdCapture forwards `audio <sub...>` argv to the loaded package runCapture", async () => {
  let seenArgv: string[] | undefined;
  const mod: CaptureAudioModule = {
    async runCapture({ argv }) {
      seenArgv = argv;
      return 0;
    },
  };
  const sink = io();
  const code = await cmdCapture(["audio", "status", "--base-dir", "/tmp/x"], {
    stdout: sink.stdout,
    stderr: sink.stderr,
    loadCaptureAudio: async () => mod,
  });
  assert.equal(code, 0);
  assert.deepEqual(seenArgv, ["status", "--base-dir", "/tmp/x"]);
});

test("cmdCapture surfaces a loader install-hint failure to stderr with a non-zero code", async () => {
  const sink = io();
  const code = await cmdCapture(["audio", "status"], {
    stdout: sink.stdout,
    stderr: sink.stderr,
    loadCaptureAudio: async () => {
      throw new Error(INSTALL_HINT);
    },
  });
  assert.equal(code, 2);
  assert.ok(sink.err.some((l) => l.includes("npm install @remnic/capture-audio")), sink.err.join("|"));
});

test("cmdCapture rejects an unknown subgroup and prints usage; bare `capture` shows usage", async () => {
  const a = io();
  assert.equal(await cmdCapture(["screen"], { stdout: a.stdout, stderr: a.stderr }), 2);
  assert.ok(a.err.join(" ").includes("unknown capture subgroup"));

  const b = io();
  assert.equal(await cmdCapture([], { stdout: b.stdout, stderr: b.stderr }), 2);
  assert.ok(b.out.join(" ").includes("remnic capture audio"));
});

test("translateCaptureLoadError maps a missing-package error to the install hint, rethrows others", () => {
  const notFound = Object.assign(new Error("Cannot find package '@remnic/capture-audio' imported from cli"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  assert.equal(translateCaptureLoadError(notFound).message, INSTALL_HINT);

  // A broken transitive dep (different specifier) is NOT the install-hint case.
  const innerMiss = Object.assign(new Error("Cannot find package 'some-inner-dep' imported from capture-audio"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  assert.notEqual(translateCaptureLoadError(innerMiss).message, INSTALL_HINT);
  assert.equal(translateCaptureLoadError(innerMiss), innerMiss);

  const other = new Error("boom");
  assert.equal(translateCaptureLoadError(other), other);
});
