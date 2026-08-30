/**
 * H5 injection-suite runner (#1962).
 *
 * Local executor for tests; ollama / openai-compat for live boxes.
 * Multi-host: mkdir claim leases, skip-if-busy, expired reclaim.
 * Host faults pause the suite instead of cutting the row (H6 #1963).
 */

import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { createHash } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { InjectionSuiteClaimLock } from "./claims.js";
import { generateFamilyVariants, generateSuiteVariants } from "./generator.js";
import { prepareInjectionSuiteFreeze } from "./freeze.js";
import {
  buildRecallPrompt,
  InjectionSuiteHostFault,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OPENAI_COMPAT_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./llm-executor.js";
import { executeProductLifecycleRow } from "./product-lifecycle.js";
import {
  InjectionSuiteRowStore,
  buildInjectionSuiteRowKey,
  defaultSuiteIdentity,
} from "./store.js";
import type {
  InjectionSuiteCliInput,
  InjectionSuiteCliResult,
  InjectionSuiteArm,
  InjectionSuiteEpisodeRow,
  InjectionSuiteRowIdentity,
  InjectionSuiteRunMetadata,
  InjectionSuiteVariant,
} from "./types.js";
import {
  HOST_FAULT_RETRY_LIMIT,
  INJECTION_SUITE_ARMS,
  INJECTION_SUITE_VERSION,
} from "./types.js";

export const INJECTION_SUITE_RESUME_CONTRACT = "h5-injection-suite-resume-v3";

export function injectionSuiteResumeContractHash(metadata: {
  suiteVersion: string;
  modelProfileId: string;
  seeds: readonly number[];
  variantsPerFamily: number;
  family?: string | null;
  limit: number | null;
  executor: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
  stage?: string;
  runKind?: string;
  modelProfileHash?: string;
  corpusManifestHash?: string;
  expectedDesignHash?: string;
  decisionRuleHash?: string;
  gitSha?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: INJECTION_SUITE_RESUME_CONTRACT,
        suiteVersion: metadata.suiteVersion,
        modelProfileId: metadata.modelProfileId,
        seeds: metadata.seeds,
        variantsPerFamily: metadata.variantsPerFamily,
        family: metadata.family ?? null,
        limit: metadata.limit,
        executor: metadata.executor,
        model: metadata.model,
        baseUrl: metadata.baseUrl,
        requestTimeoutMs: metadata.requestTimeoutMs,
        stage: metadata.stage ?? "base",
        runKind: metadata.runKind ?? "dev",
        modelProfileHash: metadata.modelProfileHash ?? "",
        corpusManifestHash: metadata.corpusManifestHash ?? "",
        expectedDesignHash: metadata.expectedDesignHash ?? "",
        decisionRuleHash: metadata.decisionRuleHash ?? "",
        gitSha: metadata.gitSha ?? "",
      }),
    )
    .digest("hex");
}

function hostFaultRetryDelayMs(
  message: string,
  consecutiveFaults: number,
): number {
  const base = /HTTP 429\b/.test(message) ? 10_000 : 250;
  return Math.min(60_000, base * 2 ** Math.max(0, consecutiveFaults - 1));
}

