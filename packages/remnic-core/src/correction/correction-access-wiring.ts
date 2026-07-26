/**
 * correction/correction-access-wiring.ts — wires the CorrectionService to the
 * orchestrator's storage / tombstone / search surfaces (issue #1580 PR 3).
 *
 * Keeps the access-service god-file thin: the service calls `createCorrectionService`
 * with two namespace-policy callbacks and gets back a fully-wired
 * {@link CorrectionService}. All the heavy lifting (search, LLM classify,
 * tombstone emission, audit-record write, propagation) lives here, in a
 * dedicated module, so the only growth in access-service.ts is the four
 * one-line delegators.
 *
 * Design rules honored:
 *   - Caller-supplied namespaces are NEVER trusted raw — the service resolves
 *     them through the injected policy (rule 42).
 *   - Corrections flow through the existing storage chokepoints: writeMemory
 *     (catalog/dedup/reindex fire — rule 43), appendTombstone (#1579),
 *     writeMemoryFrontmatter (status flip + validUntil — #1578).
 *   - The LLM classify+draft adapter routes through the existing extraction
 *     engine (Responses API only, gotcha 1). On any LLM failure the adapter
 *     returns a deterministic fallback so the planner never throws (rule 13).
 */

import path from "node:path";
import { throwIfAborted } from "../abort-error.js";
import { composeMemoryEnvelope, isMemoryCategory } from "../write-envelope.js";
import { log } from "../logger.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Orchestrator } from "../orchestrator.js";
import type { MemoryFile, MemoryStatus, PluginConfig } from "../types.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import { supersessionKeysForFact } from "../temporal-supersession.js";
import { computeContentHash } from "../content-hash.js";
import { sanitizeMemoryContent } from "../sanitize.js";
import {
  CorrectionContractError,
  validateCorrectionAction,
  type CorrectionAction,
  type CorrectionOutcome,
  type CorrectionPlan,
} from "./correction-contract.js";
import {
  type LlmClassificationResult,
  type PlannerCandidate,
  type PlannerDeps,
} from "./correction-planner.js";
import { type ExecutorDeps, type ExecutorMemory } from "./correction-executor.js";
import { CorrectionService, type CorrectionServiceDeps } from "./correction-service.js";
import { resolveRecallAuxiliaryCapabilities } from "../capabilities.js";

// ---------------------------------------------------------------------------
// Public entry: build a fully-wired CorrectionService
// ---------------------------------------------------------------------------

/**
 * The two namespace-policy callbacks the access-service supplies. These are
 * the ONLY surface-area touch-points between the correction modules and the
 * access-service god-file — everything else is wired from the orchestrator.
 */
export interface CorrectionAccessWiring {
  orchestrator: Orchestrator;
  /** Resolve the AUTHORIZED namespace for a plan/apply request (write ACL). */
  resolveAuthorizedNamespace(request: {
    namespace?: string;
    sessionKey?: string;
    principal?: string;
  }): Promise<string>;
  /** Resolve the caller's READABLE namespaces (scopes the planner's search). */
  resolveReadableNamespaces(request: {
    namespace?: string;
    sessionKey?: string;
    principal?: string;
  }): readonly string[];
  /** Whether the caller may WRITE a namespace — authorizes rescope destinations. */
  canWriteNamespace(request: {
    namespace: string;
    sessionKey?: string;
    principal?: string;
  }): Promise<boolean>;
  /**
   * Optional LLM-complete callback (Responses API only — gotcha 1). When
   * absent, the planner's classify+draft step falls back to deterministic
   * mode (rule 13). The access-service wires the orchestrator's extraction
   * LLM here once it exposes a public accessor; until then the contract
   * ships with the safe fallback.
   */
  llmComplete?(request: {
    system: string;
    user: string;
  }): Promise<string>;
}

export function createCorrectionService(wiring: CorrectionAccessWiring): CorrectionService {
  const cfg = wiring.orchestrator.config;
  // parseConfig now owns these (review thread Txp): the orchestrator's config
  // carries correctionEnabled / correctionApplyRequiresConfirm /
  // correctionMaxAffected / correctionPlanTtlHours as parsed fields. The
  // loose-read helpers stay as a fallback only for tests that construct a
  // PluginConfig-shaped object without running parseConfig.
  const correctionEnabled = isCorrectionFeatureEnabled(cfg);
  const applyRequiresConfirm =
    typeof cfg.correctionApplyRequiresConfirm === "boolean"
      ? cfg.correctionApplyRequiresConfirm
      : readCorrectionFlag(cfg, "applyRequiresConfirm", true);
  const maxAffected =
    typeof cfg.correctionMaxAffected === "number" && cfg.correctionMaxAffected >= 1
      ? Math.floor(cfg.correctionMaxAffected)
      : readCorrectionNumber(cfg, "maxAffected", 10);
  const planTtlHours =
    typeof cfg.correctionPlanTtlHours === "number" && cfg.correctionPlanTtlHours > 0
      ? cfg.correctionPlanTtlHours
      : readCorrectionNumber(cfg, "planTtlHours", 24);
  const biTemporalEnabled = cfg.temporalBiTemporal === true;

  const serviceDeps: CorrectionServiceDeps = {
    policy: {
      resolveAuthorizedNamespace: (req) => wiring.resolveAuthorizedNamespace(req),
      canWriteNamespace: (req) => wiring.canWriteNamespace(req),
      readableNamespaces: (req) =>
        Promise.resolve(wiring.resolveReadableNamespaces(req)),
    },
    plannerDeps: () =>
      makePlannerDeps(wiring, { maxAffected, planTtlHours }),
    executorDeps: () => makeExecutorDeps(wiring, { biTemporalEnabled }),
    isEnabled: () => correctionEnabled,
    applyRequiresConfirm: () => applyRequiresConfirm,
  };
  return new CorrectionService(serviceDeps);
}

