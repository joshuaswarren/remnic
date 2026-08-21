/**
 * @remnic/capture-screen — à-la-carte desktop screen-activity capture daemon
 * (issue #1899, Part 1). Strict daemon config, a node:sqlite spool with
 * dedup/supersession/retention, deny-lists, daemon-side redaction, AX
 * secure-field filtering, a native-helper seam with OCR routing, replay
 * ingestion, an authenticated loopback HTTP API, and the CLI.
 *
 * The native capture binary is shipped separately as
 * `@remnic/capture-native-<platform>-<arch>`; this package resolves it at
 * runtime and degrades honestly when it is absent.
 */

export {
  CAPTURE_SCREEN_VERSION,
  DEFAULT_HOST,
  DEFAULT_PORT,
  SPOOL_SCHEMA_VERSION,
} from "./constants.js";
export { CaptureConfigError, CaptureInputError } from "./errors.js";
export {
  defaultDaemonConfig,
  loadDaemonConfig,
  parseDaemonConfig,
  serializeDaemonConfig,
} from "./config.js";
export type { DaemonConfig } from "./config.js";
export { capturePaths, captureBaseDir, expandTilde } from "./paths.js";
export type { CapturePaths } from "./paths.js";
export { generateToken, loadOrCreateToken, tokensMatch, bearerFromHeader } from "./token.js";
export {
  assertValidTimezone,
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseSnapshotDate,
} from "./validate.js";
export type { Cursor } from "./validate.js";
export { activityDayWindow } from "./daywindow.js";
export { simhash, hammingDistance, simhashToHex, simhashFromHex } from "./simhash.js";
export { DedupCache } from "./dedup.js";
export {
  DEFAULT_DENY_APPS,
  DEFAULT_DENY_TITLES,
  DEFAULT_DENY_URLS,
  globToRegExp,
  matchDenyRule,
  matchesAnyGlob,
} from "./denylist.js";
export type { DenyCandidate, DenyLists } from "./denylist.js";
export { REDACTION_PLACEHOLDER, compileRedactionPatterns, redactText } from "./redact.js";
export { SECURE_ROLE, extractAxText } from "./axtree.js";
export type { AxNode, AxExtractResult } from "./axtree.js";
export {
  CaptureProcessor,
  DEFAULT_TERMINAL_APPS,
  computeStats,
  contentHash,
  isTerminalApp,
} from "./capture.js";
export type { AppStat, CaptureCandidate, CaptureDecision, DayStats, OcrFn } from "./capture.js";
export { Spool } from "./spool.js";
export type {
  DaemonSnapshot,
  InsertResult,
  QuerySnapshotsOptions,
  SnapshotInput,
  SnapshotPage,
  TextSource,
  WindowFingerprint,
} from "./spool.js";
export {
  NativeHelper,
  helperPackageName,
  resolveHelperBinaryPath,
  runHelperCommand,
} from "./helper.js";
export type { AxSnapshot, AxSnapshotOptions, HelperResolution, OcrWindowOptions } from "./helper.js";
export { captureViaHelper } from "./live.js";
export { ingestReplayDir, ingestReplayDirResponsive, REPLAY_COMMIT_BATCH } from "./replay.js";
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
