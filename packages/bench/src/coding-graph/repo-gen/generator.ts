import { createHash } from "node:crypto";
import { computeH6SupportArtifactHashes } from "./contracts.js";
import { computeRevisionShas } from "./materializer.js";
import { TRAP_TAXONOMY } from "./trap-taxonomy.js";
import {
  H6BenchmarkDatasetSchema,
  H6_TRAP_IDS,
} from "./types.js";
import type {
  BaseTask,
  DatasetSplit,
  H6BenchmarkDataset,
  StrategyPatch,
  SyntheticFile,
  TaskVariant,
} from "./types.js";
import { generateFilesForTrapId } from "./trap-fixtures.js";
import { H6_TASK_REQUIREMENTS } from "./trap-fixture-types.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function computeH6InventoryHash(
  dataset: Omit<H6BenchmarkDataset, "inventoryHash">,
): string {
  return sha256(JSON.stringify(dataset));
}

export const INVENTED_DOMAINS = [
  "quillboard-inventory-sync",
  "nexus-billing-engine",
  "starlight-auth-vault",
  "nebula-cache-matrix",
  "hyperion-router-mesh",
  "cyber-telemetry-stream",
  "apex-payment-gateway",
  "quantum-order-pipeline",
  "pulse-notification-bus",
  "vector-session-store",
  "crypto-wallet-core",
  "analytics-beacon-hub",
  "media-transcoder-service",
  "identity-provider-node",
  "config-server-cluster",
  "search-index-cluster",
  "workflow-runner-engine",
  "storage-bucket-manager",
  "scheduler-daemon-service",
  "rate-limiter-filter",
  "feature-flag-service",
  "audit-logger-stream",
  "dns-resolver-cache",
  "load-balancer-proxy",
  "event-dispatcher-bus",
  "queue-worker-daemon",
  "metrics-collector-agent",
  "policy-enforcer-engine",
  "schema-registry-store",
  "secret-manager-vault",
] as const;

const CANDIDATE_DESCRIPTIONS = {
  "candidate-alpha": "Candidate alpha.",
  "candidate-beta": "Candidate beta.",
} as const;

const CANONICAL_VARIANT_SURFACE_PATH = "src/helper.ts";

function applyDistanceTransformation(
  canonicalFiles: readonly SyntheticFile[],
  domain: string,
  distance: 1 | 2 | 3,
): SyntheticFile[] {
  const token = domain.replace(/-/g, "_");
  const surface = canonicalFiles.find((file) => file.path === CANONICAL_VARIANT_SURFACE_PATH);
  if (!surface) {
    throw new Error(`Canonical input for ${domain} is missing ${CANONICAL_VARIANT_SURFACE_PATH}`);
  }
  const retained = canonicalFiles.filter((file) => file.path !== CANONICAL_VARIANT_SURFACE_PATH);

  if (distance === 1) {
    const renamedToken = `${token}_revision`;
    return [
      ...retained,
      {
        ...surface,
        content: surface.content.replace(
          new RegExp(`^(export function [A-Za-z0-9]+_)${token}(\\()`, "gm"),
          `$1${renamedToken}$2`,
        ),
      },
    ];
  }

  if (distance === 2) {
    const firstFunction = surface.content.indexOf("export function");
    const prelude = surface.content.slice(0, firstFunction);
    const functionBlocks = surface.content
      .slice(firstFunction)
      .trimEnd()
      .split(/\n\n(?=export function)/)
      .reverse();
    return [
      ...retained.slice().reverse(),
      {
        ...surface,
        content: `${prelude}${functionBlocks.join("\n\n")}\n`,
      },
    ];
  }

  return [
    ...retained,
    {
      path: CANONICAL_VARIANT_SURFACE_PATH,
      content: `export * from "./helper/core.js";
`,
    },
    {
      path: "src/helper/core.ts",
      content: surface.content.replace('from "./utils.js"', 'from "../utils.js"'),
    },
  ];
}

function opaqueStrategies(
  taskIndex: number,
  generatedBadPatch: StrategyPatch,
  generatedGoodPatch: StrategyPatch,
): {
  badStrategyPatch: StrategyPatch;
  goodStrategyPatch: StrategyPatch;
  strategyCandidates: [StrategyPatch, StrategyPatch];
} {
  const alphaIsGood = taskIndex % 2 === 0;
  const badId = alphaIsGood ? "candidate-beta" : "candidate-alpha";
  const goodId = alphaIsGood ? "candidate-alpha" : "candidate-beta";
  const badStrategyPatch: StrategyPatch = {
    ...generatedBadPatch,
    id: badId,
    description: CANDIDATE_DESCRIPTIONS[badId],
  };
  const goodStrategyPatch: StrategyPatch = {
    ...generatedGoodPatch,
    id: goodId,
    description: CANDIDATE_DESCRIPTIONS[goodId],
  };
  return {
    badStrategyPatch,
    goodStrategyPatch,
    strategyCandidates: alphaIsGood
      ? [goodStrategyPatch, badStrategyPatch]
      : [badStrategyPatch, goodStrategyPatch],
  };
}

