import type { ReconcilePlan } from "@remnic/core/reconcile/plan.js";
import type { ConvergeNamespaceExclusion } from "./converge-namespace-exclusions.js";

type ReportPlan = ReconcilePlan & {
  excludedNamespaces?: readonly ConvergeNamespaceExclusion[];
};

type ApplyReportInput = {
  converged: boolean;
  status: string;
  plan: ReconcilePlan;
  transfers: {
    pulled: number;
    pushed: number;
    conflictsResolved: number;
    suppressed: number;
    failed: number;
  };
};

function singleLine(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const code = char.charCodeAt(0);
    const isSpace = code === 32 || code === 9 || code === 10 || code === 13;
    if (isSpace) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
  }
  return out;
}

export function formatConvergeReport(plan: ReportPlan): string {
  const excluded = plan.excludedNamespaces ?? [];
  const lines: string[] = [];
  const status = excluded.length > 0 && plan.converged ? "PARTIAL" : plan.converged ? "CONVERGED" : "DIVERGED";
  lines.push(`Convergence Status: ${status}`);
  lines.push("");
  lines.push("Per-Namespace Summary:");
  if (plan.byNamespace.length === 0) {
    lines.push("  (no namespaces evaluated)");
  } else {
    for (const report of plan.byNamespace) {
      lines.push(`  [${report.namespace}]`);
      lines.push(`    identical:  ${report.identical}`);
      lines.push(`    pull:       ${report.pull}`);
      lines.push(`    push:       ${report.push}`);
      lines.push(`    conflict:   ${report.conflict}`);
      lines.push(`    suppress:   ${report.suppress}`);
      lines.push(`    unresolved: ${report.unresolved}`);
    }
  }
  if (excluded.length > 0) {
    lines.push("");
    lines.push("Excluded namespaces (census failed; no pushes, no deletes):");
    for (const exclusion of excluded) {
      lines.push(`  [${singleLine(exclusion.namespace)}] side=${exclusion.side} ${singleLine(exclusion.error)}`);
    }
  }
  return lines.join("\n");
}

export function formatConvergeWatchCycleLine(
  cycle: number,
  result: ApplyReportInput & { excludedNamespaces?: readonly ConvergeNamespaceExclusion[] }
): string {
  const transfers = result.transfers;
  const excluded = result.excludedNamespaces?.length ?? 0;
  return `converge watch: cycle ${cycle} status=${result.status} pulled=${transfers.pulled} pushed=${transfers.pushed} conflicts=${transfers.conflictsResolved} failed=${transfers.failed} excluded=${excluded}`;
}

export function formatConvergeExclusionLine(cycle: number | undefined, exclusion: ConvergeNamespaceExclusion): string {
  const prefix = cycle === undefined ? "converge:" : `converge watch: cycle ${cycle}`;
  return `${prefix} excluded namespace=${singleLine(exclusion.namespace)} side=${exclusion.side}: ${singleLine(exclusion.error)}`;
}

export function formatConvergeApplyReport(result: ApplyReportInput): string {
  const lines: string[] = [];
  lines.push(`Convergence Execution Status: ${result.status.toUpperCase()}`);
  lines.push(`Converged: ${result.converged ? "YES" : "NO"}`);
  lines.push("");
  lines.push("Transfers Executed:");
  lines.push(`  pulled:             ${result.transfers.pulled}`);
  lines.push(`  pushed:             ${result.transfers.pushed}`);
  lines.push(`  conflictsResolved:  ${result.transfers.conflictsResolved}`);
  lines.push(`  suppressed:         ${result.transfers.suppressed}`);
  lines.push(`  failed:             ${result.transfers.failed}`);
  lines.push("");
  lines.push(formatConvergeReport(result.plan));
  return lines.join("\n");
}
