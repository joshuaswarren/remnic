import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { pwDump, defaultDevices } from "./pipewire.mjs";
import { BYTES_PER_SECOND, RATE, wavFile } from "./wav.mjs";

/** A trailing piece shorter than this is dropped on stop; it holds no speech. */
const MIN_FLUSH_BYTES = BYTES_PER_SECOND / 10;
const SAMPLE_BYTES = 2;

/**
 * Cut a raw PCM stream into chunks of exactly `bytesPerChunk` bytes. `emit(pcm, offsetBytes)` gets each
 * chunk with the stream offset of its first byte, so timestamps come from sample counts and chunks never gap.
 */
export function createChunker(bytesPerChunk, emit) {
  let pending = Buffer.alloc(0);
  let offset = 0;
  return {
    push(data) {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= bytesPerChunk) {
        emit(pending.subarray(0, bytesPerChunk), offset);
        offset += bytesPerChunk;
        pending = pending.subarray(bytesPerChunk);
      }
    },
    flush() {
      const whole = pending.subarray(0, pending.length - (pending.length % SAMPLE_BYTES));
      if (whole.length >= MIN_FLUSH_BYTES) emit(whole, offset);
      pending = Buffer.alloc(0);
    },
  };
}

/**
 * pw-record writes raw samples to `-` on every release, but names the format with `--container raw` only from
 * PipeWire 1.6; older releases reject that option. Ask the installed binary which it is.
 */
function recorderHasContainer() {
  return new Promise((resolve) => {
    execFile("pw-record", ["--help"], (error, stdout, stderr) => resolve(!error && /--container\b/.test(`${stdout}${stderr}`)));
  });
}

function recorderArgs(system, target, container) {
  const args = ["--rate", String(RATE), "--channels", "1", "--format", "s16"];
  if (container) args.push("--container", "raw");
  if (target) args.push("--target", target);
  if (system) args.push("-P", "{ stream.capture.sink=true }");
  return [...args, "-"];
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Start one pw-record for `channel`; resolves `{ stopped, status }` once it has exited and its last chunk is written.
 * A chunk that cannot be written stops this recorder, and `finished` rejects with that error once it has exited.
 */
function startRecorder({ channel, target, container, outDir, chunkSeconds, announce }) {
  const args = recorderArgs(channel === "system", target, container);
  const child = spawn("pw-record", args, { stdio: ["ignore", "pipe", "pipe"] });
  let streamStartMs = null;
  let stopped = false;
  let failure = null;
  const chunker = createChunker(chunkSeconds * BYTES_PER_SECOND, (pcm, offset) => {
    if (failure) return;
    try {
      const file = path.join(outDir, `${channel}-${randomUUID()}.wav`);
      writeFileSync(file, wavFile(pcm), { mode: 0o600 });
      const startedMs = streamStartMs + (offset / BYTES_PER_SECOND) * 1000;
      const endedMs = startedMs + (pcm.length / BYTES_PER_SECOND) * 1000;
      announce({ path: file, channel, startedAtUtc: iso(startedMs), endedAtUtc: iso(endedMs), device: target ?? null });
    } catch (error) {
      failure = error;
      child.kill("SIGTERM");
    }
  });
  child.stdout.on("data", (data) => {
    streamStartMs ??= Date.now() - (data.length / BYTES_PER_SECOND) * 1000;
    chunker.push(data);
  });
  child.stderr.on("data", (data) => process.stderr.write(`remnic-capture-helper: pw-record: ${data}`));
  const finished = new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(error.code === "ENOENT" ? new Error("pw-record was not found; install the pipewire package") : error),
    );
    child.once("close", (status) => {
      chunker.flush();
      if (failure) reject(failure);
      else resolve({ stopped, status });
    });
  });
  return {
    finished,
    stop() {
      stopped = true;
      child.kill("SIGTERM");
    },
  };
}

async function targets(channel, device) {
  const defaults = await pwDump().then(defaultDevices, () => ({ source: null, sink: null }));
  const mic = { channel: "mic", target: device ?? defaults.source };
  const system = { channel: "system", target: defaults.sink };
  return { mic: [mic], system: [system], both: [mic, system] }[channel];
}

/**
 * Record until SIGTERM or SIGINT, printing one JSONL ChunkEvent per finished chunk on stdout.
 * Returns the exit status: 0 after a requested stop, 1 when a recorder dies by itself.
 */
export async function audioCapture({ channel, chunkSeconds, out, device }) {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const { uid, mode } = statSync(out);
  if (uid !== process.getuid()) throw new Error(`${out} is not owned by the current user`);
  if (mode & 0o077) chmodSync(out, mode & 0o700);
  const announce = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const container = await recorderHasContainer();
  const recorders = (await targets(channel, device)).map((plan) =>
    startRecorder({ ...plan, container, outDir: out, chunkSeconds, announce }),
  );
  const stopAll = () => recorders.forEach((recorder) => recorder.stop());
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, stopAll);
  process.stdout.once("error", stopAll);

  let ended;
  let failure = null;
  try {
    ended = await Promise.race(recorders.map((recorder) => recorder.finished));
  } catch (error) {
    failure = error;
  }
  stopAll();
  const settled = await Promise.allSettled(recorders.map((recorder) => recorder.finished));
  failure ??= settled.find((result) => result.status === "rejected")?.reason ?? null;
  if (failure) throw failure;
  if (ended.stopped) return 0;
  throw new Error(`pw-record exited with status ${ended.status}`);
}