export function resolvedExecutorContract(input: InjectionSuiteCliInput): {
  executor: string;
  model: string;
  baseUrl: string;
  requestTimeoutMs: number;
} {
  const executor = input.executor ?? "local";
  if (executor === "local") {
    return { executor, model: "", baseUrl: "", requestTimeoutMs: 0 };
  }
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (executor === "openai-compat") {
    return {
      executor,
      model: input.model ?? DEFAULT_OLLAMA_MODEL,
      baseUrl: input.baseUrl ?? DEFAULT_OPENAI_COMPAT_BASE_URL,
      requestTimeoutMs,
    };
  }
  return {
    executor,
    model: input.model ?? DEFAULT_OLLAMA_MODEL,
    baseUrl: input.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    requestTimeoutMs,
  };
}
export function planInjectionSuiteRows(input: {
  seeds: number;
  variantsPerFamily: number;
  modelProfileId: string;
  family?: InjectionSuiteRowIdentity["family"];
  stage?: InjectionSuiteRowIdentity["stage"];
  arms?: readonly InjectionSuiteArm[];
  limit?: number;
}): InjectionSuiteRowIdentity[] {
  if (!Number.isInteger(input.seeds) || input.seeds < 1) {
    throw new Error("--seeds must be a positive integer");
  }
  if (
    !Number.isInteger(input.variantsPerFamily) ||
    input.variantsPerFamily < 1
  ) {
    throw new Error("--variants-per-family must be a positive integer");
  }
  const rows: InjectionSuiteRowIdentity[] = [];
  const stage = input.stage ?? "base";
  const arms = input.arms?.length
    ? input.arms
    : stage.startsWith("adaptive-")
      ? (["fencing", "both"] as const)
      : INJECTION_SUITE_ARMS;
  for (let seedOffset = 0; seedOffset < input.seeds; seedOffset += 1) {
    const seed = 71 + seedOffset;
    const variants = input.family
      ? generateFamilyVariants(
          input.family,
          input.variantsPerFamily,
          seed,
          stage,
        )
      : generateSuiteVariants(input.variantsPerFamily, seed, stage);
    for (const variant of variants) {
      for (const arm of arms) {
        rows.push(
          defaultSuiteIdentity({
            stage,
            modelProfileId: input.modelProfileId,
            arm,
            family: variant.family,
            variantId: variant.variantId,
            seed,
          }),
        );
      }
    }
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("--limit must be a positive integer");
    }
    return rows.slice(0, input.limit);
  }
  return rows;
}

function variantFor(
  identity: InjectionSuiteRowIdentity,
): InjectionSuiteVariant {
  const match = /-(\d+)$/.exec(identity.variantId);
  const index = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isInteger(index) || index < 1) {
    throw new Error(`unknown variant ${identity.variantId}`);
  }
  const generated = generateFamilyVariants(
    identity.family,
    index,
    identity.seed,
    identity.stage,
  );
  const variant = generated[index - 1];
  if (!variant || variant.variantId !== identity.variantId) {
    throw new Error(`unknown variant ${identity.variantId}`);
  }
  return variant;
}

export function executeLocalRow(
  identity: InjectionSuiteRowIdentity,
  variant: InjectionSuiteVariant,
): InjectionSuiteEpisodeRow {
  const planned = buildRecallPrompt(identity, variant);
  if (planned === "dropped") {
    return {
      rowKey: buildInjectionSuiteRowKey(identity),
      identity,
      attackSucceeded: false,
      canaryEmitted: false,
      quarantined: true,
      fenced: false,
    };
  }
  const canaryEmitted =
    planned.prompt.includes(variant.canary) && !planned.fenced;
  return {
    rowKey: buildInjectionSuiteRowKey(identity),
    identity,
    attackSucceeded: canaryEmitted,
    canaryEmitted,
    quarantined: planned.quarantined,
    fenced: planned.fenced,
  };
}

async function executeRow(
  identity: InjectionSuiteRowIdentity,
  variant: InjectionSuiteVariant,
  input: InjectionSuiteCliInput,
): Promise<InjectionSuiteEpisodeRow> {
  const executor = input.executor ?? "local";
  if (executor === "local") return executeLocalRow(identity, variant);
  return executeProductLifecycleRow(identity, variant, input);
}

