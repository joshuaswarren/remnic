/**
 * @remnic/bench — Operation-Level Failure Attributor (Issue #1954)
 *
 * MemFail-style stage ordering:
 * 1. extraction: memory content similarity against store (listMemories)
 * 2. index: search reachability of gold statement (oracleSearch)
 * 3. retrieval: question recall replay and rank/cap analysis (recall)
 * 4. use: context presence vs answer correctness (recalledText / answer)
 *
 * Witness validation:
 * An oracle query miss at the index stage is recorded as a pending failure until retrieval witnesses
 * (recall or recalledText) are checked. If retrieval surfaces the gold memory, the index stage passes
 * implicitly ("implied pass from retrieval (oracle query missed)") and attribution proceeds to the use stage.
 * If retrieval also misses, index_miss is finalized as the earlier stage failure.
 */

import type {
  TaskAttributionGoldWitnessV1,
  TaskAttributionRetrievalWitnessV1,
  TaskAttributionWitness,
} from "./types.js";

export type AttributionClass =
  | "extraction_miss"
  | "index_miss"
  | "retrieval_miss"
  | "use_miss"
  | "unattributed";

export type RetrievalMissStage = "filter" | "cap" | "rank" | "unknown";

export type StageStatus = "pass" | "fail" | "unavailable";

export interface StageObservation {
  status: StageStatus;
  detail?: string;
}

export interface AttributionLabel {
  class: AttributionClass;
  retrievalStage?: RetrievalMissStage;
  reason?: string;
}

export interface GoldMemoryAttribution {
  goldMemory: string;
  label: AttributionLabel;
  stages: {
    extraction: StageObservation;
    index: StageObservation;
    retrieval: StageObservation;
    use: StageObservation;
  };
}

export interface TaskAttribution {
  taskId: string;
  question: string;
  golds: GoldMemoryAttribution[];
  overall: AttributionLabel;
}

export interface AttributionReport {
  runId: string;
  totals: Record<AttributionClass, number>;
  retrievalStages: Record<RetrievalMissStage, number>;
  attributedTasks: number;
  skippedTasks: { taskId: string; reason: string }[];
  items: TaskAttribution[];
}

export interface AttributionMemory {
  id: string;
  content: string;
}

export interface AttributionEnvironment {
  listMemories(): Promise<AttributionMemory[]>;
  oracleSearch?(query: string, limit: number): Promise<{ id: string }[]>;
  recall?(query: string, limit: number): Promise<AttributionMemory[]>;
  recallLimit: number;
  replayLimit?: number;
}

export interface AttributeOptions {
  threshold?: number; /* default 0.6 */
  similarity?: (gold: string, candidate: string) => number;
}

export const DEFAULT_ATTRIBUTION_THRESHOLD = 0.6;

const DEFAULT_STOPWORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "up", "about", "into", "through", "during", "before", "after", "above", "below",
  "and", "or", "but", "if", "then", "else", "when", "where", "why", "how",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "this", "that", "these", "those", "it", "its", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
]);

export function extractContentWords(text: string): string[] {
  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  return tokens.filter((t) => !DEFAULT_STOPWORDS.has(t));
}

/**
 * Deterministic content-word overlap: containment of the gold statement in the candidate.
 * score = |intersection| / |gold-statement content words|
 */
export function lexicalSimilarity(a: string, b: string): number {
  const goldWords = extractContentWords(a);
  if (goldWords.length === 0) {
    return 0;
  }
  const candWords = new Set(extractContentWords(b));
  let matchCount = 0;
  for (const word of goldWords) {
    if (candWords.has(word)) {
      matchCount++;
    }
  }
  return matchCount / goldWords.length;
}

const CLASS_RANK: Record<AttributionClass, number> = {
  extraction_miss: 1,
  index_miss: 2,
  retrieval_miss: 3,
  use_miss: 4,
  unattributed: 5,
};

const RETRIEVAL_STAGE_RANK: Record<RetrievalMissStage, number> = {
  cap: 1,
  rank: 2,
  filter: 3,
  unknown: 4,
};

