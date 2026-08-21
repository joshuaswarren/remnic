/**
 * Handlers for the research bench subcommands (`remnic bench attribute`,
 * `remnic bench drift-gen`; issue #1954), extracted from index.ts under the
 * structural ratchet (issue #1995).
 *
 * Both commands live in the optional @remnic/bench package: loadBenchModule()
 * throws the install hint when it is absent (à-la-carte, pattern 44).
 */

import path from "node:path";
import type { ParsedBenchArgs } from "./bench-args.js";
import { loadBenchModule } from "./optional-bench.js";
import { resolveHomeDir } from "./path-utils.js";

function emit(result: { exitCode: number; output: string }): void {
  if (result.output) {
    console.log(result.output);
  }
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

export async function runBenchResearchCommand(
  parsed: ParsedBenchArgs,
): Promise<void> {
  if (parsed.action === "attribute") {
    if (!parsed.runRef) {
      throw new Error("ERROR: bench attribute requires --run <id>.");
    }
    const { runAttributeCliCommand } = await loadBenchModule();
    emit(
      await runAttributeCliCommand({
        runRef: parsed.runRef,
        resultsDir:
          parsed.resultsDir ??
          path.join(resolveHomeDir(), ".remnic", "bench", "results"),
        memoryDir: parsed.memoryDir,
        qmdPath: parsed.qmdPath,
        collection: parsed.collection,
        threshold: parsed.threshold,
        json: parsed.json,
      }),
    );
    return;
  }

  const { runDriftGenCliCommand } = await loadBenchModule();
  emit(
    await runDriftGenCliCommand({
      action: parsed.driftGenAction ?? "generate",
      dir: parsed.driftGenDir,
      users: parsed.users,
      epochs: parsed.epochs,
      seed: parsed.seed,
      out: parsed.out,
      factsPerEpoch: parsed.factsPerEpoch,
      driftingRatio: parsed.driftingRatio,
      contradictedRatio: parsed.contradictedRatio,
      json: parsed.json,
    }),
  );
}
