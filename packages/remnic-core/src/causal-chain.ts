/**
 * causal-chain.ts — Cross-session causal chain persistence for CMC.
 *
 * Stitches causal trajectories across session boundaries by detecting
 * when a trajectory in one session follows up on a trajectory from
 * another session. Persists edges in a graph index for later retrieval.
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import { resolveCausalTrajectoryStoreDir, type CausalTrajectoryRecord } from "./causal-trajectory.js";
import { topicOverlapScore } from "./boxes.js";
import { countRecallTokenOverlap, normalizeRecallTokens } from "./recall-tokenization.js";
import {
  assertIsoRecordedAt,
  assertString,
  isRecord,
  recordStoreDay,
} from "./store-contract.js";
import { log } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CausalEdge {
  schemaVersion: 1;
  edgeId: string;
  fromTrajectoryId: string;
  toTrajectoryId: string;
  edgeType: "follow_up_to_goal" | "retry" | "continuation" | "correction";
  confidence: number;
  stitchMethod: "lexical" | "entity" | "temporal" | "explicit";
  createdAt: string;
  metadata?: Record<string, string>;
}

export interface CausalChainIndex {
  outgoing: Record<string, string[]>;
  incoming: Record<string, string[]>;
  edges: Record<string, CausalEdge>;
  updatedAt: string;
}

export interface StitchConfig {
  lookbackDays: number;
  minScore: number;
  maxEdgesPerTrajectory: number;
}

export interface StitchCandidate {
  trajectory: CausalTrajectoryRecord;
  score: number;
  edgeType: CausalEdge["edgeType"];
  stitchMethod: CausalEdge["stitchMethod"];
}

// ─── Scoring Weights ─────────────────────────────────────────────────────────

const STITCH_WEIGHTS = {
  followUpToGoal: 4.0,
  outcomeToGoal: 2.0,
  entityOverlap: 3.0,
  tagOverlap: 1.5,
  temporalProximity: 1.0,
} as const;

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateCausalEdge(raw: unknown): CausalEdge {
  if (!isRecord(raw)) throw new Error("CausalEdge must be an object");
  if (raw.schemaVersion !== 1) throw new Error("CausalEdge.schemaVersion must be 1");

  const edgeType = assertString(raw.edgeType, "edgeType");
  const validEdgeTypes = ["follow_up_to_goal", "retry", "continuation", "correction"];
  if (!validEdgeTypes.includes(edgeType)) {
    throw new Error(`CausalEdge.edgeType must be one of ${validEdgeTypes.join(", ")}`);
  }

  const stitchMethod = assertString(raw.stitchMethod, "stitchMethod");
  const validMethods = ["lexical", "entity", "temporal", "explicit"];
  if (!validMethods.includes(stitchMethod)) {
    throw new Error(`CausalEdge.stitchMethod must be one of ${validMethods.join(", ")}`);
  }

  const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
  if (confidence < 0 || confidence > 1) throw new Error("CausalEdge.confidence must be in [0, 1]");

  return {
    schemaVersion: 1,
    edgeId: assertString(raw.edgeId, "edgeId"),
    fromTrajectoryId: assertString(raw.fromTrajectoryId, "fromTrajectoryId"),
    toTrajectoryId: assertString(raw.toTrajectoryId, "toTrajectoryId"),
    edgeType: edgeType as CausalEdge["edgeType"],
    confidence: confidence,
    stitchMethod: stitchMethod as CausalEdge["stitchMethod"],
    createdAt: assertIsoRecordedAt(assertString(raw.createdAt, "createdAt")),
    metadata: isRecord(raw.metadata)
      ? Object.fromEntries(
          Object.entries(raw.metadata).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined,
  };
}

// ─── Stable Edge ID ──────────────────────────────────────────────────────────

export function makeEdgeId(fromId: string, toId: string): string {
  const digest = createHash("sha256")
    .update(`${fromId}\0${toId}`)
    .digest("hex")
    .slice(0, 12);
  return `edge-${digest}`;
}

// ─── Storage Paths ───────────────────────────────────────────────────────────

export function resolveChainsDir(memoryDir: string, causalTrajectoryStoreDir?: string): string {
  const root = resolveCausalTrajectoryStoreDir(memoryDir, causalTrajectoryStoreDir);
  return path.join(root, "chains");
}

function chainIndexPath(chainsDir: string): string {
  return path.join(chainsDir, "chain-index.json");
}

function edgeFilePath(chainsDir: string, edge: CausalEdge): string {
  const day = recordStoreDay(edge.createdAt);
  return path.join(chainsDir, "edges", day, `${edge.edgeId}.json`);
}

// ─── Chain Index CRUD ────────────────────────────────────────────────────────

export async function readChainIndex(chainsDir: string): Promise<CausalChainIndex> {
  try {
    const raw = JSON.parse(await readFile(chainIndexPath(chainsDir), "utf8"));
    return {
      outgoing: isRecord(raw.outgoing) ? raw.outgoing as Record<string, string[]> : {},
      incoming: isRecord(raw.incoming) ? raw.incoming as Record<string, string[]> : {},
      edges: isRecord(raw.edges) ? raw.edges as Record<string, CausalEdge> : {},
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { outgoing: {}, incoming: {}, edges: {}, updatedAt: new Date().toISOString() };
  }
}

export async function writeChainIndex(chainsDir: string, index: CausalChainIndex): Promise<void> {
  await mkdir(chainsDir, { recursive: true });
  index.updatedAt = new Date().toISOString();
  await writeFile(chainIndexPath(chainsDir), JSON.stringify(index, null, 2), "utf8");
}

async function persistEdge(chainsDir: string, edge: CausalEdge): Promise<string> {
  const filePath = edgeFilePath(chainsDir, edge);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(edge, null, 2), "utf8");
  return filePath;
}

function addEdgeToIndex(index: CausalChainIndex, edge: CausalEdge): void {
  if (!index.outgoing[edge.fromTrajectoryId]) {
    index.outgoing[edge.fromTrajectoryId] = [];
  }
  if (!index.outgoing[edge.fromTrajectoryId].includes(edge.edgeId)) {
    index.outgoing[edge.fromTrajectoryId].push(edge.edgeId);
  }

  if (!index.incoming[edge.toTrajectoryId]) {
    index.incoming[edge.toTrajectoryId] = [];
  }
  if (!index.incoming[edge.toTrajectoryId].includes(edge.edgeId)) {
    index.incoming[edge.toTrajectoryId].push(edge.edgeId);
  }

  index.edges[edge.edgeId] = edge;
}

// ─── Stitching Algorithm ─────────────────────────────────────────────────────

/**
 * Score how strongly a candidate trajectory from another session
 * relates to the new trajectory being recorded.
 */