// ---------------------------------------------------------------------------
// Planner deps
// ---------------------------------------------------------------------------

function makePlannerDeps(
  wiring: CorrectionAccessWiring,
  opts: { maxAffected: number; planTtlHours: number },
): PlannerDeps {
  return {
    searchCorpus: async ({ text, namespaces, limit }) =>
      searchMemories(wiring, text, namespaces, limit),
    resolveTargets: async ({ targetIds, namespaces }) =>
      resolveTargetMemories(wiring, targetIds, namespaces),
    expandNeighbors: async ({ seedIds, namespaces, limit }) =>
      expandEntityNeighbors(wiring, seedIds, namespaces, limit),
    classifyAndDraft: async ({ text, candidates }) =>
      classifyAndDraft(wiring, text, candidates),
    renderDiff: async ({ candidates, actions }) =>
      renderCorrectionDiff(wiring, candidates, actions),
    storageDir: async (namespace) => (await wiring.orchestrator.getStorage(namespace)).dir,
    maxAffected: opts.maxAffected,
    planTtlHours: opts.planTtlHours,
    now: () => new Date(),
  };
}

async function searchMemories(
  wiring: CorrectionAccessWiring,
  text: string,
  namespaces: readonly string[],
  limit: number,
): Promise<PlannerCandidate[]> {
  // Tokenized keyword search (review thread OgIql): natural-language
  // corrections describe the new truth, not quote the old memory verbatim
  // ("we migrated from Postgres to MySQL" vs a memory saying "Postgres is
  // the database"). The old 32-char exact-prefix substring missed these.
  // We tokenize the correction into keywords, score each active memory by
  // keyword overlap, and return memories above a minimum threshold. This is
  // deliberately lightweight (no embedding/QMD dependency) — the planner's
  // job is to LOCATE candidates for the LLM classify+draft, not to rank with
  // the full recall pipeline.
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const scored: Array<{ m: MemoryFile; ns: string; score: number }> = [];
  for (const ns of namespaces) {
    const storage = await wiring.orchestrator.getStorage(ns);
    const all = await storage.readAllMemories();
    for (const m of all) {
      if (!isEligibleCorrectionCandidate(m)) continue;
      const hay = `${m.content} ${m.frontmatter.tags?.join(" ") ?? ""}`.toLowerCase();
      let hits = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) hits++;
      }
      if (hits === 0) continue;
      // Overlap ratio: how many query tokens the memory covers.
      scored.push({ m, ns, score: hits / tokens.length });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s, i) => toCandidate(s.m, s.ns, s.score - i * 0.01));
}

/** Tokenize correction text into lowercase search keywords (OgIql). */
function tokenize(text: string): string[] {
  const STOP = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "to", "of", "in", "on", "at", "by", "for", "with", "from", "into",
    "and", "or", "but", "not", "no", "yes", "this", "that", "these",
    "those", "it", "its", "we", "you", "i", "he", "she", "they", "them",
    "our", "your", "my", "his", "her", "their", "as", "so", "if", "then",
    "than", "too", "very", "can", "will", "just", "should", "now", "has",
    "have", "had", "do", "does", "did", "about", "which", "what", "who",
    "when", "where", "why", "how", "all", "each", "every", "both", "few",
    "more", "most", "other", "some", "such", "only", "own", "same", "up",
  ]);
  const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = raw.filter((w) => w.length >= 3 && !STOP.has(w));
  // De-dup while preserving order.
  return [...new Set(out)];
}

async function resolveTargetMemories(
  wiring: CorrectionAccessWiring,
  targetIds: readonly string[],
  namespaces: readonly string[],
): Promise<PlannerCandidate[]> {
  const out: PlannerCandidate[] = [];
  const missing: string[] = [];
  for (const id of targetIds) {
    let found: PlannerCandidate | null = null;
    for (const ns of namespaces) {
      const storage = await wiring.orchestrator.getStorage(ns);
      const m = await storage.getMemoryById(id);
      if (m) {
        found = toCandidate(m, ns, 1);
        break;
      }
    }
    if (found) out.push(found);
    else missing.push(id);
  }
  if (missing.length > 0) {
    throw new CorrectionContractError(`target memory not found: ${missing[0]}`);
  }
  return out;
}

