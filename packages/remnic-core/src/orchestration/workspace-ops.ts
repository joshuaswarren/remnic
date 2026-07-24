/**
 * Workspace-ops coordinator — extracted from the orchestrator
 * (issue #1526, seam 24).
 *
 * Owns the periodic workspace/operations surfaces:
 *   - day-summary fact gathering (gatherTodayFacts)
 *   - memory-action policy preview (previewMemoryActionEvent)
 *   - file hygiene runs and identity auto-consolidation
 *   - wearables service construction
 *   - local-LLM model validation
 *   - pattern-reinforcement runs and their namespace fanout
 *   - access-tracking flush
 *
 * Behavior-preserving move from orchestrator.ts (late-binding deps rule,
 * seams 18–23).
 */

import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveCompressionCapabilities, resolveConsolidationCapabilities, resolveNamespaceCapabilities, resolveRecallEnhancementCapabilities } from "../capabilities.js";
import { formatDaySummaryMemories } from "../day-summary.js";
import { type JudgeVerdict, judgeFactDurability } from "../extraction-judge.js";
import { ExtractionEngine } from "../extraction.js";
import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig } from "../fallback-llm.js";
import { lintWorkspaceFiles, rotateMarkdownFileToArchive } from "../hygiene.js";
import { StorageManager } from "../index.js";
import { LocalLlmClient } from "../local-llm.js";
import { log } from "../logger.js";
import type { NamespaceMaintenanceFanoutRunnerContext } from "../maintenance/namespace-maintenance-fanout.js";
import type { NamespaceMaintenanceSummary } from "../maintenance/namespace-planner.js";
import { type PatternReinforcementResult, runPatternReinforcement } from "../maintenance/pattern-reinforcement.js";
import { evaluateMemoryActionPolicy } from "../memory-action-policy.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { namespaceCollectionName } from "../namespaces/search.js";
import { parseMemoryActionEligibilityContext } from "../schemas.js";
import type { SearchBackend } from "../search/port.js";
import { type AccessTrackingEntry, type MemoryActionEvent, type MemoryFile, type PluginConfig, confidenceTier } from "../types.js";
import { RECALL_FALLBACK_DIRS } from "../utils/category-dir.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";
import { WearablesService } from "../wearables/service.js";
import { ActivityStore } from "../activity/store.js";
import { MeetingsBuilder } from "../meetings/build.js";
import { createMeetingMemoryGenerator, createMeetingMemoryWriter } from "../meetings/memory-gen.js";
import { createMeetingSummaryDeps } from "../meetings/summary-extractor.js";
import {
  ActivityWearablesMeetingsDaySource,
  storageWearableDayReader,
  type MeetingsActivityReader,
} from "../meetings/day-source.js";
import { MeetingsService } from "../meetings/service.js";
import { qmdCollectionPathParts, qmdResultPathCandidates } from "./qmd-result-resolver.js";
import {
  Orchestrator,
  filterHourlySummaryMarkdownForLocalDay,
  formatDateInTimeZone,
  normalizeIanaTimeZone,
  parseFiniteDate,
  utcDateKeysForLocalDay,
  type DaySummaryGatherOptions,
} from "../orchestrator.js";

/**
 * Trailing-edge coalescing window for post-sync meeting rebuilds (issue #1900).
 * An activity tick and a wearable window sync often land within seconds; this
 * folds the burst into one build per day.
 */
const MEETINGS_BUILD_DEBOUNCE_MS = 5_000;

export interface WorkspaceOpsDeps {
  readonly accessTrackingBuffer: Map<
    string,
    {
      memoryId: string;
      memoryPath?: string;
      namespace?: string;
      count: number;
      lastAccessed: string;
    }
  >;
  trackRecallBackgroundWrite(promise: Promise<void>, label: string): void;
  bulkImportWriteNamespace(): string;
  readonly config: PluginConfig;
  readonly extraction: ExtractionEngine;
  getStorage(namespace?: string): Promise<StorageManager>;
  getStorageForNamespace(namespace?: string): Promise<StorageManager>;
  readonly judgeDeferCounts: Map<string, number>;
  readonly judgeVerdictCache: Map<string, JudgeVerdict>;
  lastFileHygieneRunAtMs: number;
  readonly lastPatternReinforcementAtByNs: Map<string, number>;
  readonly localLlm: LocalLlmClient;
  maintenanceNamespaces(
    jobName?: string,
    budgetMode?: "cycle" | "unbounded",
  ): Promise<string[]>;
  namespaceFromPath(p: string): string;
  readonly qmd: SearchBackend;
  readAllMemoriesForNamespaces(
    namespaces: string[],
  ): Promise<MemoryFile[]>;
  runNamespaceMaintenanceFanoutForJob(
    jobName: string,
    runner: (ctx: NamespaceMaintenanceFanoutRunnerContext) => Promise<{ itemCount?: number } | undefined>,
    options?: { enabled?: boolean },
  ): Promise<NamespaceMaintenanceSummary>;
  runPatternReinforcement(options?: {
    force?: boolean;
    namespace?: string;
  }): Promise<{
    ran: boolean;
    skippedReason?: "disabled" | "cadence";
    namespace: string;
    result?: PatternReinforcementResult;
  }>;
  readonly storage: StorageManager;
  readonly storageRouter: NamespaceStorageRouter;
  readonly wearablesServiceByNamespace: Map<string, WearablesService>;
  readonly meetingsServiceByNamespace: Map<string, MeetingsService>;
}