export function scoreStitchCandidate(
  newTrajectory: CausalTrajectoryRecord,
  candidate: CausalTrajectoryRecord,
): StitchCandidate {
  let score = 0;
  let dominantMethod: CausalEdge["stitchMethod"] = "lexical";
  let maxComponent = 0;

  // 1. Follow-up → Goal match (token overlap)
  const newFollowUpTokens = new Set(
    normalizeRecallTokens(newTrajectory.followUpSummary ?? "", []),
  );
  const candidateGoalTokens = normalizeRecallTokens(candidate.goal, []);
  if (newFollowUpTokens.size > 0 && candidateGoalTokens.length > 0) {
    const overlap = countRecallTokenOverlap(newFollowUpTokens, candidate.goal, []);
    const normalized = overlap / Math.max(newFollowUpTokens.size, candidateGoalTokens.length);
    const component = normalized * STITCH_WEIGHTS.followUpToGoal;
    score += component;
    if (component > maxComponent) {
      maxComponent = component;
      dominantMethod = "lexical";
    }
  }

  // 1b. Candidate follow-up → New goal match (reverse direction)
  const candidateFollowUpTokens = new Set(
    normalizeRecallTokens(candidate.followUpSummary ?? "", []),
  );
  const newGoalTokens = normalizeRecallTokens(newTrajectory.goal, []);
  if (candidateFollowUpTokens.size > 0 && newGoalTokens.length > 0) {
    const overlap = countRecallTokenOverlap(candidateFollowUpTokens, newTrajectory.goal, []);
    const normalized = overlap / Math.max(candidateFollowUpTokens.size, newGoalTokens.length);
    const component = normalized * 3.0;
    score += component;
    if (component > maxComponent) {
      maxComponent = component;
      dominantMethod = "lexical";
    }
  }

  // 2. Outcome → Goal match
  const newOutcomeTokens = new Set(
    normalizeRecallTokens(newTrajectory.outcomeSummary, []),
  );
  if (newOutcomeTokens.size > 0) {
    const overlap = countRecallTokenOverlap(newOutcomeTokens, candidate.goal, []);
    const normalized = overlap / Math.max(newOutcomeTokens.size, candidateGoalTokens.length || 1);
    const component = normalized * STITCH_WEIGHTS.outcomeToGoal;
    score += component;
    if (component > maxComponent) {
      maxComponent = component;
      dominantMethod = "lexical";
    }
  }

  // 3. Entity overlap (Jaccard)
  const newEntities = newTrajectory.entityRefs ?? [];
  const candidateEntities = candidate.entityRefs ?? [];
  if (newEntities.length > 0 && candidateEntities.length > 0) {
    const entityJaccard = topicOverlapScore(newEntities, candidateEntities);
    const component = entityJaccard * STITCH_WEIGHTS.entityOverlap;
    score += component;
    if (component > maxComponent) {
      maxComponent = component;
      dominantMethod = "entity";
    }
  }

  // 4. Tag overlap (Jaccard)
  const newTags = newTrajectory.tags ?? [];
  const candidateTags = candidate.tags ?? [];
  if (newTags.length > 0 && candidateTags.length > 0) {
    const tagJaccard = topicOverlapScore(newTags, candidateTags);
    const component = tagJaccard * STITCH_WEIGHTS.tagOverlap;
    score += component;
    if (component > maxComponent) {
      maxComponent = component;
      dominantMethod = "lexical";
    }
  }

  // 5. Temporal proximity: 1/(1 + gapHours/24)
  const newMs = Date.parse(newTrajectory.recordedAt);
  const candidateMs = Date.parse(candidate.recordedAt);
  if (Number.isFinite(newMs) && Number.isFinite(candidateMs)) {
    const gapHours = Math.abs(newMs - candidateMs) / 3_600_000;
    const proximity = 1 / (1 + gapHours / 24);
    const component = proximity * STITCH_WEIGHTS.temporalProximity;
    score += component;
    if (component > maxComponent) {
      maxComponent = component;
      dominantMethod = "temporal";
    }
  }

  // Determine edge type by heuristic
  let edgeType: CausalEdge["edgeType"] = "continuation";
  const goalTokens = new Set(normalizeRecallTokens(newTrajectory.goal, []));
  const candidateGoalSet = new Set(candidateGoalTokens);
  const goalOverlap = [...goalTokens].filter((t) => candidateGoalSet.has(t)).length;
  const goalSimilarity = goalTokens.size > 0 ? goalOverlap / goalTokens.size : 0;

  if (goalSimilarity > 0.7 && candidate.outcomeKind === "failure") {
    edgeType = "retry";
  } else if (goalSimilarity > 0.7 && newTrajectory.outcomeKind !== candidate.outcomeKind) {
    edgeType = "correction";
  } else if (newFollowUpTokens.size > 0 && candidateGoalTokens.length > 0) {
    const followUpGoalOverlap = countRecallTokenOverlap(newFollowUpTokens, candidate.goal, []);
    if (followUpGoalOverlap > 0) {
      edgeType = "follow_up_to_goal";
    }
  }

  return { trajectory: candidate, score, edgeType, stitchMethod: dominantMethod };
}

