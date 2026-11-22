/**
 * semantic-consolidation.ts — Semantic Consolidation Engine
 *
 * Finds clusters of semantically similar memories using token overlap,
 * synthesizes canonical versions via LLM, and archives the originals.
 * Reduces memory store bloat while preserving all unique information.
 */

import { z } from "zod";

import type { MemoryFile, PluginConfig } from "./types.js";
import { normalizeRecallTokens, countRecallTokenOverlap } from "./recall-tokenization.js";
import { runPostConsolidationMaterialize } from "./connectors/codex-materialize-runner.js";
import type { MaterializeResult, RolloutSummaryInput } from "./connectors/codex-materialize.js";
import { discoverMemoryExtensions, renderExtensionsBlock, resolveExtensionsRoot } from "./memory-extension-host/index.js";
import { log } from "./logger.js";
import { resolvePipelineProcessingCapabilities } from "./capabilities.js";

// Re-export resolveExtensionsRoot for backward compatibility — existing
// consumers that import from semantic-consolidation.ts continue to work.
export { resolveExtensionsRoot } from "./memory-extension-host/index.js";

// Operator vocabulary (issue #561).  The types and validators live in a
// standalone `consolidation-operator.ts` module so `storage.ts` can import
// them without creating a `storage → semantic-consolidation →
// codex-materialize-runner → storage` cycle.  Re-exported here so existing
// consumers that reach for `./semantic-consolidation.js` keep working.
export {
  CONSOLIDATION_OPERATORS,
  isConsolidationOperator,
  isSemanticConsolidationLlmOperator,
  isValidDerivedFromEntry,
  type ConsolidationOperator,
  type SemanticConsolidationLlmOperator,
} from "./consolidation-operator.js";

import {
  CONSOLIDATION_OPERATORS as _CONSOLIDATION_OPERATORS,
  isConsolidationOperator as _isConsolidationOperator,
  isSemanticConsolidationLlmOperator as _isSemanticConsolidationLlmOperator,
  type ConsolidationOperator as _ConsolidationOperator,
  type SemanticConsolidationLlmOperator as _SemanticConsolidationLlmOperator,
} from "./consolidation-operator.js";

export interface ConsolidationCluster {
  category: string;
  memories: MemoryFile[];
  overlapScore: number;
  canonicalContent?: string;
}

export interface SemanticConsolidationResult {
  clustersFound: number;
  memoriesConsolidated: number;
  memoriesArchived: number;
  errors: number;
  clusters: ConsolidationCluster[];
}

/**
 * Find clusters of semantically similar memories using token overlap.
 */
export function findSimilarClusters(
  memories: MemoryFile[],
  config: {
    threshold: number;
    minClusterSize: number;
    excludeCategories: string[];
    maxPerRun: number;
  },
): ConsolidationCluster[] {
  const excluded = new Set(config.excludeCategories);

  // Group by category first
  const byCategory = new Map<string, MemoryFile[]>();
  for (const m of memories) {
    const cat = m.frontmatter.category;
    if (excluded.has(cat)) continue;
    if (m.frontmatter.status && m.frontmatter.status !== "active") continue;
    const list = byCategory.get(cat) ?? [];
    list.push(m);
    byCategory.set(cat, list);
  }

  const clusters: ConsolidationCluster[] = [];
  let totalCandidates = 0;

  for (const [category, mems] of byCategory) {
    if (totalCandidates >= config.maxPerRun) break;

    // Token-normalize all memories in this category
    const tokenized = mems.map((m) => ({
      memory: m,
      tokens: new Set(normalizeRecallTokens(m.content, [])),
    }));

    // Track which memories are already clustered
    const clustered = new Set<string>();

    for (let i = 0; i < tokenized.length && totalCandidates < config.maxPerRun; i++) {
      const remainingBudget = config.maxPerRun - totalCandidates;
      if (remainingBudget < config.minClusterSize) break;
      if (clustered.has(tokenized[i].memory.frontmatter.id)) continue;

      const cluster: MemoryFile[] = [tokenized[i].memory];
      let totalOverlap = 0;
      let comparisons = 0;

      for (let j = i + 1; j < tokenized.length && cluster.length < remainingBudget; j++) {
        if (clustered.has(tokenized[j].memory.frontmatter.id)) continue;

        const aTokens = tokenized[i].tokens;
        const bTokens = tokenized[j].tokens;
        if (aTokens.size === 0 || bTokens.size === 0) continue;

        // Bidirectional overlap: what fraction of tokens are shared
        const overlap = countRecallTokenOverlap(aTokens, [...bTokens].join(" "));
        const maxTokens = Math.max(aTokens.size, bTokens.size);
        const score = maxTokens > 0 ? overlap / maxTokens : 0;

        if (score >= config.threshold) {
          cluster.push(tokenized[j].memory);
          totalOverlap += score;
          comparisons++;
        }
      }

      if (cluster.length >= config.minClusterSize) {
        for (const m of cluster) clustered.add(m.frontmatter.id);
        clusters.push({
          category,
          memories: cluster,
          overlapScore: comparisons > 0 ? totalOverlap / comparisons : 0,
        });
        totalCandidates += cluster.length;
      }
    }
  }

  return clusters;
}

