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

import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { ConversationAssembler } from "./assembly.js";
import { SpeakerClusterer, type Embedding } from "./diarization.js";
import type { DaemonConfig } from "./config.js";
import { CaptureInputError } from "./errors.js";
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
  /** VAD speech gate seam; production supplies a sherpa-onnx detector. */
  detectSpeech?: (event: ChunkEvent) => boolean | Promise<boolean>;
  /** Speaker-embedding seam for diarization; production supplies sherpa speaker-id. */
  embed?: (event: ChunkEvent, segment: TranscribedSegment) => Embedding | Promise<Embedding>;
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
  // Resolve symlinks so a symlinked chunk path can't escape the raw dir; fall
  // back to the lexical path when the target doesn't exist yet (tests, or a
  // chunk whose WAV was already removed).
  const realOrResolved = (p: string): string => {
    try {
      return realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const rawBaseReal = realOrResolved(rawBase);
  const withinRawDir = (p: string): boolean => {
    const real = realOrResolved(p);
    return real === rawBaseReal || real.startsWith(rawBaseReal + path.sep);
  };
  const cleanupRawAudio =
    options.cleanupRawAudio ??
    (async (event: ChunkEvent): Promise<void> => {
      // Retention 0 = keep no raw audio: delete the WAV once its chunk is
      // durably persisted. A positive retention leaves it for the janitor.
      if (config.rawRetentionHours > 0) return;
      // event.path is helper-supplied; never delete anything outside the raw dir.
      if (!withinRawDir(event.path)) return;
      await rm(path.resolve(event.path), { force: true });
    });

  const assembler = new ConversationAssembler({
    gapMinutes: config.conversationGapMinutes,
    ...(options.makeConversationId ? { makeId: options.makeConversationId } : {}),
  });

  // Diarization is active only when an embedder is wired (production: the
  // sherpa speaker-id model from the native layer; tests inject a fake). Seed
  // the clusterer from persisted clusters so speaker ids survive restarts.
  const diarizer = options.embed
    ? new SpeakerClusterer(config.diarization.similarityThreshold, spool.readSpeakerClusters())
    : undefined;

  const processor = createChunkProcessor({
    spool,
    assembler,
    resolveModel,
    transcribe,
    cleanupRawAudio,
    // Cross-channel arrival skew: hold each transcribed chunk until the
    // watermark passes it, so a delayed system chunk still assembles into the
    // conversation it belongs to (issue #2145).
    // Only "both" has two independent chunk streams to interleave. A single
    // channel is already ordered, so buffering would add latency and widen the
    // crash window for nothing (issue #2145).
    reorderWindowMs: config.captureChannel === "both" ? config.reorderWindowSeconds * 1000 : 0,
    ...(options.detectSpeech ? { detectSpeech: options.detectSpeech } : {}),
    ...(options.embed ? { embed: options.embed } : {}),
    ...(diarizer ? { diarizer } : {}),
    ...(options.onError ? { onError: (error: Error) => options.onError?.(error) } : {}),
  });

  const runner: NativeCaptureRunner = createNativeCaptureRunner({
    outDir,
    chunkSeconds: config.chunkSeconds,
    // Channels to record (config.captureChannel, default "both"). With "both",
    // the processor's finalize-time cross-channel dedup drops mic segments that
    // duplicate system (loopback) speech, so it is stored once (the cleaner
    // system copy). Operators without system-audio permission can set "mic" so
    // microphone capture never depends on the system-audio path being available.
    channel: config.captureChannel,
    device: config.devices.mic,
    onChunk: (event) => {
      // Reject a helper-supplied path that escapes the raw capture dir BEFORE it
      // is read for transcription — resolving symlinks, so a symlink under the
      // dir can't point the transcriber at an arbitrary file.
      if (!withinRawDir(event.path)) {
        options.onError?.(new CaptureInputError(`native helper chunk path escapes the capture directory: ${event.path}`));
        return;
      }
      processor.enqueue({ ...event, path: path.resolve(event.path) });
    },
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
