/**
 * Unified Recall X-ray renderer (issue #570, PR 2).
 *
 * Pure functions that format a `RecallXraySnapshot` for human text,
 * GitHub-flavored markdown, and machine JSON consumption.  CLI / HTTP
 * / MCP surfaces all call into this module — they do NOT format X-ray
 * output themselves, so rendering is tested in one place (CLAUDE.md
 * rule 22).
 *
 * Scope for PR 2 (this slice):
 *   - Pure rendering.  No IO, no transport, no capture.
 *   - `renderXray(snapshot, format)` with format ∈
 *     `{"json", "text", "markdown"}`.
 *   - `parseXrayFormat(value)` — input validator that rejects unknown
 *     formats with a listed-options error (CLAUDE.md rule 51).
 *   - Golden-file-style tests in `recall-xray-renderer.test.ts`.
 */

import type {
  RecallFilterTrace,
  RecallXrayResult,
  RecallXraySnapshot,
  RecallXrayServedBy,
} from "./recall-xray.js";
import { summarizeDisclosureTokens } from "./recall-xray.js";
import { renderTierExplainTextLines } from "./recall-explain-renderer.js";
import { summarizeRetrievedMemoryProvenance } from "./memory-provenance.js";

export type RecallXrayFormat = "json" | "text" | "markdown";

export const RECALL_XRAY_FORMATS: readonly RecallXrayFormat[] = [
  "json",
  "text",
  "markdown",
] as const;

/**
 * Validate and coerce a user-provided `--format` / `format` argument to
 * `RecallXrayFormat`.  Unknown values throw an error listing valid
 * options (CLAUDE.md rule 51).  `undefined`/`null` defaults to `"text"`.
 */
