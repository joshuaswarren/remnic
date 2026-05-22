import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import { StorageManager } from "../storage.js";
import type { ContinuityIncidentRecord, PluginConfig } from "../types.js";
import { resolveSharedContextDir, SharedFeedbackEntrySchema, type SharedFeedbackEntry } from "../shared-context/manager.js";
import { parseContinuityImprovementLoops } from "../identity-continuity.js";

type MistakesFile = {
  version?: number;
  updatedAt: string;
  patterns: string[];
  registry?: MistakeRegistryEntry[];
};

type FeedbackEntryWithProvenance = {
  entry: SharedFeedbackEntry;
  sourceLine: number;
  sourcePath: string;
  entryId: string;
};

type PatternWithProvenance = {
  pattern: string;
  provenance: string[];
};

type ActionOutcomeCounts = {
  applied: number;
  skipped: number;
  failed: number;
};

type ActionOutcomeSummary = {
  action: string;
  counts: ActionOutcomeCounts;
  total: number;
  weightedScore: number;
  provenance: string[];
};

type PromotionCandidate = {
  id: string;
  sourceType: "action-outcome" | "mistake-pattern" | "rubric" | "causal-pattern";
  subject: string;
  category: "principle" | "rule" | "preference";
  content: string;
  score: number;
  rationale: string;
  outcome: ActionOutcomeCounts | null;
  provenance: string[];
  agent: string | null;
  workflow: string | null;
};

type CompoundingEntrySeverity = "low" | "medium" | "high";

type EvidenceWindow = {
  start: string | null;
  end: string | null;
};

type MistakeRegistryEntry = {
  id: string;
  pattern: string;
  category: "feedback" | "action";
  status: "active" | "retired";
  agent: string | null;
  workflow: string | null;
  tags: string[];
  severity: CompoundingEntrySeverity | null;
  confidence: number | null;
  outcome: string | null;
  provenance: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  recurrenceCount: number;
  lastWeekId: string;
  evidenceWindow: EvidenceWindow;
  mergedFromIds?: string[];
  retiredAt?: string | null;
};

type RubricSnapshotEntry = {
  id: string;
  kind: "agent" | "workflow";
  subject: string;
  observations: string[];
  tags: string[];
  provenance: string[];
  observationEntries?: Array<{
    note: string;
    provenance: string[];
  }>;
  updatedAt: string;
};

type RubricSnapshot = {
  updatedAt: string;
  agents: RubricSnapshotEntry[];
  workflows: RubricSnapshotEntry[];
};

type WeeklyCompoundingArtifact = {
  version: number;
  generatedAt: string;
  weekId: string;
  feedback: {
    count: number;
    byDecision: Record<"approved" | "approved_with_feedback" | "rejected", number>;
    entries: Array<{
      agent: string;
      workflow: string | null;
      decision: SharedFeedbackEntry["decision"];
      reason: string;
      learning: string | null;
      outcome: string | null;
      severity: CompoundingEntrySeverity | null;
      confidence: number | null;
      tags: string[];
      provenance: string;
      evidenceWindow: EvidenceWindow;
    }>;
  };
  mistakes: {
    count: number;
    patterns: string[];
    registry: MistakeRegistryEntry[];
  };
  rubrics: RubricSnapshot;
  outcomes: ActionOutcomeSummary[];
  promotionCandidates: PromotionCandidate[];
  continuity: { monthId: string; weeklyPath: string | null; monthlyPath: string | null };
};

export interface CompoundingPromotionReport {
  enabled: boolean;
  dryRun: boolean;
  weekId: string;
  promoted: Array<{
    id: string;
    candidateId: string;
    category: "principle" | "rule" | "preference";
    content: string;
    confidence: number;
    tags: string[];
    lineage: string[];
  }>;
  skipped: Array<{
    weekId: string;
    candidateId?: string;
    reason: "disabled" | "weekly-artifact-missing" | "candidate-not-found" | "duplicate-guidance";
    existingMemoryId?: string;
  }>;
}

type WeeklyActionEvent = {
  line: number;
  action: string;
  outcome: "applied" | "skipped" | "failed";
  policyDecision: "deny" | "defer" | null;
  namespace: string;
  reason: string | null;
};

const COMPOUNDING_VERSION = 2;
const RETIREMENT_WINDOW_WEEKS = 8;

function stableSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function tokenizeRecallQuery(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function weekIdToIndex(weekId: string): number {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
    return Number.POSITIVE_INFINITY;
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const isoWeekOneStart = new Date(jan4);
  isoWeekOneStart.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const targetWeekStart = new Date(isoWeekOneStart);
  targetWeekStart.setUTCDate(isoWeekOneStart.getUTCDate() + ((week - 1) * 7));
  return Math.floor(targetWeekStart.getTime() / (7 * 24 * 60 * 60 * 1000));
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const clamped = Math.max(0, Math.min(1, value));
  return Number(clamped.toFixed(3));
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((tag) => String(tag).trim()).filter((tag) => tag.length > 0))].sort();
}

function normalizeEvidenceWindow(start?: string, end?: string): EvidenceWindow {
  const safeStart = typeof start === "string" && start.trim().length > 0 ? start : null;
  const safeEnd = typeof end === "string" && end.trim().length > 0 ? end : null;
  return { start: safeStart, end: safeEnd };
}

function mergeEvidenceWindows(current: EvidenceWindow, next: EvidenceWindow): EvidenceWindow {
  return {
    start: current.start === null ? next.start : next.start === null ? current.start : current.start <= next.start ? current.start : next.start,
    end: current.end === null ? next.end : next.end === null ? current.end : current.end >= next.end ? current.end : next.end,
  };
}

function stableMistakeId(
  category: "feedback" | "action",
  pattern: string,
  agent: string | null,
  workflow: string | null,
): string {
  return [
    category,
    agent ? stableSlug(agent) : "global",
    workflow ? stableSlug(workflow) : "default",
    stableSlug(pattern).slice(0, 48),
  ].join(":");
}

function stableRubricId(kind: "agent" | "workflow", subject: string): string {
  return `${kind}:${stableSlug(subject)}`;
}

function stablePromotionCandidateId(
  sourceType: PromotionCandidate["sourceType"],
  subject: string,
  content: string,
): string {
  const digest = createHash("sha256")
    .update(`${sourceType}\u0000${subject}\u0000${content}`)
    .digest("hex")
    .slice(0, 12);
  return `${sourceType}:${digest}`;
}

function rubricArtifactFileName(
  entry: Pick<RubricSnapshotEntry, "kind" | "subject">,
  slugCollisions: ReadonlyMap<string, number>,
): string {
  const slug = stableSlug(entry.subject);
  if ((slugCollisions.get(slug) ?? 0) <= 1) return `${slug}.md`;
  const suffix = createHash("sha256").update(`${entry.kind}:${entry.subject}`).digest("hex").slice(0, 8);
  return `${slug}-${suffix}.md`;
}

function inferLegacyMistakeScope(pattern: string): { agent: string | null; workflow: string | null } {
  const separatorIndex = pattern.indexOf(":");
  if (separatorIndex <= 0) return { agent: null, workflow: null };
  const subject = pattern.slice(0, separatorIndex).trim();
  return {
    agent: subject.length > 0 ? subject : null,
    workflow: null,
  };
}

function inferLegacyMistakeMetadata(pattern: string): {
  category: "feedback" | "action";
  agent: string | null;
  workflow: string | null;
} {
  if (pattern.startsWith("memory-action/")) {
    return {
      category: "action",
      agent: null,
      workflow: "memory-actions",
    };
  }
  const scope = inferLegacyMistakeScope(pattern);
  return {
    category: "feedback",
    agent: scope.agent,
    workflow: scope.workflow,
  };
}

function normalizePromotionWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingPromotionPunctuation(value: string): string {
  return value.replace(/[,:;]+$/g, "").trim();
}

