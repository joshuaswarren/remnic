/**
 * Memory subject: user-centric vs agent-centric classification (issue #2372).
 *
 * Scope says WHERE a memory lives; subject says WHOM it is about — and that
 * is what determines where it may safely go. `user` memories model one
 * person (preferences, relationships, biography, moments, commitments);
 * `agent` memories model how to operate (procedures, principles,
 * tool-usage lessons, debugging strategies, environment facts with no
 * personal content).
 *
 * This module owns, in one place:
 *  - the deterministic write-time classification (category defaults with an
 *    optional extractor override),
 *  - the promotion guard shared by EVERY promotion surface (spaces promote
 *    AND scope-profile promotion targets — AGENTS.md §27 uniform gating),
 *  - read-only promotion-candidate surfacing (reuse-signaled agent-subject
 *    memories with no equivalent in the target layer), and
 *  - the deterministic backfill pass (shadow/apply, no LLM).
 */

import { ContentHashIndex } from "./storage/content-hash-index.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import type { McpTool } from "./access-mcp.js";
import type { MemoryCategory, MemoryFile, MemorySubject, SubjectGuardMode } from "./types.js";

export const SUBJECT_VALUES = ["user", "agent"] as const;
export const SUBJECT_GUARD_MODES = ["off", "warn", "enforce"] as const;

/** The CLI / per-call override that permits a user-subject promotion. */
export const SUBJECT_GUARD_OVERRIDE_FLAG = "--allow-user-subject";

export function isMemorySubject(value: unknown): value is MemorySubject {
  return value === "user" || value === "agent";
}

export function isSubjectGuardMode(value: unknown): value is SubjectGuardMode {
  return value === "off" || value === "warn" || value === "enforce";
}

// ---------------------------------------------------------------------------
// Write-time classification
// ---------------------------------------------------------------------------

/**
 * Deterministic category defaults (issue #2372 §1):
 *   user — preference, relationship, moment, commitment
 *   agent — procedure, principle, skill
 * Every other category has no default; the resolver falls back to `"user"`,
 * the most-restrictive value (Review Prevention Checklist §36 — an unsafe
 * enum default is never the convenient one).
 */
const SUBJECT_CATEGORY_DEFAULTS: Partial<Record<MemoryCategory, MemorySubject>> = {
  preference: "user",
  relationship: "user",
  moment: "user",
  commitment: "user",
  procedure: "agent",
  principle: "agent",
  skill: "agent",
};

export function subjectDefaultForCategory(category: MemoryCategory): MemorySubject {
  return SUBJECT_CATEGORY_DEFAULTS[category] ?? "user";
}

/**
 * Resolve the write-time subject: the extractor's single-token value when it
 * emitted a valid one, else the category default. Never reclassifies on read.
 */
export function resolveWriteSubject(
  category: MemoryCategory,
  extractorValue: unknown,
): MemorySubject {
  return isMemorySubject(extractorValue) ? extractorValue : subjectDefaultForCategory(category);
}

// ---------------------------------------------------------------------------
// Promotion guard (uniform across every promotion surface — §27)
// ---------------------------------------------------------------------------

/** Scope-profile promotion targets that are shared layers. */
export function isSharedPromotionTarget(target: string): boolean {
  return target === "teamProject" || target === "serverShared";
}

export interface SubjectGuardDecision {
  action: "allow" | "warn" | "reject";
  /** Effective subject — an absent subject resolves to "user" (fail closed, §36). */
  effectiveSubject: MemorySubject;
  /** Structured reason; empty string when action === "allow". */
  reason: string;
  /** The override that permits this promotion when action is reject/warn. */
  override: typeof SUBJECT_GUARD_OVERRIDE_FLAG;
}

/**
 * Evaluate one promotion against the subject guard. Shared by the spaces
 * promotion workflow and the scope-profile promotion targets so the two
 * surfaces cannot drift (issue #2372 acceptance 2, AGENTS.md §27).
 *
 *  - mode "off", non-shared targets, agent-subject memories, and explicit
 *    `allowUserSubject` overrides all allow.
 *  - a `user`-subject memory (or a memory with NO subject — fail closed)
 *    promoted to a shared layer warns under "warn" and rejects under
 *    "enforce", with the override named in the reason (§39: never a silent
 *    accept).
 */
