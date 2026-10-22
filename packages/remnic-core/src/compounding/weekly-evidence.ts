/**
 * Week-scoped inputs for compounding synthesis.
 *
 * Corrections, namespace action ledgers, and the feedback inbox are read here
 * so CompoundingEngine stays inside its line ceiling. Scans are bounded:
 * correction files outside the ISO week are skipped before they are read.
 * Parsing stops after WEEKLY_CORRECTION_READ_LIMIT accepted corrections or
 * WEEKLY_CORRECTION_SCAN_LIMIT opened files, whichever comes first. Visible
 * store candidates are opened before other namespaces, so a foreign store
 * cannot fill the accepted cap and hide an older default-store correction.
 */

import type { Stats } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.js";
import { namespaceIdentityFromToken } from "../namespaces/identity.js";
import { resolveDefaultNamespaceRoot } from "../namespaces/storage.js";
import { isSafeRouteNamespace } from "../routing/engine.js";
import { secureStoreDir } from "../secure-store/header.js";
import * as keyring from "../secure-store/keyring.js";
import { readMaybeEncryptedFile } from "../secure-store/secure-fs.js";
import { type SharedFeedbackEntry, SharedFeedbackEntrySchema } from "../shared-context/manager.js";
import { readRawMemoryDocument } from "../storage/memory-frontmatter-metadata.js";
import { readMaybeEncryptedLines } from "../storage/secure-line-reader.js";
import type { MemoryActionEvent, MemoryFile, PluginConfig } from "../types.js";
import { isErrnoCode } from "../utils/errno.js";
import { assertPathInsideRoot } from "../utils/path-containment.js";
import { isIsoWeekId, isoWeekId } from "./iso-week.js";

const DAY_MS = 86_400_000;

/** Accepted in-week corrections kept per synthesis. */
export const WEEKLY_CORRECTION_READ_LIMIT = 500;

/** Opened in-week correction files per synthesis, including ones policy rejects. */
export const WEEKLY_CORRECTION_SCAN_LIMIT = 2000;

/** Skip a correction file whose on-disk size exceeds this, before parsing. */
export const CORRECTION_FILE_BYTE_LIMIT = 256 * 1024;

const CORRECTION_NOTE_LIMIT = 240;

export type FeedbackEntryWithProvenance = {
  entry: SharedFeedbackEntry;
  sourceLine: number;
  sourcePath: string;
  entryId: string;
};

export type WeeklyActionEvent = {
  line: number;
  action: string;
  outcome: "applied" | "skipped" | "failed";
  policyDecision: "deny" | "defer" | null;
  namespace: string;
  reason: string | null;
  /** Stable ledger label recorded in outcome provenance. */
  ledgerLabel: string;
  actionId: string | null;
};

export type WeeklyCorrectionEvidence = {
  id: string;
  namespace: string;
  pattern: string;
  note: string;
  created: string;
  source: string | null;
  entityRef: string | null;
  confidence: number | null;
  tags: string[];
  provenance: string;
};

export type WeeklyEvidenceStorage = {
  readMemoryByPath(filePath: string): Promise<MemoryFile | null>;
  readMemoryActionEventRows(limit: number): Promise<Array<{ line: number; event: MemoryActionEvent }>>;
};

type CorrectionCandidate = {
  filePath: string;
  sortMs: number;
  namespace: string;
};

type NamespaceDir = {
  dirName: string;
  namespace: string;
  root: string;
};

/** Monday 00:00 UTC of an ISO week id, or null when `weekId` is not one this module emits. */
export function isoWeekStartMs(weekId: string): number | null {
  if (!isIsoWeekId(weekId)) return null;
  const year = Number(weekId.slice(0, 4));
  const week = Number(weekId.slice(6));
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay() || 7;
  const start = jan4 - (jan4Day - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
  if (isoWeekId(new Date(start)) !== weekId) return null;
  return start;
}

export async function readFeedbackEntriesForWeekFile(
  inboxPath: string,
  weekId: string
): Promise<FeedbackEntryWithProvenance[]> {
  // Includes entries whose date falls in the ISO week.
  const out: FeedbackEntryWithProvenance[] = [];
  try {
    const raw = await readFile(inboxPath, "utf-8");
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
          sourcePath: inboxPath,
          entryId: `${parsed.data.agent}-${parsed.data.date}-${sourceLine}`.replace(/[^a-zA-Z0-9._:-]/g, "_"),
        });
      } catch {
        // ignore a malformed line
      }
    }
  } catch {
    // missing feedback is normal
  }
  return out;
}

