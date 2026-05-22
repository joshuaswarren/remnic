import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, appendFile, writeFile, stat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { log } from "../logger.js";
import type { PluginConfig } from "../types.js";
import { expandTildePath } from "../utils/path.js";

export const SharedFeedbackEntrySchema = z.object({
  agent: z.string().min(1),
  decision: z.enum(["approved", "approved_with_feedback", "rejected"]),
  reason: z.string().min(1),
  date: z.string().min(8), // ISO-ish; keep loose
  learning: z.string().optional(),
  outcome: z.string().optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  workflow: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  evidenceWindowStart: z.string().min(8).optional(),
  evidenceWindowEnd: z.string().min(8).optional(),
  refs: z.array(z.string()).optional(),
});

export type SharedFeedbackEntry = z.infer<typeof SharedFeedbackEntrySchema>;

function safeSlug(s: string): string {
  let slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Trim leading/trailing dashes without ReDoS-prone anchored quantifiers
  let start = 0;
  while (start < slug.length && slug[start] === "-") start++;
  let end = slug.length;
  while (end > start && slug[end - 1] === "-") end--;
  return slug.slice(start, end).slice(0, 80) || "output";
}

function safePathSegment(s: string, label: string): string {
  if (s.length === 0) throw new Error(`${label} must not be empty`);
  if (/[\r\n]/.test(s)) throw new Error(`${label} must not contain line breaks`);
  const encoded = encodeURIComponent(s);
  if (encoded === "." || encoded === "..") {
    return encoded.replace(/\./g, "%2E");
  }
  return encoded;
}

function safeDecodePathSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizeFrontmatterScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the legacy partial unescape below.
    }
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function formatFrontmatterScalar(value: string): string {
  return JSON.stringify(value);
}

function readFrontmatterScalar(raw: string, key: string): string | null {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return null;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.startsWith(`${key}:`)) continue;
    const value = line.slice(key.length + 1).trim();
    return value ? normalizeFrontmatterScalar(value) : null;
  }
  return null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function safeDateSegment(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid shared-context date: ${JSON.stringify(date)}; expected YYYY-MM-DD`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Invalid shared-context date: ${JSON.stringify(date)}; expected a real calendar date`);
  }
  return date;
}

const CROSS_SIGNAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
  "agent",
  "output",
  "today",
  "daily",
  "notes",
  "note",
  "summary",
]);

function extractTopicTokens(text: string, maxTokens: number = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4)
    .filter((token) => !CROSS_SIGNAL_STOPWORDS.has(token));

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxTokens) break;
  }
  return out;
}

function stripYamlFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const closing = text.indexOf("\n---\n", 4);
  if (closing === -1) return text;
  return text.slice(closing + 5);
}

function semanticRoot(token: string): string {
  let root = token.toLowerCase();
  if (root.endsWith("izations") && root.length > 9) {
    root = `${root.slice(0, -8)}ize`;
  }
  else if (root.endsWith("ization") && root.length > 8) {
    root = `${root.slice(0, -7)}ize`;
  } else if (root.endsWith("isations") && root.length > 9) {
    root = `${root.slice(0, -8)}ise`;
  } else if (root.endsWith("isation") && root.length > 8) {
    root = `${root.slice(0, -7)}ise`;
  } else {
    const suffixes = [
      "ations",
      "ation",
      "ments",
      "ment",
      "ingly",
      "edly",
      "ings",
      "ing",
      "ers",
      "er",
      "ies",
      "ied",
      "ions",
      "ion",
      "es",
      "ed",
      "s",
    ];
    for (const suffix of suffixes) {
      if (root.length > suffix.length + 3 && root.endsWith(suffix)) {
        root = root.slice(0, -suffix.length);
        break;
      }
    }
  }
  if (root.length > 4 && root.endsWith("e")) {
    root = root.slice(0, -1);
  }
  return root;
}

