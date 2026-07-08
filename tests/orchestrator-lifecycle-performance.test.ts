import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("runLifecyclePolicyPass uses path-based frontmatter writes (no per-item corpus rescans)", () => {
  // #1526 seam 6: runLifecyclePolicyPass moved to lifecycle-policy-coordinator.ts.
  // The orchestrator keeps a thin delegation; the body lives in the coordinator.
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "lifecycle-policy-coordinator.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /async runLifecyclePolicyPass\(\s*allMemories: MemoryFile\[\],\s*storage: StorageManager = this\.deps\.getStorage\(\),?\s*\): Promise<number> \{/m,
    "expected runLifecyclePolicyPass helper in coordinator",
  );
  assert.match(
    source,
    /await storage\.writeMemoryFrontmatter\(memory,\s*\{/m,
    "lifecycle pass should write by in-memory MemoryFile/path",
  );
  assert.match(
    source,
    /const actionPriors = await this\.buildLifecycleActionPriors\(storage\);/m,
    "lifecycle action priors should come from the selected storage namespace",
  );
  assert.doesNotMatch(
    source,
    /updateMemoryFrontmatter\(/,
    "lifecycle pass should avoid ID-based frontmatter updates that rescan corpus",
  );
});

test("runDeepSleepGovernanceNow refreshes entity synthesis after apply runs", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestrator.ts"),
    "utf-8",
  );

  assert.match(
    source,
    /if \(options\?\.dryRun !== true\) \{\s*try \{\s*await this\.processEntitySynthesisQueue\(\s*this\.storageDirNamespace\(targetStorage\.dir\),\s*5,\s*\);/m,
    "deep-sleep apply runs should refresh entity synthesis for the active namespace",
  );
});