function extractExplicitIfThenRule(value: string): string | null {
  const normalized = normalizePromotionWhitespace(value);
  const match = normalized.match(/^if\b([\s\S]+?)\bthen\b([\s\S]+?)(?:[.!?])?$/i);
  if (!match) return null;
  const condition = stripTrailingPromotionPunctuation(normalizePromotionWhitespace(match[1] ?? ""));
  const outcome = stripTrailingPromotionPunctuation(normalizePromotionWhitespace(match[2] ?? ""));
  if (condition.length === 0 || outcome.length === 0) return null;
  return `IF ${condition} THEN ${outcome}.`;
}

function normalizePromotedGuidanceContent(value: string): string {
  const explicitRule = extractExplicitIfThenRule(value);
  if (explicitRule) return explicitRule;
  const normalized = normalizePromotionWhitespace(value);
  if (normalized.length === 0) return normalized;
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function canonicalPromotionContentKey(value: string): string {
  return normalizePromotedGuidanceContent(value).toLowerCase();
}

function lessonContentFromPattern(pattern: string, agent: string | null): string {
  if (!agent) return normalizePromotionWhitespace(pattern);
  const prefix = `${agent}:`;
  if (!pattern.startsWith(prefix)) return normalizePromotionWhitespace(pattern);
  const withoutPrefix = pattern.slice(prefix.length).trim();
  return withoutPrefix.length > 0 ? normalizePromotionWhitespace(withoutPrefix) : normalizePromotionWhitespace(pattern);
}

function promotionCategoryForContent(content: string): "principle" | "rule" {
  return extractExplicitIfThenRule(content) ? "rule" : "principle";
}

function clampPromotionScore(value: number): number {
  if (!Number.isFinite(value)) return 0.65;
  return Number(Math.max(0.65, Math.min(0.98, value)).toFixed(3));
}

export type TierMigrationCycleTrigger = "extraction" | "maintenance";
export interface TierMigrationCycleBudget {
  limit: number;
  scanLimit: number;
  minIntervalMs: number;
}

export function defaultTierMigrationCycleBudget(
  config: Pick<PluginConfig, "qmdTierAutoBackfillEnabled">,
  trigger: TierMigrationCycleTrigger,
): TierMigrationCycleBudget {
  if (trigger === "extraction") {
    const limit = 12;
    return {
      limit,
      scanLimit: limit * 4,
      minIntervalMs: 60_000,
    };
  }
  const limit = config.qmdTierAutoBackfillEnabled ? 200 : 50;
  return {
    limit,
    scanLimit: limit * 4,
    minIntervalMs: config.qmdTierAutoBackfillEnabled ? 120_000 : 300_000,
  };
}

function isoWeekId(d: Date): string {
  // ISO week based on Thursday
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const yyyy = dt.getUTCFullYear();
  return `${yyyy}-W${String(week).padStart(2, "0")}`;
}

function isoMonthId(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthIdFromIsoWeek(weekId: string): string {
  const match = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return isoMonthId(new Date());
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const isoWeekOneMonday = new Date(jan4);
  isoWeekOneMonday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const monday = new Date(isoWeekOneMonday);
  monday.setUTCDate(isoWeekOneMonday.getUTCDate() + (week - 1) * 7);
  return isoMonthId(monday);
}

function cadenceStaleWindowMs(cadence: "daily" | "weekly" | "monthly" | "quarterly"): number {
  switch (cadence) {
    case "daily":
      return 2 * 24 * 60 * 60 * 1000;
    case "weekly":
      return 10 * 24 * 60 * 60 * 1000;
    case "monthly":
      return 45 * 24 * 60 * 60 * 1000;
    case "quarterly":
      return 120 * 24 * 60 * 60 * 1000;
    default:
      return 45 * 24 * 60 * 60 * 1000;
  }
}

export class CompoundingEngine {
  private readonly weeklyDir: string;
  private readonly rubricsDir: string;
  private readonly rubricsIndexPath: string;
  private readonly rubricsAgentsDir: string;
  private readonly rubricsWorkflowsDir: string;
  private readonly rubricsPath: string;
  private readonly mistakesPath: string;
  private readonly feedbackInboxPath: string;
  private readonly identityAuditWeeklyDir: string;
  private readonly identityAuditMonthlyDir: string;
  private readonly memoryActionEventsPath: string;

  constructor(
    private readonly config: PluginConfig,
    private readonly storage: StorageManager = new StorageManager(config.memoryDir),
  ) {
    this.weeklyDir = path.join(config.memoryDir, "compounding", "weekly");
    this.rubricsDir = path.join(config.memoryDir, "compounding", "rubrics");
    this.rubricsIndexPath = path.join(this.rubricsDir, "index.json");
    this.rubricsAgentsDir = path.join(this.rubricsDir, "agents");
    this.rubricsWorkflowsDir = path.join(this.rubricsDir, "workflows");
    this.rubricsPath = path.join(config.memoryDir, "compounding", "rubrics.md");
    this.mistakesPath = path.join(config.memoryDir, "compounding", "mistakes.json");
    this.feedbackInboxPath = path.join(resolveSharedContextDir(config), "feedback", "inbox.jsonl");
    this.identityAuditWeeklyDir = path.join(config.memoryDir, "identity", "audits", "weekly");
    this.identityAuditMonthlyDir = path.join(config.memoryDir, "identity", "audits", "monthly");
    this.memoryActionEventsPath = path.join(config.memoryDir, "state", "memory-actions.jsonl");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.weeklyDir, { recursive: true });
    await mkdir(path.dirname(this.mistakesPath), { recursive: true });
    await mkdir(path.dirname(this.rubricsPath), { recursive: true });
    await mkdir(this.rubricsDir, { recursive: true });
    await mkdir(this.rubricsAgentsDir, { recursive: true });
    await mkdir(this.rubricsWorkflowsDir, { recursive: true });
  }

  async synthesizeWeekly(opts?: {
    weekId?: string;
  }): Promise<{
    weekId: string;
    reportPath: string;
    reportJsonPath: string;
    mistakesCount: number;
    rubricsPath: string;
    rubricsIndexPath: string;
    promotionCandidateCount: number;
  }> {
    await this.ensureDirs();
    const weekId = opts?.weekId ?? isoWeekId(new Date());

    const entries = await this.readFeedbackEntriesForWeek(weekId);
    const actionEvents = await this.readActionEventsForWeek(weekId);
    const actionPatterns = this.buildActionFailurePatterns(actionEvents);
    const outcomeSummary = this.buildActionOutcomeSummary(actionEvents);
    const previousMistakes = await this.readMistakes();
    const mistakes = this.buildMistakes(entries, actionPatterns, weekId, previousMistakes?.registry ?? []);
    const rubrics = this.buildRubricSnapshot(entries, outcomeSummary);
    let promotionCandidates = this.config.compoundingSemanticEnabled
      ? this.derivePromotionCandidates(outcomeSummary, mistakes.registry, rubrics)
      : [];
    if (this.config.cmcConsolidationEnabled) {
      try {
        const { deriveCausalPromotionCandidates, materializeAfterCausalConsolidation } = await import("../causal-consolidation.js");
        const causalCandidates = await deriveCausalPromotionCandidates({
          memoryDir: this.config.memoryDir,
          causalTrajectoryStoreDir: this.config.causalTrajectoryStoreDir,
          gatewayConfig: this.config.gatewayConfig,
          gatewayAgentId: this.config.modelSource === "gateway" ? (this.config.gatewayAgentId || undefined) : undefined,
          workspaceDir: this.config.workspaceDir,
          pluginConfig: this.config,
          config: {
            minRecurrence: this.config.cmcConsolidationMinRecurrence,
            minSessions: this.config.cmcConsolidationMinSessions,
            successThreshold: this.config.cmcConsolidationSuccessThreshold,
          },
        });
        if (causalCandidates.length > 0) {
          promotionCandidates = [...promotionCandidates, ...causalCandidates];
        }
        // #378: fire the Codex materialize post-hook so
        // `codexMaterializeOnConsolidation` actually has a runtime effect
        // when the causal consolidation path runs. The helper silently no-ops
        // when the feature flag or the per-trigger toggle is off, when the
        // sentinel is missing, or when nothing has changed since the previous
        // run. Wrapped in its own try/catch so a failed materialize never
        // aborts weekly synthesis.
        try {
          await materializeAfterCausalConsolidation({
            config: this.config,
            memoryDir: this.config.memoryDir,
          });
        } catch (materializeError) {
          log.warn(
            `[cmc] Codex materialize post-hook failed (non-fatal): ${
              materializeError instanceof Error ? materializeError.message : String(materializeError)
            }`,
          );
        }
      } catch (error) {
        log.warn(`[cmc] causal consolidation in synthesizeWeekly failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // PEDC: Run calibration consolidation during weekly synthesis
    if (this.config.calibrationEnabled) {
      try {
        const { runCalibrationConsolidation } = await import("../calibration.js");
        const calRules = await runCalibrationConsolidation({
          memoryDir: this.config.memoryDir,
          gatewayConfig: this.config.gatewayConfig,
          gatewayAgentId: this.config.modelSource === "gateway" ? (this.config.gatewayAgentId || undefined) : undefined,
          workspaceDir: this.config.workspaceDir,
        });
        log.debug(`[calibration] weekly synthesis produced ${calRules.length} calibration rule(s)`);
      } catch (error) {
        log.warn(`[calibration] weekly consolidation failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const continuity = this.config.continuityAuditEnabled
      ? await this.readContinuityAuditReferences(weekId)
      : { monthId: monthIdFromIsoWeek(weekId), weeklyPath: null, monthlyPath: null };

    // Write weekly report (always, even if empty: "day-one outcomes").
    const reportPath = path.join(this.weeklyDir, `${weekId}.md`);
    const md = this.formatWeeklyReport(weekId, entries, mistakes.patterns, mistakes.details, continuity, outcomeSummary, promotionCandidates);
    await writeFile(reportPath, md, "utf-8");

    const reportJsonPath = path.join(this.weeklyDir, `${weekId}.json`);
    const weeklyArtifact: WeeklyCompoundingArtifact = {
      version: COMPOUNDING_VERSION,
      generatedAt: mistakes.updatedAt,
      weekId,
      feedback: {
        count: entries.length,
        byDecision: {
          approved: entries.filter((wrapped) => wrapped.entry.decision === "approved").length,
          approved_with_feedback: entries.filter((wrapped) => wrapped.entry.decision === "approved_with_feedback").length,
          rejected: entries.filter((wrapped) => wrapped.entry.decision === "rejected").length,
        },
        entries: entries.map((wrapped) => ({
          agent: wrapped.entry.agent,
          workflow: wrapped.entry.workflow ?? null,
          decision: wrapped.entry.decision,
          reason: wrapped.entry.reason,
          learning: wrapped.entry.learning?.trim() || null,
          outcome: wrapped.entry.outcome?.trim() || null,
          severity: wrapped.entry.severity ?? null,
          confidence: normalizeConfidence(wrapped.entry.confidence),
          tags: normalizeTags(wrapped.entry.tags),
          provenance: `${path.basename(wrapped.sourcePath)}:L${wrapped.sourceLine}#${wrapped.entryId}`,
          evidenceWindow: normalizeEvidenceWindow(wrapped.entry.evidenceWindowStart, wrapped.entry.evidenceWindowEnd),
        })),
      },
      mistakes: {
        count: mistakes.patterns.length,
        patterns: mistakes.patterns,
        registry: mistakes.registry,
      },
      rubrics,
      outcomes: outcomeSummary,
      promotionCandidates,
      continuity,
    };
    await writeFile(reportJsonPath, JSON.stringify(weeklyArtifact, null, 2) + "\n", "utf-8");

    // Write stable rubric artifact.
    const rubricsMarkdown = this.formatRubrics(outcomeSummary, rubrics);
    await writeFile(this.rubricsPath, rubricsMarkdown, "utf-8");
    await writeFile(this.rubricsIndexPath, JSON.stringify(rubrics, null, 2) + "\n", "utf-8");
    await this.syncRubricArtifacts(rubrics);

    // Update mistakes.json (always).
    await writeFile(
      this.mistakesPath,
      JSON.stringify({
        version: COMPOUNDING_VERSION,
        updatedAt: mistakes.updatedAt,
        patterns: mistakes.patterns,
        registry: mistakes.registry,
      }, null, 2) + "\n",
      "utf-8",
    );

    log.info(
      `compounding: wrote weekly=${reportPath} weeklyJson=${reportJsonPath} rubrics=${this.rubricsPath} rubricsIndex=${this.rubricsIndexPath} mistakes=${this.mistakesPath}`,
    );
    return {
      weekId,
      reportPath,
      reportJsonPath,
      rubricsPath: this.rubricsPath,
      rubricsIndexPath: this.rubricsIndexPath,
      mistakesCount: mistakes.patterns.length,
      promotionCandidateCount: promotionCandidates.length,
    };
  }

  async promoteCandidate(opts: {
    weekId: string;
    candidateId: string;
    dryRun?: boolean;
    storage?: StorageManager;
  }): Promise<CompoundingPromotionReport> {
    const report: CompoundingPromotionReport = {
      enabled: this.config.compoundingEnabled === true && this.config.compoundingSemanticEnabled === true,
      dryRun: opts.dryRun === true,
      weekId: opts.weekId,
      promoted: [],
      skipped: [],
    };
    if (!report.enabled) {
      report.skipped.push({ weekId: opts.weekId, candidateId: opts.candidateId, reason: "disabled" });
      return report;
    }

    const artifact = await this.readWeeklyArtifact(opts.weekId);
    if (!artifact) {
      report.skipped.push({ weekId: opts.weekId, candidateId: opts.candidateId, reason: "weekly-artifact-missing" });
      return report;
    }

    const candidate = artifact.promotionCandidates.find((entry) => entry.id === opts.candidateId);
    if (!candidate) {
      report.skipped.push({ weekId: opts.weekId, candidateId: opts.candidateId, reason: "candidate-not-found" });
      return report;
    }

    const content = normalizePromotedGuidanceContent(candidate.content);
    const persistedContent = sanitizeMemoryContent(content).text;
    const storage = opts.storage ?? new StorageManager(this.config.memoryDir);
    const existing = (await storage.readAllMemories()).find((memory) =>
      memory.frontmatter.category === candidate.category &&
      memory.frontmatter.status !== "archived" &&
      memory.frontmatter.status !== "forgotten" &&
      canonicalPromotionContentKey(memory.content) === canonicalPromotionContentKey(persistedContent)
    );
    if (existing) {
      report.skipped.push({
        weekId: opts.weekId,
        candidateId: opts.candidateId,
        reason: "duplicate-guidance",
        existingMemoryId: existing.frontmatter.id,
      });
      return report;
    }

    const tags = [
      "compounding",
      "compounding-promotion",
      `compounding-source-${candidate.sourceType}`,
      ...(candidate.agent ? [`agent:${stableSlug(candidate.agent)}`] : []),
      ...(candidate.workflow ? [`workflow:${stableSlug(candidate.workflow)}`] : []),
    ];
    const uniqueTags = [...new Set(tags)];
    const lineage = [`compounding:${opts.weekId}:${opts.candidateId}`];
    const confidence = clampPromotionScore(candidate.score);

    if (opts.dryRun === true) {
      report.promoted.push({
        id: `dry-run:${opts.weekId}:${opts.candidateId}`,
        candidateId: opts.candidateId,
        category: candidate.category,
        content: persistedContent,
        confidence,
        tags: uniqueTags,
        lineage,
      });
      return report;
    }

    const id = await storage.writeMemory(candidate.category, persistedContent, {
      source: "compounding-promotion",
      tags: uniqueTags,
      confidence,
      lineage,
      memoryKind: "note",
    });
    report.promoted.push({
      id,
      candidateId: opts.candidateId,
      category: candidate.category,
      content: persistedContent,
      confidence,
      tags: uniqueTags,
      lineage,
    });
    return report;
  }

  async synthesizeContinuityAudit(opts?: {
    period?: "weekly" | "monthly";
    key?: string;
  }): Promise<{ period: "weekly" | "monthly"; key: string; reportPath: string }> {
    const period = opts?.period === "monthly" ? "monthly" : "weekly";
    const key = opts?.key?.trim() || (period === "weekly" ? isoWeekId(new Date()) : isoMonthId(new Date()));
    const nowIso = new Date().toISOString();
    const [identityAnchor, improvementLoopsRaw, openIncidents, closedIncidents, mistakes] = await Promise.all([
      this.readOptionalIdentityAnchorForAudit(),
      this.readOptionalImprovementLoopsForAudit(),
      this.readContinuityIncidentsForAudit(200, "open"),
      this.readContinuityIncidentsForAudit(200, "closed"),
      this.readMistakes(),
    ]);
    const anchorPresent = (identityAnchor ?? "").trim().length > 0;
    const improvementLoops = improvementLoopsRaw ? parseContinuityImprovementLoops(improvementLoopsRaw) : [];
    const activeLoops = improvementLoops.filter((loop) => loop.status === "active");
    const staleActiveLoops = activeLoops.filter((loop) => {
      const reviewedAt = Date.parse(loop.lastReviewed);
      if (!Number.isFinite(reviewedAt)) return true;
      return Date.now() - reviewedAt > cadenceStaleWindowMs(loop.cadence);
    });
    const hardeningCandidates: string[] = [];
    if (!anchorPresent) {
      hardeningCandidates.push("Create/update identity anchor baseline and verify recovery injection path.");
    }
    if (openIncidents.length > 0) {
      hardeningCandidates.push(
        `Close or downgrade ${openIncidents.length} open continuity incident${openIncidents.length === 1 ? "" : "s"}.`,
      );
    }
    if (improvementLoops.length === 0) {
      hardeningCandidates.push("Initialize continuity improvement-loops register with cadence and kill conditions.");
    } else if (staleActiveLoops.length > 0) {
      hardeningCandidates.push(
        `Review stale active continuity loop${staleActiveLoops.length === 1 ? "" : "s"}: ${staleActiveLoops
          .slice(0, 3)
          .map((loop) => loop.id)
          .join(", ")}.`,
      );
    }
    if ((mistakes?.patterns.length ?? 0) > 0) {
      hardeningCandidates.push("Review latest compounding mistakes and convert one pattern into preventive continuity rule.");
    }
    const nextAction = hardeningCandidates[0] ?? "No critical drift detected; keep weekly/monthly continuity audit cadence.";

    const lines: string[] = [
      `# Continuity Audit — ${period} ${key}`,
      "",
      `Generated: ${nowIso}`,
      `Scope: ${period}`,
      "",
      "## Signal Summary",
      `- Identity anchor present: ${anchorPresent ? "yes" : "no"}`,
      `- Improvement loops tracked: ${improvementLoops.length}`,
      `- Active improvement loops: ${activeLoops.length}`,
      `- Stale active loops: ${staleActiveLoops.length}`,
      `- Open incidents: ${openIncidents.length}`,
      `- Closed incidents: ${closedIncidents.length}`,
      `- Compounding mistake patterns: ${mistakes?.patterns.length ?? 0}`,
      "",
      "## Drift Checks",
      `- Identity anchor drift: ${anchorPresent ? "pass" : "needs attention"}`,
      `- Incident backlog: ${openIncidents.length === 0 ? "pass" : "needs attention"}`,
      `- Improvement-loop coverage: ${improvementLoops.length > 0 ? "pass" : "needs attention"}`,
      `- Improvement-loop freshness: ${staleActiveLoops.length === 0 ? "pass" : "needs attention"}`,
      "",
      "## Stale Rule Detection",
      `- Open incidents older than closure window: ${openIncidents.length > 0 ? "possible" : "none detected"}`,
      `- Stale active continuity loops: ${staleActiveLoops.length > 0 ? staleActiveLoops.map((l) => l.id).join(", ") : "none detected"}`,
      `- Preventive rule coverage on closed incidents: ${
        closedIncidents.some((i) => (i.preventiveRule ?? "").trim().length > 0) ? "present" : "not detected"
      }`,
      "",
      "## Next Hardening Action",
      `- ${nextAction}`,
      "",
      "## Open Incident IDs",
      ...(openIncidents.length > 0 ? openIncidents.slice(0, 20).map((i) => `- ${i.id}`) : ["- (none)"]),
      "",
    ];

    const reportPath = await this.storage.writeIdentityAudit(period, key, lines.join("\n"));
    return { period, key, reportPath };
  }

  async readMistakes(): Promise<MistakesFile | null> {
    try {
      const raw = await readFile(this.mistakesPath, "utf-8");
      const parsed = JSON.parse(raw) as MistakesFile;
      if (!parsed || !Array.isArray(parsed.patterns)) return null;
      if (!Array.isArray(parsed.registry)) {
        const updatedAt = typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
          ? parsed.updatedAt
          : new Date(0).toISOString();
        parsed.registry = parsed.patterns.map((pattern) => {
          const metadata = inferLegacyMistakeMetadata(pattern);
          return {
            id: stableMistakeId(metadata.category, pattern, metadata.agent, metadata.workflow),
            pattern,
            category: metadata.category,
            status: "active",
            agent: metadata.agent,
            workflow: metadata.workflow,
            tags: [],
            severity: null,
            confidence: null,
            outcome: null,
            provenance: [],
            firstSeenAt: updatedAt,
            lastSeenAt: updatedAt,
            recurrenceCount: 1,
            lastWeekId: isoWeekId(new Date(updatedAt)),
            evidenceWindow: { start: null, end: null },
          };
        });
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async readRubrics(): Promise<RubricSnapshot | null> {
    try {
      const raw = await readFile(this.rubricsIndexPath, "utf-8");
      const parsed = JSON.parse(raw) as RubricSnapshot;
      if (!parsed || !Array.isArray(parsed.agents) || !Array.isArray(parsed.workflows)) return null;
      parsed.agents = parsed.agents.map((entry) => this.normalizeRubricEntry(entry));
      parsed.workflows = parsed.workflows.map((entry) => this.normalizeRubricEntry(entry));
      return parsed;
    } catch {
      return null;
    }
  }

  async readWeeklyArtifact(weekId: string): Promise<WeeklyCompoundingArtifact | null> {
    try {
      const raw = await readFile(path.join(this.weeklyDir, `${weekId}.json`), "utf-8");
      const parsed = JSON.parse(raw) as WeeklyCompoundingArtifact;
      if (
        !parsed ||
        parsed.weekId !== weekId ||
        !Array.isArray(parsed.promotionCandidates)
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async buildRecallSection(
    query: string,
    opts?: { maxPatterns?: number; maxRubrics?: number },
  ): Promise<string | null> {
    const [mistakes, rubrics] = await Promise.all([
      this.readMistakes(),
      this.readRubrics(),
    ]);
    const maxPatterns = Math.max(0, Math.floor(opts?.maxPatterns ?? 40));
    const maxRubrics = Math.max(0, Math.floor(opts?.maxRubrics ?? 4));
    const queryTokens = tokenizeRecallQuery(query);

    const activePatterns = (mistakes?.registry ?? [])
      .filter((entry) => entry.status === "active")
      .sort((a, b) =>
        b.recurrenceCount - a.recurrenceCount ||
        b.lastSeenAt.localeCompare(a.lastSeenAt) ||
        a.pattern.localeCompare(b.pattern),
      );
    const topPatterns = activePatterns.slice(0, maxPatterns);

    const allRubrics = [
      ...(rubrics?.workflows ?? []),
      ...(rubrics?.agents ?? []),
    ];
    const scoredRubrics = allRubrics
      .map((entry) => ({
        entry,
        score: this.scoreRubricForQuery(entry, queryTokens),
      }))
      .sort((a, b) =>
        b.score - a.score ||
        b.entry.observations.length - a.entry.observations.length ||
        a.entry.subject.localeCompare(b.entry.subject),
      );
    const topRubrics = scoredRubrics
      .filter((item) => item.score > 0 || queryTokens.length === 0)
      .slice(0, maxRubrics)
      .map((item) => item.entry);

    if (topPatterns.length === 0 && topRubrics.length === 0) return null;

    const lines: string[] = [
      "## Institutional Learning (Compounded)",
      "",
    ];

    if (topPatterns.length > 0) {
      lines.push("Avoid repeating these patterns:");
      for (const entry of topPatterns) {
        const scope = entry.workflow ?? entry.agent ?? null;
        const metadata = [`recurrence=${entry.recurrenceCount}`];
        if (scope) metadata.push(`scope=${scope}`);
        lines.push(`- ${entry.pattern} _(${metadata.join(", ")})_`);
      }
      lines.push("");
    }

    if (topRubrics.length > 0) {
      lines.push("Active rubrics:");
      for (const rubric of topRubrics) {
        const notes = rubric.observations.slice(0, 2).join("; ");
        lines.push(`- ${rubric.kind} ${rubric.subject}: ${notes}`);
      }
    }

    return lines.join("\n");
  }

  tierMigrationCycleBudget(trigger: TierMigrationCycleTrigger): TierMigrationCycleBudget {
    return defaultTierMigrationCycleBudget(this.config, trigger);
  }

  private async readFeedbackEntriesForWeek(weekId: string): Promise<FeedbackEntryWithProvenance[]> {
    // Minimal implementation: includes entries where date starts with any day in the ISO week.
    // We approximate by taking all entries and filtering by computed isoWeekId(date).
    const out: FeedbackEntryWithProvenance[] = [];
    try {
      const raw = await readFile(this.feedbackInboxPath, "utf-8");
      const lines = raw.split("\n");
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const parsed = SharedFeedbackEntrySchema.safeParse(obj);
          if (!parsed.success) continue;
          const d = new Date(parsed.data.date);
          if (!Number.isFinite(d.getTime())) continue;
          if (isoWeekId(d) !== weekId) continue;
          const sourceLine = idx + 1;
          out.push({
            entry: parsed.data,
            sourceLine,
            sourcePath: this.feedbackInboxPath,
            entryId: `${parsed.data.agent}-${parsed.data.date}-${sourceLine}`.replace(/[^a-zA-Z0-9._:-]/g, "_"),
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // missing feedback is normal
    }
    return out;
  }

  private buildActionFailurePatterns(events: WeeklyActionEvent[]): string[] {
    const out: string[] = [];
    for (const event of events) {
      const failed = event.outcome === "failed" || event.outcome === "skipped";
      if (!failed && event.policyDecision === null) continue;
      const suffix = event.reason && event.reason.trim().length > 0
        ? ` - ${event.reason.trim().slice(0, 140)}`
        : "";
      out.push(
        `memory-action/${event.namespace}: ${event.action} ${event.outcome}${event.policyDecision ? `/${event.policyDecision}` : ""}${suffix}`,
      );
    }
    return out;
  }

  private async readActionEventsForWeek(weekId: string): Promise<WeeklyActionEvent[]> {
    const out: WeeklyActionEvent[] = [];
    const rows = await this.storage.readMemoryActionEventRows(Number.MAX_SAFE_INTEGER);
    for (const row of rows) {
      const event = row.event;
      const ts = new Date(event.timestamp);
      if (!Number.isFinite(ts.getTime()) || isoWeekId(ts) !== weekId) continue;
      out.push({
        line: row.line,
        action: event.action,
        outcome: event.outcome,
        policyDecision: event.policyDecision === "deny" || event.policyDecision === "defer"
          ? event.policyDecision
          : null,
        namespace: typeof event.namespace === "string" && event.namespace.length > 0 ? event.namespace : "default",
        reason: typeof event.reason === "string" ? event.reason : null,
      });
    }
    return out;
  }

  private buildActionOutcomeSummary(events: WeeklyActionEvent[]): ActionOutcomeSummary[] {
    const byAction = new Map<string, { counts: ActionOutcomeCounts; provenance: Set<string> }>();
    for (const event of events) {
      const key = event.action;
      const acc = byAction.get(key) ?? {
        counts: { applied: 0, skipped: 0, failed: 0 },
        provenance: new Set<string>(),
      };
      if (event.outcome === "applied") acc.counts.applied += 1;
      else if (event.outcome === "skipped") acc.counts.skipped += 1;
      else acc.counts.failed += 1;
      acc.provenance.add(`${path.basename(this.memoryActionEventsPath)}:L${event.line}`);
      byAction.set(key, acc);
    }

    const out: ActionOutcomeSummary[] = [];
    for (const [action, data] of byAction.entries()) {
      const total = data.counts.applied + data.counts.skipped + data.counts.failed;
      if (total <= 0) continue;
      // Conservative weighting: reward applied, penalize skipped/failed.
      const weightedScore = Number((((data.counts.applied * 1) - (data.counts.skipped * 0.5) - (data.counts.failed * 1.5)) / total).toFixed(3));
      out.push({
        action,
        counts: data.counts,
        total,
        weightedScore,
        provenance: [...data.provenance].sort().slice(0, 8),
      });
    }
    out.sort((a, b) => b.total - a.total || b.weightedScore - a.weightedScore || a.action.localeCompare(b.action));
    return out;
  }

  private derivePromotionCandidates(
    summary: ActionOutcomeSummary[],
    mistakes: MistakeRegistryEntry[],
    rubrics: RubricSnapshot,
  ): PromotionCandidate[] {
    const deduped = new Map<string, PromotionCandidate>();
    const upsert = (candidate: PromotionCandidate) => {
      const key = `${candidate.category}:${canonicalPromotionContentKey(candidate.content)}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, candidate);
        return;
      }
      const mergedProvenance = [...new Set([...existing.provenance, ...candidate.provenance])];
      if (candidate.score > existing.score) {
        deduped.set(key, {
          ...candidate,
          provenance: mergedProvenance,
        });
        return;
      }
      existing.provenance = mergedProvenance;
    };

    for (const item of summary) {
      if (item.total < 3) continue;
      if (item.weightedScore < 0.3) continue;
      const content = normalizePromotedGuidanceContent(
        `Prefer ${item.action} when the same workflow recurs; this week's outcomes were applied=${item.counts.applied}, skipped=${item.counts.skipped}, failed=${item.counts.failed}.`,
      );
      upsert({
        id: stablePromotionCandidateId("action-outcome", item.action, content),
        sourceType: "action-outcome",
        subject: item.action,
        category: promotionCategoryForContent(content),
        content,
        score: item.weightedScore,
        rationale: "High applied ratio with low failure/skips in weekly outcome telemetry.",
        outcome: item.counts,
        provenance: item.provenance,
        agent: null,
        workflow: "memory-actions",
      });
    }

    for (const entry of mistakes) {
      if (entry.status !== "active") continue;
      if (entry.recurrenceCount < 2) continue;
      const content = normalizePromotedGuidanceContent(lessonContentFromPattern(entry.pattern, entry.agent));
      if (content.length === 0) continue;
      const confidence = entry.confidence ?? 0.75;
      const score = Number(Math.min(0.97, 0.45 + Math.min(entry.recurrenceCount, 6) * 0.08 + confidence * 0.15).toFixed(3));
      upsert({
        id: stablePromotionCandidateId("mistake-pattern", entry.id, content),
        sourceType: "mistake-pattern",
        subject: entry.pattern,
        category: promotionCategoryForContent(content),
        content,
        score,
        rationale: `Recurring lesson still active after ${entry.recurrenceCount} confirmations in the mistake registry.`,
        outcome: null,
        provenance: entry.provenance.length > 0 ? entry.provenance : [`mistakes.json#${entry.id}`],
        agent: entry.agent,
        workflow: entry.workflow,
      });
    }

    for (const rubric of [...rubrics.workflows, ...rubrics.agents]) {
      for (const observation of this.getRubricObservationEntries(rubric)) {
        if (this.isSyntheticOutcomeRubricObservation(observation.note)) continue;
        const evidenceCount = observation.provenance.length;
        if (evidenceCount < 2) continue;
        const content = normalizePromotedGuidanceContent(observation.note);
        if (content.length === 0) continue;
        const score = Number(Math.min(0.95, 0.5 + Math.min(evidenceCount, 5) * 0.08).toFixed(3));
        upsert({
          id: stablePromotionCandidateId("rubric", `${rubric.id}:${observation.note}`, content),
          sourceType: "rubric",
          subject: `${rubric.kind}:${rubric.subject}`,
          category: promotionCategoryForContent(content),
          content,
          score,
          rationale: `Rubric guidance repeated across ${evidenceCount} supporting observations.`,
          outcome: null,
          provenance: observation.provenance,
          agent: rubric.kind === "agent" ? rubric.subject : null,
          workflow: rubric.kind === "workflow" ? rubric.subject : null,
        });
      }
    }

    return [...deduped.values()]
      .sort((a, b) => b.score - a.score || a.subject.localeCompare(b.subject))
      .slice(0, 10);
  }

  private buildMistakes(
    entries: FeedbackEntryWithProvenance[],
    actionPatterns: string[] = [],
    weekId: string,
    previousRegistry: MistakeRegistryEntry[] = [],
  ): MistakesFile & { details: PatternWithProvenance[]; registry: MistakeRegistryEntry[] } {
    const patterns: PatternWithProvenance[] = [];
    const evidenceByPattern = new Map<string, {
      category: "feedback" | "action";
      agent: string | null;
      workflow: string | null;
      tags: Set<string>;
      severity: CompoundingEntrySeverity | null;
      confidence: number | null;
      outcome: string | null;
      timestamps: string[];
      evidenceWindow: EvidenceWindow;
    }>();

    for (const wrapped of entries) {
      const e = wrapped.entry;
      const pattern = e.learning && e.learning.trim().length > 0
        ? `${e.agent}: ${e.learning.trim()}`
        : e.decision === "rejected"
          ? `${e.agent}: ${e.reason.trim()}`.slice(0, 240)
          : null;
      if (!pattern) continue;
      const provenance = [`${path.basename(wrapped.sourcePath)}:L${wrapped.sourceLine}#${wrapped.entryId}`];
      patterns.push({ pattern, provenance });

      const previous = evidenceByPattern.get(pattern) ?? {
        category: "feedback" as const,
        agent: e.agent,
        workflow: e.workflow ?? null,
        tags: new Set<string>(),
        severity: e.severity ?? null,
        confidence: normalizeConfidence(e.confidence),
        outcome: e.outcome?.trim() || null,
        timestamps: [],
        evidenceWindow: normalizeEvidenceWindow(e.evidenceWindowStart, e.evidenceWindowEnd),
      };
      for (const tag of normalizeTags(e.tags)) previous.tags.add(tag);
      previous.timestamps.push(e.date);
      if (previous.workflow === null && e.workflow) previous.workflow = e.workflow;
      if (previous.severity === null && e.severity) previous.severity = e.severity;
      if (previous.confidence === null) previous.confidence = normalizeConfidence(e.confidence);
      if (previous.outcome === null && e.outcome) previous.outcome = e.outcome.trim();
      const nextEvidenceWindow = normalizeEvidenceWindow(e.evidenceWindowStart, e.evidenceWindowEnd);
      previous.evidenceWindow = mergeEvidenceWindows(previous.evidenceWindow, nextEvidenceWindow);
      evidenceByPattern.set(pattern, previous);
    }

    for (const pattern of actionPatterns) {
      patterns.push({ pattern, provenance: [`${path.basename(this.memoryActionEventsPath)}:*`] });
      const previous = evidenceByPattern.get(pattern) ?? {
        category: "action" as const,
        agent: null,
        workflow: "memory-actions",
        tags: new Set<string>(),
        severity: "medium" as CompoundingEntrySeverity,
        confidence: null,
        outcome: null,
        timestamps: [],
        evidenceWindow: { start: null, end: null },
      };
      evidenceByPattern.set(pattern, previous);
    }

    const byPattern = new Map<string, Set<string>>();
    for (const item of patterns) {
      const existing = byPattern.get(item.pattern) ?? new Set<string>();
      for (const provenance of item.provenance) existing.add(provenance);
      byPattern.set(item.pattern, existing);
    }

    const details = [...byPattern.entries()]
      .map(([pattern, provenance]) => ({ pattern, provenance: [...provenance].sort() }))
      .slice(0, 500);
    const previousById = new Map(previousRegistry.map((entry) => [entry.id, entry]));
    const previousByPattern = new Map(previousRegistry.map((entry) => [entry.pattern, entry]));
    const registry: MistakeRegistryEntry[] = details.map((detail) => {
      const evidence = evidenceByPattern.get(detail.pattern);
      const id = stableMistakeId(
        evidence?.category ?? "feedback",
        detail.pattern,
        evidence?.agent ?? null,
        evidence?.workflow ?? null,
      );
      const previous = previousById.get(id) ?? previousByPattern.get(detail.pattern);
      const timestamps = (evidence?.timestamps ?? []).filter((value) => typeof value === "string" && value.length > 0).sort();
      const firstSeenAt = previous?.firstSeenAt ?? timestamps[0] ?? new Date().toISOString();
      const lastSeenAt = timestamps[timestamps.length - 1] ?? previous?.lastSeenAt ?? firstSeenAt;
      return {
        id,
        pattern: detail.pattern,
        category: evidence?.category ?? "feedback",
        status: "active" as const,
        agent: evidence?.agent ?? null,
        workflow: evidence?.workflow ?? null,
        tags: evidence ? [...evidence.tags].sort() : [],
        severity: evidence?.severity ?? null,
        confidence: evidence?.confidence ?? null,
        outcome: evidence?.outcome ?? null,
        provenance: detail.provenance,
        firstSeenAt,
        lastSeenAt,
        recurrenceCount: previous?.lastWeekId === weekId ? previous.recurrenceCount : (previous?.recurrenceCount ?? 0) + 1,
        lastWeekId: weekId,
        evidenceWindow: evidence?.evidenceWindow ?? { start: null, end: null },
        retiredAt: null,
      } satisfies MistakeRegistryEntry;
    });

    const seenIds = new Set(registry.map((entry) => entry.id));
    const seenPatterns = new Set(registry.map((entry) => entry.pattern));
    for (const previous of previousRegistry) {
      if (seenIds.has(previous.id) || seenPatterns.has(previous.pattern)) continue;
      const staleWeeks = weekIdToIndex(weekId) - weekIdToIndex(previous.lastWeekId);
      registry.push({
        ...previous,
        status: staleWeeks >= RETIREMENT_WINDOW_WEEKS ? "retired" : previous.status,
        retiredAt: staleWeeks >= RETIREMENT_WINDOW_WEEKS
          ? previous.retiredAt ?? new Date().toISOString()
          : previous.retiredAt ?? null,
      });
    }

    registry.sort((a, b) =>
      Number(b.status === "active") - Number(a.status === "active") ||
      b.recurrenceCount - a.recurrenceCount ||
      b.lastSeenAt.localeCompare(a.lastSeenAt) ||
      a.pattern.localeCompare(b.pattern),
    );

    return {
      version: COMPOUNDING_VERSION,
      updatedAt: new Date().toISOString(),
      patterns: details.map((d) => d.pattern),
      details,
      registry,
    };
  }

  private formatWeeklyReport(
    weekId: string,
    entries: FeedbackEntryWithProvenance[],
    patterns: string[],
    patternDetails: PatternWithProvenance[],
    continuity: { monthId: string; weeklyPath: string | null; monthlyPath: string | null },
    outcomeSummary: ActionOutcomeSummary[],
    promotionCandidates: PromotionCandidate[],
  ): string {
    const byAgent = new Map<string, FeedbackEntryWithProvenance[]>();
    for (const wrapped of entries) {
      const list = byAgent.get(wrapped.entry.agent) ?? [];
      list.push(wrapped);
      byAgent.set(wrapped.entry.agent, list);
    }

    const lines: string[] = [
      `# Weekly Compounding — ${weekId}`,
      "",
      "This file is generated by Engram's compounding engine (v5.0).",
      "",
      "## Summary",
      `- Feedback entries: ${entries.length}`,
      `- Mistake patterns: ${patterns.length}`,
      "",
      "## By Agent",
    ];

    if (byAgent.size === 0) {
      lines.push("- (none)");
    } else {
      for (const [agent, list] of Array.from(byAgent.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const approved = list.filter((e) => e.entry.decision === "approved").length;
        const awf = list.filter((e) => e.entry.decision === "approved_with_feedback").length;
        const rejected = list.filter((e) => e.entry.decision === "rejected").length;
        lines.push(`### ${agent}`);
        lines.push(`- approved: ${approved}`);
        lines.push(`- approved_with_feedback: ${awf}`);
        lines.push(`- rejected: ${rejected}`);
        const provenance = list
          .slice(0, 3)
          .map((e) => `${path.basename(e.sourcePath)}:L${e.sourceLine}#${e.entryId}`);
        if (provenance.length > 0) {
          lines.push(`- provenance: ${provenance.join(", ")}`);
        }
        lines.push("");
      }
    }

    lines.push("## Patterns (Avoid / Prefer)");
    if (patterns.length === 0) {
      lines.push("- (none yet)");
    } else {
      const detailMap = new Map(patternDetails.map((d) => [d.pattern, d.provenance]));
      for (const p of patterns.slice(0, 100)) {
        const provenance = detailMap.get(p) ?? [];
        if (provenance.length > 0) {
          lines.push(`- ${p} _(source: ${provenance.join(", ")})_`);
        } else {
          lines.push(`- ${p}`);
        }
      }
    }
    lines.push("");

    lines.push("## Outcome Weighting");
    if (outcomeSummary.length === 0) {
      lines.push("- (no action outcomes recorded this week)");
    } else {
      for (const item of outcomeSummary.slice(0, 20)) {
        lines.push(
          `- ${item.action}: applied=${item.counts.applied}, skipped=${item.counts.skipped}, failed=${item.counts.failed}, weight=${item.weightedScore} _(source: ${item.provenance.join(", ")})_`,
        );
      }
    }
    lines.push("");

    if (this.config.compoundingSemanticEnabled) {
      lines.push("## Promotion Candidates (Advisory)");
      if (promotionCandidates.length === 0) {
        lines.push("- (no advisory promotion candidates this week)");
      } else {
        for (const candidate of promotionCandidates) {
          const outcomeSummaryText = candidate.outcome
            ? ` outcomes[a=${candidate.outcome.applied}, s=${candidate.outcome.skipped}, f=${candidate.outcome.failed}]`
            : "";
          lines.push(
            `- [${candidate.sourceType}] ${candidate.subject} -> ${candidate.content} (category=${candidate.category}, score=${candidate.score}, id=${candidate.id}): ${candidate.rationale}${outcomeSummaryText} _(source: ${candidate.provenance.join(", ")})_`,
          );
        }
      }
      lines.push("");
      lines.push("_Advisory only: no automatic promotion write is performed by this report. Use `compounding_promote_candidate` or `openclaw engram compounding-promote` to persist one manually._");
      lines.push("");
    }

    if (this.config.continuityAuditEnabled) {
      lines.push("## Continuity Audits");
      if (continuity.weeklyPath) {
        lines.push(`- weekly: ${continuity.weeklyPath}`);
      } else {
        lines.push(`- weekly: (missing for ${weekId})`);
      }
      if (continuity.monthlyPath) {
        lines.push(`- monthly: ${continuity.monthlyPath}`);
      } else {
        lines.push(`- monthly: (missing for ${continuity.monthId})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  private buildRubricSnapshot(
    entries: FeedbackEntryWithProvenance[],
    outcomeSummary: ActionOutcomeSummary[],
  ): RubricSnapshot {
    const updatedAt = new Date().toISOString();
    const byAgent = new Map<string, RubricSnapshotEntry>();
    const byWorkflow = new Map<string, RubricSnapshotEntry>();

    for (const wrapped of entries) {
      const note = ((wrapped.entry.learning && wrapped.entry.learning.trim().length > 0)
        ? wrapped.entry.learning
        : wrapped.entry.decision === "rejected"
          ? wrapped.entry.reason
          : "").trim();
      if (!note) continue;
      const provenance = `${path.basename(wrapped.sourcePath)}:L${wrapped.sourceLine}#${wrapped.entryId}`;
      const agentEntry = byAgent.get(wrapped.entry.agent) ?? {
        id: stableRubricId("agent", wrapped.entry.agent),
        kind: "agent" as const,
        subject: wrapped.entry.agent,
        observations: [],
        tags: [],
        provenance: [],
        observationEntries: [],
        updatedAt,
      };
      this.addRubricObservation(agentEntry, note, provenance);
      agentEntry.tags = normalizeTags([...agentEntry.tags, ...normalizeTags(wrapped.entry.tags)]);
      byAgent.set(wrapped.entry.agent, agentEntry);

      const workflow = wrapped.entry.workflow?.trim();
      if (!workflow) continue;
      const workflowEntry = byWorkflow.get(workflow) ?? {
        id: stableRubricId("workflow", workflow),
        kind: "workflow" as const,
        subject: workflow,
        observations: [],
        tags: [],
        provenance: [],
        observationEntries: [],
        updatedAt,
      };
      this.addRubricObservation(workflowEntry, note, provenance);
      workflowEntry.tags = normalizeTags([...workflowEntry.tags, ...normalizeTags(wrapped.entry.tags)]);
      byWorkflow.set(workflow, workflowEntry);
    }

    for (const item of outcomeSummary) {
      const workflowEntry = byWorkflow.get(item.action) ?? {
        id: stableRubricId("workflow", item.action),
        kind: "workflow" as const,
        subject: item.action,
        observations: [],
        tags: [],
        provenance: [],
        observationEntries: [],
        updatedAt,
      };
      this.addRubricObservation(
        workflowEntry,
        `Outcome weight=${item.weightedScore} (applied=${item.counts.applied}, skipped=${item.counts.skipped}, failed=${item.counts.failed})`,
        ...item.provenance,
      );
      byWorkflow.set(item.action, workflowEntry);
    }

    return {
      updatedAt,
      agents: [...byAgent.values()].sort((a, b) => a.subject.localeCompare(b.subject)),
      workflows: [...byWorkflow.values()].sort((a, b) => a.subject.localeCompare(b.subject)),
    };
  }

  private formatRubrics(outcomeSummary: ActionOutcomeSummary[], snapshot: RubricSnapshot): string {
    const lines: string[] = [
      "# Compounding Rubrics",
      "",
      `Generated: ${snapshot.updatedAt}`,
      "",
      "Stable, deterministic rubric snapshot generated from weekly feedback + action outcomes.",
      "",
    ];

    lines.push("## Agent Rubrics");
    if (snapshot.agents.length === 0) {
      lines.push("- (none yet)");
    } else {
      for (const rubric of snapshot.agents) {
        lines.push(`### ${rubric.subject}`);
        const observations = this.getRubricObservationEntries(rubric).slice(0, 8);
        if (observations.length === 0) {
          lines.push("- No rubric deltas this week.");
        } else {
          for (const observation of observations) {
            const provenance = observation.provenance.join(", ");
            lines.push(`- ${observation.note}${provenance ? ` _(source: ${provenance})_` : ""}`);
          }
        }
        lines.push("");
      }
    }

    lines.push("## Workflow Rubrics");
    if (snapshot.workflows.length === 0) {
      lines.push("- (none yet)");
    } else {
      for (const rubric of snapshot.workflows) {
        lines.push(`### ${rubric.subject}`);
        for (const observation of this.getRubricObservationEntries(rubric).slice(0, 8)) {
          const provenance = observation.provenance.join(", ");
          lines.push(`- ${observation.note}${provenance ? ` _(source: ${provenance})_` : ""}`);
        }
        lines.push("");
      }
    }

    lines.push("## Action Outcome Signals");
    if (outcomeSummary.length === 0) {
      lines.push("- (none yet)");
    } else {
      for (const item of outcomeSummary.slice(0, 20)) {
        lines.push(
          `- ${item.action}: weight=${item.weightedScore} (applied=${item.counts.applied}, skipped=${item.counts.skipped}, failed=${item.counts.failed})`,
        );
      }
    }
    lines.push("");
    return lines.join("\n");
  }

  private async syncRubricArtifacts(snapshot: RubricSnapshot): Promise<void> {
    await this.replaceRubricDirectory(this.rubricsAgentsDir, snapshot.agents);
    await this.replaceRubricDirectory(this.rubricsWorkflowsDir, snapshot.workflows);
  }

  private async replaceRubricDirectory(dir: string, entries: RubricSnapshotEntry[]): Promise<void> {
    await mkdir(dir, { recursive: true });
    try {
      const names = await readdir(dir);
      await Promise.all(
        names.filter((name) => name.endsWith(".md")).map((name) => unlink(path.join(dir, name)).catch(() => undefined)),
      );
    } catch {
      // fail-open
    }

    const slugCollisions = new Map<string, number>();
    for (const entry of entries) {
      const slug = stableSlug(entry.subject);
      slugCollisions.set(slug, (slugCollisions.get(slug) ?? 0) + 1);
    }

    await Promise.all(entries.map(async (entry) => {
      const observationEntries = this.getRubricObservationEntries(entry);
      const body = [
        `# ${entry.kind === "agent" ? "Agent" : "Workflow"} Rubric — ${entry.subject}`,
        "",
        `Updated: ${entry.updatedAt}`,
        "",
        "## Observations",
        ...(observationEntries.length > 0
          ? observationEntries.map((item) => `- ${item.note}`)
          : ["- (none yet)"]),
        "",
        "## Provenance",
        ...(entry.provenance.length > 0 ? entry.provenance.map((item) => `- ${item}`) : ["- (none yet)"]),
        "",
      ].join("\n");
      const fileName = rubricArtifactFileName(entry, slugCollisions);
      await writeFile(path.join(dir, fileName), body, "utf-8");
    }));
  }

  private scoreRubricForQuery(entry: RubricSnapshotEntry, queryTokens: string[]): number {
    if (queryTokens.length === 0) return entry.observations.length;
    const haystack = [entry.subject, ...entry.observations, ...entry.tags].join(" ").toLowerCase();
    let score = 0;
    for (const token of queryTokens) {
      if (haystack.includes(token)) score += 2;
      if (entry.subject.toLowerCase().includes(token)) score += 2;
    }
    if (score === 0) return 0;
    return score + Math.min(entry.observations.length, 3);
  }

  private normalizeRubricEntry(entry: RubricSnapshotEntry): RubricSnapshotEntry {
    const normalizedEntries = this.getRubricObservationEntries(entry);
    return {
      ...entry,
      observations: normalizedEntries.map((item) => item.note),
      provenance: [...new Set(normalizedEntries.flatMap((item) => item.provenance))],
      observationEntries: normalizedEntries,
    };
  }

  private getRubricObservationEntries(entry: RubricSnapshotEntry): Array<{ note: string; provenance: string[] }> {
    if (Array.isArray(entry.observationEntries) && entry.observationEntries.length > 0) {
      return entry.observationEntries.map((item) => ({
        note: item.note,
        provenance: [...new Set(item.provenance)].sort(),
      }));
    }

    return entry.observations.map((note, index) => ({
      note,
      provenance: entry.provenance[index] ? [entry.provenance[index]] : (entry.provenance[0] ? [entry.provenance[0]] : []),
    }));
  }

  private isSyntheticOutcomeRubricObservation(note: string): boolean {
    return note.trimStart().startsWith("Outcome weight=");
  }

  private addRubricObservation(entry: RubricSnapshotEntry, note: string, ...provenance: string[]): void {
    const normalized = this.normalizeRubricEntry(entry);
    const existing = normalized.observationEntries?.find((item) => item.note === note);
    if (existing) {
      existing.provenance = [...new Set([...existing.provenance, ...provenance])].sort();
    } else {
      normalized.observationEntries?.push({
        note,
        provenance: [...new Set(provenance)].sort(),
      });
    }
    entry.observationEntries = normalized.observationEntries;
    entry.observations = normalized.observationEntries?.map((item) => item.note) ?? [];
    entry.provenance = [...new Set((normalized.observationEntries ?? []).flatMap((item) => item.provenance))];
  }

  private async readOptionalIdentityAnchorForAudit(): Promise<string | null> {
    try {
      return await this.storage.readIdentityAnchor();
    } catch {
      return null;
    }
  }

  private async readOptionalImprovementLoopsForAudit(): Promise<string | null> {
    try {
      return await this.storage.readIdentityImprovementLoops();
    } catch {
      return null;
    }
  }

  private async readContinuityIncidentsForAudit(
    limit: number,
    state: "open" | "closed",
  ): Promise<ContinuityIncidentRecord[]> {
    try {
      return await this.storage.readContinuityIncidents(limit, state);
    } catch {
      return [];
    }
  }

  private async readOptionalIdentityAuditForReference(
    period: "weekly" | "monthly",
    key: string,
  ): Promise<string | null> {
    try {
      return await this.storage.readIdentityAudit(period, key);
    } catch {
      return null;
    }
  }

  private async readContinuityAuditReferences(weekId: string): Promise<{
    weekId: string;
    monthId: string;
    weeklyPath: string | null;
    monthlyPath: string | null;
  }> {
    const monthId = monthIdFromIsoWeek(weekId);
    const weeklyPath = path.join(this.identityAuditWeeklyDir, `${weekId}.md`);
    const monthlyPath = path.join(this.identityAuditMonthlyDir, `${monthId}.md`);
    const [weeklyAudit, monthlyAudit] = await Promise.all([
      this.readOptionalIdentityAuditForReference("weekly", weekId),
      this.readOptionalIdentityAuditForReference("monthly", monthId),
    ]);
    const weeklyExists = (weeklyAudit ?? "").trim().length > 0;
    const monthlyExists = (monthlyAudit ?? "").trim().length > 0;
    return {
      weekId,
      monthId,
      weeklyPath: weeklyExists ? weeklyPath : null,
      monthlyPath: monthlyExists ? monthlyPath : null,
    };
  }
}