function matchesMemoryPath(candidatePath: string, requestedPath: string, memoryDir: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  return normalizedCandidate === path.resolve(requestedPath) || normalizedCandidate === path.resolve(memoryDir, requestedPath);
}

function accessTrackingPathCandidates(storageDir: string, memoryPath: string): string[] {
  const candidates = qmdResultPathCandidates(storageDir, memoryPath);
  const parts = qmdCollectionPathParts(memoryPath);
  if (!parts) return candidates;

  candidates.push(
    ...qmdResultPathCandidates(storageDir, parts.relativePath),
    ...qmdResultPathCandidates(path.join(storageDir, "cold"), parts.relativePath),
  );
  return [...new Set(candidates)];
}

function canonicalMemoryPath(memoryPath: string, memoryDir: string): string {
  return path.resolve(path.isAbsolute(memoryPath) ? memoryPath : path.resolve(memoryDir, memoryPath));
}
export class WorkspaceOpsCoordinator {
  constructor(
    private readonly deps: WorkspaceOpsDeps,
  ) {}

  /**
   * Run the pattern-reinforcement maintenance job (issue #687 PR 2/4).
   *
   * Cadence-gated on `patternReinforcementCadenceMs` so every caller
   * (orchestrator cron path, MCP tool, CLI) shares a single floor —
   * none can call this on a hot loop and burn the corpus.  When the
   * feature is disabled or the cadence has not elapsed, returns a
   * synthetic "skipped" result rather than throwing.
   *
   * Cadence tracking is per-namespace so a tenant-scoped MCP run in
   * one namespace does not silence a cron run in another (PR #730
   * review feedback, Codex P2).  Pass `force: true` for ad-hoc
   * operator runs that must bypass the cadence floor — mirrors the
   * pattern used by other maintenance MCP tools.
   *
   * `force` deliberately does NOT bypass the master
   * `patternReinforcementEnabled` flag (PR #730 review feedback,
   * Cursor Medium).  Operators who have explicitly disabled the
   * feature must not have their corpus mutated by an MCP tool call —
   * the only way to run the job is to enable the feature in config.
   */
  async runPatternReinforcement(options: {
    force?: boolean;
    namespace?: string;
  } = {}): Promise<{
    ran: boolean;
    skippedReason?: "disabled" | "cadence";
    namespace: string;
    result?: PatternReinforcementResult;
  }> {
    const cadenceKey = options.namespace ?? "";
    // Master switch: a disabled feature is never bypassed, even with
    // force=true.  `force` only relaxes the cadence floor below.
    if (!resolveConsolidationCapabilities(this.deps.config).patternReinforcement) {
      return { ran: false, skippedReason: "disabled", namespace: cadenceKey };
    }
    const cadence = this.deps.config.patternReinforcementCadenceMs;
    const lastAt = this.deps.lastPatternReinforcementAtByNs.get(cadenceKey);
    if (
      !options.force &&
      cadence > 0 &&
      lastAt !== undefined &&
      Date.now() - lastAt < cadence
    ) {
      return { ran: false, skippedReason: "cadence", namespace: cadenceKey };
    }
    const storage = options.namespace
      ? await this.deps.getStorage(options.namespace)
      : this.deps.storage;
    const result = await runPatternReinforcement(storage, {
      categories: this.deps.config.patternReinforcementCategories,
      minCount: this.deps.config.patternReinforcementMinCount,
    });
    this.deps.lastPatternReinforcementAtByNs.set(cadenceKey, Date.now());
    log.debug(
      `pattern reinforcement [ns=${cadenceKey || "(default)"}]: clusters=${result.clustersFound} canonicalsUpdated=${result.canonicalsUpdated} duplicatesSuperseded=${result.duplicatesSuperseded}`,
    );
    return { ran: true, result, namespace: cadenceKey };
  }

  /**
   * Fan out pattern reinforcement across all maintained namespaces (issue #1500).
   * Delegates per-namespace execution to {@link runPatternReinforcement} while
   * the planner handles discovery, budgeting, locking, and status recording.
   * When namespaces are disabled, runs once against default storage.
   */
  async runPatternReinforcementFanout(options: {
    force?: boolean;
  } = {}): Promise<NamespaceMaintenanceSummary> {
    return this.deps.runNamespaceMaintenanceFanoutForJob(
      "pattern-reinforcement",
      async (ctx) => {
        const result = await this.deps.runPatternReinforcement({
          namespace: ctx.candidate.namespace,
          force: options.force,
        });
        // runPatternReinforcement has its own per-namespace cadence gate
        // (lastPatternReinforcementAtByNs). When it throttles (ran:false),
        // signal skip so the planner records state:"skipped" and does NOT
        // touch lastMaintenanceAt — otherwise a throttled namespace would
        // look maintained while pattern reinforcement never ran (#1500
        // review: cadence-skip accuracy).
        if (!result.ran) {
          return {
            skipped: true,
            skipReason: result.skippedReason ?? "throttled",
          };
        }
        return result.result
          ? { itemCount: result.result.clustersFound }
          : { itemCount: 0 };
      },
      { enabled: resolveConsolidationCapabilities(this.deps.config).patternReinforcement },
    );
  }

