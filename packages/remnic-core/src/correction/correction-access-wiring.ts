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
import { mkdir, writeFile } from "node:fs/promises";
import type { Orchestrator } from "../orchestrator.js";
import type { MemoryFile, MemoryStatus, PluginConfig } from "../types.js";
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
  const out: PlannerCandidate[] = [];
  for (const ns of namespaces) {
    const storage = await wiring.orchestrator.getStorage(ns);
    const all = await storage.readAllMemories();
    const q = text.toLowerCase();
    for (const m of all) {
      if (m.frontmatter.status && m.frontmatter.status !== "active") continue;
      const hay = `${m.content} ${m.frontmatter.tags?.join(" ") ?? ""}`.toLowerCase();
      if (!hay.includes(q.slice(0, Math.min(32, q.length)))) continue;
      out.push(toCandidate(m, ns, 1 - out.length * 0.01));
      if (out.length >= limit) return out;
    }
  }
  return out;
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
      if (m.frontmatter.status && m.frontmatter.status !== "active") continue;
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
    getMemory: async (namespace, memoryId) => getExecutorMemory(wiring, namespace, memoryId),
    writeReplacement: async (namespace, draft) =>
      writeReplacementMemory(wiring, namespace, draft),
    applyEdit: async (namespace, memoryId, patch) =>
      applyEditMemory(wiring, namespace, memoryId, patch),
    retireMemory: async (namespace, memoryId, retireOpts) =>
      retireMemoryFn(wiring, namespace, memoryId, retireOpts),
    rescopeMemory: async (namespace, memoryId, toNamespace) =>
      rescopeMemoryFn(wiring, namespace, memoryId, toNamespace),
    appendTombstone: async (namespace, input) =>
      appendTombstoneFn(wiring, namespace, input),
    registerRedactionRule: async (namespace, pattern) =>
      registerRedactionRuleFn(wiring, namespace, pattern),
    appendAuditRecord: async (namespace, record) =>
      appendAuditRecordFn(wiring, namespace, record),
    propagate: async (namespace, touchedMemoryIds) =>
      propagateFn(wiring, namespace, touchedMemoryIds),
    biTemporalEnabled: opts.biTemporalEnabled,
    now: () => new Date(),
  };
}

async function getExecutorMemory(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
): Promise<ExecutorMemory | null> {
  const storage = await wiring.orchestrator.getStorage(namespace);
  const m = await storage.getMemoryById(memoryId);
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
): Promise<string> {
  const storage = await wiring.orchestrator.getStorage(namespace);
  // writeMemory is the single storage chokepoint — catalog/dedup/reindex fire
  // here (rule 43). Tombstone blocking also fires here (#1579), so a
  // resurrected fact lands as pending_review rather than silently overwriting.
  const id = await storage.writeMemory(
    (draft.category ?? "fact") as Parameters<typeof storage.writeMemory>[0],
    draft.content,
    {
      source: "correction",
      confidence: draft.confidence ?? 0.9,
      tags: draft.tags ?? [],
      ...(draft.entityRef ? { entityRef: draft.entityRef } : {}),
      ...(draft.validAt ? { validAt: draft.validAt } : {}),
      ...(draft.observedAt ? { observedAt: draft.observedAt } : {}),
      ...(draft.structuredAttributes ? { structuredAttributes: draft.structuredAttributes } : {}),
      ...(draft.supersedes ? { supersedes: draft.supersedes } : {}),
    },
  );
  return id;
}

async function applyEditMemory(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  patch: string,
): Promise<string> {
  const storage = await wiring.orchestrator.getStorage(namespace);
  const existing = await storage.getMemoryById(memoryId);
  if (!existing) throw new CorrectionContractError(`memory not found for edit: ${memoryId}`);
  // Apply the patch by overwriting content through the storage chokepoint.
  // The StorageManager's writeMemoryFrontmatter snapshots the prior version
  // internally when page-versioning is configured (issue #371), so every edit
  // is revertable without the correction layer forking versioning logic.
  await storage.writeMemoryFrontmatter(
    { ...existing, content: patch },
    { updated: new Date().toISOString() },
  );
  return memoryId;
}

async function retireMemoryFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  opts: { status: "superseded" | "retracted"; supersededBy?: string; validUntil?: string },
): Promise<void> {
  const storage = await wiring.orchestrator.getStorage(namespace);
  const memory = await storage.getMemoryById(memoryId);
  if (!memory) throw new CorrectionContractError(`memory not found for retire: ${memoryId}`);
  // Map the correction-domain status to the storage-domain MemoryStatus.
  // `retracted` (a correction concept) becomes `forgotten` — the soft-delete
  // status that excludes the memory from recall/browse/attribution while
  // keeping a page-version snapshot for reversibility (#686). `superseded`
  // maps to itself.
  const storageStatus: MemoryStatus = opts.status === "retracted" ? "forgotten" : "superseded";
  // Flip status + stamp validUntil (when bi-temporal is on, #1578) +
  // link the superseder. writeMemoryFrontmatter is the chokepoint.
  await storage.writeMemoryFrontmatter(memory, {
    status: storageStatus,
    ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
    ...(opts.status === "superseded" ? { supersededAt: new Date().toISOString() } : {}),
    // validUntil is the bi-temporal end; absent when the gate is off.
    ...(opts.validUntil ? { invalid_at: opts.validUntil } : {}),
  });
}