export function buildActionFailurePatterns(
  events: WeeklyActionEvent[]
): Array<{ pattern: string; provenance: string }> {
  const out: Array<{ pattern: string; provenance: string }> = [];
  for (const event of events) {
    const failed = event.outcome === "failed" || event.outcome === "skipped";
    if (!failed && event.policyDecision === null) continue;
    const suffix = event.reason && event.reason.trim().length > 0 ? ` - ${event.reason.trim().slice(0, 140)}` : "";
    out.push({
      pattern: `memory-action/${event.namespace}: ${event.action} ${event.outcome}${event.policyDecision ? `/${event.policyDecision}` : ""}${suffix}`,
      provenance: `${event.ledgerLabel}:*`,
    });
  }
  return out;
}

export async function readWeeklyActionEvents(input: {
  storage: WeeklyEvidenceStorage;
  memoryDir: string;
  weekId: string;
}): Promise<WeeklyActionEvent[]> {
  const seenActionIds = new Set<string>();
  const out: WeeklyActionEvent[] = [];
  const rootRows = await input.storage.readMemoryActionEventRows(Number.MAX_SAFE_INTEGER);
  for (const row of rootRows) {
    pushActionEvent(out, seenActionIds, row.line, row.event, "default", "memory-actions.jsonl", input.weekId);
  }

  const rootReal = await realpath(input.memoryDir);
  const namespaces = await listNamespaceStorageDirs(input.memoryDir, rootReal);
  const key = keyring.getKey(secureStoreDir(input.memoryDir));
  for (const ns of namespaces) {
    const filePath = path.join(ns.root, "state", "memory-actions.jsonl");
    const label = `namespaces/${ns.dirName}/state/memory-actions.jsonl`;
    let entryStat: Stats;
    try {
      entryStat = await lstat(filePath);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue;
      throw err;
    }
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) continue;
    const fileReal = await realpath(filePath);
    assertPathInsideRoot(rootReal, fileReal, filePath);
    try {
      let lineNumber = 0;
      for await (const row of readMaybeEncryptedLines(
        filePath,
        () => readMaybeEncryptedFile(filePath, key, input.memoryDir),
      )) {
        lineNumber += 1;
        const line = row.trim();
        if (line.length === 0) continue;
        const event = parseMemoryActionEventLine(line);
        if (!event) continue;
        pushActionEvent(out, seenActionIds, lineNumber, event, ns.namespace, label, input.weekId);
      }
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue;
      throw err;
    }
  }
  return out;
}

export async function readWeeklyCorrections(input: {
  storage: WeeklyEvidenceStorage;
  memoryDir: string;
  weekId: string;
  /** Flat root stays visible when this is null. A routed default store passes its `namespaces/<dir>/` prefix. */
  defaultNamespacePrefix?: string | null;
}): Promise<WeeklyCorrectionEvidence[]> {
  const weekStartMs = isoWeekStartMs(input.weekId);
  if (weekStartMs === null) return [];
  const rootReal = await realpath(input.memoryDir);
  const candidates: CorrectionCandidate[] = [];
  await collectCorrectionCandidates(candidates, input.memoryDir, "default", input.weekId, weekStartMs, rootReal);
  const namespaces = await listNamespaceStorageDirs(input.memoryDir, rootReal);
  for (const ns of namespaces) {
    await collectCorrectionCandidates(candidates, ns.root, ns.namespace, input.weekId, weekStartMs, rootReal);
  }
  candidates.sort((a, b) => b.sortMs - a.sortMs || a.filePath.localeCompare(b.filePath));
  const ordered = preferVisibleCorrectionCandidates(
    candidates,
    input.memoryDir,
    input.defaultNamespacePrefix ?? null,
  );
  const out: WeeklyCorrectionEvidence[] = [];
  let scanned = 0;
  for (const candidate of ordered) {
    if (out.length >= WEEKLY_CORRECTION_READ_LIMIT || scanned >= WEEKLY_CORRECTION_SCAN_LIMIT) break;
    scanned += 1;
    const evidence = await readCorrectionCandidate(input.storage, input.memoryDir, input.weekId, candidate);
    if (evidence) out.push(evidence);
  }
  if (scanned < candidates.length) {
    log.warn(
      `weekly synthesis kept ${out.length} accepted corrections after scanning ${scanned} of ${candidates.length} in-week candidates`
    );
  }
  return out;
}