function mergeOverlaps(
  base: SharedCrossSignalOverlap[],
  extra: SharedCrossSignalOverlap[],
): SharedCrossSignalOverlap[] {
  const merged = new Map<string, { agents: Set<string>; sourcePaths: Set<string> }>();
  for (const entry of [...base, ...extra]) {
    const existing = merged.get(entry.token);
    if (existing) {
      for (const agent of entry.agents) existing.agents.add(agent);
      for (const sourcePath of entry.sourcePaths) existing.sourcePaths.add(sourcePath);
    } else {
      merged.set(entry.token, {
        agents: new Set(entry.agents),
        sourcePaths: new Set(entry.sourcePaths),
      });
    }
  }
  return [...merged.entries()]
    .map(([token, value]) => ({
      token,
      agents: [...value.agents].sort(),
      sourcePaths: [...value.sourcePaths].sort(),
      agentCount: value.agents.size,
    }))
    .filter((entry) => entry.agentCount >= 2)
    .sort((a, b) => b.agentCount - a.agentCount || a.token.localeCompare(b.token));
}

async function computeSemanticOverlapCandidates(
  sources: SharedCrossSignalSource[],
  maxCandidates: number,
  timeoutAtMs: number,
): Promise<{ overlaps: SharedCrossSignalOverlap[]; candidateCount: number; timedOut: boolean }> {
  const tokenRows: Array<{ token: string; agent: string; path: string }> = [];
  for (const source of sources) {
    for (const token of source.topics) {
      if (Date.now() >= timeoutAtMs) return { overlaps: [], candidateCount: tokenRows.length, timedOut: true };
      await new Promise<void>((resolve) => setImmediate(resolve));
      tokenRows.push({ token, agent: source.agent, path: source.path });
      if (tokenRows.length >= maxCandidates) break;
    }
    if (tokenRows.length >= maxCandidates) break;
  }

  const byRoot = new Map<string, Map<string, { agents: Set<string>; paths: Set<string> }>>();
  for (const row of tokenRows) {
    if (Date.now() >= timeoutAtMs) return { overlaps: [], candidateCount: tokenRows.length, timedOut: true };
    await new Promise<void>((resolve) => setImmediate(resolve));
    const root = semanticRoot(row.token);
    if (root.length < 4) continue;
    const rootGroup = byRoot.get(root) ?? new Map<string, { agents: Set<string>; paths: Set<string> }>();
    const tokenGroup = rootGroup.get(row.token) ?? { agents: new Set<string>(), paths: new Set<string>() };
    tokenGroup.agents.add(row.agent);
    tokenGroup.paths.add(row.path);
    rootGroup.set(row.token, tokenGroup);
    byRoot.set(root, rootGroup);
  }

  const overlaps: SharedCrossSignalOverlap[] = [];
  for (const [root, tokenMap] of byRoot.entries()) {
    if (Date.now() >= timeoutAtMs) return { overlaps: [], candidateCount: tokenRows.length, timedOut: true };
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (tokenMap.size < 2) continue;
    const agents = new Set<string>();
    const sourcePaths = new Set<string>();
    for (const value of tokenMap.values()) {
      for (const agent of value.agents) agents.add(agent);
      for (const sourcePath of value.paths) sourcePaths.add(sourcePath);
    }
    if (agents.size < 2) continue;
    overlaps.push({
      token: `semantic:${root}`,
      agents: [...agents].sort(),
      sourcePaths: [...sourcePaths].sort(),
      agentCount: agents.size,
    });
  }

  overlaps.sort((a, b) => b.agentCount - a.agentCount || a.token.localeCompare(b.token));
  return {
    overlaps,
    candidateCount: tokenRows.length,
    timedOut: false,
  };
}

async function computeSemanticOverlapsWithTimeout(
  sources: SharedCrossSignalSource[],
  timeoutMs: number,
  maxCandidates: number,
): Promise<{ overlaps: SharedCrossSignalOverlap[]; candidateCount: number; timedOut: boolean }> {
  const safeTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const safeMaxCandidates = Math.max(0, Math.floor(maxCandidates));
  if (safeMaxCandidates === 0 || sources.length === 0) {
    return { overlaps: [], candidateCount: 0, timedOut: false };
  }
  const timeoutAtMs = Date.now() + safeTimeoutMs;
  return computeSemanticOverlapCandidates(sources, safeMaxCandidates, timeoutAtMs);
}

