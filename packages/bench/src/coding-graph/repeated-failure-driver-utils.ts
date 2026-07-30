import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ControlledResponsesEpisodeResult,
  ControlledResponsesFault,
  RepeatedFailureFinalRepoEvidence,
  RepeatedFailureToolExecutionResult,
} from "./repeated-failure-responses-driver.js";

const MAX_TOOL_OUTPUT_BYTES = 16_384;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function serializeBoundedToolOutput(result: RepeatedFailureToolExecutionResult): string {
  let serialized: string;
  try {
    serialized = JSON.stringify({ status: result.status, output: result.output });
  } catch {
    serialized = JSON.stringify({ status: "failed", output: "non-serializable tool output" });
  }
  const sanitized = serialized
    .replace(/(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(?:\/home\/[^\s/\"]+|\/Users\/[^\s/\"]+|[A-Za-z]:\\Users\\[^\s\\\"]+)/g, "$HOME");
  if (Buffer.byteLength(sanitized, "utf8") <= MAX_TOOL_OUTPUT_BYTES) return sanitized;
  const preview = Buffer.from(sanitized, "utf8").subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8");
  return JSON.stringify({
    status: result.status,
    truncated: true,
    outputHash: sha256(sanitized),
    preview,
  });
}

export function normalizeFinalEvidence(
  evidence: RepeatedFailureFinalRepoEvidence,
): RepeatedFailureFinalRepoEvidence {
  if (!isBoundedString(evidence.repoHash, 256)) throw new Error("invalid repo hash");
  if (![
    "UNFIXED",
    "TRAPPED",
    "FIXED",
    "NO_TRAP",
    "INDETERMINATE",
  ].includes(evidence.checkResult)) {
    throw new Error("invalid check result");
  }
  if (!Array.isArray(evidence.changedFiles) || evidence.changedFiles.length > 1000) {
    throw new Error("invalid changed file list");
  }
  const changedFiles = [...new Set(evidence.changedFiles.map((file) => {
    if (!isBoundedString(file, 1024) || path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) {
      throw new Error("evidence paths must be repository-relative");
    }
    const normalized = file.replace(/\\/g, "/");
    if (normalized.split("/").some((segment) => segment === ".." || segment === "")) {
      throw new Error("evidence path escapes repository");
    }
    return normalized;
  }))].sort();
  return { repoHash: evidence.repoHash, checkResult: evidence.checkResult, changedFiles };
}

export function failedToolExecutionResult(): RepeatedFailureToolExecutionResult {
  return {
    status: "failed",
    output: { error: "TOOL_EXECUTION_FAILED" },
  };
}

export function firstRetryableHostFault(
  result: Pick<ControlledResponsesEpisodeResult, "status" | "faults">,
): ControlledResponsesFault | undefined {
  const [fault] = result.faults;
  if (result.status !== "INVALID" || !fault) return undefined;
  const onlyHostSurfaces = result.faults.every(
    (entry) => entry.stage === "transport" || entry.stage === "response",
  );
  return onlyHostSurfaces ? fault : undefined;
}