/** Newest-first within the visible store, then newest-first everywhere else. */
function preferVisibleCorrectionCandidates(
  candidates: readonly CorrectionCandidate[],
  memoryDir: string,
  defaultNamespacePrefix: string | null,
): CorrectionCandidate[] {
  const visible: CorrectionCandidate[] = [];
  const foreign: CorrectionCandidate[] = [];
  for (const candidate of candidates) {
    const relative = path.relative(memoryDir, candidate.filePath).split(path.sep).join("/");
    if (provenanceVisibleInStoreRecall([relative], defaultNamespacePrefix)) visible.push(candidate);
    else foreign.push(candidate);
  }
  return visible.concat(foreign);
}

function parseMemoryActionEventLine(line: string): MemoryActionEvent | null {
  let parsed: Partial<MemoryActionEvent> & { recordKind?: unknown };
  try {
    parsed = JSON.parse(line) as Partial<MemoryActionEvent> & { recordKind?: unknown };
  } catch {
    return null;
  }
  if (parsed.recordKind !== undefined) return null;
  const outcome = parsed.outcome === "applied" || parsed.outcome === "skipped" || parsed.outcome === "failed"
    ? parsed.outcome
    : null;
  const timestamp = parsed.timestamp;
  const action = parsed.action;
  if (typeof timestamp !== "string" || typeof action !== "string" || outcome === null) return null;
  return { ...parsed, timestamp, action, outcome };
}

function pushActionEvent(
  out: WeeklyActionEvent[],
  seenActionIds: Set<string>,
  line: number,
  event: MemoryActionEvent,
  fallbackNamespace: string,
  ledgerLabel: string,
  weekId: string
): void {
  const ts = new Date(event.timestamp);
  if (!Number.isFinite(ts.getTime()) || isoWeekId(ts) !== weekId) return;
  const actionId = typeof event.actionId === "string" && event.actionId.length > 0 ? event.actionId : null;
  if (actionId) {
    if (seenActionIds.has(actionId)) return;
    seenActionIds.add(actionId);
  }
  out.push({
    line,
    action: event.action,
    outcome: event.outcome,
    policyDecision: event.policyDecision === "deny" || event.policyDecision === "defer" ? event.policyDecision : null,
    namespace: typeof event.namespace === "string" && event.namespace.length > 0 ? event.namespace : fallbackNamespace,
    reason: typeof event.reason === "string" ? event.reason : null,
    ledgerLabel,
    actionId,
  });
}

async function listNamespaceStorageDirs(memoryDir: string, rootReal: string): Promise<NamespaceDir[]> {
  const nsRoot = path.join(memoryDir, "namespaces");
  let rootStat: Stats;
  try {
    rootStat = await lstat(nsRoot);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return [];
    throw err;
  }
  // A symlinked namespaces directory can point outside the store. Reject the
  // whole tree rather than following it.
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
  const nsReal = await realpath(nsRoot);
  assertPathInsideRoot(rootReal, nsReal, nsRoot);
  const names = await readdir(nsRoot);
  const out: NamespaceDir[] = [];
  for (const dirName of names) {
    const namespace = namespaceFromDirName(dirName);
    if (!namespace) continue;
    const root = path.join(nsRoot, dirName);
    let entryStat: Stats;
    try {
      entryStat = await lstat(root);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue;
      throw err;
    }
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue;
    const dirReal = await realpath(root);
    assertPathInsideRoot(rootReal, dirReal, root);
    out.push({ dirName, namespace, root });
  }
  out.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return out;
}

