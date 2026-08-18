import type {
  MemoryActionEligibilityContext,
  MemoryActionPolicyResult,
  MemoryActionType,
} from "./types.js";

export interface MemoryActionPolicyOptions {
  actionsEnabled: boolean;
  maxCompressionTokensPerHour: number;
}

const HIGH_IMPORTANCE_DISCARD_THRESHOLD = 0.8;
const LOW_CONFIDENCE_DEFER_THRESHOLD = 0.35;

export function evaluateMemoryActionPolicy(input: {
  action: MemoryActionType;
  eligibility: MemoryActionEligibilityContext;
  options: MemoryActionPolicyOptions;
}): MemoryActionPolicyResult {
  const { action, eligibility, options } = input;

  if (!options.actionsEnabled) {
    return {
      action,
      decision: "deny",
      rationale: "contextCompressionActionsEnabled=false",
      eligibility,
    };
  }

  if (options.maxCompressionTokensPerHour === 0 && action === "summarize_node") {
    return {
      action,
      decision: "defer",
      rationale: "maxCompressionTokensPerHour=0",
      eligibility,
    };
  }

  if (action === "discard" && eligibility.importance >= HIGH_IMPORTANCE_DISCARD_THRESHOLD) {
    return {
      action,
      decision: "deny",
      rationale: "importance_too_high_for_discard",
      eligibility,
    };
  }

  if (
    (eligibility.lifecycleState === "archived" || eligibility.lifecycleState === "stale") &&
    (action === "update_note" || action === "create_artifact" || action === "link_graph")
  ) {
    return {
      action,
      decision: "deny",
      rationale: `lifecycle_state_${eligibility.lifecycleState}_restricted`,
      eligibility,
    };
  }

  if (
    eligibility.source !== "unknown" &&
    eligibility.confidence < LOW_CONFIDENCE_DEFER_THRESHOLD &&
    action !== "discard"
  ) {
    return {
      action,
      decision: "defer",
      rationale: "confidence_below_threshold",
      eligibility,
    };
  }

  return {
    action,
    decision: "allow",
    rationale: "eligible",
    eligibility,
  };
}

/**
 * Gate for active-context SUMMARY/FILTER plans (issue #2347). The single
 * deny rule is the shared `contextCompressionActionsEnabled` gate — a closed
 * gate returns `feature_disabled` before any selection or model work. LLM
 * summaries carry their own cap gate (`activeContextTransformLlmEnabled`)
 * resolved at plan time, not here.
 */
export interface ActiveContextTransformPolicyResult {
  decision: "allow" | "deny";
  rationale: string;
}

export function evaluateActiveContextTransformPolicy(options: {
  actionsEnabled: boolean;
  operation: "SUMMARY" | "FILTER";
}): ActiveContextTransformPolicyResult {
  if (!options.actionsEnabled) {
    return {
      decision: "deny",
      rationale: "contextCompressionActionsEnabled=false",
    };
  }
  return {
    decision: "allow",
    rationale: `${options.operation.toLowerCase()}_eligible`,
  };
}
