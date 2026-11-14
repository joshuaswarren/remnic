import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HELPER = path.join(here, "..", "bin", "remnic-capture-helper");
export const BYTES_PER_SECOND = 32_000; // 16 kHz mono, 16-bit

const FAKE_PW_RECORD = `#!/usr/bin/env node
// Stands in for pw-record: logs argv, writes FAKE_PCM_BYTES of PCM in odd-sized pieces, then exits or waits for a signal.
// Signals during writes are acted on after all samples are sent, so a stop never loses samples.
// FAKE_PCM_ENDIANNESS overrides the native-endian sample order for tests.
// FAKE_NO_CONTAINER makes it behave like PipeWire before 1.6, which has no --container option.
import { appendFileSync } from "node:fs";
import { endianness } from "node:os";
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log("pw-record [options] [<file>|-]\\n  --rate  Sample rate" + (process.env.FAKE_NO_CONTAINER ? "" : "\\n  --container  Container format"));
  process.exit(0);
}
appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(argv) + "\\n");
appendFileSync(process.env.FAKE_PID_LOG, process.pid + "\\n");
if (process.env.FAKE_NO_CONTAINER && argv.includes("--container")) {
  console.error("unknown option: --container");
  process.exit(64);
}
let writing = true;
let signalled = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    signalled = true;
    if (!writing) process.exit(0);
  });
}
const total = Number(process.env.FAKE_PCM_BYTES ?? 0);
const pcmEndianness = process.env.FAKE_PCM_ENDIANNESS ?? endianness();
let sent = 0;
while (sent < total) {
  const piece = Buffer.alloc(Math.min(7001, total - sent));
  for (let i = 0; i < piece.length; i += 1) {
    const absolute = sent + i;
    const pairStart = absolute - (absolute % 2);
    piece[i] =
      pcmEndianness === "BE"
        ? (absolute % 2 === 0 ? pairStart + 1 : pairStart) % 251
        : absolute % 251;
  }
  await new Promise((resolve) => process.stdout.write(piece, resolve));
  sent += piece.length;
}
writing = false;
if (process.env.FAKE_EXIT_CODE !== undefined) process.exit(Number(process.env.FAKE_EXIT_CODE));
if (signalled) process.exit(0);
setInterval(() => {}, 1000);
`;

/** A directory of fake pipewire tools; \`env\` puts it first on PATH. */
export function fakeTools(dumpFile) {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-linux-helper-"));
  const argvLog = path.join(dir, "pw-record-argv.log");
  const pidLog = path.join(dir, "pw-record-pid.log");
  const dumpStarted = path.join(dir, "pw-dump-started");
  const dumpRelease = path.join(dir, "pw-dump-release");
  writeFileSync(argvLog, "");
  writeFileSync(pidLog, "");
  writeFileSync(path.join(dir, "pw-record"), FAKE_PW_RECORD);
  writeFileSync(
    path.join(dir, "pw-dump"),
    `#!/bin/sh\n: > "$FAKE_PW_DUMP_STARTED"\nif [ "$FAKE_BLOCK_DUMP" = "1" ]; then\n  while [ ! -f "$FAKE_PW_DUMP_RELEASE" ]; do sleep 0.02; done\nfi\ncat '${dumpFile}'\n`,
  );
  chmodSync(path.join(dir, "pw-record"), 0o755);
  chmodSync(path.join(dir, "pw-dump"), 0o755);
  return {
    dir,
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_ARGV_LOG: argvLog,
      FAKE_PID_LOG: pidLog,
      FAKE_PW_DUMP_STARTED: dumpStarted,
      FAKE_PW_DUMP_RELEASE: dumpRelease,
    },
    recorderPids: () => readFileSync(pidLog, "utf8").split("\n").filter(Boolean).map(Number),
    recorderCalls: () =>
      readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    releaseDump: () => writeFileSync(dumpRelease, ""),
    async waitForDumpStart(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(dumpStarted) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!existsSync(dumpStarted)) throw new Error(`pw-dump did not start within ${timeoutMs}ms`);
    },
    async waitForRecorderCalls(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (this.recorderCalls().length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (this.recorderCalls().length < count) throw new Error(`only ${this.recorderCalls().length} of ${count} recorders started`);
    },
  };
}

export function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "remnic-linux-out-"));
}

/** Run the helper; collect stdout JSONL, stderr and the exit status. */
export function run(args, env = {}) {
  const child = spawn(process.execPath, [HELPER, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const lines = () => out.split("\n").filter(Boolean);
  return {
    child,
    exited,
    lines,
    events: () => lines().map((line) => JSON.parse(line)),
    stdout: () => out,
    stderr: () => err,
    async waitForEvents(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (lines().length < count) {
        if (Date.now() > deadline) {
          const message = `only ${lines().length} of ${count} events; stderr: ${err}`;
          child.kill("SIGTERM");
          throw new Error(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async stop() {
      child.kill("SIGTERM");
      return exited;
    },
  };
}

export function wavParts(file) {
  if (!existsSync(file)) throw new Error(`no file at ${file}`);
  const bytes = readFileSync(file);
  return {
    riff: bytes.toString("ascii", 0, 4),
    wave: bytes.toString("ascii", 8, 12),
    format: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    rate: bytes.readUInt32LE(24),
    bits: bytes.readUInt16LE(34),
    dataBytes: bytes.readUInt32LE(40),
    riffSize: bytes.readUInt32LE(4),
    total: bytes.length,
    pcm: bytes.subarray(44),
  };
}
