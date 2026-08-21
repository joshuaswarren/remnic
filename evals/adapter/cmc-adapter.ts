/**
 * CMC-enhanced lightweight adapter for benchmarks.
 *
 * Combines:
 * 1. LCM + FTS (fast, no LLM needed) — base recall
 * 2. IRC preference synthesis from LCM text — preference reformulation
 * 3. CMC causal trajectory extraction — derives trajectories from conversations
 * 4. CMC behavioral preference augmentation — learns preferences from patterns
 * 5. CMC retrieval — walks causal chains for multi-session context
 *
 * This adapter is designed to exercise CMC features during benchmarks
 * without requiring LLM access or external services.
 */

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MemorySystem, Message, SearchResult, MemoryStats } from "./types.js";
import type { PluginConfig } from "../../src/types.js";
import { LcmEngine } from "../../src/lcm/engine.js";
import { synthesizePreferencesFromLcm } from "../../src/compounding/preference-consolidator.js";
import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../../src/causal-trajectory.js";
import { stitchCausalChain } from "../../src/causal-chain.js";
import { retrieveCausalChains } from "../../src/causal-retrieval.js";
import { extractCausalBehaviorSignals, synthesizeCausalPreferences } from "../../src/causal-behavior.js";

/** Deterministic summarizer — truncates rather than calling an LLM. */
async function deterministicSummarize(
  text: string,
  targetTokens: number,
): Promise<string | null> {
  const targetChars = targetTokens * 4;
  if (text.length <= targetChars) return text;
  return text.slice(0, targetChars) + "…";
}

/**
 * Extract a lightweight causal trajectory from a conversation session.
 * This is a heuristic extraction — no LLM needed.
 *
 * Strategy: scan user messages for goal-like statements (questions, requests),
 * and assistant responses for action/outcome patterns. Extract preference
 * signals, entity mentions, and topic keywords.
 */
export function extractTrajectoryFromConversation(
  sessionId: string,
  messages: Message[],
): CausalTrajectoryRecord | null {
  if (messages.length < 2) return null;

  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  if (userMessages.length === 0) return null;

  // Goal = first user message (typically the request/question)
  const goal = userMessages[0].content.slice(0, 300);

  // Action = first assistant response summary
  const action = assistantMessages.length > 0
    ? assistantMessages[0].content.slice(0, 300)
    : "No assistant response";

  // Observation = last user message if multi-turn (follow-up or acknowledgment)
  const observation = userMessages.length > 1
    ? userMessages[userMessages.length - 1].content.slice(0, 200)
    : "Single-turn conversation";

  // Outcome = infer from conversation flow
  const lastMsg = messages[messages.length - 1];
  const outcomeKind = lastMsg.role === "assistant" ? "success" as const : "partial" as const;
  const outcome = lastMsg.content.slice(0, 200);

  // Extract entity-like references (capitalized multi-word phrases)
  const entityPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  const entities = new Set<string>();
  for (const msg of messages) {
    entityPattern.lastIndex = 0;
    let match;
    while ((match = entityPattern.exec(msg.content)) !== null) {
      entities.add(match[1]);
    }
  }

  // Extract topic tags from user messages
  const tags = extractTopicTags(userMessages.map((m) => m.content).join(" "));

  // Follow-up: extract preference signals that could connect to future sessions
  const followUp = extractPreferenceFollowUp(messages);

  const trajectoryId = `eval-traj-${createHash("sha256").update(sessionId + goal).digest("hex").slice(0, 12)}`;

  return {
    schemaVersion: 1,
    trajectoryId,
    recordedAt: new Date().toISOString(),
    sessionKey: sessionId,
    goal,
    actionSummary: action,
    observationSummary: observation,
    outcomeKind,
    outcomeSummary: outcome,
    followUpSummary: followUp ?? undefined,
    entityRefs: [...entities].slice(0, 10),
    tags: tags.slice(0, 10),
  };
}

/**
 * Extract topic tags from text using keyword frequency.
 */
