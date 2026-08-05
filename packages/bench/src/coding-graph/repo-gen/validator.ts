import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { compareCodePoints } from "../../codepoint-order.js";
import {
  H6_ACTION_INTENT_JSON_SCHEMA,
  H6_ARMS,
  H6_DATASET_JSON_SCHEMA,
  H6_DECISION_RULE,
  H6_TASK_JSON_SCHEMA,
  H6_TRAP_FINGERPRINT_JSON_SCHEMA,
  computeH6SupportArtifactHashes,
  serializeH6FixtureJson,
} from "./contracts.js";
import { computeH6InventoryHash } from "./generator.js";
import { unresolvedHelperImports } from "./import-scanner.js";
import {
  computeRevisionShas,
  isSafeSyntheticPath,
  materializeTaskRepo,
} from "./materializer.js";
import {
  calculateTrigramSimilarity,
  normalizedTaskLogic,
  validateH6StateDefiningIndependence,
} from "./state-defining-independence.js";
export {
  calculateJaccardSimilarity,
  tokenizeContent,
  validateH6StateDefiningIndependence,
} from "./state-defining-independence.js";

import {
  H6BenchmarkDatasetSchema,
  H6_FROZEN_INVENTORY_HASH,
  H6_FROZEN_SPLITS,
  H6_TRAP_IDS,
} from "./types.js";
import type {
  BaseTask,
  EvaluateTaskStateOptions,
  H6BenchmarkDataset,
  StateClassification,
  StateEvaluationResult,
  SyntheticFile,
  TaskVariant,
} from "./types.js";
export { unresolvedHelperImports } from "./import-scanner.js";

const MAX_CHECK_OUTPUT_CHARS = 512;

const EXPECTED_CANDIDATE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "candidate-alpha": "Candidate alpha.",
  "candidate-beta": "Candidate beta.",
};

const AGENT_VISIBLE_LEAKAGE = [
  /\btrap\b/i,
  /\bprior failure\b/i,
  /\bbad\b/i,
  /\bgood\b/i,
  /\bretry[- ]loop\b/i,
  /\bpresentation[- ]layer\b/i,
  /\broot[- ]cause\b/i,
  /\bcorrect (?:candidate|strategy|answer)\b/i,
  /\bincorrect (?:candidate|strategy|answer)\b/i,
] as const;

function agentVisibleLeakage(text: string): string | undefined {
  return AGENT_VISIBLE_LEAKAGE.find((pattern) => pattern.test(text))?.source;
}

function syntheticFilesDigest(files: readonly SyntheticFile[]): string {
  return JSON.stringify(
    files
      .map((file) => [file.path, file.content, file.isExecutable ?? false] as const)
      .sort(([left], [right]) => compareCodePoints(left, right)),
  );
}

function readChildProcessFailure(
  error: unknown,
): { exitCode: number; stdout: string } {
  if (!(error instanceof Error)) {
    return { exitCode: 1, stdout: "" };
  }

  const processError = error as Error & { status?: number; stdout?: string | Buffer };
  const stdout = processError.stdout
    ? String(processError.stdout).trim().slice(0, MAX_CHECK_OUTPUT_CHARS)
    : "";
  return {
    exitCode: typeof processError.status === "number" ? processError.status : 1,
    stdout,
  };
}

