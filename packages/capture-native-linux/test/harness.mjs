import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HELPER = path.join(here, "..", "bin", "remnic-capture-helper");
export const BYTES_PER_SECOND = 32_000; // 16 kHz mono, 16-bit

const FAKE_PW_RECORD = `#!/usr/bin/env node
// Stands in for pw-record: logs its argv, writes FAKE_PCM_BYTES of a counting pattern to stdout in
// odd-sized pieces, then either exits with FAKE_EXIT_CODE or waits for a signal like a live recording.
import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const total = Number(process.env.FAKE_PCM_BYTES ?? 0);
let sent = 0;
while (sent < total) {
  const piece = Buffer.alloc(Math.min(7001, total - sent));
  for (let i = 0; i < piece.length; i += 1) piece[i] = (sent + i) % 251;
  await new Promise((resolve) => process.stdout.write(piece, resolve));
  sent += piece.length;
}
if (process.env.FAKE_EXIT_CODE !== undefined) process.exit(Number(process.env.FAKE_EXIT_CODE));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
setInterval(() => {}, 1000);
`;

/** A directory of fake pipewire tools; \`env\` puts it first on PATH. */
export function fakeTools(dumpFile) {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-linux-helper-"));
  const argvLog = path.join(dir, "pw-record-argv.log");
  writeFileSync(argvLog, "");
  writeFileSync(path.join(dir, "pw-record"), FAKE_PW_RECORD);
  writeFileSync(path.join(dir, "pw-dump"), `#!/bin/sh\ncat '${dumpFile}'\n`);
  chmodSync(path.join(dir, "pw-record"), 0o755);
  chmodSync(path.join(dir, "pw-dump"), 0o755);
  return {
    dir,
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE_ARGV_LOG: argvLog },
    recorderCalls: () =>
      readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
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
        if (Date.now() > deadline) throw new Error(`only ${lines().length} of ${count} events; stderr: ${err}`);
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