function extractTopicTags(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const stopWords = new Set([
    "that", "this", "with", "from", "have", "been", "will", "would",
    "could", "should", "about", "their", "there", "which", "these",
    "those", "some", "more", "also", "been", "were", "what", "when",
    "your", "just", "like", "know", "think", "want", "need", "make",
    "very", "much", "many", "such", "than", "then", "them", "only",
  ]);

  const freq = new Map<string, number>();
  for (const w of words) {
    if (!stopWords.has(w)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

/**
 * Extract preference-related follow-up context from conversation.
 * Looks for explicit preference signals that could connect to future sessions.
 */
function extractPreferenceFollowUp(messages: Message[]): string | null {
  const prefPatterns = [
    /\b(?:I|i)\s+(?:prefer|enjoy|like|love|use|favor)\s+(.+?)(?:\.|,|!|\?|$)/,
    /\bmy\s+(?:favorite|preferred|go-to)\s+(.+?)(?:\.|,|!|\?|$)/i,
    /\b(?:I'm|I am)\s+(?:interested in|passionate about|focused on)\s+(.+?)(?:\.|,|!|\?|$)/i,
    /\b(?:I'd|I would)\s+(?:rather|prefer)\s+(.+?)(?:\.|,|!|\?|$)/i,
  ];

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const pattern of prefPatterns) {
      const match = msg.content.match(pattern);
      if (match) {
        return `User expressed preference: ${match[0].trim()}`;
      }
    }
  }
  return null;
}

/**
 * Create a CMC-enhanced lightweight adapter.
 */
export async function createCmcAdapter(): Promise<MemorySystem> {
  let tempDir = await mkdtemp(path.join(tmpdir(), "engram-eval-cmc-"));
  await mkdir(path.join(tempDir, "state"), { recursive: true });

  const buildPluginConfig = (dir: string) =>
    ({
      memoryDir: dir,
      lcmEnabled: true,
      lcmLeafBatchSize: 4,
      lcmRollupFanIn: 3,
      lcmFreshTailTurns: 8,
      lcmMaxDepth: 4,
      lcmDeterministicMaxTokens: 512,
      lcmRecallBudgetShare: 1.0,
      lcmArchiveRetentionDays: 365,
      ircEnabled: true,
      ircMaxPreferences: 20,
      cmcEnabled: true,
      cmcStitchLookbackDays: 30,
      cmcStitchMinScore: 1.5, // Lower threshold for eval (fewer trajectories)
      cmcStitchMaxEdgesPerTrajectory: 5,
      cmcRetrievalEnabled: true,
      cmcRetrievalMaxDepth: 3,
      cmcRetrievalMaxChars: 1200,
      cmcRetrievalCounterfactualBoost: 0.4,
      cmcBehaviorLearningEnabled: true,
      cmcBehaviorMinFrequency: 2, // Lower for eval (fewer sessions)
      cmcBehaviorMinSessions: 1,
      cmcBehaviorConfidenceThreshold: 0.4,
    }) as unknown as PluginConfig;

  const summarizeFn = deterministicSummarize;
  let engine = new LcmEngine(buildPluginConfig(tempDir), summarizeFn);
  let sessionTrajectoryCount = 0;

  return {
    async store(sessionId: string, messages: Message[]): Promise<void> {
      // 1. Store in LCM (standard)
      await engine.observeMessages(
        sessionId,
        messages.map((m) => ({ role: m.role, content: m.content })),
      );

      // 2. Extract and record a causal trajectory from this conversation
      const trajectory = extractTrajectoryFromConversation(sessionId, messages);
      if (trajectory) {
        try {
          await recordCausalTrajectory({
            memoryDir: tempDir,
            record: trajectory,
            cmcEnabled: true,
            cmcStitchLookbackDays: 30,
            cmcStitchMinScore: 1.5,
            cmcStitchMaxEdgesPerTrajectory: 5,
          });
          sessionTrajectoryCount++;
        } catch {
          // Non-fatal
        }
      }
    },

    async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
      const budget = budgetChars ?? 32000;
      const sections: string[] = [];

      // 1. LCM FTS search (standard)
      if (query) {
        try {
          const searchResults = await engine.searchContextFull(query, 20, sessionId);
          if (searchResults.length > 0) {
            const searchSection = searchResults
              .map((r: any) => `[turn ${r.turn_index}, ${r.role}]: ${r.content}`)
              .join("\n\n");
            sections.push(`## Relevant search results\n${searchSection}`);
          }
        } catch {
          // FTS search failed
        }
      }

      // 2. LCM compressed history
      try {
        const recallText = await engine.assembleRecall(sessionId, Math.floor(budget / 2));
        if (recallText) {
          sections.push(recallText);
        }
      } catch {
        // Non-fatal
      }

      // 3. IRC preference synthesis from LCM text
      if (query) {
        try {
          const ircSection = await synthesizePreferencesFromLcm(
            engine,
            query,
            sessionId,
            20,
          );
          if (ircSection) {
            sections.push(ircSection);
          }
        } catch {
          // IRC is non-fatal
        }
      }

      // 4. CMC causal retrieval (walks chain graph)
      if (query) {
        try {
          const cmcSection = await retrieveCausalChains({
            memoryDir: tempDir,
            query,
            sessionKey: sessionId,
            config: {
              maxDepth: 3,
              maxChars: 1200,
              counterfactualBoost: 0.4,
            },
          });
          if (cmcSection) {
            sections.push(cmcSection);
          }
        } catch {
          // CMC retrieval is non-fatal
        }
      }

      // 5. CMC behavioral preferences
      if (query && sessionTrajectoryCount >= 2) {
        try {
          const signals = await extractCausalBehaviorSignals({
            memoryDir: tempDir,
            config: {
              minFrequency: 2,
              minSessions: 1,
              confidenceThreshold: 0.4,
            },
          });
          if (signals.length > 0) {
            const prefs = synthesizeCausalPreferences(signals, 0.4);
            if (prefs.length > 0) {
              const prefLines = prefs.map((p) => `- ${p.statement}`);
              sections.push(`## Behavioral Preferences (from causal patterns)\n${prefLines.join("\n")}`);
            }
          }
        } catch {
          // Non-fatal
        }
      }

      // 6. Fallback if nothing found
      if (sections.length === 0) {
        try {
          const stats = await engine.getStats(sessionId);
          if (stats.totalMessages > 0) {
            const expanded = await engine.expandContext(
              sessionId, 0, stats.totalMessages - 1,
              Math.floor(budget / 4),
            );
            if (expanded.length > 0) {
              const raw = expanded
                .map((m: any) => `[${m.role}]: ${m.content}`)
                .join("\n");
              sections.push(`## Raw messages\n${raw}`);
            }
          }
        } catch {
          // Non-fatal
        }
      }

      const joined = sections.join("\n\n");
      return joined.length > budget ? joined.slice(0, budget) : joined;
    },

    async search(
      query: string,
      limit: number,
      sessionId?: string,
    ): Promise<SearchResult[]> {
      if (!engine.enabled) return [];
      const results = await engine.searchContext(query, limit, sessionId);
      return results.map((r) => ({
        turnIndex: r.turn_index,
        role: r.role,
        snippet: r.snippet,
        sessionId: r.session_id,
      }));
    },

    async reset(_sessionId?: string): Promise<void> {
      engine.close();
      await rm(tempDir, { recursive: true, force: true });
      tempDir = await mkdtemp(path.join(tmpdir(), "engram-eval-cmc-"));
      await mkdir(path.join(tempDir, "state"), { recursive: true });
      engine = new LcmEngine(buildPluginConfig(tempDir), summarizeFn);
      sessionTrajectoryCount = 0;
    },

    async getStats(sessionId?: string): Promise<MemoryStats> {
      return engine.getStats(sessionId);
    },

    async destroy(): Promise<void> {
      engine.close();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