/**
 * Read trajectory records from the causal-trajectories store within
 * the lookback window, excluding the current session.
 */
async function readRecentTrajectories(
  memoryDir: string,
  causalTrajectoryStoreDir: string | undefined,
  currentSessionKey: string,
  lookbackDays: number,
): Promise<CausalTrajectoryRecord[]> {
  const root = resolveCausalTrajectoryStoreDir(memoryDir, causalTrajectoryStoreDir);
  const trajectoriesDir = path.join(root, "trajectories");

  const files = await listJsonFiles(trajectoriesDir).catch(() => [] as string[]);
  if (files.length === 0) return [];

  const cutoff = Date.now() - lookbackDays * 86_400_000;
  const results: CausalTrajectoryRecord[] = [];

  for (const filePath of files) {
    try {
      const raw = await readJsonFile(filePath);
      if (!isRecord(raw)) continue;
      const sessionKey = typeof raw.sessionKey === "string" ? raw.sessionKey : "";
      if (sessionKey === currentSessionKey) continue;
      const recordedAt = typeof raw.recordedAt === "string" ? raw.recordedAt : "";
      const ms = Date.parse(recordedAt);
      if (!Number.isFinite(ms) || ms < cutoff) continue;
      results.push(raw as unknown as CausalTrajectoryRecord);
    } catch {
      // skip invalid files
    }
  }

  return results;
}

