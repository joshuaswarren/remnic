/**
 * Contradiction Review Queue — storage for detected contradiction pairs (issue #520).
 *
 * Stores candidate pairs as JSON files under `memoryDir/.review/contradictions/`.
 * Pair IDs are deterministic (sha256 of sorted memory IDs plus namespace when scoped) so reruns are idempotent.
 *
 * Lifecycle:
 *   - `contradicts` → awaiting user review
 *   - `duplicates` → auto-flagged for dedup (still needs user approval)
 *   - `independent` / `both-valid` → dormant with cooldown
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ContradictionVerdict } from "./contradiction-judge.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ResolutionVerb = "keep-a" | "keep-b" | "merge" | "both-valid" | "needs-more-context";

const VALID_RESOLUTION_VERBS: readonly ResolutionVerb[] = [
  "keep-a",
  "keep-b",
  "merge",
  "both-valid",
  "needs-more-context",
];

export interface ContradictionPair {
  /** Deterministic pair ID: sha256(sorted(memoryIdA, memoryIdB) plus namespace when scoped). */
  pairId: string;
  /** Memory IDs (sorted). */
  memoryIds: [string, string];
  /** Judge verdict. */
  verdict: ContradictionVerdict;
  /** Judge rationale. */
  rationale: string;
  /** Judge confidence in [0, 1]. */
  confidence: number;
  /** ISO timestamp when detected. */
  detectedAt: string;
  /** ISO timestamp when last reviewed by user. */
  lastReviewedAt?: string;
  /** Resolution verb applied by user. */
  resolution?: ResolutionVerb;
  /** ISO timestamp until which a non-terminal deferral remains hidden from review. */
  deferredUntil?: string;
  /** Content hashes captured for each referenced memory when this pair was judged. */
  memoryContentHashes?: Record<string, string>;
  /** Namespace scope. */
  namespace?: string;
}

export interface ContradictionListResult {
  pairs: ContradictionPair[];
  total: number;
  durationMs: number;
}

export type ContradictionFilter = ContradictionVerdict | "all" | "unresolved";
export interface WritePairOptions {
  /** Cooldown used by scan callers to preserve still-dormant reviewed pairs. */
  cooldownDays?: number;
}
const NEEDS_MORE_CONTEXT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const UNSCOPED_MIGRATION_MARKER_PREFIX = ".unscoped-migrated-";
const UNSCOPED_MIGRATION_MARKER_SUFFIX = ".done";

// ── Helpers ────────────────────────────────────────────────────────────────────

export function computePairId(memoryIdA: string, memoryIdB: string, namespace?: string): string {
  const sorted = [memoryIdA, memoryIdB].sort();
  const normalizedNamespace = namespace?.trim();
  const scope = normalizedNamespace ? `ns:${normalizedNamespace}::` : "";
  return createHash("sha256").update(`${scope}${sorted.join("::")}`).digest("hex").slice(0, 24);
}

export function isDefaultReviewNamespace(
  defaultNamespace: string,
  requestedNamespace: string | undefined,
  resolvedNamespace: string,
): boolean {
  const requested = requestedNamespace?.trim();
  return !requested || requested === defaultNamespace || resolvedNamespace === defaultNamespace;
}

function isTerminalResolution(resolution: ResolutionVerb | undefined): boolean {
  return resolution === "keep-a" || resolution === "keep-b" || resolution === "merge";
}

function preservesDirectResolution(resolution: ResolutionVerb | undefined): boolean {
  return isTerminalResolution(resolution) || resolution === "both-valid";
}

function isDormantReviewedPair(pair: ContradictionPair): boolean {
  return pair.verdict === "independent" || pair.resolution === "both-valid";
}

function reviewStateRank(pair: ContradictionPair, cooldownDays?: number): number {
  if (isTerminalResolution(pair.resolution)) return 5;
  if (pair.resolution === "both-valid") return 4;
  if (isDeferralActive(pair)) return 3;
  if (isDormantReviewedPair(pair)) {
    if (cooldownDays === undefined) return 2;
    return isCoolingDown(pair, cooldownDays) ? 2 : 0;
  }
  return 1;
}

function parseIsoMillis(value: string | undefined): number | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function isDeferred(pair: Pick<ContradictionPair, "resolution" | "deferredUntil">): boolean {
  return pair.resolution === "needs-more-context" || Boolean(pair.deferredUntil);
}

function deferralUntilMillis(pair: ContradictionPair): number | null {
  const deferredUntil = parseIsoMillis(pair.deferredUntil);
  if (deferredUntil !== null) return deferredUntil;

  if (pair.resolution === "needs-more-context") {
    const lastReviewed = parseIsoMillis(pair.lastReviewedAt);
    return lastReviewed === null ? null : lastReviewed + NEEDS_MORE_CONTEXT_COOLDOWN_MS;
  }

  return null;
}

