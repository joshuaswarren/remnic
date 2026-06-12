/**
 * Wearable transcript subsystem — public surface.
 *
 * Connector packages import the registry + types; hosts construct a
 * `WearablesService` (usually via the orchestrator accessor).
 */

export * from "./types.js";
export { describeErrorForOperator, WearablesInputError } from "./errors.js";
export {
  defaultWearableCleanupSettings,
  defaultWearableSourceSettings,
  defaultWearablesConfig,
  KNOWN_WEARABLE_SOURCE_IDS,
  parseWearablesConfig,
} from "./config.js";
export {
  registerWearableConnector,
  getWearableConnector,
  listWearableConnectors,
  clearWearableConnectors,
  ensureBuiltInWearableConnectors,
  type WearableConnectorFactory,
  type WearableConnectorFactoryOptions,
  type WearableConnectorRegistration,
} from "./registry.js";
export {
  cleanConversation,
  collapseImmediateRepeats,
  isLowQualitySegment,
  stripFillerTokens,
  type CleanupResult,
} from "./cleanup.js";
export {
  applyOffTheRecord,
  compileRedactionPatterns,
  redactText,
  REDACTION_PLACEHOLDER,
} from "./redaction.js";
export {
  applyCorrections,
  compileCorrectionRule,
  compileCorrectionRules,
  correctionsFilePath,
  loadCorrectionsFile,
  saveCorrectionsFile,
  type CompiledCorrectionRule,
} from "./corrections.js";
export {
  DEFAULT_SELF_NAME,
  distinctSpeakerLabels,
  emptySpeakerRegistry,
  loadSpeakerRegistry,
  resolveSpeaker,
  saveSpeakerRegistry,
  speakerRegistryKey,
  speakersFilePath,
  type ResolvedSpeaker,
  type SpeakerOverride,
  type SpeakerRegistry,
} from "./speakers.js";
export {
  composeDayTranscriptBody,
  composeDayTranscriptMeta,
  hashTranscriptBody,
  isValidTranscriptDate,
  parseDayTranscript,
  serializeDayTranscript,
  WEARABLES_DIR_NAME,
} from "./day-store.js";
export {
  emptySyncState,
  loadSyncState,
  saveSyncState,
  syncStateFilePath,
  updateSourceSyncState,
  type WearableSourceSyncState,
  type WearableSyncStateFile,
} from "./sync-state.js";
export {
  buildExtractionTurns,
  generateWearableMemories,
  importNativeMemories,
  memoryStatusForMode,
  WEARABLE_SOURCE_PREFIX,
  wearableDayTag,
  wearableSourceLabel,
  writeDailyDigestMemory,
  type WearableMemoryGenDeps,
  type WearableMemoryGenResult,
  type WearableMemoryWriter,
} from "./memory-gen.js";
export {
  dateInTimezone,
  defaultTimezone,
  resolveSyncDates,
  syncWearableSource,
  type WearableSyncDeps,
  type WearableSyncOptions,
} from "./pipeline.js";
export {
  runWearablesCliCommand,
  type WearablesCliIo,
} from "./cli.js";
export {
  locateTranscriptPath,
  WearablesService,
  type WearableDayTranscriptView,
  type WearableMemorySearchResult,
  type WearableSearchBackend,
  type WearableStorageIo,
  type WearableTranscriptSearchResult,
  type WearablesServiceDeps,
} from "./service.js";
