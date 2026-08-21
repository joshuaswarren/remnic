/**
 * Memory Boxes + Trace Weaving (v8.0 Phase 2A)
 *
 * Implements the Membox concept: a sliding topic window that forms an "open box"
 * accumulating related memories. The box is sealed on topic shift or time gap,
 * then written to memory/boxes/YYYY-MM-DD/box-<id>.md.
 *
 * Trace Weaving links recurring topic boxes with a shared traceId so that
 * cross-session continuity on the same topics is preserved and discoverable.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { log } from "./logger.js";

export const BOX_DIR = "boxes";
const STATE_DIR = "state";
const TRACES_FILE = "traces.json";
const OPEN_BOX_STATE_FILE = "open-box.json";

// ── Types ─────────────────────────────────────────────────────────────────

export interface BoxFrontmatter {
  id: string;
  memoryKind: "box";
  createdAt: string;
  sealedAt: string;
  sealReason: SealReason;
  sessionKey?: string;
  topics: string[];
  memoryIds: string[];
  traceId?: string;
  /** High-level task goal for this episode (REMem-inspired). */
  goal?: string;
  /** Tools invoked during this episode. */
  toolsUsed?: string[];
  /** Episode outcome: success, failure, partial, or unknown. */
  outcome?: "success" | "failure" | "partial" | "unknown";
}

export type SealReason = "topic_shift" | "time_gap" | "max_memories" | "forced" | "flush";

interface OpenBoxState {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  topics: string[];
  memoryIds: string[];
  goal?: string;
  toolsUsed?: string[];
}

interface TraceIndex {
  /** traceId → list of box IDs */
  traces: Record<string, string[]>;
  /** boxId → traceId */
  boxToTrace: Record<string, string>;
  /** traceId → canonical topic fingerprint for matching */
  traceTopics: Record<string, string[]>;
  /** traceId → ISO timestamp of last box added (for lookback filtering) */
  traceLastSeen: Record<string, string>;
}

export interface BoxBuilderConfig {
  memoryBoxesEnabled: boolean;
  traceWeaverEnabled: boolean;
  /** Jaccard threshold below which topic shift triggers seal (0-1, default 0.35) */
  boxTopicShiftThreshold: number;
  /** Time gap in ms before sealing an open box (default 30 min) */
  boxTimeGapMs: number;
  /** Max memories in one box before forced seal */
  boxMaxMemories: number;
  /** Days back to look for trace links */
  traceWeaverLookbackDays: number;
  /** Minimum topic overlap to assign same traceId (0-1, default 0.4) */
  traceWeaverOverlapThreshold: number;
}

interface ExtractionEvent {
  topics: string[];
  memoryIds: string[];
  timestamp: string;
  goal?: string;
  toolsUsed?: string[];
}

// ── Utility ───────────────────────────────────────────────────────────────

/**
 * Jaccard similarity between two topic arrays.
 * Returns 0.0 for empty inputs.
 */
export function topicOverlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0.0;
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0.0 : intersection / union;
}

function makeBoxId(): string {
  return `box-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function makeTraceId(topics: string[]): string {
  const key = topics.slice().sort().join(",");
  return `trace-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function parseOpenBoxState(value: unknown): OpenBoxState | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.lastActivityAt !== "string" ||
    !isStringArray(value.topics) ||
    !isStringArray(value.memoryIds)
  ) {
    return null;
  }
  if (value.goal !== undefined && typeof value.goal !== "string") return null;
  if (value.toolsUsed !== undefined && !isStringArray(value.toolsUsed)) return null;
  return {
    id: value.id,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    topics: value.topics,
    memoryIds: value.memoryIds,
    goal: value.goal,
    toolsUsed: value.toolsUsed,
  };
}

function parseTraceIndex(value: unknown): TraceIndex | null {
  if (!isRecord(value)) return null;
  if (
    !isStringArrayRecord(value.traces) ||
    !isStringRecord(value.boxToTrace) ||
    !isStringArrayRecord(value.traceTopics)
  ) {
    return null;
  }
  const traceLastSeen = value.traceLastSeen ?? {};
  if (!isStringRecord(traceLastSeen)) return null;
  return {
    traces: value.traces,
    boxToTrace: value.boxToTrace,
    traceTopics: value.traceTopics,
    traceLastSeen,
  };
}

// ── Frontmatter serialization ──────────────────────────────────────────────

function serializeStringArray(values: string[]): string {
  return JSON.stringify(values);
}

function parseStringArray(val: string | undefined): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // Fall back to the legacy comma-split parser below.
  }
  const start = val.indexOf("[");
  const end = val.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  return val
    .slice(start + 1, end)
    .split(",")
    .map((s) => stripLegacyQuotes(s.trim()))
    .filter(Boolean);
}

function stripLegacyQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeBoxFrontmatter(fm: BoxFrontmatter): string {
  const lines = [
    "---",
    `id: ${fm.id}`,
    `memoryKind: ${fm.memoryKind}`,
    `createdAt: ${fm.createdAt}`,
    `sealedAt: ${fm.sealedAt}`,
    `sealReason: ${fm.sealReason}`,
    `topics: ${serializeStringArray(fm.topics)}`,
    `memoryIds: ${serializeStringArray(fm.memoryIds)}`,
  ];
  if (fm.sessionKey) lines.push(`sessionKey: ${fm.sessionKey}`);
  if (fm.traceId) lines.push(`traceId: ${fm.traceId}`);
  if (fm.goal) lines.push(`goal: ${fm.goal.replace(/[\r\n]+/g, " ")}`);
  if (fm.toolsUsed?.length) lines.push(`toolsUsed: ${serializeStringArray(fm.toolsUsed)}`);
  if (fm.outcome) lines.push(`outcome: ${fm.outcome}`);
  lines.push("---");
  return lines.join("\n");
}

export function parseBoxFrontmatter(raw: string): BoxFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fmBlock = match[1];
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    fm[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
  }

  const outcome = fm.outcome as BoxFrontmatter["outcome"];
  return {
    id: fm.id ?? "",
    memoryKind: "box",
    createdAt: fm.createdAt ?? "",
    sealedAt: fm.sealedAt ?? "",
    sealReason: (fm.sealReason ?? "forced") as SealReason,
    sessionKey: fm.sessionKey,
    topics: parseStringArray(fm.topics),
    memoryIds: parseStringArray(fm.memoryIds),
    traceId: fm.traceId,
    goal: fm.goal || undefined,
    toolsUsed: fm.toolsUsed ? parseStringArray(fm.toolsUsed) : undefined,
    outcome: outcome && ["success", "failure", "partial", "unknown"].includes(outcome) ? outcome : undefined,
  };
}

// ── BoxBuilder ────────────────────────────────────────────────────────────

