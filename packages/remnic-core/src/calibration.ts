/**
 * calibration.ts — Prediction-Error-Driven Model-User Calibration
 *
 * Analyzes patterns in user corrections to identify systematic miscalibration
 * between the model's predictions and the user's actual expectations.
 * During consolidation, replays chains of similar corrections through an LLM
 * to synthesize CalibrationRules that adjust model behavior for this specific user.
 *
 * Inspired by:
 * - Cerebellar motor calibration (prediction errors drive lasting adjustments)
 * - Temporal difference learning (dopamine signals prediction error)
 * - Tesla FSD shadow mode (divergence between prediction and reality = training signal)
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { FallbackLlmClient } from "./fallback-llm.js";
import type { GatewayConfig, MemoryFile } from "./types.js";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import { isRecord } from "./store-contract.js";
import { log } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CalibrationRule {
  id: string;
  ruleType: "model_tendency" | "user_expectation" | "scope_boundary" | "verification_required";
  condition: string;
  modelTendency: string;
  userExpectation: string;
  calibration: string;
  confidence: number;
  evidenceCount: number;
  evidenceCorrectionIds: string[];
  createdAt: string;
  lastReinforcedAt: string;
}

export interface CalibrationIndex {
  rules: CalibrationRule[];
  updatedAt: string;
  totalCorrectionsAnalyzed: number;
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function calibrationDir(memoryDir: string): string {
  return path.join(memoryDir, "state", "calibration");
}

function calibrationIndexPath(memoryDir: string): string {
  return path.join(calibrationDir(memoryDir), "calibration-index.json");
}

export async function readCalibrationIndex(memoryDir: string): Promise<CalibrationIndex> {
  try {
    const raw = JSON.parse(await readFile(calibrationIndexPath(memoryDir), "utf8"));
    return {
      rules: Array.isArray(raw.rules) ? raw.rules : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      totalCorrectionsAnalyzed: typeof raw.totalCorrectionsAnalyzed === "number" ? raw.totalCorrectionsAnalyzed : 0,
    };
  } catch {
    return { rules: [], updatedAt: new Date().toISOString(), totalCorrectionsAnalyzed: 0 };
  }
}

async function writeCalibrationIndex(memoryDir: string, index: CalibrationIndex): Promise<void> {
  const dir = calibrationDir(memoryDir);
  await mkdir(dir, { recursive: true });
  index.updatedAt = new Date().toISOString();
  await writeFile(calibrationIndexPath(memoryDir), JSON.stringify(index, null, 2), "utf8");
}

// ─── Correction Reading ──────────────────────────────────────────────────────

export interface CorrectionMemory {
  id: string;
  content: string;
  created: string;
  confidence: number;
  entityRefs: string[];
  tags: string[];
}

const CALIBRATION_RULE_TYPES = new Set([
  "model_tendency",
  "user_expectation",
  "scope_boundary",
  "verification_required",
]);

function parseConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function parseEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Exported for entity-contamination R-11 regression coverage (#682
 * PR 2/3 — codex review).  Tests can drive the real correction-reading
 * path instead of duplicating the regex inline, so calibration parser
 * regressions surface via the contamination suite.
 */
export async function readCalibrationCorrections(memoryDir: string): Promise<CorrectionMemory[]> {
  return readCorrectionsImpl(memoryDir);
}

async function readCorrections(memoryDir: string): Promise<CorrectionMemory[]> {
  return readCorrectionsImpl(memoryDir);
}

async function readCorrectionsImpl(memoryDir: string): Promise<CorrectionMemory[]> {
  const correctionsDir = path.join(memoryDir, "corrections");
  const files = await listJsonFiles(correctionsDir).catch(() => {
    // Corrections might be in facts/ directories too
    return [] as string[];
  });

  // Also scan facts directories for correction-category files
  const factsDir = path.join(memoryDir, "facts");
  try {
    const { readdir } = await import("node:fs/promises");
    const dayDirs = (await readdir(factsDir)).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const day of dayDirs) {
      const dayPath = path.join(factsDir, day);
      const dayFiles = (await readdir(dayPath))
        .filter((f: string) => f.startsWith("correction-") && f.endsWith(".md"))
        .map((f: string) => path.join(dayPath, f));
      files.push(...dayFiles);
    }
  } catch {
    // facts dir might not exist
  }

  // Also check the dedicated corrections directory
  try {
    const { readdir } = await import("node:fs/promises");
    const corrFiles = (await readdir(correctionsDir))
      .filter((f: string) => f.endsWith(".md"))
      .map((f: string) => path.join(correctionsDir, f));
    files.push(...corrFiles);
  } catch {
    // corrections dir might not exist
  }

  const corrections: CorrectionMemory[] = [];
  const seen = new Set<string>();

  for (const filePath of files) {
    try {
      const raw = await readFile(filePath, "utf8");

      // Parse frontmatter
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) continue;

      const content = fmMatch[2].trim();
      if (!content || content.length < 10) continue;

      // Extract id from frontmatter
      const idMatch = fmMatch[1].match(/^id:\s*(.+)$/m);
      const id = idMatch?.[1]?.trim() ?? path.basename(filePath, ".md");

      if (seen.has(id)) continue;
      seen.add(id);

      const confMatch = fmMatch[1].match(/^confidence:\s*(.+)$/m);
      const confidence = confMatch ? parseFloat(confMatch[1]) : 0.9;

      const entityMatch = fmMatch[1].match(/^entityRef:\s*(.+)$/m);
      const entityRefs = entityMatch ? [entityMatch[1].trim()] : [];

      corrections.push({ id, content, created: "", confidence, entityRefs, tags: [] });
    } catch {
      // skip unparseable files
    }
  }

  return corrections;
}

