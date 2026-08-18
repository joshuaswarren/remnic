import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { EngramAccessInputError } from "../access-errors.js";
import { activityDigestPath, isValidActivityDate } from "../activity/digest.js";
import { parseFrontmatter } from "../storage.js";

export interface StandupBrief {
  date: string;
  yesterday: string;
  today: string;
  highlights: string[];
  priorities: string[];
  blockers: string[];
  activityGrid: string;
  markdown: string;
}

export function parseStandupDate(raw: unknown, now = new Date()): string {
  if (raw === undefined || raw === null) {
    return now.toISOString().slice(0, 10);
  }
  const value = String(raw);
  if (!isValidActivityDate(value)) {
    // Typed so the HTTP surface maps it to 400 (EngramAccessInputError);
    // subclasses Error, so the CLI still prints the message verbatim.
    throw new EngramAccessInputError(`invalid --date ${value}; expected YYYY-MM-DD`);
  }
  return value;
}

/** Look back at most this many days for the prior active day (issue #1981). */
const STANDUP_PRIOR_DAY_LOOKBACK = 7;

function shiftDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Prior active day: the most recent of the 7 days before `date` that has an
 * activity digest (working-day lookback — Monday resolves to Friday, not
 * Sunday, when the weekend has no digests). Calendar-previous day when no
 * day in the window qualifies.
 */
export function previousActiveDate(memoryDir: string, date: string): string {
  for (let back = 1; back <= STANDUP_PRIOR_DAY_LOOKBACK; back += 1) {
    const candidate = shiftDays(date, -back);
    if (readOptional(activityDigestPath(memoryDir, candidate)) !== null) return candidate;
  }
  return shiftDays(date, -1);
}

export function buildStandup(memoryDir: string, date: string): StandupBrief {
  const yesterday = previousActiveDate(memoryDir, date);
  const todayBody = readOptional(activityDigestPath(memoryDir, date));
  const yesterdayBody = readOptional(activityDigestPath(memoryDir, yesterday));
  const highlights = extractHighlights(yesterdayBody);
  const commitments = sortCommitments(readOpenCommitments(memoryDir));
  const dateMs = Date.parse(`${date}T00:00:00Z`);
  const overdue = commitments.filter(
    (c) => c.expiresAt !== undefined && Number.isFinite(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) < dateMs,
  );
  const open = commitments.filter((c) => !overdue.includes(c));
  const priorities = open.map((c) => (c.expiresAt ? `${c.text} (due ${c.expiresAt.slice(0, 10)})` : c.text));
  const blockers = [
    ...extractBlockers(yesterdayBody),
    ...overdue.map((c) => `commitment past due: ${c.text} (was due ${c.expiresAt?.slice(0, 10)})`),
  ];
  const activityGrid = renderGrid(yesterday, yesterdayBody);
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
    "## Today's priorities",
    ...(priorities.length > 0 ? priorities.map((line) => `- ${line}`) : ["- (no tracked commitments — add priorities manually)"]),
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
    priorities,
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

/** Drop a leading `--- … ---` frontmatter block so its fields never render. */
function stripFrontmatter(body: string): string {
  const lines = body.split("\n");
  if (lines[0]?.trim() !== "---") return body;
  const end = lines.indexOf("---", 1);
  return end < 0 ? body : lines.slice(end + 1).join("\n");
}

function firstLines(body: string, n: number): string {
  return (
    stripFrontmatter(body)
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("#") && !line.startsWith("---"))
      .slice(0, n)
      .join("\n")
      .trim() || "_Empty digest._"
  );
}

function extractHighlights(body: string | null): string[] {
  if (!body) return [];
  return stripFrontmatter(body)
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---"))
    .slice(0, 5);
}

function extractBlockers(body: string | null): string[] {
  if (!body) return [];
  return stripFrontmatter(body)
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0 && /blocker|blocked|stuck|waiting/i.test(line))
    .slice(0, 5);
}

// ── Activity grid (24 hour buckets, byte-stable) ────────────────────────────

const GRID_GLYPHS = ["░", "▁", "▂", "▃", "▄", "█"] as const;

/** Local hour of a digest timeline span line `- [HH:MM] app — window`, or null. */
function spanHour(line: string): number | null {
  if (!line.startsWith("- [")) return null;
  const close = line.indexOf("]", 3);
  if (close < 0) return null;
  const clock = line.slice(3, close);
  const sep = clock.indexOf(":");
  if (sep <= 0) return null;
  const hour = Number.parseInt(clock.slice(0, sep), 10);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function renderGrid(yesterday: string, body: string | null): string {
  if (!body) return `prior day ${yesterday}: no activity digest (empty)`;
  const counts: number[] = new Array(24).fill(0);
  for (const line of stripFrontmatter(body).split("\n")) {
    const hour = spanHour(line);
    if (hour !== null) counts[hour] = counts[hour]! + 1;
  }
  const max = Math.max(...counts);
  if (max === 0) return `prior day ${yesterday}: digest present, no timeline activity`;
  const glyphs = counts
    .map((count) =>
      count === 0 ? "·" : GRID_GLYPHS[Math.min(GRID_GLYPHS.length - 1, Math.ceil((count / max) * GRID_GLYPHS.length) - 1)],
    )
    .join("");
  const nonEmpty = counts.map((count, hour) => (count > 0 ? `${hour}` : null)).filter((h): h is string => h !== null);
  return [`prior day ${yesterday} — 24 hour buckets (· = idle):`, glyphs, `non-empty hours: ${nonEmpty.join(", ")}`].join(
    "\n",
  );
}

// ── Open commitments (deterministic facts scan) ─────────────────────────────

interface OpenCommitment {
  id: string;
  text: string;
  created: string;
  expiresAt?: string;
}

function readOpenCommitments(memoryDir: string): OpenCommitment[] {
  const factsDir = path.join(memoryDir, "facts");
  let dayDirs: string[];
  try {
    dayDirs = readdirSync(factsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isValidActivityDate(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const out: OpenCommitment[] = [];
  for (const day of dayDirs) {
    let files: string[];
    try {
      files = readdirSync(path.join(factsDir, day), { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of files) {
      const parsed = parseFrontmatter(readOptional(path.join(factsDir, day, name)) ?? "");
      if (!parsed) continue;
      const fm = parsed.frontmatter;
      if (fm.category !== "commitment") continue;
      if ((fm.status ?? "active") !== "active") continue;
      if (fm.tags.some((tag) => tag === "fulfilled" || tag === "expired")) continue;
      const text = parsed.content
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (!text) continue;
      out.push({
        id: fm.id,
        text,
        created: fm.created,
        ...(fm.expiresAt !== undefined ? { expiresAt: fm.expiresAt } : {}),
      });
    }
  }
  return out;
}

function sortCommitments(list: OpenCommitment[]): OpenCommitment[] {
  return [...list].sort((a, b) => {
    // Due-ness first: a commitment with a concrete expiry outranks an
    // undated one; earlier expiry is more due. Created, then id, as the
    // stable tiebreak (§12).
    const aDated = a.expiresAt !== undefined ? 0 : 1;
    const bDated = b.expiresAt !== undefined ? 0 : 1;
    if (aDated !== bDated) return aDated - bDated;
    const ka = a.expiresAt ?? a.created;
    const kb = b.expiresAt ?? b.created;
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

export function standupHelp(): string {
  return `Usage: remnic standup [--date YYYY-MM-DD]

Deterministic yesterday/today/blockers brief: prior-working-day highlights,
today's priorities from open commitments, blocker candidates, and a 24-hour
activity grid.
`;
}