  async maybeRunFileHygiene(): Promise<void> {
    const hygiene = this.deps.config.fileHygiene;
    if (!hygiene?.enabled) return;

    const now = Date.now();
    if (now - this.deps.lastFileHygieneRunAtMs < hygiene.runMinIntervalMs) return;
    this.deps.lastFileHygieneRunAtMs = now;

    // Rotation first (keeps bootstrap files small).
    if (hygiene.rotateEnabled) {
      for (const rel of hygiene.rotatePaths) {
        const abs = path.isAbsolute(rel)
          ? rel
          : path.join(this.deps.config.workspaceDir, rel);
        try {
          const raw = await readFile(abs, "utf-8");
          if (raw.length > hygiene.rotateMaxBytes) {
            const archiveDir = path.join(
              this.deps.config.workspaceDir,
              hygiene.archiveDir,
            );
            const base = path.basename(abs);
            const prefix =
              base
                .toUpperCase()
                .replace(/\.MD$/i, "")
                .replace(/[^A-Z0-9]+/g, "-") || "FILE";
            const { newContent } = await rotateMarkdownFileToArchive({
              filePath: abs,
              archiveDir,
              archivePrefix: prefix,
              keepTailChars: hygiene.rotateKeepTailChars,
            });
            await writeFile(abs, newContent, "utf-8");
          }
        } catch {
          // ignore missing/unreadable targets
        }
      }
    }

    // Lint (warn before truncation risk).
    if (hygiene.lintEnabled) {
      const warnings = await lintWorkspaceFiles({
        workspaceDir: this.deps.config.workspaceDir,
        paths: hygiene.lintPaths,
        budgetBytes: hygiene.lintBudgetBytes,
        warnRatio: hygiene.lintWarnRatio,
      });
      for (const w of warnings) {
        log.warn(w.message);
      }

      if (hygiene.warningsLogEnabled && warnings.length > 0) {
        const fp = path.join(this.deps.config.memoryDir, hygiene.warningsLogPath);
        await mkdir(path.dirname(fp), { recursive: true });
        const stamp = new Date().toISOString();
        const block =
          `\n\n## ${stamp}\n\n` +
          warnings.map((w) => `- ${w.message}`).join("\n") +
          "\n";
        let existing = "";
        try {
          existing = await readFile(fp, "utf-8");
        } catch {
          existing = "# Engram File Hygiene Warnings\n";
        }
        await writeFile(fp, existing + block, "utf-8");
      }
    }
  }