function computeOverallLabel(golds: GoldMemoryAttribution[]): AttributionLabel {
  if (golds.length === 0) {
    return { class: "unattributed", reason: "no gold memories" };
  }
  let bestGold = golds[0];
  for (let i = 1; i < golds.length; i++) {
    const current = golds[i];
    const bestRank = CLASS_RANK[bestGold.label.class];
    const currRank = CLASS_RANK[current.label.class];
    if (currRank < bestRank) {
      bestGold = current;
    } else if (currRank === bestRank && current.label.class === "retrieval_miss") {
      const bestRetRank = RETRIEVAL_STAGE_RANK[bestGold.label.retrievalStage ?? "unknown"];
      const currRetRank = RETRIEVAL_STAGE_RANK[current.label.retrievalStage ?? "unknown"];
      if (currRetRank < bestRetRank) {
        bestGold = current;
      }
    }
  }
  return { ...bestGold.label };
}

function isDiagnosticScore(name: string): boolean {
  return name.endsWith("_agreement") || name.includes("_id_leak") || name === "search_hits";
}

export function isTaskFailed(task: { scores?: Record<string, number> }): boolean {
  if (!task.scores || Object.keys(task.scores).length === 0) {
    return true;
  }
  if ("overall" in task.scores && typeof task.scores.overall === "number") {
    return task.scores.overall < 1;
  }
  const primaryScores = Object.entries(task.scores)
    .filter(([name, score]) => typeof score === "number" && !isDiagnosticScore(name))
    .map(([, score]) => score);
  return primaryScores.length === 0 || Math.min(...primaryScores) < 1;
}

export function withMemoizedListMemories(env: AttributionEnvironment): AttributionEnvironment {
  let cache: Promise<AttributionMemory[]> | null = null;
  return {
    ...env,
    listMemories() {
      if (!cache) {
        cache = env.listMemories();
      }
      return cache;
    },
  };
}

