import fs from "node:fs";
import path from "node:path";

import type { ParsedBenchArgs } from "./bench-args.js";

const FALLBACK_RESULTS_DIRNAME = "fallback-runs";

export function buildBenchRunnerArgs(
  parsed: ParsedBenchArgs,
  benchmarkId: string,
  outputDir?: string,
): string[] {
  const args = ["--benchmark", benchmarkId];
  if (parsed.quick) {
    args.push("--lightweight");
  }
  if (parsed.publishedLimit !== undefined) {
    args.push("--limit", String(parsed.publishedLimit));
  } else if (parsed.quick) {
    args.push("--limit", "1");
  }
  if (parsed.datasetDir) {
    args.push("--dataset-dir", parsed.datasetDir);
  }
  if (outputDir) {
    args.push("--output-dir", outputDir);
  }
  return args;
}

export function findUnsupportedFallbackBenchOptions(parsed: ParsedBenchArgs): string[] {
  const unsupported: string[] = [];
  const add = (condition: boolean, flag: string) => {
    if (condition) unsupported.push(flag);
  };

  add(parsed.modelSource !== undefined, "--model-source");
  add(parsed.gatewayAgentId !== undefined, "--gateway-agent-id");
  add(parsed.fastGatewayAgentId !== undefined, "--fast-gateway-agent-id");
  add(parsed.systemProvider !== undefined, "--system-provider/--provider");
  add(parsed.systemModel !== undefined, "--system-model/--model");
  add(parsed.systemBaseUrl !== undefined, "--system-base-url/--base-url");
  add(parsed.systemApiKey !== undefined, "--system-api-key");
  add(parsed.systemCodexReasoningEffort !== undefined, "--system-codex-reasoning-effort");
  add(parsed.systemResponderContextBudgetChars !== undefined, "--system-responder-context-budget-chars");
  add(parsed.systemResponderPromptBudgetChars !== undefined, "--system-responder-prompt-budget-chars");
  add(parsed.judgeProvider !== undefined, "--judge-provider");
  add(parsed.judgeModel !== undefined, "--judge-model");
  add(parsed.judgeBaseUrl !== undefined, "--judge-base-url");
  add(parsed.judgeApiKey !== undefined, "--judge-api-key");
  add(parsed.judgeCodexReasoningEffort !== undefined, "--judge-codex-reasoning-effort");
  add(parsed.internalProvider !== undefined, "--internal-provider");
  add(parsed.internalModel !== undefined, "--internal-model");
  add(parsed.internalBaseUrl !== undefined, "--internal-base-url");
  add(parsed.internalApiKey !== undefined, "--internal-api-key");
  add(parsed.internalDisableThinking === true, "--internal-disable-thinking");
  add(parsed.internalCodexReasoningEffort !== undefined, "--internal-codex-reasoning-effort");
  add(parsed.amaBenchJudgeProtocol !== undefined, "--ama-bench-judge-protocol");
  add(parsed.amaBenchCrossJudgeProvider !== undefined, "--ama-bench-cross-judge-provider");
  add(parsed.amaBenchCrossJudgeModel !== undefined, "--ama-bench-cross-judge-model");
  add(parsed.amaBenchCrossJudgeBaseUrl !== undefined, "--ama-bench-cross-judge-base-url");
  add(parsed.amaBenchCrossJudgeApiKey !== undefined, "--ama-bench-cross-judge-api-key");
  add(parsed.amaBenchCrossJudgeCodexReasoningEffort !== undefined, "--ama-bench-cross-judge-codex-reasoning-effort");
  add(parsed.disableThinking === true, "--disable-thinking");
  add(parsed.requestTimeout !== undefined, "--request-timeout");
  add(parsed.drainTimeout !== undefined, "--drain-timeout");
  add(parsed.max429WaitMs !== undefined, "--max-429-wait");
  add(parsed.publishedTrialLimit !== undefined, "--trial-limit");
  add(parsed.publishedTrialConcurrency !== undefined, "--trial-concurrency");
  add(parsed.publishedIngestConcurrency !== undefined, "--ingest-concurrency");
  add(parsed.publishedTaskFilter !== undefined, "--task-filter");
  add(parsed.publishedSeed !== undefined, "--seed");

  return unsupported;
}

export function createFallbackBenchOutputDir(
  resultsDir: string,
  benchmarkId: string,
  pid: number,
  startedAtMs: number = Date.now(),
): string {
  return path.join(
    resultsDir,
    FALLBACK_RESULTS_DIRNAME,
    `${benchmarkId}-${startedAtMs}-${pid}`,
  );
}

export function resolveFallbackBenchResultPath(outputDir: string): string {
  const entries = fs.readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    throw new Error(`Fallback benchmark runner did not write a JSON result artifact in ${outputDir}`);
  }
  return path.join(outputDir, entries[0]);
}
