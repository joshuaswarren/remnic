/**
 * Live capture wiring (issue #1897) — assembles the native helper runner and
 * the chunk processor into one start/stop unit the daemon drives.
 *
 * The native runner owns the helper process and surfaces validated
 * `ChunkEvent`s; the processor turns each recorded WAV into durable, replay-safe
 * conversations in the spool. This module wires them with production defaults
 * (whisper STT, model resolution, raw-audio cleanup) while keeping every
 * collaborator injectable, so tests drive the whole pipeline against a fake
 * helper binary and a fake transcriber without any macOS runtime.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

import { ConversationAssembler } from "./assembly.js";
import type { DaemonConfig } from "./config.js";
import {
  createNativeCaptureRunner,
  type ChunkEvent,
  type HelperResolution,
  type HelperSpawn,
  type NativeCaptureRunner,
  type ResolveHelperDeps,
  type RestartTimer,
} from "./native.js";
import { createChunkProcessor, type ChunkProcessor, type ChunkTranscribeInput } from "./processor.js";
import type { Spool } from "./spool.js";
import { resolveModelPath, runWhisperCli, transcribeWithWhisper, type TranscribedSegment } from "./stt.js";

export interface LiveCaptureOptions {
  spool: Spool;
  config: DaemonConfig;
  /** Directory the helper writes WAV chunks into (`audio-capture --out`). */
  outDir: string;
  /** Default whisper model path when `config.stt.modelPath` is unset. */
  defaultModelPath: string;
  onError?: (error: Error) => void;
  onStderr?: (line: string) => void;

  // Injectable seams (tests) — real defaults are built from `config` below.
  spawn?: HelperSpawn;
  resolveBinary?: (deps: ResolveHelperDeps) => HelperResolution;
  resolution?: HelperResolution;
  transcribe?: (input: ChunkTranscribeInput) => Promise<TranscribedSegment[]>;
  resolveModel?: () => string;
  cleanupRawAudio?: (event: ChunkEvent) => Promise<void>;
  scheduleRestart?: (fn: () => void, delayMs: number) => RestartTimer;
  cancelRestart?: (timer: RestartTimer) => void;
  makeConversationId?: () => string;
}

export interface LiveCapture {
  start(): void;
  /** Stop the helper, then drain + finalize the processor. */
  stop(): Promise<number>;
  readonly running: boolean;
  /** Test/observability seam. */
  readonly processor: ChunkProcessor;
}

/** Wire the native runner + chunk processor into one live-capture unit. */
export function createLiveCapture(options: LiveCaptureOptions): LiveCapture {
  const { spool, config, outDir, defaultModelPath } = options;

  const resolveModel =
    options.resolveModel ?? (() => resolveModelPath(config.stt.modelPath ?? undefined, defaultModelPath));

  const transcribe =
    options.transcribe ??
    ((input: ChunkTranscribeInput) =>
      transcribeWithWhisper({
        wavPath: input.wavPath,
        modelPath: input.modelPath,
        chunkStartedAtUtc: input.chunkStartedAtUtc,
        threads: config.stt.threads,
        run: runWhisperCli,
      }));

  const rawBase = path.resolve(outDir);
  const cleanupRawAudio =
    options.cleanupRawAudio ??
    (async (event: ChunkEvent): Promise<void> => {
      // Retention 0 = keep no raw audio: delete the WAV once its chunk is
      // durably persisted. A positive retention leaves it for the janitor.
      if (config.rawRetentionHours > 0) return;
      // event.path is helper-supplied; never delete anything outside the raw
      // capture directory even if a malformed/hostile event points elsewhere.
      const resolved = path.resolve(event.path);
      if (resolved !== rawBase && !resolved.startsWith(rawBase + path.sep)) return;
      await rm(resolved, { force: true });
    });

  const assembler = new ConversationAssembler({
    gapMinutes: config.conversationGapMinutes,
    ...(options.makeConversationId ? { makeId: options.makeConversationId } : {}),
  });

  const processor = createChunkProcessor({
    spool,
    assembler,
    resolveModel,
    transcribe,
    cleanupRawAudio,
    ...(options.onError ? { onError: (error: Error) => options.onError?.(error) } : {}),
  });

  const runner: NativeCaptureRunner = createNativeCaptureRunner({
    outDir,
    chunkSeconds: config.chunkSeconds,
    channel: "both",
    device: config.devices.mic,
    onChunk: (event) => processor.enqueue(event),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    ...(options.resolution ? { resolution: options.resolution } : {}),
    ...(options.resolveBinary ? { resolveBinary: options.resolveBinary } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.scheduleRestart ? { scheduleRestart: options.scheduleRestart } : {}),
    ...(options.cancelRestart ? { cancelRestart: options.cancelRestart } : {}),
  });

  return {
    get running(): boolean {
      return runner.running;
    },
    processor,
    start(): void {
      // Pre-flight the STT model once so a missing/unreadable model fails fast
      // (actionable) here instead of throwing on every captured chunk.
      resolveModel();
      runner.start();
    },
    async stop(): Promise<number> {
      // Await the helper's exit so its final flushed chunk is enqueued before
      // we drain and finalize.
      await runner.stop();
      return processor.finalize();
    },
  };
}