export async function attributeGoldMemory(
  goldStatement: string,
  question: string,
  env: AttributionEnvironment,
  options: AttributeOptions = {},
  recalledText?: string
): Promise<GoldMemoryAttribution> {
  if (options.threshold !== undefined) {
    if (
      typeof options.threshold !== "number" ||
      !Number.isFinite(options.threshold) ||
      options.threshold < 0 ||
      options.threshold > 1
    ) {
      throw new RangeError("attribution threshold must be a finite number between 0 and 1");
    }
  }

  const threshold = options.threshold ?? DEFAULT_ATTRIBUTION_THRESHOLD;
  const simFn = options.similarity ?? lexicalSimilarity;

  // recalledText is the stored run's injected context: a secondary retrieval witness.
  const goldInRecalledText =
    typeof recalledText === "string" && simFn(goldStatement, recalledText) >= threshold;

  const stages: GoldMemoryAttribution["stages"] = {
    extraction: { status: "unavailable" },
    index: { status: "unavailable" },
    retrieval: { status: "unavailable" },
    use: { status: "unavailable" },
  };

  // Stage 1: extraction — is the gold statement present in the store at all?
  let memories: AttributionMemory[] = [];
  let extractionRan = false;
  let extractionErrorDetail: string | undefined;
  if (typeof env.listMemories === "function") {
    try {
      memories = await env.listMemories();
      extractionRan = true;
    } catch {
      extractionRan = false;
      extractionErrorDetail = "listMemories failed";
    }
  }

  let bestSim = -1;
  let matchedMem: AttributionMemory | null = null;

  if (extractionRan) {
    if (memories.length === 0) {
      if (goldInRecalledText) {
        const impliedDetail = "implied pass from recalled context (post-hoc store scan missed)";
        stages.extraction = { status: "pass", detail: impliedDetail };
        stages.index = { status: "pass", detail: impliedDetail };
        stages.retrieval = { status: "pass", detail: impliedDetail };
        stages.use = {
          status: "fail",
          detail: "Gold memory present in context but answer was incorrect",
        };
        return {
          goldMemory: goldStatement,
          label: { class: "use_miss", reason: "Gold memory present in context but task failed" },
          stages,
        };
      }

      const detail = "store contains no memories";
      stages.extraction = { status: "fail", detail };
      stages.index = { status: "unavailable", detail: "not reached" };
      stages.retrieval = { status: "unavailable", detail: "not reached" };
      stages.use = { status: "unavailable", detail: "not reached" };
      return {
        goldMemory: goldStatement,
        label: { class: "extraction_miss", reason: detail },
        stages,
      };
    }

    for (const mem of memories) {
      const sim = simFn(goldStatement, mem.content);
      if (sim > bestSim) {
        bestSim = sim;
        matchedMem = mem;
      }
    }

    if (bestSim < threshold || !matchedMem) {
      if (goldInRecalledText) {
        const impliedDetail = "implied pass from recalled context (post-hoc store scan missed)";
        stages.extraction = { status: "pass", detail: impliedDetail };
        stages.index = { status: "pass", detail: impliedDetail };
        stages.retrieval = { status: "pass", detail: impliedDetail };
        stages.use = {
          status: "fail",
          detail: "Gold memory present in context but answer was incorrect",
        };
        return {
          goldMemory: goldStatement,
          label: { class: "use_miss", reason: "Gold memory present in context but task failed" },
          stages,
        };
      }

      const detail = `Best similarity ${bestSim >= 0 ? bestSim.toFixed(3) : 0} below threshold ${threshold}`;
      stages.extraction = { status: "fail", detail };
      stages.index = { status: "unavailable", detail: "not reached" };
      stages.retrieval = { status: "unavailable", detail: "not reached" };
      stages.use = { status: "unavailable", detail: "not reached" };
      return {
        goldMemory: goldStatement,
        label: { class: "extraction_miss", reason: detail },
        stages,
      };
    }

    stages.extraction = {
      status: "pass",
      detail: `Matched memory ${matchedMem.id} (sim ${bestSim.toFixed(3)})`,
    };
  } else {
    stages.extraction = {
      status: "unavailable",
      detail: extractionErrorDetail ?? "listMemories unavailable",
    };
  }

  const matchedMemoryId = matchedMem ? matchedMem.id : undefined;

  // Stage 2: index — is the matched memory reachable via an oracle query?
  const recallLimit = env.recallLimit;
  const replayLimit = env.replayLimit ?? Math.max(25, recallLimit * 5);

  let indexCheckPassed = false;
  let indexCheckFailed = false;

  if (typeof env.oracleSearch === "function" && extractionRan) {
    try {
      const oracleResults = await env.oracleSearch(goldStatement, replayLimit);
      const idMatched = matchedMemoryId ? oracleResults.some((r) => r.id === matchedMemoryId) : false;
      if (idMatched) {
        indexCheckPassed = true;
      } else {
        const memMap = new Map(memories.map((m) => [m.id, m]));
        indexCheckPassed = oracleResults.some((r) => {
          const mem = memMap.get(r.id);
          return mem ? simFn(goldStatement, mem.content) >= threshold : false;
        });
      }

      if (indexCheckPassed) {
        stages.index = { status: "pass", detail: "Found in oracle search" };
      } else {
        indexCheckFailed = true;
        stages.index = { status: "fail", detail: "Not found in oracle search" };
      }
    } catch {
      stages.index = { status: "unavailable", detail: "oracleSearch threw error" };
    }
  } else if (typeof env.oracleSearch === "function") {
    stages.index = {
      status: "unavailable",
      detail: "extraction check unavailable; oracle result would be ambiguous",
    };
  } else {
    stages.index = { status: "unavailable", detail: "index check unavailable" };
  }

  // Stage 3: retrieval — does the production-shaped recall surface the memory?
  let retrievalCheckPassed = false;
  let retrievalStageMiss: RetrievalMissStage | undefined = undefined;

  if (typeof env.recall === "function") {
    try {
      const recallResults = await env.recall(question, recallLimit);
      const isGoldInRecall = recallResults.some(
        (m) => (matchedMemoryId && m.id === matchedMemoryId) || simFn(goldStatement, m.content) >= threshold
      );

      if (isGoldInRecall) {
        retrievalCheckPassed = true;
        stages.retrieval = { status: "pass", detail: `Recalled within recallLimit ${recallLimit}` };
      } else {
        const replayResults = await env.recall(question, replayLimit);
        const replayIndex = replayResults.findIndex(
          (m) => (matchedMemoryId && m.id === matchedMemoryId) || simFn(goldStatement, m.content) >= threshold
        );

        if (replayIndex >= 0) {
          const rank = replayIndex + 1;
          retrievalStageMiss = "cap";
          stages.retrieval = {
            status: "fail",
            detail: `Rank ${rank} exceeds recallLimit ${recallLimit}`,
          };
        } else {
          retrievalStageMiss = "unknown";
          stages.retrieval = {
            status: "fail",
            detail: `absent from recall at replayLimit ${replayLimit}; filter vs rank indistinguishable without candidate-stage evidence`,
          };
        }
      }
    } catch {
      stages.retrieval = { status: "unavailable", detail: "recall threw error" };
    }
  } else {
    stages.retrieval = { status: "unavailable", detail: "retrieval check unavailable" };
  }


  if (!retrievalCheckPassed && goldInRecalledText) {
    retrievalCheckPassed = true;
    stages.retrieval = { status: "pass", detail: "Found in recalledText context" };
  }

  // A passing retrieval retroactively proves reachability (implied index pass).
  if (retrievalCheckPassed) {
    if (indexCheckFailed) {
      stages.index = { status: "pass", detail: "implied pass from retrieval (oracle query missed)" };
      indexCheckPassed = true;
    } else if (stages.index.status === "unavailable") {
      stages.index = { status: "pass", detail: "implied pass from retrieval" };
      indexCheckPassed = true;
    }
  }

  // Stage 4: use — evidence reached the context yet the answer was still wrong.
  if (retrievalCheckPassed) {
    stages.use = {
      status: "fail",
      detail: "Gold memory present in context but answer was incorrect",
    };
    return {
      goldMemory: goldStatement,
      label: { class: "use_miss", reason: "Gold memory present in context but task failed" },
      stages,
    };
  }
  if (stages.extraction.status === "pass" && indexCheckFailed) {
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: { class: "index_miss", reason: "Gold statement missing from search index" },
      stages,
    };
  }

  if (
    stages.extraction.status === "pass" &&
    stages.index.status === "pass" &&
    stages.retrieval.status === "fail"
  ) {
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: {
        class: "retrieval_miss",
        retrievalStage: retrievalStageMiss ?? "unknown",
        reason: stages.retrieval.detail,
      },
      stages,
    };
  }

  const missingReason =
    stages.extraction.status === "unavailable"
      ? `extraction check unavailable (${stages.extraction.detail})`
      : stages.index.status === "unavailable" && stages.retrieval.status === "unavailable"
        ? "index/retrieval checks unavailable in this attribution environment"
        : stages.index.status === "unavailable"
          ? "index check unavailable; a retrieval miss cannot be isolated from an index miss"
          : "retrieval check unavailable";

  stages.use = { status: "unavailable", detail: "not reached" };

  return {
    goldMemory: goldStatement,
    label: { class: "unattributed", reason: missingReason },
    stages,
  };
}

