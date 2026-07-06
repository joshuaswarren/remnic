/**
 * correction/index.ts — barrel for the Correction Contract (issue #1580).
 *
 * One plan/apply pipeline for all memory corrections. See
 * {@link CorrectionService} for the single entry point every surface calls.
 */

export {
  CorrectionContractError,
  CORRECTION_ACTION_KINDS,
  CORRECTION_CLASSIFICATIONS,
  CORRECTION_TEXT_MAX,
  REDACTION_PATTERN_MAX,
  deterministicFallbackPlan,
  newPlanId,
  validateCorrectionAction,
  validateCorrectionRequest,
  validateMemoryDraft,
  validateRedactionPattern,
} from "./correction-contract.js";

export type {
  CorrectionAction,
  CorrectionAffectedEntry,
  CorrectionClassification,
  CorrectionOutcome,
  CorrectionPlan,
  CorrectionRequest,
  CorrectionActionResult,
  MemoryDraft,
} from "./correction-contract.js";

export { CorrectionPlanner, parsePlan } from "./correction-planner.js";
export type { LlmClassificationResult, PlannerCandidate, PlannerDeps } from "./correction-planner.js";

export { CorrectionExecutor } from "./correction-executor.js";
export type { ExecutorDeps, ExecutorMemory } from "./correction-executor.js";

export { CorrectionService } from "./correction-service.js";
export type { CorrectionNamespacePolicy, CorrectionServiceDeps } from "./correction-service.js";

export { createCorrectionService } from "./correction-access-wiring.js";
export type { CorrectionAccessWiring } from "./correction-access-wiring.js";
