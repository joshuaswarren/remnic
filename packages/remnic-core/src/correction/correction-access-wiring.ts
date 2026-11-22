
import path from "node:path";
import { abortError, isAbortError, throwIfAborted } from "../abort-error.js";
import { composeMemoryEnvelope, isMemoryCategory } from "../write-envelope.js";
import { log } from "../logger.js";
import { createHash } from "node:crypto";
import { REDACTION_RULES_SUBDIR } from "../extraction-redaction-rules.js";
import { writeFileAtomically } from "../maintenance/atomic-file.js";
import type { Orchestrator } from "../orchestrator.js";
import type { MemoryFile, MemoryStatus, PluginConfig } from "../types.js";
import { stripAttributesSuffix } from "../structured-attributes.js";
import { extractJsonCandidates } from "../json-extract.js";
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
import { completeCorrectionClassify } from "./correction-classify.js";
import { resolveRecallAuxiliaryCapabilities } from "../capabilities.js";
import { isSupportPassportPrivateMemory } from "../support-passport/card-projection.js";

// ---------------------------------------------------------------------------

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
   * Optional test override for classify+draft. Production leaves this unset
   * and uses completeCorrectionClassify: a short per-attempt timeout, caller
   * abort, then the gateway/fallback model. A caller abort propagates; every
   * other failure becomes the deterministic empty-action plan.
   */
  llmComplete?(request: {
    system: string;
    user: string;
    abortSignal?: AbortSignal;
  }): Promise<string>;
}

