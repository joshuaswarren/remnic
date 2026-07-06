/**
 * LSP status surfacing — per-language LSP state for index_status and
 * `remnic doctor` (issue #1555 step 5).
 *
 * Reports per-language: enabled / probed / degraded(code) / requests_used.
 * A missing server is normal, not an error — the status entry shows
 * `probed: false` with a degradation code so the operator knows LSP
 * resolution is available but inactive for that language.
 */

import type { LspDegradationCode } from "./degradation.js";
import type { LspConfig } from "./config.js";
import type { CodingGraphLanguage } from "@remnic/core";
import type { ResolutionResult } from "./resolution.js";

// ──────────────────────────────────────────────────────────────────────────
// Status entry — one per configured language
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-language LSP status. Surfaced in `index_status` and rendered as a
 * single line by `remnic doctor`.
 */
export interface LspStatusEntry {
  readonly language: CodingGraphLanguage;
  /** Master switch state (codingGraph.lsp.enabled). */
  readonly enabled: boolean;
  /** Server binary found and initialize handshake succeeded. */
  readonly probed: boolean;
  /** True if the last resolution pass degraded (timeout/crash/protocol). */
  readonly degraded: boolean;
  /** Specific degradation code if `degraded` is true. */
  readonly degradationCode?: LspDegradationCode;
  /** Definition requests sent in the last index run. */
  readonly requestsUsed: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Status computation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Input for LSP status computation — the probe results and resolution
 * results from the last index run. The caller (the index pipeline)
 * collects these during the run and passes them here.
 */
export interface LspStatusInput {
  readonly config: LspConfig;
  /**
   * Per-language probe results from the last run. `true` = server found
   * and handshake succeeded.
   */
  readonly probeResults: ReadonlyMap<CodingGraphLanguage, boolean>;
  /**
   * Per-language degradation codes from the last run. A language in this
   * map with a code means the resolution pass degraded for that language.
   */
  readonly degradations: ReadonlyMap<CodingGraphLanguage, LspDegradationCode>;
  /**
   * Per-language definition request counts from the last run.
   */
  readonly requestCounts: ReadonlyMap<CodingGraphLanguage, number>;
  /**
   * The languages configured for resolution (from the index run's
   * candidate set). Only these languages get status entries.
   */
  readonly languages: readonly CodingGraphLanguage[];
}

/**
 * Compute per-language LSP status entries. Pure — no side effects.
 * Returns one entry per language in `languages`.
 */
export function getLspStatus(input: LspStatusInput): readonly LspStatusEntry[] {
  return input.languages.map((lang) => {
    const probed = input.probeResults.get(lang) ?? false;
    const degradationCode = input.degradations.get(lang);
    const requestsUsed = input.requestCounts.get(lang) ?? 0;
    return {
      language: lang,
      enabled: input.config.enabled,
      probed,
      degraded: degradationCode !== undefined,
      degradationCode,
      requestsUsed,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Doctor rendering — one line per language
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render a single LSP status line for `remnic doctor`. Format:
 *
 *   typescript: lsp [probed] 12 requests
 *   python:     lsp [degraded:request_timeout] 3 requests
 *   go:         lsp [not_probed] 0 requests
 *   rust:       lsp [disabled]
 */
export function formatLspStatusLine(entry: LspStatusEntry): string {
  if (!entry.enabled) {
    return `${entry.language}: lsp [disabled]`;
  }
  const parts: string[] = [];
  if (entry.probed) {
    parts.push("probed");
  } else {
    parts.push("not_probed");
  }
  if (entry.degraded && entry.degradationCode) {
    parts[parts.length - 1] = `degraded:${entry.degradationCode}`;
  }
  const stateStr = parts.join(" ");
  return `${entry.language}: lsp [${stateStr}] ${entry.requestsUsed} requests`;
}

// ──────────────────────────────────────────────────────────────────────────
// Resolution result → status input adapter
// ──────────────────────────────────────────────────────────────────────────

/**
 * Adapter: convert a {@link ResolutionResult} into the per-language
 * degradation + request-count maps that {@link getLspStatus} consumes.
 *
 * The resolution pass runs once per language (each language has its own
 * server). This helper is called once per language to populate the maps.
 */
export function resolutionResultToStatusMaps(
  language: CodingGraphLanguage,
  result: ResolutionResult,
  degradations: Map<CodingGraphLanguage, LspDegradationCode>,
  requestCounts: Map<CodingGraphLanguage, number>,
): void {
  requestCounts.set(language, result.upgraded + result.unresolved);
  if (result.degradation) {
    degradations.set(language, result.degradation.code);
  }
}
