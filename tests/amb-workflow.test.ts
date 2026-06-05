import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readIndentedBlock(lines: string[], header: string, indent: number): string {
  const start = lines.findIndex((line) => line === header);
  assert.notEqual(start, -1, `missing workflow block header: ${header}`);

  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      block.push(line);
      continue;
    }
    const currentIndent = line.search(/\S/);
    if (currentIndent <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

test("AMB BEAM workflow job env avoids runner-only expression contexts", async () => {
  const workflow = await readFile(
    path.join(repoRoot, ".github", "workflows", "amb-beam-remnic.yml"),
    "utf8",
  );
  const lines = workflow.split(/\r?\n/);
  const beamJob = readIndentedBlock(lines, "  beam:", 2);
  const beamEnv = readIndentedBlock(beamJob.split(/\r?\n/), "    env:", 4);

  assert.doesNotMatch(
    beamEnv,
    /\$\{\{\s*runner\./,
    "GitHub does not allow the runner context in job-level env expressions",
  );
  assert.match(beamEnv, /^\s+AMB_DIR: \/tmp\/agent-memory-benchmark$/m);
  assert.match(beamEnv, /^\s+UV_CACHE_DIR: \/tmp\/uv-cache$/m);
});

test("AMB BEAM workflow preserves leaderboard comparison failures through tee", async () => {
  const workflow = await readFile(
    path.join(repoRoot, ".github", "workflows", "amb-beam-remnic.yml"),
    "utf8",
  );
  const lines = workflow.split(/\r?\n/);
  const compareStep = readIndentedBlock(
    lines,
    "      - name: Compare against public BEAM leaderboard",
    6,
  );
  const runBlock = readIndentedBlock(compareStep.split(/\r?\n/), "        run: |", 8);
  const pipefailIndex = runBlock.indexOf("set -o pipefail");
  const comparisonIndex = runBlock.indexOf(
    'node integrations/amb/compare-beam-result.mjs "$result" | tee "$RUNNER_TEMP/remnic-beam-comparison.txt"',
  );

  assert.notEqual(pipefailIndex, -1, "compare step must enable pipefail before piping through tee");
  assert.notEqual(comparisonIndex, -1, "compare step must pipe comparison output through tee");
  assert.ok(
    pipefailIndex < comparisonIndex,
    "pipefail must be enabled before the compare-beam-result.mjs pipeline",
  );
});