async function expandEntityNeighbors(
  wiring: CorrectionAccessWiring,
  seedIds: readonly string[],
  namespaces: readonly string[],
  limit: number,
): Promise<PlannerCandidate[]> {
  // 1-hop entity-graph neighbors via entityRef-tagged siblings. We expand
  // across the AUTHORIZED namespaces the planner supplied (review thread PG8),
  // NOT only `config.defaultNamespace` — a correction planned in a non-default
  // writable namespace must only ever draft siblings from that same authorized
  // scope, or apply will fail as not-found / mutate a same-ID memory in the
  // wrong namespace. The conservative entityRef fallback searches every
  // readable namespace and tags each candidate with the namespace it was read
  // from; a richer graph expansion can ride on top later (rule 57 — additive).
  if (seedIds.length === 0 || limit <= 0 || namespaces.length === 0) return [];
  const out: PlannerCandidate[] = [];
  const seen = new Set<string>(seedIds);
  // Collect the seed entityRefs across every authorized namespace (a seed
  // memory may live in any of them), then surface active siblings sharing one.
  const seedRefs = new Set<string>();
  for (const ns of namespaces) {
    const storage = await wiring.orchestrator.getStorage(ns);
    const all = await storage.readAllMemories();
    for (const m of all) {
      if (seedIds.includes(m.frontmatter.id) && m.frontmatter.entityRef) {
        seedRefs.add(m.frontmatter.entityRef);
      }
    }
  }
  if (seedRefs.size === 0) return [];
  for (const ns of namespaces) {
    if (out.length >= limit) break;
    const storage = await wiring.orchestrator.getStorage(ns);
    const all = await storage.readAllMemories();
    for (const m of all) {
      if (out.length >= limit) break;
      if (seen.has(m.frontmatter.id)) continue;
      if (!isEligibleCorrectionCandidate(m)) continue;
      if (m.frontmatter.entityRef && seedRefs.has(m.frontmatter.entityRef)) {
        out.push(toCandidate(m, ns, 0.5));
        seen.add(m.frontmatter.id);
      }
    }
  }
  return out;
}

async function classifyAndDraft(
  wiring: CorrectionAccessWiring,
  text: string,
  candidates: PlannerCandidate[],
): Promise<LlmClassificationResult> {
  // Route through the injected LLM callback (Responses API only — gotcha 1).
  // On any failure (or when no callback is wired), return the deterministic
  // fallback (rule 13) — the planner never throws on an LLM outage.
  try {
    if (!wiring.llmComplete) {
      return fallbackClassification(candidates, "no LLM client available");
    }
    const user = buildClassifyPrompt(text, candidates);
    const raw = await wiring.llmComplete({ system: CLASSIFY_SYSTEM_PROMPT, user });
    return parseClassifyResponse(raw, candidates);
  } catch (err) {
    return fallbackClassification(candidates, `LLM unavailable: ${errMsg(err)}`);
  }
}

async function renderCorrectionDiff(
  _wiring: CorrectionAccessWiring,
  candidates: PlannerCandidate[],
  actions: CorrectionAction[],
): Promise<string> {
  // Render a human-readable unified-diff-style preview. We snapshot each
  // affected memory via page-versioning (reuse, don't fork — rule 23) when
  // versioning is configured; otherwise fall back to a textual summary.
  const lines: string[] = [];
  for (const action of actions) {
    const id =
      action.kind === "supersede"
        ? action.loserId
        : action.kind === "edit" || action.kind === "retract" || action.kind === "rescope"
          ? action.memoryId
          : null;
    const candidate = id ? candidates.find((c) => c.memoryId === id) : null;
    const before = candidate?.content ?? "(new)";
    const after = describeAfterState(action);
    lines.push(`--- ${id ?? "redaction-rule"} (${action.kind})`);
    lines.push(`- ${before.slice(0, 120)}`);
    lines.push(`+ ${after.slice(0, 120)}`);
  }
  return lines.join("\n");
}

function describeAfterState(action: CorrectionAction): string {
  switch (action.kind) {
    case "supersede":
      return action.replacement?.content ?? "(superseded without replacement)";
    case "edit":
      return action.patch;
    case "retract":
      return "(retracted + tombstoned)";
    case "rescope":
      return `(moved to namespace '${action.toNamespace}')`;
    case "redaction_rule":
      return `(redaction rule persisted for pattern '${action.pattern}')`;
  }
}

// ---------------------------------------------------------------------------
// Executor deps
// ---------------------------------------------------------------------------

function makeExecutorDeps(
  wiring: CorrectionAccessWiring,
  opts: { biTemporalEnabled: boolean },
): ExecutorDeps {
  return {
    getMemory: async (namespace, memoryId, abortSignal) =>
      getExecutorMemory(wiring, namespace, memoryId, abortSignal),
    writeReplacement: async (namespace, draft, abortSignal) =>
      writeReplacementMemory(wiring, namespace, draft, abortSignal),
    applyEdit: async (namespace, memoryId, patch, abortSignal) =>
      applyEditMemory(wiring, namespace, memoryId, patch, abortSignal),
    retireMemory: async (namespace, memoryId, retireOpts, abortSignal) =>
      retireMemoryFn(wiring, namespace, memoryId, retireOpts, abortSignal),
    rescopeMemory: async (namespace, memoryId, toNamespace, abortSignal) =>
      rescopeMemoryFn(wiring, namespace, memoryId, toNamespace, abortSignal),
    appendTombstone: async (namespace, input, abortSignal) =>
      appendTombstoneFn(wiring, namespace, input, abortSignal),
    registerRedactionRule: async (namespace, pattern, abortSignal) =>
      registerRedactionRuleFn(wiring, namespace, pattern, abortSignal),
    appendAuditRecord: async (namespace, record, abortSignal) =>
      appendAuditRecordFn(wiring, namespace, record, abortSignal),
    propagate: async (namespace, touchedMemoryIds, abortSignal) =>
      propagateFn(wiring, namespace, touchedMemoryIds, abortSignal),
    biTemporalEnabled: opts.biTemporalEnabled,
    now: () => new Date(),
  };
}

