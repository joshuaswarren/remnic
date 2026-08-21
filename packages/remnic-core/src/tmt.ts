/**
 * Temporal Memory Tree (TiMem-inspired, v8.2)
 *
 * Builds a hierarchy of summarised memory nodes:
 *   hour-HH.md → day.md → week-YYYY-WW.md → persona.md
 *
 * Stored under `<baseDir>/tmt/`.
 * All writes are fail-open: errors are caught and logged, never thrown.
 */

import * as fs from "fs";
import * as path from "path";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";

export const TMT_DIR = "tmt";

export type TmtLevel = "hour" | "day" | "week" | "persona";

export interface TmtNodeFrontmatter {
  level: TmtLevel;
  periodStart: string; // ISO date-time
  periodEnd: string;   // ISO date-time
  memoryCount: number;
  sourceIds: string[];
  builtAt: string;     // ISO date-time
}

export interface TmtConfig {
  temporalMemoryTreeEnabled: boolean;
  tmtHourlyMinMemories: number;   // default 3
  tmtSummaryMaxTokens: number;    // default 300
}

export interface MemoryEntry {
  path: string;
  id: string;
  created: string; // ISO date-time
  content: string;
}

const TMT_LEVEL_INPUT_LIMITS: Record<TmtLevel, { totalChars: number; itemChars: number; maxItems: number }> = {
  hour: { totalChars: 48_000, itemChars: 2_000, maxItems: 64 },
  day: { totalChars: 64_000, itemChars: 1_800, maxItems: 96 },
  week: { totalChars: 72_000, itemChars: 1_600, maxItems: 120 },
  persona: { totalChars: 80_000, itemChars: 1_600, maxItems: 120 },
};

export function capTmtSummaryInputs(inputs: string[], level: TmtLevel): string[] {
  const { totalChars, itemChars, maxItems } = TMT_LEVEL_INPUT_LIMITS[level];
  if (inputs.length === 0) return [];

  const capped: string[] = [];
  let usedChars = 0;

  for (const raw of inputs) {
    if (capped.length >= maxItems || usedChars >= totalChars) break;
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const next = trimmed.length > itemChars ? `${trimmed.slice(0, itemChars - 1)}…` : trimmed;
    const separator = capped.length === 0 ? 0 : 2;
    if (usedChars + separator + next.length > totalChars) break;
    capped.push(next);
    usedChars += separator + next.length;
  }

  if (capped.length > 0) return capped;
  const fallback = inputs[0]?.trim() ?? "";
  if (!fallback) return [];
  return [fallback.length > itemChars ? `${fallback.slice(0, itemChars - 1)}…` : fallback];
}

// ── Path helpers ────────────────────────────────────────────────────────────

export function tmtDir(baseDir: string): string {
  return path.join(baseDir, TMT_DIR);
}

export function hourNodePath(baseDir: string, date: string, hour: string): string {
  return path.join(tmtDir(baseDir), date, `hour-${hour}.md`);
}

export function dayNodePath(baseDir: string, date: string): string {
  return path.join(tmtDir(baseDir), date, "day.md");
}

export function weekNodePath(baseDir: string, weekKey: string): string {
  return path.join(tmtDir(baseDir), `week-${weekKey}.md`);
}

export function personaNodePath(baseDir: string): string {
  return path.join(tmtDir(baseDir), "persona.md");
}

// ── Frontmatter helpers ─────────────────────────────────────────────────────

export function serialiseTmtNode(fm: TmtNodeFrontmatter, summary: string): string {
  const yaml = [
    "---",
    `level: ${fm.level}`,
    `periodStart: "${fm.periodStart}"`,
    `periodEnd: "${fm.periodEnd}"`,
    `memoryCount: ${fm.memoryCount}`,
    `sourceIds: [${fm.sourceIds.map((id) => `"${id}"`).join(", ")}]`,
    `builtAt: "${fm.builtAt}"`,
    "---",
  ].join("\n");
  return `${yaml}\n\n${summary}\n`;
}

export function parseIsoDate(iso: string): string {
  return parseTmtInstant(iso)?.date ?? "";
}

export function parseIsoHour(iso: string): string {
  return parseTmtInstant(iso)?.hour ?? "";
}

function parseTmtInstant(iso: string): { date: string; hour: string; dateValue: Date } | null {
  if (typeof iso !== "string") return null;
  const value = iso.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return null;
  }
  const dateValue = new Date(value);
  if (!Number.isFinite(dateValue.getTime())) return null;
  const utc = dateValue.toISOString();
  return {
    date: utc.slice(0, 10),
    hour: utc.slice(11, 13),
    dateValue,
  };
}

