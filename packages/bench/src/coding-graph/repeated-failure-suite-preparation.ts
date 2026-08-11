import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  captureBenchmarkExecutionProvenance,
  getRemnicVersion,
  type BenchmarkExecutionProvenance,
} from "../reporter.js";
import { compareCodePoints } from "../codepoint-order.js";
import {
  assertTrapDatasetPreflight,
  verifyMatchingTrapAudit,
  type RepeatedFailureTrapAuditArtifact,
} from "./repeated-failure-trap-audit.js";
import type { BaseTask, TaskVariant } from "./repo-gen/index.js";
import { buildRepeatedFailureRowKey } from "./repeated-failure-store.js";
import type {
  RepeatedFailureEpisodeDriver,
  RunRepeatedFailureSuiteOptions,
} from "./repeated-failure-types.js";
import {
  PRIMARY_ARMS,
  TIMIDITY_ARMS,
  TIMING_ONLY_ARMS,
  PreregistrationBindingSchema,
  TimingPreregistrationBindingSchema,
  decisionRuleDesignMode,
  type FixtureBundle,
  type NormalizedRunOptions,
  type PlannedRow,
  type VerifiedPilotPower,
  type DesignArtifact,
  identityFor,
  sha256,
} from "./repeated-failure-suite-shared.js";
import {
  assertSafeBenchmarkOutput,
  loadFixtureBundle,
  normalizeRunOptions,
  parseRunMetadata,
  validateTaskManifest,
} from "./repeated-failure-suite-execution.js";
import {
  computeAnalysisHarnessHash,
  verifyPilotPower,
  verifyResumeSourceIntegrity,
} from "./repeated-failure-suite-analysis.js";
import {
  buildModelProfileExecutionContract,
  isRegisteredProfileDriver,
} from "./repeated-failure-suite-output.js";

const PACKAGED_PREREGISTRATION_FILENAMES = {
  12: "h6-failure-gate.md",
  13: "h6-timing-rerun.md",
} as const;

interface PreparedRepeatedFailureSuite {
  bundle: FixtureBundle;
  configuration: NormalizedRunOptions;
  provenance: BenchmarkExecutionProvenance;
  harnessVersion: string;
  harnessSourceHash: string;
  verifiedTrapAudits: RepeatedFailureTrapAuditArtifact[];
  pilotPower: VerifiedPilotPower | undefined;
  plans: PlannedRow[];
  design: DesignArtifact;
}

export function resolvePackagedPreregistrationRoot(moduleUrl = import.meta.url): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  return path.basename(moduleDirectory) === "dist"
    ? moduleDirectory
    : path.resolve(moduleDirectory, "../../preregistration");
}

export async function verifyPreregistrationBinding(
  repositoryRoot: string,
  binding: unknown,
  resourcePath?: string,
): Promise<string> {
  const sealed = z.union([
    PreregistrationBindingSchema,
    TimingPreregistrationBindingSchema,
  ]).parse(binding);
  const resolvedResourcePath = resourcePath ?? sealed.path;
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(repositoryRoot, resolvedResourcePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`preregistration file is missing: ${sealed.path}`, { cause: error });
    }
    throw error;
  }
  const actualHash = sha256(bytes);
  if (actualHash !== sealed.sha256) {
    throw new Error(`preregistration hash mismatch: expected ${sealed.sha256}, got ${actualHash}`);
  }
  return actualHash;
}

async function verifyResumePreregistrationMetadata(
  outputDir: string,
  binding: unknown,
): Promise<void> {
  const sealed = z.union([
    PreregistrationBindingSchema,
    TimingPreregistrationBindingSchema,
  ]).parse(binding);
  const metadata = parseRunMetadata(JSON.parse(
    await readFile(path.join(outputDir, "run.json"), "utf8"),
  ));
  if (
    metadata.preregistrationPath !== sealed.path
    || metadata.preregistrationHash !== sealed.sha256
  ) {
    throw new Error("resume run preregistration binding is stale");
  }
}

