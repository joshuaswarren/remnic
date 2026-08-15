/**
 * Thin H5 injection-suite runner (#1962).
 *
 * Does not call a live model. The local executor applies the #1955 screen
 * and authority fence deterministically so resume/pause/--limit can be
 * proven without starting the experiment. A later LLM executor can replace
 * `executeLocalRow` without changing the store contract.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderAuthorityFence, screenCandidateFact } from "@remnic/core";
import { generateSuiteVariants } from "./generator.js";
import { InjectionSuiteRowStore, buildInjectionSuiteRowKey, defaultSuiteIdentity } from "./store.js";
import type {
  InjectionSuiteCliInput,
  InjectionSuiteCliResult,
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

export const INJECTION_SUITE_RESUME_CONTRACT = "h5-injection-suite-resume-v1";

export function injectionSuiteResumeContractHash(metadata: {
  suiteVersion: string;
  modelProfileId: string;
  seeds: readonly number[];
  variantsPerFamily: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: INJECTION_SUITE_RESUME_CONTRACT,
        suiteVersion: metadata.suiteVersion,
        modelProfileId: metadata.modelProfileId,
        seeds: metadata.seeds,
        variantsPerFamily: metadata.variantsPerFamily,
      }),
    )
    .digest("hex");
}

export function planInjectionSuiteRows(input: {
  seeds: number;
  variantsPerFamily: number;
  modelProfileId: string;
  limit?: number;
}): InjectionSuiteRowIdentity[] {
  if (!Number.isInteger(input.seeds) || input.seeds < 1) {
    throw new Error("--seeds must be a positive integer");
  }
  const rows: InjectionSuiteRowIdentity[] = [];
  for (let seed = 1; seed <= input.seeds; seed += 1) {
    for (const variant of generateSuiteVariants(input.variantsPerFamily, seed)) {
      for (const arm of INJECTION_SUITE_ARMS) {
        rows.push(
          defaultSuiteIdentity({
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

function variantFor(identity: InjectionSuiteRowIdentity): InjectionSuiteVariant {
  const match = generateSuiteVariants(64, identity.seed).find(
    (variant) => variant.variantId === identity.variantId && variant.family === identity.family,
  );
  if (!match) throw new Error(`unknown variant ${identity.variantId}`);
  return match;
}

export function executeLocalRow(
  identity: InjectionSuiteRowIdentity,
  variant: InjectionSuiteVariant,
): InjectionSuiteEpisodeRow {
  const fencingOn = identity.arm === "fencing" || identity.arm === "both";
  const quarantineOn = identity.arm === "quarantine" || identity.arm === "both";
  const screened = screenCandidateFact(variant.payload);
  const quarantined = quarantineOn && screened.quarantine;
  const rendered = fencingOn
    ? renderAuthorityFence(variant.payload, "unknown")
    : variant.payload;
  const canaryEmitted = !quarantined && rendered.includes(variant.canary) && !fencingOn;
  return {
    rowKey: buildInjectionSuiteRowKey(identity),
    identity,
    attackSucceeded: canaryEmitted,
    canaryEmitted,
    quarantined,
    fenced: fencingOn,
  };
}

async function readRunMetadata(outputDir: string): Promise<InjectionSuiteRunMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")) as InjectionSuiteRunMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function appendEpisode(outputDir: string, row: InjectionSuiteEpisodeRow): Promise<void> {
  await writeFile(path.join(outputDir, "episodes.jsonl"), `${JSON.stringify(row)}\n`, { flag: "a" });
}

export async function runInjectionSuiteCliCommand(
  input: InjectionSuiteCliInput,
): Promise<InjectionSuiteCliResult> {
  const seeds = Array.from({ length: input.seeds }, (_, index) => index + 1);
  const planned = planInjectionSuiteRows(input);
  const resumeContractHash = injectionSuiteResumeContractHash({
    suiteVersion: INJECTION_SUITE_VERSION,
    modelProfileId: input.modelProfileId,
    seeds,
    variantsPerFamily: input.variantsPerFamily,
  });
  const existing = await readRunMetadata(input.outputDir);
  if (existing && input.resume !== true) {
    throw new Error(`Injection-suite run already exists at ${input.outputDir}; pass --resume`);
  }
  if (existing && existing.resumeContractHash !== resumeContractHash) {
    throw new Error("resume contract hash drifted; refusing to continue this run");
  }

  await mkdir(input.outputDir, { recursive: true });
  if (!existing) {
    const metadata: InjectionSuiteRunMetadata = {
      schemaVersion: 1,
      suiteVersion: INJECTION_SUITE_VERSION,
      resumeContractHash,
      modelProfileId: input.modelProfileId,
      seeds,
      variantsPerFamily: input.variantsPerFamily,
      limit: input.limit ?? null,
    };
    await writeFile(path.join(input.outputDir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  const store = new InjectionSuiteRowStore(input.outputDir);
  let completed = 0;
  let resumed = 0;

  for (const identity of planned) {
    const loaded = await store.load(identity);
    if (loaded.kind === "MALFORMED") {
      throw new Error(`Malformed injection-suite checkpoint: ${loaded.error.message}`, {
        cause: loaded.error,
      });
    }
    if (loaded.kind === "VALID" && loaded.checkpoint.terminal) {
      resumed += 1;
      continue;
    }

    const priorTries = loaded.kind === "VALID" ? loaded.checkpoint.tries.length : 0;
    const variant = variantFor(identity);
    // Consecutive host faults in THIS invocation. A resumed row that already
    // paused at the limit is allowed one recovered try (H6 #1963: pause is
    // not a lifetime brick).
    let consecutiveFaultsThisRun = 0;
    let attempt = priorTries + 1;
    while (consecutiveFaultsThisRun < HOST_FAULT_RETRY_LIMIT) {
      const started = Date.now();
      if (input.faultFirstAttempts !== undefined && attempt <= input.faultFirstAttempts) {
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

      const terminal = executeLocalRow(identity, variant);
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
    }
  }

  return {
    exitCode: 0,
    output: `injection-suite: completed=${completed} resumed=${resumed} rows=${planned.length} dir=${input.outputDir}\n`,
    completed,
    resumed,
  };
}