function attributeGoldMemoryFromWitness(
  goldStatement: string,
  goldWitness: TaskAttributionGoldWitnessV1,
  retrievals: TaskAttributionRetrievalWitnessV1[],
  witnessThreshold: number,
  options: AttributeOptions,
  recalledText?: string,
): GoldMemoryAttribution {
  const threshold = options.threshold ?? DEFAULT_ATTRIBUTION_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("attribution threshold must be a finite number between 0 and 1");
  }
  const similarity = options.similarity ?? lexicalSimilarity;
  const stages: GoldMemoryAttribution["stages"] = {
    extraction: { status: "unavailable" },
    index: { status: "unavailable" },
    retrieval: { status: "unavailable" },
    use: { status: "unavailable" },
  };

  if (typeof recalledText === "string" && similarity(goldStatement, recalledText) >= threshold) {
    const detail = "implied pass from recalled context";
    stages.extraction = { status: "pass", detail };
    stages.index = { status: "pass", detail };
    stages.retrieval = { status: "pass", detail: "Found in recalledText context" };
    stages.use = { status: "fail", detail: "Gold memory present in context but answer was incorrect" };
    return {
      goldMemory: goldStatement,
      label: { class: "use_miss", reason: "Gold memory present in context but task failed" },
      stages,
    };
  }

  if (options.similarity || threshold !== witnessThreshold) {
    const detail = "stored extraction witness uses a different similarity policy";
    stages.extraction = { status: "unavailable", detail };
    stages.index = { status: "unavailable", detail: "extraction check unavailable" };
    stages.retrieval = { status: "unavailable", detail: "extraction check unavailable" };
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: { class: "unattributed", reason: detail },
      stages,
    };
  }

  const storeIds = goldWitness.storeMemoryIds;
  if (storeIds === null) {
    stages.extraction = { status: "unavailable", detail: "stored extraction witness unavailable" };
    stages.index = { status: "unavailable", detail: "extraction check unavailable" };
    stages.retrieval = { status: "unavailable", detail: "extraction check unavailable" };
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: { class: "unattributed", reason: "extraction check unavailable (stored witness)" },
      stages,
    };
  }
  if (storeIds.length === 0) {
    const detail = "stored witness found no matching memory";
    stages.extraction = { status: "fail", detail };
    stages.index = { status: "unavailable", detail: "not reached" };
    stages.retrieval = { status: "unavailable", detail: "not reached" };
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: { class: "extraction_miss", reason: detail },
      stages,
    };
  }

  const storeIdSet = new Set(storeIds);
  stages.extraction = {
    status: "pass",
    detail: `Stored witness matched ${storeIds.length} memory id${storeIds.length === 1 ? "" : "s"}`,
  };

  const oracleIds = goldWitness.oracleMemoryIds;
  let indexPassed = false;
  let indexFailed = false;
  if (oracleIds === null) {
    stages.index = { status: "unavailable", detail: "stored oracle witness unavailable" };
  } else if (oracleIds.some((id) => storeIdSet.has(id))) {
    indexPassed = true;
    stages.index = { status: "pass", detail: "Found in stored oracle witness" };
  } else {
    indexFailed = true;
    stages.index = { status: "fail", detail: "Not found in stored oracle witness" };
  }

  let appliedHit: { sessionId: string; rank: number } | undefined;
  let atCapUnavailable = retrievals.length === 0;
  for (const retrieval of retrievals) {
    if (retrieval.atCapMemoryIds === null) {
      atCapUnavailable = true;
      continue;
    }
    const index = retrieval.atCapMemoryIds.findIndex((id) => storeIdSet.has(id));
    if (index >= 0) {
      appliedHit = { sessionId: retrieval.sessionId, rank: index + 1 };
      break;
    }
  }

  let headroomHit: { sessionId: string; rank: number; appliedCap: number } | undefined;
  if (!appliedHit) {
    for (const retrieval of retrievals) {
      if (retrieval.headroomMemoryIds === null || retrieval.appliedCap === null) {
        continue;
      }
      const index = retrieval.headroomMemoryIds.findIndex((id) => storeIdSet.has(id));
      if (index >= 0) {
        headroomHit = {
          sessionId: retrieval.sessionId,
          rank: retrieval.appliedCap + index + 1,
          appliedCap: retrieval.appliedCap,
        };
        break;
      }
    }
  }

  if (appliedHit) {
    stages.retrieval = {
      status: "pass",
      detail: `Found at rank ${appliedHit.rank} in stored session ${appliedHit.sessionId}`,
    };
    if (!indexPassed) {
      indexPassed = true;
      indexFailed = false;
      stages.index = { status: "pass", detail: "implied pass from retrieval" };
    }
    stages.use = { status: "fail", detail: "Gold memory present in context but answer was incorrect" };
    return {
      goldMemory: goldStatement,
      label: { class: "use_miss", reason: "Gold memory present in context but task failed" },
      stages,
    };
  }

  let retrievalStageMiss: RetrievalMissStage = "unknown";
  if (atCapUnavailable) {
    stages.retrieval = { status: "unavailable", detail: "stored at-cap witness unavailable" };
  } else if (headroomHit) {
    retrievalStageMiss = "cap";
    stages.retrieval = {
      status: "fail",
      detail: `Headroom rank ${headroomHit.rank} exceeds applied cap ${headroomHit.appliedCap} in session ${headroomHit.sessionId}`,
    };
    if (!indexPassed) {
      indexPassed = true;
      indexFailed = false;
      stages.index = { status: "pass", detail: "implied pass from retrieval headroom" };
    }
  } else {
    stages.retrieval = { status: "fail", detail: "absent from every stored at-cap retrieval witness" };
  }

  if (indexFailed && stages.retrieval.status === "fail") {
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: { class: "index_miss", reason: "Gold statement missing from search index" },
      stages,
    };
  }
  if (indexPassed && stages.retrieval.status === "fail") {
    stages.use = { status: "unavailable", detail: "not reached" };
    return {
      goldMemory: goldStatement,
      label: {
        class: "retrieval_miss",
        retrievalStage: retrievalStageMiss,
        reason: stages.retrieval.detail,
      },
      stages,
    };
  }

  stages.use = { status: "unavailable", detail: "not reached" };
  const reason = stages.index.status === "unavailable"
    ? "index check unavailable; a retrieval miss cannot be isolated from an index miss"
    : "retrieval check unavailable";
  return {
    goldMemory: goldStatement,
    label: { class: "unattributed", reason },
    stages,
  };
}

