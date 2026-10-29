/**
 * Buffer I/O benchmark (per-session persistence).
 *
 * Synthetic buffer shaped like the daemon incident: several sessions whose
 * buffered turns add up to ~150 MB, then one observe per session. Measures
 * the two numbers the incident reported as slow:
 *
 *   - STORE: appending a turn (the observe path) — the legacy code rewrote
 *     the WHOLE state/buffer.json here, per observe.
 *   - RECALL: loading the buffer back into a fresh SmartBuffer.
 *
 * Runs unchanged against both revisions (it only uses APIs that exist in
 * both): seeding uses saveBufferSession when the storage has it, otherwise
 * the legacy whole-state saveBuffer.
 *
 * Usage: tsx packages/remnic-core/scripts/bench-buffer-io.ts [--sessions=N]
 *                                                        [--turns=N] [--observes=N]
 *                                                        [--bytes=N] [--label=NAME]
 */
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { SmartBuffer } from "../src/buffer.js";
import { parseConfig } from "../src/config.js";
import { StorageManager } from "../src/storage.js";
import type { BufferEntryState, BufferState } from "../src/types.js";

interface Options {
  sessions: number;
  turns: number;
  observes: number;
  bytes: number;
  label: string;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { sessions: 12, turns: 20, observes: 12, bytes: 150 * 1024 * 1024, label: "run" };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (value === undefined) continue;
    if (key === "sessions") options.sessions = Number(value);
    else if (key === "turns") options.turns = Number(value);
    else if (key === "observes") options.observes = Number(value);
    else if (key === "bytes") options.bytes = Number(value);
    else if (key === "label") options.label = value;
  }
  return options;
}

function now(): bigint {
  return process.hrtime.bigint();
}

function msSince(start: bigint): number {
  return Number(now() - start) / 1e6;
}

async function directoryBytes(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { files, bytes };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      const nested = await directoryBytes(full);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += info.size;
    }
  }
  return { files, bytes };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bufio-bench-"));
  try {
    const config = parseConfig({
      memoryDir: root,
      triggerMode: "every_n",
      // Never trigger extraction during the benchmark; we measure IO only.
      bufferMaxTurns: 1_000_000,
      // Save on every observe — the legacy "rewrite the whole buffer.json"
      // behavior this change replaces.
      bufferSaveDebounceMs: 0,
    });
    const storage = new StorageManager(root);

    const perTurnBytes = Math.max(
      1024,
      Math.floor(options.bytes / (options.sessions * options.turns)),
    );
    const content = "x".repeat(perTurnBytes);
    const makeTurn = (sessionKey: string, index: number) => ({
      role: "user" as const,
      content: `${content}${index}`,
      timestamp: new Date(2026, 0, 1, 0, 0, index % 60).toISOString(),
      sessionKey,
    });

    const sessionKeys = Array.from({ length: options.sessions }, (_, i) => `bench-session-${i}`);
    const entries = new Map<string, BufferEntryState>();
    for (const [sessionIndex, key] of sessionKeys.entries()) {
      entries.set(key, {
        turns: Array.from({ length: options.turns }, (_, turnIndex) => makeTurn(key, turnIndex)),
        lastExtractionAt: null,
        extractionCount: 0,
      });
      void sessionIndex;
    }

    // Seed the store the way the running revision persists it.
    const seedStart = now();
    const sessionWriter = (storage as Partial<StorageManager>).saveBufferSession;
    if (typeof sessionWriter === "function") {
      for (const [key, entry] of entries) {
        await storage.saveBufferSession(key, entry);
      }
    } else {
      const legacyState: BufferState = {
        turns: [],
        lastExtractionAt: null,
        extractionCount: 0,
        entries: Object.fromEntries(entries),
      };
      await storage.saveBuffer(legacyState);
    }
    const seedMs = msSince(seedStart);

    // RECALL: load the buffer back from disk.
    const recallStart = now();
    const recalled = new SmartBuffer(config, storage);
    await recalled.load();
    const recallMs = msSince(recallStart);

    // STORE: append one turn per session (the observe path).
    const storeStart = now();
    const perObserve: number[] = [];
    for (let i = 0; i < options.observes; i++) {
      const key = sessionKeys[i % sessionKeys.length];
      const observeStart = now();
      await recalled.addTurn(key, makeTurn(key, options.turns + i));
      perObserve.push(msSince(observeStart));
    }
    const storeMs = msSince(storeStart);
    const sorted = [...perObserve].sort((a, b) => a - b);
    const medianObserveMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const maxObserveMs = sorted[sorted.length - 1] ?? 0;

    const onDisk = await directoryBytes(path.join(root, "state"));

    const result = {
      label: options.label,
      sessions: options.sessions,
      turnsPerSession: options.turns,
      observes: options.observes,
      bufferBytes: options.bytes,
      perSessionBytes: perTurnBytes * options.turns,
      persistence: typeof sessionWriter === "function" ? "per-session-files" : "legacy-single-file",
      seedMs: Math.round(seedMs),
      recallMs: Math.round(recallMs),
      storeMs: Math.round(storeMs),
      medianObserveMs: Math.round(medianObserveMs),
      maxObserveMs: Math.round(maxObserveMs),
      storePlusRecallMs: Math.round(storeMs + recallMs),
      onDiskFiles: onDisk.files,
      onDiskBytes: onDisk.bytes,
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
