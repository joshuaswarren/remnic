/**
 * causal-consolidation.ts — CMC Phase 2: LLM-Assisted Causal Consolidation
 *
 * Uses an LLM to analyze causal trajectory patterns across sessions.
 * The LLM receives the causal chain graph as context — connected trajectories
 * from different sessions — and identifies recurring behavioral patterns,
 * preference signals, and actionable rules.
 *
 * This is the core CMC innovation: the LLM gets cross-session causal context
 * that no other memory system provides. It can see that a user investigated
 * a bug in session 1, attempted a fix in session 2, and succeeded in session 3 —
 * and synthesize a rule or preference from that chain.
 */

import { createHash } from "node:crypto";
import { resolveCausalTrajectoryStoreDir, type CausalTrajectoryRecord } from "./causal-trajectory.js";
import { readChainIndex, resolveChainsDir, type CausalChainIndex, type CausalEdge } from "./causal-chain.js";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import { isRecord } from "./store-contract.js";
import { FallbackLlmClient } from "./fallback-llm.js";
import type { GatewayConfig, MemoryFile, PluginConfig } from "./types.js";
import path from "node:path";
import { log } from "./logger.js";
import { runPostConsolidationMaterialize } from "./connectors/codex-materialize-runner.js";
import type { MaterializeResult, RolloutSummaryInput } from "./connectors/codex-materialize.js";
import { buildExtensionsBlockForConsolidation } from "./semantic-consolidation.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CausalPatternCandidate {
  id: string;
  sourceType: "causal-pattern";
  subject: string;
  category: "principle" | "rule";
  content: string;
  score: number;
  rationale: string;
  outcome: null;
  provenance: string[];
  agent: string | null;
  workflow: string | null;
}

export interface ConsolidationConfig {
  minRecurrence: number;
  minSessions: number;
  successThreshold: number;
}

export interface LlmConsolidationResult {
  rules: Array<{
    content: string;
    category: "rule" | "principle" | "preference";
    confidence: number;
    evidence: string[];
  }>;
  preferences: Array<{
    statement: string;
    confidence: number;
    evidence: string[];
  }>;
}

// ─── Trajectory Reading ──────────────────────────────────────────────────────

async function readAllTrajectories(
  memoryDir: string,
  causalTrajectoryStoreDir?: string,
): Promise<CausalTrajectoryRecord[]> {
  const root = resolveCausalTrajectoryStoreDir(memoryDir, causalTrajectoryStoreDir);
  const trajectoriesDir = path.join(root, "trajectories");

  const files = await listJsonFiles(trajectoriesDir).catch(() => [] as string[]);
  const results: CausalTrajectoryRecord[] = [];

  for (const filePath of files) {
    try {
      const raw = await readJsonFile(filePath);
      if (isRecord(raw) && typeof raw.trajectoryId === "string") {
        results.push(raw as unknown as CausalTrajectoryRecord);
      }
    } catch {
      // skip invalid
    }
  }

  return results;
}

// ─── Context Formatting ──────────────────────────────────────────────────────

/**
 * Format trajectories and their causal connections as a readable context
 * for the LLM. Groups by session and shows chain connections.
 */
function formatCausalContext(
  trajectories: CausalTrajectoryRecord[],
  chainIndex: CausalChainIndex,
  maxChars: number = 8000,
): string {
  // Group trajectories by session
  const bySession = new Map<string, CausalTrajectoryRecord[]>();
  for (const t of trajectories) {
    const list = bySession.get(t.sessionKey) ?? [];
    list.push(t);
    bySession.set(t.sessionKey, list);
  }

  const lines: string[] = [];
  lines.push(`## Causal Trajectories (${trajectories.length} across ${bySession.size} sessions)`);
  lines.push("");

  // Format each session's trajectories
  for (const [sessionKey, sessionTrajs] of bySession) {
    lines.push(`### Session: ${sessionKey}`);
    for (const t of sessionTrajs.slice(0, 5)) {
      const outcome = t.outcomeKind === "success" ? "+" : t.outcomeKind === "failure" ? "-" : "~";
      lines.push(`[${outcome}] Goal: ${t.goal}`);
      lines.push(`    Action: ${t.actionSummary}`);
      lines.push(`    Outcome: ${t.outcomeSummary}`);
      if (t.followUpSummary) lines.push(`    Follow-up: ${t.followUpSummary}`);
      if (t.entityRefs?.length) lines.push(`    Entities: ${t.entityRefs.join(", ")}`);
    }
    lines.push("");
  }

  // Format causal chain connections
  const edgeCount = Object.keys(chainIndex.edges).length;
  if (edgeCount > 0) {
    lines.push(`## Cross-Session Causal Chains (${edgeCount} connections)`);
    lines.push("");

    const trajectoryMap = new Map(trajectories.map((t) => [t.trajectoryId, t]));
    const shown = new Set<string>();

    for (const [edgeId, edge] of Object.entries(chainIndex.edges)) {
      if (shown.size >= 10) break; // limit output size
      const from = trajectoryMap.get(edge.fromTrajectoryId);
      const to = trajectoryMap.get(edge.toTrajectoryId);
      if (!from || !to) continue;

      lines.push(`${edge.edgeType}: "${from.goal}" (${from.sessionKey}) → "${to.goal}" (${to.sessionKey})`);
      shown.add(edgeId);
    }
    lines.push("");
  }

  const result = lines.join("\n");
  return result.length > maxChars ? result.slice(0, maxChars) + "\n[truncated]" : result;
}

