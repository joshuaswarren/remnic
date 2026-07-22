/**
 * @remnic/capture-audio — desktop audio capture foundation (checklist
 * item 1 of issue #1897): strict daemon config, a SQLite spool, replay
 * ingestion, an authenticated loopback HTTP API, and the CLI.
 *
 * The `desktop` wearable connector (WearableSourceConnector + HTTP client
 * + registration) ships from this same package to keep one optional
 * install; native capture, VAD, STT, and diarization live alongside it.
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
export { ingestReplayDir } from "./replay.js";
export { buildWhisperArgs, parseWhisperJson, resolveModelPath, runWhisperCli, transcribeWithWhisper } from "./stt.js";
export { downloadWhisperModel, whisperModelUrl } from "./model.js";
export type { ModelDownloadInput, ModelDownloadResult } from "./model.js";
export { pruneExpiredRawAudio } from "./janitor.js";
export { createSileroVad, loadSherpaOnnx, sileroVadConfig } from "./vad.js";
export type { SherpaOnnxModule, SileroVadInput } from "./vad.js";
export type { TranscribedSegment, WhisperRunResult, WhisperTranscriptionInput } from "./stt.js";
export type { ReplayResult } from "./replay.js";
export { createRequestHandler, startDaemon } from "./daemon.js";
export type { DaemonDeps, DaemonHandle } from "./daemon.js";
export { isProcessAlive, readPidFile, removePidFile, writePidFile } from "./control.js";
export { runCapture } from "./cli.js";
export type { CliIo } from "./cli.js";

// Desktop wearable connector (à-la-carte companion of @remnic/core). The
// registration is what core's computed-specifier discovery reads.
export {
  createDesktopConnector,
  DesktopApiError,
  DesktopCaptureClient,
  DESKTOP_DEFAULT_BASE_URL,
  DESKTOP_SOURCE_ID,
  daemonConversationToWearable,
  ensureDesktopConnectorRegistered,
  resolveDesktopBaseUrl,
  resolveDesktopToken,
  wearableConnectorRegistration,
} from "./connector.js";
export type {
  DesktopCaptureClientOptions,
  ListConversationsParams,
} from "./connector.js";