// ─── LLM-Assisted Clustering and Replay ──────────────────────────────────────

const CLUSTER_PROMPT = `You are analyzing user corrections to an AI assistant. Each correction represents a moment where the assistant's prediction of what the user wanted was WRONG.

Your job: Group these corrections into clusters where the SAME TYPE of misunderstanding is happening. Then for each cluster, synthesize a CalibrationRule.

A CalibrationRule describes:
- condition: When does this type of mistake happen?
- modelTendency: What does the model tend to assume or do wrong?
- userExpectation: What does the user actually want instead?
- calibration: How should the model adjust its behavior?
- ruleType: One of "model_tendency", "user_expectation", "scope_boundary", "verification_required"

Focus on PATTERNS, not individual corrections. A cluster needs at least 2 corrections to be worth a rule.

Output valid JSON only:
{
  "rules": [
    {
      "ruleType": "model_tendency",
      "condition": "When discussing project scope or task boundaries",
      "modelTendency": "The model tends to assume broader scope than the user intends",
      "userExpectation": "The user prefers narrow, specific task definitions and wants to be asked before scope expansion",
      "calibration": "When uncertain about scope, ask for clarification rather than assuming. Default to the narrower interpretation.",
      "confidence": 0.85,
      "evidenceIds": ["correction-id-1", "correction-id-2"]
    }
  ]
}`;

export async function synthesizeCalibrationRules(
  corrections: CorrectionMemory[],
  llm: FallbackLlmClient,
  existingRules: CalibrationRule[],
  agentId?: string,
): Promise<CalibrationRule[]> {
  if (corrections.length < 2) return [];

  // Format corrections for the LLM
  const correctionText = corrections
    .slice(0, 50) // limit to avoid huge prompts
    .map((c, i) => `[${c.id}] ${c.content}`)
    .join("\n\n");

  const existingRulesText = existingRules.length > 0
    ? `\n\nExisting calibration rules (avoid duplicating these):\n${existingRules.map((r) => `- ${r.condition}: ${r.calibration}`).join("\n")}`
    : "";

  const response = await llm.chatCompletion(
    [
      { role: "system", content: CLUSTER_PROMPT },
      { role: "user", content: `Here are ${corrections.length} corrections from this user:\n\n${correctionText}${existingRulesText}` },
    ],
    { temperature: 0.3, maxTokens: 3000, agentId },
  );

  if (!response?.content) return [];

  try {
    let jsonStr = response.content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) jsonStr = fenceMatch[1];

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed.rules)) return [];

    const now = new Date().toISOString();
    const rawRules: unknown[] = Array.isArray(parsed.rules) ? parsed.rules : [];
    return rawRules
      .map((r: unknown): CalibrationRule | undefined => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return undefined;
        const raw = r as Record<string, unknown>;
        const ruleType = nonEmptyString(raw.ruleType);
        const condition = nonEmptyString(raw.condition);
        const modelTendency = nonEmptyString(raw.modelTendency);
        const calibration = nonEmptyString(raw.calibration);
        const confidence = parseConfidence(raw.confidence);
        if (
          !ruleType ||
          !CALIBRATION_RULE_TYPES.has(ruleType) ||
          !condition ||
          !modelTendency ||
          !calibration ||
          confidence === undefined
        ) {
          return undefined;
        }
        const evidenceCorrectionIds = parseEvidenceIds(raw.evidenceIds);
        return {
          id: `cal-${createHash("sha256").update(condition + calibration).digest("hex").slice(0, 12)}`,
          ruleType: ruleType as CalibrationRule["ruleType"],
          condition,
          modelTendency,
          userExpectation: nonEmptyString(raw.userExpectation) ?? "",
          calibration,
          confidence,
          evidenceCount: evidenceCorrectionIds.length,
          evidenceCorrectionIds,
        createdAt: now,
        lastReinforcedAt: now,
        };
      })
      .filter((rule): rule is CalibrationRule => !!rule);
  } catch {
    log.warn("[calibration] failed to parse LLM response");
    return [];
  }
}

