import {
  hashCanonicalJson,
  hashString,
} from "../../../integrity/hash-verification.js";

export const LOCOMO_TASK_SELECTION_VERSION = 1 as const;

export type LoCoMoTaskSelector =
  | { taskIds: readonly string[]; sampleSize?: never; seed?: never }
  | { taskIds?: never; sampleSize: number; seed: number };

export interface LoCoMoPinnedTaskSelector {
  kind: "explicit-task-ids";
  taskIds: readonly string[];
  expectedSelectedTaskIdsSha256: string;
}

export interface LoCoMoTaskSelectionManifest {
  algorithm: "explicit-task-ids" | "sha256-seeded-sample";
  version: typeof LOCOMO_TASK_SELECTION_VERSION;
  seed?: number;
  candidateCount: number;
  selectedCount: number;
  selectedTaskIds: string[];
  selectedTaskIdsSha256: string;
}

export function parseLoCoMoTaskSelectionManifest(
  value: unknown,
  label = "LoCoMo task selection",
): LoCoMoTaskSelectionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "algorithm",
    "version",
    "seed",
    "candidateCount",
    "selectedCount",
    "selectedTaskIds",
    "selectedTaskIdsSha256",
  ]);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw new Error(`${label} contains unknown field ${unknownKey}.`);
  }
  if (
    record.algorithm !== "explicit-task-ids" &&
    record.algorithm !== "sha256-seeded-sample"
  ) {
    throw new Error(`${label}.algorithm is invalid.`);
  }
  if (record.version !== LOCOMO_TASK_SELECTION_VERSION) {
    throw new Error(
      `${label}.version must be ${LOCOMO_TASK_SELECTION_VERSION}.`,
    );
  }
  const candidateCountRaw = record.candidateCount;
  const selectedCountRaw = record.selectedCount;
  if (
    typeof candidateCountRaw !== "number" ||
    !Number.isSafeInteger(candidateCountRaw) ||
    candidateCountRaw <= 0
  ) {
    throw new Error(`${label}.candidateCount must be a positive safe integer.`);
  }
  if (
    typeof selectedCountRaw !== "number" ||
    !Number.isSafeInteger(selectedCountRaw) ||
    selectedCountRaw <= 0
  ) {
    throw new Error(`${label}.selectedCount must be a positive safe integer.`);
  }
  const candidateCount = candidateCountRaw;
  const selectedCount = selectedCountRaw;
  if (selectedCount > candidateCount) {
    throw new Error(`${label}.selectedCount cannot exceed candidateCount.`);
  }
  if (
    !Array.isArray(record.selectedTaskIds) ||
    record.selectedTaskIds.some(
      (taskId) => typeof taskId !== "string" || taskId.length === 0,
    )
  ) {
    throw new Error(`${label}.selectedTaskIds must contain non-empty strings.`);
  }
  const selectedTaskIds = [...record.selectedTaskIds] as string[];
  if (new Set(selectedTaskIds).size !== selectedTaskIds.length) {
    throw new Error(`${label}.selectedTaskIds must not contain duplicates.`);
  }
  if (selectedTaskIds.length !== selectedCount) {
    throw new Error(
      `${label}.selectedCount must equal selectedTaskIds.length.`,
    );
  }
  const selectedTaskIdsSha256 = record.selectedTaskIdsSha256;
  if (
    typeof selectedTaskIdsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(selectedTaskIdsSha256) ||
    selectedTaskIdsSha256 !== hashCanonicalJson(selectedTaskIds)
  ) {
    throw new Error(`${label}.selectedTaskIdsSha256 does not match selectedTaskIds.`);
  }
  const seed = record.seed;
  if (record.algorithm === "explicit-task-ids") {
    if (seed !== undefined) {
      throw new Error(`${label}.seed is invalid for explicit task ids.`);
    }
  } else if (!Number.isSafeInteger(seed) || (seed as number) < 0) {
    throw new Error(`${label}.seed must be a non-negative safe integer.`);
  }

  return {
    algorithm: record.algorithm,
    version: LOCOMO_TASK_SELECTION_VERSION,
    ...(seed === undefined ? {} : { seed: seed as number }),
    candidateCount,
    selectedCount,
    selectedTaskIds,
    selectedTaskIdsSha256,
  };
}

