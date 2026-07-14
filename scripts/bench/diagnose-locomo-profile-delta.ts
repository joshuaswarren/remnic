#!/usr/bin/env -S npx tsx
import process from "node:process";

import {
  diagnoseLoComoProfileDelta,
  loadBenchmarkArtifact,
  renderLoComoProfileDeltaMarkdown,
} from "@remnic/bench";

interface CliOptions {
  baselinePath: string;
  realPath: string;
  format: "json" | "markdown";
  metric: string;
  top: number;
}

async function main(args: string[]): Promise<number> {
  const options = parseArgs(args);
  const [baseline, real] = await Promise.all([
    loadBenchmarkArtifact(options.baselinePath),
    loadBenchmarkArtifact(options.realPath),
  ]);
  const report = diagnoseLoComoProfileDelta({
    baseline: {
      artifact: baseline.artifact,
      reference: options.baselinePath,
      sha256: baseline.sha256,
    },
    real: {
      artifact: real.artifact,
      reference: options.realPath,
      sha256: real.sha256,
    },
    primaryMetric: options.metric,
    maxRegressions: options.top,
  });
  process.stdout.write(
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderLoComoProfileDeltaMarkdown(report),
  );
  return 0;
}

function parseArgs(args: string[]): CliOptions {
  if (args.length < 2) {
    throw new Error(
      "usage: diagnose-locomo-profile-delta.ts <baseline-artifact> <real-artifact> " +
        "[--metric llm_judge] [--top 20] [--format markdown|json]",
    );
  }
  const [baselinePath, realPath, ...flags] = args;
  if (!baselinePath || !realPath) {
    throw new Error("Both baseline and real artifact paths are required.");
  }
  let format: CliOptions["format"] = "markdown";
  let metric = "llm_judge";
  let top = 20;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    const value = flags[index + 1];
    if (flag === "--format") {
      if (value !== "markdown" && value !== "json") {
        throw new Error('--format must be "markdown" or "json".');
      }
      format = value;
      index += 1;
    } else if (flag === "--metric") {
      if (!value || value.startsWith("--")) throw new Error("--metric requires a value.");
      metric = value;
      index += 1;
    } else if (flag === "--top") {
      if (!value || value.startsWith("--")) throw new Error("--top requires a value.");
      top = Number(value);
      if (!Number.isInteger(top) || top < 0) {
        throw new Error("--top must be a non-negative integer.");
      }
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(flag)}.`);
    }
  }
  return { baselinePath, realPath, format, metric, top };
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
