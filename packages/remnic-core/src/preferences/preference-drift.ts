
import path from "node:path";
import type { MemoryFile, MemoryStatus, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import type { LocalLlmClient } from "../local-llm.js";
import type { FallbackLlmClient } from "../fallback-llm.js";
import type { SemanticDedupHit, SemanticDedupLookup } from "../dedup/semantic.js";
import {
  judgeContradictionPairs,
  type ContradictionJudgeInput,
  type ContradictionJudgeResult,
} from "../contradiction/contradiction-judge.js";
import {
  computeMemoryContentHash,
  writePairs,
  type ContradictionPair,
} from "../contradiction/contradiction-review.js";
import { resolveScanStorage, type ScanStorageResolution } from "../contradiction/contradiction-scan.js";
import { bumpMemoryCorpusVersionForDir } from "../memory-corpus-version.js";
import { composeMemoryEnvelope } from "../write-envelope.js";
import { readJsonFile, writeJsonFileAtomic } from "../json-store.js";
import { log } from "../logger.js";

const DRIFT_ACTOR = "preference-drift";
const DRIFT_RULE_VERSION = "preference-drift:1";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Evidence hits fetched per preference. Bounded so one scan cannot fan out. */
const EVIDENCE_LOOKUP_LIMIT = 5;

export type PreferenceDriftClassification =
  | "corroborated"
  | "stale"
  | "drifted"
  | "skipped";

export type PreferenceDriftSkipReason =
  | "backend_unavailable"
  | "verification_unavailable";

export interface PreferenceDriftEvidence {
  memoryId: string;
  /** Similarity score reported by the evidence lookup. */
  score: number;
  /** `updated` (or `created`) of the evidence memory, ISO 8601. */
  observedAt: string;
}

export interface PreferenceDriftFinding {
  memoryId: string;
  classification: PreferenceDriftClassification;
  /** Set only for `classification: "skipped"`. */
  skipped?: PreferenceDriftSkipReason;
  /** Age of the preference in whole days at the run instant. */
  ageDays: number;
  /** Existing `lastCorroborated` stamp, or null when never corroborated. */
  lastCorroborated: string | null;
  reason: string;
  evidence: PreferenceDriftEvidence[];
  /** Review pair id opened for a `drifted` finding in apply mode. */
  reviewPairId?: string;
}

export interface PreferenceDriftReport {
  schemaVersion: 1;
  generatedAt: string;
  mode: "shadow" | "apply";
  namespace?: string;
  /** Active preferences examined after the min-age filter and per-run cap. */
  scanned: number;
  /** Active preferences that passed the category/status filter before the cap. */
  eligible: number;
  findings: PreferenceDriftFinding[];
  counts: Record<PreferenceDriftClassification, number>;
  /** Frontmatter stamps + review items actually written. Always 0 in shadow mode. */
  appliedCount: number;
  reviewItemsOpened: number;
  elapsedMs: number;
  skippedReason?: "drift_disabled" | "scan_disabled";
}

export interface PreferenceDriftMarker {
  schemaVersion: 1;
  lastRunAt: string;
  lastApplyAt: string | null;
  appliedCount: number;
}

export interface PreferenceDriftDependencies {
  storage: StorageManager;
  config: PluginConfig;
  memoryDir: string;
  /** Pre-built evidence lookup. Superseded by `embeddingLookupFactory`. */
  embeddingLookup?: SemanticDedupLookup;
  /** Builds a namespace-scoped evidence lookup from the scan's own storage. */
  embeddingLookupFactory?: (storage: StorageManager) => SemanticDedupLookup | undefined;
  storageForNamespace?: (
    namespace: string | undefined,
  ) => StorageManager | ScanStorageResolution | Promise<StorageManager | ScanStorageResolution>;
  localLlm: LocalLlmClient | null;
  fallbackLlm: FallbackLlmClient | null;
  namespace?: string;
  /** When true (and `driftDetection.enabled`), stamps and review items are written. */
  apply?: boolean;
  now?: Date;
}

function driftMarkerPath(memoryDir: string): string {
  return path.join(memoryDir, "state", "preference-drift.json");
}

/** Read the last-run marker. Absent marker (or shadow-only history) → null apply timestamp. */
export async function readPreferenceDriftMarker(
  memoryDir: string,
): Promise<PreferenceDriftMarker | null> {
  try {
    const raw = await readJsonFile(driftMarkerPath(memoryDir));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.lastRunAt !== "string") return null;
    return {
      schemaVersion: 1,
      lastRunAt: m.lastRunAt,
      lastApplyAt: typeof m.lastApplyAt === "string" ? m.lastApplyAt : null,
      appliedCount: typeof m.appliedCount === "number" ? m.appliedCount : 0,
    };
  } catch {
    return null;
  }
}

function tsMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const CANDIDATE_STATUSES: Partial<Record<MemoryStatus, true>> = { active: true };

function compareCandidates(a: MemoryFile, b: MemoryFile): number {
  const aMs = tsMs(a.frontmatter.created) ?? tsMs(a.frontmatter.updated) ?? 0;
  const bMs = tsMs(b.frontmatter.created) ?? tsMs(b.frontmatter.updated) ?? 0;
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  const aId = a.frontmatter.id ?? "";
  const bId = b.frontmatter.id ?? "";
  if (aId !== bId) return aId < bId ? -1 : 1;
  return 0;
}

type EvidenceResult =
  | { ok: true; hits: PreferenceDriftEvidence[]; hitMemories: MemoryFile[] }
  | { ok: false; reason: "backend_unavailable" };

async function gatherEvidence(
  preference: MemoryFile,
  lookup: SemanticDedupLookup,
  byId: ReadonlyMap<string, MemoryFile>,
  windowStartMs: number,
  nowMs: number,
): Promise<EvidenceResult> {
  let raw: SemanticDedupHit[];
  try {
    raw = await lookup(preference.content, EVIDENCE_LOOKUP_LIMIT);
  } catch (err) {
    log.debug("[preference-drift] evidence lookup failed", {
      memoryId: preference.frontmatter.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "backend_unavailable" };
  }

  const hits: PreferenceDriftEvidence[] = [];
  const hitMemories: MemoryFile[] = [];
  for (const hit of raw) {
    if (hit.id === preference.frontmatter.id) continue;
    const memory = byId.get(hit.id);
    if (!memory) continue;
    const observedMs = tsMs(memory.frontmatter.updated) ?? tsMs(memory.frontmatter.created);
    if (observedMs === null) continue;
    if (observedMs < windowStartMs || observedMs >= nowMs) continue;
    hits.push({
      memoryId: hit.id,
      score: hit.score,
      observedAt: memory.frontmatter.updated ?? memory.frontmatter.created ?? "",
    });
    hitMemories.push(memory);
  }
  return { ok: true, hits, hitMemories };
}

/**
 * Map judge verdicts over a preference's evidence to a drift classification.
 *
 * - `contradicts` on any hit wins: the preference has drifted.
 * - `duplicates` means the evidence restates the preference → corroborated.
 * - `independent` is evidence about something else, so it corroborates
 *   nothing; with no better verdict the preference is stale.
 * - `needs-user` (which is also what the judge returns when no LLM is
 *   reachable) leaves the question genuinely unanswered. Stamping
 *   `lastCorroborated` would assert something unverified and stamping `stale`
 *   would contradict the evidence we did find, so the honest outcome is
 *   `skipped: verification_unavailable`.
 */
function classifyFromVerdicts(
  verdicts: readonly ContradictionJudgeResult[],
): { classification: PreferenceDriftClassification; skipped?: PreferenceDriftSkipReason; reason: string; driftedAgainst?: string } {
  const contradiction = verdicts.find((v) => v.verdict === "contradicts");
  if (contradiction) {
    return {
      classification: "drifted",
      reason: `recent evidence points away from this preference: ${contradiction.rationale}`,
      driftedAgainst: contradiction.memoryIdB,
    };
  }
  const restatement = verdicts.find((v) => v.verdict === "duplicates");
  if (restatement) {
    return {
      classification: "corroborated",
      reason: `recent evidence restates this preference: ${restatement.rationale}`,
    };
  }
  if (verdicts.some((v) => v.verdict === "needs-user")) {
    return {
      classification: "skipped",
      skipped: "verification_unavailable",
      reason: "recent evidence found but no judge verdict was available to classify it",
    };
  }
  return {
    classification: "stale",
    reason: "recent evidence is independent of this preference — no corroboration either way",
  };
}

/**
 * Run one preference-drift pass over a namespace.
 *
 * Shadow mode (the default) performs NO writes — not even the run marker.
 * Applying requires `apply: true` AND `driftDetection.enabled: true`.
 */
export async function runPreferenceDriftScan(
  deps: PreferenceDriftDependencies,
): Promise<PreferenceDriftReport> {
  const startTime = Date.now();
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const mode: "shadow" | "apply" = deps.apply === true ? "apply" : "shadow";
  const cfg = deps.config.driftDetection;

  const emptyCounts: Record<PreferenceDriftClassification, number> = {
    corroborated: 0,
    stale: 0,
    drifted: 0,
    skipped: 0,
  };

  if (cfg?.enabled !== true) {
    return {
      schemaVersion: 1,
      generatedAt: nowIso,
      mode,
      scanned: 0,
      eligible: 0,
      findings: [],
      counts: emptyCounts,
      appliedCount: 0,
      reviewItemsOpened: 0,
      elapsedMs: Date.now() - startTime,
      skippedReason: "drift_disabled",
    };
  }
  if (cfg.maxCandidatesPerRun === 0) {
    return {
      schemaVersion: 1,
      generatedAt: nowIso,
      mode,
      scanned: 0,
      eligible: 0,
      findings: [],
      counts: emptyCounts,
      appliedCount: 0,
      reviewItemsOpened: 0,
      elapsedMs: Date.now() - startTime,
      skippedReason: "scan_disabled",
    };
  }

  const { storage, namespace } = await resolveScanStorage(deps, deps.namespace?.trim() || undefined);
  const lookup = deps.embeddingLookupFactory
    ? deps.embeddingLookupFactory(storage)
    : deps.embeddingLookup;

  let all: MemoryFile[];
  try {
    all = await storage.readAllMemories();
  } catch (err) {
    log.warn(
      `[preference-drift] failed to read memories: ${err instanceof Error ? err.message : String(err)}`,
    );
    all = [];
  }

  const byId = new Map<string, MemoryFile>();
  for (const m of all) {
    const id = m.frontmatter.id;
    if (typeof id === "string" && id.length > 0) byId.set(id, m);
  }

  const minAgeMs = cfg.minAgeDays * DAY_MS;
  const eligible = all.filter((m) => {
    const fm = m.frontmatter;
    if (fm.category !== "preference") return false;
    if (CANDIDATE_STATUSES[fm.status ?? "active"] !== true) return false;
    if (typeof fm.id !== "string" || fm.id.length === 0) return false;
    if (!m.content || m.content.trim().length === 0) return false;
    const bornMs = tsMs(fm.created) ?? tsMs(fm.updated);
    if (bornMs === null) return false;
    return nowMs - bornMs >= minAgeMs;
  });

  const candidates = [...eligible].sort(compareCandidates).slice(0, cfg.maxCandidatesPerRun);

  const report: PreferenceDriftReport = {
    schemaVersion: 1,
    generatedAt: nowIso,
    mode,
    namespace,
    scanned: candidates.length,
    eligible: eligible.length,
    findings: [],
    counts: { ...emptyCounts },
    appliedCount: 0,
    reviewItemsOpened: 0,
    elapsedMs: 0,
  };

  const windowStartMs = nowMs - cfg.lookbackDays * DAY_MS;
  const judgeCache = new Map<string, ContradictionJudgeResult>();
  const driftedPairs: Array<{ preference: MemoryFile; evidenceId: string; finding: PreferenceDriftFinding; rationale: string; confidence: number }> = [];
  const stamps: Array<{ memory: MemoryFile; patch: { driftState?: "stale"; lastCorroborated?: string }; reasonCode: string }> = [];

  for (const preference of candidates) {
    const bornMs = tsMs(preference.frontmatter.created) ?? tsMs(preference.frontmatter.updated) ?? nowMs;
    const finding: PreferenceDriftFinding = {
      memoryId: preference.frontmatter.id,
      classification: "stale",
      ageDays: Math.floor((nowMs - bornMs) / DAY_MS),
      lastCorroborated: preference.frontmatter.lastCorroborated ?? null,
      reason: "",
      evidence: [],
    };

    if (!lookup) {
      finding.classification = "skipped";
      finding.skipped = "backend_unavailable";
      finding.reason = "no evidence lookup is configured, so corroboration cannot be checked";
      report.findings.push(finding);
      report.counts.skipped += 1;
      continue;
    }

    const evidence = await gatherEvidence(preference, lookup, byId, windowStartMs, nowMs);
    if (!evidence.ok) {
      finding.classification = "skipped";
      finding.skipped = evidence.reason;
      finding.reason = "evidence lookup backend was unavailable — not classified as stale";
      report.findings.push(finding);
      report.counts.skipped += 1;
      continue;
    }
    finding.evidence = evidence.hits;

    if (evidence.hits.length === 0) {
      finding.classification = "stale";
      finding.reason = `no corroborating evidence in the last ${cfg.lookbackDays} days`;
      report.findings.push(finding);
      report.counts.stale += 1;
      stamps.push({ memory: preference, patch: { driftState: "stale" }, reasonCode: "drift_stale" });
      continue;
    }

    const judgeInputs: ContradictionJudgeInput[] = evidence.hitMemories.map((hit) => ({
      memoryIdA: preference.frontmatter.id,
      memoryIdB: hit.frontmatter.id,
      textA: preference.content,
      textB: hit.content,
      categoryA: preference.frontmatter.category,
      categoryB: hit.frontmatter.category,
    }));
    const judged = await judgeContradictionPairs(
      judgeInputs,
      deps.config,
      deps.localLlm,
      deps.fallbackLlm,
      judgeCache,
    );
    const orderedVerdicts: ContradictionJudgeResult[] = [];
    for (const input of judgeInputs) {
      for (const result of judged.results.values()) {
        if (result.memoryIdA === input.memoryIdA && result.memoryIdB === input.memoryIdB) {
          orderedVerdicts.push(result);
          break;
        }
      }
    }

    const outcome = classifyFromVerdicts(orderedVerdicts);
    finding.classification = outcome.classification;
    finding.reason = outcome.reason;
    if (outcome.skipped) finding.skipped = outcome.skipped;
    report.findings.push(finding);
    report.counts[outcome.classification] += 1;

    if (outcome.classification === "corroborated") {
      stamps.push({
        memory: preference,
        patch: { lastCorroborated: nowIso, driftState: undefined },
        reasonCode: "drift_corroborated",
      });
    } else if (outcome.classification === "stale") {
      stamps.push({ memory: preference, patch: { driftState: "stale" }, reasonCode: "drift_stale" });
    } else if (outcome.classification === "drifted" && outcome.driftedAgainst) {
      const verdict = orderedVerdicts.find((v) => v.verdict === "contradicts");
      driftedPairs.push({
        preference,
        evidenceId: outcome.driftedAgainst,
        finding,
        rationale: verdict?.rationale ?? outcome.reason,
        confidence: verdict?.confidence ?? 0,
      });
    }
  }

  if (mode === "shadow") {
    report.elapsedMs = Date.now() - startTime;
    return report;
  }

  let writes = 0;
  for (const stamp of stamps) {
    try {
      await storage.writeMemoryFrontmatter(stamp.memory, { ...stamp.patch, updated: nowIso }, {
        at: now,
        actor: DRIFT_ACTOR,
        reasonCode: stamp.reasonCode,
        ruleVersion: DRIFT_RULE_VERSION,
      });
      writes += 1;
      report.appliedCount += 1;
    } catch (err) {
      log.warn(
        `[preference-drift] stamp ${stamp.reasonCode} on ${stamp.memory.frontmatter.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (driftedPairs.length > 0) {
    const queueEntries: Array<Omit<ContradictionPair, "pairId"> & { memoryIds: [string, string] }> =
      driftedPairs.map((d) => ({
        memoryIds: [d.preference.frontmatter.id, d.evidenceId],
        kind: "preference-drift",
        verdict: "contradicts",
        rationale: d.rationale,
        confidence: d.confidence,
        detectedAt: nowIso,
        memoryContentHashes: {
          [d.preference.frontmatter.id]: computeMemoryContentHash(
            d.preference.content,
            d.preference.frontmatter.category,
          ),
        },
        namespace,
      }));
    const written = writePairs(deps.memoryDir, queueEntries);
    report.reviewItemsOpened = written.length;
    report.appliedCount += written.length;
    for (const entry of written) {
      const match = driftedPairs.find((d) => d.preference.frontmatter.id === entry.memoryIds[0]);
      if (match) match.finding.reviewPairId = entry.pairId;
    }
  }

  if (writes > 0) {
    bumpMemoryCorpusVersionForDir(storage.dir, { indexedText: false });
    if (storage.dir !== deps.memoryDir) {
      bumpMemoryCorpusVersionForDir(deps.memoryDir, { indexedText: false });
    }
  }
  try {
    await writeJsonFileAtomic(driftMarkerPath(deps.memoryDir), {
      schemaVersion: 1,
      lastRunAt: nowIso,
      lastApplyAt: nowIso,
      appliedCount: report.appliedCount,
    } satisfies PreferenceDriftMarker);
  } catch (err) {
    log.warn(
      `[preference-drift] failed to persist run marker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  report.elapsedMs = Date.now() - startTime;
  return report;
}


export interface PreferenceDriftResolutionOptions {
  /** Replacement preference text. Required for `supersede`. */
  mergedContent?: string;
  /** Fires after a resolution leaves a durable memory mutation in the namespace. */
  onMemoryWritten?: (namespace: string | undefined, storageDir: string) => void;
  now?: Date;
}

export interface PreferenceDriftResolutionResult {
  affectedIds: string[];
  message: string;
}

/**
 * Execute a `kind: "preference-drift"` resolution verb.
 *
 * The first memory id on the item is the aging preference; the second is the
 * evidence that pointed away from it. Only the preference is ever mutated —
 * the evidence memory is a witness, not a target.
 *
 * - `keep`      — the preference still holds: stamp `lastCorroborated`, clear
 *                 `driftState`.
 * - `supersede` — write the corrected preference and retire the old one
 *                 through the normal supersession path.
 * - `archive`   — demote the preference to `archived`. Demotion, never
 *                 deletion; page versioning snapshots the overwrite.
 *
 * Callers resolve the pair record itself (`resolvePair`); this function owns
 * only the memory-side effects.
 */
export async function resolvePreferenceDrift(
  storage: StorageManager,
  pair: Pick<ContradictionPair, "pairId" | "memoryIds" | "namespace">,
  verb: "keep" | "supersede" | "archive",
  options: PreferenceDriftResolutionOptions = {},
): Promise<PreferenceDriftResolutionResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const preferenceId = pair.memoryIds[0];
  const preference = await storage.getMemoryById(preferenceId);
  if (!preference) {
    return { affectedIds: [], message: `Preference ${preferenceId} not found; not resolving ${pair.pairId}` };
  }

  const touched = (): void => {
    try {
      options.onMemoryWritten?.(pair.namespace, storage.dir);
    } catch (err) {
      log.warn(
        `[preference-drift] catalog write touch failed for ${pair.pairId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  if (verb === "keep") {
    await storage.writeMemoryFrontmatter(
      preference,
      { lastCorroborated: nowIso, driftState: undefined, updated: nowIso },
      { at: now, actor: DRIFT_ACTOR, reasonCode: "drift_kept", ruleVersion: DRIFT_RULE_VERSION },
    );
    bumpMemoryCorpusVersionForDir(storage.dir, { indexedText: false });
    touched();
    return { affectedIds: [preferenceId], message: `Preference ${preferenceId} confirmed still current` };
  }

  if (verb === "archive") {
    const archivedPath = await storage.archiveMemory(preference, {
      at: now,
      actor: DRIFT_ACTOR,
      reasonCode: "drift_archived",
      ruleVersion: DRIFT_RULE_VERSION,
      relatedMemoryIds: [pair.memoryIds[1]],
    });
    if (archivedPath === null) {
      return { affectedIds: [], message: `Preference ${preferenceId} could not be archived; not resolving` };
    }
    bumpMemoryCorpusVersionForDir(storage.dir);
    touched();
    return { affectedIds: [preferenceId], message: `Preference ${preferenceId} archived` };
  }

  const replacementText = options.mergedContent?.trim();
  if (!replacementText) {
    return {
      affectedIds: [],
      message: "supersede requires mergedContent carrying the updated preference; no memories changed",
    };
  }

  const envelope = composeMemoryEnvelope(
    {
      content: replacementText,
      category: "preference",
      confidence: preference.frontmatter.confidence ?? 0.8,
      tags: ["preference-drift", "supersede"],
      entityRef: preference.frontmatter.entityRef,
    },
    { source: DRIFT_ACTOR },
    { salvage: true },
  );
  if (envelope.salvageNotes.length > 0) {
    log.warn(`[preference-drift] supersede write salvaged invalid fields: ${envelope.salvageNotes.join("; ")}`);
  }
  const written = await storage.writeSealedMemory(envelope, {
    actor: DRIFT_ACTOR,
    lineage: [preferenceId],
    derivedVia: "update",
  });
  if (written.tombstoneBlocked) {
    return {
      affectedIds: [],
      message: `Replacement preference for ${pair.pairId} was tombstone-blocked (pending_review); not resolving — original kept active`,
    };
  }
  const superseded = await storage.supersedeMemory(
    preferenceId,
    written.id,
    `preference drift resolved by supersede (${pair.pairId})`,
    undefined,
    { actor: DRIFT_ACTOR },
  );
  bumpMemoryCorpusVersionForDir(storage.dir);
  touched();
  if (!superseded) {
    return {
      affectedIds: [written.id],
      message: `Replacement ${written.id} written but superseding ${preferenceId} failed; both remain — re-run resolution`,
    };
  }
  return {
    affectedIds: [preferenceId, written.id],
    message: `Preference ${preferenceId} superseded by ${written.id}`,
  };
}