async function getExecutorMemory(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  abortSignal?: AbortSignal,
): Promise<ExecutorMemory | null> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const m = await storage.getMemoryById(memoryId);
  throwIfAborted(abortSignal, "correction apply aborted");
  if (!m) return null;
  return toExecutorMemory(m);
}

async function writeReplacementMemory(
  wiring: CorrectionAccessWiring,
  namespace: string,
  draft: {
    content: string;
    category?: string;
    confidence?: number;
    tags?: string[];
    entityRef?: string;
    validAt?: string;
    observedAt?: string;
    structuredAttributes?: Record<string, string>;
    supersedes?: string;
  },
  abortSignal?: AbortSignal,
): Promise<string> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  // writeMemory is the single storage chokepoint — catalog/dedup/reindex fire
  // here (rule 43). Tombstone blocking also fires here (#1579), so a
  // resurrected fact lands as pending_review rather than silently overwriting.
  // Sealed-envelope write (issue #1989 PR4): correction drafts carry
  // plan-derived (machine) field values — salvage so one malformed optional
  // field cannot make a correction unapplicable; drops are warn-logged.
  // Category is IDENTITY and stays fatal (#2022 review): default to "fact"
  // only when ABSENT (the legacy default); an explicit unrecognized value
  // must surface as a contract error, not silently change the correction's
  // meaning before it supersedes the target.
  if (draft.category !== undefined && !isMemoryCategory(draft.category)) {
    throw new CorrectionContractError(
      `correction draft carries unrecognized category ${JSON.stringify(draft.category)} — expected a valid memory category`,
    );
  }
  const draftCategory = draft.category ?? ("fact" as const);
  const draftEnvelope = composeMemoryEnvelope(
    {
      content: draft.content,
      category: draftCategory,
      confidence: draft.confidence ?? 0.9,
      tags: draft.tags ?? [],
      ...(draft.entityRef ? { entityRef: draft.entityRef } : {}),
      ...(draft.validAt ? { validAt: draft.validAt } : {}),
      ...(draft.structuredAttributes ? { structuredAttributes: draft.structuredAttributes } : {}),
    },
    { source: "correction" },
    { salvage: true },
  );
  if (draftEnvelope.salvageNotes.length > 0) {
    log.warn(`correction write salvaged invalid fields: ${draftEnvelope.salvageNotes.join("; ")}`);
  }
  throwIfAborted(abortSignal, "correction apply aborted");
  const { id, tombstoneBlocked } = await storage.writeSealedMemory(draftEnvelope, {
    ...(draft.observedAt ? { observedAt: draft.observedAt } : {}),
    ...(draft.supersedes ? { supersedes: draft.supersedes } : {}),
  });
  if (tombstoneBlocked) {
    // #1645 (review thread): the replacement content matched a tombstone, so it
    // landed pending_review (non-active). Returning the id would let the
    // executor record the supersede as applied and Phase 2 retire the loser
    // with `supersededBy` pointing at a non-active replacement — stranding
    // the fact behind a tombstone. Fail the correction cleanly instead.
    throw new CorrectionContractError(
      `correction replacement was tombstone-blocked (pending_review ${id}) — cannot supersede with a non-active replacement`,
    );
  }
  return id;
}

async function applyEditMemory(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  patch: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const existing = await storage.getMemoryById(memoryId);
  throwIfAborted(abortSignal, "correction apply aborted");
  if (!existing) throw new CorrectionContractError(`memory not found for edit: ${memoryId}`);
  // Apply the patch by overwriting content through the storage chokepoint.
  // The StorageManager's writeMemoryFrontmatter snapshots the prior version
  // internally when page-versioning is configured (issue #371), so every edit
  // is revertable without the correction layer forking versioning logic.
  //
  // #1672 item 3: recompute the contentHash from the patched body so the
  // dedup index + tombstone exact tier match the NEW content. writeMemory
  // computes this at write time, but writeMemoryFrontmatter preserves the
  // prior frontmatter hash — without this the hash no longer matches the
  // patched body and a later re-extraction of the same fact dedup-misses.
  const contentHashForPatch =
    existing.frontmatter.category === "fact"
      ? computeContentHash(sanitizeMemoryContent(patch).text)
      : undefined;
  throwIfAborted(abortSignal, "correction apply aborted");
  await storage.writeMemoryFrontmatter(
    { ...existing, content: patch },
    {
      updated: new Date().toISOString(),
      ...(contentHashForPatch ? { contentHash: contentHashForPatch } : {}),
    },
  );
  return memoryId;
}

async function retireMemoryFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  opts: { status: "superseded" | "retracted"; supersededBy?: string; validUntil?: string },
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const memory = await storage.getMemoryById(memoryId);
  throwIfAborted(abortSignal, "correction apply aborted");
  if (!memory) throw new CorrectionContractError(`memory not found for retire: ${memoryId}`);
  const storageStatus: MemoryStatus = opts.status === "retracted" ? "forgotten" : "superseded";
  throwIfAborted(abortSignal, "correction apply aborted");
  await storage.writeMemoryFrontmatter(memory, {
    status: storageStatus,
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
    ...(opts.status === "superseded" ? { supersededAt: new Date().toISOString() } : {}),
    ...(opts.validUntil ? { invalid_at: opts.validUntil } : {}),
  });
}

