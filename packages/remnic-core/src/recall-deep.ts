/**
 * Budgeted REFINE/EXPAND/STOP loop (issue #2332 first slice).
 *
 * Pure state stepper. Policy is injected. No LLM, no orchestrator recall,
 * no IO. Surfaces and parseConfig wait for a later PR — config.ts is at
 * its fileSizeGrandfather ceiling.
 *
 * Budget 0 stops without calling the policy. Unknown actions throw.
 */
export const DEEP_RECALL_ACTIONS = ["refine", "expand", "stop"] as const;

export type DeepRecallAction = (typeof DEEP_RECALL_ACTIONS)[number];

export interface DeepRecallState {
  query: string;
  workingSet: readonly string[];
  frontier: readonly string[];
  budget: number;
}

export interface DeepRecallTraceStep {
  action: DeepRecallAction;
  budget: number;
  workingSet: readonly string[];
  frontier: readonly string[];
}

export interface DeepRecallStepResult {
  state: DeepRecallState;
  step: DeepRecallTraceStep;
}

export interface DeepRecallResult {
  state: DeepRecallState;
  trace: readonly DeepRecallTraceStep[];
}

export type DeepRecallPolicy = (state: DeepRecallState) => string;

export function isDeepRecallAction(value: unknown): value is DeepRecallAction {
  return typeof value === "string" && (DEEP_RECALL_ACTIONS as readonly string[]).includes(value);
}

function snapshot(state: DeepRecallState): DeepRecallState {
  return {
    query: state.query,
    workingSet: [...state.workingSet],
    frontier: [...state.frontier],
    budget: state.budget,
  };
}

export function runDeepRecallStep(state: DeepRecallState, action: string): DeepRecallStepResult {
  if (!isDeepRecallAction(action)) {
    throw new Error(
      `unknown deep recall action: ${JSON.stringify(action)}. Valid: ${DEEP_RECALL_ACTIONS.join(", ")}`,
    );
  }
  if (!Number.isFinite(state.budget) || state.budget <= 0 || action === "stop") {
    const stopped = snapshot(state);
    return {
      state: stopped,
      step: {
        action: "stop",
        budget: stopped.budget,
        workingSet: stopped.workingSet,
        frontier: stopped.frontier,
      },
    };
  }

  const next = snapshot(state);
  next.budget = state.budget - 1;
  if (action === "expand") {
    const [head, ...rest] = next.frontier;
    if (head !== undefined && !next.workingSet.includes(head)) {
      next.workingSet = [...next.workingSet, head];
    }
    next.frontier = rest;
  }
  return {
    state: next,
    step: {
      action,
      budget: next.budget,
      workingSet: next.workingSet,
      frontier: next.frontier,
    },
  };
}

export function runDeepRecall(state: DeepRecallState, policy: DeepRecallPolicy): DeepRecallResult {
  const trace: DeepRecallTraceStep[] = [];
  let current = snapshot(state);
  while (true) {
    if (!Number.isFinite(current.budget) || current.budget <= 0) {
      const stopped = snapshot(current);
      trace.push({
        action: "stop",
        budget: stopped.budget,
        workingSet: stopped.workingSet,
        frontier: stopped.frontier,
      });
      return { state: stopped, trace };
    }
    const stepped = runDeepRecallStep(current, policy(current));
    trace.push(stepped.step);
    current = stepped.state;
    if (stepped.step.action === "stop") {
      return { state: current, trace };
    }
  }
}