export function evaluateSubjectGuard(params: {
  subject: MemorySubject | undefined;
  sharedTarget: boolean;
  mode: SubjectGuardMode;
  allowUserSubject?: boolean;
}): SubjectGuardDecision {
  const effectiveSubject = params.subject ?? "user";
  const base = { effectiveSubject, override: SUBJECT_GUARD_OVERRIDE_FLAG } as const;
  if (params.mode === "off" || !params.sharedTarget || effectiveSubject === "agent") {
    return { action: "allow", reason: "", ...base };
  }
  if (params.allowUserSubject === true) {
    return { action: "allow", reason: "user-subject promotion override accepted", ...base };
  }
  return {
    action: params.mode === "enforce" ? "reject" : "warn",
    reason:
      `subject=${effectiveSubject} memory targets a shared layer (team/server); ` +
      `user-subject memories model one person and must not be shared; ` +
      `override with ${SUBJECT_GUARD_OVERRIDE_FLAG} (allowUserSubject: true) if intended`,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Promotion candidates (read-only surfacing — no auto-promotion)
// ---------------------------------------------------------------------------

export type PromotionReuseSignal = "reinforcement" | "memory_worth" | "access_count";

export interface PromotionCandidate {
  id: string;
  path: string;
  category: MemoryCategory;
  content: string;
  accessCount: number;
  reinforcementCount: number;
  mwSuccess: number;
  mwFail: number;
  reuseSignal: PromotionReuseSignal;
}

/** Default reuse-signal threshold for `accessCount` (config `promotionCandidates.minAccessCount`). */
export const PROMOTION_CANDIDATES_DEFAULT_MIN_ACCESS = 3;

/** Canonical content form for target-equivalence checks (same normalize pipeline as dedup). */
export function promotionCandidateKey(content: string): string {
  return ContentHashIndex.normalizeContent(sanitizeMemoryContent(content).text);
}

/**
 * List `subject: "agent"` memories that (a) are active, (b) show a reuse
 * signal (`reinforcement_count > 0` OR `mw_success > mw_fail` OR
 * `accessCount >= minAccessCount`), and (c) have no equivalent already in
 * the promotion target layer (content-hash check via the dedup normalizer).
 * Pure over the two memory lists; callers resolve namespaces.
 */
export function computePromotionCandidates(options: {
  memories: MemoryFile[];
  targetMemories: MemoryFile[];
  minAccessCount: number;
  limit?: number;
}): PromotionCandidate[] {
  if (!Number.isFinite(options.minAccessCount) || options.minAccessCount < 0) {
    throw new Error(
      `computePromotionCandidates: minAccessCount must be a non-negative number (got ${String(options.minAccessCount)})`,
    );
  }
  const targetKeys = new Set(
    options.targetMemories.map((m) => promotionCandidateKey(m.content ?? "")),
  );
  const out: PromotionCandidate[] = [];
  for (const memory of options.memories) {
    const fm = memory.frontmatter;
    if (fm.subject !== "agent") continue;
    if ((fm.status ?? "active") !== "active") continue;
    const reinforcementCount = fm.reinforcement_count ?? 0;
    const mwSuccess = fm.mw_success ?? 0;
    const mwFail = fm.mw_fail ?? 0;
    const accessCount = fm.accessCount ?? 0;
    let reuseSignal: PromotionReuseSignal | undefined;
    if (reinforcementCount > 0) reuseSignal = "reinforcement";
    else if (mwSuccess > mwFail) reuseSignal = "memory_worth";
    else if (accessCount >= options.minAccessCount) reuseSignal = "access_count";
    if (reuseSignal === undefined) continue;
    if (targetKeys.has(promotionCandidateKey(memory.content ?? ""))) continue;
    out.push({
      id: fm.id,
      path: memory.path,
      category: fm.category,
      content: memory.content ?? "",

      accessCount,
      reinforcementCount,
      mwSuccess,
      mwFail,
      reuseSignal,
    });
    if (options.limit !== undefined && out.length >= options.limit) break;
  }
  return out;
}

export interface PromotionCandidatesResult {
  namespace: string;
  targetNamespace: string;
  minAccessCount: number;
  candidates: PromotionCandidate[];
}

export const PROMOTION_CANDIDATES_MCP_TOOLS: McpTool[] = [
  {
    // Registered as `engram.promotion_candidates`; `withToolAliases` emits
    // the canonical `remnic.promotion_candidates` alias (dual-naming).
    name: "engram.promotion_candidates",
    description:
      "List agent-subject memories in the caller's namespace that are active, show a reuse signal (reinforcement_count > 0, mw_success > mw_fail, or accessCount >= threshold), and have no equivalent in the promotion target layer (default: the shared namespace). Read-only report; promotion itself uses the existing promotion commands (issue #2372).",
    inputSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          description:
            "Optional source namespace. Enforced against the caller's principal the same way recall is.",
        },
        targetNamespace: {
          type: "string",
          description: "Promotion target layer checked for existing equivalents. Default: the shared namespace.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum candidates to return (default 20, max 100).",
        },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Backfill (governance shadow/apply — deterministic rules only, no LLM)
// ---------------------------------------------------------------------------

/**
 * Storage surface the backfill needs (mirrors pattern-reinforcement's
 * structural interface so tests can pass an in-memory stub).
 * `writeMemoryFrontmatter` invalidates caches and syncs the fact-hash index
 * (§25/§31), so a stamped memory is immediately discoverable.
 */
export interface SubjectBackfillStorage {
  readAllMemories(): Promise<MemoryFile[]>;
  writeMemoryFrontmatter(memory: MemoryFile, patch: Partial<MemoryFile["frontmatter"]>): Promise<boolean>;
}

export interface SubjectBackfillReport {
  mode: "shadow" | "apply";
  scanned: number;
  stamped: number;
  alreadyStamped: number;
  stamps: Array<{
    id: string;
    category: MemoryCategory;
    subject: MemorySubject;
    path: string;
  }>;
}

/**
 * Stamp `subject` on memories that have none, using ONLY the deterministic
 * category defaults (never an LLM, never reclassifying an existing subject —
 * issue #2372 §1.3). `shadow` reports the intended stamps without writing;
 * `apply` writes through `writeMemoryFrontmatter`, which invalidates the
 * memory caches and re-syncs the fact-hash index.
 */
export async function backfillMemorySubjects(options: {
  storage: SubjectBackfillStorage;
  mode: "shadow" | "apply";
}): Promise<SubjectBackfillReport> {
  const memories = await options.storage.readAllMemories();
  const report: SubjectBackfillReport = {
    mode: options.mode,
    scanned: memories.length,
    stamped: 0,
    alreadyStamped: 0,
    stamps: [],
  };
  for (const memory of memories) {
    if (memory.frontmatter.subject !== undefined) {
      report.alreadyStamped++;
      continue;
    }
    const subject = subjectDefaultForCategory(memory.frontmatter.category);
    report.stamps.push({
      id: memory.frontmatter.id,
      category: memory.frontmatter.category,
      subject,
      path: memory.path,
    });
    if (options.mode === "apply") {
      await options.storage.writeMemoryFrontmatter(memory, { subject });
    }
    report.stamped++;
  }
  return report;
}
