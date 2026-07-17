#!/usr/bin/env -S npx tsx

import {
  BUILD_WEEK_LIMITATIONS,
  type BuildWeekLimitationCode,
  writeBuildWeekEvidenceReceipt,
} from "../../packages/bench/src/build-week-evidence-receipt.js";

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredFlag(name: string): string {
  const value = readFlag(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerFlag(name: string): number {
  const value = Number(requiredFlag(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function limitationCodes(): BuildWeekLimitationCode[] {
  const raw = requiredFlag("--limitations");
  const codes = raw.split(",").filter(Boolean);
  for (const code of codes) {
    if (!(code in BUILD_WEEK_LIMITATIONS)) {
      throw new Error(`unknown limitation code ${JSON.stringify(code)}`);
    }
  }
  return codes as BuildWeekLimitationCode[];
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm-fresh-isolated-store")) {
    throw new Error("--confirm-fresh-isolated-store is required; never generate evidence from production Remnic data");
  }
  const fullTaskCount = readFlag("--full-task-count");
  const boundedTaskCount = readFlag("--bounded-task-count");
  if ((fullTaskCount === undefined) === (boundedTaskCount === undefined)) {
    throw new Error("provide exactly one of --full-task-count or --bounded-task-count");
  }
  const publicationScope = fullTaskCount
    ? { kind: "full" as const, expectedTaskCount: positiveIntegerFlag("--full-task-count") }
    : { kind: "bounded-subset" as const, expectedTaskCount: positiveIntegerFlag("--bounded-task-count") };

  await writeBuildWeekEvidenceReceipt({
    resultPath: requiredFlag("--result"),
    manifestPath: requiredFlag("--manifest"),
    publicArtifactPath: readFlag("--public-artifact"),
    outputPath: requiredFlag("--output"),
    datasetVersion: requiredFlag("--dataset-version"),
    limitationCodes: limitationCodes(),
    freshIsolatedStoreConfirmed: true,
    publicationScope,
  });
  process.stdout.write("Build Week evidence receipt written.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