function isDeferralActive(pair: ContradictionPair): boolean {
  const deferredUntil = deferralUntilMillis(pair);
  return deferredUntil !== null && Date.now() < deferredUntil;
}

function reviewStateMillis(pair: ContradictionPair): number {
  return Math.max(
    parseIsoMillis(pair.deferredUntil) ?? Number.NEGATIVE_INFINITY,
    parseIsoMillis(pair.lastReviewedAt) ?? Number.NEGATIVE_INFINITY,
    parseIsoMillis(pair.detectedAt) ?? Number.NEGATIVE_INFINITY,
  );
}

function mergeMigratedPair(existing: ContradictionPair, migrated: ContradictionPair, options: WritePairOptions): ContradictionPair {
  const existingRank = reviewStateRank(existing, options.cooldownDays);
  const migratedRank = reviewStateRank(migrated, options.cooldownDays);
  const selected = migratedRank > existingRank
    ? migrated
    : migratedRank < existingRank
      ? existing
      : reviewStateMillis(migrated) > reviewStateMillis(existing)
        ? migrated
        : existing;

  return {
    ...selected,
    pairId: migrated.pairId,
    namespace: migrated.namespace,
  };
}

function reviewDir(memoryDir: string): string {
  return path.join(memoryDir, ".review", "contradictions");
}

function migrationMarkerPath(memoryDir: string, namespace: string): string {
  const namespaceKey = createHash("sha256").update(namespace).digest("hex").slice(0, 16);
  return path.join(reviewDir(memoryDir), `${UNSCOPED_MIGRATION_MARKER_PREFIX}${namespaceKey}${UNSCOPED_MIGRATION_MARKER_SUFFIX}`);
}

function clearUnscopedMigrationMarkers(memoryDir: string): void {
  const dir = reviewDir(memoryDir);
  if (!fs.existsSync(dir)) return;

  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(UNSCOPED_MIGRATION_MARKER_PREFIX) && entry.endsWith(UNSCOPED_MIGRATION_MARKER_SUFFIX)) {
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    }
  } catch {
    // Marker cleanup is best-effort. The next migration/list call can recover.
  }
}

function pairPath(memoryDir: string, pairId: string): string {
  if (pairId.includes("/") || pairId.includes("\\") || pairId.includes("..")) {
    throw new Error(`Invalid pairId: ${pairId}`);
  }
  return path.join(reviewDir(memoryDir), `${pairId}.json`);
}

function isSafeReviewJsonFile(memoryDir: string, filePath: string): boolean {
  const root = path.resolve(reviewDir(memoryDir));
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  try {
    return fs.lstatSync(resolved).isFile();
  } catch {
    return false;
  }
}

function ensureDir(memoryDir: string): void {
  const dir = reviewDir(memoryDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function uniqueTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

function writePairFile(filePath: string, pair: ContradictionPair): void {
  const tmpPath = uniqueTempPath(filePath);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(pair, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only; preserve the original write failure.
    }
    throw error;
  }
}

export function computeMemoryContentHash(content: string, category?: string): string {
  const normalized = JSON.stringify({
    content: content.trim(),
    category: (category ?? "").trim(),
  });
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function suppliedMemoryHashesChanged(
  existing: ContradictionPair,
  pair: Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] },
): boolean {
  if (!existing.memoryContentHashes || !pair.memoryContentHashes) return false;
  return pair.memoryIds.some((memoryId) => {
    const current = pair.memoryContentHashes?.[memoryId];
    return typeof current === "string" && existing.memoryContentHashes?.[memoryId] !== current;
  });
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Write a contradiction pair to the review queue.
 * Idempotent: if the pair already exists with a higher or equal confidence,
 * the existing entry is preserved.
 */
export function writePair(
  memoryDir: string,
  pair: Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] },
  options: WritePairOptions = {},
): ContradictionPair {
  ensureDir(memoryDir);
  if (pair.namespace === undefined) {
    clearUnscopedMigrationMarkers(memoryDir);
  }
  const pairId = computePairId(pair.memoryIds[0], pair.memoryIds[1], pair.namespace);
  const existing = readPair(memoryDir, pairId);

  // Preserve terminal user resolutions if already reviewed.
  if (isTerminalResolution(existing?.resolution)) {
    return existing!;
  }
  const contentChanged = Boolean(existing && suppliedMemoryHashesChanged(existing, pair));
  if (existing?.resolution === "both-valid" && options.cooldownDays === undefined && !contentChanged) {
    return existing;
  }

  // Preserve active deferrals, but allow expired deferrals to be refreshed.
  const existingDeferralExpired = Boolean(existing && isDeferred(existing) && !isDeferralActive(existing));
  if (existing && isDeferralActive(existing) && !contentChanged) {
    return existing;
  }

  // Preserve same-verdict or still-cooling entries, but let expired dormant
  // verdicts refresh when the judge now finds an actionable conflict.
  const existingDormantCooldownActive = Boolean(
    existing
    && isDormantReviewedPair(existing)
    && options.cooldownDays !== undefined
    && isCoolingDown(existing, options.cooldownDays),
  );
  const dormantContentChanged = Boolean(
    existing
    && existingDormantCooldownActive
    && contentChanged,
  );
  const existingDormantExpired = Boolean(
    existing
    && isDormantReviewedPair(existing)
    && options.cooldownDays !== undefined
    && !existingDormantCooldownActive,
  );
  if (
    existing
    && !existingDeferralExpired
    && (
      (existingDormantCooldownActive && !dormantContentChanged)
      || (!existingDormantExpired && !contentChanged && existing.confidence >= pair.confidence)
    )
  ) {
    return existing;
  }

  const full: ContradictionPair = {
    ...pair,
    pairId,
    lastReviewedAt: (existingDeferralExpired || existingDormantExpired || contentChanged)
      ? pair.lastReviewedAt
      : (existing?.lastReviewedAt ?? pair.lastReviewedAt),
    resolution: undefined,
    deferredUntil: (existingDeferralExpired || existingDormantExpired || contentChanged)
      ? undefined
      : existing?.deferredUntil,
  };

  const filePath = pairPath(memoryDir, pairId);
  writePairFile(filePath, full);

  return full;
}