export function parseXrayFormat(value: unknown): RecallXrayFormat {
  if (value === undefined || value === null) return "text";
  if (typeof value !== "string") {
    throw new Error(
      `--format expects one of ${RECALL_XRAY_FORMATS.join(", ")}; got ${typeof value}`,
    );
  }
  const v = value.trim().toLowerCase();
  if (v === "json" || v === "text" || v === "markdown") return v;
  throw new Error(
    `--format expects one of ${RECALL_XRAY_FORMATS.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

/**
 * Top-level dispatcher.  CLI / HTTP / MCP callers should always route
 * through this function so the three formats stay in lock-step.
 */
export function renderXray(
  snapshot: RecallXraySnapshot | null,
  format: RecallXrayFormat,
): string {
  if (format === "json") return renderXrayJson(snapshot);
  if (format === "markdown") return renderXrayMarkdown(snapshot);
  return renderXrayText(snapshot);
}

// ─── JSON ─────────────────────────────────────────────────────────────────

/**
 * Deterministic JSON encoding of an X-ray snapshot.  Returns a stable
 * v1 envelope when the snapshot is absent so consumers can pattern-match
 * on `snapshotFound` rather than distinguishing `null` vs `{}`.
 */
export function renderXrayJson(snapshot: RecallXraySnapshot | null): string {
  if (!snapshot) {
    return JSON.stringify(
      { schemaVersion: "1", snapshotFound: false },
      null,
      2,
    );
  }
  // `snapshotFound` is injected *before* the rest so downstream JSON
  // consumers see it near the top of the document.
  return JSON.stringify(
    { snapshotFound: true, ...snapshot },
    null,
    2,
  );
}

// ─── Text ─────────────────────────────────────────────────────────────────

export function renderXrayText(snapshot: RecallXraySnapshot | null): string {
  const lines: string[] = ["=== Recall X-ray ==="];
  if (!snapshot) {
    lines.push("No X-ray snapshot captured.");
    return lines.join("\n");
  }

  lines.push(`query: ${snapshot.query}`);
  lines.push(`snapshot-id: ${snapshot.snapshotId}`);
  lines.push(`captured-at: ${formatCapturedAt(snapshot.capturedAt)}`);
  if (snapshot.sessionKey) lines.push(`session: ${snapshot.sessionKey}`);
  if (snapshot.namespace) lines.push(`namespace: ${snapshot.namespace}`);
  if (snapshot.traceId) lines.push(`trace-id: ${snapshot.traceId}`);
  lines.push(
    `budget: ${snapshot.budget.used} / ${snapshot.budget.chars} chars`,
  );

  lines.push("");
  lines.push("--- filters ---");
  if (snapshot.filters.length === 0) {
    lines.push("(no filter traces recorded)");
  } else {
    for (const f of snapshot.filters) {
      lines.push(renderFilterTextLine(f));
    }
  }

  lines.push("");
  lines.push("--- results ---");
  if (snapshot.results.length === 0) {
    lines.push("(no results admitted)");
  } else {
    snapshot.results.forEach((result, idx) => {
      for (const line of renderResultTextLines(result, idx + 1)) {
        lines.push(line);
      }
    });
  }

  lines.push("");
  lines.push("--- tier explain ---");
  for (const line of renderTierExplainTextLines(snapshot.tierExplain ?? null)) {
    lines.push(line);
  }

  return lines.join("\n");
}

function renderFilterTextLine(f: RecallFilterTrace): string {
  const base = `- ${f.name}: ${f.admitted}/${f.considered} admitted`;
  return f.reason ? `${base} (${f.reason})` : base;
}

function renderResultTextLines(
  result: RecallXrayResult,
  rank: number,
): string[] {
  const lines: string[] = [];
  lines.push(`[${rank}] ${result.memoryId} — ${servedByLabel(result.servedBy)}`);
  if (result.path) lines.push(`    path: ${result.path}`);
  lines.push(`    score: ${renderScoreDecomposition(result)}`);
  if (result.provenance) {
    lines.push(
      `    provenance: ${summarizeRetrievedMemoryProvenance(result.provenance)}`,
    );
    lines.push(`    retrieval-reason: ${result.provenance.retrievalReason}`);
    if (result.provenance.userContextScopes.length > 0) {
      lines.push(
        `    context-scopes: ${result.provenance.userContextScopes.join(", ")}`,
      );
    }
    if (
      result.provenance.safety !== "safe" ||
      result.provenance.safetyReasons.length > 0
    ) {
      const reasonSuffix =
        result.provenance.safetyReasons.length > 0
          ? ` (${result.provenance.safetyReasons.join(", ")})`
          : "";
      lines.push(`    safety: ${result.provenance.safety}${reasonSuffix}`);
    }
  }
  if (result.admittedBy.length > 0) {
    lines.push(`    admitted-by: ${result.admittedBy.join(", ")}`);
  }
  if (result.rejectedBy) {
    lines.push(`    rejected-by: ${result.rejectedBy}`);
  }
  if (result.graphPath && result.graphPath.length > 0) {
    lines.push(`    graph-path: ${result.graphPath.join(" -> ")}`);
    // Issue #681 PR 3/3 — surface per-edge confidence inline so
    // operators can attribute floor-pruning / PageRank ranking
    // decisions to specific edges. Skipped when no confidences were
    // recorded (legacy snapshot or single-node path).
    if (
      result.graphEdgeConfidences &&
      result.graphEdgeConfidences.length > 0
    ) {
      lines.push(
        `    edge-confidences: ${result.graphEdgeConfidences
          .map((c) => c.toFixed(2))
          .join(", ")}`,
      );
    }
  }
  if (result.auditEntryId) {
    lines.push(`    audit-entry: ${result.auditEntryId}`);
  }
  return lines;
}

// ─── Markdown ─────────────────────────────────────────────────────────────

export function renderXrayMarkdown(
  snapshot: RecallXraySnapshot | null,
): string {
  const lines: string[] = ["# Recall X-ray"];
  if (!snapshot) {
    lines.push("");
    lines.push("_No X-ray snapshot captured._");
    return lines.join("\n");
  }

  lines.push("");
  lines.push(`**Query:** ${mdInlineCode(snapshot.query)}`);
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Snapshot ID | \`${snapshot.snapshotId}\` |`);
  lines.push(`| Captured at | ${formatCapturedAt(snapshot.capturedAt)} |`);
  if (snapshot.sessionKey) {
    lines.push(`| Session | \`${snapshot.sessionKey}\` |`);
  }
  if (snapshot.namespace) {
    lines.push(`| Namespace | \`${snapshot.namespace}\` |`);
  }
  if (snapshot.traceId) {
    lines.push(`| Trace ID | \`${snapshot.traceId}\` |`);
  }
  lines.push(
    `| Budget | ${snapshot.budget.used} / ${snapshot.budget.chars} chars |`,
  );

  lines.push("");
  lines.push("## Filters");
  if (snapshot.filters.length === 0) {
    lines.push("");
    lines.push("_No filter traces recorded._");
  } else {
    lines.push("");
    lines.push("| Filter | Considered | Admitted | Reason |");
    lines.push("| --- | ---: | ---: | --- |");
    for (const f of snapshot.filters) {
      const reason = f.reason ? mdEscape(f.reason) : "";
      lines.push(`| ${mdEscape(f.name)} | ${f.considered} | ${f.admitted} | ${reason} |`);
    }
  }

  lines.push("");
  lines.push("## Results");
  if (snapshot.results.length === 0) {
    lines.push("");
    lines.push("_No results admitted._");
  } else {
    snapshot.results.forEach((result, idx) => {
      for (const line of renderResultMarkdownLines(result, idx + 1)) {
        lines.push(line);
      }
    });

    // Per-disclosure token-spend summary (issue #677 PR 3/4).  Only
    // emitted when at least one result carries a disclosure level so
    // we don't pollute the snapshot for callers who haven't wired the
    // depth knob through.  Counts and tokens default to 0 for buckets
    // with no contributions.
    const summary = summarizeDisclosureTokens(snapshot.results);
    const hasAnyDisclosure =
      summary.chunk.count + summary.section.count + summary.raw.count > 0;
    if (hasAnyDisclosure) {
      lines.push("");
      lines.push("### Token spend by disclosure");
      lines.push("");
      lines.push("| Disclosure | Results | Estimated tokens |");
      lines.push("| --- | ---: | ---: |");
      lines.push(
        `| chunk | ${summary.chunk.count} | ${summary.chunk.estimatedTokens} |`,
      );
      lines.push(
        `| section | ${summary.section.count} | ${summary.section.estimatedTokens} |`,
      );
      lines.push(
        `| raw | ${summary.raw.count} | ${summary.raw.estimatedTokens} |`,
      );
      if (summary.unspecified.count > 0) {
        lines.push(
          `| _(unspecified)_ | ${summary.unspecified.count} | ${summary.unspecified.estimatedTokens} |`,
        );
      }
    }
  }

  lines.push("");
  lines.push("## Tier Explain");
  if (!snapshot.tierExplain) {
    lines.push("");
    lines.push(
      "_Not populated — direct-answer tier disabled or did not fire._",
    );
  } else {
    const te = snapshot.tierExplain;
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Tier | \`${te.tier}\` |`);
    lines.push(`| Reason | ${mdEscape(te.tierReason)} |`);
    lines.push(`| Candidates considered | ${te.candidatesConsidered} |`);
    lines.push(`| Latency (ms) | ${te.latencyMs} |`);
    lines.push(
      `| Filtered by | ${
        te.filteredBy.length > 0
          ? te.filteredBy.map(mdInlineCode).join(", ")
          : "_(none)_"
      } |`,
    );
    if (te.sourceAnchors && te.sourceAnchors.length > 0) {
      lines.push("");
      lines.push("**Source anchors:**");
      for (const anchor of te.sourceAnchors) {
        const range = anchor.lineRange
          ? `:${anchor.lineRange[0]}-${anchor.lineRange[1]}`
          : "";
        lines.push(`- \`${anchor.path}${range}\``);
      }
    }
  }

  return lines.join("\n");
}