async function readRunMetadata(
  outputDir: string,
): Promise<InjectionSuiteRunMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(path.join(outputDir, "run.json"), "utf8"),
    ) as InjectionSuiteRunMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeNewRunMetadata(
  outputDir: string,
  metadata: InjectionSuiteRunMetadata,
): Promise<boolean> {
  const filePath = path.join(outputDir, "run.json");
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "wx");
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      const directory = await open(outputDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Directory fsync is best-effort across platforms and filesystems.
    }
    return true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function ensureFrozenArtifact(
  outputDir: string,
  fileName: string,
  content: string,
): Promise<void> {
  const filePath = path.join(outputDir, fileName);
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing !== content)
      throw new Error(`frozen H5 artifact drifted: ${fileName}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFileAtomically(filePath, content);
  if ((await readFile(filePath, "utf8")) !== content) {
    throw new Error(
      `frozen H5 artifact write verification failed: ${fileName}`,
    );
  }
}

async function appendEpisode(
  outputDir: string,
  row: InjectionSuiteEpisodeRow,
): Promise<void> {
  await writeFile(
    path.join(outputDir, "episodes.jsonl"),
    `${JSON.stringify(row)}\n`,
    { flag: "a" },
  );
}

async function ensureEpisode(
  outputDir: string,
  row: InjectionSuiteEpisodeRow,
): Promise<void> {
  try {
    const existing = await readFile(
      path.join(outputDir, "episodes.jsonl"),
      "utf8",
    );
    if (existing.includes(row.rowKey)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendEpisode(outputDir, row);
}

export async function runInjectionSuiteCliCommand(
  input: InjectionSuiteCliInput,
): Promise<InjectionSuiteCliResult> {
  if (input.retryAmbiguous === true && input.resume !== true) {
    throw new Error("--retry-ambiguous requires --resume");
  }
  const planned = planInjectionSuiteRows(input);
  const seeds = [...new Set(planned.map((row) => row.seed))];
  const contract = resolvedExecutorContract(input);
  const frozen = prepareInjectionSuiteFreeze(input, planned);
  const resumeContractHash = injectionSuiteResumeContractHash({
    suiteVersion: INJECTION_SUITE_VERSION,
    modelProfileId: input.modelProfileId,
    seeds,
    variantsPerFamily: input.variantsPerFamily,
    family: input.family ?? null,
    limit: input.limit ?? null,
    executor: contract.executor,
    model: contract.model,
    baseUrl: contract.baseUrl,
    requestTimeoutMs: contract.requestTimeoutMs,
    stage: input.stage ?? "base",
    runKind: input.runKind ?? "dev",
    modelProfileHash: frozen.profile.modelProfileHash,
    corpusManifestHash: frozen.corpusManifestHash,
    expectedDesignHash: frozen.expectedDesignHash,
    decisionRuleHash: frozen.decisionRuleHash,
    gitSha: frozen.gitSha,
  });
  const existing = await readRunMetadata(input.outputDir);
  if (existing && input.resume !== true) {
    throw new Error(
      `Injection-suite run already exists at ${input.outputDir}; pass --resume`,
    );
  }
  if (existing && existing.resumeContractHash !== resumeContractHash) {
    throw new Error(
      "resume contract hash drifted; refusing to continue this run",
    );
  }

  await mkdir(input.outputDir, { recursive: true });
  await Promise.all([
    ensureFrozenArtifact(
      input.outputDir,
      "model-profile.json",
      frozen.profileBytes,
    ),
    ensureFrozenArtifact(
      input.outputDir,
      "corpus-manifest.json",
      frozen.corpusBytes,
    ),
    ensureFrozenArtifact(
      input.outputDir,
      "expected-design.json",
      frozen.designBytes,
    ),
    ensureFrozenArtifact(
      input.outputDir,
      "decision-rule.json",
      frozen.decisionRuleBytes,
    ),
  ]);
  await writeFile(path.join(input.outputDir, "deviations.jsonl"), "", {
    flag: "a",
  });
  if (!existing) {
    const metadata: InjectionSuiteRunMetadata = {
      schemaVersion: 3,
      suiteVersion: INJECTION_SUITE_VERSION,
      resumeContractHash,
      modelProfileId: input.modelProfileId,
      seeds,
      variantsPerFamily: input.variantsPerFamily,
      family: input.family ?? null,
      limit: input.limit ?? null,
      expectedRows: planned.length,
      executor: contract.executor,
      model: contract.model,
      baseUrl: contract.baseUrl,
      requestTimeoutMs: contract.requestTimeoutMs,
      stage: input.stage ?? "base",
      runKind: input.runKind ?? "dev",
      modelProfileHash: frozen.profile.modelProfileHash,
      modelDigest: frozen.profile.servedModelDigest,
      corpusManifestHash: frozen.corpusManifestHash,
      expectedDesignHash: frozen.expectedDesignHash,
      decisionRuleHash: frozen.decisionRuleHash,
      gitSha: frozen.gitSha,
      cleanTree: frozen.cleanTree,
    };
    const created = await writeNewRunMetadata(input.outputDir, metadata);
    if (!created) {
      const winner = await readRunMetadata(input.outputDir);
      if (!winner)
        throw new Error(
          `run.json appeared then vanished at ${input.outputDir}`,
        );
      if (winner.resumeContractHash !== resumeContractHash) {
        throw new Error(
          "resume contract hash drifted; refusing to continue this run",
        );
      }
    }
  }

  const store = new InjectionSuiteRowStore(input.outputDir);
  const claims = new InjectionSuiteClaimLock(store.checkpointsDir);
  let completed = 0;
  let resumed = 0;
  let skippedBusy = 0;

  for (const identity of planned) {
    const claim = await claims.tryClaim(identity);
    if (claim === "busy") {
      skippedBusy += 1;
      continue;
    }

    try {
      await claims.assertOwner(claim);
      const fresh = await store.load(identity);
      if (fresh.kind === "MALFORMED") {
        throw new Error(
          `Malformed injection-suite checkpoint: ${fresh.error.message}`,
          {
            cause: fresh.error,
          },
        );
      }
      if (fresh.kind === "VALID" && fresh.checkpoint.terminal) {
        await ensureEpisode(input.outputDir, fresh.checkpoint.terminal);
        resumed += 1;
        continue;
      }
      const ambiguous =
        fresh.kind === "VALID" ? fresh.checkpoint.inFlight : undefined;
      if (ambiguous && input.retryAmbiguous !== true) {
        return {
          exitCode: 2,
          output: `PAUSED: ${buildInjectionSuiteRowKey(identity)} has ambiguous paid attempt ${ambiguous.attempt}. Verify provider logs, then resume with --retry-ambiguous only if a retry is acceptable.\n`,
          completed,
          resumed,
          paused: true,
        };
      }
      const priorTries =
        fresh.kind === "VALID" ? fresh.checkpoint.tries.length : 0;
      const variant = variantFor(identity);
      const requiresModelCall = (input.executor ?? "local") !== "local";
      let consecutiveFaultsThisRun = 0;
      let attempt = ambiguous?.attempt ?? priorTries + 1;
      while (consecutiveFaultsThisRun < HOST_FAULT_RETRY_LIMIT) {
        await claims.assertOwner(claim);
        const started = Date.now();
        if (
          input.faultFirstAttempts !== undefined &&
          attempt <= input.faultFirstAttempts
        ) {
          consecutiveFaultsThisRun += 1;
          await store.commitTry(identity, {
            attempt,
            durationMs: Date.now() - started,
            outcome: { kind: "HOST_API_FAULT", message: "injected host fault" },
          });
          attempt += 1;
          if (consecutiveFaultsThisRun >= HOST_FAULT_RETRY_LIMIT) {
            return {
              exitCode: 2,
              output: `PAUSED: ${buildInjectionSuiteRowKey(identity)} exhausted ${HOST_FAULT_RETRY_LIMIT} host/API faults. Recover the endpoint and resume.\n`,
              completed,
              resumed,
              paused: true,
            };
          }
          continue;
        }

        try {
          if (requiresModelCall) {
            await store.markInFlight(
              identity,
              attempt,
              input.retryAmbiguous === true,
            );
          }
          const terminal = await executeRow(identity, variant, input);
          await store.commitTry(
            identity,
            {
              attempt,
              durationMs: Date.now() - started,
              outcome: {
                kind: "TASK_RESULT",
                attackSucceeded: terminal.attackSucceeded,
                canaryEmitted: terminal.canaryEmitted,
                quarantined: terminal.quarantined,
                fenced: terminal.fenced,
              },
            },
            terminal,
          );
          await appendEpisode(input.outputDir, terminal);
          completed += 1;
          break;
        } catch (error) {
          if (!(error instanceof InjectionSuiteHostFault)) throw error;
          consecutiveFaultsThisRun += 1;
          await store.commitTry(identity, {
            attempt,
            durationMs: Date.now() - started,
            outcome: { kind: "HOST_API_FAULT", message: error.message },
          });
          attempt += 1;
          if (consecutiveFaultsThisRun >= HOST_FAULT_RETRY_LIMIT) {
            return {
              exitCode: 2,
              output: `PAUSED: ${buildInjectionSuiteRowKey(identity)} exhausted ${HOST_FAULT_RETRY_LIMIT} host/API faults (${error.message}). Recover the endpoint and resume.\n`,
              completed,
              resumed,
              paused: true,
            };
          }
          await delay(
            hostFaultRetryDelayMs(error.message, consecutiveFaultsThisRun),
          );
        }
      }
    } finally {
      await claims.release(claim);
    }
  }

  return {
    exitCode: 0,
    output: `injection-suite: completed=${completed} resumed=${resumed} busy=${skippedBusy} rows=${planned.length} dir=${input.outputDir}\n`,
    completed,
    resumed,
  };
}
