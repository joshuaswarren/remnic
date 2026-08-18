/**
 * CLI surface for memory-subject operations (issue #2372).
 *
 * `remnic promotion-candidates` — read-only surfacing of agent-subject,
 * reuse-signaled promotion candidates. `remnic subjects backfill` — the
 * deterministic shadow/apply stamp for unstamped memories. Runners take an
 * io seam (service/storage callbacks + stdout) so tests drive them without
 * booting an orchestrator; the remnic-cli entry supplies the real ones.
 */

import type {
  PromotionCandidatesResult,
  SubjectBackfillReport,
} from "./memory-subject.js";

export interface PromotionCandidatesCliOptions {
  namespace?: string;
  targetNamespace?: string;
  limit: number;
  json: boolean;
}

export function parsePromotionCandidatesCliOptions(args: {
  namespace?: string;
  targetNamespace?: string;
  limit?: string;
  json?: boolean;
}): PromotionCandidatesCliOptions {
  let limit = 20;
  if (args.limit !== undefined) {
    const parsed = Number(args.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new Error(
        `promotion-candidates: --limit expects an integer in [1, 100] (got ${JSON.stringify(args.limit)})`,
      );
    }
    limit = parsed;
  }
  return {
    ...(args.namespace !== undefined && args.namespace !== "" ? { namespace: args.namespace } : {}),
    ...(args.targetNamespace !== undefined && args.targetNamespace !== ""
      ? { targetNamespace: args.targetNamespace }
      : {}),
    limit,
    json: args.json === true,
  };
}

export function renderPromotionCandidates(result: PromotionCandidatesResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const lines = [
    `Namespace: ${result.namespace}  Target layer: ${result.targetNamespace}  (minAccessCount ${result.minAccessCount})`,
  ];
  if (result.candidates.length === 0) {
    lines.push("No promotion candidates.");
    return lines.join("\n");
  }
  for (const c of result.candidates) {
    lines.push(
      `- ${c.id} [${c.category}] signal=${c.reuseSignal} access=${c.accessCount} reinforced=${c.reinforcementCount} mw=${c.mwSuccess}/${c.mwFail}`,
    );
    lines.push(`  ${c.content.replace(/\s+/g, " ").slice(0, 100)}`);
  }
  lines.push("Promote explicitly with the existing promotion commands; nothing is auto-promoted.");
  return lines.join("\n");
}

export async function runPromotionCandidatesCommand(
  rest: string[],
  io: {
    promotionCandidates: (request: {
      namespace?: string;
      targetNamespace?: string;
      limit?: number;
    }) => Promise<PromotionCandidatesResult>;
    stdout: (line: string) => void;
  },
): Promise<void> {
  const flag = (name: string): string | undefined => {
    const hit = rest.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const options = parsePromotionCandidatesCliOptions({
    namespace: flag("namespace"),
    targetNamespace: flag("target-namespace"),
    limit: flag("limit"),
    json: rest.includes("--json"),
  });
  const result = await io.promotionCandidates({
    ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
    ...(options.targetNamespace !== undefined ? { targetNamespace: options.targetNamespace } : {}),
    limit: options.limit,
  });
  io.stdout(renderPromotionCandidates(result, options.json));
}

export interface SubjectsBackfillCliOptions {
  mode: "shadow" | "apply";
  namespace?: string;
}

export function parseSubjectsBackfillCliOptions(args: {
  apply?: boolean;
  namespace?: string;
}): SubjectsBackfillCliOptions {
  return {
    mode: args.apply === true ? "apply" : "shadow",
    ...(args.namespace !== undefined && args.namespace !== "" ? { namespace: args.namespace } : {}),
  };
}

export async function runSubjectsBackfillCommand(
  rest: string[],
  io: {
    backfill: (options: { mode: "shadow" | "apply"; namespace?: string }) => Promise<SubjectBackfillReport>;
    stdout: (line: string) => void;
  },
): Promise<void> {
  const namespaceFlag = rest.find((a) => a.startsWith("--namespace="))?.slice("--namespace=".length);
  const options = parseSubjectsBackfillCliOptions({
    apply: rest.includes("--apply"),
    namespace: namespaceFlag,
  });
  const report = await io.backfill(options);
  const lines = [
    `Mode: ${report.mode}  Scanned: ${report.scanned}  Already stamped: ${report.alreadyStamped}  To stamp: ${report.stamped}`,
  ];
  for (const stamp of report.stamps) {
    lines.push(`- ${stamp.id} [${stamp.category}] → subject: ${stamp.subject}`);
  }
  if (report.mode === "shadow") {
    lines.push("Shadow run — nothing written. Re-run with --apply to stamp.");
  }
  io.stdout(lines.join("\n"));
}