/**
 * Build the LLM prompt for synthesizing a canonical memory from a cluster.
 */
export function buildConsolidationPrompt(cluster: ConsolidationCluster): string {
  const memoryTexts = cluster.memories
    .map(
      (m, i) =>
        `Memory ${i + 1} (${m.frontmatter.id}, created ${m.frontmatter.created}):\n${m.content}`,
    )
    .join("\n\n");

  return `You are a memory consolidation system. The following ${cluster.memories.length} memories in the "${cluster.category}" category contain overlapping information.

Synthesize them into ONE canonical memory that:
1. Preserves ALL unique information from every source memory
2. Removes redundancy and repetition
3. Uses clear, concise language
4. Maintains the same category and tone
5. Does NOT add information that isn't in the sources

${memoryTexts}

Write ONLY the consolidated memory content (no metadata, no explanation, no preamble):`;
}

/**
 * Parse the LLM response to extract the canonical content.
 */
export function parseConsolidationResponse(response: string): string {
  return response.trim();
}

// ─── Operator-aware prompt / parse (issue #561 PR 3) ─────────────────────────

/**
 * Structured result from an operator-aware consolidation LLM call.
 *
 * - `operator` — the consolidation operator the LLM chose for this cluster.
 *   Falls back to the heuristic default when the LLM omits or returns an
 *   unknown value (the parser never surfaces an invalid operator; see
 *   `parseOperatorAwareConsolidationResponse`).
 * - `outputs` — the canonical memory bodies to persist, never empty.
 *   MERGE and UPDATE always carry exactly one; SPLIT carries one body per
 *   separated fact (#3566).
 */
export interface OperatorAwareConsolidationResult {
  // Restricted to the LLM-allowed subset (Cursor Bugbot, PR #730):
  // `pattern-reinforcement` is reserved for the maintenance job and
  // must never reach this struct from a consolidation LLM response.
  operator: _SemanticConsolidationLlmOperator;
  outputs: string[];
}

/**
 * Heuristic default operator for a cluster.  Used as the fallback when the
 * LLM does not return a parseable operator, and as the "floor" decision in
 * `parseOperatorAwareConsolidationResponse`.
 *
 * Current heuristic (kept deliberately conservative — PR 3 only):
 *
 *   - Two or more memories being collapsed into one canonical blob is a
 *     MERGE by definition.  This is the path the current clustering
 *     pipeline exercises.
 *   - A cluster of size 1 that still reaches consolidation (future path,
 *     e.g. supersession of a single older memory by a newer value) is an
 *     UPDATE.
 *   - SPLIT is never selected by the heuristic: only the LLM can decide
 *     that one logical source encodes several distinct facts.  When it
 *     does, the coordinator writes one canonical memory per output.
 */
export function chooseConsolidationOperator(
  cluster: ConsolidationCluster,
): _SemanticConsolidationLlmOperator {
  if (cluster.memories.length <= 1) return "update";
  return "merge";
}

