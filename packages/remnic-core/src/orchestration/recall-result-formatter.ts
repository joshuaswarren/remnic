/**
 * Recall result formatter — extracted from the orchestrator (issue #1526).
 *
 * Owns the formatting of recall search results into display sections, plus the
 * identity-continuity section assembly:
 *   - QMD result formatting (with memory handles + epistemic hedge rendering)
 *   - Specialized recall result formatters (objective-state, causal-trajectory,
 *     trust-zone, harmonic-retrieval, work-product, verified-episode,
 *     verified-semantic-rule)
 *   - Identity continuity helpers (summarizeIdentityText, formatOpenIncidentLine,
 *     trimIdentitySection) and the full buildIdentityContinuitySection builder
 *   - Module-level helpers hasIdentityRecoveryIntent and
 *     resolveEffectiveIdentityInjectionMode (only consumed here)
 *
 * Behavior-preserving move from orchestrator.ts. No logic changes — the
 * orchestrator constructs one instance and keeps thin delegating methods so
 * existing call sites and tests that exercise the private API continue to work.
 */

import { buildHandleIndexForResults } from "../recall-handles.js";
import path from "node:path";
import { renderAuthorityBoundContent } from "../recall-context-composition.js";
import { renderEpistemicHedge } from "../trust-score.js";
import { resolveIdentityContinuityCapabilities, resolveSecurityCapabilities } from "../capabilities.js";
import type { StorageManager } from "../index.js";
import type { ObjectiveStateSearchResult } from "../objective-state.js";
import type { CausalTrajectorySearchResult } from "../causal-trajectory.js";
import type { TrustZoneSearchResult } from "../trust-zones.js";
import type { HarmonicRetrievalResult } from "../harmonic-retrieval.js";
import type { VerifiedEpisodeResult } from "../verified-recall.js";
import type { VerifiedSemanticRuleResult } from "../semantic-rule-verifier.js";
import type { WorkProductLedgerSearchResult } from "../work-product-ledger.js";
import { trustResultFor, type TrustStageResultItem } from "../trust-score-stage.js";
import { CONNECTOR_ID_PATTERN, CONNECTOR_LABEL_MAX_LENGTH } from "../connectors/label.js";
import { isValidConnectorId } from "../connectors/index.js";
import type {
  ContinuityIncidentRecord,
  IdentityInjectionMode,
  PluginConfig,
  QmdSearchResult,
  RecallPlanMode,
} from "../types.js";

/**
 * Issue #2183 — render the persisted `sourceConnector` carried on the result
 * (hydrated where the memory is loaded) as `[agent: <connector>]`. The value
 * reaches model-visible recall context, so it is validated against the canonical
 * persisted-ID charset (CONNECTOR_ID_PATTERN — IDs the system accepts,
 * including '.'/'_', keep their label) and TRUNCATED past CONNECTOR_LABEL_MAX
 * with an explicit marker (attribution survives; suppression would lose the
 * exact signal this PR adds). One resolver at the single render site.
 */
function renderConnectorLabel(connector: string | undefined): string | null {
  if (!isValidConnectorId(connector)) return null;
  return connector.length <= CONNECTOR_LABEL_MAX_LENGTH
    ? connector
    : `${connector.slice(0, CONNECTOR_LABEL_MAX_LENGTH - 1)}…`;
}

// ---------------------------------------------------------------------------
// Identity injection mode helpers (moved verbatim from orchestrator.ts)
// ---------------------------------------------------------------------------

export function hasIdentityRecoveryIntent(prompt: string): boolean {
  const text = typeof prompt === "string" ? prompt.toLowerCase() : "";
  if (!text) return false;
  return /\b(identity|continuity|recover(?:y|ing|ed)?|incident|drift|restore|regress(?:ion|ed|ing)?)\b/i.test(
    text,
  );
}