function namespaceFromDirName(dirName: string): string | null {
  if (dirName.length === 0 || dirName.includes("/") || dirName.includes("\\") || dirName.includes("..")) {
    return null;
  }
  if (dirName.startsWith("ns-")) {
    const decoded = namespaceIdentityFromToken(dirName);
    if (decoded === null) return null;
    // `ns-default` is the empty identity. It is the migrated default store,
    // not a foreign namespace.
    if (decoded.length === 0) return "default";
    return isSafeRouteNamespace(decoded) ? decoded : null;
  }
  return isSafeRouteNamespace(dirName) ? dirName : null;
}

async function collectCorrectionCandidates(
  candidates: CorrectionCandidate[],
  storageRoot: string,
  namespace: string,
  weekId: string,
  weekStartMs: number,
  rootReal: string
): Promise<void> {
  await collectCorrectionDir(
    candidates,
    path.join(storageRoot, "corrections"),
    namespace,
    weekId,
    weekStartMs,
    rootReal
  );
  const factsDir = path.join(storageRoot, "facts");
  const dayNames = await readContainedDirNames(factsDir, rootReal);
  if (!dayNames) return;
  for (const dayName of dayNames) {
    if (!utcDayDirInWeek(dayName, weekId)) continue;
    await collectCorrectionDir(candidates, path.join(factsDir, dayName), namespace, weekId, weekStartMs, rootReal);
  }
}

async function collectCorrectionDir(
  candidates: CorrectionCandidate[],
  dir: string,
  namespace: string,
  weekId: string,
  weekStartMs: number,
  rootReal: string
): Promise<void> {
  const names = await readContainedDirNames(dir, rootReal);
  if (!names) return;
  for (const name of names) {
    if (!name.startsWith("correction-") || !name.endsWith(".md")) continue;
    // A timestamped name outside this week is historical. Skip it before
    // lstat or realpath so a large corrections directory stays inside the
    // weekly budget.
    const filenameMs = correctionFilenameTimestampMs(name);
    if (filenameMs !== null && isoWeekId(new Date(filenameMs)) !== weekId) continue;
    const filePath = path.join(dir, name);
    let entryStat: Stats;
    try {
      entryStat = await lstat(filePath);
    } catch (err) {
      if (isErrnoCode(err, "ENOENT")) continue;
      throw err;
    }
    if (entryStat.isSymbolicLink() || !entryStat.isFile()) continue;
    if (entryStat.size > CORRECTION_FILE_BYTE_LIMIT) continue;
    const fileReal = await realpath(filePath);
    assertPathInsideRoot(rootReal, fileReal, filePath);
    if (filenameMs !== null) {
      candidates.push({ filePath, sortMs: filenameMs, namespace });
      continue;
    }
    if (entryStat.mtimeMs < weekStartMs) continue;
    candidates.push({ filePath, sortMs: entryStat.mtimeMs, namespace });
  }
}

async function readContainedDirNames(dir: string, rootReal: string): Promise<string[] | null> {
  let entryStat: Stats;
  try {
    entryStat = await lstat(dir);
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
  if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) return null;
  const dirReal = await realpath(dir);
  assertPathInsideRoot(rootReal, dirReal, dir);
  return readdir(dir);
}

