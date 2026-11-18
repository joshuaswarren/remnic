/**
 * Test-selection shadow runner.
 *
 * Logs which test files WOULD run for the current change while the full
 * suite still executes. Shadow only: this script never skips a test and must
 * never fail the job — every error path exits 0 after logging.
 *
 * Usage mirrors run-root-tests.mjs exactly:
 *   node scripts/test-selection-shadow.mjs [--group <name>]... [--shard i/n]
 *
 * Changed files come from REMNIC_SHADOW_CHANGED_PATH (one repo-relative
 * path per line). Missing or empty input means "unknown" and selects all.
 * Output JSON lands in .test-selection-shadow/ for artifact upload.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expandTestPatterns,
  parseRunnerArgs,
  selectTestPatterns,
  selectTestShard,
} from "./root-test-runner-lib.mjs";
import {
  buildImportGraph,
  buildReverseIndex,
  listImportableFiles,
  loadPackageIndex,
  selectShadowRun,
} from "./test-selection-shadow-lib.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(repoRoot, ".test-selection-shadow");

function safeShardName(shard) {
  return shard ? `${shard.index}-of-${shard.total}` : "all";
}

function main() {
  const { groups, shard } = parseRunnerArgs(process.argv.slice(2));
  const patterns = selectTestPatterns(groups);
  const { files: expandedFiles } = expandTestPatterns(repoRoot, patterns);
  const shardFiles = shard ? selectTestShard(expandedFiles, shard) : expandedFiles;

  const changedPath = process.env.REMNIC_SHADOW_CHANGED_PATH;
  let changedFiles = null;
  if (changedPath) {
    try {
      changedFiles = readFileSync(changedPath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      changedFiles = null;
    }
  }

  const packageIndex = loadPackageIndex(repoRoot);
  const graph = buildImportGraph(repoRoot, listImportableFiles(repoRoot), packageIndex);
  const reverseIndex = buildReverseIndex(graph);

  const result = selectShadowRun({
    shardFiles,
    allTestFiles: expandedFiles,
    changedFiles,
    reverseIndex,
  });

  const payload = {
    shard: shard ? `${shard.index}/${shard.total}` : null,
    groups,
    mode: result.mode,
    why: result.why ?? null,
    shardFileCount: shardFiles.length,
    wouldRunCount: result.wouldRun.length,
    changed: result.changed,
    wouldRun: result.wouldRun,
    graphEdges: [...graph.values()].reduce((sum, deps) => sum + deps.size, 0),
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `shadow-${safeShardName(shard)}.json`);
  writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);

  const pct = shardFiles.length === 0 ? 100 : Math.round((result.wouldRun.length / shardFiles.length) * 100);
  console.log(
    `[test-selection-shadow] shard=${payload.shard ?? "all"} mode=${result.mode} ` +
      `would_run=${result.wouldRun.length}/${shardFiles.length} (${pct}%) ` +
      `changed=${result.changed.length}${result.why ? ` why=${result.why}` : ""}`,
  );
  if (result.mode === "selected" && result.wouldRun.length > 0 && result.wouldRun.length <= 50) {
    for (const file of result.wouldRun) {
      console.log(`[test-selection-shadow]   would-run: ${file}`);
    }
  }
}

try {
  main();
} catch (error) {
  // Shadow must never fail CI: log and exit 0.
  console.log(`[test-selection-shadow] ERROR (ignored): ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