export function resolveEffectiveIdentityInjectionMode(options: {
  configuredMode: IdentityInjectionMode;
  recallMode: RecallPlanMode;
  prompt: string;
}): { mode: IdentityInjectionMode; shouldInject: boolean } {
  if (
    options.configuredMode === "recovery_only" &&
    !hasIdentityRecoveryIntent(options.prompt)
  ) {
    return { mode: "recovery_only", shouldInject: false };
  }
  if (options.recallMode === "minimal" && options.configuredMode === "full") {
    return { mode: "minimal", shouldInject: true };
  }
  return { mode: options.configuredMode, shouldInject: true };
}

/**
 * Render an internal (possibly absolute) result path as a memoryDir-relative
 * path for display in prompts/citations, so operator-specific filesystem paths
 * never leak into recall output and citations stay portable across machines
 * (#2020). Non-absolute or out-of-root paths are returned unchanged.
 */
export function displayResultPath(
  resultPath: string,
  memoryDir: string,
  namespace?: string,
): string {
  if (!path.isAbsolute(resultPath)) return resultPath;
  const root = path.resolve(memoryDir);
  const nsRoot = path.join(root, "namespaces");
  if (namespace && (resultPath === nsRoot || resultPath.startsWith(nsRoot + path.sep))) {
    // memoryDir/namespaces/<token>/<rel> -> "<namespace>/<rel>", the exact
    // form the citation resolver decodes back to the owning namespace.
    const afterNs = path.relative(nsRoot, resultPath).split(path.sep).slice(1).join("/");
    if (afterNs) return `${namespace}/${afterNs}`;
  }
  const rel = path.relative(root, resultPath);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel)
    ? rel.split(path.sep).join("/")
    : resultPath;
}

/**
 * Return a copy of budget metadata with `includedMemoryPaths` rendered
 * memoryDir-relative, so recall/last-recall API callers never receive operator
 * filesystem paths via budget output even though the internal snapshot keeps
 * absolute paths for tracking/x-ray (#2020). Other fields are unchanged.
 */
export function displaySafeBudgetsApplied<
  T extends {
    includedMemoryPaths?: string[];
    includedMemoryNamespaces?: Array<string | undefined>;
  },
>(budgetsApplied: T | undefined, memoryDir: string): T | undefined {
  if (!budgetsApplied?.includedMemoryPaths) return budgetsApplied;
  return {
    ...budgetsApplied,
    includedMemoryPaths: budgetsApplied.includedMemoryPaths.map((p, i) =>
      displayResultPath(p, memoryDir, budgetsApplied.includedMemoryNamespaces?.[i]),
    ),
  };
}

/**
 * Return a display-safe copy of a recall snapshot for the `includeDebug=true`
 * surface (#2077). `resultPaths` and `budgetsApplied.includedMemoryPaths` are
 * rendered namespace-relative from their aligned namespace metadata; a
 * `tierExplain.sourceAnchors[]` entry reuses that SAME authoritative metadata
 * when its absolute path matches a result/included path, and otherwise falls
 * back to the memoryDir-relative on-disk form. Either way the debug flag never
 * leaks absolute operator paths, and an anchor is never attributed to a decoded
 * (guessed) namespace — an anchor carries no owner of its own. Returns a
 * shallow copy; the input snapshot is never mutated.
 */
export function displaySafeRecallSnapshot<
  T extends {
    resultPaths?: string[];
    resultNamespaces?: Array<string | undefined>;
    budgetsApplied?: {
      includedMemoryPaths?: string[];
      includedMemoryNamespaces?: Array<string | undefined>;
    };
    tierExplain?: {
      sourceAnchors?: Array<{ path: string; lineRange?: [number, number] }>;
    };
  },