async function rescopeMemoryFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  toNamespace: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  // The destination namespace is re-authorized by the service before the
  // executor runs; here we perform the move atomically (write-then-unlink).
  throwIfAborted(abortSignal, "correction apply aborted");
  const sourceStorage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const memory = await sourceStorage.getMemoryById(memoryId);
  throwIfAborted(abortSignal, "correction apply aborted");
  if (!memory) throw new CorrectionContractError(`memory not found for rescope: ${memoryId}`);
  if (memory.frontmatter.status && memory.frontmatter.status !== "active") {
    // Don't copy a stale source: rescoping a superseded/retracted/archived
    // memory duplicates outdated content into the destination (thread Ohjwb).
    throw new CorrectionContractError(
      `cannot rescope memory ${memoryId}: source is ${memory.frontmatter.status}, not active`,
    );
  }
  throwIfAborted(abortSignal, "correction apply aborted");
  const destStorage = await wiring.orchestrator.getStorage(toNamespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const fm = memory.frontmatter;
  // Strip the `[Attributes: …]` suffix writeMemory appended to the source body
  // (review thread Of0p6): we forward `structuredAttributes` separately, so
  // writeMemory will re-append the suffix on the destination. Without this
  // strip the destination would carry the suffix TWICE, producing duplicated
  // attribute text and a different content hash/index entry.
  const destContent = fm.structuredAttributes
    ? stripAttributesSuffix(memory.content)
    : memory.content;
  // Sealed-envelope write (issue #1989 PR4): a rescope REPLAYS stored
  // frontmatter — legacy rows may predate current field limits, and a
  // rescope must never be impossible for data already in the store, so
  // compose in salvage mode (drops warn-logged).
  const rescopeEnvelope = composeMemoryEnvelope(
    {
      content: destContent,
      category: fm.category,
      ...(typeof fm.confidence === "number" ? { confidence: fm.confidence } : {}),
      ...(Array.isArray(fm.tags) ? { tags: fm.tags } : {}),
      ...(fm.entityRef ? { entityRef: fm.entityRef } : {}),
      ...(fm.structuredAttributes ? { structuredAttributes: fm.structuredAttributes } : {}),
      ...(fm.valid_at ? { validAt: fm.valid_at } : {}),
    },
    { source: `correction:rescope:${namespace}` },
    { salvage: true },
  );
  if (rescopeEnvelope.salvageNotes.length > 0) {
    log.warn(`rescope write salvaged invalid fields: ${rescopeEnvelope.salvageNotes.join("; ")}`);
  }
  throwIfAborted(abortSignal, "correction apply aborted");
  const { id: destId, tombstoneBlocked: destBlocked } = await destStorage.writeSealedMemory(rescopeEnvelope, {
    ...(fm.observedAt ? { observedAt: fm.observedAt } : {}),
    ...(fm.memoryKind ? { memoryKind: fm.memoryKind } : {}),
    ...(Array.isArray(fm.links) ? { links: fm.links } : {}),
    ...(fm.intentGoal ? { intentGoal: fm.intentGoal } : {}),
  });
  if (destBlocked) {
    // #1645: destination tombstone-blocked the rescope (pending_review). Don't
    // archive the source — that deletes the only active copy while the
    // replacement sits behind review. Fail the rescope; source stays active.
    throw new CorrectionContractError(
      `rescope of ${memoryId} into "${toNamespace}" was tombstone-blocked (pending_review ${destId}) — keeping source active`,
    );
  }
  // Unlink the source by archiving (non-destructive — rule 25). If the archive
  // fails AFTER the destination write succeeded, compensate by archiving the
  // destination too so no duplicate ACTIVE fact remains, then re-throw so the
  // executor records the action as failed (review: rescope-duplicates-on-fail).
  // Once the destination write resolves, cancellation cannot interrupt the
  // source retirement or leave both memories active.
  try {
    await sourceStorage.writeMemoryFrontmatter(memory, {
      status: "archived",
      archivedAt: new Date().toISOString(),
    });
  } catch (err) {
    try {
      const destMem = await destStorage.getMemoryById(destId);
      if (destMem) {
        await destStorage.writeMemoryFrontmatter(destMem, {
          status: "archived",
          archivedAt: new Date().toISOString(),
        });
      }
    } catch {
      // best-effort compensation
    }
    throw err;
  }
  return destId;
}

