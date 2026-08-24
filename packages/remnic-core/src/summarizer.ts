import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "./logger.js";
import { LocalLlmClient } from "./local-llm.js";
import { FallbackLlmClient, fallbackLlmRuntimeContextFromConfig, gatewayTaskChainOptions } from "./fallback-llm.js";
import { ModelRegistry } from "./model-registry.js";
import { extractJsonCandidates } from "./json-extract.js";
import {
  completeBackgroundGeneration,
  parseBackgroundGenerationJson,
} from "./background-generation.js";
import type { HourlySummary, TranscriptEntry, PluginConfig, GatewayConfig } from "./types.js";
import type { TranscriptManager } from "./transcript.js";
import { readSummarySnapshot, upsertSummarySnapshot, writeSummarySnapshot } from "./summary-snapshot.js";
import { encodeStoragePathSegment, resolveSafeStoragePath } from "./storage-paths.js";
import { sessionStoragePaths } from "./session-identity.js";
import { resolveLocalLlmCapabilities } from "./capabilities.js";
import { resolvePipelineProcessingCapabilities } from "./capabilities.js";

// Schema for LLM summary output
const HourlySummarySchema = z.object({
  bullets: z.array(z.string().trim().min(1)).min(1).describe("3-5 bullet points summarizing the hour's activity"),
});

type HourlySummaryResult = z.infer<typeof HourlySummarySchema>;

const HourlySummaryExtendedSchema = z.object({
  topics: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  actionItems: z.array(z.string()).default([]),
  rejected: z.array(z.string()).default([]),
});

type HourlySummaryExtendedResult = z.infer<typeof HourlySummaryExtendedSchema>;

