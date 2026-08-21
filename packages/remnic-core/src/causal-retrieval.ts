/**
 * causal-retrieval.ts — CMC Phase 3: Causal Retrieval Channel
 *
 * Walks upstream/downstream causal chains during recall to surface
 * connected trajectories. Branching points (multiple outgoing edges
 * with different outcomes) get a counterfactual boost as they represent
 * decision points worth surfacing.
 */

import type { CausalTrajectoryRecord } from "./causal-trajectory.js";
import { readCausalTrajectoryRecords, searchCausalTrajectories } from "./causal-trajectory.js";
import {
  readChainIndex,
  resolveChainsDir,
  type CausalChainIndex,
  type CausalEdge,
} from "./causal-chain.js";
import { log } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CausalRetrievalConfig {
  maxDepth: number;
  maxChars: number;
  counterfactualBoost: number;
}

export interface CausalRetrievalResult {
  trajectoryId: string;
  direction: "upstream" | "downstream" | "seed";
  depth: number;
  score: number;
  edgeType?: CausalEdge["edgeType"];
  edgeConfidence?: number;
  isCounterfactual: boolean;
  summary: string;
}

// ─── Graph Traversal ─────────────────────────────────────────────────────────

/**
 * Walk upstream (incoming edges) from a seed trajectory.
 */
