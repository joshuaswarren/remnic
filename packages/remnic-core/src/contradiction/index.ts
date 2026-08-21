/**
 * Contradiction detection module (issue #520).
 *
 * Nightly scan that pairs semantically-similar active memories,
 * classifies them with an LLM-as-judge, and queues contradicting
 * pairs for user resolution.
 */

export { runContradictionScan, ACTIVE_STATUSES, type ScanResult, type ScanDependencies } from "./contradiction-scan.js";
export {
  judgeContradictionPairs,
  createVerdictCache,
  clearVerdictCache,
  verdictCacheSize,
  type ContradictionVerdict,
  type ContradictionJudgeInput,
  type ContradictionJudgeResult,
  type ContradictionJudgeBatchResult,
} from "./contradiction-judge.js";
export {
  computePairId,
  writePair,
  writePairs,
  readPair,
  listPairs,
  isCoolingDown,
  resolvePair,
  type ContradictionPair,
  type ContradictionListResult,
  type ContradictionFilter,
  type ResolutionVerb,
} from "./contradiction-review.js";
export {
  executeResolution,
  isValidResolutionVerb,
  type ResolutionResult,
} from "./resolution.js";