/**
 * After a new trajectory is recorded, attempt to stitch it to
 * existing trajectories from other sessions.
 */
export async function stitchCausalChain(options: {
  memoryDir: string;
  causalTrajectoryStoreDir?: string;
  newTrajectory: CausalTrajectoryRecord;
  config: StitchConfig;
}): Promise<CausalEdge[]> {
  const { memoryDir, causalTrajectoryStoreDir, newTrajectory, config: stitchConfig } = options;
  const chainsDir = resolveChainsDir(memoryDir, causalTrajectoryStoreDir);

  const candidates = await readRecentTrajectories(
    memoryDir,
    causalTrajectoryStoreDir,
    newTrajectory.sessionKey,
    stitchConfig.lookbackDays,
  );

  if (candidates.length === 0) return [];

  const scored = candidates
    .map((c) => scoreStitchCandidate(newTrajectory, c))
    .filter((s) => s.score >= stitchConfig.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, stitchConfig.maxEdgesPerTrajectory);

  if (scored.length === 0) return [];

  const index = await readChainIndex(chainsDir);
  const newEdges: CausalEdge[] = [];

  for (const candidate of scored) {
    const edgeId = makeEdgeId(candidate.trajectory.trajectoryId, newTrajectory.trajectoryId);

    // Skip if edge already exists
    if (index.edges[edgeId]) continue;

    const edge: CausalEdge = {
      schemaVersion: 1,
      edgeId,
      fromTrajectoryId: candidate.trajectory.trajectoryId,
      toTrajectoryId: newTrajectory.trajectoryId,
      edgeType: candidate.edgeType,
      confidence: Math.min(1, candidate.score / 10),
      stitchMethod: candidate.stitchMethod,
      createdAt: new Date().toISOString(),
    };

    addEdgeToIndex(index, edge);
    await persistEdge(chainsDir, edge);
    newEdges.push(edge);
  }

  if (newEdges.length > 0) {
    await writeChainIndex(chainsDir, index);
    log.debug(`[cmc] stitched ${newEdges.length} causal edge(s) for trajectory ${newTrajectory.trajectoryId}`);
  }

  return newEdges;
}