export class BoxBuilder {
  private baseDir: string;
  private cfg: BoxBuilderConfig;
  private openBox: OpenBoxState | null = null;
  private stateLoaded = false;
  private openBoxMutationChain: Promise<unknown> = Promise.resolve();
  private traceMutationChain: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string, cfg: BoxBuilderConfig) {
    this.baseDir = baseDir;
    this.cfg = cfg;
  }

  private enqueueOpenBoxMutation<T>(op: () => Promise<T>): Promise<T> {
    const run = this.openBoxMutationChain.catch(() => {}).then(op);
    this.openBoxMutationChain = run.catch(() => {});
    return run;
  }

  private enqueueTraceMutation<T>(op: () => Promise<T>): Promise<T> {
    const run = this.traceMutationChain.catch(() => {}).then(op);
    this.traceMutationChain = run.catch(() => {});
    return run;
  }

  private get boxBaseDir(): string {
    return path.join(this.baseDir, BOX_DIR);
  }

  private get stateDir(): string {
    return path.join(this.baseDir, STATE_DIR);
  }

  private get openBoxStatePath(): string {
    return path.join(this.stateDir, OPEN_BOX_STATE_FILE);
  }

  private get tracesPath(): string {
    return path.join(this.stateDir, TRACES_FILE);
  }

  // ── State persistence ────────────────────────────────────────────────────

  private async loadOpenBox(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = await readFile(this.openBoxStatePath, "utf-8");
      this.openBox = parseOpenBoxState(JSON.parse(raw));
    } catch {
      this.openBox = null;
    }
  }

  private async writeOpenBoxState(state: OpenBoxState | null): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.openBoxStatePath, JSON.stringify(state, null, 2), "utf-8");
  }

  private async saveOpenBox(): Promise<void> {
    await this.writeOpenBoxState(this.openBox);
  }

  private async loadTraceIndex(): Promise<TraceIndex> {
    try {
      const raw = await readFile(this.tracesPath, "utf-8");
      const parsed = parseTraceIndex(JSON.parse(raw));
      if (!parsed) {
        log.warn("[engram/boxes] Ignoring invalid trace index state");
        return { traces: {}, boxToTrace: {}, traceTopics: {}, traceLastSeen: {} };
      }
      return parsed;
    } catch {
      return { traces: {}, boxToTrace: {}, traceTopics: {}, traceLastSeen: {} };
    }
  }

  private async saveTraceIndex(idx: TraceIndex): Promise<boolean> {
    try {
      await mkdir(this.stateDir, { recursive: true });
      await writeFile(this.tracesPath, JSON.stringify(idx, null, 2), "utf-8");
      return true;
    } catch (err) {
      log.warn(`[engram/boxes] Failed to save trace index: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Core logic ────────────────────────────────────────────────────────────

  /**
   * Called after each extraction run.
   * Decides whether to seal the current open box and/or start a new one.
   */
  async onExtraction(event: ExtractionEvent): Promise<void> {
    await this.enqueueOpenBoxMutation(async () => this.onExtractionUnlocked(event));
  }

  private async onExtractionUnlocked(event: ExtractionEvent): Promise<void> {
    if (!this.cfg.memoryBoxesEnabled) return;

    await this.loadOpenBox();

    const newTopics = event.topics.filter(Boolean);
    const now = new Date(event.timestamp);
    const nowMs = now.getTime();

    if (this.openBox) {
      // Check seal conditions
      const lastActivity = new Date(this.openBox.lastActivityAt).getTime();
      const timeGapMs = nowMs - lastActivity;
      const overlap = topicOverlapScore(this.openBox.topics, newTopics);
      const topicShifted = newTopics.length > 0 && overlap < this.cfg.boxTopicShiftThreshold;
      const timeExpired = timeGapMs >= this.cfg.boxTimeGapMs;
      const tooManyMemories =
        this.openBox.memoryIds.length + event.memoryIds.length > this.cfg.boxMaxMemories;

      if (tooManyMemories) {
        // Merge topics and add current batch then seal
        const topicSet = new Set([...this.openBox.topics, ...newTopics]);
        this.openBox.topics = [...topicSet];
        this.openBox.memoryIds.push(...event.memoryIds);
        if (event.toolsUsed?.length) {
          const toolSet = new Set([...(this.openBox.toolsUsed ?? []), ...event.toolsUsed]);
          this.openBox.toolsUsed = [...toolSet];
        }
        await this.sealCurrentUnlocked("max_memories");
      } else if (topicShifted) {
        await this.sealCurrentUnlocked("topic_shift");
        this.openBox = this.newBox(event, now.toISOString());
        await this.saveOpenBox();
      } else if (timeExpired) {
        await this.sealCurrentUnlocked("time_gap");
        this.openBox = this.newBox(event, now.toISOString());
        await this.saveOpenBox();
      } else {
        // Accumulate
        this.openBox.memoryIds.push(...event.memoryIds);
        // Merge new topics (union)
        const topicSet = new Set([...this.openBox.topics, ...newTopics]);
        this.openBox.topics = [...topicSet];
        this.openBox.lastActivityAt = now.toISOString();
        // Merge toolsUsed (union)
        if (event.toolsUsed?.length) {
          const toolSet = new Set([...(this.openBox.toolsUsed ?? []), ...event.toolsUsed]);
          this.openBox.toolsUsed = [...toolSet];
        }
        await this.saveOpenBox();
      }
    } else {
      // No open box — start one
      this.openBox = this.newBox(event, now.toISOString());
      // If this initial batch already exceeds max, seal immediately
      if (this.openBox.memoryIds.length > this.cfg.boxMaxMemories) {
        await this.sealCurrentUnlocked("max_memories");
      } else {
        await this.saveOpenBox();
      }
    }
  }

  private newBox(event: ExtractionEvent, ts: string): OpenBoxState {
    return {
      id: makeBoxId(),
      createdAt: ts,
      lastActivityAt: ts,
      topics: event.topics.filter(Boolean),
      memoryIds: [...event.memoryIds],
      goal: event.goal,
      toolsUsed: event.toolsUsed?.length ? [...event.toolsUsed] : undefined,
    };
  }

  /**
   * Seal the current open box and write it to disk.
   * Also runs trace weaving if enabled.
   */
  async sealCurrent(reason: SealReason): Promise<string | null> {
    return this.enqueueOpenBoxMutation(async () => this.sealCurrentUnlocked(reason));
  }

  private async sealCurrentUnlocked(reason: SealReason): Promise<string | null> {
    await this.loadOpenBox();
    if (!this.openBox) return null;

    const box = this.openBox;

    if (box.memoryIds.length === 0 && box.topics.length === 0) {
      await this.writeOpenBoxState(null);
      this.openBox = null;
      return null;
    }

    const sealedAt = new Date().toISOString();
    const day = sealedAt.slice(0, 10);
    const dir = path.join(this.boxBaseDir, day);
    await mkdir(dir, { recursive: true });

    let traceId: string | undefined;
    if (this.cfg.traceWeaverEnabled && box.topics.length > 0) {
      traceId = await this.resolveTrace(box.id, box.topics);
    }

    const fm: BoxFrontmatter = {
      id: box.id,
      memoryKind: "box",
      createdAt: box.createdAt,
      sealedAt,
      sealReason: reason,
      topics: box.topics,
      memoryIds: box.memoryIds,
      traceId,
      goal: box.goal,
      toolsUsed: box.toolsUsed?.length ? box.toolsUsed : undefined,
      outcome: "unknown",
    };

    const content = `${serializeBoxFrontmatter(fm)}\n\n<!-- Topics: ${box.topics.join(", ")} | Memories: ${box.memoryIds.length} -->\n`;
    const filePath = path.join(dir, `${box.id}.md`);
    await writeFile(filePath, content, "utf-8");
    log.debug(`[boxes] sealed box ${box.id} (${reason}): ${box.memoryIds.length} memories, topics=[${box.topics.join(",")}]`);

    await this.writeOpenBoxState(null);
    this.openBox = null;
    return box.id;
  }

  // ── Trace Weaving ─────────────────────────────────────────────────────────

  /**
   * Find an existing trace that matches box topics, or create a new trace.
   * Returns the traceId to assign to this box.
   */
  private async resolveTrace(boxId: string, topics: string[]): Promise<string | undefined> {
    return this.enqueueTraceMutation(async () => this.resolveTraceUnlocked(boxId, topics));
  }

  private async resolveTraceUnlocked(boxId: string, topics: string[]): Promise<string | undefined> {
    const idx = await this.loadTraceIndex();

    // Filter to traces active within the lookback window
    const lookbackMs = this.cfg.traceWeaverLookbackDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - lookbackMs);

    let bestTraceId: string | undefined;
    let bestScore = 0;

    for (const [tid, traceTopics] of Object.entries(idx.traceTopics)) {
      const lastSeen = idx.traceLastSeen[tid];
      if (lastSeen && new Date(lastSeen) < cutoff) continue; // outside lookback window
      const score = topicOverlapScore(topics, traceTopics);
      if (score >= this.cfg.traceWeaverOverlapThreshold && score > bestScore) {
        bestScore = score;
        bestTraceId = tid;
      }
    }

    const traceId = bestTraceId ?? makeTraceId(topics);
    const now = new Date().toISOString();

    // Update trace index
    if (!idx.traces[traceId]) idx.traces[traceId] = [];
    idx.traces[traceId].push(boxId);
    idx.boxToTrace[boxId] = traceId;
    idx.traceLastSeen[traceId] = now;

    // Update canonical topics for this trace (merge)
    if (idx.traceTopics[traceId]) {
      const merged = new Set([...idx.traceTopics[traceId], ...topics]);
      idx.traceTopics[traceId] = [...merged];
    } else {
      idx.traceTopics[traceId] = [...topics];
    }

    return (await this.saveTraceIndex(idx)) ? traceId : undefined;
  }

  // ── Recall ────────────────────────────────────────────────────────────────

  /**
   * Read all sealed boxes from the last N days for recall injection.
   */
  async readRecentBoxes(days: number): Promise<BoxFrontmatter[]> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"

    let topEntries: Dirent<string>[];
    try {
      topEntries = await readdir(this.boxBaseDir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return [];
    }

    // Filter day directories by name (YYYY-MM-DD) — skip dirs older than cutoff
    // without reading a single file from them.
    const recentDirs = topEntries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name >= cutoffDateStr)
      .map((e) => path.join(this.boxBaseDir, e.name));

    // Also include legacy flat entries at the root level (non-date dirs and .md files)
    const legacyEntries = topEntries.filter(
      (e) => !e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name),
    );

    // Read all files in each recent day directory in parallel (per dir)
    const boxes: BoxFrontmatter[] = [];

    const readDir = async (dir: string) => {
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
      } catch {
        return;
      }
      const results = await Promise.all(
        files.map(async (f) => {
          try {
            const raw = await readFile(path.join(dir, f), "utf-8");
            const parsed = parseBoxFrontmatter(raw);
            return parsed && new Date(parsed.sealedAt) >= cutoff ? parsed : null;
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (r !== null) boxes.push(r);
      }
    };

    // Day dirs in parallel
    await Promise.all(recentDirs.map(readDir));

    // Legacy non-date entries (walk sub-dirs sequentially but read files in parallel)
    for (const e of legacyEntries) {
      const full = path.join(this.boxBaseDir, e.name);
      if (e.isDirectory()) {
        await readDir(full);
      } else if (e.name.endsWith(".md")) {
        try {
          const raw = await readFile(full, "utf-8");
          const parsed = parseBoxFrontmatter(raw);
          if (parsed && new Date(parsed.sealedAt) >= cutoff) boxes.push(parsed);
        } catch { /* corrupt file — skip */ }
      }
    }

    // Sort newest-first so slice(0, N) gives the most recent boxes
    boxes.sort((a, b) => new Date(b.sealedAt).getTime() - new Date(a.sealedAt).getTime());
    return boxes;
  }
}
