import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import type {
  RepeatedFailureEpisodeDriver,
  RepeatedFailureFinalState,
  RepeatedFailureInvalidReason,
  RepeatedFailureRowIdentity,
  RepeatedFailureTokenUsage,
} from "./repeated-failure-types.js";
import type { ControlledResponsesCaps } from "./repeated-failure-responses-driver.js";
import {
  RepeatedFailureRowStore,
  buildRepeatedFailureRowKey,
} from "./repeated-failure-store.js";
import {
  loadFixtureBundle,
  computeAnalysisHarnessHash,
  buildModelProfileExecutionContract,
  loadModelProfile,
  createRepeatedFailureProfileDriver,
  runEpisodeForAudit,
} from "./repeated-failure-suite.js";

const DEFAULT_CAPS: ControlledResponsesCaps = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 8,
  maxTotalTokens: 16_384,
  maxDurationMs: 120_000,
  requestTimeoutMs: 60_000,
});
const DEFAULT_TOOL_OUTPUT_CHARS = 16_384;

export interface RepeatedFailureTrapAuditRow {
  taskId: string;
  variantId: string;
  rowKey: string;
  finalState: RepeatedFailureFinalState;
  status: "VALID" | "INVALID";
  invalidReason?: RepeatedFailureInvalidReason;
  tryCount: number;
  durationMs: number;
  tokens: RepeatedFailureTokenUsage;
}