function renderResultMarkdownLines(
  result: RecallXrayResult,
  rank: number,
): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `### ${rank}. \`${result.memoryId}\` — ${servedByLabel(result.servedBy)}`,
  );
  if (result.path) {
    lines.push("");
    lines.push(`- **Path:** \`${result.path}\``);
  } else {
    lines.push("");
  }
  lines.push(`- **Score:** ${renderScoreDecomposition(result)}`);
  if (result.provenance) {
    lines.push(
      `- **Provenance:** ${mdEscape(summarizeRetrievedMemoryProvenance(result.provenance))}`,
    );
    lines.push(
      `- **Retrieval reason:** ${mdInlineCode(result.provenance.retrievalReason)}`,
    );
    if (result.provenance.userContextScopes.length > 0) {
      lines.push(
        `- **Context scopes:** ${result.provenance.userContextScopes
          .map(mdInlineCode)
          .join(", ")}`,
      );
    }
    if (
      result.provenance.safety !== "safe" ||
      result.provenance.safetyReasons.length > 0
    ) {
      const reasonSuffix =
        result.provenance.safetyReasons.length > 0
          ? ` (${result.provenance.safetyReasons.map(mdInlineCode).join(", ")})`
          : "";
      lines.push(
        `- **Safety:** ${mdInlineCode(result.provenance.safety)}${reasonSuffix}`,
      );
    }
  }
  if (result.admittedBy.length > 0) {
    lines.push(
      `- **Admitted by:** ${result.admittedBy.map(mdInlineCode).join(", ")}`,
    );
  }
  if (result.rejectedBy) {
    lines.push(`- **Rejected by:** ${mdInlineCode(result.rejectedBy)}`);
  }
  if (result.graphPath && result.graphPath.length > 0) {
    lines.push(
      `- **Graph path:** ${result.graphPath
        .map(mdInlineCode)
        .join(" → ")}`,
    );
    // Issue #681 PR 3/3 — render per-edge confidences as a parallel
    // markdown line so operators can correlate them with the path
    // arrows above. Skipped when no confidences were recorded.
    if (
      result.graphEdgeConfidences &&
      result.graphEdgeConfidences.length > 0
    ) {
      lines.push(
        `- **Edge confidences:** ${result.graphEdgeConfidences
          .map((c) => mdInlineCode(c.toFixed(2)))
          .join(", ")}`,
      );
    }
  }
  if (result.auditEntryId) {
    lines.push(`- **Audit entry:** \`${result.auditEntryId}\``);
  }
  if (result.disclosure !== undefined) {
    const tokenLine =
      typeof result.estimatedTokens === "number"
        ? ` (~${result.estimatedTokens} tokens)`
        : "";
    lines.push(`- **Disclosure:** \`${result.disclosure}\`${tokenLine}`);
  } else if (typeof result.estimatedTokens === "number") {
    // Disclosure unspecified but tokens recorded — still surface the
    // budget so the operator can attribute spend.
    lines.push(`- **Estimated tokens:** ${result.estimatedTokens}`);
  }
  return lines;
}