/**
 * Build the operator-aware LLM prompt.  MERGE and UPDATE return
 * `{ "operator", "output" }`; SPLIT returns `{ "operator": "split",
 * "outputs": [...] }` with one canonical body per separated fact (#3566).
 */
export function buildOperatorAwareConsolidationPrompt(
  cluster: ConsolidationCluster,
): string {
  const memoryTexts = cluster.memories
    .map(
      (m, i) =>
        `Memory ${i + 1} (${m.frontmatter.id}, created ${m.frontmatter.created}):\n${m.content}`,
    )
    .join("\n\n");

  return `You are a memory consolidation system.  The following ${cluster.memories.length} memories in the "${cluster.category}" category contain overlapping information.

Pick exactly ONE consolidation operator for this cluster and return a JSON object.

Operator vocabulary:
  - "merge"  — multiple distinct source memories overlap and should be collapsed into one canonical memory (most common).
  - "update" — one source memory carries a stale value that a newer source supersedes within the same logical fact.
  - "split"  — a single logical source really encodes multiple distinct facts that should be separated (rare). For split, replace "output" with "outputs": an array holding one canonical memory text per separated fact.

Output JSON ONLY, no prose before or after.  The "operator" key MUST be set to exactly one of the three strings "merge", "update", or "split" — never a pipe-separated placeholder like "merge|update|split".  Example shape:
  {
    "operator": "merge",
    "output": "<the canonical memory text>"
  }
Split shape:
  {
    "operator": "split",
    "outputs": ["<first fact>", "<second fact>"]
  }

Each canonical memory text must:
1. Preserve ALL unique information from every source memory
2. Remove redundancy and repetition
3. Use clear, concise language
4. Match the "${cluster.category}" category and tone
5. NOT add information that isn't in the sources
For split, the outputs together must hold all of the source information, and each output holds one fact.

${memoryTexts}

Return ONLY the JSON object:`;
}

/**
 * Parse an operator-aware consolidation response.
 *
 * Contract:
 *   - Accepts strict JSON `{ "operator": "...", "output": "..." }`.
 *   - Tolerates a JSON payload wrapped in a fenced code block (```json ...```).
 *   - Falls back to the heuristic operator when the JSON is malformed,
 *     the `operator` field is missing / unknown, or the raw response is
 *     a plain blob with no JSON at all.  This keeps PR 3 backwards
 *     compatible with older models that ignore the JSON instruction.
 *   - Never throws.  A missing / empty `output` field falls back to the
 *     trimmed raw response so the caller still writes something rather
 *     than dropping the cluster.
 */