interface SharedCrossSignalSource {
  agent: string;
  path: string;
  title: string;
  topics: string[];
}

interface SharedCrossSignalOverlap {
  token: string;
  agents: string[];
  sourcePaths: string[];
  agentCount: number;
}

interface SharedCrossSignalReport {
  date: string;
  generatedAt: string;
  sourceCount: number;
  feedbackCount: number;
  feedbackByDecision: Record<"approved" | "approved_with_feedback" | "rejected", number>;
  feedbackEntries: SharedFeedbackEntry[];
  sources: SharedCrossSignalSource[];
  overlaps: SharedCrossSignalOverlap[];
  semantic: {
    enabled: boolean;
    applied: boolean;
    timedOut: boolean;
    candidateCount: number;
    maxCandidates: number;
    addedOverlapCount: number;
  };
}

export interface SharedCrossSignalSynthesisResult {
  date: string;
  crossSignalsPath: string;
  crossSignalsMarkdownPath: string;
  overlapCount: number;
  report: SharedCrossSignalReport;
}

export interface SharedDailyCurationResult {
  date: string;
  roundtablePath: string;
  crossSignalsPath: string;
  crossSignalsMarkdownPath: string;
  overlapCount: number;
}

function feedbackDecisionPriority(decision: SharedFeedbackEntry["decision"]): number {
  switch (decision) {
    case "rejected":
      return 3;
    case "approved_with_feedback":
      return 2;
    case "approved":
      return 1;
  }
}