// ─── LLM Consolidation ──────────────────────────────────────────────────────

const CONSOLIDATION_PROMPT = `You are analyzing a user's causal trajectory history across multiple sessions. Trajectories record what the user tried to do (goal), what they did (action), and what happened (outcome).

Your job is to identify:
1. BEHAVIORAL RULES: Recurring patterns where the same approach consistently succeeds or fails. These should be actionable guidance for future sessions.
2. PREFERENCES: What the user cares about, prefers, or consistently chooses — even if never explicitly stated. Infer preferences from what they repeatedly do, retry until successful, or always include in their workflow.

IMPORTANT:
- Look for CROSS-SESSION patterns — things that repeat across different sessions are more significant than within-session patterns.
- A user who retries the same goal across sessions has a strong implicit preference for that outcome.
- Consistent action choices reveal preferences even when the user never says "I prefer X."
- Frame preferences as "The user would prefer responses that..." when applicable.

Output valid JSON only:
{
  "rules": [
    {"content": "actionable rule text", "category": "rule|principle", "confidence": 0.0-1.0, "evidence": ["trajectory IDs"]}
  ],
  "preferences": [
    {"statement": "The user would prefer...", "confidence": 0.0-1.0, "evidence": ["trajectory IDs"]}
  ]
}

If no clear patterns exist, return {"rules": [], "preferences": []}.`;

async function consolidateWithLlm(
  context: string,
  llm: FallbackLlmClient,
  agentId?: string,
): Promise<LlmConsolidationResult> {
  const response = await llm.chatCompletion(
    [
      { role: "system", content: CONSOLIDATION_PROMPT },
      { role: "user", content: context },
    ],
    { temperature: 0.2, maxTokens: 2000, agentId },
  );

  if (!response?.content) {
    return { rules: [], preferences: [] };
  }

  try {
    // Extract JSON from response (may have markdown code fences)
    let jsonStr = response.content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) jsonStr = fenceMatch[1];

    const parsed = JSON.parse(jsonStr);
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules.filter(
        (r: any) => typeof r.content === "string" && r.content.length > 5,
      ) : [],
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences.filter(
        (p: any) => typeof p.statement === "string" && p.statement.length > 5,
      ) : [],
    };
  } catch {
    log.warn("[cmc] failed to parse LLM consolidation response");
    return { rules: [], preferences: [] };
  }
}

// ─── Candidate Generation ────────────────────────────────────────────────────

function stablePatternId(content: string): string {
  const digest = createHash("sha256")
    .update(`causal-pattern\0${content}`)
    .digest("hex")
    .slice(0, 16);
  return `causal-pattern:${digest}`;
}