export function parseOperatorAwareConsolidationResponse(
  response: string,
  cluster: ConsolidationCluster,
): OperatorAwareConsolidationResult {
  const fallback: OperatorAwareConsolidationResult = {
    operator: chooseConsolidationOperator(cluster),
    outputs: [response.trim()],
  };

  const trimmed = response.trim();
  if (trimmed.length === 0) return fallback;

  // Strip a fenced code block if present.
  // Dropped the \s* groups around the lazy body (they overlapped it and
  // backtracked polynomially — CodeQL js/polynomial-redos). Input is already
  // trimmed and fenced[1] is trimmed below, so matches are identical.
  const fenced = /^```(?:json)?([\s\S]*?)```$/u.exec(trimmed);
  const payload = fenced ? fenced[1].trim() : trimmed;

  // Find a balanced brace-delimited JSON object that has an `operator`
  // key (PR #632 round-4 review, codex P1).  A first/last-brace slice
  // breaks when the model prepends an earlier brace block (e.g.
  // `Example: {"note":"..."} ... {"operator":"merge",...}`).  Walk the
  // payload tracking nesting + string/escape state and skip past
  // objects that don't look like our target shape.
  const reply = CONSOLIDATION_LLM_REPLY.safeParse(findLastJsonObjectWithOperator(payload));
  if (!reply.success) return fallback;
  const rawOperator = reply.data.operator?.trim().toLowerCase() ?? "";
  const rawOutput = reply.data.output ?? "";

  // Narrow gate (Cursor Bugbot review on PR #730 head `aa1c2a8`):
  // accept ONLY the legacy split/merge/update LLM vocabulary here.
  // `pattern-reinforcement` joined the broader `ConsolidationOperator`
  // type in #687 PR 2/4 but is reserved for the maintenance job — if
  // an LLM hallucinates that operator we must NOT promote it onto
  // `derived_via`.
  const operator = _isSemanticConsolidationLlmOperator(rawOperator)
    ? rawOperator
    : chooseConsolidationOperator(cluster);
  const output = rawOutput.trim().length > 0 ? rawOutput.trim() : response.trim();
  const splitOutputs = (reply.data.outputs ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (operator === "split" && splitOutputs.length > 0) return { operator, outputs: splitOutputs };

  return { operator, outputs: [output] };
}

// Fields read from the model's JSON object; a wrong-typed field reads as absent.
const CONSOLIDATION_LLM_REPLY = z.object({
  operator: z.string().optional().catch(undefined),
  output: z.string().optional().catch(undefined),
  outputs: z.array(z.string()).optional().catch(undefined),
});

/**
 * Walk `text`, find all balanced top-level `{ ... }` blocks whose
 * JSON.parse result is an object with an `operator` key, and return
 * the LAST one (function name reflects this — PR #632 review,
 * cursor Low).  Returns `undefined` when nothing matches.  Tracks
 * string state + escape sequences so braces inside string values
 * don't throw off the depth counter.
 *
 * Used by `parseOperatorAwareConsolidationResponse` to tolerate models
 * that prepend an explanatory JSON example block before the real
 * payload (PR #632 round-4 + round-5 review, codex P1).  We take the
 * LAST candidate so that an instructional example with an `operator`
 * key ahead of the real answer doesn't steal precedence — models
 * typically write the example first and the real answer last.
 */
function findLastJsonObjectWithOperator(text: string): unknown {
  let searchFrom = 0;
  let last: unknown = undefined;
  while (searchFrom < text.length) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) return last;
    let depth = 0;
    let inString = false;
    let escape = false;
    let closed = false;
    let endIdx = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          endIdx = i;
          break;
        }
      }
    }
    if (!closed) return last;
    const slice = text.slice(start, endIdx + 1);
    try {
      const parsed = JSON.parse(slice);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "operator" in (parsed as Record<string, unknown>)
      ) {
        last = parsed;
      }
    } catch {
      // Fall through to the next candidate.
    }
    searchFrom = endIdx + 1;
  }
  return last;
}

// Silence unused-import warnings when tsup tree-shakes: these are used
// above in chooseConsolidationOperator + parse helpers.
void _CONSOLIDATION_OPERATORS;

/**
 * Discover extensions and build the block to append to a consolidation prompt.
 * Returns "" when extensions are disabled or none are found.
 */
export async function buildExtensionsBlockForConsolidation(
  config: PluginConfig,
): Promise<string> {
  if (!resolvePipelineProcessingCapabilities(config).memoryExtensions) return "";
  const root = resolveExtensionsRoot(config);
  const extensions = await discoverMemoryExtensions(root, log);
  if (extensions.length === 0) return "";
  return renderExtensionsBlock(extensions);
}

/**
 * Optional post-consolidation hook — materializes the namespace into Codex's
 * native memory layout when the consolidation run finishes. Kept here (rather
 * than in orchestrator.ts) so #378 doesn't conflict with Wave 1 edits.
 *
 * Safe to call regardless of config state: honors `codexMaterializeMemories`
 * and `codexMaterializeOnConsolidation` and silently becomes a no-op when
 * either is disabled.
 */
export async function materializeAfterSemanticConsolidation(options: {
  config: PluginConfig;
  namespace?: string;
  memories?: MemoryFile[];
  memoryDir?: string;
  codexHome?: string;
  rolloutSummaries?: RolloutSummaryInput[];
  now?: Date;
}): Promise<MaterializeResult | null> {
  // Delegates to the shared post-consolidation helper so semantic and causal
  // flows stay in lock-step — any guard/logging change happens in one place.
  return runPostConsolidationMaterialize("[semantic-consolidation]", options);
}