  /**
   * Read today's facts and hourly summaries from storage, returning them
   * as a formatted string suitable for generateDaySummary().
   */
  async gatherTodayFacts(
    namespace?: string,
    options: DaySummaryGatherOptions = {},
  ): Promise<string> {
    const ns =
      namespace && namespace.length > 0
        ? namespace
        : this.deps.config.defaultNamespace;
    const storage = await this.deps.storageRouter.storageFor(ns);
    const configuredTimeZone = normalizeIanaTimeZone(options.timeZone)
      ?? normalizeIanaTimeZone(this.deps.config.daySummaryTimezone);
    const timeZone =
      configuredTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = options.now instanceof Date && Number.isFinite(options.now.getTime())
      ? options.now
      : new Date();
    const targetLocalDate = formatDateInTimeZone(now, timeZone);
    // Facts are stored under UTC date directories, while the summary target is
    // a local calendar day. Scan the UTC-date envelope that overlaps the local
    // day, then filter parseable fact timestamps to that configured local day.
    const datesToScan = utcDateKeysForLocalDay(now, timeZone);
    const MAX_CHARS = 100_000;

    // --- Read memory files from each category dir × date directory ---
    // Iterate every recall category dir (RECALL_FALLBACK_DIRS — single source
    // of truth) so the day summary includes decisions/, moments/, ... not just
    // facts/ (#1546). corrections/ is flat, so corrections/<date>/ never exists
    // and is skipped by the ENOENT guard — preserving the prior exclusion. The
    // per-file created→local-day filter below is unchanged.
    //
    // Symlink/containment hardening (mirrors scanDir / the CLI walker): the
    // gathered contents feed the day-summary LLM input, so a symlinked category
    // dir (decisions/ → outside memoryDir) must not be followed and leak files.
    // Resolve the store root once; skip symlinked / out-of-root dirs and
    // entries; skip the scan gracefully if the root can't be resolved.
    const facts: MemoryFile[] = [];
    let memoryRootReal: string | null = null;
    try {
      memoryRootReal = await realpath(storage.dir);
    } catch {
      memoryRootReal = null;
    }
    for (const categoryDir of RECALL_FALLBACK_DIRS) {
      if (memoryRootReal === null) break;
      for (const date of datesToScan) {
        const dateDir = path.join(storage.dir, categoryDir, date);
        try {
          const dirStat = await lstat(dateDir);
          if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
          assertPathInsideRoot(memoryRootReal, await realpath(dateDir), dateDir);
          const entries = await readdir(dateDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            if (!entry.name.endsWith(".md")) continue;
            const fullPath = path.join(dateDir, entry.name);
            try {
              assertPathInsideRoot(memoryRootReal, await realpath(fullPath), fullPath);
              const raw = await readFile(fullPath, "utf-8");
              const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
              if (!fmMatch) continue;
              const fmBlock = fmMatch[1];
              const content = fmMatch[2].trim();
              const fm: Record<string, string> = {};
              for (const line of fmBlock.split("\n")) {
                const colonIdx = line.indexOf(":");
                if (colonIdx === -1) continue;
                fm[line.slice(0, colonIdx).trim()] = line
                  .slice(colonIdx + 1)
                  .trim();
              }
              const created = fm.created || "unknown";
              const createdAt = parseFiniteDate(created);
              if (
                createdAt &&
                formatDateInTimeZone(createdAt, timeZone) !== targetLocalDate
              ) {
                continue;
              }
              facts.push({
                path: fullPath,
                frontmatter: {
                  id: fm.id || path.basename(entry.name, ".md"),
                  category: (fm.category as any) || "fact",
                  created,
                  updated: fm.updated || created,
                  source: fm.source || "unknown",
                  confidence: parseFloat(fm.confidence || "0.8"),
                  confidenceTier: (fm.confidenceTier as any) || "implied",
                  tags: [],
                },
                content,
              });
            } catch {
              // Skip unreadable files
            }
          }
        } catch {
          // Absent dir (ENOENT), symlinked/out-of-root dir, or containment
          // violation — skip this category/date without aborting the summary.
        }
      }
    }

    // Sort facts by created timestamp (most recent last) so truncation keeps newest
    facts.sort((a, b) => {
      if (a.frontmatter.created === b.frontmatter.created) return 0;
      return a.frontmatter.created < b.frontmatter.created ? -1 : 1;
    });

    // --- Read hourly summaries for the scanned dates ---
    const hourlySummaries: string[] = [];
    const hourlyBaseDir = path.join(storage.dir, "summaries", "hourly");
    try {
      const sessionKeys = await readdir(hourlyBaseDir, { withFileTypes: true });
      for (const sk of sessionKeys) {
        if (!sk.isDirectory()) continue;
        for (const date of datesToScan) {
          const summaryFile = path.join(hourlyBaseDir, sk.name, `${date}.md`);
          try {
            const raw = await readFile(summaryFile, "utf-8");
            const filtered = filterHourlySummaryMarkdownForLocalDay(
              raw,
              date,
              timeZone,
              targetLocalDate,
            );
            if (filtered) {
              hourlySummaries.push(filtered);
            }
          } catch {
            // No summary file for this session/date
          }
        }
      }
    } catch {
      // No hourly summaries directory
    }

    // --- Format and truncate ---
    let formatted = formatDaySummaryMemories(facts);
    if (hourlySummaries.length > 0) {
      formatted +=
        "\n\n---\n## Hourly Summaries\n\n" +
        hourlySummaries.join("\n\n---\n\n");
    }

    // Truncate intelligently if over budget: drop oldest facts first
    if (formatted.length > MAX_CHARS) {
      // Re-build with fewer facts, keeping most recent
      while (facts.length > 1 && formatted.length > MAX_CHARS) {
        facts.shift(); // drop oldest
        formatted = formatDaySummaryMemories(facts);
        if (hourlySummaries.length > 0) {
          formatted +=
            "\n\n---\n## Hourly Summaries\n\n" +
            hourlySummaries.join("\n\n---\n\n");
        }
      }
      // If still over, hard truncate
      if (formatted.length > MAX_CHARS) {
        formatted = formatted.slice(0, MAX_CHARS);
      }
    }

    log.info(
      `gatherTodayFacts: collected ${facts.length} facts, ${hourlySummaries.length} hourly summaries for ${targetLocalDate} (${timeZone}, ${formatted.length} chars)`,
    );

    return formatted;
  }

  previewMemoryActionEvent(
    event: Omit<MemoryActionEvent, "timestamp"> & { timestamp?: string },
  ): MemoryActionEvent {
    const namespace =
      typeof event.namespace === "string" && event.namespace.length > 0
        ? event.namespace
        : this.deps.config.defaultNamespace;
    const eligibility = parseMemoryActionEligibilityContext(
      event.policyEligibility,
    );
    const policy = evaluateMemoryActionPolicy({
      action: event.action,
      eligibility,
      options: {
        actionsEnabled: resolveCompressionCapabilities(this.deps.config).contextCompressionActions,
        maxCompressionTokensPerHour: this.deps.config.maxCompressionTokensPerHour,
      },
    });
    const dryRun = event.dryRun === true;

    const normalizedOutcome = dryRun
      ? event.outcome === "failed"
        ? "failed"
        : "skipped"
      : policy.decision === "allow"
        ? event.outcome
        : event.outcome === "failed"
          ? "failed"
          : "skipped";
    const sourceSessionKey =
      typeof event.sourceSessionKey === "string" &&
      event.sourceSessionKey.length > 0
        ? event.sourceSessionKey
        : typeof event.sessionKey === "string" && event.sessionKey.length > 0
          ? event.sessionKey
          : undefined;
    const outputMemoryIds = Array.isArray(event.outputMemoryIds)
      ? Array.from(
          new Set(
            event.outputMemoryIds.filter(
              (value): value is string =>
                typeof value === "string" && value.length > 0,
            ),
          ),
        )
      : [];

    const reasonParts = [
      event.reason,
      `policy:${policy.decision}`,
      policy.rationale,
    ].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );

    return {
      ...event,
      schemaVersion: event.schemaVersion ?? 1,
      actionId:
        typeof event.actionId === "string" && event.actionId.length > 0
          ? event.actionId
          : `memact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      outcome: normalizedOutcome,
      status:
        event.status ??
        (dryRun && policy.decision === "allow" && event.outcome !== "failed"
          ? "validated"
          : normalizedOutcome === "applied"
            ? "applied"
            : "rejected"),
      actor:
        typeof event.actor === "string" && event.actor.length > 0
          ? event.actor
          : "engram",
      subsystem:
        typeof event.subsystem === "string" && event.subsystem.length > 0
          ? event.subsystem
          : "memory_action",
      reason: reasonParts.join(" | "),
      namespace,
      sessionKey: sourceSessionKey ?? event.sessionKey,
      sourceSessionKey,
      inputSummary:
        typeof event.inputSummary === "string" && event.inputSummary.length > 0
          ? event.inputSummary
          : undefined,
      outputMemoryIds,
      dryRun,
      policyVersion:
        typeof event.policyVersion === "string" &&
        event.policyVersion.length > 0
          ? event.policyVersion
          : "memory-action-policy.v1",
      timestamp:
        typeof event.timestamp === "string" && event.timestamp.length > 0
          ? event.timestamp
          : new Date().toISOString(),
      policyDecision: policy.decision,
      policyRationale: policy.rationale,
      policyEligibility: eligibility,
    };
  }

  /**
   * Validate local LLM model availability and context window compatibility.
   * Warns the user if there's a mismatch.
   */
  async validateLocalLlmModel(): Promise<void> {
    log.debug("Local LLM: validating model configuration");
    try {
      const modelInfo = await this.deps.localLlm.getLoadedModelInfo();
      if (!modelInfo) {
        log.warn(
          "Local LLM validation: Could not query model info from server",
        );
        log.warn(
          "Local LLM validation: Could not query model info. " +
            "Ensure LM Studio/Ollama is running with the model loaded.",
        );
        return;
      }

      // Check for context window mismatch
      const configuredMaxContext = this.deps.config.localLlmMaxContext;

      if (modelInfo.contextWindow) {
        log.debug(
          `Local LLM: ${modelInfo.id} loaded with ${modelInfo.contextWindow.toLocaleString()} token context window`,
        );

        if (
          configuredMaxContext &&
          configuredMaxContext > modelInfo.contextWindow
        ) {
          log.warn(
            `Local LLM context mismatch: engram configured for ${configuredMaxContext.toLocaleString()} tokens, ` +
              `but ${modelInfo.id} only supports ${modelInfo.contextWindow.toLocaleString()}. ` +
              `Reducing to ${modelInfo.contextWindow.toLocaleString()} to avoid errors.`,
          );
          // Update the config in-memory to match actual capability
          // (This is a temporary fix - user should update their config)
          (this.deps.config as { localLlmMaxContext?: number }).localLlmMaxContext =
            modelInfo.contextWindow;
        }
      } else {
        log.debug(
          `Local LLM: ${modelInfo.id} loaded (context window not reported by server)`,
        );

        if (!configuredMaxContext) {
          log.warn(
            "Local LLM: Server did not report context window. " +
              "If you get 'context length exceeded' errors, set localLlmMaxContext in your config. " +
              "Common defaults: LM Studio (32K), Ollama (2K-128K depending on model).",
          );
        }
      }
    } catch (err) {
      log.warn(`Local LLM validation failed: ${err}`);
    }
  }

  /**
   * Lazily-constructed wearables service (Limitless / Bee / Omi
   * transcript ingestion). All wearables surfaces — CLI, MCP tools,
   * HTTP routes — share this one instance so sync state, search, and
   * memory writes stay consistent. Writes are pinned to the same
   * deterministic namespace bulk-import uses.
   */
  getWearablesService(namespace: string): WearablesService {
    let service = this.deps.wearablesServiceByNamespace.get(namespace);
    if (!service) {
      service = new WearablesService({
        config: this.deps.config.wearables,
        getStorage: async () => await this.deps.getStorageForNamespace(namespace),
        extract: (turns) => this.deps.extraction.extract(turns),
        // Smart memoryMode runs candidates through the SAME extraction
        // judge (cache + defer counters included) the live extraction
        // pipeline uses, so wearable facts get identical LLM-as-judge
        // durability gating.
        judgeFacts: (candidates) =>
          judgeFactDurability(
            candidates,
            this.deps.config,
            this.deps.localLlm,
            new FallbackLlmClient(
              this.deps.config.gatewayConfig,
              fallbackLlmRuntimeContextFromConfig(this.deps.config),
            ),
            this.deps.judgeVerdictCache,
            this.deps.judgeDeferCounts,
          ),
        searchBackend: {
          search: async (query, maxResults) => {
            if (!this.deps.qmd.isAvailable()) return null;
            try {
              // Scope the indexed search to the CALLER namespace's collection so a
              // non-default caller's transcript_search never returns root or
              // other-namespace transcripts (#2123). Namespaces off, or the
              // default/machine-owner namespace rooted at memoryDir, resolve to the
              // base collection (unchanged); every other namespace to its own.
              let collection: string | undefined;
              if (resolveNamespaceCapabilities(this.deps.config).namespaces === true) {
                const storage = await this.deps.getStorageForNamespace(namespace);
                const useLegacy =
                  namespace === this.deps.config.defaultNamespace &&
                  storage.dir === this.deps.config.memoryDir;
                collection = namespaceCollectionName(this.deps.config.qmdCollection, namespace, {
                  defaultNamespace: this.deps.config.defaultNamespace,
                  useLegacyDefaultCollection: useLegacy,
                });
              }
              const results = await this.deps.qmd.search(query, collection, maxResults);
              return results.map((result) => ({
                path: result.path,
                score: result.score,
                preview: result.snippet,
              }));
            } catch {
              // Backend hiccup → tell the service "unavailable" so it
              // runs its bounded scan fallback instead of returning a
              // silent empty result (CLAUDE.md rule 34).
              return null;
            }
          },
        },
        reindexSearch: async () => {
          // qmd.update() clears the global QMD result caches itself on success
          // (QmdClient.runUpdateForCollection), so newly-indexed wearable
          // transcript/fact content is never hidden by a pre-sync cache entry
          // (#1904, Codex).
          await this.deps.qmd.update();
        },
        // Meeting tail-step (issue #1900): schedule a debounced meeting rebuild
        // for every day a wearable sync touched. Wired on the shared service so
        // BOTH the auto-sync adapter and the manual HTTP/MCP/CLI sync path
        // (EngramAccessService.wearablesSync -> getWearablesService().sync)
        // rebuild affected meetings. Gated on meetings.enabled so a sync of
        // other signals never spins up meeting building; a failure never fails
        // the sync.
        onDaysSynced: async (days) => {
          if (!this.deps.config.meetings.enabled) return;
          try {
            const meetings = await this.getMeetingsService(namespace);
            for (const day of days) meetings.requestBuild(day);
          } catch (err) {
            log.warn(
              `meetings: failed to schedule post-wearable-sync build: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        },
      });
      this.deps.wearablesServiceByNamespace.set(namespace, service);
    }
    return service;
  }

  /**
   * Lazily-constructed meetings service (issue #1900). Owns the record store,
   * the store-backed builder (fed by the concrete activity + wearable day
   * source), and the debounced post-sync build scheduler. Every meeting surface
   * — CLI, MCP tools, HTTP routes — shares this one instance. Writes are pinned
   * to the same deterministic namespace bulk-import uses, so meeting records and
   * episode memories land beside wearable/activity artifacts. Constructing it
   * touches no disk while `meetings.enabled` is off — every entrypoint gates.
   */
  async getMeetingsService(namespace: string): Promise<MeetingsService> {
    let service = this.deps.meetingsServiceByNamespace.get(namespace);
    if (!service) {
      const config = this.deps.config.meetings;
      const memoryDir = this.deps.config.memoryDir;
      const storage = await this.deps.getStorageForNamespace(namespace);
      const store = storage.meetingRecordStore();
      // Activity is machine-scoped (<memoryDir>/state/activity.sqlite) and is
      // consumed ONLY by the machine-owner (default) namespace; every other
      // caller namespace runs audio-only with no activity reader (issue #2123).
      // A missing/unavailable store degrades to no screen context, never a fail.
      const activity: MeetingsActivityReader | undefined =
        namespace !== this.deps.config.defaultNamespace
          ? undefined
          : {
        listSnapshotsForDay: (machine, startUtc, endUtc) => {
          let activityStore: ActivityStore | undefined;
          try {
            activityStore = ActivityStore.open(memoryDir);
            return activityStore.listSnapshotsForDay(machine, startUtc, endUtc);
          } catch (err) {
            log.warn(
              `meetings: activity snapshots unavailable (${
                err instanceof Error ? err.message : String(err)
              }); building without screen context`,
            );
            return [];
          } finally {
            activityStore?.close();
          }
        },
          };
      const source = new ActivityWearablesMeetingsDaySource({
        activity,
        wearables: storageWearableDayReader(storage),
        config,
        timezone: this.deps.config.activity.timezone,
      });
      // Production trust-gated summary/fact deps (issue #1900). Built from the
      // shared LLM clients + the SAME durability-judge closure the wearables
      // service passes (verdict cache + defer counters included), so meeting
      // facts inherit identical judge gating — no forked trust/judge/LLM path.
      // Pure construction (no disk/network); the builder gates on summaryMode.
      const fallbackLlm = new FallbackLlmClient(
        this.deps.config.gatewayConfig,
        fallbackLlmRuntimeContextFromConfig(this.deps.config),
      );
      const summary = createMeetingSummaryDeps({
        localLlm: this.deps.localLlm,
        fallbackLlm,
        judgeFacts: (candidates) =>
          judgeFactDurability(
            candidates,
            this.deps.config,
            this.deps.localLlm,
            fallbackLlm,
            this.deps.judgeVerdictCache,
            this.deps.judgeDeferCounts,
          ),
      });
      const builder = new MeetingsBuilder({
        source,
        store,
        config,
        hooks: {
          reindex: async () => {
            // Meeting records live in the QMD collection root; reindex on change
            // so `show`/search find them immediately (qmd.update clears its own
            // result caches). Fired only when records changed; a failure is
            // surfaced as a build warning, not a hard failure.
            await this.deps.qmd.update();
          },
        },
        // Memory generation behind the builder seam (issue #1900 decouple): the
        // deterministic engine depends only on MeetingMemoryGenerator, never on
        // memory-gen. The generator wraps the same sealed write path the wearables
        // generator uses — createMeetingMemoryWriter adds the source-scoped
        // dedup/retire the raw StorageManager lacks — plus the trust-gated
        // summary/facts layer (extractor + shared durability judge). It gates on
        // summaryMode internally, so `off` never invokes the extractor.
        memoryGenerator: createMeetingMemoryGenerator(createMeetingMemoryWriter(storage), config, summary),
      });
      service = new MeetingsService({
        config,
        store,
        builder,
        buildDebounceMs: MEETINGS_BUILD_DEBOUNCE_MS,
        onBuildError: (date, err) =>
          log.warn(
            `meetings: tail-step build for ${date} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
      });
      this.deps.meetingsServiceByNamespace.set(namespace, service);
    }
    return service;
  }

  async autoConsolidateIdentity(): Promise<void> {
    // Fan out over the catalog-union namespace set (issue #1499 sweep): a dynamic
    // namespace that accumulated IDENTITY.md reflections must also be eligible for
    // auto-consolidation, otherwise its identity file grows unbounded and is never
    // consolidated. Falls back to the configured set on any catalog read failure.
    const namespaces = resolveNamespaceCapabilities(this.deps.config).namespaces
      ? await this.deps.maintenanceNamespaces()
      : [this.deps.config.defaultNamespace];

    for (const namespace of namespaces) {
      const storage = await this.deps.storageRouter.storageFor(namespace);
      const identityNamespace =
        resolveNamespaceCapabilities(this.deps.config).namespaces &&
        namespace !== this.deps.config.defaultNamespace
          ? namespace
          : undefined;
      const reflectionsContent =
        (await storage.readIdentityReflections()) ?? "";

      const existingIdentity = await storage.readIdentity(
        this.deps.config.workspaceDir,
        identityNamespace,
      );
      const headerEnd =
        existingIdentity.indexOf("## Learned Patterns") !== -1
          ? existingIdentity.indexOf("## Learned Patterns")
          : existingIdentity.indexOf("## Reflection");
      const staticHeader =
        (headerEnd !== -1
          ? existingIdentity.slice(0, headerEnd)
          : existingIdentity
        ).trimEnd() || "# IDENTITY";
      const identityContent = `${staticHeader}\n\n${reflectionsContent.trim()}\n`;
      if (identityContent.length < Orchestrator.IDENTITY_CONSOLIDATE_THRESHOLD)
        continue;

      log.info(
        `IDENTITY(${namespace}) is ${identityContent.length} chars — auto-consolidating reflections`,
      );
      const result = await this.deps.extraction.consolidateIdentity(
        identityContent,
        "## Reflection",
      );

      if (!result || result.learnedPatterns.length === 0) {
        log.warn(
          `identity consolidation produced no patterns for namespace=${namespace}`,
        );
        continue;
      }

      const patternsSection = [
        "## Learned Patterns (consolidated from reflections, " +
          new Date().toISOString().slice(0, 10) +
          ")",
        "",
        ...result.learnedPatterns.map((p) => `- ${p}`),
        "",
      ].join("\n");

      const newContent = staticHeader + "\n\n" + patternsSection + "\n";

      await storage.writeIdentity(
        this.deps.config.workspaceDir,
        newContent,
        identityNamespace,
      );
      await storage.writeIdentityReflections("");
      // NRcCL (codex P2): record a per-namespace catalog write for THIS namespace
      // after the identity files are updated. This fan-out can mutate a dynamic
      // namespace via `writeIdentity`/`writeIdentityReflections`, but the
      // consolidation pass's only consolidated touch covers `this.deps.storage` (the
      // default) and only fires when `memoryItemMutated` was set by OTHER work — so
      // a namespace whose sole mutation in the pass is identity consolidation would
      // otherwise keep a stale `lastWriteAt`, making `listNamespaces({ writtenSince })`
      // and catalog-recency consumers miss the write. Best-effort and
      // failure-tolerant (the storage chokepoint (#1522) swallows errors, never crashing the
      // consolidation; gotcha #13, rule #40). No double-count with the consolidated
      // touch above: that one is gated on `memoryItemMutated` (which identity
      // consolidation does not set), and `markWrite` is idempotent regardless.
      log.info(
        `IDENTITY(${namespace}) consolidated: ${identityContent.length} → ${newContent.length} chars, ${result.learnedPatterns.length} patterns`,
      );
    }
  }
  trackMemoryAccess(
    memoryIds: string[],
    memoryPaths: string[] = [],
    memoryNamespaces: Array<string | undefined> = [],
  ): void {
    if (!resolveRecallEnhancementCapabilities(this.deps.config).accessTracking) return;

    const now = new Date().toISOString();
    const pathsByMemoryId = new Map<
      string,
      Array<{ path: string; namespace?: string }>
    >();
    for (const [index, memoryPath] of memoryPaths.entries()) {
      const basename = memoryPath.split(/[\\/]/).pop() ?? memoryPath;
      const memoryId = basename.endsWith(".md") ? basename.slice(0, -3) : basename;
      if (memoryId.length > 0 && memoryIds.includes(memoryId)) {
        const paths = pathsByMemoryId.get(memoryId) ?? [];
        const namespace = memoryNamespaces[index];
        paths.push({
          path: memoryPath,
          ...(namespace ? { namespace } : {}),
        });
        pathsByMemoryId.set(memoryId, paths);
      }
    }
    for (const id of memoryIds) {
      const references = pathsByMemoryId.get(id);
      const reference = references?.shift();
      const memoryPath = reference?.path;
      const namespace = reference?.namespace ?? (
        memoryPath
          ? this.deps.namespaceFromPath(memoryPath)
          : this.deps.config.defaultNamespace
      );
      const key = memoryPath
        ? `${namespace}:${canonicalMemoryPath(memoryPath, this.deps.config.memoryDir)}`
        : `${namespace}:${id}`;
      const existing = this.deps.accessTrackingBuffer.get(key);
      this.deps.accessTrackingBuffer.set(key, {
        memoryId: id,
        ...(memoryPath ? { memoryPath, namespace } : {}),
        count: (existing?.count ?? 0) + 1,
        lastAccessed: now,
      });
    }
    if (this.deps.accessTrackingBuffer.size >= this.deps.config.accessTrackingBufferMaxSize) {
      this.deps.trackRecallBackgroundWrite(
        this.flushAccessTracking(),
        "background access tracking flush",
      );
    }
  }

  /**
   * Flush access tracking buffer to disk.
   * Called during consolidation or when buffer is full.
   */
  async flushAccessTracking(): Promise<void> {
    if (this.deps.accessTrackingBuffer.size === 0) return;

    const bufferedNamespaces = new Set<string>();
    for (const [, update] of this.deps.accessTrackingBuffer) {
      bufferedNamespaces.add(
        update.namespace ??
          (update.memoryPath
            ? this.deps.namespaceFromPath(update.memoryPath)
            : this.deps.config.defaultNamespace),
      );
    }
    const configuredNamespaces = resolveNamespaceCapabilities(this.deps.config).namespaces
      ? [
          this.deps.config.defaultNamespace,
          this.deps.config.sharedNamespace,
          ...this.deps.config.namespacePolicies.map((p) => p.name),
        ]
      : [this.deps.config.defaultNamespace];
    const namespaces = Array.from(new Set([...configuredNamespaces, ...bufferedNamespaces]));
    const memoriesByNamespace = new Map<string, MemoryFile[]>();
    const memories = await this.deps.readAllMemoriesForNamespaces(namespaces);
    for (const memory of memories) {
      const namespace = this.deps.namespaceFromPath(memory.path);
      const list = memoriesByNamespace.get(namespace) ?? [];
      list.push(memory);
      memoriesByNamespace.set(namespace, list);
    }

    const entriesByNamespace = new Map<string, AccessTrackingEntry[]>();
    const mergedEntriesByNamespace = new Map<string, Map<string, AccessTrackingEntry>>();
    const storageDirByNamespace = new Map<string, string | null>();
    for (const [, update] of this.deps.accessTrackingBuffer) {
      const memoryPath = update.memoryPath;
      const namespace =
        update.namespace ??
        (memoryPath
          ? this.deps.namespaceFromPath(memoryPath)
          : this.deps.config.defaultNamespace);
      const namespaceMemories = memoriesByNamespace.get(namespace);
      let storageDir = storageDirByNamespace.get(namespace);
      if (storageDir === undefined) {
        const storage = await this.deps.storageRouter.storageFor(namespace);
        storageDir = typeof storage.dir === "string" && storage.dir.length > 0 ? storage.dir : null;
        storageDirByNamespace.set(namespace, storageDir);
      }
      const requestedPaths = memoryPath
        ? [
            memoryPath,
            ...(storageDir ? accessTrackingPathCandidates(storageDir, memoryPath) : []),
          ]
        : [];
      const memory = memoryPath
        ? namespaceMemories?.find((candidate) =>
            matchesMemoryPath(candidate.path, memoryPath, this.deps.config.memoryDir),
          ) ??
          namespaceMemories?.find((candidate) =>
            requestedPaths.some((requestedPath) =>
              matchesMemoryPath(candidate.path, requestedPath, this.deps.config.memoryDir),
            ),
          )
        : namespaceMemories?.find((candidate) => candidate.frontmatter.id === update.memoryId);
      if (!memory) continue;

      const namespaceEntries = mergedEntriesByNamespace.get(namespace) ?? new Map();
      const existing = namespaceEntries.get(memory.path);
      const existingLastAccessed = existing?.lastAccessed;
      const lastAccessed =
        existingLastAccessed &&
        Date.parse(existingLastAccessed) > Date.parse(update.lastAccessed)
          ? existingLastAccessed
          : update.lastAccessed;
      namespaceEntries.set(memory.path, {
        memoryId: existing?.memoryId ?? update.memoryId,
        memoryPath: memory.path,
        newCount:
          (existing?.newCount ?? (memory.frontmatter.accessCount ?? 0)) + update.count,
        lastAccessed,
      });
      mergedEntriesByNamespace.set(namespace, namespaceEntries);
    }
    for (const [namespace, entries] of mergedEntriesByNamespace) {
      entriesByNamespace.set(namespace, Array.from(entries.values()));
    }

    let flushedCount = 0;
    for (const [namespace, entries] of entriesByNamespace) {
      const storage = await this.deps.storageRouter.storageFor(namespace);
      await storage.flushAccessTracking(entries);
      flushedCount += entries.length;
    }
    this.deps.accessTrackingBuffer.clear();
    log.debug(`flushed ${flushedCount} access tracking entries`);
  }
}