async function appendTombstoneFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  input: {
    reason: "correction" | "supersession" | "retraction";
    sourceMemoryId: string;
    rawContent: string;
    entityRef?: string;
    supersessionKey?: string;
    supersessionKeys?: string[];
    contentHash?: string;
  },
  abortSignal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  // storage.appendTombstone returns null for TWO reasons: tombstones disabled
  // (off = pre-feature behavior) OR a swallowed store error (it catches I/O
  // failures and returns null — review thread OgIqp). The executor writes the
  // tombstone BEFORE retiring the source (PG9), so when tombstones are
  // enabled a null return means persistence failed and the retire must NOT
  // proceed (no tombstone → resurrection window). Distinguish the two cases
  // via the public isTombstonesEnabled() accessor; when disabled, null is the
  // expected pre-feature return and the action may still succeed.
  const enabled =
    typeof storage.isTombstonesEnabled === "function"
      ? storage.isTombstonesEnabled()
      : true;
  // #1672 item 4: emit one tombstone per derived supersession key (mirrors
  // temporal-supersession / forget / pattern-reinforcement) so a paraphrased
  // re-observation placing the attribute at a different key position is still
  // blocked at the keyed tier. When no keys are derived, emit a single
  // content-only tombstone. Each carries the canonical contentHash so the
  // exact tier also matches re-extraction.
  const keys =
    input.supersessionKeys && input.supersessionKeys.length > 0
      ? input.supersessionKeys
      : input.supersessionKey
        ? [input.supersessionKey]
        : [undefined];
  const writtenIds: string[] = [];
  let firstId: string | null = null;
  let committed = false;
  for (const key of keys) {
    // Once one tombstone is durable, finish the complete tombstone set even
    // if the caller aborts. The executor must retire the source after the
    // tombstone commit or compensate it; returning an abort here would leave
    // an active source behind a committed resurrection block.
    if (!committed) throwIfAborted(abortSignal, "correction apply aborted");
    const result = await storage.appendTombstone({
      reason: input.reason,
      createdBy: "user_correction",
      sourceMemoryId: input.sourceMemoryId,
      rawContent: input.rawContent,
      ...(input.entityRef ? { entityRef: input.entityRef } : {}),
      ...(key ? { supersessionKey: key } : {}),
      ...(input.contentHash ? { contentHash: input.contentHash } : {}),
    });
    if (result === null && enabled) {
      // Rollback already-written tombstones so a partial multi-key failure
      // does not leave incomplete resurrection blocking for the still-active
      // memory (review thread #1). Best-effort — a dangling tombstone is the
      // safer failure mode (false-positive block vs. false-negative leak).
      for (const id of writtenIds) {
        try { await storage.revokeTombstone(id, "user_correction"); } catch { /* best-effort */ }
      }
      throw new CorrectionContractError(
        `tombstone persistence failed for memory ${input.sourceMemoryId} (tombstones enabled but store returned null — I/O error swallowed)`,
      );
    }
    if (firstId === null) firstId = result;
    if (result) {
      writtenIds.push(result);
      committed = true;
    }
  }
  return firstId;
}

async function registerRedactionRuleFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  pattern: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  // Persist the redaction rule under state/ so extraction consults it the
  // same way tombstones are consulted (route through the same chokepoint).
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const dir = path.join(storage.dir, "state", "corrections", "redaction-rules");
  await mkdir(dir, { recursive: true });
  throwIfAborted(abortSignal, "correction apply aborted");
  // Idempotent: filename is a slug + short hash of the full pattern so
  // re-registering the same pattern overwrites rather than duplicates, while
  // distinct patterns that slug identically (e.g. "abc+def" vs "abc.def" →
  // "abc-def") no longer collide and silently remove each other's enforcement
  // (review thread P1).
  const slugBase = pattern.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 48) || "rule";
  const patternHash = createHash("sha256").update(pattern).digest("hex").slice(0, 16);
  const slug = `${slugBase}-${patternHash}`;
  throwIfAborted(abortSignal, "correction apply aborted");
  await writeFile(
    path.join(dir, `${slug}.json`),
    `${JSON.stringify({ pattern, namespace, createdAt: new Date().toISOString() })}\n`,
    "utf-8",
  );
  throwIfAborted(abortSignal, "correction apply aborted");
}

async function appendAuditRecordFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  record: {
    planId: string;
    classification: CorrectionPlan["classification"];
    outcome: CorrectionOutcome;
    requestText: string;
  },
  abortSignal?: AbortSignal,
): Promise<string> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  // Corrections are themselves memories, searchable and namespaced (issue
  // #1580 design §4). Write a correction-category memory capturing the
  // plan + outcome as the audit trail.
  // Sealed-envelope write (issue #1989 PR4): system-built audit body —
  // strict compose; an invalid audit record is a code bug.
  throwIfAborted(abortSignal, "correction apply aborted");
  const { id: id } = await storage.writeSealedMemory(
    composeMemoryEnvelope(
      {
        content: buildAuditBody(record),
        category: "correction",
        confidence: 1.0,
        tags: ["correction-audit", `plan:${record.planId}`, `classification:${record.classification}`],
      },
      { source: "correction-contract" },
    ),
    {},
  );
  throwIfAborted(abortSignal, "correction apply aborted");
  return id;
}

function buildAuditBody(record: {
  planId: string;
  classification: CorrectionPlan["classification"];
  outcome: CorrectionOutcome;
  requestText: string;
}): string {
  // Never-store / redaction corrections carry the very secret/pattern the user
  // asked Remnic NOT to retain — withhold the request text from the durable
  // audit memory so we don't persist it verbatim (#1580 review, P1).
  const sensitive =
    record.classification === "never_store" ||
    record.outcome.results.some((r) => r.action.kind === "redaction_rule");
  const safeRequest = sensitive
    ? "[redacted — never-store/redaction correction text withheld from the audit trail]"
    : record.requestText.slice(0, 200);
  const lines = [
    `Correction plan ${record.planId} applied (${record.outcome.status}).`,
    "",
    `Request: ${safeRequest}`,
    `Classification: ${record.classification}`,
    `Applied at: ${record.outcome.appliedAt}`,
    "",
    "Actions:",
  ];
  for (const r of record.outcome.results) {
    // Never-store/redaction action errors can echo the secret/pattern — withhold
    // the error text for those actions (review thread OhjwW).
    const withhold =
      r.action.kind === "redaction_rule" || record.classification === "never_store";
    const errPart = r.error ? (withhold ? " (error withheld)" : ` (${r.error})`) : "";
    lines.push(`  - ${r.action.kind}: ${r.status}${errPart}`);
  }
  return lines.join("\n");
}

