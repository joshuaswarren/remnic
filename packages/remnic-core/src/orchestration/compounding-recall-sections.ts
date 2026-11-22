import {
  resolveConsolidationCapabilities,
  resolveConversationContextCapabilities,
  resolveRecallEnhancementCapabilities,
} from "../capabilities.js";
import {
  augmentWithCausalPreferences,
  buildQueryAwarePreferenceSection,
  consolidatePreferences,
} from "../compounding/preference-consolidator.js";
import { createRecallSectionMetricRecorder } from "../recall-qos.js";
import type { StorageManager } from "../storage.js";
import type { RecallInternalDeps } from "./recall-internal-deps.js";

type RecordRecallSectionMetric = ReturnType<
  typeof createRecallSectionMetricRecorder
>;

interface SectionBuildOptions {
  deps: RecallInternalDeps;
  record: RecordRecallSectionMetric;
  retrievalQuery: string;
  deadlineMs: number;
}

export async function buildCompoundingRecallSection(
  options: SectionBuildOptions,
): Promise<string | null> {
  const { deps, record, retrievalQuery, deadlineMs } = options;
  const t0 = Date.now();
  if (
    !deps.compounding ||
    !resolveRecallEnhancementCapabilities(deps.config).compoundingInject ||
    !deps.isRecallSectionEnabled("compounding", true)
  ) {
    record({
      section: "compounding",
      priority: "enrichment",
      durationMs: 0,
      deadlineMs,
      source: "skip",
      success: true,
      timing: "skip",
    });
    return null;
  }
  const maxPatterns =
    deps.getRecallSectionNumber("compounding", "maxPatterns") ?? 40;
  const maxRubrics =
    deps.getRecallSectionNumber("compounding", "maxRubrics") ?? 4;
  if (maxPatterns === 0 && maxRubrics === 0) {
    record({
      section: "compounding",
      priority: "enrichment",
      durationMs: 0,
      deadlineMs,
      source: "skip",
      success: true,
      timing: "skip(limit=0)",
    });
    return null;
  }
  const section = await deps.compounding.buildRecallSection(
    retrievalQuery,
    { maxPatterns, maxRubrics },
  );
  record({
    section: "compounding",
    priority: "enrichment",
    durationMs: Date.now() - t0,
    deadlineMs,
    source: "fresh",
    success: true,
  });
  return section;
}

interface PreferenceSectionBuildOptions extends SectionBuildOptions {
  profileStorages: StorageManager[];
}

export async function buildIrcPreferencesRecallSection(
  options: PreferenceSectionBuildOptions,
): Promise<string | null> {
  const { deps, record, retrievalQuery, profileStorages, deadlineMs } = options;
  const t0 = Date.now();
  const config = deps.config;
  if (
    !resolveConsolidationCapabilities(config).irc ||
    !deps.isRecallSectionEnabled("preferences", true)
  ) {
    record({
      section: "preferences",
      priority: "enrichment",
      durationMs: 0,
      deadlineMs,
      source: "skip",
      success: true,
      timing: "skip",
    });
    return null;
  }
  const memoryGroups = await Promise.all(
    profileStorages.map((storage) => storage.readAllMemories()),
  );
  let preferences = consolidatePreferences(memoryGroups.flat(), {
    maxPreferences: config.ircMaxPreferences,
    includeCorrections: config.ircIncludeCorrections,
    minConfidence: config.ircMinConfidence,
  }).preferences;
  if (resolveConversationContextCapabilities(config).cmcBehaviorLearning) {
    preferences = await augmentWithCausalPreferences(preferences, {
      memoryDir: config.memoryDir,
      causalTrajectoryStoreDir: config.causalTrajectoryStoreDir,
      behaviorMinFrequency: config.cmcBehaviorMinFrequency,
      behaviorMinSessions: config.cmcBehaviorMinSessions,
      behaviorConfidenceThreshold: config.cmcBehaviorConfidenceThreshold,
    });
  }
  const section = buildQueryAwarePreferenceSection(
    preferences,
    retrievalQuery,
    config.ircMaxPreferences,
  );
  record({
    section: "preferences",
    priority: "enrichment",
    durationMs: Date.now() - t0,
    deadlineMs,
    source: "fresh",
    success: true,
  });
  return section;
}