function walkUpstream(
  seedId: string,
  index: CausalChainIndex,
  maxDepth: number,
  counterfactualBoost: number,
): Array<{ trajectoryId: string; depth: number; score: number; edgeType: CausalEdge["edgeType"]; edgeConfidence: number; isCounterfactual: boolean }> {
  const visited = new Set<string>([seedId]);
  const results: Array<{ trajectoryId: string; depth: number; score: number; edgeType: CausalEdge["edgeType"]; edgeConfidence: number; isCounterfactual: boolean }> = [];

  let frontier = [seedId];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      const incomingEdgeIds = index.incoming[currentId] ?? [];

      for (const edgeId of incomingEdgeIds) {
        const edge = index.edges[edgeId];
        if (!edge) continue;

        const fromId = edge.fromTrajectoryId;
        if (visited.has(fromId)) continue;
        visited.add(fromId);

        // Check if this is a counterfactual branching point
        const outgoingFromSource = index.outgoing[fromId] ?? [];
        const isCounterfactual = outgoingFromSource.length > 1;

        const depthDecay = 1 / depth;
        let score = depthDecay * edge.confidence;
        if (isCounterfactual) score += counterfactualBoost;

        results.push({
          trajectoryId: fromId,
          depth,
          score,
          edgeType: edge.edgeType,
          edgeConfidence: edge.confidence,
          isCounterfactual,
        });

        nextFrontier.push(fromId);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return results;
}

/**
 * Walk downstream (outgoing edges) from a seed trajectory.
 * Max 2 hops downstream (less relevant than upstream context).
 */
function walkDownstream(
  seedId: string,
  index: CausalChainIndex,
  maxDepth: number,
  counterfactualBoost: number,
): Array<{ trajectoryId: string; depth: number; score: number; edgeType: CausalEdge["edgeType"]; edgeConfidence: number; isCounterfactual: boolean }> {
  const downstreamMaxDepth = Math.min(maxDepth, 2);
  const visited = new Set<string>([seedId]);
  const results: Array<{ trajectoryId: string; depth: number; score: number; edgeType: CausalEdge["edgeType"]; edgeConfidence: number; isCounterfactual: boolean }> = [];

  let frontier = [seedId];
  for (let depth = 1; depth <= downstreamMaxDepth; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      const outgoingEdgeIds = index.outgoing[currentId] ?? [];

      // Counterfactual: multiple outgoing = branching point
      const isCounterfactual = outgoingEdgeIds.length > 1;

      for (const edgeId of outgoingEdgeIds) {
        const edge = index.edges[edgeId];
        if (!edge) continue;

        const toId = edge.toTrajectoryId;
        if (visited.has(toId)) continue;
        visited.add(toId);

        const depthDecay = 1 / (depth + 1); // downstream penalized more
        let score = depthDecay * edge.confidence;
        if (isCounterfactual) score += counterfactualBoost;

        results.push({
          trajectoryId: toId,
          depth,
          score,
          edgeType: edge.edgeType,
          edgeConfidence: edge.confidence,
          isCounterfactual,
        });

        nextFrontier.push(toId);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return results;
}

// ─── Section Formatting ──────────────────────────────────────────────────────

function formatRetrievalResult(result: CausalRetrievalResult): string {
  const direction = result.direction === "upstream" ? "↑" : result.direction === "downstream" ? "↓" : "•";
  const counterfactual = result.isCounterfactual ? " [branching point]" : "";
  const edgeInfo = result.edgeType ? ` (${result.edgeType})` : "";
  return `- ${direction} ${result.summary}${edgeInfo}${counterfactual}`;
}

function formatConnectedTrajectorySummary(
  trajectoryId: string,
  depth: number,
  trajectoriesById: Map<string, CausalTrajectoryRecord>,
): string {
  const record = trajectoriesById.get(trajectoryId);
  if (!record) return `Depth ${depth}: trajectory ${trajectoryId.slice(0, 12)}`;
  return `Depth ${depth}: [${record.outcomeKind}] ${record.goal} → ${record.outcomeSummary}`;
}

export function formatCausalRetrievalSection(
  results: CausalRetrievalResult[],
  maxChars: number,
): string | null {
  if (results.length === 0) return null;

  const lines: string[] = [
    "## Causal Chain Context",
    "",
    "Related causal trajectories from connected sessions:",
    "",
  ];

  let totalChars = lines.join("\n").length;

  for (const result of results) {
    const line = formatRetrievalResult(result);
    if (totalChars + line.length + 1 > maxChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  if (lines.length <= 4) return null; // only header, no content
  lines.push("");
  return lines.join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Retrieve causal chain context for a recall query.
 * 1. Use existing causal trajectory search for seed trajectories
 * 2. Walk upstream/downstream from seeds
 * 3. Format as recall section
 */
export async function retrieveCausalChains(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  query: string;
  sessionKey?: string;
  config: CausalRetrievalConfig;
}): Promise<string | null> {
  try {
    const { memoryDir, causalTrajectoryStoreDir, query, sessionKey, config: retrievalConfig } = options;

    // 1. Search for seed trajectories matching the query
    const seeds = await searchCausalTrajectories({
      memoryDir,
      causalTrajectoryStoreDir,
      query,
      maxResults: 3,
      sessionKey,
    });

    if (seeds.length === 0) return null;

    // 2. Load chain index
    const chainsDir = resolveChainsDir(memoryDir, causalTrajectoryStoreDir);
    const chainIndex = await readChainIndex(chainsDir);

    if (Object.keys(chainIndex.edges).length === 0) return null;

    const { trajectories } = await readCausalTrajectoryRecords({ memoryDir, causalTrajectoryStoreDir });
    const trajectoriesById = new Map(trajectories.map((trajectory) => [trajectory.trajectoryId, trajectory]));

    // 3. Walk chains from each seed
    const allResults: CausalRetrievalResult[] = [];

    for (const seed of seeds) {
      // Add seed itself
      allResults.push({
        trajectoryId: seed.record.trajectoryId,
        direction: "seed",
        depth: 0,
        score: seed.score,
        isCounterfactual: false,
        summary: `[${seed.record.outcomeKind}] ${seed.record.goal} → ${seed.record.outcomeSummary}`,
      });

      // Walk upstream
      const upstream = walkUpstream(
        seed.record.trajectoryId,
        chainIndex,
        retrievalConfig.maxDepth,
        retrievalConfig.counterfactualBoost,
      );
      for (const u of upstream) {
        allResults.push({
          trajectoryId: u.trajectoryId,
          direction: "upstream",
          depth: u.depth,
          score: u.score,
          edgeType: u.edgeType,
          edgeConfidence: u.edgeConfidence,
          isCounterfactual: u.isCounterfactual,
          summary: formatConnectedTrajectorySummary(u.trajectoryId, u.depth, trajectoriesById),
        });
      }

      // Walk downstream
      const downstream = walkDownstream(
        seed.record.trajectoryId,
        chainIndex,
        retrievalConfig.maxDepth,
        retrievalConfig.counterfactualBoost,
      );
      for (const d of downstream) {
        allResults.push({
          trajectoryId: d.trajectoryId,
          direction: "downstream",
          depth: d.depth,
          score: d.score,
          edgeType: d.edgeType,
          edgeConfidence: d.edgeConfidence,
          isCounterfactual: d.isCounterfactual,
          summary: formatConnectedTrajectorySummary(d.trajectoryId, d.depth, trajectoriesById),
        });
      }
    }

    // 4. Sort by score and format
    allResults.sort((a, b) => b.score - a.score);

    return formatCausalRetrievalSection(allResults, retrievalConfig.maxChars);
  } catch (error) {
    log.warn(`[cmc] causal retrieval failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