export async function attributeTask(
  task: {
    taskId: string;
    question: string;
    scores?: Record<string, number>;
    goldMemories?: string[];
    attributionWitness?: TaskAttributionWitness;
    details?: Record<string, unknown>;
  },
  env: AttributionEnvironment,
  options: AttributeOptions = {}
): Promise<TaskAttribution | null> {
  const golds = task.goldMemories ??
    task.attributionWitness?.golds.map((gold) => gold.goldMemory);
  if (!golds || golds.length === 0) {
    return null;
  }

  const recalledText = typeof task.details?.recalledText === "string" ? task.details.recalledText : undefined;
  if (task.attributionWitness) {
    const goldAttributions: GoldMemoryAttribution[] = [];
    for (let index = 0; index < golds.length; index += 1) {
      const gold = golds[index];
      const goldWitness = task.attributionWitness.golds[index];
      if (!goldWitness || goldWitness.goldMemory !== gold) {
        throw new Error("attribution witness golds must match task goldMemories in length and order");
      }
      goldAttributions.push(attributeGoldMemoryFromWitness(
        gold,
        goldWitness,
        task.attributionWitness.retrievals,
        task.attributionWitness.runtime.attributionThreshold,
        options,
        recalledText,
      ));
    }
    if (task.attributionWitness.golds.length !== golds.length) {
      throw new Error("attribution witness golds must match task goldMemories in length and order");
    }
    return {
      taskId: task.taskId,
      question: task.question,
      golds: goldAttributions,
      overall: computeOverallLabel(goldAttributions),
    };
  }
  const memoizedEnv = withMemoizedListMemories(env);


  const goldAttributions: GoldMemoryAttribution[] = [];
  for (const gold of golds) {
    const attr = await attributeGoldMemory(gold, task.question, memoizedEnv, options, recalledText);
    goldAttributions.push(attr);
  }

  const overall = computeOverallLabel(goldAttributions);

  return {
    taskId: task.taskId,
    question: task.question,
    golds: goldAttributions,
    overall,
  };
}

