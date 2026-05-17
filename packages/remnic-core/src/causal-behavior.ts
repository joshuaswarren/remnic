/**
 * causal-behavior.ts — CMC Phase 4: Implicit Behavioral Preference Learning
 *
 * Extracts behavioral signals from causal chain analysis. Unlike explicit
 * preference extraction (which reads text), this derives preferences from
 * patterns of action: what goals recur, what actions succeed repeatedly,
 * what outcomes are consistently pursued.
 *
 * Key insight: "Preferences are recurring causal pathways."
 */

import { resolveCausalTrajectoryStoreDir, type CausalTrajectoryRecord } from "./causal-trajectory.js";
import type { CausalChainIndex } from "./causal-chain.js";
import { readChainIndex, resolveChainsDir } from "./causal-chain.js";
import { normalizeRecallTokens } from "./recall-tokenization.js";
import { topicOverlapScore } from "./boxes.js";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import { isRecord } from "./store-contract.js";
import type { ConsolidatedPreference } from "./compounding/preference-consolidator.js";
import path from "node:path";
import { log } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CausalBehaviorSignalType =
  | "topic_revisitation"
  | "action_pattern"
  | "outcome_preference"
  | "phrasing_style";

export interface CausalBehaviorSignal {
  signalType: CausalBehaviorSignalType;
  pattern: string;
  frequency: number;
  sessionCount: number;
  confidence: number;
  trajectoryIds: string[];
}

export interface BehaviorConfig {
  minFrequency: number;
  minSessions: number;
  confidenceThreshold: number;
}

// ─── Signal Extraction ───────────────────────────────────────────────────────

/**
 * Detect topic revisitation: same goal fingerprint appearing in 3+ sessions.
 */
function detectTopicRevisitation(
  trajectories: CausalTrajectoryRecord[],
  config: BehaviorConfig,
): CausalBehaviorSignal[] {
  const goalGroups = new Map<string, { sessions: Set<string>; trajectoryIds: string[]; goal: string }>();

  for (const t of trajectories) {
    const tokens = normalizeRecallTokens(t.goal, []).sort().join(" ");
    if (!tokens) continue;
    const group = goalGroups.get(tokens) ?? { sessions: new Set(), trajectoryIds: [], goal: t.goal };
    group.sessions.add(t.sessionKey);
    group.trajectoryIds.push(t.trajectoryId);
    goalGroups.set(tokens, group);
  }

  const signals: CausalBehaviorSignal[] = [];
  for (const [_key, group] of goalGroups) {
    if (group.trajectoryIds.length < config.minFrequency) continue;
    if (group.sessions.size < config.minSessions) continue;

    signals.push({
      signalType: "topic_revisitation",
      pattern: group.goal,
      frequency: group.trajectoryIds.length,
      sessionCount: group.sessions.size,
      confidence: Math.min(1, 0.5 + (group.sessions.size / 10)),
      trajectoryIds: group.trajectoryIds.slice(0, 10),
    });
  }

  return signals;
}

/**
 * Detect action patterns: same action with >= 80% success rate, 4+ occurrences.
 */
function detectActionPatterns(
  trajectories: CausalTrajectoryRecord[],
  config: BehaviorConfig,
): CausalBehaviorSignal[] {
  const actionGroups = new Map<string, {
    sessions: Set<string>;
    trajectoryIds: string[];
    action: string;
    successCount: number;
    totalCount: number;
  }>();

  for (const t of trajectories) {
    const tokens = normalizeRecallTokens(t.actionSummary, []).sort().join(" ");
    if (!tokens) continue;
    const group = actionGroups.get(tokens) ?? {
      sessions: new Set(),
      trajectoryIds: [],
      action: t.actionSummary,
      successCount: 0,
      totalCount: 0,
    };
    group.sessions.add(t.sessionKey);
    group.trajectoryIds.push(t.trajectoryId);
    group.totalCount++;
    if (t.outcomeKind === "success") group.successCount++;
    actionGroups.set(tokens, group);
  }

  const signals: CausalBehaviorSignal[] = [];
  for (const [_key, group] of actionGroups) {
    if (group.totalCount < Math.max(config.minFrequency, 4)) continue;
    if (group.sessions.size < config.minSessions) continue;
    const successRate = group.successCount / group.totalCount;
    if (successRate < 0.8) continue;

    signals.push({
      signalType: "action_pattern",
      pattern: group.action,
      frequency: group.totalCount,
      sessionCount: group.sessions.size,
      confidence: Math.min(1, 0.6 + (successRate * 0.3)),
      trajectoryIds: group.trajectoryIds.slice(0, 10),
    });
  }

  return signals;
}

/**
 * Detect outcome preferences: consistent retry patterns leading to success.
 * When a trajectory fails and is retried (via chain edges) successfully,
 * it indicates a strong preference for that outcome.
 */
