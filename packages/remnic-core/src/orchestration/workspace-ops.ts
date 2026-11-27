
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
import { localDayKey } from "../location/intervals.js";
import { renderDayLocationContext } from "../location/tagging.js";
import { type PatternReinforcementResult, runPatternReinforcement } from "../maintenance/pattern-reinforcement.js";
import { evaluateMemoryActionPolicy } from "../memory-action-policy.js";
import { NamespaceStorageRouter } from "../namespaces/storage.js";
import { namespaceCollectionName } from "../namespaces/search.js";
import { parseMemoryActionEligibilityContext } from "../schemas.js";
import { isSupportPassportPrivateMemory } from "../support-passport/card-projection.js";
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

/** A namespace's memories keyed for lookup: first index per resolved path, first memory per id (corpus order wins). */
interface MemoryIndex {
  readonly list: MemoryFile[];
  readonly byPath: Map<string, number>;
  readonly byId: Map<string, MemoryFile>;
}

// COS-666e: the old per-update `find` over the corpus resolved paths on every comparison (a 40 s stall at 130k memories).
function indexMemories(list: MemoryFile[]): MemoryIndex {
  const byPath = new Map<string, number>();
  const byId = new Map<string, MemoryFile>();
  list.forEach((memory, i) => {
    const resolved = path.resolve(memory.path);
    if (!byPath.has(resolved)) byPath.set(resolved, i);
    if (!byId.has(memory.frontmatter.id)) byId.set(memory.frontmatter.id, memory);
  });
  return { list, byPath, byId };
}

/** The first memory, in corpus order, whose path is a requested path as given or relative to the memory dir. */
function findByRequestedPaths(index: MemoryIndex, requestedPaths: string[], memoryDir: string): MemoryFile | undefined {
  let best: number | undefined;
  for (const requested of requestedPaths) {
    for (const key of [path.resolve(requested), path.resolve(memoryDir, requested)]) {
      const i = index.byPath.get(key);
      if (i !== undefined && (best === undefined || i < best)) best = i;
    }
  }
  return best === undefined ? undefined : index.list[best];
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
    const datesToScan = utcDateKeysForLocalDay(now, timeZone);
    const MAX_CHARS = 100_000;

    // --- Read memory files from each category dir × date directory ---
    //
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
              const memory = await storage.readMemoryByPath(fullPath);
              if (!memory || isSupportPassportPrivateMemory(memory)) continue;
              const createdAt = parseFiniteDate(memory.frontmatter.created);
              if (
                createdAt &&
                formatDateInTimeZone(createdAt, timeZone) !== targetLocalDate
              ) {
                continue;
              }
              facts.push(memory);
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

    facts.sort((a, b) => {
      if (a.frontmatter.created === b.frontmatter.created) return 0;
      return a.frontmatter.created < b.frontmatter.created ? -1 : 1;
    });

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

    let formatted = formatDaySummaryMemories(facts);
    if (hourlySummaries.length > 0) {
      formatted +=
        "\n\n---\n## Hourly Summaries\n\n" +
        hourlySummaries.join("\n\n---\n\n");
    }

    if (formatted.length > MAX_CHARS) {
      while (facts.length > 1 && formatted.length > MAX_CHARS) {
        facts.shift(); // drop oldest
        formatted = formatDaySummaryMemories(facts);
        if (hourlySummaries.length > 0) {
          formatted +=
            "\n\n---\n## Hourly Summaries\n\n" +
            hourlySummaries.join("\n\n---\n\n");
        }
      }
      if (formatted.length > MAX_CHARS) {
        formatted = formatted.slice(0, MAX_CHARS);
      }
    }

    if (options.includeLocation === true && this.deps.config.location) {
      const section = await renderDayLocationContext(
        storage.dir,
        localDayKey(now.toISOString(), this.deps.config.location.timezone),
        this.deps.config.location,
      );
      if (section) {
        formatted += `\n\n${section}`;
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

      const configuredMaxContext = this.deps.config.localLlmMaxContext;

      if (modelInfo.contextWindow) {
        log.debug(
          `Local LLM: ${modelInfo.id} loaded with ${modelInfo.contextWindow.toLocaleString()} token context window`,
        );

        if (
          configuredMaxContext &&
          configuredMaxContext > modelInfo.contextWindow
        ) {
          // Warn — never rewrite the shared config behind consumers'
          // backs (#3562). The user owns the persisted value; an
          // oversized localLlmMaxContext stays in effect until they
          // lower it, and prompts may exceed the model's window.
          log.warn(
            `Local LLM context mismatch: engram configured for ${configuredMaxContext.toLocaleString()} tokens, ` +
              `but ${modelInfo.id} only supports ${modelInfo.contextWindow.toLocaleString()}. ` +
              `Set localLlmMaxContext to ${modelInfo.contextWindow.toLocaleString()} or lower in your ` +
              `persisted config to avoid context-length errors.`,
          );
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
        locationConfig: this.deps.config.location,
        extract: (turns) => this.deps.extraction.extract(turns),
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
              return null;
            }
          },
        },
        reindexSearch: async () => {
          await this.deps.qmd.update();
        },
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
            await this.deps.qmd.update();
          },
        },
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
      // otherwise keep a stale `lastWriteAt`, making `listNamespaces({ writtenSince })`
      // failure-tolerant (the storage chokepoint (#1522) swallows errors, never crashing the
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
    const indexByNamespace = new Map<string, MemoryIndex>();
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
      let index = indexByNamespace.get(namespace);
      if (index === undefined && namespaceMemories) {
        index = indexMemories(namespaceMemories);
        indexByNamespace.set(namespace, index);
      }
      const memory = memoryPath
        ? (index && (findByRequestedPaths(index, [memoryPath], this.deps.config.memoryDir) ??
            findByRequestedPaths(index, requestedPaths, this.deps.config.memoryDir)))
        : index?.byId.get(update.memoryId);
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
