#!/usr/bin/env -S npx tsx
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  type LoCoMoRetrievalTraceReceipt,
  diagnoseLoCoMoRetrievalTraceDelta,
  serializeLoCoMoRetrievalTraceDelta,
} from "@remnic/bench";
import { expandTildePath } from "@remnic/core";
import { displayErrorDetail } from "@remnic/core/runtime/better-sqlite";

import { preparePrivateOutput, writePrivateOutput } from "./capture-locomo-retrieval-trace.js";

export interface CliOptions {
  baselinePath: string;
  realPath: string;
  out?: string;
}

interface TextSink {
  write(chunk: string): unknown;
}

class OperatorFacingError extends Error {}

export async function main(argv: string[]): Promise<string> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch {
    throw new OperatorFacingError("Invalid command-line arguments.");
  }
  const [baseline, real] = await Promise.all([
    loadReceipt(options.baselinePath, "baseline"),
    loadReceipt(options.realPath, "real"),
  ]);
  let report;
  try {
    report = diagnoseLoCoMoRetrievalTraceDelta(baseline, real);
  } catch (error) {
    throw trustedOperatorError(error, "Unable to diagnose paired retrieval traces.");
  }
  const outputContext = await preparePrivateOutput(options.out);
  const outputPath = path.resolve(
    outputContext.requestedOutput ??
      path.join(
        outputContext.privateRoot,
        "locomo-retrieval-trace-deltas",
        `paired-${report.artifactHash.slice(0, 16)}.json`
      )
  );
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writePrivateOutput(outputPath, serializeLoCoMoRetrievalTraceDelta(report), outputContext);
  process.stdout.write(`${outputPath}\n`);
  return outputPath;
}

export function parseArgs(argv: string[]): CliOptions {
  if (argv.length < 2) {
    throw new Error(
      "usage: diagnose-locomo-retrieval-trace-delta.ts <baseline-trace> <real-trace> [--out private-path]"
    );
  }
  const [baselinePath, realPath, ...flags] = argv;
  if (!baselinePath || !realPath || baselinePath.startsWith("--") || realPath.startsWith("--")) {
    throw new Error("Both baseline and real retrieval trace paths are required.");
  }
  let out: string | undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--out") {
      const value = flags[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--out requires a value.");
      if (out !== undefined) throw new Error("--out may be specified only once.");
      out = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
    }
  }
  return {
    baselinePath: expandTildePath(baselinePath),
    realPath: expandTildePath(realPath),
    ...(out === undefined ? {} : { out: expandTildePath(out) }),
  };
}

async function loadReceipt(pathname: string, label: string): Promise<LoCoMoRetrievalTraceReceipt> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    throw new OperatorFacingError(`Unable to read ${label} retrieval trace JSON: ${formatOperatorError(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OperatorFacingError(`${label} retrieval trace JSON must contain an object.`);
  }
  return parsed as LoCoMoRetrievalTraceReceipt;
}

export function formatOperatorError(error: unknown): string {
  if (error instanceof OperatorFacingError) return error.message;
  return displayErrorDetail(error) || "Error";
}

function trustedOperatorError(error: unknown, fallback: string): OperatorFacingError {
  return new OperatorFacingError(error instanceof Error && error.message.length > 0 ? error.message : fallback);
}

export async function runCli(argv: string[], stderr: TextSink = process.stderr): Promise<number> {
  try {
    await main(argv);
    return 0;
  } catch (error) {
    stderr.write(`${formatOperatorError(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