function candidateChangesVariant(
  variantFiles: readonly SyntheticFile[],
  candidate: StrategyPatch,
): boolean {
  const baseByPath = new Map(variantFiles.map((file) => [file.path, file]));
  return candidate.files.some((file) => {
    const base = baseByPath.get(file.path);
    return !base
      || base.content !== file.content
      || (base.isExecutable ?? false) !== (file.isExecutable ?? false);
  });
}

function diversifyStateDefiningFiles(
  files: readonly SyntheticFile[],
  sourcePath: string,
  sourceSuffix: string,
  checkPrefix: string,
): SyntheticFile[] {
  return files.map((file) => {
    if (file.path === sourcePath) {
      const separator = file.content.endsWith("\n") ? "" : "\n";
      return { ...file, content: `${file.content}${separator}${sourceSuffix}` };
    }
    if (file.path === "test/check.js") {
      return { ...file, content: `${checkPrefix}${file.content}` };
    }
    return file;
  });
}

function stateDefiningDiversity(taskId: string): {
  sourceSuffix: string;
  checkPrefix: string;
} {
  const identityName = `repositoryIdentity${sha256(`identity:${taskId}`).slice(0, 8)}`;
  const tokens = Array.from(
    { length: 17 },
    (_, index) => `v${sha256(`vocabulary:${taskId}:${index}`).slice(0, 8)}`,
  );
  const sourceRows = [0, 6, 12]
    .map((offset) => `  ${tokens.slice(offset, offset + 6).join(": true, ")}: true,`)
    .join("\n");
  const checkRows = [0, 8, 16]
    .map((offset) => `  ${tokens.slice(offset, offset + 8).join(", ")},`)
    .join("\n");
  return {
    sourceSuffix:
      `export const ${identityName} = Object.freeze({\n${sourceRows}\n});\n`,
    checkPrefix:
      `import { ${identityName} } from "../src/service.mjs";\n` +
      `const {\n${checkRows}\n} = ${identityName};\n` +
      `if (!Object.values(${identityName}).every(Boolean)) throw new Error("Repository identity is invalid");\n`,
  };
}

