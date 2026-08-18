import { readFileSync } from "node:fs";
import path from "node:path";

import { activityDigestPath, isValidActivityDate } from "../activity/digest.js";

export interface StandupBrief {
  date: string;
  yesterday: string;
  today: string;
  highlights: string[];
  blockers: string[];
  activityGrid: string;
  markdown: string;
}

export function parseStandupDate(raw: unknown, now = new Date()): string {
  if (raw === undefined || raw === null || raw === "") {
    return now.toISOString().slice(0, 10);
  }
  const value = String(raw);
  if (!isValidActivityDate(value)) {
    throw new Error(`invalid --date ${value}; expected YYYY-MM-DD`);
  }
  return value;
}

export function previousDate(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

export function buildStandup(memoryDir: string, date: string): StandupBrief {
  const yesterday = previousDate(date);
  const todayBody = readOptional(activityDigestPath(memoryDir, date));
  const yesterdayBody = readOptional(activityDigestPath(memoryDir, yesterday));
  const highlights = extractHighlights(todayBody);
  const blockers = extractBlockers(todayBody);
  const activityGrid = renderGrid(yesterdayBody, todayBody);
  const markdown = [
    `# Standup ${date}`,
    "",
    `## Yesterday (${yesterday})`,
    yesterdayBody ? firstLines(yesterdayBody, 8) : "_No activity digest._",
    "",
    `## Today (${date})`,
    todayBody ? firstLines(todayBody, 8) : "_No activity digest._",
    "",
    "## Highlights",
    ...(highlights.length > 0 ? highlights.map((line) => `- ${line}`) : ["- _None._"]),
    "",
    "## Blockers",
    ...(blockers.length > 0 ? blockers.map((line) => `- ${line}`) : ["- _None._"]),
    "",
    "## Activity grid",
    "",
    activityGrid,
    "",
  ].join("\n");
  return {
    date,
    yesterday,
    today: date,
    highlights,
    blockers,
    activityGrid,
    markdown,
  };
}

function readOptional(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function firstLines(body: string, n: number): string {
  return body.split("\n").filter((line) => !line.startsWith("---")).slice(0, n).join("\n").trim() || "_Empty digest._";
}

function extractHighlights(body: string | null): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---"))
    .slice(0, 5);
}

function extractBlockers(body: string | null): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /blocker|blocked|stuck|waiting/i.test(line))
    .slice(0, 5);
}

function renderGrid(yesterday: string | null, today: string | null): string {
  const y = yesterday ? "x" : ".";
  const t = today ? "x" : ".";
  return ["| day | digest |", "|---|---|", `| yesterday | ${y} |`, `| today | ${t} |`].join("\n");
}

export function standupHelp(): string {
  return `Usage: remnic standup [--date YYYY-MM-DD]

Deterministic yesterday/today/blockers brief plus an activity grid.
`;
}

export function standupMemoryDirPlaceholder(memoryDir: string): string {
  return path.resolve(memoryDir);
}
