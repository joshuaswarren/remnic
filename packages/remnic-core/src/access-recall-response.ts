/**
 * Recall response assembly (issue #1906), extracted from access-recall-surface.ts
 * to keep that grandfathered file within its structural-ratchet ceiling
 * (#1520/#1995). Verbatim move of `AccessRecallSurface.assembleRecallResponse`
 * as a free function taking the surface's dependency bundle; behavior unchanged.
 */
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
import type { RecallDisclosure, RecallPlanMode } from "./types.js";
import { displaySafeBudgetsApplied, displaySafeRecallSnapshot } from "./orchestration/recall-result-formatter.js";

/**
 * Build the recall response from the completed pipeline (issue #1906 review
 * #5). Extracted so executeRecall can wrap the ENTIRE post-reservation
 * operation — this method plus orchestrator.recall — in one rollback guard,
 * releasing the reserved budget entry on any failure through response
 * construction. `budgetRecordPrincipal` is threaded back unchanged.
 */
export async function assembleRecallResponse(
  deps: AccessRecallSurfaceDeps,
  params: {
  request: EngramAccessRecallRequest;
  context: string;
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
  const snapshot = request.sessionKey
    ? deps.orchestrator.lastRecall.get(request.sessionKey)
    : null;
  const effectiveNamespace = snapshot?.namespace
    ? deps.resolveNamespace(snapshot.namespace)
    : namespace;
  // Auto-escalation policy (issue #677 PR 4/4).  When the operator
  // configured `recallDisclosureEscalation: "auto"` AND the caller
  // did not explicitly choose a disclosure level AND recall produced
  // a low-confidence result set (proxied by fill ratio: results
  // returned / topK requested), we escalate the default `chunk`
  // shape to `section` so the LLM gets richer context to compensate
  // for ambiguous retrieval.  Manual mode and explicit caller
  // disclosure both bypass the policy.  Documented in
  // `recall-disclosure-escalation.ts` and unit-tested there.
  // Confidence-proxy denominator: priority order is
  //   1. `snapshot.budgetsApplied.appliedTopK` (ALWAYS wins) — this is
  //      the limit the orchestrator actually applied after planner /
  //      minimal-mode / section-cap narrowing.  Codex P1 rounds 2+3
  //      on #705 emphasize that even a caller's explicit `request.topK`
  //      is wrong when the orchestrator caps below it (e.g. topK=50
  //      but appliedTopK=3 makes a 2-hit recall actually 0.67, not
  //      0.04).
  //   2. The caller's explicit `topK` when the snapshot lacks
  //      `budgetsApplied` (early-return paths, error cases).
  //   3. Config `qmdMaxResults` as a last-resort fallback.
  // Floor at observed-results so the ratio stays in [0, 1] even if
  // any of the signals drifts below the actual hit count.
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
  // When the recall produced no snapshot (sessionless / namespace
  // mismatch / early-return path), there is no confidence signal to
  // base escalation on.  Pass `undefined` so the helper takes its
  // `no-top-k-confidence` branch instead of computing 0/N=0 and
  // forcing auto-escalation on every sessionless caller (Codex P2
  // review on PR #705).
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
  // Gate the raw-excerpt LCM read with the SAME read-authorization namespace
  // `lcmSearch` + the in-prompt LCM sections use (#1505 thread 2f7), so
  // `disclosure: "raw"` never attaches `<principal>-project-*` overlay rows
  // when the principal can WRITE but not READ its self base (or
  // `defaultRecallNamespaces` omits `self`). Computed ONLY for raw disclosure:
  // it is the sole consumer, and resolving the overlay on every chunk/section
  // recall would be wasted work — keeping non-raw recall byte-for-byte
  // unchanged.
  // Trim the sessionKey to match what `orchestrator.recall(...)` already does
  // (`request.sessionKey?.trim() || undefined`) and what the x-ray raw-excerpt
  // path uses (cursor "Raw excerpt key not trimmed"). A whitespace-padded key
  // otherwise drives recall under one identity but resolves the raw-excerpt
  // overlay namespace + LCM `session_id` under a DIFFERENT (untrimmed) prefix,
  // so excerpts are gated/queried inconsistently with recall and the x-ray path.
  const trimmedSessionKey = request.sessionKey?.trim() || undefined;
  const rawExcerptNamespace =
    disclosure === "raw"
      ? deps.resolveRawExcerptReadNamespace(
          request.namespace,
          trimmedSessionKey,
          authenticatedPrincipal,
        )
      : undefined;
  // `undefined` for an IMPLICIT raw recall means NO readable LCM namespace
  // exists (restrictive `default` READ policy, no readable overlay/self) —
  // suppress excerpts rather than fall back to the write/overlay namespace the
  // read gate excludes (#1505 thread NBHWz). An EXPLICIT namespace always
  // resolves (or throws) above, so suppression only applies to the implicit
  // path.
  const hasExplicitNamespace =
    typeof request.namespace === "string" &&
    request.namespace.trim().length > 0;
  const rawExcerptsSuppressed =
    disclosure === "raw" &&
    !hasExplicitNamespace &&
    rawExcerptNamespace === undefined;
  // Ordered, read-authorized LCM read key SET (#1505 fallback unification) so
  // raw disclosure finds excerpts a branch-scoped session archived at
  // project/root scope — exactly as recall + `lcmSearch` do. Only with a
  // concrete sessionKey; already read-gated.
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

  // Tag filter (issue #689). Applied post-recall, post-serialization so
  // the actual frontmatter tags are already loaded onto each result. When
  // `tags` is absent or empty the filter is a no-op; an invalid `tagMatch`
  // throws via `parseTagMatch` (CLAUDE.md rule 51).
  const filterTags = normalizeTags(request.tags);
  let tagMatchMode: TagMatchMode | undefined;
  try {
    tagMatchMode = parseTagMatch(request.tagMatch);
  } catch (err) {
    throw new EngramAccessInputError(
      err instanceof Error ? err.message : String(err),
    );
  }
  let effectiveContext = context;
  if (filterTags && filterTags.length > 0) {
    const beforeIds = results.map((r) => r.id);
    const { results: admitted } = applyTagFilter(results, {
      tags: filterTags,
      tagMatch: tagMatchMode,
    });
    results = admitted;
    // Codex P1: `context` was generated by orchestrator.recall(...)
    // BEFORE the tag filter ran, so it can contain memories that don't
    // match the requested tags. Surfaces consuming `context` (the
    // prompt-injection string) would leak excluded content into the
    // LLM. When the filter actually drops any result, rebuild context
    // from the admitted set so excluded content is unreachable through
    // any field of the response. The rebuilt context concatenates each
    // admitted result's available text (full content at section/raw
    // disclosure, otherwise the preview) — a different wire format
    // than the orchestrator's native context, but a strict subset
    // safe to inject.
    const admittedIds = new Set(results.map((r) => r.id));
    const droppedAny = beforeIds.some((id) => !admittedIds.has(id));
    if (droppedAny) {
      effectiveContext = results
        .map((r) => {
          const content =
            typeof (r as { content?: unknown }).content === "string"
              ? ((r as { content?: string }).content ?? "")
              : "";
          const preview =
            typeof (r as { preview?: unknown }).preview === "string"
              ? ((r as { preview?: string }).preview ?? "")
              : "";
          return content || preview;
        })
        .filter((s) => s.length > 0)
        .join("\n\n");
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
  // Relativize the debug snapshot's absolute internal paths (#2077). The
  // snapshot returned by buildRecallDebug is the LIVE cached object (kept
  // absolute for tracking/x-ray), so build a display-safe COPY rather than
  // mutating it — mirroring the top-level `budgetsApplied` relativization.
  const debugSnapshot = debug?.snapshot;
  const safeDebug =
    debug && debugSnapshot
      ? { ...debug, snapshot: displaySafeRecallSnapshot(debugSnapshot, deps.orchestrator.config) }
      : debug;

  // Fire-and-forget audit recording. Must never block or crash recall.
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
        // Audit must reflect what was actually injected, not what
        // recall produced before the tag filter. Using `context`
        // (pre-filter) overstates injectedChars and can leak content
        // from excluded memories into the audit summary (cursor
        // Medium on PR #712).
        summary: effectiveContext.slice(0, 200) || null,
        injectedChars: effectiveContext.length,
        toggleState: "enabled" as const,
        latencyMs: Date.now() - startedAt,
        plannerMode: snapshot?.plannerMode ?? mode,
        requestedMode: mode,
        fallbackUsed: snapshot?.fallbackUsed ?? false,
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

  return {
    response: {
      query,
      sessionKey: request.sessionKey,
      namespace: effectiveNamespace,
      context: effectiveContext,
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
      budgetsApplied: displaySafeBudgetsApplied(snapshot?.budgetsApplied, deps.orchestrator.config.memoryDir),
      auditAnomalies,
      budgetWarning: toBudgetWarning(budgetDecision),
      latencyMs: snapshot?.latencyMs ?? (Date.now() - startedAt),
      debug: safeDebug,
    },
    // Non-null when this recall reserved a cross-namespace budget event at
    // admission (#1906). Single-flight followers use it to record their OWN
    // per-caller budget event (the pipeline — and its reserve — ran once).
    budgetRecordPrincipal,
  };
}