export async function evaluateTaskState(
  _task: BaseTask,
  _variant: TaskVariant,
  files: SyntheticFile[],
  options: EvaluateTaskStateOptions = {},
): Promise<StateEvaluationResult> {
  const repo = await materializeTaskRepo(files);

  let exitCode = 0;
  let stdout = "";

  try {
    stdout = execFileSync("node", ["test/check.js"], {
      cwd: repo.dir,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .slice(0, MAX_CHECK_OUTPUT_CHARS);
  } catch (error) {
    ({ exitCode, stdout } = readChildProcessFailure(error));
  } finally {
    await repo.cleanup();
  }

  if (options.isNoTrapControl) {
    return {
      state: "no-trap",
      gateStatus: "NO_MATCH",
      fingerprintMatched: false,
      testPassed: exitCode === 0,
      exitCode,
      reason: `No-trap control executed check script with exit code ${exitCode}`,
    };
  }

  if (exitCode === 2) {
    return {
      state: "TRAPPED",
      gateStatus: "MATCH_WARN",
      fingerprintMatched: true,
      testPassed: false,
      exitCode,
      reason: `Offline check script detected trap state (exit code 2): ${stdout}`,
    };
  }

  if (exitCode === 0) {
    return {
      state: "FIXED",
      gateStatus: "NO_MATCH",
      fingerprintMatched: false,
      testPassed: true,
      exitCode,
      reason: `Offline check script passed cleanly (exit code 0): ${stdout}`,
    };
  }

  return {
    state: "UNFIXED",
    gateStatus: "MATCH_WARN",
    fingerprintMatched: true,
    testPassed: false,
    exitCode,
    reason: `Offline check script reported baseline failure (exit code ${exitCode}): ${stdout}`,
  };
}


function applyPatch(
  files: SyntheticFile[],
  patchFiles: SyntheticFile[],
): SyntheticFile[] {
  const replacements = new Map(
    patchFiles.map((file) => [file.path, file]),
  );
  const existingPaths = new Set(files.map((file) => file.path));
  return [
    ...files.map((file) => replacements.get(file.path) ?? file),
    ...patchFiles.filter((file) => !existingPaths.has(file.path)),
  ];
}

function syntheticFileCollectionError(files: SyntheticFile[]): string | undefined {
  const paths = new Set<string>();
  for (const file of files) {
    if (!isSafeSyntheticPath(file.path)) {
      return `Unsafe synthetic path: ${file.path}`;
    }
    if (paths.has(file.path)) {
      return `Duplicate synthetic path: ${file.path}`;
    }
    paths.add(file.path);
  }
  return undefined;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  metrics: {
    totalTasks: number;
    totalVariants: number;
    maxPairwiseSimilarity: number;
    maxStateDefiningSimilarity: number;
    devTaskCount: number;
    pilotTaskCount: number;
    mainTaskCount: number;
  };
}

export async function validateH6Dataset(
  dataset: H6BenchmarkDataset,
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];

  const schemaParse = H6BenchmarkDatasetSchema.safeParse(dataset);
  if (!schemaParse.success) {
    issues.push({
      code: "INVALID_SCHEMA",
      message: `Dataset schema validation failed: ${schemaParse.error.message}`,
    });
    return {
      valid: false,
      issues,
      metrics: {
        totalTasks: 0,
        totalVariants: 0,
        maxPairwiseSimilarity: 1,
        maxStateDefiningSimilarity: 1,
        devTaskCount: 0,
        pilotTaskCount: 0,
        mainTaskCount: 0,
      },
    };
  }

  const { inventoryHash, ...hashableDataset } = schemaParse.data;
  if (computeH6InventoryHash(hashableDataset) !== inventoryHash) {
    issues.push({
      code: "INVENTORY_HASH_MISMATCH",
      message: "Dataset inventory hash does not match its generated contents",
    });
  }
  if (inventoryHash !== H6_FROZEN_INVENTORY_HASH) {
    issues.push({
      code: "NON_FROZEN_INVENTORY",
      message: "Dataset does not match the preregistered H6 v1 inventory",
    });
  }

  const expectedSupportHashes = computeH6SupportArtifactHashes(
    schemaParse.data.taxonomy,
  );
  if (
    JSON.stringify(expectedSupportHashes) !==
    JSON.stringify(schemaParse.data.supportArtifactHashes)
  ) {
    issues.push({
      code: "SUPPORT_ARTIFACT_HASH_MISMATCH",
      message: "Dataset support artifact hashes do not match generated contracts",
    });
  }

  const devCount = dataset.splits.dev.length;
  const pilotCount = dataset.splits.pilot.length;
  const mainCount = dataset.splits.main.length;

  if (
    devCount !== 0 ||
    pilotCount !== 12 ||
    mainCount !== 18 ||
    new Set([
      ...dataset.splits.dev,
      ...dataset.splits.pilot,
      ...dataset.splits.main,
    ]).size !== 30
  ) {
    issues.push({
      code: "UNBALANCED_SPLITS",
      message: `Expected 0/12/18 split sizes and 30 unique task IDs; got ${devCount}/${pilotCount}/${mainCount}`,
    });
  }

  for (const split of ["dev", "pilot", "main"] as const) {
    if (JSON.stringify(dataset.splits[split]) !== JSON.stringify(H6_FROZEN_SPLITS[split])) {
      issues.push({
        code: "FROZEN_SPLIT_MISMATCH",
        message: `Split ${split} does not match the preregistered task IDs and order`,
      });
    }
  }

  const devClasses = new Set(
    dataset.tasks.filter((t) => dataset.splits.dev.includes(t.id)).map((t) => t.trapId),
  );
  if (devClasses.size !== 0 && devClasses.size !== 6) {
    issues.push({
      code: "DEV_SPLIT_CLASS_IMBALANCE",
      message: `Dev split should be empty or cover all 6 trap IDs (found ${devClasses.size})`,
    });
  }
  const splitExpectations = { dev: 0, pilot: 2, main: 3 } as const;
  for (const trapId of H6_TRAP_IDS) {
    const classTasks = dataset.tasks.filter((task) => task.trapId === trapId);
    if (classTasks.length < 5) {
      issues.push({
        code: "TRAP_CLASS_UNDERSIZED",
        message: `Trap class ${trapId} has ${classTasks.length} tasks; expected at least 5`,
      });
    }
    for (const [split, expectedCount] of Object.entries(splitExpectations)) {
      const splitIds = dataset.splits[split as keyof typeof splitExpectations];
      const actualCount = classTasks.filter((task) => splitIds.includes(task.id)).length;
      if (actualCount !== expectedCount) {
        issues.push({
          code: "SPLIT_CLASS_IMBALANCE",
          message:
            `Split ${split} contains ${actualCount} ${trapId} tasks; ` +
            `expected ${expectedCount}`,
        });
      }
    }
  }

  const taskIds = dataset.tasks.map((task) => task.id);
  const splitTaskIds = [
    ...dataset.splits.dev,
    ...dataset.splits.pilot,
    ...dataset.splits.main,
  ];
  if (
    new Set(taskIds).size !== taskIds.length ||
    new Set(splitTaskIds).size !== splitTaskIds.length ||
    taskIds.some((taskId) => !splitTaskIds.includes(taskId))
  ) {
    issues.push({
      code: "SPLIT_INVENTORY_MISMATCH",
      message: "Task IDs must be unique and occur in exactly one frozen split",
    });
  }

  const canonicalDigests = new Set<string>();
  const correctCandidatePositions = [0, 0];

  for (const task of dataset.tasks) {
    const canonicalCollectionError = syntheticFileCollectionError(task.canonicalBaseFiles);
    if (canonicalCollectionError) {
      issues.push({
        code: "CANONICAL_BASE_FILES_INVALID",
        message: `${task.id}: ${canonicalCollectionError}`,
      });
    }
    const canonicalDigest = syntheticFilesDigest(task.canonicalBaseFiles);
    if (canonicalDigests.has(canonicalDigest)) {
      issues.push({
        code: "CANONICAL_BASE_DUPLICATE",
        message: `Task ${task.id} duplicates another task's canonical base repository`,
      });
    }
    canonicalDigests.add(canonicalDigest);

    for (const [surfaceName, text] of [
      ["title", task.title],
      ["description", task.description],
      ...task.canonicalBaseFiles
        .filter((file) => file.path === "TASK.md" || file.path === "README.md")
        .map((file) => [file.path, file.content] as const),
    ] as const) {
      const leakage = agentVisibleLeakage(text);
      if (leakage) {
        issues.push({
          code: "AGENT_VISIBLE_LEAKAGE",
          message: `Task ${task.id} ${surfaceName} contains agent-visible leakage matching /${leakage}/`,
        });
      }
    }

    const firstVariant = task.variants[0];
    const correctCandidatePosition = firstVariant.strategyCandidates.findIndex(
      (candidate) => candidate.id === firstVariant.goodStrategyPatch.id,
    );
    if (correctCandidatePosition === 0 || correctCandidatePosition === 1) {
      correctCandidatePositions[correctCandidatePosition] += 1;
    } else {
      issues.push({
        code: "STRATEGY_CANDIDATE_MAPPING_INVALID",
        message: `Task ${task.id} must expose exactly one internally successful candidate`,
      });
    }
    const assignedSplit = (["dev", "pilot", "main"] as const).find(
      (split) => dataset.splits[split].includes(task.id),
    );
    if (assignedSplit !== task.split) {
      issues.push({
        code: "TASK_SPLIT_MEMBERSHIP_MISMATCH",
        message: `Task ${task.id} declares ${task.split} but belongs to ${assignedSplit ?? "no split"}`,
      });
    }
    if (task.fileCount < 8 || task.fileCount > 15) {
      issues.push({
        code: "TASK_FILE_COUNT_OUT_OF_BOUNDS",
        message: `Task ${task.id} has ${task.fileCount} files (expected 8-15)`,
      });
    }

    if (task.lineCount < 300 || task.lineCount > 600) {
      issues.push({
        code: "TASK_LINE_COUNT_OUT_OF_BOUNDS",
        message: `Task ${task.id} has ${task.lineCount} lines (expected 300-600)`,
      });
    }

    const variantDistances = task.variants.map((variant) => variant.distance);
    const variantIndexes = task.variants.map((variant) => variant.variantIndex);
    if (
      new Set(variantDistances).size !== 3 ||
      new Set(variantIndexes).size !== 3
    ) {
      issues.push({
        code: "COSMETIC_VARIANT_MISMATCH",
        message: `Task ${task.id} must contain cosmetic distances and indexes 1, 2, and 3`,
      });
    }

    const canonicalPaths = task.canonicalBaseFiles.map((file) => file.path).sort();
    const variantDigests = task.variants.map((variant) => syntheticFilesDigest(variant.files));
    if (
      variantDigests.some((digest) => digest === canonicalDigest)
      || new Set(variantDigests).size !== task.variants.length
    ) {
      issues.push({
        code: "DISTANCE_VARIANT_CONTENT_DUPLICATE",
        message: `Task ${task.id} canonical base and distance variants must be content-distinct`,
      });
    }
    const distanceOne = task.variants.find((variant) => variant.distance === 1);
    const distanceTwo = task.variants.find((variant) => variant.distance === 2);
    const distanceThree = task.variants.find((variant) => variant.distance === 3);
    const distanceOneSurface = distanceOne?.files.find(
      (file) => file.path === "src/helper.ts",
    );
    const distanceTwoSurface = distanceTwo?.files.find(
      (file) => file.path === "src/helper.ts",
    );
    const distanceThreeBarrel = distanceThree?.files.find(
      (file) => file.path === "src/helper.ts",
    );
    const distanceThreeCore = distanceThree?.files.find(
      (file) => file.path === "src/helper/core.ts",
    );
    if (
      !distanceOne
      || JSON.stringify(distanceOne.files.map((file) => file.path).sort())
        !== JSON.stringify(canonicalPaths)
      || !distanceOneSurface?.content.includes("_revision")
    ) {
      issues.push({
        code: "DISTANCE_ONE_RENAME_MISSING",
        message: `Task ${task.id} distance 1 must apply its deterministic identifier rename`,
      });
    }
    if (
      !distanceTwo
      || JSON.stringify(distanceTwo.files.map((file) => file.path).sort())
        !== JSON.stringify(canonicalPaths)
      || (distanceTwoSurface?.content.indexOf("buildResponseEnvelope_") ?? -1)
        >= (distanceTwoSurface?.content.indexOf("getDomainHeader_") ?? -1)
      || JSON.stringify(distanceTwo.files.map((file) => file.path))
        === JSON.stringify(task.canonicalBaseFiles.map((file) => file.path))
    ) {
      issues.push({
        code: "DISTANCE_TWO_ORDER_MISSING",
        message: `Task ${task.id} distance 2 must move function and file order`,
      });
    }
    if (
      !distanceThree
      || !distanceThreeBarrel?.content.includes("./helper/core.js")
      || !distanceThreeCore
      || distanceThree.files.length !== task.canonicalBaseFiles.length + 1
    ) {
      issues.push({
        code: "DISTANCE_THREE_MODULE_MISSING",
        message: `Task ${task.id} distance 3 must restructure the module boundary`,
      });
    }

    const variantStates: StateClassification[][] = [];
    const taxonomyItem = dataset.taxonomy.find(
      (item) => item.trapId === task.trapId,
    );

    for (const variant of task.variants) {
      const unresolvedImports = unresolvedHelperImports(variant.files);
      if (unresolvedImports.length > 0) {
        issues.push({
          code: "UNRESOLVED_LOCAL_IMPORT",
          message: `Variant ${variant.variantId} imports unavailable utilities: ${unresolvedImports.join(", ")}`,
        });
      }
      if (
        variant.baseTaskId !== task.id ||
        variant.domain !== task.domain
      ) {
        issues.push({
          code: "VARIANT_IDENTITY_MISMATCH",
          message: `Variant ${variant.variantId} does not belong to task ${task.id}`,
        });
      }
      const candidateIds = variant.strategyCandidates.map((candidate) => candidate.id);
      const candidateIdSet = new Set(candidateIds);
      const candidateDescriptionLeakage = variant.strategyCandidates
        .map((candidate) => agentVisibleLeakage(candidate.description))
        .find((leakage) => leakage !== undefined);
      const candidateDescriptionMismatch = variant.strategyCandidates.some(
        (candidate) =>
          candidate.description !== EXPECTED_CANDIDATE_DESCRIPTIONS[candidate.id],
      );
      if (
        !taxonomyItem
        || candidateIdSet.size !== 2
        || !candidateIdSet.has("candidate-alpha")
        || !candidateIdSet.has("candidate-beta")
        || !candidateIdSet.has(variant.badStrategyPatch.id)
        || !candidateIdSet.has(variant.goodStrategyPatch.id)
        || variant.badStrategyPatch.id === variant.goodStrategyPatch.id
        || candidateDescriptionLeakage
        || candidateDescriptionMismatch
        || task.fingerprint.strategyId !== variant.badStrategyPatch.id
        || task.fingerprint.strategyId === variant.goodStrategyPatch.id
        || JSON.stringify(candidateIds)
          !== JSON.stringify(firstVariant.strategyCandidates.map((candidate) => candidate.id))
      ) {
        issues.push({
          code: "STRATEGY_CONTRACT_MISMATCH",
          message: `Variant ${variant.variantId} has invalid opaque strategy metadata or fingerprint mapping`,
        });
      }

      if (
        variant.badStrategyPatch.files.length === 0
        || variant.badStrategyPatch.files.some(
          (file) => file.path !== task.normalizedActionIntent.filePath,
        )
      ) {
        issues.push({
          code: "ACTION_INTENT_PATCH_MISMATCH",
          message:
            `Task ${task.id} action intent must name every file changed by ` +
            `variant ${variant.variantId}'s failed strategy`,
        });
      }

      const fileCollectionError = [
        variant.files,
        variant.badStrategyPatch.files,
        variant.goodStrategyPatch.files,
        variant.noTrapControlFiles,
      ]
        .map(syntheticFileCollectionError)
        .find((error) => error !== undefined);
      if (fileCollectionError) {
        issues.push({
          code: "PATH_CONTAINMENT_FAIL",
          message: `${variant.variantId}: ${fileCollectionError}`,
        });
        continue;
      }

      const unfixedEval = await evaluateTaskState(task, variant, variant.files);
      if (unfixedEval.state !== "UNFIXED") {
        issues.push({
          code: "STATE_CLASSIFICATION_FAIL",
          message:
            `Task ${task.id} variant ${variant.variantId} expected UNFIXED, ` +
            `got ${unfixedEval.state} (${unfixedEval.reason})`,
        });
      }

      const badFiles = applyPatch(
        variant.files,
        variant.badStrategyPatch.files,
      );
      const goodFiles = applyPatch(
        variant.files,
        variant.goodStrategyPatch.files,
      );
      const baseDigest = syntheticFilesDigest(variant.files);
      for (const [candidate, patchedFiles] of [
        [variant.badStrategyPatch, badFiles],
        [variant.goodStrategyPatch, goodFiles],
      ] as const) {
        if (syntheticFilesDigest(patchedFiles) === baseDigest) {
          issues.push({
            code: "CANDIDATE_PATCH_NO_OP",
            message:
              `Variant ${variant.variantId} candidate ${candidate.id} leaves the base repository byte-identical`,
          });
        }
      }
      try {
        const revisions = await computeRevisionShas(
          variant.files,
          variant.badStrategyPatch.files,
          variant.goodStrategyPatch.files,
          variant.noTrapControlFiles,
        );
        if (
          revisions.cleanSha !== variant.cleanRevisionSha ||
          revisions.trapSha !== variant.trapRevisionSha ||
          revisions.rightSha !== variant.rightRevisionSha ||
          revisions.noTrapSha !== variant.noTrapRevisionSha
        ) {
          issues.push({
            code: "REVISION_SHA_MISMATCH",
            message: `Variant ${variant.variantId} has stale or corrupt revision metadata`,
          });
        }
      } catch (error) {
        issues.push({
          code: "PATCH_REVISION_INVALID",
          message: `Variant ${variant.variantId} patch revision failed: ${String(error)}`,
        });
      }
      const trappedEval = await evaluateTaskState(task, variant, badFiles);
      if (trappedEval.state !== "TRAPPED") {
        issues.push({
          code: "STATE_CLASSIFICATION_FAIL",
          message:
            `Task ${task.id} variant ${variant.variantId} bad strategy expected TRAPPED, ` +
            `got ${trappedEval.state} (${trappedEval.reason})`,
        });
      }

      const fixedEval = await evaluateTaskState(task, variant, goodFiles);
      if (fixedEval.state !== "FIXED") {
        issues.push({
          code: "STATE_CLASSIFICATION_FAIL",
          message:
            `Task ${task.id} variant ${variant.variantId} good strategy expected FIXED, ` +
            `got ${fixedEval.state} (${fixedEval.reason})`,
        });
      }

      const noTrapEval = await evaluateTaskState(task, variant, variant.noTrapControlFiles, {
        isNoTrapControl: true,
      });
      if (noTrapEval.state !== "no-trap" || !noTrapEval.testPassed) {
        issues.push({
          code: "STATE_CLASSIFICATION_FAIL",
          message:
            `Task ${task.id} variant ${variant.variantId} control must pass as no-trap, ` +
            `got ${noTrapEval.state} (${noTrapEval.reason})`,
        });
      }

      variantStates.push([
        unfixedEval.state,
        trappedEval.state,
        fixedEval.state,
        noTrapEval.state,
      ]);
    }

    const v1Str = JSON.stringify(variantStates[0]);
    const v2Str = JSON.stringify(variantStates[1]);
    const v3Str = JSON.stringify(variantStates[2]);
    if (v1Str !== v2Str || v1Str !== v3Str) {
      issues.push({
        code: "SEMANTIC_PARITY_FAIL",
        message: `Task ${task.id} variants failed semantic parity check`,
      });
    }
  }
  if (
    correctCandidatePositions[0] !== dataset.tasks.length / 2
    || correctCandidatePositions[1] !== dataset.tasks.length / 2
  ) {
    issues.push({
      code: "STRATEGY_POSITION_IMBALANCE",
      message:
        `Successful candidate positions must be balanced; got ${correctCandidatePositions[0]}/${correctCandidatePositions[1]}`,
    });
  }

  const normalizedLogic = dataset.tasks.map(normalizedTaskLogic);
  let maxPairwiseSimilarity = 0;
  const stateIndependence = validateH6StateDefiningIndependence(dataset);
  const maxStateDefiningSimilarity = stateIndependence.maxSimilarity;
  issues.push(...stateIndependence.issues);
  for (let i = 0; i < dataset.tasks.length; i++) {
    const textI = dataset.tasks[i].variants[0].files
      .map((file) => file.content)
      .join("\n");
    for (let j = i + 1; j < dataset.tasks.length; j++) {
      const textJ = dataset.tasks[j].variants[0].files
        .map((file) => file.content)
        .join("\n");
      const sim = calculateTrigramSimilarity(textI, textJ);
      if (sim > maxPairwiseSimilarity) maxPairwiseSimilarity = sim;
      if (sim > 0.80) {
        issues.push({
          code: "SIMILARITY_EXCEEDED",
          message:
            `Tasks ${dataset.tasks[i].id} and ${dataset.tasks[j].id} ` +
            `Jaccard similarity ${sim.toFixed(3)} exceeds 0.80 threshold`,
        });
      }
      const logicSimilarity = calculateTrigramSimilarity(normalizedLogic[i], normalizedLogic[j]);
      if (logicSimilarity >= 0.98) {
        issues.push({
          code: "TRAP_LOGIC_SIMILARITY_EXCEEDED",
          message:
            `Tasks ${dataset.tasks[i].id} and ${dataset.tasks[j].id} normalized trap logic ` +
            `similarity ${logicSimilarity.toFixed(3)} is not independent`,
        });
      }
    }
  }

  const forbiddenNetworkTerms = [
    "fetch(",
    "http://",
    "https://",
    'require("net")',
    'require("tls")',
  ];
  const forbiddenImports = ["@remnic/core", "@remnic/bench", "remnic"];

  for (const task of dataset.tasks) {
    for (const variant of task.variants) {
      const files = [
        ...variant.files,
        ...variant.badStrategyPatch.files,
        ...variant.goodStrategyPatch.files,
        ...variant.noTrapControlFiles,
      ];
      for (const file of files) {

        for (const term of forbiddenNetworkTerms) {
          if (file.content.includes(term)) {
            issues.push({
              code: "NETWORK_LINT_FAIL",
              message: `Forbidden network usage '${term}' in file ${file.path} of ${variant.variantId}`,
            });
          }
        }

        for (const imp of forbiddenImports) {
          if (file.content.includes(imp)) {
            issues.push({
              code: "COUNTERFACTUAL_IMPORT_FAIL",
              message: `Forbidden private/bench import '${imp}' in file ${file.path} of ${variant.variantId}`,
            });
          }
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      totalTasks: dataset.tasks.length,
      totalVariants: dataset.tasks.length * 3,
      maxPairwiseSimilarity,
      maxStateDefiningSimilarity,
      devTaskCount: devCount,
      pilotTaskCount: pilotCount,
      mainTaskCount: mainCount,
    },
  };
}

type FixtureArtifact = { path: string; content: string };

function fixtureArtifacts(dataset: H6BenchmarkDataset): FixtureArtifact[] {
  const artifacts: FixtureArtifact[] = [
    { path: "dataset.json", content: serializeH6FixtureJson(dataset) },
    { path: "trap-taxonomy.json", content: serializeH6FixtureJson(dataset.taxonomy) },
    { path: "decision-rule.json", content: serializeH6FixtureJson(H6_DECISION_RULE) },
    { path: "arms/arms.json", content: serializeH6FixtureJson(H6_ARMS) },
    {
      path: "schema/action-intent.schema.json",
      content: serializeH6FixtureJson(H6_ACTION_INTENT_JSON_SCHEMA),
    },
    {
      path: "schema/dataset.schema.json",
      content: serializeH6FixtureJson(H6_DATASET_JSON_SCHEMA),
    },
    {
      path: "schema/task.schema.json",
      content: serializeH6FixtureJson(H6_TASK_JSON_SCHEMA),
    },
    {
      path: "schema/trap-fingerprint.schema.json",
      content: serializeH6FixtureJson(H6_TRAP_FINGERPRINT_JSON_SCHEMA),
    },
  ];
  for (const task of dataset.tasks) {
    const taskRoot = `tasks/${task.id}`;
    artifacts.push({
      path: `${taskRoot}/task.json`,
      content: serializeH6FixtureJson(task),
    });
    for (const file of task.canonicalBaseFiles) {
      artifacts.push({ path: `${taskRoot}/files/${file.path}`, content: file.content });
    }
    for (const variant of task.variants) {
      for (const file of variant.files) {
        artifacts.push({
          path: `${taskRoot}/variants/variant-${variant.variantIndex}/${file.path}`,
          content: file.content,
        });
      }
    }
    for (const candidate of task.variants[0].strategyCandidates) {
      artifacts.push({
        path: `${taskRoot}/patches/${candidate.id}.json`,
        content: serializeH6FixtureJson(candidate),
      });
    }
    for (const file of task.variants[0].noTrapControlFiles) {
      artifacts.push({ path: `${taskRoot}/no-trap/${file.path}`, content: file.content });
    }
  }
  return artifacts;
}

async function optionalLstat(targetPath: string) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertNoSymlinkPathComponents(targetPath: string): Promise<void> {
  const absolutePath = resolve(targetPath);
  const root = parse(absolutePath).root;
  let currentPath = root;
  for (const segment of absolutePath.slice(root.length).split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    const details = await optionalLstat(currentPath);
    if (!details) return;
    if (details.isSymbolicLink()) {
      throw new Error(`Fixture output path contains a symlink component: ${currentPath}`);
    }
  }
}

async function assertTreeHasNoSymlinks(targetPath: string): Promise<void> {
  const details = await optionalLstat(targetPath);
  if (!details) return;
  if (details.isSymbolicLink()) {
    throw new Error(`Fixture output tree contains a symlink: ${targetPath}`);
  }
  if (!details.isDirectory()) return;
  for (const entry of (await readdir(targetPath)).sort(compareCodePoints)) {
    await assertTreeHasNoSymlinks(join(targetPath, entry));
  }
}

async function assertFixtureOutputSafe(outputDir: string): Promise<void> {
  await assertNoSymlinkPathComponents(outputDir);
  const details = await optionalLstat(outputDir);
  if (!details) return;
  if (!details.isDirectory()) {
    throw new Error(`Fixture output root is not a directory: ${outputDir}`);
  }
  await assertTreeHasNoSymlinks(outputDir);
}

async function writeFixtureArtifact(outputDir: string, artifact: FixtureArtifact): Promise<void> {
  if (!isSafeSyntheticPath(artifact.path)) {
    throw new Error(`Unsafe fixture artifact path: ${artifact.path}`);
  }
  const filePath = join(outputDir, artifact.path);
  const parentDir = dirname(filePath);
  const temporaryPath = join(parentDir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(parentDir, { recursive: true });
  try {
    await writeFile(temporaryPath, artifact.content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function validateH6FixtureBundle(directory: string): Promise<ValidationReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(directory, "dataset.json"), "utf8"));
  } catch {
    raw = {};
  }
  const parsed = H6BenchmarkDatasetSchema.safeParse(raw);
  const report = await validateH6Dataset(raw as H6BenchmarkDataset);
  if (!parsed.success) return report;

  const bundleIssues: ValidationIssue[] = [];
  for (const artifact of fixtureArtifacts(parsed.data)) {
    const artifactPath = join(directory, artifact.path);
    const details = await lstat(artifactPath).catch(() => undefined);
    const actual = details?.isFile() && !details.isSymbolicLink()
      ? await readFile(artifactPath, "utf8").catch(() => undefined)
      : undefined;
    if (actual !== artifact.content) {
      bundleIssues.push({
        code: "FIXTURE_BUNDLE_MISMATCH",
        path: artifact.path,
        message: `Fixture artifact is missing, unsafe, or drifted: ${artifact.path}`,
      });
    }
  }
  return {
    ...report,
    valid: report.valid && bundleIssues.length === 0,
    issues: [...report.issues, ...bundleIssues],
  };
}

export async function writeH6FixtureBundle(
  outputDir: string,
  input: H6BenchmarkDataset,
): Promise<string> {
  const dataset = H6BenchmarkDatasetSchema.parse(input);
  const { inventoryHash, ...hashableDataset } = dataset;
  if (
    inventoryHash !== H6_FROZEN_INVENTORY_HASH
    || computeH6InventoryHash(hashableDataset) !== inventoryHash
    || (["dev", "pilot", "main"] as const).some(
      (split) => JSON.stringify(dataset.splits[split]) !== JSON.stringify(H6_FROZEN_SPLITS[split]),
    )
    || dataset.tasks.some((task) => !dataset.splits[task.split].includes(task.id))
  ) {
    throw new Error("Only the exact preregistered H6 v1 fixture inventory may be materialized");
  }
  const artifacts = fixtureArtifacts(dataset);
  for (const artifact of artifacts) {
    if (!isSafeSyntheticPath(artifact.path)) {
      throw new Error(`Unsafe fixture artifact path: ${artifact.path}`);
    }
  }

  const absoluteOutputDir = resolve(outputDir);
  if (absoluteOutputDir === parse(absoluteOutputDir).root) {
    throw new Error("Fixture output root cannot be the filesystem root");
  }
  await assertFixtureOutputSafe(absoluteOutputDir);
  await mkdir(dirname(absoluteOutputDir), { recursive: true });
  const existingOutput = await optionalLstat(absoluteOutputDir);
  const stagingDir = await mkdtemp(
    join(dirname(absoluteOutputDir), `.${basename(absoluteOutputDir)}.tmp-`),
  );
  let backupDir: string | undefined;
  try {
    for (const artifact of artifacts) {
      await writeFixtureArtifact(stagingDir, artifact);
    }

    if (existingOutput) {
      const generatorDir = join(absoluteOutputDir, "generator");
      const generatorDetails = await optionalLstat(generatorDir);
      if (generatorDetails) {
        if (!generatorDetails.isDirectory()) {
          throw new Error("Fixture generator path is not a directory");
        }
        await cp(generatorDir, join(stagingDir, "generator"), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      backupDir = join(
        dirname(absoluteOutputDir),
        `.${basename(absoluteOutputDir)}.backup-${randomUUID()}`,
      );
      await rename(absoluteOutputDir, backupDir);
    }

    try {
      await rename(stagingDir, absoluteOutputDir);
    } catch (error) {
      if (backupDir) {
        try {
          await rename(backupDir, absoluteOutputDir);
          backupDir = undefined;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Fixture replacement failed and the prior output could not be restored",
          );
        }
      }
      throw error;
    }

    if (backupDir) {
      await rm(backupDir, { recursive: true, force: true });
      backupDir = undefined;
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
  return join(absoluteOutputDir, "dataset.json");
}