export function createCorrectionService(wiring: CorrectionAccessWiring): CorrectionService {
  const cfg = wiring.orchestrator.config;
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
    inspectMemory: async ({ memoryId, namespaces }) =>
      inspectCorrectionMemory(wiring, memoryId, namespaces),
    expandNeighbors: async ({ seedIds, namespaces, limit }) =>
      expandEntityNeighbors(wiring, seedIds, namespaces, limit),
    classifyAndDraft: async ({ text, candidates, abortSignal }) =>
      classifyAndDraft(wiring, text, candidates, abortSignal),
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
      scored.push({ m, ns, score: hits / tokens.length });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s, i) => toCandidate(s.m, s.ns, s.score - i * 0.01));
}

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
      if (m && isEligibleCorrectionCandidate(m)) {
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
  if (seedIds.length === 0 || limit <= 0 || namespaces.length === 0) return [];
  const out: PlannerCandidate[] = [];
  const seen = new Set<string>(seedIds);
  const seedRefs = new Set<string>();
  for (const ns of namespaces) {
    const storage = await wiring.orchestrator.getStorage(ns);
    const all = await storage.readAllMemories();
    for (const m of all) {
      if (
        seedIds.includes(m.frontmatter.id) &&
        m.frontmatter.entityRef &&
        isEligibleCorrectionCandidate(m)
      ) {
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
  abortSignal?: AbortSignal,
): Promise<LlmClassificationResult> {
  // Injected llmComplete stays as a test override. Production uses
  // completeCorrectionClassify: short timeout, caller abort, gateway fallback.
  // Abort throws. Every other failure is the deterministic empty-action plan.
  try {
    throwIfAborted(abortSignal, "correction classify aborted");
    const user = buildClassifyPrompt(text, candidates);
    const raw = wiring.llmComplete
      ? await wiring.llmComplete({ system: CLASSIFY_SYSTEM_PROMPT, user, abortSignal })
      : await completeCorrectionClassify(
          [
            { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
          { config: wiring.orchestrator.config, localLlm: wiring.orchestrator.localLlm },
          abortSignal,
        );
    if (raw == null) return fallbackClassification(candidates, "correction classify unavailable");
    throwIfAborted(abortSignal, "correction classify aborted");
    return parseClassifyResponse(raw, candidates);
  } catch (err) {
    if (isAbortError(err) || abortSignal?.aborted) {
      throw isAbortError(err) ? err : abortError("correction classify aborted");
    }
    return fallbackClassification(candidates, `LLM unavailable: ${errMsg(err)}`);
  }
}

async function inspectCorrectionMemory(
  wiring: CorrectionAccessWiring,
  memoryId: string,
  namespaces: readonly string[],
): Promise<{ candidate: PlannerCandidate; status: string } | null> {
  for (const ns of namespaces) {
    const storage = await wiring.orchestrator.getStorage(ns);
    const memory = await storage.getMemoryByIdIncludingArchived(memoryId);
    if (!memory || memory.frontmatter.id !== memoryId) continue;
    const candidate = toCandidate(memory, ns, 1);
    if (isSupportPassportPrivateMemory(memory)) return { candidate, status: "ineligible" };
    if (typeof memory.frontmatter.archivedAt === "string" && memory.frontmatter.archivedAt.length > 0) {
      return { candidate, status: "archived" };
    }
    return { candidate, status: memory.frontmatter.status ?? "active" };
  }
  return null;
}

async function renderCorrectionDiff(
  _wiring: CorrectionAccessWiring,
  candidates: PlannerCandidate[],
  actions: CorrectionAction[],
): Promise<string> {
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
      return action.replacement?.content
        ?? (action.winnerId
          ? `(superseded by ${action.winnerId}; recoverable)`
          : "(superseded without replacement)");
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
  //
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
  throwIfAborted(abortSignal, "correction apply aborted");
  const sourceStorage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const memory = await sourceStorage.getMemoryById(memoryId);
  throwIfAborted(abortSignal, "correction apply aborted");
  if (!memory) throw new CorrectionContractError(`memory not found for rescope: ${memoryId}`);
  if (memory.frontmatter.status && memory.frontmatter.status !== "active") {
    throw new CorrectionContractError(
      `cannot rescope memory ${memoryId}: source is ${memory.frontmatter.status}, not active`,
    );
  }
  throwIfAborted(abortSignal, "correction apply aborted");
  const destStorage = await wiring.orchestrator.getStorage(toNamespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const fm = memory.frontmatter;
  const destContent = fm.structuredAttributes
    ? stripAttributesSuffix(memory.content)
    : memory.content;
  const rescopeEnvelope = composeMemoryEnvelope(
    {
      content: destContent,
      category: fm.category,
      ...(typeof fm.confidence === "number" ? { confidence: fm.confidence } : {}),
      ...(Array.isArray(fm.tags) ? { tags: fm.tags } : {}),
      ...(fm.entityRef ? { entityRef: fm.entityRef } : {}),
      ...(fm.structuredAttributes ? { structuredAttributes: fm.structuredAttributes } : {}),
      ...(fm.valid_at ? { validAt: fm.valid_at } : {}),
      ...(fm.sourceConnector ? { sourceConnector: fm.sourceConnector } : {}),
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
    ...(fm.toolScoped ? { toolScoped: true as const } : {}),
  });
  if (destBlocked) {
    throw new CorrectionContractError(
      `rescope of ${memoryId} into "${toNamespace}" was tombstone-blocked (pending_review ${destId}) — keeping source active`,
    );
  }
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
  const enabled =
    typeof storage.isTombstonesEnabled === "function"
      ? storage.isTombstonesEnabled()
      : true;
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
  writeRule: (outputPath: string, content: string) => Promise<unknown> = writeFileAtomically,
): Promise<void> {
  throwIfAborted(abortSignal, "correction apply aborted");
  const storage = await wiring.orchestrator.getStorage(namespace);
  throwIfAborted(abortSignal, "correction apply aborted");
  const dir = path.join(storage.dir, REDACTION_RULES_SUBDIR);
  throwIfAborted(abortSignal, "correction apply aborted");
  const slugBase = pattern.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 48) || "rule";
  const patternHash = createHash("sha256").update(pattern).digest("hex").slice(0, 16);
  const slug = `${slugBase}-${patternHash}`;
  throwIfAborted(abortSignal, "correction apply aborted");
  await writeRule(
    path.join(dir, `${slug}.json`),
    `${JSON.stringify({ pattern, namespace, createdAt: new Date().toISOString() })}\n`,
  );
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
  return id;
}

function buildAuditBody(record: {
  planId: string;
  classification: CorrectionPlan["classification"];
  outcome: CorrectionOutcome;
  requestText: string;
}): string {
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
  for (const id of touchedMemoryIds) {
    throwIfAborted(abortSignal, "correction apply aborted");
    try {
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

function isEligibleCorrectionCandidate(m: MemoryFile): boolean {
  if (isSupportPassportPrivateMemory(m)) return false;
  if (m.frontmatter.status && m.frontmatter.status !== "active") return false;
  if (typeof m.frontmatter.archivedAt === "string" && m.frontmatter.archivedAt.length > 0) return false;
  return true;
}

function toExecutorMemory(m: MemoryFile): ExecutorMemory {
  const fm = m.frontmatter;
  const rawBody = fm.structuredAttributes ? stripAttributesSuffix(m.content) : m.content;
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
    status: fm.status ?? "active",
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
  if (typeof resolveRecallAuxiliaryCapabilities(config).correction === "boolean") return resolveRecallAuxiliaryCapabilities(config).correction;
  const nested = (config as unknown as Record<string, unknown>).correction as
    | Record<string, unknown>
    | undefined;
  if (nested && typeof nested.enabled === "boolean") return nested.enabled;
  if (nested && typeof nested.enabled === "string") return nested.enabled === "true" || nested.enabled === "1";
  return readCorrectionFlag(config, "enabled", true);
}

function readCorrectionFlag(config: PluginConfig, key: string, fallback: boolean): boolean {
  const nested = (config as unknown as Record<string, unknown>).correction as
    | Record<string, unknown>
    | undefined;
  if (nested && typeof nested[key] === "boolean") return nested[key] as boolean;
  if (nested && typeof nested[key] === "string") return (nested[key] as string) === "true" || (nested[key] as string) === "1";
  const raw = (config as unknown as Record<string, unknown>)[`correction${capitalize(key)}`];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw === "true" || raw === "1";
  return fallback;
}

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
- {"kind":"supersede","loserId":"<id>","winnerId":"<existing id>"}
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
  const responses = new Map<string, Record<string, unknown>>();
  let sawJson = false;
  for (const candidate of new Set([raw.trim(), ...extractJsonCandidates(raw)])) {
    if (!raw.includes(candidate)) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      sawJson = true;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const value = parsed as Record<string, unknown>;
      if (!isClassification(value.classification) ||
          typeof value.confidence !== "number" || !Number.isFinite(value.confidence) ||
          value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.actions)) continue;
      const hasUsable = value.actions.some((action) => {
        try {
          validateCorrectionAction(action);
          return true;
        } catch {
          return false;
        }
      });
      if (hasUsable || value.actions.length === 0) responses.set(JSON.stringify(value), value);
    } catch {
      // Keep scanning after malformed JSON, not after mere syntax success.
    }
  }
  if (responses.size !== 1) {
    return fallbackClassification(candidates, responses.size > 1
      ? "LLM returned ambiguous correction responses"
      : sawJson ? "LLM returned invalid correction response" : "LLM returned non-JSON response");
  }
  const obj = responses.values().next().value as Record<string, unknown>;
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
  appendAuditRecordFn,
  registerRedactionRuleFn,
  retireMemoryFn,
  rescopeMemoryFn,
  writeReplacementMemory,
};