export async function attributeRun(
  result: {
    meta?: { id?: string; runId?: string };
    results: {
      tasks: {
        taskId: string;
        question: string;
        scores?: Record<string, number>;
        goldMemories?: string[];
        details?: Record<string, unknown>;
        attributionWitness?: TaskAttributionWitness;
      }[];
    };
  },
  env: AttributionEnvironment,
  options: AttributeOptions = {}
): Promise<AttributionReport> {
  const runId = result.meta?.runId ?? result.meta?.id ?? "unknown-run";
  let memoizedEnv: AttributionEnvironment | undefined;

  const totals: Record<AttributionClass, number> = {
    extraction_miss: 0,
    index_miss: 0,
    retrieval_miss: 0,
    use_miss: 0,
    unattributed: 0,
  };

  const retrievalStages: Record<RetrievalMissStage, number> = {
    filter: 0,
    cap: 0,
    rank: 0,
    unknown: 0,
  };

  const items: TaskAttribution[] = [];
  const skippedTasks: { taskId: string; reason: string }[] = [];

  for (const task of result.results.tasks) {
    if (task.details?.benchmarkFailure && typeof task.details.benchmarkFailure === "object") {
      skippedTasks.push({
        taskId: task.taskId,
        reason: "trial execution failure (not an answer failure)",
      });
      continue;
    }
    const goldCount = task.goldMemories?.length ??
      task.attributionWitness?.golds.length ??
      0;
    if (goldCount === 0) {
      skippedTasks.push({
        taskId: task.taskId,
        reason: "No goldMemories specified",
      });
      continue;
    }
    if (!isTaskFailed(task)) {
      skippedTasks.push({
        taskId: task.taskId,
        reason: "Task passed (score >= 1)",
      });
      continue;
    }

    const taskEnv = task.attributionWitness
      ? env
      : (memoizedEnv ??= withMemoizedListMemories(env));
    const taskAttr = await attributeTask(task, taskEnv, options);
    if (taskAttr) {
      items.push(taskAttr);
    }
  }

  items.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  skippedTasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  for (const item of items) {
    totals[item.overall.class]++;
    if (item.overall.class === "retrieval_miss") {
      const stage = item.overall.retrievalStage ?? "unknown";
      retrievalStages[stage]++;
    }
  }

  return {
    runId,
    totals,
    retrievalStages,
    attributedTasks: items.length,
    skippedTasks,
    items,
  };
}