// ─── Recall Section ──────────────────────────────────────────────────────────

/**
 * Build a recall section from calibration rules relevant to the current query.
 * Uses the LLM to select which rules apply to the current context.
 */
export function buildCalibrationRecallSection(
  rules: CalibrationRule[],
  query: string,
  maxChars: number = 1200,
): string | null {
  if (rules.length === 0) return null;

  // Simple relevance: include all rules (they're already filtered to this user)
  // In production, could use embedding similarity to filter
  const lines: string[] = [
    "## Model Calibration (learned from past corrections)",
    "",
    "Adjustments for this specific user, learned from patterns in their corrections:",
    "",
  ];

  let totalChars = lines.join("\n").length;

  for (const rule of rules) {
    const line = `- **${rule.condition}**: ${rule.modelTendency} → Instead: ${rule.calibration}`;
    if (totalChars + line.length + 1 > maxChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  if (lines.length <= 4) return null;
  lines.push("");
  return lines.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the full calibration pipeline:
 * 1. Read all corrections
 * 2. Send to LLM for clustering and rule synthesis
 * 3. Merge with existing rules
 * 4. Write updated index
 */
export async function runCalibrationConsolidation(options: {
  memoryDir: string;
  gatewayConfig?: GatewayConfig;
  gatewayAgentId?: string;
  workspaceDir?: string;
}): Promise<CalibrationRule[]> {
  try {
    const llm = new FallbackLlmClient(options.gatewayConfig, {
      workspaceDir: options.workspaceDir,
    });
    if (!llm.isAvailable(options.gatewayAgentId)) {
      log.debug("[calibration] no LLM available — skipping consolidation");
      return [];
    }

    const corrections = await readCorrections(options.memoryDir);
    if (corrections.length < 3) {
      log.debug(`[calibration] only ${corrections.length} corrections — need at least 3`);
      return [];
    }

    const existingIndex = await readCalibrationIndex(options.memoryDir);

    const newRules = await synthesizeCalibrationRules(corrections, llm, existingIndex.rules, options.gatewayAgentId);
    if (newRules.length === 0) {
      log.debug("[calibration] no new calibration rules synthesized");
      return existingIndex.rules;
    }

    // Merge: keep existing rules, add new ones (deduplicate by id)
    const ruleMap = new Map(existingIndex.rules.map((r) => [r.id, r]));
    for (const rule of newRules) {
      if (ruleMap.has(rule.id)) {
        // Reinforce existing rule
        const existing = ruleMap.get(rule.id)!;
        existing.lastReinforcedAt = new Date().toISOString();
        existing.evidenceCount += rule.evidenceCount;
        existing.confidence = Math.min(1, existing.confidence + 0.05);
      } else {
        ruleMap.set(rule.id, rule);
      }
    }

    const allRules = [...ruleMap.values()];
    await writeCalibrationIndex(options.memoryDir, {
      rules: allRules,
      updatedAt: new Date().toISOString(),
      totalCorrectionsAnalyzed: corrections.length,
    });

    log.debug(`[calibration] synthesized ${newRules.length} new rule(s), ${allRules.length} total`);
    return allRules;
  } catch (error) {
    log.warn(`[calibration] consolidation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Standalone entry point for calibration consolidation that can be called
 * independently of weekly compounding. The compounding engine's
 * `synthesizeWeekly()` is one trigger, but orchestrators or periodic
 * maintenance jobs should call this directly so calibration is not gated
 * on weekly compounding being enabled.
 */
export async function runCalibrationIfEnabled(options: {
  memoryDir: string;
  calibrationEnabled: boolean;
  gatewayConfig?: GatewayConfig;
  workspaceDir?: string;
}): Promise<CalibrationRule[]> {
  if (!options.calibrationEnabled) {
    return [];
  }
  return runCalibrationConsolidation({
    memoryDir: options.memoryDir,
    gatewayConfig: options.gatewayConfig,
    workspaceDir: options.workspaceDir,
  });
}

/**
 * Get calibration rules for recall injection.
 * Reads the pre-computed calibration index.
 */
export async function getCalibrationRulesForRecall(
  memoryDir: string,
): Promise<CalibrationRule[]> {
  const index = await readCalibrationIndex(memoryDir);
  return index.rules;
}