/**
 * Resolve a LoCoMo task selector into canonical dataset order.
 *
 * Explicit selector order never controls execution order. This keeps paired
 * runs byte-stable even when two equivalent selector files list ids in a
 * different order. Seeded sampling chooses membership by hash and then also
 * restores dataset order before producing the manifest.
 */
export function selectLoCoMoTasks(
  tasks: readonly { taskId: string }[],
  selector: LoCoMoTaskSelector,
): LoCoMoTaskSelectionManifest {
  const allIds = tasks.map((task) => task.taskId);
  if (allIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
    throw new Error("LoCoMo candidate task ids must be non-empty strings.");
  }
  if (new Set(allIds).size !== allIds.length) {
    throw new Error("LoCoMo candidate task ids must be unique.");
  }

  const hasTaskIds = "taskIds" in selector && selector.taskIds !== undefined;
  const hasSampleSize =
    "sampleSize" in selector && selector.sampleSize !== undefined;
  if (Number(hasTaskIds) + Number(hasSampleSize) !== 1) {
    throw new Error("Choose exactly one LoCoMo task selector.");
  }
  if (hasTaskIds && "seed" in selector && selector.seed !== undefined) {
    throw new Error("LoCoMo task-selection seed is valid only for seeded sampling.");
  }

  let selected: string[];
  let algorithm: LoCoMoTaskSelectionManifest["algorithm"];
  let seed: number | undefined;
  if (hasTaskIds) {
    algorithm = "explicit-task-ids";
    const requestedTaskIds = selector.taskIds;
    if (!requestedTaskIds) {
      throw new Error("LoCoMo explicit task ids are required.");
    }
    const requested = [...requestedTaskIds];
    if (requested.length === 0) {
      throw new Error("LoCoMo explicit task selection cannot be empty.");
    }
    if (
      requested.some(
        (taskId) => typeof taskId !== "string" || taskId.length === 0,
      )
    ) {
      throw new Error("LoCoMo explicit task ids must be non-empty strings.");
    }
    if (new Set(requested).size !== requested.length) {
      throw new Error("LoCoMo explicit task ids must not contain duplicates.");
    }
    const available = new Set(allIds);
    const unknown = requested.find((taskId) => !available.has(taskId));
    if (unknown !== undefined) {
      throw new Error(`Unknown LoCoMo task id: ${unknown}`);
    }
    const requestedSet = new Set(requested);
    selected = allIds.filter((taskId) => requestedSet.has(taskId));
  } else {
    algorithm = "sha256-seeded-sample";
    const sampleSize = selector.sampleSize;
    seed = selector.seed;
    if (sampleSize === undefined || seed === undefined) {
      throw new Error("LoCoMo seeded sampling requires sampleSize and seed.");
    }
    if (
      !Number.isSafeInteger(sampleSize) ||
      sampleSize <= 0 ||
      sampleSize > allIds.length
    ) {
      throw new Error(
        `LoCoMo task-selection sampleSize must be an integer from 1 to ${allIds.length}.`,
      );
    }
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new Error(
        "LoCoMo task-selection seed must be a non-negative safe integer.",
      );
    }
    const sampled = [...allIds]
      .sort((left, right) => {
        const leftHash = hashString(`${seed}\0${left}`);
        const rightHash = hashString(`${seed}\0${right}`);
        return leftHash.localeCompare(rightHash) || left.localeCompare(right);
      })
      .slice(0, sampleSize);
    const sampledSet = new Set(sampled);
    selected = allIds.filter((taskId) => sampledSet.has(taskId));
  }

  return {
    algorithm,
    version: LOCOMO_TASK_SELECTION_VERSION,
    ...(seed === undefined ? {} : { seed }),
    candidateCount: allIds.length,
    selectedCount: selected.length,
    selectedTaskIds: selected,
    selectedTaskIdsSha256: hashCanonicalJson(selected),
  };
}