export async function prepareRepeatedFailureSuite(
  options: RunRepeatedFailureSuiteOptions,
): Promise<PreparedRepeatedFailureSuite> {
  const bundle = await loadFixtureBundle(options.fixtureDir, options.decisionRuleFile);
  const configuration = normalizeRunOptions(options, bundle);
  await assertSafeBenchmarkOutput(configuration.outputDir, options.resume === true);
  if (options.resume === true) {
    await verifyResumeSourceIntegrity(configuration.outputDir);
    await verifyResumePreregistrationMetadata(
      configuration.outputDir,
      bundle.decisionRule.preregistration,
    );
  }
  await verifyPreregistrationBinding(
    resolvePackagedPreregistrationRoot(),
    bundle.decisionRule.preregistration,
    PACKAGED_PREREGISTRATION_FILENAMES[bundle.decisionRule.version],
  );
  await assertTrapDatasetPreflight(bundle.dataset);
  for (const driver of configuration.drivers) {
    await driver.preflight?.();
  }
  const provenance = captureBenchmarkExecutionProvenance();
  const harnessVersion = await getRemnicVersion();
  const harnessSourceHash = await computeAnalysisHarnessHash();
  const registeredExecutionContract = buildModelProfileExecutionContract(
    bundle,
    configuration.caps,
    configuration.maxToolOutputChars,
  );
  const verifiedTrapAudits: RepeatedFailureTrapAuditArtifact[] = [];
  if (configuration.phase === "pilot" || configuration.phase === "main") {
    for (const driver of configuration.drivers) {
      if (
        driver.driverKind !== "ollama-chat"
        || !isRegisteredProfileDriver(driver, registeredExecutionContract)
      ) {
        throw new Error(`Registered ${configuration.phase} runs require a loaded Ollama model profile driver`);
      }
    }
    for (const driver of configuration.drivers) {
      verifiedTrapAudits.push(await verifyMatchingTrapAudit(
        { id: driver.modelProfileId, hash: driver.modelProfileHash, modelDigest: driver.modelDigest },
        bundle.dataset.inventoryHash,
        harnessSourceHash,
        {
          hash: sha256(bundle.decisionRuleBytes),
          trapAudit: bundle.decisionRule.trapAudit,
        },
        [
          configuration.outputDir,
          options.pilotRunDir ?? "",
          options.fixtureDir ?? "",
          path.join(path.dirname(configuration.outputDir), "h6-trap-audit"),
          path.resolve("h6-trap-audit"),
          path.resolve("."),
        ],
      ));
    }
  }
  const pilotPower = configuration.phase === "main"
    ? await verifyPilotPower(
        options.pilotRunDir,
        bundle,
        configuration,
        harnessVersion,
        harnessSourceHash,
      )
    : undefined;
  const plans = await buildPlans(
    bundle,
    configuration.taskIds,
    configuration.variantIds,
    configuration.drivers,
    configuration.seeds,
    decisionRuleDesignMode(bundle.decisionRule),
  );
  const design = buildDesign(plans);
  return {
    bundle,
    configuration,
    provenance,
    harnessVersion,
    harnessSourceHash,
    verifiedTrapAudits,
    pilotPower,
    plans,
    design,
  };
}

export async function buildPlans(
  bundle: FixtureBundle,
  taskIds: readonly string[],
  variantIds: readonly string[],
  drivers: readonly RepeatedFailureEpisodeDriver[],
  seeds: readonly number[],
  designMode: "full" | "timing_only" = "full",
): Promise<PlannedRow[]> {
  const tasks = bundle.dataset.tasks
    .filter((task) => taskIds.length === 0 || taskIds.includes(task.id))
    .sort((left, right) => compareCodePoints(left.id, right.id));
  if (tasks.length === 0) throw new Error("task selection is empty");
  const selectedVariants: Array<{ task: BaseTask; variant: TaskVariant }> = [];
  for (const task of tasks) {
    await validateTaskManifest(bundle.fixtureDir, task);
    for (const variant of [...task.variants].sort(
      (left, right) => compareCodePoints(left.variantId, right.variantId),
    )) {
      if (variantIds.length === 0 || variantIds.includes(variant.variantId)) {
        selectedVariants.push({ task, variant });
      }
    }
  }
  if (selectedVariants.length === 0) throw new Error("variant selection is empty");
  const plans: PlannedRow[] = [];
  const primaryArms = designMode === "timing_only" ? TIMING_ONLY_ARMS : PRIMARY_ARMS;
  for (const { task, variant } of selectedVariants) {
    for (const seed of seeds) {
      for (const driver of drivers) {
        for (const arm of primaryArms) {
          plans.push({
            identity: identityFor(bundle.suiteVersion, task.id, variant.variantId, driver, seed, arm),
            task,
            variant,
            files: variant.files,
            noTrapControl: false,
          });
        }
        if (designMode === "full") {
          for (const arm of TIMIDITY_ARMS) {
            plans.push({
              identity: identityFor(
                bundle.suiteVersion,
                task.id,
                `${variant.variantId}:no-trap`,
                driver,
                seed,
                arm,
              ),
              task,
              variant,
              files: variant.noTrapControlFiles,
              noTrapControl: true,
            });
          }
        }
      }
    }
  }
  const keys = plans.map((plan) => buildRepeatedFailureRowKey(plan.identity));
  if (new Set(keys).size !== keys.length) throw new Error("row planning produced a key collision");
  return plans;
}

export function buildDesign(plans: readonly PlannedRow[]): DesignArtifact {
  return {
    schemaVersion: 1,
    runOrder: plans.map((plan) => ({
      rowKey: buildRepeatedFailureRowKey(plan.identity),
      analysis: plan.noTrapControl ? "TIMIDITY" : "PRIMARY",
      identity: plan.identity,
    })),
    primary: { rows: plans.filter((plan) => !plan.noTrapControl).map((plan) => plan.identity) },
    timidity: { rows: plans.filter((plan) => plan.noTrapControl).map((plan) => plan.identity) },
  };
}