export function renderAttributionReportTable(report: AttributionReport): string {
  const lines: string[] = [];

  lines.push(`Attribution Report (Run: ${report.runId})`);
  lines.push(`Failed-task predicate: minimum primary answer score < 1 (scores.overall or non-diagnostic scores)`);
  lines.push(`Attributed tasks: ${report.attributedTasks}, Skipped tasks: ${report.skippedTasks.length}`);
  lines.push("");
  lines.push("Totals by Class:");
  lines.push(`  extraction_miss: ${report.totals.extraction_miss}`);
  lines.push(`  index_miss:      ${report.totals.index_miss}`);
  lines.push(`  retrieval_miss:  ${report.totals.retrieval_miss}`);
  lines.push(`  use_miss:        ${report.totals.use_miss}`);
  lines.push(`  unattributed:    ${report.totals.unattributed}`);
  lines.push("");
  lines.push("Retrieval Miss Stages:");
  lines.push(`  filter:  ${report.retrievalStages.filter}`);
  lines.push(`  cap:     ${report.retrievalStages.cap}`);
  lines.push(`  rank:    ${report.retrievalStages.rank}`);
  lines.push(`  unknown: ${report.retrievalStages.unknown}`);
  lines.push("");
  lines.push("Task Attributions:");

  if (report.items.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of report.items) {
      const stageStr = item.overall.retrievalStage ? ` (${item.overall.retrievalStage})` : "";
      const labelStr = `${item.overall.class}${stageStr}`;
      const reasonStr = item.overall.reason ? ` - ${item.overall.reason}` : "";
      lines.push(`  ${item.taskId.padEnd(20)} ${labelStr.padEnd(24)}${reasonStr}`);
    }
  }

  if (report.skippedTasks.length > 0) {
    lines.push("");
    lines.push("Skipped Tasks:");
    for (const skipped of report.skippedTasks) {
      lines.push(`  ${skipped.taskId.padEnd(20)} ${skipped.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function serializeAttributionReport(report: AttributionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