async function propagateFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  touchedMemoryIds: readonly string[],
  abortSignal?: AbortSignal,
): Promise<void> {
  // Best-effort post-write propagation. The orchestrator's indexPersistedMemory
  // fires the QMD reindex for a touched file (checklist §31). A failure here
  // is non-fatal — the executor records it as a warning, never a failed action.
  for (const id of touchedMemoryIds) {
    throwIfAborted(abortSignal, "correction apply aborted");
    try {
      // indexPersistedMemory is keyed by the namespace's storage, NOT the
      // default namespace (review thread: propagation-hardcodes-default-ns).
      const storage = await wiring.orchestrator.getStorage(namespace);
      throwIfAborted(abortSignal, "correction apply aborted");
      const orchestrator = wiring.orchestrator as unknown as {
        indexPersistedMemory?(storage: unknown, memoryId: string): Promise<void>;
      };
      if (typeof orchestrator.indexPersistedMemory === "function") {
        await orchestrator.indexPersistedMemory(storage, id);
        throwIfAborted(abortSignal, "correction apply aborted");
      }
    } catch (err) {
      if (abortSignal?.aborted) throw err;
      // Swallow — propagation is best-effort.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function toCandidate(m: MemoryFile, namespace: string, score: number): PlannerCandidate {
  return {
    memoryId: m.frontmatter.id,
    path: m.path,
    content: m.content,
    excerpt: m.content.slice(0, 160),
    ...(m.frontmatter.entityRef ? { entityRef: m.frontmatter.entityRef } : {}),
    score,
    // namespace is implicit (the planner scopes by namespace); keep it on the
    // candidate for diff rendering if needed.
  } satisfies PlannerCandidate & { namespace?: string };
}

/**
 * Lifecycle-aware eligibility for a correction candidate (#1672 item 2). A
 * memory is eligible only when it is `status: "active"` AND not archived.
 * Planning a correction against a memory that was archived via the
 * `archivedAt`/archive path but still marked active would surface stale
 * content the user already set aside — and apply would reject the rescope
 * (non-active source) or supersede a fact the user intended gone. Both the
 * status flip and the archive timestamp are checked so the candidate set
 * stays consistent with the rescope/retire apply-time guards.
 */
function isEligibleCorrectionCandidate(m: MemoryFile): boolean {
  if (m.frontmatter.status && m.frontmatter.status !== "active") return false;
  if (typeof m.frontmatter.archivedAt === "string" && m.frontmatter.archivedAt.length > 0) return false;
  return true;
}

function toExecutorMemory(m: MemoryFile): ExecutorMemory {
  const fm = m.frontmatter;
  // The tombstone hash must use the ORIGINAL unsuffixed body: writeMemory
  // appends an `[Attributes: …]` suffix when structuredAttributes are set, so
  // hashing m.content would never match the pre-suffix content hash (thread
  // OhX2N, rule 23). Strip the suffix when attributes are present.
  const rawBody = fm.structuredAttributes ? stripAttributesSuffix(m.content) : m.content;
  // #1672 item 4: derive the full supersession-key set from the memory's
  // structuredAttributes so the tombstone's keyed tier blocks paraphrased
  // re-observations that place the attribute at a different key position
  // (mirrors temporal-supersession's per-key emission). Also forward the
  // canonical contentHash so the exact tier matches re-extraction without
  // recomputing from a citation-annotated body.
  const supersessionKeys = supersessionKeysForFact({
    entityRef: fm.entityRef,
    structuredAttributes: fm.structuredAttributes,
  });
  return {
    memoryId: fm.id,
    content: m.content,
    category: fm.category,
    rawContent: rawBody,
    ...(fm.entityRef ? { entityRef: fm.entityRef } : {}),
    ...(supersessionKeys.length > 0 ? { supersessionKeys } : {}),
    ...(supersessionKeys.length > 0 ? { supersessionKey: supersessionKeys[0] } : {}),
    ...(typeof fm.contentHash === "string" && fm.contentHash.length > 0
      ? { contentHash: fm.contentHash }
      : {}),
  } satisfies ExecutorMemory;
}

/**
 * The single source of truth for whether the Correction Contract feature is
 * enabled. Reads BOTH config shapes so tool visibility and the runtime gate
 * can never drift out of sync (review thread: correction-gate-config-mismatch):
 *   - nested: `config.correction.enabled`
 *   - flat:   the `correctionEnabled` legacy key (ratchet-safe shape)
 * Nested wins when present; both default to `true` (plan is read-only, safe on).
 */
export function isCorrectionFeatureEnabled(config: PluginConfig): boolean {
  // parseConfig now resolves this into `resolveRecallAuxiliaryCapabilities(config).correction` (review
  // thread Txp) — prefer the parsed boolean so operator config actually takes
  // effect. The loose nested/flat read stays as a fallback for PluginConfig-
  // shaped objects built without parseConfig (unit tests).
  if (typeof resolveRecallAuxiliaryCapabilities(config).correction === "boolean") return resolveRecallAuxiliaryCapabilities(config).correction;
  const nested = (config as unknown as Record<string, unknown>).correction as
    | Record<string, unknown>
    | undefined;
  if (nested && typeof nested.enabled === "boolean") return nested.enabled;
  if (nested && typeof nested.enabled === "string") return nested.enabled === "true" || nested.enabled === "1";
  return readCorrectionFlag(config, "enabled", true);
}

/** Read a boolean correction flag from the loosely-typed config (ratchet-safe). */
function readCorrectionFlag(config: PluginConfig, key: string, fallback: boolean): boolean {
  // Nested shape wins: config.correction.<key> (review thread: nested-correction-settings).
  const nested = (config as unknown as Record<string, unknown>).correction as
    | Record<string, unknown>
    | undefined;
  if (nested && typeof nested[key] === "boolean") return nested[key] as boolean;
  if (nested && typeof nested[key] === "string") return (nested[key] as string) === "true" || (nested[key] as string) === "1";
  // Flat legacy shape: config.correction<Key>.
  const raw = (config as unknown as Record<string, unknown>)[`correction${capitalize(key)}`];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return fallback;
}

/** Read a numeric correction value from the loosely-typed config (ratchet-safe). */
function readCorrectionNumber(config: PluginConfig, key: string, fallback: number): number {
  // Nested shape wins: config.correction.<key> (review thread: nested-correction-settings).
  const nested = (config as unknown as Record<string, unknown>).correction as
    | Record<string, unknown>
    | undefined;
  if (nested) {
    const nv = nested[key];
    if (typeof nv === "number" && Number.isFinite(nv)) return nv;
    if (typeof nv === "string") {
      const nn = Number(nv);
      if (Number.isFinite(nn)) return nn;
    }
  }
  const raw = (config as unknown as Record<string, unknown>)[`correction${capitalize(key)}`];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// LLM classify+draft (Responses API only — gotcha 1)
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `You classify memory corrections and draft per-memory actions.

Given a correction statement and candidate memories, respond with a JSON object:
{
  "classification": "wrong" | "outdated" | "incomplete" | "wrong_scope" | "never_store",
  "confidence": <number 0..1>,
  "actions": [<one or more correction actions>],
  "relevance": [{"memoryId": "<id>", "why": "<one short sentence>"}]
}

Action shapes:
- {"kind":"supersede","loserId":"<id>","replacement":{"content":"<new fact>"}}
- {"kind":"edit","memoryId":"<id>","patch":"<new full content>"}
- {"kind":"retract","memoryId":"<id>"}
- {"kind":"rescope","memoryId":"<id>","toNamespace":"<ns>"}
- {"kind":"redaction_rule","pattern":"<bounded literal or regex>"}

Only emit actions you are confident in. If uncertain, return confidence < 0.5 and few actions.`;

function buildClassifyPrompt(text: string, candidates: PlannerCandidate[]): string {
  const lines = [
    `Correction: ${text}`,
    "",
    "Candidate memories:",
  ];
  for (const c of candidates.slice(0, 20)) {
    lines.push(`[${c.memoryId}] ${c.excerpt}`);
  }
  lines.push("", "Respond with the JSON object only.");
  return lines.join("\n");
}

function parseClassifyResponse(
  raw: string,
  candidates: PlannerCandidate[],
): LlmClassificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallbackClassification(candidates, "LLM returned non-JSON response");
  }
  if (!parsed || typeof parsed !== "object") {
    return fallbackClassification(candidates, "LLM returned non-object response");
  }
  const obj = parsed as Record<string, unknown>;
  const classification = isClassification(obj.classification) ? obj.classification : "outdated";
  const confidence = typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;
  const rawActions = Array.isArray(obj.actions) ? obj.actions : [];
  const actions: CorrectionAction[] = [];
  const warnings: string[] = [];
  for (const rawAction of rawActions) {
    try {
      validateCorrectionAction(rawAction);
      actions.push(rawAction);
    } catch (err) {
      warnings.push(`dropped malformed action: ${errMsg(err)}`);
    }
  }
  const relevance = Array.isArray(obj.relevance)
    ? (obj.relevance as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({
          memoryId: typeof r.memoryId === "string" ? r.memoryId : "",
          why: typeof r.why === "string" ? r.why : "",
        }))
        .filter((r) => r.memoryId.length > 0)
    : [];
  return {
    classification,
    confidence,
    actions,
    relevance,
    warnings,
  };
}

function isClassification(value: unknown): value is CorrectionPlan["classification"] {
  return (
    value === "wrong" ||
    value === "outdated" ||
    value === "incomplete" ||
    value === "wrong_scope" ||
    value === "never_store"
  );
}

function fallbackClassification(
  candidates: PlannerCandidate[],
  reason: string,
): LlmClassificationResult {
  return {
    classification: "outdated",
    confidence: 0,
    actions: [],
    relevance: candidates.map((c) => ({ memoryId: c.memoryId, why: "located for review" })),
    warnings: [reason],
    fallback: true,
  };
}

// Re-export the local helpers for tests that import this module directly.
// (deterministicFallbackPlan and newPlanId live in correction-contract.ts and
// are re-exported by the barrel from there — not duplicated here.)
export {
  buildAuditBody,
  buildClassifyPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  parseClassifyResponse,
  // #1672: exported for focused storage-integration regression tests.
  isEligibleCorrectionCandidate,
  applyEditMemory,
  appendTombstoneFn,
  retireMemoryFn,
  rescopeMemoryFn,
  writeReplacementMemory,
};