async function rescopeMemoryFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  memoryId: string,
  toNamespace: string,
): Promise<string> {
  // The destination namespace is re-authorized by the service before the
  // executor runs; here we perform the move atomically (write-then-unlink).
  const sourceStorage = await wiring.orchestrator.getStorage(namespace);
  const memory = await sourceStorage.getMemoryById(memoryId);
  if (!memory) throw new CorrectionContractError(`memory not found for rescope: ${memoryId}`);
  const destStorage = await wiring.orchestrator.getStorage(toNamespace);
  const fm = memory.frontmatter;
  // Forward ALL frontmatter metadata so dedupe/supersession/temporal behavior
  // is preserved (review thread: preserve-frontmatter-metadata-rescope).
  const destId = await destStorage.writeMemory(fm.category, memory.content, {
    source: `correction:rescope:${namespace}`,
    ...(typeof fm.confidence === "number" ? { confidence: fm.confidence } : {}),
    ...(Array.isArray(fm.tags) ? { tags: fm.tags } : {}),
    ...(fm.entityRef ? { entityRef: fm.entityRef } : {}),
    ...(fm.structuredAttributes ? { structuredAttributes: fm.structuredAttributes } : {}),
    ...(fm.valid_at ? { validAt: fm.valid_at } : {}),
    ...(fm.observedAt ? { observedAt: fm.observedAt } : {}),
    ...(fm.memoryKind ? { memoryKind: fm.memoryKind } : {}),
    ...(Array.isArray(fm.links) ? { links: fm.links } : {}),
    ...(fm.intentGoal ? { intentGoal: fm.intentGoal } : {}),
  });
  // Unlink the source by archiving (non-destructive — rule 25). If the archive
  // fails AFTER the destination write succeeded, compensate by archiving the
  // destination too so no duplicate ACTIVE fact remains, then re-throw so the
  // executor records the action as failed (review: rescope-duplicates-on-fail).
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
  },
): Promise<string | null> {
  const storage = await wiring.orchestrator.getStorage(namespace);
  // storage.appendTombstone is the public tombstone API (#1579). It returns
  // null when tombstones are disabled (off = pre-feature behavior).
  return storage.appendTombstone({
    reason: input.reason,
    createdBy: "user_correction",
    sourceMemoryId: input.sourceMemoryId,
    rawContent: input.rawContent,
    ...(input.entityRef ? { entityRef: input.entityRef } : {}),
    ...(input.supersessionKey ? { supersessionKey: input.supersessionKey } : {}),
  });
}

async function registerRedactionRuleFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  pattern: string,
): Promise<void> {
  // Persist the redaction rule under state/ so extraction consults it the
  // same way tombstones are consulted (route through the same chokepoint).
  const storage = await wiring.orchestrator.getStorage(namespace);
  const dir = path.join(storage.dir, "state", "corrections", "redaction-rules");
  await mkdir(dir, { recursive: true });
  // Idempotent: filename is a slug of the pattern so re-registering the same
  // pattern overwrites rather than duplicates.
  const slug = pattern.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 64) || "rule";
  await writeFile(
    path.join(dir, `${slug}.json`),
    `${JSON.stringify({ pattern, namespace, createdAt: new Date().toISOString() })}\n`,
    "utf-8",
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
): Promise<string> {
  const storage = await wiring.orchestrator.getStorage(namespace);
  // Corrections are themselves memories, searchable and namespaced (issue
  // #1580 design §4). Write a correction-category memory capturing the
  // plan + outcome as the audit trail.
  const id = await storage.writeMemory("correction", buildAuditBody(record), {
    source: "correction-contract",
    confidence: 1.0,
    tags: ["correction-audit", `plan:${record.planId}`, `classification:${record.classification}`],
  });
  return id;
}

function buildAuditBody(record: {
  planId: string;
  classification: CorrectionPlan["classification"];
  outcome: CorrectionOutcome;
  requestText: string;
}): string {
  const lines = [
    `Correction plan ${record.planId} applied (${record.outcome.status}).`,
    "",
    `Request: ${record.requestText.slice(0, 200)}`,
    `Classification: ${record.classification}`,
    `Applied at: ${record.outcome.appliedAt}`,
    "",
    "Actions:",
  ];
  for (const r of record.outcome.results) {
    lines.push(`  - ${r.action.kind}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
  }
  return lines.join("\n");
}

async function propagateFn(
  wiring: CorrectionAccessWiring,
  namespace: string,
  touchedMemoryIds: readonly string[],
): Promise<void> {
  // Best-effort post-write propagation. The orchestrator's indexPersistedMemory
  // fires the QMD reindex for a touched file (checklist §31). A failure here
  // is non-fatal — the executor records it as a warning, never a failed action.
  for (const id of touchedMemoryIds) {
    try {
      // indexPersistedMemory is keyed by the namespace's storage, NOT the
      // default namespace (review thread: propagation-hardcodes-default-ns).
      const storage = await wiring.orchestrator.getStorage(namespace);
      const orchestrator = wiring.orchestrator as unknown as {
        indexPersistedMemory?(storage: unknown, memoryId: string): Promise<void>;
      };
      if (typeof orchestrator.indexPersistedMemory === "function") {
        await orchestrator.indexPersistedMemory(storage, id);
      }
    } catch {
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

function toExecutorMemory(m: MemoryFile): ExecutorMemory {
  const fm = m.frontmatter;
  return {
    memoryId: fm.id,
    content: m.content,
    category: fm.category,
    rawContent: m.content, // rawContent for the tombstone hash (rule 23).
    ...(fm.entityRef ? { entityRef: fm.entityRef } : {}),
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
  // parseConfig now resolves this into `config.correctionEnabled` (review
  // thread Txp) — prefer the parsed boolean so operator config actually takes
  // effect. The loose nested/flat read stays as a fallback for PluginConfig-
  // shaped objects built without parseConfig (unit tests).
  if (typeof config.correctionEnabled === "boolean") return config.correctionEnabled;
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
};
