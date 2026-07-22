/**
 * @remnic/capture-audio — desktop audio capture foundation (checklist
 * item 1 of issue #1897): strict daemon config, a SQLite spool, replay
 * ingestion, an authenticated loopback HTTP API, and the CLI.
 *
 * Native capture, VAD, STT, diarization, the wearable connector, and the
 * core registry entry land in later checklist items and are intentionally
 * absent here.
 */

export { CAPTURE_AUDIO_VERSION, DEFAULT_HOST, DEFAULT_PORT, SPOOL_SCHEMA_VERSION } from "./constants.js";
export { CaptureConfigError, CaptureInputError } from "./errors.js";
export {
  defaultDaemonConfig,
  loadDaemonConfig,
  parseDaemonConfig,
  serializeDaemonConfig,
} from "./config.js";
export type {
  DaemonConfig,
  DeviceConfig,
  DiarizationConfig,
  SttConfig,
  VadConfig,
} from "./config.js";
export { capturePaths, captureBaseDir } from "./paths.js";
export type { CapturePaths } from "./paths.js";
export { generateToken, loadOrCreateToken, tokensMatch, bearerFromHeader } from "./token.js";
export {
  assertValidTimezone,
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseTranscriptDate,
} from "./validate.js";
export type { Cursor } from "./validate.js";
export { Spool } from "./spool.js";
export type {
  ChunkStatus,
  ConversationInput,
  ConversationPage,
  ConversationState,
  DaemonConversation,
  DaemonSegment,
  QueryFinalOptions,
  SegmentInput,
  SpeakerInput,
  SpeakerRow,
} from "./spool.js";
export { ingestReplayDir, ingestReplayDirResponsive, REPLAY_COMMIT_BATCH } from "./replay.js";
export { buildWhisperArgs, parseWhisperJson, resolveModelPath, runWhisperCli, transcribeWithWhisper } from "./stt.js";
export { downloadWhisperModel, whisperModelUrl } from "./model.js";
export type { ModelDownloadInput, ModelDownloadResult } from "./model.js";
export type { TranscribedSegment, WhisperRunResult, WhisperTranscriptionInput } from "./stt.js";
export type { ReplayResult } from "./replay.js";
export { createRequestHandler, startDaemon } from "./daemon.js";
export type { DaemonDeps, DaemonHandle } from "./daemon.js";
export {
  isProcessAlive,
  readPidFile,
  readPidRecord,
  removePidFile,
  removePidFileIfOwner,
  writePidFile,
} from "./control.js";
export type { PidRecord } from "./control.js";
export { runCapture, superviseReplay } from "./cli.js";
export type { CliIo } from "./cli.js";