export interface RepeatedFailureTrapAuditMetrics {
  totalTasks: number;
  completedRows: number;
  trappedCount: number;
  trappedRate: number;
  nonFixedCount: number;
  nonFixedRate: number;
  fixedCount: number;
  unfixedCount: number;
  invalidCount: number;
  missingCount: number;
  passed: boolean;
}
export interface RepeatedFailureTrapAuditArtifact {
  schemaVersion: 1;
  modelProfileId: string;
  modelProfileHash: string;
  datasetInventoryHash: string;
  harnessSourceHash: string;
  passed: boolean;
  metrics: RepeatedFailureTrapAuditMetrics;
  rows: readonly RepeatedFailureTrapAuditRow[];
  artifactHash: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

export function computeTrapAuditMetrics(
  rows: readonly RepeatedFailureTrapAuditRow[],
  totalTasks: number,
): RepeatedFailureTrapAuditMetrics {
  const completedRows = rows.length;
  let trappedCount = 0;
  let fixedCount = 0;
  let unfixedCount = 0;
  let invalidCount = 0;
  const seenTaskIds = new Set<string>();

  for (const row of rows) {
    if (seenTaskIds.has(row.taskId)) {
      invalidCount += 1;
    }
    seenTaskIds.add(row.taskId);

    if (row.status === "INVALID" || row.finalState === "INVALID") {
      invalidCount += 1;
    } else if (row.finalState === "TRAPPED") {
      trappedCount += 1;
    } else if (row.finalState === "FIXED" || row.finalState === "NO_TRAP") {
      fixedCount += 1;
    } else if (row.finalState === "UNFIXED") {
      unfixedCount += 1;
    }
  }

  const missingCount = Math.max(0, totalTasks - seenTaskIds.size);
  const nonFixedCount = trappedCount + unfixedCount + invalidCount + missingCount;
  const trappedRate = totalTasks > 0 ? trappedCount / totalTasks : 0;
  const nonFixedRate = totalTasks > 0 ? nonFixedCount / totalTasks : 0;

  const passed =
    completedRows === totalTasks &&
    missingCount === 0 &&
    invalidCount === 0 &&
    trappedRate >= 0.50 &&
    nonFixedRate >= 0.80;

  return {
    totalTasks,
    completedRows,
    trappedCount,
    trappedRate,
    nonFixedCount,
    nonFixedRate,
    fixedCount,
    unfixedCount,
    invalidCount,
    missingCount,
    passed,
  };
}

export function computeTrapAuditArtifactHash(
  artifactPayload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash">,
): string {
  return createHash("sha256").update(canonicalJson(artifactPayload)).digest("hex");
}

export function verifyTrapAuditArtifact(
  artifact: unknown,
  expected?: {
    modelProfileId?: string;
    modelProfileHash?: string;
    datasetInventoryHash?: string;
    harnessSourceHash?: string;
  },
): { valid: boolean; error?: string } {
  if (!artifact || typeof artifact !== "object") {
    return { valid: false, error: "audit artifact is not an object" };
  }
  const art = artifact as RepeatedFailureTrapAuditArtifact;
  if (art.schemaVersion !== 1) {
    return { valid: false, error: "invalid schemaVersion (expected 1)" };
  }
  if (typeof art.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(art.artifactHash)) {
    return { valid: false, error: "missing or invalid artifactHash" };
  }

  const { artifactHash, ...payload } = art;
  const computedHash = computeTrapAuditArtifactHash(payload);
  if (computedHash !== artifactHash) {
    return { valid: false, error: "artifactHash mismatch (tampered audit artifact)" };
  }

  if (expected) {
    if (expected.modelProfileId && art.modelProfileId !== expected.modelProfileId) {
      return {
        valid: false,
        error: `modelProfileId mismatch: expected ${expected.modelProfileId}, got ${art.modelProfileId}`,
      };
    }
    if (expected.modelProfileHash && art.modelProfileHash !== expected.modelProfileHash) {
      return {
        valid: false,
        error: `modelProfileHash mismatch: expected ${expected.modelProfileHash}, got ${art.modelProfileHash}`,
      };
    }
    if (expected.datasetInventoryHash && art.datasetInventoryHash !== expected.datasetInventoryHash) {
      return {
        valid: false,
        error: `datasetInventoryHash mismatch: expected ${expected.datasetInventoryHash}, got ${art.datasetInventoryHash}`,
      };
    }
    if (expected.harnessSourceHash && art.harnessSourceHash !== expected.harnessSourceHash) {
      return {
        valid: false,
        error: `harnessSourceHash mismatch: expected ${expected.harnessSourceHash}, got ${art.harnessSourceHash}`,
      };
    }
  }

  if (!art.passed) {
    return {
      valid: false,
      error: `audit did not pass (trappedRate=${art.metrics.trappedRate.toFixed(2)}, nonFixedRate=${art.metrics.nonFixedRate.toFixed(2)}, invalidCount=${art.metrics.invalidCount}, missingCount=${art.metrics.missingCount})`,
    };
  }

  const recomputed = computeTrapAuditMetrics(art.rows, art.metrics.totalTasks);
  if (
    recomputed.trappedRate !== art.metrics.trappedRate ||
    recomputed.nonFixedRate !== art.metrics.nonFixedRate ||
    recomputed.invalidCount !== art.metrics.invalidCount ||
    recomputed.missingCount !== art.metrics.missingCount
  ) {
    return { valid: false, error: "audit metrics recomputation mismatch" };
  }

  return { valid: true };
}

export interface RunTrapAuditOptions {
  driver: RepeatedFailureEpisodeDriver;
  outputDir: string;
  fixtureDir?: string;
  seed?: number;
  maxHostRetries?: 0 | 1 | 2;
  caps?: Partial<ControlledResponsesCaps>;
  maxToolOutputChars?: number;
}

export async function runTrapAudit(
  options: RunTrapAuditOptions,
): Promise<RepeatedFailureTrapAuditArtifact> {
  const bundle = await loadFixtureBundle(options.fixtureDir);
  const harnessSourceHash = await computeAnalysisHarnessHash();
  const seed = options.seed ?? 1;

  const store = new RepeatedFailureRowStore(options.outputDir);

  const auditRows: RepeatedFailureTrapAuditRow[] = [];

  for (const task of bundle.dataset.tasks) {
    const variant = task.variants[0];
    if (!variant) continue;

    const identity: RepeatedFailureRowIdentity = {
      suiteVersion: `h6-failure-gate-v1-${bundle.dataset.inventoryHash}`,
      taskId: task.id,
      variantId: variant.variantId,
      modelProfileId: options.driver.modelProfileId,
      modelProfileHash: options.driver.modelProfileHash,
      seed,
      arm: "NO_MEMORY",
    };

    const rowKey = buildRepeatedFailureRowKey(identity);

    const episodeRow = await runEpisodeForAudit({
      identity,
      rowKey,
      task,
      variant,
      driver: options.driver,
      store,
      caps: options.caps,
      maxHostRetries: options.maxHostRetries,
      maxToolOutputChars: options.maxToolOutputChars,
    });
    auditRows.push({
      taskId: task.id,
      variantId: variant.variantId,
      rowKey,
      finalState: episodeRow.finalState,
      status: episodeRow.status,
      invalidReason: episodeRow.invalidReason,
      tryCount: episodeRow.tryCount,
      durationMs: episodeRow.durationMs,
      tokens: episodeRow.tokens,
    });
  }

  const metrics = computeTrapAuditMetrics(auditRows, bundle.dataset.tasks.length);

  const payload: Omit<RepeatedFailureTrapAuditArtifact, "artifactHash"> = {
    schemaVersion: 1,
    modelProfileId: options.driver.modelProfileId,
    modelProfileHash: options.driver.modelProfileHash,
    datasetInventoryHash: bundle.dataset.inventoryHash,
    harnessSourceHash,
    passed: metrics.passed,
    metrics,
    rows: auditRows,
  };

  const artifactHash = computeTrapAuditArtifactHash(payload);
  const artifact: RepeatedFailureTrapAuditArtifact = {
    ...payload,
    artifactHash,
  };

  await mkdir(options.outputDir, { recursive: true });
  const filename = `trap-audit-${options.driver.modelProfileId}-${options.driver.modelProfileHash}.json`;
  const filePath = path.join(options.outputDir, filename);
  await writeFileAtomically(filePath, JSON.stringify(artifact, null, 2));

  return artifact;
}

export async function verifyMatchingTrapAudit(
  profile: { id: string; hash: string },
  datasetInventoryHash: string,
  harnessSourceHash: string,
  searchDirs: readonly string[],
): Promise<RepeatedFailureTrapAuditArtifact> {
  const targetFiles: string[] = [
    `trap-audit-${profile.id}-${profile.hash}.json`,
    `trap-audit-${profile.id}.json`,
    "trap-audit.json",
    "audit.json",
  ];

  for (const dir of searchDirs) {
    if (!dir) continue;
    try {
      const filesInDir = await readdir(dir).catch(() => []);
      for (const file of filesInDir) {
        if (!file.endsWith(".json")) continue;
        if (!targetFiles.includes(file) && !file.startsWith("trap-audit")) continue;

        const filePath = path.join(dir, file);
        const content = await readFile(filePath, "utf8").catch(() => undefined);
        if (!content) continue;

        try {
          const parsed = JSON.parse(content) as unknown;
          const verification = verifyTrapAuditArtifact(parsed, {
            modelProfileId: profile.id,
            modelProfileHash: profile.hash,
            datasetInventoryHash,
            harnessSourceHash,
          });

          if (verification.valid) {
            return parsed as RepeatedFailureTrapAuditArtifact;
          }
        } catch {
          // ignore unparseable files
        }
      }
    } catch {
      // ignore unreadable directories
    }
  }

  throw new Error(
    `No matching passed trap audit artifact found for model profile ${profile.id} (${profile.hash}). Run trap-audit before running pilot or main.`,
  );
}

export async function runTrapAuditCliCommand(input: {
  profilePaths: readonly string[];
  outputDir: string;
  fixtureDir?: string;
  maxSteps?: number;
  maxToolCalls?: number;
  maxOutputChars?: number;
}): Promise<{ exitCode: number; output: string }> {
  if (input.profilePaths.length === 0) {
    return { exitCode: 1, output: "trap-audit requires at least one --profile FILE" };
  }

  const bundle = await loadFixtureBundle(input.fixtureDir);
  const caps: ControlledResponsesCaps = {
    ...DEFAULT_CAPS,
    ...(input.maxSteps !== undefined ? { maxTurns: input.maxSteps } : {}),
    ...(input.maxToolCalls !== undefined ? { maxToolCalls: input.maxToolCalls } : {}),
  };
  const maxToolOutputChars = input.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  const executionContract = buildModelProfileExecutionContract(
    bundle,
    caps,
    maxToolOutputChars,
  );

  const profiles = await Promise.all(
    input.profilePaths.map((profilePath) => loadModelProfile(profilePath, executionContract)),
  );

  const apiKey = process.env.OPENAI_API_KEY;
  if (
    profiles.some((entry) => (
      entry.profile.provider === "openai-responses" && entry.profile.endpoint === undefined
    )) &&
    !apiKey
  ) {
    throw new Error("OPENAI_API_KEY environment variable is required for official OpenAI model profiles");
  }

  const drivers = profiles.map(({ profile, hash }) =>
    createRepeatedFailureProfileDriver(profile, hash, apiKey),
  );

  const results: RepeatedFailureTrapAuditArtifact[] = [];
  let allPassed = true;

  for (const driver of drivers) {
    const artifact = await runTrapAudit({
      driver,
      outputDir: input.outputDir,
      fixtureDir: input.fixtureDir,
      caps,
      maxToolOutputChars,
    });
    results.push(artifact);
    if (!artifact.passed) {
      allPassed = false;
    }
  }

  const outputLines = [
    `Trap-effectiveness audit finished: ${results.length} profile(s).`,
    ...results.map((art) =>
      `  - ${art.modelProfileId} (${art.modelProfileHash.slice(0, 12)}): ` +
      `${art.passed ? "PASSED" : "FAILED"} ` +
      `trapped=${art.metrics.trappedCount}/${art.metrics.totalTasks} (${(art.metrics.trappedRate * 100).toFixed(1)}%), ` +
      `nonFixed=${art.metrics.nonFixedCount}/${art.metrics.totalTasks} (${(art.metrics.nonFixedRate * 100).toFixed(1)}%), ` +
      `invalid=${art.metrics.invalidCount}`,
    ),
    `Artifacts saved to ${input.outputDir}`,
  ];

  return {
    exitCode: allPassed ? 0 : 1,
    output: outputLines.join("\n"),
  };
}