function feedbackSeverityPriority(severity: SharedFeedbackEntry["severity"]): number {
  switch (severity) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function compareFeedbackPriority(a: SharedFeedbackEntry, b: SharedFeedbackEntry): number {
  return (
    feedbackDecisionPriority(b.decision) - feedbackDecisionPriority(a.decision)
    || feedbackSeverityPriority(b.severity) - feedbackSeverityPriority(a.severity)
    || a.date.localeCompare(b.date)
  );
}

function markdownLineText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function markdownLineList(values: readonly string[]): string {
  return values.map(markdownLineText).filter(Boolean).join(", ");
}

function formatFeedbackLine(entry: SharedFeedbackEntry): string {
  const extras: string[] = [`feedback: ${markdownLineText(entry.date)}`];
  if (entry.severity) extras.push(`severity: ${markdownLineText(entry.severity)}`);
  if (entry.refs?.length) extras.push(`refs: ${markdownLineList(entry.refs)}`);
  return `- [${markdownLineText(entry.agent)}] ${entry.decision}: ${markdownLineText(entry.reason)} [${extras.join("; ")}]`;
}

function formatOverlapLine(entry: SharedCrossSignalOverlap): string {
  return `- \`${entry.token}\` (${entry.agentCount} agents: ${markdownLineList(entry.agents)}) [sources: ${markdownLineList(entry.sourcePaths)}]`;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx" });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolveSharedContextDir(config: PluginConfig): string {
  return typeof config.sharedContextDir === "string" && config.sharedContextDir.length > 0
    ? expandTildePath(config.sharedContextDir)
    : path.join(expandTildePath(config.workspaceDir), "shared-context");
}

export class SharedContextManager {
  readonly dir: string;
  private readonly prioritiesPath: string;
  private readonly prioritiesInboxPath: string;
  private readonly outputsDir: string;
  private readonly roundtableDir: string;
  private readonly feedbackDir: string;
  private readonly feedbackInboxPath: string;
  private readonly crossSignalsDir: string;
  private readonly dailySynthesisChains = new Map<string, Promise<void>>();

  constructor(private readonly config: PluginConfig) {
    const base = resolveSharedContextDir(config);

    this.dir = base;
    this.prioritiesPath = path.join(base, "priorities.md");
    this.prioritiesInboxPath = path.join(base, "priorities.inbox.md");
    this.outputsDir = path.join(base, "agent-outputs");
    this.roundtableDir = path.join(base, "roundtable");
    this.feedbackDir = path.join(base, "feedback");
    this.feedbackInboxPath = path.join(this.feedbackDir, "inbox.jsonl");
    this.crossSignalsDir = path.join(base, "cross-signals");
  }

  async ensureStructure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.outputsDir, { recursive: true });
    await mkdir(this.roundtableDir, { recursive: true });
    await mkdir(this.feedbackDir, { recursive: true });
    await mkdir(this.crossSignalsDir, { recursive: true });
    await mkdir(path.join(this.dir, "staging"), { recursive: true });
    await mkdir(path.join(this.dir, "kpis"), { recursive: true });
    await mkdir(path.join(this.dir, "calendar"), { recursive: true });
    await mkdir(path.join(this.dir, "content-calendar"), { recursive: true });

    // Bootstrap files if missing.
    await this.ensureFile(
      this.prioritiesPath,
      [
        "# Priorities",
        "",
        "This is the shared priority stack. Agents should read this before acting.",
        "",
        "## Current",
        "- (empty)",
        "",
        "## Notes",
        "- (empty)",
        "",
      ].join("\n"),
    );
    await this.ensureFile(
      this.prioritiesInboxPath,
      [
        "# Priorities Inbox",
        "",
        "Append-only inbox. Curator merges into priorities.md.",
        "",
      ].join("\n"),
    );
    await this.ensureFile(this.feedbackInboxPath, "");
  }

  private async ensureFile(fp: string, content: string): Promise<void> {
    try {
      await stat(fp);
    } catch {
      await writeFile(fp, content, "utf-8");
    }
  }

  async readPriorities(): Promise<string> {
    try {
      return await readFile(this.prioritiesPath, "utf-8");
    } catch {
      return "";
    }
  }

  async readLatestRoundtable(): Promise<string> {
    try {
      const files = (await readdir(this.roundtableDir))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      const fp = files[0] ? path.join(this.roundtableDir, files[0]) : null;
      if (!fp) return "";
      return await readFile(fp, "utf-8");
    } catch {
      return "";
    }
  }

  async readLatestCrossSignals(): Promise<string> {
    try {
      const files = (await readdir(this.crossSignalsDir))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      const fp = files[0] ? path.join(this.crossSignalsDir, files[0]) : null;
      if (!fp) return "";
      return await readFile(fp, "utf-8");
    } catch {
      return "";
    }
  }

  async writeAgentOutput(opts: {
    agentId: string;
    title: string;
    content: string;
    createdAt?: Date;
  }): Promise<string> {
    const createdAt = opts.createdAt ?? new Date();
    const date = ymd(createdAt);
    const time = createdAt.toISOString().slice(11, 19).replace(/:/g, "");
    const slug = safeSlug(opts.title);
    const agentPathSegment = safePathSegment(opts.agentId, "agentId");

    const dir = path.join(this.outputsDir, agentPathSegment, date);
    await mkdir(dir, { recursive: true });

    const body =
      `---\n` +
      `kind: agent_output\n` +
      `agent: ${formatFrontmatterScalar(opts.agentId)}\n` +
      `createdAt: ${createdAt.toISOString()}\n` +
      `title: ${formatFrontmatterScalar(opts.title.replace(/\n/g, " ").slice(0, 200))}\n` +
      `---\n\n` +
      opts.content.trimEnd() +
      "\n";

    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      const fp = path.join(dir, `${time}-${slug}${suffix}.md`);
      try {
        await writeFile(fp, body, { encoding: "utf-8", flag: "wx" });
        return fp;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
    }

    throw new Error(`Unable to allocate unique shared-context output path for ${opts.agentId}`);
  }

  async appendFeedback(entry: SharedFeedbackEntry): Promise<void> {
    const parsed = SharedFeedbackEntrySchema.parse(entry);
    await appendFile(this.feedbackInboxPath, JSON.stringify(parsed) + "\n", "utf-8");
  }

  async appendPrioritiesInbox(opts: { agentId: string; text: string }): Promise<void> {
    const stamp = new Date().toISOString();
    const lines = [
      "",
      `## ${stamp} (${opts.agentId})`,
      "",
      opts.text.trimEnd(),
      "",
    ].join("\n");
    await appendFile(this.prioritiesInboxPath, lines, "utf-8");
  }

  private async withDailySynthesisLock<T>(date: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.dailySynthesisChains.get(date) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.dailySynthesisChains.set(date, queued);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.dailySynthesisChains.get(date) === queued) {
        this.dailySynthesisChains.delete(date);
      }
    }
  }

  async synthesizeCrossSignals(opts: {
    date?: string;
    maxSummaryItems?: number;
  }): Promise<SharedCrossSignalSynthesisResult> {
    const date = safeDateSegment(opts.date ?? ymd(new Date()));
    return this.withDailySynthesisLock(date, () => this.synthesizeCrossSignalsUnlocked({
      date,
      maxSummaryItems: opts.maxSummaryItems,
    }));
  }

  private async synthesizeCrossSignalsUnlocked(opts: {
    date: string;
    maxSummaryItems?: number;
  }): Promise<SharedCrossSignalSynthesisResult> {
    const date = opts.date;
    const maxSummaryItems = Math.max(1, opts.maxSummaryItems ?? 8);

    // Collect outputs for the day (best-effort).
    const outputs: Array<{ agent: string; path: string; title: string; raw: string }> = [];
    try {
      const agents = (await readdir(this.outputsDir, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const a of agents) {
        if (!a.isDirectory()) continue;
        const dayDir = path.join(this.outputsDir, a.name, date);
        try {
          const files = (await readdir(dayDir)).filter((f) => f.endsWith(".md")).sort();
          for (const f of files) {
            const p = path.join(dayDir, f);
            const raw = await readFile(p, "utf-8");
            const title = readFrontmatterScalar(raw, "title") ?? f;
            const agent = readFrontmatterScalar(raw, "agent") ?? safeDecodePathSegment(a.name);
            outputs.push({ agent, path: p, title, raw });
          }
        } catch {
          // no outputs for this agent/date
        }
      }
    } catch {
      // ignore
    }
    outputs.sort(
      (a, b) =>
        a.agent.localeCompare(b.agent)
        || a.path.localeCompare(b.path)
        || a.title.localeCompare(b.title),
    );

    // Collect feedback entries for the day.
    const feedback: SharedFeedbackEntry[] = [];
    try {
      const raw = await readFile(this.feedbackInboxPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const parsed = SharedFeedbackEntrySchema.safeParse(obj);
          if (!parsed.success) continue;
          if (String(parsed.data.date).startsWith(date)) feedback.push(parsed.data);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    const sources: SharedCrossSignalSource[] = outputs.map((output) => {
      const body = stripYamlFrontmatter(output.raw);
      return {
        agent: output.agent,
        path: output.path,
        title: output.title,
        topics: extractTopicTokens(`${output.title}\n${body}`),
      };
    });

    const overlapMap = new Map<string, { agents: Set<string>; sourcePaths: Set<string> }>();
    for (const source of sources) {
      for (const token of source.topics) {
        const existing = overlapMap.get(token);
        if (existing) {
          existing.agents.add(source.agent);
          existing.sourcePaths.add(source.path);
        } else {
          overlapMap.set(token, {
            agents: new Set([source.agent]),
            sourcePaths: new Set([source.path]),
          });
        }
      }
    }

    const overlaps: SharedCrossSignalOverlap[] = [...overlapMap.entries()]
      .map(([token, v]) => ({
        token,
        agents: [...v.agents].sort(),
        sourcePaths: [...v.sourcePaths].sort(),
        agentCount: v.agents.size,
      }))
      .filter((entry) => entry.agentCount >= 2)
      .sort((a, b) => b.agentCount - a.agentCount || a.token.localeCompare(b.token));

    const semanticEnabled =
      this.config.sharedCrossSignalSemanticEnabled === true
      || this.config.crossSignalsSemanticEnabled === true;
    const semanticTimeoutMs =
      this.config.sharedCrossSignalSemanticTimeoutMs
      ?? this.config.crossSignalsSemanticTimeoutMs
      ?? 4000;
    const semanticMaxCandidates = this.config.sharedCrossSignalSemanticMaxCandidates ?? 120;
    let semanticApplied = false;
    let semanticTimedOut = false;
    let semanticCandidateCount = 0;
    let semanticAddedOverlapCount = 0;
    let mergedOverlaps = overlaps;
    if (semanticEnabled) {
      try {
        const semanticResult = await computeSemanticOverlapsWithTimeout(
          sources,
          semanticTimeoutMs,
          semanticMaxCandidates,
        );
        semanticTimedOut = semanticResult.timedOut;
        semanticCandidateCount = semanticResult.candidateCount;
        if (!semanticResult.timedOut && semanticResult.overlaps.length > 0) {
          mergedOverlaps = mergeOverlaps(overlaps, semanticResult.overlaps);
          semanticAddedOverlapCount = Math.max(0, mergedOverlaps.length - overlaps.length);
          semanticApplied = semanticAddedOverlapCount > 0;
        }
      } catch (err) {
        log.warn(`shared-context semantic cross-signals failed; fail-open to deterministic output: ${err}`);
      }
    }

    const feedbackByDecision: SharedCrossSignalReport["feedbackByDecision"] = {
      approved: 0,
      approved_with_feedback: 0,
      rejected: 0,
    };
    for (const entry of feedback) {
      feedbackByDecision[entry.decision] += 1;
    }

    const report: SharedCrossSignalReport = {
      date,
      generatedAt: new Date().toISOString(),
      sourceCount: sources.length,
      feedbackCount: feedback.length,
      feedbackByDecision,
      feedbackEntries: [...feedback].sort(compareFeedbackPriority),
      sources,
      overlaps: mergedOverlaps,
      semantic: {
        enabled: semanticEnabled,
        applied: semanticApplied,
        timedOut: semanticTimedOut,
        candidateCount: semanticCandidateCount,
        maxCandidates: Math.max(0, Math.floor(semanticMaxCandidates)),
        addedOverlapCount: semanticAddedOverlapCount,
      },
    };

    const crossSignalsPath = path.join(this.crossSignalsDir, `${date}.json`);
    await writeFileAtomic(crossSignalsPath, `${JSON.stringify(report, null, 2)}\n`);

    const recurringThemeLines = mergedOverlaps.length === 0
      ? ["- No multi-agent topic overlap detected."]
      : mergedOverlaps.slice(0, maxSummaryItems).map((entry) => formatOverlapLine(entry));
    const riskSignals = [...feedback]
      .filter((entry) => entry.decision !== "approved" || entry.severity === "high" || entry.severity === "medium")
      .sort(compareFeedbackPriority)
      .slice(0, maxSummaryItems);
    const riskLines = riskSignals.length === 0
      ? ["- No explicit blockers or elevated review risks recorded."]
      : riskSignals.map((entry) => formatFeedbackLine(entry));
    const promotionCandidates = mergedOverlaps
      .filter((entry) => entry.agentCount >= 3)
      .slice(0, maxSummaryItems);
    const promotionLines = promotionCandidates.length === 0
      ? ["- No promotion candidates yet."]
      : promotionCandidates.map((entry) =>
          `- Consider promoting \`${entry.token}\` into priorities or operating rules [sources: ${markdownLineList(entry.sourcePaths)}]`
        );

    const crossSignalsMarkdown = [
      `# Cross-Signals — ${date}`,
      "",
      "## Overview",
      `- Source outputs analyzed: ${sources.length}`,
      `- Feedback entries analyzed: ${feedback.length}`,
      `- Decision totals: approved=${feedbackByDecision.approved}, approved_with_feedback=${feedbackByDecision.approved_with_feedback}, rejected=${feedbackByDecision.rejected}`,
      `- Semantic enhancer: ${semanticEnabled ? (semanticTimedOut ? "enabled (timed out, fail-open)" : semanticApplied ? "enabled (applied)" : "enabled (no additional overlaps)") : "disabled"}`,
      `- JSON report: ${crossSignalsPath}`,
      "",
      "## Recurring Themes",
      ...recurringThemeLines,
      "",
      "## Risks And Blockers",
      ...riskLines,
      "",
      "## Potential Promotions",
      ...promotionLines,
      "",
      "## Sources",
      ...(sources.length === 0 ? ["- (none)"] : sources.map((source) =>
        `- [${markdownLineText(source.agent)}] ${markdownLineText(source.title)} (${markdownLineText(source.path)})`
      )),
      "",
    ].join("\n");

    const crossSignalsMarkdownPath = path.join(this.crossSignalsDir, `${date}.md`);
    await writeFileAtomic(crossSignalsMarkdownPath, crossSignalsMarkdown);

    return {
      date,
      crossSignalsPath,
      crossSignalsMarkdownPath,
      overlapCount: mergedOverlaps.length,
      report,
    };
  }

  async curateDaily(opts: { date?: string; maxChars?: number }): Promise<SharedDailyCurationResult> {
    const date = safeDateSegment(opts.date ?? ymd(new Date()));
    return this.withDailySynthesisLock(date, () => this.curateDailyUnlocked({ ...opts, date }));
  }

  private async curateDailyUnlocked(opts: { date: string; maxChars?: number }): Promise<SharedDailyCurationResult> {
    const date = opts.date;
    const maxChars = Math.max(2_000, opts.maxChars ?? 20_000);
    const crossSignals = await this.synthesizeCrossSignalsUnlocked({ date });
    const feedbackLines = crossSignals.report.feedbackEntries.length === 0
      ? ["- (none)"]
      : crossSignals.report.feedbackEntries.map((entry) => formatFeedbackLine(entry));
    const overlapBullets = crossSignals.report.overlaps.length === 0
      ? ["- No multi-agent topic overlap detected."]
      : crossSignals.report.overlaps.slice(0, 8).map((entry) => formatOverlapLine(entry));

    const md: string[] = [
      `# Roundtable — ${date}`,
      "",
      "## Notable Agent Outputs",
      ...(crossSignals.report.sources.length === 0
        ? ["- (none)"]
        : crossSignals.report.sources.map((source) => `- ${source.title} (${source.path})`)),
      "",
      "## Feedback (Approve/Reject)",
      ...feedbackLines,
      "",
      "## Cross-Signals",
      `- Source outputs analyzed: ${crossSignals.report.sourceCount}`,
      `- Feedback entries analyzed: ${crossSignals.report.feedbackCount}`,
      `- Decision totals: approved=${crossSignals.report.feedbackByDecision.approved}, approved_with_feedback=${crossSignals.report.feedbackByDecision.approved_with_feedback}, rejected=${crossSignals.report.feedbackByDecision.rejected}`,
      `- Semantic enhancer: ${crossSignals.report.semantic.enabled ? (crossSignals.report.semantic.timedOut ? "enabled (timed out, fail-open)" : crossSignals.report.semantic.applied ? "enabled (applied)" : "enabled (no additional overlaps)") : "disabled"}`,
      `- Cross-signals JSON: ${crossSignals.crossSignalsPath}`,
      `- Cross-signals markdown: ${crossSignals.crossSignalsMarkdownPath}`,
      ...overlapBullets,
      "",
    ];

    const out = md.join("\n");
    const trimmed = out.length > maxChars ? out.slice(0, maxChars) + "\n\n...(trimmed)\n" : out;

    const roundtablePath = path.join(this.roundtableDir, `${date}.md`);
    await writeFileAtomic(roundtablePath, trimmed);

    log.info(`shared-context curated daily roundtable: ${roundtablePath}`);
    return {
      date,
      roundtablePath,
      crossSignalsPath: crossSignals.crossSignalsPath,
      crossSignalsMarkdownPath: crossSignals.crossSignalsMarkdownPath,
      overlapCount: crossSignals.overlapCount,
    };
  }
}