function utcDayDirInWeek(name: string, weekId: string): boolean {
  if (name.length !== 10 || name[4] !== "-" || name[7] !== "-") return false;
  for (let i = 0; i < name.length; i += 1) {
    if (i === 4 || i === 7) continue;
    const code = name.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  const year = Number(name.slice(0, 4));
  const month = Number(name.slice(5, 7));
  const day = Number(name.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const stamp = new Date(Date.UTC(year, month - 1, day));
  if (stamp.getUTCFullYear() !== year || stamp.getUTCMonth() !== month - 1 || stamp.getUTCDate() !== day) {
    return false;
  }
  return isoWeekId(stamp) === weekId;
}

function correctionFilenameTimestampMs(fileName: string): number | null {
  const prefix = "correction-";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(".md")) return null;
  const rest = fileName.slice(prefix.length, fileName.length - 3);
  let i = 0;
  while (i < rest.length) {
    const code = rest.charCodeAt(i);
    if (code < 48 || code > 57) break;
    i += 1;
  }
  if (i < 10) return null;
  if (i < rest.length && rest[i] !== "-") return null;
  const ms = Number(rest.slice(0, i));
  if (!Number.isSafeInteger(ms)) return null;
  return ms;
}

async function readCorrectionCandidate(
  storage: WeeklyEvidenceStorage,
  memoryDir: string,
  weekId: string,
  candidate: CorrectionCandidate
): Promise<WeeklyCorrectionEvidence | null> {
  const memory = await storage.readMemoryByPath(candidate.filePath);
  if (!memory) return null;
  const raw = readRawMemoryDocument(memory);
  if (!raw) return null;
  if (rawFrontmatterScalar(raw, "category") !== "correction") return null;
  // Missing status is the writer default (`active`). Any other explicit
  // status, including forgotten, stays out of compounding so a forget is
  // not copied back into recall or promotion.
  const status = rawFrontmatterScalar(raw, "status");
  if (status && status !== "active") return null;
  const created = rawFrontmatterScalar(raw, "created");
  if (!created) return null;
  const createdDate = new Date(created);
  if (!Number.isFinite(createdDate.getTime()) || isoWeekId(createdDate) !== weekId) return null;
  const note = collapseWhitespace(memory.content).slice(0, CORRECTION_NOTE_LIMIT);
  if (note.length === 0) return null;
  const rawSource = rawFrontmatterScalar(raw, "source");
  const source = rawSource && rawSource !== "unknown" ? rawSource : null;
  const entityRef =
    typeof memory.frontmatter.entityRef === "string" && memory.frontmatter.entityRef.length > 0
      ? memory.frontmatter.entityRef
      : null;
  const confidence = rawConfidence(raw);
  const tags = Array.isArray(memory.frontmatter.tags)
    ? memory.frontmatter.tags.filter((tag) => typeof tag === "string" && tag.length > 0)
    : [];
  const id =
    typeof memory.frontmatter.id === "string" && memory.frontmatter.id.length > 0
      ? memory.frontmatter.id
      : path.basename(candidate.filePath, ".md");
  return {
    id,
    namespace: candidate.namespace,
    pattern: `correction: ${note}`,
    note,
    created,
    source,
    entityRef,
    confidence,
    tags,
    provenance: path.relative(memoryDir, candidate.filePath).split(path.sep).join("/"),
  };
}

/**
 * Relative `namespaces/` prefix for the routed default store, or null when
 * that store is still the flat memory root. Recall and promotion treat this
 * prefix as the caller's own store.
 */
export async function defaultNamespaceRecallPrefix(config: PluginConfig): Promise<string | null> {
  const root = await resolveDefaultNamespaceRoot(config);
  const rel = path.relative(path.resolve(config.memoryDir), path.resolve(root));
  if (rel === "" || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join("/");
  if (!posix.startsWith("namespaces/")) return null;
  return `${posix}/`;
}

/**
 * Store recall and promotion keep the flat root and the routed default
 * namespace. Other `namespaces/` provenance stays on the weekly report.
 */
export function visibleRubricEntries<T extends {
  observations: string[];
  provenance: string[];
  observationEntries?: Array<{ note: string; provenance: string[] }>;
}>(
  entries: T[],
  observationsFor: (entry: T) => Array<{ note: string; provenance: string[] }>,
  defaultNamespacePrefix: string | null,
): T[] {
  return entries.flatMap((entry) => {
    const visible = observationsFor(entry).filter((item) =>
      provenanceVisibleInStoreRecall(item.provenance, defaultNamespacePrefix),
    );
    if (visible.length === 0) return [];
    return [{
      ...entry,
      observations: visible.map((item) => item.note),
      provenance: [...new Set(visible.flatMap((item) => item.provenance))],
      observationEntries: visible,
    }];
  });
}

/**
 * The mistake registry keeps 500 patterns. Store-visible action failures stay
 * ahead of correction text, and every visible pattern stays ahead of another
 * namespace, so a full correction week cannot drop the caller's own outcomes.
 */
export function capWeeklyPatternDetails<T extends { pattern: string; provenance: readonly string[] }>(
  details: readonly T[],
  categoryFor: (pattern: string) => string | undefined,
  defaultNamespacePrefix: string | null,
  limit = 500,
): T[] {
  const visibleActions: T[] = [];
  const visibleOther: T[] = [];
  const foreign: T[] = [];
  for (const detail of details) {
    if (!provenanceVisibleInStoreRecall(detail.provenance, defaultNamespacePrefix)) {
      foreign.push(detail);
      continue;
    }
    if (categoryFor(detail.pattern) === "action") visibleActions.push(detail);
    else visibleOther.push(detail);
  }
  return [...visibleActions, ...visibleOther, ...foreign].slice(0, limit);
}

/**
 * Active correction mistakes whose visible source files are all missing or
 * non-active. The next synthesis retires those registry entries immediately.
 * Every active correction entry is checked. The weekly pattern cap and the
 * retirement window already bound how many of those entries exist.
 */
export async function forgottenCorrectionPatterns(
  storage: WeeklyEvidenceStorage,
  memoryDir: string,
  registry: ReadonlyArray<{ category?: string; status?: string; pattern: string; provenance?: readonly string[] }>,
  defaultNamespacePrefix: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const entry of registry) {
    if (entry.category !== "correction" || entry.status !== "active") continue;
    const visible = (entry.provenance ?? []).filter((item) =>
      provenanceVisibleInStoreRecall([item], defaultNamespacePrefix),
    );
    if (visible.length === 0) continue;
    let stillActive = false;
    for (const rel of visible) {
      if (rel.includes("..") || path.isAbsolute(rel)) {
        stillActive = true;
        break;
      }
      let memory: MemoryFile | null;
      try {
        memory = await storage.readMemoryByPath(path.join(memoryDir, rel));
      } catch {
        stillActive = true;
        break;
      }
      if (!memory) {
        // readMemoryByPath returns null for a missing file and for a read
        // or decrypt failure. Only a confirmed absence can retire the lesson.
        const sourcePath = path.join(memoryDir, rel);
        try {
          await lstat(sourcePath);
          stillActive = true;
          break;
        } catch (err) {
          if (!isErrnoCode(err, "ENOENT")) {
            stillActive = true;
            break;
          }
        }
        continue;
      }
      const raw = readRawMemoryDocument(memory);
      const status = raw ? rawFrontmatterScalar(raw, "status") : undefined;
      if (!status || status === "active") {
        stillActive = true;
        break;
      }
    }
    if (!stillActive) out.add(entry.pattern);
  }
  return out;
}

export function provenanceVisibleInStoreRecall(
  provenance: readonly string[],
  defaultNamespacePrefix: string | null = null,
): boolean {
  return provenance.length === 0 || provenance.some((item) => {
    if (!item.startsWith("namespaces/")) return true;
    return defaultNamespacePrefix !== null && item.startsWith(defaultNamespacePrefix);
  });
}

/** Ledger rows that belong to the flat root or the routed default namespace. */
export function actionEventsVisibleInStore<T extends { ledgerLabel: string; line: number }>(
  events: readonly T[],
  defaultNamespacePrefix: string | null,
): T[] {
  return events.filter((event) =>
    provenanceVisibleInStoreRecall([`${event.ledgerLabel}:L${event.line}`], defaultNamespacePrefix),
  );
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function rawConfidence(raw: string): number | null {
  const text = rawFrontmatterScalar(raw, "confidence");
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/** Top-level frontmatter scalar. Missing keys stay missing — parser defaults are not used. */
function rawFrontmatterScalar(raw: string, key: string): string | undefined {
  const newline = raw.startsWith("---\r\n") ? 5 : raw.startsWith("---\n") ? 4 : -1;
  if (newline < 0) return undefined;
  const headerEnd = raw.indexOf("\n---", newline);
  if (headerEnd < 0) return undefined;
  const block = raw.slice(newline, headerEnd);
  const prefix = `${key}:`;
  for (const line of block.split("\n")) {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.startsWith(" ") || normalized.startsWith("\t")) continue;
    if (!normalized.startsWith(prefix)) continue;
    let value = normalized.slice(prefix.length).trim();
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
