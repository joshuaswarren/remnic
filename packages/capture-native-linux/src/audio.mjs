import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

function recorderArgs(system, target) {
  const args = ["--rate", String(RATE), "--channels", "1", "--format", "s16", "--container", "raw"];
  if (target) args.push("--target", target);
  if (system) args.push("-P", "{ stream.capture.sink=true }");
  return [...args, "-"];
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** Start one pw-record for `channel`; resolves `{ stopped, status }` once it has exited and its last chunk is written. */
function startRecorder({ channel, target, outDir, chunkSeconds, announce }) {
  const child = spawn("pw-record", recorderArgs(channel === "system", target), { stdio: ["ignore", "pipe", "pipe"] });
  let streamStartMs = null;
  let stopped = false;
  const chunker = createChunker(chunkSeconds * BYTES_PER_SECOND, (pcm, offset) => {
    const file = path.join(outDir, `${channel}-${randomUUID()}.wav`);
    writeFileSync(file, wavFile(pcm), { mode: 0o600 });
    const startedMs = streamStartMs + (offset / BYTES_PER_SECOND) * 1000;
    const endedMs = startedMs + (pcm.length / BYTES_PER_SECOND) * 1000;
    announce({ path: file, channel, startedAtUtc: iso(startedMs), endedAtUtc: iso(endedMs), device: target ?? null });
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
      resolve({ stopped, status });
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
  const announce = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const recorders = (await targets(channel, device)).map((plan) =>
    startRecorder({ ...plan, outDir: out, chunkSeconds, announce }),
  );
  const stopAll = () => recorders.forEach((recorder) => recorder.stop());
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, stopAll);
  process.stdout.once("error", stopAll);

  const first = Promise.race(recorders.map((recorder) => recorder.finished));
  const ended = await first.catch((error) => {
    stopAll();
    throw error;
  });
  stopAll();
  await Promise.all(recorders.map((recorder) => recorder.finished.catch(() => undefined)));
  if (ended.stopped) return 0;
  throw new Error(`pw-record exited with status ${ended.status}`);
}