export async function generateH6BenchmarkDataset(seed = 81): Promise<H6BenchmarkDataset> {
  const splitsAssignment: Record<DatasetSplit, string[]> = {
    dev: [],
    pilot: [],
    main: [],
  };

  const tasks: BaseTask[] = [];
  let globalTaskIndex = 0;

  for (let cIdx = 0; cIdx < H6_TRAP_IDS.length; cIdx++) {
    const trapId = H6_TRAP_IDS[cIdx];

    for (let taskInClass = 0; taskInClass < 5; taskInClass++) {
      globalTaskIndex++;
      const taskId = `h6-task-${String(globalTaskIndex).padStart(2, "0")}`;
      const domainIndex = (globalTaskIndex - 1) % INVENTED_DOMAINS.length;
      const domain = INVENTED_DOMAINS[domainIndex];

      let split: DatasetSplit = "main";
      if (taskInClass >= 0 && taskInClass <= 1) split = "pilot";

      splitsAssignment[split].push(taskId);

      const canonicalGenerated = generateFilesForTrapId(trapId, domain, taskInClass + 1);
      const diversity = stateDefiningDiversity(taskId);
      canonicalGenerated.files = diversifyStateDefiningFiles(
        canonicalGenerated.files,
        canonicalGenerated.file,
        diversity.sourceSuffix,
        diversity.checkPrefix,
      );
      canonicalGenerated.noTrapFiles = diversifyStateDefiningFiles(
        canonicalGenerated.noTrapFiles,
        canonicalGenerated.file,
        diversity.sourceSuffix,
        diversity.checkPrefix,
      );
      canonicalGenerated.badPatch = {
        ...canonicalGenerated.badPatch,
        files: diversifyStateDefiningFiles(
          canonicalGenerated.badPatch.files,
          canonicalGenerated.file,
          diversity.sourceSuffix,
          diversity.checkPrefix,
        ),
      };
      canonicalGenerated.goodPatch = {
        ...canonicalGenerated.goodPatch,
        files: diversifyStateDefiningFiles(
          canonicalGenerated.goodPatch.files,
          canonicalGenerated.file,
          diversity.sourceSuffix,
          diversity.checkPrefix,
        ),
      };
      const strategies = opaqueStrategies(
        globalTaskIndex,
        canonicalGenerated.badPatch,
        canonicalGenerated.goodPatch,
      );
      const badPatchFilePath = strategies.badStrategyPatch.files[0]?.path;
      if (strategies.badStrategyPatch.files.length !== 1 || !badPatchFilePath) {
        throw new Error(`Task ${taskId} failed strategy must change exactly one declared action-intent file`);
      }
      const packageJson: SyntheticFile = {
        path: "package.json",
        content: `${JSON.stringify(
          {
            name: `@vellum-quarry/${domain}`,
            version: "1.0.0",
            type: "module",
            description: `Synthetic repo for ${domain}`,
            scripts: { test: "node test/check.js" },
          },
          null,
          2,
        )}\n`,
      };
      const tsconfigJson: SyntheticFile = {
        path: "tsconfig.json",
        content: `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              skipLibCheck: true,
            },
            include: ["src/**/*", "vendor/**/*"],
          },
          null,
          2,
        )}\n`,
      };
      const canonicalBaseFiles = [
        packageJson,
        tsconfigJson,
        ...canonicalGenerated.files,
      ];
      const canonicalNoTrapFiles = [
        packageJson,
        tsconfigJson,
        ...canonicalGenerated.noTrapFiles,
      ];
      const variants: TaskVariant[] = [];

      for (let vIdx = 1; vIdx <= 3; vIdx++) {
        const distance = vIdx as 1 | 2 | 3;
        const variantId = `${taskId}-v${vIdx}`;
        const allFiles = applyDistanceTransformation(canonicalBaseFiles, domain, distance);
        const allNoTrapFiles = applyDistanceTransformation(
          canonicalNoTrapFiles,
          domain,
          distance,
        );
        for (const candidate of strategies.strategyCandidates) {
          if (!candidateChangesVariant(allFiles, candidate)) {
            throw new Error(
              `Variant ${variantId} candidate ${candidate.id} leaves the base repository byte-identical`,
            );
          }
        }
        const shas = await computeRevisionShas(
          allFiles,
          strategies.badStrategyPatch.files,
          strategies.goodStrategyPatch.files,
          allNoTrapFiles,
        );

        variants.push({
          variantId,
          baseTaskId: taskId,
          variantIndex: distance,
          distance,
          domain,
          files: allFiles,
          strategyCandidates: strategies.strategyCandidates,
          badStrategyPatch: strategies.badStrategyPatch,
          goodStrategyPatch: strategies.goodStrategyPatch,
          noTrapControlFiles: allNoTrapFiles,
          cleanRevisionSha: shas.cleanSha,
          trapRevisionSha: shas.trapSha,
          rightRevisionSha: shas.rightSha,
          noTrapRevisionSha: shas.noTrapSha,
        });
      }
      const offlineCheckMark = sha256(`check-mark:${taskId}:${seed}`);
      const offlineFailureMark = sha256(`failure-mark:${taskId}:${seed}`);

      const fileCount = variants[0].files.length;
      const lineCount = variants[0].files.reduce((acc, f) => acc + f.content.split("\n").length, 0);

      const baseTask: BaseTask = {
        id: taskId,
        trapId,
        domain,
        title: `Correct ${domain} service behavior`,
        description: H6_TASK_REQUIREMENTS[trapId],
        canonicalBaseFiles,
        checkCommand: "node test/check.js",
        fileCount,
        lineCount,
        fingerprint: {
          version: 1,
          trapId,
          symbol: canonicalGenerated.symbol,
          file: canonicalGenerated.file,
          pattern: canonicalGenerated.pattern,
          strategyId: strategies.badStrategyPatch.id,
        },
        normalizedActionIntent: {
          version: 1,
          actionType: "service_maintenance",
          targetSymbol: `service_${domain.replace(/-/g, "_")}`,
          filePath: badPatchFilePath,
          contextHash: sha256(`service:${domain}:${badPatchFilePath}`),
        },
        offlineCheckMark,
        offlineFailureMark,
        maxTokenCap: 8192,
        maxAttemptCap: 3,
        split,
        variants: variants as [TaskVariant, TaskVariant, TaskVariant],
      };

      tasks.push(baseTask);
    }
  }

  const datasetWithoutInventory: Omit<H6BenchmarkDataset, "inventoryHash"> = {
    version: 1,
    seed,
    createdAt: "2026-01-01T00:00:00.000Z",
    supportArtifactHashes: computeH6SupportArtifactHashes(TRAP_TAXONOMY),
    taxonomy: TRAP_TAXONOMY,
    tasks,
    splits: splitsAssignment,
  };
  const dataset: H6BenchmarkDataset = {
    ...datasetWithoutInventory,
    inventoryHash: computeH6InventoryHash(datasetWithoutInventory),
  };

  return H6BenchmarkDatasetSchema.parse(dataset);
}
