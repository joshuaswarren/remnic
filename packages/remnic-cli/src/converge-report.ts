import type { ReconcilePlan } from "@remnic/core/reconcile/plan.js";

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

export function formatConvergeReport(plan: ReconcilePlan): string {
  const lines: string[] = [];
  lines.push(`Convergence Status: ${plan.converged ? "CONVERGED" : "DIVERGED"}`);
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
  return lines.join("\n");
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