function detectOutcomePreferences(
  trajectories: CausalTrajectoryRecord[],
  chainIndex: CausalChainIndex,
  config: BehaviorConfig,
): CausalBehaviorSignal[] {
  const retrySuccesses = new Map<string, {
    sessions: Set<string>;
    trajectoryIds: string[];
    goal: string;
    count: number;
  }>();

  const trajectoryMap = new Map(trajectories.map((t) => [t.trajectoryId, t]));

  for (const [edgeId, edge] of Object.entries(chainIndex.edges)) {
    if (edge.edgeType !== "retry") continue;

    const from = trajectoryMap.get(edge.fromTrajectoryId);
    const to = trajectoryMap.get(edge.toTrajectoryId);
    if (!from || !to) continue;
    if (from.outcomeKind !== "failure" || to.outcomeKind !== "success") continue;

    const goalTokens = normalizeRecallTokens(from.goal, []).sort().join(" ");
    const group = retrySuccesses.get(goalTokens) ?? {
      sessions: new Set(),
      trajectoryIds: [],
      goal: from.goal,
      count: 0,
    };
    group.sessions.add(from.sessionKey);
    group.sessions.add(to.sessionKey);
    group.trajectoryIds.push(from.trajectoryId, to.trajectoryId);
    group.count++;
    retrySuccesses.set(goalTokens, group);
  }

  const signals: CausalBehaviorSignal[] = [];
  for (const [_key, group] of retrySuccesses) {
    if (group.count < config.minFrequency) continue;
    if (group.sessions.size < config.minSessions) continue;

    signals.push({
      signalType: "outcome_preference",
      pattern: group.goal,
      frequency: group.count,
      sessionCount: group.sessions.size,
      confidence: Math.min(1, 0.7 + (group.count / 20)),
      trajectoryIds: [...new Set(group.trajectoryIds)].slice(0, 10),
    });
  }

  return signals;
}

// ─── Preference Synthesis ────────────────────────────────────────────────────

/**
 * Convert behavioral signals into ConsolidatedPreference entries
 * that can be merged with existing IRC preference output.
 */
export function synthesizeCausalPreferences(
  signals: CausalBehaviorSignal[],
  confidenceThreshold: number,
): ConsolidatedPreference[] {
  const preferences: ConsolidatedPreference[] = [];

  for (const signal of signals) {
    if (signal.confidence < confidenceThreshold) continue;

    let statement: string;
    switch (signal.signalType) {
      case "topic_revisitation":
        statement = `The user frequently works on: ${signal.pattern}. This topic has been revisited across ${signal.sessionCount} sessions.`;
        break;
      case "action_pattern":
        statement = `The user prefers this approach: ${signal.pattern}. This action pattern has been successful ${signal.frequency} times.`;
        break;
      case "outcome_preference":
        statement = `The user persistently pursues: ${signal.pattern}. They retry until successful, indicating strong preference.`;
        break;
      case "phrasing_style":
        statement = `The user's phrasing pattern: ${signal.pattern}`;
        break;
    }

    preferences.push({
      statement,
      sourceIds: signal.trajectoryIds.slice(0, 5),
      category: "preference",
      confidence: signal.confidence,
      keywords: normalizeRecallTokens(signal.pattern, []).slice(0, 10),
    });
  }

  return preferences;
}

// ─── Causal Impact Score ─────────────────────────────────────────────────────

/**
 * Compute the causal impact score for a memory based on its
 * presence in causal chains. Used in lifecycle heat/decay.
 *
 * Formula: 0.1 * incomingEdges + 0.15 * outgoingEdges, clamped to [0, 0.3]
 */
export function computeCausalImpactScore(
  memoryId: string,
  chainIndex: CausalChainIndex,
): number {
  // Memory IDs don't directly map to trajectory IDs, but trajectory-based
  // memories may reference their source trajectory ID. For now, check
  // if the memoryId appears as a trajectory ID in the chain index.
  const incoming = chainIndex.incoming[memoryId]?.length ?? 0;
  const outgoing = chainIndex.outgoing[memoryId]?.length ?? 0;
  const raw = 0.1 * incoming + 0.15 * outgoing;
  return Math.min(0.3, Math.max(0, raw));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract all behavioral signals from causal trajectories and chain analysis.
 */
export async function extractCausalBehaviorSignals(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  config: BehaviorConfig;
}): Promise<CausalBehaviorSignal[]> {
  try {
    const { memoryDir, causalTrajectoryStoreDir, config: behaviorConfig } = options;

    // Read all trajectories
    const root = resolveCausalTrajectoryStoreDir(memoryDir, causalTrajectoryStoreDir);
    const trajectoriesDir = path.join(root, "trajectories");
    const files = await listJsonFiles(trajectoriesDir).catch(() => [] as string[]);

    const trajectories: CausalTrajectoryRecord[] = [];
    for (const filePath of files) {
      try {
        const raw = await readJsonFile(filePath);
        if (isRecord(raw) && typeof raw.trajectoryId === "string") {
          trajectories.push(raw as unknown as CausalTrajectoryRecord);
        }
      } catch {
        // skip
      }
    }

    if (trajectories.length === 0) return [];

    // Read chain index
    const chainsDir = resolveChainsDir(memoryDir, causalTrajectoryStoreDir);
    const chainIndex = await readChainIndex(chainsDir);

    // Extract all signal types
    const signals: CausalBehaviorSignal[] = [
      ...detectTopicRevisitation(trajectories, behaviorConfig),
      ...detectActionPatterns(trajectories, behaviorConfig),
      ...detectOutcomePreferences(trajectories, chainIndex, behaviorConfig),
    ];

    log.debug(`[cmc] extracted ${signals.length} behavioral signal(s) from ${trajectories.length} trajectories`);
    return signals;
  } catch (error) {
    log.warn(`[cmc] behavioral signal extraction failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