type HourlySummaryExtendedMeta = {
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  toolCounts: Record<string, number>;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Outcome stats of one `runHourly` pass (issue #2783). The summarizer must
 * not report success on empty work: an empty or stale transcript store is
 * the delegate-mode starvation signature, and callers surface these counts
 * and the staleness flag as a distinct warning instead of a bare ok.
 */
export interface HourlySummarizerRunStats {
  sessionsConsidered: number;
  sessionsWithEntries: number;
  summariesWritten: number;
  /** True when the newest transcript entry across the store is older than STALE_STORE_MS. */
  staleStore: boolean;
  /** ISO timestamp of the newest transcript entry seen by the scan, when any exist. */
  newestEntryTimestamp: string | null;
  /** True when the transcript scan itself FAILED (unreadable store) — distinct from an empty store. */
  scanFailed: boolean;
}

/** A store whose newest entry is older than this is considered stale (starvation signal, issue #2783). */
const STALE_STORE_MS = 2 * 60 * 60 * 1000;

/**
 * Interpret one {@link HourlySummarizerRunStats} into the operator-facing
 * message/warning (issue #2783). Every degraded shape — failed scan, empty
 * store, backend-down, stale store — is DISTINCT from success; monitoring
 * alerts on `warning`, never on `ok` (ok only means "the run completed").
 */
export function summarizeHourlyStatus(stats: HourlySummarizerRunStats): {
  message: string;
  warning?: string;
} {
  if (stats.scanFailed) {
    return {
      message:
        "Hourly summarization completed, but the transcript store scan FAILED (unreadable directory or I/O error). Investigate the daemon's memoryDir.",
      warning: "transcript store scan failed",
    };
  }
  if (stats.sessionsConsidered === 0) {
    return {
      message:
        "Hourly summarization completed, but the transcript store is empty — no sessions found. If turns are ingested via observe, transcript persistence may be disabled or failing.",
      warning: "transcript store is empty",
    };
  }
  if (stats.sessionsWithEntries > 0 && stats.summariesWritten === 0) {
    return {
      message: `Hourly summarization found ${stats.sessionsWithEntries} session(s) with transcript entries but wrote no summaries — the summarizer backend may be down.`,
      warning: "sessions with entries produced no summaries",
    };
  }
  if (stats.sessionsWithEntries === 0 && stats.staleStore) {
    return {
      message: `Hourly summarization completed with no transcript entries for the target hour, and the store looks stale (newest entry ${stats.newestEntryTimestamp ?? "unknown"}).`,
      warning: "no transcript entries for the target hour and no new entries recently",
    };
  }
  return {
    message: `Hourly summarization completed: ${stats.summariesWritten} summar${stats.summariesWritten === 1 ? "y" : "ies"} written across ${stats.sessionsWithEntries} session${stats.sessionsWithEntries === 1 ? "" : "s"} with transcript entries.`,
  };
}

export class HourlySummarizer {
  private summariesDir: string;
  private config: PluginConfig;
  private localLlm: LocalLlmClient;
  private fallbackLlm: FallbackLlmClient;
  private modelRegistry: ModelRegistry;
  private transcript?: TranscriptManager;

  constructor(
    config: PluginConfig,
    gatewayConfig?: GatewayConfig,
    modelRegistry?: ModelRegistry,
    transcript?: TranscriptManager
  ) {
    this.config = config;
    this.summariesDir = path.join(config.memoryDir, "summaries", "hourly");
    this.modelRegistry = modelRegistry ?? new ModelRegistry(config.memoryDir);
    this.transcript = transcript;

    // Initialize local LLM client with shared model registry
    this.localLlm = new LocalLlmClient(config, this.modelRegistry);

    // Initialize fallback client with gateway config
    this.fallbackLlm = new FallbackLlmClient(gatewayConfig, fallbackLlmRuntimeContextFromConfig(config));

    if (
      !gatewayConfig?.agents?.defaults?.model?.primary &&
      !resolveLocalLlmCapabilities(config).localLlm &&
      config.modelSource !== "gateway"
    ) {
      log.warn("no gateway default AI and local LLM disabled — hourly summarization disabled");
    }
  }

  private get useGatewayModelSource(): boolean {
    return this.config.modelSource === "gateway";
  }

  private get shouldUseLocalLlm(): boolean {
    return resolveLocalLlmCapabilities(this.config).localLlm && !this.useGatewayModelSource;
  }

  private withGatewayAgent(
    options: import("./fallback-llm.js").FallbackLlmOptions
  ): import("./fallback-llm.js").FallbackLlmOptions {
    if (!this.useGatewayModelSource) return options;
    // Shared resolution (taskModelChain > gatewayAgentId) — gotcha #22. Issue #1365.
    return { ...options, ...gatewayTaskChainOptions(this.config) };
  }

  async initialize(): Promise<void> {
    await mkdir(this.summariesDir, { recursive: true });
    log.info("hourly summarizer initialized");
  }

  private async summarySessionDir(sessionKey: string): Promise<string> {
    return resolveSafeStoragePath(this.summariesDir, encodeStoragePathSegment(sessionKey, "session"));
  }

  private async legacySummarySessionDir(sessionKey: string): Promise<string | null> {
    if (sessionKey.includes("\0")) return null;
    try {
      return await resolveSafeStoragePath(this.summariesDir, sessionKey);
    } catch {
      return null;
    }
  }

  private summaryDateString(hour: string): string {
    const dateStr = hour.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error(`invalid hourly summary timestamp: ${hour}`);
    }
    return dateStr;
  }

  // Generate summary for a specific hour and session
  async generateSummary(
    sessionKey: string,
    hourStart: Date,
    entries: TranscriptEntry[]
  ): Promise<HourlySummary | null> {
    if (entries.length === 0) return null;

    // Format entries for the LLM
    const conversation = entries.map((e) => `[${e.role}] ${e.content}`).join("\n\n");

    if (resolvePipelineProcessingCapabilities(this.config).hourlySummariesExtended) {
      const extended = await this.generateExtended(sessionKey, hourStart, conversation, entries);
      if (!extended) return null;
      const meta: HourlySummaryExtendedMeta = {
        userTurns: entries.filter((e) => e.role === "user").length,
        assistantTurns: entries.filter((e) => e.role === "assistant").length,
        toolCalls: extended._meta.toolCalls,
        toolCounts: extended._meta.toolCounts,
      };
      // Keep HourlySummary surface stable; encode "topics" as bullets for recall injection.
      const base: HourlySummary = {
        hour: hourStart.toISOString(),
        sessionKey,
        bullets: extended.topics.length > 0 ? extended.topics.slice(0, 5) : ["(summary generated)"],
        turnCount: entries.length,
        generatedAt: new Date().toISOString(),
      };
      const withExtras = base as any;
      withExtras._extended = extended;
      withExtras._extendedMeta = meta;
      return base;
    }

    const hourIso = hourStart.toISOString();
    const startTime = Date.now();

    if (this.config.backgroundGeneration) {
      try {
        const text = await completeBackgroundGeneration(this.config, [
          {
            role: "system",
            content:
              "You are a conversation summarization system. Summarize the following conversation transcript into 3-5 concise bullet points.\n\nGuidelines:\n- Focus on what was accomplished, decided, or discussed\n- Include specific topics, projects, or entities mentioned\n- Note any significant user requests or agent actions\n- Keep bullets brief but informative (1-2 sentences each)\n- Skip trivial greetings or meta-conversation\n- Use present tense for ongoing work, past for completed items\n\nRespond with valid JSON only, matching this schema:\n{\"bullets\": [\"bullet 1\", \"bullet 2\", \"bullet 3\"]}",
          },
          { role: "user", content: `Summarize this conversation:\n\n${conversation}` },
        ]);
        const parsed = parseBackgroundGenerationJson(text, (value) => HourlySummarySchema.parse(value));
        if (parsed) {
          return {
            hour: hourIso,
            sessionKey,
            bullets: parsed.bullets,
            turnCount: entries.length,
            generatedAt: new Date().toISOString(),
          };
        }
      } catch {
        log.info("summary generation: background generation unavailable, continuing");
      }
    }

    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      try {
        const localResult = await this.generateWithLocalLlm(conversation);
        if (localResult) {
          const durationMs = Date.now() - startTime;
          log.debug(`generated hourly summary for ${sessionKey} at ${hourIso} in ${durationMs}ms using local LLM`);
          return {
            hour: hourIso,
            sessionKey,
            bullets: localResult.bullets,
            turnCount: entries.length,
            generatedAt: new Date().toISOString(),
          };
        }
        // Local failed, fall back if allowed
        if (!this.config.localLlmFallback) {
          log.warn("summary generation: local LLM failed and fallback disabled");
          return null;
        }
        log.info("summary generation: local LLM unavailable, falling back to gateway default AI");
      } catch (err) {
        if (!this.config.localLlmFallback) {
          log.warn("summary generation: local LLM error and fallback disabled:", err);
          return null;
        }
        log.info("summary generation: local LLM error, falling back to gateway default AI:", err);
      }
    }

    // Fall back to gateway's default AI
    log.info("summary generation: falling back to gateway default AI");

    try {
      const messages = [
        {
          role: "system" as const,
          content: `You are a conversation summarization system. Summarize the following conversation transcript into 3-5 concise bullet points.

Guidelines:
- Focus on what was accomplished, decided, or discussed
- Include specific topics, projects, or entities mentioned
- Note any significant user requests or agent actions
- Keep bullets brief but informative (1-2 sentences each)
- Skip trivial greetings or meta-conversation
- Use present tense for ongoing work, past for completed items

Respond with valid JSON matching this schema:
{
  "bullets": ["bullet 1", "bullet 2", "bullet 3"]
}`,
        },
        { role: "user" as const, content: `Summarize this conversation:\n\n${conversation}` },
      ];

      const result = await this.fallbackLlm.parseWithSchema(
        messages,
        HourlySummarySchema,
        this.withGatewayAgent({ temperature: 0.3, maxTokens: 8192 })
      );

      const durationMs = Date.now() - startTime;

      if (result) {
        log.debug(`generated hourly summary for ${sessionKey} at ${hourIso} in ${durationMs}ms via fallback`);
        return {
          hour: hourIso,
          sessionKey,
          bullets: result.bullets,
          turnCount: entries.length,
          generatedAt: new Date().toISOString(),
        };
      }

      log.warn("summary generation fallback returned no parsed output");
      return null;
    } catch (err) {
      log.error("summary generation fallback failed", err);
      return null;
    }
  }

  private async generateExtended(
    sessionKey: string,
    hourStart: Date,
    conversation: string,
    entries: TranscriptEntry[]
  ): Promise<(HourlySummaryExtendedResult & { _meta: HourlySummaryExtendedMeta }) | null> {
    const hourIso = hourStart.toISOString();
    const startTime = Date.now();

    const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
    let toolCounts: Record<string, number> = {};
    if (this.config.hourlySummariesIncludeToolStats && this.transcript) {
      const uses = await this.transcript.readToolUse(sessionKey, hourStart, hourEnd);
      for (const u of uses) toolCounts[u.tool] = (toolCounts[u.tool] ?? 0) + 1;
    }

    const sys = `You are a conversation summarization system.\n\nSummarize the hour into structured sections.\n\nReturn valid JSON matching:\n{\n  \"topics\": [\"...\"],\n  \"decisions\": [\"...\"],\n  \"actionItems\": [\"...\"],\n  \"rejected\": [\"...\"]\n}\n\nGuidelines:\n- Prefer concrete topics and decisions.\n- Action items should be imperative.\n- Rejected ideas are things that were explicitly discarded or reversed.\n- If there are none for a section, return an empty array.\n`;

    const toolStatsLine =
      Object.keys(toolCounts).length > 0
        ? `Tools used (counts): ${Object.entries(toolCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}\n\n`
        : "";
    const userTurns = entries.filter((e) => e.role === "user").length;
    const assistantTurns = entries.filter((e) => e.role === "assistant").length;
    const toolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
    const statsLine = `Stats: userTurns=${userTurns}, assistantTurns=${assistantTurns}, toolCalls=${toolCalls}\n\n`;

    const user = `Hour: ${hourIso}\nSession: ${sessionKey}\n\n${statsLine}${toolStatsLine}Conversation:\n${conversation}\n`;

    // Try local LLM first if enabled
    if (this.shouldUseLocalLlm) {
      try {
        const contextSizes = this.modelRegistry.calculateContextSizes(
          this.config.localLlmModel,
          this.config.localLlmMaxContext
        );
        const truncated =
          user.length > contextSizes.maxInputChars
            ? user.slice(0, contextSizes.maxInputChars) + "\n\n[truncated]"
            : user;
        const response = await this.localLlm.chatCompletion(
          [
            { role: "system", content: "Output valid JSON only." },
            { role: "user", content: sys + "\n\n" + truncated },
          ],
          {
            temperature: 0.2,
            maxTokens: contextSizes.maxOutputTokens,
            operation: "hourly_summary_extended",
            priority: "background",
          }
        );
        if (response?.content) {
          const content = response.content.trim();
          for (const candidate of extractJsonCandidates(content)) {
            try {
              const parsed = JSON.parse(candidate);
              const result = HourlySummaryExtendedSchema.parse(parsed);
              log.debug(
                `generated extended hourly summary for ${sessionKey} at ${hourIso} in ${Date.now() - startTime}ms (local)`
              );
              return { ...result, _meta: { userTurns, assistantTurns, toolCalls, toolCounts } };
            } catch {
              // keep trying candidates
            }
          }
        }
      } catch (err) {
        if (!this.config.localLlmFallback) return null;
        log.info("extended summary: local failed, falling back:", err);
      }
    }

    try {
      const result = await this.fallbackLlm.parseWithSchema(
        [
          { role: "system" as const, content: sys },
          { role: "user" as const, content: user },
        ],
        HourlySummaryExtendedSchema,
        this.withGatewayAgent({ temperature: 0.2, maxTokens: 2048 })
      );
      if (result) {
        log.debug(
          `generated extended hourly summary for ${sessionKey} at ${hourIso} in ${Date.now() - startTime}ms (fallback)`
        );
        return { ...result, _meta: { userTurns, assistantTurns, toolCalls, toolCounts } };
      }
      return null;
    } catch (err) {
      log.error("extended summary generation failed", err);
      return null;
    }
  }

  /**
   * Generate summary using local LLM with JSON mode.
   * Uses dynamic context sizing based on model capabilities.
   */
  private async generateWithLocalLlm(conversation: string): Promise<HourlySummaryResult | null> {
    // Get dynamic context sizes based on model capabilities
    const contextSizes = this.modelRegistry.calculateContextSizes(
      this.config.localLlmModel,
      this.config.localLlmMaxContext
    );
    log.debug(`Summarizer model context: ${contextSizes.description}`);

    const maxConversationChars = contextSizes.maxInputChars;
    const truncatedConversation =
      conversation.length > maxConversationChars
        ? conversation.slice(0, maxConversationChars) + "\n\n[truncated]"
        : conversation;

    const instructions = `You are a conversation summarization system. Summarize the following conversation transcript into 3-5 concise bullet points.

Guidelines:
- Focus on what was accomplished, decided, or discussed
- Include specific topics, projects, or entities mentioned
- Note any significant user requests or agent actions
- Keep bullets brief but informative (1-2 sentences each)
- Skip trivial greetings or meta-conversation
- Use present tense for ongoing work, past for completed items

Respond with valid JSON matching this schema:
{
  "bullets": ["bullet 1", "bullet 2", "bullet 3"]
}`;

    const fullPrompt = `${instructions}\n\nConversation to summarize:\n${truncatedConversation}`;

    const response = await this.localLlm.chatCompletion(
      [
        { role: "system", content: "You are a conversation summarization system. Output valid JSON only." },
        { role: "user", content: fullPrompt },
      ],
      {
        temperature: 0.3,
        maxTokens: contextSizes.maxOutputTokens,
        operation: "hourly_summary",
        priority: "background",
      }
    );

    if (!response?.content) {
      return null;
    }

    try {
      // Parse JSON response
      const content = response.content.trim();
      for (const candidate of extractJsonCandidates(content)) {
        try {
          const parsed = JSON.parse(candidate);
          return HourlySummarySchema.parse(parsed);
        } catch {
          // keep trying candidates
        }
      }
      return null;
    } catch (err) {
      log.warn("local LLM summary: failed to parse JSON response:", err);
      return null;
    }
  }

  // Save summary to file
  async saveSummary(summary: HourlySummary): Promise<void> {
    const sessionDir = await this.summarySessionDir(summary.sessionKey);
    await mkdir(sessionDir, { recursive: true });

    // Format date as YYYY-MM-DD for the filename
    const dateStr = this.summaryDateString(summary.hour);
    const filePath = await resolveSafeStoragePath(sessionDir, `${dateStr}.md`);

    // Format hour as HH:00 for display
    const hourStr = summary.hour.slice(11, 13);

    // Build markdown content
    const lines: string[] = [];

    // Check if file exists to append or create
    let existingContent = "";
    try {
      existingContent = await readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist yet, will create new
    }

    // Check if this hour already exists (idempotent)
    const hourHeader = `## ${hourStr}:00`;
    if (existingContent.includes(hourHeader)) {
      // Replace existing hour section
      const headerMatch = new RegExp(`(^|\\n)${escapeRegExp(hourHeader)}\\n`).exec(existingContent);
      const sectionStart = headerMatch
        ? headerMatch.index + headerMatch[1].length
        : existingContent.indexOf(hourHeader);
      const nextHeaderPattern = /\n## \d{2}:00\n/g;
      nextHeaderPattern.lastIndex = sectionStart + hourHeader.length;
      const nextHeader = nextHeaderPattern.exec(existingContent);
      const beforeHour = existingContent.slice(0, sectionStart);
      const afterHour = nextHeader ? existingContent.slice(nextHeader.index + 1) : "";
      const newSection = this.formatHourSection(summary, hourHeader);
      existingContent = beforeHour + newSection.trimEnd() + (afterHour ? "\n\n" + afterHour : "\n");

      await writeFile(filePath, existingContent, "utf-8");
      log.debug(`updated hourly summary for ${summary.sessionKey} at ${hourStr}:00`);
    } else {
      // Append new hour section
      const newSection = this.formatHourSection(summary, hourHeader);

      if (existingContent) {
        // Add to existing file
        await writeFile(filePath, existingContent.trimEnd() + "\n\n" + newSection, "utf-8");
      } else {
        // Create new file with header
        const header = `# Hourly Summaries — ${dateStr}\n\n*Session: ${summary.sessionKey}*\n`;
        await writeFile(filePath, header + "\n" + newSection, "utf-8");
      }
      log.debug(`saved hourly summary for ${summary.sessionKey} at ${hourStr}:00`);
    }
    try {
      await upsertSummarySnapshot(this.config.memoryDir, summary);
    } catch (error) {
      log.warn(
        `hourly summarizer: failed to update summary snapshot for ${summary.sessionKey} (fail-open): ${String(error)}`
      );
    }
  }

  private formatHourSection(summary: HourlySummary, hourHeader: string): string {
    const ext = (summary as any)._extended as
      | (HourlySummaryExtendedResult & { _meta?: HourlySummaryExtendedMeta })
      | undefined;
    const meta = (summary as any)._extendedMeta as HourlySummaryExtendedMeta | undefined;
    const lines: string[] = [hourHeader, ""];

    if (resolvePipelineProcessingCapabilities(this.config).hourlySummariesExtended && ext) {
      lines.push("### Topics Discussed");
      for (const t of ext.topics) lines.push(`- ${t}`);
      lines.push("");
      lines.push("### Decisions Made");
      for (const d of ext.decisions) lines.push(`- ${d}`);
      lines.push("");
      lines.push("### Action Items");
      for (const a of ext.actionItems) lines.push(`- ${a}`);
      lines.push("");
      lines.push("### Rejected Ideas / Reversals");
      for (const r of ext.rejected) lines.push(`- ${r}`);
      lines.push("");
      if (meta && Object.keys(meta.toolCounts).length > 0) {
        lines.push("### Tools Used");
        const top = Object.entries(meta.toolCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12);
        for (const [name, count] of top) lines.push(`- ${name}: ${count}`);
        lines.push("");
      }
      lines.push("### Stats");
      lines.push(`- Turns: ${summary.turnCount}`);
      if (meta) {
        lines.push(`- User turns: ${meta.userTurns}`);
        lines.push(`- Assistant turns: ${meta.assistantTurns}`);
        lines.push(`- Tool calls: ${meta.toolCalls}`);
      }
      lines.push("");
      return lines.join("\n");
    }

    for (const bullet of summary.bullets) lines.push(`- ${bullet}`);
    lines.push(`  *(${summary.turnCount} turns)*`);
    lines.push("");
    return lines.join("\n");
  }

  // Read recent summaries for recall injection
  async readRecent(sessionKey: string, hours: number): Promise<HourlySummary[]> {
    try {
      const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

      const snapshot = await readSummarySnapshot(this.config.memoryDir, sessionKey);
      if (snapshot) {
        return snapshot
          .filter((s) => new Date(s.hour).getTime() >= cutoffTime)
          .sort((a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime());
      }

      const summaries: HourlySummary[] = [];
      const encodedDir = await this.summarySessionDir(sessionKey);
      const legacyDir = await this.legacySummarySessionDir(sessionKey);
      const seenDirs = new Set<string>();

      for (const sessionDir of [encodedDir, legacyDir]) {
        if (!sessionDir || seenDirs.has(sessionDir)) continue;
        seenDirs.add(sessionDir);
        const parsed = await this.readSummaryDir(sessionDir, sessionKey);
        summaries.push(...parsed);
      }

      const byHour = new Map<string, HourlySummary>();
      for (const summary of summaries) {
        if (!byHour.has(summary.hour)) byHour.set(summary.hour, summary);
      }

      const sortedSummaries = Array.from(byHour.values()).sort(
        (a, b) => new Date(b.hour).getTime() - new Date(a.hour).getTime()
      );

      // Filter to recent hours while materializing the full parsed history.
      const recent = sortedSummaries.filter((s) => new Date(s.hour).getTime() >= cutoffTime);

      if (sortedSummaries.length > 0) {
        try {
          await writeSummarySnapshot(this.config.memoryDir, sessionKey, sortedSummaries);
        } catch (error) {
          log.warn(
            `hourly summarizer: failed to materialize summary snapshot for ${sessionKey} (fail-open): ${String(error)}`
          );
        }
      }

      return recent;
    } catch {
      // Directory doesn't exist or error reading
      return [];
    }
  }

  private async readSummaryDir(sessionDir: string, sessionKey: string): Promise<HourlySummary[]> {
    let files: string[];
    try {
      files = await readdir(sessionDir);
    } catch {
      return [];
    }

    const summaries: HourlySummary[] = [];
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      const filePath = await resolveSafeStoragePath(sessionDir, file).catch(() => null);
      if (filePath === null) continue;

      try {
        const content = await readFile(filePath, "utf-8");
        summaries.push(...this.parseSummaryFile(content, sessionKey, file));
      } catch {
        // Skip unreadable summary files.
      }
    }

    return summaries;
  }

  private parseSummaryFile(content: string, sessionKey: string, filename: string): HourlySummary[] {
    const summaries: HourlySummary[] = [];

    // Extract date from filename (YYYY-MM-DD.md)
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dateMatch) return summaries;
    const dateStr = dateMatch[1];

    // Split by hour sections
    const hourSections = content.split(/\n## (\d{2}):00\n/);

    // First element is the header, skip it
    for (let i = 1; i < hourSections.length; i += 2) {
      const hourStr = hourSections[i];
      const sectionContent = hourSections[i + 1] || "";

      // Parse bullets
      const bullets: string[] = [];
      const lines = sectionContent.split("\n");
      let turnCount = 0;

      let inTopics = false;
      let sawExtendedTopicsHeader = false;
      for (const line of lines) {
        if (line.startsWith("### Topics")) {
          inTopics = true;
          sawExtendedTopicsHeader = true;
          continue;
        }
        if (line.startsWith("### ") && !line.startsWith("### Topics")) {
          inTopics = false;
        }
        const bulletMatch = line.match(/^- (.+)$/);
        if (bulletMatch) {
          // For extended format, only treat topic bullets as recall bullets.
          if (!sawExtendedTopicsHeader || inTopics) bullets.push(bulletMatch[1]);
        }
        const turnMatch = line.match(/\((\d+) turns?\)/);
        if (turnMatch) turnCount = parseInt(turnMatch[1], 10);
      }

      if (bullets.length > 0) {
        summaries.push({
          hour: `${dateStr}T${hourStr}:00:00.000Z`,
          sessionKey,
          bullets,
          turnCount,
          generatedAt: "", // Not stored in file, not needed for recall
        });
      }
    }

    return summaries;
  }

  // Format summaries for recall injection
  formatForRecall(summaries: HourlySummary[], maxCount: number): string {
    if (summaries.length === 0) return "";

    const limited = summaries.slice(0, maxCount);
    const lines: string[] = [`## Recent Activity (last ${limited.length} hours)`];

    for (const summary of limited) {
      const hourStr = summary.hour.slice(11, 16); // HH:MM
      for (const bullet of summary.bullets) {
        lines.push(`- ${hourStr}: ${bullet}`);
      }
    }

    return lines.join("\n");
  }

  // Main entry point for cron job
  async runHourly(): Promise<HourlySummarizerRunStats> {
    log.debug("running hourly summary generation");

    // Get active sessions from transcript. The scan outcome is kept LOCAL to
    // this invocation (review round 2): shared instance state would let two
    // concurrent runHourly calls cross-report each other's timestamps.
    const scan = await this.getActiveSessions();
    const sessions = scan.sessionKeys;
    let sessionsWithEntries = 0;
    let summariesWritten = 0;

    for (const sessionKey of sessions) {
      // Calculate the hour we want to summarize (previous hour)
      const now = new Date();
      const hourStart = new Date(now.getTime() - 60 * 60 * 1000);
      hourStart.setMinutes(0, 0, 0);
      const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);

      // Get entries for this session in the target hour
      const entries = await this.getTranscriptEntries(sessionKey, hourStart, hourEnd);

      if (entries.length === 0) {
        log.debug(`no transcript entries for ${sessionKey} at ${hourStart.toISOString()}`);
        continue;
      }
      sessionsWithEntries += 1;

      // Generate and save summary
      const summary = await this.generateSummary(sessionKey, hourStart, entries);
      if (summary) {
        await this.saveSummary(summary);
        summariesWritten += 1;
        log.info(`generated hourly summary for ${sessionKey} (${entries.length} turns)`);
      }
    }

    return {
      sessionsConsidered: sessions.length,
      sessionsWithEntries,
      summariesWritten,
      // Staleness signal (issue #2783): newest entry across the whole
      // store, from the same scan getActiveSessions already performs.
      staleStore:
        scan.newestEntryTimestamp !== null &&
        Date.now() - new Date(scan.newestEntryTimestamp).getTime() > STALE_STORE_MS,
      newestEntryTimestamp: scan.newestEntryTimestamp,
      scanFailed: scan.scanFailed,
    };
  }

  // Get list of active sessions from the transcript directory, plus the
  // scan bookkeeping runHourly reports: newest entry timestamp (staleness
  // signal) and whether the scan itself FAILED. A failed scan must not be
  // reported as an empty store — those are different incidents (review
  // round 2).
  private async getActiveSessions(): Promise<{
    sessionKeys: string[];
    newestEntryTimestamp: string | null;
    scanFailed: boolean;
  }> {
    const transcriptDir = await resolveSafeStoragePath(this.config.memoryDir, "transcripts").catch(() => null);
    if (transcriptDir === null) {
      return { sessionKeys: [], newestEntryTimestamp: null, scanFailed: false };
    }

    const sessionKeys = new Set<string>();
    let newestEntryTimestamp: string | null = null;
    let newestEntryTimeMs = Number.NaN;
    let fileReadFailed = false;
    const collect = async (transcriptPath: string): Promise<void> => {
      try {
        const raw = await readFile(transcriptPath, "utf-8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as TranscriptEntry;
            if (typeof entry.sessionKey === "string" && entry.sessionKey.length > 0) {
              sessionKeys.add(entry.sessionKey);
            }
            // Compare parsed epoch values, never strings: a malformed
            // timestamp in a hand-edited file must not poison the staleness
            // signal with a lexically-maximal garbage value (review).
            if (typeof entry.timestamp === "string") {
              const timeMs = new Date(entry.timestamp).getTime();
              if (Number.isFinite(timeMs) && (Number.isNaN(newestEntryTimeMs) || timeMs > newestEntryTimeMs)) {
                newestEntryTimeMs = timeMs;
                newestEntryTimestamp = entry.timestamp;
              }
            }
          } catch {
            // ignore malformed transcript lines
          }
        }
      } catch (err) {
        // ENOENT is a concurrently-deleted file — ignore. Any other read
        // failure (permissions, I/O) means the store is partially UNREADABLE:
        // mark the scan failed so the caller warns instead of reporting an
        // empty store (review round 3).
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          fileReadFailed = true;
        }
      }
    };

    try {
      const typeEntries = await readdir(transcriptDir, { withFileTypes: true });
      for (const typeEnt of typeEntries) {
        if (!typeEnt.isDirectory()) continue;
        const typeDir = await resolveSafeStoragePath(transcriptDir, typeEnt.name).catch(() => null);
        if (typeDir === null) continue;
        const idEntries = await readdir(typeDir, { withFileTypes: true });
        for (const idEnt of idEntries) {
          if (!idEnt.isDirectory()) continue;
          const chanDir = await resolveSafeStoragePath(typeDir, idEnt.name).catch(() => null);
          if (chanDir === null) continue;
          const files = (await readdir(chanDir)).filter((f) => f.endsWith(".jsonl")).sort();
          for (const file of files) {
            const transcriptPath = await resolveSafeStoragePath(chanDir, file).catch(() => null);
            if (transcriptPath === null) continue;
            await collect(transcriptPath);
          }
        }
      }
      return {
        sessionKeys: Array.from(sessionKeys),
        newestEntryTimestamp,
        scanFailed: fileReadFailed,
      };
    } catch (err) {
      // ENOENT on the root is a never-written store — an EMPTY store, not a
      // scan failure (those are different incidents).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return { sessionKeys: [], newestEntryTimestamp: null, scanFailed: false };
      }
      log.warn(`transcript scan failed: ${err}`);
      return { sessionKeys: [], newestEntryTimestamp: null, scanFailed: true };
    }
  }

  // Get transcript entries for a session within a time range
  private async getTranscriptEntries(sessionKey: string, startTime: Date, endTime: Date): Promise<TranscriptEntry[]> {
    // Shared session-identity layer (issue #1496, rule #22). Arbitrary keys
    // route to `session/<hash>`; legacy `agent:<id>:...` keep their paths. The
    // shared helper also supplies the read-back-only candidate dirs (mirrors
    // TranscriptManager) so legacy `other/default` AND old `parts.length >= 3`
    // data stays discoverable here too.
    const paths = sessionStoragePaths(sessionKey);

    try {
      const transcriptRoot = path.join(this.config.memoryDir, "transcripts");
      const candidateDirs = new Set(
        [paths.dir, paths.alternateDir, paths.legacyDir, ...paths.readbackDirs].filter(
          (dir): dir is string => typeof dir === "string" && dir.length > 0
        )
      );
      const entries: TranscriptEntry[] = [];
      // Dedup identical raw rows that a partially-applied migration may have
      // left in both the primary dir and a read-back dir (issue #1496, cursor
      // review). Exact raw JSONL line is the stable identity.
      const seenRawLines = new Set<string>();

      // Read all daily transcript files in the directory
      for (const candidateDir of candidateDirs) {
        const transcriptDir = await resolveSafeStoragePath(transcriptRoot, candidateDir).catch(() => null);
        if (transcriptDir === null) continue;

        const files = await readdir(transcriptDir).catch(() => []);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;

          const transcriptPath = await resolveSafeStoragePath(transcriptDir, file).catch(() => null);
          if (transcriptPath === null) continue;

          try {
            const content = await readFile(transcriptPath, "utf-8");
            const lines = content.trim().split("\n");

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line) as TranscriptEntry;
                const entryTime = new Date(entry.timestamp).getTime();

                if (
                  entry.sessionKey === sessionKey &&
                  entryTime >= startTime.getTime() &&
                  entryTime < endTime.getTime() &&
                  !seenRawLines.has(line)
                ) {
                  seenRawLines.add(line);
                  entries.push(entry);
                }
              } catch {
                // Skip malformed lines
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }

      return entries;
    } catch {
      return [];
    }
  }
}
