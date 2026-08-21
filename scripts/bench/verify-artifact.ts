#!/usr/bin/env -S npx tsx
/**
 * verify-artifact.ts — Load + validate + re-hash a BenchmarkArtifact JSON
 * file. Prints a one-line summary on success; exits non-zero on any
 * schema or parse failure.
 *
 * Usage:
 *   scripts/bench/verify-artifact.ts <path/to/artifact.json> [...]
 *
 * Output line shape:
 *   OK <filename> <benchmark> model=<id> seed=<n> metrics=<k>=<v>[,<k>=<v>...] sha256=<64-hex>
 *
 * Exit codes:
 *   0 — all artifacts verified
 *   1 — one or more artifacts failed validation
 *   2 — usage error
 */

import path from "node:path";
import process from "node:process";

// Consume `@remnic/bench` through its published package boundary
// (CLAUDE.md rule 26). The root package.json lists it under
// `devDependencies` with the `workspace:*` protocol so the script
// resolves against the workspace symlink at dev time; the published
// `remnic` npm package does NOT ship `@remnic/bench` as a runtime
// dependency (CLAUDE.md à-la-carte rule 57: optional packages stay
// off the base install surface).
import { loadBenchmarkArtifact } from "@remnic/bench";

async function main(args: string[]): Promise<number> {
  if (args.length === 0) {
    process.stderr.write(
      "usage: verify-artifact.ts <path/to/artifact.json> [...]\n",
    );
    return 2;
  }

  let failures = 0;
  for (const filePath of args) {
    try {
      const { artifact, sha256 } = await loadBenchmarkArtifact(filePath);
      const metrics = Object.entries(artifact.metrics)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${formatMetric(value)}`)
        .join(",");
      process.stdout.write(
        `OK ${path.basename(filePath)} ${artifact.benchmarkId} ` +
          `model=${artifact.model} seed=${artifact.seed} ` +
          `metrics=${metrics || "<none>"} sha256=${sha256}\n`,
      );
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`FAIL ${filePath} ${message}\n`);
    }
  }

  return failures === 0 ? 0 : 1;
}

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(
      `verify-artifact.ts crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