// ─── Shared helpers ───────────────────────────────────────────────────────

function servedByLabel(servedBy: RecallXrayServedBy): string {
  return `served-by=${servedBy}`;
}

function renderScoreDecomposition(result: RecallXrayResult): string {
  const parts: string[] = [`final=${formatScore(result.scoreDecomposition.final)}`];
  const s = result.scoreDecomposition;
  if (s.vector !== undefined) parts.push(`vector=${formatScore(s.vector)}`);
  if (s.bm25 !== undefined) parts.push(`bm25=${formatScore(s.bm25)}`);
  if (s.importance !== undefined) {
    parts.push(`importance=${formatScore(s.importance)}`);
  }
  if (s.mmrPenalty !== undefined) {
    parts.push(`mmr_penalty=${formatScore(s.mmrPenalty)}`);
  }
  if (s.tierPrior !== undefined) {
    parts.push(`tier_prior=${formatScore(s.tierPrior)}`);
  }
  if (s.reinforcementBoost !== undefined && s.reinforcementBoost > 0) {
    parts.push(`reinforcement_boost=${formatScore(s.reinforcementBoost)}`);
  }
  return parts.join(" ");
}

function formatScore(value: number): string {
  // Deterministic 4-decimal formatting keeps golden files stable
  // without printing spurious trailing zeros via toString().
  if (!Number.isFinite(value)) return "0.0000";
  return value.toFixed(4);
}

function formatCapturedAt(ts: number): string {
  if (!Number.isFinite(ts) || ts < 0) return "(unknown)";
  // `new Date(n).toISOString()` throws a RangeError for finite numbers
  // outside the valid Date range (roughly |n| > 8.64e15).  That case
  // can surface when snapshots are corrupted or captured with a
  // custom clock, so coerce it to the same "(unknown)" fallback
  // rather than crashing the renderer.
  try {
    return new Date(ts).toISOString();
  } catch {
    return "(unknown)";
  }
}

function mdEscape(value: string): string {
  // Pipe is the only character that breaks GFM table rendering; escape
  // backslash first so we do not re-escape the escape character.
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function mdInlineCode(value: string): string {
  if (value.length === 0) return "``";
  // Use exactly enough backticks to unambiguously wrap content that
  // itself contains backticks (GFM rule).
  const longestRun = /`+/g;
  let maxLen = 0;
  for (const match of value.matchAll(longestRun)) {
    if (match[0].length > maxLen) maxLen = match[0].length;
  }
  const fence = "`".repeat(maxLen + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}