>(snapshot: T, memoryDir: string): T {
  const resultPaths = snapshot.resultPaths?.map((p, i) =>
    displayResultPath(p, memoryDir, snapshot.resultNamespaces?.[i]),
  );
  // Authoritative absolute-path -> namespace map recorded at capture time, so a
  // tier anchor that coincides with a returned result renders under the SAME
  // namespace as that result instead of the raw storage segment (#2077).
  const namespaceByPath = new Map<string, string | undefined>();
  snapshot.resultPaths?.forEach((p, i) => {
    if (!namespaceByPath.has(p)) namespaceByPath.set(p, snapshot.resultNamespaces?.[i]);
  });
  snapshot.budgetsApplied?.includedMemoryPaths?.forEach((p, i) => {
    if (!namespaceByPath.has(p)) {
      namespaceByPath.set(p, snapshot.budgetsApplied?.includedMemoryNamespaces?.[i]);
    }
  });
  const tierExplain =
    snapshot.tierExplain?.sourceAnchors
      ? {
          ...snapshot.tierExplain,
          sourceAnchors: snapshot.tierExplain.sourceAnchors.map((anchor) => ({
            ...anchor,
            path: displayResultPath(anchor.path, memoryDir, namespaceByPath.get(anchor.path)),
          })),
        }
      : undefined;
  return {
    ...snapshot,
    ...(resultPaths ? { resultPaths } : {}),
    ...(snapshot.budgetsApplied
      ? { budgetsApplied: displaySafeBudgetsApplied(snapshot.budgetsApplied, memoryDir) }
      : {}),
    ...(tierExplain ? { tierExplain } : {}),
  };
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Formats recall search results into display sections and assembles the
 * identity-continuity section. Holds a reference to config for feature-gated
 * rendering (memory handles, epistemic hedges, identity injection mode).
 */
export class RecallResultFormatter {
  private readonly originAuthorityEnabled: boolean;
  constructor(private readonly config: PluginConfig) {
    this.originAuthorityEnabled = resolveSecurityCapabilities(config).originAuthority;
  }

  // ── QMD results (memory handles + epistemic hedge) ──────────────────────

  formatQmdResultEntries(
    title: string,
    results: QmdSearchResult[],
    sessionKey?: string,
    trustByPath?: Map<string, TrustStageResultItem> | null,
  ): { heading: string; entries: string[] } {
    const handleByIndex = buildHandleIndexForResults(
      results,
      this.config.recallMemoryHandles === true && sessionKey != null,
    );
    const renderHedge =
      this.config.trustScoreEpistemicRendering &&
      trustByPath !== null &&
      trustByPath !== undefined;
    const hedgeMap = renderHedge ? trustByPath : null;
    const entries = results.map((r, i) => {
      const snippetBody = r.snippet
        ? r.snippet.slice(0, 500).replace(/\n/g, " ")
        : "(no preview)";
      const snippet = renderAuthorityBoundContent(
        snippetBody,
        r.origin,
        {
          enabled: this.originAuthorityEnabled,
          untrustedOrigins: this.config.untrustedOrigins,
        },
      );
      const displayPath = displayResultPath(r.path, this.config.memoryDir, r.namespace);
      const source = typeof r.line === "number" ? `${displayPath}:${r.line}` : displayPath;
      const head = `[${i + 1}] ${source} (score: ${r.score.toFixed(3)})\n${snippet}`;
      const handle = handleByIndex.get(i);
      const withHandle = handle ? `${head.trimEnd()} ${handle}` : head.trimEnd();
      const connectorLabel = renderConnectorLabel(r.sourceConnector);
      const withConnector = connectorLabel ? `${withHandle} [agent: ${connectorLabel}]` : withHandle;
      if (hedgeMap) {
        const item = trustResultFor(hedgeMap, r);
        if (item) {
          const hedge = renderEpistemicHedge(item.trust);
          if (hedge.length > 0) return `${withConnector} ${hedge}`;
        }
      }
      return withConnector;
    });
    return { heading: `## ${title}`, entries };
  }

  formatQmdResults(
    title: string,
    results: QmdSearchResult[],
    sessionKey?: string,
    trustByPath?: Map<string, TrustStageResultItem> | null,
  ): string {
    const formatted = this.formatQmdResultEntries(
      title,
      results,
      sessionKey,
      trustByPath,
    );
    return [formatted.heading, ...formatted.entries].join("\n\n");
  }

  // ── Specialized recall result formatters ────────────────────────────────

  formatObjectiveStateResults(
    results: ObjectiveStateSearchResult[],
  ): string {
    const lines = results.map(({ snapshot }, index) => {
      const parts = [
        snapshot.recordedAt.replace("T", " ").slice(0, 16),
        `${snapshot.kind}/${snapshot.changeKind}`,
      ];
      if (snapshot.outcome) parts.push(snapshot.outcome);
      const header = `[${index + 1}] ${parts.join(" | ")} | ${snapshot.scope}`;
      const detailParts = [snapshot.summary];
      if (snapshot.command) detailParts.push(`command: ${snapshot.command}`);
      else if (snapshot.toolName)
        detailParts.push(`tool: ${snapshot.toolName}`);
      return `${header}\n${detailParts.join(" | ")}`;
    });
    return `## Objective State\n\n${lines.join("\n\n")}`;
  }

  formatCausalTrajectoryResults(
    results: CausalTrajectorySearchResult[],
  ): string {
    const lines = results.map(({ record, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${record.recordedAt.replace("T", " ").slice(0, 16)}`,
        record.outcomeKind,
      ].join(" | ");
      const details = [
        `goal: ${record.goal}`,
        `action: ${record.actionSummary}`,
        `observation: ${record.observationSummary}`,
        `outcome: ${record.outcomeSummary}`,
      ];
      if (record.followUpSummary)
        details.push(`follow-up: ${record.followUpSummary}`);
      if (matchedFields.length > 0)
        details.push(`matched: ${matchedFields.join(", ")}`);
      return `${header}\n${details.join("\n")}`;
    });

    return `## Causal Trajectories\n\n${lines.join("\n\n")}`;
  }

  formatTrustZoneResults(results: TrustZoneSearchResult[]): string {
    const lines = results.map(({ record, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${record.recordedAt.replace("T", " ").slice(0, 16)}`,
        record.zone,
        record.kind,
      ].join(" | ");
      const details = [
        record.summary,
        `provenance: ${record.provenance.sourceClass}`,
      ];
      if (record.entityRefs && record.entityRefs.length > 0) {
        details.push(`entities: ${record.entityRefs.join(", ")}`);
      }
      if (record.tags && record.tags.length > 0) {
        details.push(`tags: ${record.tags.join(", ")}`);
      }
      if (matchedFields.length > 0) {
        details.push(`matched: ${matchedFields.join(", ")}`);
      }
      return `${header}\n${details.join("\n")}`;
    });

    return `## Trust Zones\n\n${lines.join("\n\n")}`;
  }

  formatHarmonicRetrievalResults(
    results: HarmonicRetrievalResult[],
  ): string {
    const lines = results.map(
      (
        { node, matchedAnchors, matchedFields, nodeScore, anchorScore },
        index,
      ) => {
        const header = [
          `[${index + 1}] ${node.recordedAt.replace("T", " ").slice(0, 16)}`,
          `${node.kind}/${node.abstractionLevel}`,
          node.sessionKey,
        ].join(" | ");
        // #1955 review: node title/summary copy active source-memory content;
        // harmonic nodes carry no per-node origin yet, so fence as unknown
        // (least privilege) when origin authority is on (plumbing: #2397).
        // Flag-off keeps the original two-slot shape byte-identical.
        const bodyParts = this.originAuthorityEnabled
          ? [renderAuthorityBoundContent(
              [node.title, node.summary].filter(Boolean).join("\n"),
              undefined,
              { enabled: true, untrustedOrigins: this.config.untrustedOrigins },
            )]
          : [node.title, node.summary];
        const details = [
          ...bodyParts,
          `scores: node=${nodeScore.toFixed(1)} anchor=${anchorScore.toFixed(1)}`,
        ];
        if (matchedAnchors.length > 0) {
          details.push(
            `anchors: ${matchedAnchors.map((anchor) => `${anchor.anchorType}:${anchor.anchorValue}`).join("; ")}`,
          );
        }
        if (matchedFields.length > 0) {
          details.push(`matched: ${matchedFields.join(", ")}`);
        }
        return `${header}\n${details.join("\n")}`;
      },
    );

    return `## Harmonic Retrieval\n\n${lines.join("\n\n")}`;
  }

  /**
   * Render grouped raw-turn episodes for the top recalled facts (issue #2331).
   * Returns `null` for zero episodes so the section is omitted entirely —
   * never an empty header.
   */
  formatEpisodicContext(
    episodes: ReadonlyArray<{
      sessionKey: string;
      fromTurn: number;
      toTurn: number;
      memoryIds: readonly string[];
      turns: ReadonlyArray<{ role: string; content: string }>;
    }>,
  ): string | null {
    if (episodes.length === 0) return null;
    const blocks = episodes.map((episode) => {
      const shortKey =
        episode.sessionKey.length > 8
          ? `${episode.sessionKey.slice(0, 8)}…`
          : episode.sessionKey;
      const header =
        `### Episode: ${shortKey} turns ${episode.fromTurn}-${episode.toTurn - 1} ` +
        `(supports [${episode.memoryIds.join(", ")}])`;
      const lines = episode.turns.map(
        (turn) => `${turn.role}: ${turn.content}`,
      );
      return [header, ...lines].join("\n");
    });
    return `## Source Episodes\n\n${blocks.join("\n\n")}`;
  }

  formatWorkProductResults(
    results: WorkProductLedgerSearchResult[],
  ): string {
    const lines = results.map(({ entry, matchedFields }, index) => {
      const header = [
        `[${index + 1}] ${entry.recordedAt.replace("T", " ").slice(0, 16)}`,
        `${entry.kind}/${entry.action}`,
        entry.sessionKey,
      ].join(" | ");
      const details = [entry.summary, `scope: ${entry.scope}`];
      if (entry.artifactPath) details.push(`artifact: ${entry.artifactPath}`);
      if (entry.tags && entry.tags.length > 0)
        details.push(`tags: ${entry.tags.join(", ")}`);
      if (matchedFields.length > 0)
        details.push(`matched: ${matchedFields.join(", ")}`);
      return `${header}\n${details.join("\n")}`;
    });

    return `## Work Products\n\n${lines.join("\n\n")}`;
  }

  formatVerifiedEpisodeResults(
    results: VerifiedEpisodeResult[],
  ): string {
    const lines = results.map(
      ({ box, verifiedEpisodeCount, matchedFields }, index) => {
        const header = [
          `[${index + 1}] ${box.sealedAt.replace("T", " ").slice(0, 16)}`,
          box.traceId ? `trace:${box.traceId.slice(0, 12)}` : "trace:none",
        ].join(" | ");
        const details = [
          box.goal ?? `topics: ${box.topics.join(", ")}`,
          `verified episodes: ${verifiedEpisodeCount}`,
        ];
        if (box.toolsUsed && box.toolsUsed.length > 0) {
          details.push(`tools: ${box.toolsUsed.join(", ")}`);
        }
        if (matchedFields.length > 0) {
          details.push(`matched: ${matchedFields.join(", ")}`);
        }
        return `${header}\n${details.join("\n")}`;
      },
    );

    return `## Verified Episodes\n\n${lines.join("\n\n")}`;
  }

  formatVerifiedSemanticRuleResults(
    results: VerifiedSemanticRuleResult[],
  ): string {
    const lines = results.map(
      (
        {
          rule,
          sourceMemoryId,
          verificationStatus,
          effectiveConfidence,
          matchedFields,
        },
        index,
      ) => {
        const header = [
          `[${index + 1}] ${rule.frontmatter.updated.replace("T", " ").slice(0, 16)}`,
          verificationStatus,
          `confidence:${effectiveConfidence.toFixed(2)}`,
        ].join(" | ");
        // #1955 review: the rule body derives from a source memory whose
        // origin is not copied onto the rule — fence via the rule's own
        // frontmatter origin (missing → unknown, least privilege) when on.
        const ruleBody = renderAuthorityBoundContent(rule.content, rule.frontmatter.origin, {
          enabled: this.originAuthorityEnabled,
          untrustedOrigins: this.config.untrustedOrigins,
        });
        const details = [ruleBody, `source memory: ${sourceMemoryId}`];
        if (matchedFields.length > 0) {
          details.push(`matched: ${matchedFields.join(", ")}`);
        }
        return `${header}\n${details.join("\n")}`;
      },
    );

    return `## Verified Rules\n\n${lines.join("\n\n")}`;
  }

  // ── Identity continuity helpers ─────────────────────────────────────────

  summarizeIdentityText(
    raw: string,
    maxLines: number,
    maxChars: number,
  ): string {
    const lines = raw
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    const compact = lines.slice(0, Math.max(1, maxLines)).join(" ");
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  formatOpenIncidentLine(
    incident: ContinuityIncidentRecord,
    includeDetails: boolean,
  ): string {
    const base = `[${incident.id}] ${incident.symptom.trim()}`;
    if (!includeDetails) return `- ${base}`;
    const parts = [base];
    if (incident.suspectedCause)
      parts.push(`cause: ${incident.suspectedCause.trim()}`);
    if (incident.triggerWindow)
      parts.push(`window: ${incident.triggerWindow.trim()}`);
    return `- ${parts.join(" | ")}`;
  }

  trimIdentitySection(
    content: string,
    maxChars: number,
  ): { text: string; truncated: boolean } {
    if (maxChars <= 0) return { text: "", truncated: false };
    if (content.length <= maxChars) return { text: content, truncated: false };
    const suffix = "\n\n...(identity continuity trimmed)";
    if (maxChars <= suffix.length) {
      return { text: content.slice(0, maxChars), truncated: true };
    }
    const headroom = Math.max(0, maxChars - suffix.length);
    return { text: `${content.slice(0, headroom)}${suffix}`, truncated: true };
  }

  async buildIdentityContinuitySection(options: {
    storage: StorageManager;
    recallMode: RecallPlanMode;
    prompt: string;
  }): Promise<{
    section: string;
    mode: IdentityInjectionMode;
    injectedChars: number;
    truncated: boolean;
  } | null> {
    if (!resolveIdentityContinuityCapabilities(this.config).identityContinuity) return null;
    if (this.config.identityMaxInjectChars <= 0) return null;

    const resolved = resolveEffectiveIdentityInjectionMode({
      configuredMode: this.config.identityInjectionMode,
      recallMode: options.recallMode,
      prompt: options.prompt,
    });
    if (!resolved.shouldInject) return null;

    const [anchorRaw, loopsRaw, incidents] = await Promise.all([
      options.storage.readIdentityAnchor(),
      options.storage.readIdentityImprovementLoops(),
      options.storage.readContinuityIncidents(200),
    ]);
    const openIncidents = incidents.filter(
      (incident) => incident.state === "open",
    );

    const lines: string[] = [];
    if (resolved.mode === "full") {
      lines.push("## Identity Continuity");
      if (anchorRaw && anchorRaw.trim().length > 0) {
        lines.push("", "### Anchor", "", anchorRaw.trim());
      }
      if (loopsRaw && loopsRaw.trim().length > 0) {
        lines.push("", "### Improvement Loops", "", loopsRaw.trim());
      }
      lines.push("", "### Open Incidents", "");
      if (openIncidents.length === 0) {
        lines.push("- none");
      } else {
        lines.push(
          ...openIncidents
            .slice(0, 5)
            .map((incident) => this.formatOpenIncidentLine(incident, true)),
        );
      }
    } else {
      const anchorSummary = anchorRaw
        ? this.summarizeIdentityText(anchorRaw, 3, 320)
        : "";
      const loopsSummary = loopsRaw
        ? this.summarizeIdentityText(loopsRaw, 2, 240)
        : "";
      lines.push("## Identity Continuity Signals", "");
      if (anchorSummary) lines.push(`- anchor: ${anchorSummary}`);
      if (loopsSummary) lines.push(`- loops: ${loopsSummary}`);
      if (openIncidents.length === 0) {
        lines.push("- incidents: 0 open");
      } else {
        lines.push(`- incidents: ${openIncidents.length} open`);
        lines.push(
          ...openIncidents
            .slice(0, 2)
            .map((incident) => this.formatOpenIncidentLine(incident, false)),
        );
      }
    }

    const body = lines.join("\n").trim();
    if (!body) return null;

    const { text, truncated } = this.trimIdentitySection(
      body,
      this.config.identityMaxInjectChars,
    );
    if (!text) return null;

    return {
      section: text,
      mode: resolved.mode,
      injectedChars: text.length,
      truncated,
    };
  }
}
