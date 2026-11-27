import { createHash } from "node:crypto";
import type { AccessAuditResult } from "./access-audit.js";
import type { AccessRecallSurfaceDeps } from "./access-recall-surface.js";
import {
  EngramAccessInputError,
  type EngramAccessRecallRequest,
  type EngramAccessRecallResponse,
} from "./access-service.js";
import { type BudgetDecision, toBudgetWarning } from "./cross-namespace-budget.js";
import { decideDisclosureEscalation } from "./recall-disclosure-escalation.js";
import { type TagMatchMode, applyTagFilter, normalizeTags, parseTagMatch } from "./recall-tag-filter.js";
import { resolveRecallAuxiliaryCapabilities } from "./capabilities.js";
import type { RecallDisclosure, RecallPlanMode } from "./types.js";
import { displaySafeRecallSnapshot } from "./orchestration/recall-result-formatter.js";
import {
  boundRecallContextComposition,
  composeMissingMemoryContext,
  composeRecallContext,
  type RecallContextComposition,
} from "./recall-context-composition.js";

export async function assembleRecallResponse(
  deps: AccessRecallSurfaceDeps,
  params: {
  request: EngramAccessRecallRequest;
  context: string;
  contextComposition?: RecallContextComposition;
  storageCorpusVersionsAtRecallStart: Array<{ namespace: string; version: number | null }>;
  query: string;
  mode: RecallPlanMode | undefined;
  namespace: string;
  requestedDisclosure: RecallDisclosure;
  callerProvidedDisclosure: boolean;
  topK: number | undefined;
  principal: string;
  authenticatedPrincipal: string | undefined;
  startedAt: number;
  budgetDecision: BudgetDecision;
  budgetRecordPrincipal: string | null;
}): Promise<{
  response: EngramAccessRecallResponse;
  budgetRecordPrincipal: string | null;
}> {
  const {
    request,
    context,
    contextComposition,
    storageCorpusVersionsAtRecallStart,
    query,
    mode,
    namespace,
    requestedDisclosure,
    callerProvidedDisclosure,
    topK,
    principal,
    authenticatedPrincipal,
    startedAt,
    budgetDecision,
    budgetRecordPrincipal,
  } = params;
  // Only a snapshot recorded for THIS request may shape the response: a
  // timed-out recall that never reached record() must not serve the
  // previous query's results on the same session (issue #3499 review).
  const storedSnapshot = request.sessionKey
    ? deps.orchestrator.lastRecall.get(request.sessionKey)
    : null;
  const snapshot =
    storedSnapshot &&
    storedSnapshot.queryHash === createHash("sha256").update(query).digest("hex") &&
    Date.parse(storedSnapshot.recordedAt) >= startedAt
      ? storedSnapshot
      : null;
  const effectiveNamespace = snapshot?.namespace
    ? deps.resolveNamespace(snapshot.namespace)
    : namespace;
  const resultsReturned = snapshot?.memoryIds?.length ?? 0;
  const appliedTopK = snapshot?.budgetsApplied?.appliedTopK;
  const configMaxResults =
    typeof deps.orchestrator.config.qmdMaxResults === "number" &&
    Number.isFinite(deps.orchestrator.config.qmdMaxResults) &&
    deps.orchestrator.config.qmdMaxResults > 0
      ? deps.orchestrator.config.qmdMaxResults
      : 0;
  const topKDenominator =
    typeof appliedTopK === "number" &&
    Number.isFinite(appliedTopK) &&
    appliedTopK > 0
      ? Math.max(appliedTopK, resultsReturned)
      : typeof topK === "number" && topK > 0
        ? Math.max(topK, resultsReturned)
        : Math.max(configMaxResults, resultsReturned, 1);
  const topKConfidence =
    snapshot && topKDenominator > 0
      ? Math.min(1, resultsReturned / topKDenominator)
      : undefined;
  const escalationDecision = decideDisclosureEscalation({
    mode: deps.orchestrator.config.recallDisclosureEscalation,
    threshold: deps.orchestrator.config.recallDisclosureEscalationThreshold,
    originalDisclosure: requestedDisclosure,
    callerProvidedDisclosure,
    topKConfidence,
  });
  const disclosure = escalationDecision.effective;
  const trimmedSessionKey = request.sessionKey?.trim() || undefined;
  const rawExcerptNamespace =
    disclosure === "raw"
      ? deps.resolveRawExcerptReadNamespace(
          request.namespace,
          trimmedSessionKey,
          authenticatedPrincipal,
        )
      : undefined;
  const hasExplicitNamespace =
    typeof request.namespace === "string" &&
    request.namespace.trim().length > 0;
  const rawExcerptsSuppressed =
    disclosure === "raw" &&
    !hasExplicitNamespace &&
    rawExcerptNamespace === undefined;
  const rawExcerptSessionIds =
    disclosure === "raw" && rawExcerptNamespace && trimmedSessionKey
      ? deps.resolveLcmReadSessionIds(
          request.namespace,
          rawExcerptNamespace,
          trimmedSessionKey,
          authenticatedPrincipal,
        )
      : undefined;
  let results = await deps.serializeRecallResults(snapshot, disclosure, {
    query,
    sessionKey: trimmedSessionKey,
    ...(rawExcerptNamespace ? { rawExcerptNamespace } : {}),
    ...(rawExcerptSessionIds !== undefined ? { rawExcerptSessionIds } : {}),
    ...(rawExcerptsSuppressed ? { rawExcerptsSuppressed } : {}),
  });

  const filterTags = normalizeTags(request.tags);
  let tagMatchMode: TagMatchMode | undefined;
  try {
    tagMatchMode = parseTagMatch(request.tagMatch);
  } catch (err) {
    throw new EngramAccessInputError(
      err instanceof Error ? err.message : String(err),
    );
  }
  let effectiveComposition: RecallContextComposition = contextComposition ?? { context };
  let effectiveContext = composeRecallContext(effectiveComposition);
  if (filterTags && filterTags.length > 0) {
    const beforeIds = results.map((r) => r.id);
    const { results: admitted } = applyTagFilter(results, {
      tags: filterTags,
      tagMatch: tagMatchMode,
    });
    results = admitted;
    const admittedIds = new Set(results.map((r) => r.id));
    // A rejected/absent snapshot serializes to zero results, so `beforeIds` is
    // empty and nothing in `context` is tag-verified — a nonempty tag filter
    // must still suppress that unverified memory text (#3514 review). The one
    // exception is a locked secure store: its early-return context is a
    // non-memory diagnostic (the unlock instructions), not recall text, so it
    // survives the filter (#3514 review).
    const secureStoreLocked =
      snapshot === null &&
      resolveRecallAuxiliaryCapabilities(deps.orchestrator.config).secureStore &&
      !deps.orchestrator.storage.isSecureStoreUnlocked();
    const droppedAny =
      beforeIds.some((id) => !admittedIds.has(id)) ||
      (snapshot === null && !secureStoreLocked && effectiveComposition.context.trim().length > 0);
    if (droppedAny) {
      const priorDegradation = effectiveComposition.degradation;
      const filteredContext = results
        .map((result) => result.content || result.preview)
        .filter((s) => s.length > 0)
        .join("\n\n");
      const rebuilt = boundRecallContextComposition({
        context: filteredContext,
        footer: effectiveComposition.footer,
        maxChars: deps.orchestrator.config.recallBudgetChars,
      });
      effectiveComposition =
        priorDegradation?.reason === "backend-unavailable"
          ? rebuilt.context.trim().length === 0
            ? composeMissingMemoryContext({ detail: priorDegradation.detail })
            : {
                ...rebuilt,
                degradation: {
                  state: "degraded" as const,
                  reason: "backend-unavailable" as const,
                  detail: priorDegradation.detail,
                  ...(rebuilt.degradation?.budget ? { budget: rebuilt.degradation.budget } : {}),
                },
              }
          : rebuilt;
      effectiveContext = composeRecallContext(effectiveComposition);
    }
  }
  const filteredMemoryIds = filterTags && filterTags.length > 0
    ? results.map((r) => r.id)
    : (snapshot?.memoryIds ?? []);
  const debug = await deps.buildRecallDebug(
    snapshot,
    effectiveNamespace,
    request.includeDebug === true,
    request.sessionKey,
  );
  const debugSnapshot = debug?.snapshot;
  const safeDebug =
    debug && debugSnapshot
      ? { ...debug, snapshot: displaySafeRecallSnapshot(debugSnapshot, deps.orchestrator.config.memoryDir) }
      : debug;

  let auditAnomalies: AccessAuditResult["anomalies"] | undefined;
  if (deps.auditAdapter) {
    try {
      const resolvedAgentId = principal ?? "__anonymous__";
      const auditEntry = {
        ts: new Date().toISOString(),
        sessionKey: request.sessionKey ?? "",
        agentId: resolvedAgentId,
        trigger: "access-surface",
        queryText: query,
        candidateMemoryIds: snapshot?.memoryIds ?? [],
        summary: effectiveContext.slice(0, 200) || null,
        injectedChars: effectiveContext.length,
        toggleState: "enabled" as const,
        latencyMs: Date.now() - startedAt,
        plannerMode: snapshot?.plannerMode ?? mode,
        requestedMode: mode,
        fallbackUsed: snapshot?.fallbackUsed ?? false,
        ...(effectiveComposition.degradation
          ? { degradation: effectiveComposition.degradation }
          : {}),
      };
      const auditResult = await deps.auditAdapter.record(
        resolvedAgentId || "__anonymous__",
        auditEntry,
      );
      auditAnomalies = auditResult.anomalies;
    } catch {
      // Audit failures must never crash the recall path.
    }
  }

  const retrievalFailure =
    effectiveComposition.degradation?.reason === "backend-unavailable"
      ? {
          reason: "backend_unavailable" as const,
          detail: effectiveComposition.degradation.detail ?? "backend_unavailable",
        }
      : undefined;

  return {
    response: {
      query,
      sessionKey: request.sessionKey,
      namespace: effectiveNamespace,
      context: effectiveContext,
      contextComposition: effectiveComposition,
      storageCorpusVersionsAtRecallStart,
      ...(retrievalFailure ? { retrievalFailure } : {}),
      count: filterTags && filterTags.length > 0
        ? results.length
        : (snapshot?.memoryIds.length ?? results.length),
      memoryIds: filteredMemoryIds,
      results,
      recordedAt: snapshot?.recordedAt,
      traceId: snapshot?.traceId,
      plannerMode: snapshot?.plannerMode ?? mode,
      fallbackUsed: snapshot?.fallbackUsed ?? false,
      sourcesUsed: snapshot?.sourcesUsed ?? [],
      disclosure,
      budgetsApplied: snapshot
        ? displaySafeRecallSnapshot(snapshot, deps.orchestrator.config.memoryDir).budgetsApplied
        : undefined,
      auditAnomalies,
      budgetWarning: toBudgetWarning(budgetDecision),
      latencyMs: snapshot?.latencyMs ?? (Date.now() - startedAt),
      timings: snapshot?.timings,
      debug: safeDebug,
    },
    budgetRecordPrincipal,
  };
}


