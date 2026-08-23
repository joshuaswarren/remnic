/**
 * Deterministic LTP-style state-confusion task set (issue #1952).
 *
 * Each task is a change-oriented query over a small synthetic corpus with a
 * supersession chain. The runner replays the SAME read-side contract the
 * live recall pipeline applies (policy-filter admission → annotateStateView
 * labels): a superseded row is admitted only when its successor is in the
 * candidate set, then labeled current/historical/transition. No I/O, no
 * model, no external benchmark — exact-match expectations in both modes.
 *
 * Baseline (feature off) expects the supersession-filter view: superseded
 * rows never surface. Enabled (feature on) expects the labeled history view;
 * a non-change query stays baseline-identical even when enabled.
 */
import {
  annotateStateView,
  isChangeOrientedQuery,
  type StateLabel,
  type StateViewChain,
  type StateViewResult,
} from "@remnic/core";

export interface StateViewTask {
  id: string;
  query: string;
  corpus: readonly StateViewResult[];
  /** Successor links the labeler cannot derive from `supersededBy` alone (correction back-pointers). */
  chains?: readonly StateViewChain[];
  /** Expected (id, label) pairs when `recallStateViews` is ON. Absent label = unlabeled row. */
  expectedEnabled: readonly { id: string; label?: StateLabel }[];
  /** Expected visible ids when `recallStateViews` is OFF (supersession filter). */
  expectedBaseline: readonly string[];
}

function fact(id: string, status: StateViewResult["status"], extra: Partial<StateViewResult> = {}): StateViewResult {
  return { id, status, ...extra };
}

export const STATE_VIEW_TASKS: readonly StateViewTask[] = [
  {
    id: "state-view/single-hop",
    query: "when did the deploy pipeline switch providers?",
    corpus: [
      fact("deploy-old", "superseded", { supersededBy: "deploy-current", supersededAt: "2026-05-01" }),
      fact("deploy-current", "active"),
    ],
    expectedEnabled: [
      { id: "deploy-old", label: "historical" },
      { id: "deploy-current", label: "current" },
    ],
    expectedBaseline: ["deploy-current"],
  },
  {
    id: "state-view/multi-hop",
    query: "what changed about the database?",
    corpus: [
      fact("db-v1", "superseded", { supersededBy: "db-v2", supersededAt: "2026-04-01" }),
      fact("db-v2", "superseded", { supersededBy: "db-v3", supersededAt: "2026-06-01" }),
      fact("db-v3", "active"),
    ],
    expectedEnabled: [
      { id: "db-v1", label: "historical" },
      { id: "db-v2", label: "transition" },
      { id: "db-v3", label: "current" },
    ],
    expectedBaseline: ["db-v3"],
  },
  {
    id: "state-view/orphan-never-shown",
    query: "used to use which queue?",
    corpus: [
      fact("queue-current", "active"),
      fact("queue-orphan", "superseded", { supersededBy: "queue-absent", supersededAt: "2026-03-01" }),
    ],
    expectedEnabled: [{ id: "queue-current", label: "current" }],
    expectedBaseline: ["queue-current"],
  },
  {
    id: "state-view/non-change-query-inert",
    query: "which queue do we use?",
    corpus: [
      fact("queue-current", "active"),
      fact("queue-old", "superseded", { supersededBy: "queue-current", supersededAt: "2026-03-01" }),
    ],
    // No change intent: state views are inert and the supersession filter
    // alone decides — identical to baseline, and the row carries no label.
    expectedEnabled: [{ id: "queue-current" }],
    expectedBaseline: ["queue-current"],
  },
  {
    id: "state-view/disputed-cycle-safe",
    query: "when did the vendor change?",
    corpus: [
      fact("vendor-a", "superseded", { supersededBy: "vendor-b", supersededAt: "2026-01-01" }),
      fact("vendor-b", "superseded", { supersededBy: "vendor-a", supersededAt: "2026-02-01" }),
      fact("vendor-c", "active"),
    ],
    // A disputed 2-cycle anchors on no current successor: both sides label
    // transition (each has an in-set successor), neither claims historical.
    expectedEnabled: [
      { id: "vendor-a", label: "transition" },
      { id: "vendor-b", label: "transition" },
      { id: "vendor-c", label: "current" },
    ],
    expectedBaseline: ["vendor-c"],
  },
  {
    id: "state-view/corrected-backpointer",
    query: "before the correction, what was the rate limit?",
    corpus: [
      fact("limit-old", "superseded", { supersededAt: "2026-02-01" }),
      fact("limit-new", "active"),
    ],
    // Corrected row: the replacement carries the `supersedes` back-pointer,
    // the corrected row has no `supersededBy` — the chain link carries it.
    chains: [{ predecessorId: "limit-old", successorId: "limit-new", supersededAt: "2026-02-01" }],
    expectedEnabled: [
      { id: "limit-old", label: "historical" },
      { id: "limit-new", label: "current" },
    ],
    expectedBaseline: ["limit-new"],
  },
];

export interface StateViewRunResult {
  taskId: string;
  passed: boolean;
  actual: { id: string; label?: StateLabel }[];
  expected: { id: string; label?: StateLabel }[];
}

function successorOf(row: StateViewResult, chains: readonly StateViewChain[]): string | undefined {
  if (row.supersededBy) return row.supersededBy;
  return chains.find((chain) => chain.predecessorId === row.id)?.successorId;
}

/**
 * Replay the read-side contract over a task corpus for one mode: admission
 * first (superseded stays hidden unless enabled AND change-intent AND its
 * successor is in the candidate set), then annotation (labels, orphan
 * fixpoint).
 */
export function runStateViewTask(task: StateViewTask, options: { enabled: boolean }): StateViewRunResult {
  const chains = task.chains ?? [];
  const viewActive = options.enabled && isChangeOrientedQuery(task.query);
  const candidateIds = new Set(task.corpus.map((row) => row.id ?? "").filter(Boolean));
  const admitted = task.corpus.filter((row) => {
    const superseded = row.status === "superseded" || Boolean(row.supersededBy);
    if (!superseded) return true;
    if (!viewActive) return false;
    const successorId = successorOf(row, chains);
    return typeof successorId === "string" && candidateIds.has(successorId);
  });
  const actual = (viewActive
    ? annotateStateView(admitted, task.query, chains, { enabled: true })
    : admitted
  ).map((row) => ({ id: row.id ?? "", label: row.stateLabel }));
  const expected = (
    options.enabled ? task.expectedEnabled : task.expectedBaseline.map((id) => ({ id }))
  ).map((e) => ({ id: e.id, label: "label" in e ? e.label : undefined }));
  const passed =
    actual.length === expected.length &&
    actual.every((row, i) => row.id === expected[i]?.id && row.label === expected[i]?.label);
  return { taskId: task.id, passed, actual, expected };
}
