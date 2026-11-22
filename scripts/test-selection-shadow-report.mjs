/**
 * Shadow test-selection report (issue #3471).
 *
 * Joins the per-shard shadow JSONs the `tests` job uploads
 * (test-selection-shadow-<shard>/shadow-*.json) with each shard's actual
 * outcome, and emits one combined report so a week of runs can answer:
 * "when the selector proposed skipping tests, did the full suite still
 * pass — and when it failed, was a skipped file the cause?"
 *
 * Shadow only: this script never fails CI — every error path exits 0.
 *
 * Inputs:  REPORT_IN_DIR  — dir containing the unpacked shard artifacts
 *          REPORT_OUT_DIR — where shadow-report.{json,md} land
 * Optional per-shard outcome is read from `outcome` inside each JSON
 * (the workflow merges `steps.tests.outcome` in before upload).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Combine shard shadow payloads + outcomes into the comparison record.
 * @param {Array<{file:string, payload:object}>} entries
 */
export function buildShadowReport(entries) {
  const shards = entries.map(({ file, payload }) => {
    const shardFiles = Number(payload.shardFileCount ?? 0);
    const wouldRun = Array.isArray(payload.wouldRun) ? payload.wouldRun : [];
    return {
      shard: payload.shard ?? file,
      mode: payload.mode ?? "unknown",
      why: payload.why ?? null,
      changed: payload.changed ?? [],
      unmapped: payload.unmapped ?? [],
      shardFileCount: shardFiles,
      wouldRunCount: payload.wouldRunCount ?? wouldRun.length,
      wouldSkipCount: Math.max(0, shardFiles - (payload.wouldRunCount ?? wouldRun.length)),
      wouldRun,
      outcome: payload.outcome ?? "unknown",
    };
  });

  const shardsSkipped = shards.filter((s) => s.wouldSkipCount > 0);
  const suspects = shards.filter(
    (s) => s.outcome === "failure" && s.mode === "selected" && s.wouldSkipCount > 0,
  );

  return {
    generatedAt: new Date().toISOString(),
    shards,
    summary: {
      totalShards: shards.length,
      shardsFullySelected: shards.filter((s) => s.mode === "all").length,
      shardsWithProposedSkips: shardsSkipped.length,
      testsWouldHaveSkipped: shards.reduce((n, s) => n + s.wouldSkipCount, 0),
      /** Shards that failed while the selector proposed real skips —
       *  the failed file may be inside the skipped set; check the logs. */
      suspectShards: suspects.map((s) => s.shard),
      verdict:
        suspects.length > 0
          ? "attention"
          : shards.every((s) => s.outcome === "success" || s.outcome === "unknown")
            ? "no-evidence-of-miss"
            : "failed-shard-had-no-proposed-skips",
    },
  };
}

function main() {
  const inDir = process.env.REMNIC_SHADOW_REPORT_IN ?? ".test-selection-shadow";
  const outDir = process.env.REMNIC_SHADOW_REPORT_OUT ?? inDir;

  const entries = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("shadow-") && e.name.endsWith(".json")) {
        try {
          entries.push({ file: p, payload: JSON.parse(readFileSync(p, "utf-8")) });
        } catch { /* a corrupt shard JSON must not kill the report */ }
      }
    }
  };
  try { walk(inDir); } catch { /* missing dir → empty report */ }

  const report = buildShadowReport(entries);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "shadow-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines = [
    "# Test-selection shadow report",
    "",
    `Shards: ${report.summary.totalShards} | fully-selected: ${report.summary.shardsFullySelected} | with proposed skips: ${report.summary.shardsWithProposedSkips} | tests that would skip: ${report.summary.testsWouldHaveSkipped}`,
    `Verdict: **${report.summary.verdict}**${report.summary.suspectShards.length ? ` — suspect shards: ${report.summary.suspectShards.join(", ")}` : ""}`,
    "",
    "| shard | mode | outcome | would run | would skip | why |",
    "|---|---|---|---|---|---|",
    ...report.shards.map((s) => `| ${s.shard} | ${s.mode} | ${s.outcome} | ${s.wouldRunCount}/${s.shardFileCount} | ${s.wouldSkipCount} | ${s.why ?? ""} |`),
    "",
  ];
  writeFileSync(join(outDir, "shadow-report.md"), `${lines.join("\n")}\n`);
  console.log(`[shadow-report] verdict=${report.summary.verdict} skipped=${report.summary.testsWouldHaveSkipped} suspect=${report.summary.suspectShards.join(",") || "none"}`);
}

try {
  main();
} catch (error) {
  console.log(`[shadow-report] ERROR (ignored): ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