function llmResultToCandidates(result: LlmConsolidationResult): CausalPatternCandidate[] {
  const candidates: CausalPatternCandidate[] = [];

  for (const rule of result.rules) {
    const category = rule.category === "principle" ? "principle" : "rule";
    candidates.push({
      id: stablePatternId(rule.content),
      sourceType: "causal-pattern",
      subject: rule.content.slice(0, 80),
      category,
      content: rule.content,
      score: Math.min(1, rule.confidence ?? 0.7),
      rationale: "LLM-identified causal pattern from cross-session trajectory analysis",
      outcome: null,
      provenance: (rule.evidence ?? []).slice(0, 5),
      agent: null,
      workflow: null,
    });
  }

  return candidates;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run LLM-assisted consolidation: read trajectories, format causal context,
 * ask LLM to identify patterns and preferences.
 */
export async function deriveCausalPromotionCandidates(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  config: ConsolidationConfig;
  gatewayConfig?: GatewayConfig;
  gatewayAgentId?: string;
  workspaceDir?: string;
  pluginConfig?: PluginConfig;
}): Promise<CausalPatternCandidate[]> {
  try {
    const trajectories = await readAllTrajectories(options.memoryDir, options.causalTrajectoryStoreDir);
    if (trajectories.length < options.config.minRecurrence) return [];

    const chainsDir = resolveChainsDir(options.memoryDir, options.causalTrajectoryStoreDir);
    const chainIndex = await readChainIndex(chainsDir);

    // Format the causal context for the LLM
    let context = formatCausalContext(trajectories, chainIndex);

    // Append memory extensions block if available (#382)
    if (options.pluginConfig) {
      const extBlock = await buildExtensionsBlockForConsolidation(options.pluginConfig);
      if (extBlock.length > 0) {
        context += "\n\n" + extBlock;
      }
    }

    // If no LLM available, fall back to empty (no deterministic fallback)
    const llm = new FallbackLlmClient(options.gatewayConfig, {
      workspaceDir: options.pluginConfig?.workspaceDir ?? options.workspaceDir,
    });
    if (!llm.isAvailable(options.gatewayAgentId)) {
      log.debug("[cmc] no LLM available for consolidation — skipping");
      return [];
    }

    // Call LLM for pattern analysis
    const result = await consolidateWithLlm(context, llm, options.gatewayAgentId);
    const candidates = llmResultToCandidates(result);

    log.debug(`[cmc] LLM consolidation produced ${candidates.length} rule(s) and ${result.preferences.length} preference(s)`);
    return candidates;
  } catch (error) {
    log.warn(`[cmc] consolidation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Get LLM-synthesized preferences from causal trajectory analysis.
 * Returns formatted preference statements for recall injection.
 */
export async function synthesizeCausalPreferencesViaLlm(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  gatewayConfig?: GatewayConfig;
  gatewayAgentId?: string;
  workspaceDir?: string;
  minTrajectories?: number;
}): Promise<string | null> {
  try {
    const trajectories = await readAllTrajectories(options.memoryDir, options.causalTrajectoryStoreDir);
    if (trajectories.length < (options.minTrajectories ?? 2)) return null;

    const chainsDir = resolveChainsDir(options.memoryDir, options.causalTrajectoryStoreDir);
    const chainIndex = await readChainIndex(chainsDir);
    const context = formatCausalContext(trajectories, chainIndex);

    const llm = new FallbackLlmClient(options.gatewayConfig, {
      workspaceDir: options.workspaceDir,
    });
    if (!llm.isAvailable(options.gatewayAgentId)) return null;

    const result = await consolidateWithLlm(context, llm, options.gatewayAgentId);
    if (result.preferences.length === 0 && result.rules.length === 0) return null;

    const lines: string[] = ["## Behavioral Insights (from Causal Chain Analysis)", ""];

    for (const pref of result.preferences) {
      lines.push(`- ${pref.statement}`);
    }

    for (const rule of result.rules) {
      lines.push(`- ${rule.content}`);
    }

    lines.push("");
    return lines.join("\n");
  } catch (error) {
    log.warn(`[cmc] preference synthesis failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Optional post-consolidation hook — materializes Codex-native memory artifacts
 * after a causal consolidation run. Guarded by `codexMaterializeMemories` and
 * `codexMaterializeOnConsolidation`. Returns `null` when disabled or when the
 * sentinel is missing (honors user hand-edits).
 *
 * Split from the orchestrator-owned flow so #378 avoids touching
 * orchestrator.ts while Wave 1 edits are in flight.
 */
export async function materializeAfterCausalConsolidation(options: {
  config: PluginConfig;
  namespace?: string;
  memories?: MemoryFile[];
  memoryDir?: string;
  codexHome?: string;
  rolloutSummaries?: RolloutSummaryInput[];
  now?: Date;
}): Promise<MaterializeResult | null> {
  // Delegates to the shared post-consolidation helper — see
  // runPostConsolidationMaterialize in codex-materialize-runner.ts.
  return runPostConsolidationMaterialize("[cmc]", options);
}
