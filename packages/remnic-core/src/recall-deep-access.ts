/**
 * Named-policy access facade for the deep-recall stepper (issue #2332 leftover).
 *
 * Not the hot path. Surfaces and parseConfig wait. Policy names are
 * allow-listed. Budget 0 returns a tagged refusal without a policy call.
 */

import { runDeepRecall, type DeepRecallResult, type DeepRecallState } from "./recall-deep.js";

export const DEEP_RECALL_ACCESS_POLICIES = ["stop", "expand-once"] as const;

export type DeepRecallAccessPolicyName = (typeof DEEP_RECALL_ACCESS_POLICIES)[number];

export interface DeepRecallAccessInput {
  query: string;
  budget: number;
  policyName: string;
}

export interface DeepRecallAccessRefusal {
  tag: "budget_exhausted";
}

export interface DeepRecallAccessResult {
  ok: boolean;
  refusal?: DeepRecallAccessRefusal;
  state: DeepRecallState;
  trace: DeepRecallResult["trace"];
  traceJson: string;
}

export function isDeepRecallAccessPolicyName(value: unknown): value is DeepRecallAccessPolicyName {
  return typeof value === "string" && (DEEP_RECALL_ACCESS_POLICIES as readonly string[]).includes(value);
}

export function runDeepRecallAccess(input: DeepRecallAccessInput): DeepRecallAccessResult {
  if (!isDeepRecallAccessPolicyName(input.policyName)) {
    throw new Error(
      `unknown deep recall access policy: ${JSON.stringify(input.policyName)}. Valid: ${DEEP_RECALL_ACCESS_POLICIES.join(", ")}`,
    );
  }

  const start: DeepRecallState = { query: input.query, workingSet: [], frontier: [], budget: input.budget };
  if (!Number.isFinite(input.budget) || input.budget <= 0) {
    const result = runDeepRecall(start, () => {
      throw new Error("policy must not run when budget is 0");
    });
    return {
      ok: false,
      refusal: { tag: "budget_exhausted" },
      state: result.state,
      trace: result.trace,
      traceJson: JSON.stringify(result.trace),
    };
  }

  let expanded = false;
  const result = runDeepRecall(start, () => {
    if (input.policyName === "expand-once" && !expanded) {
      expanded = true;
      return "expand";
    }
    return "stop";
  });
  return {
    ok: true,
    state: result.state,
    trace: result.trace,
    traceJson: JSON.stringify(result.trace),
  };
}