/**
 * Write multiple pairs, deduplicating inputs first (rule 49).
 */
export function writePairs(
  memoryDir: string,
  pairs: Array<Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }>,
  options: WritePairOptions = {},
): ContradictionPair[] {
  const seen = new Set<string>();
  const results: ContradictionPair[] = [];

  for (const pair of pairs) {
    const key = computePairId(pair.memoryIds[0], pair.memoryIds[1], pair.namespace);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(writePair(memoryDir, pair, options));
  }

  return results;
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read a single pair by ID. Returns null if not found.
 */
export function readPair(memoryDir: string, pairId: string): ContradictionPair | null {
  const filePath = pairPath(memoryDir, pairId);
  try {
    if (!isSafeReviewJsonFile(memoryDir, filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.memoryIds)) {
      return parsed as ContradictionPair;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List pairs in the review queue, optionally filtered by verdict.
 */
export function listPairs(
  memoryDir: string,
  options?: {
    filter?: ContradictionFilter;
    namespace?: string;
    includeUnscopedForNamespace?: boolean;
    limit?: number;
  },
): ContradictionListResult {
  const startTime = Date.now();
  const dir = reviewDir(memoryDir);
  const { filter = "all", namespace, includeUnscopedForNamespace = false, limit = 50 } = options ?? {};
  const pairs: ContradictionPair[] = [];
  let total = 0;

  if (!fs.existsSync(dir)) {
    return { pairs: [], total: 0, durationMs: Date.now() - startTime };
  }

  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;

    try {
      const filePath = path.join(dir, entry);
      if (!isSafeReviewJsonFile(memoryDir, filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf-8");
      const pair = JSON.parse(raw) as ContradictionPair;

      if (typeof pair !== "object" || pair === null) continue;
      if (!Array.isArray(pair.memoryIds)) continue;

      // Namespace filter
      if (namespace && pair.namespace !== namespace && !(includeUnscopedForNamespace && pair.namespace === undefined)) continue;

      // Verdict filter
      if (filter === "unresolved") {
        if (isTerminalResolution(pair.resolution)) continue;
        if (isDeferralActive(pair)) continue;
        if (pair.resolution === "both-valid") continue;
        if (pair.verdict === "independent") continue;
      } else if (filter !== "all" && pair.verdict !== filter) {
        continue;
      }

      total++;
      if (pairs.length < limit) pairs.push(pair);
    } catch {
      continue;
    }
  }

  return { pairs, total, durationMs: Date.now() - startTime };
}

export function migrateUnscopedPairsToNamespace(memoryDir: string, namespace: string, options: WritePairOptions = {}): number {
  const resolvedNamespace = namespace.trim();
  if (!resolvedNamespace) return 0;

  const dir = reviewDir(memoryDir);
  if (!fs.existsSync(dir)) return 0;
  const markerPath = migrationMarkerPath(memoryDir, resolvedNamespace);
  if (fs.existsSync(markerPath)) return 0;

  let migrated = 0;
  let hadMigrationFailure = false;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);

    try {
      if (!isSafeReviewJsonFile(memoryDir, filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf-8");
      const pair = JSON.parse(raw) as ContradictionPair;
      if (typeof pair !== "object" || pair === null) continue;
      if (!Array.isArray(pair.memoryIds)) continue;
      if (pair.namespace !== undefined) continue;

      const pairId = computePairId(pair.memoryIds[0], pair.memoryIds[1], resolvedNamespace);
      const migratedPair = { ...pair, namespace: resolvedNamespace, pairId };
      const targetPath = pairPath(memoryDir, pairId);
      try {
        if (targetPath === filePath) {
          writePairFile(filePath, migratedPair);
        } else if (!fs.existsSync(targetPath)) {
          writePairFile(targetPath, migratedPair);
          fs.rmSync(filePath, { force: true });
        } else {
          if (!isSafeReviewJsonFile(memoryDir, targetPath)) {
            hadMigrationFailure = true;
            continue;
          }
          const existing = readPair(memoryDir, pairId);
          writePairFile(targetPath, existing ? mergeMigratedPair(existing, migratedPair, options) : migratedPair);
          fs.rmSync(filePath, { force: true });
        }
        migrated += 1;
      } catch {
        hadMigrationFailure = true;
        continue;
      }
    } catch {
      continue;
    }
  }

  if (!hadMigrationFailure) {
    try {
      fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, { encoding: "utf-8", flag: "wx" });
    } catch {
      // Another caller may have completed the same one-shot migration first.
    }
  }

  return migrated;
}

// ── Cooldown ───────────────────────────────────────────────────────────────────

/**
 * Check if a pair is within its cooldown window.
 * Returns true if the pair should be SKIPPED (still cooling down).
 */
export function isCoolingDown(pair: ContradictionPair, cooldownDays: number): boolean {
  if (cooldownDays <= 0) return false; // rule 27: guard against 0

  const deferredUntil = deferralUntilMillis(pair);
  if (deferredUntil !== null) {
    return Date.now() < deferredUntil;
  }

  if (!pair.lastReviewedAt) return false;

  const lastReviewed = parseIsoMillis(pair.lastReviewedAt);
  if (lastReviewed === null) return false;

  const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
  return Date.now() < lastReviewed + cooldownMs;
}

/**
 * Mark a pair as reviewed (sets lastReviewedAt and, for terminal verbs, resolution).
 */
export function resolvePair(
  memoryDir: string,
  pairId: string,
  verb: ResolutionVerb,
): ContradictionPair | null {
  if (typeof verb !== "string" || !VALID_RESOLUTION_VERBS.includes(verb)) {
    throw new Error(`Invalid contradiction resolution verb: ${String(verb)}`);
  }

  if (verb === "needs-more-context") {
    return deferPair(memoryDir, pairId);
  }

  const existing = readPair(memoryDir, pairId);
  if (!existing) return null;
  if (preservesDirectResolution(existing.resolution)) return existing;

  const updated: ContradictionPair = {
    ...existing,
    lastReviewedAt: new Date().toISOString(),
    resolution: verb,
    deferredUntil: undefined,
  };

  const filePath = pairPath(memoryDir, pairId);
  writePairFile(filePath, updated);

  return updated;
}

/**
 * Defer a pair without terminally resolving it.
 */
export function deferPair(
  memoryDir: string,
  pairId: string,
  deferredUntil = new Date(Date.now() + NEEDS_MORE_CONTEXT_COOLDOWN_MS).toISOString(),
): ContradictionPair | null {
  const existing = readPair(memoryDir, pairId);
  if (!existing) return null;
  if (preservesDirectResolution(existing.resolution)) return existing;

  const updated: ContradictionPair = {
    ...existing,
    lastReviewedAt: new Date().toISOString(),
    resolution: undefined,
    deferredUntil,
  };

  const filePath = pairPath(memoryDir, pairId);
  writePairFile(filePath, updated);

  return updated;
}

/**
 * Check whether a pair's referenced memories have changed since detection,
 * which should override cooldown.
 */
export function memoryHashesChanged(
  _memoryDir: string,
  pair: ContradictionPair,
  getCurrentHash: (memoryId: string) => string | null,
): boolean {
  if (!pair.memoryContentHashes) return false;

  for (const memoryId of pair.memoryIds) {
    const previousHash = pair.memoryContentHashes[memoryId];
    if (typeof previousHash !== "string") continue;

    const currentHash = getCurrentHash(memoryId);
    if (currentHash !== null && currentHash !== previousHash) return true;
  }

  return false;
}