// Returns ISO week key: YYYY-WW
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, "0")}`;
}

// ── TmtBuilder ──────────────────────────────────────────────────────────────

export type SummarizeFn = (memories: string[], level: TmtLevel) => Promise<string>;

export class TmtBuilder {
  constructor(
    private readonly baseDir: string,
    private readonly cfg: TmtConfig,
  ) {}

  /**
   * Called after each consolidation pass.
   * Groups memories by hour, builds any missing hour nodes,
   * then rolls up to day → week → persona if needed.
   * All errors are caught and logged; never throws.
   */
  async maybeRebuildNodes(
    memories: MemoryEntry[],
    summarize: SummarizeFn,
  ): Promise<void> {
    if (!this.cfg.temporalMemoryTreeEnabled || memories.length === 0) return;
    try {
      await mkdir(tmtDir(this.baseDir), { recursive: true });
      await this.buildHourNodes(memories, summarize);
      await this.buildDayNodes(memories, summarize);
      await this.buildWeekNodes(memories, summarize);
      await this.buildPersonaNode(summarize);
    } catch (err) {
      console.warn(`[engram] tmt: rebuild failed (ignored): ${err}`);
    }
  }

  private async buildHourNodes(memories: MemoryEntry[], summarize: SummarizeFn): Promise<void> {
    // Group by date+hour
    const byHour = new Map<string, MemoryEntry[]>();
    for (const m of memories) {
      const instant = parseTmtInstant(m.created);
      if (!instant) continue;
      const { date, hour } = instant;
      const key = `${date}::${hour}`;
      if (!byHour.has(key)) byHour.set(key, []);
      byHour.get(key)!.push(m);
    }

    for (const [key, entries] of byHour) {
      if (entries.length < this.cfg.tmtHourlyMinMemories) continue;
      const [date, hour] = key.split("::");
      const nodePath = hourNodePath(this.baseDir, date, hour);

      // Rebuild if missing or if more memories arrived for this hour
      let shouldBuild = !fs.existsSync(nodePath);
      if (!shouldBuild) {
        try {
          const existing = await readFile(nodePath, "utf8");
          const countMatch = existing.match(/memoryCount: (\d+)/);
          if (!countMatch || parseInt(countMatch[1], 10) !== entries.length) {
            shouldBuild = true; // active memory set changed — rebuild
          }
        } catch { shouldBuild = true; }
      }
      if (!shouldBuild) continue;

      let summary: string;
      try {
        summary = await summarize(capTmtSummaryInputs(entries.map((e) => e.content), "hour"), "hour");
      } catch (err) {
        console.warn(`[engram] tmt: hour node summarize failed for ${key} (ignored): ${err}`);
        continue;
      }
      const sortedCreated = entries.map((e) => e.created).sort();
      const fm: TmtNodeFrontmatter = {
        level: "hour",
        periodStart: sortedCreated[0],
        periodEnd: sortedCreated[sortedCreated.length - 1],
        memoryCount: entries.length,
        sourceIds: entries.map((e) => e.id),
        builtAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(nodePath), { recursive: true });
      await writeFile(nodePath, serialiseTmtNode(fm, summary), "utf8");
    }
  }

  private async buildDayNodes(memories: MemoryEntry[], summarize: SummarizeFn): Promise<void> {
    // Group by date
    const byDate = new Map<string, MemoryEntry[]>();
    for (const m of memories) {
      const instant = parseTmtInstant(m.created);
      if (!instant) continue;
      const { date } = instant;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(m);
    }

    for (const [date, entries] of byDate) {
      const nodePath = dayNodePath(this.baseDir, date);
      // Rebuild day node if it doesn't exist or if memory count changed
      let shouldBuild = !fs.existsSync(nodePath);
      if (!shouldBuild) {
        try {
          const existing = await readFile(nodePath, "utf8");
          const countMatch = existing.match(/memoryCount: (\d+)/);
          if (!countMatch || parseInt(countMatch[1], 10) !== entries.length) {
            shouldBuild = true; // active memory set changed — rebuild
          }
        } catch { shouldBuild = true; }
      }
      if (!shouldBuild) continue;

      // Per-hour: use hour node summary if available, raw content otherwise
      const inputs: string[] = [];
      const hourToEntries = new Map<string, MemoryEntry[]>();
      for (const e of entries) {
        const h = parseIsoHour(e.created);
        if (!h) continue;
        if (!hourToEntries.has(h)) hourToEntries.set(h, []);
        hourToEntries.get(h)!.push(e);
      }
      for (const [h, hourEntries] of hourToEntries) {
        const hPath = hourNodePath(this.baseDir, date, h);
        if (fs.existsSync(hPath)) {
          try {
            const hContent = await readFile(hPath, "utf8");
            const hSummary = hContent.replace(/^---[\s\S]*?---\n\n?/, "").trim();
            if (hSummary) { inputs.push(hSummary); continue; }
          } catch { /* fall through to raw content */ }
        }
        inputs.push(...hourEntries.map((e) => e.content));
      }
      if (inputs.length === 0) inputs.push(...entries.map((e) => e.content));

      let summary: string;
      try {
        summary = await summarize(capTmtSummaryInputs(inputs, "day"), "day");
      } catch (err) {
        console.warn(`[engram] tmt: day node summarize failed for ${date} (ignored): ${err}`);
        continue;
      }
      const sortedCreated = entries.map((e) => e.created).sort();
      const fm: TmtNodeFrontmatter = {
        level: "day",
        periodStart: sortedCreated[0],
        periodEnd: sortedCreated[sortedCreated.length - 1],
        memoryCount: entries.length,
        sourceIds: entries.map((e) => e.id),
        builtAt: new Date().toISOString(),
      };
      await mkdir(path.dirname(nodePath), { recursive: true });
      await writeFile(nodePath, serialiseTmtNode(fm, summary), "utf8");
    }
  }

  /**
   * Build or update week-level nodes from the day nodes already on disk.
   * Groups memories by ISO week; for each week that has a day node but no
   * (or stale) week node, reads day node summaries and builds a week node.
   * Fail-open: errors per week are caught and skipped.
   */
  private async buildWeekNodes(memories: MemoryEntry[], summarize: SummarizeFn): Promise<void> {
    // Determine which ISO weeks appear in this memory batch
    const weekToEntries = new Map<string, MemoryEntry[]>();
    for (const m of memories) {
      const instant = parseTmtInstant(m.created);
      if (!instant) continue;
      const week = isoWeekKey(instant.dateValue);
      if (!weekToEntries.has(week)) weekToEntries.set(week, []);
      weekToEntries.get(week)!.push(m);
    }

    for (const [week, entries] of weekToEntries) {
      const nodePath = weekNodePath(this.baseDir, week);

      // Rebuild if missing or if memory count grew
      let shouldBuild = !fs.existsSync(nodePath);
      if (!shouldBuild) {
        try {
          const existing = await readFile(nodePath, "utf8");
          const countMatch = existing.match(/memoryCount: (\d+)/);
          if (!countMatch || parseInt(countMatch[1], 10) !== entries.length) {
            shouldBuild = true;
          }
        } catch { shouldBuild = true; }
      }
      if (!shouldBuild) continue;

      try {
        // Collect day-node summaries for days that fall in this week
        const dir = tmtDir(this.baseDir);
        let allDirs: string[] = [];
        try { allDirs = await readdir(dir); } catch { continue; }
        const dateDirs = allDirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

        const daySummaries: string[] = [];
        for (const dateDir of dateDirs) {
          const w = isoWeekKey(new Date(dateDir + "T00:00:00Z"));
          if (w !== week) continue;
          const dayPath = dayNodePath(this.baseDir, dateDir);
          if (fs.existsSync(dayPath)) {
            try {
              const content = await readFile(dayPath, "utf8");
              const summary = content.replace(/^---[\s\S]*?---\n\n?/, "").trim();
              if (summary) daySummaries.push(summary);
            } catch { /* skip */ }
          }
        }

        // Fall back to raw memory content if no day summaries available
        const inputs = daySummaries.length > 0 ? daySummaries : entries.map((e) => e.content);
        const summary = await summarize(capTmtSummaryInputs(inputs, "week"), "week");
        const sortedCreated = entries.map((e) => e.created).sort();
        const fm: TmtNodeFrontmatter = {
          level: "week",
          periodStart: sortedCreated[0],
          periodEnd: sortedCreated[sortedCreated.length - 1],
          memoryCount: entries.length,
          sourceIds: entries.map((e) => e.id),
          builtAt: new Date().toISOString(),
        };
        await mkdir(path.dirname(nodePath), { recursive: true });
        await writeFile(nodePath, serialiseTmtNode(fm, summary), "utf8");
      } catch (err) {
        console.warn(`[engram] tmt: week node build failed for ${week} (ignored): ${err}`);
      }
    }
  }

  /**
   * Build or update the persona node from the most recent week-level summaries.
   * Reads up to 4 recent week nodes and synthesizes a persona-level narrative.
   * Fail-open: skips silently if no week nodes exist or summarize fails.
   */
  private async buildPersonaNode(summarize: SummarizeFn): Promise<void> {
    try {
      const dir = tmtDir(this.baseDir);
      let allFiles: string[] = [];
      try { allFiles = await readdir(dir); } catch { return; }

      const weekFiles = allFiles
        .filter((f) => /^week-\d{4}-\d{2}\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, 4); // Use at most 4 recent weeks

      if (weekFiles.length === 0) return;

      const weekSummaries: string[] = [];
      let totalCount = 0;
      let earliestStart: string | undefined;
      let latestEnd: string | undefined;
      for (const f of weekFiles) {
        try {
          const content = await readFile(path.join(dir, f), "utf8");
          const summary = content.replace(/^---[\s\S]*?---\n\n?/, "").trim();
          if (summary) weekSummaries.push(summary);
          const countMatch = content.match(/memoryCount: (\d+)/);
          if (countMatch) totalCount += parseInt(countMatch[1], 10);
          const startMatch = content.match(/periodStart: "([^"]+)"/);
          const endMatch = content.match(/periodEnd: "([^"]+)"/);
          if (startMatch) {
            if (!earliestStart || startMatch[1] < earliestStart) earliestStart = startMatch[1];
          }
          if (endMatch) {
            if (!latestEnd || endMatch[1] > latestEnd) latestEnd = endMatch[1];
          }
        } catch { /* skip */ }
      }

      if (weekSummaries.length === 0) return;

      const nodePath = personaNodePath(this.baseDir);

      // Skip rebuild if persona node already reflects current week data
      let shouldBuild = !fs.existsSync(nodePath);
      if (!shouldBuild) {
        try {
          const existing = await readFile(nodePath, "utf8");
          const countMatch = existing.match(/memoryCount: (\d+)/);
          if (!countMatch || parseInt(countMatch[1], 10) !== totalCount) {
            shouldBuild = true;
          }
        } catch { shouldBuild = true; }
      }
      if (!shouldBuild) return;

      const summary = await summarize(capTmtSummaryInputs(weekSummaries, "persona"), "persona");

      const now = new Date().toISOString();
      const fm: TmtNodeFrontmatter = {
        level: "persona",
        periodStart: earliestStart ?? now,
        periodEnd: latestEnd ?? now,
        memoryCount: totalCount,
        sourceIds: [],
        builtAt: now,
      };
      await writeFile(nodePath, serialiseTmtNode(fm, summary), "utf8");
    } catch (err) {
      console.warn(`[engram] tmt: persona node build failed (ignored): ${err}`);
    }
  }

  /**
   * Return the summary text of the most relevant TMT node for a given prompt.
   * Preference: day node for today > most recent day node.
   * Returns null if no nodes exist or feature is disabled.
   */
  async getMostRelevantNode(): Promise<{ level: TmtLevel; summary: string } | null> {
    if (!this.cfg.temporalMemoryTreeEnabled) return null;
    try {
      const dir = tmtDir(this.baseDir);
      if (!fs.existsSync(dir)) return null;

      // Try today's day node first
      const today = new Date().toISOString().slice(0, 10);
      const todayDay = dayNodePath(this.baseDir, today);
      if (fs.existsSync(todayDay)) {
        const content = await readFile(todayDay, "utf8");
        const summary = content.replace(/^---[\s\S]*?---\n\n?/, "").trim();
        if (summary) return { level: "day", summary };
      }

      // Find most recent date directory
      let entries: string[] = [];
      try { entries = await readdir(dir); } catch { return null; }
      const dateDirs = entries.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort().reverse();

      for (const dateDir of dateDirs) {
        const dayPath = dayNodePath(this.baseDir, dateDir);
        if (fs.existsSync(dayPath)) {
          const content = await readFile(dayPath, "utf8");
          const summary = content.replace(/^---[\s\S]*?---\n\n?/, "").trim();
          if (summary) return { level: "day", summary };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}
